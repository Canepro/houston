/**
 * The Rocket.Chat client: the login dance, the polls, and the calls that lie about failing.
 *
 * The seam has its own spec against a real socket. These cases are the domain on top of
 * it -- which failure is which, when a refusal is safer than a guess, and the three places
 * Rocket.Chat answers 200 for something that did not work.
 */
import { installAuditRecorder } from '../../src/lib/audit';
import { RequestFailed, rcHttp, type HttpResponse } from '../../src/seams/rc-http';

import {
  NotReady,
  addOauthService,
  apiInfo,
  authHeaders,
  call,
  createIncomingWebhook,
  extractOtp,
  fetchEmailOtp,
  fetchSamlIdpCert,
  generatePat,
  getSetting,
  login,
  methodSucceeded,
  newestMailStamp,
  otpRecipient,
  password2faHeaders,
  rcapi,
  releaseInfo,
  setSetting,
  settingIds,
  waitReady,
} from '../../src/core/rcapi';

const realRequest = rcHttp.request;

type Reply = Partial<HttpResponse> | Error;
type Rule = [(url: string, options: Record<string, unknown>) => boolean, Reply];

/** Every request the scripted seam saw. */
let seen: {
  url: string;
  method: string;
  headers: Record<string, string>;
  json: unknown;
  params?: Readonly<Record<string, string | number | boolean>>;
}[] = [];

function respond(reply: Partial<HttpResponse>, url: string): HttpResponse {
  const text = reply.text ?? '';
  const status = reply.status ?? 200;
  return {
    status,
    ok: reply.ok ?? status < 400,
    text,
    headers: reply.headers ?? {},
    url,
    json:
      reply.json ??
      (() => {
        return JSON.parse(text) as unknown;
      }),
  };
}

function script(rules: Rule[], fallback: Reply = { status: 200, text: '{}' }): void {
  seen = [];
  rcHttp.request = (url, options = {}) => {
    seen.push({
      url,
      method: String(options.method ?? 'GET'),
      headers: { ...options.headers },
      json: options.json,
      ...(options.params === undefined ? {} : { params: options.params }),
    });
    const hit = rules.find(([matches]) => matches(url, options as Record<string, unknown>));
    const reply = hit === undefined ? fallback : hit[1];
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(respond(reply, url));
  };
}

const at = (fragment: string) => (url: string) => url.includes(fragment);
const nowait = () => Promise.resolve();

afterEach(() => {
  rcHttp.request = realRequest;
});

describe('release metadata', () => {
  it('returns the live document and treats transport failure as an unavailable lookup', async () => {
    script([], { status: 200, text: '{"compatibleMongoVersions":["7.0"]}' });
    await expect(releaseInfo('https://releases.example/8.5.1/info')).resolves.toEqual(
      expect.objectContaining({ status: 200 }),
    );
    expect(seen[0]?.url).toBe('https://releases.example/8.5.1/info');
    script([], new RequestFailed('refused', 'https://releases.example'));
    await expect(releaseInfo('https://releases.example/8.5.1/info')).resolves.toBeNull();
  });
});

