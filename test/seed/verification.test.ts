import type * as VerificationNS from '../../src/seed/verification';
import type * as ExecNS from '../../src/seams/exec';
import { type Auth } from '../../src/core/rcapi';
import { asset } from '../../src/seed/assets';
import { ARCHIVED, DM, GROUP_DM, PERMISSIONS, READ_ONLY } from '../../src/seed/kinds';
import { type Plan, type RoomSpec, isPrivate, planFrom } from '../../src/seed/plan';
import { Receipt } from '../../src/seed/receipt';
import { username } from '../../src/seed/wording';

type Bag = Record<string, unknown>;
const ADMIN = { token: 'admin-token', userId: 'admin-id' };
const REFERENCE = '2026-10-09T12:00:00.000Z';
let restoreSleep: (() => void) | undefined;

interface Fixture {
  readonly plan: Plan;
  readonly receipt: Receipt;
  readonly tokens: Record<string, Auth>;
  readonly spec: RoomSpec;
  readonly room: Bag;
  messages: Bag[];
}

function fixture(
  selection: { files?: boolean; kind?: string; historyDays?: number } = {},
): Fixture {
  const base = planFrom('small', {
    users: 4,
    messages: 2,
    scenarios:
      selection.kind === PERMISSIONS
        ? ['permissions']
        : [ARCHIVED, READ_ONLY].includes(selection.kind ?? '')
          ? ['room-states']
          : [],
    historyDays: selection.historyDays ?? null,
  });
  const original = base.rooms.find((r) =>
    selection.kind === undefined ? r.name === 'team-chat' : r.kind === selection.kind,
  )!;
  const spec =
    selection.files === true
      ? original
      : { ...original, files: [], content: original.content.filter((m) => m.kind !== 'file') };
  const plan = { ...base, customEmoji: [], rooms: [spec] };
  const receipt = new Receipt(plan);
  receipt.manifest.reference = REFERENCE;
  const tokens: Record<string, Auth> = {};
  for (let i = 0; i < plan.users; i += 1) {
    const name = username(i);
    receipt.record(`user:${name}`, 'done', { id: `uid-${name}`, username: name, new: false });
    tokens[name] = { token: `token-${name}`, userId: `uid-${name}` };
  }
  const rid = `rid-${spec.name}`;
  const type = [DM, GROUP_DM].includes(spec.kind) ? 'd' : isPrivate(spec) ? 'p' : 'c';
  receipt.record(`room:${spec.name}`, 'done', { rid, type, teamId: '', reused: true });
  const room: Bag = {
    _id: rid,
    t: type,
    name: spec.name,
    usernames: [...spec.members],
    archived: spec.kind === ARCHIVED,
    ro: spec.kind === READ_ONLY,
    muted: spec.kind === PERMISSIONS ? ['carol'] : [],
  };
  const messages = spec.content.map((item) => {
    const mid = receipt.identifier(`message:${spec.name}:${item.key}`);
    const uid = item.author === '' ? ADMIN.userId : `uid-${item.author}`;
    const reactions: Record<string, { usernames: string[] }> = {};
    for (const action of item.reactions) {
      const badge = reactions[action.emoji] ?? { usernames: [] };
      badge.usernames.push(action.author);
      reactions[action.emoji] = badge;
    }
    const message: Bag = {
      _id: mid,
      rid,
      u: { _id: uid, username: item.author },
      msg: item.editedText || item.text,
      ts: REFERENCE,
      reactions,
      pinned: item.pin,
      starred: item.star === '' ? [] : [{ _id: `uid-${item.star}` }],
      mentions: item.mention === '' ? [] : [{ _id: `uid-${item.mention}`, username: item.mention }],
      tcount: spec.threads.includes(Number(item.key.slice(5))) ? spec.replyCount : 0,
      ...(item.parent === ''
        ? {}
        : { tmid: receipt.identifier(`message:${spec.name}:${item.parent}`) }),
      ...(item.editedText === '' ? {} : { editedBy: { _id: uid }, editedAt: REFERENCE }),
    };
    if (item.kind === 'file') {
      const media = asset(item.file);
      message.file = { _id: `fid-${item.file}`, name: media.name };
      receipt.record(`upload:${spec.name}:${item.key}`, 'done', {
        id: `fid-${item.file}`,
        rid,
        userId: uid,
        url: `/file-upload/fid-${item.file}/${media.name}`,
        sha256: media.sha256,
      });
    }
    receipt.record(`message:${spec.name}:${item.key}`, 'done', {
      id: mid,
      rid,
      kind: item.kind,
      key: item.key,
      author: item.author,
      room: spec.name,
      userId: uid,
    });
    return message;
  });
  return { plan, receipt, tokens, spec, room, messages };
}

