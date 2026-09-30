/**
 * Everything HTTPS a workspace can be given, decided before anything is built.
 *
 * Tier 3. A workspace never terminates TLS -- one Traefik edge holds :80/:443 for the box and
 * a workspace gains or loses HTTPS by a route file appearing or disappearing. So this module
 * produces a PLAN and a name, and the create path acts on it; nothing here starts a
 * container.
 */
import { lookup } from 'node:dns/promises';

import * as config from '../../lib/config';
import {
  AuthorityGateError,
  ConflictError,
  PreflightError,
  ValidationError,
} from '../../lib/errors';
import { type Emit, info, nullEmit, warn } from '../../lib/events';
import { toText } from '../../lib/format';
import {
  CA_CRT,
  LEGO_PROVIDER_DOCS,
  MODE_ACME,
  MODE_LOCAL,
  type TlsSpec,
  caDir,
  dnsCredentials,
  dnsEnvPath,
  dnsEnvVars,
  inferDnsProvider,
  localHostFor,
  normalizeDomain,
  tlsSpec,
  verify,
} from '../tls';
import { hostOwner, register as registerRoute } from '../edge/routes';
import { installed as edgeInstalled } from '../edge/spec';
import { attachNetwork, containerNetwork } from '../edge/networks';
import { running as edgeRunning, portHolder } from '../edge/engine';
import { ensureRunning } from '../edge/runtime';
import { type IssuerSpec, ensureCertManager } from '../kube/certmanager';
import { ensureIngress } from '../kube/ingress';
import { ensureKubeconfig } from '../kube/cluster';
import { type ClusterPlan, isLocalCluster } from '../kube/context';
import { preflight } from '../kube/probe';
import { type Preflight } from '../kube/tools';
import {
  type IngressEndpoint,
  endpointString,
  hostPortClaim,
  ingressEndpoint,
  kindNodeContainer,
} from '../kube/endpoints';
import * as paths from '../runner/paths';
import { readMeta, recorded } from '../runner/record';

import {
  PUBLISH_PROOF_PAUSE,
  PUBLISH_PROOF_TRIES,
  type CreateReq,
  type KubeTls,
  kubeTls,
} from './types';

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value !== '';
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
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

function realSleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * (https, domain) an EXISTING workspace was created with, or null.
 *
 * Read from repro.json rather than remembered in the request, because the `up` that
 * brings a workspace back is a different invocation -- usually a different day -- from
 * the one that gave it a name.
 */
export async function tlsFromRecord(name: string): Promise<[boolean, string] | null> {
  if (!name || !(await paths.exists(name))) return null;
  let meta;
  try {
    meta = await readMeta(name);
  } catch {
    // half-written record
    return null;
  }
  const extra = meta.extra;
  const mode = extra.tls;
  if (!isTruthy(mode) || !meta.publicUrl) return null;
  if (mode === MODE_LOCAL) return [true, ''];
  const host = meta.publicUrl.split('://').slice(-1)[0]?.split('/')[0] ?? '';
  return host ? [false, host] : null;
}

/**
 * The `.localhost` name this workspace already holds a certificate for, or "".
 *
 * A local-CA hostname used to be re-derivable from the workspace name plus the suffix,
 * so nothing had to remember it. Renaming the tool changed the suffix, and a later `up`
 * would then mint a SECOND hostname for a workspace whose issued leaf, whose Traefik
 * route and whose Rocket.Chat ROOT_URL all still say the first one.
 */
export async function recordedLocalHost(name: string): Promise<string> {
  const url = await recorded(name, 'public_url');
  const host = urlHostname(url);
  return host && host.endsWith('.localhost') ? host : '';
}

/**
 * Whether `host` resolves to the address the cluster's ingress answers on.
 *
 * Unresolvable is true, deliberately: a `--domain` whose DNS has not propagated yet is
 * the normal case for a name being set up. The case this exists to catch is a name that
 * resolves SOMEWHERE ELSE, which is a fact rather than a not-yet.
 */
