/**
 * The temporary directory, and a fresh directory made inside it, on POSIX -- which is not
 * `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`.
 *
 * `os.tmpdir()` is `$TMPDIR` as given, so a stale or deleted TMPDIR made every staging
 * directory an ENOENT stack: `backup` crashed with "mkdtemp '/nonexistent-houston-tmp/...'",
 * and `restore --new` did so after creating its workspace, leaving it behind empty with none
 * of the note a refused load adds. `tempRoot` does not trust the variable: it
 * walks `$TMPDIR`, `$TEMP`, `$TMP`, `/tmp`, `/var/tmp`, `/usr/tmp` and the working directory,
 * takes the first in which it can create, write and remove a file, and keeps that answer for
 * the rest of the process. `makeTempDir` then makes `<dir>/<prefix><8 of [a-z0-9_]>` at 0700,
 * trying another name when one is taken.
 *
 * Rank 2: it names its failures through `format`'s `fileErrorOf`, and takes `osPathAbspath`
 * from `home`.
 */
import { randomInt } from 'node:crypto';
import * as fs from 'node:fs';

import { osPathAbspath } from './home';
import { fileErrorOf } from './format';

/** The characters a random name is drawn from. */
const CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789_';

/** `TMP_MAX` on Linux: how many names `makeTempDir` tries before it gives up. */
const TMP_MAX = 238328;

/** The probe's open flags: read-write, created exclusively, and never through a link. */
const PROBE_FLAGS =
  fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

/** A random name: eight characters, each chosen uniformly. */
function randomName(): string {
  let name = '';
  for (let index = 0; index < 8; index += 1) name += CHARACTERS[randomInt(CHARACTERS.length)];
  return name;
}

/** `dir` and `leaf` joined by one `/`, for a `dir` that `osPathAbspath` already normalised. */
function joinLeaf(dir: string, leaf: string): string {
  return dir.endsWith('/') ? `${dir}${leaf}` : `${dir}/${leaf}`;
}

/**
 * The directories to try: the three variables that are set and not empty, in that order,
 * then the three fixed directories, then the working directory -- or `.` when it is gone.
 */
export function candidateTempdirList(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirlist: string[] = [];
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) {
    const value = env[name];
    if (value !== undefined && value !== '') dirlist.push(value);
  }
  dirlist.push('/tmp', '/var/tmp', '/usr/tmp');
  try {
    dirlist.push(process.cwd());
  } catch {
    dirlist.push('.');
  }
  return dirlist;
}

/**
 * The first directory of `dirlist`, made absolute, in which a file can be created, written
 * and removed. A name that exists already is retried (a hundred names per directory); any
 * other failure moves on to the next directory. None usable is a `FileError`, which
 * the CLI reports as an unhandled error.
 */
export function defaultTempdir(dirlist: readonly string[] = candidateTempdirList()): string {
  for (const candidate of dirlist) {
    const dir = candidate === '.' ? candidate : osPathAbspath(candidate);
    for (let seq = 0; seq < 100; seq += 1) {
      const filename = joinLeaf(dir, randomName());
      try {
        const fd = fs.openSync(filename, PROBE_FLAGS, 0o600);
        try {
          try {
            fs.writeSync(fd, 'blat');
          } finally {
            fs.closeSync(fd);
          }
        } finally {
          fs.unlinkSync(filename);
        }
        return dir;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        break;
      }
    }
  }
  const refused = new Error(`no usable temporary directory found in ${dirlist.join(', ')}`);
  refused.name = 'FileError';
  throw refused;
}

/** The temporary directory, once `tempRoot` has computed it: one answer for the process. */
let tempdir: string | null = null;

/** The temporary directory: computed on first use, then the same directory every time. */
export function tempRoot(): string {
  tempdir ??= defaultTempdir();
  return tempdir;
}

/**
 * A new directory `<tempdir>/<prefix><8 random characters>` at 0700, and its absolute path;
 * `tmp` is the default prefix.
 */
export function makeTempDir(prefix = 'tmp'): string {
  const dir = tempRoot();
  for (let seq = 0; seq < TMP_MAX; seq += 1) {
    const file = joinLeaf(dir, `${prefix}${randomName()}`);
    try {
      fs.mkdirSync(file, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw fileErrorOf(error, file);
    }
    return osPathAbspath(file);
  }
  const exhausted = new Error(`no unused temporary directory name found in ${dir}`);
  exhausted.name = 'FileError';
  throw exhausted;
}
