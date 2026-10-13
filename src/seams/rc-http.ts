/**
 * The only module that speaks HTTP.
 *
 * HTTP calls were once scattered through the code -- 44 in the Rocket.Chat API module
 * alone, plus `versions`, `seed`, `perf`, the CLI and one inside a web route. Here they all
 * funnel into this module, for the same reason every subprocess funnels through
 * `seams/exec.ts`: so there is ONE place that knows what a timeout is, what a transport
 * failure looks like, and what a response is, and so a test can replace the network without
 * replacing the behaviour being tested.
 *
 * THIN BY CONTRACT. It knows a URL, a method, headers, a body and a deadline. It knows
 * nothing about Rocket.Chat: no `/api/v1`, no auth headers, no 2FA, no retry policy, no
 * readiness. Those live in `core/rcapi`, which is where the domain is. A seam that knew
 * one Rocket.Chat path would grow to know all of them.
 *
 * ## The contract is the established client's, deliberately
 *
 * The HTTP client behaviour every caller was written against -- the established client, in
 * what follows -- is the reference, so its shapes are the shapes here:
 *
 *  - An HTTP status is NEVER an exception. 404s and 500s are responses, and rcapi's error
 *    handling reads the status -- so a seam that threw on 4xx would silently invert two
 *    dozen branches.
 *  - `json()` THROWS on a body that is not JSON. Three call sites in rcapi catch that and
 *    fall through to a message carrying the body's first 200 characters, which is the only
 *    useful thing a proxy's HTML error page ever provides.
 *  - `ok` is `status < 400` -- not `status === 200`.
 *  - A transport failure -- DNS, connect refused, TLS, a deadline -- is `RequestFailed`.
 *    It is a plain Error and NOT a `ReproError`: the seam has no idea whether a refused
 *    connection is a `NotReadyError` (Rocket.Chat still booting) or a `DockerError` (the
 *    port-forward died), and guessing in here would take that judgement away from the
 *    module that has the context to make it. `seams/exec.ts` draws the same line for the
 *    same reason.
 *
 * ## What it does NOT do
 *
 * No retries, no backoff, no connection pool tuning, no cookie jar. The established client
 * had none of those either, and every retry loop in rcapi -- readiness, the OTP poll, the
 * SAML descriptor -- is written out in the caller with its own deadline and its own
 * injectable sleep, because each one gives up for a different reason.
 */
import type * as HttpNS from 'node:http';
import type * as ZlibNS from 'node:zlib';
import * as tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

import { dumps } from '../lib/json-text';
import { STRIP_CHARS, floatString } from '../lib/float-text';

import { interruptibly } from './exec';

/**
 * A transport failure: the exchange did not complete. The only thing this module throws.
 *
 * `cause` carries the underlying error, so a caller that wants to distinguish a timeout
 * from a refused connection still can -- rcapi does not, because the established failure
 * handling it reproduces does not either.
 */
export class RequestFailed extends Error {
  /**
   * Which kind of failure it is, as far as a caller asks: `connection` for a connection
   * error, `timeout` for a timeout, `other` for the rest (a body cut short, too many
   * redirects, a body the JSON writer refuses). Only the first two read as "not answering
   * yet" (see `failed`). A refused connection is the default.
   */
  readonly kind: FailureKind;

  constructor(
    message: string,
    readonly url: string,
    options: { cause?: unknown; kind?: FailureKind } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RequestFailed';
    this.kind = options.kind ?? 'connection';
  }
}

/** See `RequestFailed.kind`. */
export type FailureKind = 'connection' | 'timeout' | 'other';

/** One finished exchange. */
export interface HttpResponse {
  readonly status: number;
  /**
   * The status line's reason phrase: what a status error quotes. The seam always sets it;
   * a stub standing in for the seam may leave it out.
   */
  readonly reason?: string;
  /** `status < 400`, the established meaning of ok. */
  readonly ok: boolean;
  readonly text: string;
  readonly bytes?: Buffer;
  /** Lower-cased header names, a repeated one's values joined with `, `. */
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
  /** The parsed body. THROWS for a body that is not JSON. */
  json(): unknown;
}

export interface RequestOptions {
  /** Default GET. Upper-cased before it goes out. */
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * A JSON body: serialised in the established spelling, and `Content-Type:
   * application/json` set unless the caller set one itself. `null` is NO body -- no bytes
   * and no Content-Type -- and not the four bytes `null` (see `jsonBody`).
   */
  readonly json?: unknown;
  readonly body?: string | Buffer;
  readonly binary?: boolean;
  readonly sameOriginRedirects?: boolean;
  /** Return the responding endpoint's redirect, without asking another endpoint. */
  readonly followRedirects?: boolean;
  /**
   * Route liveness on an owned loopback HTTPS origin, bypassing DNS/CDN/proxies. The
   * observed certificate is this request's sole trust anchor and must match exactly;
   * it does not establish public CA trust. Normal requests never use this option.
   */
  readonly loopbackOrigin?: {
    readonly certificate: string;
    /** A known ingress default certificate while asynchronous issuance is pending. */
    readonly allowCertificateNameMismatch?: boolean;
  };
  /** Query string, appended to the URL. */
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  /** The whole exchange's deadline, in milliseconds. */
  readonly timeoutMs?: number;
  /**
   * The most bytes a body may hold, as it arrives and once decoded; past it the exchange is
   * abandoned as a `RequestFailed` of kind `other`. Unset is no cap, as it always was: every
   * caller before this one talks to a server it started, and an identity provider is not one.
   */
  readonly maxBytes?: number;
}

