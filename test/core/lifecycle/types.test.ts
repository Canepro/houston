import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../../src/lib/config';
import { ConflictError, ValidationError } from '../../../src/lib/errors';
import type { Event } from '../../../src/lib/events';
import type { Resolved } from '../../../src/lib/versions';
import { register } from '../../../src/core/edge/routes';
import { metadata, writeRecord } from '../../../src/core/runner/record';
import { preflight as emptyPreflight } from '../../../src/core/kube/tools';

import type * as CreateDockerNS from '../../../src/core/lifecycle/create-docker';
import type * as CreateK8sNS from '../../../src/core/lifecycle/create-k8s';
import { deriveFor } from '../../../src/core/lifecycle/naming';
import { reqContext } from '../../../src/core/lifecycle/request';
import { resolveTls } from '../../../src/core/lifecycle/tlsplan';
import * as Types from '../../../src/core/lifecycle/types';

const ROOT = path.resolve(__dirname, '..', '..', '..');

/** The request and record vocabulary earlier releases published, recorded. */
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'core', 'lifecycle', 'types.json'),
    'utf8',
  ),
) as { constants: Record<string, unknown> };

describe('the lifecycle constants', () => {
  it('is identical to earlier releases, field for field', () => {
    // PRIVILEGED_CREATE_FIELDS must be identical to earlier releases' AND equal to what
    // `/api/settings` advertises. The rest of this module is the request and record
    // vocabulary shared with earlier releases; a drifted tuple is a state-directory
    // difference waiting for the first home an earlier release also runs in.
    const recorded = RECORDED.constants;
    const req = Types.createReq({ version: '8.5.1' });
    expect({
      privileged: [...Types.PRIVILEGED_CREATE_FIELDS],
      billable_prefixes: [...Types.BILLABLE_CONTEXT_PREFIXES],
      actions: [...Types.STATE_ACTIONS],
      essential: [...Types.ESSENTIAL_SERVICES],
      transient: [...Types.TRANSIENT_STATES],
      billable: [...Types.BILLABLE_DISTRIBUTIONS],
      name_max: 64,
      interactive_wait: Types.INTERACTIVE_LOCK_WAIT,
      browser_param: { ...Types.BROWSER_HOST_PARAM },
      loopback: [...Types.LOOPBACK_BINDS],
      unsupported: Types.KUBERNETES_UNSUPPORTED.map((row) => [...row]),
      proof_tries: Types.PUBLISH_PROOF_TRIES,
      proof_pause: Types.PUBLISH_PROOF_PAUSE,
      strikes: Types.tuning.FOREIGN_PORT_STRIKES,
      create_defaults: {
        version: req.version,
        preset: req.preset,
        name: req.name,
        port: req.port,
        root_url: req.rootUrl,
        bind: req.bind,
        rc_image: req.rcImage,
        mongo: req.mongo,
        reg_token: req.regToken,
        params: req.params,
        seed: req.seed,
        seed_here: req.seedHere,
        seed_profile: req.seedProfile,
        pin: req.pin,
        wait: req.wait,
        offline: req.offline,
        no_pull: req.noPull,
        fresh: req.fresh,
        force: req.force,
        monitor: req.monitor,
        stats: req.stats,
        runtime: req.runtime,
        deployment: req.deployment,
        replicas: req.replicas,
        context: req.context,
        mongo_operator: req.mongoOperator,
        https: req.https,
        domain: req.domain,
        acme_email: req.acmeEmail,
        acme_staging: req.acmeStaging,
        acme_challenge: req.acmeChallenge,
        acme_dns_provider: req.acmeDnsProvider,
        ingress_class: req.ingressClass,
        env: req.env,
        actor: req.actor,
        bind_public: req.bindPublic,
      },
      kernel_bad: [6, 19],
    }).toEqual(recorded);
  });

  it('names the privileged fields in the order earlier releases declare them', () => {
    // The ORDER is part of the tuple: a set equality check would pass while the
    // published list differs, and 6.14 compares this as data.
    expect([...Types.PRIVILEGED_CREATE_FIELDS]).toEqual([
      'rc_image',
      'reg_token',
      'bind',
      'context',
      // Added 2026-10-08: the GUI takes a license, under the same create policy.
      'license',
    ]);
    // `tuning` is a mutable object rather than a baked number, following `kube/names.ts`'s:
    // a test patches one property and every reader resolves it at call time.
    expect(Types.tuning.FOREIGN_PORT_STRIKES).toBe(4);
  });
});

