import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as config from '../../../src/lib/config';
import { metadata, writeRecord } from '../../../src/core/runner/record';
import { MODE_ACME, MODE_LOCAL, dnsEnvPath } from '../../../src/core/tls';

import type { Event } from '../../../src/lib/events';
import type { ClusterPlan } from '../../../src/core/kube/context';
import type { IngressEndpoint } from '../../../src/core/kube/endpoints';
import { preflight as newPreflight } from '../../../src/core/kube/tools';
import type { TlsSpec } from '../../../src/core/tls';

import { recordedLocalHost, resolveTls, tlsFromRecord } from '../../../src/core/lifecycle/tlsplan';
import type * as ExecNS from '../../../src/core/kube/exec';
import type * as TlsPlanNS from '../../../src/core/lifecycle/tlsplan';
import { createReq, kubeTls } from '../../../src/core/lifecycle/types';

describe('the HTTPS plan', () => {
  it('reads a workspace HTTPS name back out of its record as earlier releases do', async () => {
    // `down` than `up` is the documented way to bring a workspace back, and the record is
    // the only place the name survives. A local-CA hostname is read back rather than
    // re-derived, because the suffix changed with the rename and recomputing it would
    // mint a second name for a workspace whose leaf, route and ROOT_URL all say the first.
    const records: [string, string, string][] = [
      ['t-local', 'https://t-local.houston.localhost', 'local'],
      ['t-acme', 'https://rc.example.com/some/path', 'acme'],
      ['t-none', 'https://rc.example.com', ''],
      ['t-nourl', '', 'local'],
    ];
    for (const [name, publicUrl, tls] of records) {
      await writeRecord(
        name,
        metadata({ name, project: `houston-${name}`, publicUrl, extra: tls ? { tls } : {} }),
      );
    }
    // What earlier releases read back out of the same records, and for a missing one, recorded.
    const recorded: { from_record: ([boolean, string] | null)[]; local_host: string[] } = {
      from_record: [[true, ''], [false, 'rc.example.com'], null, null, null],
      local_host: ['t-local.houston.localhost', '', '', '', ''],
    };
    const names = [...records.map(([name]) => name), 't-missing'];
    const restored = await Promise.all(names.map((name) => tlsFromRecord(name)));
    expect(restored.map((value) => (value === null ? null : [...value]))).toEqual(
      recorded.from_record,
    );
    expect(await Promise.all(names.map((name) => recordedLocalHost(name)))).toEqual(
      recorded.local_host,
    );
  });

  it('resolves the two HTTPS modes without touching a container', async () => {
    // A workspace never terminates TLS, so a plan is a NAME and a certificate source --
    // nothing here starts anything. `--domain` without an email refuses with the exact
    // sentence earlier releases print; `--https` alone is the local-CA mode.
    const local = await resolveTls(
      createReq({ version: '8.5.1', https: true }),
      'restore-me',
      '127.0.0.1',
    );
    expect(local?.mode).toBe(MODE_LOCAL);
    expect(local?.host).toBe('restore-me.houston.localhost');
    expect(local?.port).toBe(443);

    await expect(
      resolveTls(createReq({ version: '8.5.1', domain: 'rc.example.com' }), 'd', '127.0.0.1'),
    ).rejects.toThrow(/needs a contact email/);

    const acme = await resolveTls(
      createReq({ version: '8.5.1', domain: 'rc.example.com', acmeEmail: 'ops@example.com' }),
      'd',
      '127.0.0.1',
    );
    expect(acme?.mode).toBe(MODE_ACME);
    expect(acme?.host).toBe('rc.example.com');
    expect(acme?.acmeEmail).toBe('ops@example.com');
  });

  it('restores the mode a record already holds when no flag asks for one', async () => {
    // The email is remembered in the BOX config, not the workspace record: `--domain`
    // only needs it on the first run, and the restore path reads the same config key.
    config.updateConfig((cfg) => {
      cfg.acme_email = 'ops@example.com';
    });
    await writeRecord(
      'restore-me',
      metadata({
        name: 'restore-me',
        project: 'houston-restore-me',
        publicUrl: 'https://rc.example.com',
        extra: { tls: 'acme', tls_email: 'ops@example.com' },
      }),
    );
    const restored = await resolveTls(createReq({ version: '8.5.1' }), 'restore-me', '127.0.0.1');
    expect(restored?.mode).toBe(MODE_ACME);
    expect(restored?.host).toBe('rc.example.com');
  });
});

