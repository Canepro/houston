/**
 * Creating a workspace on Kubernetes.
 *
 * Tier 5. The Kubernetes half of create, split from the Compose half because the two share a
 * request and almost nothing else: this one talks to a cluster that may not exist yet, has no
 * compose file to write, and publishes a name through an ingress rather than a port.
 *
 * Like the Compose half, this is a PLAN plus named steps rather than one function. The
 * order carries decisions that each cost a real defect to learn -- the write-ahead record
 * before any cluster resource exists, the cluster chosen before a byte is written, the
 * core tools checked before a kind cluster is built. The order is visible at the bottom.
 */
import * as fs from 'node:fs/promises';

import * as config from '../../lib/config';
import { joinPath } from '../../lib/home';
import { toText } from '../../lib/format';
import { PreflightError, ReproError, ValidationError, errorText } from '../../lib/errors';
import { type Emit, info, nullEmit, warn } from '../../lib/events';
import * as presets from '../../lib/presets/index';
import { type Preset } from '../../lib/presets/types';
import {
  type ReleaseFetcher,
  type Resolved,
  applyMongoOverride,
  resolve,
} from '../../lib/versions';
import { endpointString } from '../kube/endpoints';
import { installed as edgeInstalled } from '../edge/spec';
import { assertNamespaceAvailable, namespaceFor } from '../kube/namespace';
import { type ClusterPlan, planCluster } from '../kube/context';
import { ensureKubeconfig } from '../kube/cluster';
import { helmReachable } from '../kube/reachability';
import { missingTools } from '../kube/tools';
import type { Preflight } from '../kube/tools';
import { preflight } from '../kube/probe';
import { createWorkspace } from '../kube/workspace';
import {
  adminPass,
  metadata,
  readMeta,
  serialise,
  toDocument,
  type Metadata,
  writeRecord,
} from '../runner/record';
import { atomicWrite, exists, workspace } from '../runner/paths';
import * as topology from '../topology';
import { MODE_ACME } from '../tls';

import * as naming from './naming';
import * as notes from './notes';
import * as ports from './ports';
import * as preconditions from './preconditions';
import { waitAndFinalize, waitServing } from './ready';
import * as request from './request';
import * as seeding from './seeding';
import * as sizing from './sizing';
import { type KubeTls, type CreateReq, BILLABLE_DISTRIBUTIONS } from './types';
import * as tlsplan from './tlsplan';
import { type TlsSpec } from '../tls';

type Bag = Record<string, unknown>;
export type MonitorAttach = (name: string, emit: Emit) => Bag | Promise<Bag>;

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
 * What one Kubernetes create knows, in the order it comes to know it.
 *
 * `plan` is the CLUSTER plan `planCluster` returns -- which cluster, what distribution,
 * what it costs -- and is why the parameter these steps take is `job` rather than `plan`:
 * the two would otherwise be the same word for different things in every line.
 */
export interface KubeCreate {
  req: CreateReq;
  emit: Emit;
  monitorAttach: MonitorAttach;
  versionFetcher?: ReleaseFetcher;
  reproName: string;
  reused: boolean;
  resolved: Resolved | null;
  recorded: number;
  hostPort: number;
  cfg: config.Config;
  regToken: string;
  bindHost: string;
  root: string;
  microservices: boolean;
  presetForNotes: Preset | null;
  pre: Preflight | null;
  plan: ClusterPlan | null;
  tlsspec: TlsSpec | null;
  ktls: KubeTls | null;
  adminPassword: string;
  provisional: Metadata | null;
  out: Bag;
  meta: Metadata | null;
  groups: notes.NoteGroup[] | null;
  result: Bag;
}

export function kubeCreate(
  values: Partial<KubeCreate> & Pick<KubeCreate, 'req' | 'emit' | 'monitorAttach'>,
): KubeCreate {
  return {
    reproName: '',
    reused: false,
    resolved: null,
    recorded: 0,
    hostPort: 0,
    cfg: {},
    regToken: '',
    bindHost: '',
    root: '',
    microservices: false,
    presetForNotes: null,
    pre: null,
    plan: null,
    tlsspec: null,
    ktls: null,
    adminPassword: '',
    provisional: null,
    out: {},
    meta: null,
    groups: null,
    result: {},
    ...values,
  };
}

