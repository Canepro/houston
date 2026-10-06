/**
 * HTTPS on this box, as the terminal sees it: `edge`, `tls-status` and `trust-ca`.
 *
 * Both commands are `json: none`, so what they print and the code they exit with IS their
 * contract -- and an earlier version answered them with a dump of the service result:
 * `edge status` a key/value panel of four raw fields, `edge stop` "✓ edge stopped" over a
 * compose that could not run, `edge delete` "removed" whatever went, and `tls-status` every
 * field of the probe report and exit 0 with nothing serving TLS at all, where the
 * established answer says why, says what to check, and exits 1. A script that branches on
 * `tls-status` read a broken name as a healthy one.
 *
 * Output is what the CLI has always written off a terminal: every prose line on stdout,
 * `error: ...` on stderr through the thrown `ReproError`.
 */

import * as config from '../../lib/config';
import { ReproError } from '../../lib/errors';
import { joinPath } from '../../lib/home';
import { fileErrorText, quotedText, splitTextLines, isTruthy } from '../../lib/format';
import { Aborted, type CliIo } from '../app';
import { portClaimNote, reportGuiTls } from '../serve';

// Where the CLI's other TLS verbs find them; they live beside `serve`, their lowest caller.
export { portClaimNote, reportGuiTls };
import { say, writePanel } from '../render';

import type * as AcmeNS from '../../core/edge/acme';
import type * as AuditNS from '../../core/audit';
import type * as CertManagerNS from '../../core/kube/certmanager';
import type * as EdgeEngineNS from '../../core/edge/engine';
import type * as EdgePathsNS from '../../core/edge/paths';
import type * as EdgeRoutesNS from '../../core/edge/routes';
import type * as EdgeRuntimeNS from '../../core/edge/runtime';
import type * as EdgeSpecNS from '../../core/edge/spec';
import type * as EdgeTypesNS from '../../core/edge/types';
import type * as NamingNS from '../../core/lifecycle/naming';
import type * as RecordNS from '../../core/runner/record';
import type * as TlsNS from '../../core/tls';
import type * as TlsLocalNS from '../../core/tls-local';
import type * as TopologyNS from '../../core/topology';
import type * as ExecNS from '../../seams/exec';

type Metadata = RecordNS.Metadata;
type TlsReport = TlsNS.TlsReport;
export type Confirm = (question: string) => Promise<boolean>;

/** The staging -> production command, rebuilt from what this workspace actually used. */
export function promoteCommand(meta: Metadata, host: string): string {
  const email = String(meta.extra.tls_email ?? '') || '<you@example.com>';
  return [
    `houston up -v ${meta.rcVersion}`,
    `--name ${meta.name}`,
    `--domain ${host}`,
    `--email ${email}`,
    '--force',
    '--wait',
  ].join(' ');
}

// --- edge ---------------------------------------------------------------------------

/** The hostname a route file serves, for display only. `?` when it declares none. */
function edgeRouteHost(name: string): string {
  const routes = require('../../core/edge/routes') as typeof EdgeRoutesNS;
  return routes.routeHost(name) || '?';
}

/** Bring the front door up, and say what it is now holding. */
async function edgeStart(io: CliIo, action: string): Promise<void> {
  if (action !== 'start' && action !== 'restart') return;
  const runtime = require('../../core/edge/runtime') as typeof EdgeRuntimeNS;
  // RENDERED, not raised: a ConflictError here is an edge from another HOUSTON_HOME
  // holding the port, a real and actionable condition. It propagates as the red line.
  const started = (await runtime.up({ pull: false })).returncode === 0;
  if (!started) {
    throw new ReproError(
      'the edge did not start. Check nothing else holds :80 or :443:\n    sudo lsof -i :443',
    );
  }
  // BOUND IS NOT REACHABLE.
  const claim = await portClaimNote();
  if (claim !== '') say(io, `  ⚠ edge running, but NOT reachable — ${claim}`);
  else say(io, '✓ edge running — every registered name is served again.');
}