describe('a remembered credential that is falsy', () => {
  it('does not satisfy the ACME contact-email requirement', async () => {
    // `acme_email: false` in config is not an address, and `String(false)` is the truthy
    // word "false". Earlier releases read it as no address and refuse here; so must this.
    config.updateConfig((cfg) => {
      cfg.acme_email = false;
    });
    // The refusal earlier releases raised over the same config, recorded.
    const recorded = {
      kind: 'ValidationError',
      message:
        "a Let's Encrypt certificate needs a contact email:\n  houston up ... --domain rc.example.com --email you@example.com\nIt is remembered after the first use, or set it once with:\n  houston config set acme.email you@example.com",
    };
    let ours: { kind: string; message: string } | null = null;
    try {
      await resolveTls(createReq({ version: '8.5.1', domain: 'rc.example.com' }), 'd', '127.0.0.1');
    } catch (error) {
      ours = { kind: (error as Error).constructor.name, message: (error as Error).message };
    }
    expect(ours).toEqual(recorded);
    expect(ours?.message).toContain('needs a contact email');
  });
});

const K3S_ENDPOINT: IngressEndpoint = {
  address: '172.16.0.2',
  port: 443,
  source: 'loadbalancer',
  service: 'kube-system/traefik',
  local: true,
};

function localSpec(host = 'ws.houston.localhost'): TlsSpec {
  return { mode: MODE_LOCAL, host, port: 443, acmeEmail: '', acmeStaging: false } as TlsSpec;
}

const DOCTORED = [
  'node:dns/promises',
  '../../../src/core/kube/probe',
  '../../../src/core/kube/ingress',
  '../../../src/core/kube/certmanager',
  '../../../src/core/kube/endpoints',
  '../../../src/core/kube/cluster',
  '../../../src/core/kube/exec',
  '../../../src/core/edge/engine',
  '../../../src/core/edge/spec',
  '../../../src/core/edge/runtime',
  '../../../src/core/edge/routes',
  '../../../src/core/tls',
];

