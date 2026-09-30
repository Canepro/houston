import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProcessTimeout, SpawnFailure } from '../../src/seams/exec';
import {
  DOCKER_TTL_MS,
  QUERY_TTL_MS,
  cachedQuery,
  compose,
  composeFromFile,
  composeStream,
  composeToFile,
  docker,
  dockerAvailable,
  firstLine,
  invalidateQueries,
} from '../../src/seams/docker-cli';

/**
 * The process-contract matrix for THIS adapter.
 *
 * Every case drives a real `docker` on a real PATH -- a fake one, whose whole job is to
 * be scriptable. Mocking the process away would test that argv is assembled, which is
 * the part that cannot break silently; what can is a timeout that returns instead of
 * raising, a missing binary that reads as an empty answer, or a merged stream that
 * loses its order.
 */
let scratch = '';
let binDir = '';
let log = '';

/**
 * Install a scriptable `docker` and return an environment that finds it FIRST.
 *
 * The real PATH stays on the end because the scripts use `sh`, `cat` and `sleep`; only
 * `docker` is shadowed, which is the one binary under test.
 */
function fakeDocker(body: string): NodeJS.ProcessEnv {
  fs.writeFileSync(path.join(binDir, 'docker'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    HOUSTON_FAKE_LOG: log,
  };
}

/** An environment where no `docker` exists at all, real or fake. */
function noDocker(): NodeJS.ProcessEnv {
  const empty = path.join(scratch, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  return { ...process.env, PATH: empty };
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-dockercli-'));
  binDir = path.join(scratch, 'bin');
  log = path.join(scratch, 'argv.log');
  fs.mkdirSync(binDir);
  invalidateQueries();
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('the docker command line', () => {
  it('passes argv literally and returns a non-zero exit as a fact', async () => {
    const env = fakeDocker('printf "%s\\n" "$@" > "$HOUSTON_FAKE_LOG"; exit 17');
    const result = await docker(['ps', '--filter', 'name=a b'], { capture: true, env });

    expect(result.exitCode).toBe(17);
    expect(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual([
      'ps',
      '--filter',
      'name=a b',
    ]);
  });

  it('prefixes `compose` and runs in the directory it is given', async () => {
    const env = fakeDocker('printf "%s|%s\\n" "$*" "$PWD" > "$HOUSTON_FAKE_LOG"');
    const workdir = fs.mkdtempSync(path.join(scratch, 'ws-'));
    await compose(['up', '-d'], { cwd: workdir, env });

    const [argv, cwd] = fs.readFileSync(log, 'utf8').trim().split('|');
    expect(argv).toBe('compose up -d');
    expect(fs.realpathSync(String(cwd))).toBe(fs.realpathSync(workdir));
  });

  it('raises rather than inventing an answer when docker is not installed', async () => {
    // The engine's compose call raises here and the captured exec into a workspace does
    // not. The seam cannot pick one for both, so it raises and each adapter applies its own.
    await expect(docker(['ps'], { capture: true, env: noDocker() })).rejects.toBeInstanceOf(
      SpawnFailure,
    );
  });

  it('raises on a timeout, with the output produced before it', async () => {
    // `exec` so the sleeping process IS the direct child: a timeout kills what it
    // launched, exactly as earlier releases' timed child call does, and a grandchild holding
    // the pipe open would keep the call waiting on output nobody is going to read.
    const env = fakeDocker('printf "started"; exec sleep 5');
    let failure: unknown;
    try {
      await docker(['logs', '-f'], { capture: true, timeoutMs: 150, env });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProcessTimeout);
    expect((failure as ProcessTimeout).result.stdout).toBe('started');
  });

  it('reports a signalled docker as a signal, not as an exit code', async () => {
    const env = fakeDocker('kill -TERM $$');
    const result = await docker(['ps'], { capture: true, env });
    expect(result.signal).toBe('SIGTERM');
    expect(result.exitCode).toBeNull();
  });

  it('streams merged output line by line and keeps the last unterminated line', async () => {
    const env = fakeDocker('printf "pulling\\n"; printf "failed\\n" 1>&2; printf "tail"');
    const seen: string[] = [];
    const code = await composeStream(['pull'], { env, onLine: (line) => seen.push(line) });

    expect(code).toBe(0);
    expect(seen).toEqual(['pulling', 'failed', 'tail']);
  });

  it('writes raw bytes to a file, because an archive is not text', async () => {
    // `mongodump --archive` emits BSON. A text-mode decode would corrupt it silently and
    // the restore would fail somewhere nobody could trace back here.
    const env = fakeDocker('printf "\\001\\002\\377\\r\\n\\000"; printf "a warning" 1>&2');
    const destination = path.join(scratch, 'dump.archive');
    const result = await composeToFile(['exec', '-T', 'mongodb', 'mongodump'], destination, {
      env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('a warning');
    expect([...fs.readFileSync(destination)]).toEqual([1, 2, 255, 13, 10, 0]);
  });

  it('pipes a file into stdin and merges the output into one blob', async () => {
    const env = fakeDocker('cat; printf "restore noise" 1>&2');
    const source = path.join(scratch, 'dump.archive');
    fs.writeFileSync(source, Buffer.from([0x7f, 0x45, 0x4c]));
    const result = await composeFromFile(['exec', '-T', 'mongodb', 'mongorestore'], source, {
      env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('restore noise');
    expect(result.output.startsWith('\u007fEL')).toBe(true);
  });
});

describe("an uncaptured docker, beside earlier releases' compose call", () => {
  // An uncaptured call INHERITS the terminal: it is how `pull` draws its progress and how a
  // failed `up` says why in docker's own words. The seam captured every call and dropped
  // what it caught. The call runs in a child of its own, because an inherited stream is the
  // child's, and a spec can only read it from outside. Earlier releases' answers, from the
  // same fake docker, are recorded beside it.
  const ROOT = path.resolve(__dirname, '..', '..');
  const CHATTY = 'printf "out-line\\n"; printf "err-line\\n" 1>&2; exit 3';

  function typescript(mode: 'terminal' | 'json', env: NodeJS.ProcessEnv, cwd: string) {
    const source = [
      `require(${JSON.stringify(path.join(ROOT, 'tools', 'ts-require.js'))}).install();`,
      `const jsonout = require(${JSON.stringify(path.join(ROOT, 'src', 'lib', 'jsonout.ts'))});`,
      `const seam = require(${JSON.stringify(path.join(ROOT, 'src', 'seams', 'docker-cli.ts'))});`,
      `if (${JSON.stringify(mode)} === 'json') jsonout.activate();`,
      `seam.compose(['up', '-d'], { cwd: ${JSON.stringify(cwd)} })`,
      '  .then((result) => { process.exitCode = result.exitCode ?? 1; });',
    ].join('\n');
    const ran = spawnSync(process.execPath, ['-e', source], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr };
  }

  /** What earlier releases' compose call did with the same fake docker, recorded. */
  const RECORDED = {
    terminal: { code: 3, stdout: 'out-line\n', stderr: 'err-line\n' },
    json: { code: 3, stdout: '', stderr: 'out-line\nerr-line\n' },
  };

  function both(mode: 'terminal' | 'json') {
    const env = fakeDocker(CHATTY);
    const home = path.join(scratch, 'home');
    const workspace = path.join(home, 'repros', 'w');
    fs.mkdirSync(workspace, { recursive: true });
    return { recorded: RECORDED[mode], typescript: typescript(mode, env, workspace) };
  }

  it('inherits the terminal, as an uncaptured call does', () => {
    const ran = both('terminal');
    expect(ran.typescript).toEqual({ code: 3, stdout: 'out-line\n', stderr: 'err-line\n' });
    expect(ran.typescript).toEqual(ran.recorded);
  });

  it('sends its stdout to stderr under --json, where stdout carries JSON and nothing else', () => {
    // Releases once let it land raw among the NDJSON lines of `up --json` and ahead of the
    // envelope of `down --json`; earlier releases and this build send it to stderr now.
    // Still on the terminal: the person running the command sees it.
    const ran = both('json');
    expect(ran.typescript).toEqual({ code: 3, stdout: '', stderr: 'out-line\nerr-line\n' });
    expect(ran.typescript).toEqual(ran.recorded);
  });
});

describe('the two memos', () => {
  it('holds a read-only query for its TTL and drops it on any mutation', async () => {
    expect(QUERY_TTL_MS).toBe(2_500);
    let calls = 0;
    const query = async () => {
      calls += 1;
      return await Promise.resolve(calls);
    };

    expect(await cachedQuery('project_states', query)).toBe(1);
    expect(await cachedQuery('project_states', query)).toBe(1);
    expect(calls).toBe(1);

    // A dashboard still showing "running" two seconds after a Stop would be a cache the
    // user can notice, which is worse than the spawns the memo saves.
    invalidateQueries();
    expect(await cachedQuery('project_states', query)).toBe(2);
  });

  it('holds the daemon probe briefly, and a zero max age forces a fresh one', async () => {
    expect(DOCKER_TTL_MS).toBe(3_000);
    const env = fakeDocker('printf "1" >> "$HOUSTON_FAKE_LOG"; exit 0');

    expect(await dockerAvailable({ env })).toBe(true);
    expect(await dockerAvailable({ env })).toBe(true);
    expect(fs.readFileSync(log, 'utf8')).toBe('1');

    expect(await dockerAvailable({ maxAgeMs: 0, env })).toBe(true);
    expect(fs.readFileSync(log, 'utf8')).toBe('11');
  });

  it('answers "no" rather than raising when the daemon cannot be asked at all', async () => {
    expect(await dockerAvailable({ env: noDocker() })).toBe(false);
  });

  it('reads one trimmed line, or null for any failure at all', async () => {
    const env = fakeDocker('printf "  29.7.2  \\n"');
    expect(await firstLine(['docker', 'version'], env)).toBe('29.7.2');

    fakeDocker('exit 1');
    expect(await firstLine(['docker', 'version'], env)).toBeNull();
    expect(await firstLine(['docker-compose', 'version'], noDocker())).toBeNull();
  });
});
