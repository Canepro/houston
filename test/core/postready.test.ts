import * as path from 'node:path';

import type { Event } from '../../src/lib/events';

import { metadata, type Metadata } from '../../src/core/runner/record';
import { KUBERNETES, stamp } from '../../src/core/topology';

import type * as ModNS from '../../src/core/postready';
import type * as KubeExecNS from '../../src/core/kube/exec';
import type * as FsNS from 'node:fs';

function meta(values: Partial<Metadata> = {}): Metadata {
  return metadata({
    name: 'w',
    project: 'p',
    rcVersion: '8.5.1',
    rcImage: 'i',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset: 'saml',
    rootUrl: 'u',
    hostPort: 3000,
    versionSource: 't',
    ...values,
  });
}

const AUTH = { token: 't', userId: 'uid' };

/** Collect what the run said, the way the CLI and `web/jobs` both do. */
function recorder() {
  const said: string[] = [];
  return { said, emit: (e: Event) => said.push(e.message) };
}

const noSleep = () => Promise.resolve();

/** Load the module with `./rcapi` fully stubbed to one answer. */
function withRcapi(answers: Record<string, unknown>) {
  jest.resetModules();
  jest.doMock('../../src/core/rcapi', () => answers);
  return require('../../src/core/postready') as typeof ModNS;
}

describe('a preset configures itself through the runtime that owns it', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('reaches for kubectl on a Kubernetes workspace, and never for compose', async () => {
    // `no configuration file provided: not found` in the middle of a Kubernetes create,
    // followed by "starting". That is docker compose's own wording for "there is no
    // compose project here", and it appeared because a post_ready handler -- a preset
    // configuring ITSELF -- called `composeExec` on a Kubernetes workspace.
    jest.resetModules();
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExec: () => {
        throw new Error('it reached for docker compose');
      },
    }));
    jest.doMock('../../src/core/kube/namespace', () => ({
      namespaceFor: () => Promise.resolve('houston-k'),
    }));
    const postready = require('../../src/core/postready') as typeof ModNS;
    const { kube } = require('../../src/core/kube/exec') as typeof KubeExecNS;

    const seen: (readonly string[])[] = [];
    const original = kube.run;
    kube.run = (argv) => {
      seen.push(argv);
      return Promise.resolve({ argv, returncode: 0, stdout: 'keycloak-abc', stderr: '' });
    };
    try {
      const m = meta({ name: 'k', project: 'houston-k' });
      stamp(m.extra, KUBERNETES);
      expect(await postready.execIn(m, 'keycloak', ['bash', '-lc', 'true'])).toBe(0);
    } finally {
      kube.run = original;
    }
    expect(seen.some((argv) => argv.includes('kubectl'))).toBe(true);
    expect(seen.some((argv) => argv.includes('exec'))).toBe(true);
    expect(seen.some((argv) => argv.includes('-l') && argv.includes('app=houston-keycloak'))).toBe(
      true,
    );
  });

  it('still goes through compose on a Compose workspace -- this is a fork, not a swap', async () => {
    jest.resetModules();
    const calls: unknown[][] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExec: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(0);
      },
    }));
    const postready = require('../../src/core/postready') as typeof ModNS;
    const { kube } = require('../../src/core/kube/exec') as typeof KubeExecNS;

    const original = kube.run;
    kube.run = () => {
      throw new Error('it reached for kubectl');
    };
    try {
      expect(await postready.execIn(meta({ name: 'c' }), 'keycloak', ['true'])).toBe(0);
    } finally {
      kube.run = original;
    }
    expect(calls).toEqual([['c', 'keycloak', ['true']]]);
  });

  it('does not ask kubectl to mint a namespace the record already holds', async () => {
    // The recorded namespace short-circuits the lookup. A workspace that recorded its
    // namespace has the answer on disk, and spending a kubectl call to recompute it is a
    // child process spent in the middle of a create.
    jest.resetModules();
    jest.doMock('../../src/core/runner/engine', () => ({ composeExec: () => Promise.resolve(0) }));
    jest.doMock('../../src/core/kube/namespace', () => ({
      namespaceFor: () => {
        throw new Error('it recomputed a namespace it already had');
      },
    }));
    const postready = require('../../src/core/postready') as typeof ModNS;
    const { kube } = require('../../src/core/kube/exec') as typeof KubeExecNS;

    const seen: (readonly string[])[] = [];
    const original = kube.run;
    kube.run = (argv) => {
      seen.push(argv);
      return Promise.resolve({ argv, returncode: 0, stdout: 'pod-1', stderr: '' });
    };
    try {
      const m = meta({ name: 'k' });
      stamp(m.extra, KUBERNETES);
      m.extra.namespace = 'houston-recorded';
      await postready.execIn(m, 'keycloak', ['true']);
    } finally {
      kube.run = original;
    }
    expect(seen[0]).toContain('houston-recorded');
  });
});

