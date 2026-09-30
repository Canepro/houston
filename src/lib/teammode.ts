/**
 * Whether this box has houston accounts, asked without importing the module that knows.
 *
 * `core/users` ranks above `core/kube/namespace`, and the namespace needs one bit from it:
 * a refusal has to say whether the reader could have identified themselves and did not,
 * or whether this box has no accounts at all and `HOUSTON_USER` alone would not have
 * helped. Those are different remedies, and naming the wrong one made a namespace
 * permanently un-adoptable -- the message said "HOUSTON_USER is not set" while it WAS,
 * and the remedy it named produced the identical refusal.
 *
 * So the registry is the dependency inversion, the same shape `events.ts` uses for
 * sinks: this module is owned by a lower layer and the upper one registers into it.
 *
 * THE DEFAULT IS "ASSUME ACCOUNTS EXIST", which is also the fallback when the user file
 * cannot be read. It is the safe side: it produces the refusal that
 * tells the reader to set `HOUSTON_USER`, rather than the one that tells them to create
 * an account they may already have.
 */
type TeamModeProbe = () => boolean;

let probe: TeamModeProbe | null = null;

/** Install the real probe. Returns a function that removes it again. */
export function installTeamModeProbe(fn: TeamModeProbe): () => void {
  probe = fn;
  return () => {
    if (probe === fn) probe = null;
  };
}

/** Whether this box has houston accounts, which is what makes names meaningful. */
export function teamMode(): boolean {
  if (probe === null) return true;
  try {
    return probe();
  } catch {
    // An unreadable user file: assume the safe case.
    return true;
  }
}
