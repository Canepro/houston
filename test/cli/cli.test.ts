/**
 * CLI behaviours no other spec carries: the durable record of a failure, the load-test option
 * boundary, the GUI certificate verdict, and the Kubernetes logs command.
 *
 * The CLI's invariants, and the claims the spec for each module already makes, live there.
 */
import * as fs from 'node:fs';

import { logPath, resetForTest } from '../../src/core/eventlog';
import { loadtestTarget } from '../../src/core/loadtest';
import { NotFoundError } from '../../src/lib/errors';

import type * as PathsNS from '../../src/core/runner/paths';
import type * as RecordNS from '../../src/core/runner/record';
import type * as UsersNS from '../../src/core/users';

import type * as AppNS from '../../src/cli/app';
import { runCli } from '../../src/cli/app';
import type * as HandlersNS from '../../src/cli/handlers';
import type * as HttpsNS from '../../src/cli/handlers/https';
import { parseEndpoint, parseRamp } from '../../src/cli/perf';

describe('the durable record of a failure', () => {
  it('says a stack trace went to stderr for an unhandled failure, and not for a handled one', async () => {
    // A stack trace marks a defect in the event log, and this is the one path that prints
    // one -- as the CLI's entry point is in earlier releases.
    resetForTest();
    let stderr = '';
    const io = { writeOut: () => undefined, writeErr: (text: string) => void (stderr += text) };
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const unhandled = await runCli(['list'], {
        execute: async () => {
          throw new Error('a state no command anticipated');
        },
        io,
      });
      const handled = await runCli(['info', '--name', 'nope'], {
        execute: async () => {
          throw new NotFoundError("no repro named 'nope'");
        },
        io,
      });
      expect([unhandled, handled]).toEqual([1, 4]);
    } finally {
      write.mockRestore();
    }
    expect(stderr).toContain('    at ');
    const errors = fs
      .readFileSync(logPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; code: string; trace: boolean })
      .filter((record) => record.kind === 'error');
    expect(errors.map((record) => [record.code, record.trace])).toEqual([
      ['REPRO_ERROR', true],
      ['NOT_FOUND', false],
    ]);
  });
});

describe('the load-test option boundary', () => {
  it('aims the load at the balancer when there is one, and at an instance when not', () => {
    expect(loadtestTarget({ services: { rocketchat: {}, mongodb: {} } })).toBe(
      'http://rocketchat:3000',
    );
    expect(loadtestTarget({ services: { traefik: {}, 'rocketchat-1': {} } })).toBe(
      'http://traefik:80',
    );
    expect(loadtestTarget({ services: { 'rocketchat-1': {}, 'rocketchat-2': {} } })).toBe(
      'http://rocketchat-1:3000',
    );
  });

  it('reads an endpoint with or without a method, and keeps its query string', () => {
    expect(parseEndpoint('GET /api/v1/channels.list')).toEqual(['GET', '/api/v1/channels.list']);
    expect(parseEndpoint('post /api/v1/chat.postMessage')).toEqual([
      'POST',
      '/api/v1/chat.postMessage',
    ]);
    // A bare path defaults to GET.
    expect(parseEndpoint('/api/v1/me')).toEqual(['GET', '/api/v1/me']);
    expect(parseEndpoint('GET /api/v1/x?count=100&a=b')[1]).toBe('/api/v1/x?count=100&a=b');
    // Empty, or not an absolute path.
    for (const bad of ['', 'GET channels.list', '  ']) {
      expect(() => parseEndpoint(bad)).toThrow(/bad --endpoint/u);
    }
  });

  it('reads a ramp as START:END and refuses anything else', () => {
    expect(parseRamp('10:200', '--ramp')).toEqual([10, 200]);
    for (const bad of ['10', 'a:b', '5:0', '1:2:3']) {
      expect(() => parseRamp(bad, '--ramp')).toThrow(/bad --ramp/u);
    }
  });
});

