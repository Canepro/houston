import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../src/lib/config';
import { runWithContext } from '../../src/lib/context';
import { event as makeEvent, installedSinks } from '../../src/lib/events';
import { REDACTED } from '../../src/lib/redact';

import { THIS_IMPLEMENTATION } from '../../src/lib/lock';

import {
  DEFAULT_MAX_MB,
  DIRNAME,
  FILENAME,
  IMPL,
  RUN,
  configure,
  ended,
  event,
  failed,
  installEventlogSink,
  jobEnded,
  jobStarted,
  logPath,
  maxBytes,
  redact,
  resetForTest,
  settle,
  started,
} from '../../src/core/eventlog';

/**
 * The line an earlier release appended for `started("up", "alice")`, recorded byte for
 * byte. Its `impl` field says which build wrote it, in that build's own word.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'core', 'eventlog.json'), 'utf8'),
) as { started: string };

function lines(): Record<string, unknown>[] {
  return fs
    .readFileSync(logPath(), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  fs.rmSync(path.join(config.home(), DIRNAME), { recursive: true, force: true });
  delete process.env.HOUSTON_LOG_MAX_MB;
  delete process.env.HOUSTON_LOG_ECHO;
  resetForTest();
});

// A rotation runs after the append that starts it, and its flock(1) creates the log file it
// locks. One still in flight when a test ends races the next test's removal of the logs
// directory, and after the last test the removal of the home itself (ENOTEMPTY): so every
// test waits for the rotations it started.
afterEach(async () => {
  await settle();
});

describe('the record', () => {
  it('is one compact JSON object per line, with no spaces after the separators', () => {
    started('up --name TICKET-1', 'alice');
    const raw = fs.readFileSync(logPath(), 'utf8').trim();
    expect(raw).not.toContain('", "');
    expect(raw).not.toContain('": ');
    expect(lines()).toHaveLength(1);
  });

  it('carries a per-process run id, so one grep is one invocation', () => {
    started('up', 'alice');
    ended(0, 1.234);
    expect(lines().every((l) => l.run === RUN)).toBe(true);
    expect(RUN).toMatch(/^[0-9a-f]{8}$/u);
  });

  it('stamps UTC with a Z, like the journal beside it', () => {
    started('up', 'alice');
    expect(lines()[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  });

  it('rounds the duration to two places, as earlier releases do', () => {
    started('up');
    ended(3, 1.23456);
    expect(lines()[1]).toMatchObject({ kind: 'end', exit: 3, secs: 1.23 });
  });

  it('is created 0600, because it carries a workspace name, an actor and an error', () => {
    started('up');
    expect(fs.statSync(logPath()).mode & 0o777).toBe(0o600);
  });

  it('makes 0700 the logs directory alone, and its missing parents as earlier releases do', () => {
    // Earlier releases make the logs directory 0700 and a missing home and ITS missing
    // parents with the umask's mode, where a recursive mkdir made every one of them 0700.
    const modes = (root: string): string[] =>
      ['a', 'a/home', 'a/home/logs'].map((relative) =>
        (fs.statSync(path.join(root, relative)).mode & 0o777).toString(8),
      );
    const base = fs.mkdtempSync(path.join(config.home(), 'nested-'));
    // What earlier releases left: the umask's mode, which is what a plain mkdir gets, on
    // the two parents, and 0700 on the logs directory itself.
    fs.mkdirSync(path.join(base, 'reference'));
    const umaskMode = (fs.statSync(path.join(base, 'reference')).mode & 0o777).toString(8);
    const recorded = [umaskMode, umaskMode, '700'];
    const previous = process.env.HOUSTON_HOME;
    process.env.HOUSTON_HOME = path.join(base, 'ts', 'a', 'home');
    try {
      started('up');
    } finally {
      if (previous === undefined) delete process.env.HOUSTON_HOME;
      else process.env.HOUSTON_HOME = previous;
    }
    expect(modes(path.join(base, 'ts'))).toEqual(recorded);
    expect(modes(path.join(base, 'ts'))[2]).toBe('700');
  });

  it('separates concurrent jobs inside one serve, which `run` alone cannot', () => {
    // `run` is per PROCESS and a serve is one process for many jobs.
    runWithContext({ jobId: 'job-7', workspace: 'TICKET-9' }, () => {
      started('create');
    });
    expect(lines()[0]).toMatchObject({ job: 'job-7', ws: 'TICKET-9' });
    started('other');
    expect(lines()[1]).not.toHaveProperty('job');
  });

  it('prefers the execution workspace over the process-wide one', () => {
    configure({ ws: 'process-wide' });
    runWithContext({ workspace: 'this-job' }, () => started('x'));
    expect(lines()[0]?.ws).toBe('this-job');
    started('y');
    expect(lines()[1]?.ws).toBe('process-wide');
  });
});

describe('the writer and the route on every record', () => {
  it('names the build that wrote it and how it was started', () => {
    expect(IMPL).toBe(THIS_IMPLEMENTATION);
    started('list --json');
    configure({ via: 'dispatcher' });
    ended(0, 0.5);
    failed('internal', 'boom');
    const rows = lines();
    expect(rows.map((r) => [r.impl, r.via])).toEqual([
      ['typescript', 'direct'],
      ['typescript', 'dispatcher'],
      ['typescript', 'dispatcher'],
    ]);
    // The order earlier releases write, key for key.
    expect(Object.keys(rows[0] as object).slice(0, 6)).toEqual([
      'ts',
      'run',
      'pid',
      'kind',
      'impl',
      'via',
    ]);
  });
});

describe('redaction at the sink', () => {
  it('DROPS the unbounded and by-name-credential keys rather than walking them', () => {
    // A walk can miss a shape; dropping cannot.
    const out = redact({ result: { anything: 1 }, token: 'x', ok: 1 }) as Record<string, unknown>;
    expect(out).toEqual({ ok: 1 });
  });

  it('masks a value whose KEY names a credential', () => {
    const out = redact({ ldap_password: 'hunter2', apiKey: 'k' }) as Record<string, unknown>;
    expect(out).toEqual({ ldap_password: REDACTED, apiKey: REDACTED });
  });

  it('masks a credential the key name never reveals, inside a URL', () => {
    // MONGO_URL says nothing about the password in its VALUE.
    const out = redact({ MONGO_URL: 'mongodb://rc:s3cret@mongo:27017/rocketchat' }) as Record<
      string,
      unknown
    >;
    expect(out.MONGO_URL).toBe(`mongodb://rc:${REDACTED}@mongo:27017/rocketchat`);
  });

  it('bounds a pathological structure rather than trusting a result document', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < 12; i += 1) deep = { down: deep };
    expect(JSON.stringify(redact(deep))).toContain('…');
    expect(redact(Array.from({ length: 50 }, (_x, i) => i))).toHaveLength(20);
  });

  it('redacts exactly as earlier releases do, for every one of those shapes', () => {
    const cases: unknown[] = [
      { result: { a: 1 }, token: 'x', ok: 1 },
      { ldap_password: 'hunter2', apiKey: 'k' },
      { MONGO_URL: 'mongodb://rc:s3cret@mongo:27017/rocketchat' },
      { nested: { auth_token: 'x', url: 'https://u:p@h/x' } },
      'https://user:pw@example.com/path',
      [1, 'https://u:p@h', { secret: 'v' }],
      42,
      null,
    ];
    // What earlier releases wrote for each, recorded.
    const recorded = [
      { ok: 1 },
      { ldap_password: '********', apiKey: '********' },
      { MONGO_URL: 'mongodb://rc:********@mongo:27017/rocketchat' },
      { nested: { url: 'https://u:********@h/x' } },
      'https://user:********@example.com/path',
      [1, 'https://u:********@h', { secret: '********' }],
      42,
      null,
    ];
    expect(cases.map((c) => redact(c))).toEqual(recorded);
  });
});

describe('the echo rule', () => {
  it("skips docker's echo, which would bury the four lines that matter", () => {
    // `_up` turns every line of `docker compose pull` into an event, so a GUI create
    // emits several hundred `Downloading 45.09MB` records.
    event(makeEvent('Downloading 45.09MB', { data: { echo: true } }));
    expect(fs.existsSync(logPath())).toBe(false);
  });

  it('NEVER skips a warning or an error, echo or not', () => {
    event(makeEvent('something wrong', { level: 'warn', data: { echo: true } }));
    event(makeEvent('it failed', { level: 'error', data: { echo: true } }));
    expect(lines()).toHaveLength(2);
  });

  it('keeps the echo when somebody is debugging a pull', () => {
    process.env.HOUSTON_LOG_ECHO = '1';
    event(makeEvent('Downloading 45.09MB', { data: { echo: true } }));
    expect(lines()).toHaveLength(1);
  });

  it('omits an empty data bag rather than writing an empty object', () => {
    event(makeEvent('plain', {}));
    expect(lines()[0]).not.toHaveProperty('data');
  });
});

describe('the bound', () => {
  it('is four megabytes by default', () => {
    expect(maxBytes()).toBe(DEFAULT_MAX_MB * 1_048_576);
    expect(DEFAULT_MAX_MB).toBe(4);
  });

  it('is disabled entirely by HOUSTON_LOG_MAX_MB=0', () => {
    process.env.HOUSTON_LOG_MAX_MB = '0';
    started('up');
    expect(fs.existsSync(logPath())).toBe(false);
  });

  it('accepts a fractional cap, truncated to whole bytes as earlier releases do', () => {
    process.env.HOUSTON_LOG_MAX_MB = '0.5';
    expect(maxBytes()).toBe(Math.trunc(0.5 * 1_048_576));
    process.env.HOUSTON_LOG_MAX_MB = 'nonsense';
    expect(maxBytes()).toBe(DEFAULT_MAX_MB * 1_048_576);
  });

  it('agrees with earlier releases about every one of those caps', () => {
    // Read as earlier releases read a decimal, not by Number(): ' ' was 0 here -- the log
    // DISABLED, no start and no end for any command -- where earlier releases refuse it and
    // keep 4 MB; 0x10 and 0b1 were 16 and 1, 1_0 the default; and an infinity is an
    // `OutOfRange` in both.
    const caps = ['', '0', '0.5', '4', 'nonsense', '-1', ' ', '0x10', '0b1', '1_0', ' 2 ', '1e1'];
    caps.push('nan', 'inf', '-inf', '١');
    // What earlier releases answered for each, recorded.
    const recorded = [
      ...[4194304, 0, 524288, 4194304, 4194304, -1048576, 4194304, 4194304, 4194304],
      ...[10485760, 2097152, 10485760, 4194304, 'OutOfRange', 'OutOfRange', 1048576],
    ];
    const mine = caps.map((c) => {
      process.env.HOUSTON_LOG_MAX_MB = c;
      try {
        return maxBytes();
      } catch (error) {
        return (error as Error).name;
      }
    });
    delete process.env.HOUSTON_LOG_MAX_MB;
    expect(mine).toEqual(recorded);
  });

  it('rotates to .1 and loses no record across the boundary', async () => {
    // The one non-atomic moment. The append is lock-free O_APPEND; the rotation takes the
    // cross-process lock and re-checks the size UNDER it, so the check and the rename are
    // one decision. Records written before the rename travel with the inode into `.1`,
    // and both files are read -- so counting BOTH is what proves nothing was dropped.
    process.env.HOUSTON_LOG_MAX_MB = '0.002';
    const want = 400;
    for (let i = 0; i < want; i += 1) event(makeEvent(`line-${String(i)}`.padEnd(120, 'x')));
    await settle();

    const all: string[] = [];
    for (const file of [logPath(), `${logPath()}.1`]) {
      if (!fs.existsSync(file)) continue;
      all.push(
        ...fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter((l) => l !== ''),
      );
    }
    expect(fs.existsSync(`${logPath()}.1`)).toBe(true);
    const seen = new Set(all.map((l) => (JSON.parse(l) as { msg: string }).msg));
    expect(seen.size).toBe(want);
  });
});

describe('never throwing, never printing', () => {
  it('disables itself on the first filesystem failure rather than raising', () => {
    const blocked = path.join(config.home(), 'blocked-log');
    fs.writeFileSync(blocked, 'not a directory');
    const previous = process.env.HOUSTON_HOME;
    process.env.HOUSTON_HOME = blocked;
    try {
      expect(() => started('up')).not.toThrow();
      // And it stays off: a broken log costs one boolean per event, not an exception.
      expect(() => ended(0, 1)).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.HOUSTON_HOME;
      else process.env.HOUSTON_HOME = previous;
    }
  });

  it('writes an unserialisable value as its string form rather than raising', () => {
    event(makeEvent('odd', { data: { when: 10n, fn: () => 1 } }));
    expect(lines()).toHaveLength(1);
  });
});

describe('the sink lease', () => {
  it('is EXPLICIT, not installed by importing the module', () => {
    // Re-importing a cached module cannot restore cleared global state, and two app
    // factories must share one invocation while retaining independent shutdown ownership.
    expect(installedSinks()).not.toContain('eventlog');
    const off = installEventlogSink();
    expect(installedSinks()).toContain('eventlog');
    off();
    expect(installedSinks()).not.toContain('eventlog');
  });
});

describe('the other record kinds', () => {
  it('writes the job and error shapes earlier releases write', () => {
    failed('docker_error', 'mongodb://rc:s3cret@mongo/x failed', { stackTraceOnStderr: true });
    jobStarted('j1', 'create', 'TICKET-1');
    jobEnded('j1', 'create', 'TICKET-1', 'error', 'it broke');
    const [err, start, end] = lines();
    expect(err).toMatchObject({ kind: 'error', code: 'docker_error', trace: true });
    expect(String(err?.msg)).toContain(REDACTED);
    expect(start).toMatchObject({ kind: 'job-start', job_kind: 'create', label: 'TICKET-1' });
    expect(end).toMatchObject({ kind: 'job-end', status: 'error', msg: 'it broke' });
  });

  it('writes the same keys earlier releases write, for the same calls', () => {
    started('up --name TICKET-1', 'alice');
    ended(0, 1.5);
    const mine = lines().map((l) => Object.keys(l).sort());
    // The keys of the two lines earlier releases wrote for these calls, sorted, recorded.
    const recorded = [
      ['actor', 'cmd', 'impl', 'kind', 'pid', 'run', 'ts', 'via', 'ws'],
      ['actor', 'cmd', 'exit', 'impl', 'kind', 'pid', 'run', 'secs', 'ts', 'via', 'ws'],
    ];
    expect(mine).toEqual(recorded);
  });
});

describe('compatibility with the log earlier releases wrote', () => {
  it('spells a record as earlier releases spell it: compact, and ASCII past U+007E', () => {
    // The dual-v1 log that earlier releases and this build both append to. JSON.stringify
    // wrote the `—` of every NOT_READY message and the `é` of an argv raw, where earlier
    // releases escape it and write `\u2014` -- equal values, two spellings of one record.
    // The four fields that differ by nature -- when, which run, which pid, which build --
    // are masked; every other byte must agree.
    const mask = (text: string) =>
      text
        .replace(/"ts":"[^"]*"/gu, '"ts":"T"')
        .replace(/"run":"[0-9a-f]*"/gu, '"run":"R"')
        .replace(/"pid":\d+/gu, '"pid":0')
        .replace(/"impl":"[^"]*"/gu, '"impl":"I"');
    started('chown --name alpha --to Jos\u00e9 \u{1f600}\u2028', 'alice');
    failed(
      'NOT_READY',
      "'alpha' is not answering yet, so logging in cannot run \u2014 wait\x7f\x85",
    );
    event(makeEvent('rate \u00e9', { data: { rate: 5e-5, tiny: 1e-7, gone: Number.NaN } }));
    const ours = mask(fs.readFileSync(logPath(), 'utf8'));
    // What earlier releases wrote for the same three calls, recorded and masked.
    const cmd = '"cmd":"chown --name alpha --to Jos\\u00e9 \\ud83d\\ude00\\u2028","ws":""';
    const head = '{"ts":"T","run":"R","pid":0,';
    const who = '"impl":"I","via":"direct","actor":"alice",';
    const recorded = [
      `${head}"kind":"start",${who}${cmd}}`,
      `${head}"kind":"error",${who}${cmd},"code":"NOT_READY",` +
        `"msg":"'alpha' is not answering yet, so logging in cannot run \\u2014 wait` +
        `\\u007f\\u0085","trace":false}`,
      `${head}"kind":"event",${who}${cmd},"phase":"info","level":"info",` +
        '"msg":"rate \\u00e9","data":{"rate":5e-05,"tiny":1e-07,"gone":NaN}}',
      '',
    ].join('\n');
    expect(ours).toBe(recorded);
    expect(ours).toContain('cannot run \\u2014 wait');
  });

  it('appends to a log an earlier release started, and both lines parse on both sides', () => {
    // Where earlier releases keep the log, holding the line they appended.
    const theirPath = path.join(config.home(), 'logs', 'houston.log');
    fs.mkdirSync(path.dirname(theirPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(theirPath, RECORDED.started, { encoding: 'utf8', mode: 0o600 });
    const before = fs.readFileSync(logPath(), 'utf8');
    expect(before).toBe(RECORDED.started);
    started('down', 'bob');
    const after = fs.readFileSync(logPath(), 'utf8');
    expect(after.startsWith(before)).toBe(true);

    // Earlier releases read the log a line at a time, each non-empty line one document.
    const theirs = after
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(theirs).toHaveLength(2);
    expect(theirs[0]).toMatchObject({ cmd: 'up', actor: 'alice', kind: 'start' });
    expect(theirs[1]).toMatchObject({ cmd: 'down', actor: 'bob', kind: 'start' });
  });

  it('writes to the same path earlier releases read', () => {
    // The directory, the file and the path earlier releases gave, recorded.
    const recorded = `logs houston.log ${config.home()}/logs/houston.log`;
    expect(`${DIRNAME} ${FILENAME} ${logPath()}`).toBe(recorded);
  });
});

describe('the log as a file on disk', () => {
  it('stays two files, private at the file and at the directory', async () => {
    // Three properties that stop a log becoming its own problem: bounded, private, and
    // silent when it cannot write (the last is `disables itself on the first filesystem
    // failure`). TWO files, not a growing family.
    process.env.HOUSTON_LOG_MAX_MB = '0.002';
    for (let i = 0; i < 400; i += 1) event(makeEvent(`line ${String(i)} ${'x'.repeat(60)}`));
    await settle();
    // The rotation is enqueued, so the current file is recreated by the NEXT append rather
    // than by the rename; one more record puts both files on disk.
    event(makeEvent('after the rotation'));
    const dir = path.dirname(logPath());
    const family = fs.readdirSync(dir).filter((name) => name.startsWith(FILENAME));
    expect(family.sort()).toEqual([FILENAME, `${FILENAME}.1`]);
    expect(fs.statSync(logPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});
