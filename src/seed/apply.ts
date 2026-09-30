/**
 * Create everything the plan names, over REST.
 *
 * Tier 3. Every call goes through the RC HTTP seam (`seams/rc-http`) rather than a bare
 * fetch, because `only-exec-launches-processes` has a twin rule for the network: one place
 * decides timeouts, redirects and query encoding.
 */
import * as config from '../lib/config';
import { Timings } from '../perf/timings';
import { Interrupted, cleanup, unwindsOnInterrupt } from '../seams/exec';

import * as journal from '../core/journal';
import {
  type Auth,
  RequestFailed,
  authHeaders,
  getSetting,
  login as realLogin,
  rcapi,
  setSetting,
} from '../core/rcapi';

import { DISCUSSION, DM, GENERAL, TEAM, TEAM_PRIVATE } from './kinds';
import {
  type Made,
  type Plan,
  type RoomSpec,
  byKind,
  isPrivate,
  made as makeMade,
  planTotalMessages,
  planTotalReplies,
} from './plan';
import * as wording from './wording';

type Bag = Record<string, unknown>;
type Headers = Record<string, string>;
type Log = (message: string) => void;

/**
 * What one REST exchange gives back: the status and the body text, as `rcapi.call` returns
 * them, plus the two derived things every call site here asks for.
 *
 * `null` means a TRANSPORT failure -- `RequestFailed`, not a 4xx. The distinction is
 * load-bearing: `im.create` answering 403 still counted as a DM and still fired a doomed
 * postMessage, and the count landed in the performance report as workload that was never
 * created.
 */
export interface Answer {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
}

type Post = (path: string, headers: Headers, payload: Bag) => Promise<Answer | null>;

/** `rcapi.call`, in the shape this module reads answers in. */
async function callRc(
  rootUrl: string,
  method: string,
  path: string,
  headers: Headers,
  options: { data?: unknown; params?: Record<string, string | number | boolean> } = {},
): Promise<Answer | null> {
  try {
    const [status, text] = await rcapi.call(rootUrl, method, path, {
      extraHeaders: headers,
      ...(options.data === undefined ? {} : { data: options.data }),
      ...(options.params === undefined ? {} : { params: options.params }),
      timeoutMs: 30_000,
    });
    return { status, ok: status < 400, text };
  } catch (error) {
    if (error instanceof RequestFailed) return null;
    throw error;
  }
}

/** The established truthiness, for a setting read back off the wire. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

const EMAIL_2FA = 'Accounts_TwoFactorAuthentication_By_Email_Enabled';
const RATE_LIMITER = 'API_Enable_Rate_Limiter';

/**
 * A response's JSON body, or `{}`.
 *
 * `.ok` is true for any 2xx, and a front proxy (Traefik fronts the multi-instance preset)
 * can answer 200 with an HTML error page -- a raw parse error there would abort the entire
 * seed mid-way.
 */
export function json(resp: Answer | null): Bag {
  if (resp === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(resp.text);
  } catch {
    return {};
  }
  // The body, or `{}`: an EMPTY object or list collapses to `{}` and a non-empty list is
  // handed back as it arrived. A body that is a bare scalar is the one shape answered
  // differently from the established reading, which keeps it and raises on the next member
  // read; no Rocket.Chat endpoint returns one.
  if (Array.isArray(parsed)) return parsed.length > 0 ? (parsed as unknown as Bag) : {};
  if (parsed !== null && typeof parsed === 'object') {
    return Object.keys(parsed).length > 0 ? (parsed as Bag) : {};
  }
  return {};
}

/** The posted message's `_id`, or null. */
export function messageId(resp: Answer | null): string | null {
  const message = (json(resp).message ?? {}) as Bag;
  const id = message._id;
  return typeof id === 'string' && id !== '' ? id : null;
}

function roomId(body: Bag): string {
  for (const key of ['channel', 'group', 'room', 'discussion']) {
    const rid = ((body[key] ?? {}) as Bag)._id;
    if (typeof rid === 'string' && rid !== '') return rid;
  }
  return '';
}

