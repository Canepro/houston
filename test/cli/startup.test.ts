/**
 * What the entry point does before any command runs.
 *
 * An earlier version's `runMain` went straight to the event log: it never adopted a
 * pre-rename home and never asked who owned this one. So a home another build had claimed
 * was written to by this one -- `logs/` first -- and a fresh home was left unclaimed, which
 * is the opposite of what the marker contract in `src/core/promote.ts` requires. The build
 * runs through its real entry point, `tools/cli.js`, because the refusal only exists there.
 *
 * The terminal, pipe and lock drivers below are system tools -- util-linux `script` for a
 * pseudo-terminal, a shell pipeline or a FIFO for an OS pipe, `flock(1)` for a held lock --
 * because Node has no pseudo-terminal, and a Node child's stdout is a socket, not an OS pipe.
 * They run no houston code.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { metadata, serialise } from '../../src/core/runner/record';
import { MARKER_NAME, conflictReason } from '../../src/lib/lock';

const ROOT = path.resolve(__dirname, '..', '..');
const TS_CLI = path.join(ROOT, 'tools', 'cli.js');
const VERSION = (require('../../package.json') as { version: string }).version;

const homes: string[] = [];
function freshHome(): string {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-startup-'));
  homes.push(made);
  return made;
}
afterEach(() => {
  for (const one of homes.splice(0)) fs.rmSync(one, { recursive: true, force: true });
});

function run(home: string, argv: string[], extra: NodeJS.ProcessEnv = {}) {
  const proc = spawnSync(process.execPath, [TS_CLI, ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HOUSTON_HOME: home, NO_COLOR: '1', ...extra },
    timeout: 120_000,
  });
  return { code: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

/**
 * The shape of a startup refusal in a home another build claimed. An unknown build: a home
 * carrying the marker earlier releases write is adopted in the marker window, so it does not refuse.
 */
function refusal(argv: string[]) {
  const home = freshHome();
  fs.writeFileSync(path.join(home, MARKER_NAME), 'rust\n');
  const got = run(home, argv);
  const lines = got.stdout.split('\n').filter(Boolean);
  const envelope =
    lines.length === 0
      ? null
      : (JSON.parse(lines[lines.length - 1] as string) as {
          ok: boolean;
          schema: string;
          error: { code: string; message: string } | null;
        });
  return {
    home,
    got,
    shape: {
      code: got.code,
      stdoutLines: lines.length,
      envelope:
        envelope === null
          ? null
          : { ok: envelope.ok, schema: envelope.schema, code: envelope.error?.code },
      stackTrace: /\n\s+at /u.test(got.stderr),
      // Nothing written on the way out either: this build used to log the refusal as an
      // `error` line INTO the refused home, the one directory the refusal protects.
      written: fs.readdirSync(home).sort(),
      marker: fs.readFileSync(path.join(home, MARKER_NAME), 'utf8'),
    },
  };
}

describe('the entry point, before any command', () => {
  it.each([
    [['list'], { code: 3, stdoutLines: 0, envelope: null }],
    [
      ['list', '--json'],
      {
        code: 3,
        stdoutLines: 1,
        envelope: { ok: false, schema: 'houston.error.v1', code: 'PREFLIGHT_FAILED' },
      },
    ],
  ] as [string[], object][])(
    'refuses a home the other build owns, through the contract: %j',
    (argv, answer) => {
      const ours = refusal(argv);
      expect(ours.shape).toEqual({
        ...answer,
        stackTrace: false,
        written: [MARKER_NAME],
        marker: 'rust\n',
      });
      // The prose is the library's, naming the build that owns the home.
      expect(ours.got.stderr).toBe(`error: ${String(conflictReason(ours.home))}\n`);
    },
  );

  it('claims a fresh home as dual-v1, since the marker window keeps dual-v1 on write', () => {
    const home = freshHome();
    const got = run(home, ['list', '--json']);
    expect({
      code: got.code,
      marker: fs.readFileSync(path.join(home, MARKER_NAME), 'utf8').split('\n')[0],
    }).toEqual({ code: 0, marker: 'dual-v1' });
  });

  it('adopts a home an earlier release wrote, once, and says so once', () => {
    const home = freshHome();
    // A home in the shape earlier releases left: this build's own writers, then their marker.
    expect(run(home, ['users', 'add', 'alice', 'admin']).code).toBe(0);
    fs.writeFileSync(path.join(home, MARKER_NAME), 'python\n');
    const first = run(home, ['list', '--json']);
    const lines = first.stdout.split('\n').filter(Boolean);
    const envelope = JSON.parse(lines[lines.length - 1] as string) as { ok: boolean };
    expect({ code: first.code, ok: envelope.ok, stdoutLines: lines.length }).toEqual({
      code: 0,
      ok: true,
      stdoutLines: 1,
    });
    expect(first.stderr).toContain('dual-v1');
    expect(fs.readFileSync(path.join(home, MARKER_NAME), 'utf8')).toBe('dual-v1\n');
    expect(fs.existsSync(path.join(home, 'IMPLEMENTATION.transition'))).toBe(false);
    const second = run(home, ['list', '--json']);
    expect({ code: second.code, stderr: second.stderr }).toEqual({ code: 0, stderr: '' });
  });

  it('refuses a home an earlier release wrote that it cannot read, and leaves it as it was', () => {
    const home = freshHome();
    expect(run(home, ['users', 'add', 'alice', 'admin']).code).toBe(0);
    fs.writeFileSync(path.join(home, MARKER_NAME), 'python\n');
    fs.writeFileSync(path.join(home, 'users'), Buffer.from([0xff, 0xfe, 0x00, 0x7b]));
    const got = run(home, ['list', '--json']);
    expect(got.code).not.toBe(0);
    expect(/\n\s+at /u.test(got.stderr)).toBe(false);
    expect(fs.readFileSync(path.join(home, MARKER_NAME), 'utf8')).toBe('python\n');
    expect(fs.existsSync(path.join(home, 'IMPLEMENTATION.transition'))).toBe(false);
  });

  it('claims an empty home as dual-v1 under a mixed table', () => {
    // The table variable says mixed; an empty home is claimed dual-v1.
    const home = freshHome();
    const got = run(home, ['list', '--json'], { HOUSTON_DISPATCHED_TABLE: 'mixed' });
    expect({
      code: got.code,
      marker: fs.readFileSync(path.join(home, MARKER_NAME), 'utf8'),
    }).toEqual({ code: 0, marker: 'dual-v1\n' });
  });

  it('records the command line with its credentials masked', () => {
    // The log outlives the process and is read after the fact, so a token typed on the
    // command line must not land in it. Every spelling: a whole-value flag, a KEY=VALUE flag
    // masked by its key, and URL userinfo.
    const home = freshHome();
    const argv = [
      'up',
      '--reg-token',
      'TOKEN-1234',
      '--setting',
      'LDAP_Authentication_Password=hunter2',
      '-e',
      'MONGO_URL=mongodb://rc:s3cret@h/db',
      '--set=bind_password=pw9',
      '--help',
    ];
    const got = run(home, argv);
    const log = fs.readFileSync(path.join(home, 'logs', 'houston.log'), 'utf8');
    const start = JSON.parse(log.split('\n')[0] as string) as { cmd: string };
    expect({
      code: got.code,
      leaked: ['TOKEN-1234', 'hunter2', 's3cret', 'pw9'].filter((s) => log.includes(s)),
    }).toEqual({ code: 0, leaked: [] });
    expect(start.cmd).toBe(
      'up --reg-token ******** --setting LDAP_Authentication_Password=******** ' +
        '-e MONGO_URL=mongodb://rc:********@h/db --set=bind_password=******** --help',
    );
  });

  it('records which build answered and whether bin/houston sent it', () => {
    // `impl` and `via` on every record. The build is `dispatcher` only for its OWN route;
    // the other build's route, or none, is `direct`.
    const outcome = ['ts', 'py', undefined].map((route) => {
      const home = freshHome();
      const extra = route === undefined ? {} : { HOUSTON_DISPATCHED_ROUTE: route };
      const got = run(home, ['list', '--json'], extra);
      const log = fs.readFileSync(path.join(home, 'logs', 'houston.log'), 'utf8');
      const rows = log
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { impl?: string; via?: string });
      return { code: got.code, stamps: [...new Set(rows.map((r) => `${r.impl}/${r.via}`))] };
    });
    expect(outcome).toEqual([
      { code: 0, stamps: ['typescript/dispatcher'] },
      { code: 0, stamps: ['typescript/direct'] },
      { code: 0, stamps: ['typescript/direct'] },
    ]);
  });

  /**
   * The entry point's answers to four argv in a home whose `users` `plant` broke, and the
   * log records it wrote there. A stack trace is the runtime's own frames, so stderr is then
   * read by the line after it, the report.
   */
  function accountsOutcome(plant: (users: string) => void) {
    const home = freshHome();
    plant(path.join(home, 'users'));
    const answers = [['up', '--help'], ['list', '--json'], ['--help'], ['nosuch']].map((argv) => {
      const got = run(home, argv);
      // The error's code, or -- for a build that answered -- the schema it answered with.
      const parsed = got.stdout.trim().startsWith('{')
        ? (JSON.parse(got.stdout.trim().split('\n').pop() as string) as {
            schema: string;
            error: { code: string } | null;
          })
        : null;
      const envelope = parsed === null ? null : (parsed.error?.code ?? parsed.schema);
      const stderr = got.stderr.split(home).join('$HOUSTON_HOME');
      const traced = /\n {4}at /u.test(stderr);
      return {
        argv,
        code: got.code,
        envelope,
        stderr: traced
          ? { stackTrace: stderr.trimEnd().split('\n').pop() }
          : stderr.startsWith('error: ')
            ? stderr
            : stderr.slice(0, 7),
      };
    });
    // A build that wrote nothing has no log at all, which is an answer, not a crash.
    const logFile = path.join(home, 'logs', 'houston.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const records = log
      .split('\n')
      .filter(Boolean)
      .map(
        (line) => JSON.parse(line) as { kind: string; code?: string; cmd: string; trace?: boolean },
      )
      .map((row) => `${row.kind} ${row.code ?? ''} cmd=${row.cmd} trace=${String(row.trace)}`);
    return { answers, records };
  }

  it('answers and records an accounts file it cannot read', () => {
    // The root callback reads `users` once a command name resolves, before the command's argv
    // is parsed -- so `up --help` is the refusal and `--help` is not -- and `main`'s own
    // `start` line, which names the actor, fails on the same read. Earlier releases then write no
    // `start` and no `end`: one `error` line for a refused run, nothing for the others. This
    // build wrote an `end` for every one of them, and answered `up --help` with the help.
    const ours = accountsOutcome((users: string) => fs.mkdirSync(users));
    const refused = 'error: cannot read $HOUSTON_HOME/users: Is a directory\n';
    expect(ours.answers).toEqual([
      { argv: ['up', '--help'], code: 2, envelope: null, stderr: refused },
      { argv: ['list', '--json'], code: 2, envelope: 'VALIDATION_FAILED', stderr: refused },
      { argv: ['--help'], code: 0, envelope: null, stderr: '' },
      { argv: ['nosuch'], code: 2, envelope: null, stderr: 'Usage: ' },
    ]);
    expect(ours.records).toEqual([
      'error VALIDATION_FAILED cmd= trace=false',
      'error VALIDATION_FAILED cmd= trace=false',
    ]);
  });

  it('answers and records an accounts file that is not UTF-8 as unhandled', () => {
    // Earlier releases decode the file strictly and catch only an OS error around the read,
    // so the decode error escapes the root callback and the app, and `main` reports it as
    // unhandled: the stack trace, the "this is unhandled" line, exit 1, a REPRO_ERROR envelope
    // under --json, and ONE `error` record with `trace` -- the log's mark of a defect. This
    // build decoded the file leniently, read the account as `al\ufffdice`, and answered `up
    // --help` with the help and `list --json` with the list, exit 0, a `start` and an `end`.
    const ours = accountsOutcome((users: string) =>
      fs.writeFileSync(users, Buffer.from('al\xffice:x:2026-01-01:admin\n', 'latin1')),
    );
    const unhandled =
      'error: $HOUSTON_HOME/users is not valid UTF-8 (byte 0xff at position 2: invalid start ' +
      'byte) - this is unhandled, and the stack trace is on stderr. If it names a file under ' +
      'HOUSTON_HOME, that file is the problem.';
    expect(ours.answers).toEqual([
      { argv: ['up', '--help'], code: 1, envelope: null, stderr: { stackTrace: unhandled } },
      {
        argv: ['list', '--json'],
        code: 1,
        envelope: 'REPRO_ERROR',
        stderr: { stackTrace: unhandled },
      },
      { argv: ['--help'], code: 0, envelope: null, stderr: '' },
      { argv: ['nosuch'], code: 2, envelope: null, stderr: 'Usage: ' },
    ]);
    expect(ours.records).toEqual([
      'error REPRO_ERROR cmd= trace=true',
      'error REPRO_ERROR cmd= trace=true',
    ]);
  });

  it('finishes an interrupted pre-rename adoption before it logs anything', () => {
    // `pending()` is also true for a home the move reached but the in-place fixes did not:
    // the old log name is still there. It must be renamed before the event log writes, or
    // the first command after an upgrade splits the history across two files.
    const home = freshHome();
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'logs', 'rc-repro.log'), '{"kind":"old"}\n');
    const got = run(home, ['list', '--json']);
    expect({
      code: got.code,
      logs: fs.readdirSync(path.join(home, 'logs')).sort(),
      first: fs.readFileSync(path.join(home, 'logs', 'houston.log'), 'utf8').split('\n')[0],
      stdoutLines: got.stdout.split('\n').filter(Boolean).length,
    }).toEqual({ code: 0, logs: ['houston.log'], first: '{"kind":"old"}', stdoutLines: 1 });
  });
});

