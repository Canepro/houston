/**
 * HTTPS: terminate TLS in front of Rocket.Chat with Traefik.
 *
 * Layered onto ANY repro via `up --https` rather than being its own preset -- `--preset` is
 * single-valued, so a `tls` preset would be mutually exclusive with
 * oidc/saml/livechat/multi-instance, which are exactly the ones that need HTTPS.
 *
 * Two ways to get the certificate, and only two inputs for the common one:
 *
 *   acme   `--domain X --email Y`  Let's Encrypt via Traefik's own ACME resolver, the same
 *                                  DOMAIN + LETSENCRYPT_EMAIL pair the official
 *                                  compose.traefik.yml takes.
 *   local  `--https`               a CA made here with openssl (see `tls-local.ts`).
 *                                  Offline, no domain, no rate limits.
 *
 * The ACME CHALLENGE is not a user-facing choice. TLS-ALPN-01 is the default and what the
 * official compose uses; dns-01 is selected automatically when provider credentials exist
 * in `~/.houston/acme/dns.env`, because that is the only way to issue when Let's Encrypt
 * cannot connect inbound -- behind NAT, behind a tunnel, or behind a proxy that terminates
 * TLS in front of you. Neither appears as a flag.
 *
 * ## `node:tls` is used directly, and that is not a seam bypass
 *
 * `verify()` opens a TLS socket and reads what is actually served. That is a socket and a
 * TLS handshake, and it is not HTTP: no request is made, no body is read, and the
 * whole point is to inspect the handshake rather than what comes after it. Routing it
 * through `seams/rc-http.ts` would mean asking an HTTP client a question about a
 * certificate, which it cannot answer -- `fetch` gives no access to the peer chain. The
 * certificate FIELDS still go through openssl via the process seam, as they always have,
 * so the strings this reports are the same strings on both sides.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as tlsSocket from 'node:tls';

import * as config from '../lib/config';
import { ValidationError } from '../lib/errors';
import { joinPath } from '../lib/home';
import { socketErrorText } from '../lib/format';
import { capture } from '../seams/exec';

/**
 * Pinned to match the multi-instance preset, so a repro that uses both runs one Traefik
 * version rather than two.
 */
export const TRAEFIK_TAG = 'v3.4';
export const SERVICE = 'traefik';

export const LOCAL_SUFFIX = 'houston.localhost';

export const CA_DIR_NAME = 'ca';
export const CA_KEY = 'ca.key';
export const CA_CRT = 'ca.crt';

export const ACME_DIR_NAME = 'acme';
export const ACME_FILE = 'acme.json';
export const ACME_FILE_STAGING = 'acme-staging.json';

/**
 * Credentials for a dns-01 provider. A file, never argv: `ps` shows command lines to every
 * user on the box.
 */
export const DNS_ENV_FILE = 'dns.env';
export const LEGO_PROVIDER_DOCS = 'https://go-acme.github.io/lego/dns/';

/**
 * Let's Encrypt: 50 certificates per registered domain per 7 days. Only NEW names cost --
 * an existing certificate is reused -- so this is only reachable by a team creating many
 * differently-named workspaces in a week. Counted and warned about rather than pre-empted:
 * refusing to create a workspace over houston's own tally, which cannot see certificates
 * issued by anything else on the domain, would be wrong far more often than right.
 */
export const CERT_LIMIT_PER_WEEK = 50;

/**
 * Warn from here. Deliberately well below the limit: the useful moment to hear "a wildcard
 * would remove this" is while there is still room to act.
 */
export const CERT_WARN_AT = 25;

/**
 * Names houston has caused a certificate request for, and when. Traefik's acme.json holds
 * the certificates themselves but no issuance dates, and parsing X.509 out of it would
 * need a crypto dependency this project does not have.
 */
export const ISSUED_FILE = 'issued.json';

export const MODE_LOCAL = 'local';
export const MODE_ACME = 'acme';

