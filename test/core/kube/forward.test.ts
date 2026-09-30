/**
 * The port-forward, with REAL sockets and REAL child processes.
 *
 * Earlier releases' tests stubbed the path, signal and ownership functions, because their
 * modules resolve them at call time. Emitted TypeScript cannot replace a function one module
 * calls inside itself, and that turns out to be the better test: every claim below is about
 * WHICH PROCESS holds WHICH SOCKET, and the only honest witness to that is /proc. So the
 * processes are real -- a `node` holding a socket, a `node` carrying a port-forward's argv,
 * and, where the production path spawns kubectl, a stand-in `kubectl` this file writes into
 * a directory it owns, which records its argv and does what kubectl would.
 *
 * Nothing here reaches a cluster: the funnel is scripted for every read, and the only
 * binary launched under a Kubernetes tool's name is that stand-in. Every process a test
 * starts is killed after it, and every socket closed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Event } from '../../../src/lib/events';
import type { KubectlResult } from '../../../src/seams/kubectl';
import { noteGroupsOf } from '../../../src/core/lifecycle/notes';
import { metadata } from '../../../src/core/runner/record';
import * as topology from '../../../src/core/topology';

import { kube } from '../../../src/core/kube/exec';
import {
  ensurePortForward,
  forwardAlive,
  forwardBound,
  forwardReachable,
  listeningInodes,
  pidOwnsPort,
  pidOwnsPortExclusively,
  portForward,
  scenarioUiForwards,
  stopForward,
} from '../../../src/core/kube/forward';
import { CONTEXT } from '../../../src/core/kube/names';

const realRun = kube.run;
const realPath = process.env.PATH;

// --- processes and sockets this file owns ----------------------------------------------

const children: ChildProcess[] = [];
const servers: net.Server[] = [];

/** A `node` that carries `args` on its command line and, optionally, runs `code`. */
function holder(args: readonly string[], code = 'setInterval(() => {}, 1000)'): ChildProcess {
  const child = spawn(process.execPath, ['-e', code, ...args], { stdio: 'ignore' });
  children.push(child);
  return child;
}

