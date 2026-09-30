/**
 * Adopt a pre-rename state directory, once, without recreating anything.
 *
 * This tool was called rc-repro and kept its state in `~/.rc-repro`. The rename moves that to
 * `~/.houston`. Everything here is about doing the move WITHOUT touching the containers,
 * namespaces, certificates or volumes the old name created: those are adopted by
 * `runner.projectName` and `kube.namespaceFor`, which read what a workspace wrote down
 * instead of deriving it from a prefix. A migration that recreated a workspace would destroy
 * the customer data the repro exists to hold, so nothing here calls `up`, `down`, or anything
 * that writes to Docker or Kubernetes.
 *
 * Most of the state needs no rewriting at all, which is worth stating because it looks too
 * easy: `repro.json` has ALWAYS recorded `project`, and the Kubernetes path has recorded
 * `extra["namespace"]` since it existed. The records were never wrong -- only the readers
 * were, and that is fixed in `runner`/`kube` rather than here. What is left is the handful
 * of places where the old name was written into a FILE and read back.
 *
 * There is deliberately no journal entry and no lock. `fs.rename` is atomic, so a process
 * killed during the move leaves either the old directory or the new one and never half of
 * each; everything after the move is idempotent and keyed on what it finds rather than on
 * having been told, so a killed run is simply finished by the next one. A journal `kind`
 * would have to be taught to `journal.recover` in order to describe a side effect that
 * cannot occur.
 *
 * Deliberately NOT done here: anything root-owned. The systemd unit at
 * `/etc/systemd/system/rc-repro.service` and the CA certificate installed in the system
 * trust store both need sudo and an informed human, and the shared edge holds :80 and :443
 * for every workspace on the box -- taking it down as a silent side effect of somebody's
 * first command after an upgrade is an outage nobody asked for. `doctor` names all three,
 * with the command to fix each.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../lib/config';
import { ConflictError, ValidationError } from '../lib/errors';
import { type Emit, info, nullEmit, warn } from '../lib/events';
import { pathHome, joinPath } from '../lib/home';
import { splitTextLines as splitLines } from '../lib/format';
import { orderedDict } from '../lib/json-text';
import { docker } from '../seams/docker-cli';

import * as edgePaths from './edge/paths';
import * as edgeRuntime from './edge/runtime';
import * as edgeSpec from './edge/spec';
import { EDGE_FIELDS, fromDocument, type Edge } from './edge/types';
import { dockerAvailable } from './runner/host';
import { atomicWrite } from './runner/paths';
import { listMeta, updateMeta } from './runner/record';
import * as skill from './skill';
import * as topology from './topology';

/**
 * Where state lived before the rename, and the names that were written INTO files there
 * and read back out again.
 */
export const LEGACY_HOME_DIRNAME = '.rc-repro';
export const LEGACY_NAMESPACE_PREFIX = 'rc-repro-';
export const LEGACY_EDGE_PROJECT = 'rcrepro_edge';
export const LEGACY_LOG_NAME = 'rc-repro.log';
export const LEGACY_SKILL_DIR = 'rc-repro';

/**
 * Files whose COMMENT lines carry the old name.
 *
 * Only lines beginning with "#" are rewritten: `users` holds account names and password
 * hashes on its other lines and a blanket substitution there could rewrite somebody's
 * username.
 */
const COMMENTED_FILES: readonly string[] = ['sessions', 'users', 'first-run'];

/**
 * The pre-rename state directory on this box, or null.
 *
 * Only the DEFAULT location is ever migrated. If `HOUSTON_HOME` is set -- or its
 * pre-rename alias, which `config.env` still honours -- then an operator has said where
 * state lives, and moving a directory they named by hand is not a decision this function
 * gets to make on their behalf. `doctor` reports that case instead.
 */