/**
 * The default deadline, and why there is one at all.
 *
 * An HTTP client without a timeout waits FOREVER -- a socket to a host that accepts and then
 * says nothing never returns. Every rcapi call site passes its own; this is the floor for
 * one that forgets, and 30 s is `call()`'s own default, the most general entry point.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

function withParams(url: string, params: RequestOptions['params']): string {
  if (params === undefined) return url;
  const entries: [string, string][] = Object.entries(params).map(([key, value]) => [
    key,
    String(value),
  ]);
  if (entries.length === 0) return url;
  // `URLSearchParams`, NOT `encodeURIComponent`, and that is a decision to match the
  // established client rather than a convenience. Its query is form encoding: a space
  // becomes `+`. `encodeURIComponent` makes it `%20`. The two are interchangeable to a
  // well-behaved server and this tool exists to reproduce customers' servers, so the
  // established spelling wins. Measured: the established client gives `q=a+b%26c`, and so
  // does this.
  //
  // Appended to whatever is already there rather than replacing it -- `settingIds` writes
  // `?count=0` into its path -- as the established client appends it.
  const query = new URLSearchParams(entries as [string, string][]).toString();
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

/**
 * The bytes a JSON body is sent as: the established JSON spelling, NaN and the infinities
 * refused.
 *
 * `JSON.stringify` was used here and differs in every way that reaches the wire. Its layout
 * is compact where the established spelling has `', '` and `': '`, and it writes non-ASCII
 * raw where that escapes it -- so every login, every PAT mint and every `api -d` body went
 * out as different bytes. It writes NaN and the infinities as `null`, so
 * `api -d '{"n": 1e400}'` SENT `{"n":null}` where the request is refused with
 * `Out of range float values are not JSON compliant: inf`, and NaN likewise. And a null
 * body is no body, where this sent `null` with a JSON Content-Type.
 *
 * The refusal is a `RequestFailed`, as it has always been a request failure: `api` then
 * says `request failed: ...`. It is raised before anything is sent. A value the JSON writer
 * cannot spell at all is its TypeError, which is not caught either.
 */
function jsonBody(value: unknown, target: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return dumps(value, { allowNan: false });
  } catch (error) {
    if ((error as Error).name !== 'InvalidValue') throw error;
    throw new RequestFailed((error as Error).message, target, { cause: error, kind: 'other' });
  }
}

/** Request headers in the order they go out, each name spelled as it is written. */
type HeaderList = readonly (readonly [string, string])[];

/**
 * The established client's default headers, in its order: what every request sends ahead
 * of the caller's own headers.
 *
 * These were fetch's -- `accept`, `accept-language: *`, `sec-fetch-mode: cors`, `user-agent:
 * node`, `accept-encoding`, after the caller's -- so every request of seed, config-import,
 * monitor and every other REST command carried two headers the established client never
 * sends, in another order. fetch cannot be told to leave `accept-language` and
 * `sec-fetch-mode` out, so no hop goes through it any more (see `viaNode`).
 *
 * THE USER-AGENT IS NOT the established client's, by the owner's decision: this build does
 * not claim that client's `<name>/<version>`, a string an upgrade of it would change anyway.
 * It keeps the `node` it always sent, in that header's place. Rocket.Chat records a login's
 * user agent, so the admin's session and device entries name the build that logged in.
 */
const DEFAULT_HEADERS: HeaderList = Object.freeze([
  ['User-Agent', 'node'],
  ['Accept-Encoding', 'gzip, deflate'],
  ['Accept', '*/*'],
  ['Connection', 'keep-alive'],
] as const);

/**
 * The headers a request is prepared with: the defaults merged with the caller's, names
 * compared case-insensitively -- a caller's header takes the place of the default it names,
 * in the caller's spelling -- then the body's Content-Length, then the JSON Content-Type
 * unless the caller set one. Measured against the established client: `Content-Length`
 * before `Content-Type` when both are set by it, and `Content-Length: 0` for a method other
 * than GET or HEAD that has no body.
 */
function preparedHeaders(
  caller: Readonly<Record<string, string>>,
  method: string,
  body: string | Buffer | undefined,
): HeaderList {
  const merged = new Map<string, readonly [string, string]>();
  const put = (name: string, value: string) => merged.set(name.toLowerCase(), [name, value]);
  for (const [name, value] of DEFAULT_HEADERS) put(name, value);
  for (const [name, value] of Object.entries(caller)) put(name, value);
  // A body's Content-Length only when it is not empty, which the JSON writer never leaves it.
  if (body !== undefined) {
    if (Buffer.byteLength(body) > 0) put('Content-Length', String(Buffer.byteLength(body)));
  } else if (method !== 'GET' && method !== 'HEAD' && !merged.has('content-length')) {
    put('Content-Length', '0');
  }
  // JSON is the only body this seam sends, so a body is a JSON one.
  if (body !== undefined && !merged.has('content-type')) put('Content-Type', 'application/json');
  return [...merged.values()];
}

/** The methods that are framed with no `Content-Length: 0` when they carry no body. */
const NOT_EXPECTING_BODY: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'DELETE',
  'TRACE',
  'OPTIONS',
  'CONNECT',
]);

/**
 * The `Host` header as the established client writes it: the host lower-cased, without an
 * IPv6 literal's brackets, and without a trailing dot -- bracketed again for IPv6, with the
 * port only when it is not the scheme's default.
 */
function hostHeader(url: URL): string {
  const host = url.hostname.replace(/^\[(.*)\]$/u, '$1').replace(/\.+$/u, '');
  const shown = host.includes(':') ? `[${host}]` : host;
  return url.port === '' ? shown : `${shown}:${url.port}`;
}

