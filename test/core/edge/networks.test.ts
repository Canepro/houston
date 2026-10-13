/**
 * `core/edge/networks.ts`, through the one caller that changes a workspace's own compose
 * document: `adopt`.
 *
 * Docker is replaced, and the test has its own HOUSTON_HOME.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { docker as dockerSeam } from '../../../src/seams/docker-cli';
import { metadata, readCompose, write as writeRecord } from '../../../src/core/runner/record';
import { SERVICE } from '../../../src/core/tls';

import { holdersOf443 } from '../../../src/core/edge/engine';
import { attach, attachNetwork, detach, releaseVanished } from '../../../src/core/edge/networks';
import { adopt } from '../../../src/core/edge/runtime';

import type * as HostNS from '../../../src/core/runner/host';
import type * as PolicyNS from '../../testsetup-policy';

// Own only engine detection: its real parser reads this file's mocked Docker seam.
// Keep the suite's daemon/plugin guards rather than stripping the guarded host module.
jest.mock('../../../src/core/runner/host', () => ({
  ...jest.requireActual<typeof PolicyNS>('../../testsetup-policy').healthyHost(),
  engine: jest.requireActual<typeof HostNS>('../../../src/core/runner/host').engine,
}));

jest.mock('../../../src/seams/docker-cli', () => ({
  ...jest.requireActual('../../../src/seams/docker-cli'),
  docker: jest.fn(),
  compose: jest.fn(),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-edge-networks-'));
  process.env.HOUSTON_HOME = home;
  mocked(dockerSeam).mockImplementation((args: string[]) =>
    Promise.resolve({ argv: args, exitCode: 0, signal: null, stdout: '', stderr: '' }),
  );
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('adopting a workspace onto the edge', () => {
  it('drops its own Traefik and edits no network: the EDGE joins the workspace’s', async () => {
    await writeRecord(
      'w',
      'services:\n' +
        "  rocketchat:\n    image: rc\n    ports: ['0.0.0.0:3000:3000']\n" +
        '  mongodb:\n    image: mongo\n' +
        "  traefik:\n    image: traefik\n    ports: ['443:443', '80:80']\n",
      metadata({
        name: 'w',
        project: 'houston-w',
        rcVersion: '8.5.1',
        publicUrl: 'https://t1.kestron.org',
        extra: { tls: 'acme', tls_ports: [443], tls_email: 'o@e.com' },
      }),
    );
    expect(await adopt('w')).toEqual({ name: 'w', host: 't1.kestron.org' });
    const doc = await readCompose('w');
    // Its Traefik must go, or 443 stays held.
    expect(Object.keys(doc.services as Record<string, unknown>)).not.toContain(SERVICE);
    expect(Object.keys(doc.services as Record<string, unknown>)).toEqual(['rocketchat', 'mongodb']);
    // No network edits: the workspace keeps its own, and the edge joined it live.
    expect('networks' in doc).toBe(false);
  });
});

describe('a workspace that is not a --domain one', () => {
  it('holds no 443 and is refused adoption, because it has no public name to register', async () => {
    // `--https` alone uses a local certificate: nothing to move onto the edge.
    await writeRecord(
      'l',
      'services: {}\n',
      metadata({
        name: 'l',
        project: 'houston-l',
        rcVersion: '8.5.1',
        rootUrl: 'http://localhost:3000',
        hostPort: 3000,
        extra: { tls: 'local', tls_ports: [8443] },
      }),
    );
    expect(await holdersOf443()).toEqual([]);
    await expect(adopt('l')).rejects.toThrow(/not a --domain workspace/u);
    expect(mocked(dockerSeam)).not.toHaveBeenCalled();
  });
});

describe('the record an adoption rewrites', () => {
  it('keeps a hand-edited extra in its order and spelling, as earlier releases do', async () => {
    // Earlier releases copy the extra and write the record back in the order and the
    // spelling they read it in. A spread here was JavaScript's order, `10` first, and no
    // spelling for 12345678901234567890 or `1e16`.
    const ws = path.join(home, 'repros', 'w');
    const setUp = () => {
      fs.rmSync(path.join(home, 'edge'), { recursive: true, force: true });
      fs.mkdirSync(ws, { recursive: true });
      fs.writeFileSync(
        path.join(ws, 'repro.json'),
        '{"name": "w", "project": "houston-w", "rc_version": "8.5.1", "rc_image": "rc", ' +
          '"mongo_tag": "8.0", "mongo_flavor": "official", "preset": "", ' +
          '"root_url": "http://localhost:3000", "host_port": 3000, "version_source": "live", ' +
          '"public_url": "https://t1.kestron.org", "extra": {"tls": "acme", "10": "x", ' +
          '"b": 1, "n": 12345678901234567890, "f": 1e16, "tls_ports": [443]}}',
      );
      fs.writeFileSync(
        path.join(ws, 'docker-compose.yml'),
        'services:\n  rocketchat:\n    image: rc\n  traefik:\n    image: traefik\n',
      );
    };
    // The record earlier releases wrote back after adopting the same workspace, recorded.
    const recorded = [
      '{',
      '  "name": "w",',
      '  "project": "houston-w",',
      '  "rc_version": "8.5.1",',
      '  "rc_image": "rc",',
      '  "mongo_tag": "8.0",',
      '  "mongo_flavor": "official",',
      '  "preset": "",',
      '  "root_url": "http://localhost:3000",',
      '  "host_port": 3000,',
      '  "version_source": "live",',
      '  "pinned": false,',
      '  "created_at": "",',
      '  "public_url": "https://t1.kestron.org",',
      '  "admin_password": "",',
      '  "extra": {',
      '    "tls": "acme",',
      '    "10": "x",',
      '    "b": 1,',
      '    "n": 12345678901234567890,',
      '    "f": 1e+16,',
      '    "tls_ports": [],',
      '    "edge": true',
      '  }',
      '}',
    ].join('\n');
    setUp();
    await adopt('w');
    const ours = fs.readFileSync(path.join(ws, 'repro.json'), 'utf8');
    expect(ours).toBe(recorded);
    expect(ours).toContain('"n": 12345678901234567890');
  });
});

describe("a vanished workspace's network", () => {
  it('is left and removed once nothing of the workspace is on it, and kept otherwise', async () => {
    // Releasing a stale name only detached the edge: the empty network stayed for good.
    const asked: string[][] = [];
    let left = '';
    mocked(dockerSeam).mockImplementation((args: string[]) => {
      asked.push(args);
      return Promise.resolve({
        argv: args,
        exitCode: 0,
        signal: null,
        stdout: args[0] === 'ps' ? left : '',
        stderr: '',
      });
    });
    await releaseVanished('gone');
    expect(asked).toContainEqual([
      'network',
      'disconnect',
      '-f',
      'houston-gone_default',
      'houston_edge-edge-1',
    ]);
    expect(asked).toContainEqual(['network', 'rm', 'houston-gone_default']);
    asked.length = 0;
    left = 'abc123\n';
    await releaseVanished('gone');
    expect(asked.some((args) => args[1] === 'rm')).toBe(false);
  });
});

/** A Podman namespace can diverge from inspect while leaving other workspaces intact. */
interface IngressWorldOptions {
  kind?: 'podman' | 'docker' | 'unknown';
  rootless?: boolean;
  alreadyAttached?: boolean;
  missing?: 'ingress' | 'workspace' | 'none';
  changeDropsIngress?: boolean;
  foreignHome?: boolean;
  staleOwnership?: boolean;
  failedOwnership?: boolean;
  failedMutation?: boolean;
  failedRestart?: boolean;
  failedProbe?: boolean;
  malformedProbe?: boolean;
  invalidIngress?: boolean;
  repairWorks?: boolean;
  unknownAfterRestart?: boolean;
  changeIngressOnRestart?: boolean;
}

