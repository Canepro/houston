/** Named actors and exact write receipts for rich sample data. */
import { ConflictError, CreateFailedError } from '../lib/errors';
import { Timings } from '../perf/timings';
import { Interrupted, cleanup } from '../seams/exec';
import { type Auth, authHeaders, login as realLogin, password2faHeaders } from '../core/rcapi';
import {
  ARCHIVED,
  BROADCAST,
  DISCUSSION,
  DM,
  GENERAL,
  GROUP_DM,
  PERMISSIONS,
  READ_ONLY,
  TEAM,
  TEAM_PRIVATE,
} from './kinds';
import {
  type ContentSpec,
  type Made,
  type Plan,
  type RoomSpec,
  isPrivate,
  made as makeMade,
} from './plan';
import { avatar, asset, profile as userProfile } from './assets';
import {
  ApiRejected,
  Client,
  type Bag,
  type Headers,
  type ParticipantLogin,
  id,
  list,
  map,
} from './client';
import { ReceiptStorageError, type Receipt } from './receipt';
import * as wording from './wording';

interface Options {
  tokensOut?: Record<string, Auth>;
  login?: ParticipantLogin;
  legacy?: Bag;
}
function roomId(body: Bag): string {
  for (const key of ['channel', 'group', 'room', 'discussion']) {
    const value = id(map(body[key])._id) || id(map(body[key]).rid);
    if (value !== '') return value;
  }
  return id(body.rid);
}
function roomType(spec: RoomSpec): string {
  return [DM, GROUP_DM].includes(spec.kind) ? 'd' : isPrivate(spec) ? 'p' : 'c';
}
function messageData(message: Bag, room: RoomSpec, key: string, author: string, kind: string): Bag {
  if (id(message._id) === '') throw new ConflictError('message response has no captured identity');
  return {
    id: id(message._id),
    rid: id(message.rid),
    room: room.name,
    key,
    author,
    userId: id(map(message.u)._id),
    username: id(map(message.u).username),
    kind,
    text: id(message.msg),
    ts: message.ts ?? null,
    tmid: id(message.tmid),
    attachments: message.attachments ?? [],
    fileIds: [
      ...new Set(
        [id(map(message.file)._id), ...list(message.files).map((f) => id(f._id))].filter(
          (v) => v !== '',
        ),
      ),
    ],
  };
}

