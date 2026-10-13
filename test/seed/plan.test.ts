import { PROFILES } from '../../src/lib/seed-profiles';
import {
  ANCHOR_MESSAGES,
  CHANNEL,
  DISCUSSION,
  DM,
  GENERAL,
  PRIVATE,
  REACT_EVERY,
  TEAM,
  TEAM_CHANNEL,
  TEAM_CHANNEL_PRIVATE,
  TEAM_PRIVATE,
  THREAD_EVERY,
} from '../../src/seed/kinds';
import {
  type Plan,
  UnknownProfileError,
  byKind,
  dms,
  named,
  planFrom,
  planTotalMessages,
  planTotalReplies,
  replies,
  rich,
  totalMessages,
} from '../../src/seed/plan';

const DEFAULT_COUNTS = [
  {
    profile: 'small',
    users: 5,
    rooms: 12,
    main: 38,
    threads: 12,
    replies: 24,
    files: 4,
    openings: 2,
    content: 68,
  },
  {
    profile: 'standard',
    users: 20,
    rooms: 25,
    main: 253,
    threads: 54,
    replies: 162,
    files: 12,
    openings: 4,
    content: 431,
  },
  {
    profile: 'large',
    users: 100,
    rooms: 60,
    main: 2620,
    threads: 524,
    replies: 2620,
    files: 24,
    openings: 6,
    content: 5270,
  },
] as const;

function counts(plan: Plan) {
  return {
    profile: plan.profile,
    users: plan.users,
    rooms: plan.rooms.length,
    main: plan.rooms.reduce((sum, r) => sum + r.messages, 0),
    threads: plan.rooms.reduce((sum, r) => sum + r.threads.length, 0),
    replies: planTotalReplies(plan),
    files: plan.rooms.reduce((sum, r) => sum + r.files.length, 0),
    openings: plan.rooms.filter((r) => r.fromMessage >= 0).length * ANCHOR_MESSAGES,
    content: planTotalMessages(plan),
  };
}