describe('readiness', () => {
  it('reads "not serving" off any failure, and never raises from apiInfo', async () => {
    script([], new RequestFailed('refused', 'http://x'));
    expect(await apiInfo('http://x')).toBeNull();
    script([], { status: 503, text: 'gateway' });
    expect(await apiInfo('http://x')).toBeNull();
    // A 200 with an unparseable body is not serving either.
    script([], { status: 200, text: '<html>' });
    expect(await apiInfo('http://x')).toBeNull();
    script([], { status: 200, text: '{"version":"8.5.1"}' });
    expect(await apiInfo('http://x')).toEqual({ version: '8.5.1' });
    // The trailing slash comes off, or the path doubles it.
    expect(seen[0]?.url).toBe('http://x/api/info');
  });

  it('fails fast on a crashed container rather than polling it for the full timeout', async () => {
    // Five minutes of polling a container that has exited, then "did not become ready", is
    // a report that names the wrong thing and takes five minutes to do it.
    script([], { status: 502, text: '' });
    let ticks = 0;
    await expect(
      waitReady('http://x', {
        isAlive: () => false,
        sleep: nowait,
        onTick: () => {
          ticks += 1;
        },
      }),
    ).rejects.toBeInstanceOf(NotReady);
    await expect(waitReady('http://x', { isAlive: () => false, sleep: nowait })).rejects.toThrow(
      /is not running/u,
    );
    expect(ticks).toBe(0);
  });

  it('gives up at its own deadline, and says how long it waited', async () => {
    script([], { status: 502, text: '' });
    await expect(waitReady('http://x', { timeout: 0, sleep: nowait })).rejects.toThrow(
      /did not become ready within 0s/u,
    );
  });

  it('returns the payload as soon as it is serving', async () => {
    script([], { status: 200, text: '{"version":"8.5.1"}' });
    expect(await waitReady('http://x', { sleep: nowait })).toEqual({ version: '8.5.1' });
  });
});

