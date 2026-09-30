/**
 * What the workload is doing right now: pods, their phases, and the failures Kubernetes
 * has already decided are terminal.
 *
 * `terminalPodFailure` exists so a mistyped version or an unreachable registry costs a second
 * rather than the full readiness timeout, and reports the cause rather than the timeout.
 */
import { DockerError, NotReadyError } from '../../lib/errors';
import { quotedText, textLines } from '../../lib/format';
import { stream, type ProcessResult } from '../../seams/exec';

import { answerWhy, askList, askObject, items, present, refused, why } from './ask';
import { envFor, kube } from './exec';
import { APPLY_TIMEOUT, RELEASE, isOurs } from './names';
import { namespaceFor } from './namespace';

/**
 * The workloads whose readiness `ready` is entitled to speak for: the ones the official
 * chart gives a real readinessProbe. `account`, `authorization` and `presence` are
 * deliberately NOT here -- the chart ships them with no probe at all, so their pod-Ready
 * is set the moment the container starts and attests nothing.
 */
export const READY_SELECTOR = 'app.kubernetes.io/name in (rocketchat,rocketchat-ddp-streamer)';

/**
 * Rocket.Chat's APPLICATION pods -- every replica of the monolith, and on microservices
 * the account, authorization, ddp-streamer and presence deployments too.
 *
 * This was `app.kubernetes.io/name=rocketchat`, which is the MONOLITH deployment alone. On
 * microservices that silently omitted the four services that make the deployment
 * interesting -- ddp-streamer above all, since it carries the WebSocket, so a realtime
 * problem produced logs with nothing about realtime in them.
 *
 * Selected by RELEASE with nats excluded, rather than by listing the four names: a
 * microservice the chart adds later is then included automatically.
 */
export const LOG_SELECTOR = `app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/name!=nats`;

/**
 * The MONOLITH Rocket.Chat deployment alone, and its container. Anything asking a question
 * about "Rocket.Chat itself" wants this and not the broad log selector: that one matches
 * ddp-streamer and presence too, so `items[0]` under it could answer with a microservice's
 * environment instead of Rocket.Chat's.
 */
export const APP_SELECTOR = 'app.kubernetes.io/name=rocketchat';

export const LOG_CONTAINER = 'rocketchat';

/**
 * Waiting-state reasons a pod will never recover from on its own. `ImagePullBackOff` alone
 * is NOT terminal -- a slow or rate-limited registry looks identical while it is still
 * making progress -- so it is the REASON that discriminates, not the phase.
 */
export const TERMINAL_POD_REASONS: readonly string[] = [
  'ErrImagePull',
  'ImagePullBackOff',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
];

function mapOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function listOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/**
 * Ready endpoint count per Service in a namespace. null if it could not be read.
 *
 * EndpointSlice, not Endpoints. kubectl says it plainly on every call to the old one, and
 * `discovery.k8s.io/v1` has been GA since Kubernetes 1.21, which is this package's
 * declared kubectl floor.
 *
 * A Service with pods behind it but no READY endpoints is the case worth having this for:
 * readiness reads pod status and the port-forward targets the Deployment, so nothing on
 * either path ever traverses the Service. A selector that matches nothing therefore looked
 * exactly like a healthy workspace -- and the Kubernetes default deployment is
 * microservices, where in-cluster Service traffic is what carries the product.
 */
export async function serviceReadyAddresses(
  namespace: string,
  { context }: { context: string },
): Promise<Record<string, number> | null> {
  const seen = await askList('endpointslices', { context, namespace });
  if (refused(seen)) return null;
  const out: Record<string, number> = {};
  for (const slice of items(seen)) {
    const svc = String(mapOf(mapOf(slice.metadata).labels)['kubernetes.io/service-name'] ?? '');
    if (svc === '') continue;
    let ready = 0;
    for (const endpoint of listOf(slice.endpoints)) {
      if (mapOf(endpoint.conditions).ready === true) ready += 1;
    }
    out[svc] = (out[svc] ?? 0) + ready;
  }
  return out;
}

/**
 * Rocket.Chat Services in this workspace that no ready pod is behind.
 *
 * REPORTED, NOT GATED, and that is deliberate. Endpoints churn during a rollout, so a
 * transient empty set is normal; making readiness depend on this would turn an ordinary
 * restart into a workspace that never comes ready. And a false negative here would block
 * every boot, which is a far worse failure than the one being detected.
 */
