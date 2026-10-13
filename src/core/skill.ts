/**
 * The agent skill: one canonical file, installed per host, and told when it's stale.
 *
 * houston is increasingly driven by something that is not a person -- an agent asked "does
 * this reproduce on 8.6.1?", a CI step, a colleague's script. That caller needs to know how
 * to drive it, and the failure mode if nobody tells it is specific: it scrapes the human
 * output, which breaks the first time a line is reworded.
 *
 * `data/skill/SKILL.md` is the canonical copy and ships as package data, so the
 * instructions travel with the build rather than with the checkout. `install()` places it
 * where an agent looks -- `~/.claude/skills/houston/` and `~/.agents/skills/` -- alongside
 * a small sidecar recording the version and the file's sha256.
 *
 * The sidecar is what makes `state()` able to say `current` / `stale` / `modified` /
 * `absent`, and that distinction is the point: a skill written for an older build
 * describes flags this one may not have, and the caller it is instructing has no way to
 * notice on its own. `capabilities` reports the answer, so a stale skill is discovered
 * through the contract the caller already reads.
 *
 * MODIFIED is never overwritten without `force`. Somebody who edited their local copy did
 * it on purpose, and clobbering that to install an identical-in-spirit file is the kind of
 * helpfulness nobody asks for twice.
 *
 * ## Two files this module writes live OUTSIDE `HOUSTON_HOME`
 *
 * `~/.claude/skills/houston/.houston-skill.json` and the `~/.agents/skills/` copy are
 * those two, and they STAMP the houston version. `getHoustonVersion()` is what supplies
 * it here, and `lib/jsonout.ts` records why it is settable rather than read from installed
 * package metadata.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../lib/config';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { pathHome, joinPath } from '../lib/home';
import { getHoustonVersion } from '../lib/jsonout';
import {
  pathExists,
  decodeUtf8Strict,
  quotedText,
  toTextAny,
  isTruthy,
  expectedText,
} from '../lib/format';
import { JsonSyntaxError, loads } from '../lib/json-text';

/**
 * Where an agent looks. Two conventions, both real: Claude Code reads `~/.claude/skills`,
 * and the wider agent convention is `~/.agents/skills`.
 */
export const HOSTS: Readonly<Record<string, string>> = Object.freeze({
  claude: '.claude/skills',
  agents: '.agents/skills',
});

export const SKILL_DIR = 'houston';
export const SKILL_FILE = 'SKILL.md';
export const SIDECAR = '.houston-skill.json';

