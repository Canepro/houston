import * as fs from 'node:fs';
import * as path from 'node:path';

import { ANCHOR_MESSAGES, DISCUSSION, DM, TEAM_CHANNEL } from '../../src/seed/kinds';
import {
  type Plan,
  type RoomFacts,
  planFrom,
  reacted,
  replies,
  roomFacts,
  totalMessages,
} from '../../src/seed/plan';
import { username } from '../../src/seed/wording';

import type * as CheckNS from '../../src/seed/check';

const AUTH = { token: 't', userId: 'u' };

/** The readback a perfect seed would produce, built from the plan itself. */
function perfectFacts(plan: Plan): CheckNS.Facts {
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
  return { rooms, users_found: [...planned], users_unreadable: '', planned_users: planned };
}

function load(): typeof CheckNS {
  jest.resetModules();
  jest.doMock('../../src/core/rcapi', () => ({
    RequestFailed: class RequestFailed extends Error {},
    authHeaders: () => ({}),
    login: () => Promise.reject(new Error('no server')),
    rcapi: { call: () => Promise.resolve([500, '{}'] as [number, string]) },
  }));
  return require('../../src/seed/check') as typeof CheckNS;
}

describe('the verdict', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('passes a workspace that holds exactly what was planned', () => {
    const check = load();
    const plan = planFrom('standard');
    const verdict = check.verify(plan, perfectFacts(plan));
    expect(verdict.ok).toBe(true);
    expect(verdict.faults).toEqual([]);
    expect(verdict.extra).toEqual([]);
    expect(verdict.checked).toBe(plan.rooms.length);
  });

  it('reports MORE than planned without calling it a fault', () => {
    // Seeding only ever adds, so `got > want` cannot be evidence this run lost anything:
    // the room already held content, which is what a second `houston seed`, a preset that
    // posts on boot, and a restored backup all look like. Gating on exact equality is what
    // made the earlier version refuse a workspace that was working.
    const check = load();
    const plan = planFrom('small');
    const facts = perfectFacts(plan);
    (facts.rooms[0] as RoomFacts).messages += 40;
    const verdict = check.verify(plan, facts);
    expect(verdict.ok).toBe(true);
    expect(verdict.extra).toEqual([
      {
        kind: 'messages',
        room: plan.rooms[0]?.name,
        want: totalMessages(plan.rooms[0]!),
        got: totalMessages(plan.rooms[0]!) + 40,
      },
    ]);
  });

  it('reports LESS than planned as a fault, named by room', () => {
    const check = load();
    const plan = planFrom('small');
    const facts = perfectFacts(plan);
    (facts.rooms[0] as RoomFacts).messages -= 1;
    const verdict = check.verify(plan, facts);
    expect(verdict.ok).toBe(false);
    expect(verdict.faults[0]?.kind).toBe('messages');
    expect(verdict.faults[0]?.room).toBe(plan.rooms[0]?.name);
  });

  it('catches a discussion that lost its anchor', () => {
    // The `pmid` variant was dead code for a while and nothing noticed. It is caught by the
    // message count rather than by a check of its own: a discussion opened from a message
    // arrives holding ANCHOR_MESSAGES it did not post, so a `pmid` that stops being sent
    // makes the room come back exactly that much short.
    const check = load();
    const plan = planFrom('standard');
    const facts = perfectFacts(plan);
    const anchored = plan.rooms.find((r) => r.kind === DISCUSSION && r.fromMessage >= 0);
    const lost = facts.rooms.find((f) => f.spec === anchored);
    lost!.messages -= ANCHOR_MESSAGES;
    const verdict = check.verify(plan, facts);
    expect(verdict.ok).toBe(false);
    expect(verdict.faults[0]?.room).toBe(anchored?.name);
  });

  it('separates a room that is GONE from a room it could not read', () => {
    // RC answers a lookup for a missing room with 400 + `error-room-not-found`, which is an
    // ANSWER. Filing that under `unreadable` -- where nothing counts it as a fault -- let a
    // workspace missing a room verify clean. Found live, by deleting one.
    const check = load();
    const plan = planFrom('small');
    const absent = perfectFacts(plan);
    (absent.rooms[0] as RoomFacts).found = false;
    expect(check.verify(plan, absent).faults[0]?.kind).toBe('missing');

    const unreadable = perfectFacts(plan);
    (unreadable.rooms[0] as RoomFacts).unreadable = 'HTTP 502';
    const verdict = check.verify(plan, unreadable);
    expect(verdict.faults).toEqual([]);
    expect(verdict.unreadable).toEqual([{ what: plan.rooms[0]?.name, why: 'HTTP 502' }]);
  });

  it('reports a team channel that exists and is not in its team', () => {
    // A channel can exist and NOT be in the team, which looks identical from
    // `channels.info` -- and is the whole difference between a team workspace and a
    // workspace with similarly-named channels.
    const check = load();
    const plan = planFrom('standard');
    const facts = perfectFacts(plan);
    const stray = facts.rooms.find((f) => f.spec.kind === TEAM_CHANNEL);
    stray!.inTeam = false;
    const verdict = check.verify(plan, facts);
    expect(verdict.ok).toBe(false);
    expect(verdict.faults.map((f) => f.kind)).toContain('team');
    expect(verdict.faults.find((f) => f.kind === 'team')?.got).toBe('not in the team');
  });

  it('names the users that are missing, and stays quiet when the list is unreadable', () => {
    const check = load();
    const plan = planFrom('small');
    const facts = perfectFacts(plan);
    const short = { ...facts, users_found: facts.users_found.slice(0, 2) };
    const verdict = check.verify(plan, short);
    expect(verdict.faults[0]?.kind).toBe('users');
    expect(String(verdict.faults[0]?.detail)).toContain(username(2));

    const blind = { ...facts, users_found: [], users_unreadable: 'HTTP 500' };
    const second = check.verify(plan, blind);
    expect(second.faults).toEqual([]);
    expect(second.unreadable).toEqual([{ what: 'users', why: 'HTTP 500' }]);
  });

  it('answers with findings rather than raising, whatever it found', () => {
    // Whether a mismatch should end the command is the CALLER's decision. A verifier that
    // fails a healthy workspace teaches people to pass the override by reflex, and then it
    // is protecting nothing.
    const check = load();
    const plan = planFrom('small');
    const facts = perfectFacts(plan);
    for (const f of facts.rooms) f.found = false;
    expect(() => check.verify(plan, facts)).not.toThrow();
    expect(check.verify(plan, facts).ok).toBe(false);
  });

  it('carries every planned room into the report, wanted and got side by side', () => {
    const check = load();
    const plan = planFrom('small');
    const rows = check.verify(plan, perfectFacts(plan)).rooms;
    expect(rows).toHaveLength(plan.rooms.length);
    for (const row of rows) {
      expect(row.messages).toBe(row.want_messages);
      expect(row.replies).toBe(row.want_replies);
      expect(row.reacted).toBe(row.want_reacted);
    }
    expect(rows.some((r) => r.kind === DM)).toBe(true);
  });
});

