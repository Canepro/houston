/**
 * The Mongo database a workspace's Rocket.Chat actually uses.
 *
 * HOISTED from `core/backup.ts`, where it used to live, because three modules need
 * the same answer and only one of them may depend on backup:
 *
 *   * `backup` dumps it,
 *   * `perf/mongoprof` profiles it,
 *   * `scaleseed` bulk-inserts into it.
 *
 * The two lower modules used to reach backup through a guarded function-body import that
 * fell back to the default database on any failure, a DEFERRED upward edge. A
 * JavaScript call-time `require` could reproduce that shape exactly, but a guarded upward
 * edge is not something the TypeScript rank gate can express: its order is a total one, so
 * `scaleseed` (rank 53) reaching `backup` (above `lifecycle`) is an upward import however
 * it is spelled. The layering rule already names the resolution -- "anything two siblings
 * both need moves DOWN into their package's layer-0 module" -- so the FUNCTION moved down
 * and every caller imports the same implementation instead of two of them.
 *
 * `extra --set MONGO_URL=...` is supported and documented, and hardcoding the name meant
 * the bulk insert (or the profiler) addressed a database Rocket.Chat was not reading --
 * reporting `inserted: 50000` while the directory stayed empty. This module exists for
 * exactly that reason.
 */
import { stripText, isTruthy } from '../lib/format';

import { readCompose } from './runner/record';

/** The value when it is a mapping, else `{}` -- the check against disk. */
function bagOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Rocket.Chat's database, used when MONGO_URL cannot be read. */
export const DEFAULT_DATABASE = 'rocketchat';

/**
 * The database this workspace's Rocket.Chat uses.
 *
 * Read from MONGO_URL rather than hardcoded. An unreadable compose file -- no record, a
 * half-written workspace -- answers the default rather than raising: every caller has a
 * job to do against a database name, and a lookup is not worth failing that job over.
 */
export async function databaseOf(name: string): Promise<string> {
  let doc: Record<string, unknown>;
  try {
    doc = await readCompose(name);
  } catch {
    return DEFAULT_DATABASE;
  }
  const svcs = bagOf(doc.services);
  // `rocketchat` by a truth test, else `rocketchat-1`: an EMPTY map is falsy, so
  // `rocketchat: {}` falls through to the multi-instance service. `??` answered the
  // default database for that document where the established answer reads the override;
  // measured against the previous implementation.
  const primary = svcs.rocketchat;
  const rc = bagOf(isTruthy(primary) ? primary : svcs['rocketchat-1']);
  const raw = rc.environment;
  const env = Array.isArray(raw)
    ? Object.fromEntries(
        raw.map((item) => {
          const text = String(item);
          const at = text.indexOf('=');
          return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
        }),
      )
    : bagOf(raw);
  const url = String(env.MONGO_URL ?? '');
  // mongodb://host:port/<db>?opts  -- take the path segment, drop the query.
  // Everything after the FIRST scheme separator, or the whole string when there is none.
  // `split('://').at(-1)` took the text after the LAST one, so `mongodb://a://b` answered
  // the default where the established answer reads the `/b` path segment.
  const schemeAt = url.indexOf('://');
  const tail = schemeAt >= 0 ? url.slice(schemeAt + 3) : url;
  const slash = tail.indexOf('/');
  const rest = slash >= 0 ? tail.slice(slash + 1) : '';
  // The path up to its first `?`, through `stripText`, which strips the C0 information
  // separators too, so `String.trim()` is not the same function.
  const db = stripText(rest.split('?')[0] ?? '');
  return db !== '' ? db : DEFAULT_DATABASE;
}
