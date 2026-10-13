import type * as JournalNS from '../../src/core/journal';
import type * as ApplyNS from '../../src/seed/apply';
import { type Plan, planFrom } from '../../src/seed/plan';

const AUTH = { token: 't', userId: 'u' };
const TWOFA = 'Accounts_TwoFactorAuthentication_By_Email_Enabled';
const LIMITER = 'API_Enable_Rate_Limiter';
const participantLogin = async (_root: string, who: { user: string }) => ({
  token: `t-${who.user}`,
  userId: `u-${who.user}`,
});

/** One fake Rocket.Chat, recording what it was asked. */
interface Fake {
  readonly calls: [string, string, string][];
  readonly settings: [string, unknown][];
  readonly notes: string[];
  /** Each note as recovery would describe it, at `T`. */
  readonly described: string[];
  readonly emojis: Record<string, unknown>[];
}

function load(
  answers: {
    settings?: Record<string, unknown>;
    setOk?: (sid: string, value: unknown) => boolean;
    reply?: (method: string, path: string, payload: Record<string, unknown>) => unknown;
  } = {},
): { mod: typeof ApplyNS; fake: Fake } {
  jest.resetModules();
  const fake: Fake = { calls: [], settings: [], notes: [], described: [], emojis: [] };
  let nextId = 0;
  jest.doMock('../../src/core/rcapi', () => ({
    RequestFailed: class RequestFailed extends Error {},
    authHeaders: (a: { token: string; userId: string }) => ({
      'X-Auth-Token': a.token,
      'X-User-Id': a.userId,
    }),
    login: participantLogin,
    getSetting: (_u: string, _a: unknown, _p: string, sid: string) =>
      Promise.resolve((answers.settings ?? {})[sid] ?? null),
    setSetting: (_u: string, _a: unknown, _p: string, sid: string, value: unknown) => {
      fake.settings.push([sid, value]);
      return Promise.resolve(answers.setOk === undefined ? true : answers.setOk(sid, value));
    },
    rcapi: {
      multipart: (
        _root: string,
        requestPath: string,
        _headers: unknown,
        parts: { name: string; value: unknown }[],
      ) => {
        nextId += 1;
        const id = `id${String(nextId)}`;
        fake.calls.push(['POST', requestPath, '{}']);
        if (requestPath === '/api/v1/emoji-custom.create') {
          fake.emojis.push({
            _id: id,
            name: parts.find((p) => p.name === 'name')?.value,
            aliases: [parts.find((p) => p.name === 'aliases')?.value],
          });
        }
        return Promise.resolve([
          200,
          JSON.stringify({ success: true, file: { _id: id }, emoji: { _id: id } }),
        ]);
      },
      download: () =>
        Promise.resolve({
          status: 200,
          ok: true,
          text: '',
          bytes: Buffer.alloc(0),
          headers: {},
          url: 'http://x/file',
        }),
      call: (_root: string, method: string, path: string, opts: Record<string, unknown>) => {
        fake.calls.push([method, path, JSON.stringify(opts.data ?? opts.params ?? {})]);
        nextId += 1;
        const body =
          answers.reply?.(
            method,
            path,
            (opts.data ?? opts.params ?? {}) as Record<string, unknown>,
          ) ??
          (path === '/api/v1/emoji-custom.list'
            ? { success: true, emojis: { update: fake.emojis } }
            : undefined) ??
          defaultReply(
            path,
            `id${String(nextId)}`,
            (opts.data ?? opts.params ?? {}) as Record<string, unknown>,
          );
        const missing =
          method === 'GET' &&
          /\/(?:users|channels|groups)\.info$/u.test(path) &&
          (opts.params as Record<string, unknown>).roomName !== 'general';
        if (missing && answers.reply === undefined)
          return Promise.resolve([400, '{"success":false,"errorType":"error-room-not-found"}'] as [
            number,
            string,
          ]);
        return Promise.resolve([200, JSON.stringify(body)] as [number, string]);
      },
    },
  }));
  jest.doMock('../../src/core/journal', () => ({
    RATE_LIMITER_OFF: 'rate_limiter_off',
    EMAIL_2FA_OFF: 'email_2fa_off',
    E2EE_DEFAULT_OFF: 'e2ee_default_off',
    record: (kind: string, workspace: string, detail: { setting?: string } = {}) => {
      fake.notes.push(
        `+${kind}:${workspace}${detail.setting === undefined ? '' : `:${detail.setting}`}`,
      );
      const { describe } = jest.requireActual<typeof JournalNS>('../../src/core/journal');
      fake.described.push(
        describe({ id: 'i', kind, workspace, pid: 1, started: '', at: 'T', detail }),
      );
      return `${kind}-1`;
    },
    clear: (id: string) => {
      fake.notes.push(`-${id}`);
    },
  }));
  return { mod: require('../../src/seed/apply') as typeof ApplyNS, fake };
}

