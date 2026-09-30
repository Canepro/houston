/**
 * Capture MongoDB slow queries during a load test.
 *
 * Turns on Mongo's query profiler (level 1: log ops slower than `slowms`) for the duration of
 * the run, then reads `system.profile` back: the slowest queries, and whether they COLLSCAN
 * -- "slow because there is no index on X" is the single most useful line of evidence a perf
 * ticket can carry.
 *
 * Everything runs through `docker compose exec` on the repro's mongodb container (mongosh,
 * falling back to the legacy `mongo` shell for old pairings), is version-tolerant, and is
 * strictly best-effort: any failure degrades to "slow-query capture unavailable" without
 * affecting the test.
 */
import { databaseOf } from '../core/database-of';
import { registerRepair, MONGO_PROFILER_ON, type Entry } from '../core/journal';
import { composeExecCapture } from '../core/runner/engine';

/**
 * The DEFAULT database, kept only as the fallback when the workspace's own `MONGO_URL`
 * cannot be read.
 *
 * `env --set MONGO_URL=...` is a supported and documented override, and hardcoding this
 * meant the bulk insert (or the profiler) addressed a database Rocket.Chat was not reading
 * -- reporting `inserted: 50000` while the directory stayed empty, and `--clear-scale`
 * then reporting it had removed them, so the round trip was internally consistent and
 * externally wrong.
 */
export const DB = 'rocketchat';

/**
 * The database this workspace's Rocket.Chat actually uses.
 *
 * The shared lookup lives in `core/database-of.ts`, below both this module and backup, so
 * there is no upward edge to defer and one implementation rather than two. The fallback to
 * `DB` is kept: a lookup must never fail the run.
 */
export async function dbOf(name: string): Promise<string> {
  return (await databaseOf(name)) || DB;
}

async function uriFor(name: string): Promise<string> {
  return `mongodb://localhost:27017/${await dbOf(name)}`;
}

/**
 * Run JS in the repro's mongodb container; mongosh first, the legacy `mongo` shell as the
 * fallback. Returns stdout, or null if neither shell worked.
 */
async function evalJs(name: string, js: string): Promise<string | null> {
  const uri = await uriFor(name);
  for (const shell of ['mongosh', 'mongo']) {
    const [rc, out] = await composeExecCapture(name, 'mongodb', [
      shell,
      '--quiet',
      uri,
      '--eval',
      js,
    ]);
    if (rc === 0 && out.trim()) return out;
  }
  return null;
}

/** The last stdout line that parses as JSON (shells may print banners first). */
export function lastJson(out: string): unknown {
  const lines = out.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] as string).trim();
    if (line.startsWith('{') || line.startsWith('[')) {
      try {
        return JSON.parse(line);
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Coerce a value parsed out of a shell's stdout.
 *
 * `null`, a missing key, or a shell that serialised a NumberLong as an object must not
 * throw here -- this runs inside the callers' `finally`.
 */
export function asInt(value: unknown, fallback: number): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  if (!/^[+-]?\d+$/u.test(text)) return fallback;
  return Number.parseInt(text, 10);
}

export interface Prior {
  was?: unknown;
  slowms?: unknown;
  prior_unknown?: boolean;
}

/**
 * Enable profiling (level 1, > slowms) on the workspace's database.
 *
 * Returns the state `stop` needs, or null if nothing was changed. NOTE THE ORDERING:
 * `setProfilingLevel` has ALREADY taken effect by the time the output is read, so an
 * unparseable prior state still returns a marker (assuming the default level 0). Returning
 * null there would leave the profiler running for the life of the repro, writing an entry
 * for every slow op.
 */
export async function start(name: string, slowms = 100): Promise<Prior | null> {
  const js =
    'var prev = db.getProfilingStatus();' +
    // A numeric argument works in old shells too.
    `db.setProfilingLevel(1, ${String(Math.trunc(slowms))});` +
    'print(JSON.stringify({was: prev.was, slowms: prev.slowms}));';
  const out = await evalJs(name, js);
  // No usable shell -> the enable never ran, so there is nothing to undo.
  if (out === null) return null;
  const prior = lastJson(out);
  if (typeof prior === 'object' && prior !== null && 'was' in prior) return prior as Prior;
  return { was: 0, slowms: 100, prior_unknown: true };
}

/** Restore the prior profiling level (best-effort). */
export async function stop(name: string, prior: Prior | null | undefined): Promise<void> {
  if (prior === null || prior === undefined || Object.keys(prior).length === 0) return;
  const js =
    `db.setProfilingLevel(${String(asInt(prior.was, 0))}, ` +
    `${String(asInt(prior.slowms, 100))});`;
  await evalJs(name, js);
}

export interface SlowOp {
  ns: string;
  op: string;
  millis: number;
  plan: string;
  docs: number;
  keys: number;
  ret: number;
  cmd: string;
}

export interface SlowReport {
  total: number;
  collscan: number;
  slow: SlowOp[];
}

/** Slow ops profiled since `sinceEpochMs`. */
export async function collect(
  name: string,
  sinceEpochMs: number,
  limit = 5,
): Promise<SlowReport | null> {
  const database = await dbOf(name);
  const js =
    `var q = {ts: {$gte: new Date(${String(Math.trunc(sinceEpochMs))})},` +
    ` ns: {$ne: "${database}.system.profile"}};` +
    'var docs = db.system.profile.find(q).sort({millis: -1}).limit(200).toArray();' +
    'var out = {total: docs.length, collscan: 0, slow: []};' +
    'for (var i = 0; i < docs.length; i++) {' +
    '  var d = docs[i];' +
    "  var plan = d.planSummary || '';" +
    "  if (plan.indexOf('COLLSCAN') >= 0) out.collscan++;" +
    ` if (out.slow.length < ${String(Math.trunc(limit))}) {` +
    "    var cmd = '';" +
    '    try { cmd = JSON.stringify(d.command || d.query || {}).slice(0, 160); } catch (e) {}' +
    "    out.slow.push({ns: d.ns || '', op: d.op || '', millis: d.millis || 0," +
    '      plan: plan, docs: d.docsExamined || 0, keys: d.keysExamined || 0,' +
    '      ret: d.nreturned || 0, cmd: cmd});' +
    '  }' +
    '}' +
    'print(JSON.stringify(out));';
  const out = await evalJs(name, js);
  const parsed = out === null ? null : lastJson(out);
  return typeof parsed === 'object' && parsed !== null && 'slow' in parsed
    ? (parsed as SlowReport)
    : null;
}

/** Restore the profiler a killed run left armed. */
async function repairProfiler(entry: Entry): Promise<boolean> {
  const prior = entry.detail.prior;
  if (prior === null || prior === undefined) return false;
  await stop(entry.workspace, prior as Prior);
  return true;
}

export function installJournalRepairs(): void {
  registerRepair(MONGO_PROFILER_ON, repairProfiler);
}
