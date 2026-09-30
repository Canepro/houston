import * as fs from 'node:fs';
import * as path from 'node:path';

import { PROFILES } from '../../src/lib/seed-profiles';

import {
  ANCHOR_MESSAGES,
  DISCUSSION,
  DM,
  GENERAL,
  REACT_EVERY,
  THREAD_EVERY,
} from '../../src/seed/kinds';
import {
  type Plan,
  byKind,
  dms,
  isPrivate,
  named,
  planFrom,
  planTotalMessages,
  planTotalReplies,
  reacted,
  replies,
  rich,
  totalMessages,
  UnknownProfileError,
} from '../../src/seed/plan';

/**
 * The manifests earlier releases planned, recorded: one per profile, keyed by its name, and
 * one per override row below, keyed by the profile and the overrides' JSON.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'seed', 'plan.json'), 'utf8'),
) as Record<string, unknown>;

/** The manifest, in earlier releases' own field names, so a rename shows up as a difference. */
function dump(plan: Plan) {
  return {
    profile: plan.profile,
    users: plan.users,
    channels: plan.channels,
    messages: plan.messages,
    reactions: plan.reactions,
    dms: dms(plan),
    rich: rich(plan),
    total_messages: planTotalMessages(plan),
    total_replies: planTotalReplies(plan),
    by_kind: byKind(plan),
    rooms: plan.rooms.map((r) => ({
      kind: r.kind,
      name: r.name,
      members: [...r.members],
      messages: r.messages,
      threads: [...r.threads],
      reactions: [...r.reactions],
      parent: r.parent,
      from_message: r.fromMessage,
      private: isPrivate(r),
      replies: replies(r),
      reacted: reacted(r),
      total_messages: totalMessages(r),
    })),
  };
}

describe('the manifest', () => {
  it.each(['small', 'standard', 'large'])('is identical to earlier releases for %s', (profile) => {
    expect(dump(planFrom(profile))).toEqual(RECORDED[profile]);
  });

  it.each([
    [{ users: 2 }, 'small'],
    [{ users: 4, messages: 0 }, 'small'],
    [{ channels: 0, users: 3 }, 'standard'],
    [{ users: 1 }, 'large'],
    [{ users: -5 }, 'small'],
    [{ messages: 1 }, 'standard'],
  ] as const)('is identical to earlier releases with %o', (overrides, profile) => {
    const recorded = RECORDED[`${profile} ${JSON.stringify(overrides)}`];
    expect(recorded).toBeDefined();
    expect(dump(planFrom(profile, overrides))).toEqual(recorded);
  });

  it('carries the same profile shapes earlier releases ship', () => {
    const recorded = {
      small: {
        users: 5,
        channels: 2,
        private: 1,
        teams: 1,
        team_channels: 2,
        discussions: 2,
        dms: 2,
        messages: 5,
        reactions: false,
      },
      standard: {
        users: 20,
        channels: 5,
        private: 2,
        teams: 2,
        team_channels: 2,
        discussions: 3,
        dms: 5,
        messages: 20,
        reactions: true,
      },
      large: {
        users: 100,
        channels: 12,
        private: 4,
        teams: 3,
        team_channels: 2,
        discussions: 6,
        dms: 20,
        messages: 100,
        reactions: true,
      },
    };
    const ours = Object.fromEntries(
      Object.entries(PROFILES).map(([k, v]) => [
        k,
        {
          users: v.users,
          channels: v.channels,
          private: v.private,
          teams: v.teams,
          team_channels: v.teamChannels,
          discussions: v.discussions,
          dms: v.dms,
          messages: v.messages,
          reactions: v.reactions,
        },
      ]),
    );
    expect(ours).toEqual(recorded);
  });

  it('names an unknown profile and lists the real ones', () => {
    expect(() => planFrom('nope')).toThrow(
      "unknown seed profile 'nope' (want small | standard | large)",
    );
  });

  it('refuses what earlier releases refuse, in their words and as its own class', () => {
    // Only the profile table's own keys are profiles, and the refusal quotes the name as
    // earlier releases did. An index reached through the prototype, so `constructor` built a
    // plan of undefined counts, and a quote in the name was spelled '...' where earlier
    // releases switch to double quotes. Its own class, so the seed preamble has one to catch.
    const profiles = ['constructor', '__proto__', 'toString', "it's", '', 'Small'];
    const want = '(want small | standard | large)';
    const recorded = [
      `unknown seed profile 'constructor' ${want}`,
      `unknown seed profile '__proto__' ${want}`,
      `unknown seed profile 'toString' ${want}`,
      `unknown seed profile "it's" ${want}`,
      `unknown seed profile '' ${want}`,
      `unknown seed profile 'Small' ${want}`,
    ];
    const ours = profiles.map((p) => {
      try {
        planFrom(p);
        return null;
      } catch (error) {
        expect(error).toBeInstanceOf(UnknownProfileError);
        return (error as Error).message;
      }
    });
    expect(ours).toEqual(recorded);
  });
});

