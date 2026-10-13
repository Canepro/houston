import type * as ApplyNS from '../../src/seed/apply';
import type * as ReceiptNS from '../../src/seed/receipt';
import { type Auth } from '../../src/core/rcapi';
import { CHANNEL, DISCUSSION, TEAM } from '../../src/seed/kinds';
import { type Plan, type RoomSpec, planFrom } from '../../src/seed/plan';
import { MESSAGES } from '../../src/seed/wording';

type Bag = Record<string, unknown>;
interface Request {
  readonly method: string;
  readonly path: string;
  readonly payload: Bag;
  readonly params: Bag;
  readonly userId: string;
}
const ADMIN = { token: 'admin-token', userId: 'admin-id' };
const LEGACY = { profile: 'small', actual: { messages: 2 }, verification: { ok: true } };
let ordinal = 0;

function legacyPlan(kind: string): Plan {
  const base = planFrom('small', { users: 1, messages: 1 });
  const target = base.rooms.find((room) => room.kind === kind)!;
  const selected =
    target.parent === '' ? [target] : [base.rooms.find((r) => r.name === target.parent)!, target];
  const rooms: RoomSpec[] = selected.map((spec) => {
    const main = spec.content.find((item) => item.kind === 'main')!;
    return {
      ...spec,
      messages: 1,
      threads: [],
      replyCount: 0,
      files: [],
      reactions: [],
      fromMessage: -1,
      content: [
        {
          ...main,
          author: 'alice',
          reactions: [],
          pin: false,
          star: '',
          mention: '',
          editedText: '',
        },
      ],
    };
  });
  return { ...base, rooms, customEmoji: [] };
}

