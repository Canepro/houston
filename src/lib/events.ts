/**
 * Progress event model shared by every long-running service function.
 *
 * A single stream type unifies the two progress channels: `log=` callbacks (seed,
 * config-import) and streamed subprocess output (docker, k6). A service function takes
 * `emit: Emit` and calls it with `Event`s; the CLI prints them, the web layer buffers them
 * per job and pushes them over SSE.
 *
 * **Progress is an Event, not a print.** A service function that writes to stdout
 * instead of emitting is invisible in the GUI -- that is the whole cost of this module
 * and the reason ~125 call sites go through it.
 *
 * NO LOCK GUARDS THE SINK REGISTRY. A server that ran service calls on worker threads
 * would need one; Node has one JavaScript thread per process, so a lock would guard
 * nothing: no other execution can interleave between reading `SINKS` and writing it. The
 * SNAPSHOT before dispatch is kept and is not cosmetic -- a sink may install or uninstall
 * while handling an event, and iterating the live map while it mutates is a real hazard in
 * any language.
 */

/**
 * THE PHASE VOCABULARY, AS A TYPE.
 *
 * `jsonout.PHASES` publishes this list as part of the `--json` contract, and re-exports
 * it from here rather than keeping a second copy: two lists of the same names is how a
 * phase gets emitted that the contract never published.
 *
 * A guard that runs a regex for `phase="..."` over the source can only see the phases
 * spelled as a literal at the emit site and reports nothing about one built from a
 * variable. Here the vocabulary is the TYPE of
 * `Event.phase`, so an unpublished phase is a compile error at the call site and there
 * is no spelling for it that the check cannot see.
 *
 * A phase name arriving from OUTSIDE this process -- a replayed event log, an event
 * from an earlier release -- is still a plain string and still normalises to "info" with
 * the original kept in `detail.phase_raw`; `jsonout.EventWriter.event` owns that and
 * deliberately takes a `string`.
 */
export const PHASES = Object.freeze([
  'preflight', // engine, versions, disk, ports, connectivity checks
  'resolve', // version / image / chart resolution
  'provision', // create or verify the execution target itself
  'plan', // work out what will be done, before doing any of it
  'pull', // fetching images
  'create', // building the workspace's own definition
  'boot', // starting components
  'wait', // waiting for readiness or health
  'post_ready', // settings applied after Rocket.Chat serves
  'config', // changing a running workspace's configuration
  'tls', // certificates and the shared edge
  'seed', // seeding users, channels, messages
  'backup', // dumping data out
  'restore', // loading data back in
  'upgrade', // moving a workspace between Rocket.Chat versions
  'monitor', // attaching or detaching Prometheus + Grafana
  'teardown', // stopping and removing
  'ready', // the workspace is serving
  'done', // finished successfully
  'failed', // terminal failure; carries detail.code
  'queued', // accepted, waiting for a slot rather than working yet
  'info', // uncategorised progress; never branch on it
] as const);

/** One of the published phases. Anything else does not compile at the emit site. */
export type Phase = (typeof PHASES)[number];

/**
 * PHASES THIS BUILD EMITS AND THE CONTRACT DOES NOT PUBLISH.
 *
 * Exactly one, and it is a DEFECT that is bounded here rather than hidden: `core/loadtest.ts`
 * emits `phase: 'k6'` at eight sites, as earlier releases' load test does, and `k6` is
 * not in `PHASES`. On the wire it normalises to `info` with `detail.phase_raw = "k6"`,
 * exactly as it always has, so nothing a caller sees is wrong -- but a caller watching
 * for k6 progress never fires, which is precisely what the published vocabulary exists to
 * prevent.
 *
 * A SOURCE-SCANNING GUARD CANNOT SEE IT. Earlier releases' regex is `phase="([a-z_]+)"`,
 * and `k6` has a digit in it, so their four emit sites match nothing and the guard has
 * reported a clean vocabulary for as long as they have existed. Measured: that pattern
 * finds nothing in `phase="k6"`.
 *
 * Adding `k6` to `PHASES` is the real fix and is NOT made here: `PHASES` is published by
 * `capabilities`, whose baseline is a frozen fixture, and changing what a command emits
 * would make its output differ from what earlier releases emitted. So it is named here
 * instead, where the compiler enforces that the list of exceptions is CLOSED -- a second
 * unpublished phase does not compile until somebody writes it down -- and
 * `invariants/phase-vocabulary.test.ts` pins both that this is the only member and that it
 * really does normalise to `info` with `phase_raw` on the wire.
 */
