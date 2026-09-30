/**
 * glibc's `getlogin()`: the name of the user who LOGGED IN, whatever the process has become
 * since -- under `sudo -u other`, still the person at the keyboard; in a container or under
 * cron, where nothing logged in, no answer at all.
 *
 * Node has no `getlogin`. `os.userInfo()` is `getpwuid(geteuid())`, the EFFECTIVE user, which
 * is the answer to a different question. So this reads what glibc reads, in its order.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as tty from 'node:tty';

/**
 * What glibc's `getlogin()` reads, one function each, so a test can hand it any box.
 *
 * Each answers null where glibc's own read fails: a file that cannot be opened, a uid the
 * password database does not hold, a standard input that is not a terminal.
 */
export interface LoginSources {
  /** The first bytes of `/proc/self/loginuid`, at most the 12 glibc reads. */
  readonly loginuid: () => Buffer | null;
  /** `getpwuid(uid)->pw_name`. */
  readonly passwdName: (uid: number) => string | null;
  /** `ttyname(0)`. */
  readonly ttyName: () => string | null;
  /** The user-accounting file, `/var/run/utmp`. */
  readonly utmp: () => Buffer | null;
}

/** `LOGIN_NAME_MAX`: glibc's `getlogin` keeps the name in a buffer one byte longer. */
const LOGIN_NAME_MAX = 256;
/** `(uid_t) -1`, what the kernel reports for a process no login ever marked. */
const NO_LOGIN_UID = 0xffffffff;
/** `ut_type` values `getutline` stops at. */
const LOGIN_PROCESS = 6;
const USER_PROCESS = 7;
/**
 * `sizeof(struct utmp)`, whose `ut_session` and `ut_tv` are 32-bit on x86-64 and `long` and
 * a `struct timeval` on aarch64. The fields read here sit at the same offsets on both: the
 * type at 0, `ut_line[32]` at 8, `ut_user[32]` at 44.
 */
const UTMP_RECORD: Readonly<Record<string, number>> = Object.freeze({ x64: 384, arm64: 400 });

/**
 * The password database's name for `uid`: `/etc/passwd` first, the first line with that
 * uid, as the `files` source answers; then the running user through `os.userInfo()`, which
 * asks the whole name service. Node has no `getpwuid`, and nothing here may start a process
 * for `getent`, so ANOTHER user known only to a network source is not found here where glibc
 * finds it -- the limit `home.ts` records for `~name`.
 */
function passwdName(uid: number): string | null {
  let table = '';
  try {
    table = fs.readFileSync('/etc/passwd', 'utf8');
  } catch {
    /* no such database: the name service below, or nothing */
  }
  for (const line of table.split('\n')) {
    const fields = line.split(':');
    if (fields.length >= 7 && fields[2] === String(uid)) return fields[0] ?? '';
  }
  try {
    const self = os.userInfo();
    if (self.uid === uid) return self.username;
  } catch {
    /* the running user has no entry either */
  }
  return null;
}

/**
 * `ttyname(0)`: the terminal on standard input, by its `/proc/self/fd/0` link, trusted only
 * where that path is the same character device, as glibc checks. Where it is not -- a
 * terminal from another mount namespace -- glibc goes on to search `/dev/pts` and `/dev`;
 * that search is not reproduced, and the answer is no terminal.
 */
function ttyName(): string | null {
  try {
    if (!tty.isatty(0)) return null;
    const link = fs.readlinkSync('/proc/self/fd/0');
    if (!link.startsWith('/')) return null;
    const named = fs.statSync(link);
    return named.isCharacterDevice() && named.rdev === fs.fstatSync(0).rdev ? link : null;
  } catch {
    return null;
  }
}

const HOST: LoginSources = {
  loginuid: () => {
    try {
      return fs.readFileSync('/proc/self/loginuid').subarray(0, 12);
    } catch {
      return null;
    }
  },
  passwdName,
  ttyName,
  utmp: () => {
    try {
      return fs.readFileSync('/var/run/utmp');
    } catch {
      return null;
    }
  },
};

/** A fixed-width C string: the bytes before the first NUL, or all `width` of them. */
function cString(bytes: Buffer, width: number): Buffer {
  const field = bytes.subarray(0, width);
  const end = field.indexOf(0);
  return end < 0 ? field : field.subarray(0, end);
}

/**
 * `__getlogin_r_loginuid`: the name for the login uid, null where glibc gives up (no login
 * uid, or a name too long for its buffer), undefined where it falls back to the terminal (its
 * -1: no loginuid file, one that is not a number, a uid the password database lacks).
 */
function fromLoginuid(sources: LoginSources): string | null | undefined {
  const read = sources.loginuid();
  if (read === null || read.length === 0 || read.length >= 12) return undefined;
  // strtoul over the NUL-terminated read: leading space, a sign, digits, and nothing after.
  const text = cString(read, read.length).toString('latin1');
  const number = /^[ \t\n\v\f\r]*([+-]?)([0-9]+)$/u.exec(text);
  if (number === null) return undefined;
  const magnitude = BigInt(number[2] as string);
  const value = number[1] === '-' ? (1n << 64n) - magnitude : magnitude;
  const uid = Number(value & 0xffffffffn);
  if (uid === NO_LOGIN_UID) return null;
  const name = sources.passwdName(uid);
  if (name === null) return undefined;
  return Buffer.byteLength(name) + 1 > LOGIN_NAME_MAX + 1 ? null : name;
}

/** `getlogin_fd0`: the user utmp records on the terminal that is standard input. */
function fromTerminal(sources: LoginSources): string | null {
  const terminal = sources.ttyName();
  if (terminal === null) return null;
  const record = UTMP_RECORD[process.arch];
  const table = sources.utmp();
  if (record === undefined || table === null) return null;
  // `ttyname + 5`, past "/dev/", compared as `strncmp` compares `ut_line[32]`.
  const line = cString(Buffer.from(terminal.slice(5)), 32);
  for (let at = 0; at + record <= table.length; at += record) {
    const type = table.readInt16LE(at);
    if (type !== LOGIN_PROCESS && type !== USER_PROCESS) continue;
    if (!cString(table.subarray(at + 8), 32).equals(line)) continue;
    return cString(table.subarray(at + 44), 32).toString('utf8');
  }
  return null;
}

/**
 * glibc's `getlogin()`: the LOGIN user, not the effective one. `/proc/self/loginuid` through
 * the password database; where that has no answer, the utmp record for the terminal on
 * standard input. Null is its NULL: no login name to give.
 *
 * Linux only, as measured. Anywhere else the effective user's name stands in, as before:
 * macOS's `getlogin` asks the kernel for the session's login name, which Node cannot reach
 * without a native module or a child process.
 */
export function getlogin(sources: LoginSources = HOST): string | null {
  if (process.platform !== 'linux') {
    try {
      return os.userInfo().username;
    } catch {
      return null;
    }
  }
  const named = fromLoginuid(sources);
  return named === undefined ? fromTerminal(sources) : named;
}
