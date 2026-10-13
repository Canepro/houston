import { AuthorityGateError, ConflictError, NotReadyError } from '../../src/lib/errors';
import type { Event } from '../../src/lib/events';
import { warn } from '../../src/lib/events';
import {
  CONTRACT,
  EventWriter,
  PHASES,
  active,
  activate,
  dumps,
  envelope,
  errorEnvelope,
  jsonModeReset,
  now,
  onActivate,
  reply,
  setHoustonVersion,
  warnOnce,
  warningsSoFar,
} from '../../src/lib/jsonout';

beforeEach(() => {
  jsonModeReset();
  setHoustonVersion('0.61.0');
});

/** Capture everything written to stdout while `fn` runs. */
function captureStdout(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe('the envelope', () => {
  it('has exactly the eight documented keys', () => {
    expect(Object.keys(envelope('info', { a: 1 })).sort()).toEqual([
      'contract',
      'data',
      'error',
      'generated_at',
      'houston_version',
      'ok',
      'schema',
      'warnings',
    ]);
  });

  it('versions the payload and the wire separately', () => {
    // `contract` bumps only on a breaking change to the envelope; `schema` versions each
    // payload, so adding a field to one command does not churn every other command.
    expect(envelope('info').schema).toBe('houston.info.v1');
    expect(envelope('detail', null, { schemaVersion: 3 }).schema).toBe('houston.detail.v3');
    expect(envelope('info').contract).toBe(CONTRACT);
    expect(CONTRACT).toBe(2);
  });

  it('carries the data and the warnings it is given, and no error, on success', () => {
    const env = envelope('info', { a: 1 }, { warnings: [{ code: 'X', message: 'm' }] });
    expect(env.schema).toBe('houston.info.v1');
    expect(env.contract).toBe(CONTRACT);
    expect([env.ok, env.error]).toEqual([true, null]);
    expect(env.data).toEqual({ a: 1 });
    expect(env.warnings).toEqual([{ code: 'X', message: 'm' }]);
    expect(env.houston_version).toBeTruthy();
    expect(env.generated_at).toBeTruthy();
  });

  it('makes warnings a list, never null, so a caller can iterate without a check', () => {
    expect(envelope('info').warnings).toEqual([]);
  });

  it('renders generated_at the way earlier releases do, not the way toISOString does', () => {
    // A machine consumer reads this field. `toISOString()` gives `...T09:14:02.000Z`;
    // earlier releases give `...T09:14:02+00:00`.
    const stamp = now(new Date('2026-08-19T09:14:02.123Z'));
    expect(stamp).toBe('2026-08-19T09:14:02+00:00');
  });
});

describe('the error envelope', () => {
  it('reports the stable code from the taxonomy', () => {
    const env = errorEnvelope(new ConflictError('port taken'));
    expect(env.ok).toBe(false);
    expect(env.data).toBeNull();
    expect(env.error).toMatchObject({ code: 'CONFLICT', message: 'port taken' });
    expect(env.schema).toBe('houston.error.v1');
  });

  it('reports an unclassified failure as the base code rather than dressing it up', () => {
    // Saying "unclassified" is honest; picking a plausible code would tell a caller to
    // retry, or not to, on no evidence.
    const env = errorEnvelope(new Error('something odd'));
    expect(env.error?.code).toBe('REPRO_ERROR');
    expect(env.error?.message).toBe('something odd');
  });

  it('inlines a gate, which is the one thing a gate exists to communicate', () => {
    const env = errorEnvelope(
      new AuthorityGateError('nope', { kind: 'cluster', approveWith: 'run this' }),
    );
    expect(env.error?.gate).toEqual({ kind: 'cluster', subject: '', approve_with: 'run this' });
  });
});

describe('warnings', () => {
  it('keeps every distinct warning, and one entry for the same warning twice', () => {
    // By code alone, every plain warn event shares `WARNING`, so `up --json` kept only the
    // first: the RC 9 Premium-plan warning after an unknown-release one never reached it.
    warnOnce('WARNING', 'releases.rocket.chat has no 9.0.0');
    warnOnce('WARNING', 'Rocket.Chat 9.0 is set to require a Premium plan for LDAP login');
    warnOnce('WARNING', 'releases.rocket.chat has no 9.0.0');
    expect(warningsSoFar()).toEqual([
      { code: 'WARNING', message: 'releases.rocket.chat has no 9.0.0' },
      {
        code: 'WARNING',
        message: 'Rocket.Chat 9.0 is set to require a Premium plan for LDAP login',
      },
    ]);
  });

  it('are folded into reply() BY DEFAULT, so a call site cannot forget them', () => {
    // The field had been in the envelope since it was defined and nothing ever wrote to
    // it: `doctor --json` reported six warnings in `data` and `warnings: []`.
    warnOnce('VERSION_IGNORED', 'reusing the existing workspace');
    const lines = captureStdout(() => reply('up', { name: 'TICKET-1' }));
    const env = JSON.parse(lines.join('')) as { warnings: { code: string }[] };
    expect(env.warnings.map((w) => w.code)).toEqual(['VERSION_IGNORED']);
  });
});

describe('PHASES', () => {
  it('is closed, and an unknown phase normalises to info without losing the original', () => {
    const writer = new EventWriter();
    const wire = writer.event({ phase: 'teleport', message: 'x' });
    expect(wire.phase).toBe('info');
    expect(wire.detail).toEqual({ phase_raw: 'teleport' });
  });

  it('passes a known phase straight through', () => {
    const writer = new EventWriter();
    expect(writer.event({ phase: 'post_ready', message: 'x' }).phase).toBe('post_ready');
  });

  it('matches the vocabulary earlier releases publish exactly', () => {
    // The vocabulary is closed because it is DOCUMENTED and enforced. Two releases with
    // different closed vocabularies is worse than an open one.
    const recorded = [
      'preflight',
      'resolve',
      'provision',
      'plan',
      'pull',
      'create',
      'boot',
      'wait',
      'post_ready',
      'config',
      'tls',
      'seed',
      'backup',
      'restore',
      'upgrade',
      'monitor',
      'teardown',
      'ready',
      'done',
      'failed',
      'queued',
      'info',
    ];
    expect(PHASES).toEqual(recorded);
  });
});

describe('EventWriter', () => {
  it('keeps pct monotonic, clamping rather than dropping', () => {
    // A bar that goes backwards makes a caller think a new attempt started.
    const writer = new EventWriter();
    expect(writer.event({ pct: 40, message: 'a' }).pct).toBe(40);
    expect(writer.event({ pct: 10, message: 'b' }).pct).toBe(40);
    expect(writer.event({ pct: 55, message: 'c' }).pct).toBe(55);
  });

  it('leaves an absent pct absent', () => {
    expect(new EventWriter().event({ message: 'a' }).pct).toBeNull();
  });

  it('DROPS the terminal event, because the command emits the envelope itself', () => {
    // The contract promises exactly one envelope, last.
    const writer = new EventWriter();
    const lines = captureStdout(() => {
      writer.emit({ message: 'working', phase: 'boot' });
      writer.emit({ message: 'done', phase: 'done', terminal: true });
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ message: 'working', phase: 'boot' });
  });

  it('collects a warn-level event into the envelope"s warnings', () => {
    const writer = new EventWriter();
    captureStdout(() => writer.emit({ message: 'careful', level: 'warn', code: 'CAREFUL' }));
    expect(warningsSoFar()).toEqual([{ code: 'CAREFUL', message: 'careful' }]);
  });

  it('writes one object per line, so a caller needs no incremental parser', () => {
    const writer = new EventWriter();
    const lines = captureStdout(() => {
      writer.emit({ message: 'a', phase: 'pull' });
      writer.emit({ message: 'b', phase: 'boot' });
    });
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.trimEnd().includes('\n')).toBe(false);
    }
  });
});

