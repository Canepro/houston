/**
 * Creating a workspace on Docker Compose, and the front door both runtimes come in by.
 *
 * Tier 5. `createRepro` takes the lock and dispatches; `createReproLocked` is the Compose
 * path, and it is a PLAN plus a sequence of named steps rather than one function.
 *
 * It was 503 lines at cyclomatic complexity 99, and the cost was not aesthetic: the order
 * of those lines is load-bearing in about a dozen places, every one of them recorded in a
 * comment saying what broke when it was somewhere else. Each step names what it does, and
 * the order is visible in one screen at the bottom of this module.
 */
import * as fs from 'node:fs/promises';

import * as compose from '../../lib/compose';
import * as config from '../../lib/config';
import {
  ConflictError,
  DockerError,
  PreflightError,
  ValidationError,
  errorText,
} from '../../lib/errors';
import { type Emit, info, nullEmit, warn } from '../../lib/events';
import {
  notes as monitoringNotes,
  files as monitoringFiles,
  grafanaUrl as monitoringGrafanaUrl,
} from '../../lib/monitoring';
import { toText } from '../../lib/format';
import * as presets from '../../lib/presets/index';
import { type Preset } from '../../lib/presets/types';
import {
  type ReleaseFetcher,
  type Resolved,
  applyMongoOverride,
  resolve,
} from '../../lib/versions';
import { actor as auditActor, record as auditRecord } from '../audit';
import { diagnoseFailure } from '../diagnose';
import { attach } from '../edge/networks';
import { hasAcme, issueLocalCert } from '../edge/acme';
import { foreignEdge, portHolder, running as edgeRunning } from '../edge/engine';
import { ensureRunning } from '../edge/runtime';
import { register as registerRoute } from '../edge/routes';
import { dockerKernelVersion } from '../runner/host';
import * as engine from '../runner/engine';
import { reproLock, updateConfig as updateLockedConfig } from '../runner/locks';
import * as paths from '../runner/paths';
import * as record from '../runner/record';
import { rcState, removeVolumes } from '../runner/queries';
import * as topology from '../topology';
import { MODE_LOCAL, acmeDir, budgetWarning, recordIssuance, rootUrl as tlsRootUrl } from '../tls';

import type * as createK8s from './create-k8s';
import { createKubernetes } from './create-k8s';
import * as inspect from './inspect';
import * as naming from './naming';
import * as ownership from './ownership';
import * as ports from './ports';
import * as preconditions from './preconditions';
import { restoreRoute, upCompose, waitAndFinalize } from './ready';
import * as request from './request';
import * as seeding from './seeding';
import * as sizing from './sizing';
import * as tlsplan from './tlsplan';
import { mongoKernelConflict } from '../../lib/mongo-kernel';
import { type CreateReq, BROWSER_HOST_PARAM, LOOPBACK_BINDS } from './types';
import { type TlsSpec } from '../tls';
import {
  clearKind,
  record as journalRecord,
  clear as journalClear,
  CREATE_UNFINISHED,
} from '../journal';

type Bag = Record<string, unknown>;