function load(
  plan: Plan,
  option: { collision?: boolean; vanished?: boolean; unrelatedUser?: boolean } = {},
) {
  jest.resetModules();
  const requests: Request[] = [];
  const target = plan.rooms.at(-1)!;
  const rooms = plan.rooms.map((spec): Bag => ({
    _id: `legacy-${spec.name}`,
    name: spec.name,
    fname: spec.name,
    t: 'c',
    u: { _id: ADMIN.userId },
    topic: 'Existing topic',
    description: 'Existing description',
    announcement: 'Existing announcement',
    ...(spec.kind === TEAM ? { teamId: 'legacy-team-id', teamMain: true } : {}),
    ...(spec.parent !== '' ? { prid: `legacy-${spec.parent}` } : {}),
  }));
  const targetRoom = rooms.at(-1)!;
  const current = (room: Bag): Bag =>
    option.collision && room.name === target.name ? { ...room, _id: 'unrelated-room' } : room;
  const answer = (status: number, body: Bag) =>
    Promise.resolve([status, JSON.stringify(body)] as [number, string]);
  const page = (field: string, rows: Bag[], offset: unknown) =>
    answer(200, {
      success: true,
      [field]: rows,
      count: rows.length,
      offset: offset ?? 0,
      total: rows.length,
    });
  jest.doMock('../../src/core/rcapi', () => ({
    authHeaders: (auth: Auth) => ({ 'X-Auth-Token': auth.token, 'X-User-Id': auth.userId }),
    getSetting: () => Promise.resolve(false),
    setSetting: () => Promise.resolve(true),
    rcapi: {
      multipart: (_root: string, path: string, headers: Bag) => {
        requests.push({
          method: 'POST',
          path,
          payload: {},
          params: {},
          userId: String(headers['X-User-Id']),
        });
        return answer(500, { success: false, error: 'legacy avatar must remain unchanged' });
      },
      call: (_root: string, method: string, path: string, options: Bag) => {
        const payload = (options.data ?? {}) as Bag;
        const params = (options.params ?? {}) as Bag;
        const userId = String(((options.extraHeaders ?? {}) as Bag)['X-User-Id']);
        requests.push({ method, path, payload, params, userId });
        if (path === '/api/v1/channels.list') return page('channels', rooms, params.offset);
        if (path === '/api/v1/groups.list') return page('groups', [], params.offset);
        if (path === '/api/v1/channels.messages') {
          const room = rooms.find((r) => r._id === params.roomId)!;
          return page(
            'messages',
            [
              {
                _id: `old-message-${String(room._id)}`,
                rid: room._id,
                msg: MESSAGES[0],
                u: {
                  _id: option.unrelatedUser ? 'unrelated-alice' : 'uid-alice',
                  username: 'alice',
                },
              },
            ],
            params.offset,
          );
        }
        if (path === '/api/v1/users.info')
          return answer(200, {
            success: true,
            user: {
              _id: 'uid-alice',
              username: 'alice',
              emails: [{ address: 'alice@example.com' }],
              name: 'Existing Alice',
              bio: 'Keep this profile',
            },
          });
        if (path === '/api/v1/channels.info') {
          const room = rooms.find((r) => r.name === params.roomName);
          if (room === undefined || (option.vanished && room.name === target.name))
            return answer(404, { success: false, errorType: 'error-room-not-found' });
          return answer(200, { success: true, channel: current(room) });
        }
        if (path === '/api/v1/rooms.info' || path === '/api/v1/rooms.adminRooms.getRoom') {
          const room = rooms.find((r) => r._id === (params.roomId ?? params.rid));
          return room === undefined
            ? answer(404, { success: false, errorType: 'error-room-not-found' })
            : answer(200, { success: true, room });
        }
        if (path === '/api/v1/teams.info')
          return answer(200, {
            success: true,
            teamInfo: { _id: 'legacy-team-id', roomId: targetRoom._id, name: target.name, type: 0 },
          });
        if (path === '/api/v1/rooms.getDiscussions')
          return page(
            'discussions',
            [
              { ...targetRoom, _id: 'wrong-parent-discussion', prid: 'unrelated-parent' },
              ...(option.vanished ? [] : [current(targetRoom)]),
            ],
            params.offset,
          );
        if (path === '/api/v1/chat.sendMessage')
          return answer(200, {
            success: true,
            message: { ...(payload.message as Bag), u: { _id: userId, username: 'alice' } },
          });
        if (
          [
            '/api/v1/channels.invite',
            '/api/v1/groups.invite',
            '/api/v1/discussions.invite',
            '/api/v1/teams.addMembers',
          ].includes(path)
        )
          return answer(200, { success: true });
        return answer(500, { success: false, error: `unexpected legacy mutation ${path}` });
      },
    },
  }));
  const mod = require('../../src/seed/apply') as typeof ApplyNS;
  const Receipt = (require('../../src/seed/receipt') as typeof ReceiptNS).Receipt;
  const name = `first-legacy-adoption-${ordinal}`;
  ordinal += 1;
  const receipt = new Receipt(plan, 'legacy-database', name);
  const resume = () => new Receipt(plan, 'legacy-database', name);
  const login = async () => ({ token: 'alice-token', userId: 'uid-alice' });
  const creates = () =>
    requests.filter((r) =>
      [
        '/api/v1/users.create',
        '/api/v1/channels.create',
        '/api/v1/teams.create',
        '/api/v1/rooms.createDiscussion',
      ].includes(r.path),
    );
  return { mod, receipt, resume, login, requests, creates, target, targetRoom };
}