export function legacyHome(): string | null {
  if (config.env('HOUSTON_HOME') !== '') return null;
  // `LEGACY_HOME_DIRNAME` under the user's home, and every path in this module joined
  // component by component, a `..` kept as written (`joinPath`): `path.join` folded a
  // `..` in HOME or the home that the kernel resolves through a symlink, so an earlier
  // version adopted -- and emptied -- a different directory from the one earlier releases
  // adopt.
  const legacy = joinPath(pathHome(), LEGACY_HOME_DIRNAME);
  try {
    return fs.statSync(legacy).isDirectory() ? legacy : null;
  } catch {
    return null;
  }
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = joinPath(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Truthiness for a value read out of JSON: absent, null, `false`, `0`, `""`, `[]` and `{}`
 * are all false.
 *
 * Whether `extra.namespace` is recorded is a truth test, not a presence test, so `0`,
 * `false`, `""`, `[]` and `{}` all mean "not recorded". Enumerating only `undefined`/`null`/
 * `""` here made a `repro.json` carrying any of the others skip a workspace earlier
 * releases would have stamped -- and an unstamped Kubernetes workspace is one a later
 * `down` aims at the wrong namespace.
 */
function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '') return false;
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * The three failure classes the edge regeneration is allowed to report and swallow.
 *
 * An OS error is a Node system error (it carries `syscall`/`errno`, which a `ReproError`
 * does not); a bad value is what a broken `spec.json` gives, which here is `JSON.parse`'s
 * `SyntaxError`; a `TypeError` is `edgeFrom` refusing a key it does not know. Anything
 * else is a bug in this build and belongs at the top of the process, not in a warning.
 */
function isSpecFault(error: unknown): boolean {
  if (error instanceof SyntaxError || error instanceof TypeError) return true;
  return error instanceof Error && 'syscall' in error && 'errno' in error;
}

/** Whether a filesystem error is "there is nothing here" rather than "I could not look". */
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Whether `path` holds nothing that would be lost by removing it.
 *
 * An early `config.home()` on a fresh box can mkdir the target before anything has been
 * written into it, and refusing to migrate because of a directory this tool created itself
 * one command ago would strand the state permanently.
 *
 * THE EVENT LOG COUNTS AS EMPTY, and that is the case this actually happens in.
 * `logs/houston.log` is opened by the first command that runs at all -- so a box that ran a
 * single `houston --version` before its state was adopted has a non-empty ~/.houston
 * holding nothing but a record of that one command. Treating that as "state" refuses the
 * migration forever, on the strength of a file whose entire content is the invocation that
 * created it.
 *
 * A READ THAT FAILED IS NOT AN EMPTY DIRECTORY, and this is the one place this module
 * deliberately does not reproduce the previous implementation. Its directory walk swallows
 * a permission error and yields nothing, so it answers "empty" for a state directory it
 * cannot read -- and the only caller then removes it. Measured: a directory holding a
 * file, chmod 000, is "empty" there. Only a missing directory is genuinely empty here;
 * anything else that refuses to be listed is a refusal to migrate, which the caller turns
 * into the ConflictError telling the operator to sort the two homes out by hand.
 */
export function isEffectivelyEmpty(target: string): boolean {
  let files: string[];
  try {
    files = filesUnder(target);
  } catch (error) {
    return isMissing(error);
  }
  const logs = joinPath(target, 'logs');
  return files.every((f) => path.dirname(f) === logs && path.basename(f).startsWith('houston.log'));
}

/**
 * A file's text, with every CRLF and lone CR turned into LF.
 *
 * The translation happens before anything sees the string, so a file this rewrites comes
 * back with LF endings, as it always has. Reading the bytes verbatim here would write
 * different bytes from earlier releases for the same input file.
 */
function readText(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\r\n?/gu, '\n');
}

/** Files under `home` still carrying the old name on a comment line. */
function staleMarkers(home: string): string[] {
  const out: string[] = [];
  for (const leaf of COMMENTED_FILES) {
    let text: string;
    try {
      text = readText(joinPath(home, leaf));
    } catch {
      continue;
    }
    if (splitLines(text).some((ln) => ln.startsWith('#') && ln.includes('rc-repro'))) {
      out.push(leaf);
    }
  }
  return out;
}