function defaultReply(
  path: string,
  id: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  if (path.includes('teams.create'))
    return { success: true, team: { _id: `team-${id}`, roomId: id } };
  if (path.includes('teams.info'))
    return { success: true, teamInfo: { _id: `team-${id}`, roomId: id, name: payload.teamName } };
  if (path.includes('groups.create') || path.includes('groups.info'))
    return { success: true, group: { _id: id, name: payload.name ?? payload.roomName, t: 'p' } };
  if (path.includes('createDiscussion'))
    return { success: true, discussion: { _id: id, prid: payload.prid, t: 'c' } };
  if (path.includes('rooms.getDiscussions'))
    return { success: true, discussions: [], count: 0, offset: 0, total: 0 };
  if (path.includes('getDiscussions'))
    return { success: true, messages: [], count: 0, offset: 0, total: 0 };
  if (/\/(?:im|dm)\.create$/u.test(path)) return { success: true, room: { _id: id, t: 'd' } };
  if (path.includes('sendMessage'))
    return {
      success: true,
      message: {
        ...(payload.message as Record<string, unknown>),
        _id: (payload.message as Record<string, unknown> | undefined)?._id ?? id,
      },
    };
  if (path.includes('/rooms.mediaConfirm/')) return { success: true, message: { _id: id } };
  if (path.includes('users.create') || path.includes('users.info'))
    return {
      success: true,
      user: {
        _id: `u-${String(payload.username)}`,
        username: payload.username,
        name: payload.username,
        bio: '',
      },
    };
  if (path.includes('listEmoji')) return { success: true, emojis: [] };
  if (path.includes('members')) return { success: true, members: [], total: 0 };
  return { success: true, channel: { _id: id, name: payload.name ?? payload.roomName, t: 'c' } };
}

function withoutAssets(plan: Plan): Plan {
  return {
    ...plan,
    customEmoji: [],
    rooms: plan.rooms.map((room) => ({
      ...room,
      files: [],
      content: room.content.filter((m) => m.kind !== 'file'),
    })),
  };
}

