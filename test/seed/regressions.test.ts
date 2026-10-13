import type * as ApplyNS from '../../src/seed/apply';
import type * as ReceiptNS from '../../src/seed/receipt';
import type * as ExecNS from '../../src/seams/exec';
import { DISCUSSION, DM, TEAM, TEAM_CHANNEL } from '../../src/seed/kinds';
import { type Plan, type RoomSpec, planFrom } from '../../src/seed/plan';

type Bag = Record<string, unknown>;
interface Request {
  readonly method: string;
  readonly path: string;
  readonly payload: Bag;
  readonly params: Bag;
  readonly user: string;
}
type Reply = readonly [number, Bag, Record<string, string>?];

const ADMIN = { token: 'admin-token', userId: 'admin-id' };
const participantLogin = async (_root: string, who: { user: string }) => ({
  token: `token-${who.user}`,
  userId: `user-${who.user}`,
});

/** A seed plan with one relevant path; assets are covered separately. */
function isolated(plan: Plan, select: (room: RoomSpec) => boolean): Plan {
  return Object.assign(
    {
      ...plan,
      rooms: plan.rooms.filter(select).map((r) => {
        const content = (r as { readonly content?: RoomSpec['content'] }).content;
        return { ...r, files: [], content: content?.filter((m) => m.kind !== 'file') ?? [] };
      }),
    },
    { customEmoji: [] },
  );
}

function load(
  reply?: (request: Request) => Reply | undefined,
  options: { limiterOn?: boolean } = {},
): {
  mod: typeof ApplyNS;
  requests: Request[];
  sleep: jest.Mock<Promise<void>, [number]>;
  settings: [string, unknown][];
} {
  jest.resetModules();
  const requests: Request[] = [];
  const settings: [string, unknown][] = [];
  const sleep = jest.fn<Promise<void>, [number]>(() => Promise.resolve());
  jest.doMock('../../src/seams/exec', () => ({
    ...jest.requireActual<typeof ExecNS>('../../src/seams/exec'),
    sleep,
  }));
  let next = 0;
  jest.doMock('../../src/core/rcapi', () => ({
    RequestFailed: class RequestFailed extends Error {},
    authHeaders: (auth: { token: string; userId: string }) => ({
      'X-Auth-Token': auth.token,
      'X-User-Id': auth.userId,
    }),
    login: participantLogin,
    password2faHeaders: () => Promise.resolve({}),
    getSetting: (_root: string, _auth: unknown, _password: string, setting: string) =>
      Promise.resolve(options.limiterOn === true && setting === 'API_Enable_Rate_Limiter'),
    setSetting: (
      _root: string,
      _auth: unknown,
      _password: string,
      setting: string,
      value: unknown,
    ) => {
      settings.push([setting, value]);
      return Promise.resolve(true);
    },
    rcapi: {
      multipart: () => Promise.resolve([200, JSON.stringify({ success: true })]),
      download: () =>
        Promise.resolve({
          status: 200,
          ok: true,
          text: '',
          bytes: Buffer.alloc(0),
          headers: {},
          url: 'http://x/file',
        }),
      call: (_root: string, method: string, requestPath: string, options: Bag) => {
        const request: Request = {
          method,
          path: requestPath,
          payload: (options.data ?? {}) as Bag,
          params: (options.params ?? {}) as Bag,
          user: ((options.extraHeaders ?? {}) as Bag)['X-User-Id'] as string,
        };
        requests.push(request);
        next += 1;
        const answer = reply?.(request) ?? defaultReply(request, `id-${String(next)}`);
        Object.assign(options.responseHeaders ?? {}, answer[2] ?? {});
        return Promise.resolve([answer[0], JSON.stringify(answer[1])] as [number, string]);
      },
    },
  }));
  jest.doMock('../../src/core/journal', () => ({
    RATE_LIMITER_OFF: 'rate-limiter',
    EMAIL_2FA_OFF: 'email-2fa',
    record: () => 'note',
    clear: () => undefined,
  }));
  return { mod: require('../../src/seed/apply') as typeof ApplyNS, requests, sleep, settings };
}