/**
 * Whether anything is left to adopt.
 *
 * True while the old directory is still there, and ALSO true when the move happened but
 * the in-place fixes did not -- which is what makes an interrupted run finishable by the
 * next one without a journal.
 */
export function pending(): boolean {
  if (legacyHome() !== null) return true;
  const home = config.home();
  return staleMarkers(home).length > 0 || fs.existsSync(joinPath(home, 'logs', LEGACY_LOG_NAME));
}

/**
 * Rewrite the old name out of comment lines. Idempotent.
 *
 * Reports rather than emits: see `migrate` on why nothing here may emit.
 */
async function rewriteMarkers(home: string): Promise<string[]> {
  const done: string[] = [];
  for (const leaf of staleMarkers(home)) {
    const target = joinPath(home, leaf);
    const mode = fs.statSync(target).mode & 0o777;
    // Lines with their terminators kept: the terminator travels with its line, so a file
    // with no trailing newline does not gain one.
    const lines = splitLines(readText(target), true);
    const fixed = lines.map((ln) =>
      ln.startsWith('#') ? ln.split('rc-repro').join('houston') : ln,
    );
    await atomicWrite(target, fixed.join(''), { mode });
    done.push(leaf);
  }
  // `# houston-state:` in `sessions` is the one name in this codebase that is written AND
  // parsed back -- doctor reads it to refuse a state file written by a newer build. Left
  // unrewritten the marker never matches and that refusal quietly stops happening, which is
  // the failure you cannot see.
  return done;
}

/**
 * Move `logs/rc-repro.log*` to `logs/houston.log*`. Idempotent.
 *
 * A file already at the destination means an earlier run got as far as opening the new log,
 * so the old one is kept beside it under `.pre-rename` rather than skipped: skipping would
 * leave `pending()` true forever and re-run this on every command.
 */
function renameLogs(home: string): number {
  const logs = joinPath(home, 'logs');
  let moved = 0;
  try {
    if (!fs.statSync(logs).isDirectory()) return 0;
  } catch {
    return 0;
  }
  const names = fs
    .readdirSync(logs)
    .filter((n) => n.startsWith(LEGACY_LOG_NAME))
    .sort();
  for (const name of names) {
    const src = joinPath(logs, name);
    let dest = joinPath(logs, name.replace(LEGACY_LOG_NAME, 'houston.log'));
    if (fs.existsSync(dest)) {
      dest = joinPath(logs, `${name}.pre-rename`);
      if (fs.existsSync(dest)) continue;
    }
    fs.renameSync(src, dest);
    moved += 1;
  }
  return moved;
}

/**
 * Record the namespace a Kubernetes workspace is ALREADY in, where it is absent.
 *
 * `createWorkspace` has written `extra["namespace"]` for as long as the Kubernetes runtime
 * has existed, so this is empty for almost everybody. A workspace made before that field,
 * though, has nothing recorded, and `namespaceFor` would derive `houston-<name>` for
 * objects that are sitting in `rc-repro-<name>` -- sending a later `down` at a namespace
 * that was never created while the real one keeps its pods, its PVCs and its port-forward.
 */
async function stampNamespaces(): Promise<string[]> {
  const stamped: string[] = [];
  for (const meta of await listMeta()) {
    const name = meta.name;
    if (topology.ofMeta(meta) !== topology.KUBERNETES) continue;
    const extra: unknown = meta.extra;
    const bag =
      typeof extra === 'object' && extra !== null && !Array.isArray(extra)
        ? (extra as Record<string, unknown>)
        : {};
    if (isTruthy(bag.namespace)) continue;

    await updateMeta(name, (m) => {
      // `orderedDict(m.extra)`, which keeps the record's key order and its numbers' spelling; a
      // spread is a new object in JavaScript's order with neither.
      m.extra = orderedDict(m.extra);
      m.extra.namespace = `${LEGACY_NAMESPACE_PREFIX}${name}`;
    });
    stamped.push(name);
  }
  return stamped;
}

