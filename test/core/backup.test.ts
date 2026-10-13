import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import * as config from '../../src/lib/config';
import type * as ComposeNS from '../../src/lib/compose';
import type * as ErrorsNS from '../../src/lib/errors';
import type * as ContextNS from '../../src/lib/context';
import type * as EventsNS from '../../src/lib/events';
import type * as ExecNS from '../../src/seams/exec';
import { memberNames, readMember, writeTarGzFromDir } from '../../src/lib/targz';
import type * as TargzNS from '../../src/lib/targz';
import type * as PolicyNS from '../testsetup-policy';
import { compatibility } from '../../src/core/backup-compat';
import type * as BackupNS from '../../src/core/backup';
import type * as JournalNS from '../../src/core/journal';
import type * as TypesNS from '../../src/core/lifecycle/types';
import { type Metadata, metadata } from '../../src/core/runner/record';
import type * as RecordNS from '../../src/core/runner/record';
import {
  backupsDir,
  bundlePath,
  deleteBackup,
  human,
  listBackups,
  readManifest,
  serialiseManifest,
} from '../../src/core/backup';

interface Outcome {
  ok: boolean;
  message?: string;
}

/**
 * What earlier releases answered and wrote for the cases below, recorded: their answers,
 * the bundles they packed (base64), and the listing of one they packed from a workspace.
 * What differs from run to run is held as a token and put back by `placed`: `<dir>` is the
 * case's own directory, `<home>` is HOME, `<long>` and `<long:120>` are an over-long path
 * whole and as its first 120 characters, and a listing's owner columns are the account the
 * suite runs as, which is whose files earlier releases list.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'core', 'backup.json'), 'utf8'),
) as {
  compatibility: unknown[];
  manifest: string;
  trickyManifest: string;
  earlierBundle: string;
  earlierRead: Record<string, unknown>;
  unsafeBundles: Record<string, string>;
  unsafeOutcomes: Record<string, Outcome>;
  emptyManifestOutcome: Outcome;
  schemaOutcomes: Record<string, Outcome>;
  human: string[];
  expandUser: string[][];
  bundlePaths: string[];
  listing: (string | number | null)[][];
  timeouts: [number, number];
  tempdir: string;
  notABundle: unknown[];
  overLongDelete: { kind: string; message: string };
  earlyFiles: Record<string, string>;
  earlyList: [string, string][];
  tarFiles: Record<string, string>;
  verdicts: Record<string, Record<string, unknown>>;
};

/** `value` with every token in `tokens` replaced by its text, at any depth. */
function placed<T>(value: T, tokens: Record<string, string>): T {
  if (typeof value === 'string') {
    let out: string = value;
    for (const [token, text] of Object.entries(tokens)) out = out.split(token).join(text);
    return out as T;
  }
  if (Array.isArray(value)) return value.map((one: unknown) => placed(one, tokens)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, one]) => [key, placed(one as unknown, tokens)]),
    ) as T;
  }
  return value;
}

/** Set a path's times to the nanosecond, access time first; `utimes` keeps microseconds. */
function stamp(target: string, atimeNs: bigint, mtimeNs: bigint): void {
  const spell = (ns: bigint): string =>
    `@${String(ns / 1_000_000_000n)}.${String(ns % 1_000_000_000n).padStart(9, '0')}`;
  for (const [flag, ns] of [
    ['-a', atimeNs],
    ['-m', mtimeNs],
  ] as const) {
    const done = spawnSync('touch', [flag, '-d', spell(ns), target], { encoding: 'utf8' });
    expect({ target, status: done.status, stderr: done.stderr }).toEqual({
      target,
      status: 0,
      stderr: '',
    });
  }
}

/**
 * The workspace the listing below was recorded from: a monitoring tree and a seed file with
 * modes of their own, every file dated `1790000000123456789 + n` ns and every directory
 * `1790000000987654321 + n` ns, where n is the directory's place in sorted order -- the
 * files by the directory holding them, the directories counted from the deepest back.
 */
function shapeWorkspace(ws: string): void {
  fs.mkdirSync(path.join(ws, 'monitoring', 'grafana', 'dashboards'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'monitoring', 'grafana', 'dashboards', 'rc.json'), '{}');
  fs.writeFileSync(path.join(ws, 'monitoring', 'prometheus.yml'), 'scrape: []');
  fs.writeFileSync(path.join(ws, 'seed.ldif'), 'dn: x');
  fs.chmodSync(path.join(ws, 'seed.ldif'), 0o600);
  fs.chmodSync(path.join(ws, 'monitoring', 'grafana'), 0o750);
  fs.chmodSync(path.join(ws, 'monitoring', 'prometheus.yml'), 0o640);
  const dirs: string[] = [];
  const walk = (dir: string): void => {
    dirs.push(dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  };
  walk(ws);
  dirs.sort();
  dirs.forEach((dir, at) => {
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of files) stamp(path.join(dir, name), 1n, 1790000000123456789n + BigInt(at));
  });
  [...dirs].reverse().forEach((dir, at) => {
    stamp(dir, 1n, 1790000000987654321n + BigInt(at));
  });
}

/** The name the group database gives `gid`, or '' where it has none. */
function groupName(gid: number): string {
  for (const line of fs.readFileSync('/etc/group', 'utf8').split('\n')) {
    const [name, , id] = line.split(':');
    if (id === String(gid)) return name ?? '';
  }
  return '';
}

/**
 * Every member of a gzipped tar but the manifest and the archive, as earlier releases list
 * one: name, type, octal mode, owner and group ids and names, size, and the PAX mtime
 * (none for the `files` directory itself).
 */
function listing(bundle: string): (string | number | null)[][] {
  const raw = zlib.gunzipSync(fs.readFileSync(bundle));
  const text = (from: number, length: number): string => {
    const field = raw.subarray(from, from + length);
    const end = field.indexOf(0);
    return field.subarray(0, end === -1 ? length : end).toString('utf8');
  };
  const octal = (from: number, length: number): number => {
    const digits = text(from, length).trim();
    return digits === '' ? 0 : parseInt(digits, 8);
  };
  const rows: (string | number | null)[][] = [];
  let pax: Record<string, string> = {};
  for (let at = 0; at + 512 <= raw.length;) {
    if (raw.subarray(at, at + 512).every((byte) => byte === 0)) break;
    const size = octal(at + 124, 12);
    const flag = text(at + 156, 1);
    const type = flag === '' ? '0' : flag;
    const body = raw.subarray(at + 512, at + 512 + size);
    const header = at;
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = {};
      for (let pos = 0; pos < body.length;) {
        const space = body.indexOf(0x20, pos);
        const length = parseInt(body.subarray(pos, space).toString('utf8'), 10);
        const record = body.subarray(space + 1, pos + length - 1).toString('utf8');
        const eq = record.indexOf('=');
        pax[record.slice(0, eq)] = record.slice(eq + 1);
        pos += length;
      }
      continue;
    }
    const prefix = text(header + 345, 155);
    const stored = text(header, 100);
    const name = (pax.path ?? (prefix === '' ? stored : `${prefix}/${stored}`)).replace(
      /\/+$/u,
      '',
    );
    if (name !== 'manifest.json' && name !== 'mongo.archive.gz') {
      rows.push([
        name,
        type,
        `0o${octal(header + 100, 8).toString(8)}`,
        octal(header + 108, 8),
        octal(header + 116, 8),
        text(header + 265, 32),
        text(header + 297, 32),
        size,
        name === 'files' ? '' : (pax.mtime ?? null),
      ]);
    }
    pax = {};
  }
  return rows;
}

/** Write each recorded bundle, base64 by name, into `dir`. */
function writeBundles(dir: string, bundles: Record<string, string>): void {
  for (const [name, base64] of Object.entries(bundles)) {
    fs.writeFileSync(path.join(dir, name), Buffer.from(base64, 'base64'));
  }
}

const MANIFEST: Record<string, unknown> = {
  archive_bytes: 1234,
  archive_sha256: 'a'.repeat(64),
  created_at: '2026-01-01T00:00:00+00:00',
  database: 'rocketchat',
  deployment: 'monolith',
  dump_seconds: 1.0,
  env_overrides: { A: '1' },
  houston_version: '0.0.0',
  label: 'nightly',
  live: false,
  mongo_flavor: 'official',
  mongo_tag: '8.0',
  params: { instances: 1 },
  preset: 'default',
  rc_image: 'registry.rocket.chat/rocketchat',
  rc_version: '8.5.1',
  repro: 'alice-rc8-5-1',
  runtime: 'docker',
  schema: 1,
  sidecar_volumes: ['minio_data'],
};

function meta(values: Partial<Metadata> = {}): Metadata {
  return metadata({
    name: 'w',
    project: 'houston-w',
    rcVersion: '8.5.1',
    rcImage: 'i',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset: 'default',
    rootUrl: 'http://localhost:3000',
    hostPort: 3000,
    versionSource: 'map',
    ...values,
  });
}

describe('the restore compatibility policy', () => {
  it('agrees with earlier releases on every direction, blocker and warning', () => {
    const cases: {
      manifest: Record<string, unknown>;
      rcVersion: string;
      mongoTag: string;
      preset: string;
    }[] = [
      {
        manifest: { rc_version: '8.5.1', mongo_tag: '8.0', preset: 'default' },
        rcVersion: '8.5.1',
        mongoTag: '8.0',
        preset: 'default',
      },
      {
        manifest: { rc_version: '8.5.1', mongo_tag: '8.0' },
        rcVersion: '8.6.1',
        mongoTag: '8.0',
        preset: 'default',
      },
      {
        manifest: { rc_version: '8.6.1', mongo_tag: '8.2' },
        rcVersion: '8.5.1',
        mongoTag: '8.0',
        preset: 'default',
      },
      {
        manifest: {
          rc_version: 'garbage',
          mongo_tag: 'nonsense',
          preset: 'ldap',
          sidecar_volumes: ['minio_data'],
          live: true,
        },
        rcVersion: '8.5.1',
        mongoTag: '8.0',
        preset: 'default',
      },
      { manifest: {}, rcVersion: '8.5.1', mongoTag: '8.0', preset: 'default' },
      {
        manifest: {
          rc_version: '8.5.1',
          mongo_tag: '7.0',
          live: true,
          sidecar_volumes: ['a', 'b'],
        },
        rcVersion: '8.5.1',
        mongoTag: '8.0',
        preset: 'default',
      },
      {
        // Read as earlier releases read them: `0`, `false` and `""` are absent, not named
        // presets, and a string sidecar list joins its CHARACTERS.
        manifest: {
          rc_version: '8.5.1',
          mongo_tag: '8.0',
          preset: 0,
          live: 1,
          sidecar_volumes: 'ab',
        },
        rcVersion: '8.5.1',
        mongoTag: '8.0',
        preset: 'default',
      },
    ];
    const recorded = RECORDED.compatibility;
    const mine = cases.map((testCase) =>
      compatibility(
        testCase.manifest,
        meta({
          rcVersion: testCase.rcVersion,
          mongoTag: testCase.mongoTag,
          preset: testCase.preset,
        }),
      ),
    );
    expect(mine).toEqual(recorded);
  });
});