function bag(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value !== '';
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * What one Compose create knows, in the order it comes to know it.
 *
 * Every field is filled by exactly one step and read by the ones after it, so the
 * sequence at the bottom of this module IS the data flow -- there is no hidden channel
 * between steps.
 */
export interface CreatePlan {
  req: CreateReq;
  emit: Emit;
  streamOutput: boolean;
  monitorAttach: createK8s.MonitorAttach;
  versionFetcher?: ReleaseFetcher;
  /** `resolvePairing` */
  cfg: config.Config;
  resolved: Resolved | null;
  /** `loadPreset` */
  pre: Preset | null;
  wait: boolean;
  /** `settleName` */
  reproName: string;
  /** `claimPorts` */
  hostPort: number;
  root: string;
  token: string;
  bindHost: string;
  tlsspec: TlsSpec | null;
  /** `warnAboutTheBrowserHost` */
  public: string;
  /** `buildDocument` */
  envOverrides: Record<string, string | null>;
  adminPassword: string;
  spec: compose.Spec | null;
  doc: compose.ComposeDoc | null;
  /** `buildRecord` */
  meta: record.Metadata | null;
  /** `prepareEdge`, then `attachMonitoring` */
  files: [string, string][];
}

export function createPlan(
  values: Partial<CreatePlan> & Pick<CreatePlan, 'req' | 'emit'>,
): CreatePlan {
  return {
    streamOutput: false,
    monitorAttach: request.missingMonitorAttach,
    cfg: {},
    resolved: null,
    pre: null,
    wait: false,
    reproName: '',
    hostPort: 0,
    root: '',
    token: '',
    bindHost: '',
    tlsspec: null,
    public: '',
    envOverrides: {},
    adminPassword: '',
    spec: null,
    doc: null,
    meta: null,
    files: [],
    ...values,
  };
}

/**
 * EVERY note for this workspace, not just the one just written.
 *
 * An earlier create that failed left its own, and clearing only ours left that one
 * claiming a finished workspace had never finished.
 *
 * UNLESS THE CALLER STILL HAS WORK TO DO. With `seedHere` the CLI runs the seed after the
 * create returns, so clearing here would delete the note in the window it exists for.
 */
export function clearTheUnfinishedNote(req: CreateReq, name: string, note: string): void {
  if (!req.seedHere) {
    journalClear(note);
    clearKind(CREATE_UNFINISHED, naming.deriveFor(req) || name);
  }
}

/**
 * The create itself, plus the write-ahead note that says it may not have finished.
 *
 * A CREATE THAT NEVER FINISHES LEAVES A WORKSPACE THAT LOOKS FINE. Measured by killing one
 * mid-flight: `docker compose up -d` has already detached, so the containers come up on
 * their own and `list` reports it `running` -- which is true. What is lost is everything
 * after readiness: the preset's self-configuration, the seed, the edge route.
 *
 * Advisory rather than repaired automatically: finishing it means waiting for Rocket.Chat
 * to serve and then running post_ready, which can take the full readiness timeout, and
 * `serve`'s startup must not hold the GUI shut for that.
 */
export async function createUnderTheLock(
  req: CreateReq,
  name: string,
  emit: Emit,
  {
    streamOutput,
    monitorAttach,
    versionFetcher,
  }: {
    streamOutput: boolean;
    monitorAttach: createK8s.MonitorAttach;
    versionFetcher?: ReleaseFetcher;
  },
): Promise<Bag> {
  return await reproLock(name, async () => {
    // WHAT THE NOTE HAS TO CARRY. `ready` is the command the note tells people to run, and
    // it could not finish a seed because the request that asked for one died with the
    // process -- `req.seed` lives in a CreateReq nobody can read any more.
    const detail = {
      seed: Boolean(req.seed),
      seed_here: Boolean(req.seedHere),
      seed_profile: String(req.seedProfile),
      seed_stats: Boolean(req.stats),
    };
    let note = journalRecord(CREATE_UNFINISHED, name, detail);
    let out: Bag;
    try {
      out = await createReproLocked(req, emit, {
        streamOutput,
        monitorAttach,
        ...(versionFetcher === undefined ? {} : { versionFetcher }),
      });
    } catch (error) {
      // A REFUSAL CREATED NOTHING, so it must leave nothing. Without this the note
      // survived every kind of refusal -- a bad version, a taken port, a capacity
      // preflight -- one per attempt, and `doctor` then warned about a workspace that
      // does not exist while telling the reader to run `houston ready` on it.
      journalClear(note);
      throw error;
    }
    // RE-KEYED TO THE WORKSPACE THAT EXISTS. The note is recorded under the name derived
    // BEFORE `resolveAxes` ran, and `--deployment multi-instance` without a `--name` renames
    // the workspace on the way (`rc8-5-1` becomes `rc8-5-1-multi-instance`). With `seedHere`
    // the note is the CALLER's to close, by the name it is handed back -- so the one under
    // the old name was never cleared, and `doctor` reported an unfinished create for a
    // workspace that does not exist. Moved rather than dropped: until the caller's seed
    // lands, a kill must still leave a note, for the right name. The previous
    // implementation moves it the same way.
    const created = isTruthy(out.name) ? String(out.name) : name;
    if (req.seedHere && created !== name) {
      journalClear(note);
      note = journalRecord(CREATE_UNFINISHED, created, detail);
    }
    clearTheUnfinishedNote(req, name, note);
    return out;
  });
}

/**
 * Create-or-reuse a repro. Returns a result object (meta + boot/seed info).
 *
 * `streamOutput=true` streams docker's line output through `emit` (for the web job log);
 * false leaves docker's own progress on the terminal (CLI default). Serialised per repro,
 * like every other mutating operation.
 */
export async function createRepro(
  req: CreateReq,
  emit: Emit = nullEmit,
  {
    streamOutput = false,
    monitorAttach = request.missingMonitorAttach,
    versionFetcher,
  }: {
    streamOutput?: boolean;
    monitorAttach?: createK8s.MonitorAttach;
    versionFetcher?: ReleaseFetcher;
  } = {},
): Promise<Bag> {
  // ONCE, HERE, before anything reads it. `runtime` is consulted at a dozen places
  // downstream and inferring it at each would be a dozen chances to disagree; after this
  // `req.runtime` means what the caller meant rather than only what they typed.
  const typedRuntime = String(req.runtime).trim();
  req.runtime = request.inferRuntime(req);
  request.sayWhereThisIsGoing(req, typedRuntime, emit);

  const name = naming.deriveFor(req);
  if (!name) {
    throw new ValidationError(
      `name '${req.name}' contains no usable characters (want a-z, 0-9, '-')`,
    );
  }
  // The workspace's public name, from the cluster's zone, once the name is known.
  await request.defaultDomainFromZone(req, name, emit);
  naming.requireValidName(name);
  return await createUnderTheLock(req, name, emit, {
    streamOutput,
    monitorAttach,
    ...(versionFetcher === undefined ? {} : { versionFetcher }),
  });
}

/** Reuse an existing workspace exactly as recorded, saying so when that ignores a flag. */
export async function reuse(
  name: string,
  wait: boolean,
  req: CreateReq,
  emit: Emit,
  {
    streamOutput,
    resolved = null,
    presetName = '',
  }: { streamOutput: boolean; resolved?: Resolved | null; presetName?: string } = {
    streamOutput: false,
  },
): Promise<Bag> {
  const meta = await record.readMeta(name);
  // An existing repro is reused EXACTLY as recorded. Say so when the request asked for
  // something else: `up --version 9.9.9 --name existing` silently booted the old version,
  // which is fatal for a tool whose whole premise is version matching.
  const mismatch: string[] = [];
  if (resolved !== null && resolved.rcVersion !== meta.rcVersion) {
    mismatch.push(`version ${resolved.rcVersion} (existing: ${meta.rcVersion})`);
  }
  if (presetName && presetName !== meta.preset) {
    mismatch.push(`preset '${presetName}' (existing: '${meta.preset}')`);
  }
  if (req.monitor && !isTruthy(meta.extra.monitoring)) {
    mismatch.push('monitoring (existing: not attached)');
  }
  if (mismatch.length > 0) {
    const msg =
      `'${name}' already exists and is reused as-is, ignoring requested ` +
      mismatch.join('; ') +
      '. Use --force to rebuild it, or --fresh to also wipe its data.';
    warn(emit, msg, {
      phase: 'create',
      code: 'VERSION_IGNORED_ON_REUSE',
      data: {
        requested: resolved?.rcVersion ?? '',
        running: meta.rcVersion,
        ignored: mismatch,
      },
    });
    // AND IN THE ENVELOPE. In prose this is loud; under `--json` it was an NDJSON progress
    // event and the envelope still said `ok: true, warnings: []`.
  }
  const state = await rcState(name);
  if (state === 'running') {
    info(emit, `'${name}' is already running.`, { phase: 'create' });
  } else {
    info(emit, `'${name}' already exists - bringing it back up.`, { phase: 'create' });
    if ((await upCompose(name, { pull: false, emit, streamOutput })) !== 0) {
      throw new DockerError('`docker compose up` failed');
    }
  }
  // A reused workspace gets its https name back. This path never resolved TLS -- it reuses
  // the record as-is -- so after a `down`, `up` printed "URL https://…" from that record
  // while the name served nothing at all: the route was removed by the teardown and never
  // rewritten.
  await restoreRoute(meta, emit);

  const result = inspect.summary(meta);
  result.reused = true;
  result.waited = wait;
  if (wait) Object.assign(result, await waitAndFinalize(meta, emit));
  // NOT when the caller seeds. `seedHere` means the CLI runs it after this returns, so
  // seeding here as well would seed the workspace twice -- the manifest only ever adds, so
  // the readback would report rooms holding more than planned.
  if (req.seed && !req.seedHere) {
    result.seed = await seeding.runSeedInline(meta, req.seedProfile, req.stats, emit);
  }
  return result;
}

/** Runtime x deployment x scenario, decided before anything else reads the request. */
export async function resolveAxesStep(plan: CreatePlan): Promise<void> {
  // An existing workspace's RECORDED runtime beats the flag default. Without this,
  // `houston up -v 8.5.1 --name X` on a Kubernetes workspace defaulted to docker and ran
  // `docker compose up` against a workspace with no compose file.
  //
  // Read BEFORE resolveAxes: it normalises an empty --runtime to "docker", after which
  // `!req.runtime` is never true and this could not fire.
  const existing = naming.deriveFor(plan.req);
  if (!plan.req.runtime && existing && (await paths.exists(existing))) {
    plan.req.runtime = await topology.ofRepro(existing);
  }
  const axes = topology.resolveAxes({
    runtime: plan.req.runtime,
    deployment: plan.req.deployment,
    replicas: plan.req.replicas,
    preset: plan.req.preset,
    params: plan.req.params,
  });
  topology.requireRegistered(axes.runtime);
  for (const hint of axes.hints) info(plan.emit, hint, { phase: 'plan' });
  plan.req.preset = axes.preset;
  plan.req.params = axes.params;
  plan.req.runtime = axes.runtime;
  plan.req.deployment = axes.deployment;
  plan.req.replicas = axes.replicas;
  // ABOVE THE RUNTIME DISPATCH, deliberately: it started life below it, so `--root-url`
  // derived an IdP host on Compose and derived nothing at all on Kubernetes. Both runtimes
  // resolve the preset from `req.params`, so one call site above the fork covers both.
  request.deriveIdpHost(plan.req, plan.emit);
}

/** Which Rocket.Chat and which MongoDB, and whether this engine can run the pair. */
export async function resolvePairing(plan: CreatePlan): Promise<void> {
  await preconditions.requireDocker();
  plan.cfg = config.loadConfig();

  // HERE, where the release lookup has always gone online: after the engine preflight and
  // the name checks, not ahead of them.
  const fetcher = await request.releaseFetcher(
    plan.req.version,
    plan.req.offline,
    plan.versionFetcher,
  );
  try {
    plan.resolved = resolve(plan.req.version, {
      offline: plan.req.offline,
      ...(fetcher === undefined ? {} : { fetcher }),
    });
  } catch (error) {
    throw new ValidationError(errorText(error));
  }
  // SAID BEFORE THE BUILD, not discovered after it. `resolve()` already knows when
  // releases.rocket.chat answered 404 -- it stamps `source` -- and the create path ignored
  // it, so `up --version 99.99.99` built the whole compose document, created containers and
  // failed at the pull with docker's own "not found", ~90 seconds later.
  if (plan.resolved.source === 'map (no such release)') {
    warn(
      plan.emit,
      `releases.rocket.chat has no ${plan.req.version} — the pairing below ` +
        'comes from the shipped map, and the image pull will fail unless ' +
        `this tag really exists (\`houston versions ${plan.req.version}\`).`,
      { phase: 'resolve' },
    );
  }
  if (plan.req.rcImage || isTruthy(plan.cfg.rc_image)) {
    plan.resolved.rcImage = plan.req.rcImage || String(plan.cfg.rc_image);
  }
  if (plan.req.mongo) applyMongoOverride(plan.resolved, plan.req.mongo);

  // Before any docker work: this pairing cannot boot on this engine, and mongod says so by
  // exiting with a message that reads like a permission fault. The rule is a leaf; this
  // caller supplies the engine probe.
  const conflict = mongoKernelConflict(plan.resolved.mongoTag, await dockerKernelVersion());
  if (conflict) throw new PreflightError(conflict);
}

/** The preset, its parameters, and whether this create has to wait for readiness. */
export function loadPreset(plan: CreatePlan): void {
  try {
    plan.pre = presets.load(plan.req.preset, plan.req.params);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : String(error));
  }
  const unknown = request.unknownParams(plan.req.params, plan.pre);
  if (unknown.length > 0) {
    const valid =
      Object.keys(plan.pre.paramsHelp).sort().join(', ') || '(this preset takes no --set params)';
    throw new ValidationError(
      `unknown --set param(s) for preset '${plan.req.preset}': ${unknown.join(', ')} - valid: ${valid}`,
    );
  }

  plan.wait = plan.req.wait || plan.pre.postReady.length > 0 || plan.req.seed;
}