/**
 * Replace agent-skill copies installed under the old directory name.
 *
 * `skill install` writes into ~/.claude/skills/<tool>/ and ~/.agents/skills/<tool>/, so the
 * directory name IS the tool name and a rename strands the old copy. Nothing breaks loudly:
 * the stale SKILL.md keeps teaching agents to run `rc-repro <cmd>`, a command that no longer
 * exists, and an agent following it fails in a way that looks like the agent's fault.
 *
 * Safe to do unattended, unlike the other leftovers, because these are this tool's own files
 * in a directory it created for itself -- no sudo, nothing shared, and nothing another
 * program is entitled to. A locally EDITED skill is left alone: `install` refuses to discard
 * somebody's changes, and that refusal is right here too, so the old copy is kept and
 * reported rather than silently overwritten.
 */
function adoptSkillCopies(emit: Emit): string[] {
  const removed: string[] = [];
  for (const host of Object.keys(skill.HOSTS)) {
    // ASKED FOR, not rebuilt. `skill` owns where a host's skill directory is -- the agent
    // home it is under is private to that module for the reason its own docstring gives --
    // so the pre-rename copy is the same question with the old name.
    const old = skill.hostSkillDir(host, LEGACY_SKILL_DIR);
    try {
      if (!fs.statSync(old).isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      skill.install(host);
    } catch (error) {
      // a locally edited skill, most likely
      warn(
        emit,
        `${old} is stale but the new skill could not be installed ` +
          `(${error instanceof Error ? error.message : String(error)}) — ` +
          '`houston skill install` after resolving it',
      );
      continue;
    }
    // Removed with every error ignored -- `force` only forgives ENOENT, so an
    // unreadable file inside somebody's agent directory would otherwise throw out of
    // `migrate()` and take down the command that called it.
    try {
      fs.rmSync(old, { recursive: true, force: true });
    } catch {
      // every error ignored
    }
    removed.push(old);
  }
  if (removed.length > 0) {
    info(emit, `replaced ${String(removed.length)} pre-rename agent skill copy/copies`);
  }
  return removed;
}

/**
 * Rewrite the edge's compose file so its ABSOLUTE paths follow the move.
 *
 * Two of the edge's three mounts are relative (`./dynamic`, `./certs`) and travel with the
 * directory. The ACME store is not: it is written as an absolute path, because it is shared
 * with workspaces and lives beside the edge rather than inside it. After the move that path
 * names ~/.rc-repro/acme, which no longer exists -- and Docker does not fail on a missing
 * bind source, it CREATES it, empty and root-owned. The edge would then come up with an
 * empty ACME store pointed at production Let's Encrypt and re-request every name it already
 * held, spending a rate limit that allows five duplicates a week, to replace certificates
 * that were never lost.
 *
 * `spec.json` records everything the compose file is generated from, so this is a
 * regeneration rather than a rewrite: the same code path `edge start` uses.
 */
async function regenerateEdgeCompose(emit: Emit): Promise<boolean> {
  const specFile = joinPath(edgePaths.edgeDir(), edgePaths.SPEC_FILE);
  try {
    if (!fs.statSync(specFile).isFile()) return false;
  } catch {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    await edgeSpec.write(edgeFrom(parsed));
  } catch (error) {
    // Those three failure classes (`isSpecFault`) AND NOT WIDER. A bare `catch` here turned
    // a defect in this function into a warning nobody's gate reads: `edgeFrom` was
    // checking the wrong key names and rejecting every spec.json in existence, and the
    // only evidence was a line of prose in an emit stream no test asserts on.
    if (!isSpecFault(error)) throw error;
    warn(
      emit,
      `could not regenerate the edge configuration ` +
        `(${error instanceof Error ? error.message : String(error)}) — ` +
        '`houston edge start` rewrites it',
    );
    return false;
  }
  info(emit, 'regenerated the edge configuration for its new location');
  return true;
}

/**
 * An `Edge` from a spec -- including the part where an unexpected key is a TypeError.
 *
 * A partial spread would accept a spec written by a build that has since renamed a field
 * and silently use the default for it, which is how an edge comes back up serving a
 * different domain than the one recorded. An unknown key is refused, as it always was.
 *
 * AGAINST THE ON-DISK NAMES, which are the `acme_email`/`gui_host` spelling on disk and not
 * the `Edge` interface's. Checking the camelCase property names here rejected every
 * spec.json a pre-rename home can contain -- and a pre-rename home is by definition one an
 * earlier release wrote, so `edge_regenerated` was false for everybody. The compose file
 * then kept an ACME path naming a directory the move had just deleted, which is the exact
 * failure `regenerateEdgeCompose` exists to prevent.
 */
function edgeFrom(parsed: unknown): Edge {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('the edge spec is not an object');
  }
  const known = new Set<string>(EDGE_FIELDS.map(([, key]) => key));
  const unexpected = Object.keys(parsed).filter((key) => !known.has(key));
  if (unexpected.length > 0) {
    throw new TypeError(`unexpected edge field(s): ${unexpected.sort().join(', ')}`);
  }
  return fromDocument(parsed as Record<string, unknown>);
}