describe('the GUI certificate verdict', () => {
  afterEach(() => {
    for (const id of [
      '../../src/core/kube/endpoints',
      '../../src/core/tls',
      '../../src/core/edge/acme',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
  });

  /** `reportGuiTls` in a stated world: who holds :80/:443, what :443 serves, what ACME said. */
  async function verdict(world: {
    claim?: { context: string; service: string; address: string; ports: number[] };
    serving?: { serving: boolean; fallback: boolean; issuer: string };
    refused?: string;
    tries?: number;
  }): Promise<{ said: string; slept: number[] }> {
    jest.resetModules();
    jest.doMock('../../src/core/kube/endpoints', () => ({
      ...jest.requireActual<object>('../../src/core/kube/endpoints'),
      portClaimingCluster: async () => world.claim ?? null,
    }));
    jest.doMock('../../src/core/tls', () => ({
      ...jest.requireActual<object>('../../src/core/tls'),
      verify: async () => world.serving ?? { serving: false, fallback: false, issuer: '' },
    }));
    jest.doMock('../../src/core/edge/acme', () => ({
      ...jest.requireActual<object>('../../src/core/edge/acme'),
      acmeFailure: async () => world.refused ?? '',
    }));
    const https = require('../../src/cli/handlers/https') as typeof HttpsNS;
    let said = '';
    const slept: number[] = [];
    const io = {
      writeOut: (value: string) => {
        said += value;
      },
      writeErr: (value: string) => {
        said += value;
      },
    };
    await https.reportGuiTls(io, 'gui.example.test', {
      tries: world.tries ?? 1,
      pause: 2.0,
      sleep: async (seconds) => {
        slept.push(seconds);
      },
    });
    return { said, slept };
  }

  it('stops waiting when a cluster holds the ports no challenge could reach', async () => {
    // It waited twenty seconds for a certificate that could not arrive, then said issuance
    // "may still complete" -- which is how a reader learns to ignore the line that mattered.
    const { said, slept } = await verdict({
      claim: {
        context: 'default',
        service: 'kube-system/traefik',
        address: '172.31.46.139',
        ports: [80, 443],
      },
      tries: 10,
    });
    expect(slept).toEqual([]);
    expect(said).toContain('cannot get a certificate');
    expect(said).not.toContain('may still complete');
    expect(said).toContain('172.31.46.139');
  });

  it('says the name has no certificate, why, and what is not broken', async () => {
    // Traefik's fallback certificate is what a failed ACME looks like from outside.
    const { said } = await verdict({
      serving: { serving: true, fallback: true, issuer: 'CN = TRAEFIK DEFAULT CERT' },
      refused:
        'DNS problem: NXDOMAIN looking up A for gui.example.test - check that a DNS ' +
        'record exists for this domain',
    });
    expect(said).toContain('NO certificate');
    expect(said).toContain('NXDOMAIN');
    expect(said).toContain('the name, not the server');
    expect(said).toContain('edge logs');
    expect(said).toContain('443');
  });

  it('confirms a real certificate when there is one', async () => {
    // A warning nobody ever sees succeed is a warning people learn to ignore.
    const { said } = await verdict({
      serving: { serving: true, fallback: false, issuer: "CN = R11, O = Let's Encrypt" },
    });
    expect(said).toContain('serving a real certificate');
    expect(said).toContain("Let's Encrypt");
  });
});

describe('the Kubernetes logs command', () => {
  const MOCKED = ['../../src/core/lifecycle/preconditions', '../../src/core/kube/status'];

  afterEach(() => {
    for (const id of MOCKED) jest.dontMock(id);
    jest.resetModules();
  });

  it('prints every line kubectl writes and keeps none of them', async () => {
    // Earlier releases echo each line and drop it. This pushed every line into the result
    // as well, for a command with no `--json` to read it, so a `logs -f` on a busy cluster
    // held all it had ever printed -- 346 MB against earlier releases' 37 MB for 500,000
    // lines, and growing.
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    await record.writeRecord(
      'kalpha',
      record.metadata({
        name: 'kalpha',
        project: 'houston-kalpha',
        rcVersion: '8.5.1',
        rcImage: 'registry.rocket.chat/rocketchat/rocket.chat',
        mongoTag: '8.0',
        mongoFlavor: 'official',
        preset: 'default',
        rootUrl: 'http://localhost:3000',
        hostPort: 3000,
        versionSource: 'map',
        extra: { runtime: 'kubernetes', context: 'mine', namespace: 'houston-kalpha' },
      }),
    );
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../src/core/lifecycle/preconditions'),
      requireEngine: async () => undefined,
    }));
    const LINES = Array.from({ length: 1000 }, (_, index) => `line ${String(index)}`);
    jest.doMock('../../src/core/kube/status', () => ({
      ...jest.requireActual('../../src/core/kube/status'),
      logProcess: async (_name: string, options: { onLine?: (line: string) => void }) => {
        for (const line of LINES) options.onLine?.(line);
        return { argv: ['kubectl'], exitCode: 0, signal: null, stdout: null, stderr: null };
      },
    }));
    const app = require('../../src/cli/app') as typeof AppNS;
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
    let stdout = '';
    const io = {
      writeOut: (text: string) => void (stdout += text),
      writeErr: () => undefined,
    };
    const executor = handlers.createExecutor(io);
    const results: unknown[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let code: number;
    try {
      code = await app.runCli(['logs', '--name', 'kalpha'], {
        execute: async (invocation) => {
          const result = await executor(invocation);
          results.push(result);
          return result;
        },
        io,
      });
    } finally {
      write.mockRestore();
    }
    expect(code).toBe(0);
    expect(stdout).toBe(LINES.map((line) => `${line}\n`).join(''));
    // What the command hands back holds its exit code, and not one of the lines.
    expect(results).toEqual([{ data: { exit_code: 0 }, exitCode: 0, commandOutcome: true }]);
  });
});