describe('the readback', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('reads a DM as one of its two users, because the admin cannot see it', async () => {
    // A direct message belongs to its two users and is invisible to everyone else, so a
    // readback that only used the admin token would report every DM missing.
    jest.resetModules();
    const asked: { path: string; auth: string }[] = [];
    // The fake inbox holds every seeded user, so whichever pair the manifest picked is
    // found -- the assertion is about WHO asked, not about which pair it was.
    const everyone: string[] = [];
    jest.doMock('../../src/core/rcapi', () => ({
      RequestFailed: class RequestFailed extends Error {},
      authHeaders: (a: { token: string }) => ({ 'X-Auth-Token': a.token }),
      login: (_root: string, opts: { user: string }) =>
        Promise.resolve({ token: `t-${opts.user}`, userId: opts.user }),
      rcapi: {
        call: (_root: string, _method: string, path: string, opts: Record<string, unknown>) => {
          const headers = (opts.extraHeaders ?? {}) as Record<string, string>;
          asked.push({ path, auth: headers['X-Auth-Token'] ?? '' });
          if (path.includes('im.list')) {
            return Promise.resolve([
              200,
              JSON.stringify({ ims: [{ _id: 'dm1', usernames: everyone }] }),
            ] as [number, string]);
          }
          if (path.includes('.messages')) {
            return Promise.resolve([200, JSON.stringify({ messages: [] })] as [number, string]);
          }
          if (path.includes('users.list')) {
            return Promise.resolve([200, JSON.stringify({ users: [] })] as [number, string]);
          }
          return Promise.resolve([400, JSON.stringify({ errorType: 'error-room-not-found' })] as [
            number,
            string,
          ]);
        },
      },
    }));
    const check = require('../../src/seed/check') as typeof CheckNS;
    const plan = planFrom('small');
    for (let i = 0; i < plan.users; i += 1) everyone.push(username(i));
    const facts = await check.readback('http://x', AUTH, plan);
    const dm = facts.rooms.find((f) => f.spec.kind === DM);
    expect(dm?.found).toBe(true);
    // Asked as the DM's own first member, not as the admin.
    const imCall = asked.find((a) => a.path.includes('im.list'));
    expect(imCall?.auth).toBe(`t-${String(dm?.spec.members[0])}`);
    // And a room the server says is gone is ABSENT, not unreadable.
    const channel = facts.rooms.find((f) => f.spec.kind === 'channel');
    expect(channel?.found).toBe(false);
    expect(channel?.unreadable).toBe('');
  });

  it('prefers the sessions the seeder already minted', async () => {
    // Seeding turns email-2FA off for its own logins and back on afterwards, so by the time
    // this runs a fresh sign-in needs a code from a mailbox that does not exist.
    jest.resetModules();
    let loginCalls = 0;
    jest.doMock('../../src/core/rcapi', () => ({
      RequestFailed: class RequestFailed extends Error {},
      authHeaders: (a: { token: string }) => ({ 'X-Auth-Token': a.token }),
      login: () => {
        loginCalls += 1;
        return Promise.reject(new Error('2FA required'));
      },
      rcapi: {
        call: (_r: string, _m: string, path: string) =>
          Promise.resolve(
            path.includes('im.list')
              ? ([200, JSON.stringify({ ims: [] })] as [number, string])
              : ([200, JSON.stringify({ messages: [], users: [] })] as [number, string]),
          ),
      },
    }));
    const check = require('../../src/seed/check') as typeof CheckNS;
    const plan = planFrom('small');
    const tokens: Record<string, { token: string; userId: string }> = {};
    for (let i = 0; i < plan.users; i += 1) {
      tokens[username(i)] = { token: `seeded-${username(i)}`, userId: username(i) };
    }
    await check.readback('http://x', AUTH, plan, { tokens });
    expect(loginCalls).toBe(0);
  });
});

