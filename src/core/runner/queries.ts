/**
 * Read-only questions about what Docker is actually running.
 *
 * Two contracts recur and they are not the same: a function that returns `null` distinguishes
 * "could not ask Docker" from "the answer is empty", and one that returns `{}` or `''` has
 * decided those are the same. Which is which is load-bearing -- `prune` DELETES based on
 * absence, so it must never read a failed query as "no projects".
 */
import { DockerError } from '../../lib/errors';
import { setItemChecked, splitTextLines, expectedText, keyRefusal } from '../../lib/format';
import { JsonSyntaxError, loads } from '../../lib/json-text';
import { stripText } from '../../lib/float-text';
import { cachedQuery, docker } from '../../seams/docker-cli';
import { Interrupted } from '../../seams/exec';

import * as engine from './engine';
import { projectName } from './record';

/** A strict writer query: failed or malformed discovery must never authorize a dump/drop. */
export async function runningWriterServices(
  name: string,
  services: readonly string[],
): Promise<string[]> {
  if (services.length === 0) throw new DockerError(`'${name}' has no Rocket.Chat services`);
  const result = await engine.compose(name, ['ps', '--all', '--format', 'json', ...services], {
    capture: true,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new DockerError(
      `could not inspect Rocket.Chat writers for '${name}': ${String(result.stderr ?? '').trim()}`,
    );
  }
  const raw = String(result.stdout ?? '').trim();
  let rows: unknown[];
  try {
    let parsed: unknown;
    try {
      parsed = raw === '' ? [] : JSON.parse(raw);
    } catch {
      parsed = raw.split('\n').map((line) => JSON.parse(line) as unknown);
    }
    rows = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
  } catch {
    throw new DockerError(
      `could not inspect Rocket.Chat writers for '${name}': invalid container list`,
    );
  }
  const running = new Set<string>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new DockerError(
        `could not inspect Rocket.Chat writers for '${name}': invalid container row`,
      );
    }
    const item = row as Record<string, unknown>;
    if (typeof item.Service !== 'string' || typeof item.State !== 'string') {
      throw new DockerError(
        `could not inspect Rocket.Chat writers for '${name}': missing container state`,
      );
    }
    if (!services.includes(item.Service)) continue;
    if (item.State === 'running' || item.State === 'restarting') running.add(item.Service);
    else if (!['exited', 'dead', 'created'].includes(item.State)) {
      throw new DockerError(
        `could not inspect Rocket.Chat writers for '${name}': unsupported state '${item.State}'`,
      );
    }
  }
  return services.filter((service) => running.has(service));
}

/**
 * Delete named volumes belonging to a repro's compose project.
 *
 * `docker compose down -v` only removes volumes DECLARED in the compose file, so a
 * volume whose declaration is dropped (detaching monitoring, switching preset with
 * --force) becomes unreachable and survives forever. Containers must be gone first.
 * Returns the volume names that could not be removed.
 */
export async function removeVolumes(name: string, volumes: readonly string[]): Promise<string[]> {
  const project = await projectName(name);
  const failed: string[] = [];
  for (const volume of volumes) {
    const full = `${project}_${volume}`;
    try {
      const result = await docker(['volume', 'rm', full], { capture: true, timeoutMs: 30_000 });
      // Already gone is success, not a failure.
      if (
        result.exitCode !== 0 &&
        !String(result.stderr ?? '')
          .toLowerCase()
          .includes('no such volume')
      ) {
        failed.push(full);
      }
    } catch (error) {
      if (error instanceof Interrupted) throw error; // Ctrl-C or a stopped job: unwind
      failed.push(full);
    }
  }
  return failed;
}

/**
 * One `docker stats --no-stream` sample for the given containers, as tab-separated
 * `name<TAB>cpu%<TAB>mem-usage` lines ('' on error or none).
 *
 * Timed out: this is polled once a second by a sampler, so a wedged daemon would
 * otherwise block it forever.
 */
