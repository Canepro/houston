/**
 * The audit registry, and the two ways a record can be lost.
 *
 * It can be dropped because nothing is listening, or corrupted because a field carried a
 * separator. Both matter more here than almost anywhere: in a file whose only job is to
 * say who did what, a missing line and a forged line are the same kind of failure.
 */
import {
  FIELD_LIMIT,
  auditRecorderInstalled,
  field,
  installAuditRecorder,
  recordAudit,
} from '../../src/lib/audit';

/** Everything written to stderr while `body` ran. */
function capturing(body: () => void): string {
  const written: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    body();
  } finally {
    process.stderr.write = real;
  }
  return written.join('');
}

describe('with a recorder installed', () => {
  it('hands the record over and writes nothing itself', () => {
    const got: unknown[][] = [];
    const remove = installAuditRecorder((kind, label, options) => got.push([kind, label, options]));
    try {
      expect(auditRecorderInstalled()).toBe(true);
      const said = capturing(() => recordAudit('pat', 'TICKET-1 label=houston'));
      expect(got).toEqual([['pat', 'TICKET-1 label=houston', { outcome: 'ok' }]]);
      expect(said).toBe('');
    } finally {
      remove();
    }
    expect(auditRecorderInstalled()).toBe(false);
  });

  it('carries the outcome, because a FAILED action is the one worth seeing', () => {
    const got: unknown[][] = [];
    const remove = installAuditRecorder((kind, label, options) => got.push([kind, label, options]));
    try {
      recordAudit('signin', 'alice', { outcome: 'denied' });
      expect(got).toEqual([['signin', 'alice', { outcome: 'denied' }]]);
    } finally {
      remove();
    }
  });

  it('falls back rather than losing the record when the recorder throws', () => {
    // An unwritable log must never stop the work -- that is earlier releases' own rule -- but
    // it must not swallow the record either.
    const remove = installAuditRecorder(() => {
      throw new Error('disk full');
    });
    try {
      const said = capturing(() => recordAudit('pat', 'TICKET-1'));
      expect(said).toContain('houston.audit');
      expect(said).toContain('TICKET-1');
    } finally {
      remove();
    }
  });

  it('removes only its own recorder, so nested installs do not clobber each other', () => {
    const first: string[] = [];
    const second: string[] = [];
    const removeFirst = installAuditRecorder((kind) => first.push(kind));
    const removeSecond = installAuditRecorder((kind) => second.push(kind));
    // The first remover is now stale: it must not uninstall the second.
    removeFirst();
    try {
      recordAudit('pat');
      expect([first, second]).toEqual([[], ['pat']]);
    } finally {
      removeSecond();
    }
  });
});

describe('with none installed', () => {
  it('WRITES THE LINE to stderr rather than dropping it', () => {
    // A silently dropped audit line looks exactly like an action nobody took. stderr is
    // safe: stdout carries the `--json` envelope and nothing else, which is why `ui` goes
    // to stderr in that mode too.
    const said = capturing(() => recordAudit('pat', 'TICKET-1 label=houston bypass_2fa=true'));
    const [tag, stamp, kind, label, outcome] = said.trim().split('\t');
    expect(tag).toBe('houston.audit');
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
    expect(kind).toBe('pat');
    expect(label).toBe('TICKET-1 label=houston bypass_2fa=true');
    expect(outcome).toBe('ok');
  });

  it('writes a dash for an empty field, so the columns still line up', () => {
    const said = capturing(() => recordAudit('pat'));
    expect(said.trim().split('\t')).toEqual([
      'houston.audit',
      expect.stringMatching(/^\d{4}-/u),
      'pat',
      '-',
      'ok',
    ]);
  });
});

describe('a field that could break the record', () => {
  it('loses a tab, which would forge a column', () => {
    expect(field('alice\tadmin')).toBe('aliceadmin');
  });

  it('loses a newline, which would forge a whole line', () => {
    // The name on a FAILED sign-in is whatever the caller typed, and it reaches here
    // before any validation -- refusing to log an invalid name would blind the log to
    // exactly the traffic worth seeing.
    expect(field('alice\n2026-01-01\troot\tpat')).toBe('alice2026-01-01rootpat');
    expect(field('a\r\nb')).toBe('ab');
  });

  it('loses the rest of the control range and the exotic separators too', () => {
    // One property rather than a list somebody has to remember to extend: Unicode's
    // "Other" and "Separator" categories, minus the plain space. Written as escapes
    // deliberately -- as literal characters a formatter normalises them out of the file
    // and the case goes on passing while testing nothing.
    expect(field('a\u0000b\u001bc\u007fd')).toBe('abcd');
    expect(field('a\u2028b\u2029c\u0085d')).toBe('abcd');
    expect(field('a\u00a0b')).toBe('ab'); // no-break space is a separator
    expect(field('a\u200bb')).toBe('ab'); // zero-width space is a format character
  });

  it('keeps ordinary spaces, because every label written here has them', () => {
    expect(field('TICKET-1 label=houston bypass_2fa=true')).toBe(
      'TICKET-1 label=houston bypass_2fa=true',
    );
  });

  it('truncates rather than letting one field carry a log file', () => {
    expect(field('x'.repeat(500))).toHaveLength(FIELD_LIMIT);
    expect(FIELD_LIMIT).toBe(200);
  });

  it('answers empty for nothing at all', () => {
    expect(field('')).toBe('');
  });

  it('keeps 200 CODE POINTS, as earlier releases do, and never half a surrogate pair', () => {
    // `chown --to` with 120 emoji: the label is 131 code points and earlier releases keep
    // every one. Cut at 200 UTF-16 units it kept 94 of them and half of the 95th, which the
    // file got as U+FFFD.
    const label = `alpha - -> ${'\u{1f600}'.repeat(120)}`;
    expect(field(label)).toBe(label);
    expect([...field('\u{1f600}'.repeat(300))]).toHaveLength(FIELD_LIMIT);
    expect(field('\u{1f600}'.repeat(300))).not.toMatch(/[\ud800-\udfff]$/u);
  });

  it("filters printable characters as earlier releases do, from their Unicode, not Node's", () => {
    // U+1FAE9 is Unicode 16. Node's `\p{C}` knows it; the Unicode 15.0 earlier releases
    // ship calls it unassigned, and their field filter drops it.
    const values = [
      '\u{1fae9}bob',
      '\u{116d0} U+116D0 is 16.0 too',
      `alpha - -> ${'\u{1f600}'.repeat(120)}`,
      '\u{1f600}'.repeat(300),
      'a\tb\nc\u0000d\u007fe\u0085f\u00a0g\u200bh\u2028i\ufeffj k',
      'jos\u00e9 \u65e5\u672c \ud800 lone',
      '',
    ];
    // What earlier releases' field filter made of each value, whole and cut to 5.
    const recorded = [
      ['bob', 'bob'],
      [' U+116D0 is 16.0 too', ' U+11'],
      [`alpha - -> ${'\u{1f600}'.repeat(120)}`, 'alpha'],
      ['\u{1f600}'.repeat(200), '\u{1f600}'.repeat(5)],
      ['abcdefghij k', 'abcde'],
      ['jos\u00e9 \u65e5\u672c  lone', 'jos\u00e9 '],
      ['', ''],
    ];
    expect(values.map((v) => [field(v), field(v, 5)])).toEqual(recorded);
  });
});
