/**
 * `seed/kinds`: what rooms a seeded workspace holds, and how their messages are counted.
 */
import type { Facts } from '../../src/seed/check';
import { verify } from '../../src/seed/check';
import {
  ANCHOR_MESSAGES,
  CHANNEL,
  DISCUSSION,
  DM,
  GENERAL,
  PRIVATE,
  TEAM,
  TEAM_CHANNEL,
  TEAM_CHANNEL_PRIVATE,
  TEAM_PRIVATE,
  THREAD_EVERY,
} from '../../src/seed/kinds';
import {
  type RoomFacts,
  byKind,
  planFrom,
  reacted,
  replies,
  roomFacts,
  totalMessages,
} from '../../src/seed/plan';
import { username } from '../../src/seed/wording';

jest.mock('../../src/core/rcapi', () => ({
  RequestFailed: class RequestFailed extends Error {},
  authHeaders: () => ({}),
  login: () => Promise.reject(new Error('no server')),
  rcapi: { call: () => Promise.resolve([500, '{}'] as [number, string]) },
}));

/** What a workspace that holds exactly the plan reports. */
function facts(plan: ReturnType<typeof planFrom>): Facts {
  const rooms = plan.rooms.map((spec) => {
    const f = roomFacts(spec);
    f.found = true;
    f.rid = `rid-${spec.name}`;
    f.messages = totalMessages(spec);
    f.replies = replies(spec);
    f.reacted = reacted(spec);
    f.threads = replies(spec);
    return f;
  });
  const planned: string[] = [];
  for (let i = 0; i < plan.users; i += 1) planned.push(username(i));
  return {
    rooms,
    users_found: [...planned],
    users_unreadable: '',
    planned_users: planned,
  } as Facts;
}

describe('the rooms a profile holds', () => {
  it('has every kind of room in every profile, because tickets are rarely about a public channel', () => {
    // They are about a discussion inside a private team channel, or a thread nobody else can
    // see -- so `small` carries one of each rather than being a scaled-down `standard`.
    for (const profile of ['small', 'standard', 'large']) {
      const kinds = new Set(Object.keys(byKind(planFrom(profile))));
      for (const kind of [
        CHANNEL,
        PRIVATE,
        TEAM,
        TEAM_CHANNEL,
        TEAM_CHANNEL_PRIVATE,
        DISCUSSION,
        DM,
        GENERAL,
      ]) {
        expect({ profile, kind, present: kinds.has(kind) }).toEqual({
          profile,
          kind,
          present: true,
        });
      }
    }
    // Both team visibilities appear as soon as there are two teams.
    expect(Object.keys(byKind(planFrom('standard')))).toContain(TEAM_PRIVATE);
  });

  it('counts a planned thread as a message in its room', () => {
    // `channels.messages` returns a threaded reply with a `tmid`, so a plan that omitted it
    // would verify every room as short by the number of its threads.
    const room = planFrom('small').rooms.find((one) => one.kind === CHANNEL);
    expect(room).toBeDefined();
    const expected: number[] = [];
    for (let at = 0; at < (room?.messages ?? 0); at += THREAD_EVERY) expected.push(at);
    expect(room?.threads).toEqual(expected);
    expect(totalMessages(room as NonNullable<typeof room>)).toBe(
      (room?.messages ?? 0) + (room?.threads.length ?? 0),
    );
  });

  it('treats a discussion that lost its anchor as a fault, named by its room', () => {
    // A discussion opened from a message arrives holding ANCHOR_MESSAGES it did not post, so
    // a `pmid` that stops being sent makes the room come back exactly that much short.
    const plan = planFrom('standard');
    const anchored = plan.rooms.find((one) => one.kind === DISCUSSION && one.fromMessage >= 0);
    const plain = plan.rooms.find((one) => one.kind === DISCUSSION && one.fromMessage < 0);
    expect(anchored).toBeDefined();
    expect(plain).toBeDefined();
    expect(
      totalMessages(anchored as NonNullable<typeof anchored>) -
        totalMessages(plain as NonNullable<typeof plain>),
    ).toBe(ANCHOR_MESSAGES);
    const seen = facts(plan);
    const lost = seen.rooms.find((one) => (one as RoomFacts).spec === anchored) as RoomFacts;
    lost.messages -= ANCHOR_MESSAGES;
    const verdict = verify(plan, seen);
    expect(verdict.ok).toBe(false);
    expect(verdict.faults[0]?.room).toBe(anchored?.name);
  });
});