describe('JSON rendering', () => {
  // Each value with the text earlier releases wrote for it, sorted keys, recorded.
  it.each([
    [{ b: 1, a: 2 }, '{"a": 2, "b": 1}'],
    [{ z: { y: 1, x: [1, 2, 3] }, a: null }, '{"a": null, "z": {"x": [1, 2, 3], "y": 1}}'],
    [
      { msg: 'a "quoted" \\ backslash\nnewline\ttab' },
      String.raw`{"msg": "a \"quoted\" \\ backslash\nnewline\ttab"}`,
    ],
    [
      { unicode: 'café — naïve — 日本語 — 🚀' },
      String.raw`{"unicode": "caf\u00e9 \u2014 na\u00efve \u2014 \u65e5\u672c\u8a9e \u2014 \ud83d\ude80"}`,
    ],
    [
      { nested: [{ b: true, a: false }, null, 1.5] },
      '{"nested": [{"a": false, "b": true}, null, 1.5]}',
    ],
    [{ empty: {}, list: [], zero: 0, neg: -1 }, '{"empty": {}, "list": [], "neg": -1, "zero": 0}'],
    // `floatString`, not `String(number)`: `5e-05` and `1e-07` there, `0.00005` and `1e-7` from
    // V8, since the envelope, the record and the event log share one writer.
    [
      { rate: 5e-5, tiny: 1e-7, small: 0.0001, mixed: [2.5e-10, 'caf\u00e9'] },
      String.raw`{"mixed": [2.5e-10, "caf\u00e9"], "rate": 5e-05, "small": 0.0001, "tiny": 1e-07}`,
    ],
  ])(
    'matches the text earlier releases write, sorted keys, byte for byte: %j',
    (value, recorded) => {
      // The `--json` envelope is a frozen surface that gets pasted into tickets and
      // diffed. JSON.stringify differs in three ways that all reach the wire: it does not
      // sort keys at any depth, writes no space after `:` or `,`, and emits non-ASCII
      // literally where earlier releases escape it.
      expect(dumps(value)).toBe(recorded);
    },
  );

  it('refuses a non-finite number rather than writing invalid JSON', () => {
    // In earlier releases' own words, now that the envelope shares the record's writer.
    expect(() => dumps({ x: Infinity })).toThrow(
      'Out of range float values are not JSON compliant: inf',
    );
  });
});