describe('the Kubernetes HTTPS plan', () => {
  afterEach(() => {
    for (const id of DOCTORED) jest.dontMock(id);
    jest.resetModules();
  });

  /**
   * What the resolver answers for each name. Earlier releases' test asked the REAL resolver; a
   * DNS query is a network reach this suite refuses, so the answers are stated -- which
   * keeps the decision under test and drops only "this machine's resolver agrees".
   */
  function resolver(answers: Record<string, string[] | null>): void {
    jest.doMock('node:dns/promises', () => ({
      ...jest.requireActual('node:dns/promises'),
      lookup: async (host: string) => {
        const found = answers[host];
        if (found === undefined || found === null) {
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
        }
        return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
      },
    }));
  }

  /** Stub the cluster reads `kubernetesTlsPlan` makes. Nothing runs kubectl. */
  function clusterWith({
    ingress = ['traefik'],
    claims = [] as number[],
    ingressClass,
    made = [] as string[],
    certManager = [] as string[],
  }: {
    ingress?: string[];
    claims?: number[];
    ingressClass?: string;
    made?: string[];
    certManager?: string[];
  } = {}): typeof TlsPlanNS {
    jest.doMock('../../../src/core/kube/probe', () => ({
      ...jest.requireActual('../../../src/core/kube/probe'),
      preflight: async () =>
        newPreflight({
          context: 'default',
          clusterReachable: true,
          ingressClasses: [...ingress],
          distribution: 'k3s',
        }),
    }));
    jest.doMock('../../../src/core/kube/ingress', () => ({
      ...jest.requireActual('../../../src/core/kube/ingress'),
      ensureIngress: async () => ingressClass ?? ingress[0] ?? 'traefik',
    }));
    jest.doMock('../../../src/core/kube/certmanager', () => ({
      ...jest.requireActual('../../../src/core/kube/certmanager'),
      ensureCertManager: async ({ context }: { context: string }) => {
        certManager.push(context);
      },
    }));
    jest.doMock('../../../src/core/kube/endpoints', () => ({
      ...jest.requireActual('../../../src/core/kube/endpoints'),
      ingressEndpoint: async () => ({ ...K3S_ENDPOINT }),
      hostPortClaim: async (context: string) =>
        claims.length > 0
          ? { context, service: 'kube-system/traefik', address: '172.16.0.2', ports: [...claims] }
          : null,
    }));
    // A local k3s's kubeconfig names its API server on loopback, which is what makes it
    // "on this machine" for the CA key (`isLocalCluster`).
    jest.doMock('../../../src/core/kube/exec', () => {
      const real = jest.requireActual('../../../src/core/kube/exec') as typeof ExecNS;
      return {
        ...real,
        kube: {
          ...real.kube,
          run: async (argv: readonly string[]) => ({
            argv,
            returncode: argv.includes('config') ? 0 : 1,
            stdout: argv.includes('config') ? 'https://127.0.0.1:6443' : '',
            stderr: '',
          }),
        },
      };
    });
    jest.doMock('../../../src/core/kube/cluster', () => ({
      ...jest.requireActual('../../../src/core/kube/cluster'),
      ensureKubeconfig: async (plan: ClusterPlan) => {
        made.push(plan.context);
        return 'default';
      },
    }));
    return require('../../../src/core/lifecycle/tlsplan') as typeof TlsPlanNS;
  }

  const existing: ClusterPlan = { context: 'default', distribution: 'k3s', create: false };

  it('does not count a loopback name as reached by a cluster on a host address', async () => {
    // `*.houston.localhost` is loopback by construction and a ServiceLB address is not --
    // the pairing that produced a 404 from a URL the create had just printed as ready.
    jest.resetModules();
    resolver({
      'ws.houston.localhost': ['::1', '127.0.0.1'],
      localhost: ['127.0.0.1'],
      'elsewhere.example': ['10.9.9.9'],
    });
    const { nameReaches } = require('../../../src/core/lifecycle/tlsplan') as typeof TlsPlanNS;
    const claim = { address: '172.16.0.2', ports: [80, 443] };
    // The stated resolver is the one asked: a real one cannot answer this name at all,
    // and "cannot answer" reads as true.
    expect(await nameReaches('elsewhere.example', claim)).toBe(false);
    expect(await nameReaches('ws.houston.localhost', claim)).toBe(false);
    expect(await nameReaches('localhost', claim)).toBe(false);
    // Unresolvable is NOT a mismatch: a `--domain` whose DNS has not propagated is the
    // normal state of a name being set up.
    expect(await nameReaches('no-such-host.invalid', claim)).toBe(true);
    // A claim with no address cannot be reached by anything.
    expect(await nameReaches('localhost', { address: '' })).toBe(false);
  });

  it('adopts the ingress a cluster has, installs one where it has none, and makes the cluster first', async () => {
    // The ingress controller is what a support case is usually about, so a cluster running
    // nginx keeps nginx. This replaced a blanket refusal, and the `plan.create` refusal
    // with it: a cluster that does not exist yet is created and filled in.
    jest.resetModules();
    let tlsplan = clusterWith({ ingress: ['traefik'] });
    const req = createReq({ version: '8.5.1', https: true });
    expect((await tlsplan.kubernetesTlsPlan(req, localSpec(), existing)).ingressClass).toBe(
      'traefik',
    );
    // Had none: the plan uses what was INSTALLED, not what the earlier probe saw -- the
    // class is a separate object that appears a moment behind the release.
    jest.resetModules();
    const made: string[] = [];
    tlsplan = clusterWith({ ingress: [], ingressClass: 'nginx', made });
    expect((await tlsplan.kubernetesTlsPlan(req, localSpec(), existing)).ingressClass).toBe(
      'nginx',
    );
    expect(made).toEqual([]);
    // A cluster that does not exist yet is created, not refused, and probed after.
    const unmade: ClusterPlan = { context: 'default', distribution: 'kind', create: true };
    expect((await tlsplan.kubernetesTlsPlan(req, localSpec(), unmade)).ingressClass).toBe('nginx');
    expect(made).toEqual(['default']);
    // cert-manager is installed, not demanded: the guide lists it AND gives the command.
    jest.resetModules();
    const certManager: string[] = [];
    tlsplan = clusterWith({ certManager });
    await tlsplan.kubernetesTlsPlan(
      createReq({ version: '8.5.1', domain: 'a.example.com' }),
      {
        mode: MODE_ACME,
        host: 'a.example.com',
        port: 443,
        acmeEmail: 'ops@example.com',
        acmeStaging: false,
      } as TlsSpec,
      existing,
    );
    expect(certManager).toEqual(['default']);
  });

  it('reports whether the cluster already owns :443 FOR THIS NAME', async () => {
    // k3s ServiceLB claims host :80/:443 by hostPort DNAT, so the name reaches the ingress
    // with no edge. But holding :443 is not being where the hostname points: ServiceLB
    // claims 172.16.0.2 while `<name>.houston.localhost` is loopback, and the EDGE answers
    // there -- so the https URL returned 404. Both directions are pinned.
    const req = createReq({ version: '8.5.1', https: true });
    jest.resetModules();
    resolver({ 'ws.houston.localhost': ['172.16.0.2'] });
    let tlsplan = clusterWith({ claims: [80, 443] });
    const owned = await tlsplan.kubernetesTlsPlan(req, localSpec(), existing);
    expect(owned.clusterOwns443).toBe(true);
    expect(owned.ingressClass).toBe('traefik');
    expect(`${owned.endpoint.address}:${String(owned.endpoint.port)}`).toBe('172.16.0.2:443');

    // Same claim, but the name resolves elsewhere: through the edge.
    jest.resetModules();
    resolver({ 'ws.houston.localhost': ['127.0.0.1'] });
    tlsplan = clusterWith({ claims: [80, 443] });
    expect((await tlsplan.kubernetesTlsPlan(req, localSpec(), existing)).clusterOwns443).toBe(
      false,
    );

    jest.resetModules();
    resolver({ 'ws.houston.localhost': ['172.16.0.2'] });
    tlsplan = clusterWith({ claims: [] });
    expect((await tlsplan.kubernetesTlsPlan(req, localSpec(), existing)).clusterOwns443).toBe(
      false,
    );
  });

  it('starts the edge for a name only when the cluster does not own :443', async () => {
    // With ServiceLB holding :80/:443 the name reaches the ingress directly, and starting
    // an edge would take the port from the thing already serving it.
    jest.resetModules();
    const starts: string[] = [];
    jest.doMock('../../../src/core/edge/engine', () => ({
      ...jest.requireActual('../../../src/core/edge/engine'),
      running: async () => false,
      portHolder: async () => '',
    }));
    jest.doMock('../../../src/core/edge/spec', () => ({
      ...jest.requireActual('../../../src/core/edge/spec'),
      installed: () => false,
    }));
    jest.doMock('../../../src/core/edge/runtime', () => ({
      ...jest.requireActual('../../../src/core/edge/runtime'),
      ensureRunning: async () => {
        starts.push('started');
        return { ok: true, why: '' };
      },
    }));
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual('../../../src/core/edge/routes'),
      register: async () => false,
    }));
    const { routeKubernetesName } =
      require('../../../src/core/lifecycle/tlsplan') as typeof TlsPlanNS;
    const ktls = (clusterOwns443: boolean) =>
      kubeTls({
        host: 'a.example.com',
        ingressClass: 'traefik',
        endpoint: K3S_ENDPOINT,
        clusterOwns443,
      });
    await routeKubernetesName('ws', ktls(true));
    expect(starts).toEqual([]);
    await routeKubernetesName('ws', ktls(false));
    expect(starts).toEqual(['started']);
  });

  it("routes an ACME name's http-01 challenge to the cluster's :80, on an edge rebuilt for it", async () => {
    // The edge's :80 redirected cert-manager's challenge to HTTPS, where the cluster has no
    // solver: a `--domain` workspace on a local k3s never got a certificate. The route has
    // to carry the cluster's plain-HTTP side, and an edge an earlier houston wrote has to be
    // rebuilt so its redirect yields to it.
    jest.resetModules();
    const did: string[] = [];
    let registered: Record<string, unknown> = {};
    jest.doMock('../../../src/core/edge/engine', () => ({
      ...jest.requireActual('../../../src/core/edge/engine'),
      running: async () => true,
    }));
    jest.doMock('../../../src/core/edge/spec', () => ({
      ...jest.requireActual('../../../src/core/edge/spec'),
      installed: () => true,
      rewrite: async () => {
        did.push('rewrite');
        return true;
      },
    }));
    jest.doMock('../../../src/core/edge/runtime', () => ({
      ...jest.requireActual('../../../src/core/edge/runtime'),
      ensureRunning: async () => {
        did.push('ensureRunning');
        return { ok: true, why: '' };
      },
    }));
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual('../../../src/core/edge/routes'),
      register: async (_name: string, _host: string, options: Record<string, unknown>) => {
        registered = options;
        return false;
      },
    }));
    jest.doMock('../../../src/core/kube/endpoints', () => ({
      ...jest.requireActual('../../../src/core/kube/endpoints'),
      ingressEndpoint: async (_context: string, { port = 443 }: { port?: number } = {}) => ({
        address: '172.16.0.2',
        port: port === 80 ? 31080 : 32023,
        source: 'nodeport',
        service: 'traefik/traefik',
        local: true,
      }),
    }));
    const { routeKubernetesName } =
      require('../../../src/core/lifecycle/tlsplan') as typeof TlsPlanNS;
    await routeKubernetesName(
      'ws',
      kubeTls({
        host: 'a.example.com',
        ingressClass: 'traefik',
        endpoint: K3S_ENDPOINT,
        context: 'k3s-lane',
        issuer: { mode: 'acme', acmeEmail: 'a@b.test', acmeStaging: false },
        clusterOwns443: false,
      }),
    );
    expect(registered.passthroughHttp).toBe('172.16.0.2:31080');
    expect(did).toEqual(['rewrite', 'ensureRunning']);
  });

  it('does not blame a proxy for the default certificate served before issuance', async () => {
    // An ingress controller serves its OWN default certificate for a name it has none for
    // yet, so while the ACME order runs the cluster answers with exactly the certificate
    // this check used to blame on "something in front". Observed on a cold EKS cluster:
    // the create sent the reader to `doctor` for a port conflict that did not exist.
    jest.resetModules();
    jest.doMock('../../../src/core/tls', () => ({
      ...jest.requireActual('../../../src/core/tls'),
      verify: async () => ({ serving: true, fallback: true, issuer: 'CN = TRAEFIK DEFAULT CERT' }),
    }));
    const { publishKubernetesName } =
      require('../../../src/core/lifecycle/tlsplan') as typeof TlsPlanNS;
    const ktls = kubeTls({
      host: 'x.example.com',
      ingressClass: 'traefik',
      endpoint: K3S_ENDPOINT,
      context: 'c',
      issuer: null,
    });
    const said = async (certReady: boolean): Promise<string> => {
      const lines: string[] = [];
      await publishKubernetesName('w', ktls, {
        certReady,
        emit: (event: Event) => lines.push(event.message),
        sleep: async () => undefined,
      });
      return lines.join(' ');
    };
    // NOT ISSUED YET: the ordinary case, and it must read as one.
    const early = await said(false);
    expect(early).toContain('has not issued one yet');
    expect(early).not.toContain('something in front');
    expect(early).not.toContain('houston doctor');
    // ISSUED, and the name still answers with somebody else's default certificate.
    const late = await said(true);
    expect(late).toContain('something in front is terminating TLS');
    expect(late).toContain('houston doctor');
  });

  it("judges the origin's certificate, not a CDN's, when the edge passes the name through", async () => {
    // Behind Cloudflare the name answered with Google Trust Services WE1 and the create said
    // "serving the cluster's certificate" while cert-manager had issued nothing.
    jest.resetModules();
    let origin = { serving: true, fallback: true, issuer: 'CN = TRAEFIK DEFAULT CERT' };
    jest.doMock('../../../src/core/tls', () => ({
      ...jest.requireActual('../../../src/core/tls'),
      verify: async (host: string, options: { sni?: string }) =>
        options.sni === 'x.example.com' && host === K3S_ENDPOINT.address
          ? origin
          : { serving: true, fallback: false, issuer: 'CN = WE1, O = Google Trust Services' },
    }));
    const { publishKubernetesName } =
      require('../../../src/core/lifecycle/tlsplan') as typeof TlsPlanNS;
    const ktls = kubeTls({
      host: 'x.example.com',
      ingressClass: 'traefik',
      endpoint: K3S_ENDPOINT,
      context: 'c',
      issuer: null,
      clusterOwns443: false,
    });
    const said = async (): Promise<string> => {
      const lines: string[] = [];
      await publishKubernetesName('w', ktls, {
        certReady: false,
        emit: (event: Event) => lines.push(event.message),
        sleep: async () => undefined,
      });
      return lines.join(' | ');
    };
    const early = await said();
    expect(early).toContain('has not issued one yet');
    expect(early).not.toContain("serving the cluster's certificate");
    origin = { serving: true, fallback: false, issuer: "CN = R10, O = Let's Encrypt" };
    const issued = await said();
    expect(issued).toContain("is serving the cluster's certificate (CN = R10, O = Let's Encrypt)");
    expect(issued).toContain('itself answers with CN = WE1, O = Google Trust Services');
  });

  it('proves a public certificate against the system store, and a local one against the CA', async () => {
    // houston's own CA is not involved in a Let's Encrypt claim and may not exist.
    // `tls-status` already made this distinction; the create path passed a CA file
    // unconditionally.
    jest.resetModules();
    const seen: (string | undefined)[] = [];
    jest.doMock('../../../src/core/tls', () => ({
      ...jest.requireActual('../../../src/core/tls'),
      verify: async (_host: string, options: { cafile?: string }) => {
        seen.push(options.cafile);
        return { serving: true, fallback: false, issuer: 'CN = x' };
      },
    }));
    const { publishKubernetesName } =
      require('../../../src/core/lifecycle/tlsplan') as typeof TlsPlanNS;
    const endpoint: IngressEndpoint = {
      address: '10.0.0.1',
      port: 443,
      source: 'nodeport',
      service: 'kube-system/traefik',
      local: false,
    };
    const ktls = (mode: string) =>
      kubeTls({
        host: 'a.example.com',
        ingressClass: 'traefik',
        endpoint,
        issuer: { mode, acmeEmail: 'a@b.c', acmeStaging: false },
        clusterOwns443: true,
      });
    await publishKubernetesName('w', ktls('acme'), { sleep: async () => undefined });
    expect(seen.at(-1)).toBeUndefined();
    await publishKubernetesName('w', ktls('local'), { sleep: async () => undefined });
    expect(seen.at(-1)).toMatch(/ca\.crt$/u);
  });
});