describe('the settings a seed turns off', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it.each([
    ['unreadable', null, []],
    ['already off', false, []],
    ['on', true, [true, false]],
  ] as const)('restores only the 2FA value it changed (%s)', async (_label, prior, expected) => {
    // "Unreadable" is not "was on". Restoring ON for both turned email-2FA on for the
    // ldap/saml/oidc/livechat presets, which switch it OFF on purpose -- and a single
    // transient 500 is likely, because seeding starts the moment RC answers.
    const { mod, fake } = load({ settings: { [TWOFA]: prior, [LIMITER]: false } });
    await mod.seed('http://x', AUTH, planFrom('small', { users: 0, channels: 0, messages: 0 }));
    const touched = fake.settings.filter(([sid]) => sid === TWOFA).map(([, v]) => v);
    // `on` disables then restores; the other two never touch it at all.
    expect(touched).toEqual(expected.length === 0 ? [] : [false, true]);
  });

  it('leaves the rate limiter alone unless it was observably on', async () => {
    for (const prior of [null, false]) {
      const { mod, fake } = load({ settings: { [TWOFA]: false, [LIMITER]: prior } });
      await mod.seed('http://x', AUTH, planFrom('small', { users: 0, channels: 0, messages: 0 }));
      expect(fake.settings.filter(([sid]) => sid === LIMITER)).toEqual([]);
    }
  });

  it('journals both, because the finally is the block a SIGKILL does not run', async () => {
    const { mod, fake } = load({ settings: { [TWOFA]: true, [LIMITER]: true } });
    await mod.seed('http://x', AUTH, planFrom('small', { users: 0, channels: 0, messages: 0 }), {
      workspace: 'TICKET-1',
    });
    expect(fake.notes).toEqual(
      expect.arrayContaining([
        '+rate_limiter_off:TICKET-1',
        '+email_2fa_off:TICKET-1',
        '-rate_limiter_off-1',
        '-email_2fa_off-1',
      ]),
    );
    expect(fake.notes).toHaveLength(4);
  });

  it('says a seed turned the rate limiter off, in the line recovery prints', async () => {
    // serve's recovery said "turned off for a performance run" about a seed's note.
    const { mod, fake } = load({ settings: { [TWOFA]: false, [LIMITER]: true } });
    await mod.seed('http://x', AUTH, planFrom('small', { users: 0, channels: 0, messages: 0 }), {
      workspace: 'TICKET-1',
    });
    expect(fake.described).toEqual([
      "'TICKET-1': the API rate limiter was turned off for a seed at T and never turned back on",
    ]);
  });

  it('restores a setting after its disable took effect but returned no confirmation', async () => {
    let limiterOn = true;
    const { mod, fake } = load({
      settings: { [TWOFA]: false, [LIMITER]: true },
      setOk: (sid, value) => {
        if (sid !== LIMITER) return true;
        limiterOn = value === true;
        return value === true;
      },
    });
    const said: string[] = [];
    await mod.seed('http://x', AUTH, planFrom('small', { users: 0, channels: 0, messages: 0 }), {
      workspace: 'TICKET-1',
      log: (m) => said.push(m),
    });
    expect(limiterOn).toBe(true);
    expect(fake.settings.filter(([sid]) => sid === LIMITER)).toEqual([
      [LIMITER, false],
      [LIMITER, true],
    ]);
    expect(fake.notes).toEqual(['+rate_limiter_off:TICKET-1', '-rate_limiter_off-1']);
    expect(said.join(' ')).toMatch(
      /could not (?:disable|confirm disabling) (?:the API rate limiter|API_Enable_Rate_Limiter)/u,
    );
  });

  it('restores the second setting when restoration of the first setting fails', async () => {
    const { mod, fake } = load({
      settings: { [TWOFA]: true, [LIMITER]: true },
      setOk: (sid, value) => sid !== TWOFA || value === false,
    });
    await expect(
      mod.seed('http://x', AUTH, planFrom('small', { users: 0, channels: 0, messages: 0 }), {
        workspace: 'TICKET-1',
      }),
    ).rejects.toThrow(/could not restore Accounts_TwoFactorAuthentication_By_Email_Enabled/u);
    expect(fake.settings).toEqual([
      [TWOFA, false],
      [LIMITER, false],
      [TWOFA, true],
      [LIMITER, true],
    ]);
    expect(fake.notes).toEqual(
      expect.arrayContaining([
        '+email_2fa_off:TICKET-1',
        '+rate_limiter_off:TICKET-1',
        '-rate_limiter_off-1',
      ]),
    );
    expect(fake.notes).not.toContain('-email_2fa_off-1');
  });

  it('says so when it could not read or disable email-2FA', async () => {
    for (const [settings, fragment] of [
      [
        { [TWOFA]: null, [LIMITER]: false },
        /could not read (?:the email-2FA setting|Accounts_TwoFactorAuthentication_By_Email_Enabled)/u,
      ],
      [
        { [TWOFA]: true, [LIMITER]: false },
        /could not (?:disable|confirm disabling) (?:email-2FA|Accounts_TwoFactorAuthentication_By_Email_Enabled)/u,
      ],
    ] as const) {
      const { mod } = load({ settings, setOk: (sid, value) => sid !== TWOFA || value === true });
      const said: string[] = [];
      await mod.seed('http://x', AUTH, planFrom('small', { users: 0, channels: 0, messages: 0 }), {
        log: (m) => said.push(m),
      });
      expect(said.join(' ')).toMatch(fragment);
    }
  });
});