export async function servicesWithoutEndpoints(
  name: string,
  { context }: { context: string },
): Promise<string[]> {
  const namespace = await namespaceFor(name);
  const counts = await serviceReadyAddresses(namespace, { context });
  if (counts === null) return [];
  const svcs = await askList('svc', { context, namespace });
  if (refused(svcs)) return [];
  const bad: string[] = [];
  for (const svc of items(svcs)) {
    const meta = mapOf(svc.metadata);
    const svcName = String(meta.name ?? '');
    const spec = mapOf(svc.spec);
    const selector = mapOf(spec.selector);
    // A Service with no selector is wired by hand (or is a headless alias) and has no pods
    // to be missing. ExternalName has no endpoints by definition.
    if (svcName === '' || Object.keys(selector).length === 0) continue;
    if (String(spec.type ?? '') === 'ExternalName') continue;
    // THE SELECTOR, NOT THE LABELS, and this was wrong first time round: the chart does
    // not set `app.kubernetes.io/instance` as a LABEL on most of them, so the filter
    // excluded every Service it was meant to judge and the whole check was a silent no-op.
    // Caught by breaking one on a live cluster, which is the only way it could have been
    // caught -- a stub would have answered whatever the test put in it.
    if (selector['app.kubernetes.io/instance'] !== RELEASE) continue;
    if ((counts[svcName] ?? 0) === 0) bad.push(svcName);
  }
  return bad.sort();
}

/**
 * Whether every probed Rocket.Chat workload reports itself Ready.
 *
 * This used to read `items[0].status.containerStatuses[0].ready`, which over-claimed
 * twice: `items[0]` is ONE pod, so with `--replicas 3` the workspace was called ready on
 * the strength of the first; and only the monolith container was consulted, while on
 * microservices `ddp-streamer` carries the WebSocket and was observed Running-but-not-Ready
 * on a workspace already reported as serving.
 *
 * A Pending pod has no containerStatuses at all, so counting pods and comparing is what
 * keeps "no statuses yet" from passing as "nothing failed".
 */
export async function workspaceReady(
  name: string,
  { context }: { context: string },
): Promise<boolean> {
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      await namespaceFor(name),
      'get',
      'pod',
      '-l',
      READY_SELECTOR,
      '-o',
      'json',
    ],
    { own: isOurs(context) },
  );
  if (res.returncode !== 0) return false;
  let pods: Record<string, unknown>[];
  try {
    pods = listOf(mapOf(JSON.parse(res.stdout || '{}')).items);
  } catch {
    return false;
  }
  if (pods.length === 0) return false;
  for (const pod of pods) {
    const statuses = listOf(mapOf(pod.status).containerStatuses);
    if (statuses.length === 0) return false; // Pending/ContainerCreating
    if (!statuses.every((container) => container.ready === true)) return false;
  }
  return true;
}

async function podCount(
  name: string,
  { context, selector = LOG_SELECTOR }: { context: string; selector?: string },
): Promise<number> {
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      await namespaceFor(name),
      'get',
      'pods',
      '-l',
      selector,
      '-o',
      'name',
    ],
    { own: isOurs(context) },
  );
  if (res.returncode !== 0) return 1;
  return res.stdout.split('\n').filter((line) => line.trim() !== '').length;
}

/**
 * Stream Rocket.Chat's logs out of the cluster, shaped like the Compose one.
 *
 * A named function for the same reason the Compose one is: it is the single kubectl call
 * the log path makes, so a test can stand here without a cluster.
 *
 * `--prefix` matters more here than on Compose: with microservices or several replicas the
 * lines come from different pods and are otherwise indistinguishable. `--max-log-requests`
 * is raised because kubectl refuses to follow more than five pods by default and a
 * microservices workspace has more than five.
 */
export async function logArgv(
  name: string,
  {
    context,
    tail = 200,
    follow = true,
    selector = LOG_SELECTOR,
  }: { context: string; tail?: number; follow?: boolean; selector?: string },
): Promise<[string, ...string[]]> {
  // No `-c`: the pods now selected have DIFFERENT container names (rocketchat,
  // ddp-streamer, presence...), so naming one would fail on the others. Each pod here has
  // a single container, so kubectl's default is the right one.
  const argv: [string, ...string[]] = [
    'kubectl',
    '--context',
    context,
    '-n',
    await namespaceFor(name),
    'logs',
    '-l',
    selector,
    '--tail',
    String(Math.trunc(tail)),
    '--max-log-requests',
    '20',
  ];
  // `--prefix` ONLY when there is more than one pod to tell apart. It was unconditional
  // and that was wrong: Rocket.Chat pretty-prints its own log lines in columns, and
  // stamping "[pod/rocketchat-rocketchat-<hash>/rocketchat] " onto the front of every one
  // of them destroys exactly the formatting somebody opened the logs to read.
  if ((await podCount(name, { context, selector })) > 1) argv.push('--prefix');
  if (follow) argv.push('-f');
  return argv;
}