describe('the manifest format', () => {
  it('serialises exactly as earlier releases write it: keys sorted, indented by two', () => {
    // No trailing newline: earlier releases write none, and the bundle's manifest is
    // compared as bytes. `dump_seconds` is the float 1.0 they wrote.
    expect(serialiseManifest(MANIFEST)).toBe(RECORDED.manifest);
  });

  it('sorts nested keys and escapes non-ASCII the way earlier releases do', () => {
    // The single-key, ASCII fixture above cannot see either: earlier releases sort keys at
    // EVERY depth, and escape past ASCII what JSON.stringify writes raw.
    const tricky: Record<string, unknown> = {
      ...MANIFEST,
      label: 'a — dash, a \u2028sep, a \u0001ctl, and a "quote"',
      params: { instances: 1, zeta: 'z', alpha: 'a' },
      env_overrides: { ZED: 'z', ALPHA: 'a', MID: 'm' },
      sidecar_volumes: ['minio_data', 'other'],
    };
    expect(serialiseManifest(tricky)).toBe(RECORDED.trickyManifest);
  });

  it('refuses a bundle cut after the manifest, as earlier releases do', async () => {
    // The manifest member sorts first, so a naive reader that stops there answers for a
    // file whose tail is missing -- and the backup listing then presents a corrupt backup
    // as healthy. Earlier releases enumerate the whole stream and refuse.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-backup-trunc-'));
    try {
      const staging = path.join(dir, 'staging');
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(path.join(staging, 'manifest.json'), serialiseManifest(MANIFEST), 'utf8');
      fs.writeFileSync(path.join(staging, 'mongo.archive.gz'), Buffer.alloc(300 * 1024, 7));
      const bundle = path.join(dir, 'bundle.rcbak');
      await writeTarGzFromDir(staging, bundle);
      const body = fs.readFileSync(bundle);
      const cut = path.join(dir, 'cut.rcbak');
      fs.writeFileSync(cut, body.subarray(0, Math.floor(body.length * 0.9)));
      await expect(readManifest(cut)).rejects.toThrow('ends part-way through');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a bundle an earlier release packed, and packs one it reads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-backup-x-'));
    const earlierBundle = path.join(dir, 'earlier.rcbak');
    const tsStaging = path.join(dir, 'ts-staging');
    const tsBundle = path.join(dir, 'ts.rcbak');
    try {
      // An earlier release -> this build: the bundle it packed from a staging directory
      // holding `JSON.stringify(MANIFEST, null, 2)` and `services: {}`, recorded.
      fs.writeFileSync(earlierBundle, Buffer.from(RECORDED.earlierBundle, 'base64'));
      expect(await readManifest(earlierBundle)).toEqual(MANIFEST);

      // This build -> an earlier release, with the manifest written by `serialiseManifest`:
      // the same members as the bundle it packed, and the manifest bytes it writes, which
      // it read back as the recorded document.
      fs.mkdirSync(tsStaging, { recursive: true });
      fs.writeFileSync(path.join(tsStaging, 'manifest.json'), serialiseManifest(MANIFEST), 'utf8');
      fs.writeFileSync(path.join(tsStaging, 'compose.yml'), 'services: {}\n', 'utf8');
      await writeTarGzFromDir(tsStaging, tsBundle);
      expect(await memberNames(tsBundle)).toEqual(await memberNames(earlierBundle));
      const written = (await readMember(tsBundle, 'manifest.json'))?.toString('utf8');
      expect(written).toBe(RECORDED.manifest);
      expect(JSON.parse(written ?? '')).toEqual(RECORDED.earlierRead);
      expect(RECORDED.earlierRead).toEqual(MANIFEST);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a schema it does not read and a bundle with no manifest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-backup-refuse-'));
    try {
      const staging = path.join(dir, 's');
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(
        path.join(staging, 'manifest.json'),
        JSON.stringify({ ...MANIFEST, schema: 99 }),
        'utf8',
      );
      const wrongSchema = path.join(dir, 'wrong.rcbak');
      await writeTarGzFromDir(staging, wrongSchema);
      await expect(readManifest(wrongSchema)).rejects.toThrow('uses bundle schema 99');

      const empty = path.join(dir, 'empty');
      fs.mkdirSync(empty, { recursive: true });
      const noManifest = path.join(dir, 'nomanifest.rcbak');
      await writeTarGzFromDir(empty, noManifest);
      await expect(readManifest(noManifest)).rejects.toThrow('has no manifest.json');

      await expect(readManifest(path.join(dir, 'absent.rcbak'))).rejects.toThrow(
        'no backup bundle at',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // What earlier releases answered for each bundle below is recorded, so the read-path
  // refusals are compared as messages rather than asserted as prose this build wrote down
  // for itself.

  async function ourManifestOutcome(bundle: string): Promise<{ ok: boolean; message?: string }> {
    try {
      await readManifest(bundle);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  it('refuses an unsafe member on READ, as earlier releases do', async () => {
    // A bundle can arrive from a colleague. Earlier releases check EVERY member before they
    // read the manifest, so a member with an absolute path is refused even though nothing
    // is extracted; this build read the manifest and called the bundle healthy.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-backup-unsafe-'));
    try {
      // Each bundle as an earlier release packed it: the manifest, then one member named
      // `/etc/cron.d/pwn`, or `../esc\u2028ape.txt` -- a name the refusal escapes rather
      // than prints, so a control character reads `\u2028`, not raw.
      for (const name of ['unsafe', 'unsafe-escaped']) {
        const bundle = path.join(dir, `${name}.rcbak`);
        fs.writeFileSync(bundle, Buffer.from(RECORDED.unsafeBundles[name] ?? '', 'base64'));
        const recorded = RECORDED.unsafeOutcomes[name];
        const mine = await ourManifestOutcome(bundle);
        expect(recorded?.ok).toBe(false);
        expect(mine).toEqual(recorded);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies a zero-length manifest as malformed, not missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-backup-empty-manifest-'));
    try {
      const staging = path.join(dir, 's');
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(path.join(staging, 'manifest.json'), '', 'utf8');
      const bundle = path.join(dir, 'empty-manifest.rcbak');
      await writeTarGzFromDir(staging, bundle);
      const recorded = placed(RECORDED.emptyManifestOutcome, { '<dir>': dir });
      const mine = await ourManifestOutcome(bundle);
      expect(recorded.ok).toBe(false);
      expect(mine).toEqual(recorded);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a schema earlier releases take as 1, and quotes the rest as they do', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-backup-schema-'));
    try {
      for (const [name, value] of [
        ['schema-true', true], // true counts as 1 in earlier releases
        ['schema-string', '2'],
      ] as [string, unknown][]) {
        const staging = path.join(dir, name);
        fs.mkdirSync(staging, { recursive: true });
        fs.writeFileSync(
          path.join(staging, 'manifest.json'),
          JSON.stringify({ ...MANIFEST, schema: value }),
          'utf8',
        );
        const bundle = path.join(dir, `${name}.rcbak`);
        await writeTarGzFromDir(staging, bundle);
        const recorded = placed(RECORDED.schemaOutcomes[name], { '<dir>': dir });
        const mine = await ourManifestOutcome(bundle);
        expect(mine).toEqual(recorded);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the managed backup directory', () => {
  it('is the same directory earlier releases use, and its sizes read the same', () => {
    expect(backupsDir()).toBe(path.join(config.home(), 'backups'));
    const holes: [number, string][] = [
      [0, '0 B'],
      [512, '512 B'],
      [1024, '1.0 KB'],
      [1280, '1.2 KB'], // 1.25 KB: half to EVEN, where `toFixed(1)` gave 1.3
      [1536, '1.5 KB'],
      [2304, '2.2 KB'], // 2.25 KB, the same tie one digit up
      [11520, '11.2 KB'], // 11.25 KB
      [2359296, '2.2 MB'], // 2.25 MB
      [1048576, '1.0 MB'],
      [1073741824, '1.0 GB'],
      [5 * 1073741824 + 10, '5.0 GB'],
      // A negative is `-2000 B`, not `-2.0 KB`: the sign is not stripped before the
      // 1024 test, and the bytes branch formats with zero decimals.
      [-2000, '-2000 B'],
      [-1536, '-1536 B'],
    ];
    // What earlier releases wrote for each, recorded.
    const recorded = RECORDED.human;
    expect(holes.map(([n]) => human(n))).toEqual(recorded);
  });

  it('lists a corrupt bundle with its error rather than hiding it', async () => {
    const corrupt = path.join(backupsDir(), `corrupt-${String(process.pid)}.rcbak`);
    fs.writeFileSync(corrupt, 'not a gzip at all', 'utf8');
    try {
      const rows = await listBackups();
      const row = rows.find((entry) => entry.path === corrupt);
      expect(row).toBeDefined();
      expect(String(row?.error)).not.toBe('');
      expect(row?.repro).toBe('');
    } finally {
      fs.rmSync(corrupt, { force: true });
    }
  });

  it('refuses to delete a bundle outside the managed directory', async () => {
    const outside = path.join(os.tmpdir(), `houston-outside-${String(process.pid)}.rcbak`);
    fs.writeFileSync(outside, 'x', 'utf8');
    try {
      await expect(deleteBackup(outside)).rejects.toThrow('not in the managed backup directory');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('expands a leading ~ as earlier releases do, whatever HOME is spelled as', () => {
    // `--out` and `restore` take a `~` path. With HOME set but EMPTY `os.homedir()` is '',
    // and a bare `~` was `.` -- the working directory -- where earlier releases say `/`; and
    // a HOME ending in `/` kept the slash they strip. The rows are `lib/home.ts`'s; under
    // Jest the mock answers `os.homedir()` with HOME verbatim, as the native call does
    // (`lib/home.test.ts` checks that premise against real processes).
    // And the rows earlier releases spell their own way: a HOME holding `..` or a two-slash
    // root, which they keep and `path.join` folded; a trailing or doubled `/` and a `.`
    // part, which they drop and an earlier version printed; `~name`, which was the CURRENT
    // user's `name/`; and a `~` after a `./`, which they read as the path's first part.
    const rows = ['', '/', '//', '/tmp/x/', '/tmp/x//', '/tmp/a/../x', '//tmp/x'];
    const values = [
      '~',
      '~/b.rcbak',
      '~/dir/b.rcbak',
      'relative/b.rcbak',
      '/abs/b.rcbak',
      '~/b.rcbak/',
      '~//dir/./b.rcbak',
      './~/b.rcbak',
      'relative//b.rcbak/',
      '~root/b.rcbak',
    ];
    let current = '';
    jest.resetModules();
    jest.doMock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: () => current }));
    try {
      const fresh = require('../../src/core/backup') as typeof BackupNS;
      const ours = rows.map((row) => {
        current = row;
        return values.map((value) => fresh.expandUser(value));
      });
      // What earlier releases expanded each value to under each HOME, recorded.
      expect(ours).toEqual(RECORDED.expandUser);
    } finally {
      jest.dontMock('node:os');
      jest.resetModules();
    }
  });
});

/**
 * The decision logic, with Docker replaced at the runner seam -- what gets dumped, which
 * restores are refused, what a bundle carries. A stated world: the engine functions
 * `backup` reaches record what they were asked and answer what the case says.
 */
describe('a bundle path', () => {
  it('is refused, or not found, as earlier releases answer it', () => {
    // A `~name` nobody has is a `HomeUnknown` in earlier releases and escapes unhandled, where
    // an earlier version of this build found `name/b.rcbak` under the current home and said
    // there was no bundle there; and the path a refusal names is spelled as they spell it.
    const values = ['~no-such-user-houston/b.rcbak', 'missing//dir/./b.rcbak/', '~/missing/'];
    const ours = values.map((value) => {
      try {
        return bundlePath(value);
      } catch (error) {
        return `${(error as Error).name}: ${(error as Error).message}`;
      }
    });
    // What earlier releases answered for each, recorded.
    expect(ours).toEqual(placed(RECORDED.bundlePaths, { '<home>': os.homedir() }));
    expect(ours[0]).toBe('HomeUnknown: Could not determine home directory.');
  });
});

describe('backing up and restoring a workspace', () => {
  const COMPOSE_ONE = {
    services: {
      mongodb: { image: 'mongo:8.0' },
      rocketchat: {
        image: 'registry.rocket.chat/rocketchat/rocket.chat:8.5.1',
        environment: {
          MONGO_URL: 'mongodb://mongodb:27017/rocketchat?replicaSet=rs0',
          PORT: '3000',
        },
      },
    },
    volumes: { mongodb_data: {} },
  };

  interface World {
    payload: Buffer;
    rc: number;
    /** What the dump says on stderr. */
    dumpErr: string;
    stopRc: number;
    startRc: number;
    writerStates: Record<string, string>;
    writerQueryRc: number;
    keepWriterRunning: boolean;
    restoreInterrupted: boolean;
    dumped: [string, string, string[]][];
    restored: [string, string, string[], Buffer][];
    stopped: [string, string[]][];
    started: [string, string[]][];
    captures: string[][];
    capture: (argv: readonly string[]) => [number, string];
    /** Which seam, the program it ran, and the time limit it was handed. */
    limits: [string, string, number | undefined][];
    /** The directory each dump was written into and each load read from. */
    staged: string[];
    created: TypesNS.CreateReq[];
    waited: string[];
  }

  let world: World;
  let home = '';
  let previous: string | undefined;
  const MOCKED = [
    '../../src/seams/exec',
    '../../src/core/kube/namespace',
    '../../src/core/kube/scale',
    '../../src/core/kube/transfer',
    '../../src/core/lifecycle/admin',
    '../../src/core/lifecycle/create-docker',
    '../../src/core/lifecycle/preconditions',
    '../../src/core/lifecycle/ready',
    '../../src/core/runner/engine',
  ];

  beforeEach(() => {
    previous = process.env.HOUSTON_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-backup-world-'));
    process.env.HOUSTON_HOME = home;
    world = {
      payload: Buffer.from('BSON-ARCHIVE-BYTES'),
      rc: 0,
      dumpErr: '',
      stopRc: 0,
      startRc: 0,
      writerStates: {},
      writerQueryRc: 0,
      keepWriterRunning: false,
      restoreInterrupted: false,
      dumped: [],
      restored: [],
      stopped: [],
      started: [],
      captures: [],
      capture: () => [0, ''],
      limits: [],
      staged: [],
      created: [],
      waited: [],
    };
    jest.resetModules();
  });

  afterEach(() => {
    for (const id of MOCKED) jest.dontMock(id);
    jest.doMock('../../src/core/runner/host', () =>
      (require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    jest.resetModules();
    process.env.HOUSTON_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** The module under test, over the stated engine. */
  function load(): typeof BackupNS {
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../src/core/lifecycle/preconditions'),
      requireDocker: async () => undefined,
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      compose: async (_name: string, argv: readonly string[]) => ({
        argv: ['docker', 'compose', ...argv],
        exitCode: world.writerQueryRc,
        signal: null,
        stderr: world.writerQueryRc === 0 ? '' : 'writer query refused',
        stdout: JSON.stringify(
          argv.slice(4).map((service) => ({
            Service: service,
            State: world.writerStates[service] ?? 'running',
          })),
        ),
      }),
      composeExecToFile: async (
        name: string,
        service: string,
        argv: readonly string[],
        dest: string,
        timeoutMs?: number,
      ) => {
        world.limits.push(['toFile', argv[0] ?? '', timeoutMs]);
        world.staged.push(path.dirname(dest));
        world.dumped.push([name, service, [...argv]]);
        fs.writeFileSync(dest, world.payload);
        return [world.rc, world.dumpErr];
      },
      composeExecFromFile: async (
        name: string,
        service: string,
        argv: readonly string[],
        source: string,
        timeoutMs?: number,
      ) => {
        world.limits.push(['fromFile', argv[0] ?? '', timeoutMs]);
        world.staged.push(path.dirname(source));
        world.restored.push([name, service, [...argv], fs.readFileSync(source)]);
        if (world.restoreInterrupted) {
          const { Interrupted } = require('../../src/seams/exec') as typeof ExecNS;
          throw new Interrupted();
        }
        return [world.rc, ''];
      },
      composeExecCapture: async (
        _name: string,
        _service: string,
        argv: readonly string[],
        timeoutMs?: number,
      ) => {
        world.limits.push(['capture', argv[0] ?? '', timeoutMs]);
        world.captures.push([...argv]);
        return world.capture(argv);
      },
      stopServices: async (name: string, services: readonly string[]) => {
        world.stopped.push([name, [...services]]);
        if (world.stopRc === 0 && !world.keepWriterRunning) {
          for (const service of services) world.writerStates[service] = 'exited';
        }
        return world.stopRc;
      },
      startServices: async (name: string, services: readonly string[]) => {
        world.started.push([name, [...services]]);
        if (world.startRc === 0) {
          for (const service of services) world.writerStates[service] = 'running';
        }
        return world.startRc;
      },
    }));
    jest.doMock('../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../src/core/lifecycle/ready'),
      waitServing: async (meta: Metadata) => {
        world.waited.push(meta.name);
        return {};
      },
      // The real one takes `timeout` and `final` too; restore passes `final=false`
      // because it goes on after the workspace is serving.
      waitAndFinalize: async (meta: Metadata) => ({ url: meta.rootUrl }),
    }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      ...jest.requireActual('../../src/core/lifecycle/admin'),
      // No Rocket.Chat answers here; the Site_Url retarget is best-effort and warns.
      login: async () => {
        throw new Error('no Rocket.Chat in this test');
      },
    }));
    jest.doMock('../../src/core/lifecycle/create-docker', () => ({
      ...jest.requireActual('../../src/core/lifecycle/create-docker'),
      createRepro: async (req: TypesNS.CreateReq) => {
        world.created.push(req);
        await writeRepro(req.name);
        return {};
      },
    }));
    return require('../../src/core/backup') as typeof BackupNS;
  }

  /** Materialise a workspace the way `runner.write` would. */
  async function writeRepro(
    name: string,
    doc: unknown = COMPOSE_ONE,
    values: Partial<Metadata> = {},
  ): Promise<Metadata> {
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    const compose = require('../../src/lib/compose') as typeof ComposeNS;
    const meta = record.metadata({
      name,
      project: `houston-${name}`,
      rcVersion: '8.5.1',
      rcImage: 'registry.rocket.chat/rocketchat/rocket.chat',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 'map',
      ...values,
    });
    await record.write(name, compose.toYaml(doc as ComposeNS.ComposeDoc), meta);
    return meta;
  }

  function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  /** Every member path of a bundle, from a real unpack. */
  async function membersOf(bundle: string): Promise<string[]> {
    const targz = require('../../src/lib/targz') as typeof TargzNS;
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-bundle-members-'));
    try {
      await targz.extractTarGz(bundle, out);
      const found: string[] = [];
      const walk = (dir: string, prefix: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
          found.push(rel);
          if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        }
      };
      walk(out, '');
      return found.sort();
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }

  function events(): { emit: EventsNS.Emit; seen: EventsNS.Event[] } {
    const seen: EventsNS.Event[] = [];
    return { seen, emit: (event: EventsNS.Event) => void seen.push(event) };
  }

  /** A workspace and a bundle taken from it. */
  async function restorable(): Promise<{ backup: typeof BackupNS; bundle: string }> {
    const backup = load();
    await writeRepro('rc8-5-1');
    const made = await backup.create('rc8-5-1');
    return { backup, bundle: String(made.path) };
  }

  describe('taking a backup', () => {
    it('refuses malformed service recovery notes while accepting an explicitly stopped state', async () => {
      const backup = load();
      const events_ = require('../../src/lib/events') as typeof EventsNS;
      const repair = async (detail: Record<string, unknown>) =>
        await backup.repairStopped(
          {
            id: 'service-state',
            kind: 'rocketchat_stopped',
            workspace: 'rc8-5-1',
            pid: process.pid,
            started: '',
            at: '',
            detail,
          },
          events_.nullEmit,
          null,
        );
      for (const detail of [
        {},
        { services: null },
        { services: {} },
        { services: ['rocketchat', 1] },
        { services: [null] },
        { services: [''] },
        { services: ['   '] },
      ]) {
        expect(await repair(detail)).toBe(false);
      }
      expect(world.started).toEqual([]);
      expect(await repair({ services: [] })).toBe(true);
      expect(world.started).toEqual([]);
      expect(await repair({ services: ['rocketchat'] })).toBe(true);
      expect(world.started).toEqual([['rc8-5-1', ['rocketchat']]]);
    });

    it('dumps only Rocket.Chat’s own database, from the mongodb service', async () => {
      const backup = load();
      await writeRepro('rc8-5-1');
      const made = await backup.create('rc8-5-1');
      const [, service, argv] = world.dumped[0] ?? ['', '', []];
      expect(service).toBe('mongodb');
      expect(argv.slice(0, 2)).toEqual(['mongodump', '--archive']);
      expect(argv).toContain('--gzip');
      // --db, so `admin`/`local` never travel and the target's replica set is safe.
      expect(argv[argv.indexOf('--db') + 1]).toBe('rocketchat');
      expect(fs.existsSync(String(made.path))).toBe(true);
    });

    it('leaves the registration token out of the bundle', async () => {
      // A token is a real licence, and a bundle is what gets attached to a support case:
      // the compose file went in verbatim, REG_TOKEN and all.
      const backup = load();
      const doc = clone(COMPOSE_ONE) as {
        services: { rocketchat: { environment: Record<string, string> } };
      };
      doc.services.rocketchat.environment.REG_TOKEN = 'canary-token-4471';
      await writeRepro('rc8-5-1', doc);
      const made = await backup.create('rc8-5-1');
      const targz = require('../../src/lib/targz') as typeof TargzNS;
      const out = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-bundle-token-'));
      try {
        await targz.extractTarGz(String(made.path), out);
        const carrying = (await membersOf(String(made.path))).filter((rel) => {
          const file = path.join(out, rel);
          return fs.statSync(file).isFile() && fs.readFileSync(file).includes('canary-token-4471');
        });
        expect(carrying).toEqual([]);
        expect(fs.readFileSync(path.join(out, 'compose.yml'), 'utf8')).toContain("REG_TOKEN: ''");
      } finally {
        fs.rmSync(out, { recursive: true, force: true });
      }
    });

    it('stops Rocket.Chat for the dump and starts it again', async () => {
      // A dump under a live writer is not consistent across collections.
      const backup = load();
      await writeRepro('rc8-5-1');
      await backup.create('rc8-5-1');
      expect(world.stopped).toEqual([['rc8-5-1', ['rocketchat']]]);
      expect(world.started).toEqual([['rc8-5-1', ['rocketchat']]]);
    });

    it('starts Rocket.Chat again even when the dump fails', async () => {
      // Leaving the workspace stopped is worse than the failure itself.
      const backup = load();
      await writeRepro('rc8-5-1');
      world.rc = 1;
      const errors = require('../../src/lib/errors') as typeof ErrorsNS;
      await expect(backup.create('rc8-5-1')).rejects.toBeInstanceOf(errors.DockerError);
      expect(world.started).toEqual([['rc8-5-1', ['rocketchat']]]);
    });

    it('says a dump was killed, and keeps the end of what it said rather than the start', async () => {
      // The MongoDB operator's mongod was OOMKilled under its 500M limit while the dump ran in
      // it, and the error held only the FIRST 600 characters of stderr -- a line per collection
      // -- so neither the kill nor its reason was in it.
      const backup = load();
      await writeRepro('rc8-5-1');
      world.rc = 137;
      world.dumpErr = [
        ...Array.from(
          { length: 40 },
          (_, at) => `2026-10-13T09:32:20.${String(at)}+0000\twriting rocketchat.c${String(at)}`,
        ),
        'command terminated with exit code 137',
      ].join('\n');
      await expect(backup.create('rc8-5-1')).rejects.toThrow(
        /mongodump failed for 'rc8-5-1': it was killed \(exit 137\), most likely for running out of memory; it last said: .*command terminated with exit code 137$/su,
      );
    });

    it('refuses a returned writer-stop failure before mongodump and restores prior services', async () => {
      const backup = load();
      await writeRepro('rc8-5-1');
      world.stopRc = 47;
      await expect(backup.create('rc8-5-1')).rejects.toThrow(/could not stop Rocket.Chat writers/u);
      expect(world.dumped).toEqual([]);
      expect(world.started).toEqual([['rc8-5-1', ['rocketchat']]]);
    });

    it('refuses a successful stop that leaves a writer running before mongodump', async () => {
      const backup = load();
      await writeRepro('rc8-5-1');
      world.keepWriterRunning = true;
      await expect(backup.create('rc8-5-1')).rejects.toThrow(/writers are still running/u);
      expect(world.dumped).toEqual([]);
    });

    it('refuses failed writer discovery before stopping or dumping', async () => {
      const backup = load();
      await writeRepro('rc8-5-1');
      world.writerQueryRc = 46;
      await expect(backup.create('rc8-5-1')).rejects.toThrow(
        /could not inspect Rocket.Chat writers/u,
      );
      expect(world.dumped).toEqual([]);
      expect(world.stopped).toEqual([]);
    });

    it('keeps originally stopped Compose instances stopped after a backup', async () => {
      const backup = load();
      const doc = clone(COMPOSE_ONE) as { services: Record<string, unknown> };
      const rc = doc.services.rocketchat;
      delete doc.services.rocketchat;
      doc.services['rocketchat-1'] = rc;
      doc.services['rocketchat-2'] = clone(rc);
      await writeRepro('multi', doc);
      world.writerStates['rocketchat-2'] = 'exited';
      await backup.create('multi');
      expect(world.started).toEqual([['multi', ['rocketchat-1']]]);
      expect(world.writerStates['rocketchat-2']).toBe('exited');
    });

    it('does not start a Compose workspace whose writers were already stopped', async () => {
      const backup = load();
      await writeRepro('rc8-5-1');
      world.writerStates.rocketchat = 'exited';
      await backup.create('rc8-5-1');
      expect(world.started).toEqual([]);
      expect(world.waited).toEqual([]);
      expect(world.writerStates.rocketchat).toBe('exited');
    });

    it('leaves Rocket.Chat running for a --live dump', async () => {
      const backup = load();
      await writeRepro('rc8-5-1');
      await backup.create('rc8-5-1', { live: true });
      expect([world.stopped, world.started]).toEqual([[], []]);
    });

    it('quiesces every instance of a multi-instance workspace', async () => {
      // Stopping only the first would leave the others writing during the dump.
      const backup = load();
      const doc = clone(COMPOSE_ONE) as { services: Record<string, unknown> };
      const rc = doc.services.rocketchat;
      delete doc.services.rocketchat;
      doc.services['rocketchat-1'] = rc;
      doc.services['rocketchat-2'] = clone(rc);
      await writeRepro('multi', doc);
      await backup.create('multi');
      expect(world.stopped).toEqual([['multi', ['rocketchat-1', 'rocketchat-2']]]);
    });

    it('packs the manifest, the archive and the workspace files', async () => {
      const backup = load();
      await writeRepro('rc8-5-1', COMPOSE_ONE, {
        preset: 's3_minio',
        extra: { params: { bucket: 'custom' }, env: { A: 'b' } },
      });
      const ws = path.join(home, 'repros', 'rc8-5-1');
      expect(fs.existsSync(path.join(ws, 'repro.json'))).toBe(true);
      fs.mkdirSync(path.join(ws, 'traefik'));
      fs.writeFileSync(path.join(ws, 'traefik', 'dynamic.yml'), 'x: 1');

      const made = await backup.create('rc8-5-1', { note: 'before upgrade' });
      const names = await membersOf(String(made.path));
      for (const member of [backup.MANIFEST, backup.ARCHIVE, backup.COMPOSE, backup.RECORD]) {
        expect(names).toContain(member);
      }
      expect(names.some((name) => name.startsWith(backup.FILES_DIR))).toBe(true);

      const m = made.manifest as Record<string, unknown>;
      expect(m.label).toBe('before upgrade');
      expect([m.rc_version, m.preset]).toEqual(['8.5.1', 's3_minio']);
      expect([m.params, m.env_overrides]).toEqual([{ bucket: 'custom' }, { A: 'b' }]);
      expect(Number(m.archive_bytes)).toBeGreaterThan(0);
      expect(String(m.archive_sha256)).toHaveLength(64);
    });

    it("carries a composed workspace's presets and their params, and only for one", async () => {
      const backup = load();
      await writeRepro('combo', COMPOSE_ONE, {
        preset: 'email+ldap',
        extra: {
          presets: ['email', 'ldap'],
          preset_params: { email: {}, ldap: { users: '7' } },
        },
      });
      const m = (await backup.create('combo')).manifest as Record<string, unknown>;
      expect([m.preset, m.params, m.presets, m.preset_params]).toEqual([
        'email+ldap',
        {},
        ['email', 'ldap'],
        { email: {}, ldap: { users: '7' } },
      ]);
      await writeRepro('single', COMPOSE_ONE, {
        preset: 'ldap',
        extra: { params: { users: '3' } },
      });
      const one = (await backup.create('single')).manifest as Record<string, unknown>;
      expect(['presets' in one, 'preset_params' in one]).toEqual([false, false]);
    });

    it('keeps the modes and times of what it copies, as earlier releases do', async () => {
      // `copyFileSync` and `cpSync` made every copy's mtime the time of the backup and every
      // directory the umask's mode, and the tar writer then stored 0644 for all of them.
      // Earlier releases copied the same workspace keeping modes and times and packed it;
      // their listing of every member that came from the workspace is recorded, and this
      // build's must be the same, to the nanosecond of its PAX mtime.
      // The workspace is made under a 002 umask, the one the listing was recorded under:
      // what `shapeWorkspace` does not chmod is 0o775 or 0o664 in it, and a CI runner's 022
      // made those 0o755 and 0o644 before anything was copied.
      const savedUmask = process.umask(0o002);
      try {
        const backup = load();
        await writeRepro('rc8-5-1');
        const ws = path.join(home, 'repros', 'rc8-5-1');
        shapeWorkspace(ws);
        const made = await backup.create('rc8-5-1');
        const owner = fs.statSync(ws);
        const recorded = RECORDED.listing.map((row) => [
          ...row.slice(0, 3),
          owner.uid,
          owner.gid,
          owner.uid === os.userInfo().uid ? os.userInfo().username : '',
          groupName(owner.gid),
          ...row.slice(7),
        ]);
        expect(listing(String(made.path))).toEqual(recorded);
        const modes = Object.fromEntries(recorded.map((row) => [row[0], row[2]]));
        expect([modes['files/monitoring/grafana'], modes['files/seed.ldif']]).toEqual([
          '0o750',
          '0o600',
        ]);
        expect(recorded.find((row) => row[0] === 'files/seed.ldif')?.[8]).toBe(
          '1790000000.1234567',
        );
      } finally {
        process.umask(savedUmask);
      }
    });

    it('leaves uploaded customer settings out of the bundle', async () => {
      // workspace/import/ holds customers' uploaded dumps; a backup is not where those
      // should accumulate.
      const backup = load();
      await writeRepro('rc8-5-1');
      const imp = path.join(home, 'repros', 'rc8-5-1', 'import');
      fs.mkdirSync(imp);
      fs.writeFileSync(path.join(imp, 'u0123456789ab.json'), '[]');
      const made = await backup.create('rc8-5-1');
      expect(
        (await membersOf(String(made.path))).filter((name) => name.includes('import')),
      ).toEqual([]);
    });

    it('refuses to overwrite an existing --out path', async () => {
      const backup = load();
      await writeRepro('rc8-5-1');
      const dest = path.join(home, 'taken.rcbak');
      fs.writeFileSync(dest, 'existing');
      const errors = require('../../src/lib/errors') as typeof ErrorsNS;
      await expect(backup.create('rc8-5-1', { out: dest })).rejects.toBeInstanceOf(
        errors.ConflictError,
      );
      expect(fs.readFileSync(dest, 'utf8')).toBe('existing');
    });

    it('rejects an empty dump at source', async () => {
      // An empty archive restores as an empty workspace; catch it where it is made.
      const backup = load();
      await writeRepro('rc8-5-1');
      world.payload = Buffer.alloc(0);
      const errors = require('../../src/lib/errors') as typeof ErrorsNS;
      const refusal = backup.create('rc8-5-1');
      await expect(refusal).rejects.toBeInstanceOf(errors.DockerError);
      await expect(refusal).rejects.toThrow(/empty archive/u);
    });

    it('writes the bundle owner-only', async () => {
      // It contains every message and the admin password hash.
      const backup = load();
      await writeRepro('rc8-5-1');
      const made = await backup.create('rc8-5-1');
      expect(fs.statSync(String(made.path)).mode & 0o777).toBe(0o600);
    });

    it('fails truthfully but keeps the completed bundle when Rocket.Chat cannot recover', async () => {
      // Reporting "backed up" over a workspace that never came back is the exact outcome
      // the quiesce wrapper exists to prevent.
      const backup = load();
      await writeRepro('rc8-5-1');
      world.startRc = 1;
      const dest = path.join(home, 'failed-recovery.rcbak');
      await expect(backup.create('rc8-5-1', { out: dest })).rejects.toThrow(
        /backup saved at.*prior state could not be restored/u,
      );
      expect((await backup.readManifest(dest)).repro).toBe('rc8-5-1');
      expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
      const journal = require('../../src/core/journal') as typeof JournalNS;
      expect(journal.openEntries().some((entry) => entry.kind === journal.ROCKETCHAT_STOPPED)).toBe(
        true,
      );
    });
  });

  describe('the time limits it hands the engine', () => {
    it('are the seconds earlier releases use, in the milliseconds the seam takes', async () => {
      // The probe and dump limits are SECONDS -- earlier releases hand them to the compose
      // calls in seconds -- and the compose seam here takes `timeoutMs`. Handed
      // over unconverted, the tools probe died after 30 ms and every dump after 3.6 s, so a
      // real engine refused every backup and restore.
      // The probe and dump limits earlier releases had, in seconds, recorded.
      const [probe, dump] = RECORDED.timeouts;
      const { backup, bundle } = await restorable();
      await backup.restore(bundle);
      expect(world.limits).toEqual([
        // backup: the tools probe, then the dump
        ['capture', 'sh', probe * 1000],
        ['toFile', 'mongodump', dump * 1000],
        // restore: the tools probe, the `ulimit -n` probe, the drop, then the load
        ['capture', 'sh', probe * 1000],
        ['capture', 'sh', probe * 1000],
        // `env HOME=/tmp mongosh`: the operator's pod has no writable home for the shell.
        ['capture', 'env', probe * 1000],
        ['fromFile', 'mongorestore', dump * 1000],
      ]);
      expect([probe * 1000, dump * 1000]).toEqual([30_000, 3_600_000]);
    });
  });

  describe('the staging directory', () => {
    it('is where earlier releases put it when TMPDIR names a directory that is gone', async () => {
      // `os.tmpdir()` is `$TMPDIR` as given, so a stale TMPDIR made the backup an ENOENT stack
      // from `mkdtemp`, where earlier releases fall back past it to the first temporary
      // directory they can use. `node:os` answers the variable here as it does in a
      // process started with it; this build reads the environment itself.
      const gone = path.join(home, 'tmpdir-that-is-gone');
      const saved = process.env.TMPDIR;
      process.env.TMPDIR = gone;
      jest.doMock('node:os', () => ({ ...jest.requireActual('node:os'), tmpdir: () => gone }));
      try {
        // Where earlier releases staged, with that TMPDIR, recorded.
        const where = RECORDED.tempdir;
        expect(where).not.toBe(gone);
        const { backup, bundle } = await restorable();
        await backup.restore(bundle);
        expect(world.staged.map((dir) => path.dirname(dir))).toEqual([where, where]);
        expect(world.staged.map((dir) => path.basename(dir).replace(/[a-z0-9_]{8}$/u, ''))).toEqual(
          ['houston-backup-', 'houston-restore-'],
        );
      } finally {
        if (saved === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = saved;
        jest.dontMock('node:os');
      }
    });
  });

  describe('the bundles on disk', () => {
    it('lists only the named workspace’s bundles when asked', async () => {
      const backup = load();
      await writeRepro('a');
      await writeRepro('b');
      await backup.create('a');
      await backup.create('b');
      expect((await backup.listBackups('a')).map((row) => row.repro)).toEqual(['a']);
    });

    it('marks a bundle an earlier workspace of the same name left behind', async () => {
      // Bundles outlive their workspace and are matched to one by NAME, and houston DERIVES
      // names from the version -- so a freshly created workspace showed the destroyed one's
      // bundles as its own, and restoring one would silently load that workspace's data.
      // Still listed, because hiding a real backup is worse; marked.
      const backup = load();
      // Only the clock is stepped: both the filename and the manifest carry a timestamp.
      jest.useFakeTimers({
        doNotFake: [
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
          'requestAnimationFrame',
          'cancelAnimationFrame',
          'requestIdleCallback',
          'cancelIdleCallback',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
        ],
      });
      try {
        jest.setSystemTime(new Date('2026-08-15T08:00:00Z'));
        await writeRepro('rc8-5-1', COMPOSE_ONE, { createdAt: '2026-08-15T07:00:00+00:00' });
        const old = String((await backup.create('rc8-5-1')).path);

        // ...then that workspace is destroyed and a NEW one takes the same name.
        await writeRepro('rc8-5-1', COMPOSE_ONE, { createdAt: '2026-08-16T00:00:00+00:00' });
        let rows = await backup.listBackups('rc8-5-1');
        expect(rows.map((row) => path.basename(String(row.path)))).toContain(path.basename(old));
        expect(rows[0]?.predates_workspace).toBe(true);

        // A bundle taken by the workspace running now is NOT marked.
        jest.setSystemTime(new Date('2026-08-18T09:15:00Z'));
        const fresh = String((await backup.create('rc8-5-1')).path);
        rows = await backup.listBackups('rc8-5-1');
        const mine = rows.find((row) => path.basename(String(row.path)) === path.basename(fresh));
        expect(mine?.predates_workspace).toBe(false);

        // And with no workspace to compare against, nothing is claimed either way.
        fs.rmSync(path.join(home, 'repros', 'rc8-5-1'), { recursive: true, force: true });
        rows = await backup.listBackups('rc8-5-1');
        expect(rows.map((row) => row.predates_workspace)).toEqual(rows.map(() => false));
      } finally {
        jest.useRealTimers();
      }
    });

    it('refuses traversal on delete but removes a symlinked bundle, never its target', async () => {
      // The parent check is deliberately UNRESOLVED: traversal is refused either way, and
      // resolving would also refuse a symlink parked in the backups directory -- a
      // reasonable way to keep bundles on another disk, whose unlink removes the link.
      const backup = load();
      const outside = path.join(home, 'outside.rcbak');
      fs.writeFileSync(outside, 'x');
      // Spelled out rather than `path.join`ed, which would normalise the traversal away.
      await expect(
        backup.deleteBackup(`${backup.backupsDir()}/../${path.basename(outside)}`),
      ).rejects.toThrow(/managed backup directory/u);
      expect(fs.existsSync(outside)).toBe(true);

      const link = path.join(backup.backupsDir(), 'link.rcbak');
      fs.symlinkSync(outside, link);
      expect(String((await backup.deleteBackup(link)).deleted)).toMatch(/link\.rcbak$/u);
      expect(fs.existsSync(link)).toBe(false);
      expect(fs.existsSync(outside)).toBe(true);
    });

    it('calls a truncated bundle truncated, inside the error contract', async () => {
      // A truncated bundle threw a bare ended-early error from gzip, so the CLI printed `Aborted.`
      // at exit 1 -- what a cancelled prompt prints -- and the web layer answered 500.
      const backup = load();
      const targz = require('../../src/lib/targz') as typeof TargzNS;
      const errors = require('../../src/lib/errors') as typeof ErrorsNS;
      const staging = path.join(home, 'staging');
      fs.mkdirSync(staging);
      fs.writeFileSync(
        path.join(staging, backup.MANIFEST),
        JSON.stringify({ schema: backup.SCHEMA, name: 'x' }),
      );
      const good = path.join(home, 'good.tar.gz');
      await targz.writeTarGzFromDir(staging, good);
      const raw = fs.readFileSync(good);
      for (const [label, data] of [
        ['half', raw.subarray(0, Math.floor(raw.length / 2))],
        ['gzip-header-only', raw.subarray(0, 10)],
      ] as [string, Buffer][]) {
        const cut = path.join(home, `cut-${label}.tar.gz`);
        fs.writeFileSync(cut, data);
        let caught: unknown = null;
        try {
          await backup.readManifest(cut);
        } catch (error) {
          caught = error;
        }
        expect({ label, validation: caught instanceof errors.ValidationError }).toEqual({
          label,
          validation: true,
        });
        expect({ label, message: (caught as Error).message }).toEqual({
          label,
          message: expect.stringContaining('truncated') as unknown as string,
        });
      }
      // The modes that already worked keep their own wording: a fix that relabelled every
      // unreadable file "truncated" would be worse than the bug.
      const junk = path.join(home, 'junk.tar.gz');
      fs.writeFileSync(junk, 'not a gzip at all');
      await expect(backup.readManifest(junk)).rejects.toThrow(/not a readable backup bundle/u);
    });
  });

  describe('restoring a bundle', () => {
    it('preserves a stopped restore outcome when writer recovery also fails', async () => {
      const { backup, bundle } = await restorable();
      world.restoreInterrupted = true;
      world.startRc = 1;
      const { Interrupted } = require('../../src/seams/exec') as typeof ExecNS;
      const { emit, seen } = events();
      await expect(backup.restore(bundle, { emit })).rejects.toBeInstanceOf(Interrupted);
      expect(world.restored).toHaveLength(1);
      expect(
        seen.some(
          (event) => event.level === 'warn' && event.message.includes('restore was stopped'),
        ),
      ).toBe(true);
      const journal = require('../../src/core/journal') as typeof JournalNS;
      expect(journal.openEntries().some((entry) => entry.kind === journal.ROCKETCHAT_STOPPED)).toBe(
        true,
      );
    });

    it('fails truthfully after the data restores if the original writer state cannot recover', async () => {
      const { backup, bundle } = await restorable();
      world.startRc = 1;
      await expect(backup.restore(bundle)).rejects.toThrow(/prior state could not be restored/u);
      expect(world.restored).toHaveLength(1);
      const journal = require('../../src/core/journal') as typeof JournalNS;
      expect(journal.openEntries().some((entry) => entry.kind === journal.ROCKETCHAT_STOPPED)).toBe(
        true,
      );
    });

    it('refuses a returned writer-stop failure before dropDatabase or mongorestore', async () => {
      const { backup, bundle } = await restorable();
      world.stopRc = 47;
      world.captures.length = 0;
      await expect(backup.restore(bundle)).rejects.toThrow(/could not stop Rocket.Chat writers/u);
      expect(world.restored).toEqual([]);
      expect(world.captures.some((argv) => argv.some((arg) => arg.includes('dropDatabase')))).toBe(
        false,
      );
    });

    it('restores in place with --drop, from the archive the bundle carries', async () => {
      // Without --drop a restore merges two databases into a hybrid.
      const { backup, bundle } = await restorable();
      await backup.restore(bundle);
      const [, service, argv, payload] = world.restored[0] ?? ['', '', [], Buffer.alloc(0)];
      expect(service).toBe('mongodb');
      expect(argv.slice(0, 2)).toEqual(['mongorestore', '--archive']);
      expect(argv).toContain('--drop');
      expect(argv).toContain('--gzip');
      expect(payload.toString()).toBe('BSON-ARCHIVE-BYTES');
    });

    it('says an integral restore time as earlier releases do, 0.0s and not 0s', async () => {
      // Earlier releases round the elapsed time to one decimal and keep the point, so they
      // say `restored in 0.0s` -- and 3.0s, 12.0s: about one real restore in ten. `String`
      // of the JavaScript number printed `0s`.
      const { backup, bundle } = await restorable();
      jest.spyOn(performance, 'now').mockReturnValue(5_000);
      const { emit, seen } = events();
      const done = await backup.restore(bundle, { emit });
      expect(done.restore_seconds).toBe(0);
      expect(seen.map((event) => event.message)).toContain(
        'restored in 0.0s; waiting for Rocket.Chat',
      );
    });

    it('does not remap namespaces when the database matches', async () => {
      const { backup, bundle } = await restorable();
      await backup.restore(bundle);
      expect((world.restored[0]?.[2] ?? []).filter((arg) => arg.startsWith('--nsFrom'))).toEqual(
        [],
      );
    });

    it('remaps when the target uses a different database', async () => {
      const { backup, bundle } = await restorable();
      const doc = clone(COMPOSE_ONE);
      doc.services.rocketchat.environment.MONGO_URL =
        'mongodb://mongodb:27017/renamed?replicaSet=rs0';
      await writeRepro('rc8-5-1', doc);
      await backup.restore(bundle);
      const argv = world.restored[0]?.[2] ?? [];
      expect(argv).toContain('--nsFrom=rocketchat.*');
      expect(argv).toContain('--nsTo=renamed.*');
    });

    it('stops Rocket.Chat before it drops anything', async () => {
      // Dropping collections under a live writer is what --drop exists to prevent.
      const { backup, bundle } = await restorable();
      world.stopped.length = 0;
      await backup.restore(bundle);
      expect(world.stopped).toEqual([['rc8-5-1', ['rocketchat']]]);
    });

    it('drops the whole database, not just the collections the dump carries', async () => {
      // `mongorestore --drop` drops only what it restores. Measured against real MongoDB: a
      // collection created AFTER the dump survived, so restoring a pre-upgrade backup into
      // an upgraded workspace left the newer version's collections behind.
      const { backup, bundle } = await restorable();
      world.captures.length = 0;
      await backup.restore(bundle);
      const dropped = world.captures.filter((argv) =>
        argv.some((arg) => arg.includes('getCollectionNames')),
      );
      expect(dropped.length).toBeGreaterThan(0);
      expect(dropped[0]?.slice(2, 4)).toEqual(['mongosh', 'rocketchat']);
    });

    it('drops with a writable HOME, which the MongoDB operator pod does not give', async () => {
      // The shell makes ~/.mongodb first; in the operator's pod its EACCES warning filled the
      // output the failure reason is read from.
      const backup = load();
      await writeRepro('rc8-5-1');
      await backup.dropDatabase('rc8-5-1', 'rocketchat');
      expect(world.captures[0]?.slice(0, 3)).toEqual(['env', 'HOME=/tmp', 'mongosh']);
    });

    it('empties the database under readWrite, and prints a failure where it can be read', () => {
      // The MongoDB operator's application user holds readWrite, which may drop a collection
      // and may NOT run dropDatabase: every restore into an operator workspace warned "could
      // not drop ()" -- an empty reason, since the shell's error went to stderr -- and merged.
      const backup = load();
      const dropped: string[] = [];
      const printed: string[] = [];
      const db = {
        dropDatabase: () => {
          throw new Error('not authorized on rocketchat to execute command { dropDatabase: 1 }');
        },
        getCollectionNames: () => ['users', 'rocketchat_message', 'system.views'],
        getCollection: (name: string) => ({ drop: () => void dropped.push(name) }),
      };
      const run = (database: unknown) =>
        new Function('db', 'print', 'quit', backup.DROP_EVERY_COLLECTION)(
          database,
          (line: string) => void printed.push(line),
          (code: number) => void printed.push(`quit ${String(code)}`),
        );
      run(db);
      expect(dropped).toEqual(['users', 'rocketchat_message']);
      expect(printed).toEqual([]);
      run({
        getCollectionNames: () => {
          throw new Error('not authorized on rocketchat to execute command { listCollections }');
        },
      });
      expect(printed).toEqual([
        'drop failed: Error: not authorized on rocketchat to execute command { listCollections }',
        'quit 1',
      ]);
    });

    it('drops with the legacy shell on a MongoDB older than 5.0', async () => {
      // `mongosh` only exists from MongoDB 5.0; older images ship `mongo`.
      const backup = load();
      await writeRepro('old', COMPOSE_ONE, { mongoTag: '4.4' });
      await backup.dropDatabase('old', 'rocketchat');
      expect(world.captures[0]?.[2]).toBe('mongo');
    });

    it('warns rather than aborting when the drop fails', async () => {
      // --drop still clears everything the bundle carries, which is the common case.
      const backup = load();
      await writeRepro('rc8-5-1');
      world.capture = () => [1, 'no such command'];
      const { emit, seen } = events();
      await backup.dropDatabase('rc8-5-1', 'rocketchat', emit);
      expect(
        seen.some((event) => event.level === 'warn' && event.message.includes('may survive')),
      ).toBe(true);
    });

    it('restores one collection at a time, so a low-fd workspace survives', async () => {
      // Workspaces created before the ulimit fix keep 1024 open files until recreated.
      const { backup, bundle } = await restorable();
      await backup.restore(bundle);
      expect(world.restored[0]?.[2]).toContain('--numParallelCollections=1');
    });

    it('reports a low fd limit with the command that fixes it', async () => {
      const backup = load();
      await writeRepro('rc8-5-1');
      world.capture = () => [0, '1024\n'];
      const { emit, seen } = events();
      expect(await backup.warnLowFdLimit('rc8-5-1', emit)).toBe(1024);
      expect(seen.some((event) => event.message.includes('up --force'))).toBe(true);
    });

    it('says nothing about a healthy fd limit', async () => {
      const backup = load();
      await writeRepro('rc8-5-1');
      world.capture = () => [0, '64000\n'];
      const { emit, seen } = events();
      expect(await backup.warnLowFdLimit('rc8-5-1', emit)).toBe(64000);
      expect(seen).toEqual([]);
    });

    it('does not let an unreadable fd limit break the restore', async () => {
      const backup = load();
      await writeRepro('rc8-5-1');
      world.capture = () => [1, 'not a number'];
      expect(await backup.warnLowFdLimit('rc8-5-1')).toBe(0);
    });

    it('refuses to load newer data into an older workspace', async () => {
      const { backup, bundle } = await restorable();
      await writeRepro('older', COMPOSE_ONE, { rcVersion: '7.0.0' });
      const errors = require('../../src/lib/errors') as typeof ErrorsNS;
      const refusal = backup.restore(bundle, { name: 'older' });
      await expect(refusal).rejects.toBeInstanceOf(errors.ValidationError);
      await expect(refusal).rejects.toThrow(/downgrad/u);
    });

    it('needs --allow-upgrade to load older data into a newer workspace', async () => {
      const { backup, bundle } = await restorable();
      await writeRepro('newer', COMPOSE_ONE, { rcVersion: '8.6.1' });
      await expect(backup.restore(bundle, { name: 'newer' })).rejects.toThrow(/allow-upgrade/u);
      const out = await backup.restore(bundle, { name: 'newer', allowUpgrade: true });
      expect([out.direction, out.to_version]).toEqual(['upgrade', '8.6.1']);
    });

    it('detects an archive that does not match its recorded checksum', async () => {
      // The archive is changed and the manifest is not -- corruption, not a new bundle.
      const { backup, bundle } = await restorable();
      const targz = require('../../src/lib/targz') as typeof TargzNS;
      const staging = path.join(home, 'tamper');
      await targz.extractTarGz(bundle, staging);
      fs.writeFileSync(path.join(staging, backup.ARCHIVE), 'SOMETHING-ELSE');
      const tampered = path.join(home, 'tampered.rcbak');
      await targz.writeTarGzFromDir(staging, tampered);
      await expect(backup.restore(tampered)).rejects.toThrow(/corrupt/u);
      expect(world.restored).toEqual([]);
    });

    it('points at --new when the bundle’s workspace no longer exists', async () => {
      const { backup, bundle } = await restorable();
      fs.rmSync(path.join(home, 'repros', 'rc8-5-1'), { recursive: true, force: true });
      const errors = require('../../src/lib/errors') as typeof ErrorsNS;
      const refusal = backup.restore(bundle);
      await expect(refusal).rejects.toBeInstanceOf(errors.NotFoundError);
      await expect(refusal).rejects.toThrow(/--new/u);
    });

    it('creates a new workspace from the manifest with --new', async () => {
      const { backup, bundle } = await restorable();
      const out = await backup.restore(bundle, { new: true });
      expect([out.created, out.name]).toEqual([true, 'rc8-5-1-restored']);
      expect([world.created[0]?.version, world.created[0]?.preset]).toEqual(['8.5.1', 'default']);
    });

    it('records the admin password the restored database holds, the source’s', async () => {
      // The database comes from the source, admin and all, and the record kept the new
      // workspace's own password: every login answered 401, the Site_Url retarget first,
      // seen live after `restore --new` from an HTTPS workspace.
      const backup = load();
      await writeRepro('src', COMPOSE_ONE, { adminPassword: 'Source-Pw' });
      const made = await backup.create('src');
      await backup.restore(String(made.path), { new: true });
      const record = require('../../src/core/runner/record') as typeof RecordNS;
      expect((await record.readMeta('src-restored')).adminPassword).toBe('Source-Pw');
    });

    it('rebuilds the preset the bundle came from, on the runtime it came from', async () => {
      // The three-axis branch hardcoded preset "default" while reading runtime and
      // deployment from the manifest, and every modern bundle records `deployment` -- so
      // `restore --new` on an ldap bundle produced a VANILLA workspace holding LDAP users
      // with no directory to bind against. The case above passes either way: its bundle's
      // preset IS "default".
      const backup = load();
      const events_ = require('../../src/lib/events') as typeof EventsNS;
      await backup.createFromManifest(
        'rebuilt',
        {
          rc_version: '8.5.1',
          mongo_tag: '8.0',
          preset: 'ldap',
          runtime: 'kubernetes',
          deployment: 'microservices',
          params: { users: '5' },
          env_overrides: { OVERWRITE_SETTING_Site_Name: 'Restored' },
        },
        events_.nullEmit,
      );
      const seen = world.created[0];
      expect(seen?.preset).toBe('ldap');
      expect(seen?.runtime).toBe('kubernetes');
      expect(seen?.deployment).toBe('microservices');
      expect(seen?.params).toEqual({ users: '5' });
      // The overrides too, which a Kubernetes create now honours and records.
      expect(seen?.env).toEqual({ OVERWRITE_SETTING_Site_Name: 'Restored' });

      // A composed bundle's params come back as the `--set` keys that say them.
      await backup.createFromManifest(
        'combo-restored',
        {
          rc_version: '8.5.1',
          preset: 'email+ldap',
          runtime: 'docker',
          deployment: 'monolith',
          params: {},
          presets: ['email', 'ldap'],
          preset_params: { email: {}, ldap: { users: '7' } },
        },
        events_.nullEmit,
      );
      expect([world.created[1]?.preset, world.created[1]?.params]).toEqual([
        'email+ldap',
        { 'ldap.users': '7' },
      ]);
      world.created.splice(1, 1);

      // A pre-three-axis bundle has no `deployment`; that branch always read the preset.
      await backup.createFromManifest(
        'legacy',
        { rc_version: '8.5.1', preset: 'email' },
        events_.nullEmit,
      );
      expect(world.created[1]?.preset).toBe('email');
      expect(world.created[1]?.runtime).toBe('');
    });

    it('is owned by whoever restores it, as a create is', async () => {
      // From the GUI's Backups page a restored workspace had no owner: the create was made
      // with no actor, though the audit named the admin who pressed Restore.
      const backup = load();
      const events_ = require('../../src/lib/events') as typeof EventsNS;
      const context = require('../../src/lib/context') as typeof ContextNS;
      await context.runWithContext({ actor: 'alice' }, async () => {
        await backup.createFromManifest('owned', { rc_version: '8.5.1' }, events_.nullEmit);
      });
      expect(world.created.at(-1)?.actor).toBe('alice');
    });

    it('rebuilds a Kubernetes workspace on its cluster, with the operator if it had one', async () => {
      // The manifest recorded neither: a copy of an operator-managed MongoDB came up as a
      // plain StatefulSet on the default context, saying the operator is "opt-in".
      const backup = load();
      const events_ = require('../../src/lib/events') as typeof EventsNS;
      await backup.createFromManifest(
        'kop2',
        {
          rc_version: '8.5.1',
          preset: 'default',
          runtime: 'kubernetes',
          deployment: 'monolith',
          context: 'k3s-lane',
          mongo_operator: true,
        },
        events_.nullEmit,
      );
      expect([world.created[0]?.context, world.created[0]?.mongoOperator]).toEqual([
        'k3s-lane',
        true,
      ]);
    });

    it('refuses --new over a workspace that already exists', async () => {
      const { backup, bundle } = await restorable();
      await writeRepro('taken');
      const errors = require('../../src/lib/errors') as typeof ErrorsNS;
      const refusal = backup.restore(bundle, { new: true, name: 'taken' });
      await expect(refusal).rejects.toBeInstanceOf(errors.ConflictError);
      await expect(refusal).rejects.toThrow(/already exists/u);
    });

    it('loads a --new restore into the name the create settles on, owner prefix and all', async () => {
      // The create puts `<actor>-` in front of a name and the load went to the bare one: a
      // member's restore as new left `mem-<name>` running empty and failed on `<name>`.
      const { backup, bundle } = await restorable();
      const context = require('../../src/lib/context') as typeof ContextNS;
      const out = await context.runWithContext({ actor: 'mem' }, async () => {
        return await backup.restore(bundle, { new: true });
      });
      expect([out.name, world.created[0]?.name, world.created[0]?.actor]).toEqual([
        'mem-rc8-5-1-restored',
        'mem-rc8-5-1-restored',
        'mem',
      ]);
      const named = await context.runWithContext({ actor: 'mem' }, async () => {
        return await backup.restore(bundle, { new: true, name: 'copy' });
      });
      expect([named.name, world.created[1]?.name]).toEqual(['mem-copy', 'mem-copy']);
    });

    it('deduplicates the name --new derives', async () => {
      const { backup, bundle } = await restorable();
      await writeRepro('rc8-5-1-restored');
      const out = await backup.restore(bundle, { new: true });
      expect(out.name).toBe('rc8-5-1-restored-2');
    });

    it('says the empty workspace was left behind when a --new load fails', async () => {
      const { backup, bundle } = await restorable();
      // The mongo tools are missing only now, after the bundle was taken.
      world.capture = (argv) => (argv.join(' ').includes('command -v') ? [1, ''] : [0, '']);
      const errors = require('../../src/lib/errors') as typeof ErrorsNS;
      const refusal = backup.restore(bundle, { new: true });
      await expect(refusal).rejects.toBeInstanceOf(errors.NotReadyError);
      await expect(refusal).rejects.toThrow(/was created and is running, but empty/u);
    });

    it('does not demand Docker to restore into a Kubernetes workspace', async () => {
      // `requireDocker` at the top of `restore` refused a Kubernetes target on a box with
      // no Docker -- a check for the wrong runtime, in the one place the target is known.
      load();
      jest.doMock('../../src/core/lifecycle/preconditions', () => ({
        ...jest.requireActual('../../src/core/lifecycle/preconditions'),
        requireDocker: async () => {
          throw new Error('it demanded Docker for a k8s workspace');
        },
      }));
      const backup = require('../../src/core/backup') as typeof BackupNS;
      const record = require('../../src/core/runner/record') as typeof RecordNS;
      await record.writeRecord(
        'k',
        record.metadata({
          name: 'k',
          project: 'houston-k',
          rcVersion: '8.5.1',
          extra: { runtime: 'kubernetes', context: 'kind-houston-local' },
        }),
      );
      // It fails later, on the missing bundle, which is the point: it got PAST the check.
      const refusal = backup.restore(path.join(home, 'nope.rcbak'), { name: 'k' });
      await expect(refusal).rejects.toThrow(/no backup bundle at/u);
      await expect(refusal).rejects.not.toThrow(/Docker/u);
    });
  });

  describe('the runtime a backup touches', () => {
    async function kubeRecord(name: string, extra: Record<string, unknown> = {}): Promise<void> {
      const record = require('../../src/core/runner/record') as typeof RecordNS;
      await record.writeRecord(
        name,
        record.metadata({
          name,
          project: `p-${name}`,
          rcVersion: '8.5.1',
          rcImage: 'i',
          mongoTag: '8.0',
          mongoFlavor: 'official',
          preset: 'default',
          rootUrl: 'u',
          hostPort: 3000,
          versionSource: 't',
          extra: { runtime: 'kubernetes', context: 'kind-houston-local', ...extra },
        }),
      );
    }

    it('reaches kubectl for a Kubernetes workspace and compose for a Compose one', async () => {
      // The LOGIC is runtime-agnostic; only the five places that touch a container differ,
      // and each asks which runtime it is on. The alternative was a second copy of the
      // module. Asked through `warnLowFdLimit`, one of those five.
      const kubeAsked: string[][] = [];
      jest.doMock('../../src/core/kube/transfer', () => ({
        ...jest.requireActual('../../src/core/kube/transfer'),
        execCapture: async (_name: string, argv: readonly string[]) => {
          kubeAsked.push([...argv]);
          return [0, '64000\n'];
        },
      }));
      const backup = load();
      await kubeRecord('k');
      expect(await backup.warnLowFdLimit('k')).toBe(64000);
      expect(kubeAsked).toEqual([['sh', '-c', 'ulimit -n']]);
      expect(world.captures).toEqual([]);

      // A fork, not a swap: a Compose workspace still goes the other way.
      await writeRepro('c', COMPOSE_ONE, { hostPort: 3001 });
      world.capture = () => [0, '64000\n'];
      expect(await backup.warnLowFdLimit('c')).toBe(64000);
      expect(world.captures).toEqual([['sh', '-c', 'ulimit -n']]);
      expect(kubeAsked).toHaveLength(1);
    });

    it('never puts the MongoDB operator password in an argument, on the host or in the pod', async () => {
      // `ps` showed it, in 382 scans of one `restore --force`: `kubectl exec ... mongorestore
      // --password <pw>`, the drop's `mongosh --password <pw>`, the dump, and the exec seam's
      // relay, which carries the same arguments. A local cluster's pods share the host's
      // process table, so the tool's own argv inside the pod is just as readable.
      const PASSWORD = 'pw-9c1d4e7f-not-an-argument';
      const argvs: string[][] = [];
      const stdins: string[] = [];
      const record = (argv: readonly string[], input: unknown): void => {
        argvs.push([...argv]);
        if (typeof input === 'string' && input !== '') stdins.push(input);
      };
      jest.doMock('../../src/seams/exec', () => {
        const real = jest.requireActual<typeof ExecNS>('../../src/seams/exec');
        return {
          ...real,
          // kubectl only: the lock seam reaches these too, for `flock`.
          stream: async (argv: ExecNS.Argv, options: ExecNS.StreamOptions) => {
            if (argv[0] !== 'kubectl') return await real.stream(argv, options);
            record(argv, options.input);
            await new Promise<void>((done) =>
              options.stdoutSink?.write(world.payload, () => done()),
            );
            return { argv, exitCode: 0, signal: null, stdout: null, stderr: null };
          },
          capture: async (argv: ExecNS.Argv, options: ExecNS.CaptureOptions) => {
            if (argv[0] !== 'kubectl') return await real.capture(argv, options);
            const chunks: Buffer[] = [];
            const stdin = options.stdin;
            if (stdin !== undefined && typeof stdin !== 'string') {
              for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Buffer));
            }
            record(argv, Buffer.concat(chunks).toString('latin1'));
            return { argv, exitCode: 0, signal: null, stdout: Buffer.from(''), stderr: null };
          },
        };
      });
      jest.doMock('../../src/core/kube/scale', () => ({
        ...jest.requireActual('../../src/core/kube/scale'),
        rocketchatReplicas: async () => ({}),
        restoreRocketchatReplicas: async () => 0,
        scaleRocketchat: async () => 0,
      }));
      jest.doMock('../../src/core/kube/namespace', () => ({
        ...jest.requireActual('../../src/core/kube/namespace'),
        namespaceFor: async (name: string) => `houston-${name}`,
      }));
      const backup = load();
      const { kube } = require('../../src/core/kube/exec') as {
        kube: { run: (argv: string[], options?: { input?: string }) => Promise<unknown> };
      };
      jest.spyOn(kube, 'run').mockImplementation(async (argv, options = {}) => {
        record(argv, options.input);
        const stdout = argv.includes('secret')
          ? Buffer.from(PASSWORD).toString('base64')
          : argv.includes('ulimit -n')
            ? '64000\n'
            : '';
        return { argv, returncode: 0, stdout, stderr: '' };
      });
      await kubeRecord('k', { mongo_managed_by: 'operator', namespace: 'houston-k' });
      const made = await backup.create('k');
      await backup.restore(String(made.path), { force: true });

      // What ran in the pod, from after kubectl's `--`.
      const inPod = argvs
        .filter((argv) => argv[0] === 'kubectl' && argv.includes('exec'))
        .map((argv) => argv.slice(argv.indexOf('--') + 1));
      expect(
        inPod.flatMap((argv) => argv.filter((arg) => /^mongo(?:dump|restore|sh)$/u.test(arg))),
      ).toEqual(['mongodump', 'mongosh', 'mongorestore']);
      for (const argv of argvs) expect(argv.join(' ')).not.toContain(PASSWORD);
      // It travels on stdin instead: the dump's and the load's config line, the drop's script.
      expect(stdins.filter((input) => input.includes(PASSWORD))).toHaveLength(3);
      // And the load's archive follows its password line, whole.
      expect(stdins.some((input) => input.endsWith(`\n${world.payload.toString('latin1')}`))).toBe(
        true,
      );
    });

    it('leaves a Kubernetes workspace reachable on its own port after the dump', async () => {
      // Scaling Rocket.Chat to 0 kills the port-forward with the pod, and `backup` reported
      // success over a workspace RUNNING but unreachable at its own URL -- found by an
      // operational audit, not by the suite.
      const scaled: number[] = [];
      const killed: number[] = [];
      jest.doMock('../../src/core/kube/scale', () => ({
        ...jest.requireActual('../../src/core/kube/scale'),
        rocketchatReplicas: async () => ({ 'deployment.apps/rc': 1 }),
        restoreRocketchatReplicas: async (_name: string, counts: Record<string, number>) => {
          scaled.push(counts['deployment.apps/rc'] ?? -1);
          return 0;
        },
        scaleRocketchat: async (_name: string, { replicas }: { replicas: number }) => {
          scaled.push(replicas);
          return 0;
        },
      }));
      jest.doMock('../../src/core/kube/namespace', () => ({
        ...jest.requireActual('../../src/core/kube/namespace'),
        namespaceFor: async (name: string) => `houston-${name}`,
      }));
      // The stated engine, then a `ready` of this case's own over the one it registers.
      load();
      jest.doMock('../../src/core/lifecycle/ready', () => ({
        ...jest.requireActual('../../src/core/lifecycle/ready'),
        waitServing: async (meta: Metadata) => {
          world.waited.push(meta.name);
          return {};
        },
        waitAndFinalize: async () => {
          throw new Error('a backup must not re-run finalize and re-apply the configuration');
        },
        // It takes the namespace, because "is this a kubectl port-forward" was liveness
        // dressed as identity and a recycled pid belonging to another workspace passed it.
        stopPortForward: (pid: number) => {
          killed.push(pid);
        },
      }));
      jest.resetModules();
      const fresh = require('../../src/core/backup') as typeof BackupNS;
      const events_ = require('../../src/lib/events') as typeof EventsNS;
      const record = require('../../src/core/runner/record') as typeof RecordNS;
      await kubeRecord('k', { port_forward_pid: 4242 });
      const quiesced = new fresh.Quiesced('k', [], events_.nullEmit);
      await quiesced.enter();
      await quiesced.exit();
      expect(scaled).toEqual([0, 1]);
      // The forward whose pod was just deleted is killed, not trusted to die: a doomed
      // forward gets reused and can even serve one request before it exits.
      expect(killed).toEqual([4242]);
      expect((await record.readMeta('k')).extra.port_forward_pid).toBeUndefined();
      expect(world.waited).toEqual(['k']);

      // Compose: STARTED is not SERVING there either.
      world.waited.length = 0;
      await writeRepro('c', COMPOSE_ONE, { hostPort: 3001 });
      scaled.length = 0;
      const compose = new fresh.Quiesced('c', ['rocketchat'], events_.nullEmit);
      await compose.enter();
      await compose.exit();
      expect(scaled).toEqual([]);
      expect(world.waited).toEqual(['c']);

      // --live skips the whole dance.
      world.waited.length = 0;
      const live = new fresh.Quiesced('k', [], events_.nullEmit, true);
      await live.enter();
      await live.exit();
      expect(scaled).toEqual([]);
      expect(world.waited).toEqual([]);
    });
  });
});

describe('a bundle that is not one', () => {
  // Three defects found here, each measured against earlier releases:
  //  * an unreadable bundle, or a DIRECTORY named `*.rcbak`, hung `readManifest` for ever
  //    -- `.pipe()` never forwards the file's own error -- and the error surfaced later,
  //    uncaught, from outside every handler (in `serve`, from outside the request);
  //  * random bytes were reported as "truncated, or still being written" because every zlib
  //    code was read as truncation, where earlier releases say "not a gzip file";
  //  * a 300-character name was a missing bundle (404, exit 4) where earlier releases refuse
  //    a path they cannot use (400, exit 2).
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-badbundle-'));
  });
  afterEach(() => {
    fs.chmodSync(path.join(dir, 'locked.rcbak'), 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is refused with the class and sentence earlier releases give, and never hangs', async () => {
    fs.writeFileSync(
      path.join(dir, 'rand.rcbak'),
      Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 97 + 13) % 256)),
    );
    fs.writeFileSync(path.join(dir, 'locked.rcbak'), 'hi\n');
    fs.chmodSync(path.join(dir, 'locked.rcbak'), 0o000);
    fs.mkdirSync(path.join(dir, 'dir.rcbak'));
    fs.writeFileSync(
      path.join(dir, 'midcorrupt.rcbak'),
      Buffer.concat([
        Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]),
        Buffer.from('garbage-after-header'),
      ]),
    );
    const cases = [
      path.join(dir, 'rand.rcbak'),
      path.join(dir, 'locked.rcbak'),
      path.join(dir, 'dir.rcbak'),
      path.join(dir, 'midcorrupt.rcbak'),
      path.join(dir, `${'x'.repeat(300)}.rcbak`),
      path.join(dir, 'absent.rcbak'),
    ];
    // The precondition the unreadable case needs: this process cannot open a mode-000 file.
    expect(() => fs.readFileSync(path.join(dir, 'locked.rcbak'))).toThrow(/EACCES/u);
    // What earlier releases answered for each, recorded.
    const long = cases[4] as string;
    const recorded = placed(RECORDED.notABundle, {
      '<dir>': dir,
      '<long:120>': long.slice(0, 120),
      '<long>': long,
    });
    const ours = [];
    for (const bundle of cases) {
      // BOUNDED: the defect was a read that never returned, and an unbounded await would
      // turn that into a suite that never finishes rather than a red test.
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        readManifest(bundle).then(
          () => null,
          (error: Error) => ({ kind: error.constructor.name, message: error.message }),
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'HUNG', message: bundle }), 5000);
        }),
      ]);
      // Cleared, so a read that DID return leaves no five-second timer holding Jest open.
      clearTimeout(timer);
      ours.push(outcome);
    }
    expect(ours).toEqual(recorded);
  });

  it('refuses an over-long name as unusable on delete, as earlier releases do', async () => {
    const long = path.join(dir, `${'x'.repeat(300)}.rcbak`);
    fs.writeFileSync(path.join(dir, 'locked.rcbak'), '');
    // What earlier releases answered, recorded.
    const recorded = placed(RECORDED.overLongDelete, {
      '<long:120>': long.slice(0, 120),
      '<long>': long,
    });
    const ours = await deleteBackup(long).then(
      () => null,
      (error: Error) => ({ kind: error.constructor.name, message: error.message }),
    );
    expect(ours).toEqual(recorded);
    expect(ours?.kind).toBe('ValidationError');
  });
});