/** The workspace's name, and every refusal that depends on having one. */
export async function settleName(plan: CreatePlan): Promise<void> {
  plan.reproName = naming.deriveFor(plan.req);
  naming.warnNameCoerced(plan.req, plan.emit);
  // Before any docker work, and only for a workspace that does not exist yet: `up` on an
  // existing one reuses its containers and adds nothing.
  // `--force` is NOT a reason to skip this. `checkCapacity` has its own force branch that
  // warns loudly and proceeds -- written because "this is the guard that exists after an
  // OOM took out a 10 GB host: overriding it has to stay visible". Excluding force HERE
  // made that branch unreachable for a new workspace, so the loud override became a silent
  // one: the function was never called at all.
  if (!(await paths.exists(naming.deriveFor(plan.req)))) {
    await sizing.checkCapacity(plan.req, plan.req.preset, plan.emit);
  }
  if (!plan.reproName) {
    throw new ValidationError(
      `name '${plan.req.name}' contains no usable characters (want a-z, 0-9, '-')`,
    );
  }
  // sanitize() fixes the CHARACTERS but not the length, and the first thing below is a
  // stat on the derived path -- which throws ENAMETOOLONG rather than returning false for
  // an over-long name.
  naming.requireValidName(plan.reproName);
  if (plan.req.port && !(plan.req.port >= 1024 && plan.req.port <= 65535)) {
    throw new ValidationError(`--port ${String(plan.req.port)} is out of range (want 1024-65535)`);
  }
}

