import * as fs from 'node:fs';
import * as path from 'node:path';

import { CONTEXT as KUBE_CONTEXT } from '../../../src/core/kube/names';
import type { PodRow } from '../../../src/core/kube/status';
import { workspace } from '../../../src/core/runner/paths';
import { type Metadata, metadata, toDocument, write } from '../../../src/core/runner/record';
import * as topology from '../../../src/core/topology';

import {
  degradedReason,
  reproLinks,
  reproState,
  summary,
  uptimeHealth,
} from '../../../src/core/lifecycle/inspect';
import { type NoteGroup, flattenNotes } from '../../../src/core/lifecycle/notes';

import type * as PolicyNS from '../../testsetup-policy';
import type * as HostNS from '../../../src/core/runner/host';
import type * as PayloadNS from '../../../src/core/lifecycle/payload';

// `runner/host` is a GUARDED module and two cases here own it; the suite's healthy engine
// goes back after each one rather than the real module's answers leaking into the next.
afterEach(() => {
  jest.doMock('../../../src/core/runner/host', () =>
    (require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
  );
  jest.dontMock('../../../src/core/lifecycle/inspect');
  jest.dontMock('../../../src/core/kube/status');
  jest.resetModules();
});

/**
 * What earlier releases answered, recorded: `derived` is state, health, links and summary for
 * the cases below; `browserFixtureDetail` is the detail payload their browser tests rendered
 * the panel from.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'core', 'lifecycle', 'inspect.json'),
    'utf8',
  ),
) as { derived: Record<string, unknown>; browserFixtureDetail: Record<string, unknown> };

const STATUSES = [
  'Up 2 hours (healthy)',
  'Up 3 days (Paused)',
  'Restarting (1) 5 seconds ago',
  'Exited (0) 2 hours ago',
  'Created',
  'Dead',
  'Up 5 minutes (health: starting)',
  '',
  'UP 1 second',
];

const STATUS_CASES: [string, boolean][] = [
  ['Up 2 hours (healthy)', true],
  ['Restarting (1) 5 seconds ago', true],
  ['Exited (0) 2 hours ago', true],
  ['Created', true],
  ['', true],
  ['', false],
  ['UP 1 second', false],
];

const SERVICES = [
  { mongodb: 'Up 3 hours (healthy)', rocketchat: 'Up 2 hours (healthy)' },
  { mongodb: 'Exited (0) 5 minutes ago', rocketchat: 'Up 2 hours' },
  { mongodb: 'Restarting (1) 5 seconds ago' },
  {},
];

describe('what a workspace is right now', () => {
  it('derives state, health and links the way earlier releases do', () => {
    const recorded = RECORDED.derived;
    const meta = metadata({
      name: 'T-1',
      project: 'houston-T-1',
      rcVersion: '8.5.1',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3100',
      hostPort: 3100,
      createdAt: '2026-01-01T00:00:00+00:00',
      extra: {
        runtime: 'docker',
        deployment: 'monolith',
        instances: 2,
        monitoring: true,
        created_by: 'alice',
        bind_host: '127.0.0.1',
      },
    });
    expect({
      state: STATUS_CASES.map(([status, flag]) => reproState(status, flag)),
      uptime: STATUSES.map((status) => [...uptimeHealth(status)]),
      degraded: SERVICES.map(degradedReason),
      links: reproLinks(meta),
      summary: summary(meta),
    }).toEqual(recorded);
  });

  it('returns every key the browser fixture renders from', async () => {
    // The payload-shape trap, closed on this side too: the detail payload earlier releases'
    // browser tests rendered the panel from is recorded here, so a key the real payload adds
    // and the fixture lacks breaks the panel in production with the whole suite green. The
    // invariant is `real ⊆ fake`; this asserts it against that recorded fixture.
    const fake = RECORDED.browserFixtureDetail;

    const meta = metadata({
      name: 'cmp',
      project: 'houston-cmp',
      rcVersion: '8.5.1',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3101',
      hostPort: 3101,
      createdAt: '2026-01-01T00:00:00+00:00',
      extra: { runtime: 'docker', deployment: 'monolith', bind_host: '127.0.0.1' },
    });
    await write(
      'cmp',
      'services:\n  rocketchat:\n    image: i\n    ports:\n      - 127.0.0.1:3101:3000\n',
      meta,
    );
    // Docker cannot be asked from a unit test. `dockerAvailable` is the only stub, and it
    // is spread over the real module so its shape cannot drift from the real one.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/host', () => ({
      ...jest.requireActual('../../../src/core/runner/host'),
      dockerAvailable: async () => false,
    }));
    const payload = require('../../../src/core/lifecycle/payload') as typeof PayloadNS;
    const d = (await payload.detail('cmp')) as Record<string, unknown>;
    // THE DIRECTION IS real ⊆ fake: every key the real payload returns must exist in the
    // fixture. A key that is only real would be read by production and missing from every
    // test -- and the fixture being a superset is by design (it is the union of both
    // runtime branches).
    const unrendered = Object.keys(d).filter((key) => !(key in fake));
    expect(unrendered).toEqual([]);
    // And a shared key must be the same SHAPE, not merely present: `env` as a dict where
    // detail() returns rows is a blank tab, not an error.
    for (const key of Object.keys(d)) {
      if (d[key] === null || fake[key] === null || fake[key] === undefined) continue;
      expect(Array.isArray(d[key])).toBe(Array.isArray(fake[key]));
    }
    // The keys the panel ITERATES must be arrays, not undefined or strings.
    expect(Array.isArray(d.env)).toBe(true);
    expect(Array.isArray(d.notes)).toBe(true);
    expect(Array.isArray(d.note_groups)).toBe(true);
    expect(Array.isArray(d.links)).toBe(true);
    expect(Array.isArray(d.owner_history)).toBe(true);
    expect(typeof d.tls).toBe('string');
    expect(d.seed).toBeNull();
  });
});

function linksMeta(preset: string, extra: Record<string, unknown> = {}): Metadata {
  return metadata({
    name: 'r',
    project: 'p',
    rcVersion: '8.5.1',
    rcImage: 'i',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset,
    rootUrl: 'http://localhost:8300',
    hostPort: 8300,
    versionSource: 'x',
    extra,
  });
}

/** A recorded Kubernetes workspace with NO compose file -- the condition these share. */
function kubeWorkspace(name: string, preset: string): Metadata {
  const meta = metadata({
    name,
    project: 'p',
    rcVersion: '8.6.1',
    rcImage: 'i',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset,
    rootUrl: 'http://localhost:3010',
    hostPort: 3010,
    versionSource: 't',
  });
  topology.stamp(meta.extra, topology.KUBERNETES);
  Object.assign(meta.extra, {
    context: KUBE_CONTEXT,
    namespace: `houston-${name}`,
    bind_host: '127.0.0.1',
  });
  fs.mkdirSync(workspace(name), { recursive: true });
  fs.writeFileSync(path.join(workspace(name), 'repro.json'), JSON.stringify(toDocument(meta)));
  expect(fs.existsSync(path.join(workspace(name), 'docker-compose.yml'))).toBe(false);
  return meta;
}

describe('reading a container status', () => {
  it('names every state the rocketchat container can be in', () => {
    // "No rocketchat container" splits on whether anything else survives.
    expect(reproState('', false)).toBe('down');
    expect(reproState('', true)).toBe('stopped');
    expect(reproState('Up 2 hours (healthy)', true)).toBe('running');
    expect(reproState('Up 5 seconds (health: starting)', true)).toBe('running');
    expect(reproState('Exited (0) 2 minutes ago', true)).toBe('stopped');
    expect(reproState('Created', true)).toBe('created');
    expect(reproState('Dead', true)).toBe('dead');
    // Docker reports a paused container as "Up ... (Paused)": it must not read as running.
    expect(reproState('Up 3 days (Paused)', true)).toBe('paused');
    // The regression: a crash-looping RC read as "running" in the list (the healthy
    // Mongo's aggregate) and "stopped" in the detail. Both had to become "restarting".
    expect(reproState('Restarting (1) 5 seconds ago', true)).toBe('restarting');
  });

  it('reads the uptime and the health out of the status', () => {
    expect(uptimeHealth('Up 2 hours (healthy)')).toEqual(['2 hours', 'healthy']);
    expect(uptimeHealth('Up 47 minutes')).toEqual(['47 minutes', '']);
    expect(uptimeHealth('Exited (0) 5 minutes ago')).toEqual(['', '']);
    expect(uptimeHealth('')).toEqual(['', '']);
  });

  it("reports a transitional health without docker's string prefix", () => {
    // Taken verbatim the panel rendered "Health: health: starting". The prefix belongs to
    // the string format, not to the value.
    expect(uptimeHealth('Up 4 seconds (health: starting)')).toEqual(['4 seconds', 'starting']);
    expect(uptimeHealth('Up 2 hours (healthy)')).toEqual(['2 hours', 'healthy']);
    expect(uptimeHealth('Up 5 minutes (unhealthy)')).toEqual(['5 minutes', 'unhealthy']);
    // No healthcheck at all, and a stopped container, are both "no health".
    expect(uptimeHealth('Up 3 minutes')).toEqual(['3 minutes', '']);
    expect(uptimeHealth('Exited (0) 1 minute ago')).toEqual(['', '']);
  });
});

describe('the links a workspace publishes', () => {
  it("surfaces each scenario's own UI, the monitoring pair and every instance", () => {
    const byLabel = (meta: Metadata) =>
      Object.fromEntries(reproLinks(meta).map((link) => [link.label, link.url]));
    const s3 = byLabel(linksMeta('s3_minio'));
    expect(s3['Rocket.Chat']).toBe('http://localhost:8300');
    expect(Object.keys(s3)).toEqual(expect.arrayContaining(['MinIO console', 'MinIO API']));
    const oidc = byLabel(linksMeta('oidc'));
    expect(oidc.Keycloak).toMatch(/^http:\/\/localhost:/u);
    expect(Object.keys(byLabel(linksMeta('default', { monitoring: true })))).toEqual(
      expect.arrayContaining(['Grafana', 'Prometheus']),
    );
    expect(Object.keys(byLabel(linksMeta('multi-instance', { instances: 3 })))).toEqual(
      expect.arrayContaining(['instance 1', 'instance 2', 'instance 3']),
    );
  });
});

describe('what the record alone says', () => {
  it('renders a workspace made before note groups existed as groups', () => {
    // Grouped notes were written into repro.json at create time, so they reached only
    // workspaces created after the release that added them -- and destroying a customer
    // repro to see the new shape is the one thing nobody can do. Notes are a pure function
    // of the record, so they are derived on every read. This is what an older release wrote.
    const meta = metadata({
      name: 'old',
      project: 'houston-old',
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
        deployment: 'microservices',
        namespace: 'houston-old',
        context: 'kind-houston-local',
        release: 'rocketchat',
        bind_host: '127.0.0.1',
        mongo_managed_by: 'statefulset',
        mongo_image: 'mongo:8.0',
        notes: [
          'microservices on kind-houston-local - about 9 pods, namespace houston-old',
          'reachable on this box at http://localhost:3000',
        ],
      },
    });
    const s = summary(meta);
    const groups = s.note_groups as NoteGroup[];
    const titles = groups.map((group) => group.title);
    expect(titles.slice(0, 2)).toEqual(['Kubernetes', 'MongoDB']);
    // The three steps read in the order somebody has to perform them.
    expect(titles.slice(2, 5)).toEqual([
      '1 · Point kubectl and helm at this cluster',
      '2 · Open the way in',
      '3 · Look at what is inside',
    ]);
    // The facts that were welded into a sentence are rows now, for this record too.
    expect(Object.fromEntries(groups[0]?.rows ?? [])).toEqual({
      Cluster: 'kind-houston-local',
      Namespace: 'houston-old',
      Arrangement: 'microservices',
      Pods: 'about 9',
    });
    // And the flat list the CLI prints is the derived one, not the sentence above.
    expect(s.notes).toEqual(flattenNotes(groups));
    expect(
      (s.notes as string[]).filter((note) => note.includes('about 9 pods, namespace')),
    ).toEqual([]);
  });

  it("carries the workspace's password, and an older record's real one", () => {
    // The GUI renders `login` with a copy button and the create dialog shows the same
    // dict, so a generated password reaches a browser-only operator through this key.
    const meta = metadata({
      name: 'd',
      project: 'houston-d',
      rcVersion: '8.5.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3001',
      hostPort: 3001,
      versionSource: 'live',
      adminPassword: 's3cret-generated-value',
    });
    expect(summary(meta).login).toEqual({ user: 'admin', password: 's3cret-generated-value' });
    meta.adminPassword = '';
    expect((summary(meta).login as { password: string }).password).toBe('admin123');
  });
});