describe('what the manifest promises', () => {
  const plan = planFrom('standard');

  it('creates a team before its channels and a parent before its discussions', () => {
    // Order IS the manifest: sorting this list later would break seeding, so nothing does.
    const index = new Map(plan.rooms.map((r, i) => [r.name, i]));
    for (const room of plan.rooms) {
      if (room.parent === '') continue;
      expect(index.get(room.parent)).toBeLessThan(index.get(room.name) as number);
    }
  });

  it('counts a threaded reply as a message in the room', () => {
    // `channels.messages` returns a reply with a `tmid`, so a count that omits it does not
    // match what the server reports -- which is exactly the mismatch a verifier would
    // report as a fault on a perfectly good seed.
    const room = named(plan, 'general');
    expect(room).not.toBeNull();
    expect(totalMessages(room!)).toBe(room!.messages + room!.threads.length);
  });

  it('counts the anchor messages a message-opened discussion arrives holding', () => {
    const opened = plan.rooms.filter((r) => r.kind === DISCUSSION && r.fromMessage >= 0);
    const against = plan.rooms.filter((r) => r.kind === DISCUSSION && r.fromMessage < 0);
    expect(opened.length).toBeGreaterThan(0);
    expect(against.length).toBeGreaterThan(0);
    for (const r of opened) {
      expect(totalMessages(r)).toBe(r.messages + r.threads.length + ANCHOR_MESSAGES);
    }
    for (const r of against) expect(totalMessages(r)).toBe(r.messages + r.threads.length);
  });

  it('never asks for a DM a user has with themselves', () => {
    // `im.create` accepts a self-pair and makes a real self-DM, which is not what a plan
    // asking for a conversation between two people meant. It appeared the moment
    // `--users 2` was passed with the default five DMs.
    for (const profile of ['small', 'standard', 'large']) {
      for (const users of [2, 3, 4, 5, 20]) {
        for (const room of planFrom(profile, { users }).rooms) {
          if (room.kind !== DM) continue;
          expect(room.members[0]).not.toBe(room.members[1]);
        }
      }
    }
  });

  it('asks for no more DMs than there are distinct pairs', () => {
    // `im.create` for a pair that already has a room returns THAT room, so asking for five
    // DMs from two users produced five records pointing at one -- and the verification then
    // reported rooms short that were simply the same room counted twice.
    for (const users of [2, 3, 4, 5]) {
      const plan_ = planFrom('standard', { users });
      expect(dms(plan_)).toBeLessThanOrEqual((users * (users - 1)) / 2);
      const pairs = plan_.rooms
        .filter((r) => r.kind === DM)
        .map((r) => [...r.members].sort().join('~'));
      expect(new Set(pairs).size).toBe(pairs.length);
    }
  });

  it('threads and reacts on a fixed stride, so the readback knows where to look', () => {
    const room = named(plan, 'general');
    expect(room!.threads).toEqual(
      [...Array(Math.ceil(room!.messages / THREAD_EVERY))].map((_, i) => i * THREAD_EVERY),
    );
    expect(room!.reactions).toEqual(
      [...Array(Math.ceil(room!.messages / REACT_EVERY))].map((_, i) => i * REACT_EVERY),
    );
  });

  it('plans no reactions at all on a profile that does not ask for them', () => {
    const small = planFrom('small');
    expect(small.reactions).toBe(false);
    for (const room of small.rooms) expect(room.reactions).toEqual([]);
  });

  it('gives general the whole user list, because everyone is already in it', () => {
    const general = named(plan, 'general');
    expect(general?.kind).toBe(GENERAL);
    expect(general?.members).toHaveLength(plan.users);
  });

  it('survives a profile with no users at all', () => {
    const empty = planFrom('small', { users: 0 });
    expect(dms(empty)).toBe(0);
    expect(named(empty, 'general')?.members).toEqual([]);
  });
});

describe('the profile catalogue the plan reads', () => {
  it('is the shared leaf table, in the order small, standard, large', () => {
    // `capabilities` needs the profile names without importing the seeder, so the table is
    // its own leaf and the plan reads THAT one rather than a copy of it.
    expect(Object.keys(PROFILES)).toEqual(['small', 'standard', 'large']);
    for (const name of Object.keys(PROFILES)) {
      expect({ name, users: planFrom(name).users }).toEqual({
        name,
        users: PROFILES[name]?.users,
      });
    }
    expect(() => planFrom('huge')).toThrow('(want small | standard | large)');
  });
});

describe('a profile and its overrides', () => {
  it('takes its counts from the profile, and an override reshapes the manifest', () => {
    const standard = planFrom('standard');
    expect([standard.users, standard.channels, standard.messages, rich(standard)]).toEqual([
      20,
      5,
      20,
      true,
    ]);
    const small = planFrom('standard', { users: 3, messages: 1 });
    // Override + inherit.
    expect([small.users, small.messages, small.channels]).toEqual([3, 1, 5]);
    // The MANIFEST, not just the counts: three users means every room's membership is
    // drawn from three names.
    for (const room of small.rooms) {
      for (const member of room.members) expect(['alice', 'bob', 'carol']).toContain(member);
    }
  });

  it('is the same manifest every time, so a ticket and its reproduction can be compared', () => {
    // A plan of counts has nothing to read back and check against.
    const a = planFrom('standard');
    const b = planFrom('standard');
    expect(a.rooms).toEqual(b.rooms);
    expect(planTotalMessages(a)).toBe(planTotalMessages(b));
  });

  it('gives every room of the large profile its own name, team channels prefixed', () => {
    // A channel name is unique workspace-wide, so two teams both wanting `planning` would
    // collide and the second team would come out empty.
    const names = planFrom('large').rooms.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    const teamChannels = planFrom('large').rooms.filter((r) => r.kind.startsWith('team-channel'));
    expect(teamChannels.length).toBeGreaterThan(0);
    for (const room of teamChannels) expect(room.name).toContain('-');
  });
});