/**
 * Move the shared edge onto its new project instead of leaving both running.
 *
 * The instinct is to leave a running reverse proxy alone and ask first, because :80 and
 * :443 are visible to everything on the box. That instinct is WRONG here, and the reason is
 * the move that just happened: the old container's bind mounts point into ~/.rc-repro, which
 * no longer exists. It keeps serving only because Linux holds those directory inodes open
 * for it -- and the first time anything restarts that container, Docker re-resolves the
 * paths, creates empty directories in their place as root, and the edge comes back reporting
 * `running` while serving no route and no certificate at all. It also restarts against an
 * empty ACME store pointed at production Let's Encrypt, so it re-requests every name it used
 * to hold.
 *
 * So there is no untouched-and-working state to protect. The migration committed the moment
 * it moved the directory; stopping halfway leaves a proxy that is fine until it is not, with
 * nothing on the box saying so. Finishing costs about two seconds of downtime and is the
 * only outcome that is actually safe.
 *
 * Best-effort throughout: a box with no Docker and no edge has nothing to do here, and a
 * failure must not take the command down with it -- it is reported with the two commands
 * that finish the job by hand.
 */
async function handOverTheEdge(emit: Emit): Promise<string> {
  if (!(await dockerAvailable())) return '';
  let listed: string;
  try {
    const res = await docker(
      [
        'ps',
        '--filter',
        `label=com.docker.compose.project=${LEGACY_EDGE_PROJECT}`,
        '--filter',
        'status=running',
        '--format',
        '{{.Names}}',
      ],
      { capture: true, text: true, timeoutMs: 15_000 },
    );
    listed = String(res.stdout ?? '');
  } catch {
    return '';
  }
  const holder = listed.trim().split('\n').filter(Boolean);
  if (holder.length === 0) return '';
  const first = holder[0] as string;

  info(
    emit,
    `handing the shared edge over from ${first} — its mounts point at ` +
      'a directory that no longer exists',
  );
  let stopped: boolean;
  try {
    const stop = await docker(['compose', '-p', LEGACY_EDGE_PROJECT, 'down'], {
      capture: true,
      text: true,
      timeoutMs: 120_000,
    });
    stopped = stop.exitCode === 0;
  } catch {
    stopped = false;
  }
  if (!stopped) {
    warn(
      emit,
      `could not stop ${first} — finish by hand: \`docker compose -p ` +
        `${LEGACY_EDGE_PROJECT} down\` then \`houston edge start\``,
    );
    return first;
  }

  if (!edgeSpec.installed()) {
    info(emit, `${first} is stopped; nothing on this box needs an edge yet`);
    return first;
  }
  if ((await edgeRuntime.up({ pull: false })).returncode === 0) {
    info(emit, 'the edge is serving again on :80 and :443, as houston_edge');
  } else {
    warn(
      emit,
      `${first} is stopped but the new edge did not start — ` + '`houston edge start` says why',
    );
  }
  return first;
}