/** The name, whether this is a re-create, and the capacity refusal. */
export async function settleName(job: KubeCreate): Promise<void> {
  job.reproName = naming.deriveFor(job.req);
  naming.warnNameCoerced(job.req, job.emit);
  naming.requireValidName(job.reproName);
  // NO refusal for an existing workspace. `down` tells the user "bring it back: houston up
  // ...", and this raised "already exists, down first or --force" at them -- two messages
  // in the same tool contradicting each other about the same workspace. The namespace and
  // its PVC survived a plain `down`, which is exactly what makes bringing it back
  // meaningful.
  job.reused = await exists(job.reproName);
  if (job.reused) {
    info(job.emit, `'${job.reproName}' already exists — bringing it back up`, { phase: 'plan' });
  }
  await sizing.checkCapacity(job.req, job.req.preset, job.emit);
}

/**
 * Rocket.Chat, its MongoDB and the host port -- announced before the slow part starts.
 *
 * SAID BEFORE IT IS DONE, not after. The live lookup and the cluster probing below are a
 * dozen kubectl round trips; together they were a minute or more of complete silence
 * after the opening line.
 */
export async function resolvePairing(job: KubeCreate): Promise<void> {
  info(job.emit, `resolving Rocket.Chat ${job.req.version} and its MongoDB pairing`, {
    phase: 'plan',
  });
  // Looked up HERE, after the announcement, where the release lookup has always gone
  // online -- no longer by the front door ahead of every refusal, and no longer skipped by
  // the ones that had no door to do it.
  const fetcher = await request.releaseFetcher(
    job.req.version,
    job.req.offline,
    job.versionFetcher,
  );
  try {
    job.resolved = resolve(job.req.version, {
      offline: job.req.offline,
      ...(fetcher === undefined ? {} : { fetcher }),
    });
  } catch (error) {
    throw new ValidationError(errorText(error));
  }
  // SAID BEFORE THE BUILD, not discovered after it. `resolve()` already knows when
  // releases.rocket.chat answered 404 -- it stamps `source` and the create path ignored
  // it, so `up --version 99.99.99` built the whole document and failed at the pull ~90
  // seconds later, leaving a workspace to clean up.
  if (job.resolved.source === 'map (no such release)') {
    warn(
      job.emit,
      `releases.rocket.chat has no ${job.req.version} — the pairing below ` +
        'comes from the shipped map, and the image pull will fail unless ' +
        `this tag really exists (\`houston versions ${job.req.version}\`).`,
      { phase: 'resolve' },
    );
  }
  if (job.req.rcImage) job.resolved.rcImage = job.req.rcImage;
  if (job.req.mongo) applyMongoOverride(job.resolved, job.req.mongo);

  // A workspace that comes back must come back at the SAME address. Allocating afresh
  // moved it from :3382 to :3000 on the `up` after a `down` -- so every bookmark, every
  // curl in a ticket and the URL the user had just been shown all pointed at nothing.
  job.recorded = 0;
  if (job.reused) {
    try {
      job.recorded = Number((await readMeta(job.reproName)).hostPort) || 0;
    } catch {
      job.recorded = 0;
    }
  }
  job.hostPort =
    job.req.port ||
    job.recorded ||
    (await ports.pickHostPort(0, presets.load('default', {}), job.reproName));
}

/** How this workspace is reached and what shape it is, in Compose's own order. */
export function settleAddressing(job: KubeCreate): void {
  // Same resolution order Compose uses: the flag, then the box-level config, then
  // loopback. This was dropped entirely on the Kubernetes path.
  job.cfg = config.loadConfig();
  job.regToken = job.req.regToken || toText(job.cfg.reg_token);
  if (job.req.bind) job.bindHost = String(job.req.bind);
  else if (isTruthy(job.cfg.bind_host)) job.bindHost = String(job.cfg.bind_host);
  else job.bindHost = config.DEFAULT_BIND_HOST;
  job.root = `http://localhost:${String(job.hostPort)}`;
  job.microservices = job.req.deployment === topology.MICROSERVICES;
  // Resolved ONCE: the same object builds the workspace and supplies its notes, so what
  // was applied and what is printed cannot disagree.
  job.presetForNotes = presets.resolve(
    job.req.preset || 'default',
    topology.KUBERNETES,
    job.req.params,
  );
}