/**
 * Subject Traefik puts on the self-signed certificate it serves when a resolver has
 * produced nothing yet -- how `tls-status` tells "ACME has not issued" apart from "ACME
 * issued something wrong".
 */
const TRAEFIK_FALLBACK = 'TRAEFIK DEFAULT CERT';

/** Resolved HTTPS settings for one repro. `mode` picks the certificate source. */
export interface TlsSpec {
  readonly mode: string;
  /** External hostname: a domain, or `<name>.houston.localhost`. */
  readonly host: string;
  /** Published host port for the TLS entrypoint. */
  readonly port: number;
  readonly acmeEmail: string;
  readonly acmeStaging: boolean;
  /**
   * `tlsalpn` (Let's Encrypt connects in on 443) | `dns` (a TXT record, no inbound) |
   * `http`. Derived from whether credentials exist, never asked for.
   */
  readonly acmeChallenge: string;
  readonly acmeDnsProvider: string;
}

export function tlsSpec(values: Partial<TlsSpec> = {}): TlsSpec {
  return {
    mode: MODE_LOCAL,
    host: '',
    port: 0,
    acmeEmail: '',
    acmeStaging: false,
    acmeChallenge: 'tlsalpn',
    acmeDnsProvider: '',
    ...values,
  };
}

/**
 * The URL a workspace advertises.
 *
 * 443 is implicit in an https URL; anything else has to be spelled out or Rocket.Chat
 * advertises a URL that does not answer.
 */
export function rootUrl(spec: TlsSpec): string {
  return `https://${spec.host}${spec.port === 443 ? '' : `:${String(spec.port)}`}`;
}

export function caDir(): string {
  return joinPath(config.home(), CA_DIR_NAME);
}

export function acmeDir(): string {
  return joinPath(config.home(), ACME_DIR_NAME);
}

export function localHostFor(name: string): string {
  return `${name}.${LOCAL_SUFFIX}`;
}

/**
 * A hostname label: alphanumeric with internal hyphens. Deliberately not a full RFC 1123
 * implementation -- this only has to reject the shapes that break us.
 */
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u;

/**
 * Shared cleanup for a user-supplied hostname: scheme, trailing slash, dot, case.
 *
 * ONE implementation, because `--domain` and `--allow-host` are mistyped in exactly the
 * same ways -- a pasted URL, a trailing slash, a capitalised name -- and diverging on
 * which of those is forgiven is how one flag ends up accepting what the other refuses.
 * They differ only on a PORT, which each decides for itself.
 */
function cleanHost(value: string): [string, string[]] {
  let raw = value.trim();
  const fixes: string[] = raw !== value ? ['trimmed whitespace'] : [];
  for (const scheme of ['https://', 'http://']) {
    if (raw.toLowerCase().startsWith(scheme)) {
      raw = raw.slice(scheme.length);
      fixes.push(`dropped '${scheme}'`);
      break;
    }
  }
  if (raw.endsWith('/')) {
    raw = raw.replace(/\/+$/u, '');
    fixes.push('dropped the trailing slash');
  }
  if (raw.endsWith('.')) {
    // A trailing dot is a legal FQDN but does not match SNI or a URL host.
    raw = raw.replace(/\.+$/u, '');
    fixes.push('dropped the trailing dot');
  }
  if (raw !== raw.toLowerCase()) {
    raw = raw.toLowerCase();
    fixes.push('lower-cased it');
  }
  return [raw, fixes];
}

/**
 * Turn a user-supplied `--allow-host` into a bare hostname. Returns `[host, note]`.
 *
 * The same cleanup as `--domain`, with one deliberate difference: a port is DROPPED and
 * reported rather than refused. The Host guard compares hostnames with the port already
 * stripped off the incoming header, so `--allow-host lab.example.com:9944` names exactly
 * the right host -- and keeping the port, which is what used to happen, made it match
 * nothing at all.
 *
 * Not hypothetical. Measured on a lab box, three of the five forms somebody typed in a row
 * -- `https://h/`, `h/`, `h:9944` -- were each unmatchable, and `serve` started and
 * reported itself healthy every time before 403ing every request.
 *
 * `*` is the documented "any Host" wildcard and passes through untouched.
 */