describe('logging in', () => {
  const OK = {
    status: 200,
    text: JSON.stringify({ data: { authToken: 'tok', userId: 'uid' } }),
  };

  it('returns the token and the user id', async () => {
    script([], OK);
    expect(await login('http://x/')).toEqual({ token: 'tok', userId: 'uid' });
    expect(seen[0]?.url).toBe('http://x/api/v1/login');
    expect(seen[0]?.json).toEqual({ user: 'admin', password: 'admin123' });
  });

  it('refuses a 200 whose body is not a token, quoting what came back instead', async () => {
    // A proxy's error page served with a 200 must not escape as a JSON parse failure: the
    // body text is the only useful thing such a page ever provides.
    script([], { status: 200, text: '<html>Bad Gateway</html>' });
    await expect(login('http://x')).rejects.toThrow(/login did not return a token/u);
    await expect(login('http://x')).rejects.toThrow(/Bad Gateway/u);
  });

  it('rejects a non-200 that is not a 2FA challenge, rather than blaming 2FA', async () => {
    // `raise_for_status()` is a no-op for 3xx, so a reverse proxy's 302 to HTTPS -- the
    // case `--allow-host` exists for -- fell through into the 2FA branch and reported a
    // missing Mailpit URL for what is really a redirect.
    script([], { status: 302, text: '<html>Found</html>', ok: true });
    await expect(login('http://x')).rejects.toThrow(/302/u);
    await expect(login('http://x')).rejects.toThrow(/2FA challenge/u);
  });

  it('tries the password-fallback method before asking for an email code', async () => {
    // No email needed, so it costs nothing and works on a workspace with no Mailpit.
    let attempt = 0;
    script([
      [
        at('/login'),
        {
          status: 200,
          text: '',
          json: () => ({}),
        },
      ],
    ]);
    rcHttp.request = (url, options = {}) => {
      seen.push({
        url,
        method: 'POST',
        headers: { ...options.headers },
        json: options.json,
        ...(options.params === undefined ? {} : { params: options.params }),
      });
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve(respond({ status: 401, text: '{"error":"totp-required"}' }, url));
      }
      return Promise.resolve(respond(OK, url));
    };
    expect(await login('http://x')).toEqual({ token: 'tok', userId: 'uid' });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.headers['x-2fa-method']).toBe('password');
    // The code is the sha256 of the password, which is what RC's password method wants.
    expect(seen[1]?.headers['x-2fa-code']).toBe(
      (await password2faHeaders('admin123'))['x-2fa-code'],
    );
  });

  it('REFUSES an unfiltered OTP poll rather than risk another user’s code', async () => {
    // Mailpit is a catch-all inbox for every address. With no resolvable recipient the
    // filter would be off, and the poll could hand back a DIFFERENT user's code -- the
    // exact thing the filter exists to prevent.
    script([], { status: 401, text: '{"error":"totp-required"}' });
    await expect(
      login('http://x', {
        user: 'alice',
        password: 'alice',
        mailpitUrl: 'http://mailpit',
        sleep: nowait,
      }),
    ).rejects.toThrow(/another user's code/u);
  });

  it('says so when a code is needed and no Mailpit is configured', async () => {
    script([], { status: 401, text: '{"error":"totp-required"}' });
    await expect(login('http://x', { sleep: nowait })).rejects.toThrow(/no Mailpit URL/u);
  });

  it('resolves the admin’s own address, and anything with an @ in it', () => {
    expect(otpRecipient('admin')).toBe('admin@example.com');
    expect(otpRecipient('alice@example.test')).toBe('alice@example.test');
    expect(() => otpRecipient('alice')).toThrow(/address is unknown/u);
  });

  it('snapshots the inbox first, so a stale code is never reused', async () => {
    // A code left over from a previous login sits in the catch-all inbox and reads exactly
    // like a fresh one.
    const stale = {
      ID: 'old',
      Created: '2026-01-01T00:00:00Z',
      To: [{ Address: 'admin@example.com' }],
    };
    const fresh = {
      ID: 'new',
      Created: '2026-01-01T00:05:00Z',
      To: [{ Address: 'admin@example.com' }],
    };
    let loginAttempt = 0;
    seen = [];
    rcHttp.request = (url, options = {}) => {
      seen.push({
        url,
        method: String(options.method ?? 'GET'),
        headers: { ...options.headers },
        json: options.json,
        ...(options.params === undefined ? {} : { params: options.params }),
      });
      if (url.includes('/api/v1/messages')) {
        // Before the code is sent only the stale one is there; afterwards, both.
        const messages = seen.some((entry) => entry.url.includes('sendEmailCode'))
          ? [fresh, stale]
          : [stale];
        return Promise.resolve(respond({ text: JSON.stringify({ messages }) }, url));
      }
      if (url.includes('/api/v1/message/new')) {
        return Promise.resolve(respond({ text: JSON.stringify({ Text: 'code 424242' }) }, url));
      }
      if (url.includes('/api/v1/message/old')) {
        return Promise.resolve(respond({ text: JSON.stringify({ Text: 'code 111111' }) }, url));
      }
      if (url.includes('sendEmailCode')) return Promise.resolve(respond({ text: '{}' }, url));
      loginAttempt += 1;
      if (loginAttempt <= 2) {
        return Promise.resolve(respond({ status: 401, text: '{"error":"totp-required"}' }, url));
      }
      return Promise.resolve(respond(OK, url));
    };
    expect(await login('http://x', { mailpitUrl: 'http://mailpit', sleep: nowait })).toEqual({
      token: 'tok',
      userId: 'uid',
    });
    // The FRESH code, and the stale message was never even opened.
    const final = seen[seen.length - 1];
    expect(final?.headers['x-2fa-code']).toBe('424242');
    expect(final?.headers['x-2fa-method']).toBe('email');
    expect(seen.some((entry) => entry.url.includes('/message/old'))).toBe(false);
  });

  it('blames the failed send rather than the timeout, when the send is what failed', async () => {
    script([
      [at('/api/v1/messages'), { text: '{"messages":[]}' }],
      [at('sendEmailCode'), { status: 403, ok: false, text: 'Forbidden' }],
      [at('/login'), { status: 401, text: '{"error":"totp-required"}' }],
    ]);
    await expect(
      login('http://x', { mailpitUrl: 'http://mailpit', sleep: nowait, otpTimeout: 0 }),
    ).rejects.toThrow(/sendEmailCode returned HTTP 403/u);
  });
});

