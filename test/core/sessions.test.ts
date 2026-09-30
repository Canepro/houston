import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../src/lib/config';

import {
  ABSOLUTE_SECONDS,
  IDLE_SECONDS,
  STATE_VERSION,
  alive,
  create,
  describeAgent,
  expiresAt,
  listFor,
  publicView,
  resetCache,
  revoke,
  revokeSid,
  revokeUser,
  sessionsFile,
  verify,
  type Session,
} from '../../src/core/sessions';

/** The three header lines earlier releases write, recorded byte for byte. */
const RECORDED_HEADER =
  '# houston GUI sessions. Managed by the server; delete a line to revoke it.\n' +
  '# houston-state: 1\n' +
  '# sha256(token)\tuser\tcreated\tlast_seen\tlabel\torigin\n';

/** A session an earlier release minted at RECORDED_MINTED, and the file it wrote for it. */
const RECORDED_TOKEN = '2ZC1co8eblbJEGF3WDFWxnDAH1tzSqrhCr9PeVmnaoM';
const RECORDED_MINTED = 1790672631;
const RECORDED_MINTED_FILE =
  RECORDED_HEADER +
  'e45a04b744bb6699a73d5d4b49cefad74b623a5c2a75547746500e88f4cb0dca\talice\t' +
  `${String(RECORDED_MINTED)}\t${String(RECORDED_MINTED)}\tFirefox on Linux\tsession\n`;

/** Where earlier releases keep the file: `<home>/sessions`. */
function recordedPath(): string {
  return path.join(config.home(), 'sessions');
}

/** A row with its digest and its two clocks masked, so two mints compare by layout. */
function masked(text: string): string {
  return text.replace(/^[0-9a-f]{64}\t([^\t\n]*)\t\d+\t\d+\t/gmu, 'SID\t$1\tT\tT\t');
}

function body(): string {
  return fs.readFileSync(sessionsFile(), 'utf8');
}