describe('a half-configured preset says so instead of reporting success', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('names what failed and the command that retries it', async () => {
    // The create printed "could not fetch/apply IdP cert", then "starting", and left the
    // reader to work out whether SAML actually worked. The DEPLOYMENT succeeding and the
    // CONFIGURATION succeeding are different answers to different questions.
    jest.resetModules();
    const postready = require('../../src/core/postready') as typeof ModNS;
    const m = meta();
    m.extra.post_ready = [{ action: 'saml_idp_cert' }, { action: 'keycloak_master_ssl_off' }];
    const { said, emit } = recorder();
    postready.POST_READY_ACTIONS.saml_idp_cert = () => Promise.resolve(false);
    postready.POST_READY_ACTIONS.keycloak_master_ssl_off = () => Promise.resolve(true);
    let failed: string[] | null;
    try {
      failed = await postready.runPostReady(m, AUTH, emit);
    } finally {
      postready.resetActions();
    }
    expect(failed).toEqual(['saml_idp_cert']);
    const joined = said.join(' ');
    expect(joined).toContain('RUNNING');
    expect(joined).toContain('partly configured');
    expect(joined).toContain('saml_idp_cert');
    expect(joined).toContain('houston ready --name w');
    // And the one that SUCCEEDED is not in the list, or the summary means nothing.
    expect(joined).not.toContain('keycloak_master_ssl_off');
  });

  it('answers null, not an empty list, when there was no admin session', async () => {
    const postready = require('../../src/core/postready') as typeof ModNS;
    const m = meta();
    m.extra.post_ready = [{ action: 'saml_idp_cert' }];
    const { said, emit } = recorder();
    // No session, no actions, and null says so. "Nothing ran" and "everything succeeded"
    // are different answers, and a caller that renders `[]` as a clean bill of health needs
    // to be able to tell them apart.
    expect(await postready.runPostReady(m, null, emit)).toBeNull();
    expect(said.join(' ')).toContain('preset self-config skipped');
  });

  it('says nothing at all when there was no admin session and nothing to configure', async () => {
    const postready = require('../../src/core/postready') as typeof ModNS;
    const { said, emit } = recorder();
    expect(await postready.runPostReady(meta(), null, emit)).toBeNull();
    expect(said).toEqual([]);
  });

  it('skips an action name this build does not know, rather than failing it', async () => {
    const postready = require('../../src/core/postready') as typeof ModNS;
    const m = meta();
    m.extra.post_ready = [{ action: 'from_a_newer_preset' }];
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit)).toEqual([]);
    expect(said).toEqual([]);
  });
});