// ------------------------------------------------------------------------------- Ctrl-C

/**
 * `ticket-7`'s record and compose file, as this build's own writer spells them, its URL on
 * a port nothing serves -- or on `port`'s -- with `compose` and the record's `extra` when
 * they are given.
 */
function writeTicket7(
  home: string,
  port: number,
  compose: string,
  extra?: Record<string, unknown>,
) {
  const url = `http://localhost:${String(port)}`;
  const bag: Record<string, unknown> = { ...(extra ?? { deployment: 'compose' }) };
  bag.env ??= { ROOT_URL: url };
  const meta = metadata({
    name: 'ticket-7',
    project: 'houston-ticket-7',
    rcVersion: '7.4.1',
    rcImage: 'registry.rocket.chat/rocketchat/rocket.chat:7.4.1',
    mongoTag: '7.0',
    mongoFlavor: 'bitnami-legacy',
    preset: 'default',
    rootUrl: url,
    hostPort: port,
    versionSource: 'map (fallback)',
    pinned: true,
    createdAt: '2026-09-18T09:30:00+00:00',
    extra: bag,
  });
  const workspace = path.join(home, 'repros', 'ticket-7');
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(workspace, 'repro.json'), serialise(meta), { mode: 0o644 });
  fs.writeFileSync(
    path.join(workspace, 'docker-compose.yml'),
    compose || 'name: houston-ticket-7\nservices: {}\n',
    { mode: 0o644 },
  );
}

/**
 * A docker that answers the engine gate and reports ticket-7's containers running, so
 * `ready` polls; every call is appended to `calls`. The tools that could reach a real
 * cluster or cloud are not installed at all.
 */
const DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$(dirname "$0")/calls"
case "$*" in
  info*|version*) printf '27.0.0\\n' ;;
  *"compose version"*) printf '2.29.1\\n' ;;
  *"compose ps --all --format json"*)
    state=running
    if [ -f "$(dirname "$0")/writer-stopped" ]; then state=exited; fi
    printf '{"Service":"rocketchat","State":"%s"}\\n' "$state"
    ;;
  *"compose stop rocketchat"*) : > "$(dirname "$0")/writer-stopped" ;;
  *"compose start rocketchat"*) rm -f "$(dirname "$0")/writer-stopped" ;;
  *compose*" ps"*) printf 'rocketchat\\trunning\\tUp 10 seconds\\nmongodb\\trunning\\tUp 10 seconds\\n' ;;
