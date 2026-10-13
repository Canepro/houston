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

import type * as RecordNS from '../../src/core/runner/record';

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
});
