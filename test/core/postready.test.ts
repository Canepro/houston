import * as path from 'node:path';

import type { Event } from '../../src/lib/events';

import { metadata, type Metadata } from '../../src/core/runner/record';
import { KUBERNETES, stamp } from '../../src/core/topology';
import { Interrupted } from '../../src/seams/exec';

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
  jest.doMock('../../src/core/rcapi', () => ({
    getSetting: async () => 'keycloak',
    samlProviderState: async () => 'unloaded',
    ...answers,
  }));
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

  it("keeps Keycloak's login chatter off houston's stderr", async () => {
    // kcadm's "Logging into http://localhost:8080 as user admin of realm master" is on
    // stderr, which a Docker exec shares with houston: it landed under `up --json` and on
    // serve's console.
    const scripts: string[] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExec: (_name: string, _service: string, argv: string[]) => {
        scripts.push(argv.join(' '));
        return Promise.resolve(0);
      },
    }));
    const postready = withRcapi(rcapiAnswering(true));
    const m = meta();
    m.extra.post_ready = [{ action: 'keycloak_master_ssl_off' }];
    await postready.runPostReady(m, AUTH, recorder().emit, { sleep: noSleep });
    expect(scripts.join('\n')).toMatch(/config credentials [^&]*>\/dev\/null 2>&1 &&/u);
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

