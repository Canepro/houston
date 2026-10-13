/** Verify the latest batch by identity, including actors, assets, and room relationships. */
import { createHash } from 'node:crypto';
import { ConflictError, CreateFailedError } from '../lib/errors';
import { type Auth, authHeaders, rcapi } from '../core/rcapi';
import { ARCHIVED, BROADCAST, DISCUSSION, DM, GROUP_DM, PERMISSIONS, READ_ONLY } from './kinds';
import type { Plan } from './plan';
import type { Receipt } from './receipt';
import { ApiRejected, Client, type Bag, id, list, map } from './client';
import { profile as userProfile } from './assets';

export async function verifyBatch(
  rootUrl: string,
  admin: Auth,
  plan: Plan,
  receipt: Receipt,
  tokens: Record<string, Auth>,
  summary: Bag,
) {
  const client = new Client(rootUrl);
  const adminHdr = authHeaders(admin);
  const faults: { kind: string; room: string; want: unknown; got: unknown; detail: string }[] = [];
  const unreadable: Bag[] = [];
  const rooms: Bag[] = [];
  const counts: Record<string, number> = {
    messages: 0,
    replies: 0,
    reactions: 0,
    pins: 0,
    stars: 0,
    mentions: 0,
    edits: 0,
    files: 0,
    thread_parents: 0,
  };
  let checked = 0;
  let checks = 0;
  const fault = (kind: string, room: string, want: unknown, got: unknown, detail = ''): void => {
    faults.push({ kind, room, want, got, detail });
  };
  const expect = (
    ok: boolean,
    kind: string,
    room: string,
    want: unknown,
    got: unknown,
  ): boolean => {
    checks += 1;
    if (!ok) fault(kind, room, want, got);
    return ok;
  };
  for (const failed of list(summary.failed))
    fault('execution', id(failed.name), 'completed', failed.why);
  for (const failed of list(summary.users_failed))
    fault('login', id(failed.username), 'named participant', failed.why);
  const dates = list(receipt.done('history:timeline')?.messages);
  if (plan.historyDays !== null)
    expect(
      receipt.done('history:timeline') !== null && receipt.done('history:metadata')?.ok === true,
      'history',
      'history',
      'completed timestamp adjustment',
      'not completed',
    );
  const expectedDates = new Map(dates.map((m) => [id(m.id), id(m.ts)]));
  const userEntries = [...receipt.entries.entries()].filter(
    ([key, line]) => key.startsWith('user:') && line.state === 'done',
  );
  for (const [key, line] of userEntries) {
    const username = key.slice(5);
    try {
      const user = map(
        (await client.get('/api/v1/users.info', adminHdr, { userId: id(line.data.id) })).user,
      );
      expect(
        user._id === line.data.id && user.username === username,
        'identity',
        username,
        line.data.id,
        user._id,
      );
      if (line.data.new === true) {
        const index = userEntries.findIndex(([k]) => k === key);
        const desired = userProfile(username, index);
        expect(
          user.name === desired.name && user.bio === desired.bio,
          'profile',
          username,
          desired,
          { name: user.name, bio: user.bio },
        );
        const avatar = await rcapi.download(
          rootUrl,
          `/avatar/${encodeURIComponent(username)}`,
          adminHdr,
        );
        expect(
          avatar.ok && avatar.headers['content-type']?.includes('image/') === true,
          'avatar',
          username,
          'image',
          avatar.status,
        );
      }
    } catch (error) {
      unreadable.push({
        what: username,
        why: error instanceof Error ? error.message : String(error),
      });
    }
  }
  expect(userEntries.length === plan.users, 'users', 'users', plan.users, userEntries.length);
  try {
    const emojis = list(
      map((await client.get('/api/v1/emoji-custom.list', adminHdr)).emojis).update,
    );
    for (const name of plan.customEmoji)
      expect(
        emojis.some((e) => e.name === name && e._id === receipt.done(`emoji:${name}`)?.id),
        'emoji',
        name,
        'owned asset',
        'missing',
      );
  } catch (error) {
    unreadable.push({
      what: 'custom emoji',
      why: error instanceof Error ? error.message : String(error),
    });
  }
  for (const spec of plan.rooms) {
    const created = receipt.done(`room:${spec.name}`);
    if (created === null) {
      fault('missing', spec.name, 'created room', 'no receipt');
      continue;
    }
    const rid = id(created.rid);
    const owner = tokens[spec.members[0] ?? ''];
    const dm = [DM, GROUP_DM].includes(spec.kind);
    const headers = dm ? (owner === undefined ? null : authHeaders(owner)) : adminHdr;
    if (headers === null) {
      unreadable.push({ what: spec.name, why: 'participant could not log in' });
      continue;
    }
    try {
      const actualRoom = dm
        ? list((await client.get('/api/v1/im.list', headers, { count: 0 })).ims).find(
            (r) => r._id === rid,
          )
        : await client.room(rid, adminHdr);
      if (actualRoom === undefined || id(actualRoom._id) === '')
        throw new CreateFailedError('room readback returned no identity');
      expect(actualRoom._id === rid, 'room', spec.name, rid, actualRoom._id);
      if (!dm && spec.kind !== ARCHIVED) {
        const detail = map(
          (await client.get('/api/v1/rooms.info', adminHdr, { roomId: rid })).room,
        );
        if (detail._id !== rid)
          throw new CreateFailedError('room details returned no matching identity');
        Object.assign(actualRoom, detail);
      }
      const type = id(actualRoom.t) || id(created.type);
      const api = type === 'd' ? 'im' : type === 'p' ? 'groups' : 'channels';
      const messages = await client.pages(`/api/v1/${api}.messages`, headers, 'messages', {
        roomId: rid,
      });
      const byId = new Map(messages.map((m) => [id(m._id), m]));
      if (dm) {
        const participants = Array.isArray(actualRoom.usernames)
          ? (actualRoom.usernames as string[])
          : [];
        expect(
          participants.length === spec.members.length &&
            spec.members.every((n) => participants.includes(n)),
          'participants',
          spec.name,
          spec.members,
          participants,
        );
      } else {
        const members = await client.pages(
          `/api/v1/${type === 'p' ? 'groups' : 'channels'}.members`,
          headers,
          'members',
          { roomId: rid },
        );
        for (const username of spec.members)
          expect(
            members.some((m) => m._id === receipt.done(`user:${username}`)?.id),
            'member',
            spec.name,
            username,
            'missing',
          );
      }
      if (created.teamId !== '' && spec.kind !== DISCUSSION) {
        expect(
          actualRoom.teamId === created.teamId,
          'team',
          spec.name,
          created.teamId,
          actualRoom.teamId,
        );
        const members = await client.pages('/api/v1/teams.members', adminHdr, 'members', {
          teamId: id(created.teamId),
        });
        for (const username of spec.members)
          expect(
            members.some((m) => id(map(m.user ?? m)._id) === receipt.done(`user:${username}`)?.id),
            'team-member',
            spec.name,
            username,
            'missing',
          );
      }
      if (spec.kind === DISCUSSION) {
        const parent = id(receipt.done(`room:${spec.parent}`)?.rid);
        expect(
          actualRoom.prid === parent && actualRoom.fname === spec.name,
          'discussion',
          spec.name,
          { parent, title: spec.name },
          { parent: actualRoom.prid, title: actualRoom.fname },
        );
      }
      let roomMessages = 0;
      let roomReplies = 0;
      let roomReacted = 0;
      for (const item of spec.content) {
        const recorded = receipt.done(`message:${spec.name}:${item.key}`);
        if (recorded === null) {
          fault('message', spec.name, item.key, 'no receipt');
          continue;
        }
        const message = byId.get(id(recorded.id));
        if (message === undefined) {
          fault('message', spec.name, recorded.id, 'absent');
          continue;
        }
        counts.messages = (counts.messages ?? 0) + 1;
        roomMessages += 1;
        if (item.kind === 'reply') {
          roomReplies += 1;
          counts.replies = (counts.replies ?? 0) + 1;
        }
        const uid = item.author === '' ? admin.userId : id(receipt.done(`user:${item.author}`)?.id);
        expect(
          message.rid === rid && id(map(message.u)._id) === uid,
          'author',
          spec.name,
          { rid, userId: uid },
          { rid: message.rid, userId: map(message.u)._id },
        );
        expect(
          message.msg === (item.editedText || item.text),
          'text',
          spec.name,
          item.editedText || item.text,
          message.msg,
        );
        const parent =
          item.parent === '' ? '' : id(receipt.done(`message:${spec.name}:${item.parent}`)?.id);
        expect(id(message.tmid) === parent, 'thread-parent', spec.name, parent, id(message.tmid));
        const ts = expectedDates.get(id(message._id));
        if (ts !== undefined) expect(message.ts === ts, 'date', spec.name, ts, message.ts);
        if (item.reactions.length > 0) roomReacted += 1;
        for (const action of item.reactions) {
          const usernames = map(map(message.reactions)[action.emoji]).usernames;
          if (
            expect(
              Array.isArray(usernames) && usernames.includes(action.author),
              'reaction',
              spec.name,
              action,
              'missing',
            )
          )
            counts.reactions = (counts.reactions ?? 0) + 1;
        }
        if (item.pin) {
          if (expect(message.pinned === true, 'pin', spec.name, true, message.pinned))
            counts.pins = (counts.pins ?? 0) + 1;
        }
        if (item.star !== '') {
          const actor = tokens[item.star];
          if (actor === undefined) throw new CreateFailedError('star owner could not sign in');
          const personal = map(
            (
              await client.get('/api/v1/chat.getMessage', authHeaders(actor), {
                msgId: id(recorded.id),
              })
            ).message,
          );
          if (
            expect(
              personal._id === recorded.id &&
                list(personal.starred).some((s) => s._id === receipt.done(`user:${item.star}`)?.id),
              'star',
              spec.name,
              item.star,
              'missing',
            )
          )
            counts.stars = (counts.stars ?? 0) + 1;
        }
        if (item.mention !== '') {
          if (
            expect(
              list(message.mentions).some((m) => m.username === item.mention),
              'mention',
              spec.name,
              item.mention,
              message.mentions,
            )
          )
            counts.mentions = (counts.mentions ?? 0) + 1;
        }
        if (item.editedText !== '') {
          if (
            expect(
              id(map(message.editedBy)._id) === uid && typeof message.editedAt === 'string',
              'edit',
              spec.name,
              'editor and action date',
              { editor: map(message.editedBy)._id, date: message.editedAt },
            )
          )
            counts.edits = (counts.edits ?? 0) + 1;
        }
        if (item.kind === 'main' && spec.threads.includes(Number(item.key.slice(5)))) {
          if (
            expect(
              Number(message.tcount) >= spec.replyCount,
              'thread',
              spec.name,
              spec.replyCount,
              message.tcount,
            )
          )
            counts.thread_parents = (counts.thread_parents ?? 0) + 1;
        }
        if (item.kind === 'file') {
          const upload = receipt.done(`upload:${spec.name}:${item.key}`);
          expect(
            upload !== null && id(map(message.file)._id) === upload.id,
            'file',
            spec.name,
            upload?.id,
            map(message.file)._id,
          );
          const auth = tokens[item.author] ?? (item.author === '' ? admin : undefined);
          if (auth === undefined) throw new CreateFailedError('file uploader could not sign in');
          const url = new URL(id(upload?.url), rootUrl);
          url.searchParams.set('rc_uid', auth.userId);
          url.searchParams.set('rc_token', auth.token);
          const downloaded = await rcapi.download(rootUrl, url.href, authHeaders(auth));
          const bytes = downloaded.bytes;
          if (
            expect(
              downloaded.ok &&
                bytes !== undefined &&
                createHash('sha256').update(bytes).digest('hex') === upload?.sha256,
              'download',
              spec.name,
              'packaged bytes',
              downloaded.status,
            )
          )
            counts.files = (counts.files ?? 0) + 1;
        }
      }
      const opening = [...receipt.entries.values()].filter(
        (e) => e.state === 'done' && e.key.startsWith(`opening:${spec.name}:`),
      );
      for (const e of opening) {
        const m = byId.get(id(e.data.id));
        expect(m !== undefined, 'opening', spec.name, e.data.id, 'absent');
        const ts = expectedDates.get(id(e.data.id));
        if (ts !== undefined) expect(m?.ts === ts, 'opening-date', spec.name, ts, m?.ts);
      }
      if (spec.kind === READ_ONLY)
        expect(actualRoom.ro === true, 'read-only', spec.name, true, actualRoom.ro);
      if (spec.kind === BROADCAST)
        expect(
          actualRoom.broadcast === true && actualRoom.ro === true,
          'broadcast',
          spec.name,
          true,
          { broadcast: actualRoom.broadcast, ro: actualRoom.ro },
        );
      if (spec.kind === ARCHIVED)
        expect(actualRoom.archived === true, 'archived', spec.name, true, actualRoom.archived);
      if (spec.kind === PERMISSIONS) {
        const roles = list(
          (await client.get('/api/v1/groups.roles', adminHdr, { roomId: rid })).roles,
        );
        for (const [username, role] of [
          ['alice', 'owner'],
          ['bob', 'moderator'],
        ])
          expect(
            roles.some(
              (r) =>
                map(r.u).username === username && Array.isArray(r.roles) && r.roles.includes(role),
            ),
            'role',
            spec.name,
            { username, role },
            roles,
          );
        const muted = actualRoom.muted;
        expect(
          Array.isArray(muted) &&
            (muted.includes('carol') || muted.includes(receipt.done('user:carol')?.id)),
          'muted',
          spec.name,
          'carol',
          muted,
        );
        const outsider = tokens.dave;
        if (outsider === undefined)
          throw new CreateFailedError('permissions outsider could not sign in');
        let denied = false;
        try {
          await client.get('/api/v1/groups.history', authHeaders(outsider), { roomId: rid });
        } catch (error) {
          if (error instanceof ApiRejected && [400, 403, 404].includes(error.status)) denied = true;
          else throw error;
        }
        expect(denied, 'privacy', spec.name, 'outsider denied', 'access granted');
      }
      if ([READ_ONLY, BROADCAST, PERMISSIONS].includes(spec.kind)) {
        const username =
          spec.kind === PERMISSIONS ? 'carol' : (spec.members[1] ?? spec.members[0] ?? '');
        const auth = tokens[username];
        if (auth === undefined)
          throw new CreateFailedError('scenario participant could not sign in');
        const key = `probe:${spec.name}`;
        const mid = receipt.identifier(key);
        const text = 'Houston scenario permission verification';
        const absent = (error: unknown): boolean =>
          error instanceof ApiRejected &&
          [400, 404].includes(error.status) &&
          ['error-invalid-message', 'error-message-not-found', 'error-invalid-message-id'].includes(
            error.errorType,
          );
        const clean = async (): Promise<void> => {
          try {
            await client.post('/api/v1/chat.delete', adminHdr, { roomId: rid, msgId: mid });
          } catch (error) {
            if (!absent(error)) throw error;
          }
        };
        const outcome = await receipt.step(
          key,
          { id: mid, rid, userId: auth.userId },
          async () => {
            let denied = false;
            try {
              const body = await client.post('/api/v1/chat.sendMessage', authHeaders(auth), {
                message: { _id: mid, rid, msg: text },
              });
              if (map(body.message)._id !== mid)
                throw new ConflictError('scenario probe returned no matching identity');
            } catch (error) {
              if (
                error instanceof ApiRejected &&
                [400, 403].includes(error.status) &&
                /not-allowed|read.?only|muted|permission|unauthorized/iu.test(error.errorType)
              )
                denied = true;
              else throw error;
            }
            receipt.record(`probe-result:${spec.name}`, 'done', { denied });
            if (!denied) await clean();
            return { denied };
          },
          async () => {
            const saved = receipt.done(`probe-result:${spec.name}`);
            if (saved?.denied === true) return saved;
            const message = await client.pendingMessage(mid, rid, api, authHeaders(auth));
            if (message === null) return saved?.denied === false ? saved : null;
            if (
              message._id !== mid ||
              message.rid !== rid ||
              map(message.u)._id !== auth.userId ||
              message.msg !== text
            )
              throw new ConflictError('pending scenario probe identity changed');
            receipt.record(`probe-result:${spec.name}`, 'done', { denied: false });
            await clean();
            return { denied: false };
          },
        );
        const denied = outcome.denied === true;
        expect(
          denied,
          'posting-permission',
          spec.name,
          'ordinary member denied',
          'posting allowed',
        );
      }
      if (plan.historyDays !== null) {
        const first = spec.content.find((c) => c.kind === 'main');
        const firstId =
          first === undefined ? '' : id(receipt.done(`message:${spec.name}:${first.key}`)?.id);
        if (firstId !== '') {
          const ref = Date.parse(receipt.manifest.reference);
          const format = (time: number): string => {
            const d = new Date(time);
            return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
          };
          const matches = await client.pages('/api/v1/chat.search', headers, 'messages', {
            roomId: rid,
            searchText: `INC-4821 after:${format(ref - (plan.historyDays + 1) * 86400000)} before:${format(ref + 86400000)}`,
          });
          expect(
            matches.some((m) => m._id === firstId),
            'date-search',
            spec.name,
            firstId,
            'absent',
          );
        }
      }
      checked += 1;
      rooms.push({
        kind: spec.kind,
        name: spec.name,
        rid,
        found: true,
        messages: roomMessages,
        replies: roomReplies,
        reacted: roomReacted,
        threads: spec.threads.length,
        in_team: true,
        unreadable: '',
        participants: spec.members,
      });
    } catch (error) {
      unreadable.push({
        what: spec.name,
        why: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    ok: faults.length > 0 ? false : unreadable.length > 0 ? null : true,
    faults,
    extra: [],
    unreadable,
    checked,
    checks_completed: checks,
    rooms,
    features: counts,
  };
}
