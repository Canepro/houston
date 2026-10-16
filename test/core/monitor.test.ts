import * as fs from 'node:fs';
import * as path from 'node:path';

import type * as MonitorNS from '../../src/core/monitor';
import type * as RecordNS from '../../src/core/runner/record';
import type * as LocksNS from '../../src/core/runner/locks';
import type * as FsLockNS from '../../src/seams/fs/lock';
import type * as YamlNS from 'yaml';
import type { KubectlResult } from '../../src/seams/kubectl';

/**
 * What earlier releases answered for the cases below, recorded: the bind each document
 * gives, what each hand-edited case raised, wrote, recorded and ran, and the whole of one
 * attach and one detach -- the document, the record, the files and the events.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'core', 'monitor.json'), 'utf8'),
) as {
  binds: string[];
  cases: Record<string, unknown>[];
  attach: Record<string, unknown>;
  detach: Record<string, unknown>;
};

interface Seen {
  message: string;
  level: string;
  phase: string;
  data: Record<string, unknown>;
}

/**
 * What an event says, its data included: earlier releases pass an event's data as ONE
 * field named `data`, so their done events nest a level, on the stream and in houston.log
 * -- and a comparison that dropped `data` let this build's flat copy through.
 */
const strip = (event: Seen): Seen => ({
  message: event.message,
  level: event.level,
  phase: event.phase,
  data: event.data,
});

describe('reading the host bind out of an existing workspace', () => {
  it('answers what earlier releases answered on every document shape', () => {
    const docs = [
      { services: { rocketchat: { ports: ['0.0.0.0:3000:3000'] } } },
      { services: { rocketchat: { ports: [3000] } } },
      { services: { rocketchat: {}, monitoring: { ports: ['10.0.0.1:9090:9090'] } } },
      { services: {} },
      {},
    ];
    const { detectBind } = require('../../src/core/monitor') as typeof MonitorNS;
    expect(docs.map((doc) => detectBind(doc))).toEqual(RECORDED.binds);
  });

  it('reads an IPv6 bind back, bracketed or as bindPorts writes it', () => {
    const { detectBind } = require('../../src/core/monitor') as typeof MonitorNS;
    const doc = (ports: string[]) => ({ services: { rocketchat: { ports } } });
    expect(detectBind(doc(['::1:8025:8025']))).toBe('::1');
    expect(detectBind(doc(['[::1]:8025:8025/tcp']))).toBe('::1');
    expect(detectBind(doc(['127.0.0.1::9090/udp']))).toBe('127.0.0.1');
    // No address on any port: the default, as before.
    expect(detectBind(doc(['8025:8025']))).toBe('127.0.0.1');
  });

  it('reads the bind before unexpanded port-field interpolation', () => {
    const { detectBind } = require('../../src/core/monitor') as typeof MonitorNS;
    const doc = (ports: string[]) => ({ services: { rocketchat: { ports } } });
    expect(detectBind(doc(['127.0.0.1:${HOST_PORT:-8080}:${CONTAINER_PORT:-80}']))).toBe(
      '127.0.0.1',
    );
    expect(detectBind(doc(['[::1]:${HOST_PORT:+8080}:${CONTAINER_PORT+80}/tcp']))).toBe('::1');
  });

  it('reads host_ip from a long-syntax port before falling back to the default bind', () => {
    const { detectBind } = require('../../src/core/monitor') as typeof MonitorNS;
    expect(
      detectBind({
        services: { rocketchat: { ports: [{ target: 80, published: 8080, host_ip: '::1' }] } },
      }),
    ).toBe('::1');
  });
});