function defaultReply(request: Request, id: string): Reply {
  const { method, path, payload, params } = request;
  if (method === 'GET') {
    if (path === '/api/v1/rooms.adminRooms.getRoom' && params.rid === 'GENERAL') {
      return [200, { success: true, room: { _id: 'GENERAL', name: 'general', t: 'c' } }];
    }
    if (path === '/api/v1/channels.info' && params.roomName === 'general') {
      return [200, { success: true, channel: { _id: 'general-id', name: 'general', t: 'c' } }];
    }
    if (path === '/api/v1/rooms.getDiscussions') {
      return [200, { success: true, discussions: [], count: 0, offset: 0, total: 0 }];
    }
    if (path === '/api/v1/chat.getDiscussions') {
      return [200, { success: true, messages: [], count: 0, offset: 0, total: 0 }];
    }
    return [400, { success: false, errorType: 'error-room-not-found' }];
  }
  if (path === '/api/v1/users.create') {
    return [200, { success: true, user: { _id: `user-${String(payload.username)}` } }];
  }
  if (path === '/api/v1/teams.create') {
    return [200, { success: true, team: { _id: `team-${String(payload.name)}`, roomId: id } }];
  }
  if (path === '/api/v1/rooms.createDiscussion') {
    return [200, { success: true, discussion: { _id: id, prid: payload.prid, t: 'c' } }];
  }
  if (/\/(?:im|dm)\.create$/u.test(path))
    return [200, { success: true, room: { _id: id, t: 'd' } }];
  if (path === '/api/v1/groups.create') {
    return [200, { success: true, group: { _id: id, name: payload.name, t: 'p' } }];
  }
  if (path === '/api/v1/channels.create') {
    return [200, { success: true, channel: { _id: id, name: payload.name, t: 'c' } }];
  }
  if (path === '/api/v1/chat.sendMessage') {
    const message = payload.message as Bag;
    return [200, { success: true, message: { ...message, _id: message._id ?? id } }];
  }
  return [200, { success: true }];
}