describe('the IdP cert is fetched once, not retried around a retrier', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('calls the retrying function exactly once, with the deadline passed in', async () => {
    // A SAML create that sat for THIRTY MINUTES, found by the operational audit.
    // `fetchSamlIdpCert` retries to its own deadline, and v0.54.1 wrapped it in a second
    // 20-attempt loop without reading that. 20 x 90s is half an hour of a create that
    // looks hung and cannot be told from one that is.
    const calls: unknown[] = [];
    const postready = withRcapi({
      fetchSamlIdpCert: (_url: string, options: unknown) => {
        calls.push(options);
        return Promise.resolve('');
      },
      setSetting: () => Promise.resolve(true),
    });
    const m = meta();
    m.extra.post_ready = [
      { action: 'saml_idp_cert', descriptor_url: 'http://localhost:8081/x', setting: 's' },
    ];
    await postready.runPostReady(m, AUTH, recorder().emit, { sleep: noSleep });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ timeout: postready.IDP_CERT_DEADLINE });
  });

  it('has no loop wrapped around it in the source, which is the shape of the defect', () => {
    const fs = require('node:fs') as typeof FsNS;
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'core', 'postready.ts'),
      'utf8',
    );
    // The CALL, not the prose: the comment above it names the function to explain why it
    // is only called once, so counting the name would count the explanation too.
    expect(src.split('rcapi.fetchSamlIdpCert(')).toHaveLength(2);
  });
});

describe('every handler reports a boolean', () => {
  afterEach(() => {
    jest.resetModules();
  });

  const ALL_ACTIONS = [
    { action: 'saml_idp_cert', descriptor_url: 'http://idp/x', setting: 's' },
    { action: 'keycloak_master_ssl_off' },
    { action: 'create_oauth_provider', name: 'Keycloak', settings: { a: 1 } },
    { action: 'livechat_setup', agents: 2, department: 'Support' },
  ];

  /**
   * Driven rather than read off the type annotations.
   * The collection reads `=== false`, so a handler that answers `undefined` opts itself
   * out of it silently -- two did, and one of them was the oidc preset's only action.
   */
  function rcapiAnswering(value: boolean) {
    const yes = () => Promise.resolve(value);
    return {
      fetchSamlIdpCert: () => Promise.resolve(value ? 'CERT' : ''),
      setSetting: yes,
      addOauthService: yes,
      createUser: yes,
      addLivechatAgent: yes,
      getUserId: () => Promise.resolve(value ? 'id2' : null),
      ensureLivechatDepartment: () => Promise.resolve(value ? 'dept' : null),
      assignLivechatAgents: yes,
      saveCannedResponse: yes,
      setLivechatAvailable: yes,
    };
  }

  it('reports every action as failed when nothing works', async () => {
    jest.doMock('../../src/core/runner/engine', () => ({ composeExec: () => Promise.resolve(1) }));
    const postready = withRcapi(rcapiAnswering(false));
    const m = meta();
    m.extra.post_ready = ALL_ACTIONS;
    expect(await postready.runPostReady(m, AUTH, recorder().emit, { sleep: noSleep })).toEqual([
      'saml_idp_cert',
      'keycloak_master_ssl_off',
      'create_oauth_provider',
      'livechat_setup',
    ]);
  });

  it('reports none as failed when everything works', async () => {
    jest.doMock('../../src/core/runner/engine', () => ({ composeExec: () => Promise.resolve(0) }));
    const postready = withRcapi(rcapiAnswering(true));
    const m = meta();
    m.extra.post_ready = ALL_ACTIONS;
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    const joined = said.join(' ');
    expect(joined).toContain('SAML login button registered');
    expect(joined).toContain('Keycloak admin console enabled over HTTP');
    expect(joined).toContain('OIDC provider created and configured');
    expect(joined).toContain("Omnichannel: 2 agent(s) available, 'Support' department");
    expect(joined).not.toContain('partly configured');
  });
});