describe('a hand-edited compose file or record, attached and detached on Compose', () => {
  afterEach(() => {
    jest.resetModules();
  });

  // Each case through this build's attach and detach, with the seams stubbed: what each
  // raised, wrote, recorded and ran, against what earlier releases did for it.

  interface Case {
    doc: Record<string, unknown>;
    extra: Record<string, unknown>;
    off: boolean;
  }

  async function ours(cases: Case[]): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (const { doc: given, extra, off } of cases) {
      jest.resetModules();
      const captured: Record<string, unknown> = {};
      const ran: string[] = [];
      const doc = structuredClone(given);
      const meta = {
        name: 'w',
        project: 'houston-w',
        rcVersion: '8.5.1',
        rcImage: 'i',
        mongoTag: '8.0',
        mongoFlavor: 'official',
        preset: 'default',
        rootUrl: 'http://localhost:3000',
        hostPort: 3000,
        versionSource: 'map',
        extra: structuredClone(extra),
      };
      jest.doMock('../../src/core/lifecycle/ports', () => ({
        checkMonitorPorts: async () => undefined,
      }));
      jest.doMock('../../src/core/lifecycle/admin', () => ({
        login: async () => ({ token: 't', userId: 'u' }),
      }));
      jest.doMock('../../src/core/runner/record', () => ({
        ...jest.requireActual('../../src/core/runner/record'),
        readMeta: async () => meta,
        readCompose: async () => doc,
        write: async (_n: string, y: string, m: { extra: unknown }) => {
          captured['y'] = y;
          captured['extra'] = m.extra;
        },
      }));
      jest.doMock('../../src/core/runner/engine', () => ({
        ...jest.requireActual('../../src/core/runner/engine'),
        up: async () => {
          ran.push('up');
          return 0;
        },
        rmServices: async () => {
          ran.push('rm');
          return 0;
        },
      }));
      jest.doMock('../../src/core/runner/queries', () => ({
        ...jest.requireActual('../../src/core/runner/queries'),
        removeVolumes: async () => {
          ran.push('rmv');
          return [];
        },
      }));
      jest.doMock('../../src/core/rcapi', () => ({
        ...jest.requireActual('../../src/core/rcapi'),
        setSetting: async () => true,
      }));
      const monitor = require('../../src/core/monitor') as typeof MonitorNS;
      let error: unknown = null;
      try {
        await (off ? monitor.detachLocked('w') : monitor.attachLocked('w'));
      } catch (exc) {
        error = { kind: (exc as Error).name, message: (exc as Error).message };
      }
      out.push({ error, y: captured['y'] ?? null, extra: captured['extra'] ?? null, ran });
    }
    return out;
  }

  it('writes, refuses and records what earlier releases did, shape for shape', async () => {
    // Detach assigned `doc.services` and `doc.volumes`, so a compose file with no
    // `volumes:` came back with `volumes: {}` and an empty one as both. Attach read a
    // service with no body as `{}` and went on to write and start the stack, where the
    // earlier releases died on it -- both refuse it now. A string `extra.notes` was
    // dropped, where earlier releases keep each character, and a mapping's keys.
    const rc = { rocketchat: { image: 'rc', ports: ['127.0.0.1:3100:3000'] } };
    const cases: Case[] = [
      { doc: { services: rc }, extra: {}, off: true },
      { doc: {}, extra: {}, off: true },
      { doc: { services: rc, volumes: { mongodb_data: {} } }, extra: {}, off: true },
      { doc: { services: null, volumes: {} }, extra: {}, off: true },
      { doc: { services: rc, volumes: ['a'] }, extra: {}, off: true },
      { doc: { services: rc }, extra: { notes: 'see ticket 1234' }, off: true },
      {
        doc: { services: { rocketchat: { ports: ['3100:3000', 3000] }, mongodb: null } },
        extra: {},
        off: false,
      },
      { doc: { services: { rocketchat: 'x' } }, extra: {}, off: false },
      { doc: { services: ['rocketchat'] }, extra: {}, off: false },
      { doc: { services: rc, volumes: null }, extra: {}, off: false },
      // A null service AFTER a three-part port is never reached, here or in earlier releases.
      { doc: { services: { ...rc, mongodb: null } }, extra: {}, off: false },
      { doc: {}, extra: {}, off: false },
      { doc: { services: rc }, extra: { notes: 'see ticket 1234' }, off: false },
      { doc: { services: rc }, extra: { notes: { a: 1, b: 2 } }, off: false },
      { doc: { services: rc }, extra: { notes: [5, ['x'], 'keep'] }, off: false },
      { doc: { services: rc }, extra: { notes: null }, off: false },
      { doc: { services: rc }, extra: { notes: 5 }, off: true },
    ];
    const recorded = RECORDED.cases;
    expect(recorded).toHaveLength(cases.length);
    const got = await ours(cases);
    // One comparison, so a failure shows every case that differs, each with its index.
    expect(got.map((one, at) => ({ at, ...one }))).toEqual(
      recorded.map((one, at) => ({ at, ...one })),
    );
    expect(recorded[1]?.['y']).toContain('\n{}\n');
    expect(recorded[6]?.['error']).toEqual({
      kind: 'ValidationError',
      message: "cannot edit the compose file of 'w': service 'mongodb' is null, not a mapping",
    });
    expect((recorded[12]?.['extra'] as { notes: unknown[] }).notes.slice(0, 3)).toEqual([
      's',
      'e',
      'e',
    ]);
  });
});

