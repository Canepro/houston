/**
 * The manifest: what will exist when seeding finishes, decided before anything is created.
 *
 * Tier 2. `RoomSpec` and `Plan` are readonly interfaces, and their derived PROPERTIES free
 * functions, because a plain object is what crosses to the readback and to `repro.json`,
 * and a class would have to be unwrapped at each of those boundaries.
 */
import { quotedText } from '../lib/format';
import { PROFILES, type Shape } from '../lib/seed-profiles';
import { SCENARIOS, seedSelection } from '../lib/seed-options';
import { ValidationError } from '../lib/errors';

import {
  ANCHOR_MESSAGES,
  CHANNEL,
  DISCUSSION,
  DM,
  GROUP_DM,
  READ_ONLY,
  BROADCAST,
  ARCHIVED,
  PERMISSIONS,
  GENERAL,
  PRIVATE,
  PRIVATE_KINDS,
  REACT_EVERY,
  TEAM,
  TEAM_CHANNEL,
  TEAM_CHANNEL_PRIVATE,
  TEAM_PRIVATE,
} from './kinds';
import * as wording from './wording';

/** One room, fully decided before anything is created. */
export interface RoomSpec {
  readonly kind: string;
  readonly name: string;
  readonly members: readonly string[];
  readonly messages: number;
  /**
   * Indexes of this room's messages that get one threaded reply each. A list rather than a
   * count, so the readback knows WHICH message to look under.
   */
  readonly threads: readonly number[];
  /**
   * Indexes of this room's messages that get a reaction. Planned rather than decided while
   * posting, for the same reason as `threads`: a count nobody can predict is a count
   * nobody can check, and reactions were the one part of a `rich` profile that did work --
   * so they were also the part with no evidence.
   */
  readonly reactions: readonly number[];
  /** A team's name for a team channel; the parent room's name for a discussion. */
  readonly parent: string;
  /**
   * For a discussion: the index of the parent message it hangs off, or -1 for a discussion
   * created against the room rather than against a message. Both are real paths in the
   * product and they produce different system messages.
   */
  readonly fromMessage: number;
  readonly replyCount: number;
  readonly files: readonly string[];
  readonly content: readonly ContentSpec[];
}

export interface ContentSpec {
  readonly key: string;
  readonly kind: 'main' | 'reply' | 'file';
  readonly author: string;
  readonly text: string;
  readonly parent: string;
  readonly reactions: readonly { author: string; emoji: string }[];
  readonly pin: boolean;
  readonly star: string;
  readonly mention: string;
  readonly editedText: string;
  readonly file: string;
}

export function roomSpec(values: Partial<RoomSpec> & { kind: string; name: string }): RoomSpec {
  return {
    members: [],
    messages: 0,
    threads: [],
    reactions: [],
    parent: '',
    fromMessage: -1,
    replyCount: 1,
    files: [],
    content: [],
    ...values,
  };
}

export function isPrivate(spec: RoomSpec): boolean {
  return PRIVATE_KINDS.includes(spec.kind);
}

export function replies(spec: RoomSpec): number {
  return spec.threads.length * spec.replyCount;
}

export function reacted(spec: RoomSpec): number {
  return spec.reactions.length;
}

/**
 * Messages that will exist in the room: the base ones, the replies, and the opening line
 * of a discussion that was created from a message.
 *
 * A threaded reply IS a message in the room -- `channels.messages` returns it with a
 * `tmid` -- so a count that omits it does not match what the server reports, which is
 * exactly the mismatch a verifier would report as a fault.
 *
 * A discussion opened from a message is the same trap one level down: it arrives holding
 * `ANCHOR_MESSAGES` before anyone posts into it, and leaving those out made every
 * message-anchored discussion report more than planned on a perfectly good seed.
 */
export function totalMessages(spec: RoomSpec): number {
  return (
    spec.messages +
    replies(spec) +
    spec.files.length +
    (spec.fromMessage >= 0 ? ANCHOR_MESSAGES : 0)
  );
}

/** The manifest: what will exist when seeding finishes. */
export interface Plan {
  readonly profile: string;
  readonly users: number;
  /**
   * Standalone public channels. Kept as a top-level field because both front ends print it
   * in the "seeding N users, N channels" line.
   */
  readonly channels: number;
  /** per room, before replies */
  readonly messages: number;
  readonly reactions: boolean;
  readonly rooms: readonly RoomSpec[];
  readonly customEmoji: readonly string[];
  readonly scenarios: readonly string[];
  readonly historyDays: number | null;
}

export function dms(plan: Plan): number {
  return plan.rooms.filter((r) => r.kind === DM).length;
}

/** Kept for callers that ask whether this profile does threads/reactions. */
export function rich(plan: Plan): boolean {
  return plan.reactions;
}

