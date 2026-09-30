/**
 * Reading a create request: what runtime it means, what it would provision, what it may
 * not ask for.
 *
 * Tier 0. Pure shaping and refusal -- nothing here writes, and `capacity` depends on it to
 * know whether a create will provision a cluster and therefore whether the cluster overhead
 * counts against this machine.
 */
import * as config from '../../lib/config';
import { ValidationError } from '../../lib/errors';
import { type Emit, info, nullEmit, warn } from '../../lib/events';
import { truthyParam } from '../../lib/presets/common';
import { type Preset } from '../../lib/presets/types';
import { type ReleaseFetcher, RELEASES_URL, isValidVersion } from '../../lib/versions';
import * as topology from '../topology';
import { planCluster } from '../kube/context';
import { releaseInfo } from '../rcapi';

import {
  BILLABLE_CONTEXT_PREFIXES,
  BROWSER_HOST_PARAM,
  LOOPBACK_BINDS,
  type CreateReq,
} from './types';

/** Truthiness, as a function -- `unknown` may not appear in a conditional. */
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value !== '';
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * The release lookup `versions.resolve` makes, made WHERE it has always been made.
 *
 * `resolve` is synchronous and HTTP is not, so its document is fetched first and handed
 * over. It is asked after the name checks, the create lock and the engine preflight -- so
 * every refusal ahead of it (Docker down, compose missing, a bad `--name` or `--env`)
 * answers without touching the network. `up` fetched
 * right after parsing `--set`, ahead of all of them, so each of those refusals waited on a
 * request first, for its whole 5 s timeout on a network that drops packets.
 * Offline, or a version `resolve` refuses before going online, asks nothing; a fetcher a
 * caller injected is used as given.
 */
export async function releaseFetcher(
  version: string,
  offline: unknown,
  given?: ReleaseFetcher,
): Promise<ReleaseFetcher | undefined> {
  if (given !== undefined) return given;
  if (isTruthy(offline) || !isValidVersion(version)) return undefined;
  const fetched = await releaseInfo(RELEASES_URL.replace('{version}', version));
  return () => fetched;
}

