import type { FastifyInstance } from 'fastify';

import { edge, type Edge } from '../../src/core/edge/types';
import { PreflightError } from '../../src/lib/errors';
import type { ReproError } from '../../src/lib/errors';

import {
  serve,
  type ServeDependencies,
  type ServeIo,
  type ServeOptions,
} from '../../src/cli/serve';

interface Harness {
  readonly dependencies: ServeDependencies;
  readonly app: FastifyInstance;
  readonly out: string[];
  readonly err: string[];
  readonly io: ServeIo;
  readonly calls: string[];
}

function fakeApp(port = 38175, listenError?: Error): FastifyInstance {
  return {
    server: { address: () => ({ address: '127.0.0.1', family: 'IPv4', port }) },
    listen: jest.fn(async () => {
      if (listenError !== undefined) throw listenError;
      return `http://127.0.0.1:${String(port)}`;
    }),
    close: jest.fn(async () => undefined),
  } as unknown as FastifyInstance;
}

function harness(
  overrides: Partial<ServeDependencies> = {},
  options: { readonly port?: number; readonly listenError?: Error } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const app = fakeApp(options.port ?? 38175, options.listenError);
  const dependencies: ServeDependencies = {
    home: () => '/tmp/isolated-houston',
    loadConfig: () => ({}),
    saveConfig: jest.fn(),
    normalizeAllowHost: (value) => [value, ''],
    normalizeDomain: (value) => [value, ''],
    servedDomain: () => '',
    bridgeAddress: jest.fn(async () => '172.17.0.1'),
    resolveEdge: (domain, email, values) => edge({ domain, acmeEmail: email, ...values }) as Edge,
    requireDocker: async () => {
      calls.push('preflight');
    },
    writeEdge: async () => {
      calls.push('write');
    },
    ensureEdge: async () => {
      calls.push('start');
      return { ok: true, why: '' };
    },
    edgePortHolder: async () => '',
    edgeDirectory: () => '/tmp/isolated-houston/edge',
    edgeProject: 'houston_edge',
    edgeAddresses: async () => ['172.18.0.2'],
    anyUsers: () => true,
    listUsers: () => [{ name: 'alice' }],
    roleOf: () => 'admin',
    implicitAdmins: () => [],
    mintFirstRun: jest.fn(() => 'one-time-key'),
    createApp: async () => app,
    recoverInterrupted: async () => [],
    reportGuiTls: async () => undefined,
    dnsEnvPath: () => '/tmp/isolated-houston/acme/dns.env',
    waitForShutdown: async () => undefined,
    openBrowser: jest.fn(async () => undefined),
    executable: ['/opt/houston/bin/houston'],
    user: () => 'support',
    systemdUnit: (command, user) => `User=${user}\nExecStart=${command}\n`,
    servePidPath: (home) => `${home}/serve.pid`,
    tightenPrivateState: jest.fn(),
    writePid: jest.fn(() => true),
    removeOwnedPid: jest.fn(),
    ...overrides,
  };
  return {
    dependencies,
    app,
    out,
    err,
    calls,
    io: {
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
    },
  };
}

async function run(
  instance: Harness,
  options: ServeOptions = {},
): Promise<Awaited<ReturnType<typeof serve>>> {
  return await serve(options, instance.dependencies, instance.io);
}

