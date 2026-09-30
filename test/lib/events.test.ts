import type { Event, Emit } from '../../src/lib/events';
import {
  asDict,
  event,
  info,
  installSink,
  installedSinks,
  nullEmit,
  warn,
} from '../../src/lib/events';

/** Release every sink a test installed, so one file's leases cannot leak into another. */
const releases: (() => void)[] = [];
afterEach(() => {
  while (releases.length > 0) (releases.pop() as () => void)();
  expect(installedSinks()).toEqual([]);
});

function lease(key: string, fn: Emit): () => void {
  const release = installSink(key, fn);
  releases.push(release);
  return release;
}

describe('the Event shape', () => {
  it('defaults exactly as earlier releases do', () => {
    expect(event('pulling')).toEqual({
      message: 'pulling',
      phase: 'info',
      level: 'info',
      pct: null,
      data: {},
      terminal: false,
      code: '',
    });
  });

  it('renders the same keys as earlier releases render', () => {
    const ev = event('done', { phase: 'done', terminal: true, pct: 100 });
    expect(Object.keys(asDict(ev)).sort()).toEqual(
      ['code', 'data', 'level', 'message', 'pct', 'phase', 'terminal'].sort(),
    );
  });
});

describe('emitting', () => {
  it('hands the event to the caller"s own emitter', () => {
    const seen: Event[] = [];
    info((ev) => seen.push(ev), 'booting', { phase: 'boot', pct: 10 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ message: 'booting', phase: 'boot', pct: 10, level: 'info' });
  });

  it('gives a warning a stable code beside its prose', () => {
    // `code` is the half a caller may branch on; the message is for humans and may be
    // reworded freely.
    const seen: Event[] = [];
    warn((ev) => seen.push(ev), 'version ignored', { code: 'REUSED_WORKSPACE' });
    expect(seen[0]).toMatchObject({ level: 'warn', code: 'REUSED_WORKSPACE' });
  });

  it('defaults a warning"s code rather than leaving it empty', () => {
    const seen: Event[] = [];
    warn((ev) => seen.push(ev), 'something');
    expect(seen[0]?.code).toBe('WARNING');
  });

  it('discards through nullEmit without throwing', () => {
    expect(() => info(nullEmit, 'nobody is listening')).not.toThrow();
  });
});

describe('the sink registry', () => {
  it('delivers every event to an installed sink as well as to the caller', () => {
    const sunk: Event[] = [];
    const direct: Event[] = [];
    lease('eventlog', (ev) => sunk.push(ev));
    info((ev) => direct.push(ev), 'seeding', { phase: 'seed' });
    expect(sunk).toHaveLength(1);
    expect(direct).toHaveLength(1);
    expect(sunk[0]).toBe(direct[0]);
  });

  it('refuses an empty key', () => {
    expect(() => installSink('', nullEmit)).toThrow('cannot be empty');
  });

  it('refuses to silently replace a key with a different function', () => {
    // Otherwise one app starting could redirect another app's live event stream, and
    // the first app's shutdown could then remove the replacement.
    lease('eventlog', nullEmit);
    expect(() => installSink('eventlog', () => undefined)).toThrow('already installed');
  });

  it('counts OWNERSHIP, not invocation: two leases, one delivery each', () => {
    const sunk: Event[] = [];
    const sink: Emit = (ev) => sunk.push(ev);
    const releaseA = lease('eventlog', sink);
    lease('eventlog', sink);

    info(nullEmit, 'one');
    expect(sunk).toHaveLength(1);

    // The first app shuts down; the second still holds a lease, so the sink stays.
    releaseA();
    info(nullEmit, 'two');
    expect(sunk).toHaveLength(2);
    expect(installedSinks()).toEqual(['eventlog']);
  });

  it('has an idempotent release', () => {
    const release = installSink('eventlog', nullEmit);
    release();
    release();
    expect(installedSinks()).toEqual([]);
  });

  it('isolates a broken sink so it cannot break the operation it describes', () => {
    const reached: string[] = [];
    lease('broken', () => {
      throw new Error('disk full');
    });
    lease('working', () => reached.push('working'));

    expect(() => info(nullEmit, 'carry on')).not.toThrow();
    // ...and a later sink still runs, which is the second half of the claim.
    expect(reached).toEqual(['working']);
  });

  it('dispatches to a SNAPSHOT, so a sink may uninstall while handling an event', () => {
    const reached: string[] = [];
    const release = installSink('self-removing', () => {
      reached.push('self-removing');
      release();
    });
    lease('other', () => reached.push('other'));

    expect(() => info(nullEmit, 'go')).not.toThrow();
    expect(reached).toEqual(['self-removing', 'other']);
    expect(installedSinks()).toEqual(['other']);
  });
});

describe('the event and lease cases earlier releases’ spec names', () => {
  it('carries phase, pct and data, and renders message and terminal in its dict', () => {
    const seen: Event[] = [];
    info((ev) => seen.push(ev), 'hello', { phase: 'boot', pct: 50, data: { name: 'x' } });
    warn((ev) => seen.push(ev), 'careful', { phase: 'wait' });
    expect([seen[0]?.phase, seen[0]?.pct, seen[0]?.data]).toEqual(['boot', 50, { name: 'x' }]);
    expect(seen[1]?.level).toBe('warn');
    const d = asDict(seen[0] as Event);
    expect([d.message, d.terminal]).toEqual(['hello', false]);
  });

  it('keeps a shared sink until its LAST lease goes, and a double release is harmless', () => {
    // Two live front ends share one sink without duplicating or removing each other.
    const seen: string[] = [];
    const sink: Emit = (ev) => seen.push(ev.message);
    const releaseOne = lease('test-leases', sink);
    const releaseTwo = lease('test-leases', sink);
    expect(() => installSink('test-leases', () => undefined)).toThrow('already installed');
    info(nullEmit, 'both leases');
    expect(seen).toEqual(['both leases']);
    releaseOne();
    releaseOne();
    info(nullEmit, 'second owner remains');
    expect(seen).toEqual(['both leases', 'second owner remains']);
    releaseTwo();
    info(nullEmit, 'nobody owns it');
    expect(seen).toEqual(['both leases', 'second owner remains']);
  });
});