export function planTotalMessages(plan: Plan): number {
  return plan.rooms.reduce((sum, r) => sum + totalMessages(r), 0);
}

export function planTotalReplies(plan: Plan): number {
  return plan.rooms.reduce((sum, r) => sum + replies(r), 0);
}

export function byKind(plan: Plan): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of plan.rooms) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}

export function named(plan: Plan, name: string): RoomSpec | null {
  return plan.rooms.find((r) => r.name === name) ?? null;
}

type Add = (
  kind: string,
  name: string,
  size: number,
  messages: number,
  extra?: Partial<RoomSpec>,
) => RoomSpec;

/** The discussions hung off the rooms that can carry one, and the DMs between users. */
function discussionsAndDms(
  add: Add,
  names: readonly string[],
  rooms: RoomSpec[],
  shape: Shape,
): void {
  const categories = [CHANNEL, PRIVATE, TEAM, TEAM_PRIVATE, TEAM_CHANNEL, TEAM_CHANNEL_PRIVATE];
  const parents = categories.flatMap((kind) => rooms.filter((r) => r.kind === kind).slice(0, 1));
  for (let d = 0; d < shape.discussions; d += 1) {
    if (parents.length === 0) break;
    const parent = parents[d % parents.length] as RoomSpec;
    // Alternating: half are opened FROM a message (which is how a support engineer usually
    // makes one, and which leaves a different system message in the parent), half against
    // the room itself.
    add(
      DISCUSSION,
      wording.poolName(wording.DISCUSSION_NAMES, d, ' '),
      3,
      Math.max(2, Math.floor(shape.messages / 4)),
      {
        parent: parent.name,
        members: parent.members.slice(0, 3),
        fromMessage: d % 2 === 0 && parent.messages > 0 ? 0 : -1,
      },
    );
  }

  // Capped at the number of DISTINCT pairs: `im.create` for a pair that already has a room
  // returns that same room, so asking for five DMs from two users produced five records
  // pointing at one or two rooms -- and the verification then reported rooms as short that
  // were simply the same room counted twice.
  const n = names.length;
  const wanted = Math.min(shape.dms, Math.floor((n * (n - 1)) / 2));
  for (let i = 0; i < wanted; i += 1) {
    if (n < 2) break;
    const [a, b] = wording.dmPair(names, i);
    const msgs = Math.max(2, Math.floor(shape.messages / 5));
    rooms.push(
      roomSpec({
        kind: DM,
        name: `${a}~${b}`,
        members: [a, b],
        messages: msgs,
        replyCount: shape.replyCount,
        threads: wording.threads(msgs),
        reactions: shape.reactions ? wording.threads(msgs, REACT_EVERY) : [],
      }),
    );
  }
  let groups = 0;
  for (let a = 0; a < names.length && groups < shape.groupDms; a += 1) {
    for (let b = a + 1; b < names.length && groups < shape.groupDms; b += 1) {
      for (let c = b + 1; c < names.length && groups < shape.groupDms; c += 1) {
        const members = [names[a] as string, names[b] as string, names[c] as string];
        const messages = Math.max(
          3,
          Math.floor(shape.messages * (shape.replyCount === 5 ? 0.15 : 0.3)),
        );
        rooms.push(
          roomSpec({
            kind: GROUP_DM,
            name: members.join('~'),
            members,
            messages,
            replyCount: shape.replyCount,
            threads: wording.threads(messages),
            reactions: shape.reactions ? wording.threads(messages, REACT_EVERY) : [],
          }),
        );
        groups += 1;
      }
    }
  }
}

/** The public and private channels, and the teams with their own channels inside. */
function channelsAndTeams(
  add: Add,
  names: readonly string[],
  rooms: RoomSpec[],
  shape: Shape,
): void {
  for (let i = 0; i < shape.channels; i += 1) {
    add(CHANNEL, wording.channelName(i), 4, shape.messages);
  }
  for (let i = 0; i < shape.private; i += 1) {
    // Fewer messages: a private room's value here is that it EXISTS and is invisible to a
    // non-member, not that it is busy.
    add(PRIVATE, wording.privateName(i), 3, Math.max(3, Math.floor(shape.messages / 2)));
  }
  for (let t = 0; t < shape.teams; t += 1) {
    // Alternating, so any profile with two or more teams has one of each. A private team is
    // a different object from a private channel -- its main room is type `p` AND it owns
    // other rooms -- and only one of the two is exercised by making every team public.
    const tname = wording.teamName(t);
    const team = add(
      t % 2 === 0 ? TEAM : TEAM_PRIVATE,
      tname,
      4,
      Math.max(3, Math.floor(shape.messages / 2)),
    );
    for (let c = 0; c < shape.teamChannels; c += 1) {
      add(
        c % 2 === 0 ? TEAM_CHANNEL : TEAM_CHANNEL_PRIVATE,
        wording.teamChannelName(t, c),
        3,
        Math.max(3, Math.floor(shape.messages / 2)),
        {
          parent: tname,
          members: team.members.slice(
            c % Math.max(1, team.members.length - 2),
            (c % Math.max(1, team.members.length - 2)) + 3,
          ),
        },
      );
    }
  }
  // Everyone is already in `general`, so it is the one room where the whole user list
  // authors.
  rooms.push(
    roomSpec({
      kind: GENERAL,
      name: 'general',
      members: [...names],
      messages: shape.messages,
      replyCount: shape.replyCount,
      threads: wording.threads(shape.messages),
      reactions: shape.reactions ? wording.threads(shape.messages, REACT_EVERY) : [],
    }),
  );
}

