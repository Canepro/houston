import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyRequest } from 'fastify';

import * as audit from '../../../src/core/audit';

jest.mock('../../../src/core/audit', () => ({
  ...jest.requireActual('../../../src/core/audit'),
  audit: jest.fn(),
}));
jest.mock('../../../src/core/runner/engine', () => ({
  ...jest.requireActual('../../../src/core/runner/engine'),
  stream: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/naming', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/naming'),
  resolveName: jest.fn(async (name: string) => name),
}));
jest.mock('../../../src/core/topology', () => ({
  ...jest.requireActual('../../../src/core/topology'),
  ofRepro: async () => 'docker',
}));

import { createApp } from '../../../src/web/app';
import * as sessions from '../../../src/core/sessions';
import * as users from '../../../src/core/users';
import * as naming from '../../../src/core/lifecycle/naming';
import * as runnerEngine from '../../../src/core/runner/engine';
import { authenticateSocket, type LogSocket, runLogStream } from '../../../src/web/routes/logs';

const mockStream = jest.mocked(runnerEngine.stream);
const mockAudit = jest.mocked(audit.audit);
const mockResolveName = jest.mocked(naming.resolveName);

function handshake(headers: Record<string, string>): FastifyRequest {
  return {
    headers: { host: 'localhost', ...headers },
    raw: { socket: { remoteAddress: '127.0.0.1' } },
    ip: '127.0.0.1',
    params: { name: 'demo' },
    routeOptions: { url: '/api/repros/:name/logs/stream' },
  } as unknown as FastifyRequest;
}

async function signedIn(user: string): Promise<string> {
  await users.add(user, 'correct-horse-battery', 'member');
  return await sessions.create(user, { label: 'test' });
}

function upgrade(headers: Record<string, string>): Partial<IncomingMessage> {
  return {
    headers,
    socket: { remoteAddress: '127.0.0.1' } as IncomingMessage['socket'],
  };
}

class FakeSocket extends EventEmitter implements LogSocket {
  readonly CLOSING = 2;
  readyState = 1;
  readonly sent: string[] = [];

  send(value: string, done?: (error?: Error) => void): void {
    this.sent.push(value);
    done?.();
  }

  close(): void {
    if (this.readyState >= this.CLOSING) return;
    this.readyState = 3;
    this.emit('close');
  }
}