describe('seed correctness regressions', () => {
  afterEach(() => jest.resetModules());

  it('finishes every captured message and reaction after limiter-disable acknowledgement and explicit 429 refusals', async () => {
    const plan = isolated(
      planFrom('small', { users: 3, messages: 3 }),
      (r) => r.name === 'general',
    );
    const refused = new Set<string>();
    const { mod, requests, sleep, settings } = load(
      ({ path }) => {
        if (
          ['/api/v1/chat.sendMessage', '/api/v1/chat.react'].includes(path) &&
          !refused.has(path)
        ) {
          refused.add(path);
          return [
            429,
            {
              success: false,
              error:
                'Error, too many requests. Please slow down. You must wait 1 seconds before trying this endpoint again. [error-too-many-requests]',
            },
            { 'retry-after': '1' },
          ];
        }
        return undefined;
      },
      { limiterOn: true },
    );
    const Receipt = (require('../../src/seed/receipt') as typeof ReceiptNS).Receipt;
    const receipt = new Receipt(plan, 'rate-limited-database', 'rate-limited-seed');
    const result = await mod.seed('http://x', ADMIN, plan, {
      login: participantLogin,
      receipt,
    });
    const content = plan.rooms[0]!.content;
    expect(result.failed).toEqual([]);
    expect(result.messages).toBe(content.length);
    expect(result.reactions).toBe(content.reduce((sum, item) => sum + item.reactions.length, 0));
    expect(settings).toEqual([
      ['API_Enable_Rate_Limiter', false],
      ['API_Enable_Rate_Limiter', true],
    ]);
    expect(sleep.mock.calls).toEqual([[1250], [1250]]);
    for (const item of content) {
      const key = `message:general:${item.key}`;
      const done = receipt.done(key);
      expect(done).toMatchObject({ id: receipt.identifier(key), text: item.text });
      expect(receipt.intent(key)).toBeNull();
    }
    const sends = requests.filter((request) => request.path === '/api/v1/chat.sendMessage');
    expect(sends).toHaveLength(content.length + 1);
    expect(sends[0]?.payload).toEqual(sends[1]?.payload);
    expect(sends[0]?.user).toBe(sends[1]?.user);
    const reactions = requests.filter((request) => request.path === '/api/v1/chat.react');
    expect(reactions[0]?.payload).toEqual(reactions[1]?.payload);
    expect(reactions[0]?.user).toBe(reactions[1]?.user);
  });

  it('never substitutes admin for a DM participant who cannot sign in', async () => {
    const plan = isolated(planFrom('small', { users: 2, messages: 1 }), (r) => r.kind === DM);
    const { mod, requests } = load();
    const result = await mod.seed('http://x', ADMIN, plan, {
      login: async () => {
        throw new Error('participant login denied');
      },
    });
    expect(requests.filter((r) => /\/(?:im|dm)\.create$/u.test(r.path))).toEqual([]);
    expect(requests.filter((r) => r.path === '/api/v1/chat.sendMessage')).toEqual([]);
    expect(requests.filter((r) => r.path === '/api/v1/chat.react')).toEqual([]);
    expect(result.dms).toBe(0);
    expect(result.failed).toEqual([
      expect.objectContaining({ name: plan.rooms[0]?.name, why: expect.any(String) }),
    ]);
  });

  it('uses another participant for reactions and explicitly enables each reaction', async () => {
    const plan = isolated(
      planFrom('standard', { users: 3, messages: 6 }),
      (r) => r.name === 'general',
    );
    const { mod, requests } = load();
    await mod.seed('http://x', ADMIN, plan, { login: participantLogin });
    const authors = new Map<string, string>();
    const messages = requests.filter((r) => r.path === '/api/v1/chat.sendMessage');
    // The fake server returns the request's explicit id where supplied, otherwise its call id.
    for (const request of messages) {
      const message = request.payload.message as Bag;
      const id = String(message._id ?? `id-${String(requests.indexOf(request) + 1)}`);
      authors.set(id, request.user);
    }
    const reactions = requests.filter((r) => r.path === '/api/v1/chat.react');
    expect(reactions.length).toBeGreaterThan(0);
    for (const request of reactions) {
      expect(authors.has(String(request.payload.messageId))).toBe(true);
      expect(request.user).not.toBe(authors.get(String(request.payload.messageId)));
      expect(request.payload.shouldReact).toBe(true);
    }
  });

  it('retains a reused team id and reconciles team membership before adding a child room', async () => {
    const plan = isolated(
      planFrom('standard', { users: 4, messages: 0 }),
      (r) =>
        (r.kind === TEAM && r.name === 'platform') ||
        (r.kind === TEAM_CHANNEL && r.parent === 'platform'),
    );
    const { mod, requests } = load(({ path, params }) => {
      if (path === '/api/v1/teams.create')
        return [400, { success: false, error: 'name-already-exists' }];
      if (path === '/api/v1/teams.info') {
        return [
          200,
          {
            success: true,
            teamInfo: { _id: 'existing-team', roomId: 'existing-main', name: 'platform', type: 0 },
          },
        ];
      }
      if (path === '/api/v1/channels.info' && params.roomName === 'platform') {
        return [
          200,
          {
            success: true,
            channel: {
              _id: 'existing-main',
              name: 'platform',
              t: 'c',
              teamId: 'existing-team',
              teamMain: true,
            },
          },
        ];
      }
      if (path === '/api/v1/rooms.info' && params.roomId === 'existing-main')
        return [
          200,
          {
            success: true,
            room: {
              _id: 'existing-main',
              name: 'platform',
              t: 'c',
              teamId: 'existing-team',
              teamMain: true,
            },
          },
        ];
      return undefined;
    });
    await mod.seed('http://x', ADMIN, plan, { login: participantLogin });
    const child = requests.find((r) => r.path === '/api/v1/channels.create');
    expect(child?.payload.extraData).toEqual(expect.objectContaining({ teamId: 'existing-team' }));
    const additions = requests.filter((r) => r.path === '/api/v1/teams.addMembers');
    const members = additions.flatMap((r) =>
      (r.payload.members as (string | Bag)[]).map((m) =>
        typeof m === 'string' ? m : String(m.userId),
      ),
    );
    for (const member of plan.rooms[0]?.members ?? []) expect(members).toContain(`user-${member}`);
  });

  it('reuses only the discussion with the exact title and parent', async () => {
    const plan = discussionPlan();
    const discussion = plan.rooms.find((r) => r.kind === DISCUSSION)!;
    const { mod, requests } = load((request) =>
      discussionReply(request, discussion, [
        { drid: 'wrong-discussion', rid: 'unrelated-parent', msg: discussion.name },
        { drid: 'expected-discussion', rid: 'parent-id', msg: discussion.name },
      ]),
    );
    const result = await mod.seed('http://x', ADMIN, plan, { login: participantLogin });
    expect(requests.filter((r) => r.path === '/api/v1/rooms.createDiscussion')).toEqual([]);
    expect(result.created).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: discussion.name,
          rid: 'expected-discussion',
          reused: true,
        }),
      ]),
    );
  });

  it('reports ambiguous discussions instead of choosing one or creating another', async () => {
    const plan = discussionPlan();
    const discussion = plan.rooms.find((r) => r.kind === DISCUSSION)!;
    const { mod, requests } = load((request) =>
      discussionReply(request, discussion, [
        { drid: 'candidate-a', rid: 'parent-id', msg: discussion.name },
        { drid: 'candidate-b', rid: 'parent-id', msg: discussion.name },
      ]),
    );
    const result = await mod.seed('http://x', ADMIN, plan, { login: participantLogin });
    expect(result.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: discussion.name,
          why: expect.stringMatching(/ambiguous/iu),
        }),
      ]),
    );
    expect(requests.filter((r) => r.path === '/api/v1/rooms.createDiscussion')).toEqual([]);
  });

  it('varies reply wording across separate threads rather than repeating one sentence', async () => {
    const plan = isolated(
      planFrom('standard', { users: 3, messages: 11 }),
      (r) => r.name === 'general',
    );
    const { mod, requests } = load();
    await mod.seed('http://x', ADMIN, plan, { login: participantLogin });
    const replies = requests
      .filter((r) => r.path === '/api/v1/chat.sendMessage')
      .map((r) => r.payload.message as Bag)
      .filter((m) => typeof m.tmid === 'string');
    expect(new Set(replies.map((m) => m.tmid)).size).toBeGreaterThan(1);
    expect(new Set(replies.map((m) => m.msg)).size).toBeGreaterThan(1);
    for (const reply of replies)
      expect(String(reply.msg)).not.toMatch(/reproduced on \d+\.\d+\.\d+/u);
  });

  it('does not count a message rejected by a successful HTTP response body', async () => {
    const plan = isolated(
      planFrom('standard', { users: 3, messages: 1 }),
      (r) => r.name === 'general',
    );
    const { mod } = load(({ path }) =>
      path === '/api/v1/chat.sendMessage'
        ? [200, { success: false, error: 'not-allowed' }]
        : undefined,
    );
    const result = await mod.seed('http://x', ADMIN, plan, { login: participantLogin });
    expect(result.messages).toBe(0);
  });
});

