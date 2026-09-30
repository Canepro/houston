/**
 * cert-manager and the issuers a workspace's ingress names.
 *
 * Installed only into a cluster houston may write to, and only after every read-only refusal
 * has passed -- an install left behind by a refusal is the defect this ordering was measured
 * against.
 */
import * as fs from 'node:fs';

import * as YAML from 'yaml';

import { CreateFailedError, PreflightError } from '../../lib/errors';
import { info, nullEmit, warn, type Emit } from '../../lib/events';
import { ensureCa } from '../tls-local';

import { askObject, present, why } from './ask';
import { distributionOf, isLocalCluster } from './context';
import { kube, type KubectlResult } from './exec';
import { CERT_MANAGER_NAMESPACE } from './monitoring';
import { INSTALL_TIMEOUT, OWNER_LABEL_KEY, OWNER_LABEL_VALUE, isOurs, tuning } from './names';
import { apply } from './release';
import type { Sleep } from './replicaset';

const realSleep: Sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Whether cert-manager can issue in this cluster.
 *
 * Keyed on the CRD rather than on a Deployment name or a helm release: the release can be
 * named anything, and `installCRDs` versus `crds.enabled` differ by cert-manager version --
 * but nothing can issue a Certificate without the CRD, and its absence is exactly the
 * failure that reads as "no matches for kind ClusterIssuer".
 */
export async function certManagerInstalled(context: string): Promise<boolean> {
  const res = await kube.run(
    ['kubectl', '--context', context, 'get', 'crd', 'certificates.cert-manager.io', '-o', 'name'],
    { own: isOurs(context) },
  );
  return res.returncode === 0 && res.stdout.includes('certificates.cert-manager.io');
}

/**
 * The pinned cert-manager release, and the command a person runs to get it. The OFFICIAL
 * Rocket.Chat guide installs cert-manager with kubectl, not helm, and lists it as a
 * PREREQUISITE -- so houston requires it and names this, rather than installing it into a
 * cluster it does not own.
 *
 * Following the guide here is not deference, it deletes work: verified against the real
 * v1.21.1 manifest, it contains no `startupapicheck` and no Job of any kind, so nothing can
 * fail a post-install hook, and it carries the six CRDs directly, so the
 * `crds.enabled`-versus-`installCRDs` trap has nowhere to happen.
 */
export const CERT_MANAGER_VERSION = 'v1.21.1';

export const CERT_MANAGER_MANIFEST = `https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml`;

/**
 * houston's own issuer, and the Secret holding the CA that backs it. A ClusterIssuer reads
 * its Secret from the cluster-resource namespace, which for a default cert-manager install
 * is its own.
 */
export const CA_ISSUER = 'houston-ca';

export const CA_ISSUER_SECRET = 'houston-ca';

export const ISSUER_WAIT_INTERVAL = 2.0;

/**
 * How long to wait for cert-manager to issue. 45 x 2 s was too tight for a FIRST issuance on
 * a cold cluster: the ACME account has to be registered, the order placed, the http-01
 * challenge served and validated by Let's Encrypt from outside, and on a first workspace all
 * of that starts only once the image pull has finished.
 *
 * OBSERVED through the GUI on a fresh EKS cluster -- the wait expired, the ingress answered
 * with its own default certificate, and the certificate arrived about a minute later. The
 * cost of waiting longer is bounded and only paid with `--domain`; the cost of giving up
 * early is a create that ends by reporting a failure that is not one.
 */
export const CERT_WAIT_TRIES = 90;

export const CERT_WAIT_INTERVAL = 2.0;

/**
 * The ACME directories, and two ISSUER NAMES rather than one with a flag. Switching staging
 * on and off must not reuse an account registered against the other directory:
 * `privateKeySecretRef` holds the ACME account key, and pointing a production order at a
 * staging account fails in a way that names neither.
 */
export const ACME_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';

export const ACME_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

