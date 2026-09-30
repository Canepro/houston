import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  CHANNEL_NAMES,
  DISCUSSION_NAMES,
  EMOJI,
  FIRST_NAMES,
  MESSAGES,
  PRIVATE_NAMES,
  REPLIES,
  TEAM_CHANNEL_NAMES,
  TEAM_NAMES,
  channelName,
  dmPair,
  isContent,
  members,
  poolName,
  privateName,
  teamChannelName,
  teamName,
  threads,
  username,
} from '../../src/seed/wording';
import { DM } from '../../src/seed/kinds';
import { planFrom } from '../../src/seed/plan';

/**
 * What earlier releases ship and derive, recorded: the name pools in order, the names derived
 * past each pool, the membership rotations and the DM pair walk, for the inputs below.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'seed', 'wording.json'), 'utf8'),
) as {
  pools: Record<string, string[]>;
  derived: Record<string, string[]>;
  members: string[][];
  dm_pairs: string[][];
};

describe('the name pools', () => {
  it('are the pools earlier releases ship, in order', () => {
    // ORDER is the contract, not just membership: `username(i)` indexes into these, so a
    // reordered pool renames every seeded user and every room.
    expect({
      first: [...FIRST_NAMES],
      channel: [...CHANNEL_NAMES],
      private: [...PRIVATE_NAMES],
      team: [...TEAM_NAMES],
      teamch: [...TEAM_CHANNEL_NAMES],
      disc: [...DISCUSSION_NAMES],
      messages: [...MESSAGES],
      replies: [...REPLIES],
      emoji: [...EMOJI],
    }).toEqual(RECORDED.pools);
  });

  it('avoids the userN names the ldap and saml presets use', () => {
    // A seeded `user1` and an LDAP `user1` are two different accounts with the same name,
    // and the second create fails on a workspace running both.
    for (const name of FIRST_NAMES) expect(name).not.toMatch(/^user\d+$/u);
  });
});

describe('the derived names', () => {
  it('suffix on overflow, exactly as earlier releases do', () => {
    // Recorded: usernames 0-59, channels 0-29, private rooms 0-11, teams 0-8, team channels
    // for teams 0-3 by channels 0-5, and discussion names 0-13 joined with a space.
    const recorded = RECORDED.derived;
    expect([...Array(60)].map((_, i) => username(i))).toEqual(recorded.u);
    expect([...Array(30)].map((_, i) => channelName(i))).toEqual(recorded.c);
    expect([...Array(12)].map((_, i) => privateName(i))).toEqual(recorded.p);
    expect([...Array(9)].map((_, i) => teamName(i))).toEqual(recorded.t);
    const tc: string[] = [];
    for (let t = 0; t < 4; t += 1) for (let c = 0; c < 6; c += 1) tc.push(teamChannelName(t, c));
    expect(tc).toEqual(recorded.tc);
    expect([...Array(14)].map((_, i) => poolName(DISCUSSION_NAMES, i, ' '))).toEqual(recorded.d);
  });

  it('prefixes a team channel with its team, because names are workspace-unique', () => {
    // Two teams both wanting `planning` is the common case, and the second create would
    // fail with a name clash rather than producing the second team's channel.
    expect(teamChannelName(0, 0)).toBe('platform-planning');
    expect(teamChannelName(1, 0)).toBe('customer-success-planning');
    expect(teamChannelName(0, 0)).not.toBe(teamChannelName(1, 0));
  });
});

describe('the deterministic choices', () => {
  it('rotates membership without randomness, as earlier releases do', () => {
    const names = [...Array(9)].map((_, i) => username(i));
    const ours: string[][] = [];
    for (let i = 0; i < 12; i += 1) for (const s of [1, 3, 4, 20]) ours.push(members(names, i, s));
    expect(ours).toEqual(RECORDED.members);
    expect(members([], 0, 3)).toEqual([]);
  });

  it('walks DM pairs so none repeats early, as earlier releases do', () => {
    const names = [...Array(6)].map((_, i) => username(i));
    expect([...Array(25)].map((_, i) => dmPair(names, i))).toEqual(RECORDED.dm_pairs);
  });

  it('picks thread indexes on a stride, and none at all with no messages', () => {
    expect(threads(11)).toEqual([0, 5, 10]);
    expect(threads(11, 3)).toEqual([0, 3, 6, 9]);
    expect(threads(0)).toEqual([]);
  });
});

describe('telling a person apart from the server', () => {
  it('treats anything carrying a `t` as a system message', () => {
    // There are dozens -- `uj`, `au`, `ru`, `room_changed_topic`, `discussion-created` --
    // so the rule is the presence of the field, which is what the client uses to decide
    // whether to render a grey line.
    expect(isContent({ msg: 'hello' })).toBe(true);
    expect(isContent({ msg: 'x', t: 'uj' })).toBe(false);
    expect(isContent({ msg: 'x', t: 'discussion-created' })).toBe(false);
    // An empty `t` is no type at all to earlier releases, so it is content there and must
    // be here.
    expect(isContent({ msg: 'x', t: '' })).toBe(true);
    expect(isContent({})).toBe(true);
  });

  it('agrees with earlier releases on every shape a message arrives in', () => {
    const shapes = [
      { msg: 'hello' },
      { msg: 'x', t: 'uj' },
      { msg: 'x', t: '' },
      { msg: 'x', t: null },
      {},
      { t: 0 },
      { t: false },
    ];
    const recorded = [true, false, true, true, true, true, true];
    expect(shapes.map((m) => isContent(m))).toEqual(recorded);
  });
});

describe('names that must never collide', () => {
  it('never repeats a user or channel name, even past the pool, and never uses userN', () => {
    // ldap/saml presets use user1..userN; a seeded `user1` would be a second account with
    // the same name, and the second create fails on a workspace running both.
    const users = [...Array(60)].map((_, i) => username(i));
    for (const name of users) expect(name.startsWith('user')).toBe(false);
    expect(new Set(users).size).toBe(users.length);
    expect(users[0]).toBe('alice');
    const channels = [...Array(30)].map((_, i) => channelName(i));
    expect(new Set(channels).size).toBe(channels.length);
  });

  it('does not repeat a DM pair while there are pairs left, in any profile', () => {
    // A repeated pair's second `im.create` returns the SAME room, so a plan asking for
    // five DM rooms could quietly produce four. `gap == n / 2` on an even count folds back
    // onto pairs an earlier gap produced, so the bound is floor((n-1)/2) bands, not floor(n/2).
    for (const n of [5, 6, 20]) {
      const names = [...Array(n)].map((_, i) => username(i));
      const count = n * Math.floor((n - 1) / 2);
      const pairs = [...Array(count)].map((_, i) => [...dmPair(names, i)].sort().join('~'));
      expect(new Set(pairs).size).toBe(pairs.length);
      for (let i = 0; i < count; i += 1) {
        const [a, b] = dmPair(names, i);
        expect(a).not.toBe(b);
      }
    }
    for (const profile of ['small', 'standard', 'large']) {
      const rooms = planFrom(profile).rooms.filter((r) => r.kind === DM);
      const distinct = new Set(rooms.map((r) => [...r.members].sort().join('~')));
      expect(distinct.size).toBe(rooms.length);
    }
  });
});
