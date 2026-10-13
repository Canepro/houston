import type * as ApplyNS from '../../src/seed/apply';
import type * as ReceiptNS from '../../src/seed/receipt';
import { type Auth } from '../../src/core/rcapi';
import { asset } from '../../src/seed/assets';
import { type Plan, planFrom } from '../../src/seed/plan';
import { username } from '../../src/seed/wording';

type Bag = Record<string, unknown>;
interface Request {
  readonly method: string;
  readonly path: string;
  readonly userId: string;
  readonly params: Bag;
  readonly payload: Bag;
}
const ADMIN = { token: 'admin-token', userId: 'admin-id' };
const RID = 'sample-room';
const FID = 'uploaded-png';
const MID = 'confirmed-file-message';
let ordinal = 0;

function mediaPlan(): Plan {
  const base = planFrom('small', { users: 2, messages: 0 });
  const original = base.rooms.find((r) => r.name === 'team-chat')!;
  const file = original.content.find((m) => m.kind === 'file' && m.file === 'png')!;
  const room = {
    ...original,
    messages: 0,
    threads: [],
    replyCount: 0,
    reactions: [],
    files: ['png'],
    content: [{ ...file, reactions: [], pin: false, star: '', editedText: '' }],
  };
  return { ...base, rooms: [room], customEmoji: [] };
}

function load(plan: Plan, loseUpload = false) {
  jest.resetModules();
  const requests: Request[] = [];
  const messages: Bag[] = Array.from({ length: 205 }, (_, i) => ({
    _id: `older-message-${i}`,
    rid: RID,
    u: { _id: 'another-author' },
    file: { _id: FID },
    msg: 'An older file message by a different author',
  }));
  const reply = (status: number, body: Bag) =>
    Promise.resolve([status, JSON.stringify(body)] as [number, string]);
  jest.doMock('../../src/core/rcapi', () => ({
    authHeaders: (auth: Auth) => ({ 'X-Auth-Token': auth.token, 'X-User-Id': auth.userId }),
    getSetting: () => Promise.resolve(false),
    setSetting: () => Promise.resolve(true),
    rcapi: {
      multipart: (_root: string, path: string, headers: Bag) => {
        requests.push({
          method: 'MULTIPART',
          path,
          userId: String(headers['X-User-Id']),
          params: {},
          payload: {},
        });
        if (loseUpload) return Promise.reject(new Error('response lost after accepting upload'));
        return reply(200, {
          success: true,
          file: { _id: FID, url: `/file-upload/${FID}/evidence.png` },
        });
      },
      call: (_root: string, method: string, path: string, options: Bag) => {
        const params = (options.params ?? {}) as Bag;
        const payload = (options.data ?? {}) as Bag;
        const userId = String(((options.extraHeaders ?? {}) as Bag)['X-User-Id']);
        requests.push({ method, path, userId, params, payload });
        if (path === '/api/v1/rooms.adminRooms.getRoom')
          return reply(200, {
            success: true,
            room: {
              _id: RID,
              t: 'c',
              name: plan.rooms[0]!.name,
              topic: 'Existing support topic',
              description: 'Existing room description',
              announcement: 'Existing room announcement',
            },
          });
        if (path === `/api/v1/rooms.mediaConfirm/${RID}/${FID}`) {
          messages.push({
            _id: MID,
            rid: RID,
            u: { _id: userId },
            file: { _id: FID },
            msg: payload.msg,
            ts: '2026-10-09T12:00:00.000Z',
          });
          return Promise.reject(new Error('response lost after accepting confirmation'));
        }
        if (path === '/api/v1/channels.messages') {
          const offset = Number(params.offset ?? 0);
          const count = Number(params.count ?? 100);
          return reply(200, {
            success: true,
            messages: messages.slice(offset, offset + count),
            total: messages.length,
          });
        }
        return reply(500, { success: false, error: `unexpected request ${path}` });
      },
    },
  }));
  return {
    mod: require('../../src/seed/apply') as typeof ApplyNS,
    Receipt: (require('../../src/seed/receipt') as typeof ReceiptNS).Receipt,
    requests,
    messages,
  };
}

