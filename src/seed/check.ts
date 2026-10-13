/**
 * Read the seeded workspace back and compare it with the manifest.
 *
 * Tier 4. The point of the whole package is that this file can be written at all: a plan
 * nobody can state is a plan nothing can check.
 */
import { type Auth, RequestFailed, authHeaders, login as realLogin, rcapi } from '../core/rcapi';
import {
  dictGetChecked,
  hashableKey,
  toInt,
  iterateChecked,
  orElse,
  toTextAny,
  isTruthy,
  storedText,
} from '../lib/format';
import { loads as jsonLoads } from '../lib/json-text';

import { ABSENT, DISCUSSION, DM, GROUP_DM, TEAM_CHANNEL, TEAM_CHANNEL_PRIVATE } from './kinds';
import {
  type Plan,
  type RoomFacts,
  type RoomSpec,
  isPrivate,
  reacted as specReacted,
  replies as specReplies,
  roomFacts,
  totalMessages,
} from './plan';
import * as wording from './wording';

type Bag = Record<string, unknown>;
type Headers = Record<string, string>;

/**
 * `[body, why]`, the body as the seed reads an answer: `{}`, or whatever truthy JSON value
 * the answer held -- a mapping, and also a list, a string, a number. `null`: not read.
 */
type Get = (
  path: string,
  headers: Headers,
  params?: Record<string, string | number | boolean>,
) => Promise<[unknown, string]>;

type AsUser = (name: string) => Promise<Headers | null>;

type CountMessages = (
  rid: string,
  path: string,
  headers: Headers,
) => Promise<[number, number, number, string]>;

/**
 * THE READBACK READS AN ANSWER AS IT ALWAYS HAS, and stops where it always stopped.
 *
 * Every member read, `or`, loop and integer read applied to what Rocket.Chat sent follows
 * the established rules here (`dictGetChecked`, `orElse`, `iterateChecked`, `toInt`): a users.list
 * answering a JSON list raises `expected an object, got a list`, and a threads total of
 * `'abc'` raises `'abc' is not an integer`. `checkSeed` catches it, reports the readback as
 * unable to run (`ok: null`) and records NOTHING. This build read the same answers leniently -- the
 * list was an empty bag, `'abc'` was `Number()`'d to 0 -- so it carried on reading, reported
 * faults (or a clean readback) the established readback never reaches, and wrote them into
 * repro.json.
 */

/**
 * A room id as the readback carries it: the `_id` Rocket.Chat sent when it is truthy, which
 * is when the room counts as found. Rocket.Chat's is always a string; anything else is the
 * text the established client would put in the query for it.
 *
 * NOT REPRODUCED: a list or a mapping `_id`, which the established client would send as
 * repeated values.
 */
function ridOf(value: unknown): string {
  if (!isTruthy(value)) return '';
  return typeof value === 'string' ? value : storedText(value);
}

/** Read a discussion back: it is not found the way a channel is. */
async function readDiscussion(
  countMessages: CountMessages,
  f: RoomFacts,
  facts: readonly RoomFacts[],
  get: Get,
  hdr: Headers,
  rids: Map<string, string>,
  spec: RoomSpec,
): Promise<void> {
  const prid = rids.get(spec.parent);
  if (prid === undefined || prid === '') {
    // The parent's own row already says whether it is absent or merely unreadable;
    // repeating the guess here would double-count one fault.
    const parent = facts.find((x) => x.spec.name === spec.parent);
    if (parent !== undefined && !parent.found && parent.unreadable === '') return;
    f.unreadable = `parent '${spec.parent}' not readable`;
    return;
  }
  const [body, why] = await get('/api/v1/chat.getDiscussions', hdr, { roomId: prid, count: 100 });
  if (body === null) {
    if (why !== ABSENT) f.unreadable = why;
    return;
  }
  // Matched on the DISPLAY name: `rooms.createDiscussion` gives the room a generated slug
  // for its `name` and puts the title in `fname`, so a readback keyed on the name it was
  // asked for finds nothing at all.
  for (const m of iterateChecked(orElse(dictGetChecked(body, 'messages'), []))) {
    if (dictGetChecked(m, 'msg') === spec.name) {
      f.found = true;
      f.rid = ridOf(dictGetChecked(m, 'drid', ''));
      break;
    }
  }
  if (f.rid !== '') {
    const path = isPrivate(spec) ? '/api/v1/groups.messages' : '/api/v1/channels.messages';
    [f.messages, f.replies, f.reacted, f.unreadable] = await countMessages(f.rid, path, hdr);
  }
}