describe('attaching monitoring on Compose', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('matches earlier releases on the document, the record, the files and the events', async () => {
    const recorded = RECORDED.attach;

    jest.resetModules();
    const captured: Record<string, unknown> = {};
    const events: Seen[] = [];
    const doc: Record<string, unknown> = {
      services: { rocketchat: { environment: {}, ports: ['0.0.0.0:3000:3000'] } },
      volumes: {},
    };
    const meta = {
      name: 'w',
      project: 'houston-w',
      rcVersion: '8.5.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 'map',
      extra: {},
    };
    jest.doMock('../../src/core/lifecycle/naming', () => ({ resolveName: async (n: string) => n }));
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      requireDocker: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/ports', () => ({
      checkMonitorPorts: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: async () => ({ token: 't', userId: 'u' }),
    }));
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'docker',
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => meta,
      readCompose: async () => doc,
      write: async (_n: string, y: string, m: unknown, files: [string, string][] | undefined) => {
        captured['y'] = y;
        captured['meta'] = m;
        captured['files'] = files;
      },
    }));
    jest.doMock('../../src/core/runner/locks', () => ({
      ...jest.requireActual('../../src/core/runner/locks'),
      reproLock: async (_n: string, body: () => Promise<unknown>) => await body(),
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      up: async (n: string, options: { pull?: boolean; forceRecreate?: string }) => {
        captured['up'] = [n, options.pull ?? true, options.forceRecreate ?? ''];
        return 0;
      },
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      setSetting: async () => false,
    }));
    const monitor = require('../../src/core/monitor') as typeof MonitorNS;
    const result = await monitor.attach('w', ((event: Seen) => events.push(strip(event))) as never);

    const yaml = require('yaml') as typeof YamlNS;
    expect(result).toEqual(recorded['result']);
    expect(result['monitoring']).toBe(true);
    expect(yaml.parse(captured['y'] as string)).toEqual(recorded['doc']);
    expect((captured['meta'] as { extra: unknown }).extra).toEqual(recorded['extra']);
    expect((captured['files'] as [string, string][]).map(([name]) => name)).toEqual(
      recorded['files'],
    );
    expect(captured['up']).toEqual(recorded['up']);
    expect(events).toEqual(recorded['events']);
  });
});

describe('detaching monitoring on Compose', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('matches earlier releases on cleanup, the record and the progress it emits', async () => {
    const recorded = RECORDED.detach;

    jest.resetModules();
    const captured: Record<string, unknown> = {};
    const events: Seen[] = [];
    const meta = {
      name: 'w',
      project: 'houston-w',
      rcVersion: '8.5.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 'map',
      extra: {
        monitoring: true,
        monitoring_ports: [9090, 5050],
        notes: ['Grafana: x', 'keep me'],
      },
    };
    const doc: Record<string, unknown> = {
      services: {
        rocketchat: { environment: {} },
        prometheus: {},
        grafana: {},
        loki: {},
        'node-exporter': {},
        'mongodb-exporter': {},
        'opentelemetry-logs-collector': {},
      },
      volumes: { prometheus_tsdb: {}, grafana_data: {}, loki_data: {} },
    };
    jest.doMock('../../src/core/lifecycle/naming', () => ({ resolveName: async (n: string) => n }));
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      requireDocker: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/ports', () => ({
      checkMonitorPorts: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: async () => {
        throw new Error('down');
      },
    }));
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'docker',
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => meta,
      readCompose: async () => doc,
      write: async (_n: string, y: string, m: unknown) => {
        captured['y'] = y;
        captured['meta'] = m;
      },
    }));
    jest.doMock('../../src/core/runner/locks', () => ({
      ...jest.requireActual('../../src/core/runner/locks'),
      reproLock: async (_n: string, body: () => Promise<unknown>) => await body(),
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      rmServices: async (_n: string, services: string[]) => {
        captured['rm'] = [...services];
        return 0;
      },
    }));
    jest.doMock('../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../src/core/runner/queries'),
      removeVolumes: async (_n: string, volumes: string[]) => {
        captured['vols'] = [...volumes];
        return ['houston-w_loki_data'];
      },
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      setSetting: async () => false,
    }));
    const monitor = require('../../src/core/monitor') as typeof MonitorNS;
    const result = await monitor.detach('w', ((event: Seen) => events.push(strip(event))) as never);

    const yaml = require('yaml') as typeof YamlNS;
    expect(result).toEqual(recorded['result']);
    expect(yaml.parse(captured['y'] as string)).toEqual(recorded['doc']);
    expect((captured['meta'] as { extra: unknown }).extra).toEqual(recorded['extra']);
    expect(captured['rm']).toEqual(recorded['rm']);
    expect(captured['vols']).toEqual(recorded['vols']);
    expect(events).toEqual(recorded['events']);
    expect(
      events.some((event) => event.message.includes('could not remove monitoring volume')),
    ).toBe(true);
  });
});