/** The host port, the URL houston will call itself by, and the TLS plan. */
export async function claimPorts(plan: CreatePlan): Promise<void> {
  const pre = plan.pre as Preset;
  await preconditions.guardProjectCollision(plan.reproName);
  await ports.checkSidecarPorts(pre, plan.reproName);
  if (plan.req.monitor) await ports.checkMonitorPorts(plan.reproName);
  plan.hostPort = await ports.pickHostPort(plan.req.port, pre, plan.reproName);
  // ALWAYS the published local port, never an override. `--root-url` says what Rocket.Chat
  // should ADVERTISE, and it still does that through the compose spec below -- but `root`
  // is what houston calls itself, and Metadata's own docstring makes that a contract.
  //
  // Letting the override through broke that contract, and readiness is where it showed:
  // `ready` polls meta.rootUrl, so a workspace whose root_url held a public https name
  // reported "Rocket.Chat did not become ready within 300s" while /api/info on the local
  // port answered 200 the whole time.
  plan.root = `http://localhost:${String(plan.hostPort)}`;
  plan.token = plan.req.regToken || toText(plan.cfg.reg_token);
  plan.bindHost = request.requestedBindHost(plan.req);
  plan.tlsspec = await tlsplan.resolveTls(
    plan.req,
    plan.reproName,
    plan.bindHost,
    plan.reproName,
    plan.emit,
  );
}

/** What publishing this workspace off loopback exposes, said once, at create time. */
export function warnAboutTheBind(plan: CreatePlan): void {
  if (plan.req.bindPublic && plan.bindHost !== '0.0.0.0' && plan.bindHost !== '::') {
    // Derived from the challenge (see resolveTls), not requested.
    plan.bindHost = '0.0.0.0';
    warn(
      plan.emit,
      `binding 0.0.0.0 so Let's Encrypt can reach this host for the ` +
        `${plan.req.acmeChallenge} challenge - that exposes the workspace, and ` +
        'it runs the fixed admin/admin123 credentials. `houston down` when ' +
        'you are finished.',
      { phase: 'tls' },
    );
  } else if (!LOOPBACK_BINDS.includes(plan.bindHost)) {
    // THE SAME EXPOSURE, ASKED FOR RATHER THAN DERIVED, AND IT WAS SILENT. The warning
    // above fires only when houston widened the bind ITSELF for an ACME challenge; `up
    // --bind 0.0.0.0` typed by hand got the normal panel and nothing else.
    const side = config.PRESET_PORTS[plan.req.preset] !== undefined ? plan.req.preset : '';
    const sideText = side ? `${side}:${String(config.PRESET_PORTS[side]?.[0] ?? '')}` : '';
    // WHAT THE PANEL DOES NOT ALREADY SAY, and nothing else. The Rocket.Chat admin is
    // generated for a workspace bound this wide and printed two lines below, so repeating
    // it here is a sentence people learn to scroll past.
    const weak: string[] = [];
    if (sideText) weak.push(`the ${plan.req.preset} UI on ${sideText}`);
    if (plan.req.monitor) weak.push('Grafana on admin/admin');
    if (plan.req.seed) weak.push('seeded users, whose password is their username');
    warn(
      plan.emit,
      `--bind ${plan.bindHost} publishes this workspace on every interface` +
        (weak.length > 0 ? ` — and ${weak.join(', ')}` : '') +
        '. Only do this on a trusted network.',
      { phase: 'create' },
    );
  }
  // RC advertises the https URL (links, OAuth callbacks, CORS all derive from ROOT_URL);
  // `root` stays http so houston's own API calls need no CA.
}

