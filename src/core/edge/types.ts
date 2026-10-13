/**
 * What the edge serves, and whether it came up.
 *
 * Tier 0 of `src/core/edge/`.
 */
import * as config from '../../lib/config';
import { spelled } from '../../lib/json-text';
import { MODE_ACME, dnsEnvVars, inferDnsProvider, tlsSpec, type TlsSpec } from '../tls';

/** What the edge serves. `domain` is the GUI's own hostname. */
export interface Edge {
  readonly domain: string;
  readonly acmeEmail: string;
  readonly acmeStaging: boolean;
  readonly acmeChallenge: string;
  readonly acmeDnsProvider: string;
  /**
   * Where the GUI process listens. It binds the Docker bridge rather than loopback so
   * this container can reach it and nothing else can -- verified reachable from a
   * container and refused from 127.0.0.1.
   */
  readonly guiHost: string;
  readonly guiPort: number;
  /** Overridable so tests (and a box where 443 is genuinely taken) are not forced onto
   * privileged ports. */
  readonly httpPort: number;
  readonly httpsPort: number;
  /**
   * One `*.<domain>` certificate instead of one per workspace name. Derived from whether
   * DNS credentials exist, never asked for -- a wildcard can ONLY be issued over dns-01,
   * so the token is the whole question.
   */
  readonly wildcard: boolean;
}

/**
 * Each `Edge` property beside the key it is written under in `spec.json`.
 *
 * THE ON-DISK NAME IS THE ESTABLISHED ONE, not this interface's. `spec.json` has always
 * been written with snake_case keys, `acme_email`, `gui_host` and the rest; a document
 * serialised straight from this camelCase interface is a file the previous implementation
 * cannot read, and `migrate` -- whose whole job is adopting a home an EARLIER RELEASE
 * wrote -- would reject every spec it was ever given. `runner/record`'s `META_FIELDS` is the
 * same table for `repro.json` and the reason this one exists.
 *
 * Declaration order is the established field order, because the spec is written in it
 * and a file whose keys are shuffled is a needless diff against every file earlier
 * releases wrote.
 */
export const EDGE_FIELDS: readonly (readonly [keyof Edge, string])[] = Object.freeze([
  ['domain', 'domain'],
  ['acmeEmail', 'acme_email'],
  ['acmeStaging', 'acme_staging'],
  ['acmeChallenge', 'acme_challenge'],
  ['acmeDnsProvider', 'acme_dns_provider'],
  ['guiHost', 'gui_host'],
  ['guiPort', 'gui_port'],
  ['httpPort', 'http_port'],
  ['httpsPort', 'https_port'],
  ['wildcard', 'wildcard'],
] as const);

/** The spec as the JSON document that goes on disk, in the established field order. */
export function toDocument(value: Edge): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  for (const [property, key] of EDGE_FIELDS) document[key] = value[property];
  return document;
}

/**
 * A `spec.json` document as an `Edge`.
 *
 * EACH VALUE AS `loads` READ IT: no field is coerced to the type this interface declares,
 * because none has ever been coerced. A hand-edited `false` email stays `false` and a port
 * written `8080.0` stays a float (`spelled` hands it back as a `JsonFloat`), so what is
 * rebuilt from the spec -- the compose ports, the GUI route, the rewritten spec itself --
 * says what it has always said.
 *
 * Unknown keys are dropped rather than raising, for the reason `fromDocument` in
 * `runner/record` gives: a spec written by a NEWER houston carrying an added field would
 * otherwise fail a start. `migrate` wants the stricter reading and does its own refusal
 * first -- there a surprise field means the file is not the file it thinks it is.
 */
export function fromDocument(document: Record<string, unknown>): Edge {
  const values: Partial<Edge> = {};
  for (const [property, key] of EDGE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(document, key)) {
      (values as Record<string, unknown>)[property] = spelled(document, key);
    }
  }
  return edge(values);
}

export function edge(values: Partial<Edge> = {}): Edge {
  return {
    domain: '',
    acmeEmail: '',
    acmeStaging: false,
    acmeChallenge: 'tlsalpn',
    acmeDnsProvider: '',
    guiHost: '',
    guiPort: 7070,
    httpPort: 80,
    httpsPort: 443,
    wildcard: false,
    ...values,
  };
}