describe('detaching monitoring on Kubernetes', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('asks for the label off, then reports whether the shared stack stayed', async () => {
    jest.resetModules();
    const labels: [string, boolean][] = [];
    const removed: { context: string }[] = [];
    const stopped: number[] = [];
    const updates: Record<string, unknown>[] = [];
    const meta = {
      name: 'w',
      project: 'houston-w',
      rcVersion: '8.5.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 'map',
      extra: {
        runtime: 'kubernetes',
        namespace: 'houston-w',
        context: 'kind-houston-local',
        monitoring: true,
        grafana_pid: 4321,
      } as Record<string, unknown>,
    };
    jest.doMock('../../src/core/lifecycle/naming', () => ({ resolveName: async (n: string) => n }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: async () => ({ token: 't', userId: 'u' }),
    }));
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'kubernetes',
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => meta,
      updateMeta: async (_n: string, mutate: (m: { extra: Record<string, unknown> }) => void) => {
        mutate(meta);
        updates.push({ ...meta.extra });
      },
    }));
    jest.doMock('../../src/core/kube/monitoring', () => ({
      MONITORING_NAMESPACE: 'monitoring',
      setMonitoringLabel: async (namespace: string, options: { wanted: boolean }) => {
        labels.push([namespace, options.wanted]);
      },
      removeMonitoring: async (options: { context: string }) => {
        removed.push(options);
        return false;
      },
    }));
    jest.doMock('../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../src/core/lifecycle/ready'),
      stopPortForward: (pid: number) => {
        stopped.push(pid);
      },
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      setSetting: async () => false,
    }));
    const monitor = require('../../src/core/monitor') as typeof MonitorNS;
    const events: Seen[] = [];
    const result = await monitor.detach('w', ((event: Seen) => events.push(strip(event))) as never);

    expect(result).toEqual({
      name: 'w',
      monitoring: false,
      rc_setting_reset: false,
      stack_removed: false,
    });
    expect(labels).toEqual([['houston-w', false]]);
    expect(removed.map((call) => call.context)).toEqual(['kind-houston-local']);
    expect(stopped).toEqual([4321]);
    expect(meta.extra.monitoring).toBeUndefined();
    expect(meta.extra.monitoring_ports).toBeUndefined();
    expect(meta.extra.grafana_pid).toBeUndefined();
    expect(events.some((event) => event.message.includes('still wants the shared stack'))).toBe(
      true,
    );
    // Nested one level, as earlier releases nest it.
    expect(events.at(-1)).toEqual({
      message: "monitoring detached from 'w'",
      level: 'info',
      phase: 'done',
      data: { data: { rc_setting_reset: false, stack_removed: false } },
    });
  });
});

