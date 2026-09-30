/**
 * Who owns a workspace, and who may destroy or hand over one.
 *
 * Tier 1. The gate is deliberately policy-driven rather than hard-coded: `mayDestroy` and
 * `mayChown` read the box's configured policy, and the default lets an admin act for
 * everybody -- which is why the GUI's route roles cannot be the only check and why these live
 * in the service layer.
 */
import * as config from '../../lib/config';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import {
  quotedText,
  toTextAny,
  stripText,
  isTruthy,
  expectedText,
  storedText,
} from '../../lib/format';
import { actor as auditActor, record as auditRecord } from '../audit';
import { type Metadata, readMeta, updateMeta } from '../runner/record';
import { anyUsers, atLeast, roleOf } from '../users';

import * as naming from './naming';
import { CREATE_POLICY_KEY, DESTROY_POLICY_KEY } from './types';

/** The current UTC time in ISO 8601, to the second, with a `+00:00` offset. */
function isoSeconds(): string {
  return `${new Date().toISOString().slice(0, 19)}+00:00`;
}

/**
 * `meta.extra` when it is a mapping, else `{}`.
 *
 * `extra` is whatever the record holds, and a hand-edited one can hold null, a list or a
 * string there. This read `meta.extra` unchecked: a null crashed `chown` with a TypeError
 * stack where the established answer hands the workspace over, a string crashed inside the
 * write, and a list took the owner as an ARRAY PROPERTY that JSON.stringify drops, so
 * `chown` said the handover succeeded and repro.json kept the list.
 */
function bagOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * The items of what a JSON record holds: a list's items, a string's characters, a
 * mapping's keys. Anything else is a TypeError, which nothing on the way up catches.
 *
 * The history was kept only when it was an array, so an `owner_history` of `{"k": "v"}` or
 * `"ab"` was dropped where the established reading keeps `["k", ...]` or `["a", "b", ...]`,
 * and a `5` was written over where the established answer stops before writing anything.
 */
function listChecked(value: unknown): unknown[] {
  if (Array.isArray(value)) return [...value];
  if (typeof value === 'string') return Array.from(value);
  if (value !== null && typeof value === 'object') return Object.keys(value);
  throw new TypeError(expectedText('a list', value));
}

/**
 * Who owns `name` NOW, or "" for a pre-team workspace or one that is gone.
 *
 * `owner` wins over `created_by`, which is deliberately immutable: who made a workspace
 * is a fact about the past and stays in the record, while who is responsible for it today
 * is a thing that changes when a ticket is handed over.
 *
 * The RAW value: `owner` when it is truthy, else `created_by` as recorded, else "". This
 * stringified it and dropped a falsy `created_by`, so an `owner` of 123 matched the actor
 * "123" and the gate let a member take a workspace they have always been refused, and the
 * history's `from` became "123" for 123 and "" for a `created_by` of 0 or null.
 */
export async function ownerOf(name: string): Promise<unknown> {
  let meta: Metadata;
  try {
    meta = await readMeta(name);
  } catch {
    return '';
  }
  const extra = bagOf(meta.extra);
  if (isTruthy(extra.owner)) return extra.owner;
  return Object.hasOwn(extra, 'created_by') ? extra.created_by : '';
}

/**
 * Hand a workspace over. Returns {name, from, to}.
 *
 * Ownership is a real verb because the workflow team-server.md §3.3 was written around --
 * support engineers handing tickets to each other -- was never modelled at all: the
 * record only ever knew who typed `up`.
 */
