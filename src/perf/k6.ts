/**
 * Drive HTTP load at a repro with k6, run as a throwaway container.
 *
 * k6 joins the repro's own compose network (`houston-<name>_default`) and targets the
 * INTERNAL service address (`rocketchat:3000` / `traefik:80`) -- so there is no host-port
 * round trip and it works even when the repro binds to loopback only. Scenario scripts ship
 * in `data/loadtest/` and are copied into the repro's workspace, mounted at `/k6`; the
 * script's `handleSummary` writes `/k6/summary.json`, which is read back.
 */
import * as fs from 'node:fs';

import * as config from '../lib/config';
import { joinPath } from '../lib/home';
import { projectName } from '../core/runner/record';
import { workspace } from '../core/runner/paths';
import { inherit, stream } from '../seams/exec';

/** arm64/amd64 multi-arch (native on Apple Silicon) -- pinned for reproducibility. */
export const K6_IMAGE = 'grafana/k6:0.55.0';

export const SCENARIOS: readonly string[] = Object.freeze([
  'messages',
  'login',
  'read',
  'mixed',
  'journey',
  'webhook',
  'badbot',
  'custom',
]);

/** In-network address of the monitor stack's Prometheus (`loadtest --live`). */
export const PROM_RW_URL = 'http://prometheus:9090/api/v1/write';

/** Passed via an 0600 `--env-file` rather than the argv (see `run`). */
const SECRET_ENV: readonly string[] = Object.freeze(['RC_TOKEN', 'RC_PASS']);

/**
 * The `docker run` this becomes, with the secrets in a file rather than in argv.
 *
 * `RC_TOKEN` is a bypass-2FA PAT and `RC_PASS` the admin password. Passed as `-e K=V` they
 * sit in the argv, readable by any local user via `ps` or `/proc/<pid>/cmdline` for the
 * whole run and via `docker inspect` afterwards. An 0600 env file in the already
 * bind-mounted directory avoids that.
 *
 * ONLY THOSE TWO go in the file: everything else is harmless, and a user-supplied value (a
 * custom scenario's `RC_BODY`) could contain a newline, which the KEY=VALUE file format
 * cannot represent.
 */
export async function k6Command(
  dest: string,
  env: Record<string, string>,
  live: boolean,
  name: string,
  scenario: string,
  timeline: boolean,
): Promise<[string[], string]> {
  const secretEnv = Object.entries(env).filter(([k]) => SECRET_ENV.includes(k));
  const plainEnv = Object.entries(env).filter(([k]) => !SECRET_ENV.includes(k));

  const network = `${await projectName(name)}_default`;
  const cmd = ['docker', 'run', '--rm', '--network', network, '-v', `${dest}:/k6`];
  // Run as the host user so k6 can write /k6/summary.json into the bind-mounted directory.
  // On Linux, bind-mount permissions are enforced and the image's non-root user otherwise
  // cannot write there ("permission denied"); Docker Desktop ignores this but the flag is
  // harmless there. (POSIX only.)
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    cmd.push('--user', `${String(process.getuid())}:${String(process.getgid())}`);
  }
  for (const [k, v] of plainEnv) cmd.push('-e', `${k}=${v}`);
  const envfile = joinPath(dest, 'k6.env');
  fs.rmSync(envfile, { force: true });
  if (secretEnv.length > 0) {
    fs.writeFileSync(envfile, secretEnv.map(([k, v]) => `${k}=${v}\n`).join(''), {
      encoding: 'utf8',
    });
    fs.chmodSync(envfile, 0o600);
    cmd.push('--env-file', envfile);
  }
  cmd.push(K6_IMAGE, 'run');
  // Stream every measurement so houston can build latency-over-time buckets.
  if (timeline) cmd.push('--out', 'json=/k6/points.json');
  // Push metrics into the monitor stack's Prometheus as the test runs.
  if (live) cmd.push('--out', 'experimental-prometheus-rw');
  cmd.push(`/k6/${scenario}.js`);
  return [cmd, envfile];
}

export interface StageOptions {
  duration: string;
  extraEnv?: Record<string, string | null | undefined> | null;
  live: boolean;
  name: string;
  password: string;
  ramp?: string | null;
  scenario: string;
  spike?: string | null;
  target: string;
  token: string;
  uid: string;
  user: string;
  users?: Record<string, unknown>[] | null;
  vus: number;
}