function discussionPlan(): Plan {
  const base = planFrom('small', { users: 3, messages: 1 });
  const discussion = base.rooms.find((r) => r.kind === DISCUSSION)!;
  return isolated(base, (r) => r.name === discussion.parent || r === discussion);
}

function discussionReply(request: Request, spec: RoomSpec, listings: Bag[]): Reply | undefined {
  if (request.path === '/api/v1/channels.create' || request.path === '/api/v1/groups.create') {
    return [200, { success: true, channel: { _id: 'parent-id', name: spec.parent, t: 'c' } }];
  }
  if (request.path === '/api/v1/rooms.getDiscussions') {
    return [
      200,
      {
        success: true,
        discussions: listings.map((listing) => ({
          _id: listing.drid,
          prid: listing.rid,
          fname: listing.msg,
          t: 'c',
        })),
        count: listings.length,
        offset: 0,
        total: listings.length,
      },
    ];
  }
  if (request.path === '/api/v1/chat.getDiscussions') {
    return [
      200,
      {
        success: true,
        messages: listings,
        count: listings.length,
        offset: 0,
        total: listings.length,
      },
    ];
  }
  if (request.path === '/api/v1/rooms.info') {
    const rid = String(request.params.roomId);
    return [
      200,
      {
        success: true,
        room: {
          _id: rid,
          fname: spec.name,
          prid: rid === 'wrong-discussion' ? 'unrelated-parent' : 'parent-id',
          t: 'c',
        },
      },
    ];
  }
  return undefined;
}