/** A socket held by THIS process, which is what makes it a squatter to anybody else. */
async function listen(port: number, host: string): Promise<net.Server> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitFor(what: string, done: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- the kubectl stand-in --------------------------------------------------------------

let kubectlDir = '';

/**
 * A `kubectl` that records its argv and then does what a port-forward does: bind the host
 * port it was given, on `--address` if it was given one -- or, as `exit`, what a kubectl
 * that cannot bind does, which is exit at once.
 */
function installKubectl(mode: 'listen' | 'exit'): void {
  kubectlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-kubectl-'));
  fs.writeFileSync(path.join(kubectlDir, 'mode'), mode);
  fs.writeFileSync(
    path.join(kubectlDir, 'kubectl'),
    `#!${process.execPath}\n` +
      "'use strict';\n" +
      "const fs = require('node:fs');\n" +
      "const net = require('node:net');\n" +
      "const path = require('node:path');\n" +
      'const argv = process.argv.slice(2);\n' +
      "fs.appendFileSync(path.join(__dirname, 'spawned.jsonl'), " +
      "JSON.stringify({ pid: process.pid, argv }) + '\\n');\n" +
      "if (fs.readFileSync(path.join(__dirname, 'mode'), 'utf8') === 'exit') process.exit(1);\n" +
      "const host = Number(String(argv[argv.length - 1]).split(':')[0]);\n" +
      "const at = argv.indexOf('--address');\n" +
      "net.createServer().listen(host, at >= 0 ? argv[at + 1] : '127.0.0.1');\n" +
      'setTimeout(() => process.exit(0), 60000);\n',
    { mode: 0o755 },
  );
  process.env.PATH = `${kubectlDir}${path.delimiter}${realPath ?? ''}`;
}

function spawned(): { pid: number; argv: string[] }[] {
  if (kubectlDir === '') return [];
  const log = path.join(kubectlDir, 'spawned.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { pid: number; argv: string[] });
}

function killSpawned(): void {
  for (const { pid } of spawned()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  if (kubectlDir !== '') fs.rmSync(path.join(kubectlDir, 'spawned.jsonl'), { force: true });
}

/** The cluster, scripted: a Running Rocket.Chat pod, and whatever else a test names. */
function cluster(
  answer: (joined: string, argv: readonly string[]) => Partial<KubectlResult> | undefined = () =>
    undefined,
): void {
  kube.run = (argv) => {
    const joined = argv.join(' ');
    const reply =
      answer(joined, argv) ??
      (argv.includes('pod')
        ? { stdout: JSON.stringify({ items: [{ status: { phase: 'Running' } }] }) }
        : {});
    return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '', ...reply });
  };
}

/** Long enough for a node child to bind, short enough that a doomed wait stays quick. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 100));

afterEach(async () => {
  kube.run = realRun;
  killSpawned();
  if (kubectlDir !== '') fs.rmSync(kubectlDir, { recursive: true, force: true });
  kubectlDir = '';
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once('exit', () => resolve());
          child.kill('SIGKILL');
        }),
    ),
  );
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

// --- whose socket it is --------------------------------------------------------------------

describe('whose socket a forward is', () => {
  it('is confirmed by OWNING the socket, not by the port answering', async () => {
    // `forwardBound` asked whether the PORT answered, and lost that race 3 times out of 3
    // against a squatter -- in a tenth of a millisecond. The defect IS the timing, so the
    // squatter and the child here are real: a stub would answer whatever it was told.
    const squatter = await listen(0, '127.0.0.1');
    const { port } = squatter.address() as net.AddressInfo;
    // A child that exits at once, standing in for a kubectl that cannot bind.
    const doomed = spawn('sh', ['-c', 'exit 1'], { stdio: 'ignore' });
    children.push(doomed);
    const pid = doomed.pid as number;
    expect(await forwardBound(pid, port, { tries: 3, interval: 0.1 })).toBe(false);
    // And the ownership question itself, both ways.
    expect(pidOwnsPort(pid, port)).toBe(false);
    expect(pidOwnsPort(process.pid, port)).toBe(true);
  });

  it('does not certify a forward that got only one address family', async () => {
    // `kubectl port-forward` binds "localhost", which is BOTH 127.0.0.1 and [::1]. If
    // an IPv4-only process already holds the port, kubectl does NOT fail -- it binds [::1]
    // alone and runs happily -- and `pidOwnsPort` said yes, so every IPv4 client reached
    // the squatter. The squatter is a CHILD, because a socket this process binds is by
    // definition its own.
    const mine = await listen(0, '::1');
    const { port } = mine.address() as net.AddressInfo;
    // Only this process holds it: exclusive, which is the healthy forward.
    expect(pidOwnsPort(process.pid, port)).toBe(true);
    expect(pidOwnsPortExclusively(process.pid, port)).toBe(true);
    // A pid that holds nothing on it answers no to both.
    expect(pidOwnsPortExclusively(1, port)).toBe(false);

    holder(
      [],
      `require('net').createServer().listen(${String(port)}, '127.0.0.1');` +
        'setInterval(() => {}, 1000)',
    );
    await waitFor('the IPv4 squatter', () => listeningInodes(port).size > 1);
    // THE SPLIT. Presence still says yes -- our IPv6 socket is really there -- and that is
    // exactly the answer that certified a broken URL.
    expect(pidOwnsPort(process.pid, port)).toBe(true);
    expect(pidOwnsPortExclusively(process.pid, port)).toBe(false);
  });
});

describe('which process is OUR forward', () => {
  it('knows a forward that hid its own arguments, but only while it holds the port', async () => {
    // On a host where `kubectl` is a symlink to `k3s`, the multi-call binary rewrites its
    // own argv and /proc/<pid>/cmdline reads `kubectl` and then nothing. Measured: `ss
    // -ltnp` showed that pid holding :3000 while this answered "dead", so `ensurePortForward`
    // respawned onto a port its own live forward held, every call. `process.title` makes
    // exactly that shape: the name, and nothing after it.
    const port = await freePort();
    const hidden = holder(
      [],
      `process.title = 'kubectl';` +
        `require('net').createServer().listen(${String(port)}, '127.0.0.1');` +
        'setInterval(() => {}, 1000)',
    );
    await waitFor('the hidden forward to bind', () => pidOwnsPort(hidden.pid as number, port));
    expect(forwardAlive(hidden.pid, { namespace: 'houston-k', hostPort: port })).toBe(true);
    // ...but only while the port it was started for is actually held: three facts, together.
    expect(forwardAlive(hidden.pid, { namespace: 'houston-k', hostPort: await freePort() })).toBe(
      false,
    );

    // A recycled pid running something else is still refused.
    const other = await freePort();
    const nginx = holder(
      [],
      `process.title = 'nginx';` +
        `require('net').createServer().listen(${String(other)}, '127.0.0.1');` +
        'setInterval(() => {}, 1000)',
    );
    await waitFor('nginx to bind', () => pidOwnsPort(nginx.pid as number, other));
    expect(forwardAlive(nginx.pid, { namespace: 'houston-k', hostPort: other })).toBe(false);

    // And a FULL argv is still matched strictly, so a different workspace's forward on a
    // recycled pid does not pass.
    const theirs = holder([
      'kubectl',
      '--context',
      'c',
      '-n',
      'houston-OTHER',
      'port-forward',
      'deployment/x',
      '3000:3000',
    ]);
    const ours = holder([
      'kubectl',
      '--context',
      'c',
      '-n',
      'houston-k',
      'port-forward',
      'deployment/x',
      '3000:3000',
    ]);
    await waitFor('the argv to be readable', () =>
      forwardAlive(ours.pid, { namespace: 'houston-k', hostPort: 3000 }),
    );
    expect(forwardAlive(theirs.pid, { namespace: 'houston-k', hostPort: 3000 })).toBe(false);
  });

  it('is identified by its argv, so a recycled pid is not our forward', async () => {
    // The check was "is this process a kubectl port-forward" -- liveness wearing identity's
    // clothes. A recycled pid belonging to another workspace's forward passed it, so houston
    // could decline to start the forward it needed and signal a stranger at teardown.
    const argvFor = (namespace: string, ports: string) => [
      'kubectl',
      '--context',
      'c',
      '-n',
      namespace,
      'port-forward',
      'deployment/rocketchat-rocketchat',
      ports,
    ];
    const mine = holder(argvFor('houston-mine', '3001:3000'));
    const theirs = holder(argvFor('houston-theirs', '3002:3000'));
    const longer = holder(argvFor('houston-mine', '13001:3000'));
    const server = holder(['busybox', 'httpd', '-f', '-p', '8000']);
    await waitFor('the argv to be readable', () =>
      forwardAlive(mine.pid, { namespace: 'houston-mine', hostPort: 3001 }),
    );
    // Someone else's workspace, same box, recycled pid.
    expect(forwardAlive(theirs.pid, { namespace: 'houston-mine', hostPort: 3001 })).toBe(false);
    // Same namespace, different port -- a substring test would have matched 13001.
    expect(forwardAlive(longer.pid, { namespace: 'houston-mine', hostPort: 3001 })).toBe(false);
    // Not a port-forward at all.
    expect(forwardAlive(server.pid, { namespace: 'houston-mine', hostPort: 3001 })).toBe(false);
  });

  it('retires the previous forward by the port it is ON, not the port being asked for', async () => {
    // `up --port 3261` asked about the NEW port, got false, recorded pid 0 and left
    // the old kubectl holding 3260 with nothing able to find it again -- it survived
    // `down --volumes` for the same reason.
    const old = holder([
      'kubectl',
      '--context',
      'c',
      '-n',
      'ns',
      'port-forward',
      'deployment/x',
      '3260:3000',
    ]);
    const pid = old.pid as number;
    await waitFor('the argv to be readable', () =>
      forwardAlive(pid, { namespace: 'ns', hostPort: 3260 }),
    );
    const gone = new Promise<void>((resolve) => old.once('exit', () => resolve()));

    // Asked about the new port: not our forward, and nothing is signalled.
    expect(stopForward(pid, { namespace: 'ns', hostPort: 3261 })).toBe(false);
    expect(running(pid)).toBe(true);
    // Asked about the port it is actually on: retired.
    const events: Event[] = [];
    expect(stopForward(pid, { namespace: 'ns', hostPort: 3260, emit: (e) => events.push(e) })).toBe(
      true,
    );
    await gone;
    expect(events.map((event) => event.message).join(' ')).toContain('3260');
    // No recorded pid at all is not an error.
    expect(stopForward(0, { namespace: 'ns', hostPort: 3260 })).toBe(false);
  });
});

describe('publishing a workspace', () => {
  it('forwards to the DEPLOYMENT, on the container port', async () => {
    // `port-forward svc/...` needs a ready ENDPOINT, and a Service has none until its pod
    // passes readiness -- so the first version exited straight after `helm install` and
    // the URL `up` printed never answered. A deployment target only needs a pod to exist.
    installKubectl('listen');
    cluster();
    const port = await freePort();
    const pid = await portForward('k', {
      namespace: 'houston-k',
      context: CONTEXT,
      hostPort: port,
      sleep: settle,
    });
    const [started] = spawned();
    expect(pid).toBe(started?.pid);
    const argv = started?.argv ?? [];
    expect(argv[argv.indexOf('port-forward') + 1]?.startsWith('deployment/')).toBe(true);
    // The container port is 3000; the Service's is 80.
    expect(argv.at(-1)).toBe(`${String(port)}:3000`);
  });

  it('replaces a dead forward rather than trusting a recorded pid', async () => {
    // A forward dies with its pod, so a recorded pid is not evidence it is alive -- and a
    // recycled pid is not evidence it is OURS.
    expect(forwardAlive(null)).toBe(false);
    expect(forwardAlive(999999999)).toBe(false); // a pid that cannot be read is dead
    installKubectl('listen');
    cluster();
    const port = await freePort();
    const pid = await ensurePortForward('k', {
      namespace: 'ns',
      context: CONTEXT,
      hostPort: port,
      pid: 999999999,
    });
    expect(spawned()).toHaveLength(1); // it did not trust the dead pid
    expect(pid).toBe(spawned()[0]?.pid);
  });

  it('carries --bind to the forward, and never widens loopback on its own', async () => {
    // `--bind 0.0.0.0` was accepted on this path and then dropped -- a workspace created for
    // a shared box was reachable only from localhost and nothing said so. The default must
    // stay loopback: repros ship fixed weak credentials.
    installKubectl('listen');
    cluster();
    await portForward('n', {
      namespace: 'ns',
      context: CONTEXT,
      hostPort: await freePort(),
      bindHost: '0.0.0.0',
      sleep: settle,
    });
    const wide = spawned()[0]?.argv ?? [];
    expect(wide[wide.indexOf('--address') + 1]).toBe('0.0.0.0');
    for (const quiet of ['', '127.0.0.1', 'localhost']) {
      killSpawned();
      await portForward('n', {
        namespace: 'ns',
        context: CONTEXT,
        hostPort: await freePort(),
        bindHost: quiet,
        sleep: settle,
      });
      expect([quiet, spawned()[0]?.argv.includes('--address')]).toEqual([quiet, false]);
    }
  });

  it('records no pid for a forward that never bound, and says which of two causes it was', async () => {
    // kubectl cannot share a port: something already holding it makes kubectl exit within
    // milliseconds -- to DEVNULL -- and the pid used to be recorded anyway, naming a dead
    // process while the squatter answered the URL.
    installKubectl('exit');
    cluster();
    const port = await freePort();
    await listen(port, '127.0.0.1'); // THE SQUATTER HOLDS THE PORT
    const said: string[] = [];
    const emit = (event: Event) => said.push(event.message);
    expect(
      await portForward('k', {
        namespace: 'ns',
        context: CONTEXT,
        hostPort: port,
        emit,
        sleep: settle,
      }),
    ).toBe(0);
    expect(said.some((message) => message.includes('something else already holds it'))).toBe(true);

    // THE OTHER CAUSE, and the commonest: during a rolling update the pod goes away, kubectl
    // exits and NOTHING holds the port. This printed the squatter message anyway and told
    // the reader to run `down` then `up` -- a false alarm prescribing destruction.
    said.length = 0;
    const empty = await freePort();
    expect(
      await portForward('k', {
        namespace: 'ns',
        context: CONTEXT,
        hostPort: empty,
        emit,
        sleep: settle,
      }),
    ).toBe(0);
    expect(said.some((message) => message.includes('not a collision'))).toBe(true);
    expect(said.some((message) => message.includes('down --name'))).toBe(false);

    // And the ordinary case still works: the child alive and holding its own socket.
    fs.writeFileSync(path.join(kubectlDir, 'mode'), 'listen');
    killSpawned();
    const ok = await freePort();
    const pid = await portForward('k', {
      namespace: 'ns',
      context: CONTEXT,
      hostPort: ok,
      sleep: settle,
    });
    expect(pid).toBe(spawned()[0]?.pid);
    expect(pid).toBeGreaterThan(0);
  });

  it('forwards a scenario’s UI to the deployment, on the CONTAINER port', async () => {
    // A live OIDC workspace: Keycloak 1/1 Running, the recorded forward pid gone, nothing
    // answering. `port-forward svc/...` dies when the Service's endpoint churns, and a
    // deployment forward has to publish the container port -- for SAML those differ.
    installKubectl('listen');
    const port = await freePort();
    cluster((joined) => {
      if (joined.includes('get svc')) return { stdout: `keycloak ${String(port)} 8080\n` };
      if (joined.includes('endpointslices')) {
        return {
          stdout: JSON.stringify({
            items: [
              {
                metadata: { labels: { 'kubernetes.io/service-name': 'keycloak' } },
                endpoints: [{ conditions: { ready: true } }],
              },
            ],
          }),
        };
      }
      return undefined;
    });
    const out = await scenarioUiForwards('w', {
      namespace: 'houston-w',
      context: CONTEXT,
      sleep: settle,
    });
    const [started] = spawned();
    expect(out).toEqual({ [port]: started?.pid });
    const argv = started?.argv ?? [];
    expect(argv).toContain('deployment/keycloak');
    expect(argv.some((arg) => arg.startsWith('svc/'))).toBe(false);
    // host:container, so the CONTAINER port is what it maps to.
    expect(argv).toContain(`${String(port)}:8080`);
  });
});

describe('telling somebody the URL is dead', () => {
  it('retries before it hands over a Grafana URL', async () => {
    // `kubectl port-forward` returns a pid before it binds, and `houston monitor` reported
    // attached and exited 0 while a curl to the URL it printed got nothing at all.
    const slept: number[] = [];
    expect(
      await forwardReachable(1, {
        tries: 3,
        interval: 0.01,
        sleep: (seconds) => {
          slept.push(seconds);
          return Promise.resolve();
        },
      }),
    ).toBe(false);
    expect(slept).toHaveLength(3); // it must retry rather than check once
  });

  it('says a dead forward out loud, names the repair, and is silent when it cannot know', async () => {
    // `list` showed `running` beside a URL that refused connections. "running" is not
    // WRONG -- it is the pods' state -- which is why the reader had nothing to go on. So the
    // note is derived on every read, and disappears the moment the forward is back.
    const meta = metadata({
      name: 'k',
      project: 'houston-k',
      rcVersion: '8.5.1',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
    });
    topology.stamp(meta.extra, topology.KUBERNETES);
    Object.assign(meta.extra, {
      context: CONTEXT,
      namespace: 'houston-k',
      port_forward_pid: 999999999,
    });
    const titles = () => noteGroupsOf(meta).map((group) => group.title);

    const dead = noteGroupsOf(meta).find(
      (group) => group.title === 'The URL is not published right now',
    );
    expect(dead).toBeDefined();
    expect(dead?.commands.some((command) => command.includes('houston ready --name k'))).toBe(true);
    expect(dead?.body.some((line) => line.includes('localhost:3000'))).toBe(true);
    // It must not read as an accusation against Rocket.Chat, which may be fine.
    expect(dead?.body.some((line) => line.includes('says nothing about Rocket.Chat'))).toBe(true);

    // A live forward says nothing at all.
    const live = holder([
      'kubectl',
      '--context',
      CONTEXT,
      '-n',
      'houston-k',
      'port-forward',
      'deployment/rocketchat-rocketchat',
      '3000:3000',
    ]);
    await waitFor('the argv to be readable', () =>
      forwardAlive(live.pid, { namespace: 'houston-k', hostPort: 3000 }),
    );
    meta.extra.port_forward_pid = live.pid;
    expect(titles()).not.toContain('The URL is not published right now');

    // AND NEITHER DOES A RECORD WITH NO PID: one written before the pid was tracked says
    // nothing about what is listening, so a note claiming a fact must stay quiet.
    delete meta.extra.port_forward_pid;
    expect(titles()).not.toContain('The URL is not published right now');

    // A Compose workspace publishes a real port and is not affected.
    const compose = metadata({
      name: 'd',
      project: 'houston-d',
      rootUrl: 'http://localhost:3001',
      hostPort: 3001,
    });
    expect(noteGroupsOf(compose).map((group) => group.title)).not.toContain(
      'The URL is not published right now',
    );
  });
});
