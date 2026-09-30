/**
 * The user's home directory, as the state directory has always been found from it -- which
 * is not what `os.homedir()` returns.
 *
 * `HOME` is taken when it is in the environment and the password database asked only when
 * it is not; Node's `os.homedir()` is exactly that choice, verbatim. The home then has
 * every trailing `/` stripped from whichever value it got, and a value that strips to
 * nothing becomes `/`. So with `HOME` set but EMPTY the state directory is `/.houston`,
 * and every site that joined `os.homedir()` resolved `.houston` in the working directory
 * instead -- a different directory for each place the command happened to be run from,
 * none of which an earlier release would ever look in. Measured, `HOUSTON_HOME` unset:
 *
 *     HOME unset       config.home() -> <password-database home>/.houston
 *     HOME=''          config.home() -> /.houston        (os.homedir() is '')
 *     HOME='/'         config.home() -> /.houston
 *     HOME='//'        config.home() -> /.houston        (os.homedir() is '//')
 *     HOME='/tmp/x/'   config.home() -> /tmp/x/.houston  (os.homedir() is '/tmp/x/')
 *     HOME='/tmp/x//'  config.home() -> /tmp/x/.houston
 *
 * The strip applies to the password-database value too, since it comes after the choice,
 * and `os.homedir()` does not strip: measured against a bind-mounted passwd in a user
 * namespace, an entry of `/fake/home//` is `/fake/home//` to Node and `/fake/home` to
 * `pathHome`, and an empty entry is `''` to Node and `/` to `pathHome`.
 *
 * WHAT IS LEFT TO THE CALLER, deliberately: the join. `joinPath` keeps a leading `//`
 * and every `..`, where `path.join` collapses both, so `HOME='//tmp/x'` resolves
 * `//tmp/x/.houston` through the one and `/tmp/x/.houston` through the other -- the same
 * directory on Linux, and a spelling difference that belongs to each site's path
 * arithmetic, not to which directory is home. And a uid with no password-database entry
 * and no `HOME` fails: `os.homedir()` throws a `SystemError`, where earlier releases raised
 * their own could-not-determine-home error.
 *
 * `os.homedir()` rather than `process.env.HOME`, although they agree in production:
 * under Jest `process.env` is the test file's own copy and `os.homedir()` is native, so
 * the suite moves HOME by mocking `node:os` -- and a helper that read the copy would make
 * every one of those mocks answer the developer's real home.
 *
 * A rank-0 module that imports nothing from `src/`, because `config.ts` is one of its
 * twelve callers and `lib/lock.ts` (rank 1), which joins the marker onto a home, another,
 * and nothing may reach up or sideways for it. The rule is this module's alone.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';

/** The home: `os.homedir()` with trailing `/` stripped, or `/` if that leaves nothing. */
export function pathHome(): string {
  const raw = os.homedir();
  let end = raw.length;
  while (end > 0 && raw[end - 1] === '/') end -= 1;
  return end === 0 ? '/' : raw.slice(0, end);
}

/**
 * The segments joined component by component, which is not `path.join`.
 *
 * The segments are joined as `posixJoin` joins them, the result is parsed once, and two
 * things `path.join`'s normalisation removes are kept: every `..` (a lexical parent is not a
 * resolved one -- `nonexistent/../x` needs `nonexistent` to exist before the kernel walks
 * back out of it, so the two spellings can name different files) and a root of exactly two
 * slashes, whose meaning POSIX leaves to the system. It drops what `path.join` drops too:
 * empty and `.` parts, a trailing `/`, and a root of three or more slashes, which is one. An
 * absolute segment discards what came before it, as `joinPath('a', '/b')` is `/b`, and
 * nothing at all is `.`. Measured; `home.test.ts` holds the table.
 *
 * The home itself is `pathHome`'s; this is the join the paragraph above leaves to the caller.
 */
