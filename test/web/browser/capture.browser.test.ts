import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { chromium } from 'playwright';

import * as config from '../../../src/lib/config';

import { browserDriver, parseWorkload, run, SECRET_MASK_COLOR } from '../../../src/core/capture';

const ADMIN_PASSWORD = 'browser-capture-password-123';
const LITERAL_PASSWORD = 'browser-capture-literal-"quoted"\\slash-456';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/** Decode the simple non-interlaced 8-bit PNG Playwright writes, including its row filters. */
function pngPixels(bytes: Buffer): {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
} {
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    throw new Error('expected a PNG frame');
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  for (let at = PNG_SIGNATURE.length; at < bytes.length;) {
    const size = bytes.readUInt32BE(at);
    const kind = bytes.subarray(at + 4, at + 8).toString('ascii');
    const chunk = bytes.subarray(at + 8, at + 8 + size);
    at += 12 + size;
    if (kind === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      const bitDepth = chunk[8];
      const colorType = chunk[9];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || chunk[12] !== 0)
        throw new Error('expected a non-interlaced 8-bit RGB(A) PNG');
      channels = colorType === 6 ? 4 : 3;
    } else if (kind === 'IDAT') {
      data.push(chunk);
    }
  }
  const stride = width * channels;
  const encoded = zlib.inflateSync(Buffer.concat(data));
  if (encoded.length !== height * (stride + 1)) throw new Error('unexpected PNG row size');
  const decoded = Buffer.alloc(height * stride);
  for (let row = 0; row < height; row += 1) {
    const filter = encoded[row * (stride + 1)] ?? -1;
    const source = encoded.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const target = decoded.subarray(row * stride, (row + 1) * stride);
    for (let column = 0; column < stride; column += 1) {
      const sourceByte = source[column] ?? 0;
      const left = column >= channels ? (target[column - channels] ?? 0) : 0;
      const up = row > 0 ? (decoded[(row - 1) * stride + column] ?? 0) : 0;
      const upLeft =
        row > 0 && column >= channels ? (decoded[(row - 1) * stride + column - channels] ?? 0) : 0;
      if (filter === 0) target[column] = sourceByte;
      else if (filter === 1) target[column] = (sourceByte + left) & 0xff;
      else if (filter === 2) target[column] = (sourceByte + up) & 0xff;
      else if (filter === 3) target[column] = (sourceByte + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        target[column] =
          (sourceByte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff;
      } else throw new Error(`unsupported PNG filter ${String(filter)}`);
    }
  }
  return { width, height, channels, data: decoded };
}

/** WebM's YUV conversion shifts the mask RGB values slightly when the review page decodes it. */
function countMaskPixels(bytes: Buffer): number {
  const color = SECRET_MASK_COLOR.slice(1)
    .match(/../gu)
    ?.map((value) => Number.parseInt(value, 16));
  if (color === undefined || color.length !== 3) throw new Error('invalid secret mask color');
  const [red = -1, green = -1, blue = -1] = color;
  const image = pngPixels(bytes);
  let count = 0;
  for (let at = 0; at < image.data.length; at += image.channels) {
    if (
      (image.data[at] ?? 0) >= red - 75 &&
      (image.data[at + 1] ?? 0) <= green + 75 &&
      (image.data[at + 2] ?? 0) >= blue - 75
    )
      count += 1;
  }
  return count;
}

