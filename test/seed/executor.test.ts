import type * as ApplyNS from '../../src/seed/apply';
import type * as ReceiptNS from '../../src/seed/receipt';
import { type Auth } from '../../src/core/rcapi';
import { ARCHIVED, PERMISSIONS, READ_ONLY } from '../../src/seed/kinds';
import { type Plan, isPrivate, planFrom } from '../../src/seed/plan';
import { username } from '../../src/seed/wording';

type Bag = Record<string, unknown>;
interface Request {
  readonly path: string;
  readonly payload: Bag;
  readonly userId: string;
}
const ADMIN = { token: 'admin-token', userId: 'admin-id' };
const RID = 'scenario-room';
let ordinal = 0;

function scenarioPlan(kind: string): Plan {
  const base = planFrom('small', {
    users: 4,
    scenarios: kind === PERMISSIONS ? ['permissions'] : ['room-states'],
  });
  const original = base.rooms.find((r) => r.kind === kind)!;
  const main = original.content.find((m) => m.kind === 'main')!;
  const spec = {
    ...original,
    messages: 1,
    threads: [],
    replyCount: 0,
    reactions: [],
    files: [],
    content: [
      {
        ...main,
        author: kind === PERMISSIONS ? 'carol' : main.author,
        reactions: [],
        pin: false,
        star: '',
        mention: '',
        editedText: '',
      },
    ],
  };
  return { ...base, rooms: [spec], customEmoji: [] };
}

