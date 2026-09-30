/**
 * Durable notes for side effects a killed process must not leave, asked for from a layer
 * that must not import the module that stores them.
 *
 * `core/journal` ranks above `core/eks`, and `core/eks` needs it, for the most
 * expensive note in the product: `eksctl create cluster` is twenty minutes of building a
 * VPC, a NAT gateway and a control plane, and the note goes down BEFORE the call and is
 * cleared only once eksctl has returned. A note written afterwards describes nothing --
 * the whole case it exists for is the process not getting there.
 *
 * The registry is the same dependency inversion `events.ts` uses for sinks, `teammode.ts`
 * for its probe and `audit.ts` for its recorder: this module is owned by a lower layer,
 * and the upper one registers into it.
 *
 * ## The default writes to stderr, for a sharper version of audit's reason
 *
 * The journal is best-effort -- a journal that cannot be written must not stop the
 * operation it was describing, and a record returns '' for an unwritable directory. So
 * throwing here would invent a behaviour. But a dropped CLUSTER_UNFINISHED note is not a
 * missing log line: it is the only record that something billable may exist, written
 * precisely for the case where the process does not survive to say so itself. Silence
 * there is the failure the note exists to prevent.
 *
 * So the fallback WRITES THE NOTE, to stderr, with its kind, its subject and its detail.
 * Nothing is lost, and the gap is loud the first time somebody builds a cluster before
 * the real journal is registered.
 *
 * ## Subject predicates are queued, not dropped
 *
 * `registerSubjectPredicate` runs at import time (`core/eks.ts`), which can be before
 * `core/journal` has installed a sink here. A registration made against no sink is
 * REMEMBERED and replayed when one arrives, because the alternative -- losing it -- makes
 * recovery unable to ask whether a note's subject still exists, which is what turns a
 * stale note into a permanent false alarm.
 */

/** A cluster create that was started and never seen to return. */
export const CLUSTER_UNFINISHED = 'cluster_unfinished';

/** Whether the thing a note is about still exists. Recovery asks before reporting. */
export type SubjectPredicate = (entry: JournalEntry) => boolean | Promise<boolean>;

/** The fields `core/eks` reads back off a note. `core/journal`'s entry is wider. */
export interface JournalEntry {
  readonly kind: string;
  /** The subject: a workspace name, or -- for CLUSTER_UNFINISHED -- a cluster name. */
  readonly workspace: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface JournalSink {
  /** Note a side effect that must be undone. Returns the entry id, or '' if unwritable. */
  record(kind: string, workspace: string, detail: Record<string, unknown>): string;
  /** Forget an entry, because whatever it described has been undone. */
  clear(entryId: string): void;
  registerSubjectPredicate(kind: string, predicate: SubjectPredicate): void;
}

let sink: JournalSink | null = null;

/** Registrations made before a sink existed, replayed when one arrives. */
const pending: [string, SubjectPredicate][] = [];

/** Install the real journal. Returns a function that removes it again. */
export function installJournalSink(fn: JournalSink): () => void {
  sink = fn;
  for (const [kind, predicate] of pending) fn.registerSubjectPredicate(kind, predicate);
  pending.length = 0;
  return () => {
    if (sink === fn) sink = null;
  };
}

export function journalSinkInstalled(): boolean {
  return sink !== null;
}

/**
 * Teach recovery how to ask whether one kind of note's subject still exists.
 *
 * Queued when no sink is installed, because this runs at module scope and losing it would
 * leave recovery unable to tell a live note from a stale one.
 */
export function registerSubjectPredicate(kind: string, predicate: SubjectPredicate): void {
  if (sink === null) {
    pending.push([kind, predicate]);
    return;
  }
  sink.registerSubjectPredicate(kind, predicate);
}

/** For a test that wants a clean slate; the queue is module state like any other. */
export function clearPendingPredicates(): void {
  pending.length = 0;
}

function shout(kind: string, workspace: string, detail: Record<string, unknown>): void {
  let rendered: string;
  try {
    rendered = JSON.stringify(detail);
  } catch {
    rendered = '{}';
  }
  process.stderr.write(`houston.journal\t${kind}\t${workspace || '-'}\t${rendered}\n`);
}

/**
 * Note a side effect. Returns the entry id, or '' when there is nothing holding it.
 *
 * Best-effort by contract: a sink that throws must not stop the operation it was
 * describing, exactly as an unwritable journal directory does not.
 */
export function recordJournal(
  kind: string,
  workspace: string,
  detail: Record<string, unknown> = {},
): string {
  if (sink !== null) {
    try {
      return sink.record(kind, workspace, detail);
    } catch {
      // Fall through and say it out loud rather than losing the note entirely.
    }
  }
  shout(kind, workspace, detail);
  return '';
}

/** Forget an entry. An empty id is a note that was never written, and is a no-op. */
export function clearJournal(entryId: string): void {
  if (entryId === '') return;
  if (sink === null) return;
  try {
    sink.clear(entryId);
  } catch {
    // Clearing a note that cannot be cleared leaves a stale one, which recovery reports
    // and a person resolves. Raising here would fail an operation that has succeeded.
  }
}
