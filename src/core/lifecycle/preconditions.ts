/**
 * What has to be true before a command runs at all.
 *
 * Tier 1. Each of these REFUSES rather than warning: an engine that is not there, a state
 * transition that is not defined, a teardown the caller may not perform, a project name
 * already taken by something houston did not create. A create that starts and then cannot
 * finish leaves a half-made workspace, which is worse than never starting.
 */
import { ConflictError, DockerError, PreflightError, ValidationError } from '../../lib/errors';
import { quotedText, valueKind } from '../../lib/format';
import * as presets from '../../lib/presets/index';
import { actor as auditActor, record as auditRecord } from '../audit';
import { which } from '../kube/tools';
import { composeStandaloneVersion, composeVersion, dockerAvailable } from '../runner/host';
import * as paths from '../runner/paths';
import { projectName } from '../runner/record';
import { projectConfigFiles } from '../runner/queries';
import * as topology from '../topology';
import { MODE_ACME } from '../tls';

import * as naming from './naming';
import * as ownership from './ownership';
import { KUBERNETES_UNSUPPORTED, LOOPBACK_BINDS, STATE_ACTIONS, type CreateReq } from './types';

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value !== '';
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * A box can have the engine without the plugin, and `docker info` says nothing about it.
 *
 * AND the compose plugin, because every path here shells out to `docker compose` and a
 * box can have one without the other. It is a preflight fault -- fix your environment --
 * so it is raised as one, once, with the package to install.
 */
export async function requireTheComposePlugin(): Promise<void> {
  const cv = (await composeVersion()) ?? '';
  const major = cv ? (cv.split('.')[0] as string).replace(/^v/u, '') : '';
  if (!/^\d+$/u.test(major) || Number.parseInt(major, 10) < 2) {
    if (cv) {
      throw new PreflightError(
        `\`docker compose\` reports ${cv}, and houston needs v2 or newer. ` +
          'Upgrade the compose plugin, then `docker compose version`.',
      );
    }
    // NOT NECESSARILY ABSENT. The same binary is both the plugin and a standalone
    // `docker-compose`, so a box can have a working v2 on PATH while `docker compose`
    // does not exist -- the binary was never put where the docker CLI looks.
    const standalone = (await composeStandaloneVersion()) ?? '';
    if (standalone) {
      throw new PreflightError(
        '`docker compose` is not available, but a standalone ' +
          `\`docker-compose\` ${standalone} is on PATH — the binary is there and the ` +
          'docker CLI cannot see it as a plugin. houston calls `docker compose`, ' +
          'so register it once:\n' +
          '    mkdir -p ~/.docker/cli-plugins\n' +
          '    ln -sf "$(command -v docker-compose)" ' +
          '~/.docker/cli-plugins/docker-compose\n' +
          `  Then \`docker compose version\` should print ${standalone}.`,
      );
    }
    throw new PreflightError(
      '`docker compose` v2 is not available — the plugin is not installed. ' +
        'Everything houston does with containers goes through it.' +
        '\n  Amazon Linux / RHEL / Fedora: `sudo dnf install -y docker-compose-plugin`' +
        '\n  Debian / Ubuntu:              `sudo apt-get install -y docker-compose-plugin`' +
        '\n  Then `docker compose version`, and `houston doctor` to check the rest.',
    );
  }
}

/**
 * Refuse when the container engine is not answering.
 *
 * `DockerError`, not `NotReadyError`. The distinction is the whole point of the
 * exit-code taxonomy: `NOT_READY` (exit 5, HTTP 409) means "it is coming up, poll again",
 * and an absent engine is never that -- polling cannot start Docker.
 */
export async function requireDocker(): Promise<void> {
  if (!(await dockerAvailable())) {
    // Named for the platform, because "Start Docker Desktop" on Linux names a product
    // that is usually not the one installed.
    const starter =
      process.platform === 'darwin' || process.platform === 'win32'
        ? 'Start Docker Desktop'
        : 'Start it with `sudo systemctl start docker`';
    throw new DockerError(`Docker isn't running. ${starter} and try again.`);
  }
  await requireTheComposePlugin();
}