export async function dockerStats(containerIds: readonly string[]): Promise<string> {
  if (containerIds.length === 0) return '';
  try {
    const result = await docker(
      [
        'stats',
        '--no-stream',
        '--format',
        '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}',
        ...containerIds,
      ],
      { capture: true, timeoutMs: 30_000 },
    );
    return result.exitCode === 0 ? String(result.stdout ?? '') : '';
  } catch {
    return '';
  }
}

/**
 * Coarse state of the rocketchat service: running | exited | created | absent.
 *
 * One `docker compose ps` per call -- fine for a single repro. For listing many repros
 * use `projectStates`, which is a single docker call for all of them.
 */
export async function rcState(name: string): Promise<string> {
  for (const line of (await engine.ps(name)).split('\n')) {
    const parts = line.split('\t');
    const service = parts[0];
    // "rocketchat" for a normal repro, "rocketchat-1"/"-2"/… for a multi-instance one —
    // the first instance found is enough for readiness.
    if (service !== undefined && (service === 'rocketchat' || service.startsWith('rocketchat-'))) {
      return parts[1] ?? 'unknown';
    }
  }
  return 'absent';
}

/**
 * A compose `--format json` answer: one JSON document -- an object is one row, and anything
 * else is handed back AS IT IS -- else NDJSON, one document per line. `null` when the whole
 * answer is the JSON `null`: the listing then says the query failed, where wrapping it as
 * `[null]` sent a null row to `item.Name` and crashed `list` (Go encodes a nil slice as
 * `null`).
 *
 * EVERY ROW IS KEPT, whatever JSON it is, and `projectRows` reads each one as a mapping. This
 * dropped the rows that were not objects, so an answer holding a stray one -- a WARN line on
 * stdout, then the array, which the NDJSON reading takes as ONE row that is a list -- read as
 * no projects at all: every workspace looked down, and `prune --yes` deleted one the listing
 * called running. A row that is not a mapping throws there, before anything is pruned.
 * Read with `loads` and stripped with `stripText`, as it always has been.
 */