/**
 * Which cluster, what it would cost, and whether this box has the tools to talk to it.
 *
 * THE CLUSTER IS CHOSEN FIRST, before a single byte is written. `planCluster` only probes,
 * and it is what refuses when there is no cluster and no `kind` -- so that refusal now
 * costs nothing, where before it left an `incomplete` record that `list` showed as a
 * workspace and whose port `usedPorts()` went on reserving.
 *
 * THE CORE TOOLS FIRST, before anything is provisioned: with `kubectl` absent, `up` built
 * an entire kind cluster, THEN failed, and blamed the API server.
 */
export async function planClusterStep(job: KubeCreate): Promise<void> {
  job.pre = await preflight();
  const missing = missingTools(job.pre);
  if (missing.length > 0) {
    throw new PreflightError(
      `${missing.join(', ')} is not installed, and a Kubernetes ` +
        'workspace cannot be created or used without it. Install it and try ' +
        'again — `houston doctor` lists what this runtime needs.',
    );
  }
  job.plan = await planCluster(request.reqContext(job.req));
  // A BILLABLE CLUSTER AND NO PUBLIC NAME. Warned, not refused, and the distinction
  // matters: a refusal would remove the one way to reach a workspace whose ingress is
  // broken, which is exactly when somebody needs it.
  if (BILLABLE_DISTRIBUTIONS.includes(job.plan.distribution) && !(job.req.domain || '').trim()) {
    warn(
      job.emit,
      `'${job.plan.context}' is a ${job.plan.distribution} cluster, and without --domain ` +
        'this workspace is reachable only by a port-forward from this machine — ' +
        'tied to a pod, gone when it restarts, and one person at a time. ' +
        '`--domain <name>` gives it a publicly-trusted address instead.',
      { phase: 'preflight' },
    );
  }
}

/** The HTTPS name, and which of the two mechanisms will serve it. */
export async function planTls(job: KubeCreate): Promise<void> {
  job.tlsspec = await tlsplan.resolveTls(
    job.req,
    job.reproName,
    job.bindHost,
    job.reproName,
    job.emit,
  );
  job.ktls = null;
  if (job.plan !== null && !job.plan.create) {
    // THE PREFLIGHT NEEDS A KUBECONFIG THAT KNOWS THIS CONTEXT, and on a fresh
    // HOUSTON_HOME it does not have one: the cluster exists, so nothing was created, so
    // nothing exported the context this is about to ask through. Idempotent, and a no-op
    // for a cluster houston did not make.
    await ensureKubeconfig(job.plan, job.emit);
    // HELM'S OWN ANSWER, and this is the cheapest refusal on the path. houston drives
    // kubectl AND helm, they resolve their configuration differently, and only kubectl was
    // ever asked. Measured: kubectl completely happy while helm refused every call with
    // `x509: certificate signed by unknown authority`, so the create built a namespace, a
    // StatefulSet, a PersistentVolume and an initiated replica set, spent four minutes,
    // then died at the chart and rolled all of it back.
    const helmWhy = await helmReachable(job.plan.context);
    if (helmWhy) {
      throw new ValidationError(
        `helm cannot reach cluster '${job.plan.context}', although kubectl can. ` +
          'The chart install would fail after MongoDB and roll the whole ' +
          `workspace back. helm said: ${helmWhy} — a kubeconfig left over ` +
          'from a previous install of the same cluster does this. Regenerate ' +
          'it (k3s: `sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/config`; ' +
          'kind: `kind export kubeconfig --name <cluster>`) and run this ' +
          'again. `houston doctor` reports the same thing.',
      );
    }
    await assertNamespaceAvailable(job.reproName, {
      context: job.plan.context,
      owner: job.req.actor,
    });
  }
}

/** What the in-cluster ingress needs, when the edge is not the thing serving the name. */
export async function planKubeTls(job: KubeCreate): Promise<void> {
  if (job.tlsspec !== null) {
    // Named before the probing starts. `kubernetesTlsPlan` asks the cluster about its
    // ingress classes, its cert-manager CRD and its ingress endpoint before it emits
    // anything, which on a managed cluster is several seconds of nothing at the exact
    // moment the reader is waiting to learn where HTTPS is coming from.
    info(
      job.emit,
      `checking ${job.plan?.context ?? ''} for the ingress and cert-manager HTTPS ` + 'needs',
      { phase: 'tls' },
    );
    // AFTER `ensureKubeconfig`, because every probe in it needs a kubeconfig that knows
    // the context, and BEFORE the write-ahead record, because a refusal must leave
    // nothing.
    job.ktls = await tlsplan.kubernetesTlsPlan(job.req, job.tlsspec, job.plan as ClusterPlan, {
      emit: job.emit,
    });
  }
}