function load(
  plan: Plan,
  option: { fresh?: boolean; closeAfterMessage?: boolean; markerInCustomFields?: boolean } = {},
) {
  jest.resetModules();
  const requests: Request[] = [];
  let exists = option.fresh !== true;
  let readOnly = plan.rooms[0]!.kind === READ_ONLY && option.fresh !== true;
  let archived: boolean | undefined =
    plan.rooms[0]!.kind === ARCHIVED && option.fresh !== true ? true : undefined;
  let muted = plan.rooms[0]!.kind === PERMISSIONS;
  let ownedRun = '';
  const answer = (status: number, body: Bag) =>
    Promise.resolve([status, JSON.stringify(body)] as [number, string]);
  const room = (): Bag => ({
    _id: RID,
    t: isPrivate(plan.rooms[0]!) ? 'p' : 'c',
    name: plan.rooms[0]!.name,
    ro: readOnly,
    ...(archived === undefined ? {} : { archived }),
    topic: 'Existing topic',
    description: 'Existing description',
    announcement: 'Existing announcement',
    ...(option.markerInCustomFields === true
      ? { customFields: { houstonSeed: { run: ownedRun, key: plan.rooms[0]!.name } } }
      : { houstonSeed: { run: ownedRun, key: plan.rooms[0]!.name } }),
  });
  jest.doMock('../../src/core/rcapi', () => ({
    authHeaders: (auth: Auth) => ({ 'X-Auth-Token': auth.token, 'X-User-Id': auth.userId }),
    getSetting: () => Promise.resolve(false),
    setSetting: () => Promise.resolve(true),
    rcapi: {
      call: (_root: string, _method: string, path: string, options: Bag) => {
        const payload = (options.data ?? {}) as Bag;
        const params = (options.params ?? {}) as Bag;
        const userId = String(((options.extraHeaders ?? {}) as Bag)['X-User-Id']);
        requests.push({ path, payload, userId });
        if (path === '/api/v1/users.info')
          return answer(200, {
            success: true,
            user: {
              _id: `uid-${String(params.username)}`,
              username: params.username,
              emails: [{ address: `${String(params.username)}+houston-${ownedRun}@example.com` }],
            },
          });
        if (path === '/api/v1/channels.info' || path === '/api/v1/groups.info') {
          if (!exists) return answer(404, { success: false, errorType: 'error-room-not-found' });
          return answer(200, {
            success: true,
            [isPrivate(plan.rooms[0]!) ? 'group' : 'channel']: room(),
          });
        }
        if (path === '/api/v1/channels.create') {
          exists = true;
          return answer(200, { success: true, channel: room() });
        }
        if (path === '/api/v1/channels.invite') return answer(200, { success: true });
        if (path === '/api/v1/rooms.adminRooms.getRoom')
          return answer(200, { success: true, room: room() });
        if (path === '/api/v1/rooms.info')
          return answer(200, {
            success: true,
            room: { ...room(), muted: muted ? ['carol'] : [] },
          });
        if (path === '/api/v1/groups.roles')
          return answer(200, {
            success: true,
            roles: [
              { u: { _id: 'uid-alice', username: 'alice' }, roles: ['owner'] },
              { u: { _id: 'uid-bob', username: 'bob' }, roles: ['moderator'] },
            ],
          });
        if (path === '/api/v1/groups.addOwner' || path === '/api/v1/groups.addModerator')
          return answer(400, { success: false, errorType: 'error-user-already-owner' });
        if (path === '/api/v1/channels.setReadOnly') {
          if ((payload.readOnly === true) === readOnly)
            return answer(400, {
              success: false,
              error: 'The room already has that read-only state',
            });
          readOnly = payload.readOnly === true;
          return answer(200, { success: true });
        }
        if (path === '/api/v1/channels.archive' || path === '/api/v1/channels.unarchive') {
          const desired = path === '/api/v1/channels.archive';
          if ((archived === true) === desired)
            return answer(400, {
              success: false,
              error: 'The room already has that archived state',
            });
          archived = desired;
          return answer(200, { success: true });
        }
        if (path === '/api/v1/rooms.unmuteUser' || path === '/api/v1/rooms.muteUser') {
          muted = path === '/api/v1/rooms.muteUser';
          return answer(200, { success: true });
        }
        if (path === '/api/v1/chat.sendMessage') {
          if (readOnly || archived === true || (muted && userId === 'uid-carol'))
            return answer(403, { success: false, errorType: 'error-not-allowed' });
          if (option.closeAfterMessage) {
            if (plan.rooms[0]!.kind === READ_ONLY) readOnly = true;
            if (plan.rooms[0]!.kind === ARCHIVED) archived = true;
          }
          return answer(200, {
            success: true,
            message: { ...(payload.message as Bag), u: { _id: userId } },
          });
        }
        return answer(500, { success: false, error: `unexpected request ${path}` });
      },
    },
  }));
  const mod = require('../../src/seed/apply') as typeof ApplyNS;
  const Receipt = (require('../../src/seed/receipt') as typeof ReceiptNS).Receipt;
  const name = `scenario-resume-${ordinal}`;
  ordinal += 1;
  const receipt = new Receipt(plan, 'database-identity', name);
  ownedRun = receipt.manifest.run;
  for (let i = 0; i < plan.users; i += 1) {
    const member = username(i);
    receipt.record(`user:${member}`, 'done', {
      id: `uid-${member}`,
      username: member,
      new: false,
    });
  }
  if (option.fresh !== true) {
    receipt.record(`room:${plan.rooms[0]!.name}`, 'done', {
      rid: RID,
      type: isPrivate(plan.rooms[0]!) ? 'p' : 'c',
      teamId: '',
      reused: false,
    });
    receipt.record(`members:room:${plan.rooms[0]!.name}`, 'done', {});
  }
  const login = async (_root: string, who: { user: string }) => ({
    token: `token-${who.user}`,
    userId: `uid-${who.user}`,
  });
  return {
    mod,
    Receipt,
    name,
    receipt,
    login,
    requests,
    state: () => ({ readOnly, archived, muted }),
    ownRun: (run: string) => {
      ownedRun = run;
    },
  };
}