describe('an OAuth provider that did not configure is not a success', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('reports a provider that could not be created', async () => {
    // `runPostReady` collects a failure on an explicit false, and this handler returned
    // nothing on EVERY path -- so a workspace whose OAuth provider could not be created
    // printed one warning, was left out of the "only partly configured" summary that
    // exists for exactly this, and exited 0.
    const postready = withRcapi({ addOauthService: () => Promise.resolve(false) });
    const m = meta({ preset: 'oidc' });
    m.extra.post_ready = [
      { action: 'create_oauth_provider', name: 'Keycloak', settings: { a: 1 } },
    ];
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([
      'create_oauth_provider',
    ]);
    expect(said.join(' ')).toContain('partly configured');
  });

  it('names the settings that did not apply, and does not call the button usable', async () => {
    // Creating the provider is not the same as the provider working. The settings carry
    // the realm URL, the client id and the secret; every `setSetting` result was
    // discarded, so a provider created with none of them reported "login button
    // registered" -- and the button really was registered, pointing at nothing.
    const postready = withRcapi({
      addOauthService: () => Promise.resolve(true),
      // The url is the one that matters, and it is the one that refuses.
      setSetting: (_u: string, _a: unknown, _p: string, sid: string) =>
        Promise.resolve(!sid.includes('-url')),
    });
    const settings = {
      'Accounts_OAuth_Custom-Keycloak': true,
      'Accounts_OAuth_Custom-Keycloak-url': 'http://keycloak:8085/realms/x',
    };
    const m = meta({ preset: 'oidc' });
    m.extra.post_ready = [{ action: 'create_oauth_provider', name: 'Keycloak', settings }];
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([
      'create_oauth_provider',
    ]);
    const joined = said.join(' ');
    expect(joined).toContain('-url');
    expect(joined).toContain('lead nowhere');
    expect(joined).toContain('1 of its 2 settings did not apply');
  });

  it('retries the settings that did not take, because RC caches them', async () => {
    // The provider's settings are created BY `addOAuthService`, so the first PATCH can
    // land before the id exists. A fixed sleep is either too short on a loaded box or
    // wasted on a fast one, and this is the window in which a wrong answer looks like
    // success.
    let attempt = 0;
    const seen: string[][] = [];
    const postready = withRcapi({
      addOauthService: () => Promise.resolve(true),
      setSetting: (_u: string, _a: unknown, _p: string, sid: string) => {
        const round = seen[attempt] ?? (seen[attempt] = []);
        round.push(sid);
        return Promise.resolve(attempt > 0);
      },
    });
    const m = meta({ preset: 'oidc' });
    m.extra.post_ready = [{ action: 'create_oauth_provider', name: 'K', settings: { a: 1, b: 2 } }];
    const sleep = () => {
      attempt += 1;
      return Promise.resolve();
    };
    expect(await postready.runPostReady(m, AUTH, recorder().emit, { sleep })).toEqual([]);
    // The retry carries ONLY what failed, not the whole set again.
    expect(seen[0]).toEqual(['a', 'b']);
    expect(seen[1]).toEqual(['a', 'b']);
    expect(seen).toHaveLength(2);
  });

  it('gives up after three retries rather than looping forever', async () => {
    let rounds = 0;
    const postready = withRcapi({
      addOauthService: () => Promise.resolve(true),
      setSetting: () => {
        rounds += 1;
        return Promise.resolve(false);
      },
    });
    const m = meta({ preset: 'oidc' });
    m.extra.post_ready = [{ action: 'create_oauth_provider', name: 'K', settings: { a: 1 } }];
    expect(await postready.runPostReady(m, AUTH, recorder().emit, { sleep: noSleep })).toEqual([
      'create_oauth_provider',
    ]);
    expect(rounds).toBe(4); // one attempt, then three retries
  });
});