describe('attaching monitoring on Kubernetes', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('wires the workspace into the shared stack and reports the Grafana URL', async () => {
    jest.resetModules();
    // The real lock: the Compose specs above stand it in, and a doMock outlives resetModules.
    jest.dontMock('../../src/core/runner/locks');
    const calls: Record<string, unknown[]> = {
      ensure: [],
      labels: [],
      forwards: [],
      reachable: [],
      updates: [],
      order: [],
    };
    const meta = {
      name: 'w',
      project: 'houston-w',
      rcVersion: '8.5.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://127.0.0.1:1',
      hostPort: 3000,
      versionSource: 'map',
      extra: {
        runtime: 'kubernetes',
        namespace: 'houston-w',
        context: 'kind-houston-local',
        // FALSY, and that is the point: earlier releases read any falsy bind as the empty one,
        // where `String(value ?? '')` would have asked kubectl to bind "false".
        bind_host: false,
      } as Record<string, unknown>,
    };
    jest.doMock('../../src/core/lifecycle/naming', () => ({ resolveName: async (n: string) => n }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: async () => ({ token: 't', userId: 'u' }),
    }));
    jest.doMock('../../src/core/lifecycle/ports', () => ({
      checkMonitorPorts: async () => undefined,
    }));
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'kubernetes',
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => meta,
      updateMeta: async (_n: string, mutate: (m: { extra: Record<string, unknown> }) => void) => {
        mutate(meta);
        calls['updates']?.push({ ...meta.extra });
      },
    }));
    jest.doMock('../../src/core/kube/monitoring', () => ({
      MONITORING_NAMESPACE: 'monitoring',
      ensureMonitoring: async (options: { context: string }) => {
        calls['ensure']?.push(options.context);
        calls['order']?.push('ensure');
      },
      setMonitoringLabel: async (namespace: string, options: { wanted: boolean }) => {
        calls['labels']?.push([namespace, options.wanted]);
        calls['order']?.push('label');
      },
      ensurePodMonitor: async (options: { namespace: string; context: string }) => {
        // It renders the release again, so it runs under the workspace's lock: an `upgrade`
        // holding it would otherwise race the re-render.
        const { holdsFileLock } = require('../../src/seams/fs/lock') as typeof FsLockNS;
        const { lockPath } = require('../../src/core/runner/locks') as typeof LocksNS;
        const locked = holdsFileLock(lockPath('w')) ? 'locked' : 'unlocked';
        calls['order']?.push(`podmonitor ${options.namespace} ${options.context} ${locked}`);
      },
    }));
    jest.doMock('../../src/core/kube/forward', () => ({
      grafanaForward: async (options: { context: string; hostPort: number; bindHost: string }) => {
        calls['forwards']?.push(options);
        return 4321;
      },
      forwardReachable: async (port: number) => {
        calls['reachable']?.push(port);
        return true;
      },
    }));
    jest.doMock('../../src/core/kube/names', () => ({ CONTEXT: 'kind-houston-local' }));
    jest.doMock('../../src/core/kube/namespace', () => ({
      namespaceFor: async (n: string) => `houston-${n}`,
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      setSetting: async () => false,
    }));
    const monitor = require('../../src/core/monitor') as typeof MonitorNS;
    const events: Seen[] = [];
    const result = await monitor.attach('w', ((event: Seen) => events.push(strip(event))) as never);

    expect(calls['ensure']).toEqual(['kind-houston-local']);
    expect(calls['labels']).toEqual([['houston-w', true]]);
    // CLAIMED BEFORE THE INSTALL: the label is the reference count a teardown in any home
    // reads, and set after the install it let another workspace's `down` remove the stack
    // this attach was still installing.
    // And the workspace's PodMonitor AFTER the stack, which is what brings its CRD: the first
    // `up --monitor` installed the release before it, so helm rendered no PodMonitor and
    // Grafana's Rocket.Chat dashboard had no data until a re-up.
    expect(calls['order']).toEqual([
      'label',
      'ensure',
      'podmonitor houston-w kind-houston-local locked',
    ]);
    expect(calls['forwards']).toEqual([
      { context: 'kind-houston-local', hostPort: 5050, bindHost: '' },
    ]);
    expect(calls['reachable']).toEqual([5050]);
    expect(result['monitoring']).toBe(true);
    expect(result['grafana_url']).toBe('http://localhost:5050/grafana');
    expect(meta.extra.monitoring).toBe(true);
    expect(meta.extra.monitoring_ports).toEqual([5050]);
    expect(meta.extra.grafana_pid).toBe(4321);
    expect(events.some((event) => event.message.includes('not answering yet'))).toBe(false);
    // Nested one level, as earlier releases nest it.
    expect(events.at(-1)).toEqual({
      message: "monitoring attached to 'w'",
      level: 'info',
      phase: 'done',
      data: { data: { grafana_url: 'http://localhost:5050/grafana' } },
    });
  });
});