/** Read a dm back: it is not found the way a channel is. */
async function readDm(
  asUser: AsUser,
  countMessages: CountMessages,
  f: RoomFacts,
  get: Get,
  spec: RoomSpec,
): Promise<void> {
  const headers = await asUser(spec.members[0] as string);
  if (headers === null) {
    f.unreadable = `cannot sign in as ${String(spec.members[0])}`;
    return;
  }
  const [body, why] = await get('/api/v1/im.list', headers, { count: 0 });
  if (body === null) {
    f.unreadable = why;
    return;
  }
  const ims = dictGetChecked(body, 'ims');
  const list = isTruthy(ims) ? ims : orElse(dictGetChecked(body, 'update'), []);
  for (const room of iterateChecked(list)) {
    const participants = [...iterateChecked(orElse(dictGetChecked(room, 'usernames'), []))];
    if (
      participants.length === spec.members.length &&
      spec.members.every((name) => participants.includes(name))
    ) {
      f.found = true;
      f.rid = ridOf(dictGetChecked(room, '_id', ''));
      break;
    }
  }
  if (f.rid !== '') {
    [f.messages, f.replies, f.reacted, f.unreadable] = await countMessages(
      f.rid,
      '/api/v1/im.messages',
      headers,
    );
  }
}

/** Read every planned room back, and say what is actually in it. */
async function readRoomFacts(
  asUser: AsUser,
  countMessages: CountMessages,
  facts: RoomFacts[],
  get: Get,
  hdr: Headers,
  plan: Plan,
  rids: Map<string, string>,
): Promise<void> {
  for (const spec of plan.rooms) {
    const f = roomFacts(spec);
    facts.push(f);
    if (spec.kind === DM || spec.kind === GROUP_DM) {
      await readDm(asUser, countMessages, f, get, spec);
      continue;
    }
    if (spec.kind === DISCUSSION) {
      await readDiscussion(countMessages, f, facts, get, hdr, rids, spec);
      continue;
    }
    const infoPath = isPrivate(spec) ? '/api/v1/groups.info' : '/api/v1/channels.info';
    const [body, why] = await get(infoPath, hdr, { roomName: spec.name });
    if (body === null) {
      if (why !== ABSENT) f.unreadable = why;
      continue;
    }
    const channel = dictGetChecked(body, 'channel');
    const room = isTruthy(channel) ? channel : orElse(dictGetChecked(body, 'group'), {});
    f.rid = ridOf(dictGetChecked(room, '_id', ''));
    f.found = f.rid !== '';
    if (!f.found) continue;
    rids.set(spec.name, f.rid);
    const msgPath = isPrivate(spec) ? '/api/v1/groups.messages' : '/api/v1/channels.messages';
    [f.messages, f.replies, f.reacted, f.unreadable] = await countMessages(f.rid, msgPath, hdr);
    const [tl] = await get('/api/v1/chat.getThreadsList', hdr, { rid: f.rid, count: 100 });
    // The total, or 0, read by `toInt`, whose RangeError ends the readback.
    if (tl !== null) f.threads = toInt(orElse(dictGetChecked(tl, 'total'), 0));
    if (spec.parent !== '' && (spec.kind === TEAM_CHANNEL || spec.kind === TEAM_CHANNEL_PRIVATE)) {
      // A channel can exist and NOT be in the team, which looks identical from
      // `channels.info` and is the whole difference between a team workspace and a
      // workspace with similarly-named channels.
      f.inTeam = await wording.inTeam(get, hdr, spec.parent, spec.name);
    }
  }
}

/**
 * The answer as the seed reads it: the body read as JSON (a `NaN` total is a float, which
 * `toInt` refuses), anything falsy made `{}` by `orElse`, and `{}` for a body that is not
 * JSON. A truthy list, string or number is handed back as it arrived, where `apply.json`
 * makes a scalar `{}`: the readback is where the next member read (`dictGetChecked`) raises on
 * it.
 */
function answerOf(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = jsonLoads(text);
  } catch {
    return {};
  }
  return orElse(parsed, {});
}

