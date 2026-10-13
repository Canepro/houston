/**
 * INVARIANT: three things the terminal front door promises.
 *
 * MECHANISM: BEHAVIOURAL, driven through the real dispatcher.
 *
 * Earlier releases guarded all three by reading source, and two of those guards had to be
 * re-pointed by hand when the handlers moved: each searched the text of the seed command, the
 * TLS route or the edge command for `"status"` and friends. What each one is really claiming
 * is what a COMMAND does, so each is driven as a command.
 */
import * as fs from 'node:fs';

import type * as HandlersNS from '../../../src/cli/handlers';
import type * as EdgeRuntimeNS from '../../../src/core/edge/runtime';
import type * as TlsNS from '../../../src/core/tls';

import { COMMAND_SPECS } from '../../../src/cli/spec-data';
import { configFile } from '../../../src/lib/config';

afterEach(() => {
  jest.resetModules();
});

describe('`edge <action>`', () => {
  it('handles every action its own help advertises', async () => {
    const spec = COMMAND_SPECS.find((one) => one.path === 'edge');
    const advertised = String(spec?.arguments[0]?.description ?? '')
      .split('|')
      .map((word) => word.trim())
      .filter((word) => word !== '');
    expect(advertised.length).toBeGreaterThanOrEqual(5);

    const reached: string[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/edge/engine', () => ({
      ...(jest.requireActual('../../../src/core/edge/engine') as Record<string, unknown>),
      // `stop` and `restart` bring the container down through the ENGINE, not the runtime.
      down: async () => {
        reached.push('down');
        return 0;
      },
    }));
    // An INSTALLED edge, so each action reaches its runtime call: on a home with no edge,
    // `logs`, `stop` and `delete` say "nothing here" and stop, exactly as earlier releases do.
    jest.doMock('../../../src/core/edge/spec', () => ({
      ...(jest.requireActual('../../../src/core/edge/spec') as Record<string, unknown>),
      installed: () => true,
      current: () => null,
    }));
    jest.doMock('../../../src/core/edge/runtime', () => {
      const real = jest.requireActual('../../../src/core/edge/runtime') as typeof EdgeRuntimeNS;
      // Each returns the SHAPE the command reads: a status, a compose result, an exit
      // code, a deletion report. A wrong shape fails about the stub, not the command.
      const mark = (what: string, value: unknown) => () => {
        reached.push(what);
        return value;
      };
      return {
        ...real,
        status: mark('status', { installed: true, running: true, routes: [], attached: [] }),
        up: mark('up', { returncode: 0, stdout: '', stderr: '' }),
        logs: mark('logs', 0),
        deleteHost: mark('deleteHost', {
          host: 'x.example',
          routes: [],
          passthrough: [],
          certificate: false,
          declaration: false,
          acme: [],
          restarted: null,
          foreign: '',
          kept: [],
        }),
      };
    });
    try {
      const handlers = require('../../../src/cli/handlers') as typeof HandlersNS;
      const execute = handlers.createExecutor({
        writeOut: () => undefined,
        writeErr: () => undefined,
      });
      for (const action of advertised) {
        reached.length = 0;
        // The accident this exists for: inserting a helper directly above a decorated
        // command bound the decorator to the HELPER, `edge status` stopped existing, and
        // `edge logs --tail 2` answered "No such option". Nothing failed; the command was
        // simply somebody else's function.
        await execute({
          spec: spec as never,
          arguments: { action, host: 'x.example' },
          options: { tail: 2, follow: false, yes: true },
          events: null,
        });
        expect(`${action} reached ${String(reached.length)} runtime call(s)`).not.toBe(
          `${action} reached 0 runtime call(s)`,
        );
      }
    } finally {
      jest.dontMock('../../../src/core/edge/runtime');
      jest.dontMock('../../../src/core/edge/engine');
      jest.dontMock('../../../src/core/edge/spec');
      jest.resetModules();
    }
  });

  it('refuses an action it does not advertise, rather than doing nothing', async () => {
    const spec = COMMAND_SPECS.find((one) => one.path === 'edge');
    const handlers = require('../../../src/cli/handlers') as typeof HandlersNS;
    const execute = handlers.createExecutor({
      writeOut: () => undefined,
      writeErr: () => undefined,
    });
    await expect(
      execute({
        spec: spec as never,
        arguments: { action: 'up' },
        options: {},
        events: null,
      }),
    ).rejects.toThrow(
      "unknown action 'up' (want: status | start | stop | restart | logs | delete <host>)",
    );
  });
});