/** A record BEFORE any cluster resource exists, so a killed create leaves something. */
export async function writeProvisionalRecord(job: KubeCreate): Promise<void> {
  // A WRITE-AHEAD RECORD, before a single cluster resource exists. `createWorkspace`
  // below builds the namespace, MongoDB, the chart release, the scenario's manifests and
  // the port-forward -- minutes of work -- and only after it returned was anything written
  // down. Kill the process in that window and the workspace is left fully running with NO
  // record: invisible to `list`, `info` and `down`. Two such orphans were found holding
  // several GB between them.
  job.adminPassword = preconditions.reachableBeyondLoopback({
    tlsspec: job.tlsspec,
    bindHost: job.bindHost,
  })
    ? config.generateAdminPassword()
    : '';
  const resolved = job.resolved as Resolved;
  const plan = job.plan as ClusterPlan;
  job.provisional = metadata({
    name: job.reproName,
    project: await namespaceFor(job.reproName),
    rcVersion: resolved.rcVersion,
    rcImage: resolved.rcImage,
    mongoTag: resolved.mongoTag,
    mongoFlavor: resolved.mongoFlavor,
    preset: job.req.preset,
    rootUrl: job.root,
    hostPort: job.hostPort,
    versionSource: resolved.source,
    pinned: job.req.pin,
    adminPassword: job.adminPassword,
    createdAt: new Date().toISOString().slice(0, 19) + '+00:00',
  });
  topology.stamp(job.provisional.extra, topology.KUBERNETES);
  job.provisional.extra[config.EXTRA_DEPLOYMENT] = job.req.deployment || topology.MICROSERVICES;
  job.provisional.extra.namespace = await namespaceFor(job.reproName);
  // The chosen context, not a guess at it. This was `CONTEXT` unconditionally, which was
  // right only while houston's own cluster was the only one it could use.
  job.provisional.extra[config.EXTRA_CONTEXT] = plan.context;
  job.provisional.extra.distribution = plan.distribution;
  job.provisional.extra.incomplete = true;
  if (job.req.actor) job.provisional.extra.created_by = job.req.actor;
  // Through the runner seam, so the workspace directory is restricted to 0700 the way
  // every Compose one is. This runtime is the one that also writes `kubernetes/values.yaml`
  // with ADMIN_PASS in it.
  await writeRecord(job.reproName, job.provisional);

  // BEFORE the create, so an ACME challenge has somewhere to land the moment the chart's
  // Ingress appears.
  if (job.ktls !== null) {
    await tlsplan.routeKubernetesName(job.reproName, job.ktls, { emit: job.emit });
  }
}

/** The namespace, MongoDB, the chart release and the port-forward -- the long part. */
export async function createTheWorkspace(job: KubeCreate): Promise<void> {
  let previousPid = 0;
  let previousPort: number | null = null;
  if (job.reused) {
    try {
      const old = await readMeta(job.reproName);
      previousPid = Number(bag(old.extra).port_forward_pid ?? 0) || 0;
      previousPort = Number(old.hostPort) || null;
    } catch {
      // no record, no forward to retire
      previousPid = 0;
      previousPort = null;
    }
  }
  const resolved = job.resolved as Resolved;
  job.out = await createWorkspace({
    name: job.reproName,
    resolved,
    hostPort: job.hostPort,
    microservices: job.microservices,
    replicas: job.req.replicas || 1,
    owner: job.req.actor,
    bindHost: job.bindHost,
    adminPassword: job.adminPassword,
    previousPid,
    previousPort,
    // PASSED AT LAST. `createWorkspace` has taken `rootUrl` since it was written and this
    // call never supplied it, so `valuesFor` never set anything and the chart emitted no
    // ROOT_URL -- Rocket.Chat ran on its own default while every human reached it here.
    rootUrl: job.root,
    // With a name, the chart's own Ingress template builds the Ingress -- houston
    // hand-writes none.
    tlsHost: job.ktls?.host ?? '',
    ingressClass: job.ktls?.ingressClass ?? '',
    issuer: job.ktls?.issuer ?? null,
    useOperator: job.req.mongoOperator,
    // Through a Secret referenced by `valueFrom`, never as a values literal: `helm get
    // values` is readable by anyone who can reach the release.
    regToken: job.regToken,
    // Resolved through the KUBERNETES adapter, so a scenario yields native manifests here
    // and a compose service on the other runtime -- one intent, two renderings.
    preset: job.presetForNotes,
    plan: job.plan,
    emit: job.emit,
  });
}