esac
exit 0
`;
/**
 * The same docker, with `script` as its `compose logs`. Replaced by a function because a
 * replacement STRING reads the shell's `$$` as a single `$`.
 */
function withLogs(script: string): string {
  return DOCKER.replace('\nesac', () => `\n  *compose*" logs"*) ${script} ;;\nesac`);
}
/**
 * The same docker, with a `compose logs` that dies of SIGINT and has the interrupt reach
 * its parent 20 ms LATER. The helper's descriptors are closed, so compose's pipes close
 * when compose dies, not when the helper does.
 */
const DOCKER_LATE_INTERRUPT = withLogs(
  '(sleep 0.02; kill -INT "$PPID") </dev/null >/dev/null 2>&1 & kill -INT $$',
);
/** The same docker, with a `compose logs` that records its pid and becomes a `sleep 30`. */
const DOCKER_LOGS_CHILD = withLogs(
  'printf "pid %s\\n" "$$" >> "$(dirname "$0")/calls"; exec sleep 30',
);
const ABSENT_TOOLS = ['kubectl', 'helm', 'kind', 'aws', 'eksctl', 'k6', 'git', 'curl', 'wget'];

/** A workspace with the two services `backup` stops one of and dumps the other. */
const COMPOSE_TWO_SERVICES = `name: houston-ticket-7
services:
  rocketchat:
    image: registry.rocket.chat/rocketchat/rocket.chat:7.4.1
    environment:
      MONGO_URL: mongodb://mongodb:27017/rocketchat?replicaSet=rs0
  mongodb:
    image: bitnamilegacy/mongodb:7.0
`;
/** The same docker, with the database tools present and a mongodump that never finishes. */
const DOCKER_DUMPING = DOCKER.replace(
  '\nesac',
  () =>
    '\n  *"command -v mongodump"*) printf \'/usr/bin/mongodump\\n/usr/bin/mongorestore\\n\' ;;' +
    '\n  *mongodump*) printf "pid %s\\n" "$$" >> "$(dirname "$0")/calls"; exec sleep 30 ;;' +
    '\nesac',
);

/** The same docker, with a mongodump that writes its archive and finishes. */
const DOCKER_DUMPED = DOCKER.replace(
  '\nesac',
  () =>
    '\n  *"command -v mongodump"*) printf \'/usr/bin/mongodump\\n/usr/bin/mongorestore\\n\' ;;' +
    "\n  *mongodump*) printf 'fake-archive-bytes' ;;" +
    '\nesac',
);

/** The same docker, with a `compose pull` that never finishes. */
const DOCKER_PULLING = DOCKER.replace(
  '\nesac',
  () =>
    '\n  *compose*" pull"*) printf "pid %s\\n" "$$" >> "$(dirname "$0")/calls"; exec sleep 30 ;;' +
    '\nesac',
);

/** A kubectl whose `logs` prints a line, records its pid and becomes a `sleep 30`. */
const KUBECTL_FOLLOWING = `#!/bin/sh
printf '%s\\n' "$*" >> "$(dirname "$0")/calls"
case "$*" in
  *" logs "*) printf 'pid %s\\n' "$$" >> "$(dirname "$0")/calls"; echo "line from kubectl"; exec sleep 30 ;;
  *"get pods"*) printf 'pod/rocketchat-abc\\n' ;;
