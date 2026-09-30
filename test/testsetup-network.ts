/**
 * The suite does not reach the network, and a test that tries is FAILED, not forgiven.
 *
 * The fourth fixture, and one earlier releases' suite never had: its one real call to
 * `releases.rocket.chat` was cured by a stub of the versions lookup's HTTP get, so the reason
 * for a guard had to be measured again, here.
 *
 * MEASURED, not assumed. The whole Jest suite was run with every name lookup, socket
 * connect and `fetch` to a non-loopback address recorded. It passes 1904/1904 with no
 * network at all -- and it still made ONE real reach: `test/core/doctor.test.ts` runs the
 * doctor's `versions` check, which asked `https://releases.rocket.chat/8.5.1/info` over the
 * wire. Offline that degrades to "could not reach", which the test tolerates; online it
 * reads a live answer. A test whose path depends on whether the machine is online is one
 * that passes here and fails somewhere else, and nobody sees the difference until then.
 *
 * ## Why the reach FAILS the test instead of merely throwing
 *
 * `seams/rc-http` turns any rejection into `RequestFailed("could not reach ...")`, and every
 * caller already handles that -- which is exactly the problem. A guard that only threw would
 * put every such test on the offline branch and let it pass, so the reach would be HIDDEN
 * rather than REMOVED. So the attempt is refused (nothing leaves the machine; the rejection
 * has the shape undici gives when a name does not resolve), recorded, and the test that made
 * it fails in `afterEach` with the URL named. The cure is the test owning its stub.
 *
 * Loopback is not the network: the web layer's integration tests and `seams/rc-http`'s own
 * contract tests talk to a server this process started on 127.0.0.1, and they pass through.
 *
 * ## `node:http` and `node:https` too, because the seam speaks through them
 *
 * `seams/rc-http` sends every hop through node's own client now, not fetch -- fetch adds
 * headers requests never sends and cannot be told not to -- so a guard on the
 * `fetch` global alone would see none of the seam's requests. `request` and `get` of both
 * modules are wrapped, on the REAL module objects, which outlive each test file as
 * `child_process` does in `testsetup-cloud.ts`: installed once per worker, the recorder
 * re-pointed by every file. A refused request is a real `ClientRequest` whose connection is
 * never opened -- its `createConnection` throws -- so it fails with the shape node gives a
 * name that does not resolve, and nothing is dialled, an IP literal included.
 *
 * NOT GUARDED, and recorded rather than implied: `node:tls`, `node:net` and raw sockets.
 * Only `seams/rc-http.ts` may call `fetch` (an eslint `no-restricted-globals` rule), and the
 * same measurement found no socket-level reach outside it. `tls.verify` dials whatever host
 * it is given; every test of it dials loopback.
 */
import type * as HttpNS from 'node:http';

const GUARD = Symbol.for('houston.test.network-guard');

interface NetworkGuard {
  /** Every refused reach since the last check, as `METHOD url`. */
  readonly reaches: string[];
}

function loopback(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare === 'localhost' || bare === '::1' || /^127\.\d+\.\d+\.\d+$/u.test(bare);
}

function requestOf(input: unknown, init: RequestInit | undefined): { url: string; method: string } {
  if (typeof input === 'string') return { url: input, method: init?.method ?? 'GET' };
  if (input instanceof URL) return { url: input.href, method: init?.method ?? 'GET' };
  const request = input as { url?: string; method?: string };
  return { url: String(request.url ?? input), method: init?.method ?? request.method ?? 'GET' };
}

const holder = globalThis as unknown as Record<symbol, NetworkGuard | undefined>;
if (holder[GUARD] === undefined) {
  const guard: NetworkGuard = { reaches: [] };
  holder[GUARD] = guard;
  const realFetch = globalThis.fetch;

  globalThis.fetch = function guardedFetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    const { url, method } = requestOf(input, init);
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
    const network = parsed !== undefined && /^(https?|wss?):$/u.test(parsed.protocol);
    if (!network || loopback(parsed?.hostname ?? '')) return realFetch(input, init);

    guard.reaches.push(`${method.toUpperCase()} ${url}`);
    // The shape undici rejects with when a name does not resolve, so the code under test
    // takes the path a genuinely offline machine takes -- and the test still fails below.
    const cause = Object.assign(
      new Error(
        `getaddrinfo ENOTFOUND ${parsed?.hostname ?? url} (refused: the test suite does not ` +
          'reach the network)',
      ),
      { code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: parsed?.hostname },
    );
    return Promise.reject(new TypeError('fetch failed', { cause }));
  } as typeof fetch;

  const verdict = (when: string): void => {
    if (guard.reaches.length === 0) return;
    const named = guard.reaches.splice(0);
    throw new Error(
      `${when} reached the network: ${named.join(', ')}. Nothing left the machine -- the ` +
        'request was refused -- but a test whose answer depends on whether this box is ' +
        'online passes here and fails on a runner. Stub src/seams/rc-http.ts, or the ' +
        'core/rcapi.ts function above it, in the test that owns the call.',
    );
  };
  afterEach(() => {
    verdict('this test');
  });
  afterAll(() => {
    verdict('a hook in this file');
  });
}