export async function nameReaches(
  host: string,
  claim: { address: string } | null,
): Promise<boolean> {
  const address = claim === null ? '' : String(claim.address);
  if (!address) return false;
  let addrs: string[];
  try {
    addrs = (await lookup(host, { all: true })).map((entry) => entry.address);
  } catch {
    // Any resolver failure is an OS error, and every one answers the same way.
    return true;
  }
  return addrs.includes(address);
}

/**
 * Choose the ACME challenge. Not a flag -- there is a right answer.
 *
 * TLS-ALPN-01 is the default and what the official compose uses. It needs Let's Encrypt
 * to reach this host on 443, which is impossible behind NAT, behind a tunnel, or behind
 * a proxy that terminates TLS in front of the origin.
 *
 * dns-01 needs none of that: the provider's API writes a TXT record and Let's Encrypt
 * never connects here. So it is selected exactly when credentials for it exist, which is
 * the only signal that says "the operator set this up on purpose".
 */
export function pickChallenge(
  req: CreateReq,
  cfg: Record<string, unknown>,
  emit: Emit = nullEmit,
): void {
  if (dnsEnvVars().length === 0) {
    req.acmeChallenge = 'tlsalpn';
    return;
  }
  let provider = isTruthy(cfg.acme_dns_provider) ? String(cfg.acme_dns_provider) : '';
  if (!provider) {
    const [found, why] = inferDnsProvider();
    provider = found;
    if (!provider) {
      // Credentials are present but unreadable as a provider. Falling back to tlsalpn
      // silently would ignore a file the user deliberately created.
      throw new ValidationError(
        `${dnsEnvPath()} exists, so dns-01 was assumed, but the ` +
          `provider could not be worked out: ${why}.\n` +
          '  Name it with `houston config set acme.dns_provider <name>` — ' +
          `providers and their variables: ${LEGO_PROVIDER_DOCS}\n` +
          '  Or delete the file to use the inbound challenge instead.',
      );
    }
  }
  const [ok, detail] = dnsCredentials(provider);
  if (!ok) throw new ValidationError(detail);
  req.acmeChallenge = 'dns';
  req.acmeDnsProvider = provider;
  info(
    emit,
    `using the dns-01 challenge via ${provider} (${detail}) — no inbound ` +
      'connection needed, so the workspace stays on loopback',
    { phase: 'tls' },
  );
}

/** Which ACME challenge this request means, and what each one implies about the bind. */
export function challengeMode(domain: string, emit: Emit, req: CreateReq): string {
  const cfg = config.loadConfig();
  let mode: string;
  if (domain) {
    mode = MODE_ACME;
    // DOMAIN + LETSENCRYPT_EMAIL, the two the official compose asks for. The email is
    // remembered so only the first run needs it.
    req.acmeEmail = req.acmeEmail || toText(cfg.acme_email);
    if (!req.acmeEmail) {
      throw new ValidationError(
        "a Let's Encrypt certificate needs a contact email:\n" +
          '  houston up ... --domain ' +
          domain +
          ' --email you@example.com\n' +
          'It is remembered after the first use, or set it once with:\n' +
          '  houston config set acme.email you@example.com',
      );
    }
    // `config.truthy`, not a truth test: a config written by an older houston holds the
    // STRING "false", which a truth test reads as true -- so staging could never be turned
    // back off.
    req.acmeStaging = req.acmeStaging || config.truthy(cfg.acme_staging);
    pickChallenge(req, cfg, emit);
  } else {
    mode = MODE_LOCAL;
  }

  // The workspace stays on loopback whatever the challenge. It publishes no TLS port at
  // all now, so there is nothing for Let's Encrypt to connect TO here -- the EDGE answers
  // the TLS-ALPN challenge on 443, for every name it serves.
  req.bindPublic = false;

  return mode;
}

/**
 * Turn the --https flags into a tls.TlsSpec, or null when --https is absent.
 *
 * Validates here rather than letting Traefik fail at boot: a bad combination otherwise
 * produces a repro that comes up and serves nothing, with the reason only in `docker
 * compose logs traefik`.
 */