/** Turn off the two settings that would make seeding fail, and journal both. */
export async function quiesceSettings(
  set: (settingId: string, value: unknown) => Promise<boolean>,
  admin: Auth,
  adminPassword: string,
  log: Log,
  rootUrl: string,
): Promise<{ email2faChanged: boolean; limiterPrev: unknown }> {
  // Make seeding possible/fast: new users' logins are not blocked by email-2FA, and bulk
  // calls are not throttled. Both settings are restored to their PRIOR values afterwards
  // -- in a finally, so a mid-seed crash cannot leave the workspace's security settings
  // silently changed.
  //
  // "UNREADABLE" IS NOT "WAS ON". The old rule restored ON for both, so a single transient
  // 500 -- likely, since seeding starts the moment RC answers -- turned email-2FA on for
  // the ldap / saml / oidc / livechat presets, which deliberately switch it OFF because
  // their users have no mailbox here. Only touch a value that was actually observed, and
  // only put back what was actually changed.
  const email2faPrev = await getSetting(rootUrl, admin, adminPassword, EMAIL_2FA);
  const limiterPrev = await getSetting(rootUrl, admin, adminPassword, RATE_LIMITER);
  let email2faChanged = false;
  const authorshipWarning =
    'seeded users may not be loginable, so messages will be authored by admin';
  if (email2faPrev === null || email2faPrev === undefined) {
    log(`  ⚠ could not read the email-2FA setting — leaving it alone; ${authorshipWarning}`);
  } else if (truthy(email2faPrev)) {
    email2faChanged = await set(EMAIL_2FA, false);
    if (!email2faChanged) {
      // Previously silent: the bool was discarded, so a failed disable surfaced only as
      // "0 usable as authors" further down.
      log(`  ⚠ could not disable email-2FA — ${authorshipWarning}`);
    }
  }
  return { email2faChanged, limiterPrev };
}

export interface SeedOptions {
  readonly log?: Log;
  readonly workspace?: string;
  /**
   * Filled with the per-user sessions this created, for a readback that has to look at a
   * DM. An out-parameter rather than a key in the result: the result is written into
   * `repro.json` and rendered in a browser, and a session token has no business in either.
   */
  readonly tokensOut?: Record<string, Auth>;
  readonly adminPassword?: string;
  /** Injected for the spec, which has no server to log into. */
  readonly login?: typeof realLogin;
}

/** Seed the repro. `log(msg)` is called with progress lines. */
export async function seed(
  rootUrl: string,
  admin: Auth,
  plan: Plan,
  options: SeedOptions = {},
): Promise<Bag> {
  const log = options.log ?? (() => undefined);
  const workspace = options.workspace ?? '';
  const base = rootUrl.replace(/\/+$/u, '');
  // The workspace's own admin password, falling back to the shared loopback one -- the
  // same fallback `record.adminPass` applies from the other side. `setSetting`
  // re-authenticates for a 2FA-guarded change, so a wrong password here fails the settings
  // step of a seed that had otherwise worked.
  const adminPassword = (options.adminPassword ?? '') || config.ADMIN_PASSWORD;
  const adminHdr: Headers = { ...authHeaders(admin), 'Content-Type': 'application/json' };

  const post: Post = async (path, headers, payload) =>
    await callRc(base, 'POST', path, headers, { data: payload });

  const set = async (settingId: string, value: unknown): Promise<boolean> =>
    await setSetting(rootUrl, admin, adminPassword, settingId, value);

  const { email2faChanged, limiterPrev } = await quiesceSettings(
    set,
    admin,
    adminPassword,
    log,
    rootUrl,
  );
  // JOURNALLED, both of them. The `finally` below is the only thing that puts these back,
  // and it is exactly the block a SIGKILL, an OOM or a `systemctl restart` does not run. A
  // GUI seed of the `large` profile is minutes long against `jobs.drain`'s 25 seconds, so
  // this is a routine interruption, not an exotic one -- and what survives is a workspace
  // with the rate limiter AND email-2FA off, silently different from the one somebody is
  // about to measure, with nothing on disk for `doctor` or `serve`'s recovery to find.
  // `workspace` is optional so the pure seed path stays callable without a name; every
  // real caller passes it.
  let limiterNote = '';
  let email2faNote = '';
  if (limiterPrev === true) {
    if (workspace !== '') limiterNote = journal.record(journal.RATE_LIMITER_OFF, workspace);
    if (!(await set(RATE_LIMITER, false))) {
      journal.clear(limiterNote);
      limiterNote = '';
      log('  ⚠ could not disable the API rate limiter — seed rates may be throttled');
    }
  }
  if (email2faChanged && workspace !== '') {
    email2faNote = journal.record(journal.EMAIL_2FA_OFF, workspace);
  }

  // UNWOUND by a Ctrl-C, and this `finally` a cleanup the interrupt runs: the rate limiter
  // and email-2FA go back on and their notes are cleared. With `process.exit(130)` a seed
  // interrupted mid-way left both OFF and both notes on disk, which must never happen. The
  // one catch in the body that is an ordinary-failure handler, the user login's, rethrows it.
  try {
    return await unwindsOnInterrupt(
      async () => await seedBody(rootUrl, adminHdr, plan, post, log, options),
    );
  } finally {
    await cleanup(async () => {
      if (limiterPrev === true) {
        if (await set(RATE_LIMITER, true)) journal.clear(limiterNote);
      }
      if (email2faChanged) {
        if (await set(EMAIL_2FA, true)) journal.clear(email2faNote);
      }
    });
  }
}