/** Inspect every presented decoded frame, retaining samples and any green credential glyphs. */
async function inspectVideo(dest: string): Promise<{ frames: number; green: number }> {
  const reviewer = await chromium.launch();
  try {
    const page = await reviewer.newPage({ viewport: { width: 1280, height: 800 } });
    const encoded = fs.readFileSync(path.join(dest, 'video.webm')).toString('base64');
    await page.setContent(`<video src="data:video/webm;base64,${encoded}" muted></video>`);
    const result = await page.evaluate(async () => {
      const video = document.querySelector('video')!;
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 800;
      const context = canvas.getContext('2d')!;
      const samples: { frame: number; png: string }[] = [];
      const counts: number[] = [];
      if (video.readyState < 2)
        await new Promise<void>((resolve, reject) => {
          video.addEventListener('loadeddata', () => resolve(), { once: true });
          video.addEventListener('error', () => reject(new Error('video decode failed')), {
            once: true,
          });
        });
      // Playwright records at 25 fps. Seek to the middle of each encoded frame, including
      // the final frame, so background-tab presentation throttling cannot skip evidence.
      for (let at = 0.02; at < video.duration; at += 0.04) {
        await new Promise<void>((resolve) => {
          video.addEventListener('seeked', () => resolve(), { once: true });
          video.currentTime = at;
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        context.drawImage(video, 0, 0);
        const pixels = context.getImageData(0, 0, 1280, 800).data;
        let green = 0;
        for (let pixel = 0; pixel < pixels.length; pixel += 4) {
          if (pixels[pixel]! < 80 && pixels[pixel + 1]! > 90 && pixels[pixel + 2]! < 80) green += 1;
        }
        counts.push(green);
        if (green > 0 || counts.length % 25 === 0)
          samples.push({ frame: counts.length, png: canvas.toDataURL('image/png').split(',')[1]! });
      }
      return { counts, samples };
    });
    fs.writeFileSync(path.join(dest, 'decoded-frame-counts.json'), JSON.stringify(result.counts));
    for (const sample of result.samples)
      fs.writeFileSync(
        path.join(dest, `decoded-${String(sample.frame)}.png`),
        Buffer.from(sample.png, 'base64'),
      );
    return { frames: result.counts.length, green: Math.max(0, ...result.counts) };
  } finally {
    await reviewer.close();
  }
}

describe('scripted capture in a real browser', () => {
  let server: Server | null = null;
  let other: Server | null = null;
  let dest = '';

  afterEach(async () => {
    if (server !== null) {
      await close(server);
      expect(server.listening).toBe(false);
      server = null;
    }
    if (other !== null) {
      await close(other);
      expect(other.listening).toBe(false);
      other = null;
    }
    const proof = process.env.CAPTURE_PROOF_DIR;
    if (dest !== '' && proof !== undefined) {
      fs.mkdirSync(proof, { recursive: true, mode: 0o700 });
      fs.cpSync(dest, path.join(proof, path.basename(dest)), { recursive: true });
    }
    if (dest !== '') fs.rmSync(dest, { recursive: true, force: true });
    dest = '';
  });

  test('masks a literal credential value selected by a password field before recording browser artifacts', async () => {
    other = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<p id=other-origin>Other origin, signed out</p>');
    });
    await listen(other);
    const otherAddress = other.address() as AddressInfo;
    expect(otherAddress.address).toBe('127.0.0.1');
    const otherOrigin = `http://127.0.0.1:${String(otherAddress.port)}`;
    server = createServer((request, response) => {
      if (request.url === '/session') {
        response.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'session=transient-cookie-secret-123; Path=/',
        });
        response.end(JSON.stringify({ token: 'transient-response-secret-456' }));
        return;
      }
      if (request.url === '/video.webm') {
        const video = path.join(dest, 'video.webm');
        if (!fs.existsSync(video)) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'video/webm' });
        response.end(fs.readFileSync(video));
        return;
      }
      if (request.url === '/video-proof') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          '<!doctype html><video id="capture" src="/video.webm" width="1280" height="800" muted></video>',
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
<html><body>
  <style>
    body { margin: 0; min-height: 2600px; }
    #sign-in { margin: 1800px 0 0 80px; }
  </style>
  <form id="sign-in">
    <label>Credential <input id="credential" name="password"></label>
    <button id="submit" type="submit">Sign in</button>
  </form>
  <p id="signed-in" hidden>Signed in</p>
  <div id="shadow-host"></div>
  <a id="logout" href="${otherOrigin}">Leave origin</a>
  <script>
    document.getElementById('shadow-host').attachShadow({mode: 'open'}).innerHTML = '<input name=password>';
    document.getElementById('sign-in').addEventListener('submit', async (event) => {
      event.preventDefault();
      const session = await (await fetch('/session')).json();
      localStorage.setItem('Meteor.loginToken', session.token);
      await fetch('/session', { headers: { Authorization: session.token } });
      localStorage.setItem('Meteor.loginToken', 'rotated-storage-secret-789');
      localStorage.clear();
      document.cookie = 'session=; Max-Age=0; Path=/';
      document.getElementById('signed-in').hidden = false;
    });
  </script>
</body></html>`);
    });
    await listen(server);
    const address = server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-capture-browser-'));
    const workload = parseWorkload(
      [
        'name: loopback-sign-in',
        'steps:',
        '  - goto: "/"',
        '  - wait_for: "#credential"',
        '  - fill: xpath=//input[@name="password"]',
        `    value: ${JSON.stringify(LITERAL_PASSWORD)}`,
        '  - fill: "#shadow-host >> input[name=password]"',
        `    value: ${JSON.stringify(LITERAL_PASSWORD)}`,
        '  - click: "#submit"',
        '  - wait_for: "#signed-in"',
        '  - shot: signed-in',
        '  - click: "#logout"',
        '  - wait_for: "#other-origin"',
      ].join('\n'),
      'loopback fixture',
    );

    const driver = await browserDriver(origin, dest, [ADMIN_PASSWORD]);
    const manifest = await run(workload, driver, dest, {
      root_url: origin,
      admin_pass: ADMIN_PASSWORD,
    });

    expect(manifest.status).toBe('ok');
    expect(manifest.shots).toEqual(['shots/shot-01.png']);
    expect(manifest.video).toBe('video.webm');
    expect(manifest.trace).toBe('trace.json');
    expect(manifest.privacy).toEqual({
      trace_policy: 'action-summary-only',
      known_secret_values: 2,
      masked_input_selectors: [
        '#shadow-host >> input[name=password]',
        'xpath=//input[@name="password"]',
      ],
      trace_screenshots: false,
      trace_snapshots: false,
      visual_review_required: true,
    });
    expect(fs.existsSync(path.join(dest, 'video.webm'))).toBe(true);
    const frame = fs.readFileSync(path.join(dest, 'steps', 'step-02-fill.png'));
    // A full-page image uses document coordinates while the recording uses viewport
    // coordinates. The capture frame must stay a viewport image after the fill scrolls
    // this tall document, so the same persistent cover protects both artifacts.
    expect(pngPixels(frame).height).toBe(800);
    expect(countMaskPixels(frame)).toBeGreaterThan(500);

    // The PNG frame proves the browser page was masked. Play the retained WebM through a
    // fresh Chromium page too, so this test fails if a future recording path drops the cover.
    const reviewer = await chromium.launch();
    try {
      const page = await reviewer.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${origin}/video-proof`);
      await page.waitForFunction(() => {
        const video = document.querySelector('video');
        return video instanceof HTMLVideoElement && video.readyState >= 2 && video.duration > 0;
      });
      await page.evaluate(async () => {
        const video = document.querySelector('video');
        if (!(video instanceof HTMLVideoElement)) throw new Error('capture video is missing');
        const at = Math.max(0, Math.min(3, video.duration - 0.1));
        await video.play();
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const done = () => {
            if (video.currentTime >= at && video.readyState >= 2) {
              video.pause();
              resolve();
            } else if (Date.now() >= deadline) {
              reject(new Error('capture video did not reach a decoded review frame'));
            } else {
              requestAnimationFrame(done);
            }
          };
          video.addEventListener('error', () => reject(video.error), { once: true });
          done();
        });
      });
      await page.waitForTimeout(200);
      const reviewFrame = await page.screenshot({ fullPage: true });
      expect(countMaskPixels(reviewFrame)).toBeGreaterThan(500);
      fs.writeFileSync(path.join(dest, 'decoded-video-frame.png'), reviewFrame);
    } finally {
      await reviewer.close();
    }

    const trace = fs.readFileSync(path.join(dest, 'trace.json'), 'utf8');
    expect(fs.existsSync(path.join(dest, 'trace.zip'))).toBe(false);
    for (const secret of [
      ADMIN_PASSWORD,
      LITERAL_PASSWORD,
      'transient-cookie-secret-123',
      'transient-response-secret-456',
      'rotated-storage-secret-789',
    ]) {
      expect(trace).not.toContain(secret);
    }
    const summary = JSON.parse(trace) as { schema: string; steps: Record<string, unknown>[] };
    expect(summary.schema).toBe('houston.capture-actions.v1');
    expect(summary.steps.map((step) => step.action)).toEqual([
      'goto',
      'wait_for',
      'fill',
      'fill',
      'click',
      'wait_for',
      'shot',
      'click',
      'wait_for',
    ]);
    for (const step of summary.steps)
      expect(Object.keys(step).sort()).toEqual(['action', 'index', 'ms', 'outcome']);
    const manifestText = fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8');
    expect(manifestText).not.toContain(ADMIN_PASSWORD);
    expect(manifestText).not.toContain(LITERAL_PASSWORD);
  });

  test('waits for an attached credential control to become visible within its one action deadline', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
<input id="delayed-password" name="password" style="display:none">
<script>
  setTimeout(() => { document.getElementById('delayed-password').style.display = 'block'; }, 1500);
</script>`);
    });
    await listen(server);
    const address = server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-capture-delayed-visible-'));
    const driver = await browserDriver(origin, dest, [ADMIN_PASSWORD]);

    const manifest = await run(
      parseWorkload(
        [
          'steps:',
          '  - goto: /',
          '  - fill: "#delayed-password"',
          '    value: "{{admin_pass}}"',
          '    timeout_ms: 3000',
        ].join('\n'),
        'delayed visible fixture',
      ),
      driver,
      dest,
      { root_url: origin, admin_pass: ADMIN_PASSWORD },
    );

    expect(manifest.status).toBe('ok');
    expect(manifest.privacy.masked_input_selectors).toEqual(['#delayed-password']);
  });

  test('refuses a native-modal credential control across a shadow boundary before it receives a secret', async () => {
    let filled = false;
    server = createServer((request, response) => {
      if (request.url === '/filled') {
        filled = true;
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
<dialog id="modal"><div id="modal-host"></div></dialog>
<script>
  const input = document.getElementById('modal-host').attachShadow({mode: 'open'}).appendChild(document.createElement('input'));
  input.name = 'password';
  input.addEventListener('input', () => { void fetch('/filled'); });
  document.getElementById('modal').showModal();
</script>`);
    });
    await listen(server);
    const address = server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-capture-modal-'));
    const driver = await browserDriver(origin, dest, [ADMIN_PASSWORD]);

    await expect(
      run(
        parseWorkload(
          [
            'steps:',
            '  - goto: /',
            '  - fill: "#modal-host >> input[name=password]"',
            '    value: "{{admin_pass}}"',
          ].join('\n'),
          'native modal fixture',
        ),
        driver,
        dest,
        { root_url: origin, admin_pass: ADMIN_PASSWORD },
      ),
    ).rejects.toThrow(/capture stopped at step 1/u);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(filled).toBe(false);
    const manifest = fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8');
    expect(manifest).not.toContain(ADMIN_PASSWORD);
  });

  test.each(['modal', 'shadow-popover', 'removed-cover'])(
    'protects the same filled control through a late %s transition and style reset',
    async (mode) => {
      server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><style>
        body { margin: 0; background: white; }
        dialog { margin: 100px; padding: 20px; }
        input { width: 600px; height: 70px; font: 40px monospace; color: rgb(0,160,0); background: white; }
      </style>
      <dialog id="container" open><div id="host"></div></dialog>
      <button id="change">Change layer</button><p id="done" hidden>Changed</p>
      <script>
        const container = document.getElementById('container');
        const host = document.getElementById('host');
        const root = ${JSON.stringify(mode)} === 'shadow-popover' ? host.attachShadow({mode:'open'}) : host;
        root.innerHTML = '<input name="token" style="width:600px;height:70px;font:40px monospace;color:rgb(0,160,0);background:white">';
        const input = root.querySelector('input');
        document.getElementById('change').onclick = () => {
          if (!input.value) throw new Error('transition must follow fill');
          input.removeAttribute('style');
          input.style.cssText = 'width:600px;height:70px;font:40px monospace;color:rgb(0,160,0);background:white;opacity:1!important;transition:opacity 10s!important';
          if (${JSON.stringify(mode)} === 'removed-cover') for (const el of document.querySelectorAll('div[aria-hidden="true"]')) {
            const replacement = el.cloneNode(true);
            replacement.style.background = 'transparent';
            el.replaceWith(replacement);
          }
          if (${JSON.stringify(mode)} === 'modal') { container.close(); container.showModal(); }
          if (${JSON.stringify(mode)} === 'shadow-popover') {
            container.close(); container.removeAttribute('open');
            container.setAttribute('popover', 'manual'); container.showPopover();
          }
          document.getElementById('done').hidden = false;
        };
      </script>`);
      });
      await listen(server);
      const address = server.address() as AddressInfo;
      expect(address.address).toBe('127.0.0.1');
      const origin = `http://127.0.0.1:${String(address.port)}`;
      dest = fs.mkdtempSync(path.join(os.tmpdir(), `houston-capture-lifetime-${mode}-`));
      const driver = await browserDriver(origin, dest, [ADMIN_PASSWORD]);
      const manifest = await run(
        parseWorkload(
          [
            'steps:',
            '  - goto: /',
            '  - fill: "#host >> input[name=token]"',
            '    value: "{{admin_pass}}"',
            '  - click: "#change"',
            '    settle_ms: 1000',
            '  - shot: after-transition',
          ].join('\n'),
          'late transition fixture',
        ),
        driver,
        dest,
        { root_url: origin, admin_pass: ADMIN_PASSWORD },
      );
      expect(manifest.status).toBe('ok');
      expect(manifest.privacy.masked_input_selectors).toEqual(['#host >> input[name=token]']);
      const decoded = await inspectVideo(dest);
      expect(decoded.frames).toBeGreaterThan(20);
      expect(decoded.green).toBe(0);
      const image = pngPixels(fs.readFileSync(path.join(dest, 'shots/shot-01.png')));
      let green = 0;
      for (let at = 0; at < image.data.length; at += image.channels) {
        if (image.data[at]! < 80 && image.data[at + 1]! > 90 && image.data[at + 2]! < 80)
          green += 1;
      }
      expect(green).toBe(0);
    },
  );

  test('keeps authored goto userinfo out of real banners and persisted records while navigating the original URL', async () => {
    const requests: string[] = [];
    const user = 'authored-user-marker';
    const password = 'authored-password-marker';
    const expectedAuth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    let authorized = false;
    server = createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/destination') {
        if (request.headers.authorization !== expectedAuth) {
          response.writeHead(401, { 'www-authenticate': 'Basic realm=fixture' });
          response.end();
          return;
        }
        authorized = true;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><p>Synthetic navigation target</p>');
    });
    await listen(server);
    const address = server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const target = origin.replace('http://', `http://${user}:${password}@`) + '/destination';
    const source = ['steps:', '  - goto: /', `  - goto: "${target}"`, '  - shot: result'].join(
      '\n',
    );
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-capture-authored-url-'));
    const sourceFile = path.join(config.home(), 'synthetic-workload.yaml');
    fs.writeFileSync(sourceFile, source);
    const workload = parseWorkload(fs.readFileSync(sourceFile, 'utf8'), sourceFile);
    const driver = await browserDriver(origin, dest);
    const banner = driver.banner!.bind(driver);
    const narrations: string[] = [];
    driver.banner = async (text) => {
      narrations.push(text);
      await banner(text);
      if (text.startsWith('step 1:')) {
        await driver.settle!(500);
        await driver.screenshot(path.join(dest, 'authored-url-banner.png'));
      }
    };
    const manifest = await run(workload, driver, dest, { root_url: origin });
    expect(manifest.status).toBe('ok');
    expect(requests).toContain('/destination');
    expect(authorized).toBe(true);
    expect(workload.steps[1]!.target).toBe(target);
    expect(fs.readFileSync(sourceFile, 'utf8')).toBe(source);
    for (const text of [
      JSON.stringify(narrations),
      fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'),
    ]) {
      expect(text).not.toContain(user);
      expect(text).not.toContain(password);
    }
  });

  test('honors a goto deadline and retains its honest failed capture', async () => {
    server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<p>slow response</p>');
      }, 400);
    });
    await listen(server);
    const address = server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const urlMarker = 'capture-url-marker-987';
    const unsafeRoot = `http://capture-user:${urlMarker}@127.0.0.1:${String(
      address.port,
    )}/customer/${urlMarker}?ticket=${urlMarker}`;
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-capture-timeout-'));
    const driver = await browserDriver(origin, dest);
    let failure: unknown;
    try {
      await run(
        parseWorkload('steps:\n  - goto: /slow\n    timeout_ms: 50\n', 'fixture'),
        driver,
        dest,
        {
          root_url: unsafeRoot,
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('navigation timed out');
    expect((failure as Error).message).not.toContain(urlMarker);
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')) as {
      status: string;
      failure_kind: string;
      failed_step: { action: string; error: string };
    };
    expect(manifest.status).toBe('failed');
    expect(manifest.failure_kind).toBe('step');
    expect(manifest.failed_step.action).toBe('goto');
    expect(manifest.failed_step.error).toBe('navigation timed out');
    const retained = fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8');
    expect(retained).not.toContain(urlMarker);
    expect(fs.readFileSync(path.join(dest, 'trace.json'), 'utf8')).not.toContain(urlMarker);
  });
});