/** `edge start|stop|restart`: move the front door without losing its routes. */
async function edgeLifecycle(io: CliIo, action: string): Promise<number> {
  const spec = require('../../core/edge/spec') as typeof EdgeSpecNS;
  const types = require('../../core/edge/types') as typeof EdgeTypesNS;
  const engine = require('../../core/edge/engine') as typeof EdgeEngineNS;
  if (!spec.installed() && action !== 'stop') {
    await spec.write(types.edge());
  } else if (action === 'start' || action === 'restart') {
    // RE-RESOLVE FROM CONFIG, so a changed `acme.challenge` or `acme.staging` reaches the
    // container; rebuilt from the recorded spec, which is why the spec is recorded.
    const current = spec.current();
    if (current !== null) {
      await spec.write(
        types.resolveEdge(current.domain, current.acmeEmail, {
          guiHost: current.guiHost,
          guiPort: current.guiPort,
          httpPort: current.httpPort,
          httpsPort: current.httpsPort,
        }),
      );
    }
  }
  if (action === 'stop' || action === 'restart') {
    // NOTHING TO STOP IS NOT A FAILURE, AND NOT A SUCCESS EITHER.
    if (!spec.installed()) {
      say(
        io,
        'no edge is set up in this home — nothing to stop. If a name is still being ' +
          'served, the edge belongs to another HOUSTON_HOME; `houston edge status` says so.',
      );
      return 0;
    }
    // AND THE EXIT CODE IS READ: a compose that could not run reported the ports free.
    if ((await engine.down()) !== 0) {
      throw new ReproError(
        'could not stop the edge — `docker compose -p houston_edge ps` says what is still there.',
      );
    }
    say(io, '✓ edge stopped; it no longer holds :80 or :443.');
  }
  await edgeStart(io, action);
  return 0;
}

/** Whether the certificate is really gone, which depends on who is running Traefik. */
async function reportAcmeDeletion(io: CliIo, gone: EdgeRuntimeNS.HostDeletion): Promise<void> {
  const engine = require('../../core/edge/engine') as typeof EdgeEngineNS;
  if (gone.acme.length === 0) return;
  say(io, `✓ Let's Encrypt certificate removed from ${gone.acme.join(', ')}`);
  if (gone.foreign !== '') {
    say(
      io,
      `the edge holding :443 belongs to another HOUSTON_HOME (${gone.foreign}), and it ` +
        "reads its OWN certificate store — so what was just deleted is this home's copy, " +
        'not the certificate that name is being served with. Run this there, with that ' +
        'HOUSTON_HOME.',
    );
  } else if (gone.restarted === true) {
    say(
      io,
      'the edge was restarted so Traefik reloads the store — it holds it in memory and ' +
        'rewrites the whole file, so an edit made underneath it comes back. Every other ' +
        'name is served again; routes are files.',
    );
  } else if (gone.restarted === false) {
    say(
      io,
      'the edge did not come back cleanly — `houston edge status`. Until it restarts, ' +
        'Traefik may write the deleted entry back from memory.',
    );
  } else if (!(await engine.running())) {
    say(io, 'the edge is stopped, so nothing can write the entry back.');
  }
}

/** `edge delete`: forget one name, with the refusals that protect a live one. */
async function edgeDelete(
  io: CliIo,
  host: string,
  yes: boolean,
  confirm: Confirm,
): Promise<number> {
  const spec = require('../../core/edge/spec') as typeof EdgeSpecNS;
  const runtime = require('../../core/edge/runtime') as typeof EdgeRuntimeNS;
  if (!spec.installed()) {
    say(io, 'no edge in this home, so it holds no names — nothing to delete.');
    return 0;
  }
  if (host === '') {
    throw new ReproError(
      'name the host: `houston edge delete <host>`. `houston edge status` lists what this ' +
        'edge routes and what it holds a certificate for.',
    );
  }
  // The prompt names what goes: "delete <host>" reads like removing a route, and it is
  // removing a private key.
  if (
    !yes &&
    !(await confirm(
      `delete ${host} — its route, its certificate, its PRIVATE KEY and its ` +
        "Let's Encrypt entry? This cannot be undone",
    ))
  ) {
    throw new Aborted();
  }
  const gone = await runtime.deleteHost(host, { confirm: true });
  // Reported per kind, and only what actually went.
  for (const name of gone.routes) {
    say(
      io,
      `✓ route ${name} removed` +
        (gone.passthrough.includes(name)
          ? ' (passthrough — its certificate is in the cluster, and went with the namespace)'
          : ''),
    );
  }
  if (gone.certificate) say(io, `✓ certificate and key for ${gone.host} removed`);
  if (gone.declaration) say(io, `✓ certificate declaration for ${gone.host} removed`);
  await reportAcmeDeletion(io, gone);
  if (!(gone.routes.length > 0 || gone.certificate || gone.declaration || gone.acme.length > 0)) {
    say(
      io,
      `nothing here for ${gone.host} — no route, no certificate, no ACME entry. Already ` +
        'clean, or the name belongs to another HOUSTON_HOME.',
    );
    return 0;
  }
  if (gone.kept.length > 0) {
    say(
      io,
      `kept ${gone.kept.join(', ')} — the issuance ledger is what \`tls-status\` counts ` +
        "against Let's Encrypt's five-a-week duplicate limit. Deleting the certificate " +
        'does NOT give the budget back; re-issuing the same name still counts.',
    );
  }
  return 0;
}