describe('a create request', () => {
  it('gives every request its own params, so one caller cannot seed the next', () => {
    const first = Types.createReq({ version: '8.5.1' });
    expect(first.preset).toBe('default');
    expect(first.seed).toBe(false);
    expect(first.params).toEqual({});
    first.params.x = 1;
    expect(Types.createReq({ version: '8.5.1' }).params).toEqual({});
  });

  it('carries no dead TLS field, because the request is the web API schema too', () => {
    // A stale field is a stale endpoint. `acmeChallenge` and `acmeDnsProvider` survive as
    // DERIVED state -- `pickChallenge` sets them and no flag reaches them.
    const fields = Object.keys(Types.createReq({ version: '8.5.1' }));
    for (const dead of ['tlsCert', 'tlsKey', 'tlsSan', 'acmeChallengeGiven']) {
      expect({ dead, present: fields.includes(dead) }).toEqual({ dead, present: false });
    }
    for (const kept of [
      'domain',
      'acmeEmail',
      'https',
      'acmeStaging',
      'acmeChallenge',
      'acmeDnsProvider',
    ]) {
      expect({ kept, present: fields.includes(kept) }).toEqual({ kept, present: true });
    }
  });

  it('derives the lock name and the written name identically', () => {
    // create derives the name twice -- once to lock, once in the body. If the two
    // disagreed, the lock would guard a different workspace than the one written.
    for (const values of [
      { version: '8.5.1', actor: 'alice' },
      { version: '8.5.1', preset: 'ldap', actor: 'alice' },
      { version: '8.5.1', name: 'My Repro!', actor: 'alice' },
      { version: '8.5.1' },
    ]) {
      const once = deriveFor(Types.createReq(values));
      expect(deriveFor(Types.createReq(values))).toBe(once);
      expect(once).not.toBe('');
    }
  });

  it('resolves the cluster through one function both callers share', () => {
    // `willProvision` decides whether `checkCapacity` reserves a control plane's RAM;
    // `createKubernetes` decides where the workspace goes. A default applied in one and
    // not the other reserves memory for a kind cluster while building in EKS.
    expect(Types.PRIVILEGED_CREATE_FIELDS).toContain('context');
    expect(reqContext(Types.createReq({ version: '8.5.1' }))).toBe('');
    config.updateConfig((cfg) => {
      cfg[config.KUBE_CONTEXT_KEY] = 'eks-support';
    });
    // The box default applies to both front ends, not just the CLI...
    expect(reqContext(Types.createReq({ version: '8.5.1' }))).toBe('eks-support');
    // ...and an explicit --context still wins.
    expect(reqContext(Types.createReq({ version: '8.5.1', context: 'other' }))).toBe('other');
  });
});

