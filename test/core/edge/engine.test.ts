/**
 * `core/edge/engine.ts`, and the start/stop paths that read it.
 *
 * The claims are the ones where the edge could be wrong silently: naming the wrong thing as
 * holding :443, calling another home's container ours, and a start or a delete that reports
 * success over a compose that said otherwise.
 *
 * Docker is replaced throughout, and each test has its own HOUSTON_HOME, because a route
 * file left by one of these would be read by the next as a registered workspace.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { compose as composeSeam, docker as dockerSeam } from '../../../src/seams/docker-cli';
import { metadata, readMeta, write as writeRecord } from '../../../src/core/runner/record';
import { ACME_FILE, acmeDir } from '../../../src/core/tls';

import { issueLocalCert } from '../../../src/core/edge/acme';
import {
  bridgeAddress,
  composeRun,
  down,
  foreignEdge,
  holdersOf443,
  portHolder,
} from '../../../src/core/edge/engine';
import * as paths from '../../../src/core/edge/paths';
import { CONTAINER } from '../../../src/core/edge/paths';
import { register, registered } from '../../../src/core/edge/routes';
import { adopt, deleteHost, ensureRunning, logs, up } from '../../../src/core/edge/runtime';
import { current, write } from '../../../src/core/edge/spec';
import { edge } from '../../../src/core/edge/types';
import type * as ConfigNS from '../../../src/lib/config';

jest.mock('../../../src/seams/docker-cli', () => ({
  ...jest.requireActual('../../../src/seams/docker-cli'),
  docker: jest.fn(),
  compose: jest.fn(),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

interface Reply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}
type Rule = readonly [readonly string[], Reply];

/**
 * A scripted docker: argv fragments -> what it says, first matching rule wins.
 *
 * Substring-matched against the JOINED argv, for the reason `edge.test.ts` records: half
 * these calls identify themselves by a Go template, and an element-wise match silently
 * matches nothing.
 */
function scriptDocker(rules: readonly Rule[], composeRules: readonly Rule[] = []): void {
  const answer = (table: readonly Rule[], argv: readonly string[]) => {
    const joined = argv.join(' ');
    const said = table.find(([needles]) => needles.every((needle) => joined.includes(needle)));
    return {
      argv,
      exitCode: said?.[1].exitCode ?? 0,
      signal: null,
      stdout: said?.[1].stdout ?? '',
      stderr: said?.[1].stderr ?? '',
    };
  };
  mocked(dockerSeam).mockImplementation((args: string[]) =>
    Promise.resolve(answer(rules, ['docker', ...args])),
  );
  mocked(composeSeam).mockImplementation((args: string[]) =>
    Promise.resolve(answer(composeRules, ['docker', 'compose', ...args])),
  );
}

/** This home's edge, up and holding both ports. */
function runningEdge(): Rule[] {
  return [
    [['ps', '{{.ID}}'], { stdout: 'c0ffee\n' }],
    [['inspect', 'working_dir'], { stdout: `${paths.edgeDir()}\n` }],
    [
      ['NetworkSettings.Ports'],
      { stdout: '{"80/tcp":[{"HostPort":"80"}],"443/tcp":[{"HostPort":"443"}]}' },
    ],
  ];
}

/** Another home's edge: our project label, somebody else's working directory. */
function foreignEdgeAt(dir: string): Rule[] {
  return [
    [['ps', '{{.ID}}'], { stdout: 'deadbeef\n' }],
    [['inspect', 'working_dir'], { stdout: `${dir}\n` }],
  ];
}

/** What compose was asked, without the `-p houston_edge` every call carries. */
function composeVerbs(): string[] {
  return mocked(composeSeam).mock.calls.map(([args]) => (args as string[]).slice(2).join(' '));
}

