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
  captureBundle,
  parseWorkload,
  prepareBundleRoot,
  REDACTED,
  run,
  type Artifacts,
  type Driver,
  type DriverFactory,
} from '../../src/core/capture';
import * as naming from '../../src/core/lifecycle/naming';
import { metadata, readMeta } from '../../src/core/runner/record';
import * as config from '../../src/lib/config';
import { CaptureFailedError, ConflictError, ValidationError } from '../../src/lib/errors';

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
    fs.writeFileSync(path.join(this.dest, 'trace.zip'), Buffer.from('scrubbed trace'));
    return {
      video: 'video.webm',
      trace: 'trace.zip',
      traceHits: 1,
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
});