describe('the advanced seed manifest', () => {
  it.each(DEFAULT_COUNTS)('plans the agreed first-run counts for $profile', (expected) => {
    expect(counts(planFrom(expected.profile))).toEqual(expected);
  });

  it.each([
    ['small', 2, 1, 1, 0, 1, 1, 2, 2, 1],
    ['standard', 5, 2, 1, 1, 2, 2, 3, 5, 3],
    ['large', 12, 4, 2, 1, 3, 3, 6, 20, 8],
  ] as const)(
    'plans the agreed room structure for %s',
    (
      profile,
      publicRooms,
      privateRooms,
      publicTeams,
      privateTeams,
      publicChildren,
      privateChildren,
      discussions,
      direct,
      group,
    ) => {
      expect(byKind(planFrom(profile))).toEqual({
        [CHANNEL]: publicRooms,
        [PRIVATE]: privateRooms,
        [TEAM]: publicTeams,
        ...(privateTeams === 0 ? {} : { [TEAM_PRIVATE]: privateTeams }),
        [TEAM_CHANNEL]: publicChildren,
        [TEAM_CHANNEL_PRIVATE]: privateChildren,
        [GENERAL]: 1,
        [DISCUSSION]: discussions,
        [DM]: direct,
        'group-dm': group,
      });
    },
  );

  it.each([
    ['small', 15, 43, 9, 12, 12, 2, 1],
    ['standard', 96, 278, 17, 25, 25, 6, 3],
    ['large', 897, 2551, 32, 60, 60, 20, 6],
  ] as const)(
    'plans the agreed feature counts for %s',
    (profile, reacted, reactions, pins, stars, mentions, edits, emoji) => {
      const plan = planFrom(profile);
      const content = plan.rooms.flatMap((r) => r.content);
      expect({
        reacted: content.filter((m) => m.reactions.length > 0).length,
        reactions: content.reduce((sum, m) => sum + m.reactions.length, 0),
        pins: content.filter((m) => m.pin).length,
        stars: content.filter((m) => m.star !== '').length,
        mentions: content.filter((m) => m.mention !== '').length,
        edits: content.filter((m) => m.editedText !== '').length,
        emoji: plan.customEmoji.length,
      }).toEqual({ reacted, reactions, pins, stars, mentions, edits, emoji });
    },
  );

  it('creates a team before its channels and a parent before its discussions', () => {
    const plan = planFrom('large');
    const index = new Map(plan.rooms.map((r, i) => [r.name, i]));
    for (const room of plan.rooms)
      if (room.parent !== '') expect(index.get(room.parent)).toBeLessThan(index.get(room.name)!);
  });

  it('counts multiple replies and uploaded files as content messages', () => {
    for (const expected of DEFAULT_COUNTS) {
      for (const room of planFrom(expected.profile).rooms) {
        expect(replies(room)).toBe(room.threads.length * room.replyCount);
        expect(totalMessages(room)).toBe(
          room.messages +
            replies(room) +
            room.files.length +
            (room.fromMessage >= 0 ? ANCHOR_MESSAGES : 0),
        );
        expect(room.content).toHaveLength(room.messages + replies(room) + room.files.length);
      }
    }
  });

  it('uses public and private discussion parents in every profile and all six categories in large', () => {
    for (const profile of Object.keys(PROFILES)) {
      const plan = planFrom(profile);
      const discussions = plan.rooms.filter((r) => r.kind === DISCUSSION);
      const parents = discussions.map((r) => named(plan, r.parent)!);
      expect(parents.some((r) => [CHANNEL, TEAM, TEAM_CHANNEL].includes(r.kind))).toBe(true);
      expect(
        parents.some((r) => [PRIVATE, TEAM_PRIVATE, TEAM_CHANNEL_PRIVATE].includes(r.kind)),
      ).toBe(true);
      for (const discussion of discussions) {
        const parent = named(plan, discussion.parent)!;
        for (const member of discussion.members) expect(parent.members).toContain(member);
      }
    }
    const large = planFrom('large');
    expect(
      new Set(
        large.rooms.filter((r) => r.kind === DISCUSSION).map((r) => named(large, r.parent)?.kind),
      ),
    ).toEqual(new Set([CHANNEL, PRIVATE, TEAM, TEAM_PRIVATE, TEAM_CHANNEL, TEAM_CHANNEL_PRIVATE]));
  });

  it('starts threads and reactions at the promised main-message strides in every profile', () => {
    for (const profile of Object.keys(PROFILES)) {
      const plan = planFrom(profile);
      expect(rich(plan)).toBe(true);
      for (const room of plan.rooms) {
        expect(room.threads).toEqual(
          Array.from(
            { length: Math.ceil(room.messages / THREAD_EVERY) },
            (_, i) => i * THREAD_EVERY,
          ),
        );
        expect(room.reactions).toEqual(
          Array.from({ length: Math.ceil(room.messages / REACT_EVERY) }, (_, i) => i * REACT_EVERY),
        );
      }
    }
  });

  it('plans authors and feature actors from actual room membership without self reactions', () => {
    for (const profile of Object.keys(PROFILES)) {
      for (const room of planFrom(profile).rooms) {
        const keys = new Set(room.content.map((m) => m.key));
        expect(keys.size).toBe(room.content.length);
        for (const message of room.content) {
          expect(room.members).toContain(message.author);
          if (message.parent !== '') expect(keys.has(message.parent)).toBe(true);
          for (const reaction of message.reactions) {
            expect(room.members).toContain(reaction.author);
            expect(reaction.author).not.toBe(message.author);
          }
          if (message.star !== '') expect(room.members).toContain(message.star);
          if (message.mention !== '') {
            expect(room.members).toContain(message.mention);
            expect(message.mention).not.toBe(message.author);
            expect(message.text).toContain(`@${message.mention}`);
          }
          if (room.kind === DM || room.kind === 'group-dm') expect(message.pin).toBe(false);
        }
      }
    }
  });

  it('keeps direct and group conversations distinct and caps them by participant combinations', () => {
    for (const users of [0, 1, 2, 3, 4, 5, 6]) {
      const plan = planFrom('large', { users });
      const direct = plan.rooms.filter((r) => r.kind === DM);
      const groups = plan.rooms.filter((r) => r.kind === 'group-dm');
      expect(direct.length).toBeLessThanOrEqual((users * (users - 1)) / 2);
      expect(groups.length).toBeLessThanOrEqual(
        users < 3 ? 0 : (users * (users - 1) * (users - 2)) / 6,
      );
      for (const [rooms, size] of [
        [direct, 2],
        [groups, 3],
      ] as const) {
        expect(new Set(rooms.map((r) => [...r.members].sort().join('~'))).size).toBe(rooms.length);
        for (const room of rooms) expect(new Set(room.members).size).toBe(size);
      }
    }
  });

  it('keeps the established derived-room minima and fixtures with a zero public-message override', () => {
    for (const profile of Object.keys(PROFILES)) {
      const plan = planFrom(profile, { messages: 0 });
      for (const room of plan.rooms) {
        if (room.kind === GENERAL || room.kind === CHANNEL) {
          expect(room.messages).toBe(0);
          expect(room.threads).toEqual([]);
          expect(room.reactions).toEqual([]);
        } else if (room.kind === DISCUSSION || room.kind === DM) {
          expect(room.messages).toBe(2);
        } else {
          expect(room.messages).toBe(3);
        }
        if (room.kind === DISCUSSION && room.fromMessage >= 0) {
          expect(named(plan, room.parent)?.messages).toBeGreaterThan(0);
        }
      }
      expect(plan.rooms.reduce((sum, r) => sum + r.files.length, 0)).toBe(
        PROFILES[profile]!.fileSets * 4,
      );
      expect(planTotalMessages(plan)).toBe({ small: 45, standard: 120, large: 378 }[profile]);
    }
  });

  it('recalculates membership and conversation counts for reduced overrides', () => {
    const plan = planFrom('standard', { users: 3, channels: 0, messages: 1 });
    expect([plan.users, plan.channels, plan.messages]).toEqual([3, 0, 1]);
    expect(plan.rooms.filter((r) => r.kind === CHANNEL)).toEqual([]);
    for (const room of plan.rooms) {
      for (const member of room.members) expect(['alice', 'bob', 'carol']).toContain(member);
      if (room.kind === GENERAL) expect(room.messages).toBe(1);
      else if (room.kind === DISCUSSION || room.kind === DM) expect(room.messages).toBe(2);
      else expect(room.messages).toBe(3);
    }
  });

  it('gives general the complete seeded user list and survives no users', () => {
    expect(named(planFrom('standard'), 'general')?.members).toHaveLength(PROFILES.standard!.users);
    const empty = planFrom('small', { users: 0 });
    expect(dms(empty)).toBe(0);
    expect(named(empty, 'general')?.members).toEqual([]);
  });

  it('keeps every room name unique, with a team prefix on child channels', () => {
    const plan = planFrom('large');
    expect(new Set(plan.rooms.map((r) => r.name)).size).toBe(plan.rooms.length);
    for (const room of plan.rooms.filter((r) => r.kind.startsWith('team-channel')))
      expect(room.name.startsWith(`${room.parent}-`)).toBe(true);
  });

  it('is deterministic before execution so repeated runs request the same content', () => {
    expect(planFrom('standard')).toEqual(planFrom('standard'));
  });
});