describe('JSON mode', () => {
  it('is off until a command turns it on', () => {
    expect(active()).toBe(false);
    activate();
    expect(active()).toBe(true);
  });

  it('tells the prose sink to move to stderr, through the registry', () => {
    // stdout carries JSON and nothing else. The hook runs this way round so this module
    // does not import the terminal layer for one line.
    const calls: boolean[] = [];
    onActivate((on) => calls.push(on));
    activate();
    jsonModeReset();
    expect(calls).toEqual([true, false]);
  });

  it('resets warnings too, so one test process does not leak into the next command', () => {
    warnOnce('X', 'y');
    jsonModeReset();
    expect(warningsSoFar()).toEqual([]);
  });
});

describe('the error taxonomy reaches the envelope intact', () => {
  it('carries the same code the CLI exit code and the web status come from', () => {
    const exc = new NotReadyError('rocket.chat is not serving yet');
    expect(errorEnvelope(exc).error?.code).toBe('NOT_READY');
    expect(exc.exitCode).toBe(5);
    expect(exc.httpStatus).toBe(409);
  });
});

describe('one service warning, read by the machine front end', () => {
  it('reaches the envelope with its code, its prose and its data as detail', () => {
    const seen: Event[] = [];
    warn((ev) => seen.push(ev), 'requested version ignored', {
      phase: 'create',
      code: 'VERSION_IGNORED',
      data: { requested: '9', running: '8' },
    });
    const warning = seen[0] as Event;
    expect(warning.code).toBe('VERSION_IGNORED');
    captureStdout(() => new EventWriter().emit(warning));
    expect(warningsSoFar()).toEqual([
      {
        code: 'VERSION_IGNORED',
        message: 'requested version ignored',
        detail: { requested: '9', running: '8' },
      },
    ]);
  });
});