describe('reading a code out of an inbox', () => {
  it('takes a standalone six-digit number and nothing else', () => {
    expect(extractOtp('Your login code is 428913, valid 5 min.')).toBe('428913');
    expect(extractOtp('<b>042891</b>')).toBe('042891');
    expect(extractOtp('order #12345678 shipped')).toBeNull(); // not six digits
    expect(extractOtp('')).toBeNull();
  });

  it('matches the recipient case-insensitively, and only the right one', async () => {
    const message = (address: string) => ({
      messages: [{ ID: '1', Created: 'z', To: [{ Address: address }] }],
    });
    script([[at('/api/v1/messages'), { text: JSON.stringify(message('Alice@Example.com')) }]]);
    expect(await newestMailStamp('http://m', { toEmail: 'alice@example.com' })).toBe('z');
    script([[at('/api/v1/messages'), { text: JSON.stringify(message('Alice@Example.com')) }]]);
    expect(await newestMailStamp('http://m', { toEmail: 'admin@example.com' })).toBe('');
    // No filter matches anything, which is why an unresolvable recipient is refused
    // upstream rather than falling through to this.
    script([[at('/api/v1/messages'), { text: JSON.stringify(message('anyone@example.com')) }]]);
    expect(await newestMailStamp('http://m')).toBe('z');
  });

  it('keeps polling through a Mailpit that is not up yet', async () => {
    // Mailpit boots alongside Rocket.Chat, so a refused connection is "not yet", not "no".
    let tries = 0;
    seen = [];
    rcHttp.request = (url) => {
      tries += 1;
      if (tries < 3) return Promise.reject(new RequestFailed('refused', url));
      if (url.includes('/api/v1/messages')) {
        return Promise.resolve(
          respond({ text: JSON.stringify({ messages: [{ ID: '1', Created: 'z', To: [] }] }) }, url),
        );
      }
      return Promise.resolve(respond({ text: JSON.stringify({ Text: 'code 999111' }) }, url));
    };
    expect(await fetchEmailOtp('http://m', { sleep: nowait })).toBe('999111');
    expect(tries).toBeGreaterThan(2);
  });

  it('answers null at the deadline rather than hanging', async () => {
    script([[at('/api/v1/messages'), { text: '{"messages":[]}' }]]);
    expect(await fetchEmailOtp('http://m', { timeout: 0, sleep: nowait })).toBeNull();
  });
});