/** An IdP preset whose own service still names the BROWSER's machine, not this one. */
export function warnAboutTheBrowserHost(plan: CreatePlan): void {
  plan.public = plan.tlsspec === null ? '' : tlsRootUrl(plan.tlsspec);
  // SAID AT CREATE TIME, because it cannot be discovered afterwards. The IdP presets send
  // the BROWSER to a hostname baked into Rocket.Chat's settings, and the default names
  // this machine -- `localhost:8081` for SAML, `keycloak:8085` for OIDC. From anywhere
  // else both of those addresses are the visitor's own laptop: the SAML button bounces
  // off nothing and returns to the login page, and the OIDC popup opens a name that does
  // not resolve and renders blank.
  const browserParam = BROWSER_HOST_PARAM[plan.req.preset];
  if (browserParam === undefined) return;
  if (isTruthy(plan.req.params[browserParam])) return;
  const defaultHost: Record<string, string> = {
    saml: 'localhost',
    oidc: 'keycloak',
    s3_minio: 'minio',
  };
  const servicePort = config.PRESET_PORTS[plan.req.preset]?.[0] ?? 0;
  const advertised = plan.req.rootUrl || plan.req.domain;
  let why = '';
  if (!LOOPBACK_BINDS.includes(plan.bindHost)) {
    why =
      `this '${plan.req.preset}' workspace is bound to ${plan.bindHost}, so ` +
      'somebody will open it from another machine';
  } else if (advertised) {
    // DELIBERATELY NOT DERIVED. Pointing the service at {advertised} while its port is on
    // loopback would break Rocket.Chat's own access to it as well -- measured: a container
    // cannot reach a 127.0.0.1-published port by the host's address.
    why =
      `this '${plan.req.preset}' workspace advertises ${advertised}, but its ` +
      `ports are published on ${plan.bindHost || config.DEFAULT_BIND_HOST} ` +
      'where nothing off this box can reach them';
  }
  if (why) {
    warn(
      plan.emit,
      `${why} — and its own service still points the browser at ` +
        `${defaultHost[plan.req.preset] ?? ''}:${String(servicePort)}, which names that browser's OWN ` +
        'machine. SAML returns to the login page, OIDC opens a blank ' +
        'window, presigned previews fail. None of them logs an error.',
      { phase: 'create' },
    );
    warn(
      plan.emit,
      '    Both halves have to move. Re-create with:\n' +
        `      --bind 0.0.0.0 --port ${String(plan.hostPort)} ` +
        `--root-url http://<host>:${String(plan.hostPort)} ` +
        `--set ${browserParam}=<host>\n` +
        '    where <host> is the name people actually type.',
      { phase: 'create' },
    );
  }
}

/** Carried-forward env, the admin password, and the compose document itself. */
export async function buildDocument(plan: CreatePlan): Promise<void> {
  // Overrides already on this repro are carried forward: `up --force` rebuilds the compose
  // file from the spec, so without this a rebuild would silently drop env the user had
  // set. Anything named on THIS run wins.
  plan.envOverrides = {};
  if (await paths.exists(plan.reproName)) {
    try {
      const prev = bag((await record.readMeta(plan.reproName)).extra.env);
      plan.envOverrides = { ...(prev as Record<string, string | null>) };
    } catch {
      // half-written record; nothing to carry
    }
  }
  Object.assign(plan.envOverrides, plan.req.env);

  // THE ADMIN PASSWORD, decided here because this is where both halves of "reachable from
  // off this box" are finally known. Generated for a public workspace and left empty --
  // meaning the shared `admin123` -- for a loopback one.
  plan.adminPassword = preconditions.reachableBeyondLoopback({
    tlsspec: plan.tlsspec,
    bindHost: plan.bindHost,
  })
    ? config.generateAdminPassword()
    : '';
  const resolved = plan.resolved as Resolved;
  plan.spec = compose.spec({
    projectName: await record.projectName(plan.reproName),
    rcImage: resolved.rcImage,
    rcTag: resolved.rcVersion,
    mongoTag: resolved.mongoTag,
    mongoFlavor: resolved.mongoFlavor,
    mongoShell: resolved.mongoShell,
    oplog: resolved.oplog,
    rootUrl: plan.req.rootUrl || plan.public || plan.root,
    publicUrl: plan.public,
    hostPort: plan.hostPort,
    regToken: plan.token || null,
    preset: plan.pre as Preset,
    bindHost: plan.bindHost,
    monitoring: plan.req.monitor,
    envOverrides: plan.envOverrides,
  });
  plan.spec.adminPassword = plan.adminPassword;
  try {
    plan.doc = compose.build(plan.spec);
  } catch (error) {
    // e.g. a preset naming an entry_service it doesn't define.
    throw new ValidationError(error instanceof Error ? error.message : String(error));
  }
}