/**
 * The header lines of one hop, in the established order: `Host` first, then a framing
 * header when the prepared headers carry none (`Content-Length: 0` for a redirected PUT
 * whose body was dropped, which is not prepared again), then the prepared headers. As a
 * flat array, which node's client writes verbatim -- spelling and order kept, nothing of
 * its own added while `Connection` and the framing are present.
 */
function onTheWire(
  url: URL,
  method: string,
  headers: HeaderList,
  body: string | Buffer | undefined,
) {
  const named = new Set(headers.map(([name]) => name.toLowerCase()));
  const lines: string[] = [];
  if (!named.has('host')) lines.push('Host', hostHeader(url));
  if (!named.has('content-length') && !named.has('transfer-encoding')) {
    if (body !== undefined) lines.push('Content-Length', String(Buffer.byteLength(body)));
    else if (!NOT_EXPECTING_BODY.has(method)) lines.push('Content-Length', '0');
  }
  for (const [name, value] of headers) lines.push(name, value);
  return lines;
}

/**
 * Whether node may send this through the environment's proxy: plain HTTP, with the proxy
 * settings node read at startup (NODE_USE_ENV_PROXY). It decides NO_PROXY itself.
 */
function proxiedHttp(url: URL, shared: { options?: { proxyEnv?: unknown } }): boolean {
  return url.protocol === 'http:' && shared.options?.proxyEnv !== undefined;
}

/**
 * The same header lines as one object, in the same order and spelling -- or the lines, when
 * a name repeats and an object would drop one.
 *
 * Node before 24.19 builds a proxied request's absolute URI from `getHeader('host')`, which
 * a raw list never reaches, and falls back to `localhost`: behind a proxy on Node
 * 24.10-24.18, which `engines` admits, every plain-HTTP call houston made asked the proxy
 * for localhost. From an object node reads `Host`, and adds nothing of its own while
 * `Host`, `Connection` and the framing are there -- so the bytes are the list's.
 */
function asHeaderObject(lines: readonly string[]): Record<string, string> | readonly string[] {
  const out = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  for (let at = 0; at < lines.length; at += 2) {
    const name = lines[at] as string;
    if (seen.has(name.toLowerCase())) return lines;
    seen.add(name.toLowerCase());
    out[name] = lines[at + 1] as string;
  }
  return out;
}

/** The statuses that redirect, and how many redirects are followed. */
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 30;

/** One hop's answer, its body still to be read. */
interface Answer {
  readonly status: number;
  readonly reason: string;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * The body, content-decoded and read as UTF-8. Throws a `Broken` for a body cut short, and
   * an `Undecodable` for one its Content-Encoding does not describe.
   */
  text(): Promise<string>;
  bytes(): Promise<Buffer>;
  /** Let a redirect's body go. */
  discard(): Promise<void>;
}

type Send = (
  url: URL,
  /** The request target: the path and query exactly as they go on the request line. */
  path: string,
  method: string,
  headers: HeaderList,
  body: string | Buffer | undefined,
  signal: AbortSignal,
  loopbackOrigin?: RequestOptions['loopbackOrigin'],
  maxBytes?: number,
) => Promise<Answer>;

/**
 * Where a hop broke -- before its status line arrived, or while its body was arriving -- and
 * how much of a body of a stated length had: which decides what the established message says.
 */
class Broken extends Error {
  constructor(
    readonly stage: 'send' | 'body',
    readonly read: number,
    readonly length: number | null,
    cause: unknown,
    /** The proxy whose connection failed, when it was the proxy's and not the host's. */
    readonly proxy: URL | null = null,
  ) {
    super(String((cause as Error).message || cause), { cause });
  }
}

/** A body past the caller's `maxBytes`. */
class TooLarge extends Error {
  constructor(readonly limit: number) {
    super(`more than ${String(limit)} bytes`);
  }
}

/**
 * The proxy node's agent takes for `url` from the environment it read at startup, as node
 * picks it -- the lower-case name first -- or null. Whether NO_PROXY exempts the host is
 * node's to decide; `failedAtProxy` reads it off what failed.
 */