describe('a reaction that did not land', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('reports fewer reactions than planned as a fault', () => {
    const check = load();
    const plan = planFrom('standard');
    const facts = perfectFacts(plan);
    (facts.rooms[0] as RoomFacts).reacted -= 1;
    const verdict = check.verify(plan, facts);
    expect(verdict.ok).toBe(false);
    expect(verdict.faults[0]?.kind).toBe('reactions');
  });
});

describe('a malformed answer, read as earlier releases read it', () => {
  // Every field lookup, fallback, loop and integer conversion earlier releases' readback
  // applies to an answer raises on a shape Rocket.Chat does not send; the seed check then
  // reports "could not run" and records nothing. This build read the same answers leniently
  // and went on to report -- and record -- a verdict earlier releases never reached. Each
  // table is one world: which paths answer what, the rest "room not found". What earlier
  // releases answered for each -- the error or the verdict, and the requests made -- is
  // recorded, keyed by the table's label.
  const RECORDED = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'seed', 'check.json'), 'utf8'),
  ) as Record<string, unknown>;
  const found = (extra: Record<string, [number, string]>): Record<string, [number, string]> => ({
    '/api/v1/channels.info': [200, JSON.stringify({ channel: { _id: 'r1' } })],
    '/api/v1/channels.messages': [200, JSON.stringify({ messages: [] })],
    ...extra,
  });
  const TABLES: [string, Record<string, [number, string]>][] = [
    ['users.list answers a list', { '/api/v1/users.list': [200, '[1]'] }],
    ['users.list answers a bare number', { '/api/v1/users.list': [200, '5'] }],
    [
      'a threads total that is not a number',
      found({ '/api/v1/chat.getThreadsList': [200, '{"total": "abc"}'] }),
    ],
    [
      'a threads total that is NaN',
      found({ '/api/v1/chat.getThreadsList': [200, '{"total": NaN}'] }),
    ],
    [
      'a threads total that is a numeric string',
      found({ '/api/v1/chat.getThreadsList': [200, '{"total": " 1_2 "}'] }),
    ],
    [
      'a threads total that is a list',
      found({ '/api/v1/chat.getThreadsList': [200, '{"total": [3]}'] }),
    ],
    [
      'a message that is not a dict',
      found({ '/api/v1/channels.messages': [200, '{"messages": [5]}'] }),
    ],
    [
      'a messages value that is a string',
      found({ '/api/v1/channels.messages': [200, '{"messages": "ab"}'] }),
    ],
    [
      'a message whose t is an empty list',
      found({ '/api/v1/channels.messages': [200, '{"messages": [{"t": [], "tmid": "x"}]}'] }),
    ],
    [
      'a room not found, answered as a list',
      { '/api/v1/channels.info': [400, '["error-room-not-found"]'] },
    ],
    ['a 500 answered as a list', { '/api/v1/channels.info': [500, '["x"]'] }],
    ['a channel that is a list', { '/api/v1/channels.info': [200, '{"channel": [1]}'] }],
    ['an im.list that is a number', { '/api/v1/im.list': [200, '{"ims": 5}'] }],
    ['DM usernames that are a number', { '/api/v1/im.list': [200, '{"ims": [{"usernames": 7}]}'] }],
    [
      'DM usernames that are one string',
      {
        '/api/v1/im.list': [
          200,
          '{"update": [{"_id": "d", "usernames": "alice bob carol dave erin"}]}',
        ],
      },
    ],
    [
      'a username that is a list',
      { '/api/v1/users.list': [200, '{"users": [{"username": ["x"]}]}'] },
    ],
    ['a teamInfo that is a list', found({ '/api/v1/teams.info': [200, '{"teamInfo": [1]}'] })],
    ['a room id that is a number', { '/api/v1/channels.info': [200, '{"channel": {"_id": 7}}'] }],
  ];
  afterEach(() => {
    jest.resetModules();
  });

  it('raises where earlier releases raise, in their words, after the same requests', async () => {
    const ours: unknown[] = [];
    for (const [, table] of TABLES) {
      jest.resetModules();
      const asked: [string, Record<string, string>][] = [];
      jest.doMock('../../src/core/rcapi', () => ({
        RequestFailed: class RequestFailed extends Error {},
        authHeaders: (a: { token: string }) => ({ 'X-Auth-Token': a.token }),
        login: () => Promise.reject(new Error('no login')),
        rcapi: {
          call: (_root: string, _method: string, path: string, opts: Record<string, unknown>) => {
            const params = (opts.params ?? {}) as Record<string, unknown>;
            asked.push([
              path,
              Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
            ]);
            return Promise.resolve(
              table[path] ?? ([400, '{"errorType": "error-room-not-found"}'] as [number, string]),
            );
          },
        },
      }));
      const check = require('../../src/seed/check') as typeof CheckNS;
      const plan = planFrom('small');
      const tokens: Record<string, { token: string; userId: string }> = {};
      for (let i = 0; i < plan.users; i += 1) tokens[username(i)] = { token: 't', userId: 'u' };
      let res: Record<string, unknown>;
      try {
        const facts = await check.readback('http://x', { token: 'a', userId: 'b' }, plan, {
          tokens,
        });
        const v = check.verify(plan, facts);
        res = {
          error: null,
          verdict: {
            ok: v.ok,
            faults: v.faults,
            extra: v.extra,
            unreadable: v.unreadable,
            checked: v.checked,
          },
          threads: v.rooms.map((r) => r.threads),
        };
      } catch (error) {
        res = { error: (error as Error).message };
      }
      res.asked = asked;
      ours.push(res);
    }
    expect(Object.fromEntries(TABLES.map(([label], i) => [label, ours[i]]))).toEqual(
      Object.fromEntries(TABLES.map(([label]) => [label, RECORDED[label]])),
    );
  });
});