/**
 * Build one, choosing the challenge the way the rest of the tool does.
 *
 * `acme.staging` is read here, and that was new: the field existed, `tls` built the
 * staging CA URL from it, `config set acme.staging true` mapped to it and staging even
 * got its own storage file so switching could never mix a staging certificate into the
 * production store -- and NOTHING wired it to the edge. `serve --domain` called this
 * without it, so the switch was unreachable for the one component that requests
 * certificates.
 *
 * That mattered on the box that found it. Let's Encrypt allows five FAILED authorizations
 * per name per hour, a support box has a name per ticket, and every restart abandons an
 * in-flight challenge -- so a few restarts spend the budget for the whole hour and the
 * only safe way to test the plumbing is against staging, which is what this switch is for.
 */
/**
 * The challenge `config set acme.challenge` forces, or '' when it forces none. The one reading
 * of it: the edge `serve --domain` builds and a workspace's `up --domain` (`pickChallenge`)
 * both ask here, where only the first used to look.
 */
export function forcedChallenge(cfg: Record<string, unknown>): string {
  const forced = String(cfg.acme_challenge ?? '')
    .trim()
    .toLowerCase();
  return ['http', 'tlsalpn', 'dns'].includes(forced) ? forced : '';
}

export function resolveEdge(
  domain: string,
  acmeEmail: string,
  overrides: Partial<Edge> = {},
): Edge {
  const hasDns = dnsEnvVars().length > 0;
  const provider = hasDns ? inferDnsProvider()[0] : '';
  const cfg = config.loadConfig();
  // `truthy`, not a bare boolean -- "false" is a truthy string, which made the staging
  // switch one-way. Same fix as the workspace path; same reason.
  const staging = overrides.acmeStaging ?? config.truthy(cfg.acme_staging);
  // Derived, but overridable -- because the derivation assumes one of the two automatic
  // paths is available and a real box existed where neither was: TLS-ALPN validation
  // failed on every attempt and the operator had no access to the DNS zone. `config set
  // acme.challenge http` is the escape hatch, and it names the mechanism rather than a
  // symptom.
  const forced = forcedChallenge(cfg);
  const challenge = forced !== '' ? forced : hasDns ? 'dns' : 'tlsalpn';
  return edge({
    ...overrides,
    domain,
    acmeEmail,
    acmeStaging: staging,
    acmeChallenge: challenge,
    acmeDnsProvider: provider,
    wildcard: hasDns && challenge === 'dns',
  });
}

/**
 * Whether the wildcard already covers `host`, so it needs no request.
 *
 * Exactly one label below the domain: a TLS wildcard matches ONE label, and
 * `a.b.support.xyz.com` is therefore not covered even though a DNS wildcard would resolve
 * it -- the two wildcards match differently and conflating them would mean serving the
 * wrong certificate.
 */
export function covers(value: Edge, host: string): boolean {
  if (!value.wildcard || value.domain === '' || host === '') return false;
  const suffix = `.${value.domain}`;
  return host.endsWith(suffix) && !host.slice(0, -suffix.length).includes('.');
}

/** The equivalent workspace TlsSpec, so ACME flags come from one place. */
export function asTlsSpec(value: Edge): TlsSpec {
  return tlsSpec({
    mode: MODE_ACME,
    host: value.domain,
    port: value.httpsPort,
    acmeEmail: value.acmeEmail,
    acmeStaging: value.acmeStaging,
    acmeChallenge: value.acmeChallenge,
    acmeDnsProvider: value.acmeDnsProvider,
  });
}

/**
 * Whether the edge came up, and if not, WHY.
 *
 * A bool for two years, and the reason was captured and dropped on the floor: `up()` ran
 * `docker compose up` with the output captured and returned only the return code, so both
 * failure sites could do nothing but guess at `portHolder(443)` and point at a directory.
 * On a fresh EC2 box that produced "error: the edge did not start." with `docker ps -a`
 * empty -- no container, no clue, and the actual compose error discarded one frame below.
 *
 * `ok` is the flag every existing `if (!await ensureRunning(...))` keeps meaning what it
 * meant; `why` is new information rather than a changed contract.
 */
export interface StartResult {
  readonly ok: boolean;
  readonly why: string;
}

export function startResult(ok: boolean, why = ''): StartResult {
  return { ok, why };
}