/**
 * Turn a shape into the concrete list of rooms, in CREATION order.
 *
 * Order matters and is part of the manifest: a team exists before its channels, and every
 * discussion's parent exists before the discussion. Sorting this list later would break
 * seeding, so nothing does.
 */
function build(shape: Shape, names: readonly string[]): RoomSpec[] {
  const rooms: RoomSpec[] = [];
  let idx = 0;

  const add: Add = (kind, name, size, messages, extra = {}) => {
    const spec = roomSpec({
      kind,
      name,
      members: wording.members(names, idx, size),
      messages,
      threads: wording.threads(messages),
      reactions: shape.reactions ? wording.threads(messages, REACT_EVERY) : [],
      replyCount: shape.replyCount,
      ...extra,
    });
    rooms.push(spec);
    idx += 1;
    return spec;
  };

  channelsAndTeams(add, names, rooms, shape);
  discussionsAndDms(add, names, rooms, shape);
  return rooms;
}

export interface PlanOverrides {
  readonly users?: number | null;
  readonly channels?: number | null;
  readonly messages?: number | null;
  readonly scenarios?: readonly string[];
  readonly historyDays?: number | null;
}

/**
 * The planner's refusal of a profile that is not one of `PROFILES`.
 *
 * A class of its own so a caller translates THIS refusal and nothing else -- the CLI turns
 * it into its error line and the GUI into a ValidationError. It was a bare `Error`, which
 * the CLI seed let through as an
 * unhandled failure: a JavaScript stack, "this is unhandled", `trace: true` in the log, for
 * a typo in `--profile`.
 */
