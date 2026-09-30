import type * as ApplyNS from '../../src/seed/apply';
import { planFrom } from '../../src/seed/plan';

const AUTH = { token: 't', userId: 'u' };
const TWOFA = 'Accounts_TwoFactorAuthentication_By_Email_Enabled';
const LIMITER = 'API_Enable_Rate_Limiter';

/** One fake Rocket.Chat, recording what it was asked. */
interface Fake {
  readonly calls: [string, string, string][];
  readonly settings: [string, unknown][];
  readonly notes: string[];
}

function load(
  answers: {
    settings?: Record<string, unknown>;
    setOk?: (sid: string) => boolean;
    reply?: (method: string, path: string, payload: Record<string, unknown>) => unknown;
  } = {},
): { mod: typeof ApplyNS; fake: Fake } {
  jest.resetModules();
  const fake: Fake = { calls: [], settings: [], notes: [] };
  let nextId = 0;
  jest.doMock('../../src/core/rcapi', () => ({
    RequestFailed: class RequestFailed extends Error {},
    authHeaders: (a: { token: string; userId: string }) => ({
      'X-Auth-Token': a.token,
      'X-User-Id': a.userId,
    }),
    login: () => Promise.reject(new Error('no server')),
    getSetting: (_u: string, _a: unknown, _p: string, sid: string) =>
      Promise.resolve((answers.settings ?? {})[sid] ?? null),
    setSetting: (_u: string, _a: unknown, _p: string, sid: string, value: unknown) => {
      fake.settings.push([sid, value]);
      return Promise.resolve(answers.setOk === undefined ? true : answers.setOk(sid));
    },
    rcapi: {
      call: (_root: string, method: string, path: string, opts: Record<string, unknown>) => {
        fake.calls.push([method, path, JSON.stringify(opts.data ?? opts.params ?? {})]);
        nextId += 1;
        const body =
          answers.reply?.(method, path, (opts.data ?? {}) as Record<string, unknown>) ??
          defaultReply(path, `id${String(nextId)}`);
        return Promise.resolve([200, JSON.stringify(body)] as [number, string]);
      },
    },
  }));
  jest.doMock('../../src/core/journal', () => ({
    RATE_LIMITER_OFF: 'rate_limiter_off',
    EMAIL_2FA_OFF: 'email_2fa_off',
    record: (kind: string, workspace: string) => {
      fake.notes.push(`+${kind}:${workspace}`);
      return `${kind}-1`;
    },
    clear: (id: string) => {
      fake.notes.push(`-${id}`);
    },
  }));
  return { mod: require('../../src/seed/apply') as typeof ApplyNS, fake };
}

function defaultReply(path: string, id: string): Record<string, unknown> {
  if (path.includes('teams.create')) return { team: { _id: `team-${id}`, roomId: id } };
  if (path.includes('groups.create') || path.includes('groups.info')) return { group: { _id: id } };
  if (path.includes('createDiscussion')) return { discussion: { _id: id } };
  if (path.includes('im.create')) return { room: { _id: id } };
  if (path.includes('sendMessage')) return { message: { _id: id } };
  return { channel: { _id: id } };
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
    expect(fake.notes).toEqual([
      '+rate_limiter_off:TICKET-1',
      '+email_2fa_off:TICKET-1',
      '-rate_limiter_off-1',
      '-email_2fa_off-1',
    ]);
  });

  it('withdraws the note when the disable it recorded did not take', async () => {
    // A note for a change that never happened is a recovery that would turn a setting ON
    // that the workspace had deliberately off.
    const { mod, fake } = load({
      settings: { [TWOFA]: false, [LIMITER]: true },
      setOk: (sid) => sid !== LIMITER,
    });
    const said: string[] = [];
    await mod.seed('http://x', AUTH, planFrom('small', { users: 0, channels: 0, messages: 0 }), {
      workspace: 'TICKET-1',
      log: (m) => said.push(m),
    });
    expect(fake.notes).toEqual(['+rate_limiter_off:TICKET-1', '-rate_limiter_off-1']);
    expect(said.join(' ')).toContain('could not disable the API rate limiter');
  });

  it('says so when it could not read or disable email-2FA', async () => {
    for (const [settings, fragment] of [
      [{ [TWOFA]: null, [LIMITER]: false }, 'could not read the email-2FA setting'],
      [{ [TWOFA]: true, [LIMITER]: false }, 'could not disable email-2FA'],
    ] as const) {
      const { mod } = load({ settings, setOk: (sid) => sid !== TWOFA });
      const said: string[] = [];
      await mod.seed('http://x', AUTH, planFrom('small', { users: 0, channels: 0, messages: 0 }), {
        log: (m) => said.push(m),
      });
      expect(said.join(' ')).toContain(fragment);
      // Both warnings carry the consequence, which is what a reader needs.
      expect(said.join(' ')).toContain('authored by admin');
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
    expect(paths).toContain('/api/v1/im.create');
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
      login: () => Promise.reject(new Error('no server')),
      getSetting: () => Promise.resolve(false),
      setSetting: () => Promise.resolve(true),
      rcapi: {
        call: (_r: string, _m: string, path: string) => {
          fake.calls.push(path);
          if (path.includes('im.create')) return Promise.resolve([403, '{}'] as [number, string]);
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
    const result = (await mod2.seed('http://x', AUTH, planFrom('small'))) as Record<
      string,
      unknown
    >;
    expect(result.dms).toBe(0);
    const failures = result.failed as { name: string; why: string }[];
    expect(failures.every((f) => f.why === 'im.create')).toBe(true);
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
      login: () => Promise.reject(new Error('no server')),
      getSetting: () => Promise.resolve(false),
      setSetting: () => Promise.resolve(true),
      rcapi: {
        call: (_r: string, method: string, path: string) => {
          if (method === 'POST' && /(channels|groups)\.create/u.test(path)) {
            return Promise.resolve([400, '{"error":"name-already-exists"}'] as [number, string]);
          }
          return Promise.resolve([200, JSON.stringify(defaultReply(path, 'existing'))] as [
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
    const result = (await mod2.seed('http://x', AUTH, planFrom('small'))) as Record<
      string,
      unknown
    >;
    expect(result.reused as number).toBeGreaterThan(0);
    expect(result.failed).toEqual([]);
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
    expect(Object.keys(result.durations).sort()).toEqual(['channels', 'dms', 'messages', 'users']);
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

  it('reacts exactly where the manifest says, once per planned index', async () => {
    // Reactions lived in the posting loop as `i % 3 == 0`, so nothing could say how many
    // there should be and nothing checked how many there were.
    const { mod, fake } = load({ settings: quiet });
    const plan = planFrom('standard', { users: 2, channels: 1, messages: 6 });
    await mod.seed('http://x', AUTH, plan);
    const reacts = fake.calls
      .filter(([, p]) => p.endsWith('chat.react'))
      .map(([, , body]) => JSON.parse(body) as Record<string, unknown>);
    expect(reacts.length).toBeGreaterThan(0);
    for (const body of reacts) expect(Object.keys(body).sort()).toEqual(['emoji', 'messageId']);
    expect(reacts).toHaveLength(plan.rooms.reduce((sum, r) => sum + r.reactions.length, 0));
  });
});