export async function resolveTls(
  req: CreateReq,
  reproName: string,
  bindHost: string,
  exclude = '',
  emit: Emit = nullEmit,
): Promise<TlsSpec | null> {
  // A domain means HTTPS; requiring --https alongside it was ceremony. --https on its own
  // selects the local-CA mode, which needs nothing else.
  if (!(req.https || req.domain || req.acmeEmail)) {
    // ...unless this workspace ALREADY has an https name. `down` then `up` is the
    // documented way to bring a workspace back ("data intact"), and it silently dropped
    // TLS: the record went on claiming public_url while nothing served it.
    const restored = await tlsFromRecord(exclude || reproName);
    if (restored === null) return null;
    [req.https, req.domain] = restored;
    if (!(req.https || req.domain)) return null;
    info(
      emit,
      'restoring the https name this workspace already had' +
        (req.domain ? ` (${req.domain})` : ''),
      { phase: 'tls' },
    );
  }
  void bindHost;

  // Normalized before anything else reads it: it becomes ROOT_URL, the Host() router rule
  // and a TLS SNI name, so a scheme or trailing slash surviving this far corrupts all
  // three at once.
  let domain = '';
  if (req.domain) {
    const [normalized, fixed] = normalizeDomain(req.domain);
    domain = normalized;
    if (fixed) req.domain = domain; // so downstream and repro.json agree with reality
  }

  const mode = challengeMode(domain, emit, req);
  const host = domain || (await recordedLocalHost(reproName)) || localHostFor(reproName);
  // Every name answers on the edge's 443. No port is allocated per workspace and no port
  // is probed: this workspace terminates no TLS, so there is nothing to conflict with.
  const port = 443;

  // ONE NAME, ONE WORKSPACE. Both runtimes come through here, so this is the single place
  // the collision can be refused.
  const taken = hostOwner(host, { excluding: exclude || reproName });
  if (taken) {
    throw new ConflictError(
      `${host} is already served for workspace '${taken}', and the edge routes by ` +
        'hostname -- two claims on one name means Traefik picks one and the other ' +
        'silently never answers. Use a different name, or `houston down --name ' +
        `${taken}\` first.`,
    );
  }

  return tlsSpec({
    mode,
    host,
    port,
    acmeEmail: req.acmeEmail,
    acmeStaging: req.acmeStaging,
    acmeChallenge: req.acmeChallenge,
    acmeDnsProvider: req.acmeDnsProvider,
  });
}

/**
 * Put the name in front of the cluster. BEFORE the chart, and that is not tidiness.
 *
 * An ACME order starts the moment cert-manager sees the Ingress -- which the chart
 * creates during `helm install` -- and the http-01 challenge arrives on this host's :80.
 * If the edge is not up and the route is not written by then, Let's Encrypt gets a
 * connection refused, the order fails, and `waitForCertificate` spends its whole budget
 * on a challenge that could never have been answered.
 *
 * Writing the route early is harmless in the other direction: it points at the cluster's
 * ingress, which exists whether or not this workspace does.
 */