function parseJsonOrNdjson(raw: string): unknown {
  const trimmed = stripText(raw);
  if (trimmed === '') return [];
  const decodeFailed = (error: unknown): boolean =>
    error instanceof JsonSyntaxError || error instanceof SyntaxError;
  try {
    const document = loads(trimmed);
    return isMapping(document) ? [document] : document;
  } catch (error) {
    if (!decodeFailed(error)) throw error;
    // Newer compose emits a JSON array; older versions emit NDJSON, one object per
    // line. Both are handled so callers work across compose versions.
    const rows: unknown[] = [];
    for (const line of splitTextLines(trimmed)) {
      const stripped = stripText(line);
      if (stripped === '') continue;
      try {
        rows.push(loads(stripped));
      } catch (lineError) {
        if (!decodeFailed(lineError)) throw lineError;
      }
    }
    return rows;
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Each row keyed by its `Name` (`""` when it has none), as far as that decides anything:
 * the rows of what the listing returned (a string iterates by characters, and a number or
 * a boolean is not iterable), each read as a mapping, and its name used as a key. The
 * first row that is not a mapping throws `expected an object, got ...`, and a list or
 * mapping for a name `... cannot be a key`, both TypeErrors; `runCli` reports either
 * through the contract's last line, as it always has.
 */
function projectRows(data: unknown): [string, Record<string, unknown>][] {
  let items: unknown[];
  if (typeof data === 'string') items = [...data];
  else if (Array.isArray(data)) items = data;
  else throw new TypeError(expectedText('a list', data));
  return items.map((item) => {
    if (!isMapping(item)) {
      throw new TypeError(expectedText('an object', item));
    }
    const name = item.Name ?? '';
    if (typeof name === 'object') {
      throw new TypeError(keyRefusal(name));
    }
    return [String(name), item];
  });
}

/**
 * Parsed `docker compose ls --all --format json`, or null if the query failed.
 *
 * Bounded: the GUI polls this every 4 s on a worker. A daemon that answers `docker info`
 * (so `dockerAvailable` says yes) but then wedges on `compose ls` would otherwise park a
 * worker per poll. Failing to null is already the "could not ask docker" path.
 */
export async function composeLs(): Promise<unknown> {
  try {
    const result = await docker(['compose', 'ls', '--all', '--format', 'json'], {
      capture: true,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) return null;
    return parseJsonOrNdjson(String(result.stdout ?? ''));
  } catch (error) {
    if (error instanceof Interrupted) throw error; // Ctrl-C or a stopped job: unwind
    return null;
  }
}

/**
 * Map compose project name -> status string for ALL projects, in one call.
 *
 * Status looks like "running(3)" / "exited(2)"; a fully `down`ed repro (no containers)
 * is absent from the output. Returns null if the query itself failed -- callers that
 * DELETE based on absence (prune) must not confuse "no projects" with "could not ask
 * docker".
 */
export async function projectStates(): Promise<Record<string, string> | null> {
  return await cachedQuery('project_states', async () => {
    const data = await composeLs();
    if (data === null) return null;
    const out: Record<string, string> = {};
    for (const [name, item] of projectRows(data)) out[name] = String(item.Status ?? '');
    return out;
  });
}

/**
 * Map compose project name -> its ConfigFiles string (comma-joined paths).
 *
 * Used to detect a project-name COLLISION: two repro workspaces (a real one and a
 * throwaway in a different HOUSTON_HOME) derive the same project name `houston-<name>`,
 * and `docker compose up` would then reconcile the wrong workspace's containers. null if
 * docker could not be queried.
 */
export async function projectConfigFiles(): Promise<Record<string, string> | null> {
  const data = await composeLs();
  if (data === null) return null;
  const out: Record<string, string> = {};
  for (const [name, item] of projectRows(data)) out[name] = String(item.ConfigFiles ?? '');
  return out;
}

/**
 * `serviceContainerIds` of `rocketchat`, else of `rocketchat-1`: ONE `docker compose ps -q`
 * when the first answers. This asked the first twice -- once for the length, once for the
 * value -- so every "still booting" tick of a readiness wait ran an extra docker process,
 * about a hundred over a 300 s wait.
 */
async function rcContainerId(name: string): Promise<string | undefined> {
  const first = await engine.serviceContainerIds(name, 'rocketchat');
  const ids = first.length > 0 ? first : await engine.serviceContainerIds(name, 'rocketchat-1');
  return ids[0];
}

/**
 * The RC container's ACTUAL environment, or null if it could not be read.
 *
 * The compose document is what a workspace was ASKED to run; this is what it IS
 * running, and they diverge. MEASURED: an `env` apply interrupted mid-recreate left
 * `OVERWRITE_SETTING_Accounts_RegistrationForm=Disabled` in both the compose file and
 * `repro.json`, and absent from the container -- and neither `start`, `restart` nor a
 * re-run `up` put it back, because none of them re-reads the compose config.
 *
 * NULL, NOT `{}`. "The container is not running" and "the container has no environment"
 * are different facts, and the caller reports drift by comparing two sets -- so an empty
 * one from a failed read would report every recorded variable as missing.
 */
export async function rcContainerEnv(name: string): Promise<Record<string, string> | null> {
  const id = await rcContainerId(name);
  if (id === undefined) return null;
  let rows: unknown;
  try {
    const result = await docker(['inspect', '--format', '{{json .Config.Env}}', id], {
      capture: true,
      timeoutMs: 15_000,
    });
    if (result.exitCode !== 0) return null;
    rows = JSON.parse(String(result.stdout ?? 'null'));
  } catch (error) {
    if (error instanceof Interrupted) throw error; // Ctrl-C or a stopped job: unwind
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const out: Record<string, string> = {};
  for (const row of rows) {
    const text = String(row);
    const at = text.indexOf('=');
    // An item set on a mapping (`setItemChecked`): a container running `__proto__=x` has that
    // variable. Assigned, it was dropped, and `houston env` reported the override it had
    // just applied as NOT RUNNING.
    if (at > 0) setItemChecked(out, text.slice(0, at), text.slice(at + 1));
  }
  return out;
}

/**
 * The running containers that have no network at all.
 *
 * A start that fails at its port binding leaves the container attached to nothing, and the
 * next `compose start` "succeeds" with it so: Rocket.Chat up with only `lo`, no published
 * port, and `getaddrinfo EAI_AGAIN mongodb`. Nothing short of recreating it gives it back.
 */
export async function networklessContainers(name: string): Promise<string[]> {
  try {
    const listed = await engine.compose(name, ['ps', '-q'], { capture: true });
    const ids = String(listed.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (listed.exitCode !== 0 || ids.length === 0) return [];
    const result = await docker(
      ['inspect', '--format', '{{.Name}}\t{{len .NetworkSettings.Networks}}', ...ids],
      { capture: true, timeoutMs: 15_000 },
    );
    if (result.exitCode !== 0) return [];
    return String(result.stdout ?? '')
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([, count]) => (count ?? '').trim() === '0')
      .map(([container]) => (container ?? '').replace(/^\//u, ''));
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    return [];
  }
}

/**
 * What Docker recorded as each container's start error, `service: error`, for those that
 * have one.
 *
 * `compose start` prints the reason (a port somebody else holds) on its own output and
 * exits 1. In the GUI that went to serve's terminal, and the job said only "`docker compose
 * start` failed" -- a port clash and a broken image read the same. Docker keeps the reason
 * on the container, so it is asked afterwards rather than parsed out of the stream.
 */
export async function startErrors(name: string): Promise<string[]> {
  try {
    const listed = await engine.compose(name, ['ps', '--all', '-q'], { capture: true });
    const ids = String(listed.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (listed.exitCode !== 0 || ids.length === 0) return [];
    const result = await docker(
      [
        'inspect',
        '--format',
        '{{index .Config.Labels "com.docker.compose.service"}}\t{{.State.Error}}',
        ...ids,
      ],
      { capture: true, timeoutMs: 15_000 },
    );
    if (result.exitCode !== 0) return [];
    return String(result.stdout ?? '')
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([, error]) => (error ?? '').trim() !== '')
      .map(([service, error]) => `${service ?? '?'}: ${(error ?? '').trim()}`);
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    return [];
  }
}

/** A one-shot setup container: its compose service, state and exit code. */
export interface OneShot {
  service: string;
  status: string;
  exitCode: number;
}

/**
 * The workspace's one-shot setup containers -- `mongo-init`, `minio-init` -- as they stand.
 *
 * By name and by policy: a `-init` service with no restart policy runs once and exits. An
 * unreadable answer is none, so a box that cannot be asked waits for nothing extra.
 */
export async function oneShotSetups(name: string): Promise<OneShot[]> {
  try {
    const listed = await engine.compose(name, ['ps', '--all', '-q'], { capture: true });
    const ids = String(listed.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (listed.exitCode !== 0 || ids.length === 0) return [];
    const result = await docker(
      [
        'inspect',
        '--format',
        '{{index .Config.Labels "com.docker.compose.service"}}\t' +
          '{{.HostConfig.RestartPolicy.Name}}\t{{.State.Status}}\t{{.State.ExitCode}}',
        ...ids,
      ],
      { capture: true, timeoutMs: 15_000 },
    );
    if (result.exitCode !== 0) return [];
    return String(result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim().split('\t'))
      .filter(
        ([service, policy]) =>
          (service ?? '').endsWith('-init') && ['no', ''].includes(policy ?? ''),
      )
      .map(([service, , status, code]) => ({
        service: service ?? '',
        status: status ?? '',
        exitCode: Number(code) || 0,
      }));
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    return [];
  }
}

/**
 * How many times the repro's rocketchat container has restarted -- a nonzero and
 * climbing value signals a crash-loop, usually resource pressure. 0 if unknown.
 */
export async function rcRestartCount(name: string): Promise<number> {
  const id = await rcContainerId(name);
  if (id === undefined) return 0;
  try {
    // Bounded for the same reason as composeLs: the detail panel refreshes this on a
    // timer, and "unknown" (0) is already the documented fallback.
    const result = await docker(['inspect', '--format', '{{.RestartCount}}', id], {
      capture: true,
      timeoutMs: 15_000,
    });
    const count = Number.parseInt(String(result.stdout ?? '0').trim(), 10);
    return Number.isFinite(count) ? count : 0;
  } catch (error) {
    // Any failure to run or read the command, which an Interrupted is not: a
    // Ctrl-C in `docker inspect` during `backup`'s wait for Rocket.Chat was a restart count
    // of 0, one more `still booting` line, and the next wait ending the run.
    if (error instanceof Interrupted) throw error;
    return 0;
  }
}

/**
 * Map compose project -> {service: `Status` string} for EVERY container.
 *
 * The same single `docker ps`; it just stopped discarding the rest of the output.
 * `rcStatusByProject` used to keep the rocketchat line and throw the others away, which
 * is why a repro whose MONGODB had exited reported `running` and `healthy` -- both
 * derived from the Rocket.Chat container alone, and Rocket.Chat serves /api/info
 * perfectly well with no database behind it.
 */
export async function servicesByProject(): Promise<Record<string, Record<string, string>>> {
  return await cachedQuery('services_by_project', servicesByProjectUncached);
}

export async function servicesByProjectUncached(): Promise<Record<string, Record<string, string>>> {
  let stdout: string;
  try {
    const result = await docker(
      [
        'ps',
        '--all',
        '--format',
        '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Status}}',
      ],
      { capture: true, timeoutMs: 30_000 },
    );
    // Same 4 s poll bound as composeLs; {} = "could not ask".
    if (result.exitCode !== 0) return {};
    stdout = String(result.stdout ?? '');
  } catch (error) {
    if (error instanceof Interrupted) throw error; // Ctrl-C or a stopped job: unwind
    return {};
  }
  const out: Record<string, Record<string, string>> = {};
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    const [project, service, status] = parts;
    if (parts.length < 3 || project === undefined || project === '') continue;
    out[project] ??= {};
    (out[project] as Record<string, string>)[service ?? ''] = status ?? '';
  }
  return out;
}

/**
 * Map compose project -> its rocketchat container `Status` string ("Up 2 hours
 * (healthy)"), in ONE `docker ps` call. Used to show uptime and health per repro without
 * an N-call fan-out.
 */
export async function rcStatusByProject(
  byProject?: Record<string, Record<string, string>>,
): Promise<Record<string, string>> {
  const servicesByName = byProject ?? (await servicesByProject());
  const out: Record<string, string> = {};
  for (const [project, services] of Object.entries(servicesByName)) {
    out[project] = services.rocketchat ?? services['rocketchat-1'] ?? '';
  }
  return out;
}

/** Per-container `{service, state, status, health}` for a repro, including stopped. */
export async function containerDetails(
  name: string,
): Promise<{ service: string; state: string; status: string; health: string }[]> {
  const result = await engine.compose(name, ['ps', '--all', '--format', 'json'], {
    capture: true,
  });
  if (result.exitCode !== 0) return [];
  // The object rows only, as before `parseJsonOrNdjson` kept every row: the previous
  // implementation reads each row as a mapping here too, but nothing has measured what a
  // detail panel should do on the non-object answer compose never gives, so this reads it
  // as it did.
  const data = parseJsonOrNdjson(String(result.stdout ?? ''));
  return (Array.isArray(data) ? data.filter(isMapping) : []).map((item) => ({
    service: String(item.Service ?? ''),
    state: String(item.State ?? ''),
    status: String(item.Status ?? ''),
    health: String(item.Health ?? ''),
  }));
}