describe('the reference count under a detach', () => {
  /**
   * The real `removeMonitoring`, driven through the real service, with only `kube.run`
   * scripted.
   *
   * The count is what stops `monitor --off` on one workspace from blinding every other
   * one on the cluster, so the case asserts the SERVICE answers `stack_removed: false`
   * and never emits `uninstall` when a second namespace still carries the label.
   */
  afterEach(() => {
    jest.resetModules();
  });

  interface Rule {
    match: (argv: readonly string[]) => boolean;
    result: Partial<KubectlResult>;
  }

  it('leaves the stack up while another workspace still wants it', async () => {
    jest.resetModules();
    // Registered factories are not cleared by `resetModules`, so the tests above would
    // otherwise leave their stubs in place and this case would compare a stub's silence
    // rather than the real reference count.
    jest.unmock('../../src/core/kube/monitoring');
    jest.unmock('../../src/core/kube/names');
    jest.unmock('../../src/core/kube/namespace');
    jest.unmock('../../src/core/kube/forward');
    const ran: string[] = [];
    const rules: Rule[] = [
      {
        match: (argv) => argv.includes('list'),
        result: {
          stdout: JSON.stringify([{ name: 'monitoring', status: 'deployed', revision: 1 }]),
        },
      },
      {
        match: (argv) => argv.includes('-l'),
        result: {
          stdout: JSON.stringify({
            items: [{ metadata: { name: 'houston-w' } }, { metadata: { name: 'houston-b' } }],
          }),
        },
      },
      {
        match: (argv) => argv.join(' ').includes('houston-b'),
        result: {
          stdout: JSON.stringify({ metadata: { labels: { 'houston.io/monitoring': 'true' } } }),
        },
      },
    ];
    const kubeRun = async (argv: readonly string[]): Promise<KubectlResult> => {
      if (argv.includes('uninstall')) ran.push('uninstall');
      const rule = rules.find((candidate) => candidate.match(argv));
      const result = (rule?.result ?? { stdout: '', returncode: 0 }) as Partial<KubectlResult>;
      return {
        stdout: String(result.stdout ?? ''),
        stderr: '',
        returncode: result.returncode ?? 0,
      } as never;
    };
    jest.doMock('../../src/core/kube/exec', () => {
      const actual = jest.requireActual('../../src/core/kube/exec') as {
        kube: Record<string, unknown>;
      };
      return { ...actual, kube: { ...actual.kube, run: kubeRun } };
    });
    const meta = {
      name: 'w',
      project: 'houston-w',
      rcVersion: '8.5.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 'map',
      extra: {
        runtime: 'kubernetes',
        namespace: 'houston-w',
        context: 'kind-houston-local',
        monitoring: true,
      },
    };
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => meta,
      updateMeta: async (_n: string, mutate: (m: { extra: Record<string, unknown> }) => void) => {
        mutate(meta);
      },
    }));
    jest.doMock('../../src/core/lifecycle/naming', () => ({ resolveName: async (n: string) => n }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: async () => {
        throw new Error('down');
      },
    }));
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'kubernetes',
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      setSetting: async () => false,
    }));
    const monitor = require('../../src/core/monitor') as typeof MonitorNS;
    const events: Seen[] = [];
    const result = await monitor.detach('w', ((event: Seen) => events.push(strip(event))) as never);

    expect(result['stack_removed']).toBe(false);
    expect(events.map((event) => event.message).join(' ')).toContain('still used by b');
    expect(ran).not.toContain('uninstall');
    expect(meta.extra.monitoring).toBeUndefined();
  });
});

describe('a recorded Grafana pid that is not an integer', () => {
  it('refuses as earlier releases do rather than reading 0x10 as 16', async () => {
    // Earlier releases refuse `0x10` as a pid; `Number(pid)` answers 16, and a silently wrong pid
    // is a signal sent to whatever process now owns that number.
    jest.resetModules();
    const stopped: number[] = [];
    const meta = {
      name: 'w',
      project: 'houston-w',
      rcVersion: '8.5.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 'map',
      extra: {
        runtime: 'kubernetes',
        namespace: 'houston-w',
        context: 'kind-houston-local',
        monitoring: true,
        grafana_pid: '0x10',
      } as Record<string, unknown>,
    };
    jest.doMock('../../src/core/lifecycle/naming', () => ({ resolveName: async (n: string) => n }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: async () => {
        throw new Error('down');
      },
    }));
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'kubernetes',
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => meta,
      updateMeta: async () => undefined,
    }));
    jest.doMock('../../src/core/kube/monitoring', () => ({
      MONITORING_NAMESPACE: 'monitoring',
      setMonitoringLabel: async () => undefined,
      removeMonitoring: async () => false,
    }));
    jest.doMock('../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../src/core/lifecycle/ready'),
      stopPortForward: (pid: number) => {
        stopped.push(pid);
      },
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      setSetting: async () => false,
    }));
    const monitor = require('../../src/core/monitor') as typeof MonitorNS;
    await expect(monitor.detach('w', (() => undefined) as never)).rejects.toThrow(
      "'0x10' is not an integer",
    );
    expect(stopped).toEqual([]);
  });
});