function rows(): string[] {
  return body()
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function sid(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

beforeEach(() => {
  fs.rmSync(sessionsFile(), { force: true });
  resetCache();
});

describe('the on-disk format', () => {
  it('is tab-delimited behind the state-version header', async () => {
    await create('alice', { label: 'Firefox on Linux' });
    const text = body();
    expect(text).toContain(`# houston-state: ${STATE_VERSION}\n`);
    expect(text.split('\n')[0]).toBe(
      '# houston GUI sessions. Managed by the server; delete a line to revoke it.',
    );
    expect(text.split('\n')[2]).toBe('# sha256(token)\tuser\tcreated\tlast_seen\tlabel\torigin');
    const parts = (rows()[0] as string).split('\t');
    expect(parts).toHaveLength(6);
    expect(parts[1]).toBe('alice');
    expect(parts[4]).toBe('Firefox on Linux');
    expect(parts[5]).toBe('session');
  });

  it('writes the header bytes earlier releases write, character for character', async () => {
    await create('alice');
    const mine = body().split('\n').slice(0, 3).join('\n');
    expect(`${mine}\n`).toBe(RECORDED_HEADER);
  });

  it('stores only the digest, never the token', async () => {
    const token = await create('alice');
    expect(body()).not.toContain(token);
    expect(rows()[0]?.startsWith(sid(token))).toBe(true);
  });

  it('is created 0600, because it is a set of live credentials', async () => {
    await create('alice');
    expect(fs.statSync(sessionsFile()).mode & 0o777).toBe(0o600);
  });

  it('mints a token of the same alphabet and length as earlier releases mint', async () => {
    const token = await create('alice');
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it('cannot have its record separator broken by an attacker-controlled label', async () => {
    await create('alice', { label: 'Firefox\ton\nLinux\tadmin\t0\t0\tx\tsession' });
    expect(rows()).toHaveLength(1);
    expect((rows()[0] as string).split('\t')).toHaveLength(6);
    expect((rows()[0] as string).split('\t')[4]).toBe('FirefoxonLinuxadmin00xsession');
  });

  it('caps the label at sixty characters, as earlier releases do', async () => {
    await create('alice', { label: 'x'.repeat(200) });
    expect((rows()[0] as string).split('\t')[4]).toHaveLength(60);
  });

  it('labels a session with no user agent "unknown" rather than empty', async () => {
    await create('alice', { label: '' });
    expect((rows()[0] as string).split('\t')[4]).toBe('unknown');
  });
});

describe('the two clocks', () => {
  const base: Session = {
    sid: 'a'.repeat(64),
    user: 'alice',
    created: 1_000_000,
    lastSeen: 1_000_000,
    label: 'x',
    origin: 'session',
  };

  it('expire at whichever bound bites first, derived rather than stored', () => {
    expect(expiresAt(base)).toBe(base.created + IDLE_SECONDS);
    const old = { ...base, lastSeen: base.created + ABSOLUTE_SECONDS };
    expect(expiresAt(old)).toBe(base.created + ABSOLUTE_SECONDS);
  });

  it('agree with earlier releases on both bounds', () => {
    // The idle and absolute bounds and the state version earlier releases had, recorded.
    const recorded = [43200, 604800, 1];
    expect(recorded).toEqual([IDLE_SECONDS, ABSOLUTE_SECONDS, STATE_VERSION]);
  });

  it('call a session dead at its expiry, not after it', () => {
    expect(alive(base, expiresAt(base) - 1)).toBe(true);
    expect(alive(base, expiresAt(base))).toBe(false);
  });

  it('truncate the sid in the public view, because a listed verifier is a handed-over one', () => {
    const view = publicView(base);
    expect(view.sid).toBe('aaaaaaaa');
    expect(view.expires_at).toBe(expiresAt(base));
    expect(Object.keys(view)).toEqual([
      'sid',
      'user',
      'created',
      'last_seen',
      'label',
      'origin',
      'expires_at',
    ]);
  });
});

describe('verify, revoke, and list', () => {
  it('returns the session a live token names', async () => {
    const token = await create('alice', { label: 'Firefox on Linux' });
    const s = await verify(token);
    expect(s?.user).toBe('alice');
    expect(s?.sid).toBe(sid(token));
  });

  it('returns null for an empty, unknown or revoked token', async () => {
    expect(await verify('')).toBeNull();
    expect(await verify('not-a-token')).toBeNull();
    const token = await create('alice');
    expect(await revoke(token)).toBe(true);
    expect(await verify(token)).toBeNull();
    expect(await revoke(token)).toBe(false);
  });

  it('refuses an expired session without needing anything to sweep it', async () => {
    const token = await create('alice');
    const expired = body().replace(
      /^([0-9a-f]{64}\t\w+\t)(\d+)\t(\d+)/mu,
      (_m, head: string) => `${head}1000000\t1000000`,
    );
    fs.writeFileSync(sessionsFile(), expired);
    resetCache();
    expect(await verify(token)).toBeNull();
  });

  it('ends every session a user has, which is what a password change must do', async () => {
    await create('alice');
    await create('alice');
    const other = await create('bob');
    expect(await revokeUser('alice')).toBe(2);
    expect(rows()).toHaveLength(1);
    expect(await verify(other)).not.toBeNull();
    expect(await revokeUser('nobody')).toBe(0);
  });

  it('lists only the asking user, and keeps insertion order for a tie', () => {
    // A tie is the normal case here, not an edge case: sessions minted inside one second
    // share `last_seen`, and BOTH sorts are stable, so the tie keeps insertion order rather
    // than reversing it. Measured on earlier releases before being asserted here -- the
    // intuitive expectation ("three" first) is wrong on both sides, and encoding it would
    // have meant departing from them to make the test pass. The file is written directly
    // rather than through `create()`: three real mints under a loaded suite can straddle a
    // second boundary, which turns the tie into a real order and makes the assertion a race
    // the test sometimes loses. The clock is read once so every row shares the same second,
    // and the order earlier releases gave is recorded beside it.
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(
      sessionsFile(),
      '# houston GUI sessions. Managed by the server; delete a line to revoke it.\n' +
        `# houston-state: ${STATE_VERSION}\n` +
        '# sha256(token)\tuser\tcreated\tlast_seen\tlabel\torigin\n' +
        `${'a'.repeat(64)}\talice\t${now}\t${now}\tone\tsession\n` +
        `${'b'.repeat(64)}\tbob\t${now}\t${now}\ttwo\tsession\n` +
        `${'c'.repeat(64)}\talice\t${now}\t${now}\tthree\tsession\n`,
    );
    resetCache();

    expect(listFor('alice').map((s) => s.label)).toEqual(['one', 'three']);
    expect(listFor('bob').map((s) => s.label)).toEqual(['two']);
    expect(listFor('nobody')).toEqual([]);

    const recorded = ['one', 'three'];
    expect(listFor('alice').map((s) => s.label)).toEqual(recorded);
  });

  it('orders by last activity when the timestamps actually differ', () => {
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(
      sessionsFile(),
      '# houston GUI sessions. Managed by the server; delete a line to revoke it.\n' +
        `# houston-state: ${STATE_VERSION}\n` +
        '# sha256(token)\tuser\tcreated\tlast_seen\tlabel\torigin\n' +
        `${'1'.repeat(64)}\talice\t${now - 300}\t${now - 300}\told\tsession\n` +
        `${'2'.repeat(64)}\talice\t${now - 300}\t${now - 10}\trecent\tsession\n` +
        `${'3'.repeat(64)}\talice\t${now - 300}\t${now - 100}\tmiddle\tsession\n`,
    );
    resetCache();
    expect(listFor('alice').map((s) => s.label)).toEqual(['recent', 'middle', 'old']);
  });

  it('revokes by sid, which is what the "your sessions" list hands back', async () => {
    const token = await create('alice');
    expect(await revokeSid('deadbeef')).toBe(false);
    expect(await revokeSid(sid(token))).toBe(true);
    expect(await verify(token)).toBeNull();
  });

  it('drops an expired row on the next write rather than keeping it forever', async () => {
    const live = await create('alice');
    fs.writeFileSync(
      sessionsFile(),
      `${body()}${'b'.repeat(64)}\tghost\t1000000\t1000000\tstale\tsession\n`,
    );
    resetCache();
    expect(rows()).toHaveLength(2);
    await create('bob');
    expect(
      rows()
        .map((r) => r.split('\t')[1])
        .sort(),
    ).toEqual(['alice', 'bob']);
    expect(await verify(live)).not.toBeNull();
  });
});

describe('describe_agent', () => {
  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/120 Safari/537', 'Chrome on macOS'],
    ['Mozilla/5.0 (Windows NT 10.0) Edg/120', 'Edge on Windows'],
    ['curl/8.5.0', 'curl'],
    ['', 'unknown'],
  ])('reads %p as %p', (ua, expected) => {
    expect(describeAgent(ua)).toBe(expected);
  });

  it('agrees with earlier releases on every one of those, including the precedence order', () => {
    const agents = [
      'Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/120 Safari/537',
      'Mozilla/5.0 (Windows NT 10.0) Edg/120 Chrome/120 Safari/537',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604',
      'curl/8.5.0',
      'Opera/OPR/106 Chrome/120',
      '',
    ];
    // What earlier releases called each one, recorded.
    const recorded = [
      'Firefox on Linux',
      'Chrome on macOS',
      'Edge on Windows',
      'Safari on iOS',
      'curl',
      'Opera',
      'unknown',
    ];
    expect(agents.map(describeAgent)).toEqual(recorded);
  });
});

describe('compatibility with the sessions file earlier releases wrote', () => {
  it('verifies a session an earlier release minted', async () => {
    fs.mkdirSync(config.home(), { recursive: true });
    fs.writeFileSync(recordedPath(), RECORDED_MINTED_FILE, { encoding: 'utf8', mode: 0o600 });
    jest.spyOn(Date, 'now').mockReturnValue((RECORDED_MINTED + 60) * 1000);
    resetCache();
    const s = await verify(RECORDED_TOKEN);
    expect(s?.user).toBe('alice');
    expect(s?.label).toBe('Firefox on Linux');
    expect(s?.origin).toBe('session');
  });

  it('mints a session an earlier release verifies', async () => {
    const token = await create('bob', { label: 'Chrome on macOS', origin: 'setup' });
    // The file an earlier release wrote for the same mint, recorded. This build's is the
    // same but for the digest and the two clocks, so it reads this one as it reads its own.
    const recorded =
      RECORDED_HEADER +
      '15f189ca8314ca47f11877e46090b0e9ae962bf240c9c7f25879c0c6d4353a0a\tbob\t' +
      '1790672645\t1790672645\tChrome on macOS\tsetup\n';
    const mine = fs.readFileSync(recordedPath(), 'utf8');
    expect(masked(mine)).toBe(masked(recorded));
    const seen = (rows()[0] as string).split('\t');
    expect(seen[0]).toBe(sid(token));
    expect(seen[1]).toBe('bob');
    expect(seen[4]).toBe('Chrome on macOS');
    expect(seen[5]).toBe('setup');
  });

  it('honours a revocation made by the other build', async () => {
    const token = await create('alice');
    // What an earlier release leaves after revoking the only session there is, recorded.
    fs.writeFileSync(recordedPath(), RECORDED_HEADER, 'utf8');
    resetCache();
    expect(await verify(token)).toBeNull();
  });

  it('has its own revocation honoured by the other build', async () => {
    const token = await create('alice');
    expect(await revoke(token)).toBe(true);
    // An earlier release reads a file with no row for the digest as no session: this one
    // is exactly what it leaves after a revocation of its own.
    expect(fs.readFileSync(recordedPath(), 'utf8')).toBe(RECORDED_HEADER);
    expect(body()).not.toContain(sid(token));
  });

  it('leaves a file the other build rewrites to the same rows', async () => {
    await create('alice', { label: 'one' });
    await create('bob', { label: 'two' });
    const mine = rows().sort();

    // The rows an earlier release wrote back for the same two sessions when it rewrote the
    // file, recorded: the same but for each digest and the two clocks.
    const recorded = [
      '78ae10f004869f0206b8bc20c4b26ce03933cbfc293e4df4c8478e09c977644f\talice\t' +
        '1790672632\t1790672632\tone\tsession',
      '5bd749c7ff4f47e29c13810c9ee59a78f309b80647435355073a4eb9e5a11d06\tbob\t' +
        '1790672632\t1790672632\ttwo\tsession',
    ];
    expect(mine.map(masked).sort()).toEqual(recorded.map(masked).sort());
  });

  // Hand-edited files, each revoked from here and by earlier releases: they break lines on
  // every line boundary and read the two clocks as whole decimal numbers. `split('\n')` kept
  // a CRLF file's `\r` in the origin and read two sessions split by a lone `\r` as one;
  // `parseInt` kept `NOWx` and `NOW.0`, dropped ` 1_NOW` as expired, and could not read
  // fullwidth digits, so bob stayed signed in on a line earlier releases revoke. The clock
  // is the one the answers were recorded at.
  it('is read as earlier releases read it, and rewritten to the same bytes on revoke', async () => {
    const recordedNow = 1790672632;
    jest.spyOn(Date, 'now').mockReturnValue(recordedNow * 1000);
    const now = Math.floor(Date.now() / 1000);
    const fullwidth = [...String(now)]
      .map((digit) => String.fromCodePoint(0xff10 + Number(digit)))
      .join('');
    const line = (id: string, user: string, created: string, seen: string, end = '\n') =>
      `${id.repeat(64)}\t${user}\t${created}\t${seen}\tcurl\tsession${end}`;
    const shapes = [
      line('1', 'bob', `${now}`, `${now}`) +
        line('3', 'alice', `${now}x`, `${now}`) +
        line('4', 'carol', `${now}.0`, `${now}`) +
        line('5', 'carol', ` 1_${now}`, `+${now}`),
      line('1', 'bob', fullwidth, fullwidth),
      `# a header\r\n${line('1', 'bob', `${now}`, `${now}`, '\r\n')}${line('3', 'alice', `${now}`, `${now}`, '\r\n')}`,
      line('1', 'bob', `${now}`, `${now}`, '\r') + line('2', 'bob', `${now}`, `${now}`),
      line('1', 'bob', `${now}`, `${now}`, '\x1c') +
        line('2', 'bob', `${now}`, `${now}`, ' ') +
        line('3', 'alice', `${now}`, `${now}`),
    ];
    // What earlier releases revoked and left behind for each, recorded.
    const kept = (id: string, user: string, created: string): string =>
      `${id.repeat(64)}\t${user}\t${created}\t${String(recordedNow)}\tcurl\tsession\n`;
    const recorded: [number, string][] = [
      [1, `${RECORDED_HEADER}${kept('5', 'carol', `1${String(recordedNow)}`)}`],
      [1, RECORDED_HEADER],
      [1, `${RECORDED_HEADER}${kept('3', 'alice', String(recordedNow))}`],
      [2, RECORDED_HEADER],
      [2, `${RECORDED_HEADER}${kept('3', 'alice', String(recordedNow))}`],
    ];
    const ours: [number, string][] = [];
    for (const text of shapes) {
      fs.writeFileSync(sessionsFile(), text);
      resetCache();
      ours.push([await revokeUser('bob'), body()]);
    }
    expect(ours).toEqual(recorded);
    expect(ours.map(([ended]) => ended)).toEqual([1, 1, 1, 2, 2]);
  });
});

describe('a sessions lock earlier releases cannot open for writing', () => {
  // `flock(1)` opened `locks/sessions.lock` read-only, so it took a directory or a read-only
  // file and wrote the session; earlier releases open it for writing and fail first, and a
  // locks directory they may not create is `<home>/locks: Permission denied`, not Node's
  // `EACCES: ..., mkdir`.
  // The third column is what earlier releases raised for each, recorded.
  const locks = (home: string): string => path.join(home, 'locks');
  it.each([
    [
      'a directory',
      (home: string) => fs.mkdirSync(path.join(locks(home), 'sessions.lock')),
      (home: string) => `FileError: ${home}/locks/sessions.lock: Is a directory`,
    ],
    [
      'read-only',
      (home: string) => {
        fs.writeFileSync(path.join(locks(home), 'sessions.lock'), '');
        fs.chmodSync(path.join(locks(home), 'sessions.lock'), 0o444);
      },
      (home: string) => `FileError: ${home}/locks/sessions.lock: Permission denied`,
    ],
    [
      'in a home it may not write, with no locks directory',
      (home: string) => {
        fs.rmdirSync(locks(home));
        fs.chmodSync(home, 0o555);
      },
      (home: string) => `FileError: ${home}/locks: Permission denied`,
    ],
  ])(
    '%s raises what earlier releases raise',
    async (_label, shape, recorded) => {
      const before = process.env.HOUSTON_HOME;
      const home = fs.mkdtempSync(path.join(config.home(), 'shape-'));
      fs.mkdirSync(locks(home));
      process.env.HOUSTON_HOME = home;
      resetCache();
      try {
        shape(home);
        let ours = 'created';
        try {
          await create('alice');
        } catch (error) {
          ours = `${(error as Error).name}: ${(error as Error).message}`;
        }
        expect(ours).toBe(recorded(home));
      } finally {
        if (before === undefined) delete process.env.HOUSTON_HOME;
        else process.env.HOUSTON_HOME = before;
        fs.chmodSync(home, 0o700);
        fs.rmSync(home, { recursive: true, force: true });
        resetCache();
      }
    },
    30_000,
  );
});