describe('the calls that answer 200 for something that did not work', () => {
  it('opens method.call’s inner envelope, because the outer flag lies', async () => {
    // `method.call` returns HTTP 200 with `success: true` even when the Meteor method
    // threw -- the real outcome is a JSON string in `message`.
    const ran = (message: unknown) =>
      respond({ status: 200, text: JSON.stringify({ success: true, message }) }, 'u');
    expect(methodSucceeded(ran(JSON.stringify({ msg: 'result', result: 1 })))).toBe(true);
    expect(
      methodSucceeded(ran(JSON.stringify({ msg: 'result', error: { message: 'nope' } }))),
    ).toBe(false);
    // An outer failure is still a failure.
    expect(methodSucceeded(respond({ status: 200, text: '{"success":false}' }, 'u'))).toBe(false);
    expect(methodSucceeded(respond({ status: 500, text: 'boom' }, 'u'))).toBe(false);
    // An unparseable inner envelope is not a success either.
    expect(methodSucceeded(ran('not json'))).toBe(false);
  });

  it('puts the DDP message in method.call spaced as earlier releases wrote it', async () => {
    // The inner message is a STRING, and earlier releases wrote its bytes as
    // `{"msg": "method", "id": "1", ...}` with `\uXXXX` past ASCII. `JSON.stringify` wrote
    // it compact and raw, and every addOAuthService sent other bytes.
    const names = ['Keycloak', 'Ms_entra_id', 'K\u00e9y \u65e5'];
    // What earlier releases sent for each name, recorded.
    const recorded = [
      '{"msg": "method", "id": "1", "method": "addOAuthService", "params": ["Keycloak"]}',
      '{"msg": "method", "id": "1", "method": "addOAuthService", "params": ["Ms_entra_id"]}',
      '{"msg": "method", "id": "1", "method": "addOAuthService", "params": ["K\\u00e9y \\u65e5"]}',
    ];
    const ours: unknown[] = [];
    for (const name of names) {
      script([], new RequestFailed('connection refused', 'http://x'));
      expect(await addOauthService('http://x', { token: 't', userId: 'u' }, 'pw', name)).toBe(
        false,
      );
      ours.push((seen[0]?.json as { message?: unknown } | undefined)?.message);
    }
    expect(ours).toEqual(recorded);
    expect(ours[0]).toBe(
      '{"msg": "method", "id": "1", "method": "addOAuthService", "params": ["Keycloak"]}',
    );
  });

  it('treats a setting write as done only when the body says so', async () => {
    script([], { status: 200, text: '{"success":true}' });
    expect(await setSetting('http://x', { token: 't', userId: 'u' }, 'pw', 'A', 1)).toBe(true);
    script([], { status: 200, text: '{"success":false}' });
    expect(await setSetting('http://x', { token: 't', userId: 'u' }, 'pw', 'A', 1)).toBe(false);
    script([], new RequestFailed('refused', 'http://x'));
    expect(await setSetting('http://x', { token: 't', userId: 'u' }, 'pw', 'A', 1)).toBe(false);
  });

  it('reads a setting value, and answers null when it cannot', async () => {
    script([], { status: 200, text: '{"success":true,"value":"completed"}' });
    expect(
      await getSetting('http://x', { token: 't', userId: 'u' }, 'pw', 'Show_Setup_Wizard'),
    ).toBe('completed');
    script([], { status: 403, text: 'no' });
    expect(
      await getSetting('http://x', { token: 't', userId: 'u' }, 'pw', 'Show_Setup_Wizard'),
    ).toBeNull();
  });

  it('asks the workspace which names are settings, and says null when it could not', async () => {
    // A bare setting id in the environment is accepted by docker, changes nothing, and
    // reports no error -- so guessing from a name's shape is not good enough.
    script([], { status: 200, text: '{"success":true,"settings":[{"_id":"A"},{"_id":"B"},{}]}' });
    expect(await settingIds('http://x', { token: 't', userId: 'u' }, 'pw')).toEqual(
      new Set(['A', 'B']),
    );
    expect(seen[0]?.url).toContain('?count=0');
    script([], { status: 401, text: '' });
    expect(await settingIds('http://x', { token: 't', userId: 'u' }, 'pw')).toBeNull();
    script([], { status: 200, text: '{"success":false}' });
    expect(await settingIds('http://x', { token: 't', userId: 'u' }, 'pw')).toBeNull();
  });
});