/** Certificates and ACME entries no route claims any more. */
function reportStrayCertificates(io: CliIo, domain: string, routes: readonly string[]): void {
  const acme = require('../../core/edge/acme') as typeof AcmeNS;
  const paths = require('../../core/edge/paths') as typeof EdgePathsNS;
  // Declared and unservable: silent apart from a log nobody was pointed at.
  const orphans = acme.orphanCerts();
  if (orphans.length > 0) {
    say(
      io,
      `  ⚠ ${String(orphans.length)} name(s) declared with no certificate file — ` +
        `${orphans.slice(0, 3).join(', ')}${orphans.length > 3 ? '…' : ''}. Traefik logs ` +
        "'failed to find any PEM data' for each, once a second, and serves none of them. " +
        `\`houston edge logs\`; if ${paths.certsDir()} is root-owned (Docker creates a ` +
        'missing bind-mount target that way), `sudo chown -R $(id -u):$(id -g) ' +
        `${paths.certsDir()}\` and re-run \`up\` for those workspaces.`,
    );
  }
  // Certificates with nothing pointing at them: a name cannot be cleaned up until it can
  // be SEEN.
  const claimed = new Set(routes.map((name) => edgeRouteHost(name).toLowerCase()));
  claimed.add(domain.toLowerCase());
  const stale = acme.acmeHosts().filter((host) => !claimed.has(host.toLowerCase()));
  if (stale.length > 0) {
    say(
      io,
      `  ⚠ ${String(stale.length)} certificate(s) held with no route — ` +
        `${stale.slice(0, 3).join(', ')}${stale.length > 3 ? '…' : ''}. Each is a Let's ` +
        'Encrypt certificate AND private key on this disk for a name nothing serves. ' +
        '`houston edge delete <host>` removes one.',
    );
  }
}

/** `edge status`: what the front door is serving, and for whom. */
async function edgeStatus(io: CliIo): Promise<number> {
  const runtime = require('../../core/edge/runtime') as typeof EdgeRuntimeNS;
  const spec = require('../../core/edge/spec') as typeof EdgeSpecNS;
  const paths = require('../../core/edge/paths') as typeof EdgePathsNS;
  const routes = require('../../core/edge/routes') as typeof EdgeRoutesNS;
  const st = await runtime.status();
  if (!st.installed) {
    say(io, 'no edge yet — it starts with the first `--https` or `--domain` workspace.');
    return 0;
  }
  const domain = spec.servedDomain();
  const rows: [string, string][] = [
    ['State', st.running ? 'running' : 'STOPPED'],
    ['Project', `${paths.PROJECT} (${paths.edgeDir()})`],
  ];
  if (domain !== '') rows.push(['GUI name', domain]);
  writePanel(io, 'houston edge', rows);
  if (!st.running && (st.routes.length > 0 || domain !== '')) {
    say(
      io,
      '  ⚠ every https name on this box is unreachable while it is stopped — `houston edge start`',
    );
  } else if (!st.running) {
    // Nothing to reach: "every https name is unreachable" above "no names registered yet"
    // was the same false alarm doctor raised about a box that had finished with HTTPS.
    say(io, '  stopped — no https workspace uses it; `houston edge start` when one does.');
  } else {
    // "running" was the whole answer here, and running is not reachable.
    const claim = await portClaimNote();
    if (claim !== '') say(io, `  ⚠ running but NOT reachable — ${claim}`);
  }
  reportStrayCertificates(io, domain, st.routes);
  if (st.routes.length === 0) {
    say(io, '  no names registered yet.');
    return 0;
  }
  // Attachment and route side by side: a route whose network the edge never joined is a
  // 502, not an error, and that is the hardest failure to read.
  say(io, `\n${'NAME'.padEnd(28)} ${'SERVES'.padEnd(38)} REACHABLE`);
  for (const name of st.routes) {
    const ok = await routes.routeReachable(name, st.attached);
    say(io, `${name.padEnd(28)} ${edgeRouteHost(name).padEnd(38)} ${ok ? 'yes' : 'NO (502)'}`);
  }
  return 0;
}