describe('the secure serve boundary', () => {
  it('mints a loopback-only setup key while keeping Fastify authentication enabled', async () => {
    let appOptions: Parameters<ServeDependencies['createApp']>[0] | undefined;
    const opened: string[] = [];
    const h = harness({
      anyUsers: () => false,
      createApp: async (options) => {
        appOptions = options;
        return h.app;
      },
      openBrowser: async (url) => {
        opened.push(url);
      },
    });

    const result = await run(h, { port: 0 });

    expect(result).toEqual({
      printed: false,
      bind: '127.0.0.1',
      port: 38175,
      domain: '',
      // The port ASKED for, as the announcement builds it before the listener binds.
      url: 'http://localhost:0/setup#k=one-time-key',
    });
    expect(appOptions).toMatchObject({ accounts: true, firstRun: true, publicHttps: false });
    expect(opened).toEqual(['http://localhost:0/setup#k=one-time-key']);
    expect(h.out[0]).toBe('houston GUI: http://localhost:0/setup#k=one-time-key\n');
    expect(h.out.join('')).toContain('single-use');
    expect(h.dependencies.writePid).toHaveBeenCalledWith(
      '/tmp/isolated-houston/serve.pid',
      process.pid,
    );
    expect(h.dependencies.removeOwnedPid).toHaveBeenCalledWith(
      '/tmp/isolated-houston/serve.pid',
      process.pid,
    );
    expect(h.app.close).toHaveBeenCalledTimes(1);
  });

  it('refuses to expose a first-run credential on a reachable bind or domain', async () => {
    // `_first_run_key`: exit 3, printed on stderr with no `error:` -- the documented first-run
    // stop -- and NOTHING minted or bound on a reachable interface.
    const refused = { printed: false, refused: true, exitCode: 3 };
    const remote = harness({ anyUsers: () => false });
    expect(await run(remote, { bind: '0.0.0.0', insecure: true })).toEqual(refused);
    expect(remote.err.join('')).toContain('houston users add <name>');
    expect(remote.dependencies.mintFirstRun).not.toHaveBeenCalled();
    expect(remote.app.listen).not.toHaveBeenCalled();

    const domain = harness({ anyUsers: () => false });
    expect(await run(domain, { domain: 'support.example.com', email: 'ops@example.com' })).toEqual(
      refused,
    );
    expect(domain.calls).toEqual([]);
    expect(domain.app.listen).not.toHaveBeenCalled();
  });

  it('names an invalid or match-nothing proxy, trusts nothing by it, and says plain http', async () => {
    // Earlier releases count `--trust-proxy` as SAID when deciding whether to refuse a
    // password in the clear, and WARN about one that matches nothing: the server starts,
    // trusts no peer, and the posture line reports plain http -- it does not refuse.
    for (const proxy of ['not-an-address', '0.0.0.0']) {
      let appOptions: Parameters<ServeDependencies['createApp']>[0] | undefined;
      const h = harness({
        createApp: async (options) => {
          appOptions = options;
          return h.app;
        },
      });
      await run(h, { bind: '0.0.0.0', allowHost: ['lab.example.com'], trustProxy: [proxy] });
      expect(h.out.join('')).toContain(
        `--trust-proxy ${proxy === '0.0.0.0' ? '0.0.0.0 means' : "'not-an-address'"}`,
      );
      expect(h.out.join('')).toContain('PLAIN HTTP on a reachable interface');
      expect(appOptions?.trustedProxies ?? []).toHaveLength(proxy === '0.0.0.0' ? 1 : 0);
    }
  });

  it('permits an explicit insecure reachable bind without claiming HTTPS', async () => {
    let appOptions: Parameters<ServeDependencies['createApp']>[0] | undefined;
    const h = harness({
      createApp: async (options) => {
        appOptions = options;
        return h.app;
      },
    });

    const result = await run(h, {
      bind: '0.0.0.0',
      allowHost: ['lab.example.com'],
      insecure: true,
      noOpen: false,
    });

    expect(result).toMatchObject({ bind: '0.0.0.0', url: 'http://lab.example.com:7070/' });
    expect(appOptions).toMatchObject({ accounts: true, publicHttps: false });
    expect(h.out.join('')).toContain(
      'auth: named accounts over PLAIN HTTP on a reachable interface',
    );
    expect(h.dependencies.openBrowser).not.toHaveBeenCalled();
  });

  it('trusts only the declared proxy network and leaves HTTPS to forwarded headers', async () => {
    let appOptions: Parameters<ServeDependencies['createApp']>[0] | undefined;
    const h = harness({
      createApp: async (options) => {
        appOptions = options;
        return h.app;
      },
    });

    await run(h, {
      bind: '0.0.0.0',
      allowHost: ['lab.example.com'],
      trustProxy: ['10.1.2.3/8'],
      noOpen: true,
    });

    expect(appOptions).toMatchObject({ accounts: true, publicHttps: false });
    expect(appOptions?.trustedProxies).toHaveLength(1);
    expect(appOptions?.trustedProxies?.[0]?.contains('10.250.0.1')).toBe(true);
    expect(appOptions?.trustedProxies?.[0]?.contains('11.0.0.1')).toBe(false);
  });

  it('reuses the persisted domain, persists a changed email and starts the edge in order', async () => {
    let appOptions: Parameters<ServeDependencies['createApp']>[0] | undefined;
    let door: Edge | undefined;
    const h = harness({
      servedDomain: () => 'support.example.com',
      loadConfig: () => ({ acme_email: 'old@example.com' }),
      resolveEdge: (domain, email, values) => {
        door = edge({ domain, acmeEmail: email, acmeStaging: true, ...values });
        return door;
      },
      createApp: async (options) => {
        appOptions = options;
        return h.app;
      },
    });

    const result = await run(h, { email: 'new@example.com', noOpen: false });

    expect(result).toMatchObject({
      domain: 'support.example.com',
      bind: '172.17.0.1',
      port: 38175,
      url: 'https://support.example.com/',
    });
    expect(h.dependencies.saveConfig).toHaveBeenCalledWith({
      acme_email: 'new@example.com',
    });
    expect(door).toMatchObject({
      domain: 'support.example.com',
      acmeEmail: 'new@example.com',
      guiHost: '172.17.0.1',
      guiPort: 7070,
    });
    expect(h.calls).toEqual(['preflight', 'write', 'start']);
    expect(appOptions).toMatchObject({
      accounts: true,
      publicHttps: true,
      allowHosts: ['support.example.com'],
    });
    expect(appOptions?.trustedProxies?.[0]?.contains('172.18.0.2')).toBe(true);
    expect(h.dependencies.openBrowser).not.toHaveBeenCalled();
  });

  it('--no-domain deliberately ignores the persisted edge without changing it', async () => {
    const h = harness({ servedDomain: () => 'support.example.com' });

    const result = await run(h, { noDomain: true, noOpen: true });

    expect(result).toMatchObject({ domain: '', bind: '127.0.0.1' });
    expect(h.calls).toEqual([]);
    expect(h.dependencies.bridgeAddress).not.toHaveBeenCalled();
    expect(h.dependencies.openBrowser).not.toHaveBeenCalled();
  });

  it('prints a restart-safe service recipe without starting an edge or listener', async () => {
    const h = harness({ servedDomain: () => 'support.example.com' });

    const result = await run(h, {
      noDomain: true,
      bind: '127.0.0.1',
      allowHost: ['lab.example.com'],
      printService: true,
    });

    expect(result.printed).toBe(true);
    if (!result.printed) throw new Error('expected a printed service');
    // `--no-domain` is not echoed back, as earlier releases' service command line does not.
    expect(result.command).toContain(
      'serve --bind 127.0.0.1 --allow-host lab.example.com --no-open',
    );
    expect(h.out.join('')).toContain('User=support');
    expect(h.out.join('')).toContain('nohup');
    expect(h.calls).toEqual([]);
    expect(h.app.listen).not.toHaveBeenCalled();
    expect(h.dependencies.writePid).not.toHaveBeenCalled();
  });

  it('does not write edge state when its Docker preflight fails', async () => {
    const h = harness({
      requireDocker: async () => {
        h.calls.push('preflight');
        throw new PreflightError('Docker is unavailable');
      },
    });

    await expect(
      run(h, { domain: 'support.example.com', email: 'ops@example.com' }),
    ).rejects.toThrow('Docker is unavailable');
    expect(h.calls).toEqual(['preflight']);
    expect(h.app.listen).not.toHaveBeenCalled();
  });

  it('reports an edge start failure before constructing Fastify', async () => {
    const h = harness({
      ensureEdge: async () => {
        h.calls.push('start');
        return { ok: false, why: 'address already in use' };
      },
      edgePortHolder: async () => 'nginx',
    });

    await expect(
      run(h, { domain: 'support.example.com', email: 'ops@example.com' }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ReproError>>({
        exitCode: 1,
        message: expect.stringContaining('nginx is holding :443'),
      }),
    );
    expect(h.calls).toEqual(['preflight', 'write', 'start']);
    expect(h.app.listen).not.toHaveBeenCalled();
  });

  it('closes the listener and removes only its PID when shutdown fails', async () => {
    const h = harness({
      waitForShutdown: async () => {
        throw new Error('controlled shutdown failure');
      },
    });

    await expect(run(h, { noOpen: true })).rejects.toThrow('controlled shutdown failure');
    expect(h.dependencies.removeOwnedPid).toHaveBeenCalledWith(
      '/tmp/isolated-houston/serve.pid',
      process.pid,
    );
    expect(h.app.close).toHaveBeenCalledTimes(1);
  });

  it('closes the app and removes its PID when listen fails in a way the listener does not report', async () => {
    // The pid file is written before `app.listen`, and a `finally` unlinks it.
    const h = harness({}, { listenError: new Error('controlled listen failure') });

    await expect(run(h, { noOpen: true })).rejects.toThrow('controlled listen failure');
    expect(h.dependencies.writePid).toHaveBeenCalledTimes(1);
    expect(h.dependencies.removeOwnedPid).toHaveBeenCalledWith(
      '/tmp/isolated-houston/serve.pid',
      process.pid,
    );
    expect(h.app.close).toHaveBeenCalledTimes(1);
  });

  it('announces, opens the browser and writes its PID before it binds, in that order', async () => {
    // The announcement, the app, the browser, the pid file, then `app.listen`: the
    // lifespan (the recovery) and only then the bind.
    const order: string[] = [];
    const h = harness({
      tightenPrivateState: () => {
        order.push('tighten');
      },
      createApp: async () => {
        order.push(`app after ${String(h.out.length)} announced`);
        return h.app;
      },
      openBrowser: async (url) => {
        order.push(`browser ${url}`);
      },
      writePid: () => {
        order.push('pid');
        return true;
      },
      recoverInterrupted: async () => {
        order.push('recover');
        return [];
      },
    });
    jest.mocked(h.app.listen).mockImplementation((async () => {
      order.push('listen');
      return 'http://127.0.0.1:38175';
    }) as never);

    await run(h, {});

    expect(h.out[0]).toBe('houston GUI: http://localhost:7070/\n');
    expect(order).toEqual([
      'tighten',
      `app after ${String(h.out.length)} announced`,
      'browser http://localhost:7070/',
      'pid',
      'recover',
      'listen',
    ]);
  });

  it('refuses a port in use after the announcement, with one error line, exit 3', async () => {
    const net = await import('node:net');
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen({ host: '127.0.0.1', port: 0 }, resolve));
    const busy = (holder.address() as { port: number }).port;
    try {
      // The error a real listen on that port raises, as Fastify hands it on.
      const inUse = await new Promise<Error>((resolve) => {
        const second = net.createServer();
        second.once('error', resolve);
        second.listen({ host: '127.0.0.1', port: busy });
      });
      const h = harness({}, { listenError: inUse });

      const result = await run(h, { port: busy, noOpen: true });

      expect(result).toEqual({ printed: false, refused: true, exitCode: 3 });
      expect(h.out[0]).toBe(`houston GUI: http://localhost:${String(busy)}/\n`);
      expect(h.err.join('')).toBe(
        `error: cannot listen on 127.0.0.1:${String(busy)}: address already in use\n`,
      );
      expect(h.dependencies.removeOwnedPid).toHaveBeenCalledWith(
        '/tmp/isolated-houston/serve.pid',
        process.pid,
      );
      expect(h.app.close).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });

  it.each([
    ['EACCES', '127.0.0.1', 'cannot listen on 127.0.0.1:80: permission denied'],
    ['EADDRINUSE', '::1', 'cannot listen on [::1]:80: address already in use'],
    ['EADDRNOTAVAIL', '10.9.9.9', 'cannot listen on 10.9.9.9:80: address not available'],
  ])('says a %s bind on %s as the address and the reason', async (code, address, said) => {
    const failure = Object.assign(new Error(`listen ${code}`), {
      code,
      syscall: 'listen',
      address,
      port: 80,
    });
    const h = harness({}, { listenError: failure });

    const result = await run(h, { bind: address, port: 80, insecure: true, noOpen: true });

    expect(result).toEqual({ printed: false, refused: true, exitCode: 3 });
    expect(h.err.join('')).toBe(`error: ${said}\n`);
  });
});

describe('startup recovery', () => {
  // A DEFECT AN EARLIER VERSION HAD: earlier releases run the startup recovery before the
  // server listens, and no front door here called `core/recovery` at all -- so a backup
  // killed mid-way left Rocket.Chat stopped, and the next `serve` never noticed.

  it('repairs what a killed process left half-done, before the listener opens', async () => {
    const instance = harness({
      recoverInterrupted: async () => {
        instance.calls.push('recover');
        return [
          {
            id: 'a',
            kind: 'quiesced',
            workspace: 'w',
            what: 'Rocket.Chat stopped for a backup of w',
            repaired: true,
            why: '',
          },
          {
            id: 'b',
            kind: 'ratelimit_off',
            workspace: 'v',
            what: 'the API rate limiter of v',
            repaired: false,
            why: 'no admin',
          },
        ];
      },
    });
    jest.mocked(instance.app.listen).mockImplementation((async () => {
      instance.calls.push('listen');
      return 'http://127.0.0.1:38175';
    }) as never);
    await run(instance);
    expect(instance.calls).toEqual(['recover', 'listen']);
    const err = instance.err.join('');
    expect(err).toContain('houston: repaired: Rocket.Chat stopped for a backup of w\n');
    expect(err).toContain('houston: STILL BROKEN: the API rate limiter of v\n');
  });

  it('still serves when the repair itself fails, and says why', async () => {
    // A box that cannot be repaired must still serve; anything else turns one stuck
    // workspace into an outage of the whole GUI. (The earlier suite's own test of this never
    // ran the startup hook, so it passed whether or not the catch existed.)
    const instance = harness({
      recoverInterrupted: async () => {
        throw new Error('cluster unreachable');
      },
    });
    const result = await run(instance);
    expect(result).toMatchObject({ printed: false, port: 38175 });
    expect(instance.app.listen).toHaveBeenCalled();
    expect(instance.err.join('')).toContain(
      'houston: could not check for interrupted work: cluster unreachable\n',
    );
  });
});