describe('choosing the ACME challenge', () => {
  // A HOME PER CASE: a dns.env left behind would switch every later case to dns-01.
  let home = '';
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.HOUSTON_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-challenge-'));
    process.env.HOUSTON_HOME = home;
  });
  afterEach(() => {
    process.env.HOUSTON_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const domainReq = () =>
    createReq({ version: '8.6.1', domain: 'rc1.example.com', acmeEmail: 'a@b.c' });

  function dnsEnv(body = 'CF_DNS_API_TOKEN=secret\n'): void {
    fs.mkdirSync(path.dirname(dnsEnvPath()), { recursive: true });
    fs.writeFileSync(dnsEnvPath(), body, 'utf8');
  }

  it('reaches staging through config only', async () => {
    // Not a flag on `up` -- but Let's Encrypt allows five failed validations per hostname
    // per hour, so a way to rehearse has to exist. `config set acme.staging` itself is
    // driven through the CLI in test/cli/handlers.test.ts.
    config.updateConfig((cfg) => {
      cfg.acme_staging = true;
    });
    expect((await resolveTls(domainReq(), 'x', ''))?.acmeStaging).toBe(true);
  });

  it('defaults to TLS-ALPN, matching the official compose', async () => {
    expect((await resolveTls(domainReq(), 'x', ''))?.acmeChallenge).toBe('tlsalpn');
  });

  it('selects dns-01 when credentials exist, and keeps the workspace on loopback', async () => {
    // The file IS the signal -- nobody creates it by accident -- and it is the only way
    // to issue behind NAT, a tunnel or a TLS-terminating proxy. dns-01 accepts no inbound
    // connection, so the workspace is never widened: these repros run admin/admin123.
    dnsEnv();
    const req = domainReq();
    const spec = await resolveTls(req, 'x', '');
    expect([spec?.acmeChallenge, spec?.acmeDnsProvider]).toEqual(['dns', 'cloudflare']);
    expect(req.bindPublic).toBe(false);
  });

  it('lets an explicit provider override inference', async () => {
    dnsEnv('SOME_UNKNOWN_THING=x\n');
    config.updateConfig((cfg) => {
      cfg.acme_dns_provider = 'exoscale';
    });
    const spec = await resolveTls(domainReq(), 'x', '');
    expect([spec?.acmeChallenge, spec?.acmeDnsProvider]).toEqual(['dns', 'exoscale']);
  });
});