describe('resuming scenario rooms', () => {
  afterEach(() => jest.resetModules());

  it.each([READ_ONLY, ARCHIVED])(
    'populates a fresh %s room while avoiding rejected no-op state updates',
    async (kind) => {
      for (const closeAfterMessage of [false, true]) {
        const plan = scenarioPlan(kind);
        const data = load(plan, { fresh: true, closeAfterMessage });
        expect(data.state()).toEqual(
          expect.objectContaining({ readOnly: false, archived: undefined }),
        );
        const result = await data.mod.seed('http://x', ADMIN, plan, {
          receipt: data.receipt,
          login: data.login,
        });
        expect(result.failed).toEqual([]);
        expect(result.messages).toBe(1);
        expect(data.requests.filter((r) => r.path === '/api/v1/channels.create')).toHaveLength(1);
        const stateWrites = data.requests.filter((r) =>
          [
            '/api/v1/channels.setReadOnly',
            '/api/v1/channels.archive',
            '/api/v1/channels.unarchive',
          ].includes(r.path),
        );
        expect(stateWrites).toEqual(
          closeAfterMessage
            ? []
            : [
                expect.objectContaining({
                  path:
                    kind === READ_ONLY
                      ? '/api/v1/channels.setReadOnly'
                      : '/api/v1/channels.archive',
                  payload: kind === READ_ONLY ? { roomId: RID, readOnly: true } : { roomId: RID },
                }),
              ],
        );
        expect(data.state()[kind === READ_ONLY ? 'readOnly' : 'archived']).toBe(true);
        expect(data.receipt.done(`state:${plan.rooms[0]!.name}:open`)).toEqual({
          rid: RID,
          open: true,
        });
        expect(data.receipt.done(`state:${plan.rooms[0]!.name}:close`)).toEqual({
          rid: RID,
          open: false,
        });
      }
    },
  );

  it('reopens a receipt-created read-only room before unfinished content and closes it afterward', async () => {
    const plan = scenarioPlan(READ_ONLY);
    const data = load(plan);
    const result = await data.mod.seed('http://x', ADMIN, plan, {
      receipt: data.receipt,
      login: data.login,
    });
    expect(result.failed).toEqual([]);
    expect(result.messages).toBe(1);
    const opening = data.requests.findIndex(
      (r) => r.path === '/api/v1/channels.setReadOnly' && r.payload.readOnly === false,
    );
    const message = data.requests.findIndex((r) => r.path === '/api/v1/chat.sendMessage');
    const closing = data.requests.findIndex(
      (r) => r.path === '/api/v1/channels.setReadOnly' && r.payload.readOnly === true,
    );
    expect(opening).toBeGreaterThanOrEqual(0);
    expect(opening).toBeLessThan(message);
    expect(closing).toBeGreaterThan(message);
    expect(data.state().readOnly).toBe(true);
  });

  it('reuses existing permission roles and reads rich mute state before allowing the participant to finish', async () => {
    const plan = scenarioPlan(PERMISSIONS);
    const data = load(plan);
    const result = await data.mod.seed('http://x', ADMIN, plan, {
      receipt: data.receipt,
      login: data.login,
    });
    expect(result.failed).toEqual([]);
    expect(result.messages).toBe(1);
    expect(
      data.requests.filter((r) =>
        ['/api/v1/groups.addOwner', '/api/v1/groups.addModerator'].includes(r.path),
      ),
    ).toEqual([]);
    const unmute = data.requests.findIndex((r) => r.path === '/api/v1/rooms.unmuteUser');
    const message = data.requests.findIndex((r) => r.path === '/api/v1/chat.sendMessage');
    const mute = data.requests.findIndex((r) => r.path === '/api/v1/rooms.muteUser');
    expect(unmute).toBeGreaterThanOrEqual(0);
    expect(unmute).toBeLessThan(message);
    expect(data.requests[message]!.userId).toBe('uid-carol');
    expect(mute).toBeGreaterThan(message);
    expect(data.state().muted).toBe(true);
  });

  it('reconciles a pending prior-owned user without requiring the new batch email nonce', async () => {
    const plan = scenarioPlan(READ_ONLY);
    const data = load(plan);
    data.receipt.finish();
    const resumed = new data.Receipt(plan, 'database-identity', data.name);
    for (let i = 1; i < plan.users; i += 1) {
      const member = username(i);
      resumed.record(`user:${member}`, 'done', data.receipt.done(`user:${member}`)!);
    }
    resumed.record(`user:alice`, 'intent', {
      username: 'alice',
      email: `alice+houston-${resumed.manifest.run}@example.com`,
    });
    resumed.record(
      `room:${plan.rooms[0]!.name}`,
      'done',
      data.receipt.done(`room:${plan.rooms[0]!.name}`)!,
    );
    resumed.record(`members:room:${plan.rooms[0]!.name}`, 'done', {});
    await expect(
      data.mod.seed('http://x', ADMIN, plan, { receipt: resumed, login: data.login }),
    ).resolves.toEqual(expect.objectContaining({ failed: [], messages: 1 }));
    expect(resumed.done('user:alice')).toEqual(
      expect.objectContaining({ id: 'uid-alice', new: false }),
    );
    expect(data.requests.filter((r) => r.path === '/api/v1/users.create')).toEqual([]);
  });

  it('reconciles a pending prior-owned room by its exact identity without requiring the new marker', async () => {
    const plan = scenarioPlan(READ_ONLY);
    const data = load(plan);
    data.receipt.finish();
    const resumed = new data.Receipt(plan, 'database-identity', data.name);
    for (let i = 0; i < plan.users; i += 1) {
      const member = username(i);
      resumed.record(`user:${member}`, 'done', data.receipt.done(`user:${member}`)!);
    }
    const spec = plan.rooms[0]!;
    resumed.record(`room:${spec.name}`, 'intent', {
      name: spec.name,
      kind: spec.kind,
      marker: { houstonSeed: { run: resumed.manifest.run, key: spec.name } },
    });
    resumed.record(`members:room:${spec.name}`, 'done', {});
    await expect(
      data.mod.seed('http://x', ADMIN, plan, { receipt: resumed, login: data.login }),
    ).resolves.toEqual(expect.objectContaining({ failed: [], messages: 1 }));
    expect(resumed.done(`room:${spec.name}`)).toEqual(
      expect.objectContaining({ rid: RID, type: 'c', reused: true }),
    );
    expect(data.requests.filter((r) => r.path === '/api/v1/channels.create')).toEqual([]);
  });
});

