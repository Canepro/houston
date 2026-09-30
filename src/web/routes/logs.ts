/** Polled and WebSocket log streams with bounded, live-tail queueing. */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import * as audit from '../../core/audit';
import { resolveName } from '../../core/lifecycle/naming';
import { stream as composeStream } from '../../core/runner/engine';
import { readMeta } from '../../core/runner/record';
import * as sessions from '../../core/sessions';
import * as topology from '../../core/topology';
import { runWithContext } from '../../lib/context';
import { ReproError, asPayload } from '../../lib/errors';
import { bag, kubeContext, queryInt } from '../route-deps';
import type * as KubeStatusNS from '../../core/kube/status';
import type * as UsersNS from '../../core/users';
import {
  cookieName,
  crossSite,
  hostOk,
  preauthShouldAudit,
  resolvePeer,
  sessionToken,
} from '../security';

function kubeStatusModule(): typeof KubeStatusNS {
  return require('../../core/kube/status') as typeof KubeStatusNS;
}

function usersModule(): typeof UsersNS {
  return require('../../core/users') as typeof UsersNS;
}

export const TAIL_MAX = 5000;
export const WS_QUEUE_MAX = 3000;
export const DROPPED_FRAME = (count: number): string =>
  `... ${String(count)} line(s) skipped: this container is logging faster than the ` +
  'browser is reading. Narrow the service or level filter, or use `houston logs`.';

export interface LogSocket {
  readonly readyState: number;
  readonly CLOSING: number;
  send(value: string, callback?: (error?: Error | null) => void): void;
  close(code?: number): void;
  once(event: 'close', listener: () => void): this;
  removeListener(event: 'close', listener: () => void): this;
}

export class LogQueue {
  private readonly items: Array<string | null> = [];
  private readonly waiters: Array<(item: string | null) => void> = [];
  dropped = 0;

  constructor(readonly maximum = WS_QUEUE_MAX) {}

  offer(item: string | null): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(item);
      return;
    }
    if (this.items.length >= this.maximum) {
      const oldestLine = this.items.findIndex((entry) => entry !== null);
      if (oldestLine === -1) {
        if (item !== null) this.dropped += 1;
        return;
      }
      this.items.splice(oldestLine, 1);
      this.dropped += 1;
    }
    this.items.push(item);
  }

  next(): Promise<string | null> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  takeDropped(): number {
    const value = this.dropped;
    this.dropped = 0;
    return value;
  }
}

function clampTail(value: unknown, fallback: number): number {
  return Math.max(1, Math.min(queryInt(value, fallback, 'tail'), TAIL_MAX));
}

function cookiePresent(request: FastifyRequest, name: string): boolean {
  return (request.headers.cookie ?? '')
    .split(';')
    .some((part) => part.trim().startsWith(`${name}=`));
}