describe('what the Kubernetes HTTPS plan refuses and says', () => {
  afterEach(() => {
    for (const id of DOCTORED) jest.dontMock(id);
    jest.resetModules();
  });

  /** `_kube_tls_env`: the cluster reads `kubernetesTlsPlan` makes, stated. Nothing runs kubectl. */
  function kubeTlsEnv({
    distribution = 'k3s',
    endpoint = true,
  }: { distribution?: string; endpoint?: boolean } = {}): [typeof TlsPlanNS, ClusterPlan] {
    jest.resetModules();
    jest.doMock('../../../src/core/kube/probe', () => ({
      ...jest.requireActual('../../../src/core/kube/probe'),
      preflight: async () =>
        newPreflight({
          context: 'default',
          clusterReachable: true,
          ingressClasses: ['traefik'],
          distribution,
        }),
    }));
    jest.doMock('../../../src/core/kube/ingress', () => ({
      ...jest.requireActual('../../../src/core/kube/ingress'),
      ensureIngress: async () => 'traefik',
    }));
    jest.doMock('../../../src/core/kube/certmanager', () => ({
      ...jest.requireActual('../../../src/core/kube/certmanager'),
      ensureCertManager: async () => undefined,
    }));
    jest.doMock('../../../src/core/kube/endpoints', () => ({
      ...jest.requireActual('../../../src/core/kube/endpoints'),
      ingressEndpoint: async () => (endpoint ? { ...K3S_ENDPOINT } : null),
      hostPortClaim: async () => null,
    }));
    // A local k3s's kubeconfig names its API server on loopback, which is what makes it
    // "on this machine" for the CA key (`isLocalCluster`).
    jest.doMock('../../../src/core/kube/exec', () => {
      const real = jest.requireActual('../../../src/core/kube/exec') as typeof ExecNS;
      return {
        ...real,
        kube: {
          ...real.kube,
          run: async (argv: readonly string[]) => ({
            argv,
            returncode: argv.includes('config') ? 0 : 1,
            stdout: argv.includes('config') ? 'https://127.0.0.1:6443' : '',
            stderr: '',
          }),
        },
      };
    });
    return [
      require('../../../src/core/lifecycle/tlsplan') as typeof TlsPlanNS,
      { context: 'default', distribution, create: false },
    ];
  }

  const acmeSpec = (): TlsSpec =>
    ({
      mode: MODE_ACME,
      host: 'a.example.com',
      port: 443,
      acmeEmail: 'ops@example.com',
      acmeStaging: false,
    }) as TlsSpec;

  it('refuses HTTPS on Kubernetes when nothing can route to the name', async () => {
    // An ingress CLASS with no reachable Service is a controller nothing outside the
    // cluster can reach: the workspace would install and the name would answer nothing.
    const [tlsplan, plan] = kubeTlsEnv({ endpoint: false });
    const refused = tlsplan.kubernetesTlsPlan(
      createReq({ version: '8.5.1', https: true }),
      localSpec(),
      plan,
    );
    await expect(refused).rejects.toMatchObject({ name: 'PreflightError' });
    await expect(refused).rejects.toThrow('no Service publishing :443');
  });

  it('takes --domain on a managed cluster that refuses --https, because no CA key leaves the box', async () => {
    const [tlsplan, plan] = kubeTlsEnv({ distribution: 'eks' });
    await expect(
      tlsplan.kubernetesTlsPlan(createReq({ version: '8.5.1', https: true }), localSpec(), plan),
    ).rejects.toMatchObject({ name: 'AuthorityGateError' });
    const ktls = await tlsplan.kubernetesTlsPlan(
      createReq({ version: '8.5.1', domain: 'a.example.com' }),
      acmeSpec(),
      plan,
    );
    expect(ktls.issuer?.mode).toBe('acme');
  });

  it('says nothing about credentials when a public name is created, and still explains http-01', async () => {
    // The warning that used to fire here repeated the summary panel two lines later; a
    // generated per-workspace password removed the condition it existed to report.
    const [tlsplan, plan] = kubeTlsEnv();
    const said: string[] = [];
    await tlsplan.kubernetesTlsPlan(
      createReq({ version: '8.5.1', name: 'pub', domain: 'a.example.com' }),
      acmeSpec(),
      plan,
      { emit: (event: Event) => said.push(`${event.level}:${event.message}`) },
    );
    const joined = said.join('\n');
    for (const gone of [
      'reachable by anyone who can resolve it',
      'admin password is GENERATED',
      'admin123',
      'username as their password',
      '--volumes when you are',
    ]) {
      expect({ gone, said: joined.includes(gone) }).toEqual({ gone, said: false });
    }
    expect(joined).toContain('http-01 challenge');
  });
});