describe('the GUI', () => {
  it('styles and filters every state the backend can report', () => {
    // `reproState` stopped flattening docker's transitional states, so they reach the
    // dashboard for real. A state the interface does not know renders with no colour and
    // lands in renderDetail's fallback branch.
    const webui = path.join(ROOT, 'data', 'webui');
    const css = fs.readFileSync(path.join(webui, 'app.css'), 'utf8');
    const html = fs.readFileSync(path.join(webui, 'index.html'), 'utf8');
    const missing: string[] = [];
    for (const state of ['running', 'stopped', 'down', 'unknown', ...Types.TRANSIENT_STATES]) {
      if (!css.includes(`.wrow[data-state="${state}"]`)) missing.push(`rail accent ${state}`);
      if (!new RegExp(`\\.wstate\\.${state}\\b`, 'u').test(css)) missing.push(`colour ${state}`);
      if (!new RegExp(`\\.pill\\.${state}\\b`, 'u').test(css)) missing.push(`pill ${state}`);
    }
    for (const state of Types.TRANSIENT_STATES) {
      if (!html.includes(`value="${state}"`)) missing.push(`filter ${state}`);
    }
    expect(Types.TRANSIENT_STATES.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});

describe('where the HTTPS name comes from', () => {
  it('says how to set the email when a domain arrives without one', async () => {
    await expect(
      resolveTls(
        Types.createReq({ version: '8.5.1', domain: 'chat.example.com' }),
        'w',
        '127.0.0.1',
      ),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.stringContaining('config set acme.email') }),
    );
    await expect(
      resolveTls(
        Types.createReq({ version: '8.5.1', domain: 'chat.example.com' }),
        'w',
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('never publishes a workspace publicly to answer a challenge', async () => {
    // TLS-ALPN used to force --domain onto 0.0.0.0 so Let's Encrypt could connect. The
    // edge answers the challenge now, so widening the bind of a repro running fixed weak
    // credentials buys nothing -- and a request that arrives already widened is narrowed.
    const req = Types.createReq({
      version: '8.5.1',
      domain: 't1.support.xyz.com',
      acmeEmail: 'ops@xyz.com',
    });
    req.bindPublic = true;
    await resolveTls(req, 'w', '127.0.0.1');
    expect(req.bindPublic).toBe(false);
  });

  it('refuses a hostname another workspace holds, and lets its owner come back', async () => {
    // Refused where BOTH runtimes pass, so neither can grow its own answer. A passthrough
    // route is planted because it is the one kind written without asking docker anything,
    // beside the record that makes `first` a workspace.
    await writeRecord('first', metadata({ name: 'first', project: 'houston-first' }));
    await register('first', 'taken.example.com', { passthrough: '10.0.0.1:443' });
    const second = Types.createReq({
      version: '8.5.1',
      name: 'second',
      domain: 'taken.example.com',
      acmeEmail: 'o@e.com',
    });
    const refused = await resolveTls(second, 'second', '127.0.0.1', 'second').then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ConflictError);
    expect(String((refused as Error).message)).toContain("already served for workspace 'first'");
    expect(String((refused as Error).message)).toContain('houston down --name first');

    const again = Types.createReq({
      version: '8.5.1',
      name: 'first',
      domain: 'taken.example.com',
      acmeEmail: 'o@e.com',
    });
    expect((await resolveTls(again, 'first', '127.0.0.1', 'first'))?.host).toBe(
      'taken.example.com',
    );
  });
});

describe('a hostname claim with no workspace behind it', () => {
  it('is released, rather than blocking the name with advice nothing can follow', async () => {
    // A route that outlived its record refused every later `up --domain`, saying `houston
    // down --name gone` -- which answered NOT_FOUND -- and `prune` could not see it either.
    await register('gone', 'orphan.example.com', { passthrough: '10.0.0.1:443' });
    const req = Types.createReq({
      version: '8.5.1',
      name: 'fresh',
      domain: 'orphan.example.com',
      acmeEmail: 'o@e.com',
    });
    expect((await resolveTls(req, 'fresh', '127.0.0.1', 'fresh'))?.host).toBe('orphan.example.com');
  });

  it('lets go of its network too, which the edge otherwise holds for ever', async () => {
    // Releasing only the route left the edge attached to the vanished workspace's network,
    // so that network could not be removed and outlived even `edge stop`.
    const detached: string[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/edge/networks', () => ({
      ...jest.requireActual('../../../src/core/edge/networks'),
      releaseVanished: async (name: string) => {
        detached.push(name);
      },
    }));
    const fresh = require('../../../src/core/lifecycle/tlsplan') as {
      resolveTls: typeof resolveTls;
    };
    await register('gone', 'orphan.example.com', { passthrough: '10.0.0.1:443' });
    const req = Types.createReq({
      version: '8.5.1',
      name: 'fresh',
      domain: 'orphan.example.com',
      acmeEmail: 'o@e.com',
    });
    await fresh.resolveTls(req, 'fresh', '127.0.0.1', 'fresh');
    expect(detached).toEqual(['gone']);
    jest.dontMock('../../../src/core/edge/networks');
    jest.resetModules();
  });
});

describe('the Kubernetes create path', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('warns about a billable cluster with no public name, and does not refuse it', async () => {
    // Warned, not refused: a refusal would remove the one way to reach a workspace whose
    // ingress is broken, exactly when somebody needs a port-forward. But on a cluster
    // billing by the hour a port-forward is a poor thing to have paid for. This reaches the
    // policy without asking this machine for RAM, a release lookup or a cluster.
    const holder = { distribution: 'eks' };
    jest.doMock('../../../src/core/lifecycle/sizing', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/sizing'),
      checkCapacity: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      pickHostPort: async () => 3000,
    }));
    jest.doMock('../../../src/lib/versions', () => ({
      ...jest.requireActual('../../../src/lib/versions'),
      resolve: (version: string): Resolved => ({
        rcVersion: version,
        rcImage: 'img',
        mongoTag: '8.0',
        mongoFlavor: 'official',
        mongoShell: 'mongosh',
        oplog: false,
        source: 'test',
        note: '',
      }),
    }));
    jest.doMock('../../../src/core/kube/probe', () => ({
      ...jest.requireActual('../../../src/core/kube/probe'),
      preflight: async () => emptyPreflight(),
    }));
    jest.doMock('../../../src/core/kube/context', () => ({
      ...jest.requireActual('../../../src/core/kube/context'),
      planCluster: async () => ({
        context: 'the-cluster',
        distribution: holder.distribution,
        create: false,
      }),
    }));
    const { createKubernetes } =
      require('../../../src/core/lifecycle/create-k8s') as typeof CreateK8sNS;
    async function warnings(values: Partial<Types.CreateReq>): Promise<string[]> {
      const seen: Event[] = [];
      // It fails later -- helm is absent here -- and the warning is what is tested.
      await createKubernetes(
        Types.createReq({
          version: '8.5.1',
          runtime: 'kubernetes',
          context: 'the-cluster',
          offline: true,
          ...values,
        }),
        (event) => seen.push(event),
      ).catch(() => undefined);
      return seen
        .filter((event) => event.level === 'warn' && event.message.includes('--domain'))
        .map((event) => event.message);
    }

    const warned = await warnings({});
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('port-forward');
    expect(warned[0]).toContain('eks');
    // The same cluster WITH a name: nothing to say.
    expect(await warnings({ domain: 'rc.example.org' })).toEqual([]);
    // And a local cluster is never warned about: it costs nothing to leave running.
    for (const local of ['kind', 'k3s']) {
      holder.distribution = local;
      expect({ local, warned: await warnings({}) }).toEqual({ local, warned: [] });
    }
  });

  it('derives the IdP host above the runtime fork, so Kubernetes gets it too', async () => {
    // It was derived below the dispatch -- on Compose and not at all on Kubernetes. Both
    // runtimes resolve the preset from `req.params`, so this is on the call site rather
    // than on either branch.
    const seen: Record<string, unknown>[] = [];
    jest.doMock('../../../src/core/lifecycle/create-k8s', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/create-k8s'),
      createKubernetes: async (req: Types.CreateReq) => {
        seen.push({ ...req.params });
        return { ok: true };
      },
    }));
    const { createReproLocked } =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    // `--domain` is the other way to say it, but this runtime refuses that flag outright,
    // so `--root-url` is the only route in. saml as well as oidc: same param, easy to wire
    // only one.
    for (const [name, preset] of [
      ['k', 'oidc'],
      ['k2', 'saml'],
    ] as const) {
      await createReproLocked(
        Types.createReq({
          version: '8.5.1',
          name,
          preset,
          runtime: 'kubernetes',
          bind: '0.0.0.0',
          rootUrl: 'http://box.example.com:3007',
        }),
      );
    }
    // Nothing invented for a plain Kubernetes workspace.
    await createReproLocked(
      Types.createReq({ version: '8.5.1', name: 'k3', preset: 'oidc', runtime: 'kubernetes' }),
    );
    expect(seen.map((params) => params.idp_host)).toEqual([
      'box.example.com',
      'box.example.com',
      undefined,
    ]);
  });
});