type Timed = (
  bucket: string,
  path: string,
  headers: Headers,
  payload: Bag,
) => Promise<Answer | null>;

/** A plain public or private channel, which is what most of the plan is. */
async function makeAChannel(
  lookup: (spec: RoomSpec) => Promise<string>,
  adminHdr: Headers,
  made: Map<string, Made>,
  members: string[],
  rec: Made,
  spec: RoomSpec,
  timed: Timed,
): Promise<void> {
  // A plain channel or group, standalone or inside a team. `extraData.teamId` puts it in
  // the team in ONE call -- `teams.createRoom` does not exist on 8.5.1 (404), and
  // create-then-`teams.addRooms` is two round trips for the same result.
  const path = isPrivate(spec) ? '/api/v1/groups.create' : '/api/v1/channels.create';
  const payload: Bag = { name: spec.name, members };
  if (spec.parent !== '') {
    const team = made.get(spec.parent);
    if (team !== undefined && team.teamId !== '') payload.extraData = { teamId: team.teamId };
  }
  const r = await timed('channels', path, adminHdr, payload);
  if (r !== null && r.ok) {
    rec.rid = roomId(json(r));
  } else {
    rec.rid = await lookup(spec);
    rec.reused = true;
    if (rec.rid === '') rec.failed = 'create';
  }
}

/** Create the team or team-private kind, which is not made the way a channel is. */
async function makeTeam(
  lookup: (spec: RoomSpec) => Promise<string>,
  adminHdr: Headers,
  members: string[],
  rec: Made,
  spec: RoomSpec,
  timed: Timed,
): Promise<void> {
  const r = await timed('channels', '/api/v1/teams.create', adminHdr, {
    name: spec.name,
    type: isPrivate(spec) ? 1 : 0,
    members,
  });
  const body = json(r);
  if (r !== null && r.ok) {
    const team = (body.team ?? {}) as Bag;
    rec.teamId = typeof team._id === 'string' ? team._id : '';
    rec.rid = typeof team.roomId === 'string' ? team.roomId : '';
  } else {
    rec.rid = await lookup(spec);
    rec.reused = true;
    if (rec.rid === '') rec.failed = 'teams.create';
  }
}

/** Create the dm kind, which is not made the way a channel is. */
async function makeDm(
  adminHdr: Headers,
  rec: Made,
  spec: RoomSpec,
  timed: Timed,
  tokens: Map<string, Auth>,
): Promise<void> {
  const owner = spec.members[0] as string;
  const auth = tokens.get(owner);
  const hdr: Headers =
    auth !== undefined ? { ...authHeaders(auth), 'Content-Type': 'application/json' } : adminHdr;
  const r = await timed('dms', '/api/v1/im.create', hdr, { username: spec.members[1] });
  // `post()` returns null only on a TRANSPORT error, so a 400/403 (revoked create-d
  // permission, Accounts_Direct_Message_Max_Users) still counted as a DM and still fired a
  // doomed postMessage. The reported count then landed in the performance report as
  // workload that was never created.
  if (r === null || !r.ok) {
    rec.failed = 'im.create';
    return;
  }
  rec.rid = roomId(json(r));
}