/** A pre-edge `--domain` workspace running its OWN Traefik on 443 (`_acme_workspace`). */
async function acmeWorkspace(name: string, host: string): Promise<void> {
  await writeRecord(
    name,
    'services:\n' +
      "  rocketchat:\n    image: rc\n    ports: ['0.0.0.0:3000:3000']\n" +
      '  mongodb:\n    image: mongo\n' +
      "  traefik:\n    image: traefik\n    ports: ['443:443', '80:80']\n",
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

/** Traefik's store holding `gone.example.org` and `keep.example.org` (`_write_acme`). */
function writeAcme(): void {
  fs.mkdirSync(acmeDir(), { recursive: true });
  fs.writeFileSync(
    path.join(acmeDir(), ACME_FILE),
    JSON.stringify({
      le: {
        Account: { Email: 'ops@xyz.com', PrivateKey: 'acct-key' },
        Certificates: [
          { domain: { main: 'gone.example.org', sans: [] }, certificate: 'c1', key: 'k1' },
          {
            domain: { main: 'keep.example.org', sans: ['www.keep.example.org'] },
            certificate: 'c2',
            key: 'k2',
          },
        ],
      },
    }),
    'utf8',
  );
}

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-edge-engine-'));
  process.env.HOUSTON_HOME = home;
  scriptDocker([]);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the address the GUI listens on behind the edge', () => {
  it('is the bridge gateway when this host can listen there, else loopback', async () => {
    // 127.0.0.2 is bindable on Linux (all of 127/8 is local) and stands in for a Docker
    // host's own gateway; 192.0.2.1 (TEST-NET-1) is no address of this machine, as a VM
    // engine's bridge is not.
    scriptDocker([[['network', 'inspect', 'bridge'], { stdout: '127.0.0.2\n' }]]);
    expect(await bridgeAddress()).toBe('127.0.0.2');
    scriptDocker([[['network', 'inspect', 'bridge'], { stdout: '192.0.2.1\n' }]]);
    expect(await bridgeAddress()).toBe('127.0.0.1');
    scriptDocker([[['network', 'inspect', 'bridge'], { exitCode: 1, stderr: 'no docker' }]]);
    expect(await bridgeAddress()).toBe('');
  });
});

describe('naming what holds :443', () => {
  it('names the container, because "the edge did not start" points at the wrong thing', async () => {
    // The cause is almost always something ELSE on :443 -- hit twice while building this.
    scriptDocker([
      [['ps', '{{.Names}}'], { stdout: 'some-other-traefik\t0.0.0.0:443->443/tcp\n' }],
    ]);
    expect(await portHolder(443)).toContain('some-other-traefik');
  });

  it('names the PROJECT too, which is what `docker compose -p <project> down` takes', async () => {
    // Naming only the container sent somebody at our own project -- the one `-p` value
    // that cannot possibly free the port -- which is what happened when a pre-rename edge
    // outlived the rename.
    scriptDocker([
      [['ps', '{{.Names}}'], { stdout: 'rcrepro_edge-edge-1\t0.0.0.0:443->443/tcp\n' }],
      [['inspect', 'com.docker.compose.project"}}'], { stdout: 'rcrepro_edge\n' }],
    ]);
    const said = await portHolder(443);
    expect(said).toContain('rcrepro_edge-edge-1');
    expect(said).toContain("rcrepro_edge'");
  });

  it('calls an edge from another home by what it is, not "outside Docker"', async () => {
    // Skipping by container NAME alone hid the most confusing case: an edge from a
    // different HOUSTON_HOME has exactly our name, so it was excluded as "us".
    scriptDocker([
      [['ps', '{{.Names}}'], { stdout: `${CONTAINER}\t0.0.0.0:443->443/tcp\n` }],
      ...foreignEdgeAt('/somebody/elses/.houston/edge'),
    ]);
    expect(await portHolder(443)).toContain('another HOUSTON_HOME');
  });

  it('does not report this home’s own edge as foreign', async () => {
    scriptDocker(foreignEdgeAt(paths.edgeDir()));
    expect(await foreignEdge()).toBe('');
    // ...and the same container from a different directory IS foreign, named by it.
    scriptDocker(foreignEdgeAt('/somebody/elses/.houston/edge'));
    expect(await foreignEdge()).toBe('/somebody/elses/.houston/edge');
  });
});

describe('moving a pre-edge workspace across', () => {
  it('registers its route and drops its claim on 443', async () => {
    await acmeWorkspace('w', 't1.kestron.org');
    await adopt('w');
    expect(registered()).toEqual(['w']);
    expect(fs.readFileSync(paths.routePath('w'), 'utf8')).toContain('t1.kestron.org');
    const meta = await readMeta('w');
    expect(meta.extra.edge).toBe(true);
    // It publishes no 443 now; leaving the claim would make every later workspace
    // allocate around a port this one does not hold.
    expect(meta.extra.tls_ports).toEqual([]);
    expect(await holdersOf443()).toEqual([]);
  });

  it('happens by itself when the edge starts, because that workspace is why it cannot', async () => {
    // `--adopt` existed when moving meant recreating every container. It is instant and
    // touches no data now, and the legacy Traefik holding :443 is the reason the edge
    // cannot start at all.
    await acmeWorkspace('legacy', 't1.example.com');
    expect((await ensureRunning()).ok).toBe(true);
    expect(registered()).toEqual(['legacy']);
    expect(composeVerbs().filter((verb) => verb.startsWith('up'))).toHaveLength(1);
  });
});

