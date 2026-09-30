/**
 * Wire journal recovery handlers from the modules that own each side effect.
 *
 * A service-layer module for two reasons:
 *
 *   * it installs repairs from `backup`, `seed/repairs`, `perf/mongoprof`, `loadtest` and
 *     `eks`, so it cannot compile without every one of them;
 *   * nothing in `src/core/` imports it -- only the front doors do -- and moving it into a
 *     front door would put a service-layer registry there, which is the one place
 *     the layering rule says such a thing must not live.
 *
 * `install()` is idempotent, and `recover()` installs before delegating to the
 * dependency-free core, so a caller cannot forget the extensions the way a caller of
 * `journal.recover()` alone could.
 */
import { type Emit, nullEmit } from '../lib/events';
import * as mongoprof from '../perf/mongoprof';
import * as seedRepairs from '../seed/repairs';

import * as backup from './backup';
import * as servicePerf from './loadtest';
import * as journal from './journal';

/**
 * `eks` registers its CLUSTER_UNFINISHED subject predicate at MODULE LOAD here. Importing
 * it is the install; the side effect is named in the eks module's own registration site.
 */
import './eks';

export { type Entry, type RecoverOptions, type RecoverRow } from './journal';

/** Install every recovery extension idempotently before journal recovery. */
export function install(): void {
  backup.installJournalRepairs();
  seedRepairs.installJournalRepairs();
  servicePerf.installJournalRepairs();
  mongoprof.installJournalRepairs();
}

/** Install extensions, then run recovery through its dependency-free core. */
export async function recover(
  emit: Emit = nullEmit,
  options: journal.RecoverOptions = {},
): Promise<journal.RecoverRow[]> {
  install();
  return await journal.recover(emit, options);
}