describe('what the HTTPS plan leaves to the operator', () => {
  let home = '';
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.HOUSTON_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-tlsplan-'));
    process.env.HOUSTON_HOME = home;
  });
  afterEach(() => {
    process.env.HOUSTON_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('refuses a dns.env naming no provider it knows, rather than silently falling back', async () => {
    // Falling back to tlsalpn would ignore a file the user deliberately created.
    fs.mkdirSync(path.dirname(dnsEnvPath()), { recursive: true });
    fs.writeFileSync(dnsEnvPath(), 'SOME_UNKNOWN_THING=x\n', 'utf8');
    const refused = resolveTls(
      createReq({ version: '8.6.1', domain: 'rc1.example.com', acmeEmail: 'a@b.c' }),
      'x',
      '',
    );
    await expect(refused).rejects.toMatchObject({ name: 'ValidationError' });
    await expect(refused).rejects.toThrow('config set acme.dns_provider');
  });

  it('puts no reachability guess between a name and its certificate', async () => {
    // How traffic reaches this host is the operator's business: this process cannot see
    // a tunnel, a port-forward or a firewall, so the probes that guessed are gone.
    const tls = jest.requireActual<Record<string, unknown>>('../../../src/core/tls');
    for (const probe of [
      'dnsPreflight',
      'reachabilityGaps',
      'resolvesTo',
      'hostHasPublicAddress',
    ]) {
      expect({ probe, present: probe in tls }).toEqual({ probe, present: false });
    }
    const spec = await resolveTls(
      createReq({ version: '8.6.1', domain: 'nowhere.invalid', acmeEmail: 'a@b.c' }),
      'x',
      '',
    );
    expect(spec?.mode).toBe(MODE_ACME);
  });
});