describe('optional support scenarios and history validation', () => {
  it.each([
    ['small', 16, 88, 13],
    ['standard', 29, 451, 21],
    ['large', 64, 5290, 36],
  ] as const)('plans fixed support scenario additions for %s', (profile, rooms, content, pins) => {
    const plan = planFrom(profile, { scenarios: ['room-states', 'permissions'] });
    expect(plan.rooms).toHaveLength(rooms);
    expect(planTotalMessages(plan)).toBe(content);
    expect(plan.rooms.flatMap((r) => r.content).filter((m) => m.pin)).toHaveLength(pins);
  });

  it('rejects the permissions scenario when fewer than four seeded users are available', () => {
    expect(() => planFrom('small', { users: 3, scenarios: ['permissions'] })).toThrow(/four|4/u);
  });

  it('rejects unknown scenarios and invalid historical windows before execution', () => {
    expect(() => planFrom('small', { scenarios: ['unknown'] })).toThrow(/scenario/u);
    for (const historyDays of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => planFrom('small', { historyDays })).toThrow(/history|historical/u);
  });

  it('keeps normal timestamps optional and preserves profile counts for historical seeding', () => {
    const ordinary = planFrom('standard');
    const historical = planFrom('standard', { historyDays: 180 });
    expect(ordinary.historyDays).toBeNull();
    expect(historical.historyDays).toBe(180);
    expect(counts(historical)).toEqual(counts(ordinary));
  });
});

describe('the profile catalogue and validation', () => {
  it('uses the shared profile catalogue in the order small, standard, large', () => {
    expect(Object.keys(PROFILES)).toEqual(['small', 'standard', 'large']);
    for (const name of Object.keys(PROFILES))
      expect(planFrom(name).users).toBe(PROFILES[name]?.users);
  });

  it('names an unknown profile and lists the real profiles', () => {
    expect(() => planFrom('nope')).toThrow(
      "unknown seed profile 'nope' (want small | standard | large)",
    );
  });

  it('refuses prototype names and preserves the quoted usage error contract', () => {
    const profiles = ['constructor', '__proto__', 'toString', "it's", '', 'Small'];
    const want = '(want small | standard | large)';
    const errors = [
      `unknown seed profile 'constructor' ${want}`,
      `unknown seed profile '__proto__' ${want}`,
      `unknown seed profile 'toString' ${want}`,
      `unknown seed profile "it's" ${want}`,
      `unknown seed profile '' ${want}`,
      `unknown seed profile 'Small' ${want}`,
    ];
    for (const [i, profile] of profiles.entries()) {
      expect(() => planFrom(profile)).toThrow(UnknownProfileError);
      expect(() => planFrom(profile)).toThrow(errors[i]);
    }
  });
});
