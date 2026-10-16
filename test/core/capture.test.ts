import * as fs from 'node:fs';
import * as path from 'node:path';

import type * as RecordNS from '../../src/core/runner/record';

jest.mock('../../src/core/evidence', () => ({ record: jest.fn(), writeBundle: jest.fn() }));
jest.mock('../../src/core/lifecycle/naming', () => ({ resolveName: jest.fn() }));
jest.mock('../../src/core/runner/record', () => {
  const actual = jest.requireActual<typeof RecordNS>('../../src/core/runner/record');
  return { ...actual, readMeta: jest.fn() };
});

import * as evidence from '../../src/core/evidence';
import {
  browserDriver,
  captureBundle,
  listWorkloads,
  loadWorkload,
  parseWorkload,
  prepareBundleRoot,
  REDACTED,
  run,
  type Artifacts,
  type Driver,
  type DriverFactory,
} from '../../src/core/capture';
import * as naming from '../../src/core/lifecycle/naming';
import { reproLock } from '../../src/core/runner/locks';
import { renderCaptureSection } from '../../src/lib/capture-render';
import { metadata, readMeta } from '../../src/core/runner/record';
import * as config from '../../src/lib/config';
import {
  CaptureFailedError,
  ConflictError,
  PreflightError,
  ValidationError,
} from '../../src/lib/errors';

const ADMIN_PASSWORD = 'capture-admin-password-123';

class FakeDriver implements Driver {
  readonly calls: string[] = [];
  readonly fills: string[] = [];
  finished = false;
  private readonly maskedSelectors = new Set<string>();

  constructor(
    private readonly dest: string,
    private readonly failure: string | null = null,
    private readonly runtimeSecret = 'session-token-123',
  ) {}

  async goto(url: string): Promise<void> {
    this.calls.push(`goto:${url}`);
  }

  async click(selector: string): Promise<void> {
    this.calls.push(`click:${selector}`);
    if (this.failure === 'click') throw new Error(`browser rejected ${this.runtimeSecret}`);
  }

  async fill(selector: string, value: string): Promise<void> {
    this.calls.push(`fill:${selector}`);
    this.fills.push(value);
    if (value.includes(ADMIN_PASSWORD)) this.maskedSelectors.add(selector);
  }

  async press(key: string): Promise<void> {
    this.calls.push(`press:${key}`);
  }

  async waitFor(selector: string): Promise<void> {
    this.calls.push(`wait:${selector}`);
  }

  async screenshot(file: string): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(5000, 0x61));
  }

  async finish(): Promise<Artifacts> {
    this.finished = true;
    fs.writeFileSync(path.join(this.dest, 'video.webm'), Buffer.alloc(17000, 0x62));
    return {
      video: 'video.webm',
      secrets: [this.runtimeSecret],
      maskedSelectors: [...this.maskedSelectors],
    };
  }
}

function writeWorkload(name: string, text: string): void {
  fs.mkdirSync(config.workloadDir(), { recursive: true });
  fs.writeFileSync(path.join(config.workloadDir(), `${name}.yaml`), text, 'utf8');
}

function workload(name = 'fixture') {
  return parseWorkload(
    [
      `name: ${name}`,
      'description: a test capture',
      'steps:',
      '  - goto: "/"',
      '  - fill: "#password"',
      '    value: "{{admin_pass}}"',
      '  - click: "#submit"',
      '  - shot: "../outside"',
    ].join('\n'),
    'fixture',
  );
}

const mockRecord = jest.mocked(evidence.record);
const mockWriteBundle = jest.mocked(evidence.writeBundle);
const mockResolveName = jest.mocked(naming.resolveName);
const mockReadMeta = jest.mocked(readMeta);

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveName.mockResolvedValue('ticket-1234');
  mockReadMeta.mockResolvedValue(
    metadata({
      name: 'ticket-1234',
      rootUrl: 'http://127.0.0.1:3000',
      adminPassword: ADMIN_PASSWORD,
    }),
  );
  mockRecord.mockResolvedValue({ repro: { name: 'ticket-1234' } });
});