export function normalizeAllowHost(value: string): [string, string] {
  if (value.trim() === '*') return ['*', ''];
  let [raw, fixes] = cleanHost(value);
  if (raw.startsWith('[')) {
    // `[::1]:9944` / `[::1]` -- the guard unwraps the brackets too, so match it.
    const inner = raw.slice(1).split(']')[0] ?? '';
    if (inner !== '') {
      raw = inner;
      fixes = [...fixes, 'unwrapped the IPv6 brackets'];
    }
  } else if ((raw.match(/:/gu) ?? []).length === 1) {
    // host:port. More than one colon and no brackets is a bare IPv6 literal (`::1`),
    // which has no port to drop and must survive untouched.
    const [head, port] = raw.split(':') as [string, string];
    raw = head;
    fixes = [...fixes, `dropped the port '${port}' — a Host header's port is not matched`];
  }
  if (raw === '') {
    throw new ValidationError(
      `--allow-host '${value}' has no hostname in it. Pass the name you will type in the ` +
        "address bar — e.g. --allow-host lab.example.com, or '*' for any host.",
    );
  }
  if (raw.includes('/')) {
    throw new ValidationError(
      `--allow-host '${value}' contains a path. Pass the hostname only ` +
        `(${raw.split('/')[0] ?? ''}) — the guard matches the Host header, and a Host ` +
        'header has no path in it.',
    );
  }
  return [raw, fixes.join('; ')];
}

/**
 * Turn a user-supplied `--domain` into a bare hostname. Returns `[host, note]`.
 *
 * The official Rocket.Chat compose docs spell out that DOMAIN must be set "without
 * https:// or trailing slashes", which is a strong hint that people get it wrong -- and
 * unguarded it produced `ROOT_URL="https://https://host"` plus a bogus ACME `domains`
 * entry that Let's Encrypt rejects.
 *
 * Forms with one obvious meaning are corrected and reported. Forms that would change what
 * gets served (a port, a path) are refused, because silently dropping them would not do
 * what the user asked.
 */
export function normalizeDomain(value: string): [string, string] {
  const [raw, fixes] = cleanHost(value);

  if (raw === '') throw new ValidationError('--domain is empty');
  if (raw.includes('/')) {
    throw new ValidationError(
      `--domain '${value}' contains a path. Pass the hostname only ` +
        `(${raw.split('/')[0] ?? ''}); serving a repro under a sub-path is not supported.`,
    );
  }
  if (raw.includes(':')) {
    throw new ValidationError(
      `--domain '${value}' contains a port. Pass the hostname only ` +
        `(${raw.split(':')[0] ?? ''}) — a repro on a real domain is served on 443, so the ` +
        'URL carries no port.',
    );
  }
  if (raw.startsWith('*.')) {
    throw new ValidationError(
      `--domain '${value}' is a wildcard. --domain has to be the concrete host the ` +
        'workspace is reached at, because it becomes ROOT_URL.',
    );
  }
  if (raw.split('.').some((label) => !LABEL_RE.test(label))) {
    throw new ValidationError(
      `--domain '${value}' is not a valid hostname (letters, digits and hyphens per ` +
        'label, separated by dots).',
    );
  }
  return [raw, fixes.join('; ')];
}

export function acmeStorageName(staging: boolean): string {
  return staging ? ACME_FILE_STAGING : ACME_FILE;
}