/** Create every room the plan names, in the order the plan puts them in. */
async function makeRooms(
  adminHdr: Headers,
  made: Map<string, Made>,
  plan: Plan,
  rootUrl: string,
  timed: Timed,
  tokens: Map<string, Auth>,
): Promise<void> {
  /**
   * The id of a room that already exists, so a re-seed adds to it.
   *
   * A second `houston seed` used to abandon a private group it had not created this run
   * (its freshly-sampled members were not in it, so every post 400'd). With a deterministic
   * manifest the membership is the same on every run, so the room can simply be reused --
   * and the readback reports the totals, which is a better answer than silently doing less.
   */
  const lookup = async (spec: RoomSpec): Promise<string> => {
    const path = isPrivate(spec) ? '/api/v1/groups.info' : '/api/v1/channels.info';
    const r = await callRc(rootUrl, 'GET', path, adminHdr, { params: { roomName: spec.name } });
    return r !== null && r.ok ? roomId(json(r)) : '';
  };

  // 2. Rooms, in the manifest's order (a team before its channels, a parent before its
  //    discussions). Every call goes through `timed`, so the buckets add up without an
  //    outer wrapper subtracting one from another.
  for (const spec of plan.rooms) {
    const rec = makeMade(spec);
    made.set(spec.name, rec);
    const members = [...spec.members];
    if (spec.kind === DISCUSSION) {
      // NOT here. Half of them are meant to hang off a MESSAGE in the parent, and at this
      // point no message has been posted anywhere -- so the `pmid` branch could never fire
      // and every discussion came out attached to the room instead. The whole variant was
      // dead code, silently. They are created in their own pass below, after the parents
      // have said something.
      continue;
    }
    if (spec.kind === GENERAL) {
      // Not created -- every workspace ships it. Looked up, because messages go by rid and
      // a name would not reach a renamed default room.
      rec.rid = await lookup(spec);
      if (rec.rid === '') rec.failed = 'general not found';
      continue;
    }
    if (spec.kind === DM) {
      await makeDm(adminHdr, rec, spec, timed, tokens);
      continue;
    }
    if (spec.kind === TEAM || spec.kind === TEAM_PRIVATE) {
      await makeTeam(lookup, adminHdr, members, rec, spec, timed);
      continue;
    }
    await makeAChannel(lookup, adminHdr, made, members, rec, spec, timed);
  }
}

/** The discussions, once every room has its messages. */
async function sendReplies(
  adminHdr: Headers,
  fill: (ordinal: number, rec: Made) => Promise<void>,
  made: Map<string, Made>,
  ordinals: Map<string, number>,
  timed: Timed,
): Promise<void> {
  // 4. Discussions LAST, so the half that hang off a message have one to hang off.
  for (const [name, rec] of made) {
    const spec = rec.spec;
    if (spec.kind !== DISCUSSION) continue;
    const parent = made.get(spec.parent);
    if (parent === undefined || parent.rid === '') {
      rec.failed = 'no parent room';
      continue;
    }
    const payload: Bag = { prid: parent.rid, t_name: spec.name, users: [...spec.members] };
    if (spec.fromMessage >= 0 && spec.fromMessage < parent.messageIds.length) {
      // Opened FROM a message, which is how a support engineer usually makes one, and which
      // leaves a different system message in the parent.
      payload.pmid = parent.messageIds[spec.fromMessage];
      payload.reply = wording.REPLIES[spec.fromMessage % wording.REPLIES.length];
    }
    const r = await timed('channels', '/api/v1/rooms.createDiscussion', adminHdr, payload);
    if (r === null || !r.ok) {
      rec.failed = 'rooms.createDiscussion';
      continue;
    }
    rec.rid = roomId(json(r));
    await fill(ordinals.get(name) ?? 0, rec);
  }
}