describe('the room requests Rocket.Chat 8.8.0 validates', () => {
  afterEach(() => jest.resetModules());

  it('carries the seed marker in customFields, leaving extraData to Rocket.Chat fields', async () => {
    // From 8.8.0 channels.create and groups.create refuse an extraData key they do not
    // declare: the marker there failed every room of a seed (invalid-params).
    const plan = scenarioPlan(READ_ONLY);
    const data = load(plan, { fresh: true });
    await data.mod.seed('http://x', ADMIN, plan, { receipt: data.receipt, login: data.login });
    const create = data.requests.find((r) => r.path === '/api/v1/channels.create');
    expect(create?.payload.customFields).toEqual({
      houstonSeed: { run: data.receipt.manifest.run, key: plan.rooms[0]!.name },
    });
    expect(create?.payload.extraData).toEqual({});
  });

  it('invites one member per call, the only shape 8.8.0 channels.invite takes', async () => {
    const plan = scenarioPlan(READ_ONLY);
    const data = load(plan, { fresh: true });
    await data.mod.seed('http://x', ADMIN, plan, { receipt: data.receipt, login: data.login });
    const invites = data.requests.filter((r) => r.path === '/api/v1/channels.invite');
    expect(invites.map((r) => r.payload)).toEqual(
      plan.rooms[0]!.members.map((member) => ({ roomId: RID, userId: `uid-${member}` })),
    );
  });

  it('recognises its own unfinished room by the marker in customFields', async () => {
    const plan = scenarioPlan(READ_ONLY);
    const data = load(plan, { markerInCustomFields: true });
    // A workspace with no earlier receipt: the room is identified by its marker alone.
    const resumed = new data.Receipt(plan, 'database-identity', `${data.name}-marker`);
    data.ownRun(resumed.manifest.run);
    for (let i = 0; i < plan.users; i += 1) {
      const member = username(i);
      resumed.record(`user:${member}`, 'done', data.receipt.done(`user:${member}`)!);
    }
    const spec = plan.rooms[0]!;
    resumed.record(`room:${spec.name}`, 'intent', {
      name: spec.name,
      kind: spec.kind,
      marker: { houstonSeed: { run: resumed.manifest.run, key: spec.name } },
    });
    await expect(
      data.mod.seed('http://x', ADMIN, plan, { receipt: resumed, login: data.login }),
    ).resolves.toEqual(expect.objectContaining({ failed: [], messages: 1 }));
    expect(resumed.done(`room:${spec.name}`)).toEqual(expect.objectContaining({ rid: RID }));
    expect(data.requests.filter((r) => r.path === '/api/v1/channels.create')).toEqual([]);
  });
});