/**
 * The domain Let's Encrypt counts against, approximately.
 *
 * The real rule is the eTLD+1 from the Public Suffix List, which this project does not
 * carry -- so the last two labels are used instead. That is right for
 * `t1.support.xyz.com` -> `xyz.com` and WRONG for multi-part suffixes like `co.uk`, where
 * it groups a whole suffix as one domain and so over-counts.
 *
 * Acceptable only because this drives a warning and never a refusal: the worst case is
 * mentioning a wildcard slightly too early.
 */
export function registrableDomain(host: string): string {
  const labels = (host || '')
    .replace(/^\.+|\.+$/gu, '')
    .split('.')
    .filter((label) => label !== '');
  if (labels.length >= 2) return labels.slice(-2).join('.');
  return labels[0] ?? '';
}

export function issuedPath(): string {
  return joinPath(acmeDir(), ISSUED_FILE);
}

/**
 * Exported so a check can read the real file through the real parser rather than
 * re-parsing it; `recordIssuance` is its writer counterpart.
 */
export function readIssued(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(issuedPath(), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Note that `host` needed a certificate of its own.
 *
 * Keyed by name and only ever written ONCE per name: re-registering an existing name
 * reuses its certificate and costs nothing, so overwriting the date would make a
 * long-lived workspace look like a fresh request every time it is recreated. Best-effort
 * -- a tally must never stop the work.
 */
export function recordIssuance(host: string, when = ''): void {
  if (host === '') return;
  try {
    const issued = readIssued();
    if (host in issued) return;
    issued[host] = when || todayIso();
    fs.mkdirSync(acmeDir(), { recursive: true });
    const temporary = `${issuedPath()}.tmp`;
    const ordered = Object.fromEntries(
      Object.keys(issued)
        .sort()
        .map((key) => [key, issued[key]]),
    );
    fs.writeFileSync(temporary, `${JSON.stringify(ordered, null, 2)}`, 'utf8');
    fs.renameSync(temporary, issuedPath());
  } catch {
    // A tally must never stop the work.
  }
}

/** How many distinct names under `domain` were first seen in the last `days`. */
export function recentIssuances(domain: string, days = 7): number {
  const cutoff = Date.now() - days * 86_400_000;
  let count = 0;
  for (const [host, day] of Object.entries(readIssued())) {
    if (registrableDomain(host) !== domain) continue;
    const when = Date.parse(`${String(day)}T00:00:00Z`);
    if (Number.isNaN(when)) continue;
    // Strictly newer than the cutoff, as it always was.
    if (when > cutoff - 0) {
      const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
      if (String(day) > cutoffDay) count += 1;
    }
  }
  return count;
}

/** The certificate-budget message, or '' while there is nothing worth saying. */
export function budgetWarning(host: string): string {
  const domain = registrableDomain(host);
  if (domain === '') return '';
  const used = recentIssuances(domain);
  if (used < CERT_WARN_AT) return '';
  return (
    `${String(used)} certificates issued for ${domain} in the last 7 days (limit ` +
    `${String(CERT_LIMIT_PER_WEEK)}). A wildcard certificate would remove this — it needs ` +
    `a DNS API token in ${dnsEnvPath()}.`
  );
}

export function dnsEnvPath(): string {
  return joinPath(acmeDir(), DNS_ENV_FILE);
}

/**
 * Which lego provider a credentials variable belongs to.
 *
 * The variables ARE provider-specific, so the file already says which provider it is --
 * asking the user to repeat that on every `up` was ceremony. Longest prefix wins, so
 * `CLOUDFLARE_*` is not mistaken for anything shorter. Not exhaustive: an unrecognised
 * file just means `--acme-dns-provider` is required, which is the old behaviour rather
 * than a failure.
 */
const DNS_VAR_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  CF_: 'cloudflare',
  CLOUDFLARE_: 'cloudflare',
  AWS_: 'route53',
  DO_AUTH_TOKEN: 'digitalocean',
  GCE_: 'gcloud',
  AZURE_: 'azuredns',
  LINODE_: 'linode',
  HETZNER_: 'hetzner',
  VULTR_: 'vultr',
  OVH_: 'ovh',
  GODADDY_: 'godaddy',
  NAMECHEAP_: 'namecheap',
  DNSIMPLE_: 'dnsimple',
  NS1_: 'ns1',
  DIGITALOCEAN_: 'digitalocean',
});