/** `houston edge <action> [host]`. Returns the exit code; a refusal is thrown. */
export async function edgeCommand(
  io: CliIo,
  action: string,
  host: string,
  { follow = false, tail = 200, yes = false }: { follow?: boolean; tail?: number; yes?: boolean },
  confirm: Confirm,
): Promise<number> {
  const spec = require('../../core/edge/spec') as typeof EdgeSpecNS;
  const engine = require('../../core/edge/engine') as typeof EdgeEngineNS;
  const runtime = require('../../core/edge/runtime') as typeof EdgeRuntimeNS;
  if (action === 'logs') {
    // WHERE HTTPS FAILS, and there was no way to read it from here.
    if (!spec.installed()) {
      say(
        io,
        'no edge yet — nothing to show. It starts with the first `--https` or `--domain` ' +
          'workspace, or `serve --domain`.',
      );
      return 0;
    }
    if (!(await engine.running())) {
      say(
        io,
        'the edge is STOPPED — this is whatever it said before it stopped. `houston edge start`',
      );
    }
    return await runtime.logs({ tail, follow });
  }
  if (action === 'status') return await edgeStatus(io);
  if (action === 'delete') return await edgeDelete(io, host, yes, confirm);
  if (action === 'start' || action === 'stop' || action === 'restart') {
    return await edgeLifecycle(io, action);
  }
  throw new ReproError(
    `unknown action ${quotedText(action)} (want: status | start | stop | restart | logs | delete <host>)`,
  );
}

// --- tls-status -----------------------------------------------------------------------

/** The next things to actually check, ordered by how often they are the cause. */
export function tlsTroubleshoot(
  io: CliIo,
  meta: Metadata,
  mode: string,
  host: string,
  port: number,
): void {
  const topology = require('../../core/topology') as typeof TopologyNS;
  say(io, `  Rocket.Chat itself is fine at ${meta.rootUrl} - this is the TLS layer.`);
  // A KUBERNETES WORKSPACE'S CERTIFICATE IS NOT THE EDGE'S, so none of the advice below
  // applies to it: sending someone to `edge logs` for a certificate the edge never saw is
  // the whole reason this branch exists.
  if (topology.ofMeta(meta) === topology.KUBERNETES) {
    const certmanager = require('../../core/kube/certmanager') as typeof CertManagerNS;
    const ns = String(meta.extra.namespace ?? '') || meta.project || '';
    say(
      io,
      '  TLS terminates in the cluster, from a Secret cert-manager filled — the edge only ' +
        'forwards the raw connection, so its log has nothing about this name.',
    );
    say(io, '  Most likely, in order:');
    say(io, '    1. the Certificate is not Ready yet, or says why it is not');
    say(
      io,
      '    2. the ClusterIssuer is not Ready (created before cert-manager, or no egress for an ACME order)',
    );
    say(
      io,
      "    3. nothing routes to the ingress — `houston doctor` names a cluster holding this host's ports",
    );
    say(io, '  What cert-manager says:');
    say(io, `    kubectl -n ${ns} describe certificate ${certmanager.tlsSecretFor(meta.name)}`);
    say(
      io,
      `    kubectl describe clusterissuer ${mode === 'acme' ? certmanager.ACME_ISSUER : certmanager.CA_ISSUER}`,
    );
    if (mode === 'acme') {
      say(io, `    kubectl -n ${ns} get order,challenge`);
      say(
        io,
        '  Debug on staging (`houston config set acme.staging true`): production allows only ' +
          `5 failed validations per hour for ${host}.`,
      );
    }
    return;
  }
  if (mode === 'acme') {
    say(io, '  Most likely, in order:');
    say(
      io,
      `    1. inbound TCP/${String(port)} not reachable from the internet (cloud security group / host firewall)`,
    );
    say(io, `    2. DNS: \`dig +short ${host}\` must return this host's PUBLIC IP`);
    say(
      io,
      "    3. behind Cloudflare's orange cloud? it terminates TLS, so tlsalpn cannot work - " +
        'put a provider token in ~/.houston/acme/dns.env to switch to dns-01',
    );
    say(io, `  What Traefik says:  houston logs --name ${meta.name} | grep -i acme`);
    say(
      io,
      `  Debug on staging (--acme-staging): production allows only 5 failed validations per hour for ${host}.`,
    );
  } else {
    say(io, `  Check Traefik started:  houston logs --name ${meta.name} | grep -i traefik`);
  }
}

