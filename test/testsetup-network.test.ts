/**
 * The network fixture, proven: a non-loopback request is refused and FAILS its test, a
 * loopback one goes through, and a test that owns its stub still wins.
 *
 * "Without the fixture, the same test reaches the network" is proven outside this run, by
 * `yarn test:fixtures:prove`, which fetches an address from the RFC 5737 documentation
 * range -- unroutable by definition, so nothing is ever contacted -- with and without
 * `test/testsetup-network.ts`, and requires a socket connect in one run and none in the other.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';

import type * as RcapiNS from '../src/core/rcapi';

const GUARD = Symbol.for('houston.test.network-guard');

/** What this test itself caused, taken out so the setup file's verdict does not fire. */
function drained(): string[] {
  const holder = globalThis as unknown as Record<symbol, { reaches: string[] } | undefined>;
  return holder[GUARD]?.reaches.splice(0) ?? [];
}

describe('a request that would leave the machine', () => {
  it('is refused with the shape a name that does not resolve has', async () => {
    const reached = fetch('https://releases.rocket.chat/8.5.1/info');
    await expect(reached).rejects.toMatchObject({
      name: 'TypeError',
      message: 'fetch failed',
      cause: { code: 'ENOTFOUND', message: expect.stringContaining('does not reach the network') },
    });
    expect(drained()).toEqual(['GET https://releases.rocket.chat/8.5.1/info']);
  });

  it('is reported by the seam as a transport failure, the path an offline box takes', async () => {
    const rcapi = require('../src/core/rcapi') as typeof RcapiNS;
    expect(await rcapi.releasesReachable()).toBeNull();
    expect(drained()).toEqual(['GET https://releases.rocket.chat/8.5.1/info']);
  });

  it('names the method and the URL, for a request object as well as a string', async () => {
    await expect(fetch(new Request('https://203.0.113.10/x', { method: 'POST' }))).rejects.toThrow(
      'fetch failed',
    );
    await expect(fetch(new URL('http://example.invalid/'))).rejects.toThrow('fetch failed');
    expect(drained()).toEqual(['POST https://203.0.113.10/x', 'GET http://example.invalid/']);
  });
});

/** The error a client request ends with, or null for an answer. */
function outcome(request: http.ClientRequest): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    request.on('response', (response: http.IncomingMessage) => {
      response.resume();
      resolve(null);
    });
    request.on('error', resolve);
  });
}

describe('a request through node:http or node:https that would leave the machine', () => {
  // The seam sends every hop through node's own client now, not fetch, so a
  // guard on the fetch global alone saw none of its requests: `releasesReachable` above
  // would have dialled releases.rocket.chat.
  it('is refused with the shape node gives a name that does not resolve', async () => {
    const request = https.request({ hostname: 'releases.rocket.chat', path: '/8.5.1/info' });
    request.end();
    expect(await outcome(request)).toMatchObject({
      code: 'ENOTFOUND',
      syscall: 'getaddrinfo',
      message: expect.stringContaining('does not reach the network'),
    });
    expect(drained()).toEqual(['GET https://releases.rocket.chat/8.5.1/info']);
  });

  it('names the method and the URL, for every way of calling it', async () => {
    const refused = [
      http.request('http://203.0.113.10/x?q=1', { method: 'post' }),
      http.get(new URL('http://example.invalid:8080/')),
      https.get('https://[2001:db8::1]:8443/y'),
      http.request({ host: '198.51.100.7', port: 3000, path: '/api/info', method: 'HEAD' }),
    ];
    // Listened to at once: the refusal is emitted on the next tick, as a failed lookup is.
    const outcomes = refused.map(outcome);
    for (const request of refused) request.end();
    for (const ended of outcomes) expect(await ended).toMatchObject({ code: 'ENOTFOUND' });
    expect(drained()).toEqual([
      'POST http://203.0.113.10/x?q=1',
      'GET http://example.invalid:8080/',
      'GET https://[2001:db8::1]:8443/y',
      'HEAD http://198.51.100.7:3000/api/info',
    ]);
  });
});

describe('loopback is not the network', () => {
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    server = http.createServer((_request, response) => response.end('here'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reaches a server this process started', async () => {
    const response = await fetch(`${base}/`);
    expect(await response.text()).toBe('here');
    expect(drained()).toEqual([]);
  });

  it('reaches it through node:http as well, by every loopback name', async () => {
    const port = base.split(':')[2] as string;
    for (const host of ['127.0.0.1', 'localhost']) {
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://${host}:${port}/`, (response) => {
            let text = '';
            response.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
            response.on('end', () => resolve(text));
          })
          .on('error', reject);
      });
      expect(body).toBe('here');
    }
    expect(drained()).toEqual([]);
  });
});

describe('a test that owns a stub still wins', () => {
  afterEach(() => {
    jest.dontMock('../src/core/rcapi');
    jest.resetModules();
  });

  it('by stating the answer at the function above the seam', async () => {
    jest.resetModules();
    jest.doMock('../src/core/rcapi', () => ({
      ...jest.requireActual<typeof RcapiNS>('../src/core/rcapi'),
      releasesReachable: async () => 200,
    }));
    const rcapi = require('../src/core/rcapi') as typeof RcapiNS;
    expect(await rcapi.releasesReachable()).toBe(200);
    expect(drained()).toEqual([]);
  });

  it('by replacing fetch itself for the length of the test', async () => {
    const guarded = globalThis.fetch;
    globalThis.fetch = (async () => new Response('stubbed', { status: 200 })) as typeof fetch;
    try {
      const response = await fetch('https://releases.rocket.chat/8.5.1/info');
      expect(await response.text()).toBe('stubbed');
    } finally {
      globalThis.fetch = guarded;
    }
    expect(drained()).toEqual([]);
  });
});