function ingressWorld(options: IngressWorldOptions = {}) {
  let ingress = '10.89.0.7';
  const project = 'houston-w_default';
  const cid = 'edge-owned-id';
  const networks = new Set(['houston_edge_default', 'houston-bystander_default']);
  if (options.alreadyAttached === true) networks.add(project);
  const actual = new Set(['127.0.0.1', ingress, '10.89.2.5']);
  if (options.alreadyAttached === true) actual.add('10.89.1.8');
  if (options.missing === 'ingress') actual.delete(ingress);
  if (options.missing === 'workspace') actual.delete('10.89.1.8');
  const calls: string[][] = [];
  let ownershipReads = 0;
  let restarts = 0;
  const dynamic = path.join(home, 'edge', 'dynamic');
  fs.mkdirSync(dynamic, { recursive: true });
  const route = path.join(dynamic, 'bystander.yml');
  const certs = path.join(home, 'edge', 'acme.json');
  fs.writeFileSync(route, 'bystander route\n');
  fs.writeFileSync(certs, 'existing certificates\n');
  mocked(dockerSeam).mockClear();
  mocked(dockerSeam).mockImplementation((args: string[]) => {
    calls.push([...args]);
    let stdout = '';
    let exitCode = 0;
    let stderr = '';
    const format = args.at(-1) ?? '';
    if (args[0] === 'info') {
      stdout =
        options.kind === 'unknown'
          ? 'not engine JSON'
          : JSON.stringify(
              options.kind === 'docker'
                ? { SecurityOptions: [], CgroupDriver: 'systemd' }
                : {
                    host: {
                      security: { rootless: options.rootless !== false },
                      cgroupManager: 'systemd',
                    },
                  },
            );
    } else if (args[0] === 'version') {
      stdout = JSON.stringify({ Server: { Components: [] } });
    } else if (args[0] === 'ps') {
      stdout = cid;
    } else if (args[0] === 'inspect' && format.includes('working_dir')) {
      ownershipReads += 1;
      stdout =
        options.foreignHome === true || (options.staleOwnership === true && ownershipReads > 1)
          ? '/another-home/edge'
          : path.join(home, 'edge');
      if (options.failedOwnership === true) exitCode = 1;
    } else if (args[0] === 'inspect' && format.includes('range $k,$v')) {
      stdout = [...networks].join('\n');
    } else if (args[0] === 'inspect' && format === '{{json .NetworkSettings.Networks}}') {
      stdout = JSON.stringify(
        Object.fromEntries(
          [...networks].map((net) => [
            net,
            {
              IPAddress:
                net === 'houston_edge_default'
                  ? options.invalidIngress === true
                    ? 'not-an-ip'
                    : ingress
                  : net === project || net === 'kind'
                    ? '10.89.1.8'
                    : '10.89.2.5',
            },
          ]),
        ),
      );
    } else if (args[0] === 'network' && args[1] === 'connect') {
      if (options.failedMutation === true) exitCode = 1;
      else {
        networks.add(args[2] ?? '');
        actual.add('10.89.1.8');
        if (options.changeDropsIngress === true) actual.delete(ingress);
      }
    } else if (args[0] === 'network' && args[1] === 'disconnect') {
      if (options.failedMutation === true) exitCode = 1;
      else {
        networks.delete(args[3] ?? '');
        actual.delete('10.89.1.8');
        if (options.changeDropsIngress === true) actual.delete(ingress);
      }
    } else if (args[0] === 'exec') {
      if (args.join(' ') !== ['exec', cid, 'ip', 'addr', 'show'].join(' ')) {
        exitCode = 127;
        stderr = 'fixture accepts only the proven ip addr show command';
      } else if (
        options.failedProbe === true ||
        (options.unknownAfterRestart === true && restarts > 0)
      ) {
        exitCode = 127;
        stderr = 'ip could not be run';
      } else {
        stdout =
          [...actual]
            .map((ip, index) => {
              const loopback = ip === '127.0.0.1';
              const iface = loopback ? 'lo' : `eth${String(index - 1)}`;
              return [
                `${String(index + 1)}: ${iface}${loopback ? '' : '@if11'}: ` +
                  (loopback
                    ? '<LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN qlen 1000'
                    : '<BROADCAST,MULTICAST,UP,LOWER_UP,M-DOWN> mtu 1500 qdisc noqueue state UP qlen 1000'),
                `    link/${loopback ? 'loopback' : 'ether'} 00:00:00:00:00:00 brd 00:00:00:00:00:00`,
                `    inet ${ip}/${loopback ? '8' : '24'} scope ${loopback ? 'host' : 'global'} ${iface}`,
                '       valid_lft forever preferred_lft forever',
                `    inet6 ${loopback ? '::1/128 scope host' : 'fe80::1/64 scope link tentative'} `,
                '       valid_lft forever preferred_lft forever',
              ].join('\n');
            })
            .join('\n') + '\n';
        // An unrelated malformed row makes the WHOLE observation unknown, even when
        // earlier interface and valid IPv4 rows would otherwise prove ingress absent.
        if (options.malformedProbe === true) stdout += '    inet 999.1.1.1/24 scope global eth1\n';
      }
    } else if (args[0] === 'restart') {
      restarts += 1;
      if (options.failedRestart === true) {
        exitCode = 1;
        stderr = 'Error: namespace restart refused';
      } else if (options.repairWorks !== false) {
        if (options.changeIngressOnRestart === true) {
          actual.delete(ingress);
          ingress = '10.89.0.8';
        }
        actual.add(ingress);
      }
    }
    return Promise.resolve({ argv: args, exitCode, signal: null, stdout, stderr });
  });
  return {
    get ingress() {
      return ingress;
    },
    cid,
    networks,
    actual,
    calls,
    route,
    certs,
  };
}