export async function authenticateSocket(
  app: FastifyInstance,
  request: FastifyRequest,
  socket: LogSocket,
): Promise<string | null> {
  const context = app.houstonSecurity;
  const peer = resolvePeer(context, request);
  const closePolicy = async (): Promise<void> => {
    // Let the upgrade's 101 reach the peer before its policy close frame. Closing in the
    // same turn makes in-process and sufficiently fast clients observe an abnormal 1006.
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.close(1008);
  };
  const refuse = (why: string, who = '', preauth = false): void => {
    if (preauth && !preauthShouldAudit(peer.address || '-', why)) return;
    audit.audit(who || '-', 'logs-open', `${String(bag(request.params).name)} refused=${why}`, {
      origin: 'attempt',
      outcome: 'denied',
    });
  };
  if (!hostOk(context, request.headers.host)) {
    refuse('host', '', true);
    await closePolicy();
    return null;
  }
  if (crossSite(context, request.headers, { requireOrigin: context.accounts })) {
    refuse(request.headers.origin ? 'origin' : 'no-origin', '', true);
    await closePolicy();
    return null;
  }
  if (!context.accounts) return '';
  let raw = sessionToken(context, request);
  const peerCookie = cookieName(context, peer.https);
  if (!raw && peerCookie === context.cookiePlain && cookiePresent(request, context.cookieSecure)) {
    const secure = request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${context.cookieSecure}=`));
    raw = secure?.slice(context.cookieSecure.length + 1) ?? '';
  }
  const session = await sessions.verify(raw);
  if (session === null) {
    refuse(cookiePresent(request, peerCookie) ? 'stale-session' : `no-cookie:${peerCookie}`);
    await closePolicy();
    return null;
  }
  const need = context.routeRequirement('WS', request.routeOptions.url ?? '');
  const users = usersModule();
  const role = users.roleOf(session.user);
  if (need === null || !users.atLeast(role, need)) {
    audit.audit(
      session.user,
      'logs-open',
      `${String(bag(request.params).name)} refused=role need=${String(need)} have=${role}`,
      { origin: 'session', outcome: 'denied' },
    );
    await closePolicy();
    return null;
  }
  return session.user;
}

async function startLogProducer(
  target: string,
  tail: number,
  queue: LogQueue,
  signal: AbortSignal,
): Promise<void> {
  const onLine = (line: string): void => queue.offer(line);
  try {
    if ((await topology.ofRepro(target)) === topology.KUBERNETES) {
      const kube = kubeStatusModule();
      const meta = await readMeta(target);
      await kube.logProcess(target, {
        context: kubeContext(meta.extra),
        tail,
        follow: true,
        onLine,
        abortSignal: signal,
      });
    } else {
      await composeStream(target, ['logs', '-f', '--no-color', '--tail', String(tail)], onLine, {
        abortSignal: signal,
      });
    }
  } finally {
    queue.offer(null);
  }
}

export async function pumpLogQueue(
  socket: Pick<LogSocket, 'send'>,
  queue: LogQueue,
): Promise<void> {
  const send = async (value: string): Promise<void> =>
    await new Promise<void>((resolve, reject) => {
      socket.send(value, (error) => {
        // `ws` reports a successful write as null; treating only undefined as success
        // delivered the first frame and then rejected the pump on that null sentinel.
        if (error === undefined || error === null) resolve();
        else reject(error);
      });
    });
  for (;;) {
    const line = await queue.next();
    const dropped = queue.takeDropped();
    if (dropped > 0) await send(DROPPED_FRAME(dropped));
    if (line === null) return;
    await send(line);
  }
}

export async function runLogStream(
  socket: LogSocket,
  produce: (queue: LogQueue, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  let disconnected!: () => void;
  const disconnect = new Promise<void>((resolve) => {
    disconnected = resolve;
    socket.once('close', disconnected);
  });
  socket.once('close', abort);
  const queue = new LogQueue();
  const producer = produce(queue, controller.signal);
  try {
    await Promise.race([pumpLogQueue(socket, queue), disconnect]);
  } finally {
    controller.abort();
    await producer.catch(() => undefined);
    socket.removeListener('close', abort);
    socket.removeListener('close', disconnected);
    if (socket.readyState < socket.CLOSING) socket.close();
  }
}

export async function handleLogSocket(
  app: FastifyInstance,
  socket: LogSocket,
  request: FastifyRequest<{ Params: { name: string }; Querystring: { tail?: unknown } }>,
): Promise<void> {
  let disconnected = socket.readyState >= socket.CLOSING;
  const earlyClose = (): void => {
    disconnected = true;
  };
  socket.once('close', earlyClose);
  try {
    const tail = clampTail(request.query.tail, 300);
    const actor = await authenticateSocket(app, request, socket);
    if (actor === null || disconnected) return;
    await runWithContext({ actor, origin: actor ? 'session' : '' }, async () => {
      let target: string;
      try {
        target = await resolveName(request.params.name);
        if (disconnected) return;
        audit.record('logs-open', target);
      } catch (error) {
        if (!(error instanceof ReproError)) throw error;
        if (!disconnected) {
          socket.send(JSON.stringify(asPayload(error)), () => socket.close());
        }
        return;
      }
      await runLogStream(socket, async (queue, signal) =>
        startLogProducer(target, tail, queue, signal),
      );
    });
  } finally {
    socket.removeListener('close', earlyClose);
  }
}

export function register(app: FastifyInstance): void {
  app.get<{ Params: { name: string }; Querystring: { tail?: unknown } }>(
    '/api/repros/:name/logs/stream',
    { websocket: true, config: { houstonTransport: 'WS' } },
    async (socket, request) => await handleLogSocket(app, socket, request),
  );

  app.get<{ Params: { name: string }; Querystring: { tail?: unknown } }>(
    '/api/repros/:name/logs',
    async (request) => {
      const tail = clampTail(request.query.tail, 200);
      const target = await resolveName(request.params.name);
      const lines: string[] = [];
      if ((await topology.ofRepro(target)) === topology.KUBERNETES) {
        const kube = kubeStatusModule();
        const meta = await readMeta(target);
        await kube.logProcess(target, {
          context: kubeContext(meta.extra),
          tail,
          follow: false,
          onLine: (line) => lines.push(line),
        });
      } else {
        await composeStream(target, ['logs', '--no-color', '--tail', String(tail)], (line) =>
          lines.push(line),
        );
      }
      return { name: target, logs: lines.join('\n') };
    },
  );
}