describe('resuming sample media operations', () => {
  afterEach(() => jest.resetModules());

  function prepared(loseUpload = false) {
    const plan = mediaPlan();
    const loaded = load(plan, loseUpload);
    const name = `media-recovery-${ordinal}`;
    ordinal += 1;
    const receipt = new loaded.Receipt(plan, 'database-identity', name);
    for (let i = 0; i < plan.users; i += 1) {
      const member = username(i);
      receipt.record(`user:${member}`, 'done', {
        id: `uid-${member}`,
        username: member,
        new: false,
      });
    }
    receipt.record(`room:${plan.rooms[0]!.name}`, 'done', {
      rid: RID,
      type: 'c',
      teamId: '',
      reused: true,
    });
    receipt.record(`members:room:${plan.rooms[0]!.name}`, 'done', {});
    const login = async (_root: string, who: { user: string }) => ({
      token: `token-${who.user}`,
      userId: `uid-${who.user}`,
    });
    return { ...loaded, name, plan, receipt, login };
  }

  it('recovers a confirmed file by its uploader and file identity without uploading or confirming twice', async () => {
    const data = prepared();
    const item = data.plan.rooms[0]!.content[0]!;
    const key = `message:${data.plan.rooms[0]!.name}:${item.key}`;
    await expect(
      data.mod.seed('http://x', ADMIN, data.plan, {
        receipt: data.receipt,
        login: data.login,
      }),
    ).rejects.toThrow(/uncertain result/u);
    expect(data.receipt.intent(key)).not.toBeNull();
    expect(data.receipt.done(`upload:${data.plan.rooms[0]!.name}:${item.key}`)).toEqual(
      expect.objectContaining({
        id: FID,
        userId: `uid-${item.author}`,
        sha256: asset('png').sha256,
      }),
    );

    const resumed = new data.Receipt(data.plan, 'database-identity', data.name);
    const result = await data.mod.seed('http://x', ADMIN, data.plan, {
      receipt: resumed,
      login: data.login,
    });
    expect(resumed.manifest.run).toBe(data.receipt.manifest.run);
    expect(resumed.done(key)).toEqual(
      expect.objectContaining({ id: MID, rid: RID, userId: `uid-${item.author}`, kind: 'file' }),
    );
    expect(result.failed).toEqual([]);
    expect(result.files).toBe(1);
    expect(result.total_content).toBe(1);
    expect(data.requests.filter((r) => r.method === 'MULTIPART')).toHaveLength(1);
    expect(data.requests.filter((r) => r.path.includes('/rooms.mediaConfirm/'))).toHaveLength(1);
    const pages = data.requests.filter((r) => r.path === '/api/v1/channels.messages');
    expect(pages.map((r) => r.params.offset)).toEqual([0, 100, 200]);
    expect(pages.every((r) => r.userId === `uid-${item.author}`)).toBe(true);
  });

  it('refuses ambiguous confirmation candidates while retaining the uploaded file and pending intent', async () => {
    const data = prepared();
    const key = `message:${data.plan.rooms[0]!.name}:${data.plan.rooms[0]!.content[0]!.key}`;
    await expect(
      data.mod.seed('http://x', ADMIN, data.plan, {
        receipt: data.receipt,
        login: data.login,
      }),
    ).rejects.toThrow(/uncertain result/u);
    data.messages.push({ ...data.messages.at(-1), _id: 'another-confirmed-message' });
    const resumed = new data.Receipt(data.plan, 'database-identity', data.name);
    await expect(
      data.mod.seed('http://x', ADMIN, data.plan, { receipt: resumed, login: data.login }),
    ).rejects.toThrow(/cannot be reconciled uniquely/u);
    expect(resumed.intent(key)).not.toBeNull();
    expect(resumed.done(key)).toBeNull();
    expect(data.requests.filter((r) => r.method === 'MULTIPART')).toHaveLength(1);
    expect(data.requests.filter((r) => r.path.includes('/rooms.mediaConfirm/'))).toHaveLength(1);
  });

  it('refuses to repeat an upload whose server outcome is unknown', async () => {
    const data = prepared(true);
    const key = `upload:${data.plan.rooms[0]!.name}:${data.plan.rooms[0]!.content[0]!.key}`;
    await expect(
      data.mod.seed('http://x', ADMIN, data.plan, {
        receipt: data.receipt,
        login: data.login,
      }),
    ).rejects.toThrow(/uncertain result/u);
    const resumed = new data.Receipt(data.plan, 'database-identity', data.name);
    await expect(
      data.mod.seed('http://x', ADMIN, data.plan, { receipt: resumed, login: data.login }),
    ).rejects.toThrow(/uncertain result; refusing another upload/u);
    expect(resumed.intent(key)).not.toBeNull();
    expect(data.requests.filter((r) => r.method === 'MULTIPART')).toHaveLength(1);
    expect(data.requests.filter((r) => r.path.includes('/rooms.mediaConfirm/'))).toEqual([]);
  });
});