/** The KEY names in a credentials file, never the values. */
function keyNames(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line !== '' && !line.startsWith('#') && line.includes('=')) {
      names.push((line.split('=')[0] as string).trim());
    }
  }
  return names;
}

/** Variable NAMES in the credentials file (never values), or `[]` if absent. */
export function dnsEnvVars(): string[] {
  try {
    if (!fs.statSync(dnsEnvPath()).isFile()) return [];
  } catch {
    return [];
  }
  return keyNames(fs.readFileSync(dnsEnvPath(), 'utf8'));
}

/**
 * Work out the lego provider from the credentials file. Returns `[provider, why]`.
 *
 * `['', reason]` when the file is missing, unrecognised, or names more than one provider
 * -- in which case `--acme-dns-provider` has to be given explicitly.
 */
export function inferDnsProvider(): [string, string] {
  const names = dnsEnvVars();
  if (names.length === 0) {
    return ['', `${dnsEnvPath()} does not exist or has no KEY=VALUE lines`];
  }
  const found = new Map<string, string>();
  // Longest prefix first so CLOUDFLARE_ beats CF_ and DIGITALOCEAN_ beats DO_.
  const prefixes = Object.keys(DNS_VAR_PROVIDERS).sort((left, right) => right.length - left.length);
  for (const name of names) {
    const upper = name.toUpperCase();
    for (const prefix of prefixes) {
      if (upper.startsWith(prefix)) {
        found.set(DNS_VAR_PROVIDERS[prefix] as string, name);
        break;
      }
    }
  }
  if (found.size === 0) {
    return ['', `none of ${names.join(', ')} matches a known provider`];
  }
  if (found.size > 1) {
    return [
      '',
      `${names.join(', ')} look like more than one provider (${[...found.keys()].sort().join(', ')})`,
    ];
  }
  const [provider, via] = [...found.entries()][0] as [string, string];
  return [provider, `${via} in ${path.basename(dnsEnvPath())}`];
}

/**
 * Check the dns-01 credentials file, returning `[ok, message]`.
 *
 * Each lego provider reads its OWN environment variables (CF_DNS_API_TOKEN,
 * AWS_ACCESS_KEY_ID, DO_AUTH_TOKEN, GCE_PROJECT, ...), so this cannot verify the right
 * ones are present -- but it can catch the file being missing or empty, which otherwise
 * surfaces only as an opaque Traefik failure minutes later.
 */
export function dnsCredentials(provider: string): [boolean, string] {
  const target = dnsEnvPath();
  let text: string;
  try {
    if (!fs.statSync(target).isFile()) throw new Error('not a file');
    text = fs.readFileSync(target, 'utf8');
  } catch {
    return [
      false,
      `--acme-challenge dns needs provider credentials, and ${target} does not exist.\n` +
        `  Create it with the variables '${provider}' expects (see ` +
        `${LEGO_PROVIDER_DOCS}${provider}/), e.g. for cloudflare:\n` +
        `    mkdir -p ${path.dirname(target)} && chmod 700 ${path.dirname(target)}\n` +
        `    printf 'CF_DNS_API_TOKEN=%s\\n' "$TOKEN" > ${target}\n` +
        `    chmod 600 ${target}`,
    ];
  }
  const names = keyNames(text);
  if (names.length === 0) {
    return [
      false,
      `${target} has no KEY=VALUE lines. Add the variables '${provider}' expects — see ` +
        `${LEGO_PROVIDER_DOCS}${provider}/`,
    ];
  }
  // Names only. Never echo the values.
  return [true, `${path.basename(target)}: ${names.join(', ')}`];
}