export async function setOwner(
  name: string,
  to: string,
  { by = '' } = {},
): Promise<{
  name: string;
  from: unknown;
  to: string;
}> {
  const target = await naming.resolveName(name);
  // Enforced HERE, beside the mutation, exactly as `teardown` enforces `mayDestroy`: the
  // CLI and the GUI both reach this function, and a check at either front end alone would
  // leave the other open.
  const [allowed, why] = await mayChown(target, by || auditActor());
  if (!allowed) {
    auditRecord('chown', target, { outcome: 'denied' });
    throw new ConflictError(why);
  }
  // `stripText`: `trim()` kept a leading \x1f or NEL that `stripText` strips and stripped a BOM
  // it keeps, so the recorded owner differed from the one earlier releases record.
  const owner = stripText(to || '').toLowerCase();
  if (!owner) throw new ValidationError('no new owner given (--to <name>)');
  // `quotedText(owner)`, where this hard-coded single quotes: `--to "O'Brien"` printed
  // `'o'brien'` where the established message says `"o'brien"`, and a backslash went
  // unescaped.
  if (anyUsers() && !roleOf(owner)) {
    throw new NotFoundError(
      `no account named ${quotedText(owner)} (see \`houston users list\`) — a workspace ` +
        'cannot be handed to somebody who cannot sign in',
    );
  }
  const was = await ownerOf(target);
  const byWhom = by || auditActor();

  await updateMeta(target, (meta: Metadata) => {
    const extra = bagOf(meta.extra);
    const history = listChecked(isTruthy(extra.owner_history) ? extra.owner_history : []);
    history.push({ from: was, to: owner, by: byWhom, at: isoSeconds() });
    extra.owner = owner;
    extra.owner_history = history.slice(-20);
    meta.extra = extra;
  });
  // audit.log is a record both releases append to: the stored spelling, as it always was.
  auditRecord('chown', `${target} ${storedText(isTruthy(was) ? was : '-')} -> ${owner}`);
  return { name: target, from: was, to: owner };
}

/**
 * Whether `actor` may set rcImage / regToken / bind on a create.
 *
 * Open unless the box has explicitly narrowed it. Note the asymmetry with `mayDestroy`
 * below, which defaults the OTHER way and should: destroying somebody else's workspace
 * loses a colleague's in-progress work, and no create field does that.
 */
export function maySetPrivilegedFields(actor: string): boolean {
  if (config.loadConfig()[CREATE_POLICY_KEY] !== 'admin') return true;
  if (!actor) return true; // no accounts on this box: nothing to bound
  return atLeast(roleOf(actor), 'admin');
}

/**
 * (allowed, the current owner when refusing). The ownership rule itself.
 *
 * ONE implementation, because two operations apply it and they must not drift:
 * `mayDestroy` and `mayChown`. Reassigning a workspace is not a lesser act than
 * destroying it -- it is the act that DECIDES who may destroy it.
 */
export async function ownerGate(name: string, actor: string): Promise<[boolean, string]> {
  if (config.loadConfig()[DESTROY_POLICY_KEY] === 'anyone') return [true, ''];
  if (!actor) return [true, '']; // no accounts on this box: nothing to bound
  if (roleOf(actor) === 'admin') return [true, ''];
  const owner = await ownerOf(name);
  // The owner equals the actor only as the same string: an int 123 against the actor
  // "123" is not, and the refusal names the owner as `toTextAny` spells it.
  if (!isTruthy(owner) || owner === actor) return [true, ''];
  return [false, toTextAny(owner)];
}

/** (allowed, why not). Advisory for a front end, enforced by `teardown`. */
export async function mayDestroy(name: string, actor: string): Promise<[boolean, string]> {
  const [allowed, owner] = await ownerGate(name, actor);
  if (allowed) return [true, ''];
  // The old message told the refused caller to run `chown --to <themselves>`, which was
  // accurate -- `setOwner` was ungated, so following the refusal defeated it in one
  // command. It is gated now, so the advice names who can actually run it.
  return [
    false,
    `${name} belongs to ${owner} — ask ${owner}, or an admin can ` +
      `force it. (${owner} or an admin can run ` +
      `\`houston chown -n ${name} --to ${actor}\` to hand it over ` +
      'for good.)',
  ];
}

/**
 * (allowed, why not). Advisory for a front end, enforced by `setOwner`.
 *
 * `POST /api/repros/{name}/owner` is member+ and this was not checked at all, so a member
 * who had just been refused a destroy could reassign the workspace to themselves and
 * destroy it on the next call -- two HTTP requests, both audited, neither prevented.
 */
export async function mayChown(name: string, actor: string): Promise<[boolean, string]> {
  const [allowed, owner] = await ownerGate(name, actor);
  if (allowed) return [true, ''];
  return [
    false,
    `${name} belongs to ${owner} — only ${owner} or an admin can ` +
      'hand it over. Taking ownership is what decides who may ' +
      'destroy a workspace, so it is gated the same way as ' +
      '`down --volumes`.',
  ];
}