/**
 * Bundles that end early, as earlier releases report them. The walker said "archive ended
 * inside a member" for every one, and a gzip stream cut short read as zlib's "unexpected
 * end of file"; earlier releases say "empty file", "truncated header", "unexpected end of
 * data", "Compressed file ended before the end-of-stream marker was reached" -- and read a
 * tar with no end-of-archive blocks, which they take as ended.
 */
describe('a bundle that ends early, as the backup listing reports it', () => {
  it('is named with the reason earlier releases give', async () => {
    const dir = path.join(process.env.HOUSTON_HOME as string, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    // The five bundles as an earlier release built them, recorded: nothing; a gzip whose
    // content is too short for a header; a tar of a manifest and 4000 random bytes cut 1000
    // bytes into the second member; the whole tar gzipped and cut in half; and the tar
    // without its end-of-archive blocks. Each is dated 1790000000.
    writeBundles(dir, RECORDED.earlyFiles);
    for (const name of Object.keys(RECORDED.earlyFiles)) {
      fs.utimesSync(path.join(dir, name), 1790000000, 1790000000);
    }
    // What earlier releases listed for them, recorded.
    const recorded = placed(RECORDED.earlyList, { '<dir>': dir });
    const ours = (await listBackups())
      .map((row) => [String(row.path).split('/').at(-1), String(row.error)])
      .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));
    expect(ours).toEqual(recorded);
    expect(recorded.map(([, error]) => error.replace(/^.*\.rcbak /u, ''))).toEqual([
      'is not a readable backup bundle: empty file',
      'is not a readable backup bundle: truncated header',
      'is not a readable backup bundle: unexpected end of data',
      'ends part-way through: it is truncated, or still being written. (Compressed file ended before the end-of-stream marker was reached)',
      '',
    ]);
  });
});