/** Ask THIS host, on both loopback families, what it is really serving. */
async function probeTlsEndpoint(
  cafile: string,
  host: string,
  meta: Metadata,
  port: number,
): Promise<TlsReport> {
  const tls = require('../../core/tls') as typeof TlsNS;
  const withCa = cafile === '' ? {} : { cafile };
  // On a Kubernetes workspace this box is not in the path at all: the certificate is a
  // Secret in the cluster and the cluster's ingress holds :443. Probing loopback there
  // reaches whatever else is listening here, which reported a healthy EKS workspace as
  // broken. So the NAME is what gets probed when TLS terminates elsewhere.
  if (String(meta.extra.tls_terminates ?? '') === 'cluster') {
    return await tls.verify(host, { port, ...withCa });
  }
  // BOTH LOOPBACK FAMILIES, because one of them may not be ours: k3s's ServiceLB DNATs
  // IPv4 :443 into the cluster, so 127.0.0.1 answered `CN = TRAEFIK DEFAULT CERT` while
  // [::1] -- the houston edge -- served the real one. The first answer that is not a
  // fallback wins; if every family answers with a placeholder, that IS the finding.
  let report: TlsReport | null = null;
  for (const probe of ['127.0.0.1', '::1']) {
    report = await tls.verify(probe, { port, sni: host, ...withCa });
    if (report.serving && !report.fallback) break;
  }
  return report as TlsReport;
}

/** The certificate actually being served; exit 1 for the placeholder. */
function renderTlsPanel(
  io: CliIo,
  host: string,
  meta: Metadata,
  mode: string,
  port: number,
  r: TlsReport,
): number {
  // SUBJECT OR THE NAMES: cert-manager issues with no subject at all -- the name is in the
  // SANs only -- so every Kubernetes workspace showed `Subject: ?` for a correct one.
  writePanel(io, `TLS: ${meta.name}`, [
    ['Endpoint', `${host}:${String(port)}`],
    ['Issuer', r.issuer || '?'],
    ['Valid for', r.subject || r.names.join(', ') || '?'],
    ['Expires', r.dates.replace('notAfter=', '')],
  ]);
  if (!r.fallback) return 0;
  // The ingress controller's own placeholder: it started and has no certificate for this
  // name YET. The exit code stays non-zero: whatever the cause, this name is not serving
  // a real certificate now.
  say(
    io,
    "  ✗ this is the ingress controller's built-in placeholder certificate — cert-manager " +
      'has not issued one for this name yet.',
  );
  say(
    io,
    '    On a fresh cluster that is normal for the first minute or three. Run this again; ' +
      'if it persists, the ACME order is stuck.',
  );
  tlsTroubleshoot(io, meta, mode, host, port);
  return 1;
}

/** An ACME name being served an untrusted certificate: three reasons, told apart. */
function explainSelfSignedAcme(
  io: CliIo,
  host: string,
  meta: Metadata,
  mode: string,
  r: TlsReport,
  acmeMode: string,
): void {
  if (mode === acmeMode && r.self_signed) {
    say(io, '  ✗ serving a self-signed certificate — nothing has issued one yet.');
    say(
      io,
      '  On Kubernetes the ingress serves its own until cert-manager finishes, which is a ' +
        'minute or three after the workspace answers.',
    );
    say(io, `  kubectl -n houston-${meta.name} describe certificate ${meta.name}-tls`);
  } else if (mode === acmeMode && r.staging) {
    say(io, "  ✓ serving HTTPS with a real Let's Encrypt-issued certificate.");
    say(
      io,
      '  Not trusted here, which is normal for --acme-staging: DNS and the challenge both worked.',
    );
    say(io, '  For a trusted certificate, re-run the SAME command without --acme-staging:');
    say(io, `    ${promoteCommand(meta, host)}`);
  } else if (mode === acmeMode) {
    say(
      io,
      `  ✗ serving a certificate this machine does not trust, from ${r.issuer || 'an unnamed issuer'}.`,
    );
    say(
      io,
      '  That is neither staging nor a placeholder, so something else is answering for ' +
        'this name — a proxy in front is the usual cause.',
    );
  } else {
    say(io, '  ✓ serving HTTPS.');
    say(
      io,
      '  This machine does not trust the issuer; that may be fine if the clients that matter do.',
    );
  }
}