esac
exit 0
`;
/** ticket-7 as a Kubernetes workspace. */
const ON_KUBERNETES = { runtime: 'kubernetes', context: 'houston-test', deployment: 'monolith' };

/** The calls a stub was asked for after the child that recorded its pid had started. */
function callsAfterTheChild(calls: string): string[] {
  const lines = calls.split('\n').filter(Boolean);
  return lines.slice(lines.findIndex((line) => line.startsWith('pid ')) + 1);
}

/** What a workspace's journal holds, by kind. */
function notes(box: string): string[] {
  const dir = path.join(box, 'home', 'journal');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .map(
      (name) =>
        (JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { kind: string }).kind,
    );
}

/**
 * Run the build on a pseudo-terminal -- stdin, stdout and stderr all the one terminal -- and
 * type Ctrl-C a second after `marker` appears on it, or in the file `watched` names. The
 * terminal sends the SIGINT to the whole foreground process group, children included.
 * Node has no pty; util-linux `script` makes one, runs the command on it as the session's
 * leader, and relays what is written to its stdin -- here the Ctrl-C -- into the terminal. The
 * answer is the command's exit status and everything the terminal showed.
 */
async function onTerminal(
  marker: string,
  watched: string,
  argv: string[],
  { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; terminal: string }> {
  const quoted = argv.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(' ');
  const child = spawn(
    'script',
    ['--quiet', '--return', '--command', `exec ${quoted}`, '/dev/null'],
    {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  );
  let terminal = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (terminal += chunk));
  const run = { ended: false };
  const closed = new Promise<number | null>((resolve) =>
    child.on('close', (status) => {
      run.ended = true;
      resolve(status);
    }),
  );
  const seenInFile = () =>
    watched !== '' && fs.existsSync(watched) && fs.readFileSync(watched, 'utf8').includes(marker);
  const deadline = Date.now() + 90_000;
  let seen: number | null = null;
  let typed = false;
  while (!run.ended) {
    if (Date.now() > deadline) child.kill('SIGKILL');
    if (seen === null && (terminal.includes(marker) || seenInFile())) seen = Date.now();
    if (!typed && seen !== null && Date.now() - seen > 1000) {
      child.stdin.write('\x03');
      typed = true;
    }
    await sleep(50);
  }
  const status = await closed;
  child.stdin.end();
  return { status, terminal };
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * A Rocket.Chat on loopback with actual seed identity and creation response shapes;
 * a request whose path or body contains `hang` is never answered. Each request is kept
 * as `METHOD path body`.
 */
async function fakeRocketChat(hang?: string) {
  const seen: string[] = [];
  const emojis: Record<string, unknown>[] = [];
  const rooms = new Map<string, Record<string, unknown>>([
    ['GENERAL', { _id: 'GENERAL', name: 'general', t: 'c' }],
  ]);
  let sequence = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      const target = request.url ?? '';
      seen.push(`${request.method ?? ''} ${target} ${body}`.trim());
      if (hang !== undefined && `${target} ${body}`.includes(hang)) return;
      const url = new URL(target, 'http://127.0.0.1');
      const api = url.pathname;
      let payload: Record<string, unknown> = {};
      if (body !== '' && request.headers['content-type']?.includes('application/json') === true)
        payload = JSON.parse(body) as Record<string, unknown>;
      const send = (status: number, result: Record<string, unknown>) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result));
      };
      if (api === '/api/v1/users.info')
        return send(404, { success: false, errorType: 'error-user-not-found' });
      if (api === '/api/v1/users.create')
        return send(200, { success: true, user: { _id: `uid-${String(payload.username)}` } });
      if (api === '/api/v1/login') {
        const user = String(payload.user);
        return send(200, {
          success: true,
          data: { authToken: `token-${user}`, userId: `uid-${user}`, me: { _id: `uid-${user}` } },
        });
      }
      if (api === '/api/v1/emoji-custom.list')
        return send(200, { success: true, emojis: { update: emojis } });
      if (api === '/api/v1/emoji-custom.create') {
        const field = (name: string) =>
          new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]*)`, 'u').exec(body)?.[1] ?? '';
        emojis.push({
          _id: `emoji-${field('name')}`,
          name: field('name'),
          aliases: [field('aliases')],
        });
        return send(200, { success: true });
      }
      if (api === '/api/v1/channels.info' || api === '/api/v1/groups.info') {
        const room = [...rooms.values()].find((r) => r.name === url.searchParams.get('roomName'));
        return room === undefined
          ? send(404, { success: false, errorType: 'error-room-not-found' })
          : send(200, { success: true, [api.includes('groups') ? 'group' : 'channel']: room });
      }
      if (api === '/api/v1/rooms.adminRooms.getRoom' || api === '/api/v1/rooms.info') {
        const rid = url.searchParams.get(api.endsWith('rooms.info') ? 'roomId' : 'rid') ?? '';
        const room = rooms.get(rid);
        return room === undefined
          ? send(404, { success: false, errorType: 'error-room-not-found' })
          : send(200, { success: true, ...(api.endsWith('rooms.info') ? { room } : room) });
      }
      sequence += 1;
      if (api === '/api/v1/teams.create') {
        const rid = `room-${sequence}`;
        const teamId = `team-${sequence}`;
        rooms.set(rid, { _id: rid, name: payload.name, t: 'c', teamId, teamMain: true });
        return send(200, { success: true, team: { _id: teamId, roomId: rid } });
      }
      if (api === '/api/v1/channels.create' || api === '/api/v1/groups.create') {
        const rid = `room-${sequence}`;
        const room = {
          _id: rid,
          name: payload.name,
          t: api.includes('groups') ? 'p' : 'c',
          ...((payload.extraData ?? {}) as Record<string, unknown>),
        };
        rooms.set(rid, room);
        return send(200, { success: true, [api.includes('groups') ? 'group' : 'channel']: room });
      }
      if (api === '/api/v1/chat.sendMessage')
        return send(200, {
          success: true,
          message: {
            ...(payload.message as Record<string, unknown>),
            u: { _id: request.headers['x-user-id'] },
          },
        });
      if (api.startsWith('/api/v1/rooms.media/'))
        return send(200, {
          success: true,
          file: { _id: `file-${sequence}`, url: `/file-${sequence}` },
        });
      if (api.startsWith('/api/v1/rooms.mediaConfirm/'))
        return send(200, {
          success: true,
          message: {
            _id: `file-message-${sequence}`,
            rid: api.split('/').at(-2),
            msg: payload.msg,
            u: { _id: request.headers['x-user-id'] },
          },
        });
      send(200, {
        success: true,
        version: '7.4.1',
        info: { version: '7.4.1' },
        data: { authToken: 'token', userId: 'user', me: { _id: 'user' } },
        value: true,
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { port, seen, close };
}

/** A fresh box: a dual-v1 home holding ticket-7, its own HOME and TMPDIR, a stub PATH. */
interface BoxOptions {
  /** The workspace's compose file, where the default `services: {}` will not do. */
  readonly compose?: string;
  /** The record's `extra`, where the default Compose workspace will not do. */
  readonly extra?: Record<string, unknown>;
  /** The port the record's URL names: something serving there, or else nothing. */
  readonly port?: number;
  /** The kubectl on PATH, where the default one that exits 127 will not do. */
  readonly kubectl?: string;
}

async function interruptBox(
  docker = DOCKER,
  { compose = '', extra, port, kubectl }: BoxOptions = {},
): Promise<{ box: string; env: NodeJS.ProcessEnv }> {
  const box = freshHome();
  for (const dir of ['home', 'user', 'skills', 'tmp', 'bin']) fs.mkdirSync(path.join(box, dir));
  fs.writeFileSync(path.join(box, 'bin', 'docker'), docker, { mode: 0o755 });
  for (const tool of ABSENT_TOOLS) {
    fs.writeFileSync(path.join(box, 'bin', tool), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  }
  if (kubectl !== undefined) {
    fs.writeFileSync(path.join(box, 'bin', 'kubectl'), kubectl, { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = {
    PATH: [path.join(box, 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    HOME: path.join(box, 'user'),
    HOUSTON_HOME: path.join(box, 'home'),
    HOUSTON_SKILL_HOME: path.join(box, 'skills'),
    TMPDIR: path.join(box, 'tmp'),
    KUBECONFIG: path.join(box, 'absent', 'kubeconfig'),
    COLUMNS: '100',
    NO_COLOR: '1',
    TERM: 'dumb',
    LANG: 'C.UTF-8',
  };
  writeTicket7(path.join(box, 'home'), port ?? (await closedPort()), compose, extra);
  fs.writeFileSync(path.join(box, 'home', MARKER_NAME), 'dual-v1\n');
  return { box, env };
}

/** The event log's records, oldest first, reduced to what an interrupt changes. */
function records(box: string): { kind: string; exit?: number; trace?: boolean }[] {
  const file = path.join(box, 'home', 'logs', 'houston.log');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const { kind, exit, trace } = JSON.parse(line) as {
        kind: string;
        exit?: number;
        trace?: boolean;
      };
      return { kind, ...(exit === undefined ? {} : { exit }), ...(trace ? { trace } : {}) };
    });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start the build with stdin a pipe held OPEN -- a prompt is waiting, not reading end of input
 * -- wait until `blocked` says it is, give it a second more, and send SIGINT to its pid.
 * `docker` replaces the stub, and `prepare` runs on the box before the build starts.
 */
async function interrupted(
  argv: string[],
  blocked: (seen: { stdout: string; calls: string }) => boolean,
  {
    docker = DOCKER,
    prepare,
    twice = false,
    ...options
  }: {
    docker?: string;
    prepare?: (box: string) => Promise<void> | void;
    /** A second SIGINT 100 ms after the first: inside the first's grace period. */
    twice?: boolean;
  } & BoxOptions = {},
) {
  const { box, env } = await interruptBox(docker, options);
  await prepare?.(box);
  const child = spawn(process.execPath, [TS_CLI, ...argv], {
    cwd: box,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const closed = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('close', (status, signal) => resolve({ status, signal })),
  );
  const calls = () => {
    const file = path.join(box, 'bin', 'calls');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };
  const deadline = Date.now() + 90_000;
  while (!blocked({ stdout, calls: calls() })) {
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill('SIGKILL');
      throw new Error(`it never blocked: ${stdout}${stderr}`);
    }
    await sleep(50);
  }
  await sleep(1000);
  child.kill('SIGINT');
  if (twice) {
    await sleep(100);
    child.kill('SIGINT');
  }
  const guard = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const { status, signal } = await closed;
  clearTimeout(guard);
  child.stdin.end();
  return { status, signal, stdout, stderr, log: records(box), box, calls: calls() };
}

/** A stub records `pid <n>` for the child it becomes; which of those are still running. */
function stillRunning(calls: string): number[] {
  const alive: number[] = [];
  for (const line of calls.split('\n')) {
    const pid = /^pid (\d+)$/u.exec(line)?.[1];
    if (pid === undefined) continue;
    try {
      // A zombie still answers signal 0: its state is the third field of /proc/<pid>/stat.
      if (fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z') alive.push(+pid);
    } catch {
      /* gone */
    }
  }
  return alive;
}

/** Every process whose command line names `text`, but this one. */
function processesNaming(text: string): string[] {
  const found = spawnSync('pgrep', ['-f', '-a', text], { encoding: 'utf8' }).stdout;
  return found
    .split('\n')
    .filter(Boolean)
    .filter((line) => Number(line.split(' ')[0]) !== process.pid);
}

function killAll(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

describe('Ctrl-C, as earlier releases report it', () => {
  it('exits 130 with an end record when it stops a command, and says nothing more', async () => {
    // Earlier releases turn an interrupt inside the command into exit 130: no line of its own
    // and no envelope. An earlier version died by the signal -- no `end` record, and a signalled
    // status where earlier releases exit 130.
    const argv = ['ready', '--name', 'ticket-7', '--timeout', '60'];
    const polling = ({ stdout }: { stdout: string }) => stdout.includes('still booting');
    const shape = (got: Awaited<ReturnType<typeof interrupted>>) => ({
      status: got.status,
      signal: got.signal,
      stderr: got.stderr,
      last: got.log[got.log.length - 1],
    });
    expect(shape(await interrupted(argv, polling))).toEqual({
      status: 130,
      signal: null,
      stderr: '',
      last: { kind: 'end', exit: 130 },
    });
  }, 240_000);

  it('is Aborted. and exit 1 at a question, as earlier releases answer it', async () => {
    const argv = ['down', '--name', 'ticket-7', '--volumes'];
    const asking = ({ stdout }: { stdout: string }) => stdout.endsWith('Continue? [y/N]: ');
    const shape = (got: Awaited<ReturnType<typeof interrupted>>) => ({
      status: got.status,
      signal: got.signal,
      stdout: got.stdout,
      stderr: got.stderr,
      log: got.log,
    });
    expect(shape(await interrupted(argv, asking))).toEqual({
      status: 1,
      signal: null,
      // The question stays on its line: no newline, and nothing after it on stdout.
      stdout: 'This permanently deletes the data volume and record for ticket-7. Continue? [y/N]: ',
      stderr: 'Aborted.\n',
      log: [{ kind: 'start' }, { kind: 'end', exit: 1 }],
    });
  }, 240_000);

  it('is 130 when the child it waits on dies of the same Ctrl-C and is reported first', async () => {
    // A terminal's Ctrl-C reaches `logs` and its compose child together, and earlier releases
    // answered the interrupt first every time. Node can hand JS the child's death first:
    // `logs` then returned 0, since it discards compose's code, and `runMain` wrote `end` 0
    // and dropped the interrupt that came after (3 of 37 runs on a pty, measured). So the
    // build is put in that late order for certain: its compose dies of SIGINT, and the
    // interrupt reaches it 20 ms later.
    const argv = ['logs', '--name', 'ticket-7', '--follow'];
    const late = await interruptBox(DOCKER_LATE_INTERRUPT);
    const ran = spawnSync(process.execPath, [TS_CLI, ...argv], {
      cwd: late.box,
      env: late.env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect({
      // A death by a signal, reported negated, as the terminal driver's status reports it.
      status: ran.status ?? -os.constants.signals[ran.signal as NodeJS.Signals],
      written: ran.stdout + ran.stderr,
      log: records(late.box),
    }).toEqual({
      status: 130,
      written: '',
      log: [{ kind: 'start' }, { kind: 'end', exit: 130 }],
    });
  }, 240_000);

  it('kills the child it waits on when the SIGINT reaches Houston alone, as earlier releases did', async () => {
    // A SIGINT sent to the pid alone -- `kill -INT`, a supervisor, a test -- never reaches
    // the child. Earlier releases give it 0.25 s to die of the same Ctrl-C, then SIGKILL it
    // on the way out; `process.exit(130)` left compose running.
    const argv = ['logs', '--name', 'ticket-7', '--follow'];
    const waiting = ({ calls }: { calls: string }) => /^pid \d+$/mu.test(calls);
    const shape = async () => {
      const got = await interrupted(argv, waiting, { docker: DOCKER_LOGS_CHILD });
      await sleep(300);
      const left = stillRunning(got.calls);
      killAll(left);
      return { status: got.status, stderr: got.stderr, log: got.log, childrenLeft: left.length };
    };
    expect(await shape()).toEqual({
      status: 130,
      stderr: '',
      log: [{ kind: 'start' }, { kind: 'end', exit: 130 }],
      childrenLeft: 0,
    });
  }, 240_000);

  it('leaves nothing waiting for a workspace lock it was interrupted waiting on', async () => {
    // `down` behind another command's lock. Earlier releases' flock(2) wait is interrupted and
    // nothing is left waiting. This build's wait is a flock(1) child, which an earlier version's
    // `process.exit` left waiting: it took the lock once the other command released it, after the
    // command that wanted it had gone. The other command's lock is held by a flock(1) of its
    // own, which takes the same flock(2) lock and says `held` once it has it; `--close` keeps
    // the lock with flock itself, not the `sleep` it runs.
    const HOLD = ['-x', '--close'];
    const argv = ['down', '--name', 'ticket-7'];
    const gated = ({ calls }: { calls: string }) => calls.includes('compose version');
    const shape = async () => {
      let holder: ReturnType<typeof spawn> | undefined;
      let lock = '';
      const hold = async (box: string): Promise<void> => {
        lock = path.join(box, 'home', 'locks', 'ticket-7.lock');
        fs.mkdirSync(path.dirname(lock), { recursive: true });
        const started = spawn('flock', [...HOLD, lock, '-c', 'echo held; exec sleep 120'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          detached: true,
        });
        holder = started;
        await new Promise<void>((resolve) => started.stdout.once('data', () => resolve()));
      };
      try {
        const got = await interrupted(argv, gated, { prepare: hold });
        await sleep(300);
        const waiters = processesNaming(lock).filter(
          (line) => Number(line.split(' ')[0]) !== holder?.pid,
        );
        killAll(waiters.map((line) => Number(line.split(' ')[0])));
        return { status: got.status, stderr: got.stderr, log: got.log, waiters };
      } finally {
        // The holder and the `sleep` it runs, as one process group.
        if (holder?.pid !== undefined) process.kill(-holder.pid, 'SIGKILL');
      }
    };
    // The one event is the wait, SAID: `down` behind another command's lock used to wait in
    // silence for as long as that command ran.
    expect(await shape()).toEqual({
      status: 130,
      stderr: '',
      log: [{ kind: 'start' }, { kind: 'event' }, { kind: 'end', exit: 130 }],
      waiters: [],
    });
  }, 240_000);

  it.each([
    ['a Ctrl-C', false],
    ["a second Ctrl-C inside the first one's grace period", true],
  ])(
    'starts Rocket.Chat again when %s interrupts the dump, as earlier releases did',
    async (_how, twice) => {
      // In earlier releases the interrupt unwinds `backup` through the quiesce's exit:
      // `compose start rocketchat`, the `rocketchat_stopped` note cleared, a wait for it to
      // serve, and then the staging directory removed. `process.exit(130)` left the workspace
      // STOPPED, the note on disk, a houston-backup-* directory in TMPDIR and mongodump running.
      // A second Ctrl-C lands in the wait for the child: it is killed and the unwind goes on
      // the same way. Here it found nothing pending and ended the run there, which was case
      // 1's old outcome again.
      const argv = ['backup', '--name', 'ticket-7'];
      const dumping = ({ calls }: { calls: string }) => /^pid \d+$/mu.test(calls);
      const shape = async () => {
        const rc = await fakeRocketChat();
        try {
          const got = await interrupted(argv, dumping, {
            docker: DOCKER_DUMPING,
            compose: COMPOSE_TWO_SERVICES,
            port: rc.port,
            twice,
          });
          await sleep(300);
          const left = stillRunning(got.calls);
          killAll(left);
          return {
            status: got.status,
            stdout: got.stdout,
            stderr: got.stderr,
            log: got.log.map((record) => record.kind),
            callsAfter: callsAfterTheChild(got.calls).map((call) => call.split(' ').slice(0, 2)),
            requests: rc.seen,
            notes: notes(got.box),
            staging: fs.readdirSync(path.join(got.box, 'tmp')),
            childrenLeft: left.length,
          };
        } finally {
          await rc.close();
        }
      };
      expect(await shape()).toEqual({
        status: 130,
        stdout:
          '  stopping Rocket.Chat so the dump is consistent (Mongo keeps running)\n' +
          "  dumping database 'rocketchat'\n",
        stderr: '',
        log: ['start', 'event', 'event', 'end'],
        callsAfter: [
          ['compose', 'start'],
          // The wait for Rocket.Chat now also asks whether its one-shot setup finished.
          ['compose', 'ps'],
          ['inspect', '--format'],
          ['ps', '--all'],
        ],
        requests: ['GET /api/info'],
        notes: [],
        staging: [],
        childrenLeft: 0,
      });
    },
    240_000,
  );

  it('packs no bundle when a Ctrl-C lands in the wait for Rocket.Chat to serve again', async () => {
    // The dump is done and the quiesce's exit is waiting for Rocket.Chat. Earlier releases'
    // error handler around that wait does not catch the interrupt, so it leaves the exit and
    // no bundle is packed. An earlier version's `catch` did catch it: a warning, then "packing the
    // bundle", a bundle written and "backed up", and only then exit 130.
    const argv = ['backup', '--name', 'ticket-7'];
    const shape = async () => {
      const rc = await fakeRocketChat('/api/info');
      try {
        const waiting = () => rc.seen.some((request) => request.startsWith('GET /api/info'));
        const got = await interrupted(argv, waiting, {
          docker: DOCKER_DUMPED,
          compose: COMPOSE_TWO_SERVICES,
          port: rc.port,
        });
        const backups = path.join(got.box, 'home', 'backups');
        return {
          status: got.status,
          stdout: got.stdout,
          stderr: got.stderr,
          log: got.log.map((record) => record.kind),
          bundles: fs.existsSync(backups) ? fs.readdirSync(backups) : [],
          notes: notes(got.box),
          staging: fs.readdirSync(path.join(got.box, 'tmp')),
        };
      } finally {
        await rc.close();
      }
    };
    expect(await shape()).toEqual({
      status: 130,
      stdout:
        '  stopping Rocket.Chat so the dump is consistent (Mongo keeps running)\n' +
        "  dumping database 'rocketchat'\n",
      stderr: '',
      log: ['start', 'event', 'event', 'end'],
      bundles: [],
      notes: [],
      staging: [],
    });
  }, 240_000);

  it('leaves no create_unfinished note when interrupted in the pull, as earlier releases did', async () => {
    // Earlier releases write the note before the work and clear it in a handler an interrupt
    // reaches: they leave no note, and `process.exit(130)` left one for `doctor` to warn about
    // a workspace that was never made.
    const port = String(await closedPort());
    const argv = ['up', '--version', '7.4.1', '--name', 't9', '--offline', '--port', port];
    const pulling = ({ calls }: { calls: string }) => /^pid \d+$/mu.test(calls);
    const shape = async () => {
      const got = await interrupted(argv, pulling, { docker: DOCKER_PULLING });
      await sleep(300);
      const left = stillRunning(got.calls);
      killAll(left);
      return {
        status: got.status,
        stdout: got.stdout,
        // The stub records its pid before the parent has necessarily emitted the
        // next capacity event. Under parallel Jest load the build may print it
        // before SIGINT; neither ordering changes the interrupted cleanup.
        cleanStderr: !/\n\s+at |\bError:/u.test(got.stderr),
        log: {
          first: got.log[0],
          last: got.log.at(-1),
          hasEvent: got.log.some((record) => record.kind === 'event'),
          hasError: got.log.some((record) => record.kind === 'error'),
        },
        notes: notes(got.box),
        childrenLeft: left.length,
      };
    };
    expect(await shape()).toEqual({
      status: 130,
      stdout: "  creating 't9' - RC 7.4.1, Mongo 7.0 (bitnami-legacy), preset default\n",
      cleanStderr: true,
      log: {
        first: { kind: 'start' },
        last: { kind: 'end', exit: 130 },
        hasEvent: true,
        hasError: false,
      },
      notes: [],
      childrenLeft: 0,
    });
  }, 240_000);

  it.each([
    ['a room', '"name": "team-chat"'],
    ["a seeded user's login", '"user": "alice"'],
  ])(
    'puts back the settings seed turned off when interrupted in %s, as its finally does',
    async (_where, hang) => {
      // `seed` turns the rate limiter and email-2FA off, journals both, and puts them back in
      // a `finally` that an interrupt runs. `process.exit(130)` left both OFF and both notes on
      // disk; and the user login's catch, which in earlier releases does not catch an
      // interrupt, swallowed it, so the next request ended the run first.
      // stdout is left out: this build prints the seed's progress when it ends, not as it
      // goes, which is a difference of its own.
      const argv = ['seed', '--name', 'ticket-7'];
      const shape = async () => {
        const rc = await fakeRocketChat(hang);
        try {
          const hung = () => rc.seen.some((request) => request.includes(hang));
          const got = await interrupted(argv, hung, { port: rc.port });
          const at = rc.seen.findIndex((request) => request.includes(hang));
          return {
            status: got.status,
            stderr: got.stderr,
            log: got.log.map((record) => record.kind),
            requestsAfter: rc.seen.slice(at + 1),
            notes: notes(got.box),
          };
        } finally {
          await rc.close();
        }
      };
      expect(await shape()).toEqual({
        status: 130,
        stderr: '',
        log: ['start', 'end'],
        // The fake answers every setting `true`, so the encryption defaults were held off too.
        requestsAfter: [
          'POST /api/v1/settings/Accounts_TwoFactorAuthentication_By_Email_Enabled {"value": true}',
          'POST /api/v1/settings/API_Enable_Rate_Limiter {"value": true}',
          'POST /api/v1/settings/E2E_Enabled_Default_DirectRooms {"value": true}',
          'POST /api/v1/settings/E2E_Enabled_Default_PrivateRooms {"value": true}',
          'POST /api/v1/settings/E2E_Force_Encryption_For_Private_Rooms {"value": true}',
        ],
        notes: [],
      });
    },
    240_000,
  );

  it.each([
    ["SIGINT to houston's pid", 'pid'],
    ['Ctrl-C on a terminal', 'pty'],
  ])(
    "ends Kubernetes logs with kubectl's own code on %s, as earlier releases did",
    async (_how, how) => {
      // Earlier releases let the interrupt pass, terminate kubectl, and exit with its code
      // (0 when it has none), which for a death by a signal is its negation -- -15 from the
      // SIGTERM, or -2 when the terminal's Ctrl-C killed it first.
      // runMain's handler answered 130, and on a terminal the SIGTERM sent to the merge
      // relay the Ctrl-C had already killed came back as a JS stack.
      const argv = ['logs', '--name', 'ticket-7', '--follow'];
      const box = { kubectl: KUBECTL_FOLLOWING, extra: ON_KUBERNETES };
      const shape = async () => {
        if (how === 'pid') {
          const following = ({ calls }: { calls: string }) => /^pid \d+$/mu.test(calls);
          const got = await interrupted(argv, following, box);
          const left = stillRunning(got.calls);
          killAll(left);
          const written = got.stdout + got.stderr;
          return { status: got.status, written, log: got.log, childrenLeft: left.length };
        }
        const { box: made, env } = await interruptBox(DOCKER, box);
        const calls = path.join(made, 'bin', 'calls');
        const cli = [process.execPath, TS_CLI, ...argv];
        const typed = await onTerminal('pid ', calls, cli, { cwd: made, env });
        const left = stillRunning(fs.readFileSync(calls, 'utf8'));
        killAll(left);
        // `^C` is the terminal echoing the keypress, not anything the build wrote.
        const written = typed.terminal.replace('^C', '').replace(/\r\n/gu, '\n');
        return { status: typed.status, written, log: records(made), childrenLeft: left.length };
      };
      expect(await shape()).toEqual({
        status: how === 'pid' ? 241 : 254,
        written: 'line from kubectl\n',
        log: [{ kind: 'start' }, { kind: 'end', exit: how === 'pid' ? -15 : -2 }],
        childrenLeft: 0,
      });
    },
    240_000,
  );

  it('is Aborted. at a password typed on a terminal, never an unhandled AbortError', async () => {
    // readline in terminal mode reads Ctrl-C as a keypress, so no signal is raised at all;
    // an earlier version printed a JS stack and logged an `error` with trace: true.
    const { box, env } = await interruptBox();
    const argv = [process.execPath, TS_CLI, 'users', 'add', 'bob', '--ask-password'];
    const got = await onTerminal('Password for bob: ', '', argv, { cwd: box, env });
    expect({ ...got, log: records(box) }).toEqual({
      status: 1,
      terminal: 'Password for bob: \r\nAborted.\r\n',
      log: [{ kind: 'start' }, { kind: 'end', exit: 1 }],
    });
  }, 240_000);
});

/**
 * A reader that stops reading before the output ends: `houston audit -n 20000 | head -1`.
 * Earlier releases' echo fails with EPIPE, their entry point answers it with exit 1 and nothing
 * on stderr, and `main` records `end` 1. An earlier version died of an unhandled 'error' event -- a
 * 25-line Node stack on stderr -- AFTER its `end` record had said 0.
 */
describe('a reader that goes away, as earlier releases answer the broken pipe', () => {
  // Node's child.stdout is a socket on this host: destroying it may report
  // ECONNRESET. A shell `| head` is an OS pipe, whose closed
  // reader reports the EPIPE this contract is about. So the command runs on the left of a
  // shell pipe whose reader, `dd`, reads ONE chunk of up to 8 KiB and exits; the command's
  // stderr and status go to files, and what `dd` read is counted by `wc -c`.
  const PIPE_DRIVER =
    'err=$1; status=$2; shift 2\n' +
    '{ "$@" </dev/null 2>"$err"; echo $? >"$status"; } | dd bs=8192 count=1 status=none | wc -c\n';

  /** 20,000 lines, 1.4 MB: far more than a pipe or a socket buffer holds unread. */
  const AUDIT = Array.from({ length: 20_000 }, (_, i) => {
    const day = String(1 + (i % 28)).padStart(2, '0');
    const hour = String(i % 24).padStart(2, '0');
    const ticket = String(i).padStart(5, '0');
    return `2026-09-${day}T${hour}:00:00+00:00\talice\tcreate\talice-ticket-${ticket} 8.5.1\tlocal\tok\n`;
  }).join('');

  /** Run `argv` with an OS pipe this side closes after its first chunk, as `head` does. */
  async function cutShort(argv: string[]) {
    const { box, env } = await interruptBox();
    fs.writeFileSync(path.join(box, 'home', 'audit.log'), AUDIT);
    const err = path.join(box, 'cut.stderr');
    const exit = path.join(box, 'cut.status');
    const driven = spawnSync(
      'sh',
      ['-c', PIPE_DRIVER, 'sh', err, exit, process.execPath, TS_CLI, ...argv],
      { cwd: box, env, encoding: 'utf8', timeout: 120_000 },
    );
    expect(driven.status).toBe(0);
    expect(driven.stderr).toBe('');
    const status = Number(fs.readFileSync(exit, 'utf8').trim());
    const read = Number(driven.stdout.trim());
    const stderr = fs.readFileSync(err, 'utf8');
    // The reader did go away early: what it read is a fraction of what there was to read.
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(AUDIT.length / 2);
    return { status, signal: null, stderr, log: records(box) };
  }

  it.each([[['audit', '-n', '20000']], [['audit', '-n', '20000', '--tsv']]])(
    'exits 1, says nothing and records end 1: %j',
    async (argv) => {
      expect(await cutShort(argv)).toEqual({
        status: 1,
        signal: null,
        stderr: '',
        log: [{ kind: 'start' }, { kind: 'end', exit: 1 }],
      });
    },
    240_000,
  );
});

/**
 * A write that fails for any reason but a closed pipe -- `houston list > file` on a full disk, a
 * terminal that hung up. Earlier releases answer EPIPE alone, so their `main` reports anything
 * else as unhandled, and their runtime then cannot flush the stream at shutdown: exit 120. An earlier
 * version rethrew it from the 'error' listener, a Node stack and exit 1 with `start` alone in the
 * log.
 */
describe('a stream that cannot be written, as earlier releases report it', () => {
  /** Run `argv` with stdout (1) or stderr (2) on /dev/full, which fails every write ENOSPC. */
  async function unwritable(argv: string[], fd: 1 | 2) {
    const { box, env } = await interruptBox();
    const full = fs.openSync('/dev/full', 'w');
    let got;
    try {
      got = spawnSync(process.execPath, [TS_CLI, ...argv], {
        cwd: box,
        env,
        encoding: 'utf8',
        timeout: 120_000,
        stdio: ['ignore', fd === 1 ? full : 'pipe', fd === 2 ? full : 'pipe'],
      });
    } finally {
      fs.closeSync(full);
    }
    // Null where stderr is the file, not a pipe.
    const stderr = (got.stderr as string | null) ?? '';
    // The report after the stack trace, whose frames are the runtime's own.
    const at = stderr.search(/^error: /mu);
    return {
      status: got.status,
      log: records(box),
      traced: fd === 2 ? null : /^\s+at /mu.test(stderr),
      report: at < 0 ? '' : stderr.slice(at),
    };
  }

  /** The report of the flush at shutdown that failed. */
  const IGNORED = 'error: could not flush stdout: No space left on device\n';
  const UNHANDLED =
    'error: No space left on device - this is unhandled, and the ' +
    'stack trace is on stderr. If it names a file under HOUSTON_HOME, that file is the problem.\n';
  const REPORTED = {
    log: [{ kind: 'start' }, { kind: 'end', exit: 1 }, { kind: 'error', trace: true }],
    traced: true,
  };
  const STARTED = { log: [{ kind: 'start' }], traced: null, report: '' };

  it.each([
    [['--version'], 1, { ...REPORTED, report: UNHANDLED + IGNORED }],
    [['list'], 1, { ...REPORTED, report: UNHANDLED + IGNORED }],
    [['list', '--json'], 1, { ...REPORTED, report: IGNORED }],
    [['bogus'], 2, STARTED],
    [['list', '--bogus'], 2, STARTED],
  ] as [string[], 1 | 2, object][])(
    '%j with fd %d unwritable',
    async (argv, fd, answer) => {
      expect(await unwritable(argv, fd)).toEqual({ status: 120, ...answer });
    },
    240_000,
  );
});

/**
 * A pipe nobody reads, before the command runs: the first run after an upgrade adopting
 * `~/.rc-repro` with stderr closed, or a startup refusal. Earlier releases' handlers there
 * swallow the broken pipe -- the adoption's and the exit report's -- so the migration stops at
 * its first message and the command still runs, and the runtime's flush of stderr fails at
 * shutdown: 120. An earlier version had no listener yet: the adoption
 * moved the directory and died of the unhandled 'error' event, exit 1, with no marker claimed and
 * no log.
 */
describe('a pipe nobody reads, before the command, as earlier releases survive it', () => {
  /**
   * The writing end of a pipe whose reading end is already closed: a FIFO in `dir`, opened
   * for reading (without waiting for a writer), then for writing, and the reader closed.
   */
  function pipeNobodyReads(dir: string): number {
    const fifo = path.join(dir, 'closed.fifo');
    const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    expect(made.status).toBe(0);
    const reader = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const writer = fs.openSync(fifo, fs.constants.O_WRONLY);
    fs.closeSync(reader);
    return writer;
  }

  /** Every path under `dir`, and each file's bytes, for the log's records in `logs/`. */
  function tree(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()) {
      const full = path.join(dir, entry);
      out[entry] = fs.statSync(full).isDirectory()
        ? '<dir>'
        : entry.startsWith('logs/')
          ? fs
              .readFileSync(full, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((line) => (JSON.parse(line) as { kind: string }).kind)
              .join(' ')
          : fs.readFileSync(full, 'utf8');
    }
    return out;
  }

  async function closed(
    argv: string[],
    fd: 1 | 2,
    stage: (box: string, env: NodeJS.ProcessEnv) => void,
  ) {
    const { box, env } = await interruptBox();
    stage(box, env);
    const closedEnd = pipeNobodyReads(path.join(box, 'tmp'));
    let got;
    try {
      got = spawnSync(process.execPath, [TS_CLI, ...argv], {
        cwd: box,
        env,
        encoding: 'utf8',
        timeout: 120_000,
        stdio: ['pipe', fd === 1 ? closedEnd : 'pipe', fd === 2 ? closedEnd : 'pipe'],
      });
    } finally {
      fs.closeSync(closedEnd);
      fs.rmSync(path.join(box, 'tmp', 'closed.fifo'), { force: true });
    }
    const home = env.HOUSTON_HOME ?? path.join(box, 'user', '.houston');
    return {
      status: got.status,
      // Null where the stream is the closed pipe, not one read here.
      stdout: ((got.stdout as string | null) ?? '').replaceAll(box, '<box>'),
      stderr: ((got.stderr as string | null) ?? '').replaceAll(box, '<box>'),
      // The fixture workspace's record carries a port picked per box.
      home: Object.fromEntries(
        Object.entries(tree(home)).filter(([entry]) => !entry.startsWith('repros/')),
      ),
      skills: tree(path.join(box, 'user', '.claude', 'skills')),
    };
  }

  /** A pre-rename home and its agent skill, with HOUSTON_HOME unset so the adoption runs. */
  const legacy =
    (conflict: boolean) =>
    (box: string, env: NodeJS.ProcessEnv): void => {
      delete env.HOUSTON_HOME;
      env.HOUSTON_SKILL_HOME = path.join(box, 'user');
      fs.mkdirSync(path.join(box, 'user', '.rc-repro', 'repros'), { recursive: true });
      fs.writeFileSync(path.join(box, 'user', '.rc-repro', 'config.yaml'), 'x: 1\n');
      const skill = path.join(box, 'user', '.claude', 'skills', 'rc-repro');
      fs.mkdirSync(skill, { recursive: true });
      fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: rc-repro\n---\nbody\n');
      if (conflict) {
        fs.mkdirSync(path.join(box, 'user', '.houston'));
        fs.writeFileSync(path.join(box, 'user', '.houston', 'config.yaml'), 'y: 2\n');
      }
    };
  /** A promotion the home says is in flight, which every command refuses. */
  const inFlight = (_box: string, env: NodeJS.ProcessEnv): void => {
    fs.writeFileSync(
      path.join(env.HOUSTON_HOME as string, 'IMPLEMENTATION.transition'),
      '{"from":"python","to":"dual-v1"}\n',
    );
  };

  /** The pre-rename skill, left where it was: the adoption stopped at its first message. */
  const LEGACY_SKILL = {
    'rc-repro': '<dir>',
    'rc-repro/SKILL.md': '---\nname: rc-repro\n---\nbody\n',
  };
  const IN_FLIGHT = {
    IMPLEMENTATION: 'dual-v1\n',
    'IMPLEMENTATION.transition': '{"from":"python","to":"dual-v1"}\n',
    repros: '<dir>',
  };
  const quiet = { stdout: '', stderr: '' };

  it.each([
    [
      'the adoption of ~/.rc-repro, stderr closed',
      ['--version'],
      2,
      legacy(false),
      {
        stdout: `houston ${VERSION}\n`,
        stderr: '',
        home: {
          IMPLEMENTATION: 'typescript\n',
          'config.yaml': 'x: 1\n',
          logs: '<dir>',
          'logs/houston.log': 'start end',
          repros: '<dir>',
        },
        skills: LEGACY_SKILL,
      },
    ],
    [
      'an adoption that refuses, stderr closed',
      ['--version'],
      2,
      legacy(true),
      { ...quiet, home: { 'config.yaml': 'y: 2\n' }, skills: LEGACY_SKILL },
    ],
    [
      'a startup refusal, stderr closed',
      ['--version'],
      2,
      inFlight,
      { ...quiet, home: IN_FLIGHT, skills: {} },
    ],
    [
      'a startup refusal under --json, stdout closed',
      ['list', '--json'],
      1,
      inFlight,
      {
        stdout: '',
        stderr: 'error: could not flush stdout: Broken pipe\n',
        home: IN_FLIGHT,
        skills: {},
      },
    ],
    [
      'a usage error, stderr closed',
      ['bogus'],
      2,
      () => undefined,
      {
        ...quiet,
        home: {
          IMPLEMENTATION: 'dual-v1\n',
          logs: '<dir>',
          'logs/houston.log': 'start end',
          repros: '<dir>',
        },
        skills: {},
      },
    ],
  ] as [string, string[], 1 | 2, (box: string, env: NodeJS.ProcessEnv) => void, object][])(
    '%s',
    async (_label, argv, fd, stage, answer) => {
      expect(await closed(argv, fd, stage)).toEqual({ status: 120, ...answer });
    },
    240_000,
  );
});

/**
 * A log over HOUSTON_LOG_MAX_MB. Earlier releases rotate inside the write that finds it over the cap,
 * BEFORE writing, so a run's `start` lands in a fresh `houston.log`. An earlier version appended
 * first and enqueued the rename: `--version` over a full log put `start` and `end` both into `.1`,
 * leaving no `houston.log`, and a slower rename split them across the two.
 */
describe('the event log at its size cap, rotated in the order earlier releases rotate it', () => {
  /** Each file's record kinds (`pad` for the lines the box started with). */
  function kinds(box: string): Record<string, string[]> {
    const logs = path.join(box, 'home', 'logs');
    const out: Record<string, string[]> = {};
    for (const name of fs.readdirSync(logs).sort()) {
      out[name] = fs
        .readFileSync(path.join(logs, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { kind: string }).kind);
    }
    return out;
  }

  async function rotated(megabytes: string) {
    const { box, env } = await interruptBox();
    const logs = path.join(box, 'home', 'logs');
    fs.mkdirSync(logs, { mode: 0o700 });
    const pad = Array.from({ length: 80 }, (_, n) => `{"kind":"pad","n":${String(n)}}\n`).join('');
    fs.writeFileSync(path.join(logs, 'houston.log'), pad, { mode: 0o600 });
    const got = spawnSync(process.execPath, [TS_CLI, '--version'], {
      cwd: box,
      env: { ...env, HOUSTON_LOG_MAX_MB: megabytes },
      encoding: 'utf8',
      timeout: 120_000,
    });
    return { status: got.status, logs: kinds(box) };
  }

  it.each([
    // 1 KiB, under the 80 lines: the run starts a fresh file, the old one is .1.
    [
      'a log over the cap',
      '0.001',
      { 'houston.log': ['start', 'end'], 'houston.log.1': Array<string>(80).fill('pad') },
    ],
    // 105 bytes, under one record: rotated before `start` and again before `end`, as earlier
    // releases' cap below a record's size does, and the lines the box started with are gone.
    [
      'a cap smaller than one record',
      '0.0001',
      { 'houston.log': ['end'], 'houston.log.1': ['start'] },
    ],
  ])(
    '%s',
    async (_label, megabytes, logs) => {
      expect(await rotated(megabytes)).toEqual({ status: 0, logs });
    },
    240_000,
  );
});

/**
 * A failing `doctor --json` reports its refusal through the JSON failure DIRECTLY, not through
 * the command failure path, so earlier releases write no `error` record: `start`, then `end 3`.
 * An earlier version logged the PreflightError like any other failure, an `error PREFLIGHT_FAILED`
 * between them -- a failure class that earlier releases never record, on the most ordinary
 * failing doctor there is, Docker down.
 */
describe('a failing doctor --json, in the event log', () => {
  it('leaves start and end, and no error record', async () => {
    const { box, env } = await interruptBox('#!/bin/sh\necho "docker: down" >&2\nexit 1\n');
    const got = spawnSync(process.execPath, [TS_CLI, 'doctor', '--json'], {
      cwd: box,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const envelope = JSON.parse(got.stdout.trim().split('\n').at(-1) ?? '{}') as {
      error?: { code?: string };
    };
    expect({ code: got.status, error: envelope.error?.code, log: records(box) }).toEqual({
      code: 3,
      error: 'PREFLIGHT_FAILED',
      log: [{ kind: 'start' }, { kind: 'end', exit: 3 }],
    });
  }, 240_000);
});

/**
 * The agent skill the pre-rename adoption reinstalls records the version that wrote it. Earlier
 * releases know their version from the start; an earlier runMain set this build's only after adoption
 * had run, so the sidecar it wrote said "houston_version": "0.0.0" -- on disk, outside
 * HOUSTON_HOME, for good.
 */
describe('the skill the pre-rename adoption reinstalls', () => {
  it('records the version of the build that wrote it', async () => {
    const { box, env } = await interruptBox();
    const home = path.join(box, 'home');
    const skills = path.join(box, 'skills');
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'logs', 'rc-repro.log'), '{"kind": "start"}\n');
    fs.mkdirSync(path.join(skills, '.claude', 'skills', 'rc-repro'), { recursive: true });
    fs.writeFileSync(path.join(skills, '.claude', 'skills', 'rc-repro', 'SKILL.md'), 'old\n');
    const got = spawnSync(process.execPath, [TS_CLI, 'skill', 'status', '--json'], {
      cwd: box,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(got.status).toBe(0);
    const sidecar = path.join(skills, '.claude', 'skills', 'houston', '.houston-skill.json');
    const version = (JSON.parse(fs.readFileSync(sidecar, 'utf8')) as Record<string, unknown>)
      .houston_version;
    expect(version).not.toBe('0.0.0');
    expect(version).toBe(VERSION);
  }, 240_000);
});

/**
 * A HOUSTON_HOME that walks back out of a symlink: `link/../hh`, with `link -> other/sub`.
 * Earlier releases leave the path to the kernel, which follows `link` first and uses `other/hh`;
 * an earlier version `path.join`ed every file onto the home, which folds `link/..` to nothing,
 * and used `hh` in the working directory -- so it claimed a second, empty home for itself,
 * listed no workspaces, refused `use`, and wrote `config set` where earlier releases never read.
 * Reached for real with `HOUSTON_HOME=$PWD/../state` from a directory entered through a
 * symlink, which `$PWD` spells logically.
 */
describe('a HOUSTON_HOME holding a `..` after a symlink', () => {
  it('names the directory the kernel resolves', async () => {
    const { box, env } = await interruptBox();
    fs.mkdirSync(path.join(box, 'other', 'sub'), { recursive: true });
    fs.renameSync(path.join(box, 'home'), path.join(box, 'other', 'hh'));
    fs.symlinkSync('other/sub', path.join(box, 'link'));
    fs.writeFileSync(path.join(box, 'other', 'hh', 'config.yaml'), 'bind_host: 9.9.9.9\n');
    const answers = [
      ['config', 'get', 'bind_host'],
      ['list'],
      ['use', 'ticket-7'],
      ['config', 'set', 'bind_host', '1.1.1.1'],
      ['config', 'get', 'bind_host'],
    ].map((argv) => {
      const got = spawnSync(process.execPath, [TS_CLI, ...argv], {
        cwd: box,
        env: { ...env, HOUSTON_HOME: 'link/../hh' },
        encoding: 'utf8',
        timeout: 120_000,
      });
      return { argv, code: got.status, stdout: got.stdout, stderr: got.stderr };
    });
    expect(answers.map((answer) => answer.stdout)).toEqual([
      '9.9.9.9\n',
      expect.stringContaining('ticket-7            7.4.1'),
      expect.stringContaining("'ticket-7'"),
      expect.anything(),
      '1.1.1.1\n',
    ]);
    // One state directory, the kernel's, and nothing made where `path.join` pointed.
    expect(fs.readFileSync(path.join(box, 'other', 'hh', 'config.yaml'), 'utf8')).toBe(
      'bind_host: 1.1.1.1\ndefault_repro: ticket-7\n',
    );
    expect(fs.readFileSync(path.join(box, 'other', 'hh', MARKER_NAME), 'utf8')).toBe('dual-v1\n');
    expect(fs.existsSync(path.join(box, 'hh'))).toBe(false);
  }, 240_000);
});
