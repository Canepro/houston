import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { auditRecorderInstalled, recordAudit } from '../../src/lib/audit';
import * as config from '../../src/lib/config';
import { runWithContext } from '../../src/lib/context';

import {
  AUDIT_FILE,
  KEEP,
  MAX_BYTES,
  ORIGINS,
  audit,
  auditPath,
  parseLine,
  read,
  record,
} from '../../src/core/audit';

/** Write bytes an earlier release wrote where it keeps the log: `<home>/audit.log`. */
function writeRecorded(bytes: string): void {
  fs.mkdirSync(config.home(), { recursive: true });
  fs.writeFileSync(path.join(config.home(), 'audit.log'), bytes, { encoding: 'utf8', mode: 0o600 });
}

function lines(): string[] {
  return fs
    .readFileSync(auditPath(), 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

beforeEach(() => {
  // The numbered copies too, or the rotation tests leak into each other: `audit.log.1`
  // survives a test that only removed `audit.log`, and the next test sees a rotation
  // that did not happen.
  fs.rmSync(auditPath(), { force: true });
  for (let n = 1; n <= KEEP; n += 1) fs.rmSync(`${auditPath()}.${n}`, { force: true });
});

describe('the stored line', () => {
  it('is six tab-separated fields in the order earlier releases write them', () => {
    audit('alice', 'repro-down', 'TICKET-1234', { origin: 'session', outcome: 'ok' });
    const [line] = lines();
    const parts = (line as string).split('\t');
    expect(parts).toHaveLength(6);
    expect(parts.slice(1)).toEqual(['alice', 'repro-down', 'TICKET-1234', 'session', 'ok']);
  });

  it('stamps the timestamp the way earlier releases spell it, not the way toISOString does', () => {
    // Earlier releases write seconds precision with an explicit +00:00 offset.
    // `toISOString()` is milliseconds and a Z. Both are ISO 8601; they are not the same
    // bytes, and this file is compared byte for byte.
    audit('alice', 'kind', 'label');
    const ts = (lines()[0] as string).split('\t')[0] as string;
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/u);
  });

  it('writes "-" for an empty actor, kind or label, and defaults the outcome to ok', () => {
    audit('', '', '');
    expect((lines()[0] as string).split('\t').slice(1)).toEqual(['-', '-', '-', '-', 'ok']);
  });

  it('cannot be made to forge a column or a whole line', () => {
    // The name on a FAILED sign-in is whatever the caller typed and reaches here before
    // any validation, because refusing to log an invalid name would blind the log to
    // exactly the traffic worth seeing. A tab forges a column; a newline forges a line.
    audit('al\tice\nroot\tsudo\tall', 'signin', 'x', { origin: 'attempt', outcome: 'denied' });
    expect(lines()).toHaveLength(1);
    expect((lines()[0] as string).split('\t')).toHaveLength(6);
    expect((lines()[0] as string).split('\t')[1]).toBe('alicerootsudoall');
  });

  it('creates the file 0600, at creation rather than by a later chmod', () => {
    audit('alice', 'kind', 'label');
    expect(fs.statSync(auditPath()).mode & 0o777).toBe(0o600);
  });

  it('is best-effort: an unwritable home does not stop the work', () => {
    const blocked = path.join(config.home(), 'blocked');
    fs.mkdirSync(blocked, { recursive: true });
    fs.writeFileSync(path.join(blocked, AUDIT_FILE), 'not a directory');
    const previous = process.env.HOUSTON_HOME;
    process.env.HOUSTON_HOME = path.join(blocked, AUDIT_FILE);
    try {
      expect(() => audit('alice', 'kind', 'label')).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.HOUSTON_HOME;
      else process.env.HOUSTON_HOME = previous;
    }
  });
});

describe('the actor and the origin', () => {
  it('come from the execution context rather than from fifteen signatures', () => {
    runWithContext({ actor: 'bob', origin: 'session' }, () => {
      record('repro-up', 'TICKET-9');
    });
    expect((lines()[0] as string).split('\t').slice(1)).toEqual([
      'bob',
      'repro-up',
      'TICKET-9',
      'session',
      'ok',
    ]);
  });

  it('write "-" for an origin outside the closed list, as earlier releases ignore it', () => {
    // A value missing from ORIGINS does not raise; it writes "-" and looks like a legacy
    // line. `setup` was omitted at first and did exactly that on every new install.
    runWithContext({ actor: 'bob', origin: 'invented' }, () => record('kind'));
    expect((lines()[0] as string).split('\t')[4]).toBe('-');
    expect(ORIGINS).toContain('setup');
  });

  it('accepts every origin earlier releases declare, then sso, and no others', () => {
    // The origins earlier releases declared, in their order, recorded; `sso` is the Okta
    // sign-in's, which they never wrote.
    const recorded = 'session,local,asserted,setup,system,attempt';
    expect([...ORIGINS]).toEqual([...recorded.split(','), 'sso']);
  });
});

describe('parse_line', () => {
  it('preserves job acceptance and final outcomes in the existing six-field format', () => {
    for (const outcome of ['accepted', 'done', 'error', 'stopped']) {
      audit('alice', 'seed', 'ticket', { origin: 'session', outcome });
      const stored = lines().at(-1) as string;
      expect(stored.split('\t')).toHaveLength(6);
      expect(parseLine(stored)).toMatchObject({
        actor: 'alice',
        kind: 'seed',
        label: 'ticket',
        origin: 'session',
        outcome,
      });
    }
    expect(read().lines.map((row) => row.outcome)).toEqual([
      'stopped',
      'error',
      'done',
      'accepted',
    ]);
    expect(parseLine('ts\talice\tseed\tticket')?.outcome).toBe('ok');
    expect(parseLine('ts\talice\tseed\tticket\t-\tunrecognised')?.outcome).toBe('ok');
  });

  it('reads a four-field line written before origin and outcome existed', () => {
    expect(parseLine('2026-01-01T00:00:00+00:00\talice\tkind\tlabel')).toEqual({
      ts: '2026-01-01T00:00:00+00:00',
      actor: 'alice',
      kind: 'kind',
      label: 'label',
      origin: '',
      outcome: 'ok',
    });
  });

  it('refuses a line with fewer than four fields, and an empty one', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('\n')).toBeNull();
    expect(parseLine('a\tb\tc')).toBeNull();
  });

  it('normalises an outcome it does not recognise to ok, and "-" origin to empty', () => {
    const rec = parseLine('ts\ta\tk\tl\t-\tinvented');
    expect(rec?.origin).toBe('');
    expect(rec?.outcome).toBe('ok');
    expect(parseLine('ts\ta\tk\tl\tsession\tdenied')?.outcome).toBe('denied');
  });

  it('agrees with the parser of earlier releases on every one of those shapes', () => {
    const shapes = [
      '2026-01-01T00:00:00+00:00\talice\tkind\tlabel',
      '2026-01-01T00:00:00+00:00\talice\tkind\tlabel\tsession\tdenied',
      'ts\ta\tk\tl\t-\tinvented',
      'a\tb\tc',
      '',
    ];
    // What earlier releases parsed each shape into, recorded.
    const recorded = [
      {
        ts: '2026-01-01T00:00:00+00:00',
        actor: 'alice',
        kind: 'kind',
        label: 'label',
        origin: '',
        outcome: 'ok',
      },
      {
        ts: '2026-01-01T00:00:00+00:00',
        actor: 'alice',
        kind: 'kind',
        label: 'label',
        origin: 'session',
        outcome: 'denied',
      },
      { ts: 'ts', actor: 'a', kind: 'k', label: 'l', origin: '', outcome: 'ok' },
      null,
      null,
    ];
    expect(shapes.map(parseLine)).toEqual(recorded);
  });
});