/** What a local-CA workspace needs before a browser will trust it. */
function explainLocalCaMode(
  io: CliIo,
  host: string,
  meta: Metadata,
  mode: string,
  port: number,
  r: TlsReport,
): number {
  if (!r.trusted_via_ca) {
    say(io, "  ✗ serving a certificate that does not chain to houston's CA.");
    tlsTroubleshoot(io, meta, mode, host, port);
    return 1;
  }
  say(io, "  ✓ serving HTTPS with houston's local CA.");
  if (r.trusted) {
    say(io, '  This machine trusts it — `trust-ca` has been run; no browser warnings.');
  } else {
    say(
      io,
      '  Not trusted by this machine yet. Run `houston trust-ca` once to silence browser ' +
        'warnings (the warning itself is harmless locally).',
    );
  }
  return 0;
}

/** For a real domain, also what the PUBLIC name serves: a proxy in front is a different certificate. */
async function explainAcmeMode(io: CliIo, host: string, mode: string, r: TlsReport): Promise<void> {
  const tls = require('../../core/tls') as typeof TlsNS;
  if (mode !== tls.MODE_ACME) return;
  const pub = await tls.verify(host, { port: 443 });
  if (!pub.serving) {
    say(
      io,
      `  ⚠ ${host}:443 is not reachable from here (${pub.error}) — this host serves TLS, but ` +
        'the public name does not resolve to it or nothing forwards to it.',
    );
  } else if (pub.issuer !== '' && pub.issuer !== r.issuer) {
    say(
      io,
      `  ⚠ ${host} is fronted by something else: it serves a certificate issued by ` +
        `${quotedText(pub.issuer)}, not the one this host serves (${quotedText(r.issuer)}).`,
    );
    say(
      io,
      "  That is what an orange-clouded Cloudflare record looks like. Clients get the proxy's " +
        'certificate, not this one.',
    );
  }
}

/**
 * `houston tls-status [--name]`: what is ACTUALLY being served over HTTPS. Returns the exit
 * code; an unknown name is thrown.
 */
export async function tlsStatus(io: CliIo, name: string): Promise<number> {
  const tls = require('../../core/tls') as typeof TlsNS;
  const spec = require('../../core/edge/spec') as typeof EdgeSpecNS;
  const naming = require('../../core/lifecycle/naming') as typeof NamingNS;
  const record = require('../../core/runner/record') as typeof RecordNS;
  // THE GUI'S OWN NAME, when no workspace was asked for. `serve --domain` gives this box
  // an https name that is not a workspace, and this was the one command whose job is
  // "what is being served for this name". The key read is `default`, the established
  // key.
  if (name === '' && !isTruthy(config.loadConfig().default)) {
    const guiDomain = spec.servedDomain();
    if (guiDomain !== '') {
      say(
        io,
        `Checking the GUI's own name, ${guiDomain} (no workspace given; \`--name <n>\` for one)`,
      );
      await reportGuiTls(io, guiDomain, { tries: 1, pause: 0 });
      return 0;
    }
  }
  const audit = require('../../core/audit') as typeof AuditNS;
  const meta = await record.readMeta(await naming.resolveName(name, audit.actor()));
  // `if not m.public_url`: a record's null or false is no https too, where `=== ''` let a
  // null through to `.split` and a stack.
  if (!isTruthy(meta.publicUrl)) {
    say(
      io,
      `  ⚠ ${quotedText(meta.name)} was not created with --https - it serves plain HTTP at ${meta.rootUrl}.`,
    );
    return 1;
  }
  const mode = String(meta.extra.tls ?? '');
  const host = meta.publicUrl.split('://').slice(1).join('://').split(':')[0] ?? '';
  // An edge-served workspace publishes no TLS port of its own, so `tls_ports` is absent OR
  // an empty list (adoption clears it); `[0]` on the empty list was an unhandled error.
  const claimed = (Array.isArray(meta.extra.tls_ports) ? meta.extra.tls_ports : [])
    .map(String)
    .filter((port) => /^\d+$/u.test(port))
    .map(Number);
  const port = claimed[0] ?? 443;
  const cafile = mode === tls.MODE_LOCAL ? joinPath(tls.caDir(), tls.CA_CRT) : '';
  say(io, `Checking ${meta.publicUrl} ...`);

  const r = await probeTlsEndpoint(cafile, host, meta, port);
  if (!r.serving) {
    say(io, `  ✗ nothing is serving TLS on this host's port ${String(port)} - ${r.error}`);
    tlsTroubleshoot(io, meta, mode, host, port);
    return 1;
  }
  if (renderTlsPanel(io, host, meta, mode, port, r) !== 0) return 1;
  await explainAcmeMode(io, host, mode, r);
  if (mode === tls.MODE_LOCAL) return explainLocalCaMode(io, host, meta, mode, port, r);
  if (r.trusted) {
    say(io, '  ✓ serving HTTPS with a certificate this machine trusts.');
    return 0;
  }
  explainSelfSignedAcme(io, host, meta, mode, r, tls.MODE_ACME);
  return 0;
}