describe('scripted browser capture', () => {
  test('refuses an unreadable user override instead of running the built-in smoke workload', async () => {
    fs.mkdirSync(path.join(config.workloadDir(), 'smoke.yaml'), { recursive: true });
    await expect(loadWorkload('smoke')).rejects.toThrow(/cannot read workload.*EISDIR/u);
  });

  test('names unreadable valid workload entries without advertising invalid names', async () => {
    fs.mkdirSync(path.join(config.workloadDir(), 'broken.yaml'), { recursive: true });
    writeWorkload('ready', 'name: ready\ndescription: ready to run\nsteps:\n  - goto: /\n');
    writeWorkload('my flow', 'name: invalid\nsteps:\n  - goto: /\n');
    writeWorkload('.hidden', 'name: hidden\nsteps:\n  - goto: /\n');

    const rows = await listWorkloads();

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ready', description: 'ready to run' }),
        expect.objectContaining({
          name: 'broken',
          source: path.join(config.workloadDir(), 'broken.yaml'),
          description: expect.stringMatching(/^UNREADABLE — cannot read workload /u),
        }),
      ]),
    );
    for (const invalid of ['my flow', '.hidden'])
      expect(rows.map((row) => row.name)).not.toContain(invalid);
  });

  test('reports an unreadable workload directory instead of presenting an empty user catalogue', async () => {
    const previousHome = config.home();
    const home = path.join(previousHome, 'unreadable-home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'workloads'), 'not a directory');
    process.env.HOUSTON_HOME = home;
    try {
      await expect(listWorkloads()).rejects.toThrow(/cannot list workloads.*ENOTDIR/u);
    } finally {
      process.env.HOUSTON_HOME = previousHome;
    }
  });

  test('passes the requested and default navigation deadlines to the driver', async () => {
    const dest = path.join(config.home(), 'navigation-timeouts');
    const driver = new FakeDriver(dest);
    const goto = jest.spyOn(driver, 'goto');
    await run(
      parseWorkload(
        'steps:\n  - goto: /slow\n    timeout_ms: 61000\n  - goto: /default\n',
        'fixture',
      ),
      driver,
      dest,
    );
    expect(goto.mock.calls).toEqual([
      ['/slow', 61000],
      ['/default', 15000],
    ]);
  });

  test('resolves relative, root-relative and absolute goto targets without mangling them', async () => {
    const dest = path.join(config.home(), 'navigation-targets');
    const driver = new FakeDriver(dest);
    const goto = jest.spyOn(driver, 'goto');
    await run(
      parseWorkload(
        [
          'steps:',
          '  - goto: login',
          '  - goto: /rooms/general',
          '  - goto: "https://idp.example.test/login?prompt=login"',
        ].join('\n'),
        'fixture',
      ),
      driver,
      dest,
      { root_url: 'http://127.0.0.1:3000/customer/path?ticket=hidden' },
    );

    expect(goto.mock.calls).toEqual([
      ['http://127.0.0.1:3000/login', 15000],
      ['http://127.0.0.1:3000/rooms/general', 15000],
      ['https://idp.example.test/login?prompt=login', 15000],
    ]);
  });

  test('records authored URL shapes safely without copying context expansion back from navigation', async () => {
    const contextURL = 'https://context-user:context-value@idp.example.test/landing';
    const cases = [
      [
        'http://workspace.test',
        'http:user:key@idp.example.test/login',
        REDACTED,
        'http://workspace.test/user:key@idp.example.test/login',
      ],
      [
        'https://workspace.test',
        'http:user:key@idp.example.test/login',
        'http://idp.example.test/login',
        'http://user:key@idp.example.test/login',
      ],
      [
        'http://workspace.test',
        'https:user:key@idp.example.test/login',
        'https://idp.example.test/login',
        'https://user:key@idp.example.test/login',
      ],
      [
        'https://workspace.test',
        'https:user:key@idp.example.test/login',
        REDACTED,
        'https://workspace.test/user:key@idp.example.test/login',
      ],
      [
        '',
        'http:user:key@idp.example.test/login',
        'http://idp.example.test/login',
        'http:user:key@idp.example.test/login',
      ],
      [
        'https://workspace.test',
        'login?prompt=login',
        'login?prompt=login',
        'https://workspace.test/login?prompt=login',
      ],
      [
        'http://workspace.test',
        '/rooms/general',
        '/rooms/general',
        'http://workspace.test/rooms/general',
      ],
      [
        'https://workspace.test',
        '//user:key@idp.example.test/login',
        'https://idp.example.test/login',
        'https://user:key@idp.example.test/login',
      ],
      ['http://workspace.test', '{{next}}', '{{next}}', contextURL],
      [
        'https://workspace.test',
        'https://user:{{admin_pass}}@idp.example.test/login',
        'https://idp.example.test/login',
        'https://user:context-password@idp.example.test/login',
      ],
      [
        'https://workspace.test',
        '/?next=https%3A%2F%2Fuser%3Akey%40idp.example.test',
        REDACTED,
        'https://workspace.test/?next=https%3A%2F%2Fuser%3Akey%40idp.example.test',
      ],
      [
        'https://workspace.test',
        '/#next=https://user@idp.example.test',
        REDACTED,
        'https://workspace.test/#next=https://user@idp.example.test',
      ],
    ];
    for (const root of ['http://workspace.test', 'https://workspace.test', '']) {
      for (const delimiter of ['%2F', '%3F', '%23', '%5C', '%20']) {
        const nested = `https://user:synthetic${delimiter}key@idp.example.test/callback`;
        for (const part of ['query', 'path', 'fragment']) {
          for (let depth = 0; depth < 3; depth += 1) {
            let encoded = nested;
            for (let layer = 0; layer < depth; layer += 1) encoded = encodeURIComponent(encoded);
            const target =
              part === 'query'
                ? `/?next=${encoded}`
                : part === 'path'
                  ? `/${encoded}`
                  : `/#next=${encoded}`;
            cases.push([root, target, REDACTED, `${root}${target}`]);
          }
        }
        // URL punctuation can be encoded independently of the password's delimiter.
        for (const encoded of [
          nested.replace('@', '%40'),
          nested.replace('https://', 'https%3A%2F%2F').replace('@', '%40'),
        ]) {
          const target = `/?next=${encoded}`;
          cases.push([root, target, REDACTED, `${root}${target}`]);
        }
      }
    }
    // Mixed depth: the password's delimiter is raw (or one layer encoded) while the `@` is
    // encoded one or two layers deeper, so no single decoded layer shows both at once.
    const encodeTimes = (text: string, times: number): string => {
      let encoded = text;
      for (let layer = 0; layer < times; layer += 1) encoded = encodeURIComponent(encoded);
      return encoded;
    };
    const mixed: string[] = [
      '/?next=https://user:pa ss@idp.example.test/cb',
      '/?next=https://user:pa%20ss%2540idp.example.test/cb',
      '/?next=postgres://user:pa\\ss@db.example.test/x',
      '/?next=postgres%3A%2F%2Fuser%3Apa%5Css%2540db.example.test',
    ];
    for (const delimiter of [' ', '%20', '\\', '%5C', ' ', '\u000b']) {
      for (const scheme of ['https', 'postgres']) {
        for (const atDepth of [0, 1, 2]) {
          for (const wrap of [0, 1]) {
            const nested = `${scheme}://user:pa${delimiter}ss${encodeTimes('@', atDepth)}idp.example.test/cb`;
            mixed.push(`/?next=${encodeTimes(nested, wrap)}`);
          }
        }
      }
    }
    for (const root of ['http://workspace.test', 'https://workspace.test', '']) {
      for (const target of mixed) {
        cases.push([root, target, REDACTED, root === '' ? target : new URL(target, root).href]);
      }
    }
    for (const target of [
      '/?next=https://idp.example.test/callback%2Fsafe',
      '/path/person@example.test',
      '/?next=https%3A%2F%2Fidp.example.test%2Fcallback',
    ]) {
      cases.push(['https://workspace.test', target, target, `https://workspace.test${target}`]);
    }
    for (const target of [
      '/?percent=%invalid',
      `/?next=${encodeURIComponent(encodeURIComponent(encodeURIComponent(encodeURIComponent(encodeURIComponent('https://user:key@idp.example.test')))))}`,
    ]) {
      cases.push(['https://workspace.test', target, REDACTED, `https://workspace.test${target}`]);
    }
    const recordings: { target: string; recorded: string }[] = [];
    const expected: { target: string; recorded: string }[] = [];
    for (const [index, row] of cases.entries()) {
      const [root, target, recorded, navigated] = row as [string, string, string, string];
      const dest = path.join(config.home(), `recorded-target-${String(index)}`);
      const driver = new FakeDriver(dest);
      const goto = jest.spyOn(driver, 'goto');
      const manifest = await run(
        parseWorkload(`steps:\n  - goto: ${JSON.stringify(target)}\n`, 'fixture'),
        driver,
        dest,
        { root_url: root, next: contextURL, admin_pass: 'context-password' },
      );
      expect(goto.mock.calls).toEqual([[navigated, 15000]]);
      recordings.push({ target, recorded: manifest.steps[0]!.target });
      expected.push({ target, recorded });
      expect(JSON.stringify(manifest)).not.toContain('context-value');
      expect(manifest.privacy.visual_review_required).toBe(true);
    }
    expect(recordings).toEqual(expected);
  });

  test('renders artifact-only failure with its actual cause and no invented failed step', async () => {
    const dest = path.join(config.home(), 'missing-frame');
    const driver = new FakeDriver(dest);
    jest.spyOn(driver, 'screenshot').mockResolvedValue(undefined);
    await expect(run(workload(), driver, dest, { admin_pass: 'unit-pass' })).rejects.toThrow(
      CaptureFailedError,
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    const readme = renderCaptureSection(manifest).join('\n');
    expect(manifest.failed_step).toBeNull();
    expect(readme).toContain('Artifact validation failed');
    expect(readme).toContain('is listed in the manifest but missing');
    expect(readme).not.toContain('stopped at step');
    expect(readme).not.toContain('selectors');
    const failedDest = path.join(config.home(), 'step-zero-failed');
    await expect(
      run(
        parseWorkload('steps:\n  - click: "#submit"\n', 'fixture'),
        new FakeDriver(failedDest, 'click'),
        failedDest,
      ),
    ).rejects.toThrow(CaptureFailedError);
    const failedManifest = JSON.parse(
      fs.readFileSync(path.join(failedDest, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(renderCaptureSection(failedManifest).join('\n')).toContain(
      'stopped at step 0 (click #submit)',
    );
  });

  test('keeps the browser generation and evidence snapshot together while a mutation waits', async () => {
    writeWorkload('race', 'steps:\n  - goto: /\n');
    const out = path.join(config.home(), 'race-bundle');
    let version = 'old';
    let browserVersion = '';
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockRecord.mockImplementation(
      async () => await reproLock('ticket-1234', async () => ({ repro: { rc_version: version } })),
    );
    mockWriteBundle.mockImplementation(
      async (_name, dest) =>
        await reproLock('ticket-1234', async () => {
          fs.mkdirSync(dest);
          return { path: dest, files: [] };
        }),
    );
    const capturing = captureBundle('ticket-1234', 'race', out, {
      driverFactory: async (_url, dest) => {
        browserVersion = version;
        enter();
        await released;
        return new FakeDriver(dest);
      },
    });
    await entered;
    const mutation = reproLock('ticket-1234', () => {
      version = 'new';
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    const payload = await capturing;
    await mutation;
    expect(browserVersion).toBe('old');
    expect(payload.repro).toEqual({ rc_version: browserVersion });
    expect(version).toBe('new');
  });

  test('rejects an invalid workload before starting a browser or creating an output root', async () => {
    writeWorkload('invalid', 'name: invalid\nsteps:\n  - misspelled_action: "#go"\n');
    const out = path.join(config.home(), 'invalid-output');
    const driverFactory = jest.fn<ReturnType<DriverFactory>, Parameters<DriverFactory>>();

    await expect(captureBundle('ticket-1234', 'invalid', out, { driverFactory })).rejects.toThrow(
      ValidationError,
    );
    expect(driverFactory).not.toHaveBeenCalled();
    expect(fs.existsSync(out)).toBe(false);
  });

  test('rejects an empty workload before starting a browser or creating an output root', async () => {
    writeWorkload('empty', 'name: empty\nsteps: []\n');
    const out = path.join(config.home(), 'empty-output');
    const driverFactory = jest.fn<ReturnType<DriverFactory>, Parameters<DriverFactory>>();

    await expect(captureBundle('ticket-1234', 'empty', out, { driverFactory })).rejects.toThrow(
      ValidationError,
    );
    expect(driverFactory).not.toHaveBeenCalled();
    expect(fs.existsSync(out)).toBe(false);
  });

  test('keeps known secrets out of metadata and records the visual-review boundary', async () => {
    const dest = path.join(config.home(), 'safe-capture');
    const driver = new FakeDriver(dest);

    const manifest = await run(workload(), driver, dest, {
      root_url: 'http://127.0.0.1:3000',
      admin_pass: ADMIN_PASSWORD,
    });

    expect(driver.fills).toEqual([ADMIN_PASSWORD]);
    expect(manifest.shots).toEqual(['shots/shot-01.png']);
    expect(fs.existsSync(path.join(path.dirname(dest), 'outside.png'))).toBe(false);
    const onDisk = fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8');
    expect(onDisk).not.toContain(ADMIN_PASSWORD);
    expect(manifest.privacy).toEqual({
      trace_policy: 'action-summary-only',
      known_secret_values: 2,
      masked_input_selectors: ['#password'],
      trace_screenshots: false,
      trace_snapshots: false,
      visual_review_required: true,
    });
    expect(manifest.validation.some((row) => row.status === 'fail')).toBe(false);
  });

  test('requires visual review even when no secret input was masked', async () => {
    const dest = path.join(config.home(), 'unmasked-capture');
    const manifest = await run(
      parseWorkload('name: unmasked\nsteps:\n  - goto: "/"\n', 'fixture'),
      new FakeDriver(dest),
      dest,
      { root_url: 'http://127.0.0.1:3000' },
    );

    expect(manifest.privacy.masked_input_selectors).toEqual([]);
    expect(manifest.privacy.visual_review_required).toBe(true);
  });

  test('redacts a literal workspace secret before it can reach the staged manifest', async () => {
    const dest = path.join(config.home(), 'literal-secret');
    const driver = new FakeDriver(dest);
    const literal = parseWorkload(
      [
        'name: literal-secret',
        'steps:',
        '  - goto: "/"',
        '  - fill: "#public-note"',
        `    value: "copied ${ADMIN_PASSWORD}"`,
      ].join('\n'),
      'fixture',
    );

    const manifest = await run(literal, driver, dest, {
      root_url: 'http://127.0.0.1:3000',
      admin_pass: ADMIN_PASSWORD,
    });

    expect(manifest.steps[1]?.value).toBe(REDACTED);
    expect(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')).not.toContain(ADMIN_PASSWORD);
  });

  test('redacts a secret discovered at finish from every persisted manifest field', async () => {
    const runtimeSecret = 'late-session-token-456';
    const dest = path.join(config.home(), 'late-secret');
    const late = parseWorkload(
      [
        `name: "run ${runtimeSecret}"`,
        `description: "description ${runtimeSecret}"`,
        'steps:',
        `  - goto: "/${runtimeSecret}"`,
        '  - fill: "#public-note"',
        `    value: "${runtimeSecret}"`,
        `  - click: "#${runtimeSecret}"`,
      ].join('\n'),
      'fixture',
    );

    await expect(run(late, new FakeDriver(dest, 'click', runtimeSecret), dest)).rejects.toThrow(
      CaptureFailedError,
    );

    const persisted = fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8');
    expect(persisted).not.toContain(runtimeSecret);
    const manifest = JSON.parse(persisted) as {
      workload: string;
      description: string;
      steps: { target: string; value?: string; error?: string }[];
    };
    expect(manifest.workload).toContain(REDACTED);
    expect(manifest.description).toContain(REDACTED);
    expect(manifest.steps.map((step) => step.target).join('\n')).toContain(REDACTED);
    expect(manifest.steps.map((step) => step.value ?? '').join('\n')).toContain(REDACTED);
    expect(manifest.steps.map((step) => step.error ?? '').join('\n')).toContain(REDACTED);
  });

  test('redacts an overlapping session secret as one whole value', async () => {
    const prefix = 'shared-secret';
    const session = `${prefix}-session-token`;
    const dest = path.join(config.home(), 'overlapping-secret');
    const workload = parseWorkload(
      [`name: "run ${session}"`, 'steps:', `  - click: "#${session}"`].join('\n'),
      'fixture',
    );

    await expect(
      run(workload, new FakeDriver(dest, 'click', session), dest, {
        root_url: 'http://127.0.0.1:3000',
        admin_pass: prefix,
      }),
    ).rejects.toThrow(CaptureFailedError);

    const persisted = fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8');
    expect(persisted).toContain(`run ${REDACTED}`);
    expect(persisted).not.toContain(session);
    expect(persisted).not.toContain('-session-token');
  });

  test('closes the driver when initial capture artifact setup fails', async () => {
    const blocked = path.join(config.home(), 'blocked-capture-parent');
    fs.writeFileSync(blocked, 'not a directory');
    const dest = path.join(blocked, 'capture');
    const driver = new FakeDriver(dest);

    await expect(run(workload(), driver, dest)).rejects.toThrow();
    expect(driver.finished).toBe(true);
  });

  test('force deletes only a positively identified Houston evidence bundle', async () => {
    const arbitrary = path.join(config.home(), 'arbitrary');
    fs.mkdirSync(arbitrary, { recursive: true });
    fs.writeFileSync(path.join(arbitrary, 'notes.txt'), 'leave this alone');

    await expect(prepareBundleRoot(arbitrary, true)).rejects.toThrow(ConflictError);
    expect(fs.readFileSync(path.join(arbitrary, 'notes.txt'), 'utf8')).toBe('leave this alone');

    const prior = path.join(config.home(), 'prior-bundle');
    fs.mkdirSync(prior, { recursive: true });
    fs.writeFileSync(path.join(prior, 'README.md'), '# prior');
    fs.writeFileSync(path.join(prior, 'manifest.json'), '{"repro":{"name":"ticket-1234"}}');

    await prepareBundleRoot(prior, true);
    expect(fs.existsSync(prior)).toBe(false);
  });

  test('force refuses a directory whose evidence manifest is a symlink', async () => {
    const outside = path.join(config.home(), 'outside-manifest.json');
    fs.writeFileSync(outside, '{"repro":{"name":"ticket-1234"}}');
    const arbitrary = path.join(config.home(), 'symlinked-manifest');
    fs.mkdirSync(arbitrary, { recursive: true });
    fs.writeFileSync(path.join(arbitrary, 'README.md'), '# not enough to identify this bundle');
    fs.writeFileSync(path.join(arbitrary, 'notes.txt'), 'leave this alone');
    fs.symlinkSync(outside, path.join(arbitrary, 'manifest.json'));

    await expect(prepareBundleRoot(arbitrary, true)).rejects.toThrow(ConflictError);
    expect(fs.readFileSync(path.join(arbitrary, 'notes.txt'), 'utf8')).toBe('leave this alone');
  });

  test('keeps an identifiable forced bundle when browser preflight fails', async () => {
    writeWorkload('preflight', 'steps:\n  - goto: /\n');
    const out = path.join(config.home(), 'preflight-bundle');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'README.md'), '# prior evidence');
    fs.writeFileSync(path.join(out, 'manifest.json'), '{"repro":{"name":"ticket-1234"}}');
    const driverFactory: DriverFactory = async () => {
      throw new PreflightError('Playwright is unavailable');
    };

    await expect(
      captureBundle('ticket-1234', 'preflight', out, { force: true, driverFactory }),
    ).rejects.toThrow(PreflightError);

    expect(fs.readFileSync(path.join(out, 'README.md'), 'utf8')).toBe('# prior evidence');
    expect(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).toContain('ticket-1234');
  });

  test('writes evidence first, then moves the staged capture into the fresh bundle root', async () => {
    writeWorkload(
      'stage',
      ['name: stage', 'steps:', '  - goto: "/"', '  - shot: landing'].join('\n'),
    );
    const out = path.join(config.home(), 'staged-bundle');
    mockWriteBundle.mockImplementation(async (_name, dest, payload, capture) => {
      expect(fs.existsSync(dest)).toBe(false);
      expect(payload.capture).toBeUndefined();
      expect((capture as { workload?: string }).workload).toBe('stage');
      fs.mkdirSync(dest);
      fs.writeFileSync(path.join(dest, 'manifest.json'), '{}');
      fs.writeFileSync(path.join(dest, 'README.md'), '# evidence');
      return { path: dest, files: ['README.md', 'manifest.json'] };
    });
    const driverFactory: DriverFactory = async (_root, dest) => new FakeDriver(dest);

    const payload = await captureBundle('ticket-1234', 'stage', out, { driverFactory });

    expect(fs.existsSync(path.join(out, 'capture', 'manifest.json'))).toBe(true);
    expect((payload.bundle as { files: string[] }).files).toEqual(
      expect.arrayContaining(['capture/manifest.json', 'capture/shots/shot-01.png']),
    );
    expect(
      fs
        .readdirSync(path.dirname(out))
        .filter((entry) => entry.startsWith('.staged-bundle.stage-')),
    ).toEqual([]);
  });

  test('keeps a failed capture in its bundle and reports the manifest at its final path', async () => {
    writeWorkload(
      'failed-step',
      ['name: failed-step', 'steps:', '  - goto: "/"', '  - click: "#submit"'].join('\n'),
    );
    const out = path.join(config.home(), 'failed-step-bundle');
    mockWriteBundle.mockImplementation(async (_name, dest, _payload, capture) => {
      expect((capture as { status?: string }).status).toBe('failed');
      fs.mkdirSync(dest);
      fs.writeFileSync(path.join(dest, 'manifest.json'), '{}');
      fs.writeFileSync(path.join(dest, 'README.md'), '# evidence');
      return { path: dest, files: ['README.md', 'manifest.json'] };
    });
    const driverFactory: DriverFactory = async (_root, dest) => new FakeDriver(dest, 'click');

    let caught: unknown;
    try {
      await captureBundle('ticket-1234', 'failed-step', out, { driverFactory });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CaptureFailedError);
    const failure = caught as CaptureFailedError;
    const manifest = path.join(out, 'capture', 'manifest.json');
    expect(failure.details).toMatchObject({ bundle: out, manifest });
    expect(failure.message).toContain(`Partial capture bundle retained at ${out}.`);
    expect(fs.existsSync(manifest)).toBe(true);
    expect(JSON.parse(fs.readFileSync(manifest, 'utf8'))).toMatchObject({ status: 'failed' });
  });

  test('retains the staged artifacts and reports their location if evidence cannot be written', async () => {
    writeWorkload('writer-fails', 'name: writer-fails\nsteps:\n  - goto: "/"\n');
    const out = path.join(config.home(), 'failed-evidence');
    mockWriteBundle.mockRejectedValue(new ValidationError('evidence writer stopped'));
    const driverFactory: DriverFactory = async (_root, dest) => new FakeDriver(dest);

    let caught: unknown;
    try {
      await captureBundle('ticket-1234', 'writer-fails', out, { driverFactory });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    const stage = (caught as ValidationError).details.capture_stage as string;
    expect(stage).toContain('.failed-evidence.stage-');
    expect(fs.existsSync(path.join(stage, 'capture', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(out)).toBe(false);
  });

  test('refuses an unresolved workload placeholder before it is typed, navigated or launched', async () => {
    const context = { root_url: 'http://127.0.0.1:3000', admin_user: 'admin', admin_pass: 'x1' };
    for (const text of [
      'steps:\n  - goto: "/{{admin_usr}}"\n',
      'steps:\n  - goto: /\n  - fill: "#email"\n    value: "{{admin_usr}}"\n',
      'steps:\n  - goto: /\n  - fill: "#email"\n    value: "{{admin_user}} {{nope}}"\n',
    ]) {
      const dest = path.join(config.home(), `unresolved-${String(text.length)}`);
      const driver = new FakeDriver(dest);
      await expect(run(parseWorkload(text, 'fixture'), driver, dest, context)).rejects.toThrow(
        /unresolved placeholder \{\{(?:admin_usr|nope)\}\}/u,
      );
      expect(driver.calls).toEqual([]);
      expect(driver.fills).toEqual([]);
    }
    // A resolved value that happens to contain placeholder syntax is data, not a placeholder.
    const dest = path.join(config.home(), 'braced-secret');
    const driver = new FakeDriver(dest);
    await run(workload(), driver, dest, { ...context, admin_pass: 'p{{x}}ss' });
    expect(driver.fills).toEqual(['p{{x}}ss']);

    writeWorkload('typo', 'steps:\n  - goto: /\n  - fill: "#email"\n    value: "{{admin_usr}}"\n');
    const driverFactory = jest.fn<ReturnType<DriverFactory>, Parameters<DriverFactory>>();
    await expect(
      captureBundle('ticket-1234', 'typo', path.join(config.home(), 'typo-bundle'), {
        driverFactory,
      }),
    ).rejects.toThrow(ValidationError);
    expect(driverFactory).not.toHaveBeenCalled();
  });

  test('fails the capture when the driver leaves the raw recording directory behind', async () => {
    class LeakyDriver extends FakeDriver {
      constructor(private readonly where: string) {
        super(where);
      }
      override async finish(): Promise<Artifacts> {
        fs.mkdirSync(path.join(this.where, '_video'), { recursive: true });
        fs.writeFileSync(path.join(this.where, '_video', 'raw.webm'), Buffer.alloc(17000, 0x63));
        return await super.finish();
      }
    }
    const dest = path.join(config.home(), 'leaky-run');
    await expect(
      run(parseWorkload('steps:\n  - goto: /\n', 'fixture'), new LeakyDriver(dest), dest),
    ).rejects.toThrow(/raw browser recording/u);
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')) as {
      status: string;
      failure_kind: string;
      validation: { check: string; status: string }[];
    };
    expect(manifest.status).toBe('failed');
    expect(manifest.failure_kind).toBe('artifact');
    expect(manifest.validation).toContainEqual(
      expect.objectContaining({ check: 'raw-recording', status: 'fail' }),
    );
  });

  test.each(['removable', 'locked'])(
    'never publishes a %s raw recording directory with the capture bundle',
    async (mode) => {
      writeWorkload('leaky', 'name: leaky\nsteps:\n  - goto: /\n');
      const out = path.join(config.home(), `leaky-bundle-${mode}`);
      mockWriteBundle.mockImplementation(async (_name, dest) => {
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, 'README.md'), '# evidence');
        return { path: dest, files: ['README.md'] };
      });
      let locked = '';
      const driverFactory: DriverFactory = async (_root, dest) => {
        const driver = new FakeDriver(dest);
        const finish = driver.finish.bind(driver);
        driver.finish = async () => {
          const raw = path.join(dest, '_video');
          fs.mkdirSync(path.join(raw, 'inner'), { recursive: true });
          fs.writeFileSync(path.join(raw, 'inner', 'raw.webm'), Buffer.alloc(17000, 0x63));
          if (mode === 'locked') {
            locked = path.join(raw, 'inner');
            fs.chmodSync(locked, 0o500);
          }
          return await finish();
        };
        return driver;
      };
      let caught: unknown;
      try {
        await captureBundle('ticket-1234', 'leaky', out, { driverFactory });
      } catch (error) {
        caught = error;
      }
      try {
        expect(caught).toBeInstanceOf(Error);
        expect(fs.existsSync(path.join(out, 'capture', '_video'))).toBe(false);
        const published = fs.readdirSync(path.join(out, 'capture'), { recursive: true });
        expect(published.map(String).filter((entry) => entry.includes('raw.webm'))).toEqual([]);
      } finally {
        // The unremovable directory is moved aside, so restore access wherever it now is.
        const moved = fs
          .readdirSync(path.dirname(out), { recursive: true })
          .map(String)
          .filter((entry) => entry.endsWith(path.join('withheld-raw-recording', 'inner')));
        for (const entry of [...moved.map((item) => path.join(path.dirname(out), item)), locked]) {
          if (entry !== '' && fs.existsSync(entry)) fs.chmodSync(entry, 0o700);
        }
      }
    },
  );

  test('gives workspace userinfo to the browser as HTTP credentials and to no artifact', async () => {
    writeWorkload('basic-auth', 'name: basic-auth\nsteps:\n  - goto: /\n  - shot: landing\n');
    mockReadMeta.mockResolvedValue(
      metadata({
        name: 'ticket-1234',
        rootUrl: 'http://basic%20user:p%40ss%3Aword@127.0.0.1:3000',
        adminPassword: ADMIN_PASSWORD,
      }),
    );
    mockWriteBundle.mockImplementation(async (_name, dest) => {
      fs.mkdirSync(dest);
      fs.writeFileSync(path.join(dest, 'README.md'), '# evidence');
      return { path: dest, files: ['README.md'] };
    });
    const seen: { root: string; secrets: readonly string[]; options: unknown }[] = [];
    const driverFactory: DriverFactory = async (root, dest, secrets, options) => {
      seen.push({ root, secrets, options });
      return new FakeDriver(dest);
    };
    const out = path.join(config.home(), 'basic-auth-bundle');
    await captureBundle('ticket-1234', 'basic-auth', out, { driverFactory });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.root).toBe('http://127.0.0.1:3000');
    expect(seen[0]!.options).toEqual({
      httpCredentials: { username: 'basic user', password: 'p@ss:word' },
    });
    // The encoded spelling is what a URL-shaped log line would carry, so it is redacted too.
    expect(seen[0]!.secrets).toEqual(
      expect.arrayContaining([ADMIN_PASSWORD, 'p@ss:word', 'p%40ss%3Aword']),
    );
    const files = fs.readdirSync(out, { recursive: true, withFileTypes: true });
    for (const entry of files.filter((item) => item.isFile())) {
      const text = fs.readFileSync(path.join(entry.parentPath, entry.name)).toString('latin1');
      expect(text).not.toMatch(/p%40ss|p@ss|basic(?:%20| )user/u);
    }
  });

  test('opens the browser context with the workspace HTTP credentials limited to its origin', async () => {
    const dest = path.join(config.home(), 'pw-credentials');
    const page = {
      video: () => null,
      close: async () => undefined,
      evaluate: async () => null,
    };
    const context = {
      newPage: async () => page,
      cookies: async () => [],
      close: async () => undefined,
    };
    const newContext = jest.fn(async () => context);
    const driver = await browserDriver('http://127.0.0.1:3000', dest, ['s3cret-pass'], {
      httpCredentials: { username: 'basic', password: 'p@ss' },
      playwright: {
        chromium: { launch: async () => ({ newContext, close: async () => undefined }) },
      } as never,
    });
    expect(newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://127.0.0.1:3000',
        httpCredentials: {
          username: 'basic',
          password: 'p@ss',
          origin: 'http://127.0.0.1:3000',
        },
      }),
    );
    expect((await driver.finish()).secrets).toEqual(
      expect.arrayContaining(['s3cret-pass', 'p@ss']),
    );
  });
});