/**
 * Bundles earlier releases read differently from a gunzip stream. The gunzip stream checked
 * the whole file's CRC trailer, reading ahead of the walker to reach it, where earlier
 * releases stop at the end-of-archive block -- or at the first header they cannot use --
 * and never read the trailer; a bit-flipped archive then failed mid-member, and the
 * WriteStream still opening under it threw ENOENT, unhandled, once the staging directory
 * was removed. Each bundle is recorded as an earlier release built it, with the verdicts
 * it reached reading its manifest and unpacking its archive, and the verdicts here must be
 * the same.
 */
describe('a bundle read as earlier releases read it', () => {
  it('reaches the verdicts earlier releases reach reading and unpacking it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-asterfile-'));
    try {
      // The fifteen bundles, recorded: a good one of a manifest and a 60000-byte archive;
      // its trailer alone damaged; junk after it; a flipped stored byte; cut in the
      // archive; a second header with a bad checksum or a size that is not octal; a first
      // header with a bad checksum; a bad checksum after a PAX header; no end-of-archive
      // block, with and without a damaged trailer; a manifest stored twice;
      // contiguous-file members; `./manifest.json`; and a member of an unknown type.
      writeBundles(dir, RECORDED.tarFiles);
      const names = Object.keys(RECORDED.tarFiles).sort();
      expect(names).toHaveLength(15);
      // What earlier releases concluded for each, recorded.
      const recorded = placed(RECORDED.verdicts, { '<dir>': dir });
      const outcome = (error: unknown) => ({
        kind: (error as Error).constructor.name,
        message: (error as Error).message,
      });
      const ours: Record<string, Record<string, unknown>> = {};
      for (const name of names) {
        const bundle = path.join(dir, name);
        const row: Record<string, unknown> = {};
        let manifest: Record<string, unknown> = {};
        try {
          manifest = await readManifest(bundle);
          row.manifest = { repro: manifest.repro };
        } catch (error) {
          row.manifest = outcome(error);
        }
        const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-asterfile-staging-'));
        try {
          const { unpackArchive, sha256File } = require('../../src/core/backup') as typeof BackupNS;
          const archive = await unpackArchive(bundle, staging, manifest);
          row.unpack = { sha256: sha256File(archive) };
        } catch (error) {
          row.unpack = outcome(error);
        } finally {
          // Removed at once, as `loadFromBundle`'s `finally` removes it: nothing still
          // writing into it may fail afterwards.
          fs.rmSync(staging, { recursive: true, force: true });
        }
        ours[name] = row;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ours).toEqual(recorded);
      // The shapes this is about, so a change that makes both answers wrong the same way is
      // still visible.
      const at = (name: string) => recorded[name] ?? {};
      expect(at('badcrc.rcbak').unpack).toEqual(at('good.rcbak').unpack);
      expect(at('flipped.rcbak').unpack).toEqual({
        kind: 'ValidationError',
        message: `${path.join(dir, 'flipped.rcbak')} is corrupt: the archive does not match its recorded checksum`,
      });
      // Past the first header, one earlier releases cannot use is the END: the manifest reads, and
      // the archive after it is not there.
      for (const name of ['second-bad-checksum.rcbak', 'second-not-octal.rcbak']) {
        expect(at(name)).toEqual({
          manifest: { repro: 'w' },
          unpack: {
            kind: 'ValidationError',
            message: `${path.join(dir, name)} has no mongo.archive.gz; is it an houston backup?`,
          },
        });
      }
      expect(at('after-pax-bad-checksum.rcbak').manifest).toEqual({
        kind: 'ValidationError',
        message: `${path.join(dir, 'after-pax-bad-checksum.rcbak')} is not a readable backup bundle: bad checksum`,
      });
      expect(at('dup.rcbak').manifest).toEqual({ repro: 'last' });
      expect(at('contig.rcbak').unpack).toEqual(at('good.rcbak').unpack);
      expect((at('no-eoa-badcrc.rcbak').unpack as { kind?: string }).kind).toBe('BadGzip');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