/** `repro.json`: everything a later command needs that the compose file does not say. */
export function buildRecord(plan: CreatePlan): void {
  const resolved = plan.resolved as Resolved;
  const pre = plan.pre as Preset;
  const spec = plan.spec as compose.Spec;
  plan.meta = record.metadata({
    name: plan.reproName,
    project: spec.projectName,
    rcVersion: resolved.rcVersion,
    rcImage: resolved.rcImage,
    mongoTag: resolved.mongoTag,
    mongoFlavor: resolved.mongoFlavor,
    preset: pre.name,
    rootUrl: plan.root,
    hostPort: plan.hostPort,
    versionSource: resolved.source,
    pinned: plan.req.pin,
    publicUrl: plan.public,
    adminPassword: plan.adminPassword,
    createdAt: new Date().toISOString().slice(0, 19) + '+00:00',
  });
  // Stamped on every create, compose included, so "absent" keeps meaning exactly one
  // thing: a workspace older than the key.
  topology.stamp(plan.meta.extra, plan.req.runtime || topology.DOCKER);
  plan.meta.extra[config.EXTRA_DEPLOYMENT] = plan.req.deployment || topology.MONOLITH;
  // Recorded so a reader can be told the truth about reaching this workspace from another
  // machine. It was only ever written INTO the compose port mappings.
  plan.meta.extra.bind_host = plan.bindHost;
  // WHAT ROCKET.CHAT ADVERTISES, when that is not what houston calls it. `rootUrl` on the
  // record is deliberately the plain loopback URL that houston's own API calls use, and
  // `publicUrl` is set only by TLS -- so `--root-url http://box:3007` was written into the
  // compose ROOT_URL and recorded nowhere, and anything generated FOR THE BROWSER then got
  // loopback.
  if (spec.rootUrl && spec.rootUrl !== plan.root) {
    plan.meta.extra.advertised_url = spec.rootUrl;
  }
  if (pre.postReady.length > 0) plan.meta.extra.post_ready = pre.postReady;
  if (pre.notes.length > 0) plan.meta.extra.notes = pre.notes;
  if (pre.instances > 1) plan.meta.extra.instances = pre.instances;
  if (Object.keys(pre.extra).length > 0) Object.assign(plan.meta.extra, pre.extra);
  if (pre.ports.length > 0) plan.meta.extra.sidecar_ports = pre.ports;
  if (Object.keys(plan.envOverrides).length > 0) plan.meta.extra.env = plan.envOverrides;
  if (plan.req.actor) {
    // Who owns this. Shown by `list` and the GUI card.
    plan.meta.extra.created_by = plan.req.actor;
  }
  if (Object.keys(plan.req.params).length > 0) {
    // Recorded so a repro can be rebuilt exactly: `backup` copies these into its manifest,
    // and `restore --new` would otherwise recreate an s3_minio repro with the DEFAULT
    // bucket rather than the one whose data it is loading.
    plan.meta.extra.params = { ...plan.req.params };
  }
}

/** Prometheus and Grafana, when asked for. */
export function attachMonitoring(plan: CreatePlan): void {
  if (!plan.req.monitor) return;
  const meta = plan.meta as record.Metadata;
  const targets = compose.rcServiceNames((plan.pre as Preset).instances);
  plan.files.push(...monitoringFiles(targets, (plan.spec as compose.Spec).projectName));
  meta.extra.monitoring = true;
  meta.extra.monitoring_ports = [...config.MONITOR_PORTS];
  const notes = Array.isArray(meta.extra.notes) ? [...meta.extra.notes] : [];
  meta.extra.notes = [
    ...notes,
    ...monitoringNotes(monitoringGrafanaUrl(plan.public, !!plan.public)),
  ];
}

/** Taking down what is already there, and the gate on destroying its data. */
export async function replaceExisting(plan: CreatePlan): Promise<void> {
  if (!(await paths.exists(plan.reproName))) return;
  // `--fresh` DELETES THE DATA VOLUME, which is the same irreversible act `down --volumes`
  // is gated on -- and this branch consulted nobody. Checked only for `--fresh`: a plain
  // overwrite recreates containers and leaves the volume alone.
  if (plan.req.fresh) {
    const [allowed, why] = await ownership.mayDestroy(plan.reproName, auditActor());
    if (!allowed) {
      auditRecord('up-fresh', plan.reproName, { outcome: 'denied' });
      throw new ConflictError(why);
    }
  }
  // Volumes the OLD compose file declared but the new one doesn't (switching preset with
  // --force, dropping --monitor) would be orphaned: `down -v` only removes what the file
  // declares, so once it's rewritten nothing can ever reach them again.
  let stale: string[] = [];
  if (!plan.req.fresh) {
    try {
      const oldDoc = await record.readCompose(plan.reproName);
      const oldVolumes = new Set(Object.keys(bag(oldDoc.volumes)));
      const newVolumes = new Set(Object.keys((plan.doc as compose.ComposeDoc).volumes));
      stale = [...oldVolumes].filter((name) => !newVolumes.has(name));
    } catch {
      // unreadable old file: nothing to reconcile
      stale = [];
    }
  }
  if ((await engine.down(plan.reproName, { volumes: plan.req.fresh })) !== 0) {
    throw new DockerError(
      `could not tear down the existing '${plan.reproName}'; not overwriting it`,
    );
  }
  for (const bad of await removeVolumes(plan.reproName, stale.sort())) {
    warn(plan.emit, `could not remove ${bad}, left over from the previous preset`, {
      phase: 'create',
    });
  }
}