export async function routeKubernetesName(
  name: string,
  ktls: KubeTls,
  { emit = nullEmit }: { emit?: Emit } = {},
): Promise<void> {
  if (!ktls.clusterOwns443) {
    if (!(await edgeRunning())) {
      info(emit, 'starting the edge (one Traefik, :80 and :443 for every name)', { phase: 'tls' });
      const started = await ensureRunning();
      if (!started.ok) {
        const holder = await portHolder(443);
        const because = holder
          ? ` — ${holder} is holding :443`
          : started.why
            ? ` — ${started.why}`
            : '';
        warn(
          emit,
          `the edge did not start${because}, so ${ktls.host} will not ` +
            'answer yet. The workspace itself is unaffected; free the ' +
            'port and `houston edge start`.',
          { phase: 'tls' },
        );
      }
    }
  }
  if (edgeInstalled()) {
    // THE EDGE MAY NOT BE ABLE TO REACH THE ENDPOINT YET. A kind cluster's node is a
    // container on kind's own Docker network, so its ingress NodePort answers from the
    // host and not from a container on the default bridge. Joining is the same mechanism
    // `attach` uses for a workspace's network, applied to the cluster's.
    const node = kindNodeContainer(String(ktls.context || ''));
    if (node) {
      const net = await containerNetwork(node);
      if (net && (await attachNetwork(net))) {
        info(
          emit,
          `the edge joined the cluster's Docker network (${net}) — ` +
            'its ingress is not reachable from the default bridge',
          { phase: 'tls' },
        );
      }
    }
    await registerRoute(name, ktls.host, { passthrough: endpointString(ktls.endpoint) });
    info(
      emit,
      `${ktls.host} → ${endpointString(ktls.endpoint)} (${ktls.endpoint.source}), passed ` +
        'through untouched — TLS terminates in the cluster',
      { phase: 'tls' },
    );
  } else if (ktls.clusterOwns443) {
    info(
      emit,
      `${ktls.host} is served by the cluster's own ingress, which holds ` +
        "this host's :443 — no edge needed",
      { phase: 'tls' },
    );
  }
}

/** What the probe found, in terms the reader can act on. */
export function reportWhatTheNameServes(
  certReady: boolean,
  emit: Emit,
  ktls: KubeTls,
  name: string,
  seen: { serving?: boolean; fallback?: boolean; issuer?: string; error?: string },
): void {
  if (seen.fallback && !certReady) {
    // THE ORDINARY CASE, and it was being reported as the alarming one. An ingress
    // controller serves its OWN default certificate for a name it has no certificate for
    // yet -- so while cert-manager is still working through the ACME order, the cluster
    // answers with exactly the certificate this branch used to blame on "something in
    // front". `certReady` is false here, which says plainly that nothing was issued in
    // time.
    warn(
      emit,
      `${ktls.host} is answering with the ingress controller's own ` +
        `default certificate (${seen.issuer ?? ''}) because cert-manager ` +
        'has not issued one yet — the ACME order is usually still ' +
        `running. The workspace is up. \`houston tls-status --name ` +
        `${name}\` re-checks it, and \`kubectl -n houston-${name} get ` +
        'certificate` says what cert-manager is waiting on.',
      { phase: 'tls' },
    );
  } else if (seen.fallback) {
    // The certificate IS issued and the name still answers with somebody's default one,
    // so the cluster is not the thing terminating TLS for it.
    warn(
      emit,
      `${ktls.host} answered with a proxy's own default certificate ` +
        `(${seen.issuer ?? ''}), not the one in the cluster — the ` +
        'certificate was issued, so something in front is terminating TLS ' +
        'for this name instead of passing it through. `houston doctor` ' +
        "names a cluster holding this host's ports.",
      { phase: 'tls' },
    );
  } else if (!seen.serving) {
    warn(
      emit,
      `nothing answered TLS for ${ktls.host} yet ` +
        `(${seen.error ?? 'no certificate offered'}). The workspace ` +
        `is up on its port-forward; \`houston tls-status --name ${name}\` ` +
        're-checks the name.',
      { phase: 'tls' },
    );
  } else {
    info(emit, `https://${ktls.host} is serving the cluster's certificate (${seen.issuer ?? ''})`, {
      phase: 'tls',
    });
  }
}

/**
 * Put the name in front of the cluster, and then CHECK it rather than claim it.
 *
 * Two topologies, both normal, and the difference decides whether the edge is needed at
 * all. The check at the end is the part that matters: measured on a box where the edge
 * was bound, running, healthy, and answering every https name with its own default
 * certificate because the cluster had taken the port underneath it.
 */