function proxyOf(url: URL, env: HttpNS.ProxyEnv | undefined): URL | null {
  if (env === undefined) return null;
  const raw =
    url.protocol === 'https:'
      ? env.https_proxy || env.HTTPS_PROXY
      : env.http_proxy || env.HTTP_PROXY;
  if (raw === undefined || raw === '') return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** A URL's host as a socket wants it (no IPv6 brackets), and its port or the scheme's. */
function endpoint(url: URL): { host: string; port: string } {
  return {
    host: url.hostname.replace(/^\[(.*)\]$/u, '$1'),
    port: url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port,
  };
}

/**
 * Whether a connection that failed was the one to `proxy` rather than to the host. For http
 * node asks the proxy for the absolute URL, so a request whose target it rewrote went only to
 * the proxy. For https it tunnels, and the target is left alone, so the failed endpoint says:
 * the proxy's name that did not resolve, or the proxy's port that did not connect.
 */
function failedAtProxy(
  error: unknown,
  hop: URL,
  proxy: URL | null,
  rewritten: boolean,
): URL | null {
  if (proxy === null) return null;
  if (hop.protocol === 'http:') return rewritten ? proxy : null;
  const failed = error as { hostname?: unknown; address?: unknown; port?: unknown };
  const via = endpoint(proxy);
  const direct = endpoint(hop);
  if (failed.hostname !== undefined) return failed.hostname === via.host ? proxy : null;
  const port = String(failed.port);
  return port === via.port && (port !== direct.port || failed.address === via.host) ? proxy : null;
}

function contentLength(headers: Readonly<Record<string, string>>): number | null {
  const stated = (headers['content-length'] ?? '').trim();
  return /^\d+$/u.test(stated) ? Number(stated) : null;
}

/**
 * A body its Content-Encoding does not describe: a content-decoding error -- not a
 * connection error, so not "not answering yet".
 */
class Undecodable extends Error {
  constructor(
    /** The Content-Encoding, lower-cased, or '' when there is none. */
    readonly encoding: string,
    cause: unknown,
  ) {
    super(String((cause as Error).message || cause), { cause });
  }
}

/**
 * The body content-decoded, then read as UTF-8 with the BOM dropped.
 *
 * LENIENT ABOUT AN END CUT SHORT, as the established decoders are (an incremental decoder
 * gives what it has and does not complain at the end) and as fetch's were: a gzip body
 * missing its trailer is the text it holds, where node's one-shot decoders refuse it with
 * "unexpected end of file". A body that is not the encoding at all is an `Undecodable`.
 */
function decodedBytes(
  bytes: Buffer,
  headers: Readonly<Record<string, string>>,
  maxBytes?: number,
): Buffer {
  const zlib = require('node:zlib') as typeof ZlibNS;
  const lenient = {
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
    ...(maxBytes === undefined ? {} : { maxOutputLength: maxBytes }),
  };
  const encoding = (headers['content-encoding'] ?? '').trim().toLowerCase();
  let plain = bytes;
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') plain = zlib.gunzipSync(bytes, lenient);
    else if (encoding === 'deflate') {
      // Deflate: zlib-wrapped first, raw deflate when that fails.
      try {
        plain = zlib.inflateSync(bytes, lenient);
      } catch {
        plain = zlib.inflateRawSync(bytes, lenient);
      }
    }
  } catch (error) {
    if (maxBytes !== undefined && (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE')
      throw new TooLarge(maxBytes);
    throw new Undecodable(encoding, error);
  }
  return plain;
}

function decoded(
  bytes: Buffer,
  headers: Readonly<Record<string, string>>,
  maxBytes?: number,
): string {
  return new TextDecoder('utf-8').decode(decodedBytes(bytes, headers, maxBytes));
}

/**
 * Response headers, lower-cased, every repeat of a name joined with `, ` (as fetch did
 * too) -- where node's `headers` keeps only the first `Location` or `Content-Type` it sees.
 */
function collect(incoming: HttpNS.IncomingMessage): Record<string, string> {
  const collected: Record<string, string> = {};
  for (const [name, values] of Object.entries(incoming.headersDistinct)) {
    if (values !== undefined) collected[name.toLowerCase()] = values.join(', ');
  }
  return collected;
}

/**
 * One hop, through node's own client: EVERY hop, where fetch used to carry most of them.
 *
 * fetch adds `accept-language: *` and `sec-fetch-mode: cors` to every request and orders the
 * headers itself, and neither can be turned off, so what went out was never what the
 * established client sends. Here the header lines are written as `onTheWire` lists them. It
 * also sends what fetch refused: a body on GET or HEAD, and TRACE or TRACK.
 *
 * A CONNECTION PER REQUEST, as the established client opens one for a call and closes it
 * after: an agent of its own that keeps nothing alive. node's shared agent would keep the
 * socket for the next request, and a kept socket the other end has since closed fails that
 * request where connecting again does not.
 *
 * THROUGH THE PROXY THE SHARED AGENT WOULD USE. HTTP_PROXY, HTTPS_PROXY and NO_PROXY have
 * always been honoured; node honours them only under NODE_USE_ENV_PROXY (or
 * `--use-env-proxy`), read at startup into its global agents' `proxyEnv`, and bin/houston
 * sets it for this build. An
 * agent of one's own is not given it -- `agent: false` sent every request around the proxy,
 * the release lookup's included -- so it is handed the global agent's, whatever node
 * decided: the proxy under the flag, none without it, as fetch's dispatcher was.
 *
 * Guarded in the suite by `testsetup-network.ts`, which refuses a non-loopback
 * `http.request` / `https.request` as it refuses a non-loopback `fetch`.
 */
const viaNode: Send = async (
  url,
  path,
  method,
  headers,
  body,
  signal,
  loopbackOrigin,
  maxBytes,
) => {
  const client = (
    url.protocol === 'https:' ? require('node:https') : require('node:http')
  ) as typeof HttpNS;
  // `options` is there on both modules' agents; only https' type declares it.
  const shared = client.globalAgent as HttpNS.Agent & { options?: HttpNS.AgentOptions };
  const originTls =
    loopbackOrigin === undefined
      ? {}
      : {
          ca: loopbackOrigin.certificate,
          allowPartialTrustChain: true,
          rejectUnauthorized: true,
          servername: url.hostname,
          checkServerIdentity: (host: string, certificate: tls.PeerCertificate) => {
            const pinned = new X509Certificate(loopbackOrigin.certificate);
            if (certificate.fingerprint256 !== pinned.fingerprint256)
              return new Error('the origin certificate changed during the readiness probe');
            return loopbackOrigin.allowCertificateNameMismatch === true
              ? undefined
              : tls.checkServerIdentity(host, certificate);
          },
        };
  const agent = new client.Agent({
    keepAlive: false,
    proxyEnv: loopbackOrigin === undefined ? shared.options?.proxyEnv : undefined,
    ...originTls,
  });
  const lines = onTheWire(url, method, headers, body);
  return await new Promise<Answer>((resolve, reject) => {
    const outgoing = client.request(
      {
        protocol: url.protocol,
        // `[::1]` is how a URL spells the host and `::1` is how a socket wants it.
        hostname:
          loopbackOrigin === undefined ? url.hostname.replace(/^\[(.*)\]$/u, '$1') : '127.0.0.1',
        port: url.port,
        path,
        method,
        headers:
          loopbackOrigin === undefined && proxiedHttp(url, shared) ? asHeaderObject(lines) : lines,
        agent,
        signal,
        ...originTls,
      },
      (incoming) => {
        const collected = collect(incoming);
        const length = contentLength(collected);
        const chunks: Buffer[] = [];
        let read = 0;
        // The message only says `aborted`; the socket says whether it was reset, which is
        // what the established message reports.
        let socketError: unknown = null;
        const onSocketError = (error: unknown) => {
          socketError = error;
        };
        // Held here: a kept-alive socket is gone from the message by the time it closes.
        const socket = incoming.socket;
        socket.on('error', onSocketError);
        const arrived = new Promise<Buffer>((done, broke) => {
          incoming.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            read += chunk.length;
            if (maxBytes !== undefined && read > maxBytes) incoming.destroy(new TooLarge(maxBytes));
          });
          incoming.on('error', (error) => {
            broke(new Broken('body', read, length, socketError ?? error));
          });
          incoming.on('close', () => {
            socket.off('error', onSocketError);
            if (incoming.complete) done(Buffer.concat(chunks));
            else broke(new Broken('body', read, length, socketError ?? new Error('aborted')));
          });
        });
        // Read by `text()` or `discard()`; never a rejection nobody is waiting for.
        arrived.catch(() => undefined);
        resolve({
          status: incoming.statusCode ?? 0,
          reason: incoming.statusMessage ?? '',
          headers: collected,
          text: async () => decoded(await arrived, collected, maxBytes),
          bytes: async () => decodedBytes(await arrived, collected, maxBytes),
          discard: async () => {
            await arrived.catch(() => undefined);
          },
        });
      },
    );
    outgoing.on('error', (error) => {
      const proxy = loopbackOrigin === undefined ? proxyOf(url, shared.options?.proxyEnv) : null;
      const via = failedAtProxy(error, url, proxy, outgoing.path !== path);
      reject(new Broken('send', 0, null, error, via));
    });
    outgoing.end(body);
  });
};