describe('what a seed creates', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('makes every room the plan names, and reports the counts', async () => {
    const { mod, fake } = load({ settings: { [TWOFA]: false, [LIMITER]: false } });
    const plan = planFrom('small');
    const result = (await mod.seed('http://x', AUTH, plan)) as Record<string, unknown>;
    expect(result.rooms_total).toBe(plan.rooms.length);
    expect(result.failed).toEqual([]);
    // A team is created through teams.create and a private room through groups.create;
    // using channels.create for either produces a different object entirely.
    const paths = fake.calls.map(([, p]) => p);
    expect(paths).toContain('/api/v1/teams.create');
    expect(paths).toContain('/api/v1/groups.create');
    expect(paths).toContain('/api/v1/rooms.createDiscussion');
    expect(paths.some((p) => /\/(?:im|dm)\.create$/u.test(p))).toBe(true);
  });

  it('creates discussions LAST, so the ones anchored to a message have one', async () => {
    // The `pmid` branch was dead code: discussions were created before their parents had
    // posted anything, so every discussion came out attached to the room instead.
    const { mod, fake } = load({ settings: { [TWOFA]: false, [LIMITER]: false } });
    await mod.seed('http://x', AUTH, planFrom('small'));
    const firstDiscussion = fake.calls.findIndex(([, p]) => p.includes('createDiscussion'));
    const lastMessage = fake.calls.map(([, p]) => p).lastIndexOf('/api/v1/chat.sendMessage');
    expect(firstDiscussion).toBeGreaterThan(0);
    const anchored = fake.calls.filter(
      ([, p, body]) => p.includes('createDiscussion') && body.includes('"pmid"'),
    );
    expect(anchored.length).toBeGreaterThan(0);
    expect(lastMessage).toBeGreaterThan(firstDiscussion);
  });

  it('does not count a DM the server refused', async () => {
    // `post()` answers null only on a TRANSPORT error, so a 400/403 still counted as a DM
    // and still fired a doomed postMessage -- and the count landed in the performance
    // report as workload that was never created.
    jest.resetModules();
    const fake: { calls: string[] } = { calls: [] };
    jest.doMock('../../src/core/rcapi', () => ({
      RequestFailed: class RequestFailed extends Error {},
      authHeaders: () => ({}),
      login: participantLogin,
      getSetting: () => Promise.resolve(false),
      setSetting: () => Promise.resolve(true),
      rcapi: {
        call: (_r: string, _m: string, path: string) => {
          fake.calls.push(path);
          if (/\/(?:im|dm)\.create$/u.test(path))
            return Promise.resolve([403, '{}'] as [number, string]);
          return Promise.resolve([200, JSON.stringify(defaultReply(path, 'id1'))] as [
            number,
            string,
          ]);
        },
      },
    }));
    jest.doMock('../../src/core/journal', () => ({
      RATE_LIMITER_OFF: 'r',
      EMAIL_2FA_OFF: 'e',
      record: () => 'n',
      clear: () => undefined,
    }));
    const mod2 = require('../../src/seed/apply') as typeof ApplyNS;
    const result = (await mod2.seed('http://x', AUTH, withoutAssets(planFrom('small')))) as Record<
      string,
      unknown
    >;
    expect(result.dms).toBe(0);
    const failures = result.failed as { name: string; why: string }[];
    expect(failures.every((f) => /(?:im|dm)\.create/u.test(f.why))).toBe(true);
    expect(failures.length).toBeGreaterThan(0);
  });

  it('reuses a room it could not create rather than abandoning it', async () => {
    // A second `houston seed` used to abandon a private group it had not created this run.
    // With a deterministic manifest the membership is the same every run, so the room can
    // simply be reused -- and the readback reports the totals.
    jest.resetModules();
    jest.doMock('../../src/core/rcapi', () => ({
      RequestFailed: class RequestFailed extends Error {},
      authHeaders: () => ({}),
      login: participantLogin,
      getSetting: () => Promise.resolve(false),
      setSetting: () => Promise.resolve(true),
      rcapi: {
        call: (_r: string, method: string, path: string, opts: Record<string, unknown>) => {
          if (method === 'POST' && /(channels|groups)\.create/u.test(path)) {
            return Promise.resolve([400, '{"error":"name-already-exists"}'] as [number, string]);
          }
          return Promise.resolve([
            200,
            JSON.stringify(
              defaultReply(
                path,
                'existing',
                (opts.data ?? opts.params ?? {}) as Record<string, unknown>,
              ),
            ),
          ] as [number, string]);
        },
      },
    }));
    jest.doMock('../../src/core/journal', () => ({
      RATE_LIMITER_OFF: 'r',
      EMAIL_2FA_OFF: 'e',
      record: () => 'n',
      clear: () => undefined,
    }));
    const mod2 = require('../../src/seed/apply') as typeof ApplyNS;
    const result = (await mod2.seed('http://x', AUTH, withoutAssets(planFrom('small')))) as Record<
      string,
      unknown
    >;
    expect(result.reused as number).toBeGreaterThan(0);
    expect(result.failed).toEqual([]);
  });

  it("invites a reused private room's planned members, so their posts are not refused", async () => {
    // The plan picks a room's authors from the profile's user count, so a private room an
    // earlier `small` seed made held `small`'s members, and a `standard` seed's authors got
    // `error-not-allowed` -- dropped silently, with their reactions, and the job said Done.
    jest.resetModules();
    const posted: [string, string][] = [];
    jest.doMock('../../src/core/rcapi', () => ({
      RequestFailed: class RequestFailed extends Error {},
      authHeaders: () => ({}),
      login: participantLogin,
      getSetting: () => Promise.resolve(false),
      setSetting: () => Promise.resolve(true),
      rcapi: {
        call: (_r: string, method: string, path: string, opts: Record<string, unknown>) => {
          if (method === 'POST') posted.push([path, JSON.stringify(opts.data ?? {})]);
          if (method === 'POST' && /(channels|groups|teams)\.create/u.test(path)) {
            return Promise.resolve([400, '{"error":"name-already-exists"}'] as [number, string]);
          }
          return Promise.resolve([
            200,
            JSON.stringify(
              defaultReply(
                path,
                'existing',
                (opts.data ?? opts.params ?? {}) as Record<string, unknown>,
              ),
            ),
          ] as [number, string]);
        },
      },
    }));
    jest.doMock('../../src/core/journal', () => ({
      RATE_LIMITER_OFF: 'r',
      EMAIL_2FA_OFF: 'e',
      record: () => 'n',
      clear: () => undefined,
    }));
    const mod2 = require('../../src/seed/apply') as typeof ApplyNS;
    const { isPrivate } = require('../../src/seed/plan') as { isPrivate: (spec: never) => boolean };
    const plan = withoutAssets(planFrom('small'));
    await mod2.seed('http://x', AUTH, plan, {
      login: async (_root: string, who: { user: string }) => ({
        token: `t-${who.user}`,
        userId: `u-${who.user}`,
      }),
    } as never);
    const room = plan.rooms.find(
      (spec) => isPrivate(spec as never) && spec.members.some((m) => m !== 'admin'),
    );
    expect(room).toBeDefined();
    const invited = posted
      .filter(([path]) => path === '/api/v1/groups.invite')
      .flatMap(([, body]) => {
        const parsed = JSON.parse(body) as { userId?: string; userIds?: string[] };
        return parsed.userIds ?? [parsed.userId];
      });
    for (const member of (room?.members ?? []).filter((m) => m !== 'admin')) {
      expect(invited).toContain(`u-${member}`);
    }
  });

  it('reports a body that is not JSON as an empty one, rather than aborting', async () => {
    // Traefik fronts the multi-instance preset and can answer 200 with an HTML error page;
    // a raw parse error there would abort the entire seed mid-way.
    const { mod } = load({});
    expect(mod.json(null)).toEqual({});
    expect(mod.json({ status: 200, ok: true, text: '<html>nope</html>' })).toEqual({});
    // An empty answer falls back to `{}`: a non-empty list comes straight back, and an
    // empty one collapses -- the rule is emptiness, as earlier releases had it, not a type
    // check.
    expect(mod.json({ status: 200, ok: true, text: '[1,2]' })).toEqual([1, 2]);
    expect(mod.json({ status: 200, ok: true, text: '[]' })).toEqual({});
    expect(mod.json({ status: 200, ok: true, text: '{}' })).toEqual({});
    expect(mod.messageId({ status: 200, ok: true, text: '{"message":{"_id":"m1"}}' })).toBe('m1');
    expect(mod.messageId({ status: 200, ok: true, text: '{}' })).toBeNull();
  });
});