describe('the personal access token', () => {
  const AUTH = { token: 't', userId: 'u' };

  it('is audited HERE, before anything is sent', async () => {
    // Eight non-test call sites in earlier releases, so a record written at one handler would
    // have missed six -- and a bypass-2FA admin token for somebody else's workspace is one
    // of the two most sensitive things this tool can do.
    const audited: string[][] = [];
    const remove = installAuditRecorder((kind, label) => audited.push([kind, label]));
    try {
      script([], { status: 200, text: '{"success":true,"token":"pat-1"}' });
      expect(await generatePat('http://x', AUTH, 'pw', { workspace: 'TICKET-1' })).toBe('pat-1');
      expect(audited).toEqual([['pat', 'TICKET-1 label=houston bypass_2fa=True']]);
    } finally {
      remove();
    }
  });

  it('records the root URL when no workspace was named, rather than nothing', async () => {
    const audited: string[][] = [];
    const remove = installAuditRecorder((kind, label) => audited.push([kind, label]));
    try {
      script([], { status: 200, text: '{"success":true,"token":"pat-1"}' });
      await generatePat('http://x', AUTH, 'pw', { bypass2fa: false, tokenName: 'ci' });
      expect(audited).toEqual([['pat', 'http://x label=ci bypass_2fa=False']]);
    } finally {
      remove();
    }
  });

  it('spells the flag as earlier releases audit it: True and False', async () => {
    // Recorded from earlier releases with every request refused, since the record is
    // written before any request. This wrote `true`/`false`, so an external grep or awk
    // over audit.log for the spelling earlier releases wrote missed every PAT this build
    // minted.
    const CASES: [string, string, string, boolean][] = [
      ['TICKET-1', 'http://x', 'houston', true],
      ['', 'http://x', 'ci', false],
    ];
    // What earlier releases audited for each case, recorded.
    const recorded = [
      ['pat', 'TICKET-1 label=houston bypass_2fa=True'],
      ['pat', 'http://x label=ci bypass_2fa=False'],
    ];
    const audited: string[][] = [];
    const remove = installAuditRecorder((kind, label) => audited.push([kind, label]));
    try {
      for (const [workspace, root, tokenName, bypass2fa] of CASES) {
        script([], new RequestFailed('connection refused', root));
        await generatePat(root, AUTH, 'pw', { workspace, tokenName, bypass2fa }).catch(() => '');
      }
    } finally {
      remove();
    }
    expect(audited).toEqual(recorded);
    expect(audited[1]).toEqual(['pat', 'http://x label=ci bypass_2fa=False']);
  });

  it('audits even a mint that then fails, because the attempt is the event', async () => {
    const audited: string[][] = [];
    const remove = installAuditRecorder((kind) => audited.push([kind]));
    try {
      script([], { status: 403, text: 'forbidden' });
      await expect(generatePat('http://x', AUTH, 'pw')).rejects.toThrow(/could not create PAT/u);
      expect(audited).toHaveLength(1);
    } finally {
      remove();
    }
  });

  it('regenerates when the token already exists', async () => {
    script([
      [at('users.generatePersonalAccessToken'), { status: 200, text: '{"success":false}' }],
      [
        at('users.regeneratePersonalAccessToken'),
        { status: 200, text: '{"success":true,"token":"pat-2"}' },
      ],
    ]);
    expect(await generatePat('http://x', AUTH, 'pw')).toBe('pat-2');
    expect(seen).toHaveLength(2);
  });

  it('keeps its contract when the network fails, rather than leaking a transport error', async () => {
    // "A token, or an Error whose message names the path". A bare RequestFailed escaping
    // would break any caller that narrows its catch.
    script([], new RequestFailed('refused', 'http://x'));
    await expect(generatePat('http://x', AUTH, 'pw')).rejects.toThrow(
      /could not reach users.generatePersonalAccessToken/u,
    );
    await expect(generatePat('http://x', AUTH, 'pw')).rejects.not.toBeInstanceOf(RequestFailed);
  });

  it('satisfies 2FA with the password method, because minting one is guarded', async () => {
    script([], { status: 200, text: '{"success":true,"token":"pat-1"}' });
    await generatePat('http://x', AUTH, 'pw');
    expect(seen[0]?.headers['x-2fa-method']).toBe('password');
    expect(seen[0]?.headers['X-Auth-Token']).toBe('t');
  });
});