/** RFC 3986's unreserved characters. */
const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-~';
/** The characters a path keeps unescaped (unreserved, sub-delims, `:` `@` `/`), and a query's. */
const PATH_CHARS: ReadonlySet<string> = new Set(`${UNRESERVED}!$&'()*+,;=:@/`);
const QUERY_CHARS: ReadonlySet<string> = new Set([...PATH_CHARS, '?']);

/** A string's UTF-8 bytes, a lone surrogate included as itself. */
function utf8(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const point = char.codePointAt(0) as number;
    if (point < 0x80) bytes.push(point);
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point < 0x10000)
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    else
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
  }
  return bytes;
}

const escaped = (byte: number) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * Every byte outside `allowed` escaped, and a `%` kept only when EVERY `%` in the component
 * already starts a valid escape.
 */
function encodeInvalid(component: string, allowed: ReadonlySet<string>): string {
  let valid = 0;
  const normalised = component.replace(/%[a-fA-F0-9]{2}/gu, (escape) => {
    valid += 1;
    return escape.toUpperCase();
  });
  const bytes = utf8(normalised);
  const alreadyEncoded = valid === bytes.filter((byte) => byte === 0x25).length;
  let out = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    out +=
      (alreadyEncoded && byte === 0x25) || (byte < 0x80 && allowed.has(char))
        ? char
        : escaped(byte);
  }
  return out;
}

/** Dot segments removed, RFC 3986 5.2.4. */
function removeDotSegments(path: string): string {
  const output: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '.') continue;
    if (segment !== '..') output.push(segment);
    else if (output.length > 0) output.pop();
  }
  if (path.startsWith('/') && (output.length === 0 || output[0] !== '')) output.unshift('');
  if (path.endsWith('/.') || path.endsWith('/..')) output.push('');
  return output.join('/');
}

/** Percent-encoding of `text`'s UTF-8 bytes, the unreserved characters and `safe` kept. */
function quote(text: string, safe: string): string {
  const keep = new Set([...UNRESERVED, ...safe]);
  let out = '';
  for (const byte of utf8(text)) {
    const char = String.fromCharCode(byte);
    out += byte < 0x80 && keep.has(char) ? char : escaped(byte);
  }
  return out;
}

/**
 * The URI requoted: unquote the unreserved escapes, then quote what is illegal -- or, where
 * an escape does not parse, quote every `%`.
 */
function requoteUri(uri: string): string {
  const parts = uri.split('%');
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i] as string;
    const head = [...part].slice(0, 2).join('');
    if ([...head].length === 2 && /^[\p{L}\p{N}]+$/u.test(head)) {
      if (!/^[0-9A-Fa-f]{2}$/u.test(head)) return quote(uri, "!#$&'()*+,/:;=?@[]~");
      const char = String.fromCharCode(parseInt(head, 16));
      parts[i] = UNRESERVED.includes(char) ? `${char}${part.slice(2)}` : `%${part}`;
    } else {
      parts[i] = `%${part}`;
    }
  }
  return quote(parts.join(''), "!#$%&'()*+,/:;=?@[]~");
}

