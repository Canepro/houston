/**
 * What a workspace is called: sanitising, deriving, and resolving a name to a record.
 *
 * Tier 0, and the busiest leaf in the package. Callers reach it as `naming.resolveName(...)`
 * rather than by importing the function, so a patch on this module is seen by all of them.
 */
import { createHash } from 'node:crypto';

import { namesOf } from '../../lib/presets/composite';
import * as config from '../../lib/config';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { quotedText } from '../../lib/format';
import { type Emit, event, warn } from '../../lib/events';
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

/**
 * The longest name `deriveName` makes for a composed set. Over HTTPS the edge resolves
 * `houston-<name>-phpldapadmin-1`, the longest container it routes to, and a DNS label
 * holds 63 characters; 40 also fits `<name>.houston.localhost` in a certificate's
 * 64-character common name and `houston-<name>` in a Kubernetes namespace.
 */
export const DERIVED_MAX = 40;

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
/**
 * Say the name the create settled on, when it is not what was typed: derived from the
 * version and presets, or prefixed with the person's account. The GUI titles its progress
 * with it (`code`), which until now guessed `rc-<version>` and named nothing on the box.
 */
export function announceName(req: CreateReq, name: string, emit: Emit): void {
  if (name === req.name) return;
  emit(
    event(`workspace name: ${name}`, {
      phase: 'create',
      code: 'workspace-name',
      data: { workspace: name },
    }),
  );
}

/**
 * How long a name the person may TYPE when the workspace name may be at most `max`: with
 * accounts houston puts `<actor>-` in front of what they type, and that counts too.
 */
export function typedRoom(req: CreateReq, name: string, max: number): string {
  const prefixed = req.actor !== '' && name.startsWith(`${req.actor}-`);
  const room = max - (prefixed ? req.actor.length + 1 : 0);
  return (
    `at most ${String(room)} characters` +
    (prefixed ? `, as houston puts '${req.actor}-' in front of it` : '')
  );
}

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
  const names = preset && preset !== 'default' ? namesOf(preset) : [];
  // A composed set joins with `--`, so `email+ldap` cannot derive the same name as a user
  // preset called `email-ldap` (workspace names hold only [a-z0-9-]).
  if (names.length > 0) base += `-${names.join('--')}`;
  if (actor) base = `${actor}-${base}`;
  const name = sanitize(base);
  if (names.length < 2 || name.length <= DERIVED_MAX) return name;
  // A composed set can name more than fits: five presets from the GUI made a 51-character
  // name whose HTTPS certificate openssl refused, and whose longer containers the edge
  // could not resolve. Keep whole preset names while they fit,
  // then a hash of the full name, so the same set derives the same name every time (a
  // re-up finds it) and two sets never derive the same one.
  const tag = createHash('sha256').update(name).digest('hex').slice(0, 6);
  const room = DERIVED_MAX - tag.length - 1;
  const [first = '', ...rest] = name.split('--');
  let kept = first;
  for (const part of rest) {
    if (`${kept}--${part}`.length > room) break;
    kept += `--${part}`;
  }
  return `${kept.slice(0, room).replace(/-+$/u, '')}-${tag}`;
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
 * A typed name keeps no prefix when it is an existing workspace the actor may act on
 * (`exactName`), as every other command resolves it.
 */
export function deriveFor(req: CreateReq): string {
  if (!req.name) return deriveName(req.version, req.preset, req.actor);
  return sanitize(req.exactName ? req.name : ownerPrefix(sanitize(req.name), req.actor));
}