/**
 * Stream the log lines out of the cluster, merged, one callback per line.
 *
 * The log process's output is read as text, line by line: every line reaches the readers,
 * the unterminated last one included, split as text mode splits (`textLines`). This split
 * on `\n` alone and kept whatever followed the last one -- `logs` dropped a final line with
 * no newline, and a `\r`-redrawn line came through whole with its carriage returns in it
 * The result retains nothing: `stream` keeps no copy of the output, so a reader that needs
 * the text collects it through `onLine`.
 */
export async function logProcess(
  name: string,
  options: {
    context: string;
    tail?: number;
    follow?: boolean;
    selector?: string;
    onLine?: (line: string) => void;
    abortSignal?: AbortSignal;
    /** Called once kubectl is about to run, after the pod count its argv needed. */
    onSpawn?: () => void;
  },
): Promise<ProcessResult> {
  const argv = await logArgv(name, options);
  const env = envFor(options.context);
  const lines = textLines((line) => options.onLine?.(line));
  options.onSpawn?.();
  const result = await stream(argv, {
    encoding: 'utf8',
    mergeStderr: true,
    ...(env !== undefined ? { env } : {}),
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    onStdout: (chunk) => lines.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8')),
  });
  lines.end();
  return result;
}

/**
 * Rocket.Chat's EFFECTIVE environment, read out of the running container.
 *
 * Compose answers this from the generated compose file. There is no such document here,
 * and the helm values are only what houston asked for -- the chart adds its own, so the
 * values are not the answer to "what is Rocket.Chat actually running with".
 */
export async function containerEnv(
  name: string,
  { context, selector = APP_SELECTOR }: { context: string; selector?: string },
): Promise<Record<string, string>> {
  const namespace = await namespaceFor(name);
  const pod = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      namespace,
      'get',
      'pod',
      '-l',
      selector,
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ],
    { own: isOurs(context) },
  );
  // THE EXIT CODE, not just empty stdout. A refused read -- wrong context, RBAC, a
  // timeout -- also produces no stdout, so a HEALTHY running workspace was told "no
  // Rocket.Chat pod ... is it running?", which sends the reader to start something that is
  // already started.
  //
  // `quotedText(context)` and `quotedText(name)'s`, the established messages: `quotedText` picks
  // double quotes for `o'brien`, and a quoted name before `'s` is `'beta''s`. These
  // hard-coded single quotes, so every refused pod lookup -- RBAC, a wrong context, no
  // kubectl -- read differently.
  if (pod.returncode !== 0) {
    throw new DockerError(
      `could not ask cluster ${quotedText(context)} for ${quotedText(name)}'s Rocket.Chat pod: ${why(pod)}`,
    );
  }
  const target = pod.stdout.trim();
  if (target === '') {
    throw new NotReadyError(
      `no Rocket.Chat pod in ${namespace} to read the environment from — is ${quotedText(name)} ` +
        `running? (\`houston start --name ${name}\`)`,
    );
  }
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      namespace,
      'exec',
      target,
      '-c',
      LOG_CONTAINER,
      '--',
      'env',
    ],
    { timeout: APPLY_TIMEOUT, own: isOurs(context) },
  );
  if (res.returncode !== 0) {
    throw new NotReadyError(`could not read the environment from ${target}: ${why(res)}`);
  }
  const out: Record<string, string> = {};
  for (const line of res.stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at >= 0) out[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return out;
}

/**
 * A Kubernetes CPU or memory quantity as a plain number.
 *
 * CPU comes as millicores ("142m") or cores ("1"); memory as Ki/Mi/Gi. Returned as
 * millicores and BYTES respectively, so the caller does the same arithmetic it does for
 * Compose.
 */