export const ACME_ISSUER = 'houston-acme';

export const ACME_ISSUER_STAGING = 'houston-acme-staging';

/**
 * Which ClusterIssuer a workspace's Ingress should name, and how to make it.
 *
 * Two issuers, ONE mechanism, and that is the whole point of following the official guide's
 * values.yaml: `ingress.enabled`, `ingressClassName`, the `cert-manager.io/cluster-issuer`
 * annotation and `ingress.tls` are byte-identical between them. The difference between a
 * local certificate and a publicly trusted one is the issuer NAME -- one field -- which is
 * as close as a support box can get to reproducing the file a customer actually wrote.
 */
export interface IssuerSpec {
  /** `local` or `acme`. */
  readonly mode: string;
  readonly acmeEmail?: string;
  readonly acmeStaging?: boolean;
}

export function issuerName(spec: IssuerSpec): string {
  if (spec.mode !== 'acme') return CA_ISSUER;
  return spec.acmeStaging === true ? ACME_ISSUER_STAGING : ACME_ISSUER;
}

export function issuerDirectory(spec: IssuerSpec): string {
  return spec.acmeStaging === true ? ACME_STAGING : ACME_PRODUCTION;
}

/**
 * The three Deployments the official manifest creates. Waited for by name, because the
 * manifest has no hooks and `kubectl apply` returns the moment the objects are accepted --
 * and a ClusterIssuer created before the webhook is serving is accepted and then never
 * reconciled.
 */
export const CERT_MANAGER_DEPLOYMENTS: readonly string[] = [
  'cert-manager',
  'cert-manager-webhook',
  'cert-manager-cainjector',
];

export const CERT_MANAGER_INTERVAL = 3.0;

/** What to run to satisfy the prerequisite, quoted from the official guide. */
export function certManagerInstallHint(): string {
  return `kubectl apply -f ${CERT_MANAGER_MANIFEST}`;
}

/** Wait for cert-manager's deployments and CRDs after applying its manifest. */
async function waitForCertManager(context: string, emit: Emit, sleep: Sleep): Promise<void> {
  // THE WEBHOOK, not just the apply. `kubectl apply` returns as soon as the objects are
  // accepted, and a ClusterIssuer created before the webhook is serving is accepted and then
  // never reconciled -- no `.status` at all, so no Certificate ever issues and nothing says
  // why.
  for (const name of CERT_MANAGER_DEPLOYMENTS) {
    await kube.run(
      [
        'kubectl',
        '--context',
        context,
        '-n',
        CERT_MANAGER_NAMESPACE,
        'rollout',
        'status',
        `deployment/${name}`,
        '--timeout=180s',
      ],
      { timeout: INSTALL_TIMEOUT, own: isOurs(context) },
    );
  }
  // And the CRD, which is what "can this cluster issue a Certificate" actually means.
  let crds = false;
  for (let attempt = 0; attempt < tuning.CERT_MANAGER_TRIES; attempt += 1) {
    if (await certManagerInstalled(context)) {
      crds = true;
      break;
    }
    if (attempt < tuning.CERT_MANAGER_TRIES - 1) await sleep(CERT_MANAGER_INTERVAL);
  }
  if (!crds) {
    throw new CreateFailedError(
      `cert-manager was applied to '${context}' but its CRDs never appeared, so nothing can ` +
        `issue a Certificate there. \`kubectl -n ${CERT_MANAGER_NAMESPACE} get pods\` and ` +
        '`kubectl get crd | grep cert-manager`.',
    );
  }
  await waitForTheWebhook(context, sleep);
  info(emit, 'cert-manager: installed and answering', { phase: 'tls' });
}