export async function execute(
  rootUrl: string,
  admin: Auth,
  receipt: Receipt,
  plan: Plan,
  options: Options,
  log: (message: string) => void,
): Promise<{
  made: Map<string, Made>;
  names: string[];
  durations: Record<string, number>;
  timings: Timings;
  usersFailed: Bag[];
}> {
  const client = new Client(rootUrl, { log });
  const adminHdr = authHeaders(admin);
  const timings = new Timings();
  const durations: Record<string, number> = { users: 0, channels: 0, messages: 0, dms: 0 };
  const tokens = new Map<string, Auth>();
  const userIds = new Map<string, string>();
  const names = Array.from({ length: plan.users }, (_, i) => wording.username(i));
  const usersFailed: Bag[] = [];
  const legacyUsers = new Set<string>();
  const legacyRooms = new Set<string>();
  const start = Date.now();
  const step = async (
    key: string,
    data: Bag,
    perform: () => Promise<Bag>,
    reconcile?: (intent: Bag) => Promise<Bag | null>,
  ): Promise<Bag> => {
    try {
      return await receipt.step(key, data, perform, reconcile);
    } catch (error) {
      if (error instanceof ApiRejected && error.status < 500)
        receipt.record(key, 'rejected', { status: error.status });
      else if (error instanceof ApiRejected)
        throw new ConflictError(
          `seed operation ${key} has an uncertain server result; resume with the same options`,
        );
      else if (error instanceof CreateFailedError) throw error;
      else if (!(error instanceof ConflictError) && !(error instanceof Interrupted))
        throw new ConflictError(
          `seed operation ${key} has an uncertain result; resume with the same options`,
        );
      throw error;
    }
  };
  const mutation = async (key: string, path: string, headers: Headers, data: Bag): Promise<Bag> =>
    await step(
      key,
      { path, userId: headers['X-User-Id'] ?? '' },
      async () => {
        await client.post(path, headers, data);
        return { userId: headers['X-User-Id'] ?? '' };
      },
      async () => {
        await client.post(path, headers, data);
        return { userId: headers['X-User-Id'] ?? '' };
      },
    );
  const lookupUser = async (username: string): Promise<Bag | null> => {
    try {
      const user = map((await client.get('/api/v1/users.info', adminHdr, { username })).user);
      if (id(user._id) !== '') return user;
      if (!receipt.persistent) return null;
      throw new CreateFailedError('users.info returned no identity');
    } catch (error) {
      if (error instanceof ApiRejected && [400, 404].includes(error.status)) return null;
      throw error;
    }
  };
  // A verified older seed record alone cannot own a name collision. Require its
  // original administrator-created room and actual legacy text/author identities.
  const prior = options.legacy;
  if (
    prior !== undefined &&
    typeof prior.run_id !== 'string' &&
    map(prior.verification).ok === true &&
    typeof map(prior.actual).messages === 'number' &&
    Number(map(prior.actual).messages) > 0
  ) {
    const visible = [
      ...(await client.pages('/api/v1/channels.list', adminHdr, 'channels')),
      ...(await client.pages('/api/v1/groups.list', adminHdr, 'groups')),
    ];
    const expectedNames = new Set(
      plan.rooms.filter((r) => ![DM, GROUP_DM].includes(r.kind)).map((r) => r.name),
    );
    for (const room of visible) {
      if (
        !expectedNames.has(id(room.fname) || id(room.name)) ||
        id(map(room.u)._id) !== admin.userId ||
        id(room._id) === ''
      )
        continue;
      const messages = await client.pages(
        `/api/v1/${room.t === 'p' ? 'groups' : 'channels'}.messages`,
        adminHdr,
        'messages',
        { roomId: id(room._id) },
      );
      const old = messages.filter(
        (m) => wording.MESSAGES.includes(id(m.msg)) && id(map(m.u)._id) !== '',
      );
      if (old.length === 0) continue;
      legacyRooms.add(id(room._id));
      for (const message of old) legacyUsers.add(id(map(message.u)._id));
    }
  }
  const isLegacyUser = (current: Bag, username: string): boolean =>
    legacyUsers.has(id(current._id)) &&
    list(current.emails).some((e) => e.address === `${username}@example.com`);
  for (let i = 0; i < names.length; i += 1) {
    const username = names[i] as string;
    const key = `user:${username}`;
    const email = `${username}+houston-${receipt.manifest.run}@example.com`;
    const desired = userProfile(username, i);
    try {
      const create = async (): Promise<Bag> => {
        const current = await lookupUser(username);
        const owned = receipt.owned.get(key);
        if (current !== null) {
          if (
            receipt.persistent &&
            owned?.id !== id(current._id) &&
            !isLegacyUser(current, username)
          )
            throw new ConflictError(`seed username ${username} belongs to an unowned account`);
          return { id: id(current._id), username, new: false };
        }
        const user = map(
          (
            await client.post('/api/v1/users.create', adminHdr, {
              name: desired.name,
              username,
              email,
              password: username,
              verified: true,
              requirePasswordChange: false,
              joinDefaultChannels: true,
            })
          ).user,
        );
        if (id(user._id) === '')
          throw new ConflictError(`seed account ${username} returned no identity`);
        return { id: id(user._id), username, email, new: true };
      };
      const created = await step(key, { username, email }, create, async (intent) => {
        const current = await lookupUser(username);
        if (current === null) return null;
        if (receipt.owned.get(key)?.id === current._id || isLegacyUser(current, username))
          return { id: id(current._id), username, new: false };
        if (!list(current.emails).some((e) => e.address === intent.email))
          throw new ConflictError(`seed cannot identify the pending account ${username}`);
        return { id: id(current._id), username, email, new: true };
      });
      userIds.set(username, id(created.id));
      const auth = await (options.login ?? realLogin)(rootUrl, {
        user: username,
        password: username,
      });
      if (receipt.persistent && auth.userId !== id(created.id))
        throw new ConflictError(`seed login returned a different identity for ${username}`);
      tokens.set(username, auth);
      if (created.new === true) {
        await mutation(
          `profile:${username}`,
          '/api/v1/users.updateOwnBasicInfo',
          authHeaders(auth),
          { data: desired },
        );
        const setAvatar = async (): Promise<Bag> => {
          await client.multipart('/api/v1/users.setAvatar', authHeaders(auth), [
            { name: 'image', value: avatar(i), filename: 'seed-avatar.png', type: 'image/png' },
          ]);
          return {};
        };
        await step(`avatar:${username}`, {}, setAvatar, setAvatar);
        if (receipt.persistent)
          await mutation(
            `email2fa:${username}`,
            '/api/v1/users.2fa.disableEmail',
            { ...authHeaders(auth), ...(await password2faHeaders(username)) },
            {},
          );
      }
    } catch (error) {
      if (
        error instanceof ConflictError ||
        error instanceof Interrupted ||
        error instanceof ReceiptStorageError
      )
        throw error;
      usersFailed.push({ username, why: error instanceof Error ? error.message : String(error) });
    }
  }
  durations.users = (Date.now() - start) / 1000;
  for (const [name, auth] of tokens)
    if (options.tokensOut !== undefined) options.tokensOut[name] = auth;
  log(`users: ${names.length} (${tokens.size} usable as authors)`);
  const actor = (name: string): Auth => {
    if (name === '') return admin;
    const auth = tokens.get(name);
    if (auth === undefined)
      throw new CreateFailedError(`seed participant ${name} could not log in`);
    return auth;
  };
  for (let i = 0; i < plan.customEmoji.length; i += 1) {
    const name = plan.customEmoji[i] as string;
    const alias = receipt.identifier(`emoji:${name}`);
    const find = async (): Promise<Bag[]> =>
      list(map((await client.get('/api/v1/emoji-custom.list', adminHdr)).emojis).update).filter(
        (e) => e.name === name,
      );
    await step(
      `emoji:${name}`,
      { name, alias },
      async () => {
        const existing = await find();
        if (existing.length > 1) throw new ConflictError(`seed emoji ${name} is ambiguous`);
        if (existing.length === 1) {
          if (receipt.persistent && receipt.owned.get(`emoji:${name}`)?.id !== id(existing[0]?._id))
            throw new ConflictError(`seed emoji ${name} belongs to an unowned asset`);
          return { id: id(existing[0]?._id), name, reused: true };
        }
        await client.multipart('/api/v1/emoji-custom.create', adminHdr, [
          { name: 'name', value: name },
          { name: 'aliases', value: alias },
          { name: 'emoji', value: avatar(i), filename: 'seed-emoji.png', type: 'image/png' },
        ]);
        const found = await find();
        if (found.length !== 1)
          throw new CreateFailedError(`seed emoji ${name} could not be identified`);
        return { id: id(found[0]?._id), name, reused: false };
      },
      async () => {
        const found = await find();
        if (found.length === 0) return null;
        if (
          found.length !== 1 ||
          !Array.isArray(found[0]?.aliases) ||
          !(found[0].aliases as unknown[]).includes(alias)
        )
          throw new ConflictError(`seed emoji ${name} cannot be reconciled`);
        return { id: id(found[0]._id), name, reused: false };
      },
    );
  }
  const made = new Map<string, Made>();
  const stateRooms: Made[] = [];
  const marker = (spec: RoomSpec): Bag => ({
    houstonSeed: { run: receipt.manifest.run, key: spec.name },
  });
  const readRoom = async (rid: string): Promise<Bag> => await client.room(rid, adminHdr);
  const existingChannel = async (spec: RoomSpec): Promise<Bag | null> => {
    try {
      const body = await client.get(
        `/api/v1/${isPrivate(spec) ? 'groups' : 'channels'}.info`,
        adminHdr,
        { roomName: spec.name },
      );
      const found = map(body.group ?? body.channel);
      if (id(found._id) === '') {
        if (!receipt.persistent) return null;
        throw new CreateFailedError('room lookup returned no identity');
      }
      return found;
    } catch (error) {
      if (error instanceof ApiRejected && [400, 404].includes(error.status)) return null;
      throw error;
    }
  };
  const createRoom = async (spec: RoomSpec, reuseOnly = false): Promise<Bag> => {
    const owned = receipt.owned.get(`room:${spec.name}`);
    if ([DM, GROUP_DM].includes(spec.kind)) {
      const owner = actor(spec.members[0] as string);
      const others = spec.members.slice(1);
      const body = await client.post(
        '/api/v1/dm.create',
        authHeaders(owner),
        spec.kind === DM ? { username: others[0] } : { usernames: others.join(',') },
      );
      const rid = roomId(body);
      if (rid === '') throw new ConflictError(`conversation ${spec.name} returned no room`);
      return { rid, type: 'd', reused: owned?.rid === rid, teamId: '' };
    }
    if (spec.kind === GENERAL) return { rid: 'GENERAL', type: 'c', reused: true, teamId: '' };
    if (spec.kind === DISCUSSION) {
      const parent = made.get(spec.parent);
      if (parent === undefined || parent.rid === '' || parent.failed !== '')
        throw new CreateFailedError(`discussion parent ${spec.parent} is unavailable`);
      const matches = (
        await client.pages('/api/v1/rooms.getDiscussions', adminHdr, 'discussions', {
          roomId: parent.rid,
        })
      ).filter((d) => id(d.prid) === parent.rid && (d.fname === spec.name || d.name === spec.name));
      if (matches.length > 1)
        throw new CreateFailedError(`discussion ${spec.name} is ambiguous under ${spec.parent}`);
      if (matches.length === 1) {
        const found = matches[0] as Bag;
        if (receipt.persistent && owned?.rid !== id(found._id) && !legacyRooms.has(id(found._id)))
          throw new ConflictError(`discussion ${spec.name} is unowned`);
        return {
          rid: id(found._id),
          type: id(found.t) || roomType(parent.spec),
          reused: true,
          teamId: id(found.teamId),
          parent: parent.rid,
        };
      }
      if (reuseOnly)
        throw new ConflictError(`pending discussion ${spec.name} has no committed identity`);
      const payload: Bag = { prid: parent.rid, t_name: spec.name, users: spec.members };
      if (spec.fromMessage >= 0) {
        const anchor = parent.messageIds[spec.fromMessage];
        if (anchor === undefined)
          throw new CreateFailedError(`discussion anchor ${spec.parent} is unavailable`);
        payload.pmid = anchor;
        payload.reply = `INC-4821 discussion opening: ${spec.name}`;
      }
      const body = await client.post('/api/v1/rooms.createDiscussion', adminHdr, payload);
      const rid = roomId(body);
      if (rid === '') throw new ConflictError('discussion creation returned no room');
      return {
        rid,
        type: id(map(body.discussion).t) || roomType(parent.spec),
        reused: false,
        teamId: parent.teamId,
        parent: parent.rid,
        anchor: id(payload.pmid),
      };
    }
    let existing: Bag | null = null;
    if (owned !== undefined) {
      try {
        existing = await readRoom(id(owned.rid));
      } catch (error) {
        if (!(error instanceof ApiRejected && [400, 404].includes(error.status))) throw error;
      }
    } else existing = await existingChannel(spec);
    if (existing !== null && id(existing._id) !== '') {
      if (
        receipt.persistent &&
        owned?.rid !== id(existing._id) &&
        !legacyRooms.has(id(existing._id))
      )
        throw new ConflictError(`seed room ${spec.name} belongs to an unowned room`);
      const detail =
        spec.kind === ARCHIVED
          ? existing
          : map(
              (await client.get('/api/v1/rooms.info', adminHdr, { roomId: id(existing._id) })).room,
            );
      let teamId = id(detail.teamId ?? existing.teamId);
      if ([TEAM, TEAM_PRIVATE].includes(spec.kind))
        teamId = id(
          map((await client.get('/api/v1/teams.info', adminHdr, { teamName: spec.name })).teamInfo)
            ._id,
        );
      return {
        rid: id(existing._id),
        type: id(existing.t) || roomType(spec),
        reused: true,
        teamId,
      };
    }
    if (reuseOnly)
      throw new ConflictError(`pending ${spec.kind} ${spec.name} has no committed identity`);
    if ([TEAM, TEAM_PRIVATE].includes(spec.kind)) {
      const team = map(
        (
          await client.post('/api/v1/teams.create', adminHdr, {
            name: spec.name,
            type: spec.kind === TEAM_PRIVATE ? 1 : 0,
            members: spec.members,
          })
        ).team,
      );
      if (id(team.roomId) === '' || id(team._id) === '')
        throw new ConflictError('team creation returned no identity');
      return { rid: id(team.roomId), teamId: id(team._id), type: roomType(spec), reused: false };
    }
    const parent = made.get(spec.parent);
    // The marker rides in customFields: from 8.8.0 `extraData` takes only the room fields
    // Rocket.Chat declares, and refused the whole create with it there (invalid-params).
    const extraData: Bag = {};
    if (spec.parent !== '') {
      if (parent === undefined || parent.teamId === '')
        throw new CreateFailedError(`team ${spec.parent} is unavailable`);
      extraData.teamId = parent.teamId;
    }
    if (spec.kind === BROADCAST) extraData.broadcast = true;
    const body = await client.post(
      `/api/v1/${isPrivate(spec) ? 'groups' : 'channels'}.create`,
      adminHdr,
      { name: spec.name, members: spec.members, extraData, customFields: marker(spec) },
    );
    const rid = roomId(body);
    if (rid === '') throw new ConflictError(`room ${spec.name} returned no identity`);
    return { rid, type: roomType(spec), teamId: parent?.teamId ?? '', reused: false };
  };
  const forceState = async (room: Made, open: boolean): Promise<void> => {
    const spec = room.spec;
    const key = `state:${spec.name}:${open ? 'open' : 'close'}`;
    let storageError: unknown;
    try {
      receipt.record(key, 'intent', { rid: room.rid, kind: spec.kind, open });
    } catch (error) {
      if (open) throw error;
      storageError = error;
    }
    const current = await readRoom(room.rid);
    if (spec.kind === ARCHIVED && (current.archived === true) !== !open)
      await client.post(`/api/v1/channels.${open ? 'unarchive' : 'archive'}`, adminHdr, {
        roomId: room.rid,
      });
    if (spec.kind === READ_ONLY && (current.ro === true) !== !open)
      await client.post('/api/v1/channels.setReadOnly', adminHdr, {
        roomId: room.rid,
        readOnly: !open,
      });
    if (spec.kind === PERMISSIONS) {
      if (receipt.persistent)
        Object.assign(
          current,
          map((await client.get('/api/v1/rooms.info', adminHdr, { roomId: room.rid })).room),
        );
      const muted =
        Array.isArray(current.muted) &&
        (current.muted.includes(userIds.get('carol')) || current.muted.includes('carol'));
      if (muted !== !open)
        await client.post(`/api/v1/rooms.${open ? 'unmuteUser' : 'muteUser'}`, adminHdr, {
          roomId: room.rid,
          userId: userIds.get('carol'),
        });
    }
    if (storageError !== undefined) throw storageError;
    receipt.record(key, 'done', { rid: room.rid, open });
  };
  const content = async (room: Made, item: ContentSpec): Promise<void> => {
    const spec = room.spec;
    const auth = actor(item.author);
    const headers = authHeaders(auth);
    const key = `message:${spec.name}:${item.key}`;
    const parent =
      item.parent === '' ? '' : id(receipt.done(`message:${spec.name}:${item.parent}`)?.id);
    if (item.parent !== '' && parent === '')
      throw new CreateFailedError(`thread ${item.key} has no parent`);
    let message: Bag;
    const t0 = Date.now();
    if (item.kind === 'file') {
      const fixture = asset(item.file);
      const filename = `${receipt.identifier(key)}-${fixture.name}`;
      const uploaded = await step(
        `upload:${spec.name}:${item.key}`,
        { rid: room.rid, userId: auth.userId, filename, sha256: fixture.sha256 },
        async () => {
          const file = map(
            (
              await client.multipart(`/api/v1/rooms.media/${room.rid}`, headers, [
                { name: 'file', value: fixture.bytes, filename, type: fixture.type },
              ])
            ).file,
          );
          if (id(file._id) === '') throw new ConflictError('upload returned no file identity');
          return {
            id: id(file._id),
            url: id(file.url),
            rid: room.rid,
            userId: auth.userId,
            filename,
            sha256: fixture.sha256,
          };
        },
        async () => {
          throw new ConflictError(
            `upload ${filename} has an uncertain result; refusing another upload`,
          );
        },
      );
      message = await step(
        key,
        { rid: room.rid, userId: auth.userId, fileId: uploaded.id },
        async () =>
          messageData(
            map(
              (
                await client.post(
                  `/api/v1/rooms.mediaConfirm/${room.rid}/${id(uploaded.id)}`,
                  headers,
                  { msg: item.text, description: 'Packaged support sample' },
                )
              ).message,
            ),
            spec,
            item.key,
            item.author,
            'file',
          ),
        async () => {
          const api =
            roomType(spec) === 'd' ? 'im' : roomType(spec) === 'p' ? 'groups' : 'channels';
          const matches = (
            await client.pages(`/api/v1/${api}.messages`, headers, 'messages', { roomId: room.rid })
          ).filter(
            (m) =>
              id(map(m.u)._id) === auth.userId &&
              (id(map(m.file)._id) === uploaded.id ||
                list(m.files).some((f) => f._id === uploaded.id)),
          );
          if (matches.length !== 1)
            throw new ConflictError(`media confirmation ${filename} cannot be reconciled uniquely`);
          return messageData(matches[0] as Bag, spec, item.key, item.author, 'file');
        },
      );
    } else {
      const mid = receipt.identifier(key);
      const payload: Bag = {
        _id: mid,
        rid: room.rid,
        msg: item.text,
        ...(parent === '' ? {} : { tmid: parent }),
      };
      message = await step(
        key,
        { id: mid, rid: room.rid, userId: auth.userId, text: item.text, tmid: parent },
        async () => {
          const posted = map(
            (await client.post('/api/v1/chat.sendMessage', headers, { message: payload })).message,
          );
          if (id(posted._id) === '') throw new ConflictError('message returned no identity');
          if (receipt.persistent && posted._id !== mid)
            throw new ConflictError('server did not preserve the supplied message identity');
          return messageData(posted, spec, item.key, item.author, item.kind);
        },
        async (intent) => {
          let found: Bag | null;
          try {
            const type = roomType(spec);
            found = await client.pendingMessage(
              mid,
              room.rid,
              type === 'd' ? 'im' : type === 'p' ? 'groups' : 'channels',
              headers,
            );
          } catch (error) {
            if (
              error instanceof ApiRejected &&
              [400, 404].includes(error.status) &&
              [
                'error-invalid-message',
                'error-message-not-found',
                'error-invalid-message-id',
              ].includes(error.errorType)
            )
              return null;
            throw new ConflictError(`message ${mid} could not be reconciled`);
          }
          if (found === null) return null;
          if (
            id(found._id) !== mid ||
            found.rid !== intent.rid ||
            id(map(found.u)._id) !== intent.userId ||
            id(found.tmid) !== intent.tmid ||
            ![intent.text, item.editedText].includes(found.msg)
          )
            throw new ConflictError(`message ${mid} differs from its pending intent`);
          return messageData(found, spec, item.key, item.author, item.kind);
        },
      );
    }
    if (id(message.id) === '') throw new CreateFailedError('captured message has no identity');
    timings.add(Date.now() - t0);
    if (item.kind === 'main') {
      room.messages += 1;
      room.messageIds.push(id(message.id));
    }
    if (item.kind === 'reply') room.replies += 1;
    for (let i = 0; i < item.reactions.length; i += 1) {
      const reaction = item.reactions[i] as { author: string; emoji: string };
      await mutation(
        `react:${spec.name}:${item.key}:${i}`,
        '/api/v1/chat.react',
        authHeaders(actor(reaction.author)),
        { messageId: message.id, emoji: reaction.emoji, shouldReact: true },
      );
      room.reactions += 1;
    }
    if (item.pin)
      await mutation(`pin:${spec.name}:${item.key}`, '/api/v1/chat.pinMessage', adminHdr, {
        messageId: message.id,
      });
    if (item.star !== '')
      await mutation(
        `star:${spec.name}:${item.key}`,
        '/api/v1/chat.starMessage',
        authHeaders(actor(item.star)),
        { messageId: message.id },
      );
    if (item.editedText !== '')
      await mutation(`edit:${spec.name}:${item.key}`, '/api/v1/chat.update', headers, {
        roomId: room.rid,
        msgId: message.id,
        text: item.editedText,
      });
  };
  try {
    for (const spec of plan.rooms) {
      const room = makeMade(spec);
      made.set(spec.name, room);
      try {
        const created = await step(
          `room:${spec.name}`,
          { name: spec.name, kind: spec.kind, marker: marker(spec) },
          async () => await createRoom(spec),
          async () => {
            if ([DM, GROUP_DM, GENERAL].includes(spec.kind)) return await createRoom(spec);
            const owned = receipt.owned.get(`room:${spec.name}`);
            if (owned !== undefined) {
              let found: Bag | null = null;
              try {
                found = await readRoom(id(owned.rid));
              } catch (error) {
                if (!(error instanceof ApiRejected && [400, 404].includes(error.status)))
                  throw error;
              }
              if (found !== null) {
                if (
                  found._id !== owned.rid ||
                  found.t !== owned.type ||
                  (found.name !== spec.name && found.fname !== spec.name)
                )
                  throw new ConflictError(`pending owned room ${spec.name} changed identity`);
                return await createRoom(spec);
              }
            }
            if (spec.kind === DISCUSSION || [TEAM, TEAM_PRIVATE].includes(spec.kind)) {
              if (legacyRooms.size > 0) return await createRoom(spec, true);
              throw new ConflictError(
                `pending ${spec.kind} ${spec.name} has no committed identity`,
              );
            }
            const found = await existingChannel(spec);
            if (found === null) return null;
            if (legacyRooms.has(id(found._id))) return await createRoom(spec, true);
            // Top-level is where builds before the customFields move left it.
            const proof = map(map(found.customFields).houstonSeed ?? found.houstonSeed);
            if (proof.run !== receipt.manifest.run || proof.key !== spec.name)
              throw new ConflictError(`pending room ${spec.name} cannot be identified`);
            return {
              rid: id(found._id),
              type: id(found.t),
              teamId: id(found.teamId),
              reused: false,
            };
          },
        );
        room.rid = id(created.rid);
        room.teamId = id(created.teamId);
        room.reused = created.reused === true;
        if (room.rid === '') throw new CreateFailedError('room has no identity');
        if ([READ_ONLY, ARCHIVED, PERMISSIONS].includes(spec.kind)) {
          stateRooms.push(room);
          await forceState(room, true);
        }
        if (room.teamId !== '' && spec.kind !== DISCUSSION)
          await mutation(`members:team:${spec.name}`, '/api/v1/teams.addMembers', adminHdr, {
            teamId: room.teamId,
            members: spec.members.map((n) => ({ userId: userIds.get(n) })),
          });
        if (![DM, GROUP_DM].includes(spec.kind) && spec.members.length > 0) {
          const path = `/api/v1/${id(created.type) === 'p' ? 'groups' : 'channels'}.invite`;
          // One user per call: from 8.8.0 channels.invite takes `userId` and refuses `userIds`.
          // Inviting a member again is a no-op, so a reconcile repeats the whole list.
          const invite = async (): Promise<Bag> => {
            for (const member of spec.members) {
              const userId = userIds.get(member);
              if (userId !== undefined)
                await client.post(path, adminHdr, { roomId: room.rid, userId });
            }
            return { userId: adminHdr['X-User-Id'] ?? '' };
          };
          await step(
            `members:room:${spec.name}`,
            { path, userId: adminHdr['X-User-Id'] ?? '' },
            invite,
            invite,
          );
        }
        if (spec.kind === PERMISSIONS) {
          const roles = list(
            (await client.get('/api/v1/groups.roles', adminHdr, { roomId: room.rid })).roles,
          );
          for (const [name, role, path] of [
            ['alice', 'owner', 'groups.addOwner'],
            ['bob', 'moderator', 'groups.addModerator'],
          ] as const) {
            const key = `roles:${name}`;
            if (
              roles.some(
                (r) =>
                  map(r.u)._id === userIds.get(name) &&
                  Array.isArray(r.roles) &&
                  r.roles.includes(role),
              )
            )
              receipt.record(key, 'done', { userId: userIds.get(name), role });
            else
              await mutation(key, `/api/v1/${path}`, adminHdr, {
                roomId: room.rid,
                userId: userIds.get(name),
              });
          }
        }
        if (![DM, GROUP_DM, DISCUSSION].includes(spec.kind) && receipt.persistent) {
          const current = await readRoom(room.rid);
          const settings: Bag = { rid: room.rid };
          if (id(current.topic) === '') settings.roomTopic = `INC-4821 · ${spec.name}`;
          if (id(current.description) === '')
            settings.roomDescription = `Sample ${spec.kind} for support, deployment, and incident reproduction.`;
          if (id(current.announcement) === '')
            settings.roomAnnouncement = 'Review INC-4821 evidence and pinned checkpoints.';
          if (Object.keys(settings).length > 1)
            await mutation(
              `metadata:${spec.name}`,
              '/api/v1/rooms.saveRoomSettings',
              adminHdr,
              settings,
            );
        }
        if (spec.kind === DISCUSSION && !room.reused && receipt.persistent) {
          const capture = async (): Promise<Bag> => {
            const api = id(created.type) === 'p' ? 'groups' : 'channels';
            const opening = await client.pages(`/api/v1/${api}.messages`, adminHdr, 'messages', {
              roomId: room.rid,
            });
            const ownOpening = opening.filter(
              (m) =>
                wording.isContent(m) &&
                id(map(m.u)._id) === admin.userId &&
                id(created.anchor) !== '' &&
                (m.msg === `INC-4821 discussion opening: ${spec.name}` ||
                  (m.msg === '' &&
                    list(m.attachments).some((a) => {
                      const link = /(?:[?&])msg=([^&]+)/u.exec(id(a.message_link));
                      return (
                        link !== null && decodeURIComponent(link[1] as string) === created.anchor
                      );
                    }))),
            );
            const expected = id(created.anchor) === '' ? 0 : 2;
            if (ownOpening.length !== expected)
              throw new CreateFailedError('discussion opening readback is incomplete or ambiguous');
            for (const m of ownOpening)
              receipt.record(
                `opening:${spec.name}:${id(m._id)}`,
                'done',
                messageData(m, spec, 'opening', '', 'opening'),
              );
            const parent = made.get(spec.parent) as Made;
            const parentType = id(receipt.done(`room:${parent.spec.name}`)?.type);
            const notices = await client.pages(
              `/api/v1/${parentType === 'p' ? 'groups' : 'channels'}.messages`,
              adminHdr,
              'messages',
              { roomId: parent.rid },
            );
            for (const m of notices.filter((n) => n.drid === room.rid))
              receipt.record(
                `notice:${spec.name}:${id(m._id)}`,
                'done',
                messageData(m, parent.spec, 'notice', '', 'notice'),
              );
            return { count: ownOpening.length };
          };
          await receipt.step(
            `capture-openings:${spec.name}`,
            { rid: room.rid, anchor: created.anchor ?? '' },
            capture,
            capture,
          );
        }
        for (const item of spec.content) await content(room, item);
        if (spec.content.length === 0 && spec.messages > 0)
          throw new CreateFailedError('room has no explicit content manifest');
        log(
          `  ${spec.name}: ${room.messages} messages, ${room.replies} replies${room.reused ? ' (reused)' : ''}`,
        );
      } catch (error) {
        if (
          error instanceof ConflictError ||
          error instanceof Interrupted ||
          error instanceof ReceiptStorageError
        )
          throw error;
        room.failed = error instanceof Error ? error.message : String(error);
        log(`  ⚠ ${spec.name}: ${room.failed}`);
      }
    }
  } finally {
    await cleanup(async () => {
      const failures: unknown[] = [];
      for (const room of stateRooms)
        if (room.rid !== '')
          try {
            await forceState(room, false);
          } catch (error) {
            failures.push(error);
          }
      if (failures.length > 0) throw failures[0];
    });
  }
  return { made, names, durations, timings, usersFailed };
}