/** The three reads this needs, sharing one cache of what was asked. */
function readers(
  base: string,
  cache: Map<string, Headers>,
  login: typeof realLogin,
  rootUrl: string,
): { asUser: AsUser; countMessages: CountMessages; get: Get } {
  /**
   * `(body, why)`. `why` is "" on success and `ABSENT` when the room is gone.
   *
   * Rocket.Chat answers a lookup for a room that does not exist with HTTP 400 and
   * `errorType: error-room-not-found`, which is an ANSWER, not a failure to ask -- and the
   * difference is the whole verdict. Treating it as "could not read" filed a deleted room
   * under `unreadable`, where nothing counts it as a fault, so a workspace missing a room
   * verified clean. Found live, by deleting one and watching the check pass.
   */
  const get: Get = async (path, headers, params) => {
    let status: number;
    let text: string;
    try {
      [status, text] = await rcapi.call(base, 'GET', path, {
        extraHeaders: headers,
        ...(params !== undefined ? { params } : {}),
        timeoutMs: 30_000,
      });
    } catch (error) {
      if (error instanceof RequestFailed) return [null, error.message];
      throw error;
    }
    if (status >= 400) {
      // A 400 or a 404 only: the body is asked only for those two.
      if (
        (status === 400 || status === 404) &&
        toTextAny(dictGetChecked(answerOf(text), 'errorType', '')).includes('not-found')
      ) {
        return [null, ABSENT];
      }
      return [null, `HTTP ${String(status)}`];
    }
    return [answerOf(text), ''];
  };

  const asUser: AsUser = async (name) => {
    if (!cache.has(name)) {
      try {
        const auth = await login(rootUrl, { user: name, password: name });
        cache.set(name, { ...authHeaders(auth), 'Content-Type': 'application/json' });
      } catch {
        // reported as unreadable, never a fault
        cache.set(name, {});
      }
    }
    const headers = cache.get(name);
    return headers !== undefined && Object.keys(headers).length > 0 ? headers : null;
  };

  /**
   * `(content messages, replies, reacted, why)`.
   *
   * All three come out of ONE listing: a reacted message carries a `reactions` object and a
   * reply carries a `tmid`, so asking per message would be N calls for facts the room
   * already handed over.
   */
  const countMessages: CountMessages = async (rid, path, headers) => {
    const [body, why] = await get(path, headers, { roomId: rid, count: 0 });
    if (body === null) return [0, 0, 0, why];
    const msgs = iterateChecked(orElse(dictGetChecked(body, 'messages'), [])).filter((m) =>
      wording.isContent(m),
    );
    return [
      msgs.length,
      msgs.filter((m) => isTruthy(dictGetChecked(m, 'tmid'))).length,
      msgs.filter((m) => isTruthy(dictGetChecked(m, 'reactions'))).length,
      '',
    ];
  };

  return { asUser, countMessages, get };
}

export interface Facts {
  readonly rooms: RoomFacts[];
  readonly users_found: string[];
  readonly users_unreadable: string;
  readonly planned_users: string[];
}

export interface ReadbackOptions {
  /** Injectable so a test does not need a server. */
  readonly login?: typeof realLogin;
  /**
   * The sessions the SEEDER already minted, and passing them is not an optimisation.
   *
   * Seeding turns email-2FA off for its own logins and turns it back on afterwards -- so by
   * the time this runs, signing in as a user needs a code from a mailbox that does not
   * exist, and every DM comes back "cannot sign in". On a workspace with 2FA off the
   * fallback login works and this can be called on its own.
   */
  readonly tokens?: Record<string, Auth>;
}

/**
 * Re-read the seeded workspace and report what is actually there.
 *
 * Reads as the ADMIN wherever the admin can see the room, and as a participant where it
 * cannot: a direct message belongs to its two users and is invisible to everyone else, so a
 * readback that only used the admin token would report every DM missing.
 */
export async function readback(
  rootUrl: string,
  admin: Auth,
  plan: Plan,
  options: ReadbackOptions = {},
): Promise<Facts> {
  const base = rootUrl.replace(/\/+$/u, '');
  const hdr: Headers = { ...authHeaders(admin), 'Content-Type': 'application/json' };
  const cache = new Map<string, Headers>();
  for (const [name, auth] of Object.entries(options.tokens ?? {})) {
    cache.set(name, { ...authHeaders(auth), 'Content-Type': 'application/json' });
  }

  const { asUser, countMessages, get } = readers(base, cache, options.login ?? realLogin, rootUrl);

  const facts: RoomFacts[] = [];
  const rids = new Map<string, string>();
  await readRoomFacts(asUser, countMessages, facts, get, hdr, plan, rids);

  const [users, why] = await get('/api/v1/users.list', hdr, { count: 0 });
  // The set of usernames the answer holds: a username that is a list or a mapping is
  // refused by `hashableKey`, and only a string can match a planned name.
  const known = new Set<unknown>();
  if (users !== null) {
    for (const u of iterateChecked(orElse(dictGetChecked(users, 'users'), []))) {
      known.add(hashableKey(dictGetChecked(u, 'username')));
    }
  }
  const plannedUsers: string[] = [];
  for (let i = 0; i < plan.users; i += 1) plannedUsers.push(wording.username(i));
  return {
    rooms: facts,
    users_found: plannedUsers.filter((u) => known.has(u)).sort(),
    users_unreadable: users === null ? why : '',
    planned_users: plannedUsers,
  };
}