/**
 * ANSWERING, which a Ready webhook pod is not yet: prove it with the object that is next.
 *
 * The webhook pod rolls out Ready as soon as it serves, but the API server calls it with the
 * CA bundle cainjector copies into its webhook configurations, and on a fresh install that
 * copy lands some seconds LATER. Until it does, every create of a cert-manager object fails
 * with `failed calling webhook "webhook.cert-manager.io" ... x509: certificate signed by
 * unknown authority`. MEASURED on a k3s playground: the apply straight after "installed and
 * answering" failed that way (exit 7), in both implementations, including a run that met
 * cert-manager's images already cached; an install that pulled its images had simply been
 * slow enough to miss the window.
 *
 * So the wait asks the webhook itself: a server-side dry-run of the ClusterIssuer that
 * `ensureCaIssuer` creates next goes through the same admission call and persists nothing.
 *
 * Bounded, but by its OWN bound, `tuning.CERT_MANAGER_WEBHOOK_TRIES` (60 x 3 s = 180 s, the
 * rollout waits' `--timeout=180s`), not the CRD wait's 60 s. cainjector injects the bundle
 * only once it holds its leader lease, and cert-manager's two Leases,
 * `kube-system/cert-manager-cainjector-leader-election` and
 * `kube-system/cert-manager-controller`, are created at run time, are not in the manifest,
 * and OUTLIVE `kubectl delete -f` of it. A new candidate that finds a lease it does not hold
 * waits a full lease duration (60 s) from when it first sees it, plus its retry period,
 * however long ago the old holder died. MEASURED on a k3s playground after a
 * fresh apply of the pinned v1.21.1 manifest on a cluster that had had cert-manager: the
 * three Deployments rolled out at +12 s, cainjector logged "Attempting to acquire leader
 * lease" at 05:51:48 and "Successfully acquired lease" at 05:53:07, and the webhook first
 * accepted this dry-run at +89 s. At 60 s the wait refused every such cluster, in the
 * previous implementation as here (the third run, exit 7); the first run's first install
 * passed only because its cluster had never had cert-manager.
 */
async function waitForTheWebhook(context: string, sleep: Sleep): Promise<void> {
  let res: KubectlResult | undefined;
  for (let attempt = 0; attempt < tuning.CERT_MANAGER_WEBHOOK_TRIES; attempt += 1) {
    res = await kube.run(
      ['kubectl', '--context', context, 'apply', '--dry-run=server', '-f', '-'],
      { input: caClusterIssuerManifest(), own: isOurs(context) },
    );
    if (res.returncode === 0) return;
    if (attempt < tuning.CERT_MANAGER_WEBHOOK_TRIES - 1) await sleep(CERT_MANAGER_INTERVAL);
  }
  throw new CreateFailedError(
    `cert-manager's webhook in '${context}' never accepted an object, so nothing can ` +
      `create an issuer or a Certificate there: ${why(res)}` +
      `. \`kubectl --context ${context} -n ${CERT_MANAGER_NAMESPACE} logs ` +
      `deploy/cert-manager-webhook\`, and \`kubectl --context ${context} get ` +
      'validatingwebhookconfiguration cert-manager-webhook -o yaml` for its caBundle.',
  );
}

/**
 * Adopt cert-manager if the cluster has it, install it if not.
 *
 * Installed exactly as the guide installs it -- by kubectl, not helm -- and that choice is
 * load-bearing rather than stylistic: the static manifest contains no `startupapicheck` and
 * no Job at all, so nothing can fail a post-install hook.
 *
 * Only on a cluster that is on this machine, UNLESS INVITED. Six CRDs and an admission
 * webhook are a change to what a cluster IS, for every workload in it -- not something to do
 * to somebody else's ON THE WAY TO BOOTING A REPRO. That last clause is the whole of the
 * rule, and locality was standing in for it: what makes an implicit install wrong is that
 * nobody asked, not where the cluster is.
 *
 * Never removed. `kubectl delete -f` takes the CRDs, and removing the CRDs garbage-collects
 * every Certificate and Issuer in the cluster -- the user's included.
 */
