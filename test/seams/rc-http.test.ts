/**
 * The HTTP seam, against a real socket.
 *
 * A stubbed `fetch` would prove the seam agrees with my idea of fetch, which is not the question --
 * the question is whether the contract rcapi's 44 call sites were written against survives the move
 * to `fetch`. So every case here runs a real server on loopback, and the two that are about NOT
 * reaching one use a closed port and a server that never answers.
 *
 * The same shape as `exec.test.ts`, which runs real processes for the same reason.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

import { loads } from '../../src/lib/json-text';
import { DEFAULT_TIMEOUT_MS, RequestFailed, rcHttp } from '../../src/seams/rc-http';

/**
 * What earlier releases' HTTP client did with the same requests, recorded: the body and
 * Content-Type it prepared or the refusal (keyed by method and document), the failure it
 * raised (keyed by case, with `{PORT}` for the port of the URL asked and `{OTHER_PORT}` for
 * a redirect's or a proxy's), the URL and target it sent (with `{ORIGIN}`), and the request
 * lines and headers the server read from it (with `{PORT}`, and its own default User-Agent
 * value written as `<the default>`).
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'seams', 'rc-http.json'), 'utf8'),
) as {
  prepared: Record<string, { body: string; ctype: string | null; error: string }>;
  raised: Record<string, { message: string; kind: string }>;
  prepared_url: Record<string, { url: string; target: string }>;
  headers: Record<string, Record<string, Exchange[]>>;
};

/** A recorded value that must exist. */
function recordedEntry<T>(table: Record<string, T>, key: string): T {
  expect(Object.keys(table)).toContain(key);
  return table[key] as T;
}

/** The port of a URL this run made. */
function portOf(url: string): string {
  return new URL(url).port;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server | null = null;
let origin = '';

/** The last request the server saw: method, path, headers, body. */
let seen: {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
} | null = null;

async function serving(handler: Handler): Promise<string> {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${String(port)}`;
  return origin;
}

/** A port nothing is listening on: the server is opened and closed to reserve it. */
async function closedPort(host = '127.0.0.1'): Promise<string> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, host, resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://${host.includes(':') ? `[${host}]` : host}:${String(port)}`;
}

/** This process's environment without a proxy variable, so a case names its own. */
function withoutProxies(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(https?|no|all)_proxy$/iu.test(name)),
  );
}

/** Stop the current server, so a test can start another. */
async function closing(): Promise<void> {
  if (server === null) return;
  const stopping = server;
  server = null;
  stopping.closeAllConnections();
  await new Promise<void>((resolve) => stopping.close(() => resolve()));
}

afterEach(async () => {
  seen = null;
  if (server !== null) {
    const closing = server;
    server = null;
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
});

describe('what an HTTP status means', () => {
  it('never throws for one, because rcapi reads the number', async () => {
    // Earlier releases' HTTP client returns 404s and 500s as responses and rcapi's error
    // handling reads the status, so a seam that threw on 4xx would silently invert two dozen
    // branches -- every check for a 200 would become unreachable.
    await serving((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"success":false}');
    });
    const resp = await rcHttp.request(origin);
    expect(resp.status).toBe(404);
    expect(resp.json()).toEqual({ success: false });
  });

  it('calls 2xx and 3xx ok, and 4xx and 5xx not, as earlier releases do', async () => {
    // `resp.ok` is `status < 400`, NOT `status === 200`. Four rcapi functions return it
    // directly, so narrowing it to 200 would report a 201 as a failed create.
    for (const [status, ok] of [
      [200, true],
      [201, true],
      [204, true],
      [304, true],
      [400, false],
      [403, false],
      [500, false],
    ] as [number, boolean][]) {
      await serving((_req, res) => {
        res.writeHead(status);
        res.end(status === 204 || status === 304 ? undefined : 'body');
      });
      const resp = await rcHttp.request(origin);
      expect([resp.status, resp.ok]).toEqual([status, ok]);
      if (server !== null) {
        const closing = server;
        server = null;
        closing.closeAllConnections();
        await new Promise<void>((resolve) => closing.close(() => resolve()));
      }
    }
  }, 30_000);
});