/** `repro.json` as it stands once the cluster has answered. */
export async function buildRecord(job: KubeCreate): Promise<void> {
  const resolved = job.resolved as Resolved;
  const plan = job.plan as ClusterPlan;
  job.meta = metadata({
    name: job.reproName,
    project: String(job.out.namespace ?? ''),
    rcVersion: resolved.rcVersion,
    rcImage: resolved.rcImage,
    mongoTag: resolved.mongoTag,
    // NOT `resolved.mongoFlavor`. That is a COMPOSE concept -- "official" vs
    // "bitnami-legacy" -- and this runtime honours neither: `createWorkspace` records
    // `mongo_managed_by` and `mongo_image` for exactly this reason.
    mongoFlavor: '',
    preset: job.req.preset,
    rootUrl: job.root,
    hostPort: job.hostPort,
    versionSource: resolved.source,
    pinned: job.req.pin,
    adminPassword: job.adminPassword,
    createdAt: new Date().toISOString().slice(0, 19) + '+00:00',
  });
  topology.stamp(job.meta.extra, topology.KUBERNETES);
  job.meta.extra[config.EXTRA_DEPLOYMENT] = job.req.deployment || topology.MICROSERVICES;
  for (const [key, value] of Object.entries(job.out)) {
    if (key !== 'microservices') job.meta.extra[key] = value;
  }
  // WHAT kind of cluster this workspace lives in. A label, never a branch -- it is what
  // lets `doctor`, the notes and a support case say "k3s" instead of leaving a reader to
  // infer it from a context name.
  job.meta.extra.distribution = plan.distribution;
  if (job.ktls !== null) {
    // The SAME three fields the Compose path records, so `list`, `info`, `reproLinks`, the
    // GUI grid and `tls-status` all work on a Kubernetes workspace for free. `rootUrl`
    // deliberately stays the plain http port-forward URL; `publicUrl` is what a human opens.
    job.meta.publicUrl = `https://${job.ktls.host}`;
    job.meta.extra.tls = job.ktls.issuer?.mode === 'acme' ? MODE_ACME : 'local';
    // `edge` means "a route file speaks for this name". It is what `noteGroupsOf` keys the
    // HTTPS card on, and it is false in the topology where the cluster holds :443 itself
    // and no edge is involved at all.
    job.meta.extra.edge = edgeInstalled();
    // Where TLS actually terminates, which is the one thing genuinely different from
    // Compose: the certificate is a cluster Secret issued by cert-manager, not a file the
    // edge loaded.
    job.meta.extra.tls_terminates = 'cluster';
    job.meta.extra.ingress_endpoint = endpointString(job.ktls.endpoint);
    job.meta.extra.ingress_class = job.ktls.ingressClass;
    // `certificate_ready` decides how a fallback certificate is EXPLAINED. It was computed
    // here all along and thrown away, so the check that reports the result did not know
    // whether one had ever been issued.
    await tlsplan.publishKubernetesName(job.reproName, job.ktls, {
      certReady: Boolean(job.out.certificate_ready),
      emit: job.emit,
    });
  }
}

/** What was ASKED for, so the workspace can be rebuilt exactly as it was. */
export function recordTheRequest(job: KubeCreate): void {
  const meta = job.meta as Metadata;
  if (job.req.replicas > 1) meta.extra.instances = job.req.replicas;
  if (job.req.actor) meta.extra.created_by = job.req.actor;
  // Recorded so the notes can be REBUILT from the record rather than read back out of it
  // -- a dynamic scenario's prose is a function of its params, and nothing was keeping them.
  if (Object.keys(job.req.params).length > 0) meta.extra.params = { ...job.req.params };
  // A preset's self-configuration actions, recorded exactly as the Compose path records
  // them. Without this the OIDC preset would create no OAuth provider and the SAML preset
  // no provider settings -- both recorded and neither applied.
  const postReady = (job.presetForNotes as Preset | null)?.postReady;
  if (postReady !== undefined && postReady.length > 0) meta.extra.post_ready = postReady;
}