// --- trust-ca -----------------------------------------------------------------------

/**
 * Run a tool for 30 s, print each line of its stdout indented two, and say
 * `⚠ <tool> failed: <exc>` when it could not be run at all. Its stderr and its exit code
 * are captured and dropped.
 */
async function runAndEcho(io: CliIo, argv: ExecNS.Argv): Promise<void> {
  const exec = require('../../seams/exec') as typeof ExecNS;
  let out: string;
  try {
    const result = await exec.capture(argv, { encoding: 'utf8', timeoutMs: 30_000 });
    out = typeof result.stdout === 'string' ? result.stdout : '';
  } catch (error) {
    // A spawn failure or a timeout, each saying what could not run.
    if (error instanceof exec.SpawnFailure) {
      say(io, `  ⚠ ${argv[0]} failed: ${fileErrorText(error.cause)}`);
      return;
    }
    if (error instanceof exec.ProcessTimeout) {
      say(io, `  ⚠ ${argv[0]} failed: ${argv.join(' ')} timed out after 30 seconds`);
      return;
    }
    throw error;
  }
  for (const line of splitTextLines(out)) say(io, `  ${line}`);
}

/**
 * `houston trust-ca [--uninstall] [--show]`: what happened to the system trust store, in
 * the established words, and exit 0 either way.
 *
 * `trust()` answers `[changed, how]`, and `changed` false is its FAILURE: an earlier version
 * read it as "already trusted", and said "✓ local CA uninstalled" for every `--uninstall`
 * without reading it at all -- so a `sudo -n rm` that failed told the operator trust was
 * withdrawn while a CA whose key can mint a certificate for any name stayed in the store.
 */
export async function trustCa(io: CliIo, uninstall: boolean, show: boolean): Promise<number> {
  const local = require('../../core/tls-local') as typeof TlsLocalNS;
  const [key, crt] = await local.ensureCa();
  if (show) {
    say(io, `CA certificate: ${crt}`);
    say(io, `CA key:         ${key}  (keep private)`);
    await runAndEcho(io, [
      'openssl',
      'x509',
      '-in',
      crt,
      '-noout',
      '-subject',
      '-fingerprint',
      '-sha256',
      '-dates',
    ]);
    return 0;
  }
  const [installed, how] = await local.trust(crt, uninstall);
  if (installed) {
    say(io, `✓ CA ${uninstall ? 'removed from' : 'installed into'} ${how}.`);
    say(
      io,
      '  Restart the browser to pick it up. Firefox keeps its own store — ' +
        'if it still warns, import the CA under Settings → Privacy → Certificates.',
    );
  } else {
    say(
      io,
      `  ⚠ could not ${uninstall ? 'remove' : 'install'} it automatically ` +
        `on this platform (${how}).`,
    );
    say(io, local.manualTrustInstructions(crt, uninstall));
  }
  return 0;
}