describe('the WebSocket log route', () => {
  beforeEach(() => {
    mockStream.mockReset();
    mockAudit.mockReset();
    mockResolveName.mockReset();
    mockResolveName.mockImplementation(async (name) => String(name ?? ''));
  });

  it('closes an unauthorised socket with policy code 1008 before opening a producer', async () => {
    const app = await createApp({ accounts: true });
    try {
      await app.ready();
      const close = jest.fn();
      const request = {
        headers: { host: 'localhost', origin: 'http://localhost' },
        raw: { socket: { remoteAddress: '127.0.0.1' } },
        ip: '127.0.0.1',
        params: { name: 'demo' },
        routeOptions: { url: '/api/repros/:name/logs/stream' },
      } as unknown as FastifyRequest;
      const socket = { close } as unknown as LogSocket;
      await expect(authenticateSocket(app, request, socket)).resolves.toBeNull();
      expect(close).toHaveBeenCalledWith(1008);
      expect(mockStream).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('enforces authentication in the actual registered socket handler', async () => {
    const app = await createApp({ accounts: true });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address() as AddressInfo;
      const socket = new WebSocket(
        `ws://127.0.0.1:${String(address.port)}/api/repros/demo/logs/stream`,
      );
      const closeCode = await new Promise<number>((resolve, reject) => {
        socket.addEventListener('close', (event) => resolve(event.code), { once: true });
        socket.addEventListener('error', () => reject(new Error('WebSocket client failed')), {
          once: true,
        });
      });
      expect(closeCode).toBe(1008);
      expect(mockAudit).toHaveBeenCalledWith(
        '-',
        'logs-open',
        'demo refused=no-origin',
        expect.objectContaining({ outcome: 'denied' }),
      );
      expect(mockStream).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('delivers output through the route registered with Fastify', async () => {
    mockStream.mockImplementation(async (_target, _args, onLine) => {
      onLine?.('from the registered route');
      return 0;
    });
    const app = await createApp({ accounts: false });
    try {
      await app.ready();
      let deliver!: (value: string) => void;
      const message = new Promise<string>((resolve) => {
        deliver = resolve;
      });
      const injection = app.injectWS(
        '/api/repros/demo/logs/stream',
        upgrade({ host: 'localhost' }),
        {
          onInit: (opened) =>
            opened.once('message', (data: { toString(): string }) => deliver(data.toString())),
        },
      );
      await expect(message).resolves.toBe('from the registered route');
      expect(mockStream).toHaveBeenCalledTimes(1);
      const socket = await injection;
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it('does not start a producer after disconnect during workspace resolution', async () => {
    let release!: (name: string) => void;
    mockResolveName.mockImplementation(
      async () =>
        await new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const app = await createApp({ accounts: false });
    try {
      await app.ready();
      let observeServerClose!: () => void;
      const serverClosed = new Promise<void>((resolve) => {
        observeServerClose = resolve;
      });
      app.websocketServer.once(
        'connection',
        (serverSocket: { once(event: 'close', listener: () => void): unknown }) => {
          serverSocket.once('close', observeServerClose);
        },
      );
      const socket = await app.injectWS(
        '/api/repros/demo/logs/stream',
        upgrade({ host: 'localhost' }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockResolveName).toHaveBeenCalledTimes(1);
      socket.terminate();
      await serverClosed;
      release('demo');
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockStream).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('refuses a cross-site handshake that carries a valid session', async () => {
    // The confirmed exploit: a WebSocket handshake is exempt from CORS, so the browser
    // makes it cross-origin and attaches the ambient credential itself. Refused 403 on
    // a POST and ACCEPTED here, then streamed the workspace's log.
    const token = await signedIn('cross-site-alice');
    const app = await createApp({ accounts: true });
    try {
      await app.ready();
      const close = jest.fn();
      const socket = { close } as unknown as LogSocket;
      const request = handshake({
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        cookie: `houston_session=${token}`,
      });
      await expect(authenticateSocket(app, request, socket)).resolves.toBeNull();
      expect(close).toHaveBeenCalledWith(1008);
      expect(mockAudit).toHaveBeenCalledWith(
        '-',
        'logs-open',
        'demo refused=origin',
        expect.objectContaining({ outcome: 'denied' }),
      );
    } finally {
      await app.close();
    }
  });

  it('honours a host-prefixed cookie on the socket, and never the plain name over https', async () => {
    // `__Host-` is PROOF of the scheme: a browser will not store one without Secure and
    // will not send it over http. Behind a TLS-terminating proxy the socket could resolve
    // plain http while the sign-in resolved https, and a signed-in browser was refused.
    const token = await signedIn('prefixed-alice');
    const plainHop = await createApp({ accounts: true });
    try {
      await plainHop.ready();
      const socket = { close: jest.fn() } as unknown as LogSocket;
      const request = handshake({
        origin: 'http://localhost',
        cookie: `__Host-houston_session=${token}`,
      });
      await expect(authenticateSocket(plainHop, request, socket)).resolves.toBe('prefixed-alice');
    } finally {
      await plainHop.close();
    }
    // The reverse would give back exactly what the prefix buys.
    const httpsHop = await createApp({ accounts: true, publicHttps: true });
    try {
      await httpsHop.ready();
      const close = jest.fn();
      const socket = { close } as unknown as LogSocket;
      const request = handshake({
        origin: 'https://localhost',
        cookie: `houston_session=${token}`,
      });
      await expect(authenticateSocket(httpsHop, request, socket)).resolves.toBeNull();
      expect(close).toHaveBeenCalledWith(1008);
    } finally {
      await httpsHop.close();
    }
  });

  it('coalesces repeated pre-authentication audit lines from one peer', async () => {
    const app = await createApp({ accounts: true });
    try {
      const request = {
        headers: { host: 'not-allowed.invalid' },
        raw: { socket: { remoteAddress: '192.0.2.177' } },
        ip: '192.0.2.177',
        params: { name: 'demo' },
        routeOptions: { url: '/api/repros/:name/logs/stream' },
      } as unknown as FastifyRequest;
      const socket = { close: jest.fn() } as unknown as LogSocket;
      await authenticateSocket(app, request, socket);
      await authenticateSocket(app, request, socket);
      expect(mockAudit).toHaveBeenCalledTimes(1);
      expect(mockAudit).toHaveBeenCalledWith(
        '-',
        'logs-open',
        'demo refused=host',
        expect.objectContaining({ origin: 'attempt', outcome: 'denied' }),
      );
    } finally {
      await app.close();
    }
  });

  it('sends normal output, observes the sentinel, and closes cleanly', async () => {
    const socket = new FakeSocket();
    await runLogStream(socket, async (queue) => {
      queue.offer('the final line');
      queue.offer(null);
    });
    expect(socket.sent).toEqual(['the final line']);
    expect(socket.readyState).toBe(3);
    expect(socket.listenerCount('close')).toBe(0);
  });

  it('aborts the producer and removes the socket listener when the client disconnects', async () => {
    let aborted = false;
    const socket = new FakeSocket();
    const running = runLogStream(
      socket,
      async (_queue, signal): Promise<void> =>
        await new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        }),
    );
    socket.close();
    await running;
    expect(aborted).toBe(true);
    expect(socket.listenerCount('close')).toBe(0);
  });
});