/** Write the record, then the compose file, then bring it up, then attach the edge. */
export async function startTheWorkspace(plan: CreatePlan): Promise<void> {
  const meta = plan.meta as record.Metadata;
  const resolved = plan.resolved as Resolved;
  await record.write(
    plan.reproName,
    compose.toYaml(plan.doc as compose.ComposeDoc),
    meta,
    plan.files,
  );
  if (plan.req.pin) {
    await updateLockedConfig((cfg) => {
      cfg.default_repro = plan.reproName;
    });
  }

  info(
    plan.emit,
    `creating '${plan.reproName}' - RC ${resolved.rcVersion}, ` +
      `Mongo ${resolved.mongoTag} (${resolved.mongoFlavor}), preset ${(plan.pre as Preset).name}`,
    // Nested, as it always has been: the event's detail is ONE key named `data`, so it is
    // `{"data": {"name": ...}}` on the NDJSON stream and in houston.log. `jsonout` calls
    // removing a key breaking, so the wire keeps the established shape.
    { phase: 'create', data: { data: { name: plan.reproName } } },
  );

  const rc = await upCompose(plan.reproName, {
    pull: !plan.req.noPull,
    emit: plan.emit,
    streamOutput: plan.streamOutput,
  });
  if (rc !== 0) {
    const cause = await diagnoseFailure(plan.reproName);
    const head = cause ? `\`docker compose up\` failed - ${cause}` : '`docker compose up` failed.';
    throw new DockerError(
      `${head} Workspace kept for inspection - retry with --force, or discard: ` +
        `houston down --name ${plan.reproName} --volumes`,
    );
  }

  // AFTER the workspace is up, because attaching needs the network `docker compose up` has
  // only just created. Registering during the build wrote a correct route to a backend the
  // edge could not resolve, so the name answered 502 -- and 502 is not an error anyone
  // sees, it just looks like a broken workspace. Idempotent: register() attaches too.
  if (plan.tlsspec !== null) {
    await attach(plan.reproName);
  }
}

/** The summary the caller gets back, plus waiting and seeding when asked. */
export async function finish(plan: CreatePlan): Promise<Bag> {
  const meta = plan.meta as record.Metadata;
  const result = inspect.summary(meta);
  result.reused = false;
  result.waited = plan.wait;
  if (plan.wait) Object.assign(result, await waitAndFinalize(meta, plan.emit));
  // NOT when the caller seeds, for the reason `reuse` records.
  if (plan.req.seed && !plan.req.seedHere) {
    result.seed = await seeding.runSeedInline(
      meta,
      plan.req.seedProfile,
      plan.req.stats,
      plan.emit,
    );
  }
  return result;
}

/** An edge belonging to another HOUSTON_HOME, refused before anything is written. */
export async function refuseAForeignEdge(): Promise<void> {
  // REFUSED BEFORE ANYTHING IS WRITTEN. `edge.up()` checks `foreignEdge()` -- an edge
  // belonging to a DIFFERENT HOUSTON_HOME, which compose would silently replace because
  // every home keys the project by the same name -- and it did so only after the local CA,
  // the certificate, the route file and the whole edge project had been written.
  const stolen = await foreignEdge();
  if (stolen) {
    throw new ConflictError(
      'the shared edge on this box belongs to another HOUSTON_HOME ' +
        `(${stolen}). Starting one from here would REPLACE it and take down ` +
        'every https name it serves, because compose keys the project by name ' +
        'and both homes use the same one. Use that home, or stop its edge ' +
        'first.',
    );
  }
}

/** A local certificate, or the private directory Traefik needs before it mounts it. */
export async function issueCertificate(plan: CreatePlan, local: boolean): Promise<void> {
  const tlsspec = plan.tlsspec;
  if (tlsspec === null) return;
  if (local) {
    info(plan.emit, `issuing a local certificate for ${tlsspec.host}`, { phase: 'tls' });
    await issueLocalCert(tlsspec.host);
  } else {
    // Traefik writes acme.json here; it must exist and be private BEFORE the container
    // mounts it, or Traefik refuses to use it.
    await fs.mkdir(acmeDir(), { recursive: true });
    await fs.chmod(acmeDir(), 0o700);
  }
}

/** Started lazily, by the first workspace that needs a name -- never at install or by `serve`. */
export async function startTheEdge(plan: CreatePlan, local: boolean): Promise<void> {
  const tlsspec = plan.tlsspec;
  if (tlsspec === null) return;
  // Started HERE, not in resolveTls. Lazily, by the first workspace that needs a name --
  // not at install, not by `serve`, since whether the GUI has a public hostname is an
  // unrelated question. It has to happen where docker work legitimately happens, though:
  // putting it in resolveTls made a resolve function start containers, and the TEST SUITE
  // then started a real edge that held :443 and broke a live run.
  if (!(await edgeRunning()) || (!local && !hasAcme())) {
    info(plan.emit, 'starting the edge (one Traefik, :80 and :443 for every name)', {
      phase: 'tls',
    });
    const started = await ensureRunning({
      acmeEmail: local ? '' : tlsspec.acmeEmail,
      acmeStaging: tlsspec.acmeStaging,
    });
    if (!started.ok) {
      const holder = await portHolder(443);
      const because = holder
        ? ` — ${holder} is holding :443`
        : started.why
          ? ` — ${started.why}`
          : '';
      warn(
        plan.emit,
        `the edge did not start${because}, so ${tlsspec.host} will ` +
          'not answer yet. The workspace itself is unaffected; free ' +
          'the port and `houston edge start`.',
        { phase: 'tls' },
      );
    }
  }
}