describe('the body', () => {
  it('throws from json() but keeps the text, which is the part an operator needs', async () => {
    // A 200 carrying a proxy's HTML error page is the case: three rcapi call sites catch
    // the parse failure and fall through to a message quoting the text's first 200
    // characters, which is the only useful thing such a page ever provides.
    await serving((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>502 Bad Gateway</body></html>');
    });
    const resp = await rcHttp.request(origin);
    expect(resp.status).toBe(200);
    expect(() => resp.json()).toThrow();
    expect(resp.text).toContain('502 Bad Gateway');
  });

  it('sends a JSON body and sets the type, unless the caller set one', async () => {
    await serving((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    await rcHttp.request(origin, { method: 'POST', json: { user: 'a', password: 'b' } });
    expect(seen?.headers['content-type']).toBe('application/json');
    // Earlier releases' JSON separators, which is what they send (see 'the JSON body' below).
    expect(seen?.body).toBe('{"user": "a", "password": "b"}');

    // An explicit Content-Type wins, exactly as it does in earlier releases.
    await rcHttp.request(origin, {
      method: 'POST',
      json: {},
      headers: { 'Content-Type': 'application/x-custom' },
    });
    expect(seen?.headers['content-type']).toBe('application/x-custom');
  });

  it('upper-cases the method and defaults to GET', async () => {
    await serving((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    await rcHttp.request(origin, { method: 'post' });
    expect(seen?.method).toBe('POST');
    await rcHttp.request(origin);
    expect(seen?.method).toBe('GET');
  });
});

/**
 * What earlier releases prepared for a request with this method and JSON document: the
 * body, its Content-Type, or the refusal they raised instead.
 */
function prepared(
  document: string | null,
  method = 'POST',
): { body: string; ctype: string | null; error: string } {
  return recordedEntry(RECORDED.prepared, `${method} ${document ?? ''}`);
}

describe('the JSON body', () => {
  // `JSON.stringify` wrote compact separators and raw non-ASCII, wrote NaN and the
  // infinities as `null`, and sent `null` for no document, where earlier releases send no
  // body at all. Each document is read by `json-text.loads` here, which is how `api -d`
  // reads one, as earlier releases read it with their own.
  it.each<[string, string | null]>([
    ['an object', '{"user": "a", "password": "b", "n": [1, 2.5, -0.5, true, null]}'],
    ['non-ASCII, astral and DEL', '["caf\u00e9", "\u{1f600}", "\u007f", "tab\\there"]'],
    ['a bare string', '"x"'],
    ['empty containers', '{"a": {}, "b": []}'],
    ['a falsy value, which is still a body', '0'],
    ['None', null],
    ['NaN', '{"a": NaN}'],
    ['an overflowing exponent', '[1e400]'],
    ['minus Infinity', '-Infinity'],
  ])('sends %s as earlier releases send a JSON body', async (_label, document) => {
    await serving((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    const theirs = prepared(document);
    let error = '';
    try {
      await rcHttp.request(origin, {
        method: 'POST',
        json: document === null ? null : loads(document),
      });
    } catch (failure) {
      expect(failure).toBeInstanceOf(RequestFailed);
      error = (failure as Error).message;
    }
    const ours = {
      body: seen?.body ?? '',
      ctype: seen === null ? null : (seen.headers['content-type'] ?? null),
      error,
    };
    expect(ours).toEqual(theirs);
    // A refused body is refused BEFORE anything is sent, as earlier releases refuse it.
    if (theirs.error !== '') expect(seen).toBeNull();
  });
});

describe('what fetch will not send', () => {
  // fetch refuses a body on GET and HEAD and refuses TRACE and TRACK outright; earlier
  // releases send all of them, and `houston api` reaches every one. The seam takes those
  // around fetch and nothing else.
  it.each<[string, string, string | null]>([
    ['a GET with a body', 'GET', '{"a": 1}'],
    ['a HEAD with a body', 'HEAD', '"x"'],
    ['a TRACE', 'TRACE', null],
    ['a TRACE with a body', 'TRACE', '[1, "\u00e9"]'],
  ])('sends %s as earlier releases prepare it', async (_label, method, document) => {
    await serving((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok": true}');
    });
    const resp = await rcHttp.request(`${origin}/x?q=1`, {
      method,
      json: document === null ? null : loads(document),
    });
    const theirs = prepared(document, method);
    expect({
      method: seen?.method,
      url: seen?.url,
      body: seen?.body,
      ctype: seen?.headers['content-type'] ?? null,
    }).toEqual({ method, url: '/x?q=1', body: theirs.body, ctype: theirs.ctype });
    if (theirs.body !== '')
      expect(seen?.headers['content-length']).toBe(String(Buffer.byteLength(theirs.body)));
    // The response reads as every other one does.
    expect([resp.status, resp.ok, resp.url]).toEqual([200, true, `${origin}/x?q=1`]);
    expect(resp.text).toBe(method === 'HEAD' ? '' : '{"ok": true}');
  });

  it('sends a TRACK, which this server cannot even parse', async () => {
    // node's own parser knows no TRACK and answers 400 itself: an ANSWER, where fetch would
    // have refused to send the request at all.
    await serving((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    expect((await rcHttp.request(origin, { method: 'TRACK' })).status).toBe(400);
  });

  it('keeps the seam contract on that path: refused, silent, compressed', async () => {
    const get = { method: 'GET', json: {}, timeoutMs: 5_000 } as const;
    const dead = await closedPort();
    await expect(rcHttp.request(dead, get)).rejects.toThrow(
      `cannot connect to 127.0.0.1:${dead.split(':')[2] as string} (/): Connection refused`,
    );

    await serving(() => {
      /* accept, and never answer */
    });
    await expect(rcHttp.request(origin, { ...get, timeoutMs: 250 })).rejects.toThrow(
      `127.0.0.1:${origin.split(':')[2] as string} did not answer within 0.25s`,
    );
    await closing();

    await serving((_req, res) => {
      res.writeHead(200, { 'Content-Encoding': 'gzip' });
      res.end(gzipSync('{"zipped": true}'));
    });
    expect((await rcHttp.request(origin, get)).json()).toEqual({ zipped: true });
  });
});

/**
 * What earlier releases raised for the same failing request, recorded under `key`: its
 * words, with this run's ports put back, and whether its class was a connection failure
 * or a timeout.
 */
function raised(key: string, port: string, otherPort = ''): { message: string; kind: string } {
  const answer = recordedEntry(RECORDED.raised, key);
  return {
    message: answer.message.split('{PORT}').join(port).split('{OTHER_PORT}').join(otherPort),
    kind: answer.kind,
  };
}

describe('what a failure is called', () => {
  // `api` prints a transport failure after `request failed: `, and the PAT mint after
  // `could not reach <path>: `, and earlier releases print their HTTP client's own words
  // there. This seam printed its own words: `fetch failed`, `answered and then stopped
  // sending`, `did not answer within 30000ms`. The class matters as well as the words: the
  // readiness check reads only a connection failure or a timeout as "not answering yet".
  const scenarios: [string, (req: http.IncomingMessage, res: http.ServerResponse) => void][] = [
    [
      'closed before a status line',
      (_req, res) => {
        res.socket?.end();
      },
    ],
    [
      'reset before a status line',
      (_req, res) => {
        res.socket?.resetAndDestroy();
      },
    ],
    [
      'a body short of its length',
      (_req, res) => {
        res.writeHead(200, { 'Content-Length': '100' });
        res.write('{"partial":', () => setTimeout(() => res.socket?.end(), 50));
      },
    ],
    [
      'reset in the body',
      (_req, res) => {
        res.writeHead(200, { 'Content-Length': '100' });
        res.write('{"partial":', () => setTimeout(() => res.socket?.resetAndDestroy(), 50));
      },
    ],
    [
      'silent until the deadline',
      () => {
        /* accept, and never answer */
      },
    ],
    [
      'silent in the body',
      (_req, res) => {
        res.writeHead(200, { 'Content-Length': '100' });
        res.write('{"partial":');
      },
    ],
    [
      'a redirect loop',
      (_req, res) => {
        res.writeHead(302, { Location: '/loop', 'Content-Length': '0' });
        res.end();
      },
    ],
    // Earlier releases' content-decoding error, which is not "not answering yet": node's zlib
    // error read as a refused connection once every body came through node's client.
    [
      'a body that is not the gzip it says',
      (_req, res) => {
        res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': '15' });
        res.end('not gzip at all');
      },
    ],
    [
      'a body that is not the deflate it says',
      (_req, res) => {
        res.writeHead(200, { 'Content-Encoding': 'deflate', 'Content-Length': '11' });
        res.end('not deflate');
      },
    ],
  ];
  it.each(
    scenarios.flatMap(([label, handler]) => [
      [`${label}, without a body`, handler, null] as const,
      [`${label}, a GET with a body`, handler, '{"a": 1}'] as const,
    ]),
  )(
    '%s',
    async (label, handler, document) => {
      await serving(handler);
      const url = `${origin.replace('127.0.0.1', 'localhost')}/loop`;
      const theirs = raised(label, portOf(url));
      let ours = { message: '', kind: '' };
      try {
        await rcHttp.request(url, {
          method: 'GET',
          json: document === null ? null : loads(document),
          timeoutMs: 1_000,
        });
      } catch (failure) {
        expect(failure).toBeInstanceOf(RequestFailed);
        ours = {
          message: (failure as RequestFailed).message,
          kind: (failure as RequestFailed).kind,
        };
      }
      expect(theirs.message).not.toBe('');
      expect(ours).toEqual(theirs);
    },
    30_000,
  );
});

describe('a connection that is never made', () => {
  // Named by the address, the target asked for and the reason, `cannot connect to
  // 127.0.0.1:3000 (/api/v1/login): Connection refused`, where this said `could
  // not reach <url>: fetch failed` -- quoted by config-import, monitor attach and seed, and
  // persisted as a seed's `verification.unreadable[].why`. Compared with what earlier
  // releases raised for the same request, recorded.
  const cases: [string, (dead: string) => string, string, string | null][] = [
    ['a login refused', (dead) => `${dead}/api/v1/login`, 'POST', '{"user": "admin"}'],
    [
      'a query refused, by name',
      (dead) => `${dead.replace('127.0.0.1', 'localhost')}/api/v1/users.list?count=0`,
      'GET',
      null,
    ],
    ['a host spelled in capitals', (dead) => dead.replace('127.0.0.1', 'LocalHost'), 'GET', null],
    ['the https pool', (dead) => `${dead.replace('http:', 'https:')}/api/info`, 'GET', null],
    ['a target earlier releases escape', (dead) => `${dead}/api/v1/a b?q=a'b|c`, 'DELETE', null],
  ];
  it.each(cases)(
    '%s',
    async (label, where, method, document) => {
      const url = where(await closedPort());
      const theirs = raised(label, portOf(url));
      expect(theirs.kind).toBe('connection');
      expect(await refusal(url, method, document)).toEqual(theirs);
    },
    30_000,
  );

  it('names an IPv6 host in brackets', async () => {
    const url = `${await closedPort('::1')}/api/v1/login`;
    const theirs = raised('names an IPv6 host in brackets', portOf(url));
    expect(theirs.message).toContain('cannot connect to [::1]:');
    expect(await refusal(url, 'POST', '{}')).toEqual(theirs);
  }, 30_000);

  it('names the hop that failed, after a redirect', async () => {
    const dead = await closedPort();
    await serving((_req, res) => {
      res.writeHead(302, { Location: `${dead}/next?x=1`, 'Content-Length': '0' });
      res.end();
    });
    const theirs = raised(
      'names the hop that failed, after a redirect',
      portOf(`${origin}/start`),
      portOf(dead),
    );
    expect(theirs.message).toContain(' (/next?x=1): ');
    expect(await refusal(`${origin}/start`, 'GET', null)).toEqual(theirs);
  }, 30_000);

  // Not to be made on a machine that has a network: measured in a network namespace (an
  // `unreachable` route, no route at all, no resolver, a name that does not exist) against
  // earlier releases, and the error node's client gives for each handed to the seam as the
  // connection's own.
  it.each<[string, string, Record<string, unknown>, string]>([
    [
      'no route to the network',
      'http://10.1.2.3:3000/api/info',
      { code: 'ENETUNREACH', errno: -101, syscall: 'connect', address: '10.1.2.3', port: 3000 },
      'cannot connect to 10.1.2.3:3000 (/api/info): Network is unreachable',
    ],
    [
      'no route to the host',
      'http://10.9.9.9:3000/api/info',
      { code: 'EHOSTUNREACH', errno: -113, syscall: 'connect', address: '10.9.9.9', port: 3000 },
      'cannot connect to 10.9.9.9:3000 (/api/info): No route to host',
    ],
    [
      'a name that does not exist',
      'http://rc.invalid:3000/api/info',
      { code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: 'rc.invalid' },
      'cannot resolve rc.invalid (/api/info): Name or service not known',
    ],
    [
      'no resolver to ask',
      'http://rc.invalid:3000/api/info',
      { code: 'EAI_AGAIN', errno: -3001, syscall: 'getaddrinfo', hostname: 'rc.invalid' },
      'cannot resolve rc.invalid (/api/info): Temporary failure in name resolution',
    ],
  ])('%s', async (_label, url, shape, measured) => {
    // THE REAL MODULE OBJECT, which the seam reads `request` from at every call.
    const client = require('node:http') as typeof http;
    const failure = Object.assign(
      new Error(`${String(shape.syscall)} ${String(shape.code)}`),
      shape,
    );
    const spy = jest.spyOn(client, 'request').mockImplementation(
      ((options: http.RequestOptions, answer: (incoming: http.IncomingMessage) => void) =>
        new http.ClientRequest(
          {
            ...options,
            agent: undefined,
            createConnection: () => {
              throw failure;
            },
          },
          answer,
        )) as unknown as typeof http.request,
    );
    try {
      expect(await refusal(url, 'GET', null)).toEqual({ message: measured, kind: 'connection' });
    } finally {
      spy.mockRestore();
    }
  });
});

/** What the seam raises for a request that is expected to fail, as `raised` reports it. */
async function refusal(
  url: string,
  method: string,
  document: string | null,
): Promise<{ message: string; kind: string }> {
  try {
    await rcHttp.request(url, {
      method,
      json: document === null ? null : loads(document),
      timeoutMs: 5_000,
    });
  } catch (failure) {
    expect(failure).toBeInstanceOf(RequestFailed);
    return { message: (failure as RequestFailed).message, kind: (failure as RequestFailed).kind };
  }
  throw new Error(`${url} answered`);
}

/**
 * What earlier releases prepared for `path` on this run's origin: the URL, and the target
 * they put on the request line.
 */
function preparedUrl(path: string): { url: string; target: string } {
  const answer = recordedEntry(RECORDED.prepared_url, path);
  return { url: answer.url.split('{ORIGIN}').join(origin), target: answer.target };
}

describe('the URL that goes out', () => {
  // fetch sent a URL as WHATWG rewrites it, and earlier releases send it as their HTTP
  // client prepares it: `|`, `[`, `]`, `{`, `}`, `"` and a stray `%` escaped, a backslash and
  // a TAB escaped rather than turned into `/` and dropped. Each is compared on what the
  // server saw on the request line, and on `resp.url`.
  it.each<[string, string]>([
    ['a pipe in the query', '/api/v1/x?q=a|b'],
    ['brackets in the path', '/api/v1/[x]'],
    ['a backslash', '/api/v1/a\\b'],
    ['a stray percent', '/api/v1/%zz'],
    ['a TAB', '/api/v1/x\ty'],
    ['a Rocket.Chat query document', '/api/v1/rooms.info?query={"name":{"$in":["a b"]}}'],
    ['a quote in the query, which WHATWG escapes', "/api/v1/x?q='a'"],
    ['a dot segment', '/api/v1/../x'],
    ['an escaped dot segment, which earlier releases send as dots', '/api/v1/%2e%2e/x'],
    ['an escaped unreserved character', '/api/v1/x?a=%41&b=%7e'],
    ['a lower-case escape', '/api/v1/x%2fy'],
    ['non-ASCII', '/api/v1/café'],
    ['a space and a plus', '/api/v1/a b?q=c d+e'],
    ['a fragment', '/api/v1/x#frag'],
    ['an empty query', '/api/v1/x?'],
    ['a valid escape beside a stray percent', '/api/v1/a%20%zz'],
    ['a percent before a non-ASCII letter', '/api/v1/%\u00e91'],
    ['a control character', '/api/v1/x\u0001y'],
    ['doubled slashes', '/api//v1//x'],
    ['a question mark in the query', '/api/v1/x?a=?b'],
  ])('sends %s as earlier releases send it', async (_label, path) => {
    await serving((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    const theirs = preparedUrl(path);
    const resp = await rcHttp.request(`${origin}${path}`);
    expect({ url: resp.url, target: seen?.url }).toEqual(theirs);
  });
});

describe('the query string', () => {
  it('appends params, encodes them, and respects a URL that already has one', async () => {
    await serving((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    await rcHttp.request(`${origin}/api/v1/messages`, { params: { limit: 10 } });
    expect(seen?.url).toBe('/api/v1/messages?limit=10');

    // `?count=0` is written into the path by `settingIds`, so a params object on top of
    // it must not produce a second `?`.
    await rcHttp.request(`${origin}/api/v1/settings?count=0`, { params: { foo: 'a b&c' } });
    // `+` for a space, NOT `%20`. MEASURED against earlier releases: they build the query
    // with form encoding, and produce exactly `foo=a+b%26c`.
    expect(seen?.url).toBe('/api/v1/settings?count=0&foo=a+b%26c');
  });

  it('normalises a dot segment away, which earlier releases also do', async () => {
    // Worth a case because it is the one place this seam CANNOT keep a URL byte-identical:
    // fetch resolves `/./` before the request goes out. Measured rather than assumed --
    // earlier releases prepare `http://h/api//v1/./info` as `http://h/api//v1/info` too, so
    // this seam matches them rather than differing. The doubled slash survives on both sides.
    await serving((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    await rcHttp.request(`${origin}/api//v1/./info`, { params: {} });
    expect(seen?.url).toBe('/api//v1/info');
  });
});

describe('not reaching the other end', () => {
  it('is a RequestFailed, not a ReproError, because the seam cannot tell which', async () => {
    // A refused connection might be Rocket.Chat still booting (NotReadyError) or a dead
    // port-forward (DockerError). The seam has no way to know, and guessing would take
    // that judgement away from the module that does.
    const dead = await closedPort();
    await expect(rcHttp.request(dead, { timeoutMs: 5_000 })).rejects.toBeInstanceOf(RequestFailed);
    await expect(rcHttp.request(dead, { timeoutMs: 5_000 })).rejects.toThrow(
      /^cannot connect to 127\.0\.0\.1:\d+ \(\/\): Connection refused$/u,
    );
  }, 30_000);

  it('gives up at the deadline and says what it was', async () => {
    // An HTTP client without a timeout waits FOREVER: a socket to a host that accepts and
    // then says nothing never returns. This is the floor that stops that.
    await serving(() => {
      /* accept, and never answer */
    });
    const started = Date.now();
    // Named by the address and the wait (see 'what a failure is called').
    await expect(rcHttp.request(origin, { timeoutMs: 250 })).rejects.toThrow(
      / did not answer within 0\.25s$/u,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it('carries the underlying error as the cause', async () => {
    const dead = await closedPort();
    let failure: unknown;
    try {
      await rcHttp.request(dead, { timeoutMs: 5_000 });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RequestFailed);
    expect((failure as RequestFailed).cause).toBeDefined();
    expect((failure as RequestFailed).url).toBe(dead);
  }, 30_000);

  it('has a deadline even when the caller forgets one', async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });
});

describe('redirects and headers', () => {
  it('follows a redirect, which is what made one login failure so confusing', async () => {
    // A reverse proxy's 302 to HTTPS is followed, so what comes back is not a 2FA
    // challenge -- and rcapi used to read it as one and blame a missing Mailpit URL.
    // Earlier releases follow by default too, so this is their behaviour, not a choice.
    await serving((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/landed' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"landed":true}');
    });
    const resp = await rcHttp.request(`${origin}/start`);
    expect(resp.status).toBe(200);
    expect(resp.json()).toEqual({ landed: true });
    expect(resp.url).toContain('/landed');
  });

  it('lower-cases response header names, so a caller reads one spelling', async () => {
    await serving((_req, res) => {
      res.writeHead(200, { 'X-Custom-Thing': 'yes', 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const resp = await rcHttp.request(origin);
    expect(resp.headers['x-custom-thing']).toBe('yes');
  });

  it('sends the headers it was given, verbatim', async () => {
    await serving((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    await rcHttp.request(origin, {
      headers: { 'X-Auth-Token': 'tok', 'X-User-Id': 'uid', 'x-2fa-method': 'password' },
    });
    expect(seen?.headers['x-auth-token']).toBe('tok');
    expect(seen?.headers['x-user-id']).toBe('uid');
    expect(seen?.headers['x-2fa-method']).toBe('password');
  });
});

/** One request as the server read it: the request line, and every header in order, as spelled. */
type Exchange = [string, ...[string, string][]];

/** A server that records every request it reads, and redirects `/r301`, `/r302`, `/r307`. */
async function recording(): Promise<Exchange[]> {
  const exchanges: Exchange[] = [];
  await serving((req, res) => {
    const pairs: [string, string][] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      pairs.push([req.rawHeaders[i] as string, req.rawHeaders[i + 1] as string]);
    exchanges.push([`${req.method ?? ''} ${req.url ?? ''}`, ...pairs]);
    const moved = /^\/r(30[127])$/u.exec(req.url ?? '');
    res.writeHead(moved === null ? 200 : Number(moved[1]), {
      ...(moved === null ? {} : { Location: '/x' }),
      Connection: 'close',
    });
    res.end(moved === null ? '{}' : undefined);
  });
  return exchanges;
}

describe('the headers that go out', () => {
  // Every request went out through fetch, which sends `accept-language: *` and
  // `sec-fetch-mode: cors` as well, puts its own defaults after the caller's headers and the
  // JSON Content-Type before the Content-Length, and cannot be told otherwise: every request
  // of seed, config-import, monitor and every other REST command carried other headers, in
  // another order, than earlier releases'. Compared here line for line -- the request line,
  // then each header's name as spelled and its value -- with what earlier releases sent to
  // the same server, every hop of a redirect included, recorded.
  //
  // The one difference kept is the User-Agent's VALUE, by the owner's decision: this build
  // says `node` where earlier releases send their HTTP client's own name and version. Its
  // place is theirs; the recording writes their value as `<the default>`.
  const unagent = (exchanges: Exchange[]): Exchange[] =>
    exchanges.map(
      ([line, ...pairs]) =>
        [
          line,
          ...pairs.map(([name, value]): [string, string] =>
            name === 'User-Agent' && value === 'node' ? [name, '<the default>'] : [name, value],
          ),
        ] as Exchange,
    );
  /** What the server read from earlier releases for this case and host, with this run's port. */
  const sentByEarlierReleases = (label: string, host: string, port: string): Exchange[] =>
    (recordedEntry(RECORDED.headers, label)[host] ?? []).map(
      ([line, ...pairs]) =>
        [
          line,
          ...pairs.map(([name, value]): [string, string] => [
            name,
            value.split('{PORT}').join(port),
          ]),
        ] as Exchange,
    );
  const LOGIN = { user: 'admin', password: 'admin123' };
  it.each<[string, string, string, Record<string, string> | null, unknown]>([
    ['a GET', 'GET', '/x', null, undefined],
    ['a login: earlier releases put the Content-Type after the length', 'POST', '/x', null, LOGIN],
    [
      'a setting written with the caller Content-Type and the 2FA headers',
      'POST',
      '/x',
      {
        'X-Auth-Token': 'tok',
        'X-User-Id': 'uid',
        'Content-Type': 'application/json',
        'x-2fa-code': 'c0de',
        'x-2fa-method': 'password',
      },
      { value: true },
    ],
    ['an authed GET', 'GET', '/x', { 'X-Auth-Token': 'tok', 'X-User-Id': 'uid' }, undefined],
    ['a POST without a body, which still says its length', 'POST', '/x', null, undefined],
    ['a DELETE without a body, the same', 'DELETE', '/x', null, undefined],
    ['an OPTIONS, the same', 'OPTIONS', '/x', null, undefined],
    [
      'a caller header in the place of the default it names, in its spelling',
      'PUT',
      '/x',
      { accept: 'application/json', 'user-agent': 'a-script/1.0' },
      undefined,
    ],
    ['a GET with a body', 'GET', '/x', null, { a: 1 }],
    [
      'a PUT a 301 moves: the body is dropped, and the length said is 0',
      'PUT',
      '/r301',
      null,
      { a: 1 },
    ],
    ['a POST a 302 turns into a GET', 'POST', '/r302', { 'X-Auth-Token': 't' }, { a: 1 }],
    ['a POST a 307 sends again', 'POST', '/r307', null, { a: 1 }],
  ])(
    '%s',
    async (label, method, route, headers, value) => {
      const exchanges = await recording();
      for (const host of ['127.0.0.1', 'localhost']) {
        const url = `${origin.replace('127.0.0.1', host)}${route}`;
        const theirs = sentByEarlierReleases(label, host, portOf(url));
        await rcHttp.request(url, {
          method,
          ...(headers === null ? {} : { headers }),
          ...(value === undefined ? {} : { json: value }),
        });
        const ours = exchanges.splice(0);
        expect(unagent(ours)).toEqual(theirs);
        // The recorded difference, and only where earlier releases send their own.
        if (headers?.['user-agent'] === undefined) {
          expect(theirs[0]).toContainEqual(['User-Agent', '<the default>']);
          expect(ours[0]).toContainEqual(['User-Agent', 'node']);
        }
      }
    },
    30_000,
  );
});

describe('a compressed body', () => {
  // Every body is read by node's client now, and its one-shot decoders are stricter than
  // earlier releases' and fetch's: a gzip body missing its end is the text it holds for both
  // of those, and was "unexpected end of file" here.
  it('keeps what a gzip body cut short holds, as earlier releases do', async () => {
    const whole = gzipSync('{"partial": "body", "and": "more"}');
    await serving((_req, res) => {
      const cut = whole.subarray(0, whole.length - 6);
      res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': String(cut.length) });
      res.end(cut);
    });
    // What earlier releases read from the same cut body, recorded.
    const theirs = '{"partial": "body", "and": "more"}';
    expect((await rcHttp.request(origin)).text).toBe(theirs);
  });
});

describe('a proxy in the environment', () => {
  // Node reads NODE_USE_ENV_PROXY once, at startup, so each case is a process of its own:
  // the seam loaded through `tools/ts-require`, one request, and what came back.
  const ROOT = path.resolve(__dirname, '..', '..');
  const viaChild = async (url: string, env: Record<string, string>): Promise<string> => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `require(${JSON.stringify(path.join(ROOT, 'tools', 'ts-require'))}).install();` +
          `const { rcHttp } = require(${JSON.stringify(path.join(ROOT, 'src', 'seams', 'rc-http.ts'))});` +
          `rcHttp.request(${JSON.stringify(url)}, { timeoutMs: 5000 }).then(` +
          '(r) => process.stdout.write(`${r.status} ${r.text}`),' +
          '(e) => process.stdout.write(`failed: ${e.message}`));',
      ],
      { env: { ...withoutProxies(), NODE_USE_ENV_PROXY: '', ...env } },
    );
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    // Its exit is part of the claim: an agent keeping the socket would hold the process open.
    expect(await new Promise<number | null>((resolve) => child.on('close', resolve))).toBe(0);
    return out;
  };

  let proxy: http.Server | null = null;
  afterEach(async () => {
    const stopping = proxy;
    proxy = null;
    stopping?.closeAllConnections();
    await new Promise<void>((resolve) =>
      stopping === null ? resolve() : stopping.close(() => resolve()),
    );
  });

  /** A forward proxy that answers every request itself, and the request lines it read. */
  async function proxying(): Promise<{ url: string; asked: string[] }> {
    const asked: string[] = [];
    proxy = http.createServer((req, res) => {
      asked.push(`${req.method ?? ''} ${req.url ?? ''}`);
      res.writeHead(200, { Connection: 'close' });
      res.end('from the proxy');
    });
    await new Promise<void>((resolve) => proxy?.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`, asked };
  }

  it('is used under NODE_USE_ENV_PROXY, as bin/houston runs this build', async () => {
    // Every hop went through `agent: false` once fetch was gone, and an agent of one's own
    // is not given the proxy node read at startup: releases.rocket.chat, doctor's release
    // check and every REST call went around HTTP_PROXY, which earlier releases honour -- and
    // behind a proxy, a release lookup that failed paired the wrong MongoDB.
    await serving((_req, res) => res.end('direct'));
    const { url, asked } = await proxying();
    const target = `${origin}/api/info?q=1`;
    expect(await viaChild(target, { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: url })).toBe(
      '200 from the proxy',
    );
    expect(asked).toEqual([`GET ${target}`]);
  }, 30_000);

  it('is not used without it, as fetch did not use it', async () => {
    await serving((_req, res) => res.end('direct'));
    const { url, asked } = await proxying();
    expect(await viaChild(`${origin}/api/info`, { HTTP_PROXY: url })).toBe('200 direct');
    expect(asked).toEqual([]);
  }, 30_000);

  it.each<[string, string]>([
    ['for an http URL, asked of the proxy as the whole URL', 'http:'],
    ['for an https URL, tunnelled', 'https:'],
  ])(
    'names the proxy it could not reach, %s',
    async (label, scheme) => {
      const proxyUrl = await closedPort();
      const target = `${(await closedPort()).replace('http:', scheme)}/api/v1/login?q=1`;
      const env = scheme === 'http:' ? { HTTP_PROXY: proxyUrl } : { HTTPS_PROXY: proxyUrl };
      const theirs = raised(`proxy ${label}`, portOf(target), portOf(proxyUrl));
      expect(theirs.message).toContain('cannot connect to the proxy ');
      expect(await viaChild(target, { NODE_USE_ENV_PROXY: '1', ...env })).toBe(
        `failed: ${theirs.message}`,
      );
    },
    30_000,
  );
});

describe('the seam itself', () => {
  it('is a replaceable property, because a module binding is not', async () => {
    // swc emits exports as non-configurable getters, so `jest.spyOn` on a bare exported
    // function fails with "Cannot redefine property". Earlier releases carried the mirror
    // of this note on their rcapi call for the same reason.
    const real = rcHttp.request;
    try {
      rcHttp.request = () =>
        Promise.resolve({
          status: 202,
          ok: true,
          text: 'accepted',
          headers: {},
          url: 'http://stub',
          json: () => ({}),
        });
      expect((await rcHttp.request('http://rc')).status).toBe(202);
    } finally {
      rcHttp.request = real;
    }
  });
});
