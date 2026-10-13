/**
 * The ingress controller, adopted when one is already there and installed when not.
 */
import { CreateFailedError, DockerError, PreflightError } from '../../lib/errors';
import { type PublicPath } from '../../lib/presets/public';
import { info, nullEmit, type Emit } from '../../lib/events';

import { why } from './ask';
import { ingressClasses } from './capabilities';
import { CA_ISSUER } from './certmanager';
import { distributionOf, isLocalCluster } from './context';
import { helmEnv, kube } from './exec';
import { APPLY_TIMEOUT, INSTALL_TIMEOUT, isOurs } from './names';
import { clearPendingRelease } from './release';
import type { Sleep } from './replicaset';

const realSleep: Sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * The ingress controller houston installs when a cluster has none, and where. The official
 * Rocket.Chat guide's own example, so a cluster houston filled in looks like a cluster
 * somebody followed the guide on.
 *
 * THE CHART'S DEFAULT SERVICE TYPE IS LEFT ALONE, and that is the whole reason no NodePort
 * is configured anywhere: on a cluster with a provider it gets an address and the cluster
 * owns :443, and on one without it stays pending while Kubernetes allocates NodePorts
 * anyway. `ingressEndpoint` reads whichever exists.
 */
export const INGRESS_REPO = 'traefik';

export const INGRESS_REPO_URL = 'https://traefik.github.io/charts';

export const INGRESS_CHART = `${INGRESS_REPO}/traefik`;

export const INGRESS_RELEASE = 'traefik';

export const INGRESS_NAMESPACE = 'traefik';

export const INGRESS_CLASS_TRIES = 30;

export const INGRESS_CLASS_INTERVAL = 2.0;

/** Install the ingress controller and wait for its rollout. */
async function installIngressController(context: string, emit: Emit): Promise<void> {
  info(
    emit,
    `no ingress controller in '${context}' — installing ${INGRESS_CHART} into ` +
      `${INGRESS_NAMESPACE} (once per cluster, the guide's own command)`,
    { phase: 'tls', pct: 12 },
  );
  await kube.run(['helm', 'repo', 'add', INGRESS_REPO, INGRESS_REPO_URL, '--force-update'], {
    timeout: APPLY_TIMEOUT,
    env: helmEnv(context),
  });
  await kube.run(['helm', 'repo', 'update', INGRESS_REPO], {
    timeout: APPLY_TIMEOUT,
    env: helmEnv(context),
  });
  // Same blast radius as the operator and the monitoring stack: one shared release, so a
  // killed install wedges it for every later workspace on this cluster.
  await clearPendingRelease(INGRESS_RELEASE, INGRESS_NAMESPACE, context, { emit });
  // DELIBERATELY NOT `--wait`, and NOT the rollback flag either -- which implies it. Helm's
  // readiness check for a Service of type LoadBalancer waits for
  // `status.loadBalancer.ingress` to be populated, and this chart's Service is a
  // LoadBalancer by default. On a cluster with no provider that never happens, so `--wait`
  // cannot succeed on precisely the cluster houston is installing into. Measured on k3s
  // started with `--disable servicelb`: five minutes, then a rollback, on an install whose
  // three pods were fine.
  const res = await kube.run(
    [
      'helm',
      'upgrade',
      '--install',
      INGRESS_RELEASE,
      INGRESS_CHART,
      '--kube-context',
      context,
      '-n',
      INGRESS_NAMESPACE,
      '--create-namespace',
      '--timeout',
      '5m',
    ],
    { timeout: INSTALL_TIMEOUT, env: helmEnv(context) },
  );
  if (res.returncode !== 0) {
    throw new CreateFailedError(
      `could not install an ingress controller into '${context}': ${why(res)}`,
    );
  }
  // The controller itself, which `--wait` would have covered had it been usable.
  await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      INGRESS_NAMESPACE,
      'rollout',
      'status',
      `deployment/${INGRESS_RELEASE}`,
      '--timeout=180s',
    ],
    { timeout: INSTALL_TIMEOUT, own: isOurs(context) },
  );
}

/**
 * The IngressClass to use. Adopts one if the cluster has it, installs if not.
 *
 * `invited` means a human asked for this cluster to be set up (`cluster prepare`) rather
 * than houston reaching for an ingress on the way to booting a workspace. Locality was
 * standing in for consent; installing a LoadBalancer Service into somebody else's cluster
 * uninvited is the thing to avoid, and being asked to is not that.
 *
 * ADOPTING COMES FIRST, and not only to save work: the ingress controller is the component
 * whose behaviour a support case is usually about, so a cluster that already runs nginx must
 * keep running nginx. Installing Traefik over the top would reproduce the wrong thing in
 * exactly the dimension that matters.
 *
 * Only on a cluster that is on this machine: an ingress controller's Service is a
 * LoadBalancer by chart default, and on a managed cluster that provisions a real cloud load
 * balancer -- a billable resource, created implicitly, in somebody's account.
 *
 * Never removed. An ingress controller serves every Ingress in the cluster, including ones
 * houston knows nothing about, and taking the box's ingress away on a `down --volumes` would
 * be a far bigger surprise than leaving it.
 */