export class UnknownProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownProfile';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function planFrom(profile: string, overrides: PlanOverrides = {}): Plan {
  // Only `PROFILES`' own keys. An index reaches through the prototype, so
  // `--profile constructor` found `Object` and built a plan of undefined counts, and the
  // profile is quoted by `quotedText`.
  const base = Object.hasOwn(PROFILES, profile) ? PROFILES[profile] : undefined;
  if (base === undefined) {
    throw new UnknownProfileError(
      `unknown seed profile ${quotedText(profile)} (want ${Object.keys(PROFILES).join(' | ')})`,
    );
  }
  const pick = (given: number | null | undefined, fallback: number): number =>
    given === null || given === undefined ? fallback : Math.max(0, given);
  const shape: Shape = {
    ...base,
    users: pick(overrides.users, base.users),
    channels: pick(overrides.channels, base.channels),
    messages: pick(overrides.messages, base.messages),
  };
  const names: string[] = [];
  for (let i = 0; i < shape.users; i += 1) names.push(wording.username(i));
  const selection = seedSelection(overrides.scenarios, overrides.historyDays);
  for (const scenario of selection.scenarios)
    if (names.length < SCENARIOS[scenario as keyof typeof SCENARIOS].minimumUsers)
      throw new ValidationError(
        `the ${scenario} scenario requires at least ${SCENARIOS[scenario as keyof typeof SCENARIOS].minimumUsers} seeded users`,
      );
  const rooms = build(shape, names);
  if (selection.scenarios.includes('room-states')) {
    for (const [kind, name] of [
      [READ_ONLY, 'seed-read-only'],
      [BROADCAST, 'seed-broadcast'],
      [ARCHIVED, 'seed-archived'],
    ]) {
      rooms.push(
        roomSpec({
          kind: kind as string,
          name: name as string,
          members: names.slice(0, 3),
          messages: 5,
          replyCount: 0,
        }),
      );
    }
  }
  if (selection.scenarios.includes('permissions')) {
    rooms.push(
      roomSpec({
        kind: PERMISSIONS,
        name: 'seed-permissions',
        members: names.slice(0, 3),
        messages: 5,
        replyCount: 0,
      }),
    );
  }
  const customEmoji = Array.from({ length: shape.emoji }, (_, i) => `houston_seed_${i + 1}`);
  for (let i = 0; i < rooms.length; i += 1) {
    const room = rooms[i] as RoomSpec;
    if (room.members.length < 2) rooms[i] = { ...room, threads: [], replyCount: 0, reactions: [] };
  }
  const fileKinds = [CHANNEL, PRIVATE, DISCUSSION, TEAM, TEAM_CHANNEL, DM];
  for (let i = 0; i < shape.fileSets; i += 1) {
    const room = rooms.find((r) => r.kind === fileKinds[i]);
    if (room !== undefined)
      rooms[rooms.indexOf(room)] = { ...room, files: ['png', 'txt', 'pdf', 'csv'] };
  }
  let edits = shape.edits;
  let serial = 0;
  const detailed = rooms.map((room) => {
    const scenario = [READ_ONLY, BROADCAST, ARCHIVED, PERMISSIONS].includes(room.kind);
    const content: ContentSpec[] = [];
    for (let i = 0; i < room.messages; i += 1) {
      const author =
        room.kind === BROADCAST ? '' : (room.members[i % Math.max(1, room.members.length)] ?? '');
      const others = room.members.filter((n) => n !== author);
      const mention = i === 0 && !scenario ? (others[0] ?? '') : '';
      const custom = customEmoji[serial % customEmoji.length] as string;
      const text = wording.conversation(room.name, i, mention, i === 0 && !scenario ? custom : '');
      const actions: { author: string; emoji: string }[] = [];
      if (room.reactions.includes(i) && others.length > 0) {
        const emoji = i === 0 ? `:${custom}:` : (wording.EMOJI[i % wording.EMOJI.length] as string);
        actions.push({ author: others[0] as string, emoji });
        if (others.length > 1) actions.push({ author: others[1] as string, emoji });
        actions.push({ author: others[0] as string, emoji: ':white_check_mark:' });
      }
      const editedText =
        edits > 0 ? `${text}\n\nUpdate: evidence attached; next checkpoint confirmed.` : '';
      if (edits > 0) edits -= 1;
      const main = {
        key: `main-${i}`,
        kind: 'main' as const,
        author,
        text,
        parent: '',
        reactions: actions,
        pin: i === 0 && ![DM, GROUP_DM].includes(room.kind),
        star: i === 0 && !scenario ? author : '',
        mention,
        editedText,
        file: '',
      };
      content.push(main);
      if (room.threads.includes(i)) {
        for (let j = 0; j < room.replyCount; j += 1) {
          content.push({
            key: `reply-${i}-${j}`,
            kind: 'reply',
            author: others[j % Math.max(1, others.length)] ?? author,
            text: wording.threadReply(room.name, i, j),
            parent: main.key,
            reactions: [],
            pin: false,
            star: '',
            mention: '',
            editedText: '',
            file: '',
          });
        }
      }
      serial += 1;
    }
    for (const file of room.files)
      content.push({
        key: `file-${file}`,
        kind: 'file',
        author: room.members[0] ?? '',
        text: `INC-4821 ${room.name}: sample ${file.toUpperCase()} evidence`,
        parent: '',
        reactions: [],
        pin: false,
        star: '',
        mention: '',
        editedText: '',
        file,
      });
    return { ...room, content };
  });
  return {
    profile,
    users: shape.users,
    channels: shape.channels,
    messages: shape.messages,
    reactions: shape.reactions,
    rooms: detailed,
    customEmoji,
    ...selection,
  };
}

/** What actually got created, alongside the spec that asked for it. */
export interface Made {
  readonly spec: RoomSpec;
  rid: string;
  teamId: string;
  reused: boolean;
  messages: number;
  replies: number;
  reactions: number;
  failed: string;
  messageIds: string[];
}

export function made(spec: RoomSpec): Made {
  return {
    spec,
    rid: '',
    teamId: '',
    reused: false,
    messages: 0,
    replies: 0,
    reactions: 0,
    failed: '',
    messageIds: [],
  };
}

/** What the server says about one planned room. */
export interface RoomFacts {
  readonly spec: RoomSpec;
  found: boolean;
  rid: string;
  /** content messages, replies included */
  messages: number;
  /** of those, the ones inside a thread */
  replies: number;
  /** of those, the ones carrying at least one reaction */
  reacted: number;
  /** parent messages that have a thread */
  threads: number;
  /** for a team channel: is it actually IN the team */
  inTeam: boolean;
  /** why this room could not be checked at all */
  unreadable: string;
}

export function roomFacts(spec: RoomSpec): RoomFacts {
  return {
    spec,
    found: false,
    rid: '',
    messages: 0,
    replies: 0,
    reacted: 0,
    threads: 0,
    inTeam: true,
    unreadable: '',
  };
}