describe('the livechat action', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('is a failure when the agent could not be made available', async () => {
    // This returned nothing on both paths, so a livechat workspace whose agent could not be
    // made available printed a warning and was still counted as fully configured.
    const postready = withRcapi({
      addLivechatAgent: () => Promise.resolve(true),
      createUser: () => Promise.resolve(true),
      getUserId: () => Promise.resolve(null),
      setLivechatAvailable: () => Promise.resolve(false),
      saveCannedResponse: () => Promise.resolve(true),
      ensureLivechatDepartment: () => Promise.resolve(null),
      assignLivechatAgents: () => Promise.resolve(false),
    });
    const m = meta({ preset: 'livechat' });
    m.extra.post_ready = [{ action: 'livechat_setup' }];
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([
      'livechat_setup',
    ]);
    expect(said.join(' ')).toContain('Admin -> Omnichannel -> Agents');
  });

  it('is NOT a failure when only the canned response was refused', async () => {
    // Canned responses fail on a workspace with no licence, which is the normal case and
    // not a fault -- so it is deliberately outside the verdict.
    const postready = withRcapi({
      addLivechatAgent: () => Promise.resolve(true),
      createUser: () => Promise.resolve(true),
      getUserId: () => Promise.resolve(null),
      setLivechatAvailable: () => Promise.resolve(true),
      saveCannedResponse: () => Promise.resolve(false),
      ensureLivechatDepartment: () => Promise.resolve(null),
      assignLivechatAgents: () => Promise.resolve(false),
    });
    const m = meta({ preset: 'livechat' });
    m.extra.post_ready = [{ action: 'livechat_setup' }];
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    expect(said.join(' ')).toContain('Enterprise features');
  });

  it('counts only the agents it could actually resolve', async () => {
    const postready = withRcapi({
      addLivechatAgent: () => Promise.resolve(true),
      createUser: () => Promise.resolve(true),
      // agent2 resolves, agent3 does not -- the admin plus one, not plus two.
      getUserId: (_u: string, _a: unknown, username: string) =>
        Promise.resolve(username === 'agent2' ? 'id2' : null),
      setLivechatAvailable: () => Promise.resolve(true),
      saveCannedResponse: () => Promise.resolve(true),
      ensureLivechatDepartment: () => Promise.resolve(null),
      assignLivechatAgents: () => Promise.resolve(false),
    });
    const m = meta({ preset: 'livechat' });
    m.extra.post_ready = [{ action: 'livechat_setup', agents: 3 }];
    const { said, emit } = recorder();
    await postready.runPostReady(m, AUTH, emit, { sleep: noSleep });
    expect(said.join(' ')).toContain('Omnichannel: 2 agent(s) available');
    // No department was asked for, so the summary must not claim one.
    expect(said.join(' ')).not.toContain('department created');
  });
});

describe('the keycloak action reads its fields the way earlier releases do', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('keys the service and port defaults on PRESENCE, not on truthiness', async () => {
    // A field that is PRESENT is used even when it is falsy, where
    // `value || fallback` would silently substitute the default -- so a preset that
    // deliberately wrote an empty service name would reach a different container.
    jest.resetModules();
    const calls: { service: string; argv: readonly string[] }[] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExec: (_n: string, service: string, argv: readonly string[]) => {
        calls.push({ service, argv });
        return Promise.resolve(0);
      },
    }));
    const postready = require('../../src/core/postready') as typeof ModNS;
    const m = meta();
    m.extra.post_ready = [{ action: 'keycloak_master_ssl_off', service: '', port: 0 }];
    await postready.runPostReady(m, AUTH, recorder().emit, { sleep: noSleep });
    expect(calls[0]?.service).toBe('');
    expect(calls[0]?.argv[2]).toContain('http://localhost:0');
  });

  it('uses keycloak and 8080 when the fields are absent', async () => {
    jest.resetModules();
    const calls: { service: string; argv: readonly string[] }[] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExec: (_n: string, service: string, argv: readonly string[]) => {
        calls.push({ service, argv });
        return Promise.resolve(0);
      },
    }));
    const postready = require('../../src/core/postready') as typeof ModNS;
    const m = meta();
    m.extra.post_ready = [{ action: 'keycloak_master_ssl_off' }];
    await postready.runPostReady(m, AUTH, recorder().emit, { sleep: noSleep });
    expect(calls[0]?.service).toBe('keycloak');
    expect(calls[0]?.argv[2]).toContain('http://localhost:8080');
  });
});
