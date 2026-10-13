/**
 * The edge as the create path sees it: which name a workspace gets, bringing a name back
 * after `down`, and checking a published name rather than claiming it.
 *
 * These cases sit with the edge because the edge is what they are about; the functions they
 * drive are in `core/lifecycle/`.
 *
 * Docker is replaced, the TLS probe is replaced, and each test has its own HOUSTON_HOME.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { type Event } from '../../../src/lib/events';
import { compose as composeSeam, docker as dockerSeam } from '../../../src/seams/docker-cli';
import { restoreRoute } from '../../../src/core/lifecycle/ready';
import { publishKubernetesName, resolveTls } from '../../../src/core/lifecycle/tlsplan';
import { createReq, kubeTls } from '../../../src/core/lifecycle/types';
import { metadata, readMeta, write as writeRecord } from '../../../src/core/runner/record';
import { MODE_ACME, MODE_LOCAL, rootUrl, verify, type TlsReport } from '../../../src/core/tls';

import * as paths from '../../../src/core/edge/paths';
import { registered } from '../../../src/core/edge/routes';
import { write } from '../../../src/core/edge/spec';
import { edge } from '../../../src/core/edge/types';

jest.mock('../../../src/seams/docker-cli', () => ({
  ...jest.requireActual('../../../src/seams/docker-cli'),
  docker: jest.fn(),
  compose: jest.fn(),
}));
jest.mock('../../../src/core/tls', () => ({
  ...jest.requireActual('../../../src/core/tls'),
  verify: jest.fn(),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

/** This home's edge, up and holding both ports; every other docker call answers empty. */
function runningEdge(): void {
  mocked(dockerSeam).mockImplementation((args: string[]) => {
    const joined = args.join(' ');
    let stdout = '';
    if (joined.startsWith('ps') && joined.includes('{{.ID}}')) stdout = 'c0ffee\n';
    else if (joined.includes('working_dir')) stdout = `${paths.edgeDir()}\n`;
    else if (joined.includes('NetworkSettings.Ports')) {
      stdout = '{"80/tcp":[{"HostPort":"80"}],"443/tcp":[{"HostPort":"443"}]}';
    }
    return Promise.resolve({ argv: args, exitCode: 0, signal: null, stdout, stderr: '' });
  });
}

/** A `--domain` workspace whose route a teardown removed (`_acme_workspace`). */
async function acmeWorkspace(name: string, host: string): Promise<void> {
  await writeRecord(
    name,
    'services:\n  rocketchat:\n    image: rc\n',
    metadata({
      name,
      project: `houston-${name}`,
      rcVersion: '8.5.1',
      mongoTag: '8.0',
      hostPort: 3000,
      preset: 'email',
      rootUrl: 'http://localhost:3000',
      publicUrl: `https://${host}`,
      extra: { tls: 'acme', tls_ports: [443], tls_email: 'o@e.com' },
    }),
  );
}

function report(values: Partial<TlsReport>): TlsReport {
  return {
    host: 'ws.houston.localhost',
    port: 443,
    serving: false,
    trusted: false,
    trusted_via_ca: false,
    issuer: '',
    subject: '',
    dates: '',
    names: [],
    fallback: false,
    self_signed: false,
    staging: false,
    error: '',
    ...values,
  };
}

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-edge-lifecycle-'));
  process.env.HOUSTON_HOME = home;
  mocked(dockerSeam).mockImplementation((args: string[]) =>
    Promise.resolve({ argv: args, exitCode: 0, signal: null, stdout: '', stderr: '' }),
  );
  mocked(composeSeam).mockImplementation((args: string[]) =>
    Promise.resolve({ argv: args, exitCode: 0, signal: null, stdout: '', stderr: '' }),
  );
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the name a workspace gets', () => {
  it('needs only a domain and an email, and claims no port: the edge holds 443', async () => {
    // The entire point of the edge. A workspace terminates no TLS, so there is nothing to
    // conflict with -- which deleted the port-443 arbitration, the `--adopt` flag and the
    // second-workspace refusal along with it.
    const req = createReq({
      version: '8.5.1',
      domain: 'chat.example.com',
      acmeEmail: 'me@example.com',
    });
    const spec = await resolveTls(req, 'w', '127.0.0.1');
    expect(spec?.mode).toBe(MODE_ACME);
    expect(spec?.host).toBe('chat.example.com');
    expect(spec?.port).toBe(443);
    expect(spec === null ? '' : rootUrl(spec)).toBe('https://chat.example.com'); // no :port
    // The edge redirects :80 once, for every name, so no per-workspace redirect is planned.
    expect(spec === null ? [] : Object.keys(spec)).not.toContain('httpRedirect');
  });

  it('gives local HTTPS a .houston.localhost name on the same 443, not a port of its own', async () => {
    // `--https` used to allocate 8443, 8444, ... one per workspace, each with its own URL.
    // Now it takes the same path as a real domain.
    const spec = await resolveTls(createReq({ version: '8.5.1', https: true }), 'w', '127.0.0.1');
    expect(spec?.mode).toBe(MODE_LOCAL);
    expect(spec?.host).toBe('w.houston.localhost');
    expect(spec?.port).toBe(443);
    expect(spec === null ? '' : rootUrl(spec)).toBe('https://w.houston.localhost');
  });

  it('is decided without starting a container', async () => {
    // A resolve step that started docker made the TEST SUITE stand up a real edge holding
    // :443, which then broke a live run on the same box. Docker work belongs to the create
    // path.
    await resolveTls(
      createReq({ version: '8.5.1', domain: 't1.example.com', acmeEmail: 'o@e.com' }),
      'w',
      '127.0.0.1',
    );
    expect(composeSeam).not.toHaveBeenCalled();
    expect(dockerSeam).not.toHaveBeenCalled();
  });
});