/**
 * What a runtime cannot honour, from the registry the create path enforces.
 *
 * Published so the create dialog can say it BEFORE somebody fills a field in -- and, more
 * to the point, so it cannot say it wrongly.
 */
export function unsupportedFields(runtime: string): { field: string; why: string }[] {
  if (topology.normalize(runtime) !== topology.KUBERNETES) return [];
  return KUBERNETES_UNSUPPORTED.map(([name, why]) => ({ field: name, why }));
}

/**
 * Require the engine THIS workspace runs on -- not the one Compose needs.
 *
 * `requireDocker()` was called before anything looked at the runtime, so every Kubernetes
 * path went through a gate it has no use for. On a host with no Docker at all -- the
 * documented adopt-an-existing-cluster setup -- `upgrade`, `ready`, `logs`, `token`,
 * `api`, `pat`, `seed` and `down` all refused a perfectly healthy workspace.
 *
 * CONTRACT: `target` is an already-resolved workspace name.
 */
export async function requireEngine(target: string): Promise<void> {
  if ((await topology.ofRepro(target)) !== topology.KUBERNETES) {
    await requireDocker();
    return;
  }
  // kubectl is the engine here. Said rather than assumed: without it every Kubernetes
  // operation fails one layer deeper, in a subprocess whose "command not found" names
  // nothing the reader can act on.
  if (!which('kubectl')) {
    throw new PreflightError(
      `'${target}' runs on Kubernetes and \`kubectl\` is not on PATH, so ` +
        'houston cannot reach it. Install kubectl and make sure your ' +
        'kubeconfig points at the cluster this workspace lives in.',
    );
  }
}

/**
 * Whether anything off this machine can reach this workspace.
 *
 * This is the ONE question `config.ADMIN_PASSWORD` turns on. Both ways of removing that
 * premise are here: a public name reaches Rocket.Chat through the edge while the
 * workspace itself stays on loopback, so the bind check alone answers "no" for the very
 * case that matters most.
 *
 * A LOCAL-CA `--https` name is deliberately NOT public: `<name>.houston.localhost`
 * resolves to 127.0.0.1, nothing off the box can reach it, and treating it as exposed
 * would rotate the password for the common local case for no gain.
 */
export function reachableBeyondLoopback({
  tlsspec = null,
  bindHost = '',
}: {
  tlsspec?: { mode: string } | null;
  bindHost?: string;
} = {}): boolean {
  if (tlsspec !== null && tlsspec.mode === MODE_ACME) return true;
  return !LOOPBACK_BINDS.includes(bindHost);
}

/**
 * Refuse to create when a docker compose project of the same derived name already exists
 * but belongs to a DIFFERENT workspace.
 *
 * The project name is `houston-<name>` regardless of HOUSTON_HOME, so a repro named after
 * an existing one in another home would make `docker compose up` reconcile (hijack) the
 * other workspace's containers/volume. Best-effort: if docker can't be queried, skip the
 * check rather than block.
 */
export async function guardProjectCollision(name: string): Promise<void> {
  const existing = await projectConfigFiles();
  if (existing === null || Object.keys(existing).length === 0) return;
  const proj = await projectName(name);
  if (!Object.hasOwn(existing, proj)) return;
  const ours = `${paths.workspace(name)}/docker-compose.yml`;
  const files = String(existing[proj] ?? '');
  if (!files.includes(ours)) {
    throw new ConflictError(
      `a docker compose project '${proj}' already exists, owned by a different ` +
        `workspace (${files || 'unknown'}). Creating '${name}' here would hijack its ` +
        'containers and data volume - choose a different --name.',
    );
  }
}