describe('reading back', () => {
  it('returns the most recent matching lines, newest first', () => {
    for (let i = 0; i < 5; i += 1) audit('alice', 'repro-up', `TICKET-${i}`, { origin: 'local' });
    const page = read({ limit: 3 });
    expect(page.lines.map((r) => r.label)).toEqual(['TICKET-4', 'TICKET-3', 'TICKET-2']);
    expect(page.path).toBe(auditPath());
  });

  it('filters by actor, kind, substring and floor timestamp', () => {
    audit('alice', 'repro-up', 'alpha', { origin: 'local' });
    audit('bob', 'repro-down', 'beta', { origin: 'local' });
    expect(read({ actorName: 'bob' }).lines.map((r) => r.label)).toEqual(['beta']);
    expect(read({ kind: 'repro-up' }).lines.map((r) => r.label)).toEqual(['alpha']);
    expect(read({ q: 'BET' }).lines.map((r) => r.label)).toEqual(['beta']);
    expect(read({ since: '2999-01-01' }).lines).toEqual([]);
  });

  it('refuses a --since that is not a date, rather than matching nothing', () => {
    // Compared as text against each line's timestamp, `--since notadate` filtered out
    // every line and answered "nothing matched", exit 0.
    audit('alice', 'repro-up', 'alpha', { origin: 'local' });
    expect(() => read({ since: 'notadate' })).toThrow('--since wants an ISO date');
  });

  it('is an empty page for a log that does not exist, not an error', () => {
    expect(read()).toEqual({ lines: [], truncated: false, path: auditPath() });
  });

  it('reads BACKWARDS across a chunk boundary without losing or splitting a line', () => {
    // The reader walks the file from the end in 64 KB chunks, carrying the partial first
    // line of each chunk into the next read. An off-by-one there silently drops one line
    // per chunk, which on a busy log is invisible until somebody counts.
    const total = 4000;
    for (let i = 0; i < total; i += 1) {
      audit('alice', 'repro-up', `TICKET-${String(i).padStart(6, '0')}`, { origin: 'local' });
    }
    expect(fs.statSync(auditPath()).size).toBeGreaterThan(64 * 1024);
    const page = read({ limit: total });
    expect(page.lines).toHaveLength(total);
    expect(page.lines[0]?.label).toBe('TICKET-003999');
    expect(page.lines[total - 1]?.label).toBe('TICKET-000000');
    expect(new Set(page.lines.map((r) => r.label)).size).toBe(total);
  });

  it('says so when it stopped early rather than pretending it saw the whole file', () => {
    // `truncated` is "there is still file behind me", and the scan is per 64 KB CHUNK --
    // so a small file is never truncated however low the limit, because one chunk
    // reached the start. Asserted against earlier releases rather than against an
    // intuition: the obvious expectation (limit 5 of 50 lines is truncated) is wrong on
    // both sides, and a test that encoded it would have been "fixed" by departing from
    // what earlier releases do.
    for (let i = 0; i < 50; i += 1) audit('alice', 'repro-up', `T-${i}`, { origin: 'local' });
    expect(read({ limit: 5, maxBytes: 200 }).truncated).toBe(false);
    expect(read({ limit: 500 }).truncated).toBe(false);

    for (let i = 0; i < 4000; i += 1) {
      audit('alice', 'repro-up', `TICKET-${String(i).padStart(6, '0')}`, { origin: 'local' });
    }
    expect(read({ limit: 5 }).truncated).toBe(true);
    expect(read({ limit: 99999 }).truncated).toBe(false);
    expect(read({ limit: 99999, maxBytes: 200 }).truncated).toBe(true);

    // What earlier releases answered for the same three reads of the same log, recorded.
    const recorded = [true, false, true];
    expect([
      read({ limit: 5 }).truncated,
      read({ limit: 99999 }).truncated,
      read({ limit: 99999, maxBytes: 200 }).truncated,
    ]).toEqual(recorded);
  });

  it('reads a character the 64 KiB read window cuts in two whole, as earlier releases do', () => {
    // Split into lines as BYTES and then decoded a line at a time, so a character
    // whose first byte is in one read and the rest in the next is rejoined. An earlier version
    // decoded each block and re-encoded its partial first line, which baked two U+FFFD in
    // for `é` and three for `😀`, and `q="josé"` then found nothing.
    const boundaryLog = (character: string, label: string): void => {
      const line = (at: number, kind: string, text: string): string =>
        `2026-09-${String(1 + (at % 28)).padStart(2, '0')}T00:00:00+00:00\talice\t${kind}\t` +
        `${text}\tlocal\tok\n`;
      const head = Array.from({ length: 20 }, (_, at) => line(at, 'seed', `ws${String(at)}`));
      const cut = Buffer.from(character, 'utf8').length - 1;
      const straddling = line(28, 'chown', `${label}${character}`);
      // Everything after the character's FIRST byte is exactly one read: 65536 bytes.
      const after = Buffer.byteLength(
        straddling.slice(straddling.indexOf(character) + character.length),
      );
      let rest = '';
      let at = 0;
      while (65536 - cut - after - Buffer.byteLength(rest) > 200)
        rest += line((at += 1), 'start', `alice-ticket-${String(at).padStart(4, '0')}`);
      const short = 65536 - cut - after - Buffer.byteLength(rest) - line(0, 'stop', '').length;
      rest += line(0, 'stop', 'x'.repeat(short));
      fs.mkdirSync(config.home(), { recursive: true });
      fs.writeFileSync(auditPath(), [...head, straddling, rest].join(''));
      const size = fs.statSync(auditPath()).size;
      const bytes = fs.readFileSync(auditPath());
      // The window's first byte is a continuation byte of the character: the case at issue.
      expect((bytes[size - 65536] as number) & 0xc0).toBe(0x80);
      expect(bytes.subarray(size - 65536 - 1, size - 65536 + cut).toString('utf8')).toBe(character);
    };
    // What earlier releases read back from each log: the whole of it, as a count and a
    // sha256 of its canonical JSON (keys sorted), and the one line a search finds.
    const canonical = (records: object[]): string =>
      JSON.stringify(
        records.map((one) =>
          Object.fromEntries(Object.entries(one).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        ),
      );
    const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
    const record = (text: string, kind = 'chown') => ({
      ts: '2026-09-01T00:00:00+00:00',
      actor: 'alice',
      kind,
      label: text,
      origin: 'local',
      outcome: 'ok',
    });
    const recorded: Record<string, { count: number; sha256: string }> = {
      é: {
        count: 1027,
        sha256: '11fc0f8b67d492c9d0a752207f656f0930ef63ac29738aebae9ea280f9646ad3',
      },
      '😀': {
        count: 1027,
        sha256: '057f46c4b4a6297bc655e0bd97beb7561e81430a0e291ce8cd30d7288351d242',
      },
    };
    for (const [character, label] of [
      ['é', 'ws194 - -> jos'],
      ['😀', 'ws195 - -> rocket '],
    ] as const) {
      boundaryLog(character, label);
      const all = read({ limit: 2000 }).lines;
      expect([character, all.length]).toEqual([character, recorded[character]?.count]);
      expect([character, sha256(canonical(all))]).toEqual([character, recorded[character]?.sha256]);
      // Spot checks: the line the window cut, the oldest line and the newest.
      expect(all[1006]).toEqual(record(`${label}${character}`));
      expect(all.at(-1)).toEqual(record('ws0', 'seed'));
      expect(all[0]?.kind).toBe('stop');
      expect([character, read({ q: `${label}${character}` }).lines]).toEqual([
        character,
        [record(`${label}${character}`)],
      ]);
      expect(read({ q: `${label}${character}` }).lines.map((r) => r.label)).toEqual([
        `${label}${character}`,
      ]);
    }
  });
});

describe('rotation', () => {
  it('keeps the log bounded and shifts the numbered copies along', () => {
    fs.mkdirSync(config.home(), { recursive: true });
    fs.writeFileSync(auditPath(), 'x'.repeat(MAX_BYTES + 1));
    fs.writeFileSync(`${auditPath()}.1`, 'first');
    audit('alice', 'kind', 'label');

    expect(fs.readFileSync(`${auditPath()}.2`, 'utf8')).toBe('first');
    expect(fs.statSync(`${auditPath()}.1`).size).toBe(MAX_BYTES + 1);
    expect(lines()).toHaveLength(1);
  });

  it('numbers the copies the way earlier releases do, so they find them', () => {
    // Earlier releases name the first copy `audit.log.1`, not `audit.1.log`.
    const recorded = 'audit.log.1';
    expect(recorded).toBe(`${AUDIT_FILE}.1`);
    expect(KEEP).toBe(5);
  });

  it('does not rotate a log under the cap', () => {
    audit('alice', 'kind', 'label');
    audit('alice', 'kind', 'label');
    expect(fs.existsSync(`${auditPath()}.1`)).toBe(false);
    expect(lines()).toHaveLength(2);
  });
});

describe('compatibility with the log earlier releases wrote', () => {
  it('reads every line an earlier release wrote, with identical values', () => {
    // What an earlier release wrote for two audits, recorded byte for byte.
    writeRecorded(
      '2026-09-29T09:01:38+00:00\talice\trepro-down\tTICKET-1234\tsession\tdenied\n' +
        '2026-09-29T09:01:38+00:00\tbob\tseed\tTICKET-9\tlocal\tok\n',
    );

    const page = read();
    expect(page.lines.map((r) => [r.actor, r.kind, r.label, r.origin, r.outcome])).toEqual([
      ['bob', 'seed', 'TICKET-9', 'local', 'ok'],
      ['alice', 'repro-down', 'TICKET-1234', 'session', 'denied'],
    ]);
  });

  it('writes lines an earlier release reads back with identical values', () => {
    audit('carol', 'pat', 'label=houston bypass_2fa=true', { origin: 'asserted' });
    audit('dave', 'signin', '10.0.0.1', { origin: 'attempt', outcome: 'denied' });

    // The bytes an earlier release wrote for the same two audits, recorded: this build's
    // are the same but for the time each was written.
    const recorded =
      'T\tcarol\tpat\tlabel=houston bypass_2fa=true\tasserted\tok\n' +
      'T\tdave\tsignin\t10.0.0.1\tattempt\tdenied\n';
    const mine = fs.readFileSync(path.join(config.home(), 'audit.log'), 'utf8');
    expect(mine.replace(/^[^\t\n]+\t/gmu, 'T\t')).toBe(recorded);
    // And what an earlier release read back from its own bytes, recorded.
    expect(read({ limit: 10 }).lines).toEqual([
      {
        ts: expect.any(String),
        actor: 'dave',
        kind: 'signin',
        label: '10.0.0.1',
        origin: 'attempt',
        outcome: 'denied',
      },
      {
        ts: expect.any(String),
        actor: 'carol',
        kind: 'pat',
        label: 'label=houston bypass_2fa=true',
        origin: 'asserted',
        outcome: 'ok',
      },
    ]);
  });

  it('appends to a log an earlier release wrote without rewriting what is already there', () => {
    writeRecorded('2026-09-29T09:01:38+00:00\talice\tfirst\tx\tlocal\tok\n');
    const before = fs.readFileSync(auditPath(), 'utf8');
    audit('bob', 'second', 'y', { origin: 'local' });
    const after = fs.readFileSync(auditPath(), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length).split('\t')[2]).toBe('second');
  });
});

describe('the registry', () => {
  it('is installed by importing this module, so nothing has to remember to arm it', () => {
    expect(auditRecorderInstalled()).toBe(true);
  });

  it('routes lib/audit.recordAudit to the file rather than to stderr', () => {
    runWithContext({ actor: 'erin', origin: 'session' }, () => {
      recordAudit('pat', 'label=houston', { outcome: 'ok' });
    });
    expect((lines()[0] as string).split('\t').slice(1)).toEqual([
      'erin',
      'pat',
      'label=houston',
      'session',
      'ok',
    ]);
  });
});