function load(
  data: Fixture,
  behavior: {
    unreadable?: boolean;
    wrongDownload?: boolean;
    allowProbe?: boolean;
    interruptProbe?: boolean;
    rateLimitedStar?: boolean;
  } = {},
) {
  jest.resetModules();
  const requests: { method: string; path: string; headers: Bag; payload: Bag; params: Bag }[] = [];
  const downloads: string[] = [];
  const sleep = jest.fn(() => Promise.resolve());
  if (behavior.rateLimitedStar === true) {
    const exec = require('../../src/seams/exec') as typeof ExecNS;
    const spy = jest.spyOn(exec, 'sleep').mockImplementation(sleep);
    restoreSleep = () => spy.mockRestore();
  }
  let starRefused = false;
  const visibleMessage = (message: Bag, viewer: unknown): Bag => ({
    ...message,
    starred: ((message.starred ?? []) as Bag[]).filter((s) => s._id === viewer),
  });
  jest.doMock('../../src/core/rcapi', () => ({
    authHeaders: (auth: Auth) => ({ 'X-Auth-Token': auth.token, 'X-User-Id': auth.userId }),
    rcapi: {
      call: (_root: string, method: string, requestPath: string, options: Bag) => {
        const params = (options.params ?? {}) as Bag;
        const payload = (options.data ?? {}) as Bag;
        requests.push({
          method,
          path: requestPath,
          headers: (options.extraHeaders ?? {}) as Bag,
          payload,
          params,
        });
        const answer = (status: number, body: Bag) =>
          Promise.resolve([status, JSON.stringify(body)] as [number, string]);
        if (behavior.unreadable === true) return answer(500, { success: false });
        if (requestPath === '/api/v1/users.info') {
          const name = Object.keys(data.tokens).find(
            (n) => data.tokens[n]?.userId === params.userId,
          );
          return answer(200, { success: true, user: { _id: params.userId, username: name } });
        }
        if (requestPath === '/api/v1/emoji-custom.list')
          return answer(200, { success: true, emojis: { update: [] } });
        if (requestPath === '/api/v1/rooms.adminRooms.getRoom') {
          const flat = { ...data.room };
          delete flat.muted;
          return answer(200, { success: true, ...flat });
        }
        if (requestPath === '/api/v1/rooms.info')
          return answer(200, { success: true, room: data.room });
        if (requestPath === '/api/v1/im.list')
          return answer(200, { success: true, ims: [data.room] });
        if (requestPath === '/api/v1/groups.roles')
          return answer(200, {
            success: true,
            roles: [
              { u: { _id: 'uid-alice', username: 'alice' }, roles: ['owner'] },
              { u: { _id: 'uid-bob', username: 'bob' }, roles: ['moderator'] },
            ],
          });
        if (requestPath === '/api/v1/groups.history')
          return answer(403, { success: false, errorType: 'error-not-allowed' });
        if (requestPath.endsWith('.members'))
          return answer(200, {
            success: true,
            members: data.spec.members.map((n) => ({ _id: `uid-${n}`, username: n })),
            total: data.spec.members.length,
          });
        if (requestPath.endsWith('.messages') || requestPath === '/api/v1/chat.search') {
          const offset = Number(params.offset ?? 0);
          const count = Number(params.count ?? 100);
          return answer(200, {
            success: true,
            messages: data.messages
              .slice(offset, offset + count)
              .map((m) => visibleMessage(m, ((options.extraHeaders ?? {}) as Bag)['X-User-Id'])),
            total: data.messages.length,
          });
        }
        if (requestPath === '/api/v1/chat.sendMessage') {
          if (
            behavior.interruptProbe === true &&
            requests.filter((r) => r.path === requestPath).length === 1
          ) {
            data.messages.push({
              ...(payload.message as Bag),
              u: { _id: ((options.extraHeaders ?? {}) as Bag)['X-User-Id'] },
              ts: REFERENCE,
            });
            return Promise.reject(new Error('response lost after accepting permission probe'));
          }
          if (behavior.allowProbe === true)
            return answer(200, { success: true, message: payload.message });
          return answer(403, { success: false, errorType: 'error-not-allowed' });
        }
        if (requestPath === '/api/v1/chat.getMessage') {
          if (behavior.rateLimitedStar === true && !starRefused) {
            starRefused = true;
            Object.assign(options.responseHeaders ?? {}, { 'retry-after': '0' });
            return answer(429, { success: false, errorType: 'error-too-many-requests' });
          }
          const message = data.messages.find((m) => m._id === params.msgId);
          return message === undefined
            ? answer(404, { success: false, errorType: 'error-message-not-found' })
            : answer(200, {
                success: true,
                message: visibleMessage(
                  message,
                  ((options.extraHeaders ?? {}) as Bag)['X-User-Id'],
                ),
              });
        }
        if (requestPath === '/api/v1/chat.delete') {
          data.messages = data.messages.filter((m) => m._id !== payload.msgId);
          return answer(200, { success: true });
        }
        return answer(500, { success: false, error: `unexpected request ${requestPath}` });
      },
      download: (_root: string, requestPath: string) => {
        downloads.push(requestPath);
        const extension = /\.(png|pdf|txt|csv)/u.exec(requestPath)?.[1] ?? 'txt';
        return Promise.resolve({
          status: 200,
          ok: true,
          text: '',
          bytes:
            behavior.wrongDownload === true
              ? Buffer.from('different bytes')
              : asset(extension).bytes,
          headers: {},
          url: requestPath,
        });
      },
    },
  }));
  return {
    mod: require('../../src/seed/verification') as typeof VerificationNS,
    requests,
    downloads,
    sleep,
  };
}