export async function ensureCertManager({
  context,
  distribution = '',
  invited = false,
  emit = nullEmit,
  sleep = realSleep,
}: {
  context: string;
  distribution?: string;
  invited?: boolean;
  emit?: Emit;
  sleep?: Sleep;
}): Promise<void> {
  if (await certManagerInstalled(context)) {
    info(emit, 'cert-manager: already in this cluster', { phase: 'tls' });
    return;
  }
  if (!invited && !isLocalCluster(distribution || (await distributionOf(context)))) {
    throw new PreflightError(
      `cluster '${context}' has no cert-manager, and it is not on this machine, so houston ` +
        'will not install one: six CRDs and an admission webhook change what that cluster ' +
        'is, for every workload in it. The official Rocket.Chat guide installs it as a ' +
        `prerequisite:\n    ${certManagerInstallHint()}\n  houston adopts it as soon as it ` +
        'is there.',
    );
  }
  info(
    emit,
    `no cert-manager in '${context}' — installing ${CERT_MANAGER_VERSION} (once per ` +
      "cluster, the guide's own command)",
    { phase: 'tls', pct: 10 },
  );
  const res = await kube.run(
    ['kubectl', '--context', context, 'apply', '-f', CERT_MANAGER_MANIFEST],
    { timeout: INSTALL_TIMEOUT, own: isOurs(context) },
  );
  if (res.returncode !== 0) {
    throw new CreateFailedError(
      `could not install cert-manager into '${context}': ${why(res)} — it is one command ` +
        `if you would rather run it yourself: ${certManagerInstallHint()}`,
    );
  }
  await waitForCertManager(context, emit, sleep);
}

/**
 * The CA Secret and the ClusterIssuer that signs from it.
 *
 * `stringData`, so Kubernetes does the base64 -- the PEM never has to be re-encoded
 * correctly here.
 *
 * A `ca` issuer rather than an `acme` one is what makes `--https` and `--domain` the same
 * values.yaml with one field different.
 */
export function caIssuerManifest(certPem: string, keyPem: string): string {
  const indent = (pem: string): string =>
    pem
      .trim()
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
  return (
    `---\napiVersion: v1\nkind: Secret\nmetadata:\n` +
    `  name: ${CA_ISSUER_SECRET}\n  namespace: ${CERT_MANAGER_NAMESPACE}\n` +
    `  labels:\n    ${OWNER_LABEL_KEY}: ${OWNER_LABEL_VALUE}\n` +
    `type: kubernetes.io/tls\nstringData:\n` +
    `  tls.crt: |\n${indent(certPem)}\n` +
    `  tls.key: |\n${indent(keyPem)}\n` +
    caClusterIssuerManifest()
  );
}

/**
 * The ClusterIssuer half of `caIssuerManifest`, on its own: it carries no key, so
 * `waitForTheWebhook` can dry-run it before anything is created.
 */
function caClusterIssuerManifest(): string {
  return (
    `---\napiVersion: cert-manager.io/v1\nkind: ClusterIssuer\nmetadata:\n` +
    `  name: ${CA_ISSUER}\n` +
    `  labels:\n    ${OWNER_LABEL_KEY}: ${OWNER_LABEL_VALUE}\n` +
    `spec:\n  ca:\n    secretName: ${CA_ISSUER_SECRET}\n`
  );
}

/** Whether an issuer answer carries a Ready=True condition, and what it said. */
function readyCondition(doc: Record<string, unknown>): string | null {
  const status = doc.status;
  const conditions =
    status !== null && typeof status === 'object'
      ? ((status as { conditions?: Record<string, unknown>[] }).conditions ?? [])
      : [];
  for (const condition of conditions) {
    if (condition.type === 'Ready' && String(condition.status) === 'True') {
      return String(condition.message ?? '');
    }
  }
  return null;
}