export async function publishKubernetesName(
  name: string,
  ktls: KubeTls,
  {
    certReady = true,
    emit = nullEmit,
    sleep = realSleep,
  }: { certReady?: boolean; emit?: Emit; sleep?: (seconds: number) => Promise<void> } = {},
): Promise<void> {
  // ONLY for the local issuer. A Let's Encrypt certificate is checked against the SYSTEM
  // store -- that is the whole claim being made about it -- and houston's own CA may not
  // even exist on a box that has only ever used `--domain`.
  const cafile = (ktls.issuer?.mode ?? 'local') !== 'acme' ? `${caDir()}/${CA_CRT}` : '';
  let seen: Awaited<ReturnType<typeof verify>> | null = null;
  for (let attempt = 0; attempt < PUBLISH_PROOF_TRIES; attempt += 1) {
    seen = await verify(ktls.host, cafile ? { port: 443, cafile } : { port: 443 });
    if (seen.serving && !seen.fallback) break;
    if (attempt < PUBLISH_PROOF_TRIES - 1) await sleep(PUBLISH_PROOF_PAUSE);
  }
  reportWhatTheNameServes(certReady, emit, ktls, name, seen ?? {});
}

/** Every reason this name cannot be served, checked before anything is installed. */
export async function refuseANameThatWillNotReach(
  claim: { address: string; ports?: number[] } | null,
  emit: Emit,
  endpoint: IngressEndpoint | null,
  remoteIngress: boolean,
  spec: { mode: string },
  tlsspec: TlsSpec,
): Promise<boolean> {
  const endpointAddress = endpoint === null ? '' : endpoint.address;
  if (spec.mode === 'acme') {
    info(
      emit,
      remoteIngress
        ? "the http-01 challenge goes straight to the cluster's own load " +
            `balancer (${endpointAddress}) — this machine is not in the path`
        : claim !== null && (claim.ports ?? []).includes(80)
          ? "the http-01 challenge will reach the cluster's ingress directly " +
            "— it holds this host's :80"
          : "the http-01 challenge arrives on the edge's :80 and is redirected " +
            'onto the passthrough, which reaches the cluster',
      { phase: 'tls' },
    );
  }
  // WHETHER THIS HOSTNAME REACHES THE CLUSTER, not whether the cluster holds *a* host
  // address. k3s ServiceLB claims :443 at the host's own address, so `claim` said yes --
  // while `<name>.houston.localhost` resolves to ::1 first, klipper's DNAT is IPv4-only,
  // and the edge is what answers there.
  let owns = claim !== null && (claim.ports ?? []).includes(443);
  if (owns && !(await nameReaches(tlsspec.host, claim))) {
    info(
      emit,
      `${tlsspec.host} does not resolve to the cluster's ingress ` +
        `(${claim === null ? '' : claim.address}), so the name is published through the edge ` +
        'rather than straight at the cluster',
      { phase: 'tls' },
    );
    owns = false;
  }
  // A REMOTE INGRESS CANNOT BE FRONTED BY A LOCAL EDGE, so there is nothing here to
  // decide. `claim` asks whether the cluster holds THIS HOST's :443, which for any
  // managed cluster is definitionally no.
  return owns;
}

/**
 * cert-manager and an ingress controller, and where the cluster is receiving.
 *
 * ADOPT WHAT IS THERE, INSTALL WHAT IS NOT -- and this is the FIRST thing on this path
 * that changes the cluster, which is why every refusal above it is a read.
 */
export async function installTheIngressMachinery(
  asked: string,
  context: string,
  emit: Emit,
  plan: ClusterPlan,
  pre: Preflight,
  req: CreateReq,
): Promise<[Awaited<ReturnType<typeof hostPortClaim>>, IngressEndpoint, string]> {
  const where = pre.distribution || plan.distribution;
  // THE GUIDE'S TWO PREREQUISITES, in the order they depend on each other. Both are
  // adopted when the cluster has them and installed with the guide's own command when it
  // does not; both refuse on a cluster that is not on this machine, where CRDs and a
  // LoadBalancer are somebody else's to create; and neither is ever removed.
  //
  // cert-manager first: it is what the ingress annotation will name, and an issuer
  // created before its webhook is serving is accepted and then never reconciled.
  await ensureCertManager({ context, distribution: where, emit });
  const ingressClass = await ensureIngress({
    context,
    distribution: where,
    prefer: req.ingressClass,
    emit,
  });
  // AFTER `ensureIngress`, because on a cluster that had none the ingress Service is
  // something houston has just created. Read before it, this found nothing and refused
  // for want of the thing it was about to install.
  const endpoint = await ingressEndpoint(context);
  if (endpoint === null) {
    throw new PreflightError(
      `${asked}: cluster '${context}' has the ingress class '${ingressClass}' but ` +
        'no Service publishing :443 that can be reached from outside it, so ' +
        "nothing can route to this workspace's name. `kubectl get svc -A` — the " +
        "controller's Service needs to be a LoadBalancer or a NodePort. An " +
        'ingress exposed by a hostPort DaemonSet has none to find.',
    );
  }
  const claim = await hostPortClaim(context);
  return [claim, endpoint, ingressClass];
}

