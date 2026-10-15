import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { chromium } from 'playwright';

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

/** Read regular ZIP entries from Playwright's trace so the test sees its actual contents. */
function zipEntries(bytes: Buffer): Buffer[] {
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 0x10016); at -= 1) {
    if (
      bytes.readUInt32LE(at) === 0x06054b50 &&
      at + 22 + bytes.readUInt16LE(at + 20) === bytes.length
    ) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('trace has no ZIP end record');
  const count = bytes.readUInt16LE(end + 10);
  const centralEnd = bytes.readUInt32LE(end + 16) + bytes.readUInt32LE(end + 12);
  let at = bytes.readUInt32LE(end + 16);
  const entries: Buffer[] = [];
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > centralEnd || bytes.readUInt32LE(at) !== 0x02014b50)
      throw new Error(`trace central entry ${String(index)} is invalid`);
    const method = bytes.readUInt16LE(at + 10);
    const compressed = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const localAt = bytes.readUInt32LE(at + 42);
    if (bytes.readUInt32LE(localAt) !== 0x04034b50)
      throw new Error(`trace local entry ${String(index)} is invalid`);
    const dataAt =
      localAt + 30 + bytes.readUInt16LE(localAt + 26) + bytes.readUInt16LE(localAt + 28);
    const data = bytes.subarray(dataAt, dataAt + compressed);
    entries.push(method === 0 ? data : zlib.inflateRawSync(data));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decode the simple non-interlaced 8-bit PNG Playwright writes, including its row filters. */
function pngPixels(bytes: Buffer): { channels: number; data: Buffer } {
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
  return { channels, data: decoded };
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

describe('scripted capture in a real browser', () => {
  let server: Server | null = null;
  let dest = '';

  afterEach(async () => {
    if (server !== null) {
      await close(server);
      expect(server.listening).toBe(false);
      server = null;
    }
    if (dest !== '') fs.rmSync(dest, { recursive: true, force: true });
    dest = '';
  });

  test('masks a literal credential value selected by a password field before recording browser artifacts', async () => {
    server = createServer((request, response) => {
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
  <form id="sign-in">
    <label>Credential <input id="credential" name="password"></label>
    <button id="submit" type="submit">Sign in</button>
  </form>
  <p id="signed-in" hidden>Signed in</p>
  <script>
    document.getElementById('sign-in').addEventListener('submit', (event) => {
      event.preventDefault();
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
        '  - fill: input[name=password]',
        `    value: ${JSON.stringify(LITERAL_PASSWORD)}`,
        '  - click: "#submit"',
        '  - wait_for: "#signed-in"',
        '  - shot: signed-in',
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
    expect(manifest.trace).toBe('trace.zip');
    expect(manifest.privacy).toEqual({
      known_secret_values: 2,
      masked_input_selectors: ['input[name=password]'],
      trace_screenshots: false,
      trace_snapshots: false,
      visual_review_required: true,
    });
    expect(fs.existsSync(path.join(dest, 'video.webm'))).toBe(true);
    const frame = fs.readFileSync(path.join(dest, 'steps', 'step-02-fill.png'));
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
        const at = Math.max(0, Math.min(video.duration / 2, video.duration - 0.1));
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
    } finally {
      await reviewer.close();
    }

    const trace = zipEntries(fs.readFileSync(path.join(dest, 'trace.zip')));
    expect(trace.some((entry) => entry.includes(Buffer.from(ADMIN_PASSWORD)))).toBe(false);
    const escapedPassword = JSON.stringify(LITERAL_PASSWORD).slice(1, -1);
    const formPassword = new URLSearchParams({ value: LITERAL_PASSWORD })
      .toString()
      .slice('value='.length);
    for (const secret of [ADMIN_PASSWORD, LITERAL_PASSWORD, escapedPassword, formPassword]) {
      expect(trace.some((entry) => entry.includes(Buffer.from(secret)))).toBe(false);
    }
    expect(
      trace.some(
        (entry) =>
          entry.includes(PNG_SIGNATURE) ||
          entry.includes(Buffer.from([0xff, 0xd8, 0xff])) ||
          entry.includes(Buffer.from('RIFF')),
      ),
    ).toBe(false);
    const manifestText = fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8');
    expect(manifestText).not.toContain(ADMIN_PASSWORD);
    expect(manifestText).not.toContain(LITERAL_PASSWORD);
  });
});