/** Put the messages, threads and reactions into the rooms that were made. */
async function fillRooms(
  adminHdr: Headers,
  durs: Record<string, number>,
  hdrFor: (members: readonly string[], turn: number) => Headers,
  made: Map<string, Made>,
  msg: Timings,
  post: Post,
  timed: Timed,
): Promise<void> {
  // 3. Messages, threads and reactions. One call shape for every room kind:
  //    chat.sendMessage against an rid. A discussion's `name` is a generated slug rather
  //    than its title, so addressing rooms by `#name` -- as this used to -- cannot reach
  //    one at all.
  const fill = async (ordinal: number, rec: Made): Promise<void> => {
    const spec = rec.spec;
    if (rec.rid === '') return;
    const bucket = spec.kind === DM ? 'dms' : 'messages';
    for (let i = 0; i < spec.messages; i += 1) {
      // Stride 7 against a pool of 16 is coprime, so a room walks the whole pool before
      // repeating; the room's ordinal offsets it so two rooms do not open with the same
      // line. The first cut multiplied by the count of messages ALREADY posted, which made
      // the effective stride 8 -- half the pool size -- and every room said "Hey team, any
      // update on this?" three times out of five.
      const body = {
        rid: rec.rid,
        msg: wording.MESSAGES[(ordinal * 5 + i * 7) % wording.MESSAGES.length],
      };
      const t = monotonic();
      const r = await post('/api/v1/chat.sendMessage', hdrFor(spec.members, i), { message: body });
      const dt = monotonic() - t;
      durs[bucket] = (durs[bucket] ?? 0) + dt;
      if (r === null || !r.ok) continue;
      msg.add(dt * 1000);
      rec.messages += 1;
      const mid = messageId(r);
      if (mid !== null) rec.messageIds.push(mid);
      if (spec.threads.includes(i) && mid !== null) {
        // THE THREAD. `chat.postMessage` with a `tmid` answers 400, so every reply this
        // module used to attempt was lost and no thread was ever created -- while `rich`
        // profiles advertised them. `chat.sendMessage` takes the whole message object,
        // `tmid` included, and is what the client itself uses.
        const tr = await timed(bucket, '/api/v1/chat.sendMessage', hdrFor(spec.members, i + 1), {
          message: { rid: rec.rid, tmid: mid, msg: wording.REPLIES[i % wording.REPLIES.length] },
        });
        if (tr !== null && tr.ok) rec.replies += 1;
      }
      if (mid !== null && spec.reactions.includes(i)) {
        const rr = await timed(bucket, '/api/v1/chat.react', hdrFor(spec.members, i), {
          messageId: mid,
          emoji: wording.EMOJI[i % wording.EMOJI.length],
        });
        if (rr !== null && rr.ok) rec.reactions += 1;
      }
    }
  };

  const ordinals = new Map<string, number>();
  let n = 0;
  for (const name of made.keys()) {
    ordinals.set(name, n);
    n += 1;
  }
  for (const [name, rec] of made) {
    if (rec.spec.kind !== DISCUSSION) await fill(ordinals.get(name) ?? 0, rec);
  }

  await sendReplies(adminHdr, fill, made, ordinals, timed);
}

/** `time.monotonic()`, in seconds. */
function monotonic(): number {
  return Number(process.hrtime.bigint()) / 1e9;
}

/**
 * Create everything the plan names; split out so `seed()` can guarantee setting
 * restoration in a finally.
 *
 * Times each phase and collects per-message latency for the seed timing breakdown.
 */