describe('starting the edge', () => {
  it('re-attaches every route, because attachments do not survive a recreate', async () => {
    // Attachments are RUNTIME state on the container while the route files survive, so
    // without this every name answers 502 after an upgrade, a restart or a reboot.
    await write(edge());
    await register('alice-rc8-5-1', 'alice-rc8-5-1.example.com');
    await register('bob-rc8-5-1', 'bob-rc8-5-1.example.com');
    mocked(dockerSeam).mockClear();
    await up({ pull: false });
    const joined = mocked(dockerSeam)
      .mock.calls.map(([args]) => args as string[])
      .filter((args) => args[0] === 'network' && args[1] === 'connect')
      .map((args) => args[2]);
    expect(joined.sort()).toEqual(['houston-alice-rc8-5-1_default', 'houston-bob-rc8-5-1_default']);
  });

  it('builds the first edge with the challenge the box was set to, not always TLS-ALPN', async () => {
    // A box behind a tunnel ran `config set acme.challenge http`, then `up --domain`: the edge
    // `up` wrote first asked for TLS-ALPN, which the tunnel cannot carry, and its first
    // certificate never came, seen live. Only `serve`'s edge, and upgrades, read the setting.
    const config = require('../../../src/lib/config') as typeof ConfigNS;
    config.updateConfig((cfg) => {
      cfg.acme_challenge = 'http';
    });
    try {
      scriptDocker([]);
      expect((await ensureRunning({ acmeEmail: 'a@b.test' })).ok).toBe(true);
      expect(current()?.acmeChallenge).toBe('http');
    } finally {
      config.updateConfig((cfg) => {
        delete cfg.acme_challenge;
      });
    }
  });

  it('still applies a changed configuration to an edge that is already running', async () => {
    // `ensureRunning` returned true the moment the edge was RUNNING -- after the caller
    // had rewritten the compose file -- so a changed resolver email or domain was written
    // to disk and never applied. Found on a box whose `acme.json` held an account for a
    // mistyped address while the corrected one was being passed on every restart.
    await write(edge({ domain: 'gui.example.test', acmeEmail: 'a@b.test' }));
    scriptDocker(runningEdge());
    expect((await ensureRunning({ acmeEmail: 'a@b.test' })).ok).toBe(true);
    // compose is asked to reconcile: it recreates only if the configuration changed.
    expect(composeVerbs().some((verb) => verb.startsWith('up'))).toBe(true);

    // And a compose that cannot reconcile is a failure with a reason, not a silent yes.
    scriptDocker(runningEdge(), [
      [['up'], { exitCode: 1, stderr: 'Error response from daemon: port is already allocated\n' }],
    ]);
    const bad = await ensureRunning({ acmeEmail: 'a@b.test' });
    expect(bad.ok).toBe(false);
    expect(bad.why).toContain('already allocated');
  });

  it('says what docker said when the start fails, taking the LAST error line', async () => {
    // "error: the edge did not start." was the whole message on a fresh EC2 box where
    // `docker ps -a` was empty, because the compose error was captured and dropped.
    await write(edge({ domain: 'gui.example.test', acmeEmail: 'a@b.test' }));
    scriptDocker(
      [],
      [
        [
          ['up'],
          {
            exitCode: 1,
            stderr:
              'time="..." level=warning msg="a warning nobody needs"\n' +
              'Error response from daemon: failed to pull traefik:v3.1: no space left on device\n',
          },
        ],
      ],
    );
    const res = await ensureRunning({ acmeEmail: 'a@b.test' });
    expect(res.ok).toBe(false);
    // compose puts its diagnostics FIRST, so a prefix is the least useful part.
    expect(res.why).toContain('no space left on device');
    expect(res.why).not.toContain('a warning nobody needs');

    // And success still reads as success at every existing call site.
    scriptDocker([]);
    expect(await ensureRunning({ acmeEmail: 'a@b.test' })).toEqual({ ok: true, why: '' });
  });

  it('removes a GUI route an older version wrote with no domain', async () => {
    // It produced Host(``), rejected at every reload with "empty args for matcher Host".
    // Not writing it any more does nothing for the edges that already have one.
    await write(edge());
    fs.writeFileSync(paths.routePath('_gui'), 'rule: "Host(``)"\n', 'utf8');
    scriptDocker(runningEdge());
    await ensureRunning();
    expect(fs.existsSync(paths.routePath('_gui'))).toBe(false);
  });

  it('leaves a real GUI route alone', async () => {
    await write(edge({ domain: 'gui.example.com', acmeEmail: 'o@e.com' }));
    scriptDocker(runningEdge());
    await ensureRunning();
    expect(fs.readFileSync(paths.routePath('_gui'), 'utf8')).toContain('Host(`gui.example.com`)');
  });
});