describe('a Kubernetes detach, as a GUI job sees it', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('reports progress on the way rather than going quiet, and ends on done', async () => {
    // A GUI job showed "running" with an empty log for nine minutes, which is
    // indistinguishable from a hang. Something must arrive BEFORE the terminal event.
    jest.resetModules();
    const meta = {
      name: 'w',
      project: 'houston-w',
      rootUrl: 'http://localhost:3000',
      extra: {
        runtime: 'kubernetes',
        namespace: 'houston-w',
        context: 'kind-houston-local',
        monitoring: true,
      } as Record<string, unknown>,
    };
    jest.doMock('../../src/core/lifecycle/naming', () => ({ resolveName: async (n: string) => n }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: async () => {
        throw new Error('down');
      },
    }));
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'kubernetes',
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => meta,
      updateMeta: async (_n: string, mutate: (m: typeof meta) => void) => {
        mutate(meta);
      },
    }));
    jest.doMock('../../src/core/kube/monitoring', () => ({
      MONITORING_NAMESPACE: 'monitoring',
      setMonitoringLabel: async () => undefined,
      removeMonitoring: async () => true,
    }));
    const monitor = require('../../src/core/monitor') as typeof MonitorNS;
    const events: Seen[] = [];
    await monitor.detach('w', ((event: Seen) => events.push(strip(event))) as never);
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.some((event) => event.phase === 'monitor')).toBe(true);
    expect(events.at(-1)?.phase).toBe('done');
  });
});