/**
 * Put houston's CA in the cluster as a `ca` ClusterIssuer, and wait for it.
 *
 * THE WAIT IS THE POINT: a ClusterIssuer created before cert-manager is ready is ACCEPTED
 * and then never reconciled -- no `.status` at all, so no Certificate ever issues and
 * nothing says why. Waiting for `Ready=True` here means a workspace either has a working
 * issuer or a refusal, and never the silent third thing.
 */
export async function ensureCaIssuer({
  context,
  emit = nullEmit,
  sleep = realSleep,
}: {
  context: string;
  emit?: Emit;
  sleep?: Sleep;
}): Promise<void> {
  const [keyPath, crtPath] = await ensureCa();
  info(emit, `issuer ${CA_ISSUER} from houston's own CA (once per cluster)`, { phase: 'tls' });
  await apply(
    caIssuerManifest(fs.readFileSync(crtPath, 'utf8'), fs.readFileSync(keyPath, 'utf8')),
    { namespace: CERT_MANAGER_NAMESPACE, context },
  );
  for (let attempt = 0; attempt < tuning.ISSUER_WAIT_TRIES; attempt += 1) {
    const seen = await askObject('clusterissuer', CA_ISSUER, { context });
    if (present(seen)) {
      const message = readyCondition(seen.doc);
      if (message !== null) {
        info(emit, `issuer ${CA_ISSUER} ready — ${message || 'signing CA verified'}`, {
          phase: 'tls',
        });
        return;
      }
    }
    if (attempt < tuning.ISSUER_WAIT_TRIES - 1) await sleep(ISSUER_WAIT_INTERVAL);
  }
  throw new PreflightError(
    `the ClusterIssuer ${CA_ISSUER} did not become ready in cluster '${context}'. ` +
      'cert-manager accepts an issuer it is not yet able to reconcile and then says ' +
      'nothing, so a workspace built on it would never get a certificate. `kubectl ' +
      `describe clusterissuer ${CA_ISSUER}\`, then try again.`,
  );
}

/**
 * The official guide's own ClusterIssuer, with houston's name on it.
 *
 * `ingressClassName` rather than the guide's `class`, which is the deprecated spelling of
 * the same field -- cert-manager 1.21 accepts both, and naming the current field is what
 * stops this being a deprecation warning later.
 *
 * http01, and NOT tls-alpn, because cert-manager does not implement tls-alpn at all. That is
 * worth stating where the choice is made: the Compose path defaults to TLS-ALPN and this one
 * cannot.
 *
 * BUILT AS A DOCUMENT, NOT A STRING. This was string interpolation, and `acmeEmail` is
 * caller-supplied -- so an address carrying newlines added its own keys to `spec.acme` and
 * the result was valid YAML cert-manager accepts. A ClusterIssuer is CLUSTER-SCOPED and
 * shared by every workspace on the box, so `skipTLSVerify: true` injected here would apply
 * to all of them.
 */
export function acmeIssuerManifest(
  spec: IssuerSpec,
  { ingressClass }: { ingressClass: string },
): string {
  const doc = {
    apiVersion: 'cert-manager.io/v1',
    kind: 'ClusterIssuer',
    metadata: { name: issuerName(spec), labels: { [OWNER_LABEL_KEY]: OWNER_LABEL_VALUE } },
    spec: {
      acme: {
        server: issuerDirectory(spec),
        email: spec.acmeEmail ?? '',
        privateKeySecretRef: { name: `${issuerName(spec)}-account-key` },
        solvers: [{ http01: { ingress: { ingressClassName: ingressClass } } }],
      },
    },
  };
  // `---` and key order preserved: the document is written into the workspace directory for
  // a human to read, and reordering it would make every diff noise.
  return `---\n${YAML.stringify(doc, { compat: 'yaml-1.1', indentSeq: false, lineWidth: 0 })}`;
}