/** Put the script, its users and its environment where the container will find them. */
export function stageScenario(options: StageOptions): {
  dest: string;
  env: Record<string, string>;
  summary: string;
} {
  const {
    duration,
    extraEnv,
    live,
    name,
    password,
    ramp,
    scenario,
    spike,
    target,
    token,
    uid,
    user,
    users,
    vus,
  } = options;
  const ws = workspace(name);
  const dest = joinPath(ws, 'loadtest');
  fs.mkdirSync(dest, { recursive: true });

  for (const fn of [`${scenario}.js`, 'common.js']) {
    fs.writeFileSync(joinPath(dest, fn), fs.readFileSync(config.dataPath('loadtest', fn), 'utf8'), {
      encoding: 'utf8',
    });
  }
  // A stale result from a prior run must not be mistaken for this one.
  const summary = joinPath(dest, 'summary.json');
  fs.rmSync(summary, { force: true });
  // Ditto for the timeline point stream.
  fs.rmSync(joinPath(dest, 'points.json'), { force: true });

  const env: Record<string, string> = {
    RC_URL: target,
    RC_TOKEN: token,
    RC_UID: uid,
    RC_USER: user,
    RC_PASS: password,
    DURATION: duration,
  };
  if (spike) env.SPIKE = spike;
  else if (ramp) env.RAMP = ramp;
  else env.VUS = String(vus);
  if (live) {
    env.K6_PROMETHEUS_RW_SERVER_URL = PROM_RW_URL;
    env.K6_PROMETHEUS_RW_TREND_STATS = 'p(95),p(99),avg';
  }
  const ufile = joinPath(dest, 'users.json');
  if (users !== null && users !== undefined && users.length > 0) {
    fs.writeFileSync(ufile, JSON.stringify(users), { encoding: 'utf8' });
    env.RC_USERS_FILE = '/k6/users.json';
  } else {
    // A stale user list from a prior run -- this run is admin-only.
    fs.rmSync(ufile, { force: true });
  }
  if (extraEnv !== null && extraEnv !== undefined) {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v !== null && v !== undefined) env[k] = v;
    }
  }
  return { dest, env, summary };
}

export interface RunOptions {
  vus: number;
  duration: string;
  ramp?: string | null;
  token: string;
  uid: string;
  target: string;
  user?: string;
  password?: string;
  extraEnv?: Record<string, string | null | undefined> | null;
  users?: Record<string, unknown>[] | null;
  quiet?: boolean;
  timeline?: boolean;
  spike?: string | null;
  live?: boolean;
}

/**
 * Run `scenario` against `target` (an in-network URL) and return the summary.
 *
 * `users` is an optional list of pre-authenticated seeded users ({username, password,
 * token, uid}) -- VUs round-robin over them so load carries real per-user identity instead
 * of one shared admin token.
 *
 * Streams k6's live progress to the terminal. Throws if k6 produced no summary (for
 * example it could not reach the target).
 */
export async function run(
  name: string,
  scenario: string,
  options: RunOptions,
): Promise<Record<string, unknown>> {
  const {
    vus,
    duration,
    ramp = null,
    token,
    uid,
    target,
    user = config.ADMIN_USERNAME,
    password = config.ADMIN_PASSWORD,
    extraEnv = null,
    users = null,
    quiet = false,
    timeline = false,
    spike = null,
    live = false,
  } = options;

  const { dest, env, summary } = stageScenario({
    duration,
    extraEnv,
    live,
    name,
    password,
    ramp,
    scenario,
    spike,
    target,
    token,
    uid,
    user,
    users,
    vus,
  });

  const [cmd, envfile] = await k6Command(dest, env, live, name, scenario, timeline);

  try {
    // k6 writes its banner and progress to stdout. `quiet` (--json mode) reroutes it to
    // STDERR so stdout stays a single parseable JSON object for CI and scripts -- the
    // `--json` contract is that stdout carries the envelope and nothing else.
    if (quiet) {
      await stream(cmd as [string, ...string[]], {
        onStdout: (chunk) => process.stderr.write(chunk),
        onStderr: (chunk) => process.stderr.write(chunk),
        encoding: 'utf8',
      });
    } else {
      await inherit(cmd as [string, ...string[]]);
    }
  } finally {
    // Never leave the PAT on disk.
    fs.rmSync(envfile, { force: true });
  }

  if (!fs.existsSync(summary)) {
    throw new Error(
      'k6 produced no summary (see output above) — could it reach the target, and is ' +
        `the image available? (\`docker pull ${K6_IMAGE}\`)`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(summary, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    // Truncated or corrupt summary (killed mid-write, disk full).
    throw new Error(
      `k6 summary was unreadable (${error instanceof Error ? error.message : String(error)}) — ` +
        'the run likely did not finish',
      { cause: error },
    );
  }
}