describe('Grafana public URL regression: attach and detach', () => {
  const modules = [
    'lifecycle/naming',
    'lifecycle/ports',
    'lifecycle/admin',
    'runner/record',
    'runner/engine',
    'runner/queries',
    'edge/routes',
    'kube/names',
    'kube/namespace',
    'kube/monitoring',
    'kube/exec',
    'kube/forward',
    'rcapi',
  ];
  afterEach(() => {
    for (const module of modules) jest.dontMock(`../../src/core/${module}`);
    jest.resetModules();
  });

  function setup(runtime: string, tls = 'local', staging = false) {
    jest.resetModules();
    const record = jest.requireActual<typeof RecordNS>('../../src/core/runner/record');
    const m = record.metadata({
      name: 'w',
      project: 'houston-w',
      publicUrl: 'https://rc.example.test',
      rootUrl: 'http://localhost:3310',
      extra: {
        runtime,
        tls,
        tls_staging: staging,
        namespace: 'houston-w',
        context: 'prod',
        ingress_class: 'traefik',
        notes: [
          'keep me',
          'Grafana:    https://old.example.test/grafana  (admin/admin; anonymous view enabled)',
          "Container logs -> Loki: open the 'Rocket.Chat Logs' dashboard in Grafana (https://old.example.test/grafana/d/houston-logs) - no login needed.",
        ],
      },
    });
    const doc = {
      services: { rocketchat: { environment: {}, ports: ['127.0.0.1:3310:3000'] } },
      volumes: {},
    };
    const registered = jest.fn(async () => false);
    const cleanup = jest.fn(async () => undefined);
    const ports = jest.fn(async () => undefined);
    const forward = jest.fn(async () => 1);
    let manifest: Record<string, unknown> | undefined;
    jest.doMock('../../src/core/lifecycle/naming', () => ({
      resolveName: async (name: string) => name,
    }));
    jest.doMock('../../src/core/lifecycle/ports', () => ({ checkMonitorPorts: ports }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: async () => ({ token: 't', userId: 'u' }),
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...record,
      readMeta: async () => m,
      readCompose: async () => doc,
      write: async () => undefined,
      updateMeta: async (_name: string, update: (meta: typeof m) => void) => update(m),
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual<object>('../../src/core/runner/engine'),
      up: async () => 0,
      rmServices: async () => 0,
    }));
    jest.doMock('../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../src/core/runner/queries'),
      removeVolumes: async () => [],
    }));
    jest.doMock('../../src/core/edge/routes', () => ({
      ...jest.requireActual<object>('../../src/core/edge/routes'),
      register: registered,
    }));
    jest.doMock('../../src/core/kube/names', () => jest.requireActual('../../src/core/kube/names'));
    jest.doMock('../../src/core/kube/namespace', () => ({
      ...jest.requireActual<object>('../../src/core/kube/namespace'),
      namespaceFor: async () => 'houston-w',
    }));
    jest.doMock('../../src/core/kube/monitoring', () => ({
      ...jest.requireActual<object>('../../src/core/kube/monitoring'),
      ensureMonitoring: async () => undefined,
      setMonitoringLabel: async () => undefined,
      removeGrafanaIngress: cleanup,
      removeMonitoring: async () => false,
    }));
    jest.doMock('../../src/core/kube/forward', () => ({
      ...jest.requireActual<object>('../../src/core/kube/forward'),
      grafanaForward: forward,
      forwardReachable: async () => true,
    }));
    jest.doMock('../../src/core/kube/exec', () => ({
      ...jest.requireActual<object>('../../src/core/kube/exec'),
      kube: {
        run: async (argv: string[], options: { input?: string } = {}) => {
          if (argv.includes('apply'))
            manifest = JSON.parse(options.input ?? '{}') as Record<string, unknown>;
          return {
            argv,
            returncode: 0,
            stderr: '',
            stdout:
              argv.includes('certificate') && manifest !== undefined
                ? JSON.stringify({ status: { conditions: [{ type: 'Ready', status: 'True' }] } })
                : '',
          };
        },
      },
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual<object>('../../src/core/rcapi'),
      setSetting: async () => true,
    }));
    return {
      m,
      doc,
      registered,
      cleanup,
      ports,
      forward,
      manifest: () => manifest,
      monitor: require('../../src/core/monitor') as typeof MonitorNS,
    };
  }

  it('publishes Docker Grafana, refreshes both route variants and strips old HTTPS notes', async () => {
    const world = setup('docker');
    const result = await world.monitor.attachLocked('w');
    expect(result.grafana_url).toBe('https://rc.example.test/grafana');
    expect(
      (world.doc.services as Record<string, { environment?: unknown }>).grafana?.environment,
    ).toMatchObject({ GF_SERVER_ROOT_URL: 'https://rc.example.test/grafana/' });
    expect(world.registered).toHaveBeenCalledWith(
      'w',
      'rc.example.test',
      expect.objectContaining({ grafana: true }),
    );
    expect(world.m.extra.notes).not.toEqual(
      expect.arrayContaining([expect.stringContaining('https://old.example.test')]),
    );
    await world.monitor.detachLocked('w');
    expect(world.registered).toHaveBeenLastCalledWith(
      'w',
      'rc.example.test',
      expect.objectContaining({ grafana: false }),
    );
    expect(world.m.extra.notes).toEqual(['keep me']);
  });

  it.each([
    ['local', false, 'houston-ca'],
    ['acme', false, 'houston-acme'],
    ['acme', true, 'houston-acme-staging'],
  ] as const)(
    'applies the Kubernetes Ingress for %s staging=%s and deletes it on detach',
    async (mode, staging, issuer) => {
      const world = setup('kubernetes', mode, staging);
      const result = await world.monitor.attachKubernetes('w');
      expect(result.grafana_url).toBe('https://rc.example.test/grafana');
      expect(result.notes).toContain('Grafana: https://rc.example.test/grafana (admin/admin)');
      expect(result.notes).toContain('the stack is SHARED by every workspace on this cluster');
      expect(world.manifest()).toMatchObject({
        metadata: {
          name: 'grafana-w',
          namespace: 'houston-system',
          labels: { 'app.kubernetes.io/managed-by': 'houston', 'houston.io/workspace': 'w' },
          annotations: { 'cert-manager.io/cluster-issuer': issuer },
        },
        spec: {
          ingressClassName: 'traefik',
          tls: [{ hosts: ['rc.example.test'], secretName: 'grafana-w-tls' }],
          rules: [
            {
              host: 'rc.example.test',
              http: {
                paths: [
                  {
                    path: '/grafana',
                    pathType: 'Prefix',
                    backend: {
                      service: { name: 'monitoring-grafana-service', port: { number: 3000 } },
                    },
                  },
                ],
              },
            },
          ],
        },
      });
      expect(world.forward).not.toHaveBeenCalled();
      expect(world.ports).not.toHaveBeenCalled();
      await world.monitor.detachKubernetes('w');
      expect(world.cleanup).toHaveBeenCalledWith('w', expect.objectContaining({ context: 'prod' }));
    },
  );
});