describe('the rest of the surface', () => {
  it('reuses an integration it already made rather than failing', async () => {
    script([
      [at('integrations.create'), { status: 400, ok: false, text: '{"success":false}' }],
      [
        at('integrations.list'),
        {
          status: 200,
          text: JSON.stringify({
            integrations: [
              { name: 'other', _id: 'x', token: 'y' },
              { name: 'houston-loadtest-hook', _id: 'i1', token: 't1' },
            ],
          }),
        },
      ],
    ]);
    expect(await createIncomingWebhook('http://x', { token: 't', userId: 'u' }, 'pw')).toBe(
      '/hooks/i1/t1',
    );
  });

  it('answers null for a webhook it could neither create nor find', async () => {
    script([], new RequestFailed('refused', 'http://x'));
    expect(await createIncomingWebhook('http://x', { token: 't', userId: 'u' }, 'pw')).toBeNull();
  });

  it('keeps retrying a SAML descriptor while the IdP boots, then reads one line', async () => {
    // Keycloak boots slowly, so "not serving" is not "no certificate".
    let tries = 0;
    seen = [];
    rcHttp.request = (url) => {
      tries += 1;
      if (tries < 3) return Promise.reject(new RequestFailed('refused', url));
      return Promise.resolve(
        respond(
          {
            text: '<md:KeyDescriptor><ds:X509Certificate>MIIC\n  AgEB\n  ABC=\n</ds:X509Certificate>',
          },
          url,
        ),
      );
    };
    expect(await fetchSamlIdpCert('http://idp/descriptor', { sleep: nowait })).toBe('MIICAgEBABC=');
  });

  it('answers null for an IdP that never came up', async () => {
    script([], new RequestFailed('refused', 'http://idp'));
    expect(await fetchSamlIdpCert('http://idp', { timeout: 0, sleep: nowait })).toBeNull();
  });

  it('returns a status and a body from call(), and sends the auth headers', async () => {
    script([], { status: 202, text: 'accepted' });
    expect(
      await call('http://rc/', 'get', '/api/info', { auth: { token: 'tok', userId: 'uid' } }),
    ).toEqual([202, 'accepted']);
    expect(seen[0]?.url).toBe('http://rc/api/info');
    expect(seen[0]?.headers).toMatchObject(authHeaders({ token: 'tok', userId: 'uid' }));
    // An extra header wins over the auth ones, which is what `extra_headers` is for.
    script([], { status: 200, text: '' });
    await call('http://rc', 'POST', 'api/v1/x', {
      auth: { token: 'tok', userId: 'uid' },
      data: { a: 1 },
      extraHeaders: { 'X-Auth-Token': 'override' },
    });
    expect(seen[0]?.headers['X-Auth-Token']).toBe('override');
    expect(seen[0]?.json).toEqual({ a: 1 });
  });

  it('carries a query string, which is what the three bypasses were going around it for', async () => {
    // The seed, perf and CLI code once called `/api/v1/...` directly, around this client,
    // and a query string is what each of them needed. `only-rcapi-speaks-http`
    // is the gate that brings them back through, so the keyword has to exist for them to
    // come.
    script([], { status: 200, text: '{}' });
    await call('http://rc', 'GET', '/api/v1/channels.info', {
      params: { roomName: 'team chat', count: 0 },
    });
    expect(seen[0]?.params).toEqual({ roomName: 'team chat', count: 0 });
    // And a call with no params sends none, rather than an empty `?`.
    script([], { status: 200, text: '{}' });
    await call('http://rc', 'GET', '/api/info');
    expect(seen[0]?.params).toBeUndefined();
  });

  it('does NOT swallow a transport failure in call(), unlike the best-effort helpers', async () => {
    // `call` is the `houston api` command's own path: an unreachable workspace has to
    // reach the caller, which renders it, rather than becoming a silent empty body.
    script([], new RequestFailed('refused', 'http://rc'));
    await expect(call('http://rc', 'GET', '/api/info')).rejects.toBeInstanceOf(RequestFailed);
  });
});

describe('the REST seam the callers go through', () => {
  it('is a replaceable property, so seed, the CLI and the GUI can all be stubbed at one place', async () => {
    // swc emits exports as non-configurable getters; `rcapi.call` is the property every
    // caller that speaks REST reaches it through, so replacing it must take effect.
    const real = rcapi.call;
    const seenCalls: unknown[][] = [];
    try {
      rcapi.call = (...args: Parameters<typeof call>) => {
        seenCalls.push(args);
        return Promise.resolve([202, 'accepted'] as [number, string]);
      };
      expect(await rcapi.call('http://rc', 'GET', '/api/info')).toEqual([202, 'accepted']);
      expect(seenCalls).toEqual([['http://rc', 'GET', '/api/info']]);
    } finally {
      rcapi.call = real;
    }
  });
});