export function parseQuantity(text: string): number {
  const trimmed = text.trim();
  if (trimmed.endsWith('m')) return Number(trimmed.slice(0, -1) || 0);
  for (const [suffix, multiplier] of [
    ['Ki', 1024],
    ['Mi', 1024 ** 2],
    ['Gi', 1024 ** 3],
    ['K', 1000],
    ['M', 1000 ** 2],
    ['G', 1000 ** 3],
  ] as const) {
    if (trimmed.endsWith(suffix)) {
      return Number(trimmed.slice(0, -suffix.length) || 0) * multiplier;
    }
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : 0;
}

export interface PodMetric {
  pod: string;
  cpu_millicores: number;
  mem_bytes: number;
}

/**
 * Per-pod CPU and memory, via `kubectl top`.
 *
 * Every Rocket.Chat application pod, which on microservices means the four services as
 * well as the monolith deployment. Scoped to the monolith alone it would report two pods
 * out of six and call it the workspace's resource use.
 *
 * Needs metrics-server, which kind does NOT ship. When it is absent the refusal says so
 * and how to install it, rather than reporting zero -- a resource figure that is quietly
 * wrong is worse than one that is missing.
 */
export async function podMetrics(
  name: string,
  { context, selector = LOG_SELECTOR }: { context: string; selector?: string },
): Promise<PodMetric[]> {
  // An EMPTY selector means the whole namespace, and the flag is dropped rather than
  // passed empty -- Compose sums every container in the workspace, and reporting only the
  // Rocket.Chat pods made the two runtimes measure different sets, omitting the database
  // on the one where it is usually the largest consumer.
  const argv = ['kubectl', '--context', context, '-n', await namespaceFor(name), 'top', 'pods'];
  if (selector !== '') argv.push('-l', selector);
  argv.push('--no-headers');
  const res = await kube.run(argv, { timeout: APPLY_TIMEOUT, own: isOurs(context) });
  if (res.returncode !== 0) {
    const blob = `${res.stderr}${res.stdout}`.toLowerCase();
    if (blob.includes('metrics') || blob.includes('not available')) {
      // Both commands, because the second is not optional on kind: its kubelet serves a
      // self-signed certificate that metrics-server refuses by default, so the install
      // succeeds and never reports a metric.
      throw new NotReadyError(
        'this cluster has no metrics-server, so there is nothing to read CPU and memory ' +
          'from. Install it with:\n' +
          '  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/' +
          'latest/download/components.yaml\n' +
          "and on kind, let it accept the kubelet's self-signed certificate:\n" +
          '  kubectl -n kube-system patch deploy metrics-server --type=json -p ' +
          '\'[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":' +
          '"--kubelet-insecure-tls"}]\'',
      );
    }
    throw new NotReadyError(`could not read pod metrics: ${why(res)}`);
  }
  const rows: PodMetric[] = [];
  for (const line of res.stdout.split('\n')) {
    const parts = line.split(/\s+/u).filter(Boolean);
    if (parts.length >= 3) {
      rows.push({
        pod: parts[0] as string,
        cpu_millicores: parseQuantity(parts[1] as string),
        mem_bytes: parseQuantity(parts[2] as string),
      });
    }
  }
  return rows;
}

export interface PodRow {
  service: string;
  state: string;
  status: string;
  health: string;
  app: boolean;
  blocked: boolean;
  restarts: number;
  started: string;
}

/** Render one Kubernetes pod in the container-panel shape. */
export function podRow(item: Record<string, unknown>): PodRow {
  const meta = mapOf(item.metadata);
  const st = mapOf(item.status);
  // initContainerStatuses too: the MongoDB fix-permission and init containers are exactly
  // where a Kubernetes workspace gets stuck, and a pod whose init container is in
  // CrashLoopBackOff reports phase Pending and an EMPTY containerStatuses -- so reading
  // only the main list showed "0/0 ready" and named nothing.
  const main = listOf(st.containerStatuses);
  const all = [...listOf(st.initContainerStatuses), ...main];
  const ready = main.filter((container) => container.ready === true).length;
  let restarts = 0;
  for (const container of all) restarts += Number(container.restartCount ?? 0);

  let reason = '';
  for (const container of all) {
    const state = mapOf(container.state);
    const waiting = mapOf(state.waiting);
    const terminated = mapOf(state.terminated);
    // A terminated init container that SUCCEEDED is not a reason -- that is the normal end
    // of an init container, and reporting "Completed" as the pod's status hid a Rocket.Chat
    // container that was crash-looping behind it.
    if (terminated.reason === 'Completed') continue;
    reason = String(waiting.reason ?? terminated.reason ?? '');
    if (reason !== '') break;
  }
  const phase = String(st.phase ?? '');
  let status = reason || `${String(ready)}/${String(main.length)} ready`;
  if (restarts > 0) status += ` · ${String(restarts)} restart${restarts === 1 ? '' : 's'}`;
  return {
    service: String(meta.name ?? ''),
    state: phase.toLowerCase(),
    status,
    health: main.length > 0 && ready === main.length ? 'healthy' : '',
    // WHICH POD IS ROCKET.CHAT ITSELF, decided by the label APP_SELECTOR already names --
    // not by a substring of the pod name, which is a naming rule the browser would then
    // hold a second copy of.
    app: mapOf(meta.labels)['app.kubernetes.io/name'] === 'rocketchat',
    // Decided HERE, next to the list that defines it, because the browser needs the answer
    // and must not keep a second copy of the policy: `ContainerCreating` and
    // `PodInitializing` are waiting reasons too, and a panel that treated every reason as a
    // failure would report a booting workspace as broken.
    blocked: TERMINAL_POD_REASONS.includes(reason),
    restarts,
    started: String(st.startTime ?? ''),
  };
}

/**
 * Every pod in this workspace's namespace, in the shape the panel's containers tab already
 * renders.
 *
 * A waiting REASON outranks the phase in the status column. "Pending" says only that
 * something has not happened; `ImagePullBackOff`, `CrashLoopBackOff` and
 * `CreateContainerConfigError` say what, and that is the answer to "why is this workspace
 * not up".
 */
export async function podRows(name: string, { context }: { context: string }): Promise<PodRow[]> {
  const res = await kube.run(
    ['kubectl', '--context', context, '-n', await namespaceFor(name), 'get', 'pods', '-o', 'json'],
    { own: isOurs(context) },
  );
  // An unreachable cluster is the panel's "docker is unavailable": an empty list, never a
  // raise. `detail()` is on the path of every panel open, and a workspace whose cluster is
  // asleep still has to render.
  if (res.returncode !== 0) return [];
  let doc: Record<string, unknown>;
  try {
    doc = mapOf(JSON.parse(res.stdout || '{}'));
  } catch {
    return [];
  }
  const rows = listOf(doc.items).map(podRow);
  // Named order, so the tab does not reshuffle itself between two panel opens.
  rows.sort((left, right) =>
    left.service < right.service ? -1 : left.service > right.service ? 1 : 0,
  );
  return rows;
}

/**
 * The first pod condition that cannot succeed, as `[pod, reason, message]`.
 *
 * Without this, a create waits out its whole timeout on something already decided: a
 * mistyped version, an image the registry does not have, an unreachable registry. Ten
 * minutes of "waiting for Rocket.Chat" for an answer Kubernetes had in seconds.
 *
 * Returns null when nothing is terminal, so the caller keeps waiting -- the default has to
 * be patience, or a slow pull becomes a failed create.
 */
export async function terminalPodFailure(
  name: string,
  { context }: { context: string },
): Promise<[string, string, string] | null> {
  const res = await kube.run(
    ['kubectl', '--context', context, '-n', await namespaceFor(name), 'get', 'pods', '-o', 'json'],
    { own: isOurs(context) },
  );
  if (res.returncode !== 0) return null;
  let rows: Record<string, unknown>[];
  try {
    rows = listOf(mapOf(JSON.parse(res.stdout || '{}')).items);
  } catch {
    return null;
  }
  for (const item of rows) {
    const pod = String(mapOf(item.metadata).name ?? '');
    const st = mapOf(item.status);
    for (const status of [...listOf(st.containerStatuses), ...listOf(st.initContainerStatuses)]) {
      const waiting = mapOf(mapOf(status.state).waiting);
      const reason = String(waiting.reason ?? '');
      if (TERMINAL_POD_REASONS.includes(reason)) {
        return [pod, reason, String(waiting.message ?? '').trim()];
      }
    }
  }
  return null;
}

/**
 * Whether the Rocket.Chat deployment is present in the workspace's namespace.
 *
 * Distinct from the namespace existing, which survives a plain `down` along with the PVC.
 *
 * RAISES rather than answering false when the cluster could not be asked. This returned
 * `rc == 0 and stdout`, so a wrong context, an RBAC denial or a timeout all read as "the
 * workload is not there" -- and `prunable()` then listed a LIVE workspace under "these
 * down repros will be deleted, containers, data volumes and records". Measured: it
 * returned a workspace that was serving 200 at the time.
 */
export async function workloadExists(
  name: string,
  { context }: { context: string },
): Promise<boolean> {
  const answer = await askObject('deployment', `${RELEASE}-rocketchat`, {
    namespace: await namespaceFor(name),
    context,
  });
  if (refused(answer)) {
    throw new DockerError(
      `could not ask cluster ${quotedText(context)} whether ${quotedText(name)} is running: ` +
        (answerWhy(answer) || 'the API server did not answer'),
    );
  }
  return present(answer);
}
