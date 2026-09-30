import * as net from 'node:net';

import { EventEmitter } from 'node:events';

import {
  PORT_MAX,
  pickPort,
  pickPortRange,
  portFree,
  usedPorts,
} from '../../../src/core/runner/ports';
import type * as PortsNS from '../../../src/core/runner/ports';
import { metadata, writeRecord } from '../../../src/core/runner/record';

const servers: net.Server[] = [];

function listen(port: number, host = '127.0.0.1'): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    servers.push(server);
    server.once('error', reject);
    server.listen({ host, port }, () => resolve());
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function record(name: string, hostPort: number, extra: Record<string, unknown> = {}) {
  await writeRecord(name, metadata({ name, hostPort, extra }));
}

describe('which ports a workspace has claimed', () => {
  it('counts the instance block and every recorded side-service port', async () => {
    await record('plain', 3000);
    await record('multi', 4000, { instances: 3 });
    await record('sided', 5000, {
      sidecar_ports: [8082, '8083'],
      monitoring_ports: [9090, 5050],
      tls_ports: [443],
    });

    const claimed = await usedPorts();
    expect(claimed.has(3000)).toBe(true);
    // A multi-instance repro publishes the load balancer plus one port per instance.
    expect([4000, 4001, 4002, 4003].every((port) => claimed.has(port))).toBe(true);
    expect(claimed.has(4004)).toBe(false);
    expect([5000, 8082, 8083, 9090, 5050, 443].every((port) => claimed.has(port))).toBe(true);
  });

  it('ignores a record it cannot read rather than failing the whole question', async () => {
    await record('readable', 3100);
    expect((await usedPorts()).has(3100)).toBe(true);
  });
});

describe('whether a port can actually be published', () => {
  it('reports a listener on loopback as busy', async () => {
    const port = await pickPort(31_000);
    expect(await portFree(port)).toBe(true);
    await listen(port);
    // The connect probe is what catches this: a wildcard bind with SO_REUSEADDR can
    // miss a docker publish on 127.0.0.1:<port>, and repros bind loopback.
    expect(await portFree(port)).toBe(false);
  });

  it('answers per interface, which is the dedicated-IP escape hatch', async () => {
    const port = await pickPort(31_500);
    await listen(port, '127.0.0.1');
    expect(await portFree(port, '127.0.0.1')).toBe(false);
  });
});

describe('allocation', () => {
  it('skips ports another workspace claimed even when nothing is listening', async () => {
    const start = 32_000;
    await record('holder', start, { instances: 2 });
    const picked = await pickPort(start);
    expect(picked).toBeGreaterThan(start + 2);
    expect(picked).toBeLessThan(PORT_MAX);
  });

  it('finds a block of consecutive ports for a multi-instance repro', async () => {
    const base = await pickPortRange(3, 32_500);
    await listen(base + 1);
    const next = await pickPortRange(3, 32_500);
    // The busy port cannot be inside the block that was just handed out.
    expect(next === base ? false : next > base).toBe(true);
    expect(next + 2).toBeLessThan(PORT_MAX);
  });
});

/**
 * A `node:net` whose answers are stated: whether anything is listening, and what `bind()`
 * says for a port. Nothing here opens a socket.
 */
function statedNet(listener: boolean, bindError: (port: number) => string | null): object {
  class Socket extends EventEmitter {
    setTimeout(): this {
      return this;
    }
    destroy(): this {
      return this;
    }
    connect(): this {
      setImmediate(() => {
        if (listener) this.emit('connect');
        else this.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
      });
      return this;
    }
  }
  class Server extends EventEmitter {
    listen(options: { port: number }, ready: () => void): this {
      const code = bindError(options.port);
      setImmediate(() => {
        if (code === null) ready();
        else this.emit('error', Object.assign(new Error(code), { code }));
      });
      return this;
    }
    close(done?: () => void): this {
      done?.();
      return this;
    }
  }
  return { ...jest.requireActual<object>('node:net'), Socket, createServer: () => new Server() };
}

describe('a host that answers differently', () => {
  afterEach(() => {
    jest.dontMock('node:net');
    jest.resetModules();
  });

  function withNet(listener: boolean, bindError: (port: number) => string | null) {
    jest.resetModules();
    jest.doMock('node:net', () => statedNet(listener, bindError));
    return require('../../../src/core/runner/ports') as typeof PortsNS;
  }

  it('gives up with a clean error rather than scanning past the last port', async () => {
    // Sandboxes where nothing can bind must get a sentence, not an overflow past 65535.
    // Started near the top so the scan is six ports, not sixty thousand.
    const ports = withNet(true, () => null);
    await expect(ports.pickPort(PORT_MAX - 5)).rejects.toThrow(/no free host port/u);
    await expect(ports.pickPortRange(3, PORT_MAX - 5)).rejects.toThrow(/consecutive/u);
  });

  it('does not call a privileged port busy only because this user cannot bind it', async () => {
    // The docker daemon runs as root, so `ports: 443:443` works; bind() as the calling
    // user raises EACCES, and reading that as "in use" refused 443 on every non-root box.
    const privileged = (port: number) => (port < 1024 ? 'EACCES' : null);
    let ports = withNet(false, privileged);
    expect([await ports.portFree(443), await ports.portFree(8443)]).toEqual([true, true]);
    // A real listener still registers as busy -- the connect probe catches it.
    ports = withNet(true, privileged);
    expect([await ports.portFree(443), await ports.portFree(8443)]).toEqual([false, false]);
    // And a genuine EADDRINUSE on an unprivileged port is still busy.
    ports = withNet(false, () => 'EADDRINUSE');
    expect(await ports.portFree(8443)).toBe(false);
  });
});