async function seedBody(
  rootUrl: string,
  adminHdr: Headers,
  plan: Plan,
  post: Post,
  log: Log,
  options: SeedOptions,
): Promise<Bag> {
  const durs: Record<string, number> = { users: 0.0, channels: 0.0, messages: 0.0, dms: 0.0 };
  const msg = new Timings(); // primary chat.sendMessage latencies
  const doLogin = options.login ?? realLogin;

  const timed: Timed = async (bucket, path, headers, payload) => {
    const t = monotonic();
    const r = await post(path, headers, payload);
    durs[bucket] = (durs[bucket] ?? 0) + (monotonic() - t);
    return r;
  };

  // 1. Users (idempotent: an existing user just gets logged into).
  const tokens = new Map<string, Auth>();
  const names: string[] = [];
  for (let i = 0; i < plan.users; i += 1) names.push(wording.username(i));
  const usersStart = monotonic();
  for (const un of names) {
    await post('/api/v1/users.create', adminHdr, {
      name: capitalize(un),
      username: un,
      email: `${un}@example.com`,
      password: un,
      verified: true,
      requirePasswordChange: false,
      joinDefaultChannels: true,
    });
    try {
      tokens.set(un, await doLogin(rootUrl, { user: un, password: un }));
    } catch (error) {
      // An ordinary failure: fall back to admin authorship -- but not for a Ctrl-C, which
      // is not one.
      if (error instanceof Interrupted) throw error;
    }
  }
  durs.users = monotonic() - usersStart;
  if (options.tokensOut !== undefined) {
    for (const [name, auth] of tokens) options.tokensOut[name] = auth;
  }
  log(`users: ${String(names.length)} (${String(tokens.size)} usable as authors)`);

  /**
   * The author of one message: the members, round-robin.
   *
   * Round-robin rather than a random pick, for the same reason as everything else here --
   * but it is also better content: a random pick can leave a member who never speaks, while
   * this guarantees every member of a room authors in it as soon as there are as many
   * messages as members.
   */
  const hdrFor = (members: readonly string[], turn: number): Headers => {
    const authors = members.map((u) => tokens.get(u)).filter((a): a is Auth => a !== undefined);
    if (authors.length === 0) return adminHdr;
    return {
      ...authHeaders(authors[turn % authors.length] as Auth),
      'Content-Type': 'application/json',
    };
  };

  const made = new Map<string, Made>();

  await makeRooms(adminHdr, made, plan, rootUrl, timed, tokens);
  await fillRooms(adminHdr, durs, hdrFor, made, msg, post, timed);

  return result(plan, made, names, durs, msg, log);
}

/** Capitalised: first character upper, the rest lower. */
function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

/** The seed summary. The legacy keys keep their meaning; the rest are new. */
export function result(
  plan: Plan,
  made: Map<string, Made>,
  names: readonly string[],
  durs: Record<string, number>,
  msg: Timings,
  log: Log,
): Bag {
  const rooms = [...made.values()];
  const created = rooms.filter((r) => r.rid !== '' && r.failed === '');
  const totalMsgs = rooms.reduce((sum, r) => sum + r.messages, 0);
  const totalReplies = rooms.reduce((sum, r) => sum + r.replies, 0);
  const dmCount = created.filter((r) => r.spec.kind === DM).length;
  const kinds: Record<string, number> = {};
  for (const r of created) kinds[r.spec.kind] = (kinds[r.spec.kind] ?? 0) + 1;
  const failed = rooms.filter((r) => r.failed !== '').map((r) => [r.spec.name, r.failed] as const);
  if (failed.length > 0) {
    log(
      `  ⚠ ${String(failed.length)} room(s) not created: ` +
        failed
          .slice(0, 4)
          .map(([n, why]) => `${n} (${why})`)
          .join(', '),
    );
  }
  log(
    `messages: ${String(totalMsgs + totalReplies)} (${String(totalReplies)} in threads)  ` +
      `rooms: ${String(created.length)}  DMs: ${String(dmCount)}`,
  );
  return {
    // Legacy keys, unchanged in meaning: both front ends and the performance report read
    // these.
    users: names.length,
    channels: created.filter((r) => r.spec.kind === 'channel').length,
    messages: totalMsgs + totalReplies,
    dms: dmCount,
    durations: durs,
    latency: msg.summary(),
    latency_hist: msg.histogram(),
    // The manifest's own vocabulary, for the readback and for anything that wants to say
    // what is in there.
    profile: plan.profile,
    rooms: kinds,
    rooms_total: created.length,
    threads: totalReplies,
    reactions: rooms.reduce((sum, r) => sum + r.reactions, 0),
    reused: created.filter((r) => r.reused).length,
    failed: failed.map(([n, w]) => ({ name: n, why: w })),
    planned: {
      rooms: byKind(plan),
      rooms_total: plan.rooms.length,
      messages: planTotalMessages(plan),
      threads: planTotalReplies(plan),
      users: plan.users,
    },
    created: created.map((r) => ({
      kind: r.spec.kind,
      name: r.spec.name,
      rid: r.rid,
      parent: r.spec.parent,
      private: isPrivate(r.spec),
      messages: r.messages,
      replies: r.replies,
      reused: r.reused,
    })),
  };
}