/**
 * Register an ACME account in the cluster and wait for it. Idempotent.
 *
 * The wait is the same one `ensureCaIssuer` makes, but the failure it catches is different
 * and more common: this issuer makes a real network call to Let's Encrypt to register an
 * account, so a cluster with no egress, a wrong email or a rate-limited account fails HERE
 * -- once, with a reason -- rather than silently per Certificate afterwards.
 */
export async function ensureAcmeIssuer(
  spec: IssuerSpec,
  {
    context,
    ingressClass,
    emit = nullEmit,
    sleep = realSleep,
  }: { context: string; ingressClass: string; emit?: Emit; sleep?: Sleep },
): Promise<void> {
  const which = spec.acmeStaging === true ? 'staging' : 'production';
  const name = issuerName(spec);
  info(
    emit,
    `issuer ${name} — Let's Encrypt ${which}, http-01 via ${ingressClass} (once per cluster)`,
    { phase: 'tls' },
  );
  await apply(acmeIssuerManifest(spec, { ingressClass }), {
    namespace: CERT_MANAGER_NAMESPACE,
    context,
  });
  for (let attempt = 0; attempt < tuning.ISSUER_WAIT_TRIES; attempt += 1) {
    const seen = await askObject('clusterissuer', name, { context });
    if (present(seen)) {
      const message = readyCondition(seen.doc);
      if (message !== null) {
        info(emit, `issuer ${name} ready — ${message || 'ACME account registered'}`, {
          phase: 'tls',
        });
        return;
      }
    }
    if (attempt < tuning.ISSUER_WAIT_TRIES - 1) await sleep(ISSUER_WAIT_INTERVAL);
  }
  throw new PreflightError(
    `the ClusterIssuer ${name} did not become ready in cluster '${context}'. Registering an ` +
      `ACME account is a real call to ${issuerDirectory(spec)} from inside the cluster, so ` +
      'this is usually no egress from the pods, or a rejected contact address. `kubectl ' +
      `describe clusterissuer ${name}\` says which.`,
  );
}

/**
 * Make the issuer this workspace's Ingress is about to name.
 *
 * One call site, two mechanisms, chosen by the spec rather than by a branch at the caller --
 * which is what keeps `--https` and `--domain` the same code path with a different issuer.
 */
export async function ensureIssuer(
  spec: IssuerSpec,
  {
    context,
    ingressClass,
    emit = nullEmit,
  }: { context: string; ingressClass: string; emit?: Emit },
): Promise<void> {
  if (spec.mode === 'acme') {
    await ensureAcmeIssuer(spec, { context, ingressClass, emit });
  } else {
    await ensureCaIssuer({ context, emit });
  }
}

/**
 * Wait for cert-manager to issue `name`. Returns whether it did.
 *
 * NOT fatal, and deliberately: the workspace itself is up and reachable on its port-forward
 * whatever the certificate does, so a certificate that has not arrived is a thing to SAY
 * rather than a reason to destroy a workspace somebody waited minutes for.
 */
export async function waitForCertificate(
  name: string,
  {
    namespace,
    context,
    emit = nullEmit,
    sleep = realSleep,
  }: { namespace: string; context: string; emit?: Emit; sleep?: Sleep },
): Promise<boolean> {
  for (let attempt = 0; attempt < CERT_WAIT_TRIES; attempt += 1) {
    const seen = await askObject('certificate', name, { namespace, context });
    if (present(seen) && readyCondition(seen.doc) !== null) return true;
    if (attempt < CERT_WAIT_TRIES - 1) await sleep(CERT_WAIT_INTERVAL);
  }
  warn(
    emit,
    `the certificate ${name} in ${namespace} is not Ready yet — the workspace is up either ` +
      `way. \`kubectl -n ${namespace} describe certificate ${name}\` says what cert-manager ` +
      'is waiting for.',
    { phase: 'tls' },
  );
  return false;
}

/** The Secret cert-manager fills for a workspace's Ingress. */
export function tlsSecretFor(name: string): string {
  return `${name}-tls`;
}