/** The route, and the certificate request it may or may not imply. */
export async function registerTheName(plan: CreatePlan, local: boolean): Promise<void> {
  const tlsspec = plan.tlsspec;
  if (tlsspec === null) return;
  const needsCert = await registerRoute(plan.reproName, tlsspec.host, {
    instances: (plan.pre as Preset).instances || 1,
    local,
    grafana: plan.req.monitor,
  });
  if (local) {
    // nothing further: the certificate was issued above
  } else if (needsCert) {
    // No reachability checks. Whether the domain resolves here, and how traffic gets to
    // this host, is the operator's business -- houston cannot see a tunnel, a
    // port-forward or a firewall from in here.
    info(
      plan.emit,
      `requesting a certificate from Let's Encrypt ` +
        `(${tlsspec.acmeStaging ? 'staging' : 'production'}) ` +
        `for ${tlsspec.host} — the edge does this in the background; ` +
        `confirm with \`houston tls-status -n ${plan.reproName}\``,
      { phase: 'tls' },
    );
    // Counted BEFORE the warning, so the name being created is included -- the useful
    // number is "after this one", not "before it".
    recordIssuance(tlsspec.host);
    const budget = budgetWarning(tlsspec.host);
    if (budget) warn(plan.emit, budget, { phase: 'tls' });
  } else {
    info(
      plan.emit,
      `registering ${tlsspec.host} — covered by the wildcard, no certificate request`,
      {
        phase: 'tls',
      },
    );
  }
}

/** What the record has to say so `tls-status` and the panel can tell the truth. */
export function recordTls(plan: CreatePlan, local: boolean): void {
  const tlsspec = plan.tlsspec;
  const meta = plan.meta;
  if (tlsspec === null || meta === null) return;
  meta.extra.tls = tlsspec.mode;
  meta.extra.edge = true;
  // Deliberately NO tls_ports: usedPorts() feeds port allocation, and claiming a port this
  // workspace does not publish would make every later workspace route around one it never
  // held.
  if (!local) {
    meta.extra.tls_staging = tlsspec.acmeStaging;
    meta.extra.tls_email = tlsspec.acmeEmail;
  }
  const notes = Array.isArray(meta.extra.notes) ? [...meta.extra.notes] : [];
  meta.extra.notes = [
    ...notes,
    `served by the edge at https://${tlsspec.host}`,
    'the edge holds :443 for the whole box; this workspace publishes none',
  ];
}

/** The shared Traefik edge: refuse a foreign one, get a certificate, route the name. */
export async function prepareEdge(plan: CreatePlan): Promise<void> {
  plan.files = [...(plan.pre as Preset).files];
  if (plan.tlsspec === null) return;
  // ONE path, whether the name is a real domain or a .houston.localhost one. The only
  // difference is where the certificate comes from, and that is the edge's business -- so
  // no tls/ files are written here, no port is claimed, and nothing about this workspace's
  // containers depends on it.
  const local = plan.tlsspec.mode === MODE_LOCAL;
  await refuseAForeignEdge();
  await issueCertificate(plan, local);
  await startTheEdge(plan, local);
  await registerTheName(plan, local);
  recordTls(plan, local);
}

/**
 * The Compose create, as a plan and the steps that fill it in.
 *
 * The ORDER below is the specification. Each step's own docstring and comments say why it
 * sits where it does; several of them record a defect caused by sitting somewhere else.
 */
export async function createReproLocked(
  req: CreateReq,
  emit: Emit = nullEmit,
  {
    streamOutput = false,
    monitorAttach = request.missingMonitorAttach,
    versionFetcher,
  }: {
    streamOutput?: boolean;
    monitorAttach?: createK8s.MonitorAttach;
    versionFetcher?: ReleaseFetcher;
  } = {},
): Promise<Bag> {
  const plan = createPlan({
    req,
    emit,
    streamOutput,
    monitorAttach,
    ...(versionFetcher === undefined ? {} : { versionFetcher }),
  });
  await resolveAxesStep(plan);

  if (req.runtime === topology.KUBERNETES) {
    // A PARALLEL path, not a branch woven through this function. Everything below is
    // compose-shaped -- host ports, a compose document, `docker compose up` -- and two
    // front-ends depend on it behaving exactly as it does. Handing Kubernetes off here
    // keeps the Docker default byte-identical and puts the Kubernetes sequence in the
    // module that owns it.
    //
    // TLS is refused rather than ignored. `resolveTls` runs BELOW this line, so `--https`
    // on a Kubernetes workspace did nothing at all and said nothing about it.
    preconditions.refuseUnsupportedOnKubernetes(req);
    return await createKubernetes(req, emit, {
      monitorAttach,
      ...(versionFetcher === undefined ? {} : { versionFetcher }),
    });
  }
  await resolvePairing(plan);
  loadPreset(plan);
  await settleName(plan);

  if ((await paths.exists(plan.reproName)) && !plan.req.force && !plan.req.fresh) {
    return await reuse(plan.reproName, plan.wait, plan.req, plan.emit, {
      streamOutput: plan.streamOutput,
      resolved: plan.resolved,
      presetName: (plan.pre as Preset).name,
    });
  }
  await claimPorts(plan);
  warnAboutTheBind(plan);
  warnAboutTheBrowserHost(plan);
  await buildDocument(plan);
  buildRecord(plan);
  await prepareEdge(plan);
  attachMonitoring(plan);
  await replaceExisting(plan);
  await startTheWorkspace(plan);
  return await finish(plan);
}