/** The request target: the prepared URL's path and query, encoded for the request line. */
function requestTarget(prepared: string): string {
  const rest = prepared.slice(prepared.indexOf('//') + 2);
  const start = rest.search(/[/?#]/u);
  const tail = start < 0 ? '' : (rest.slice(start).split('#')[0] as string);
  const mark = tail.indexOf('?');
  const path = (mark < 0 ? tail : tail.slice(0, mark)) || '/';
  const query = mark < 0 ? '' : tail.slice(mark + 1);
  let target = query === '' ? path : `${path}?${query}`;
  // A target that starts `//` keeps one leading slash, so it cannot read as a host.
  if (target.startsWith('//')) target = `/${target.replace(/^\/+/u, '')}`;
  const [, head = '', tailQuery] = /^(\/[^?#]*)(?:\?([^#]*))?/su.exec(target) ?? [];
  return tailQuery === undefined
    ? encodeInvalid(head, PATH_CHARS)
    : `${encodeInvalid(head, PATH_CHARS)}?${encodeInvalid(tailQuery, QUERY_CHARS)}`;
}

/**
 * The URL as the established client sends it, and the target on its request line.
 *
 * fetch sent a URL as the WHATWG parser rewrites it, and the two disagree about exactly the
 * characters a Rocket.Chat query is made of. The established client escapes `|`, `[`, `]`,
 * `{`, `}` and `"` (parsed, then requoted), where WHATWG leaves them raw; it escapes a
 * stray `%` as `%25`, where WHATWG keeps it; and it sends `\` and a TAB as `%5C` and `%09`,
 * where WHATWG turns the backslash into `/` and drops the TAB -- so
 * `api GET '/api/v1/a\b'` asked Rocket.Chat for `/api/v1/a/b`, another endpoint. So the
 * URL is prepared the established way, and its target goes on the request line verbatim
 * through node's client, where WHATWG would still rewrite one (a `'` in a query, which it
 * escapes).
 *
 * Null for what this does not reproduce -- a scheme other than http(s), no host, userinfo,
 * a host outside `[A-Za-z0-9.-]` or an IPv6 literal, a port past 65535 -- which go out as
 * before, so a failure keeps the words it had.
 */
function prepareUrl(raw: string): { url: string; target: string } | null {
  let start = 0;
  while (start < raw.length && STRIP_CHARS.has(raw[start] as string)) start += 1;
  const url = raw.slice(start);
  const parts =
    /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):)?(?:\/\/([^\\/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/su.exec(
      url,
    );
  if (parts === null) return null;
  const [, rawScheme, authority, rawPath = '', rawQuery, rawFragment] = parts;
  const scheme = (rawScheme ?? '').toLowerCase();
  if ((scheme !== 'http' && scheme !== 'https') || authority === undefined) return null;
  const hostPort =
    /^([A-Za-z0-9-][A-Za-z0-9.-]*|\[[0-9A-Fa-f:.]+\])(?::0*?(|0|[1-9][0-9]{0,4}))?$/u.exec(
      authority,
    );
  if (hostPort === null) return null;
  const host = (hostPort[1] as string).toLowerCase();
  const port = Number(hostPort[2] ?? '');
  if (port > 65_535) return null;
  const path = rawPath === '' ? '/' : encodeInvalid(removeDotSegments(rawPath), PATH_CHARS);
  const query = rawQuery === undefined ? '' : encodeInvalid(rawQuery, QUERY_CHARS);
  const fragment = rawFragment === undefined ? '' : encodeInvalid(rawFragment, QUERY_CHARS);
  // A port of 0 is left out, as it always has been.
  let joined = `${scheme}://${host}${port === 0 ? '' : `:${String(port)}`}${path}`;
  if (query !== '') joined += `?${query}`;
  if (fragment !== '') joined += `#${fragment}`;
  const prepared = requoteUri(joined);
  return { url: prepared, target: requestTarget(prepared) };
}

/** Where `url` connects, as a refusal names it: `127.0.0.1:3000`, an IPv6 host in brackets. */
function whereOf(url: URL): string {
  const { host, port } = endpoint(url);
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/** glibc's words for the connect errors a refused connection carries, as measured. */
const CONNECT_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  ECONNREFUSED: 'Connection refused',
  ENETUNREACH: 'Network is unreachable',
  EHOSTUNREACH: 'No route to host',
});

/** getaddrinfo's words for a name that does not resolve. */
const RESOLVE_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  ENOTFOUND: 'Name or service not known',
  EAI_AGAIN: 'Temporary failure in name resolution',
});

/**
 * The message for a connection that could not be made -- to the host, or to `proxy` -- or
 * null for a failure it does not describe (see `failed`).
 */
function neverConnected(
  cause: unknown,
  hop: URL,
  path: string,
  landed: string,
  proxy: URL | null,
): string | null {
  // Several addresses tried (localhost is ::1 and 127.0.0.1): the error of the last one
  // tried is the one reported.
  const tried = (cause as { errors?: unknown }).errors;
  const failure = (Array.isArray(tried) && tried.length > 0 ? tried.at(-1) : cause) as {
    code?: unknown;
    syscall?: unknown;
  };
  const code = String(failure.code);
  // Only an http:// proxy was measured.
  if (proxy !== null && proxy.protocol !== 'http:') return null;
  const words = CONNECT_ERRORS[code];
  const resolve = RESOLVE_ERRORS[code];
  // What was asked for: the request target, or through an http proxy the whole URL without
  // its fragment.
  const asked =
    proxy !== null && hop.protocol === 'http:' ? (landed.split('#')[0] as string) : path;
  if (words !== undefined && failure.syscall === 'connect') {
    return proxy === null
      ? `cannot connect to ${whereOf(hop)} (${asked}): ${words}`
      : `cannot connect to the proxy ${whereOf(proxy)} for ${asked}: ${words}`;
  }
  if (resolve !== undefined && failure.syscall === 'getaddrinfo') {
    const host = endpoint(proxy ?? hop).host.replace(/\.+$/u, '');
    return proxy === null
      ? `cannot resolve ${host} (${asked}): ${resolve}`
      : `cannot resolve the proxy ${host} for ${asked}: ${resolve}`;
  }
  return null;
}

/**
 * The message for the failure, where it can be said exactly: what was tried and why it did
 * not work, in the C library's words for the reason.
 *
 *   closed before a status line   <target>: the connection closed without a response
 *   reset before a status line    <target>: the connection was reset (Connection reset by peer)
 *   a body short of its length    <target>: the response ended early (11 bytes read, 89 more
 *                                 expected)
 *   reset in the body             <target>: the connection was reset mid-response (...)
 *   silent until the deadline     localhost:3100 did not answer within 30.0s
 *   silent in the body            localhost:3100 stopped sending before the response ended
 *   refused, unreachable          cannot connect to 127.0.0.1:1 (/api/v1/login): Connection
 *                                 refused (or Network is unreachable, No route to host)
 *   a name that does not resolve  cannot resolve rc.invalid (/api/v1/login): Name or service
 *                                 not known
 *   a proxy that refuses          cannot connect to the proxy <host:port> for <the whole URL>
 *   a body that is not its        the response said content-encoding gzip but could not be
 *   Content-Encoding              decoded: incorrect header check
 *
 * They are quoted by config-import, monitor attach and `seed`, and persisted -- a seed's
 * `verification.unreadable[].why` in repro.json. A name that does not resolve is taken as
 * EAI_NONAME, as it nearly always is: node calls EAI_NODATA `ENOTFOUND` too. What cannot be
 * said exactly keeps the seam's own words: any other failure to connect (TLS, a proxy that
 * answers a CONNECT with a refusal) is `could not reach <url>: <node's words>`, and a
 * connect timeout reads as the read timeout does.
 *
 * THE KIND DECIDES: a connection error and a timeout are "not answering yet", and a short
 * body is not one. The deadline is the whole exchange's where a per-read timeout would be
 * each read's (see `request`), so the same words can stand for a different wait.
 */
function failed(
  error: unknown,
  hop: URL,
  path: string,
  landed: string,
  target: string,
  timeoutMs: number,
  aborted: boolean,
): RequestFailed {
  const tooLarge =
    error instanceof TooLarge ? error : error instanceof Broken ? error.cause : undefined;
  if (tooLarge instanceof TooLarge) {
    return new RequestFailed(`${target} answered with ${tooLarge.message}`, target, {
      cause: tooLarge,
      kind: 'other',
    });
  }
  if (error instanceof Undecodable) {
    const zlibError = error.cause as { errno?: unknown; code?: unknown; message?: unknown };
    return new RequestFailed(
      zlibError.code !== 'Z_DATA_ERROR'
        ? `${target} answered and then stopped sending`
        : `the response said content-encoding ${error.encoding} but could not be decoded: ${String(zlibError.message)}`,
      target,
      { cause: error.cause, kind: 'other' },
    );
  }
  const broken = error instanceof Broken ? error : new Broken('send', 0, null, error);
  const cause = broken.cause as Error & { code?: unknown };
  // Node's client throws the socket's own error; fetch wrapped it, and no hop is fetch's now.
  const code = cause.code;
  const message = String(cause.message);
  const said = (words: string, kind: FailureKind) =>
    new RequestFailed(words, target, { cause, kind });
  if (aborted) {
    const where = whereOf(hop);
    return broken.stage === 'send'
      ? said(`${where} did not answer within ${floatString(timeoutMs / 1000)}s`, 'timeout')
      : said(`${where} stopped sending before the response ended`, 'connection');
  }
  const closed = message === 'socket hang up' || message === 'aborted';
  const wasReset = code === 'ECONNRESET' && !closed;
  if (broken.stage === 'send') {
    if (closed) return said(`${target}: the connection closed without a response`, 'connection');
    if (wasReset) {
      return said(`${target}: the connection was reset (Connection reset by peer)`, 'connection');
    }
    const unmade = neverConnected(cause, hop, path, landed, broken.proxy);
    if (unmade !== null) return said(unmade, 'connection');
    return said(`could not reach ${target}: ${String(cause.message || cause)}`, 'connection');
  }
  if (wasReset) {
    return said(
      `${target}: the connection was reset mid-response (Connection reset by peer)`,
      'other',
    );
  }
  if (closed && broken.length !== null) {
    const short = `${String(broken.read)} bytes read, ${String(broken.length - broken.read)} more expected`;
    return said(`${target}: the response ended early (${short})`, 'other');
  }
  return said(`${target} answered and then stopped sending`, 'other');
}

/**
 * The hops of one request: redirects followed by the established rules, each hop over
 * node's client (`viaNode`).
 *
 * FOLLOWED HERE, not by the client, because the established rules are their own. fetch
 * gave up after 20 with `fetch failed`; the established client follows 30 and refuses the
 * 31st with `Exceeded 30 redirects.` A 302 turns anything but HEAD into GET for it and only
 * a POST for fetch; a 303 does the same; a 301 turns a POST into GET for both. And every
 * redirect but 307 and 308 drops the body, with its Content-Type and Content-Length, even
 * where the method stays -- fetch sent a 301'd PUT's body again.
 *
 * CONNECT IS REFUSED, in the words fetch refused it with, as it always was: node's client
 * reads any answer to a CONNECT as the start of a tunnel, not as a response, where the
 * established client reads it as a response.
 */
async function resolveRedirects(
  target: string,
  method: string,
  headers: HeaderList,
  body: string | Buffer | undefined,
  timeoutMs: number,
  interrupted?: AbortSignal,
  binary = false,
  sameOriginRedirects = false,
  followRedirects = true,
  loopbackOrigin?: RequestOptions['loopbackOrigin'],
  maxBytes?: number,
): Promise<HttpResponse> {
  const prepared = prepareUrl(target);
  let url: URL;
  try {
    url = new URL(prepared?.url ?? target);
  } catch (error) {
    // fetch's own words for the same input, which is what this said before it parsed.
    throw new RequestFailed(
      `could not reach ${target}: Failed to parse URL from ${target}`,
      target,
      {
        cause: error,
      },
    );
  }
  // THE WHOLE EXCHANGE, not just the connect. The established client's timeout is per
  // socket operation and this is a deadline, which is stricter -- a server trickling one
  // byte per second satisfies the first and not the second. Stricter is the right direction
  // for a tool whose callers all sit inside their own retry loop with their own budget.
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  interrupted?.addEventListener('abort', () => controller.abort(), { once: true });
  let path = prepared?.target ?? `${url.pathname}${url.search}`;
  // The response's URL: the URL as prepared, fragment and all.
  let landed = prepared?.url ?? url.href;
  let verb = method;
  let payload = body;
  let sent = headers;
  try {
    for (let redirects = 0; ; redirects += 1) {
      let answer: Answer;
      try {
        if (verb === 'CONNECT') throw new TypeError("'CONNECT' HTTP method is unsupported.");
        answer = await viaNode(
          url,
          path,
          verb,
          sent,
          payload,
          controller.signal,
          loopbackOrigin,
          maxBytes,
        );
      } catch (error) {
        throw failed(error, url, path, landed, target, timeoutMs, controller.signal.aborted);
      }
      const location = answer.headers.location;
      if (followRedirects && REDIRECTS.has(answer.status) && location !== undefined) {
        await answer.discard();
        // Thirty redirects followed: the 31st is the one refused.
        if (redirects >= MAX_REDIRECTS)
          throw new RequestFailed(`Exceeded ${String(MAX_REDIRECTS)} redirects.`, target, {
            kind: 'other',
          });
        // The requoted location resolved against the URL, keeping the fragment when the new
        // location has none (RFC 7231 7.1.2).
        try {
          const next = new URL(requoteUri(location), url);
          if (sameOriginRedirects && next.origin !== new URL(target).origin)
            throw new Error('cross-origin download redirect refused');
          if (next.hash === '') next.hash = url.hash;
          url = next;
        } catch (error) {
          throw new RequestFailed(`could not reach ${target}: ${String(error)}`, target, {
            cause: error,
          });
        }
        landed = url.href;
        path = requestTarget(url.href);
        if (answer.status === 303 && verb !== 'HEAD') verb = 'GET';
        if (answer.status === 302 && verb !== 'HEAD') verb = 'GET';
        if (answer.status === 301 && verb === 'POST') verb = 'GET';
        if (answer.status !== 307 && answer.status !== 308) {
          payload = undefined;
          sent = sent.filter(
            ([name]) =>
              !['content-length', 'content-type', 'transfer-encoding'].includes(name.toLowerCase()),
          );
        }
        continue;
      }
      let text: string;
      let bytes: Buffer | undefined;
      try {
        if (binary) {
          bytes = await answer.bytes();
          text = new TextDecoder('utf-8').decode(bytes);
        } else text = await answer.text();
      } catch (error) {
        throw failed(error, url, path, landed, target, timeoutMs, controller.signal.aborted);
      }
      return {
        status: answer.status,
        reason: answer.reason,
        ok: answer.status < 400,
        text,
        ...(bytes === undefined ? {} : { bytes }),
        headers: answer.headers,
        url: landed,
        json: () => JSON.parse(text) as unknown,
      };
    }
  } finally {
    clearTimeout(deadline);
  }
}

/** Make one HTTP request. The single network call site. */
async function request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  const target = withParams(url, options.params);
  const method = (options.method ?? 'GET').toUpperCase();
  if (options.body !== undefined && options.json !== undefined) {
    throw new RequestFailed('a request cannot carry both JSON and a raw body', target, {
      kind: 'other',
    });
  }
  const body = options.body ?? jsonBody(options.json, target);
  // The JSON Content-Type only when the caller did not say: an explicit Content-Type wins
  // over the one a JSON body would have set. After the Content-Length, in the established
  // order (see `preparedHeaders`).
  const headers = preparedHeaders(options.headers ?? {}, method, body);
  // A WAIT A CTRL-C REACHES: the exchange is abandoned and the interrupt raised in its
  // place. `seed` restores the two settings it turned off only if its `finally` runs, and a
  // Ctrl-C lands in a request far more often than anywhere else in it.
  return await interruptibly(() => {
    const interrupted = new AbortController();
    return {
      done: resolveRedirects(
        target,
        method,
        headers,
        body,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        interrupted.signal,
        options.binary === true,
        options.sameOriginRedirects === true,
        options.followRedirects !== false,
        options.loopbackOrigin,
        options.maxBytes,
      ),
      stop: () => interrupted.abort(),
    };
  });
}

/**
 * The seam, as an object.
 *
 * A module-level function binding cannot be replaced from outside under this build --
 * swc emits ES module exports as non-configurable getters, so `jest.spyOn` on one fails
 * with "Cannot redefine property". Hanging the callable off an exported object is what
 * `seams/kubectl.ts` and `core/kube/exec.ts` do, for the same reason.
 */
export const rcHttp = { request };