describe("a multi-instance workspace's info", () => {
  it('names its presets without the deployment, which has its own instances line', async () => {
    // Compose builds multi-instance through that preset, so the record lists it among the
    // presets, and `info` printed it as one; the owner settled it is the deployment.
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    await record.writeRecord(
      'mi',
      record.metadata({
        name: 'mi',
        project: 'houston-mi',
        preset: 'email+multi-instance',
        extra: { runtime: 'docker', deployment: 'multi-instance', instances: 2 },
      }),
    );
    let out = '';
    let err = '';
    const io = {
      writeOut: (text: string) => void (out += text),
      writeErr: (text: string) => void (err += text),
    };
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
    const code = await runCli(['info', '--name', 'mi'], {
      io,
      execute: handlers.createExecutor(io),
    });
    expect([code, err]).toEqual([0, '']);
    const row = out.split('\n').find((line) => line.includes('Preset')) ?? '';
    expect(row).toContain('email');
    expect(row).not.toContain('multi-instance');
    expect(out).toContain('instances (2');
  });

  it('does not print fictional direct instance URLs for Kubernetes replicas', async () => {
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    await record.writeRecord(
      'kube-mi',
      record.metadata({
        name: 'kube-mi',
        project: 'houston-kube-mi',
        preset: 'default',
        hostPort: 4300,
        extra: { runtime: 'kubernetes', deployment: 'microservices', instances: 3 },
      }),
    );
    let out = '';
    const io = { writeOut: (text: string) => void (out += text), writeErr: () => undefined };
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;

    expect(
      await runCli(['info', '--name', 'kube-mi'], { io, execute: handlers.createExecutor(io) }),
    ).toBe(0);
    expect(out).not.toContain('instances (3');
    expect(out).not.toContain('rocketchat-1: http://localhost:4301');
  });
});