// --- node:http and node:https -----------------------------------------------------------

interface ClientBackstop {
  /** Re-pointed by every test file, because the module object outlives each of them. */
  note: (reach: string) => void;
}
type Requester = (...call: unknown[]) => HttpNS.ClientRequest;
type ClientModule = Record<'request' | 'get', Requester> &
  Record<symbol, ClientBackstop | undefined>;

const CLIENT_BACKSTOP = Symbol.for('houston.test.network-client-backstop');

/** `request(options[, cb])` or `request(url[, options][, cb])`: where it would go, and how. */
function destinationOf(
  scheme: string,
  call: readonly unknown[],
): { url: string; method: string; host: string } | null {
  const [first, second] = call;
  let url: URL | undefined;
  let options: Record<string, unknown> = {};
  if (typeof first === 'string' || first instanceof URL) {
    try {
      url = new URL(String(first));
    } catch {
      return null;
    }
    if (typeof second === 'object' && second !== null) options = second as Record<string, unknown>;
  } else if (typeof first === 'object' && first !== null) {
    options = first as Record<string, unknown>;
  }
  if (options.socketPath !== undefined) return null;
  const bare = (value: unknown) => String(value).replace(/^\[(.*)\]$/u, '$1');
  const host = bare(options.hostname ?? options.host ?? url?.hostname ?? 'localhost');
  const port = String(options.port ?? url?.port ?? '');
  const protocol = String(options.protocol ?? url?.protocol ?? scheme);
  const shown = host.includes(':') ? `[${host}]` : host;
  const where = String(options.path ?? (url === undefined ? '/' : `${url.pathname}${url.search}`));
  return {
    url: `${protocol}//${shown}${port === '' ? '' : `:${port}`}${where}`,
    method: String(options.method ?? 'GET').toUpperCase(),
    host,
  };
}

/** The same call, its connection replaced by one that fails before anything is dialled. */
function refusedCall(call: readonly unknown[], refusal: Error): unknown[] {
  const never = {
    agent: undefined,
    createConnection: () => {
      throw refusal;
    },
  };
  const [first, second, ...rest] = call;
  if (typeof first === 'string' || first instanceof URL) {
    if (typeof second === 'object' && second !== null)
      return [first, { ...(second as object), ...never }, ...rest];
    return [first, never, ...(second === undefined ? [] : [second]), ...rest];
  }
  return [{ ...(first as object), ...never }, ...call.slice(1)];
}

for (const [id, scheme] of [
  ['node:http', 'http:'],
  ['node:https', 'https:'],
] as const) {
  // THE REAL MODULE OBJECT, not an import-interop copy of it: `seams/rc-http` reads
  // `request` from this object at every call, and a patch on a copy would reach nothing.
  const client = require(id) as ClientModule;
  if (client[CLIENT_BACKSTOP] === undefined) {
    const state: ClientBackstop = { note: () => undefined };
    client[CLIENT_BACKSTOP] = state;
    const intercept = (real: Requester): Requester =>
      function guardedRequest(this: unknown, ...call: unknown[]): HttpNS.ClientRequest {
        const where = destinationOf(scheme, call);
        if (where === null || loopback(where.host)) return real.apply(this, call);
        state.note(`${where.method} ${where.url}`);
        // The shape node's client fails with when a name does not resolve, as the fetch
        // guard's is undici's, so the code under test takes the offline path.
        const refusal = Object.assign(
          new Error(
            `getaddrinfo ENOTFOUND ${where.host} (refused: the test suite does not reach the ` +
              'network)',
          ),
          { code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: where.host },
        );
        return real.apply(this, refusedCall(call, refusal));
      };
    client.request = intercept(client.request);
    client.get = intercept(client.get);
  }
  (client[CLIENT_BACKSTOP] as ClientBackstop).note = (reach: string) => {
    (holder[GUARD] as NetworkGuard).reaches.push(reach);
  };
}