/**
 * Refuse a bad stop/start/restart BEFORE any work is queued. Returns the target.
 *
 * A PREFLIGHT: a refusal must leave no trace. The GUI runs this as a job now, and a job
 * answers 200 with an id -- so a bad action or an unknown name would have become a job
 * that failed rather than a 400 or a 404 on the request that made the mistake.
 */
export async function checkStateRequest(name: string, action: unknown): Promise<string> {
  if (typeof action !== 'string') {
    throw new ValidationError(
      `action must be a string (want ${STATE_ACTIONS.join('|')}), got ` + `${valueKind(action)}`,
    );
  }
  if (!STATE_ACTIONS.includes(action)) {
    throw new ValidationError(`unknown action '${action}' (want ${STATE_ACTIONS.join('|')})`);
  }
  return await naming.resolveName(name);
}

/**
 * Refuse an unconfirmed or unowned teardown before it is queued. Returns the target.
 *
 * Same reason as `checkStateRequest`, and the stake is higher: without it a member who
 * asked to destroy a colleague's workspace got 200 and a job id, and had to open the
 * Activity list to discover they had been refused.
 */
export async function checkTeardownRequest(
  name: string,
  { volumes = false, confirm = false } = {},
): Promise<string> {
  const target = await naming.resolveName(name);
  if (volumes && !confirm) {
    throw new ValidationError(
      `deleting ${quotedText(target)}'s data volume and record is irreversible - pass confirm=true`,
    );
  }
  if (volumes) {
    const [allowed, why] = await ownership.mayDestroy(target, auditActor());
    if (!allowed) {
      auditRecord('down-volumes', target, { outcome: 'denied' });
      throw new ConflictError(why);
    }
  }
  return target;
}

/**
 * Refuse what this runtime cannot honour, rather than accepting and dropping it.
 *
 * Ordered so the most consequential is reported first when several are set: being told
 * about `--fresh` matters more than being told about `--reg-token`, because one of them
 * is about data.
 */
export function refuseUnsupportedOnKubernetes(req: CreateReq): void {
  const bag = req as unknown as Record<string, unknown>;
  for (const [name, why] of KUBERNETES_UNSUPPORTED) {
    if (isTruthy(bag[name])) {
      throw new ValidationError(
        `--${name.replace(/_/gu, '-')} is not supported on Kubernetes yet: ` +
          `${why}. Use --runtime docker for a workspace that needs it.`,
      );
    }
  }
  // A preset reaches Kubernetes when it has an adapter for it. Those that do not are
  // still refused, because being recorded and not applied is what this guard exists to
  // prevent; but the refusal is now per preset rather than a blanket "not supported", and
  // it names the ones that DO work so the answer is actionable.
  if (req.preset && req.preset !== 'default') {
    const works = [...presets.scenarioNames()].sort().join(', ') || 'none yet';
    let resolved;
    try {
      resolved = presets.resolve(req.preset, topology.KUBERNETES, req.params);
    } catch (error) {
      throw new ValidationError(
        `preset '${req.preset}' cannot be resolved for Kubernetes: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Presets with a Kubernetes adapter: ${works}. Or use ` +
          '--runtime docker, where every preset works.',
      );
    }
    // RESOLVING is not the same as WORKING. A preset with no scenario adapter comes back
    // with its Compose `services` intact -- Keycloak, Mailpit, MinIO -- and this runtime
    // builds no compose document, so those containers would simply never exist while the
    // settings pointing at them were applied.
    if (Object.keys(resolved.services).length > 0 && resolved.kubernetesManifests.length === 0) {
      throw new ValidationError(
        `preset '${req.preset}' needs backing services ` +
          `(${Object.keys(resolved.services).sort().join(', ')}) and has no ` +
          'Kubernetes adapter to create them, so they would be missing while ' +
          'Rocket.Chat was configured to use them. Presets with an adapter: ' +
          `${works}. Or use --runtime docker, where every preset works.`,
      );
    }
  }
}
