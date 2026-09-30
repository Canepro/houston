/**
 * `target` made with any missing parents, an existing directory accepted -- which is not
 * `fs.mkdirSync(target, { recursive: true, mode })`.
 *
 * `mode` applies to the LEAF only. It tries the leaf; on ENOENT it makes the parent the same
 * way with the default 0o777, so the umask alone decides every missing parent, and then
 * tries the leaf again. Node's recursive mkdir applies `mode` to every directory it
 * creates, so `HOUSTON_HOME=a/b/c/home` left `a`, `a/b` and `a/b/c` at 0700, where earlier
 * releases left them drwxrwxr-x under umask 002 and only `home` drwx------ -- on every
 * command's first run against such a home, since claiming it is the first write. A failure
 * names the component that could not be made, where Node names the whole path it was
 * handed.
 *
 * Rank 0 and importing nothing from `src/`, because `lib/lock.ts` (rank 1) is one of its
 * callers and nothing may reach sideways or up for it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The errors that mean "not a directory" rather than a failure to report. */
const NOT_THERE = new Set(['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP']);

/** Is `target` a directory: follows a link; false when it is not there, else the stat error. */
function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch (error) {
    if (NOT_THERE.has(String((error as NodeJS.ErrnoException).code))) return false;
    throw error;
  }
}

/** mkdir, an existing directory accepted; `parents` says whether a missing parent is made. */
function mkdir(target: string, mode: number, parents: boolean): void {
  try {
    fs.mkdirSync(target, { mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const parent = path.dirname(target);
      if (!parents || parent === target) throw error;
      mkdir(parent, 0o777, true);
      mkdir(target, mode, false);
      return;
    }
    // Not EEXIST alone: the kernel may answer EACCES or EROFS for a directory that exists.
    if (!isDir(target)) throw error;
  }
}

/** `target` made with any missing parents, `mode` on the leaf only, an existing one accepted. */
export function mkdirParents(target: string, mode = 0o777): void {
  mkdir(target, mode, true);
}