describe('bringing a name back after `down`', () => {
  it('re-registers the route the teardown removed', async () => {
    // `down` then `up` printed "URL https://..." from the record while the name served
    // NOTHING: teardown removed the route and the reuse path never resolved TLS again.
    // Found by running the round trip, not by any test.
    await acmeWorkspace('w', 't1.example.com');
    await write(edge());
    runningEdge();
    expect(registered()).toEqual([]);
    await restoreRoute(await readMeta('w'));
    expect(registered()).toEqual(['w']);
    expect(fs.readFileSync(paths.routePath('w'), 'utf8')).toContain('t1.example.com');
  });

  it('never fails the workspace when the route cannot be written, and says so', async () => {
    // The workspace is up and usable either way; failing a reuse over the ingress would
    // be the wrong trade. The watched directory is a FILE here, so the write really fails.
    await acmeWorkspace('w', 't1.example.com');
    fs.mkdirSync(paths.edgeDir(), { recursive: true });
    fs.writeFileSync(paths.dynamicDir(), 'not a directory', 'utf8');
    runningEdge();
    const said: Event[] = [];
    await expect(
      restoreRoute(await readMeta('w'), (event) => said.push(event)),
    ).resolves.toBeUndefined();
    expect(said.map((event) => `${event.level}:${event.message}`).join('\n')).toContain(
      'warn:could not restore the https name t1.example.com',
    );
  });
});

describe('checking a published name', () => {
  it('gives the proxy time to reload before calling the chain broken', async () => {
    // Found on a chain that was completely correct: the proof reported "answered with a
    // proxy's own default certificate", and the same name served the cluster's certificate
    // seconds later. A route file APPEARING and Traefik having RELOADED it are a second
    // apart, and the proof ran in between. A check that fires on every healthy create is
    // how a reader learns to ignore the one line that would have told them something.
    const probe = mocked(verify);
    probe
      .mockResolvedValueOnce(
        report({ serving: true, fallback: true, issuer: 'CN = TRAEFIK DEFAULT CERT' }),
      )
      .mockResolvedValueOnce(
        report({ serving: true, fallback: true, issuer: 'CN = TRAEFIK DEFAULT CERT' }),
      )
      .mockResolvedValueOnce(
        report({ serving: true, fallback: false, issuer: 'CN = houston local CA' }),
      )
      // The origin behind the edge, asked once the name serves a real certificate.
      .mockResolvedValueOnce(
        report({ serving: true, fallback: false, issuer: 'CN = houston local CA' }),
      );
    const said: string[] = [];
    await publishKubernetesName(
      'ws',
      kubeTls({
        host: 'ws.houston.localhost',
        ingressClass: 'traefik',
        endpoint: {
          address: '172.16.0.2',
          port: 443,
          source: 'loadbalancer',
          service: 'kube-system/traefik',
          local: true,
        },
        clusterOwns443: false,
      }),
      { emit: (event) => said.push(`${event.level}:${event.message}`), sleep: async () => {} },
    );
    const joined = said.join('\n');
    expect(joined).not.toContain('warn:');
    expect(joined).toContain("is serving the cluster's certificate");
    // It must actually retry, not give up after one look -- and stop once it is right: three
    // looks at the name, then one at the origin it passes through to.
    expect(probe).toHaveBeenCalledTimes(4);
    expect(joined).not.toContain('itself answers with');
  });
});