describe('what a seed posts', () => {
  afterEach(() => {
    jest.resetModules();
  });

  const quiet = { [TWOFA]: false, [LIMITER]: false };

  it('times every phase and collects the message latency', async () => {
    const { mod } = load({ settings: quiet });
    const result = (await mod.seed(
      'http://x',
      AUTH,
      planFrom('small', { users: 2, channels: 1, messages: 3 }),
    )) as { durations: Record<string, number>; latency: { count: number } };
    expect(Object.keys(result.durations)).toEqual(
      expect.arrayContaining(['channels', 'dms', 'messages', 'users']),
    );
    expect(result.latency.count).toBeGreaterThanOrEqual(1);
  });

  it('posts a thread reply the only way that creates a thread', async () => {
    // `chat.postMessage` with a `tmid` answers 400, so every reply was silently lost and no
    // thread was ever created while `rich` profiles advertised threads. Asserted on the CALL
    // SHAPE, because that is what was wrong.
    const { mod, fake } = load({ settings: quiet });
    await mod.seed('http://x', AUTH, planFrom('small', { users: 2, channels: 1, messages: 5 }));
    const threaded = fake.calls
      .filter(([, p]) => p.endsWith('chat.sendMessage'))
      .map(([, , body]) => JSON.parse(body) as { message?: { rid?: string; tmid?: string } })
      .filter((body) => body.message?.tmid !== undefined);
    expect(threaded.length).toBeGreaterThan(0);
    for (const body of threaded) expect(body.message?.rid).toEqual(expect.any(String));
    expect(fake.calls.filter(([, p]) => p.endsWith('chat.postMessage'))).toEqual([]);
  });

  it('reacts with every actor and emoji the manifest names, explicitly enabling each action', async () => {
    // Reactions lived in the posting loop as `i % 3 == 0`, so nothing could say how many
    // there should be and nothing checked how many there were.
    const { mod, fake } = load({ settings: quiet });
    const plan = planFrom('standard', { users: 2, channels: 1, messages: 6 });
    await mod.seed('http://x', AUTH, plan);
    const reacts = fake.calls
      .filter(([, p]) => p.endsWith('chat.react'))
      .map(([, , body]) => JSON.parse(body) as Record<string, unknown>);
    expect(reacts.length).toBeGreaterThan(0);
    for (const body of reacts)
      expect(body).toEqual(
        expect.objectContaining({
          emoji: expect.any(String),
          messageId: expect.any(String),
          shouldReact: true,
        }),
      );
    expect(reacts).toHaveLength(
      plan.rooms.flatMap((r) => r.content).reduce((sum, m) => sum + m.reactions.length, 0),
    );
  });
});