export function joinPath(...segments: string[]): string {
  const joined = posixJoin('', ...segments);
  let root = '';
  let rest = joined;
  if (joined.startsWith('/')) {
    root = joined[1] === '/' && joined[2] !== '/' ? '//' : '/';
    rest = joined.slice(root.length);
  }
  const parts = rest.split('/').filter((part) => part !== '' && part !== '.');
  return root + parts.join('/') || '.';
}

/**
 * `name`'s home in the password database, or null for a name the database does not hold.
 *
 * `/etc/passwd` first, the first line with that name, as the `files` source answers; then
 * the current user through `os.userInfo()`, which asks the whole name service. Node has no
 * `getpwnam`, and nothing here may start a process for `getent`, so ANOTHER user known only
 * to a network source (LDAP, sssd) is not found here, where `getpwnam` would find it.
 */
function passwordHome(name: string): string | null {
  let table = '';
  try {
    table = fs.readFileSync('/etc/passwd', 'utf8');
  } catch (error) {
    if (!isOsError(error)) throw error;
  }
  for (const line of table.split('\n')) {
    const fields = line.split(':');
    if (fields.length >= 7 && fields[0] === name) return fields[5] ?? '';
  }
  try {
    const self = os.userInfo();
    if (self.username === name) return self.homedir;
  } catch (error) {
    if (!isOsError(error)) throw error;
  }
  return null;
}

/**
 * `target` with a leading `~` or `~name` expanded, which is not "replace a leading `~` with
 * the home".
 *
 * The path is spelled first -- a trailing `/`, `.` parts and doubled slashes gone, `..`
 * kept -- and only a FIRST PART that starts with `~` is expanded: `~` is `pathHome()`, and
 * `~name` is that user's password-database home, both with trailing slashes stripped (or `/`
 * if nothing is left) and then parsed, so a HOME holding `..` or a two-slash root keeps it.
 * A `~name` nobody has, or a home that itself starts with `~`, is
 * `Could not determine home directory.`, thrown as a `HomeUnknown` so the CLI's last line
 * keeps that wording.
 *
 * The ports this replaces joined `pathHome()` onto the text after the `~` with `path.join`:
 * `~bob/x` was the CURRENT user's `bob/x`, `~/x/` kept its slash, and a HOME of `/a/../b`
 * became `/b`.
 */
export function pathExpandUser(target: string): string {
  const spelled = joinPath(target);
  if (!spelled.startsWith('~')) return spelled;
  const cut = spelled.indexOf('/');
  const first = cut < 0 ? spelled : spelled.slice(0, cut);
  const rest = cut < 0 ? '' : spelled.slice(cut + 1);
  let home: string | null = first === '~' ? pathHome() : passwordHome(first.slice(1));
  if (home !== null && first !== '~') home = home.replace(/\/+$/u, '') || '/';
  if (home === null || home.startsWith('~')) {
    const refused = new Error('Could not determine home directory.');
    refused.name = 'HomeUnknown';
    throw refused;
  }
  return joinPath(home, rest);
}

/** A plain POSIX join: no normalisation at all, and an absolute segment restarts the path. */
function posixJoin(first: string, ...rest: string[]): string {
  let joined = first;
  for (const segment of rest) {
    if (segment.startsWith('/')) joined = segment;
    else if (joined === '' || joined.endsWith('/')) joined += segment;
    else joined += `/${segment}`;
  }
  return joined;
}

/** Head and tail, the head's trailing slashes dropped unless it is all slashes. */
function posixSplit(target: string): [string, string] {
  const at = target.lastIndexOf('/') + 1;
  let head = target.slice(0, at);
  if (head !== '' && !/^\/+$/u.test(head)) head = head.replace(/\/+$/u, '');
  return [head, target.slice(at)];
}

/**
 * Lexical normalisation, which is not `path.normalize`: a root of exactly two slashes is
 * kept, and a trailing `/` is not.
 */