describe('the detail of a Kubernetes workspace', () => {
  function withCluster(pods: PodRow[], { dockerDown = false } = {}): typeof PayloadNS {
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/inspect', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/inspect'),
      kubernetesState: async () => 'running',
    }));
    jest.doMock('../../../src/core/kube/status', () => ({
      ...jest.requireActual('../../../src/core/kube/status'),
      podRows: async () => pods,
    }));
    if (dockerDown) {
      // Over the suite's healthy engine, so the only thing this changes is the answer.
      jest.doMock('../../../src/core/runner/host', () => ({
        ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
        dockerAvailable: async () => false,
      }));
    }
    return require('../../../src/core/lifecycle/payload') as typeof PayloadNS;
  }

  it('gives it its links and its pods', async () => {
    // The Kubernetes branch returned before it built either. A preset's UI answers on the
    // SAME host port under both runtimes, so leaving links out made phpLDAPadmin, Keycloak,
    // MinIO, Mailpit and Grafana unreachable from the GUI while the CLI printed each. And
    // an empty `containers` reads as "this repro is down" under a running workspace, with
    // no way to see an ImagePullBackOff from a browser.
    kubeWorkspace('k', 'ldap');
    const payload = withCluster([
      {
        service: 'rocketchat-rocketchat-1',
        state: 'running',
        status: '1/1 ready',
        health: 'healthy',
        app: true,
        blocked: false,
        restarts: 0,
        started: '2026-08-18T10:00:00Z',
      },
      {
        service: 'rocketchat-mongodb-0',
        state: 'pending',
        status: 'ImagePullBackOff',
        health: '',
        app: false,
        blocked: true,
        restarts: 0,
        started: '',
      },
    ]);
    const d = await payload.detail('k');
    const labels = (d.links as { label: string }[]).map((link) => link.label);
    expect(labels).toContain('Rocket.Chat');
    // The scenario's own UI, on the same port as Compose.
    expect(labels).toContain('phpLDAPadmin');
    const containers = d.containers as PodRow[];
    expect(containers.map((row) => row.service)).toEqual([
      'rocketchat-rocketchat-1',
      'rocketchat-mongodb-0',
    ]);
    expect(containers[1]?.status).toContain('ImagePullBackOff');
    // microservices, because that is what this runtime DEFAULTS to and the record names no
    // deployment.
    expect([d.runtime, d.deployment, d.namespace]).toEqual([
      'kubernetes',
      'microservices',
      'houston-k',
    ]);
    // An uptime, from the earliest running pod.
    expect(d.uptime).not.toBe('');
  });

  it('survives docker being down, because the runtime is asked first', async () => {
    // detail() asked docker first, and its docker-unavailable branch reads the COMPOSE
    // FILE. A Kubernetes workspace has none, so a daemon merely asleep answered the panel
    // with a bare ENOENT -- a 500 -- for a workspace running fine in the cluster.
    kubeWorkspace('k', 'default');
    const payload = withCluster([], { dockerDown: true });
    // The stub is really in force: the engine this payload sees says docker is down.
    expect(
      await (require('../../../src/core/runner/host') as typeof HostNS).dockerAvailable(),
    ).toBe(false);
    const d = await payload.detail('k');
    // Docker's absence says nothing about a cluster...
    expect(d.state).toBe('running');
    // ...and the links are still there.
    expect((d.links as unknown[]).length).toBeGreaterThan(0);
  });
});