export const UNPUBLISHED_PHASES = Object.freeze(['k6'] as const);

/** A phase an emit site may name: published, or a written-down exception. */
export type EmittedPhase = Phase | (typeof UNPUBLISHED_PHASES)[number];

export interface Event {
  message: string;
  /** One of `PHASES`, or a written-down `UNPUBLISHED_PHASES` exception. Closed. */
  phase: EmittedPhase;
  /** info|warn|error */
  level: string;
  /** 0-100 when known, null when not. */
  pct: number | null;
  data: Record<string, unknown>;
  /** Last event of a job; `data` carries the Result. */
  terminal: boolean;
  /** Stable warning code; prose remains for humans. */
  code: string;
}

/**
 * An emitter is any callable taking one Event. Kept as a plain function type (not a
 * class) so a test can pass `events.push.bind(events)` and the CLI can pass a small
 * adapter.
 */
export type Emit = (event: Event) => void;

/** Build an Event with the established defaults. */
export function event(message: string, fields: Partial<Omit<Event, 'message'>> = {}): Event {
  return {
    message,
    phase: fields.phase ?? 'info',
    level: fields.level ?? 'info',
    pct: fields.pct ?? null,
    data: fields.data ?? {},
    terminal: fields.terminal ?? false,
    code: fields.code ?? '',
  };
}

/** The wire object for one Event, matching `Event.as_dict()`. */
export function asDict(ev: Event): Record<string, unknown> {
  return {
    message: ev.message,
    phase: ev.phase,
    level: ev.level,
    pct: ev.pct,
    data: ev.data,
    terminal: ev.terminal,
    code: ev.code,
  };
}

/**
 * Sinks are keyed because two independently created front ends may want the same
 * durable destination. The count is OWNERSHIP, not invocation multiplicity: two live
 * apps lease the event log once each, while each Event still reaches it exactly once.
 */
const SINKS = new Map<string, { fn: Emit; leases: number }>();

/**
 * Lease one keyed sink and return an idempotent release callback.
 *
 * Reinstalling the exact same function adds an ownership lease. Reusing a key for a
 * DIFFERENT function is an error rather than a silent replacement: otherwise one app
 * starting could redirect another app's live event stream, and the first app's shutdown
 * could then remove the replacement.
 */
export function installSink(key: string, fn: Emit): () => void {
  if (!key) throw new Error('an event sink key cannot be empty');
  const current = SINKS.get(key);
  if (current !== undefined && current.fn !== fn) {
    throw new Error(`event sink ${JSON.stringify(key)} is already installed`);
  }
  SINKS.set(key, { fn, leases: current === undefined ? 1 : current.leases + 1 });

  let released = false;
  return function unregister(): void {
    if (released) return;
    released = true;
    const held = SINKS.get(key);
    if (held === undefined || held.fn !== fn) return;
    if (held.leases === 1) SINKS.delete(key);
    else SINKS.set(key, { fn, leases: held.leases - 1 });
  };
}

/** How many sinks are installed. For tests and for `status`-style reporting. */
export function installedSinks(): string[] {
  return [...SINKS.keys()].sort();
}

/** Discard events (the default for callers that do not care about progress). */
export function nullEmit(_event: Event): void {
  /* deliberately empty */
}

/**
 * Deliver the event to a snapshot of the currently installed sinks.
 *
 * HERE, because this module is the single funnel every long-running function goes
 * through -- so a sink covers every emit site without one of them being touched. The
 * registry is the dependency inversion: this rank-1 module imports no sink.
 *
 * Each sink is isolated. Logging must never break the operation it describes, nor
 * prevent a later sink from running.
 */
function tee(ev: Event): void {
  const sinks = [...SINKS.values()].map((held) => held.fn);
  for (const sink of sinks) {
    try {
      sink(ev);
    } catch {
      // one broken sink must not block anything
    }
  }
}

export function info(
  emit: Emit,
  message: string,
  options: { phase?: EmittedPhase; pct?: number | null; data?: Record<string, unknown> } = {},
): void {
  const ev = event(message, {
    phase: options.phase ?? 'info',
    pct: options.pct ?? null,
    data: options.data ?? {},
  });
  tee(ev);
  emit(ev);
}

export function warn(
  emit: Emit,
  message: string,
  options: { phase?: EmittedPhase; code?: string; data?: Record<string, unknown> } = {},
): void {
  const ev = event(message, {
    phase: options.phase ?? 'info',
    level: 'warn',
    data: options.data ?? {},
    code: options.code ?? 'WARNING',
  });
  tee(ev);
  emit(ev);
}