export interface Fault {
  readonly kind: string;
  readonly room: string;
  readonly want: unknown;
  readonly got: unknown;
  readonly detail: string;
}

export interface Verdict {
  readonly ok: boolean | null;
  readonly faults: Fault[];
  readonly extra: Bag[];
  readonly unreadable: Bag[];
  readonly checked: number;
  readonly rooms: Bag[];
}

/** Every way what is there can differ from what the plan asked for. */
function collectFaults(extra: Bag[], facts: Facts, faults: Fault[], unreadable: Bag[]): void {
  const fault = (kind: string, name: string, want: unknown, got: unknown, detail = ''): void => {
    faults.push({ kind, room: name, want, got, detail });
  };

  /**
   * A count that disagrees -- and WHICH WAY it disagrees decides everything.
   *
   * Seeding only ever adds, so `got > want` cannot be evidence that this run lost anything:
   * the room already held content, which is what a second `houston seed`, a preset that
   * posts on boot, or a restored backup all look like. Reported, because a reader comparing
   * against the manifest should know, but never as a fault -- gating on exact equality is
   * what made the earlier version of this refuse a workspace that was working.
   *
   * `got < want` is the real signal: something was asked for and is not there.
   */
  const counted = (kind: string, name: string, want: number, got: number): void => {
    if (got < want) fault(kind, name, want, got);
    else if (got > want) extra.push({ kind, room: name, want, got });
  };

  const missingUsers = facts.planned_users.filter((u) => !facts.users_found.includes(u));
  if (facts.users_unreadable !== '') {
    unreadable.push({ what: 'users', why: facts.users_unreadable });
  } else if (missingUsers.length > 0) {
    fault(
      'users',
      '',
      facts.planned_users.length,
      facts.users_found.length,
      missingUsers.slice(0, 5).join(', '),
    );
  }

  for (const f of facts.rooms) {
    const spec = f.spec;
    if (f.unreadable !== '') {
      unreadable.push({ what: spec.name, why: f.unreadable });
      continue;
    }
    if (!f.found) {
      fault('missing', spec.name, spec.kind, 'absent');
      continue;
    }
    counted('messages', spec.name, totalMessages(spec), f.messages);
    counted('threads', spec.name, specReplies(spec), f.replies);
    counted('reactions', spec.name, specReacted(spec), f.reacted);
    if (!f.inTeam) fault('team', spec.name, `in ${spec.parent}`, 'not in the team');
  }
}

/**
 * Compare the manifest with what was read back.
 *
 * Returns findings, never throws: whether a mismatch should end the command is the
 * CALLER's decision, and the default is that it should not. A verifier that fails a healthy
 * workspace teaches people to pass the override by reflex, and then it is protecting
 * nothing -- which is exactly what happened to the version of this that shipped with an
 * exact-equality gate and a known-lossy seeder.
 */
export function verify(plan: Plan, facts: Facts): Verdict {
  const faults: Fault[] = [];
  const extra: Bag[] = [];
  const unreadable: Bag[] = [];

  collectFaults(extra, facts, faults, unreadable);
  for (const room of plan.rooms)
    if (!facts.rooms.some((f) => f.spec.name === room.name && f.spec.kind === room.kind))
      unreadable.push({ what: room.name, why: 'no readback result' });
  // A discussion's ANCHOR is checked by that message count, not separately: one opened from
  // a message arrives holding ANCHOR_MESSAGES it did not post, so a `pmid` that silently
  // stopped being sent makes the room come back two short -- a fault, named by room. That is
  // not a happy accident; it is why the anchor is in the plan instead of being subtracted
  // out. The variant was dead code for a while (discussions were created before their
  // parents had said anything) and nothing noticed, which is what this now prevents.
  return {
    ok: faults.length > 0 ? false : unreadable.length > 0 ? null : true,
    faults,
    extra,
    unreadable,
    checked: facts.rooms.filter((f) => f.unreadable === '').length,
    rooms: facts.rooms.map((f) => ({
      kind: f.spec.kind,
      name: f.spec.name,
      found: f.found,
      messages: f.messages,
      want_messages: totalMessages(f.spec),
      replies: f.replies,
      want_replies: specReplies(f.spec),
      reacted: f.reacted,
      want_reacted: specReacted(f.spec),
      threads: f.threads,
      in_team: f.inTeam,
      unreadable: f.unreadable,
    })),
  };
}