describe('rootless Podman ingress after shared-edge network mutations', () => {
  it('repairs ingress lost by attach once by owned ID, retaining the bystander route and certs', async () => {
    const world = ingressWorld({ changeDropsIngress: true, changeIngressOnRestart: true });
    expect(await attach('w')).toBe(true);
    expect(world.calls.filter((args) => args[0] === 'restart')).toEqual([['restart', world.cid]]);
    expect(world.ingress).toBe('10.89.0.8');
    expect(world.actual.has(world.ingress)).toBe(true);
    expect([...world.networks].sort()).toEqual([
      'houston-bystander_default',
      'houston-w_default',
      'houston_edge_default',
    ]);
    expect(fs.readFileSync(world.route, 'utf8')).toBe('bystander route\n');
    expect(fs.readFileSync(world.certs, 'utf8')).toBe('existing certificates\n');
  });

  it('repairs the same proven ingress loss when attaching an explicit cluster network', async () => {
    const world = ingressWorld({ changeDropsIngress: true });
    expect(await attachNetwork('kind')).toBe(true);
    expect(world.calls.filter((args) => args[0] === 'restart')).toEqual([['restart', world.cid]]);
    expect(world.actual.has(world.ingress)).toBe(true);
    expect(world.networks.has('kind')).toBe(true);
  });

  it('repairs ingress lost by detach once without restoring the removed workspace network', async () => {
    const world = ingressWorld({ alreadyAttached: true, changeDropsIngress: true });
    await detach('w');
    expect(world.calls.filter((args) => args[0] === 'restart')).toEqual([['restart', world.cid]]);
    expect(world.actual.has(world.ingress)).toBe(true);
    expect(world.networks.has('houston-w_default')).toBe(false);
    expect(world.networks.has('houston-bystander_default')).toBe(true);
  });

  it('checks a pre-existing attachment rather than accepting inspect while ingress is absent', async () => {
    const world = ingressWorld({ alreadyAttached: true, missing: 'ingress' });
    expect(await attach('w')).toBe(true);
    expect(world.calls.filter((args) => args[0] === 'restart')).toEqual([['restart', world.cid]]);
    expect(world.calls.some((args) => args[0] === 'network')).toBe(false);
    expect(world.actual.has(world.ingress)).toBe(true);
  });

  it('reports a refused owned-edge restart with its engine reason and makes no second attempt', async () => {
    const world = ingressWorld({ changeDropsIngress: true, failedRestart: true });
    await expect(attach('w')).rejects.toMatchObject({
      name: 'DockerError',
      code: 'ENGINE_UNAVAILABLE',
      message: expect.stringContaining('namespace restart refused'),
    });
    expect(world.calls.filter((args) => args[0] === 'restart')).toEqual([['restart', world.cid]]);
  });

  it('refuses success after restart when the freshly inspected ingress is still absent', async () => {
    const world = ingressWorld({
      alreadyAttached: true,
      changeDropsIngress: true,
      repairWorks: false,
    });
    await expect(detach('w')).rejects.toMatchObject({
      name: 'DockerError',
      message: expect.stringContaining('still absent from the container'),
    });
    expect(world.calls.filter((args) => args[0] === 'restart')).toEqual([['restart', world.cid]]);
  });

  it('refuses success after restart when the actual ingress can no longer be verified', async () => {
    const world = ingressWorld({ changeDropsIngress: true, unknownAfterRestart: true });
    await expect(attach('w')).rejects.toMatchObject({
      name: 'DockerError',
      message: expect.stringContaining('ip could not be run'),
    });
    expect(world.calls.filter((args) => args[0] === 'restart')).toEqual([['restart', world.cid]]);
  });

  it('preserves a healthy rootless edge through connect and disconnect without restarting it', async () => {
    const world = ingressWorld();
    expect(await attach('w')).toBe(true);
    await detach('w');
    expect(world.calls.some((args) => args[0] === 'restart')).toBe(false);
    expect(world.actual.has(world.ingress)).toBe(true);
  });

  it('does not restart shared ingress for an absent workspace-only address', async () => {
    const world = ingressWorld({ alreadyAttached: true, missing: 'workspace' });
    expect(await attach('w')).toBe(true);
    expect(world.calls.some((args) => args[0] === 'restart')).toBe(false);
    expect(world.actual.has('10.89.1.8')).toBe(false);
  });

  it.each([
    ['Docker', { kind: 'docker' }],
    ['rootful Podman', { rootless: false }],
    ['unknown engine', { kind: 'unknown' }],
  ] as const)('preserves %s behavior despite a namespace discrepancy', async (_name, options) => {
    const world = ingressWorld({ ...options, changeDropsIngress: true });
    expect(await attach('w')).toBe(true);
    expect(world.calls.some((args) => args[0] === 'exec' || args[0] === 'restart')).toBe(false);
  });

  it.each([
    ['failed namespace probe', { failedProbe: true }],
    ['malformed namespace probe', { malformedProbe: true }],
    ['invalid inspected ingress address', { invalidIngress: true }],
    ['another home', { foreignHome: true }],
    ['changed ownership', { staleOwnership: true }],
    ['failed ownership inspection', { failedOwnership: true }],
  ] as const)('does not authorise a restart from %s', async (_name, options) => {
    const world = ingressWorld({ ...options, changeDropsIngress: true });
    expect(await attach('w')).toBe(true);
    expect(world.calls.some((args) => args[0] === 'restart')).toBe(false);
  });

  it('keeps a failed connect false and a failed disconnect best effort without restarting', async () => {
    const world = ingressWorld({ missing: 'ingress', failedMutation: true });
    expect(await attach('w')).toBe(false);
    await detach('w');
    expect(world.calls.some((args) => args[0] === 'restart')).toBe(false);
  });
});