/**
 * Bring the cluster up if it is ours to, probe it, and refuse a local CA it cannot be
 * taught to trust.
 *
 * THE CLUSTER HAS TO EXIST BEFORE IT CAN BE ASKED ANYTHING. This used to refuse outright
 * when `plan.create` was set -- there was nothing to probe and houston installed no
 * ingress controller, so `--https` on a box whose only Kubernetes was a not-yet-created
 * kind cluster was a dead end.
 */
export async function probeTheCluster(
  emit: Emit,
  plan: ClusterPlan,
  spec: { mode: string },
): Promise<[string, Preflight]> {
  const context = plan.create ? await ensureKubeconfig(plan, emit) : plan.context;
  const pre = await preflight(context);
  // WHERE THE CA KEY WOULD GO. `tls-local.ts`: this key "can mint a certificate for any name
  // the browser will trust". On this machine's own cluster that is the same trust boundary
  // as the box. On somebody else's it is not, and there is a better answer that needs no
  // CA at all.
  if (spec.mode === 'local' && !isLocalCluster(pre.distribution || plan.distribution)) {
    throw new AuthorityGateError(
      "--https would copy houston's CA private key into a Secret in cluster " +
        `'${context}', which is not on this machine ` +
        `(${pre.distribution || plan.distribution || 'unknown'}). That key can ` +
        'mint a certificate for any name this box trusts, so it does not leave ' +
        'here. Use --domain for a publicly-trusted certificate instead, or ' +
        'reach the workspace on its port-forward.',
      { code: 'GATE_UNAPPROVED_CLUSTER' },
    );
  }
  return [context, pre];
}

/**
 * Refuse, or return what the ingress needs. Reads only; writes nothing.
 *
 * Every refusal here costs one probe and no state. That ordering is the point: an
 * `up --https` that cannot work should say so in a second, not after four minutes of
 * MongoDB and a chart install.
 */
export async function kubernetesTlsPlan(
  req: CreateReq,
  tlsspec: TlsSpec,
  plan: ClusterPlan,
  { emit = nullEmit }: { emit?: Emit } = {},
): Promise<KubeTls> {
  // Both modes are honoured now, and they are the same code path with a different
  // ClusterIssuer -- which is what the official values.yaml already implies.
  const spec: IssuerSpec = {
    mode: tlsspec.mode === MODE_ACME ? 'acme' : 'local',
    acmeEmail: tlsspec.acmeEmail,
    acmeStaging: tlsspec.acmeStaging,
  };
  // Which request every refusal below is about. Defined here, beside the spec it is
  // derived from, because the first refusal comes before the cluster is even probed.
  const asked = spec.mode === 'acme' ? '--domain' : '--https';
  const [context, pre] = await probeTheCluster(emit, plan, spec);
  const [claim, endpoint, ingressClass] = await installTheIngressMachinery(
    asked,
    context,
    emit,
    plan,
    pre,
    req,
  );
  const remoteIngress = !endpoint.local;
  let owns = await refuseANameThatWillNotReach(claim, emit, endpoint, remoteIngress, spec, tlsspec);
  if (!owns && remoteIngress) owns = true;
  return kubeTls({
    host: tlsspec.host,
    ingressClass,
    endpoint: { ...endpoint },
    issuer: spec,
    context,
    clusterOwns443: owns,
  });
}