/** The canonical file shipped inside the package. */
export function packaged(): string {
  return config.dataPath('skill', SKILL_FILE);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The user's home, NOT `HOUSTON_HOME`.
 *
 * A skill is read by an agent that knows nothing about houston's state directory, so it
 * goes where that agent looks. `HOUSTON_SKILL_HOME` exists only so a test can point this
 * somewhere disposable -- without it a test run would write into the developer's real
 * `~/.claude`.
 */
function userHome(): string {
  return config.env('HOUSTON_SKILL_HOME') || pathHome();
}

/**
 * The DIRECTORY a skill sits in for `host`, by name.
 *
 * `dir` defaults to the one this build installs; `migrate` asks for the pre-rename name
 * beside it. It is a function here rather than arithmetic at the caller because the
 * caller got it wrong: `migrate` rebuilt it as `dirname(target(host))`, which is the
 * skill's own directory rather than its parent, so it looked for `<host>/houston/rc-repro`
 * and never found the copy sitting at `<host>/rc-repro`. One owner for the shape, and a
 * second caller cannot be off by a path component.
 */
export function hostSkillDir(host: string, dir: string = SKILL_DIR): string {
  // `quotedText(host)`, where this hard-coded single quotes: `--host "o'x"` printed `'o'x'`
  // where the established message says `"o'x"`, in stderr and in the envelope's message
  // alike. And the host must be an OWN key: `HOSTS['constructor']` is `Object`, not
  // undefined, so `--host constructor` (or `toString`, `__proto__`) went on to join a
  // function into the path and died unhandled, exit 1. An unknown host is a bad `--host`
  // value, so a usage error, exit 2: it was a NotFoundError, exit 4, which the contract keeps
  // for a missing workspace, and a bad flag value is 2 on every other command.
  if (!Object.hasOwn(HOSTS, host)) {
    throw new ValidationError(
      `unknown skill host ${quotedText(host)} (want ${Object.keys(HOSTS).sort().join(' | ')} or all)`,
    );
  }
  const relative = HOSTS[host] as string;
  // The skill home, the host's directory and `SKILL_DIR`, joined by `joinPath`, which
  // keeps a `..` and a `//` in HOUSTON_SKILL_HOME where `path.join` folded them away --
  // `nonexistent/../x` was `x` here, so `skill status` found a copy the established path
  // cannot reach and called it current where the established answer is absent.
  return joinPath(userHome(), relative, dir);
}

export function target(host: string): string {
  return joinPath(hostSkillDir(host), SKILL_FILE);
}

export interface HostState {
  host: string;
  /** current | stale | modified | absent */
  status: string;
  path: string;
  version: string;
}

/**
 * The file's text, or '' when it cannot be read. Its newlines are translated, CRLF and lone
 * CR to LF -- a CRLF copy of the packaged file IS the packaged file, as it always was, and
 * was "stale" here, its hash differing too -- and the decode is strict, so bytes that are
 * not UTF-8 are a `NotUtf8` refusal, not U+FFFDs.
 */
function readText(target_: string): string {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(target_);
  } catch {
    return '';
  }
  return decodeUtf8Strict(bytes, target_).replace(/\r\n?/gu, '\n');
}

/** What is installed for one host, and whether it matches this build. */
export function hostState(host: string): HostState {
  const where = target(host);
  const installed = readText(where);
  if (!installed) return { host, status: 'absent', path: where, version: '' };
  const want = readText(packaged());
  // The sidecar through `loads`, `{}` when it is empty or fails to decode -- a
  // JsonSyntaxError, or the sidecar's own `NotUtf8` -- so a NaN in it is a value.
  // What it holds must then be a mapping: a list is the TypeError `expected an object, got
  // a list`, which `state()` reports as `unknown`.
  let side: unknown;
  try {
    side = loads(readText(joinPath(path.dirname(where), SIDECAR)) || '{}');
  } catch (error) {
    if (!(error instanceof RangeError) && !(error instanceof JsonSyntaxError)) throw error;
    side = {};
  }
  if (side === null || typeof side !== 'object' || Array.isArray(side)) {
    throw new TypeError(expectedText('an object', side));
  }
  const held = side as Record<string, unknown>;
  const recorded = isTruthy(held.sha256) ? toTextAny(held.sha256) : '';
  const version = isTruthy(held.houston_version) ? toTextAny(held.houston_version) : '';
  if (installed === want) return { host, status: 'current', path: where, version };
  // The sidecar separates the two ways a file can differ, and they need opposite answers:
  // if it still matches what WE wrote, the package moved on and this is stale (reinstall
  // it). If it does not, a human edited it, and that is theirs.
  if (recorded && recorded !== sha256(installed)) {
    return { host, status: 'modified', path: where, version };
  }
  return { host, status: 'stale', path: where, version };
}

/**
 * The CHECKOUT's own copy, if the caller is working inside one.
 *
 * An agent reads `.claude/skills/` relative to the project before it reads the one in a
 * home directory, so in a checkout that is the file actually in play -- and reporting only
 * the home copy meant `capabilities` said `current: false` to a developer who was, at that
 * moment, reading a perfectly current skill. It then told them to run `skill install`,
 * which writes a DIFFERENT copy somewhere the agent was not reading. Found by driving the
 * skill and watching it say that.
 *
 * Walked upward from the working directory, the same way the tooling finds it.
 */