describe('`tls-status`', () => {
  it('probes the name when TLS terminates in the cluster, and loopback when it does not', async () => {
    const dialled: string[] = [];
    const sni: string[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/tls', () => ({
      ...(jest.requireActual('../../../src/core/tls') as typeof TlsNS),
      verify: async (host: string, options: { port?: number; sni?: string } = {}) => {
        dialled.push(host);
        if (options.sni !== undefined) sni.push(`${host}:${String(options.port)} ${options.sni}`);
        // The whole report the command reads, not three fields of it.
        return {
          host,
          port: 443,
          serving: true,
          trusted: true,
          trusted_via_ca: true,
          issuer: 'CN = houston local CA',
          subject: '',
          dates: 'notAfter=Nov 23 2026',
          names: ['kw.houston.localhost'],
          fallback: false,
          self_signed: false,
          staging: false,
          error: '',
        };
      },
    }));
    jest.doMock('../../../src/core/runner/record', () => ({
      ...(jest.requireActual('../../../src/core/runner/record') as Record<string, unknown>),
      readMeta: async (name: string) => ({
        name,
        project: `houston-${name}`,
        rcVersion: '8.5.1',
        rcImage: 'i',
        mongoTag: '8.0',
        mongoFlavor: 'official',
        preset: 'default',
        rootUrl: 'http://localhost:3000',
        hostPort: 3000,
        versionSource: 'map',
        pinned: false,
        createdAt: '2026-01-01T00:00:00Z',
        publicUrl: 'https://kw.houston.localhost',
        adminPassword: '',
        extra: {
          tls: 'local',
          // The Kubernetes workspaces are the ones whose certificate lives in the cluster.
          tls_terminates: name === 'kw' || name === 'ke' ? 'cluster' : '',
          // ...and `ke`'s name reaches it through this box's edge, passed through.
          ...(name === 'ke' ? { edge: true, ingress_endpoint: '172.16.0.2:32023' } : {}),
        },
      }),
    }));
    jest.doMock('../../../src/core/lifecycle/naming', () => ({
      ...(jest.requireActual('../../../src/core/lifecycle/naming') as Record<string, unknown>),
      resolveName: async (name: string) => name,
    }));
    try {
      const handlers = require('../../../src/cli/handlers') as typeof HandlersNS;
      const execute = handlers.createExecutor({
        writeOut: () => undefined,
        writeErr: () => undefined,
      });
      const spec = COMMAND_SPECS.find((one) => one.path === 'tls-status');
      // `--name` is an OPTION on this command, not a positional.
      await execute({ spec: spec as never, arguments: {}, options: { name: 'kw' }, events: null });
      // On a Kubernetes workspace the cluster's Ingress terminates TLS, so dialling this
      // box reports a healthy workspace as broken.
      expect(dialled).toContain('kw.houston.localhost');
      dialled.length = 0;
      await execute({ spec: spec as never, arguments: {}, options: { name: 'cw' }, events: null });
      // And the Compose path must STILL probe loopback, which is where it terminates.
      expect(dialled).toContain('127.0.0.1');
      // Behind this box's edge the name may be answered by a CDN in front: behind
      // Cloudflare its certificate was reported as the workspace's, exit 0, while the
      // cluster served its ingress default. The origin is the recorded ingress endpoint.
      dialled.length = 0;
      sni.length = 0;
      await execute({ spec: spec as never, arguments: {}, options: { name: 'ke' }, events: null });
      expect(dialled).toEqual(['172.16.0.2']);
      expect(sni).toEqual(['172.16.0.2:32023 kw.houston.localhost']);
    } finally {
      jest.dontMock('../../../src/core/tls');
      jest.dontMock('../../../src/core/runner/record');
      jest.dontMock('../../../src/core/lifecycle/naming');
      jest.resetModules();
    }
  });
});

describe('`tls-status` on a staging certificate', () => {
  it('says how to leave staging the way it was entered', async () => {
    // Staging from `config set acme.staging true` was told to re-run "without
    // --acme-staging", a flag never given, so the re-run changed nothing.
    jest.resetModules();
    jest.doMock('../../../src/core/tls', () => ({
      ...(jest.requireActual('../../../src/core/tls') as typeof TlsNS),
      verify: async (host: string) => ({
        host,
        port: 443,
        serving: true,
        trusted: false,
        trusted_via_ca: false,
        issuer: "CN = (STAGING) Ersatz Emmer YR2, O = (STAGING) Let's Encrypt",
        subject: '',
        dates: 'notAfter=Nov 23 2026',
        names: ['s.example.com'],
        fallback: false,
        self_signed: false,
        staging: true,
        error: '',
      }),
    }));
    jest.doMock('../../../src/core/runner/record', () => ({
      ...(jest.requireActual('../../../src/core/runner/record') as Record<string, unknown>),
      readMeta: async (name: string) => ({
        name,
        project: `houston-${name}`,
        rcVersion: '8.5.1',
        rcImage: 'i',
        mongoTag: '8.0',
        mongoFlavor: 'official',
        preset: 'default',
        rootUrl: 'https://s.example.com',
        hostPort: 3000,
        versionSource: 'map',
        pinned: false,
        createdAt: '2026-01-01T00:00:00Z',
        publicUrl: 'https://s.example.com',
        adminPassword: '',
        extra: { tls: 'acme', tls_email: 'o@e.com', tls_ports: [443] },
      }),
    }));
    jest.doMock('../../../src/core/lifecycle/naming', () => ({
      ...(jest.requireActual('../../../src/core/lifecycle/naming') as Record<string, unknown>),
      resolveName: async (name: string) => name,
    }));
    try {
      const out: string[] = [];
      const handlers = require('../../../src/cli/handlers') as typeof HandlersNS;
      const execute = handlers.createExecutor({
        writeOut: (text: string) => void out.push(text),
        writeErr: () => undefined,
      });
      const spec = COMMAND_SPECS.find((one) => one.path === 'tls-status');
      const run = async (): Promise<string> => {
        out.length = 0;
        await execute({
          spec: spec as never,
          arguments: {},
          options: { name: 's' },
          events: null,
        }).catch(() => undefined);
        return out.join('');
      };
      expect(await run()).toContain('without --acme-staging');
      fs.writeFileSync(configFile(), 'acme_staging: true\n');
      const fromConfig = await run();
      expect(fromConfig).toContain('houston config set acme.staging false');
      expect(fromConfig).not.toContain('without --acme-staging');
    } finally {
      jest.dontMock('../../../src/core/tls');
      jest.dontMock('../../../src/core/runner/record');
      jest.dontMock('../../../src/core/lifecycle/naming');
      jest.resetModules();
    }
  });
});
