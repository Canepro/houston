/**
 * What a workspace is called: sanitising, deriving, and resolving a name to a record.
 *
 * Tier 0, and the busiest leaf in the package. Callers reach it as `naming.resolveName(...)`
 * rather than by importing the function, so a patch on this module is seen by all of them.
 */
import * as config from '../../lib/config';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { quotedText } from '../../lib/format';
import { type Emit, warn } from '../../lib/events';
import * as paths from '../runner/paths';

import type { CreateReq } from './types';

const NAME_RE = /[^a-z0-9-]+/gu;

/**
 * What `sanitize()` can produce, and therefore the only shape a real repro has.
 *
 * The trailing `\n?` lets a name end in one final newline, as it always could -- without
 * it a name earlier releases accept would be refused here.
 */
const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]*\n?$/u;

/**
 * The name becomes a directory entry (255 bytes on ext4/APFS) and a compose project
 * name, and the generated container names add `houston-<name>-<service>-1` on top.
 * Unbounded, it passed validation and then raised ENAMETOOLONG from the filesystem -- a
 * 500 from the web API and a raw stack trace from the CLI. 64 leaves ample room.
 */
export const NAME_MAX = 64;

export function requireValidName(name: string): void {
  if (!VALID_NAME_RE.test(name)) {
    throw new ValidationError(
      `invalid repro name ${quotedText(name)} (lowercase letters, digits and '-' only)`,
    );
  }
  if (name.length > NAME_MAX) {
    throw new ValidationError(
      `repro name is ${String(name.length)} characters; the limit is ${String(NAME_MAX)} ` +
        '(it becomes a directory and a set of container names)',
    );
  }
}

export function sanitize(name: string): string {
  const lowered = name.toLowerCase().replace(/\./gu, '-');
  return lowered.replace(NAME_RE, '-').replace(/^-+|-+$/gu, '');
}

/**
 * Say so when `--name` is not the name the workspace gets.
 *
 * `sanitize` slugifies rather than refusing, which is right -- `TICKET-1234` and
 * `ticket 1234` should both work -- but it was silent, and slugifying is not injective:
 * `../escape` and `escape` both become `escape`. There is no traversal here and no
 * injection, but two different tickets could silently land on ONE workspace and share
 * its data, which is the failure worth naming.
 */
export function warnNameCoerced(req: CreateReq, emit: Emit): void {
  if (!req.name) return;
  const became = sanitize(req.name);
  if (became && became !== req.name) {
    warn(
      emit,
      `--name ${quotedText(req.name)} becomes ${quotedText(became)} — a workspace name is a ` +
        `directory and a DNS label. Another name that reduces to ${quotedText(became)} ` +
        'would be the same workspace, data included.',
      { phase: 'create' },
    );
  }
}

/**
 * The workspace name for a version+preset, namespaced by who asked.
 *
 * Without `actor` this returns the same name for everybody -- so on a shared server the
 * second person to run `up -v 8.5.1` silently REUSED the first person's workspace, data
 * and all. Prefixing by the authenticated user makes two people running the same version
 * two workspaces. Left off entirely on a single-user machine.
 */
export function deriveName(version: string, preset: string, actor = ''): string {
  let base = `rc${version}`;
  if (preset && preset !== 'default') base += `-${preset}`;
  if (actor) base = `${actor}-${base}`;
  return sanitize(base);
}

/**
 * `name` namespaced to `actor`, unless it already is.
 *
 * An explicit --name still wins, but on a shared server it has to be somebody's or two
 * people typing `--name test` collide exactly as the derived names did.
 */
export function ownerPrefix(name: string, actor: string): string {
  if (!actor) return name;
  return name.startsWith(`${actor}-`) ? name : `${actor}-${name}`;
}

/**
 * The workspaces `name` could mean, best match first.
 *
 * Creation TRANSFORMS what you type -- `sanitize()` always, and the owner prefix when
 * there are accounts -- so resolution has to apply the same transforms or the name never
 * round-trips. Order matters: exact first, then the owner-prefixed form, then the bare
 * sanitized form, which is what keeps pre-accounts workspaces reachable.
 */
export function nameCandidates(name: string, actor = ''): string[] {
  const out: string[] = [];
  // Only if it is already a legal name: this one is used as a filesystem path, and the
  // sanitized forms below are safe by construction while raw input is not.
  if (VALID_NAME_RE.test(name) && name.length <= NAME_MAX) out.push(name);
  const clean = sanitize(name);
  if (actor && clean) {
    const prefixed = ownerPrefix(clean, actor);
    if (!out.includes(prefixed)) out.push(prefixed);
  }
  if (clean && !out.includes(clean)) out.push(clean);
  return out;
}

/** Whether the config's `default_repro` is set: a truth test, not a presence test. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value !== '';
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * Explicit name (must exist) else the configured default (must exist).
 *
 * `actor` lets a name typed without the owner prefix find the workspace it created;
 * without one this behaves exactly as it did before accounts existed.
 */
export async function resolveName(name: string | null | undefined, actor = ''): Promise<string> {
  if (name) {
    for (const candidate of nameCandidates(name, actor)) {
      if (await paths.exists(candidate)) return candidate;
    }
    // Nothing matched. Report the shape problem when there is one -- "invalid name" is
    // more use than "not found" for `--name 'my repro!'` -- and otherwise say what was
    // looked for, in the form it would have been made.
    requireValidName(sanitize(name) || name);
    throw new NotFoundError(`no repro named ${quotedText(name)} (run \`houston list\`)`);
  }
  const fallback = config.loadConfig().default_repro;
  if (!truthy(fallback)) {
    throw new ValidationError('no name given and no default repro set (use `houston use <name>`)');
  }
  const defaultName = String(fallback);
  requireValidName(defaultName);
  if (!(await paths.exists(defaultName))) {
    throw new NotFoundError(
      `default repro ${quotedText(defaultName)} no longer exists; set another with \`houston use\``,
    );
  }
  return defaultName;
}

/**
 * The workspace name for this request. Used twice -- by the lock wrapper and by the body
 * -- so they cannot drift apart and lock a different repro than the one being written.
 */
export function deriveFor(req: CreateReq): string {
  if (req.name) return sanitize(ownerPrefix(sanitize(req.name), req.actor));
  return deriveName(req.version, req.preset, req.actor);
}