describe('resuming the first legacy seed adoption', () => {
  afterEach(() => jest.resetModules());

  it('reconciles a proven old-email user intent without overwriting profile, avatar, or email 2FA', async () => {
    const plan = legacyPlan(CHANNEL);
    const data = load(plan);
    data.receipt.record('user:alice', 'intent', {
      username: 'alice',
      email: `alice+houston-${data.receipt.manifest.run}@example.com`,
    });
    const resumed = data.resume();
    expect(resumed.owned.size).toBe(0);
    await expect(
      data.mod.seed('http://x', ADMIN, plan, {
        receipt: resumed,
        login: data.login,
        legacy: LEGACY,
      }),
    ).resolves.toEqual(expect.objectContaining({ failed: [], users_failed: [], messages: 1 }));
    expect(resumed.done('user:alice')).toEqual({ id: 'uid-alice', username: 'alice', new: false });
    expect(data.creates()).toEqual([]);
    expect(
      data.requests.filter((r) =>
        [
          '/api/v1/users.updateOwnBasicInfo',
          '/api/v1/users.setAvatar',
          '/api/v1/users.2fa.disableEmail',
        ].includes(r.path),
      ),
    ).toEqual([]);
  });

  it.each([CHANNEL, TEAM, DISCUSSION])(
    'reconciles the exact proven legacy %s room intent without creation',
    async (kind) => {
      const plan = legacyPlan(kind);
      const data = load(plan);
      data.receipt.record('user:alice', 'done', { id: 'uid-alice', username: 'alice', new: false });
      data.receipt.record(`room:${data.target.name}`, 'intent', {
        name: data.target.name,
        kind,
        marker: { houstonSeed: { run: data.receipt.manifest.run, key: data.target.name } },
      });
      const resumed = data.resume();
      expect(resumed.owned.has(`room:${data.target.name}`)).toBe(false);
      await expect(
        data.mod.seed('http://x', ADMIN, plan, {
          receipt: resumed,
          login: data.login,
          legacy: LEGACY,
        }),
      ).resolves.toEqual(expect.objectContaining({ failed: [], messages: plan.rooms.length }));
      expect(resumed.done(`room:${data.target.name}`)).toEqual(
        expect.objectContaining({
          rid: data.targetRoom._id,
          type: 'c',
          reused: true,
          teamId: kind === TEAM ? 'legacy-team-id' : '',
          ...(kind === DISCUSSION ? { parent: `legacy-${data.target.parent}` } : {}),
        }),
      );
      expect(data.creates()).toEqual([]);
      const posts = data.requests.filter((r) => r.path === '/api/v1/chat.sendMessage');
      expect(posts.at(-1)?.payload.message).toEqual(
        expect.objectContaining({ rid: data.targetRoom._id }),
      );
      if (kind === TEAM)
        expect(
          data.requests.find((r) => r.path === '/api/v1/teams.addMembers')?.payload.teamId,
        ).toBe('legacy-team-id');
      if (kind === DISCUSSION)
        expect(
          data.requests.find((r) => r.path === '/api/v1/rooms.getDiscussions')?.params.roomId,
        ).toBe(`legacy-${data.target.parent}`);
    },
  );

  it('refuses a same-name account whose UID is absent from the proven old message authors', async () => {
    const plan = legacyPlan(CHANNEL);
    const data = load(plan, { unrelatedUser: true });
    data.receipt.record('user:alice', 'intent', {
      username: 'alice',
      email: `alice+houston-${data.receipt.manifest.run}@example.com`,
    });
    await expect(
      data.mod.seed('http://x', ADMIN, plan, {
        receipt: data.resume(),
        login: data.login,
        legacy: LEGACY,
      }),
    ).rejects.toThrow(/cannot identify the pending account alice/u);
    expect(data.creates()).toEqual([]);
    expect(data.requests.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('refuses a same-name room with another ID despite an otherwise proven legacy room', async () => {
    const plan = legacyPlan(CHANNEL);
    const data = load(plan, { collision: true });
    data.receipt.record('user:alice', 'done', { id: 'uid-alice', username: 'alice', new: false });
    data.receipt.record(`room:${data.target.name}`, 'intent', {
      name: data.target.name,
      kind: CHANNEL,
    });
    await expect(
      data.mod.seed('http://x', ADMIN, plan, {
        receipt: data.resume(),
        login: data.login,
        legacy: LEGACY,
      }),
    ).rejects.toThrow(/pending room .* cannot be identified/u);
    expect(data.creates()).toEqual([]);
    expect(data.requests.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it.each([TEAM, DISCUSSION])(
    'refuses to replace a vanished legacy %s while reconciling its persisted intent',
    async (kind) => {
      const plan = legacyPlan(kind);
      const data = load(plan, { vanished: true });
      data.receipt.record('user:alice', 'done', { id: 'uid-alice', username: 'alice', new: false });
      data.receipt.record(`room:${data.target.name}`, 'intent', { name: data.target.name, kind });
      await expect(
        data.mod.seed('http://x', ADMIN, plan, {
          receipt: data.resume(),
          login: data.login,
          legacy: LEGACY,
        }),
      ).rejects.toThrow();
      expect(data.creates()).toEqual([]);
    },
  );
});