export function projectCopy(start?: string): string | null {
  const here = path.resolve(start ?? process.cwd());
  // The host's relative directory, split on "/" with its first part dropped,
  // so the walked path is `<dir>/.claude/skills/houston/SKILL.md`. Kept as the same
  // derivation rather than a second literal, so the two cannot drift apart.
  const tail = (HOSTS.claude as string).split('/').slice(1).join('/');
  let directory = here;
  for (;;) {
    const candidate = path.join(directory, '.claude', tail, SKILL_DIR, SKILL_FILE);
    // `pathExists`, which throws for a directory it may not enter where existsSync said no
    // and walked on -- to a parent's copy the established walk never reports.
    if (pathExists(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export interface SkillState {
  version: string;
  hosts: Record<string, { status: string; path: string; version: string; scope: string }>;
  current: boolean;
}

/**
 * Every copy that exists, for `capabilities`. Never raises: discovery must not fail on an
 * odd home or an unreadable directory.
 *
 * `current` is true when every copy that EXISTS matches this build, and at least one does.
 * Absent is not current -- there is nothing to have read -- and a stale copy anywhere is
 * worth reporting even if another one is fine, because nobody knows which of them the
 * caller loaded.
 */
export function state(): SkillState {
  const version = getHoustonVersion();
  const hosts: SkillState['hosts'] = {};
  for (const host of Object.keys(HOSTS).sort()) {
    try {
      const st = hostState(host);
      hosts[host] = { status: st.status, path: st.path, version: st.version, scope: 'user' };
    } catch {
      hosts[host] = { status: 'unknown', path: '', version: '', scope: 'user' };
    }
  }
  let local: string | null;
  try {
    local = projectCopy();
  } catch {
    local = null;
  }
  if (local !== null) {
    const same = readText(local) === readText(packaged());
    hosts.project = {
      status: same ? 'current' : 'stale',
      path: local,
      version: same ? version : '',
      scope: 'project',
    };
  }
  const present = Object.values(hosts).filter((h) => h.status !== 'absent');
  const current = present.length > 0 && present.every((h) => h.status === 'current');
  return { version, hosts, current };
}

export interface InstallResult {
  version: string;
  hosts: { host: string; path: string; action: string }[];
}

/**
 * Copy the packaged skill into each host's directory. Idempotent.
 *
 * Refuses a locally-modified file without `force`, because overwriting somebody's edit to
 * install the version they had already chosen to change is not a service.
 */
export function install(host = 'all', { force = false } = {}): InstallResult {
  const hosts = host === 'all' ? Object.keys(HOSTS).sort() : [host];
  const want = readText(packaged());
  if (!want) {
    throw new NotFoundError(
      `the packaged skill is missing from this install (${packaged()}) — ` +
        'reinstall houston, or run from a checkout',
    );
  }
  const results: InstallResult['hosts'] = [];
  for (const name of hosts) {
    const st = hostState(name);
    const where = target(name);
    if (st.status === 'modified' && !force) {
      throw new ConflictError(
        `${where} was edited locally; installing would discard that. Pass --force to ` +
          'overwrite it, or move it aside first.',
      );
    }
    if (st.status === 'current') {
      results.push({ host: name, path: where, action: 'unchanged' });
      continue;
    }
    fs.mkdirSync(path.dirname(where), { recursive: true });
    fs.writeFileSync(where, want, 'utf8');
    fs.writeFileSync(
      joinPath(path.dirname(where), SIDECAR),
      // Indented by 1, plus a trailing newline. The indent is 1, not 2 -- the established
      // bytes, for one of the two files that live outside HOUSTON_HOME.
      JSON.stringify(
        {
          houston_version: getHoustonVersion(),
          sha256: sha256(want),
          installed_at: `${new Date().toISOString().slice(0, 19)}+00:00`,
        },
        null,
        1,
      ) + '\n',
      'utf8',
    );
    results.push({
      host: name,
      path: where,
      action: st.status === 'absent' ? 'installed' : 'updated',
    });
  }
  return { version: getHoustonVersion(), hosts: results };
}