describe('SSH loopback guidance', () => {
  it.each([
    { label: 'recorded wildcard', recorded: '0.0.0.0', configured: '127.0.0.1', fail: false },
    {
      label: 'owned typed name',
      actor: 'operator',
      owner: 'operator',
      recorded: '0.0.0.0',
      configured: '127.0.0.1',
      fail: false,
    },
    {
      label: 'foreign typed name resolves a new owned name',
      actor: 'operator',
      owner: 'other',
      recorded: '0.0.0.0',
      configured: '127.0.0.1',
      fail: true,
    },
    {
      label: 'reuse ignores a new bind flag',
      flags: ['--bind', '127.0.0.1'],
      mapping: '0.0.0.0:3123:3000',
      configured: '127.0.0.1',
      fail: false,
    },
    {
      label: 'Kubernetes bind flag wins',
      flags: ['--bind', '127.0.0.1'],
      runtime: 'kubernetes',
      recorded: '0.0.0.0',
      configured: '0.0.0.0',
      fail: true,
    },
    {
      label: 'legacy wildcard',
      mapping: '0.0.0.0:3123:3000',
      configured: '127.0.0.1',
      fail: false,
    },
    { label: 'legacy loopback', mapping: '127.0.0.2:3123:3000', configured: '0.0.0.0', fail: true },
    {
      label: 'legacy bracketed IPv6',
      mapping: '[::1]:3123:3000',
      configured: '0.0.0.0',
      fail: true,
    },
    { label: 'legacy bare IPv6', mapping: '::1:3123:3000', configured: '0.0.0.0', fail: true },
    { label: 'unknown legacy bind', configured: '127.0.0.1', fail: false },
    {
      label: 'invalid legacy bind',
      mapping: '[::1:3123:3000',
      configured: '127.0.0.1',
      fail: false,
    },
    {
      label: 'interpolated legacy bind',
      mapping: '${BIND}:3123:3000',
      configured: '127.0.0.1',
      fail: false,
    },
    {
      label: 'Kubernetes now wildcard',
      runtime: 'kubernetes',
      recorded: '127.0.0.1',
      configured: '0.0.0.0',
      fail: false,
    },
    {
      label: 'Kubernetes now loopback',
      runtime: 'kubernetes',
      recorded: '0.0.0.0',
      configured: '127.0.0.1',
      fail: true,
    },
    {
      label: 'explicit Kubernetes',
      flags: ['--runtime', 'kubernetes'],
      recorded: '0.0.0.0',
      configured: '127.0.0.1',
      fail: true,
    },
    {
      label: 'explicit Docker reuse',
      flags: ['--runtime', 'docker'],
      runtime: 'kubernetes',
      recorded: '0.0.0.0',
      configured: '127.0.0.1',
      fail: false,
    },
    {
      label: 'force now wildcard',
      flags: ['--force'],
      recorded: '127.0.0.1',
      configured: '0.0.0.0',
      fail: false,
    },
    {
      label: 'force now loopback',
      flags: ['--force'],
      recorded: '0.0.0.0',
      configured: '127.0.0.1',
      fail: true,
    },
    {
      label: 'fresh now wildcard',
      flags: ['--fresh'],
      recorded: '127.0.0.1',
      configured: '0.0.0.0',
      fail: false,
    },
    {
      label: 'fresh now loopback',
      flags: ['--fresh'],
      recorded: '0.0.0.0',
      configured: '127.0.0.1',
      fail: true,
    },
    { label: 'new wildcard', missing: true, configured: '0.0.0.0', fail: false },
    { label: 'new loopback', missing: true, configured: '127.0.0.1', fail: true },
    {
      label: 'explicit bind wins',
      flags: ['--force', '--bind', '0.0.0.0'],
      recorded: '127.0.0.1',
      configured: '127.0.0.1',
      fail: false,
    },
  ])('preflights the bind the runtime will use: $label', async (scenario) => {
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    const paths = require('../../src/core/runner/paths') as typeof PathsNS;
    const name = 'ssh-preflight';
    await paths.remove(name);
    if (!('missing' in scenario)) {
      const meta = record.metadata({
        name,
        rootUrl: 'http://localhost:3123',
        hostPort: 3123,
        extra: {
          ...('runtime' in scenario ? { runtime: scenario.runtime } : {}),
          ...('owner' in scenario ? { owner: scenario.owner } : {}),
          ...('recorded' in scenario ? { bind_host: scenario.recorded } : {}),
        },
      });
      await record.writeRecord(name, meta);
      if ('mapping' in scenario) {
        fs.writeFileSync(
          `${paths.workspace(name)}/docker-compose.yml`,
          `services:\n  rocketchat:\n    ports: [${JSON.stringify(scenario.mapping)}]\n`,
        );
      }
    }
    const keys = [
      'SSH_CONNECTION',
      'SSH_CLIENT',
      'SSH_TTY',
      'HOUSTON_SSH_LOCAL_PORT',
      'HOUSTON_SSH_PORT',
      'HOUSTON_BIND_HOST',
      'HOUSTON_USER',
    ] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const users = require('../../src/core/users') as typeof UsersNS;
    const priorUsers = users.readAll();
    if ('actor' in scenario) {
      users.writeAll(new Map([['operator', ['synthetic-unused-hash', '2026-01-01', 'member']]]));
    }
    try {
      for (const key of keys) delete process.env[key];
      process.env.SSH_TTY = '/dev/ttys001';
      process.env.HOUSTON_BIND_HOST = scenario.configured;
      if ('actor' in scenario) process.env.HOUSTON_USER = scenario.actor;
      jest.resetModules();
      // The create boundary is stopped here. Preflight, parser, state reads and human
      // dispatch are real; no engine is reached and a refusal must precede this call.
      const create = jest.fn(async () => {
        if ('missing' in scenario) {
          await record.writeRecord(
            name,
            record.metadata({
              name,
              hostPort: 3123,
              rootUrl: 'http://localhost:3123',
              extra: { bind_host: scenario.configured },
            }),
          );
        }
        return { name, waited: true, booted_s: 1 };
      });
      jest.doMock('../../src/core/lifecycle/create-docker', () => ({
        ...jest.requireActual<object>('../../src/core/lifecycle/create-docker'),
        createRepro: create,
      }));
      const app = require('../../src/cli/app') as typeof AppNS;
      const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
      for (const [key, value] of [
        ['HOUSTON_SSH_LOCAL_PORT', '80'],
        ['HOUSTON_SSH_PORT', '70000'],
      ] as const) {
        delete process.env.HOUSTON_SSH_LOCAL_PORT;
        delete process.env.HOUSTON_SSH_PORT;
        process.env[key] = value;
        create.mockClear();
        let stdout = '';
        let stderr = '';
        const io = {
          writeOut: (text: string) => void (stdout += text),
          writeErr: (text: string) => void (stderr += text),
        };
        const code = await app.runCli(
          [
            'up',
            '--version',
            '8.5.1',
            '--name',
            name,
            '--offline',
            ...('flags' in scenario ? scenario.flags : []),
          ],
          { execute: handlers.createExecutor(io), io },
        );
        expect({ key, code, creates: create.mock.calls.length }).toEqual({
          key,
          code: scenario.fail ? 2 : 0,
          creates: scenario.fail ? 0 : 1,
        });
        if (scenario.fail) expect(stderr).toContain(`${key} must be an integer`);
        expect(stdout).not.toContain('tunnel :');
      }
    } finally {
      users.writeAll(priorUsers);
      jest.dontMock('../../src/core/lifecycle/create-docker');
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      jest.resetModules();
    }
  });

  it.each([
    { bind: '127.0.0.2', advertised: '', local: '3123' },
    { bind: '127.0.0.2', advertised: 'https://chat.example.test', local: '3123' },
    { bind: '127.0.0.2', advertised: 'http://127.0.0.1:3123', local: '3123' },
    { bind: '::1', advertised: '', local: '4311' },
  ])(
    'warns about unforwarded loopback URLs in human info: %j',
    async ({ bind, advertised, local }) => {
      const record = require('../../src/core/runner/record') as typeof RecordNS;
      await record.writeRecord(
        'ssh-origin',
        record.metadata({
          name: 'ssh-origin',
          rootUrl: `http://${bind === '::1' ? '[::1]' : bind}:3123`,
          hostPort: 3123,
          preset: 'email',
          extra: { bind_host: bind, sidecar_ports: [8025], advertised_url: advertised },
        }),
      );
      const keys = [
        'SSH_CONNECTION',
        'SSH_CLIENT',
        'SSH_TTY',
        'HOUSTON_SSH_LOCAL_PORT',
        'HOUSTON_SSH_PORT',
        'HOUSTON_SSH_HOST',
        'HOUSTON_SSH_USER',
      ] as const;
      const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
      try {
        for (const key of keys) delete process.env[key];
        process.env.SSH_TTY = '/dev/ttys001';
        process.env.HOUSTON_SSH_LOCAL_PORT = local;
        process.env.HOUSTON_SSH_HOST = 'ssh-proof.invalid';
        process.env.HOUSTON_SSH_USER = 'operator';
        let stdout = '';
        let stderr = '';
        const io = {
          writeOut: (text: string) => void (stdout += text),
          writeErr: (text: string) => void (stderr += text),
        };
        const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
        expect(
          await runCli(['info', '--name', 'ssh-origin'], {
            execute: handlers.createExecutor(io),
            io,
          }),
        ).toBe(0);
        expect(stderr).toBe('');
        const target = bind === '::1' ? '[::1]' : bind;
        expect(stdout).toContain(`127.0.0.1:${local}:${target}:3123`);
        expect(stdout).toContain(`127.0.0.1:8025:${target}:8025`);
        expect(stdout).toContain(`browser: http://127.0.0.1:${local}`);
        expect(stdout).toContain('callbacks');
        expect(stdout).toContain('printed side-service URLs');
        expect(stdout).toContain(`using ${bind} cannot use this handoff`);
        expect(stdout).not.toContain('so their printed URLs work through the tunnel');
        if (advertised === 'https://chat.example.test') {
          expect(stdout).toContain('ROOT_URL is https://chat.example.test');
          expect(stdout).not.toContain('still names port');
        }
        if (advertised === 'http://127.0.0.1:3123')
          expect(stdout).not.toContain('rather than the tunnel');
      } finally {
        for (const key of keys) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
    },
  );

  it('prints the tunnel only when human info verifies a loopback bind', async () => {
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    await record.writeRecord(
      'ssh-ready',
      record.metadata({
        name: 'ssh-ready',
        project: 'houston-ssh-ready',
        rcVersion: '8.5.1',
        rcImage: 'i',
        mongoTag: '8.0',
        mongoFlavor: 'official',
        preset: 'default',
        rootUrl: 'http://localhost:3123',
        hostPort: 3123,
        versionSource: 'map',
        extra: { bind_host: '127.0.0.1' },
      }),
    );
    const keys = [
      'SSH_CONNECTION',
      'USER',
      'HOUSTON_SSH_HOST',
      'HOUSTON_SSH_USER',
      'HOUSTON_SSH_LOCAL_PORT',
    ] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.SSH_CONNECTION = '198.51.100.20 55100 203.0.113.8 22';
      process.env.USER = 'operator';
      delete process.env.HOUSTON_SSH_HOST;
      delete process.env.HOUSTON_SSH_USER;
      delete process.env.HOUSTON_SSH_LOCAL_PORT;
      jest.resetModules();
      jest.doMock('../../src/core/lifecycle/create-docker', () => ({
        ...jest.requireActual<object>('../../src/core/lifecycle/create-docker'),
        createRepro: async () => ({ name: 'ssh-ready', waited: true, booted_s: 1 }),
      }));
      const app = require('../../src/cli/app') as typeof AppNS;
      const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
      let stdout = '';
      let stderr = '';
      const io = {
        writeOut: (text: string) => void (stdout += text),
        writeErr: (text: string) => void (stderr += text),
      };
      const execute = handlers.createExecutor(io);
      const up = await app.runCli(
        ['up', '--version', '8.5.1', '--name', 'ssh-ready', '--offline', '--wait'],
        { execute, io },
      );
      const info = await app.runCli(['info', '--name', 'ssh-ready'], { execute, io });
      expect([up, info, stderr]).toEqual([0, 0, '']);
      expect(
        stdout.match(
          /tunnel : ssh -N -o ExitOnForwardFailure=yes -L 127\.0\.0\.1:3123:127\.0\.0\.1:3123 -- operator@203\.0\.113\.8/g,
        ),
      ).toHaveLength(2);
      expect(stdout.match(/browser: http:\/\/127\.0\.0\.1:3123/g)).toHaveLength(2);
      // Old records can omit bind_host while Compose proves a wildcard publish.
      const old = await record.readMeta('ssh-ready');
      delete old.extra.bind_host;
      await record.writeRecord('ssh-ready', old);
      const paths = require('../../src/core/runner/paths') as typeof PathsNS;
      fs.writeFileSync(
        `${paths.workspace('ssh-ready')}/docker-compose.yml`,
        'services:\n  rocketchat:\n    ports: ["0.0.0.0:3123:3000"]\n',
      );
      stdout = '';
      expect(await app.runCli(['info', '--name', 'ssh-ready'], { execute, io })).toBe(0);
      expect(stdout).not.toContain('tunnel :');
      expect(stdout).not.toContain('Credentials stay private');
      // rootUrl is where Houston itself calls the workspace. With neither the current
      // metadata nor its legacy Compose file proving the bind, do not infer loopback from it.
      fs.unlinkSync(`${paths.workspace('ssh-ready')}/docker-compose.yml`);
      stdout = '';
      expect(await app.runCli(['info', '--name', 'ssh-ready'], { execute, io })).toBe(0);
      expect(stdout).not.toContain('tunnel :');
      expect(stdout).not.toContain('Credentials stay private');
    } finally {
      jest.dontMock('../../src/core/lifecycle/create-docker');
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      jest.resetModules();
    }
  });

  it('recovers a legacy IPv6 Compose bind for human info guidance', async () => {
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    const paths = require('../../src/core/runner/paths') as typeof PathsNS;
    await record.writeRecord(
      'ssh-legacy-ipv6',
      record.metadata({
        name: 'ssh-legacy-ipv6',
        project: 'houston-ssh-legacy-ipv6',
        rcVersion: '8.5.1',
        rcImage: 'i',
        mongoTag: '8.0',
        mongoFlavor: 'official',
        preset: 'default',
        rootUrl: 'http://localhost:3123',
        hostPort: 3123,
        versionSource: 'map',
      }),
    );
    fs.writeFileSync(
      `${paths.workspace('ssh-legacy-ipv6')}/docker-compose.yml`,
      'services:\n  rocketchat:\n    ports: ["[::1]:3123:3000"]\n',
    );
    const keys = [
      'SSH_CONNECTION',
      'USER',
      'HOUSTON_SSH_HOST',
      'HOUSTON_SSH_USER',
      'HOUSTON_SSH_LOCAL_PORT',
    ] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.SSH_CONNECTION = '198.51.100.20 55100 203.0.113.8 22';
      process.env.USER = 'operator';
      delete process.env.HOUSTON_SSH_HOST;
      delete process.env.HOUSTON_SSH_USER;
      delete process.env.HOUSTON_SSH_LOCAL_PORT;
      const app = require('../../src/cli/app') as typeof AppNS;
      const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
      let stdout = '';
      let stderr = '';
      const io = {
        writeOut: (text: string) => void (stdout += text),
        writeErr: (text: string) => void (stderr += text),
      };
      const code = await app.runCli(['info', '--name', 'ssh-legacy-ipv6'], {
        execute: handlers.createExecutor(io),
        io,
      });
      expect([code, stderr]).toEqual([0, '']);
      expect(stdout).toContain(
        "tunnel : ssh -N -o ExitOnForwardFailure=yes -L '127.0.0.1:3123:[::1]:3123' -- operator@203.0.113.8",
      );
      expect(stdout).toContain('browser: http://127.0.0.1:3123');
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});