describe('a SAML provider refreshed after a restart', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/rcapi');
    jest.resetModules();
  });

  function samlMeta(instances = 1): Metadata {
    const m = meta({
      rootUrl: 'http://localhost:3600',
      hostPort: 3600,
      extra: { instances },
    });
    m.extra.post_ready = [
      {
        action: 'saml_idp_cert',
        descriptor_url: 'http://localhost:8081/descriptor',
        setting: 'SAML_Custom_Default_cert',
        enable_setting: 'SAML_Custom_Default',
      },
    ];
    return m;
  }

  it('keeps an unchanged healthy SAML provider loaded without writing settings again', async () => {
    const setSetting = jest.fn(async () => true);
    const observed = new Map<string, number>();
    const pauses: number[] = [];
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      getSetting: async (_root: string, _auth: unknown, _pw: string, setting: string) =>
        setting === 'SAML_Custom_Default_cert' ? 'CERT' : 'keycloak',
      setSetting,
      samlProviderReady: async (root: string) => {
        observed.set(root, (observed.get(root) ?? 0) + 1);
        return true;
      },
    });
    const { said, emit } = recorder();
    expect(
      await postready.runPostReady(samlMeta(2), AUTH, emit, {
        sleep: async (seconds) => {
          pauses.push(seconds);
        },
      }),
    ).toEqual([]);
    expect(setSetting).not.toHaveBeenCalled();
    expect(pauses).toEqual([3]);
    expect([...observed.entries()].sort()).toEqual([
      ['http://localhost:3600', 2],
      ['http://localhost:3601', 2],
      ['http://localhost:3602', 2],
    ]);
    expect(said.join(' ')).toContain('SAML login button registered');
  });

  it('says the certificate is already in place, not applied, when nothing was written', async () => {
    // A healthy `ready` said "IdP cert applied" while every SAML setting kept its
    // `_updatedAt`: nothing had been applied.
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      getSetting: async (_root: string, _auth: unknown, _pw: string, setting: string) =>
        setting === 'SAML_Custom_Default_cert' ? 'CERT' : 'keycloak',
      setSetting: async () => true,
      samlProviderReady: async () => true,
    });
    const { said, emit } = recorder();
    await postready.runPostReady(samlMeta(), AUTH, emit, { sleep: noSleep });
    expect(said).toContain('IdP cert already in place; SAML login button registered.');
    expect(said.join(' ')).not.toContain('IdP cert applied');
  });

  it('waits for unchanged SAML settings to finish initial registration without toggling them', async () => {
    let elapsed = 0;
    const setSetting = jest.fn(async () => true);
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      getSetting: async (_root: string, _auth: unknown, _pw: string, setting: string) =>
        setting === 'SAML_Custom_Default_cert' ? 'CERT' : 'keycloak',
      setSetting,
      samlProviderReady: async (root: string) => root !== 'http://localhost:3602' || elapsed >= 6,
    });
    expect(
      await postready.runPostReady(samlMeta(2), AUTH, recorder().emit, {
        sleep: async (seconds) => {
          elapsed += seconds;
        },
      }),
    ).toEqual([]);
    // The slow process answers missing-provider redirects while its initial load is
    // pending. Two loaded observations are required after it finishes at six seconds.
    expect(elapsed).toBe(9);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it.each(['missing', 'late-loaded'])(
    'bounds unchanged SAML observation by wall time when the provider is %s',
    async (state) => {
      let clock = 0;
      let repaired = false;
      let firstWriteAt: number | undefined;
      const timeouts: number[] = [];
      const postready = withRcapi({
        fetchSamlIdpCert: async () => 'CERT',
        getSetting: async (_root: string, _auth: unknown, _pw: string, setting: string) =>
          setting === 'SAML_Custom_Default_cert' ? 'CERT' : 'keycloak',
        setSetting: async (
          _root: string,
          _auth: unknown,
          _pw: string,
          setting: string,
          value: unknown,
        ) => {
          firstWriteAt ??= clock;
          if (setting === 'SAML_Custom_Default' && value === true) repaired = true;
          return true;
        },
        samlProviderReady: async (_root: string, { timeoutMs = 3_000 } = {}) => {
          if (repaired) return true;
          timeouts.push(timeoutMs);
          const began = clock;
          // Two slow requests consume real observation time, rather than only the
          // polling sleeps. The last pair must fit the remaining one-second budget.
          clock += Math.min(5_000, timeoutMs * 2);
          return state === 'late-loaded' && began >= 24_000;
        },
      });
      const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        expect(
          await postready.runPostReady(samlMeta(), AUTH, recorder().emit, {
            sleep: async (seconds) => {
              clock += seconds * 1000;
            },
          }),
        ).toEqual([]);
      } finally {
        now.mockRestore();
      }
      expect(firstWriteAt).toBe(33_000);
      expect(timeouts).toEqual([3_000, 3_000, 3_000, 3_000, 500]);
    },
  );

  it('reloads an unchanged certificate when a replica loses its loaded provider', async () => {
    const writes: unknown[] = [];
    let observation = 0;
    let repaired = false;
    let elapsed = 0;
    let firstWriteAt: number | undefined;
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      getSetting: async (_root: string, _auth: unknown, _pw: string, setting: string) =>
        setting === 'SAML_Custom_Default_cert' ? 'CERT' : 'keycloak',
      setSetting: async (
        _root: string,
        _auth: unknown,
        _pw: string,
        setting: string,
        value: unknown,
      ) => {
        firstWriteAt ??= elapsed;
        if (setting === 'SAML_Custom_Default') writes.push(value);
        if (setting === 'SAML_Custom_Default' && value === true) repaired = true;
        return true;
      },
      // The first observation succeeds, but a replica then remains absent until a
      // real reload repairs it. Waiting is bounded and cannot silently certify it.
      samlProviderReady: async (root: string) => {
        observation += 1;
        return root !== 'http://localhost:3602' || observation <= 3 || repaired;
      },
    });
    expect(
      await postready.runPostReady(samlMeta(2), AUTH, recorder().emit, {
        sleep: async (seconds) => {
          elapsed += seconds;
        },
      }),
    ).toEqual([]);
    expect(firstWriteAt).toBe(33);
    expect(writes).toEqual([false, false, false, true, true, true]);
  });

  it.each([false, true])(
    'reports a refused enable-setting write (%s) instead of registration',
    async (refused) => {
      const postready = withRcapi({
        fetchSamlIdpCert: async () => 'CERT',
        setSetting: async (
          _url: string,
          _auth: unknown,
          _pw: string,
          setting: string,
          value: unknown,
        ) => setting !== 'SAML_Custom_Default' || value !== refused,
        samlProviderReady: async () => true,
      });
      const { said, emit } = recorder();
      expect(await postready.runPostReady(samlMeta(), AUTH, emit, { sleep: noSleep })).toEqual([
        'saml_idp_cert',
      ]);
      expect(said.join(' ')).not.toContain('SAML login button registered');
      expect(said.join(' ')).toContain('SAML_Custom_Default');
    },
  );

  it('does not claim registration while the service list remains empty', async () => {
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      setSetting: async () => true,
      samlProviderReady: async () => false,
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(samlMeta(), AUTH, emit, { sleep: noSleep })).toEqual([
      'saml_idp_cert',
    ]);
    expect(said.join(' ')).toContain('did not register on every instance');
    expect(said.join(' ')).not.toContain('SAML login button registered');
  });

  it('lets the disabled provider reload before enabling it, then observes the registration', async () => {
    let disabledAt = 0;
    let elapsed = 0;
    let registered = false;
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      setSetting: async (
        _url: string,
        _auth: unknown,
        _pw: string,
        setting: string,
        value: unknown,
      ) => {
        if (setting === 'SAML_Custom_Default' && value === false) disabledAt = elapsed;
        if (setting === 'SAML_Custom_Default' && value === true) {
          // Rocket.Chat debounces SAML reloads for two seconds; the previous one-second
          // transition could leave a replica completing its disabled reload later.
          registered = elapsed - disabledAt > 2;
        }
        return true;
      },
      samlProviderReady: async () => registered,
    });
    const sleep = async (seconds: number) => {
      elapsed += seconds;
    };
    expect(await postready.runPostReady(samlMeta(), AUTH, recorder().emit, { sleep })).toEqual([]);
    expect(registered).toBe(true);
  });

  it('refreshes each replica cache and waits for its own SAML provider to load', async () => {
    const writes: { root: string; setting: string; value: unknown }[] = [];
    const observed = new Map<string, number>();
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      setSetting: async (
        root: string,
        _auth: unknown,
        _pw: string,
        setting: string,
        value: unknown,
      ) => {
        writes.push({ root, setting, value });
        return true;
      },
      samlProviderReady: async (root: string) => {
        const attempt = (observed.get(root) ?? 0) + 1;
        observed.set(root, attempt);
        return root !== 'http://localhost:3602' || attempt > 1;
      },
    });
    expect(
      await postready.runPostReady(samlMeta(2), AUTH, recorder().emit, { sleep: noSleep }),
    ).toEqual([]);
    for (const root of [
      'http://localhost:3600',
      'http://localhost:3601',
      'http://localhost:3602',
    ]) {
      expect(writes).toContainEqual({ root, setting: 'SAML_Custom_Default_cert', value: 'CERT' });
      expect(writes).toContainEqual({ root, setting: 'SAML_Custom_Default', value: false });
      expect(writes).toContainEqual({ root, setting: 'SAML_Custom_Default', value: true });
      expect(observed.get(root)).toBeGreaterThanOrEqual(2);
    }
  });

  it('waits for a slower replica to unload before re-enabling the shared SAML service', async () => {
    let elapsed = 0;
    let disabled = false;
    let enabledTooSoon = false;
    const observed = new Set<string>();
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      setSetting: async (
        _root: string,
        _auth: unknown,
        _pw: string,
        setting: string,
        value: unknown,
      ) => {
        if (setting === 'SAML_Custom_Default' && value === false) disabled = true;
        if (setting === 'SAML_Custom_Default' && value === true) {
          enabledTooSoon ||= elapsed < 9;
          disabled = false;
        }
        return true;
      },
      samlProviderState: async (root: string) => {
        observed.add(root);
        return disabled && (root !== 'http://localhost:3602' || elapsed >= 6)
          ? 'unloaded'
          : 'loaded';
      },
      samlProviderReady: async () => !disabled && !enabledTooSoon,
    });
    const { said, emit } = recorder();
    expect(
      await postready.runPostReady(samlMeta(2), AUTH, emit, {
        sleep: async (seconds) => {
          elapsed += seconds;
        },
      }),
    ).toEqual([]);
    expect(enabledTooSoon).toBe(false);
    expect([...observed].sort()).toEqual([
      'http://localhost:3600',
      'http://localhost:3601',
      'http://localhost:3602',
    ]);
    expect(said.join(' ')).toContain('SAML login button registered');
  });

  it('does not treat an unreachable replica as unloaded, and restores enablement on timeout', async () => {
    const writes: unknown[] = [];
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      setSetting: async (
        _root: string,
        _auth: unknown,
        _pw: string,
        setting: string,
        value: unknown,
      ) => {
        if (setting === 'SAML_Custom_Default') writes.push(value);
        return true;
      },
      samlProviderState: async () => 'unknown',
      samlProviderReady: async () => true,
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(samlMeta(), AUTH, emit, { sleep: noSleep })).toEqual([
      'saml_idp_cert',
    ]);
    expect(writes).toEqual([false, true]);
    expect(said.join(' ')).toContain('reload did not finish disabling on every instance');
    expect(said.join(' ')).not.toContain('SAML login button registered');
  });

  it('restores SAML enablement after one replica refuses the disable write', async () => {
    const enabled: string[] = [];
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      setSetting: async (
        root: string,
        _auth: unknown,
        _pw: string,
        setting: string,
        value: unknown,
      ) => {
        if (setting === 'SAML_Custom_Default' && value === true) enabled.push(root);
        return setting !== 'SAML_Custom_Default' || value !== false || !root.endsWith(':3602');
      },
    });
    expect(
      await postready.runPostReady(samlMeta(2), AUTH, recorder().emit, { sleep: noSleep }),
    ).toEqual(['saml_idp_cert']);
    expect(enabled.sort()).toEqual([
      'http://localhost:3600',
      'http://localhost:3601',
      'http://localhost:3602',
    ]);
  });

  it.each(['observation', 'cancellation'])(
    'restores SAML enablement when %s interrupts the unload wait',
    async (failure) => {
      const problem = failure === 'cancellation' ? new Interrupted() : new Error('probe failed');
      const writes: unknown[] = [];
      const postready = withRcapi({
        fetchSamlIdpCert: async () => 'CERT',
        setSetting: async (
          _root: string,
          _auth: unknown,
          _pw: string,
          setting: string,
          value: unknown,
        ) => {
          if (setting === 'SAML_Custom_Default') writes.push(value);
          return true;
        },
        samlProviderState: async () => {
          if (failure === 'observation') throw problem;
          return 'loaded';
        },
      });
      await expect(
        postready.runPostReady(samlMeta(), AUTH, recorder().emit, {
          sleep: async () => {
            throw problem;
          },
        }),
      ).rejects.toBe(problem);
      expect(writes).toEqual([false, true]);
    },
  );
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

  function oidcMeta(instances = 1): Metadata {
    const m = meta({ preset: 'oidc', rootUrl: 'http://localhost:3600', hostPort: 3600 });
    m.extra.instances = instances;
    m.extra.post_ready = [
      {
        action: 'create_oauth_provider',
        name: 'Keycloak',
        settings: {
          'Accounts_OAuth_Custom-Keycloak': true,
          'Accounts_OAuth_Custom-Keycloak-url': 'http://keycloak:8085/realms/houston',
          'Accounts_OAuth_Custom-Keycloak-show_button': true,
        },
      },
    ];
    return m;
  }

  const registered = () =>
    Promise.resolve<[number, string]>([
      200,
      JSON.stringify({ success: true, configurations: [{ service: 'keycloak' }] }),
    ]);

  it('sets the URL before enabling so RC cannot poison its initial OAuth constructor', async () => {
    let url: unknown;
    let poisoned = false;
    const writes: string[] = [];
    const reads: string[] = [];
    const postready = withRcapi({
      addOauthService: async () => true,
      setSetting: async (
        _root: string,
        _auth: unknown,
        _pw: string,
        sid: string,
        value: unknown,
      ) => {
        writes.push(sid);
        if (sid.endsWith('-url')) url = value;
        if (sid === 'Accounts_OAuth_Custom-Keycloak' && value === true && typeof url !== 'string') {
          poisoned = true;
        }
        return true; // The HTTP PATCH still succeeds when RC's asynchronous loader throws.
      },
      call: async (root: string) => {
        reads.push(root);
        return [200, JSON.stringify({ configurations: poisoned ? [] : [{ service: 'keycloak' }] })];
      },
    });
    expect(
      await postready.runPostReady(oidcMeta(2), AUTH, recorder().emit, { sleep: noSleep }),
    ).toEqual([]);
    expect(poisoned).toBe(false);
    expect(writes).toEqual([
      'Accounts_OAuth_Custom-Keycloak-url',
      'Accounts_OAuth_Custom-Keycloak-show_button',
      'Accounts_OAuth_Custom-Keycloak',
    ]);
    expect(reads).toEqual([
      'http://localhost:3600',
      'http://localhost:3601',
      'http://localhost:3602',
    ]);
  });

  it('leaves a new provider disabled when its configuration was refused', async () => {
    const writes: string[] = [];
    const postready = withRcapi({
      addOauthService: async () => true,
      setSetting: async (_root: string, _auth: unknown, _pw: string, sid: string) => {
        writes.push(sid);
        return !sid.endsWith('-url');
      },
      call: () => {
        throw new Error('it observed an incompletely configured provider');
      },
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(oidcMeta(), AUTH, emit, { sleep: noSleep })).toEqual([
      'create_oauth_provider',
    ]);
    expect(writes).not.toContain('Accounts_OAuth_Custom-Keycloak');
    expect(said.join(' ')).toContain('partly configured');
    expect(said.join(' ')).not.toContain('login button registered');
  });

  it('names an enable refusal without retrying or reporting a registered button', async () => {
    const writes: string[] = [];
    const postready = withRcapi({
      addOauthService: async () => true,
      setSetting: async (_root: string, _auth: unknown, _pw: string, sid: string) => {
        writes.push(sid);
        return sid !== 'Accounts_OAuth_Custom-Keycloak';
      },
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(oidcMeta(), AUTH, emit, { sleep: noSleep })).toEqual([
      'create_oauth_provider',
    ]);
    expect(writes.filter((sid) => sid === 'Accounts_OAuth_Custom-Keycloak')).toHaveLength(1);
    expect(said.join(' ')).toContain('Accounts_OAuth_Custom-Keycloak');
    expect(said.join(' ')).not.toContain('login button registered');
  });

  it('waits for every replica registration without repeating the enable write', async () => {
    let observations = 0;
    const writes: unknown[] = [];
    const waits: number[] = [];
    const postready = withRcapi({
      addOauthService: async () => true,
      setSetting: async (
        _root: string,
        _auth: unknown,
        _pw: string,
        sid: string,
        value: unknown,
      ) => {
        if (sid === 'Accounts_OAuth_Custom-Keycloak') writes.push(value);
        return true;
      },
      call: async (
        root: string,
        method: string,
        apiPath: string,
        options: { timeoutMs: number },
      ) => {
        expect(method).toBe('GET');
        expect(apiPath).toBe('/api/v1/service.configurations');
        expect(options.timeoutMs).toBeLessThanOrEqual(3000);
        observations += 1;
        if (root.endsWith('3602') && observations <= 3) return [200, '{"configurations":[]}'];
        return await registered();
      },
    });
    expect(
      await postready.runPostReady(oidcMeta(2), AUTH, recorder().emit, {
        sleep: async (seconds) => {
          waits.push(seconds);
        },
      }),
    ).toEqual([]);
    expect(observations).toBe(6);
    expect(waits).toEqual([3]);
    expect(writes).toEqual([true]);
  });

  it('reports absent or malformed registration after a bounded observation', async () => {
    let observations = 0;
    let waits = 0;
    const postready = withRcapi({
      addOauthService: async () => true,
      setSetting: async () => true,
      call: async () => {
        observations += 1;
        return observations % 2 ? [200, '{"configurations":[]}'] : [200, 'not JSON'];
      },
    });
    const { said, emit } = recorder();
    expect(
      await postready.runPostReady(oidcMeta(), AUTH, emit, {
        sleep: async () => {
          waits += 1;
        },
      }),
    ).toEqual(['create_oauth_provider']);
    expect(observations).toBe(12);
    expect(waits).toBe(11);
    expect(said.join(' ')).toContain('did not register on every instance');
    expect(said.join(' ')).toContain('partly configured');
    expect(said.join(' ')).not.toContain('login button registered');
  });

  it('does not accept registration that answers after its observation deadline', async () => {
    let now = 1000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const postready = withRcapi({
      addOauthService: async () => true,
      setSetting: async () => true,
      call: async () => {
        now += 33_001;
        return await registered();
      },
    });
    const { said, emit } = recorder();
    try {
      expect(await postready.runPostReady(oidcMeta(), AUTH, emit, { sleep: noSleep })).toEqual([
        'create_oauth_provider',
      ]);
    } finally {
      clock.mockRestore();
    }
    expect(said.join(' ')).toContain('did not register on every instance');
    expect(said.join(' ')).not.toContain('login button registered');
  });

  it('keeps a healthy repeated ready enabled throughout configuration', async () => {
    let enabled = true;
    const writes: unknown[] = [];
    const postready = withRcapi({
      addOauthService: async () => true,
      setSetting: async (
        _root: string,
        _auth: unknown,
        _pw: string,
        sid: string,
        value: unknown,
      ) => {
        expect(enabled).toBe(true);
        if (sid === 'Accounts_OAuth_Custom-Keycloak') {
          writes.push(value);
          enabled = value === true;
        }
        return true;
      },
      call: registered,
    });
    expect(
      await postready.runPostReady(oidcMeta(), AUTH, recorder().emit, { sleep: noSleep }),
    ).toEqual([]);
    expect(writes).toEqual([true]);
    expect(enabled).toBe(true);
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

describe('the e2ee test users', () => {
  afterEach(() => {
    jest.resetModules();
  });

  function e2eeMeta(): ReturnType<typeof meta> {
    const m = meta({ preset: 'e2ee' });
    m.extra.post_ready = [{ action: 'e2ee_users' }];
    return m;
  }

  it('creates e2e-alice, e2e-bob and e2e-carol, each with nothing else done for them', async () => {
    const made: string[] = [];
    const postready = withRcapi({
      createUser: (_u: string, _a: unknown, _p: string, username: string) => {
        made.push(username);
        return Promise.resolve(true);
      },
      getUserId: () => Promise.resolve(null),
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(e2eeMeta(), AUTH, emit, { sleep: noSleep })).toEqual([]);
    expect(made).toEqual(['e2e-alice', 'e2e-bob', 'e2e-carol']);
    expect(said.join(' ')).toContain('E2EE test users ready: e2e-alice, e2e-bob, e2e-carol');
  });

  it('keeps a user an earlier `ready` already made, which users.create refuses', async () => {
    const postready = withRcapi({
      createUser: (_u: string, _a: unknown, _p: string, username: string) =>
        Promise.resolve(username !== 'e2e-bob'),
      getUserId: (_u: string, _a: unknown, username: string) =>
        Promise.resolve(username === 'e2e-bob' ? 'bob-id' : null),
    });
    expect(
      await postready.runPostReady(e2eeMeta(), AUTH, recorder().emit, { sleep: noSleep }),
    ).toEqual([]);
  });

  it('is a failure naming the users that could not be made', async () => {
    const postready = withRcapi({
      createUser: (_u: string, _a: unknown, _p: string, username: string) =>
        Promise.resolve(username === 'e2e-alice'),
      getUserId: () => Promise.resolve(null),
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(e2eeMeta(), AUTH, emit, { sleep: noSleep })).toEqual([
      'e2ee_users',
    ]);
    expect(said.join(' ')).toContain('could not create the E2EE test users e2e-bob, e2e-carol');
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

describe('Keycloak under a path', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('is configured at that path, where it now answers', async () => {
    jest.resetModules();
    const seen: string[][] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExec: (_name: string, _svc: string, argv: string[]) => {
        seen.push(argv);
        return Promise.resolve(0);
      },
    }));
    const postready = require('../../src/core/postready') as typeof ModNS;
    const m = metadata({ name: 'kc', project: 'houston-kc' });
    const { emit } = recorder();
    await postready.POST_READY_ACTIONS.keycloak_master_ssl_off?.(
      m,
      { base: 'http://localhost:3000', userId: 'u', token: 't' } as never,
      { action: 'keycloak_master_ssl_off', path: '/keycloak' },
      emit,
      noSleep,
    );
    expect(seen[0]?.[2]).toContain('--server http://localhost:8080/keycloak ');
  });
});