describe('the encryption defaults a seed holds off', () => {
  afterEach(() => {
    jest.resetModules();
  });

  const DM = 'E2E_Enabled_Default_DirectRooms';
  const PRIVATE = 'E2E_Enabled_Default_PrivateRooms';
  const FORCE = 'E2E_Force_Encryption_For_Private_Rooms';

  it('turns each that is on off before any room is made, and puts it back', async () => {
    // On, Rocket.Chat creates the seeder's DMs and private rooms encrypted and refuses its
    // plaintext in them (error-not-allowed): the seed left those rooms empty and exited 2.
    let atFirstRequest: [string, unknown][] | null = null;
    const loaded = load({
      settings: { [TWOFA]: false, [LIMITER]: false, [DM]: true, [PRIVATE]: true, [FORCE]: true },
      reply: () => {
        atFirstRequest ??= [...loaded.fake.settings];
        return undefined;
      },
    });
    const { mod, fake } = loaded;
    await mod.seed('http://x', AUTH, withoutAssets(planFrom('small', { users: 2 })), {
      workspace: 'TICKET-1',
      login: participantLogin,
    });
    expect(atFirstRequest).toEqual([
      [DM, false],
      [PRIVATE, false],
      [FORCE, false],
    ]);
    expect(fake.settings.slice(3)).toEqual([
      [DM, true],
      [PRIVATE, true],
      [FORCE, true],
    ]);
    // Journalled one note each, naming the setting, because a SIGKILL skips the restore.
    expect(fake.notes).toEqual([
      `+e2ee_default_off:TICKET-1:${DM}`,
      `+e2ee_default_off:TICKET-1:${PRIVATE}`,
      `+e2ee_default_off:TICKET-1:${FORCE}`,
      '-e2ee_default_off-1',
      '-e2ee_default_off-1',
      '-e2ee_default_off-1',
    ]);
  });

  it('leaves one that is off or absent alone, and says nothing about it', async () => {
    // Absent is ordinary: the force setting arrived in Rocket.Chat 8.8.0.
    const { mod, fake } = load({
      settings: { [TWOFA]: false, [LIMITER]: false, [DM]: false, [PRIVATE]: null, [FORCE]: null },
    });
    const said: string[] = [];
    await mod.seed('http://x', AUTH, planFrom('small', { users: 0, channels: 0, messages: 0 }), {
      log: (m) => said.push(m),
    });
    expect(fake.settings).toEqual([]);
    expect(said.join(' ')).not.toContain('E2E_');
  });
});
