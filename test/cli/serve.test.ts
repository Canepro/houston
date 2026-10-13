import type { FastifyInstance } from 'fastify';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { edge, type Edge } from '../../src/core/edge/types';
import { saveConfig } from '../../src/lib/config';
import { PreflightError, ValidationError } from '../../src/lib/errors';
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
    engineKind: jest.fn(async () => 'docker'),
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
    livePid: () => null,
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

  it('says whether Okta sign-in is on, and why not, without refusing to start', async () => {
    const home = process.env.HOUSTON_HOME ?? '';
    saveConfig({
      'sso.issuer': 'https://login.example.com',
      'sso.client_id': '0oa-client',
      'sso.public_url': 'https://houston.example.com',
      'sso.email_domains': 'example.com',
    });
    try {
      const broken = harness();
      await run(broken, { bind: '0.0.0.0', allowHost: ['lab.example.com'], insecure: true });
      expect(broken.out.join('')).toContain('⚠ Okta sign-in is set up but off: no client secret');
      expect(broken.app.listen).toHaveBeenCalled();
      fs.writeFileSync(path.join(home, 'sso.env'), 'HOUSTON_SSO_CLIENT_SECRET=s3cret\n', {
        mode: 0o600,
      });
      const ready = harness();
      await run(ready, { bind: '0.0.0.0', allowHost: ['lab.example.com'], insecure: true });
      expect(ready.out.join('')).toContain(
        'Okta sign-in: on, from https://login.example.com, back at https://houston.example.com',
      );
      expect(ready.out.join('')).not.toContain('s3cret');
    } finally {
      fs.rmSync(path.join(home, 'config.yaml'), { force: true });
      fs.rmSync(path.join(home, 'sso.env'), { force: true });
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

  it('refuses --domain with no contact email as a usage error, exit 2, before touching the edge', async () => {
    // A flag the call is missing. It was a plain ReproError, exit 1 (L7-07).
    const h = harness();
    const refusal = await run(h, { domain: 'support.example.com', noOpen: true }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ValidationError);
    expect(refusal).toMatchObject({ exitCode: 2 });
    expect((refusal as Error).message).toContain(
      "a Let's Encrypt certificate needs a contact email",
    );
    expect(h.calls).toEqual([]);
  });

  it('refuses --domain on Podman without --bind, before touching the edge', async () => {
    const h = harness({
      servedDomain: () => 'support.example.com',
      loadConfig: () => ({ acme_email: 'ops@example.com' }),
      engineKind: jest.fn(async () => 'podman'),
    });
    await expect(run(h, { noOpen: true })).rejects.toThrow(
      '`serve --domain` on Podman needs --bind <an address of this host the HTTPS edge can reach>',
    );
    expect(h.dependencies.bridgeAddress).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    // With --bind it goes ahead.
    const told = harness({
      servedDomain: () => 'support.example.com',
      loadConfig: () => ({ acme_email: 'ops@example.com' }),
      engineKind: jest.fn(async () => 'podman'),
    });
    expect(await run(told, { noOpen: true, bind: '10.0.0.5' })).toMatchObject({ bind: '10.0.0.5' });
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

  it('bounds shutdown before awaiting an app close held by active connections', async () => {
    jest.useFakeTimers();
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const h = harness();
    Object.defineProperty(h.app, 'close', {
      value: jest.fn(async () => {
        entered();
        await held;
      }),
    });
    const serving = run(h, { noOpen: true });
    try {
      await closing;
      await jest.advanceTimersByTimeAsync(37_999);
      expect(exit).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(h.err.join('')).toContain('serve shutdown exceeded 38 seconds');
      release();
      await serving;
      await jest.advanceTimersByTimeAsync(40_000);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await serving;
      exit.mockRestore();
      jest.useRealTimers();
    }
  });

  it('keeps the signal shutdown bound after app close returns with no jobs and a live handle', async () => {
    jest.useFakeTimers();
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const warning = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const timers = jest.spyOn(global, 'setTimeout');
    const h = harness();
    Object.defineProperty(h.app, 'jobs', { value: { active: () => 0 } });
    const dependencies: Partial<ServeDependencies> = { ...h.dependencies };
    Reflect.deleteProperty(dependencies, 'waitForShutdown');
    const before = process.listenerCount('SIGTERM');
    const serving = serve({ noOpen: true }, dependencies, h.io);
    const pulse = jest.fn();
    let abandoned: NodeJS.Timeout | undefined;
    try {
      for (
        let attempt = 0;
        attempt < 100 && process.listenerCount('SIGTERM') === before;
        attempt += 1
      ) {
        await Promise.resolve();
      }
      expect(process.listenerCount('SIGTERM')).toBe(before + 1);
      process.emit('SIGTERM');
      await serving;
      expect(h.app.close).toHaveBeenCalledTimes(1);
      expect(h.app.jobs.active()).toBe(0);
      const boundIndex = timers.mock.calls.findIndex((args) => args[1] === 38_000);
      const bound = timers.mock.results[boundIndex]?.value as NodeJS.Timeout;
      expect(bound.hasRef()).toBe(false);
      const liveHandle = setInterval(pulse, 1000) as unknown as NodeJS.Timeout;
      abandoned = liveHandle;
      expect(liveHandle.hasRef()).toBe(true);
      await jest.advanceTimersByTimeAsync(37_999);
      expect(pulse).toHaveBeenCalledTimes(37);
      expect(exit).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        '  ⚠ serve shutdown exceeded 38 seconds; ending the process\n',
      );
    } finally {
      if (abandoned !== undefined) clearInterval(abandoned);
      await serving;
      jest.clearAllTimers();
      exit.mockRestore();
      warning.mockRestore();
      timers.mockRestore();
      jest.useRealTimers();
    }
  });

  it('says so when shutdown stops jobs that outlasted the drain', async () => {
    // The jobs were stopped, as Stop stops them, and nothing on the terminal said why serve
    // was still there or what had become of them.
    let appOptions: Parameters<ServeDependencies['createApp']>[0] | undefined;
    const h = harness({
      createApp: async (options) => {
        appOptions = options;
        return h.app;
      },
    });
    await run(h, { noOpen: true });
    appOptions?.onShutdownStop?.(['job_1']);
    expect(h.err.join('')).toBe(
      '  ⚠ 1 job(s) still running at shutdown — stopping them, as Stop does; what they had ' +
        'done stays done\n',
    );
  });

  it('cancels the shutdown deadline when app close rejects', async () => {
    jest.useFakeTimers();
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const h = harness();
    Object.defineProperty(h.app, 'close', {
      value: jest.fn(async () => {
        throw new Error('controlled close failure');
      }),
    });
    try {
      await expect(run(h, { noOpen: true })).rejects.toThrow('controlled close failure');
      await jest.advanceTimersByTimeAsync(40_000);
      expect(exit).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      exit.mockRestore();
      jest.useRealTimers();
    }
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
      // And what to do: an older serve is the commonest holder, and nothing said so.
      expect(h.err.join('')).toBe(
        `error: cannot listen on 127.0.0.1:${String(busy)}: address already in use\n` +
          `  an older houston serve may still hold it: \`ss -ltnp | grep ${String(busy)}\` ` +
          'names what does; stop that, or choose another --port\n',
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
    expect(h.err.join('').split('\n')[0]).toBe(`error: ${said}`);
    // Only a port in use has a holder to name.
    expect(h.err.join('').includes('older houston serve')).toBe(code === 'EADDRINUSE');
  });

  it('names an earlier serve from this home by its pid, and leaves its pid file to it', async () => {
    const inUse = Object.assign(new Error('listen EADDRINUSE'), {
      code: 'EADDRINUSE',
      syscall: 'listen',
      address: '127.0.0.1',
      port: 9944,
    });
    const h = harness({ livePid: () => 4242 }, { listenError: inUse });

    const result = await run(h, { port: 9944, noOpen: true });

    expect(result).toEqual({ printed: false, refused: true, exitCode: 3 });
    expect(h.err.join('')).toBe(
      'error: cannot listen on 127.0.0.1:9944: address already in use\n' +
        '  an earlier houston serve from this home is still running (pid 4242): stop it ' +
        '(`kill 4242`, or `sudo systemctl stop houston` if it runs as the service), or ' +
        'choose another --port\n',
    );
    // This serve wrote over the earlier one's record before it could know; it is put back.
    expect(h.dependencies.writePid).toHaveBeenLastCalledWith(
      '/tmp/isolated-houston/serve.pid',
      4242,
    );
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