/**
 * Traefik's ACME flags.
 *
 * Public because the front door (`core/edge`) issues certificates the same way a workspace
 * does; two copies of this would drift, and the challenge choice is the part that decides
 * whether issuance works at all.
 */
export function acmeArgs(spec: TlsSpec): string[] {
  const args = [
    `--certificatesresolvers.le.acme.email=${spec.acmeEmail}`,
    `--certificatesresolvers.le.acme.storage=/etc/traefik/acme/${acmeStorageName(spec.acmeStaging)}`,
  ];
  if (spec.acmeStaging) {
    args.push(
      '--certificatesresolvers.le.acme.caserver=' +
        'https://acme-staging-v02.api.letsencrypt.org/directory',
    );
  }
  if (spec.acmeChallenge === 'dns') {
    // dns-01: validated by a TXT record the provider API writes, so Let's Encrypt never
    // connects here. The only option behind NAT, a tunnel, or a proxy that terminates TLS
    // in front of the origin.
    args.push('--certificatesresolvers.le.acme.dnschallenge=true');
    if (spec.acmeDnsProvider !== '') {
      args.push(`--certificatesresolvers.le.acme.dnschallenge.provider=${spec.acmeDnsProvider}`);
    }
  } else if (spec.acmeChallenge === 'http') {
    // http-01, and it exists because the other two can both be unavailable at once.
    // Reported from an EC2 box where TLS-ALPN validation failed every time with `remote
    // error: tls: unrecognized name` -- Let's Encrypt reached :443 and the challenge was
    // not being answered -- and where dns-01 was impossible because the operator had the
    // machine and not the DNS zone.
    args.push('--certificatesresolvers.le.acme.httpchallenge=true');
    args.push('--certificatesresolvers.le.acme.httpchallenge.entrypoint=web');
  } else {
    // TLS-ALPN-01, the same challenge the official compose.traefik.yml uses. It validates
    // on 443, which is already published, so no second port has to be opened for it.
    args.push('--certificatesresolvers.le.acme.tlschallenge=true');
  }
  return args;
}