/** The URL's hostname, or "" when it has none. */
function urlHostname(value: string): string {
  if (!value) return '';
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

/**
 * Whether this create is going to CREATE a cluster, as opposed to use one.
 *
 * The two capacity questions below both turn on it, and both used to ask something
 * narrower that gave the wrong answer the moment houston could use a cluster it did not
 * make: `clusterExists` is specifically OUR kind cluster, so a box whose k3s was about
 * to be adopted was billed 600 MB for a control plane already running.
 *
 * False on any doubt. An unprobeable cluster is not evidence that one will be built.
 */
export async function willProvision(req: CreateReq): Promise<boolean> {
  if (topology.normalize(req.runtime) !== topology.KUBERNETES) return false;
  try {
    // The request's context, or this answers for the WRONG cluster: with `kind`
    // installed, an un-passed context makes `planCluster` plan a kind create and return
    // true, so `checkCapacity` would reserve a control plane's RAM for a workspace going
    // to a cluster that already exists somewhere else.
    return (await planCluster(reqContext(req))).create;
  } catch {
    // No cluster and no kind: the create will refuse.
    return false;
  }
}

/**
 * The runtime this request means, with a context taken as saying Kubernetes.
 *
 * A CONTEXT IS A KUBERNETES WORD. Somebody who typed `--context <an eks arn>` has already
 * said where this runs. Only from an EXPLICIT `--context`, never from the box default: a
 * default cluster is a convenience for the Kubernetes work somebody already does, and
 * letting it silently move `up` off Compose would change what an un-flagged command means
 * for every workspace on the box.
 */
export function inferRuntime(req: CreateReq): string {
  const named = String(req.runtime).trim();
  if (named) return named;
  if (String(req.context).trim()) return topology.KUBERNETES;
  return named;
}

/**
 * Say out loud when a SAVED setting decided where this workspace goes.
 *
 * `kubernetes.context` changes what other commands mean and nothing ever mentioned it,
 * which produced two opposite complaints from the same silence. Both are the same defect:
 * a stored setting that decides something, with nothing on screen saying it did. Neither
 * is a refusal -- this reports, and the operator decides.
 *
 * An explicit `--context` says nothing here: naming the cluster on the command line is
 * already the unambiguous form.
 */
export function sayWhereThisIsGoing(
  req: CreateReq,
  typedRuntime: string,
  emit: Emit = nullEmit,
): void {
  const saved = config.defaultKubeContext();
  if (!saved || String(req.context).trim()) return;
  if (topology.normalize(req.runtime) === topology.KUBERNETES) {
    // Only when it COSTS: a saved kind or k3s context being used by `--runtime
    // kubernetes` is the whole point of saving one, and warning about it every time
    // would train people to stop reading these.
    if (savedDefaultIsBillable(saved)) {
      warn(
        emit,
        `this workspace is going to '${saved}', which costs money by the ` +
          "hour — it was chosen because it is this box's saved default " +
          'cluster, not because this command named one. `--context <name>` ' +
          'names a cluster outright; `houston config set ' +
          "kubernetes.context ''` clears the default.",
        { phase: 'preflight' },
      );
    }
    return;
  }
  if (typedRuntime) return; // they said `--runtime docker`; they are not confused
  info(
    emit,
    `this workspace is going to Docker. '${saved}' is saved as this box's ` +
      'default cluster, but a plain `up` never uses it — add `--runtime ' +
      'kubernetes` to send this one there, or `--context <name>` to name a ' +
      'cluster outright.',
    { phase: 'preflight' },
  );
}

/**
 * Whether a saved context names a cluster somebody is paying for.
 *
 * Read from the CONTEXT NAME, never by probing. This runs on the way into every create,
 * including Compose ones, and a create that pauses to ask a cloud API which kind of
 * cluster it is not about to use has bought nothing at a real price.
 */
export function savedDefaultIsBillable(context: string): boolean {
  const low = context.trim().toLowerCase();
  return BILLABLE_CONTEXT_PREFIXES.some((prefix) => low.startsWith(prefix));
}

/**
 * Which cluster this request names, falling back to the box's default.
 *
 * ONE function because two callers need the same answer and disagreeing is a real failure
 * rather than an untidiness: `willProvision` decides whether `checkCapacity` reserves a
 * control plane's RAM, and `createKubernetes` decides where the workspace actually goes.
 */
export function reqContext(req: CreateReq): string {
  const named = String(req.context).trim();
  return named || config.defaultKubeContext();
}

/** The params the preset does not document, sorted. */
export function unknownParams(params: Record<string, unknown>, pre: Preset): string[] {
  return Object.keys(params)
    .filter((key) => !Object.hasOwn(pre.paramsHelp, key))
    .sort();
}

/**
 * The interface these ports will be published on, as far as is known this early.
 *
 * `req.bindPublic` can still widen it later -- `resolveTls` sets that when an ACME
 * challenge needs the host reachable -- so this is the REQUESTED bind, not the final one.
 * Callers that must not over-promise use it in the conservative direction: loopback here
 * means "do not assume anything is reachable".
 */
export function requestedBindHost(req: CreateReq): string {
  const cfg = config.loadConfig();
  if (req.bind) return String(req.bind);
  if (isTruthy(cfg.bind_host)) return String(cfg.bind_host);
  return config.DEFAULT_BIND_HOST;
}

/**
 * Default a preset's browser-facing hostname from the URL the browser will use.
 *
 * `--root-url https://rc.example.com` and `--domain rc.example.com` both say, in as many
 * words, "people will type this". The saml/oidc presets otherwise send the browser to
 * `localhost:8081` / `keycloak:8085`, and `s3_minio` in presigned mode hands it
 * `minio:9000` -- all of which name the visitor's own laptop.
 *
 * Explicit `--set` always wins; nothing is derived for a workspace nobody said would be
 * reached from elsewhere.
 */
export function deriveIdpHost(req: CreateReq, emit: Emit = nullEmit): void {
  const param = BROWSER_HOST_PARAM[req.preset];
  if (param === undefined) return;
  const params: Record<string, unknown> = { ...req.params };
  if (isTruthy(params[param])) return;
  // s3_minio ONLY in presigned mode. In the default proxy mode the browser never touches
  // MinIO -- Rocket.Chat streams the bytes -- so `minio:9000` is reached over the compose
  // network, which is strictly more reliable than a host address.
  if (req.preset === 's3_minio' && !truthyParam(params, 'presigned')) return;
  // A HOST IS ONLY WORTH DERIVING IF IT CAN BE REACHED, and with the default loopback
  // bind it cannot -- by anything, including Rocket.Chat's own container. OIDC's url
  // serves the browser AND RC's backend, so deriving it here would have moved the backend
  // off compose DNS onto an address nothing can reach, turning one broken leg into two.
  if (LOOPBACK_BINDS.includes(requestedBindHost(req))) return;
  const source = req.rootUrl || (req.domain ? `https://${req.domain}` : '');
  const host = urlHostname(source);
  if (!host || host === 'localhost' || host === '127.0.0.1') return;
  params[param] = host;
  req.params = params;
  info(
    emit,
    `the ${req.preset} preset will address its own service as '${host}', ` +
      'taken from the URL you gave — that is the name the browser follows, ' +
      'and its default names this machine. Override with ' +
      `\`--set ${param}=...\`.`,
    { phase: 'create' },
  );
}

/**
 * The default for create's `monitorAttach` hook.
 *
 * A create may be asked for monitoring, and the thing that knows how to attach it lives a
 * layer up -- so the parameter defaults to a refusal rather than to `null`, and a caller
 * that forgets gets a ValidationError naming the omission instead of a TypeError deep
 * inside the k8s branch.
 */
export function missingMonitorAttach(_name: string, _emit: Emit): Record<string, unknown> {
  throw new ValidationError('monitoring attachment was not supplied by the caller');
}