describe('the ACME challenge a workspace asks for', () => {
  it('honours `config set acme.challenge`, as the edge `serve` builds does', () => {
    // `up --domain` ignored the override and asked for TLS-ALPN, which cannot pass a tunnel or
    // a proxy that terminates TLS in front: on a box behind Cloudflare the first certificate
    // failed ("Cannot negotiate ALPN protocol"), seen live, while `serve --domain` used http-01.
    const { pickChallenge } = require('../../../src/core/lifecycle/tlsplan') as typeof TlsPlanNS;
    const chosen = (cfg: Record<string, unknown>) => {
      const req = createReq({ version: '8.5.1', domain: 'rc.example.com' });
      pickChallenge(req, cfg);
      return req.acmeChallenge;
    };
    expect([
      chosen({ acme_challenge: 'http' }),
      chosen({ acme_challenge: ' HTTP ' }),
      chosen({}),
    ]).toEqual(['http', 'http', 'tlsalpn']);
  });
});

describe("the Let's Encrypt contact email", () => {
  it('is remembered after the first use, so bringing a workspace back needs no --email', async () => {
    // The refusal and --email's help both say so, but only `serve` wrote it: `up --name X`
    // after `down` on an HTTPS workspace was refused for want of an email, seen live on k3s.
    config.updateConfig((cfg) => {
      delete cfg.acme_email;
    });
    await resolveTls(
      createReq({ version: '8.5.1', domain: 'again.example.com', acmeEmail: 'first@example.com' }),
      'again',
      '127.0.0.1',
    );
    const back = await resolveTls(
      createReq({ version: '8.5.1', domain: 'again.example.com' }),
      'again',
      '127.0.0.1',
    );
    expect(back?.acmeEmail).toBe('first@example.com');
  });
});