/** Move a pre-rename ~/.rc-repro into place, once. */
function adoptLegacyHome(legacy: string | null, moved: boolean, target: string): boolean {
  if (legacy === null) return moved;
  if (fs.existsSync(target) && !isEffectivelyEmpty(target)) {
    throw new ConflictError(
      `both ${legacy} and ${target} hold state, so there is no safe move to ` +
        `make — this tool will not merge two state directories. Keep the one ` +
        `you want and remove or rename the other, then run this again`,
    );
  }
  if (fs.existsSync(target)) {
    // `isEffectivelyEmpty` allows an event log through, so this is a tree removal rather
    // than an rmdir. Only ever reached for a directory that holds nothing but this tool's
    // own log of the command that made it.
    fs.rmSync(target, { recursive: true, force: true });
  }
  try {
    fs.renameSync(legacy, target);
  } catch (error) {
    // Cross-device is the realistic cause, and a copy would stop being atomic exactly
    // where atomicity is the whole safety argument.
    throw new ValidationError(
      `could not move ${legacy} to ${target}: ${error instanceof Error ? error.message : String(error)}. ` +
        `Move it by hand (\`mv ${legacy} ${target}\`) and run this again`,
    );
  }
  return true;
}

export interface MigrateResult {
  readonly moved: boolean;
  readonly from: string;
  readonly to: string;
  readonly markers: string[];
  readonly logs_renamed: number;
  readonly namespaces_recorded: string[];
  readonly skills_replaced: string[];
  readonly edge_regenerated: boolean;
  readonly legacy_edge: string;
}

/**
 * Move the pre-rename state into place and finish any interrupted move.
 *
 * Safe to call on every invocation: it is a no-op once there is nothing left to do, and it
 * never touches Docker or Kubernetes state.
 */
export async function migrate(emit: Emit = nullEmit): Promise<MigrateResult> {
  const legacy = legacyHome();
  const target = config.home();
  let moved = false;

  moved = adoptLegacyHome(legacy, moved, target);

  // EVERY filesystem change happens before ANY message, and the order is the whole point.
  // `events.info` tees each event into the event log, which opens logs/houston.log -- so a
  // single "moved ..." emitted here would create the destination file and turn the log
  // rename below into a permanent no-op, leaving logs/rc-repro.log behind and `pending()`
  // true on every subsequent command.
  const logsRenamed = renameLogs(target);
  const markers = await rewriteMarkers(target);
  const namespaces = await stampNamespaces();
  // BEFORE the handover below starts it: the edge must not come up pointed at the directory
  // it just moved out of.
  const regenerated = moved ? await regenerateEdgeCompose(emit) : false;

  if (moved) info(emit, `moved ${String(legacy)} to ${target}`);
  if (logsRenamed > 0) {
    info(emit, `renamed ${String(logsRenamed)} event-log file(s) to houston.log`);
  }
  if (markers.length > 0) {
    info(emit, `rewrote the old name out of ${markers.join(', ')}`);
  }
  if (namespaces.length > 0) {
    info(emit, `recorded the existing namespace for ${namespaces.join(', ')}`);
  }

  return {
    moved,
    from: legacy ?? '',
    to: target,
    markers,
    logs_renamed: logsRenamed,
    namespaces_recorded: namespaces,
    skills_replaced: adoptSkillCopies(emit),
    edge_regenerated: regenerated,
    legacy_edge: await handOverTheEdge(emit),
  };
}