describe('the compose seam', () => {
  it('never raises, even for a home that has never had an edge', async () => {
    // A seam that raises for one caller raises for the next, and every caller here reads
    // a return code. `down` is the caller that broke: `houston edge stop` on a fresh home
    // answered with a stack trace naming a path under HOUSTON_HOME.
    process.env.HOUSTON_HOME = path.join(home, 'never-made');
    const absent = new Error('spawn docker ENOENT');
    mocked(composeSeam).mockImplementation(() => Promise.reject(absent));
    expect(fs.existsSync(paths.edgeDir())).toBe(false);
    const res = await composeRun(['ps']);
    expect(res.returncode).toBe(127); // 127 is "could not run it"
    expect(res.stderr).toContain('spawn docker ENOENT');
    expect(await down()).toBe(127);
    // And the log stream, the one other direct call with the same working directory.
    expect(await logs({ tail: 1, follow: false })).toBe(127);
  });
});

describe('the edge log', () => {
  it('reaches the terminal uncaptured, as earlier releases run it, and returns its code', async () => {
    // `runtime.logs` is the one edge compose call earlier releases do NOT capture: `-f` has to
    // behave like `docker compose logs -f`. This one captured and dropped what it caught,
    // so `edge logs` printed nothing of the log and `-f` nothing at all.
    mocked(composeSeam).mockResolvedValue({
      argv: [],
      exitCode: 3,
      signal: null,
      stdout: null,
      stderr: null,
    });
    expect(await logs({ tail: 5, follow: true })).toBe(3);
    expect(mocked(composeSeam).mock.calls).toEqual([
      [['-p', 'houston_edge', 'logs', '--tail=5', '-f'], { cwd: paths.edgeDir() }],
    ]);
  });

  it('answers a child a signal ended with minus the signal, as returncode does', async () => {
    mocked(composeSeam).mockResolvedValue({
      argv: [],
      exitCode: null,
      signal: 'SIGTERM',
      stdout: null,
      stderr: null,
    });
    expect(await logs()).toBe(-15);
  });
});

describe('deleting a name, and whether the edge restarts for it', () => {
  it('does not restart for a local certificate, which is read from disk', async () => {
    // Removing the file is already in effect. Restarting would interrupt every other name
    // on the box and buy nothing -- so Docker is not even asked.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    await register('x', 'x.example.org', { local: true });
    await issueLocalCert('x.example.org');
    scriptDocker(runningEdge());
    mocked(dockerSeam).mockClear();
    expect((await deleteHost('x.example.org', { confirm: true })).restarted).toBeNull();
    expect(composeVerbs()).toEqual([]);
    expect(dockerSeam).not.toHaveBeenCalled();
  });

  it('restarts a running edge for an ACME deletion, or the entry comes back', async () => {
    // Traefik holds the store in memory and rewrites the whole file when a certificate
    // changes, so an edit made underneath it can reappear hours after a command said it
    // was deleted. Restarting rebuilds that memory from the edited file.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    writeAcme();
    scriptDocker(runningEdge());
    expect((await deleteHost('gone.example.org', { confirm: true })).restarted).toBe(true);
    expect(composeVerbs().map((verb) => verb.split(' ')[0])).toEqual(['down', 'up']);
  });

  it('reports a foreign edge and never restarts it', async () => {
    // Every home names its project `houston_edge`, so a naive restart would stop another
    // home's edge. What was missing was the SENTENCE: that edge reads its own ACME store,
    // so what was deleted here is this home's copy.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    writeAcme();
    scriptDocker(foreignEdgeAt('/home/someone/.houston/edge'));
    const gone = await deleteHost('gone.example.org', { confirm: true });
    expect(gone.restarted).toBeNull();
    expect(gone.foreign).toBe('/home/someone/.houston/edge');
    // The deletion itself still happened -- the key came off THIS disk.
    expect(gone.acme).toEqual(['acme.json']);
    expect(composeVerbs()).toEqual([]);
  });
});