function posixNormpath(target: string): string {
  if (target === '') return '.';
  const slashes = !target.startsWith('/')
    ? ''
    : target.startsWith('//') && !target.startsWith('///')
      ? '//'
      : '/';
  const parts: string[] = [];
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (
      part !== '..' ||
      (slashes === '' && parts.length === 0) ||
      (parts.length > 0 && parts[parts.length - 1] === '..')
    ) {
      parts.push(part);
    } else if (parts.length > 0) {
      parts.pop();
    }
  }
  return slashes + parts.join('/') || '.';
}

/**
 * The absolute path: joined onto the working directory when relative, then `posixNormpath`
 * -- so a `..` is folded lexically and a root of exactly two slashes is kept, where
 * `path.resolve` makes that root one slash.
 */
export function osPathAbspath(target: string): string {
  return posixNormpath(target.startsWith('/') ? target : posixJoin(process.cwd(), target));
}

/** Whether `error` is a failed system call, which carries a numeric errno. */
function isOsError(error: unknown): error is NodeJS.ErrnoException {
  return typeof (error as NodeJS.ErrnoException | null)?.errno === 'number';
}

/**
 * The non-strict realpath walk: each component is looked up as it is reached, so a symlink
 * is followed BEFORE a `..` after it walks back out -- the kernel's order, which
 * `path.resolve` (and `fs.realpathSync`, which calls it first) do not keep. A failed
 * system call on the lookup means "not a link"; a loop returns what it has, unfinished.
 */
function joinRealpath(
  start: string,
  remaining: string,
  seen: Map<string, string | null>,
): [string, boolean] {
  let current = start;
  let rest = remaining;
  if (rest.startsWith('/')) {
    rest = rest.slice(1);
    current = '/';
  }
  while (rest !== '') {
    const cut = rest.indexOf('/');
    let name = cut < 0 ? rest : rest.slice(0, cut);
    rest = cut < 0 ? '' : rest.slice(cut + 1);
    if (name === '' || name === '.') continue;
    if (name === '..') {
      if (current !== '') {
        [current, name] = posixSplit(current);
        if (name === '..') current = posixJoin(current, '..', '..');
      } else {
        current = '..';
      }
      continue;
    }
    const next = posixJoin(current, name);
    let isLink = false;
    try {
      isLink = fs.lstatSync(next).isSymbolicLink();
    } catch (error) {
      if (!isOsError(error)) throw error;
    }
    if (!isLink) {
      current = next;
      continue;
    }
    if (seen.has(next)) {
      const cached = seen.get(next) ?? null;
      if (cached !== null) {
        current = cached;
        continue;
      }
      return [posixJoin(next, rest), false];
    }
    seen.set(next, null);
    const [resolved, ok] = joinRealpath(current, fs.readlinkSync(next), seen);
    if (!ok) return [posixJoin(resolved, rest), false];
    current = resolved;
    seen.set(next, current);
  }
  return [current, true];
}

/**
 * `target` resolved: the realpath of `joinPath`'s spelling of the path, then the `stat`
 * that turns a symlink loop into a `Symlink loop from '...'` error.
 *
 * NOT `path.resolve` and not `fs.realpathSync`: both fold every `..` against the text before
 * it first, so `link/../hh` with `link -> other/sub` resolved to `hh` in the working directory
 * where the kernel walks through the link to `other/hh`. A path that does not exist resolves
 * as far as it can and keeps the rest.
 */
export function pathResolve(target: string): string {
  const spelled = joinPath(target);
  const [found] = joinRealpath('', spelled, new Map());
  const resolved = joinPath(
    posixNormpath(found.startsWith('/') ? found : posixJoin(process.cwd(), found)),
  );
  try {
    fs.statSync(resolved);
  } catch (error) {
    if (isOsError(error) && error.code === 'ELOOP') {
      throw new Error(`Symlink loop from '${resolved}'`, { cause: error });
    }
  }
  return resolved;
}