describe('verification of the latest seed receipt', () => {
  afterEach(() => {
    restoreSleep?.();
    restoreSleep = undefined;
    jest.resetModules();
  });

  it('verifies the latest message identities across pages without counting older workspace content', async () => {
    const data = fixture();
    const latest = [...data.messages];
    data.messages = [
      ...Array.from({ length: 205 }, (_, i) => ({ ...latest[0], _id: `old-message-${i}` })),
      ...latest,
    ];
    const { mod, requests } = load(data);
    const verdict = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.faults).toEqual([]);
    expect(verdict.checked).toBe(1);
    expect(verdict.features.messages).toBe(data.spec.content.length);
    expect(
      requests.filter((r) => r.path === '/api/v1/channels.messages').map((r) => r.params.offset),
    ).toEqual([0, 100, 200]);
  });

  it('fails when the latest message IDs are absent even though old messages satisfy every aggregate count', async () => {
    const data = fixture();
    data.messages = Array.from({ length: 200 }, (_, i) => ({
      ...data.messages[i % data.messages.length],
      _id: `old-message-${i}`,
    }));
    const { mod } = load(data);
    const verdict = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.faults.filter((f) => f.kind === 'message')).toHaveLength(
      data.spec.content.length,
    );
    expect(verdict.features.messages).toBe(0);
  });

  it('reports missing feature actions and reduces their verified counts', async () => {
    const data = fixture();
    for (const message of data.messages)
      Object.assign(message, {
        reactions: {},
        pinned: false,
        starred: [],
        mentions: [],
        editedBy: {},
        editedAt: undefined,
      });
    const { mod } = load(data);
    const verdict = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    expect(verdict.ok).toBe(false);
    const kinds = verdict.faults.map((f) => f.kind);
    for (const kind of ['reaction', 'pin', 'star', 'mention', 'edit'])
      expect(kinds).toContain(kind);
    expect(verdict.features).toEqual(
      expect.objectContaining({ reactions: 0, pins: 0, stars: 0, mentions: 0, edits: 0 }),
    );
  });

  it('reads personal stars using the starring participant instead of admin', async () => {
    const data = fixture();
    const { mod, requests } = load(data);
    const verdict = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    const starred = data.spec.content.filter((m) => m.star !== '');
    expect(verdict.ok).toBe(true);
    expect(verdict.features.stars).toBe(starred.length);
    for (const item of starred) {
      const mid = data.receipt.done(`message:${data.spec.name}:${item.key}`)!.id;
      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '/api/v1/chat.getMessage',
            params: { msgId: mid },
            headers: {
              'X-Auth-Token': `token-${item.star}`,
              'X-User-Id': `uid-${item.star}`,
            },
          }),
        ]),
      );
    }
  });

  it('completes every room feature after a personal-star read is rate-limited', async () => {
    const data = fixture({ files: true });
    const { mod, requests, sleep } = load(data, { rateLimitedStar: true });
    const verdict = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    const content = data.spec.content;
    const starred = content.filter((item) => item.star !== '');
    expect(starred.length).toBeGreaterThan(0);
    expect(verdict.ok).toBe(true);
    expect(verdict.faults).toEqual([]);
    expect(verdict.unreadable).toEqual([]);
    expect(verdict.checked).toBe(1);
    expect(verdict.features).toMatchObject({
      messages: content.length,
      replies: content.filter((item) => item.kind === 'reply').length,
      reactions: content.reduce((total, item) => total + item.reactions.length, 0),
      pins: content.filter((item) => item.pin).length,
      stars: starred.length,
      mentions: content.filter((item) => item.mention !== '').length,
      edits: content.filter((item) => item.editedText !== '').length,
      files: content.filter((item) => item.kind === 'file').length,
      thread_parents: data.spec.threads.length,
    });
    expect(sleep.mock.calls).toEqual([[250]]);
    const first = starred[0]!;
    const mid = data.receipt.done(`message:${data.spec.name}:${first.key}`)!.id;
    const repeated = requests.filter(
      (request) => request.path === '/api/v1/chat.getMessage' && request.params.msgId === mid,
    );
    expect(repeated).toHaveLength(2);
    expect(repeated[0]!.headers).toEqual({
      'X-Auth-Token': `token-${first.star}`,
      'X-User-Id': `uid-${first.star}`,
    });
    expect(repeated[1]!.headers).toBe(repeated[0]!.headers);
    expect(repeated[1]!.params).toBe(repeated[0]!.params);
  });

  it('marks unreadable required objects incomplete instead of verifying them', async () => {
    const data = fixture();
    const { mod } = load(data, { unreadable: true });
    const verdict = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    expect(verdict.ok).toBeNull();
    expect(verdict.checked).toBe(0);
    expect(verdict.faults).toEqual([]);
    expect(verdict.unreadable.length).toBeGreaterThan(0);
  });

  it('checks complete group conversation membership and the exact thread parent identity', async () => {
    const data = fixture({ kind: GROUP_DM });
    data.room.usernames = [...data.spec.members, 'outsider'];
    const reply = data.messages.find((m) => typeof m.tmid === 'string')!;
    reply.tmid = 'older-parent';
    const { mod } = load(data);
    const verdict = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.faults.map((f) => f.kind)).toEqual(
      expect.arrayContaining(['participants', 'thread-parent']),
    );
  });

  it('downloads confirmed attachments using the uploader identity and rejects changed bytes', async () => {
    const data = fixture({ files: true });
    const { mod, downloads } = load(data, { wrongDownload: true });
    const verdict = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.faults.filter((f) => f.kind === 'download')).toHaveLength(4);
    for (const url of downloads) {
      expect(url).toContain(`rc_uid=${data.tokens[data.spec.members[0]!]!.userId}`);
      expect(url).toContain(`rc_token=${data.tokens[data.spec.members[0]!]!.token}`);
    }
  });

  it('cannot verify a historical batch whose timestamp adjustment was never completed', async () => {
    const data = fixture({ historyDays: 180 });
    const { mod } = load(data);
    const verdict = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    expect(verdict.ok).not.toBe(true);
    expect(verdict.faults.length + verdict.unreadable.length).toBeGreaterThan(0);
  });

  it('checks read-only posting refusal and deletes an unexpected successful permission probe', async () => {
    const data = fixture({ kind: READ_ONLY });
    const { mod, requests } = load(data, { allowProbe: true });
    const verdict = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.faults.map((f) => f.kind)).toContain('posting-permission');
    const probe = requests.find((r) => r.path === '/api/v1/chat.sendMessage')!;
    expect(probe.headers['X-User-Id']).not.toBe(ADMIN.userId);
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/api/v1/chat.delete',
          payload: { roomId: data.room._id, msgId: (probe.payload.message as Bag)._id },
        }),
      ]),
    );
  });

  it('verifies the archive flag without requiring a version-dependent REST posting refusal', async () => {
    const data = fixture({ kind: ARCHIVED });
    const { mod, requests } = load(data, { allowProbe: true });
    const verdict = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    expect(verdict.ok).toBe(true);
    expect(requests.filter((r) => r.path === '/api/v1/chat.sendMessage')).toEqual([]);
    data.room.archived = false;
    const mismatch = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.faults.map((f) => f.kind)).toContain('archived');
  });

  it('reads flat admin room identities and rich room info before checking muted posting permissions', async () => {
    const data = fixture({ kind: PERMISSIONS });
    const { mod, requests } = load(data);
    const verdict = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    expect(verdict.unreadable).toEqual([]);
    expect(verdict.faults).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(requests.map((r) => r.path)).toEqual(
      expect.arrayContaining(['/api/v1/rooms.adminRooms.getRoom', '/api/v1/rooms.info']),
    );
    const probe = requests.find((r) => r.path === '/api/v1/chat.sendMessage')!;
    expect(probe.headers['X-User-Id']).toBe('uid-carol');
    const outsider = requests.find((r) => r.path === '/api/v1/groups.history')!;
    expect(outsider.headers['X-User-Id']).toBe('uid-dave');
  });

  it('recovers an accepted permission probe after a lost response and deletes it without replay', async () => {
    const data = fixture({ kind: READ_ONLY });
    const { mod, requests } = load(data, { interruptProbe: true });
    const incomplete = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    const key = `probe:${data.spec.name}`;
    const probeId = data.receipt.identifier(key);
    expect(incomplete.ok).toBeNull();
    expect(data.receipt.intent(key)).not.toBeNull();
    expect(data.messages.some((m) => m._id === probeId)).toBe(true);
    const resumed = await mod.verifyBatch(
      'http://x',
      ADMIN,
      data.plan,
      data.receipt,
      data.tokens,
      {},
    );
    expect(resumed.ok).toBe(false);
    expect(resumed.faults.map((f) => f.kind)).toContain('posting-permission');
    expect(data.messages.some((m) => m._id === probeId)).toBe(false);
    expect(data.receipt.intent(key)).toBeNull();
    expect(requests.filter((r) => r.path === '/api/v1/chat.sendMessage')).toHaveLength(1);
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/api/v1/chat.delete',
          payload: { roomId: data.room._id, msgId: probeId },
          headers: { 'X-Auth-Token': ADMIN.token, 'X-User-Id': ADMIN.userId },
        }),
      ]),
    );
  });
});