export async function ensureIngress({
  context,
  distribution = '',
  invited = false,
  prefer = '',
  emit = nullEmit,
  sleep = realSleep,
}: {
  context: string;
  distribution?: string;
  invited?: boolean;
  prefer?: string;
  emit?: Emit;
  sleep?: Sleep;
}): Promise<string> {
  const seen = await ingressClasses(context);
  if (seen === null) {
    throw new DockerError(
      `could not read the IngressClasses in cluster '${context}', so houston cannot tell ` +
        'whether it has an ingress controller. Check the credential in your kubeconfig — ' +
        "refusing to guess, because 'I cannot ask' and 'there is none' are different answers.",
    );
  }
  if (seen.length > 0 && prefer !== '') {
    // NAMED BY THE OPERATOR, and refused rather than silently ignored. Somebody who passes
    // `--ingress-class alb` and gets nginx has been overruled without being told.
    if (!seen.includes(prefer)) {
      throw new PreflightError(
        `cluster '${context}' has no IngressClass named '${prefer}'. It has: ` +
          `${seen.join(', ') || 'none'}.`,
      );
    }
    info(emit, `ingress: using '${prefer}' as asked`, { phase: 'tls' });
    return prefer;
  }
  if (seen.length > 1) {
    // SAID OUT LOUD, because a choice among several is a decision and this is the only place
    // it is visible. `ingressClasses` puts the cluster's own default first; where there is
    // no default the order is by name, which is arbitrary but at least the same every time.
    info(
      emit,
      `ingress: adopting '${String(seen[0])}' — this cluster has ${seen.join(', ')}. ` +
        '`--ingress-class` names a different one.',
      { phase: 'tls' },
    );
    return seen[0] as string;
  }
  if (seen.length === 1) {
    info(emit, `ingress: adopting '${String(seen[0])}', already in this cluster`, {
      phase: 'tls',
    });
    return seen[0] as string;
  }
  if (
    !invited &&
    !(await isLocalCluster(distribution || (await distributionOf(context)), context))
  ) {
    throw new PreflightError(
      `cluster '${context}' has no ingress controller, and it is not on this machine, so ` +
        "houston will not install one: the chart's Service is a LoadBalancer and that " +
        'provisions a real load balancer in your cloud account. Install one yourself and ' +
        `houston will adopt it:\n    helm install ${INGRESS_RELEASE} ${INGRESS_CHART} -n ` +
        `${INGRESS_NAMESPACE} --create-namespace`,
    );
  }
  await installIngressController(context, emit);
  // THE CLASS, NOT THE RELEASE. helm returning means the Deployment is ready; the
  // IngressClass is a separate object and the chart creates it, so a create that went
  // straight on to reading the classes would find none and refuse for want of the thing it
  // had just installed.
  for (let attempt = 0; attempt < INGRESS_CLASS_TRIES; attempt += 1) {
    const found = await ingressClasses(context);
    if (found !== null && found.length > 0) {
      info(emit, `ingress: installed '${String(found[0])}'`, { phase: 'tls' });
      return found[0] as string;
    }
    if (attempt < INGRESS_CLASS_TRIES - 1) await sleep(INGRESS_CLASS_INTERVAL);
  }
  throw new CreateFailedError(
    `${INGRESS_CHART} installed into '${context}' but no IngressClass appeared, so nothing ` +
      `would route to this workspace. \`kubectl get ingressclass\` and \`kubectl -n ` +
      `${INGRESS_NAMESPACE} get pods\`.`,
  );
}

/** The Ingress, in the workspace's namespace, that serves a preset's own UIs. */
export const TOOLS_INGRESS = 'houston-tools';

/**
 * A preset's own UIs at paths of the workspace's HTTPS name (`lib/presets/public.ts`), each to
 * its Service. Same host and the SAME certificate Secret as the chart's Ingress, so it asks
 * cert-manager for nothing and costs no certificate; deleting the namespace removes it.
 */
export function toolsIngressManifest(
  host: string,
  {
    ingressClass,
    secretName,
    paths,
    labels,
  }: {
    ingressClass: string;
    secretName: string;
    paths: readonly PublicPath[];
    labels: Record<string, string>;
  },
): string {
  return JSON.stringify({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: { name: TOOLS_INGRESS, labels },
    spec: {
      ingressClassName: ingressClass,
      tls: [{ hosts: [host], secretName }],
      rules: [
        {
          host,
          http: {
            paths: paths.map((p) => ({
              path: p.path,
              pathType: 'Prefix',
              backend: { service: { name: p.service, port: { number: p.service_port } } },
            })),
          },
        },
      ],
    },
  });
}

/**
 * The official guide's ingress block, verbatim in shape.
 *
 * `host` is returned alongside because the chart uses it for BOTH the Ingress rule host and
 * its own ROOT_URL -- see `valuesFor`, where passing a URL here once rendered
 * `https://http://localhost:32812`.
 *
 * The chart builds the Ingress; houston hand-writes none. That matters beyond tidiness: the
 * chart's own template is what path-splits `/sockjs` and `/websocket` to the ddp-streamer
 * when microservices are on, and emulating a template is the signal that the layer is wrong.
 */
export function ingressValues(
  host: string,
  {
    ingressClass,
    secretName,
    issuer = CA_ISSUER,
  }: { ingressClass: string; secretName: string; issuer?: string },
): Record<string, unknown> {
  return {
    host,
    ingress: {
      enabled: true,
      ingressClassName: ingressClass,
      annotations: { 'cert-manager.io/cluster-issuer': issuer },
      tls: [{ secretName, hosts: [host] }],
    },
  };
}