async function certField(pem: string, ...args: string[]): Promise<string> {
  try {
    const proc = await capture(['openssl', 'x509', '-noout', ...args] as [string, ...string[]], {
      input: pem,
      encoding: 'utf8',
      timeoutMs: 15_000,
    });
    return String(proc.stdout ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * The DNS names a certificate is valid for, from its subjectAltName.
 *
 * NEEDED because a certificate can have no subject at all. cert-manager issues exactly
 * that shape -- the name lives only in the SANs -- so every Kubernetes workspace's
 * certificate reported `Subject: ?`, which reads as a parse failure rather than as a
 * perfectly good certificate. `tls-local.ts` already says why the SANs are the field that
 * matters: browsers have ignored commonName since Chrome 58.
 */
export async function certNames(pem: string): Promise<string[]> {
  const raw = await certField(pem, '-ext', 'subjectAltName');
  const out: string[] = [];
  for (const chunk of raw.split('\n').join(',').split(',')) {
    const part = chunk.trim();
    if (part.startsWith('DNS:')) out.push(part.slice(4).trim());
  }
  return out;
}

export interface CertificateDetails {
  issuer: string;
  subject: string;
  names: string[];
  dates: string;
  fallback: boolean;
  self_signed: boolean;
  staging: boolean;
}

/** Extract identity and provenance fields from the served certificate. */
export async function certificateDetails(pem: string): Promise<CertificateDetails> {
  const issuer = (await certField(pem, '-issuer')).replace(/^issuer=/u, '').trim();
  const subject = (await certField(pem, '-subject')).replace(/^subject=/u, '').trim();
  return {
    issuer,
    subject,
    // The names, always, because the subject can legitimately be empty. A caller that
    // shows one field should be able to fall back.
    names: await certNames(pem),
    dates: (await certField(pem, '-enddate')).split('\n').join(' '),
    fallback: `${issuer}${subject}`.toLowerCase().includes(TRAEFIK_FALLBACK.toLowerCase()),
    // WHY an untrusted certificate is untrusted, which is three different situations and
    // had one message. `--acme-staging` was treated as the only explanation, so a
    // workspace on Kubernetes whose cert-manager had not finished yet was reported as "a
    // real Let's Encrypt-issued certificate ... normal for --acme-staging" -- wrong twice.
    //
    //   self_signed - issuer is the subject: nothing has issued this, it is a
    //                 placeholder. On a cluster that means "not issued YET".
    //   staging     - Let's Encrypt's staging root says so in its own name.
    self_signed: issuer !== '' && issuer === subject,
    staging: issuer.toLowerCase().includes('staging'),
  };
}

/** One TLS handshake, with verification off, returning the peer certificate as PEM. */
async function handshake(
  host: string,
  port: number,
  timeout: number,
  servername: string,
): Promise<{ pem: string; error: string }> {
  return await new Promise((resolve) => {
    const socket = tlsSocket.connect({
      host,
      port,
      servername: net.isIP(servername) === 0 ? servername : undefined,
      rejectUnauthorized: false,
      timeout: Math.round(timeout * 1000),
    });
    const finish = (pem: string, error: string): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ pem, error });
    };
    socket.once('secureConnect', () => {
      // `getPeerCertificate` is TYPED as always returning a certificate and does not:
      // for a peer that offered none it returns an empty object, so `raw` is absent at
      // runtime while the type says Buffer. `Buffer.isBuffer` is the check the type
      // system cannot see through, and an empty certificate is no certificate -- the case
      // is real, an anonymous-cipher or aborted handshake reaches it.
      const der: unknown = socket.getPeerCertificate(false).raw;
      if (!Buffer.isBuffer(der) || der.length === 0) {
        finish('', 'the server offered no certificate');
        return;
      }
      const body = (der.toString('base64').match(/.{1,64}/gu) ?? []).join('\n');
      finish(`-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`, '');
    });
    // A timeout, reported in the established words: TimeoutError, "timed out".
    socket.once('timeout', () => finish('', 'TimeoutError: timed out'));
    socket.once('error', (error: NodeJS.ErrnoException) => finish('', socketErrorText(error)));
  });
}