/** The notes a reader needs, then the record -- and no compose file, because it is not one. */
export async function writeRecordStep(job: KubeCreate): Promise<void> {
  const meta = job.meta as Metadata;
  job.groups = notes.noteGroupsOf(meta);
  // THE GROUPS ARE NOT PERSISTED. They are rendered presentation -- roughly 5.5 KB of a
  // 6.4 KB Kubernetes record, the same content as `notes` a second time, and including an
  // absolute `export KUBECONFIG=<home>/clients/kubernetes/config` that is wrong the moment
  // the home moves.
  delete meta.extra.note_groups;
  // Derived, never written twice: the CLI and every workspace record made before groups
  // existed read this.
  meta.extra.notes = notes.flattenNotes(job.groups);
  // No compose document, so an empty one rather than a fake: a file that looks like a
  // compose project but is not would be worse than none.
  const ws = workspace(job.reproName);
  await fs.mkdir(ws, { recursive: true });
  // `serialise(meta)`, as every record is written: the record's one spelling, not
  // JSON.stringify's.
  await atomicWrite(joinPath(ws, 'repro.json'), serialise(meta));
}

/** Waiting, seeding, monitoring, and the line the caller reads at the end. */
export async function finish(job: KubeCreate): Promise<Bag> {
  const meta = job.meta as Metadata;
  job.result = {
    name: job.reproName,
    meta: toDocument(meta),
    url: job.root,
    reused: job.reused,
    runtime: topology.KUBERNETES,
  };
  // A preset with post_ready actions MUST wait, or there is nothing to configure against.
  if (job.req.wait || job.req.seed || isTruthy(meta.extra.post_ready)) {
    // waitAndFinalize, not bare waitServing: it also finalizes the setup wizard over REST
    // and runs the preset's post_ready actions. Waiting and stopping there left every
    // self-configuring preset half-applied.
    Object.assign(job.result, await waitAndFinalize(meta, job.emit, 600.0, false));
    job.result.ready = true;
  }
  // NOT when the caller seeds. `seedHere` means the CLI runs it after this returns, so
  // seeding here as well would seed the workspace twice.
  if (job.req.seed && !job.req.seedHere) {
    job.result.seed = await seeding.runSeedInline(
      meta,
      job.req.seedProfile,
      job.req.stats,
      job.emit,
    );
  }
  // `--monitor` last, and only once the workspace is serving: attaching turns on RC's own
  // Prometheus_Enabled over REST, which needs a workspace that answers.
  if (job.req.monitor) {
    if (!(job.req.wait || job.req.seed)) {
      await waitServing(meta, job.emit, 600.0);
    }
    // An add-on failing does not un-create the workspace. The first live run of this
    // failed on the monitoring chart and exited 7 with the workspace up, serving, and
    // listed as running -- a create reported as failed while its result was sitting there
    // working.
    try {
      job.result.monitoring = await job.monitorAttach(job.reproName, job.emit);
    } catch (error) {
      if (!(error instanceof ReproError)) throw error;
      warn(job.emit, `the workspace is up, but monitoring did not attach: ${error.message}`, {
        phase: 'monitor',
      });
      warn(job.emit, `retry it with: houston monitor --name ${job.reproName}`, {
        phase: 'monitor',
      });
      job.result.monitoring = { monitoring: false, error: error.message };
    }
  }
  info(job.emit, `${job.root}  admin / ${adminPass(meta)}`, { phase: 'done', pct: 100 });
  return job.result;
}

/**
 * The Kubernetes half of `createReproLocked`.
 *
 * Shares everything that is not runtime-specific -- name derivation, version resolution,
 * the capacity refusal, host-port allocation, repro.json -- and delegates only the
 * sequence that differs. A workspace created here is a workspace like any other: `list`,
 * `info`, `logs` and `down` find it because it has a repro.json.
 */
export async function createKubernetes(
  req: CreateReq,
  emit: Emit = nullEmit,
  {
    monitorAttach = request.missingMonitorAttach,
    versionFetcher,
  }: { monitorAttach?: MonitorAttach; versionFetcher?: ReleaseFetcher } = {},
): Promise<Bag> {
  const job = kubeCreate({
    req,
    emit,
    monitorAttach,
    ...(versionFetcher === undefined ? {} : { versionFetcher }),
  });
  await settleName(job);
  await resolvePairing(job);
  settleAddressing(job);
  await planClusterStep(job);
  await planTls(job);
  await planKubeTls(job);
  await writeProvisionalRecord(job);
  await createTheWorkspace(job);
  await buildRecord(job);
  recordTheRequest(job);
  await writeRecordStep(job);
  return await finish(job);
}