/** Whether the endpoint validates under the requested trust store. */
async function certificateAccepted(
  host: string,
  port: number,
  timeout: number,
  servername: string,
  cafile: string,
): Promise<boolean> {
  // THE CA IS READ INSIDE THE TRY, and that is not style. A CA file that does not exist
  // made the trust setup throw ENOENT -- a filesystem error, but thrown one line ABOVE
  // the handler that caught filesystem errors -- so this reporting function
  // crashed its caller instead of reporting. Hit live: a fresh HOUSTON_HOME going straight
  // to `--domain` has never minted a local certificate, so `ca/ca.crt` is simply not
  // there, and `up` ended in a stack trace after the workspace had been built.
  let ca: Buffer | undefined;
  try {
    ca = cafile !== '' ? fs.readFileSync(cafile) : undefined;
  } catch {
    return false;
  }
  return await new Promise((resolve) => {
    const socket = tlsSocket.connect({
      host,
      port,
      servername: net.isIP(servername) === 0 ? servername : undefined,
      ...(ca === undefined ? {} : { ca }),
      rejectUnauthorized: true,
      timeout: Math.round(timeout * 1000),
    });
    const finish = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once('secureConnect', () => finish(socket.authorized));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export interface TlsReport {
  host: string;
  port: number;
  serving: boolean;
  trusted: boolean;
  trusted_via_ca: boolean;
  issuer: string;
  subject: string;
  dates: string;
  names: string[];
  fallback: boolean;
  self_signed: boolean;
  staging: boolean;
  error: string;
}

/**
 * Connect over TLS and report what is ACTUALLY being served.
 *
 * Deliberately connects with verification off first: a staging or local-CA certificate is
 * untrusted by design, and refusing to look at it would report "broken" for a setup that
 * is working exactly as intended. Trust is then a separate, second question.
 */
export async function verify(
  host: string,
  {
    port = 443,
    timeout = 10,
    cafile = '',
    sni = '',
  }: { port?: number; timeout?: number; cafile?: string; sni?: string } = {},
): Promise<TlsReport> {
  const out: TlsReport = {
    host,
    port,
    serving: false,
    trusted: false,
    trusted_via_ca: false,
    issuer: '',
    subject: '',
    dates: '',
    names: [],
    fallback: false,
    self_signed: false,
    staging: false,
    error: '',
  };
  // `sni` lets the caller connect to an ADDRESS while presenting a different server name
  // -- how you check what this host serves for a domain without letting a proxy in front
  // answer instead.
  const servername = sni || host;
  const { pem, error } = await handshake(host, port, timeout, servername);
  if (error !== '') {
    out.error = error;
    return out;
  }
  out.serving = true;
  Object.assign(out, await certificateDetails(pem));

  // Two DIFFERENT questions, kept apart on purpose:
  //   trusted        - would a browser accept this, using only the SYSTEM store?
  //   trusted_via_ca - does it chain to the CA we were given?
  // Collapsing them made local mode always report "trusted", because passing houston's
  // own CA guarantees success and hides whether `trust-ca` has run.
  out.trusted = await certificateAccepted(host, port, timeout, servername, '');
  out.trusted_via_ca =
    cafile !== ''
      ? await certificateAccepted(host, port, timeout, servername, cafile)
      : out.trusted;
  return out;
}

/**
 * A few of Cloudflare's published edge ranges. Used ONLY to explain a failure more
 * precisely, never to block: the list drifts, and being wrong here must not stop a working
 * setup.
 */
export const CLOUDFLARE_HINT_NETS: readonly string[] = [
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '173.245.48.0/20',
  '162.158.0.0/15',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '131.0.72.0/22',
  '141.101.64.0/18',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
];

export function notes(spec: TlsSpec, name = '<name>'): string[] {
  if (spec.mode === MODE_LOCAL) {
    return [
      `HTTPS (local certificate): ${rootUrl(spec)}`,
      "Signed by houston's own CA, so a browser warns until you run `houston trust-ca` " +
        'once (then no warnings, and curl needs no -k).',
      'A phone cannot use this: the cert is untrusted there and .localhost resolves to ' +
        'the phone itself. Use --domain for mobile.',
    ];
  }
  if (spec.acmeStaging) {
    // Staging roots are NOT in any trust store -- that is the whole point of staging.
    // Claiming otherwise sent people looking for a broken workspace when the browser
    // warning was the expected, correct outcome.
    return [
      `HTTPS (Let's Encrypt STAGING): ${rootUrl(spec)}`,
      'A staging certificate is deliberately NOT trusted - a browser warning here is the ' +
        "SUCCESS signal, because TLS terminated with a real Let's Encrypt-issued cert.",
      `Confirm what is served:  houston tls-status --name ${name}`,
      'Then `houston config unset acme.staging` and re-run with --force.',
    ];
  }
  return [
    `HTTPS (Let's Encrypt): ${rootUrl(spec)}`,
    'Publicly trusted, so the Rocket.Chat mobile app accepts it with nothing to install - ' +
      `just add ${rootUrl(spec)} in the app.`,
    'Traefik requests the certificate in the background. Confirm it issued:  houston ' +
      `tls-status --name ${name}`,
    'Certificate state lives in ~/.houston/acme/ and survives `down`, so re-creating this ' +
      'repro reuses the cert instead of re-issuing it.',
  ];
}
