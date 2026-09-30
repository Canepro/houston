/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { FastifyInstance } from 'fastify';

jest.mock('../../../src/core/lifecycle/inspect', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/inspect'),
  listRepros: jest.fn(),
  describe: jest.fn(),
  kubernetesState: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/payload', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/payload'),
  detail: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/naming', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/naming'),
  resolveName: jest.fn(),
}));
jest.mock('../../../src/core/runner/host', () => ({
  ...jest.requireActual('../../../src/core/runner/host'),
  dockerAvailable: jest.fn(),
  dockerKernelVersion: jest.fn(),
}));
jest.mock('../../../src/core/runner/engine', () => ({
  ...jest.requireActual('../../../src/core/runner/engine'),
  containerIds: jest.fn(),
  stream: jest.fn(),
}));
jest.mock('../../../src/core/runner/queries', () => ({
  ...jest.requireActual('../../../src/core/runner/queries'),
  dockerStats: jest.fn(),
  containerDetails: jest.fn(),
  rcRestartCount: jest.fn(),
}));
jest.mock('../../../src/core/runner/record', () => ({
  ...jest.requireActual('../../../src/core/runner/record'),
  readMeta: jest.fn(),
}));
jest.mock('../../../src/core/topology', () => ({
  ...jest.requireActual('../../../src/core/topology'),
  ofRepro: jest.fn(),
}));
jest.mock('../../../src/core/kube/probe', () => ({
  ...jest.requireActual('../../../src/core/kube/probe'),
  preflight: jest.fn(),
}));
jest.mock('../../../src/core/kube/tools', () => ({
  ...jest.requireActual('../../../src/core/kube/tools'),
  toolsReady: jest.fn(),
  canProvision: jest.fn(),
}));
jest.mock('../../../src/core/kube/status', () => ({
  ...jest.requireActual('../../../src/core/kube/status'),
  podMetrics: jest.fn(),
  podRows: jest.fn(),
}));
jest.mock('../../../src/core/cluster', () => ({
  ...jest.requireActual('../../../src/core/cluster'),
  knownContexts: jest.fn(),
  status: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/sizing', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/sizing'),
  capacity: jest.fn(),
}));
jest.mock('../../../src/core/edge/runtime', () => ({
  ...jest.requireActual('../../../src/core/edge/runtime'),
  status: jest.fn(),
  deleteHost: jest.fn(),
}));
jest.mock('../../../src/core/edge/spec', () => ({
  ...jest.requireActual('../../../src/core/edge/spec'),
  servedDomain: jest.fn(),
}));
jest.mock('../../../src/core/edge/acme', () => ({
  ...jest.requireActual('../../../src/core/edge/acme'),
  acmeHosts: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/create-docker', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/create-docker'),
  createRepro: jest.fn(),
}));
jest.mock('../../../src/core/envvars', () => ({
  ...jest.requireActual('../../../src/core/envvars'),
  current: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/seeding', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/seeding'),
  runSeedInline: jest.fn(),
}));
jest.mock('../../../src/core/backup', () => ({
  ...jest.requireActual('../../../src/core/backup'),
  listBackups: jest.fn(),
}));
jest.mock('../../../src/core/doctor', () => ({
  ...jest.requireActual('../../../src/core/doctor'),
  runChecks: jest.fn(),
}));
jest.mock('../../../src/core/edge/routes', () => ({
  ...jest.requireActual('../../../src/core/edge/routes'),
  routeHost: jest.fn(),
  isPassthrough: jest.fn(),
  routeReachable: jest.fn(),
}));

import * as cluster from '../../../src/core/cluster';
import * as backup from '../../../src/core/backup';
import * as doctor from '../../../src/core/doctor';
import * as edgeRoutes from '../../../src/core/edge/routes';
import * as createDocker from '../../../src/core/lifecycle/create-docker';
import * as envvars from '../../../src/core/envvars';
import * as seeding from '../../../src/core/lifecycle/seeding';
import * as presets from '../../../src/lib/presets';
import * as config from '../../../src/lib/config';
import { CREATE_POLICY_KEY, PRIVILEGED_CREATE_FIELDS } from '../../../src/core/lifecycle/types';
import type { JobManager } from '../../../src/web/jobs';
import { NotReadyError } from '../../../src/lib/errors';
import * as firstrun from '../../../src/core/firstrun';
import * as edgeAcme from '../../../src/core/edge/acme';
import * as edgeRuntime from '../../../src/core/edge/runtime';
import * as edgeSpec from '../../../src/core/edge/spec';
import * as inspect from '../../../src/core/lifecycle/inspect';
import * as naming from '../../../src/core/lifecycle/naming';
import * as payload from '../../../src/core/lifecycle/payload';
import * as sizing from '../../../src/core/lifecycle/sizing';
import * as kubeProbe from '../../../src/core/kube/probe';
import * as kubeTools from '../../../src/core/kube/tools';
import * as runnerHost from '../../../src/core/runner/host';
import * as runnerEngine from '../../../src/core/runner/engine';
import * as runnerQueries from '../../../src/core/runner/queries';
import * as runnerRecord from '../../../src/core/runner/record';
import * as topology from '../../../src/core/topology';
import * as kubeStatus from '../../../src/core/kube/status';
import * as users from '../../../src/core/users';
import { createApp } from '../../../src/web/app';
import type { AppOptions } from '../../../src/web/app';

const realPayload = jest.requireActual<typeof payload>('../../../src/core/lifecycle/payload');
const realInspect = jest.requireActual<typeof inspect>('../../../src/core/lifecycle/inspect');

const mockListRepros = jest.mocked(inspect.listRepros);
const mockDescribe = jest.mocked(inspect.describe);
const mockKubernetesState = jest.mocked(inspect.kubernetesState);
const mockDetail = jest.mocked(payload.detail);
const mockResolveName = jest.mocked(naming.resolveName);
const mockDockerAvailable = jest.mocked(runnerHost.dockerAvailable);
const mockDockerKernelVersion = jest.mocked(runnerHost.dockerKernelVersion);
const mockContainerIds = jest.mocked(runnerEngine.containerIds);
const mockComposeStream = jest.mocked(runnerEngine.stream);
const mockDockerStats = jest.mocked(runnerQueries.dockerStats);
const mockContainerDetails = jest.mocked(runnerQueries.containerDetails);
const mockRcRestartCount = jest.mocked(runnerQueries.rcRestartCount);
const mockReadMeta = jest.mocked(runnerRecord.readMeta);
const mockRuntimeOf = jest.mocked(topology.ofRepro);
const mockPodMetrics = jest.mocked(kubeStatus.podMetrics);
const mockPodRows = jest.mocked(kubeStatus.podRows);
const mockPreflight = jest.mocked(kubeProbe.preflight);
const mockToolsReady = jest.mocked(kubeTools.toolsReady);
const mockCanProvision = jest.mocked(kubeTools.canProvision);
const mockKnownContexts = jest.mocked(cluster.knownContexts);
const mockClusterStatus = jest.mocked(cluster.status);
const mockCapacity = jest.mocked(sizing.capacity);
const mockEdgeStatus = jest.mocked(edgeRuntime.status);
const mockDeleteHost = jest.mocked(edgeRuntime.deleteHost);
const mockServedDomain = jest.mocked(edgeSpec.servedDomain);
const mockAcmeHosts = jest.mocked(edgeAcme.acmeHosts);
const mockCreateRepro = jest.mocked(createDocker.createRepro);
const mockEnvCurrent = jest.mocked(envvars.current);
const mockRunSeedInline = jest.mocked(seeding.runSeedInline);
const mockListBackups = jest.mocked(backup.listBackups);
const mockRunChecks = jest.mocked(doctor.runChecks);
const mockRouteHost = jest.mocked(edgeRoutes.routeHost);
const mockIsPassthrough = jest.mocked(edgeRoutes.isPassthrough);
const mockRouteReachable = jest.mocked(edgeRoutes.routeReachable);

const PUBLIC_NAME = 'houston.support.example.com';
let portedJobs: JobManager | undefined;
let portedUser = 'alice';
let portedPassword = 'browser-password-123';
let portedReducedMotion = false;
let surfaceAcmeHosts: string[] = [];

type BrowserCase = readonly [file: string, name: string];

const CASES: readonly BrowserCase[] = [
  ['flows', 'a signed out browser lands on the sign in page'],
  ['flows', 'a wrong password shows an error in the page'],
  ['flows', 'signing in renders the dashboard'],
  ['flows', 'sign out ends the session and returns to the login'],
  ['flows', 'first run creates the first admin in the browser'],
  ['flows', 'the setup page says so when the key is missing'],
  ['flows', 'a readonly user is not offered what it cannot do'],
  ['flows', 'an admin can open people and a member cannot'],
  ['flows', 'the activity page opens both of its tabs'],
  ['surfaces chrome', 'the theme is light by default and the choice survives a reload'],
  ['surfaces chrome', 'people rows have their own shape not activitys'],
  ['surfaces chrome', 'a background poll does not navigate the page for you'],
  ['surfaces chrome', 'activity and a workspace are different views of the stage'],
  ['surfaces chrome', 'the scenarios page shows the setup step a preset needs'],
  ['surfaces chrome', 'every page is reachable and says which one you are on'],
  ['surfaces chrome', 'the dashboard poll does not close the page you are reading'],
  ['surfaces chrome', 'preset notes are read as points not as lines'],
  ['surfaces rail', 'the dashboard renders a workspace card'],
  ['surfaces rail', 'the detail panel opens and switches tabs'],
  ['surfaces rail', 'the log viewer streams container output'],
  ['surfaces rail', 'the backups tab lists what is there'],
  ['surfaces rail', 'a readonly user is offered nothing in the detail panel either'],
  ['surfaces rail', 'nothing in the page is painted a hardcoded dark colour'],
  ['surfaces rail', 'no control is hidden behind the status bar'],
  ['surfaces rail', 'the one button a screen is asking for carries the accent'],
  ['surfaces rail', 'a burst of log lines costs one layout not one per line'],
  ['surfaces rail', 'scrolling up in the logs offers one press back to the latest'],
  ['surfaces rail', 'reduced motion keeps every state and removes the travel'],
  ['surfaces rail', 'the action pane names the thing not one of its parts'],
  ['surfaces panel', 'the home page leads with capacity'],
  ['surfaces panel', 'a down workspace is something home asks you about'],
  ['surfaces panel', 'a card is not the same colour as the thing it stands on'],
  ['surfaces panel', 'a note that names a place joins the row that already lists it'],
  ['surfaces dialogs', 'the create dialog opens and lists presets'],
  ['surfaces dialogs', 'the load test dialog opens from the panel'],
  ['surfaces dialogs', 'the doctor dialog renders its checks'],
  ['surfaces dialogs', 'the edge badge surfaces an unreachable route'],
  ['surfaces dialogs', 'an admin can delete a certificate nothing points at'],
  ['surfaces dialogs', 'a member is not offered the delete at all'],
  ['surfaces dialogs', 'the create dialog follows the box policy not the role'],
  ['surfaces dialogs', 'https is in section two and is still not a second twisty'],
  ['surfaces dialogs', 'you can change your own password from the browser'],
  ['surfaces offstage', 'a running workspace on home offers both places it could mean'],
  ['remote', 'the panel says that localhost means the readers own machine'],
  ['remote', 'a wide bound workspace is given the address that works from here'],
  ['remote', 'a local browser is told none of this'],
  ['remote', 'the create dialog warns a remote reader about the default bind'],
  ['remote', 'the create dialog stays quiet on a laptop'],
  ['plain http', 'signing in works over plain http on a real hostname'],
  ['plain http', 'a write from the spa survives plain http on a real hostname'],
  ['plain http', 'a link row shows the workspaces root url verbatim'],
  ['plain http', 'a placeholder url in a link row is left alone'],
  ['plain http', 'the workspace row says kubernetes and stays quiet about docker'],
  ['plain http', 'the create dialog offers a runtime and follows it'],
  ['plain http', 'creating a kubernetes workspace sends the axes'],
  ['kubernetes chrome', 'the top links become one menu on a narrow screen'],
  ['kubernetes chrome', 'the header is the doctor button and the footer names both engines'],
  ['kubernetes chrome', 'the doctor chip goes red only when nothing can run a workspace'],
  ['kubernetes chrome', 'in progress shows only jobs that are'],
  ['kubernetes dialogs', 'the seed job shows what it made and whether it was confirmed'],
  ['kubernetes dialogs', 'the create dialog says what it builds and what the box has left'],
  ['kubernetes dialogs', 'the runtime card names no cluster because it cannot know which'],
  ['kubernetes dialogs', 'the arrangement says what it builds'],
  ['kubernetes offstage', 'fake detail matches the real payload'],
  ['kubernetes offstage', 'the restart count on kubernetes is rocket chats own pod'],
  ['kubernetes pane', 'the action pane leads with what this state admits'],
  ['kubernetes pane', 'the pane never offers what this runtime refuses'],
  ['kubernetes panel', 'the panel leads with what is wrong and what to do'],
  ['kubernetes panel', 'a down workspace is told what it still holds'],
  ['kubernetes panel', 'a pod that cannot start is named in the panel'],
  ['kubernetes panel', 'the narrow layout is a picker a panel and a bar'],
  ['kubernetes panel', 'a sidecar that keeps restarting is a fault on kubernetes'],
  ['kubernetes panel', 'a sidecar that is not ready and restarting is still a fault'],
  ['kubernetes rail', 'the env tab renders on kubernetes where it used to be blank'],
  ['kubernetes rail', 'the env tab still offers the controls on compose'],
  ['kubernetes rail', 'the env tab shows the refusal rather than an empty table'],
  ['kubernetes rail', 'the containers tab shows pods and says so on kubernetes'],
  ['kubernetes rail', 'the live chart stops asking when the answer is a refusal'],
  ['kubernetes rail', 'a credential note is not labelled a sudo setup step'],
  ['kubernetes rail', 'the one preset with a real setup step keeps it'],
  ['kubernetes rail', 'the three panes survive a narrow window'],
  ['kubernetes rail', 'a note that ends in a name is not glued to the next one'],
  ['kubernetes rail', 'a genuinely wrapped note still joins the line after it'],
  ['kubernetes rail', 'a long line in a note scrolls instead of being clipped away'],
  ['kubernetes rail', 'a grouped note gets its own card with a fact table and a copy button'],
  ['kubernetes rail', 'the overview says which runtime the workspace runs on'],
  ['kubernetes rail', 'the panel is not a two hundred pixel window on a narrow screen'],
  ['kubernetes rail', 'a place a group names is the link row and not a second row'],
  ['kubernetes rail', 'a healthy workspace gets no triage block at all'],
  ['kubernetes rail', 'the rail groups by what each workspace wants from you'],
  ['kubernetes rail', 'one state gets no group headings'],
  ['kubernetes rail', 'a long workspace name does not push the rail sideways'],
  ['kubernetes rail', 'a seeded workspace is not told to seed itself'],
  ['kubernetes rail', 'nothing is suggested for a workspace that is not running'],
  ['kubernetes rail', 'a kubernetes log line is split by pod like a compose one'],
  ['kubernetes rail', 'a note paragraph is as wide as the card it is in'],
  ['kubernetes rail', 'a restart count that climbs is a fault even while ready'],
  ['kubernetes rail', 'the gui has exactly one jobActive and the page parses'],
  ['kubernetes rail', 'the stats poll discards another workspaces answer'],
  ['clusters', 'the clusters view never shows a zero it did not read'],
  ['clusters', 'the cluster chip wants you in amber and is never red'],
  ['clusters', 'only an admin is offered the controls that spend or destroy'],
  ['clusters', 'the delete dialog will not arm until the name is typed'],
  ['clusters', 'the fake cluster status matches the real payload'],
  ['clusters', 'the cluster action pane survives the four second poll'],
  ['clusters', 'the create form says what a managed cluster commits you to'],
  ['clusters', 'section two does not quote this laptops memory for a cluster in aws'],
  ['clusters', 'the clusters view speaks english and explains its own numbers'],
  ['clusters', 'a cluster aws says is gone does not read as one that is down'],
  ['clusters', 'a gone cluster offers only controls that can work'],
  ['clusters', 'the local certificate option goes when the cluster is not on this machine'],
  ['clusters', 'the cluster picker shows a name not sixty characters of arn'],
];

const CASES_DIGEST = 'aeebd4e964f9c7a2a5be8fafed9d5634993deab5159c30fa863e004480017f13';
const caseIds = CASES.map(([file, name]) => `${file}: ${name}`);
const casesDigest = crypto.createHash('sha256').update(JSON.stringify(CASES)).digest('hex');
if (CASES.length !== 112 || new Set(caseIds).size !== 112 || casesDigest !== CASES_DIGEST) {
  throw new Error(
    `browser behavior inventory changed: expected 112 unique cases at ${CASES_DIGEST}, ` +
      `got ${String(CASES.length)} cases, ${String(new Set(caseIds).size)} unique, ${casesDigest}`,
  );
}

function probeCase(file: string, name: string): boolean {
  return file === 'surfaces rail' && name === 'the dashboard renders a workspace card';
}

function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 't1234',
    state: 'running',
    rc_version: '7.4.1',
    mongo_tag: '7.0',
    mongo_flavor: 'mongodb',
    host_port: 3001,
    uptime: '2h',
    preset: 'base',
    health: 'healthy',
    url: 'http://localhost:3001',
    root_url: 'http://localhost:3001',
    public_url: '',
    login: { user: 'admin', password: 'admin123' },
    degraded: '',
    instances: 1,
    instance_urls: [],
    containers: [
      { service: 'rocketchat', state: 'running', status: 'Up 2 hours', health: 'healthy' },
    ],
    env: [{ key: 'ROOT_URL', value: 'http://localhost:3001', override: false }],
    links: [],
    notes: [],
    note_groups: [],
    restarts: 0,
    monitoring: false,
    tls: '',
    is_default: false,
    created_by: 'alice',
    owner: 'alice',
    made_by: 'alice',
    owner_history: [],
    workspace: '/tmp/ws',
    default: false,
    grafana_url: '',
    diag: {},
    runtime: 'docker',
    deployment: 'monolith',
    bind_host: '127.0.0.1',
    seed: null,
    pinned: false,
    namespace: '',
    ...overrides,
  };
}

function configureStubs(browserCase: BrowserCase): void {
  const kubernetes = browserCase[0].includes('kubernetes');
  const row = detail(
    kubernetes
      ? {
          runtime: 'kubernetes',
          deployment: 'microservices',
          namespace: 'houston-t1234',
          containers: [],
        }
      : {},
  );
  mockListRepros.mockResolvedValue([row] as never);
  mockDescribe.mockResolvedValue(row as never);
  mockDetail.mockResolvedValue(row as never);
  if (
    process.env.BROWSER_GATE_PROBE === 'wire' &&
    browserCase[0] === 'surfaces rail' &&
    browserCase[1] === 'the detail panel opens and switches tabs'
  ) {
    mockDetail.mockResolvedValue({ ...row, rc_version: 'wire-contract-violation' } as never);
  }
  mockResolveName.mockResolvedValue('t1234');
  mockDockerAvailable.mockResolvedValue(true);
  mockDockerKernelVersion.mockResolvedValue('6.8.0');
  mockContainerIds.mockResolvedValue([]);
  mockDockerStats.mockResolvedValue('');
  mockContainerDetails.mockResolvedValue([]);
  mockRcRestartCount.mockResolvedValue(0);
  mockReadMeta.mockResolvedValue({
    name: 't1234',
    runtime: kubernetes ? topology.KUBERNETES : topology.DOCKER,
    extra: kubernetes ? { context: 'kind-support' } : {},
  } as never);
  mockRuntimeOf.mockResolvedValue(kubernetes ? topology.KUBERNETES : topology.DOCKER);
  mockPodMetrics.mockResolvedValue([]);
  mockPodRows.mockResolvedValue([]);
  mockKubernetesState.mockResolvedValue('running');
  mockPreflight.mockResolvedValue({
    context: kubernetes ? 'kind-support' : '',
    distribution: kubernetes ? 'kind' : '',
    clusterReachable: kubernetes,
    nodeCount: kubernetes ? 1 : 0,
    namespaces: kubernetes ? ['houston-t1234'] : [],
  } as never);
  mockToolsReady.mockReturnValue(kubernetes);
  mockCanProvision.mockReturnValue(false);
  mockKnownContexts.mockResolvedValue({ contexts: [], unreadable: '', default: '' });
  mockClusterStatus.mockResolvedValue({} as never);
  mockCapacity.mockResolvedValue({
    known: true,
    total_mb: 32768,
    available_mb: 28672,
    reserve_mb: 6553,
    swap_mb: 0,
    workspace_mb: 1100,
    room: 20,
    room_denominated_in: 'docker',
    room_by_runtime: { docker: 20, 'kubernetes-monolith': 10, 'kubernetes-microservices': 8 },
  } as never);
  mockEdgeStatus.mockResolvedValue({
    installed: false,
    running: false,
    attached: [],
    routes: [],
  } as never);
  mockServedDomain.mockReturnValue('');
  mockAcmeHosts.mockReturnValue([]);
  mockListBackups.mockResolvedValue([]);
  mockRunChecks.mockResolvedValue({ checks: [], counts: {}, verdict: 'ok', repros: {} });
  mockRouteHost.mockImplementation((value) => `${value}.example.test`);
  mockIsPassthrough.mockReturnValue(false);
  mockRouteReachable.mockResolvedValue(true);
  mockComposeStream.mockResolvedValue(0);
}
const CLUSTER_SUPPORT = 'arn:aws:eks:us-east-1:1:cluster/support';
const CLUSTER_PERF = 'arn:aws:eks:eu-west-1:1:cluster/perf';

function clusterContext(
  context: string,
  overrides: Partial<cluster.ContextRow> = {},
): cluster.ContextRow {
  const short = context.split('/').at(-1) ?? context;
  const region = context.startsWith('arn:aws:eks:') ? (context.split(':')[3] ?? '') : '';
  return {
    context,
    short,
    region,
    aliases: [],
    ours: false,
    provider: 'eks',
    billable: true,
    is_default: context === CLUSTER_SUPPORT,
    ...overrides,
  };
}

function fakeClusterStatus(context = ''): cluster.Ledger {
  if (context === CLUSTER_SUPPORT) {
    return {
      context,
      distribution: 'eks',
      provider: 'external',
      ours: false,
      reachable: true,
      unreadable: [],
      reach_status: 'ok',
      reach_why: '',
      reach_advice: '',
      manageable: true,
      unmanageable_why: '',
      gone: false,
      nodes: 2,
      age_hours: 148,
      instance_types: { 't3.large': 2 },
      workspaces: [
        {
          namespace: 'houston-t1',
          name: 't1',
          owner: 'alice',
          owner_readable: true,
          pvcs: 1,
        },
      ],
      pvcs: 1,
      loadbalancers: 1,
      operator: false,
      monitoring: false,
      cost: {
        usd_hr: 0.3523,
        unpriced: {},
        incomplete: [],
        basis: 'us-east-1 on-demand',
        estimate: true,
      },
    };
  }
  return {
    context,
    distribution: '',
    provider: '',
    ours: false,
    reachable: false,
    unreadable: ['cluster'],
    reach_status: 'denied',
    reach_why: 'it answered and refused these credentials',
    reach_advice: ' Ask whoever created it to run `aws eks create-access-entry`.',
    manageable: true,
    unmanageable_why: '',
    gone: false,
    nodes: null,
    age_hours: null,
    instance_types: null,
    workspaces: null,
    pvcs: null,
    loadbalancers: null,
    operator: null,
    monitoring: null,
    cost: null,
  };
}

function useClusterContexts(rows: cluster.ContextRow[], byDefault: string): void {
  mockKnownContexts.mockResolvedValue({
    contexts: rows,
    unreadable: '',
    default: byDefault,
  });
}

function useDefaultClusters(): void {
  useClusterContexts(
    [clusterContext(CLUSTER_SUPPORT), clusterContext(CLUSTER_PERF, { is_default: false })],
    CLUSTER_SUPPORT,
  );
  mockClusterStatus.mockImplementation(async (context) => fakeClusterStatus(context));
}

async function prepareClusterCase(name: string): Promise<void> {
  if (name === 'only an admin is offered the controls that spend or destroy') {
    portedUser = 'ronly';
    portedPassword = 'read-only-password';
    await users.add(portedUser, portedPassword, 'readonly');
  }
  useDefaultClusters();
  mockCapacity.mockResolvedValue({
    known: true,
    total_mb: 8192,
    available_mb: 6144,
    reserve_mb: 1024,
    swap_mb: 0,
    workspace_mb: 1100,
    room: 4,
    room_denominated_in: 'docker',
    room_by_runtime: {
      docker: 4,
      'kubernetes-monolith': 2,
      'kubernetes-microservices': 1,
    },
  });

  if (
    name === 'the create form says what a managed cluster commits you to' ||
    name === 'the local certificate option goes when the cluster is not on this machine'
  ) {
    useClusterContexts(
      [
        clusterContext(CLUSTER_SUPPORT),
        clusterContext('kind-houston-local', {
          short: 'kind-houston-local',
          region: '',
          ours: true,
          provider: '',
          billable: false,
          is_default: false,
        }),
      ],
      CLUSTER_SUPPORT,
    );
  }

  if (name === 'section two does not quote this laptops memory for a cluster in aws') {
    useClusterContexts(
      [
        clusterContext(CLUSTER_SUPPORT, { is_default: false }),
        clusterContext('kind-houston-local', {
          short: 'kind-houston-local',
          region: '',
          ours: true,
          provider: '',
          billable: false,
          is_default: false,
        }),
      ],
      '',
    );
  }

  if (
    name === 'a cluster aws says is gone does not read as one that is down' ||
    name === 'a gone cluster offers only controls that can work'
  ) {
    mockClusterStatus.mockImplementation(async (context) => {
      const status = fakeClusterStatus(context);
      if (context !== CLUSTER_PERF) return status;
      return {
        ...status,
        gone: true,
        reach_advice:
          'AWS says this cluster no longer exists, so it is not costing anything. ' +
          'The kubeconfig entry naming it is left over — ' +
          '`houston cluster forget perf` removes it.',
      };
    });
  }

  if (name === 'the cluster picker shows a name not sixty characters of arn') {
    const arn = 'arn:aws:eks:us-east-1:533674205877:cluster/chatrepo';
    useClusterContexts(
      [
        clusterContext(arn, {
          short: 'chatrepo',
          region: 'us-east-1',
          is_default: true,
        }),
        clusterContext('kind-houston-local', {
          short: 'kind-houston-local',
          region: '',
          ours: true,
          provider: '',
          billable: false,
          is_default: false,
        }),
      ],
      arn,
    );
  }
}

async function openClusterLedger(page: Page): Promise<void> {
  await page.locator('#btn-clusters').click();
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.cl-card')];
    return cards.length === 2 && cards.every((card) => !card.textContent.includes('reading…'));
  });
}

async function openClusterCreate(page: Page): Promise<void> {
  await page.locator('#btn-new').click();
  await page.locator('#create-dialog[open]').waitFor({ state: 'visible' });
}

async function selectKubernetes(page: Page): Promise<void> {
  await page.locator('#runtime-forks button', { hasText: 'Kubernetes' }).click();
  await page.locator('#context-row').waitFor({ state: 'visible' });
  await page.waitForTimeout(600);
}

async function exerciseClusterCase(name: string, page: Page): Promise<void> {
  if (name === 'the fake cluster status matches the real payload') {
    const required: readonly (keyof cluster.Ledger)[] = [
      'context',
      'distribution',
      'provider',
      'ours',
      'reachable',
      'unreadable',
      'reach_status',
      'reach_why',
      'reach_advice',
      'manageable',
      'unmanageable_why',
      'gone',
      'nodes',
      'age_hours',
      'instance_types',
      'workspaces',
      'pvcs',
      'loadbalancers',
      'operator',
      'monitoring',
      'cost',
    ];
    const fake: cluster.Ledger = fakeClusterStatus(CLUSTER_SUPPORT);
    expect(Object.keys(fake).sort()).toEqual([...required].sort());
    return;
  }

  if (name === 'the cluster chip wants you in amber and is never red') {
    await page.locator('#cluster-badge:not([hidden])').waitFor({ state: 'visible' });
    await openClusterLedger(page);
    await page.waitForFunction(() =>
      document.querySelector('#cluster-badge')?.classList.contains('warn'),
    );
    const classes = (await page.locator('#cluster-badge').getAttribute('class')) ?? '';
    expect(classes).toContain('warn');
    expect(classes).not.toContain('down');
    return;
  }

  if (
    name === 'the create form says what a managed cluster commits you to' ||
    name === 'section two does not quote this laptops memory for a cluster in aws' ||
    name === 'the local certificate option goes when the cluster is not on this machine' ||
    name === 'the cluster picker shows a name not sixty characters of arn'
  ) {
    await openClusterCreate(page);
  } else {
    await openClusterLedger(page);
  }

  if (name === 'the clusters view never shows a zero it did not read') {
    const cards = page.locator('.cl-card');
    expect(await cards.count()).toBe(2);
    const good = await cards.nth(0).innerText();
    const bad = await cards.nth(1).innerText();
    expect(good).toContain('2× t3.large');
    expect(good).toContain('$0.3523/hr');
    expect(bad).toContain('?');
    expect(bad).toContain('refusing');
    expect(bad).toContain('refused these credentials');
    expect(bad).toContain('create-access-entry');
    expect(bad.toLowerCase()).toContain('unknown, not zero');
    return;
  }

  if (name === 'only an admin is offered the controls that spend or destroy') {
    expect(await page.locator('#detail').innerText()).toContain('$0.3523/hr');
    expect(await page.locator('#detail').innerText()).not.toContain('Delete cluster');
    const pane = await page.locator('#actpane').innerText();
    expect(pane).not.toContain('Build a managed cluster');
    expect(pane).toContain('admin action');
    return;
  }

  if (name === 'the delete dialog will not arm until the name is typed') {
    expect(await page.locator('#actpane').innerText()).toContain('Build a managed cluster');
    expect(await page.locator('#detail').innerText()).toContain('Delete cluster');
    await page
      .locator('.cl-card')
      .nth(0)
      .getByRole('button', { name: /Delete cluster/u })
      .click();
    await page.locator('#cluster-delete-dialog[open]').waitFor({ state: 'visible' });
    const go = page.locator('#cluster-delete-go');
    expect(await go.isDisabled()).toBe(true);
    expect(await page.locator('#cluster-delete-holds').innerText()).toContain(
      'holding 1 workspace(s)',
    );
    const confirm = page.locator('#cluster-delete-form input[name=confirm]');
    await confirm.fill('wrong');
    expect(await go.isDisabled()).toBe(true);
    await confirm.fill('support');
    expect(await go.isDisabled()).toBe(false);
    return;
  }

  if (name === 'the cluster action pane survives the four second poll') {
    expect(await page.getByText('Build a managed cluster', { exact: true }).isVisible()).toBe(true);
    await page.waitForTimeout(5200);
    expect((await page.locator('.panes').getAttribute('class')) ?? '').not.toContain('no-detail');
    expect(await page.getByText('Build a managed cluster', { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText('Copy operator policy', { exact: true }).isVisible()).toBe(true);
    return;
  }

  if (name === 'the create form says what a managed cluster commits you to') {
    expect(await page.locator('#context-row').isHidden()).toBe(true);
    expect(await page.locator('#cluster-note').isHidden()).toBe(true);
    await selectKubernetes(page);
    expect(
      await page.locator('#context-row').evaluate((node) => {
        for (
          let current: Element | null = node;
          current !== null;
          current = current.parentElement
        ) {
          if (current.tagName === 'DETAILS') return false;
        }
        return true;
      }),
    ).toBe(true);
    expect(
      await page.locator('#runtime-forks').evaluate((node) => {
        const section = node.closest('section');
        return section?.querySelector('#context-row') !== null;
      }),
    ).toBe(true);
    const labels = await page.locator('#context-select option').allInnerTexts();
    expect(labels.some((label) => label.includes('costs money'))).toBe(true);
    expect(labels.some((label) => label.includes('costs money') && label.includes('kind'))).toBe(
      false,
    );
    const implicit = await page.locator('#cluster-note').innerText();
    expect(implicit).toContain('costs money');
    expect(implicit).toContain(CLUSTER_SUPPORT);
    expect(
      labels.some((label) => label.includes('Decide for me') && label.includes('support')),
    ).toBe(true);
    await page.locator('#context-select').selectOption(CLUSTER_SUPPORT);
    await page.waitForTimeout(400);
    expect(await page.locator('#cluster-note').innerText()).toContain('port-forward');
    expect(await page.locator('#create-https-block').isVisible()).toBe(true);
    expect(
      await page
        .locator('#create-https-block')
        .evaluate((node) => node.closest('details') === null),
    ).toBe(true);
    await page.locator('#cluster-note').getByRole('button', { name: 'Set a domain' }).click();
    expect(await page.locator('#https-mode').inputValue()).toBe('acme');
    expect(
      await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name),
    ).toBe('domain');
    await page.locator('#create-form [name=domain]').fill('t1.rc.example.com');
    await page.waitForTimeout(300);
    const named = await page.locator('#cluster-note').innerText();
    expect(named).not.toContain('port-forward');
    expect(named).toContain('costs money');
    await page.locator('#context-select').selectOption('kind-houston-local');
    await page.waitForTimeout(300);
    expect(await page.locator('#cluster-note').isHidden()).toBe(true);
    return;
  }

  if (name === 'section two does not quote this laptops memory for a cluster in aws') {
    await page.waitForFunction(() =>
      document.querySelector('#create-room')?.textContent.includes('free'),
    );
    expect(await page.locator('#create-room').innerText()).toContain('free');
    await selectKubernetes(page);
    await page.locator('#context-select').selectOption('kind-houston-local');
    await page.waitForTimeout(400);
    expect(await page.locator('#create-room').innerText()).toContain('free');
    await page.locator('#context-select').selectOption(CLUSTER_SUPPORT);
    await page.waitForTimeout(400);
    expect((await page.locator('#create-room').innerText()).trim()).toBe('');
    return;
  }

  if (name === 'the clusters view speaks english and explains its own numbers') {
    const body = await page.locator('#detail').innerText();
    expect(body).not.toContain('`');
    expect(await page.locator('.cl-card code').count()).toBeGreaterThan(0);
    expect(body).not.toContain('Copy context');
    expect(body).toContain('Copy name');
    expect(body).toContain('holding');
    expect(body).toContain("only this machine's");
    return;
  }

  if (name === 'a cluster aws says is gone does not read as one that is down') {
    const card = await page.locator('.cl-card').nth(1).innerText();
    expect(card.toLowerCase()).toContain('gone');
    expect(card).toContain('no longer exists');
    expect(card).not.toContain('not answering');
    expect(card.toLowerCase()).not.toContain('unknown, not zero');
    expect(card).toContain('nothing');
    return;
  }

  if (name === 'a gone cluster offers only controls that can work') {
    const cards = page.locator('.cl-card');
    const live = await cards.nth(0).locator('.cl-foot button').allInnerTexts();
    const dead = await cards.nth(1).locator('.cl-foot button').allInnerTexts();
    expect(live).toContain('Prepare');
    expect(live.some((label) => label.includes('Delete'))).toBe(true);
    expect(dead).not.toContain('Prepare');
    expect(dead.some((label) => label.includes('Delete'))).toBe(false);
    expect(dead.some((label) => label.includes('Forget'))).toBe(true);
    const forget = cards.nth(1).getByRole('button', { name: /Forget/u });
    expect((await forget.getAttribute('class')) ?? '').not.toContain('danger');
    return;
  }

  if (name === 'the local certificate option goes when the cluster is not on this machine') {
    const modes = async (): Promise<string[]> =>
      await page
        .locator('#https-mode option')
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(await modes()).toContain('local');
    await selectKubernetes(page);
    expect(await modes()).not.toContain('local');
    expect(await modes()).toContain('acme');
    await page.locator('#context-select').selectOption('kind-houston-local');
    await page.waitForTimeout(700);
    expect(await modes()).toContain('local');
    await page.locator('#https-mode').selectOption('local');
    await page.locator('#context-select').selectOption(CLUSTER_SUPPORT);
    await page.waitForTimeout(700);
    expect(await page.locator('#https-mode').inputValue()).not.toBe('local');
    return;
  }

  if (name === 'the cluster picker shows a name not sixty characters of arn') {
    const arn = 'arn:aws:eks:us-east-1:533674205877:cluster/chatrepo';
    await selectKubernetes(page);
    const options = await page.locator('#context-select option').evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.textContent,
        value: (node as HTMLOptionElement).value,
      })),
    );
    const managed = options.find((option) => option.value === arn);
    expect(managed).toBeDefined();
    expect(managed?.text).toContain('chatrepo');
    expect(managed?.text).toContain('us-east-1');
    expect(managed?.text).not.toContain(arn);
    expect(managed?.text).not.toContain('533674205877');
    expect(managed?.text.length).toBeLessThan(60);
    expect(managed?.text).toContain('costs money');
    expect(managed?.text).toContain('default');
    expect(managed?.value).toBe(arn);
    expect(options.some((option) => option.value === 'kind-houston-local')).toBe(true);
    const decide = options.find((option) => option.value === '');
    expect(decide?.text).toContain('chatrepo');
    expect(decide?.text).not.toContain(arn);
  }
}

async function waitForGui(page: Page): Promise<void> {
  await page.locator('.wrow').waitFor({ state: 'visible' });
  expect(await page.locator('#sb-count').textContent()).not.toBe('—');
}

const PASSWORD = 'browser-password-123';

async function signIn(page: Page, user = 'alice', password = PASSWORD): Promise<void> {
  await page.goto('/signin');
  await page.locator('#u').fill(user);
  await page.locator('#p').fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/'),
    page.locator('button').click(),
  ]);
}

async function exerciseFlow(name: string, page: Page, firstRunKey: string): Promise<void> {
  if (name === 'a signed out browser lands on the sign in page') {
    await page.goto('/');
    await page.waitForURL((url) => url.pathname === '/signin');
    expect(await page.locator('#u').isVisible()).toBe(true);
    expect(await page.locator('#p').isVisible()).toBe(true);
    expect(await page.title()).toContain('houston');
    return;
  }
  if (name === 'a wrong password shows an error in the page') {
    await page.goto('/signin');
    await page.locator('#u').fill('alice');
    await page.locator('#p').fill('not-the-password');
    await page.locator('button').click();
    await page.locator('.signin-banner.bad').waitFor({ state: 'visible' });
    expect(await page.locator('.signin-banner.bad').textContent()).toContain('not right');
    return;
  }
  if (name === 'first run creates the first admin in the browser') {
    await page.goto(`/setup#k=${firstRunKey}`);
    await page.locator('#u').fill('alice');
    await page.locator('#p').fill(PASSWORD);
    await page.locator('button[type=submit]').click();
    await page.locator('#whoami:not([hidden])').waitFor({ state: 'visible' });
    expect((await page.locator('#whoami').textContent())?.trim()).toBe('alice');
    expect(page.url()).not.toContain('#k=');
    expect(users.roleOf('alice')).toBe('admin');
    return;
  }
  if (name === 'the setup page says so when the key is missing') {
    await page.goto('/setup');
    await page.locator('#err:not([hidden])').waitFor({ state: 'visible' });
    expect(await page.locator('#err').textContent()).toContain('setup link');
    return;
  }

  await signIn(
    page,
    name.includes('readonly') ? 'ronly' : 'alice',
    name.includes('readonly') ? 'read-only-password' : PASSWORD,
  );
  await page.locator('#whoami:not([hidden])').waitFor({ state: 'visible' });

  if (name === 'signing in renders the dashboard') {
    expect((await page.locator('#whoami').textContent())?.trim()).toBe('alice');
    expect(await page.locator('#btn-new').isVisible()).toBe(true);
    return;
  }
  if (name === 'sign out ends the session and returns to the login') {
    await page.locator('#whoami').click();
    await page.locator('#me-menu:not([hidden])').waitFor({ state: 'visible' });
    await page.locator('#me-out').click();
    await page.waitForURL((url) => url.pathname === '/signin');
    await page.goto('/');
    await page.waitForURL((url) => url.pathname === '/signin');
    return;
  }
  if (name === 'a readonly user is not offered what it cannot do') {
    expect((await page.locator('#whoami').textContent())?.trim()).toBe('ronly · readonly');
    expect(await page.locator('#btn-new').isHidden()).toBe(true);
    expect(await page.locator('#btn-prune').isHidden()).toBe(true);
    return;
  }
  if (name === 'an admin can open people and a member cannot') {
    await page.locator('#whoami').click();
    await page.locator('#me-people:not([hidden])').waitFor({ state: 'visible' });
    await page.locator('#me-people').click();
    await page.locator('#people-dialog[open]').waitFor({ state: 'visible' });
    await page.locator('#people-body', { hasText: 'alice' }).waitFor({ state: 'visible' });
    expect(await page.locator('#people-body').textContent()).toContain('admin');
    await page.locator('#people-close').click();
    await page.locator('#whoami').click();
    await page.locator('#me-out').click();
    await page.waitForURL((url) => url.pathname === '/signin');
    await signIn(page, 'bob', 'bobs-good-password');
    await page.locator('#whoami:not([hidden])').waitFor({ state: 'visible' });
    await page.locator('#whoami').click();
    await page.locator('#me-menu:not([hidden])').waitFor({ state: 'visible' });
    expect(await page.locator('#me-people').isHidden()).toBe(true);
    return;
  }
  if (name === 'the activity page opens both of its tabs') {
    await page.locator('#btn-jobs').click();
    await page.locator('#act-tabs').waitFor({ state: 'visible' });
    await page.locator('#act-tab-history').click();
    await page.locator('#jobs-filter:not([hidden])').waitFor({ state: 'visible' });
    await page.locator('#jobs-list', { hasText: 'alice' }).waitFor({ state: 'visible' });
  }
}

async function prepareFlow(name: string): Promise<{ options: AppOptions; firstRunKey: string }> {
  if (
    name === 'first run creates the first admin in the browser' ||
    name === 'the setup page says so when the key is missing'
  ) {
    return { options: { accounts: true, firstRun: true }, firstRunKey: firstrun.mint() };
  }
  await users.add('alice', PASSWORD, 'admin');
  if (name === 'a readonly user is not offered what it cannot do') {
    await users.add('ronly', 'read-only-password', 'readonly');
  }
  if (name === 'an admin can open people and a member cannot') {
    await users.add('bob', 'bobs-good-password', 'member');
  }
  return { options: { accounts: true }, firstRunKey: '' };
}

function portedFile(file: string): boolean {
  return (
    file.startsWith('surfaces ') ||
    ['remote', 'plain http', 'clusters'].includes(file) ||
    file.startsWith('kubernetes')
  );
}

function publicOrigin(file: string, name: string): boolean {
  const remote = [
    'the panel says that localhost means the readers own machine',
    'a wide bound workspace is given the address that works from here',
    'the create dialog warns a remote reader about the default bind',
  ];
  const plain = [
    'signing in works over plain http on a real hostname',
    'a write from the spa survives plain http on a real hostname',
    'a link row shows the workspaces root url verbatim',
    'a placeholder url in a link row is left alone',
  ];
  return (
    (file === 'remote' && remote.includes(name)) || (file === 'plain http' && plain.includes(name))
  );
}

function useRows(rows: Record<string, unknown>[]): void {
  mockListRepros.mockResolvedValue(rows as never);
  mockDescribe.mockImplementation(
    async (name) => rows.find((row) => row.name === name) ?? (rows[0] as never),
  );
  mockDetail.mockImplementation(
    async (name) => rows.find((row) => row.name === name) ?? (rows[0] as never),
  );
  mockResolveName.mockImplementation(async (name) => name ?? '');
}

function kubeDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return detail({
    runtime: 'kubernetes',
    deployment: 'microservices',
    namespace: 'houston-t1234',
    containers: [],
    ...overrides,
  });
}

function prepareKubernetesCase(name: string): void {
  if (name === 'the header is the doctor button and the footer names both engines') {
    mockPreflight.mockResolvedValue({
      context: '',
      distribution: '',
      clusterReachable: false,
      nodeCount: 0,
      namespaces: [],
    } as never);
    mockToolsReady.mockReturnValue(false);
  }
  if (name === 'in progress shows only jobs that are') {
    portedJobs = {
      listJobs: () => [
        {
          id: 'j1',
          kind: 'create',
          label: 'a',
          actor: 'alice',
          status: 'running',
          started_at: 1,
          finished_at: null,
          error: '',
          error_kind: '',
        },
        {
          id: 'j2',
          kind: 'backup',
          label: 'b',
          actor: 'alice',
          status: 'queued',
          started_at: 1,
          finished_at: null,
          error: '',
          error_kind: '',
        },
        {
          id: 'j3',
          kind: 'create',
          label: 'c',
          actor: 'alice',
          status: 'done',
          started_at: 1,
          finished_at: 2,
          error: '',
          error_kind: '',
        },
        {
          id: 'j4',
          kind: 'seed',
          label: 'd',
          actor: 'alice',
          status: 'error',
          started_at: 1,
          finished_at: 2,
          error: 'x',
          error_kind: 'InternalError',
        },
      ],
      drain: async () => [],
      get: () => undefined,
    } as unknown as JobManager;
  }
  if (name === 'the seed job shows what it made and whether it was confirmed') {
    mockReadMeta.mockResolvedValue({
      name: 't1234',
      project: 'p',
      rcVersion: '7.4.1',
      rcImage: 'i',
      mongoTag: '7.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3001',
      hostPort: 3001,
      versionSource: 'x',
      pinned: false,
      createdAt: '',
      publicUrl: '',
      adminPassword: '',
      extra: {},
    });
    mockRunSeedInline.mockResolvedValue({
      users: 20,
      messages: 283,
      threads: 48,
      rooms_total: 22,
      dms: 5,
      rooms: { channel: 5, team: 1, discussion: 3, dm: 5 },
      verification: { ok: true, faults: [], extra: [], unreadable: [], checked: 22 },
    } as never);
  }
  if (name === 'the runtime card names no cluster because it cannot know which') {
    mockPreflight.mockResolvedValue({
      context: 'default',
      distribution: 'k3s',
      clusterReachable: true,
      nodeCount: 1,
      namespaces: [],
    } as never);
    mockKnownContexts.mockResolvedValue({
      contexts: [
        {
          context: 'arn:aws:eks:us-east-1:1:cluster/support',
          short: '',
          region: 'us-east-1',
          ours: false,
          provider: 'eks',
          billable: true,
          is_default: true,
          aliases: [],
        },
        {
          context: 'default',
          short: 'default',
          region: '',
          ours: false,
          provider: '',
          billable: false,
          is_default: false,
          aliases: [],
        },
      ],
      unreadable: '',
      default: 'arn:aws:eks:us-east-1:1:cluster/support',
    });
  }
  if (name === 'the panel leads with what is wrong and what to do')
    useRows([detail({ restarts: 4, health: 'unhealthy' })]);
  if (name === 'a down workspace is told what it still holds')
    useRows([detail({ state: 'down', health: '', uptime: '' })]);
  if (name === 'a pod that cannot start is named in the panel')
    useRows([
      kubeDetail({
        containers: [
          {
            service: 'rocketchat-0',
            state: 'pending',
            status: 'ImagePullBackOff',
            health: '',
            blocked: true,
            restarts: 0,
            started: '',
          },
          {
            service: 'mongodb-0',
            state: 'pending',
            status: 'ContainerCreating',
            health: '',
            blocked: false,
            restarts: 0,
            started: '',
          },
        ],
      }),
    ]);
  if (name === 'the narrow layout is a picker a panel and a bar')
    useRows(Array.from({ length: 6 }, (_, index) => detail({ name: `ws-${String(index)}` })));
  if (name === 'a sidecar that keeps restarting is a fault on kubernetes')
    useRows([
      kubeDetail({
        restarts: 0,
        containers: [
          {
            service: 'rocketchat-rocketchat-579c867b87-mwq4w',
            state: 'running',
            status: '1/1 ready',
            health: 'healthy',
            app: true,
            restarts: 0,
          },
          {
            service: 'rocketchat-ddp-streamer-768f896d7-rpcw9',
            state: 'running',
            status: '1/1 ready · 3 restarts',
            health: 'healthy',
            app: false,
            restarts: 3,
          },
          {
            service: 'rocketchat-presence-7ffb7dc6f7-m25vt',
            state: 'running',
            status: '1/1 ready · 1 restart',
            health: 'healthy',
            app: false,
            restarts: 1,
          },
        ],
      }),
    ]);
  if (name === 'a sidecar that is not ready and restarting is still a fault')
    useRows([
      kubeDetail({
        restarts: 0,
        containers: [
          {
            service: 'rocketchat-rocketchat-579c867b87-mwq4w',
            state: 'running',
            status: '1/1 ready',
            health: 'healthy',
            app: true,
            restarts: 0,
          },
          {
            service: 'rocketchat-ddp-streamer-768f896d7-rpcw9',
            state: 'running',
            status: 'CrashLoopBackOff · 7 restarts',
            health: '',
            app: false,
            restarts: 7,
          },
        ],
      }),
    ]);
  if (name === 'the env tab renders on kubernetes where it used to be blank')
    mockEnvCurrent.mockResolvedValue({
      name: 't1234',
      overrides: ['MY_FLAG'],
      env: [
        { key: 'ROOT_URL', value: 'http://localhost:3001', override: false },
        { key: 'MY_FLAG', value: '1', override: true },
        { key: 'MONGO_URL', value: '********', override: false },
      ],
    });
  if (name === 'the env tab still offers the controls on compose') {
    useRows([detail()]);
    mockRuntimeOf.mockResolvedValue(topology.DOCKER);
    mockEnvCurrent.mockResolvedValue({
      name: 't1234',
      overrides: [],
      env: [{ key: 'ROOT_URL', value: 'http://localhost:3001', override: false }],
    });
  }
  if (name === 'the env tab shows the refusal rather than an empty table') {
    useRows([kubeDetail({ state: 'stopped' })]);
    mockEnvCurrent.mockRejectedValue(
      new NotReadyError(
        "no Rocket.Chat pod in houston-t1234 to read the environment from — is 't1234' running?",
      ),
    );
  }
  if (name === 'the containers tab shows pods and says so on kubernetes')
    useRows([
      kubeDetail({
        containers: [
          {
            service: 'rocketchat-rocketchat-6d9-abc',
            state: 'running',
            status: '1/1 ready',
            health: 'healthy',
          },
          {
            service: 'rocketchat-mongodb-0',
            state: 'pending',
            status: 'ImagePullBackOff',
            health: '',
          },
        ],
      }),
    ]);
  if (name === 'the live chart stops asking when the answer is a refusal')
    mockPodMetrics.mockRejectedValue(
      new NotReadyError(
        'this cluster has no metrics-server, so there is nothing to read CPU and memory from. Install it with:\n  kubectl apply -f https://example/x.yaml',
      ),
    );
  if (name === 'a credential note is not labelled a sudo setup step')
    useRows([detail({ state: 'stopped', preset: 'ldap', notes: [...presets.load('ldap').notes] })]);
  if (name === 'the one preset with a real setup step keeps it')
    useRows([detail({ state: 'stopped', preset: 'oidc', notes: [...presets.load('oidc').notes] })]);
  if (name === 'a note that ends in a name is not glued to the next one')
    useRows([
      detail({
        state: 'stopped',
        notes: [
          'monolith on kind-houston-local — about 5 pods, namespace houston-x',
          'MongoDB 8.0 as a plain StatefulSet — mongo:8.0, NO authentication.',
          'reachable on this box at http://localhost:3000',
        ],
      }),
    ]);
  if (name === 'a genuinely wrapped note still joins the line after it')
    useRows([detail({ state: 'stopped', preset: 'oidc', notes: [...presets.load('oidc').notes] })]);
  if (name === 'a long line in a note scrolls instead of being clipped away')
    useRows([
      detail({
        state: 'stopped',
        notes: [
          'houston keeps its own kubeconfig; a bare kubectl will not see this:',
          '    export KUBECONFIG=/tmp/runner-of-someone/a-very-long-isolated-home-0/clients/kubernetes/config',
        ],
      }),
    ]);
  if (name === 'a grouped note gets its own card with a fact table and a copy button')
    useRows([
      kubeDetail({
        notes: ['Kubernetes:', '    Cluster  x'],
        note_groups: [
          {
            title: 'Kubernetes',
            rows: [
              ['Cluster', 'kind-houston-local'],
              ['Namespace', 'houston-t1234'],
              ['Arrangement', 'microservices'],
            ],
            body: [],
            commands: [],
          },
          {
            title: 'Port forward',
            rows: [],
            body: ['The port-forward dies with the pod. Start it again:'],
            commands: ['kubectl -n houston-t1234 port-forward deployment/rc 3001:3000'],
          },
        ],
      }),
    ]);
  if (name === 'the panel is not a two hundred pixel window on a narrow screen')
    useRows([
      kubeDetail({
        note_groups: Array.from({ length: 8 }, (_, index) => ({
          title: `Group ${String(index)}`,
          kind: '',
          rows: [],
          body: [`Something worth reading, number ${String(index)}.`],
          commands: [],
        })),
      }),
    ]);
  if (name === 'a place a group names is the link row and not a second row')
    useRows([
      kubeDetail({
        notes: [],
        links: [
          { label: 'Rocket.Chat', url: 'http://localhost:3001', kind: 'rc' },
          { label: 'Grafana', url: 'http://localhost:5050', kind: 'monitor' },
        ],
        note_groups: [
          {
            title: 'Monitoring',
            rows: [],
            body: [
              'Grafana:    http://localhost:5050  (admin/admin; anonymous view enabled)',
              'Dashboards auto-provisioned: Rocket.Chat Metrics, MongoDB.',
            ],
            commands: [],
          },
        ],
      }),
    ]);
  if (name === 'the rail groups by what each workspace wants from you')
    useRows([
      detail({ name: 'aa-loop', state: 'restarting', restarts: 4 }),
      detail({ name: 'bb-sick', health: 'unhealthy' }),
      detail({ name: 'cc-fine' }),
      detail({ name: 'dd-stopped', state: 'stopped', uptime: '', health: '' }),
      detail({ name: 'ee-down', state: 'down', uptime: '', health: '' }),
    ]);
  if (name === 'one state gets no group headings')
    useRows(Array.from({ length: 3 }, (_, index) => detail({ name: `ws-${String(index)}` })));
  if (name === 'a long workspace name does not push the rail sideways')
    useRows([
      detail({ name: 'a-really-long-workspace-name-for-ticket-4821', preset: 'ldap' }),
      detail({ name: 'dana-upgrade', uptime: '4 minutes', monitoring: true }),
    ]);
  if (name === 'a seeded workspace is not told to seed itself')
    useRows([detail({ seed: { profile: 'standard', at: '2026-08-19T09:00:00+00:00', ok: true } })]);
  if (name === 'nothing is suggested for a workspace that is not running')
    useRows([detail({ state: 'down', uptime: '', health: '' })]);
  if (name === 'a note paragraph is as wide as the card it is in')
    useRows([
      kubeDetail({
        note_groups: [
          {
            title: '1 · Point kubectl and helm at this cluster',
            rows: [],
            body: [
              'houston keeps its own kubeconfig so creating a cluster cannot move the context you were using. A bare `kubectl` will not see this workspace until it is pointed here, and every command below assumes it:',
            ],
            commands: ['export KUBECONFIG=/home/you/.houston/clients/kubernetes/config'],
          },
        ],
      }),
    ]);
}

function setSurfaceDetail(row: Record<string, unknown>): void {
  mockListRepros.mockResolvedValue([row] as never);
  mockDescribe.mockResolvedValue(row as never);
  mockDetail.mockResolvedValue(row as never);
}

async function prepareSurface(name: string): Promise<void> {
  if (name === 'a readonly user is offered nothing in the detail panel either') {
    portedUser = 'ronly';
    portedPassword = 'read-only-password';
    await users.add(portedUser, portedPassword, 'readonly');
  }
  if (name === 'a member is not offered the delete at all') {
    portedUser = 'bob';
    portedPassword = 'bobs-good-password';
    await users.add(portedUser, portedPassword, 'member');
  }
  if (name === 'the create dialog follows the box policy not the role') {
    portedUser = 'mem';
    portedPassword = 'members-good-password';
    await users.add(portedUser, portedPassword, 'member');
  }
  if (name === 'the home page leads with capacity') {
    mockCapacity.mockResolvedValue({
      known: true,
      total_mb: 10_240,
      available_mb: 4_096,
      reserve_mb: 2_048,
      swap_mb: 0,
      workspace_mb: 1_100,
      room: 1,
      room_denominated_in: 'docker',
      room_by_runtime: {
        docker: 1,
        'kubernetes-monolith': 0,
        'kubernetes-microservices': 0,
      },
    });
  }
  if (name === 'a down workspace is something home asks you about') {
    setSurfaceDetail(detail({ name: 'upgrade-test', state: 'down' }));
    mockResolveName.mockResolvedValue('upgrade-test');
  }
  if (name === 'a note that names a place joins the row that already lists it') {
    setSurfaceDetail(
      detail({
        links: [
          { label: 'Rocket.Chat', url: 'http://localhost:3001', kind: 'rc' },
          { label: 'Grafana', url: 'http://localhost:5050', kind: 'monitor' },
          { label: 'Prometheus', url: 'http://localhost:9090', kind: 'monitor' },
        ],
        notes: [
          'Grafana:    http://localhost:5050  (admin/admin; anonymous view enabled)',
          'Prometheus: http://localhost:9090  (Status -> Targets: rocketchat, mongodb)',
          'Dashboards auto-provisioned: Rocket.Chat Metrics, MongoDB, Node Exporter Full.',
        ],
      }),
    );
  }
  if (name === 'the log viewer streams container output') {
    mockComposeStream.mockImplementation(async (_target, _args, onLine, options) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      for (let index = 0; index < 5; index += 1) {
        onLine?.(`houston-t1234-rocketchat-1  | {"level":30,"msg":"line ${String(index)}"}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      const signal = options?.abortSignal;
      if (signal !== undefined && !signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
      return 0;
    });
  }
  if (name === 'the backups tab lists what is there') {
    mockListBackups.mockResolvedValue([
      {
        path: '/tmp/t1234-2026-08-09.tar.zst',
        bytes: 1_234_567,
        rc_version: '7.4.1',
        mongo_tag: '7.0',
        preset: 'base',
        label: '',
        created_at: '2026-08-09T10:00:00+00:00',
      },
    ]);
  }
  if (name === 'the doctor dialog renders its checks') {
    mockRunChecks.mockResolvedValue({
      checks: [
        { status: 'ok', message: 'Docker daemon running (27.0.3)' },
        { status: 'ok', message: 'Edge running — holds :80/:443', elsewhere: 'edge chip' },
        { status: 'warn', message: '1 edge route(s) with no workspace' },
        { status: 'fail', message: '2 GB free - a workspace needs about 6' },
      ],
      counts: {},
      verdict: 'fail',
      repros: { total: 1, running: 1 },
    } as never);
  }
  if (name === 'the edge badge surfaces an unreachable route') {
    mockEdgeStatus.mockResolvedValue({
      installed: true,
      running: true,
      routes: ['t1234', 't9999'],
      attached: ['houston-t1234_default'],
    });
    mockServedDomain.mockReturnValue('support.example.com');
    mockRouteReachable.mockImplementation(async (value) => value === 't1234');
  }
  if (
    name === 'an admin can delete a certificate nothing points at' ||
    name === 'a member is not offered the delete at all'
  ) {
    surfaceAcmeHosts = ['old-ticket-991.kestron.org'];
    mockAcmeHosts.mockImplementation(() => [...surfaceAcmeHosts]);
    mockEdgeStatus.mockResolvedValue({ installed: true, running: true, routes: [], attached: [] });
    mockServedDomain.mockReturnValue('');
    mockDeleteHost.mockImplementation(async (host) => {
      surfaceAcmeHosts = surfaceAcmeHosts.filter((value) => value !== host);
      return {
        host,
        routes: [],
        passthrough: [],
        certificate: false,
        declaration: false,
        acme: ['acme.json'],
        restarted: null,
        foreign: '',
        kept: [],
      };
    });
  }
  if (name === 'reduced motion keeps every state and removes the travel') {
    portedReducedMotion = true;
  }
}

async function preparePortedCase(file: string, name: string): Promise<AppOptions> {
  await users.add('alice', PASSWORD, 'admin');
  if (file.startsWith('surfaces ')) await prepareSurface(name);
  if (file === 'clusters') await prepareClusterCase(name);
  if (name === 'people rows have their own shape not activitys')
    await users.add('bob', PASSWORD, 'member');
  if (name === 'the panel says that localhost means the readers own machine')
    useRows([detail({ bind_host: '127.0.0.1' })]);
  if (name === 'a wide bound workspace is given the address that works from here')
    useRows([detail({ bind_host: '0.0.0.0' })]);
  if (name === 'a link row shows the workspaces root url verbatim') {
    useRows([
      detail({ links: [{ label: 'Rocket.Chat', url: 'http://localhost:3001', kind: '' }] }),
    ]);
  }
  if (name === 'a placeholder url in a link row is left alone') {
    useRows([detail({ links: [{ label: 'Livechat', url: '<repro-url>/livechat', kind: '' }] })]);
  }
  if (name === 'the workspace row says kubernetes and stays quiet about docker') {
    useRows([detail({ name: 'kube-one', runtime: 'kubernetes' }), detail({ name: 'compose-one' })]);
  }
  if (name === 'creating a kubernetes workspace sends the axes')
    mockCreateRepro.mockResolvedValue({} as never);
  prepareKubernetesCase(name);
  return {
    accounts: true,
    ...(publicOrigin(file, name) ? { allowHosts: [PUBLIC_NAME] } : {}),
    ...(portedJobs === undefined ? {} : { jobs: portedJobs }),
  };
}

async function browserImport<T>(
  page: Page,
  module: string,
  member: string,
  ...args: unknown[]
): Promise<T> {
  return (await page.evaluate(
    async ({ specifier, exported, values }) => {
      const load = new Function('name', 'return import(name)') as (
        name: string,
      ) => Promise<Record<string, (...items: unknown[]) => unknown>>;
      const loaded = await load(specifier);
      return loaded[exported]?.(...values);
    },
    { specifier: module, exported: member, values: args },
  )) as T;
}

async function openWorkspace(page: Page, name = 't1234'): Promise<void> {
  await page
    .locator('.wrow', { has: page.locator('.nm', { hasText: name }) })
    .first()
    .click();
  await page.locator('#d-body').waitFor({ state: 'visible' });
}

async function scenarioParts(page: Page, scenario: string, klass: string): Promise<string[]> {
  const card = page.locator('.hcard').filter({ has: page.locator('b', { hasText: scenario }) });
  return await card
    .locator(`.${klass}`)
    .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
}

async function exerciseChrome(name: string, page: Page): Promise<void> {
  if (name === 'the theme is light by default and the choice survives a reload') {
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
    const toggle = page.locator('#theme-toggle');
    await toggle.click();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
    await page.reload();
    await page.locator('#repros').waitFor({ state: 'visible' });
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
    expect((await toggle.innerText()).trim()).toBe('');
    expect(await toggle.locator('svg').count()).toBe(1);
    expect(await toggle.getAttribute('aria-label')).toBe('Switch to the light theme');
    expect(await toggle.locator('circle').count()).toBe(1);
    await toggle.click();
    expect(await toggle.getAttribute('aria-label')).toBe('Switch to the dark theme');
    expect(await toggle.locator('circle').count()).toBe(0);
    expect(
      await toggle.evaluate((node) => {
        const svg = node.querySelector('svg');
        return svg !== null && getComputedStyle(svg).stroke === getComputedStyle(node).color;
      }),
    ).toBe(true);
    return;
  }
  if (name === 'people rows have their own shape not activitys') {
    await page.locator('#whoami').click();
    await page.locator('#me-people').click();
    await page.locator('#people-dialog[open]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('.prow').length >= 2);
    expect(await page.locator('#people-dialog .jobrow, #people-dialog .jstatus').count()).toBe(0);
    const row = page.locator('.prow', { hasText: 'bob' }).first();
    expect(await row.locator('select').inputValue()).toBe('member');
    expect(await row.getByRole('button', { name: /reset/u }).count()).toBe(1);
    expect(await row.getByRole('button', { name: /remove/u }).count()).toBe(1);
    const counts = await page
      .locator('.prow')
      .evaluateAll((rows) => rows.map((row) => row.children.length));
    expect(new Set(counts).size).toBe(1);
    return;
  }
  if (name === 'a background poll does not navigate the page for you') {
    for (const [opener, marker] of [
      ['#btn-jobs', '#act-tabs'],
      ['#btn-scenarios', '.hcard.scen'],
    ] as const) {
      await page.locator(opener).click();
      await page.locator(marker).first().waitFor({ state: 'visible' });
      await browserImport(page, '/js/state.js', 'refreshHome', true);
      await page.waitForTimeout(400);
      expect(await page.locator(marker).count()).toBeGreaterThan(0);
      expect(await page.locator('.home-head h1').textContent()).not.toContain('Good ');
    }
    return;
  }
  if (name === 'activity and a workspace are different views of the stage') {
    await openWorkspace(page);
    expect(await page.locator('#actpane .apdanger').isVisible()).toBe(true);
    await page.locator('#btn-jobs').click();
    await page.locator('#act-tabs').waitFor({ state: 'visible' });
    expect(await page.locator('#actpane .apdanger').count()).toBe(0);
    expect(await page.locator('.wrow[aria-current=true]').count()).toBe(1);
    await page.locator('.wrow').click();
    await page.locator('#d-body').waitFor({ state: 'visible' });
    expect(await page.locator('#act-tabs').count()).toBe(0);
    return;
  }
  if (name === 'the scenarios page shows the setup step a preset needs') {
    await page.locator('#btn-scenarios').click();
    await page.waitForFunction(() =>
      document.querySelector('#detail')?.textContent.includes('oidc'),
    );
    const body = (await page.locator('#detail').textContent()) ?? '';
    expect(body).toContain('127.0.0.1  keycloak');
    expect(body).toContain('/etc/hosts');
    expect(body).toContain('8085');
    const command = page.locator('.note-cmd code', { hasText: '127.0.0.1' });
    expect(await command.count()).toBe(1);
    expect(await command.first().innerText()).toBe('127.0.0.1  keycloak');
    expect(await command.first().evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('pre');
    expect(await page.locator('.note-cmd .cp').first().isVisible()).toBe(true);
    const row = page
      .locator('.linkrow')
      .filter({ has: page.locator('.l-u', { hasText: 'http://keycloak:8085' }) });
    expect(await row.count()).toBe(1);
    expect(await row.locator('.l-n').innerText()).toContain('Keycloak admin console');
    expect(await row.locator('.l-c').innerText()).toBe('admin/admin');
    expect(await row.locator('.l-sub').innerText()).toContain('houston');
    expect(await row.first().getAttribute('href')).toBe('http://keycloak:8085');
    return;
  }
  if (name === 'every page is reachable and says which one you are on') {
    expect(await page.locator('#btn-home').getAttribute('aria-current')).not.toBeNull();
    await page.locator('#btn-jobs').click();
    await page.locator('#act-tabs').waitFor({ state: 'visible' });
    expect(await page.locator('#btn-jobs').getAttribute('aria-current')).not.toBeNull();
    expect(await page.locator('#btn-home').getAttribute('aria-current')).toBeNull();
    await page.locator('#btn-home').click();
    await page.waitForFunction(() =>
      document.querySelector('#detail')?.textContent.includes('workspace(s)'),
    );
    await page.locator('#btn-scenarios').click();
    await page.waitForFunction(() =>
      document.querySelector('#detail')?.textContent.includes('Scenarios'),
    );
    await page.locator('.brand').click();
    await page.waitForFunction(() =>
      document.querySelector('#detail')?.textContent.includes('workspace(s)'),
    );
    return;
  }
  if (name === 'the dashboard poll does not close the page you are reading') {
    await page.locator('#btn-scenarios').click();
    await page.waitForFunction(() =>
      document.querySelector('#detail')?.textContent.includes('Scenarios'),
    );
    await page.waitForTimeout(5000);
    expect(await page.locator('#detail').textContent()).toContain('Scenarios');
    return;
  }
  await page.locator('#btn-scenarios').click();
  await page.waitForFunction(() =>
    document.querySelector('#detail')?.textContent.includes('livechat'),
  );
  expect(await scenarioParts(page, 'livechat', 'l-u')).toEqual([
    'http://localhost:8090',
    '<repro-url>/livechat',
  ]);
  expect(await scenarioParts(page, 'livechat', 'l-w')).toEqual([
    'widget embedded, cross-origin',
    'same-origin',
  ]);
  const live = await scenarioParts(page, 'livechat', 'note-p');
  expect(live).toHaveLength(2);
  expect(live[0]).toMatch(/^admin is an available/u);
  const oidc = await scenarioParts(page, 'oidc', 'note-p');
  expect(oidc[0]).toMatch(/^OIDC needs one host entry/u);
  expect(oidc[0]).toContain('same URL');
}

async function exerciseRemote(name: string, page: Page): Promise<void> {
  if (name.includes('panel says')) {
    await openWorkspace(page);
    const warning = page.locator('#d-body .banner.warn');
    await warning.waitFor({ state: 'visible' });
    const said = (await warning.textContent()) ?? '';
    expect(said).toContain(PUBLIC_NAME);
    expect(said).toContain('0.0.0.0');
    expect(said).toContain('admin/admin123');
    expect(await page.locator('#d-body .urlbox').first().textContent()).toContain(
      'http://localhost:3001',
    );
    return;
  }
  if (name.includes('wide bound')) {
    await openWorkspace(page);
    await page.waitForFunction(() =>
      document.querySelector('#d-body')?.textContent.includes('From this machine'),
    );
    expect(await page.locator('#d-body').textContent()).toContain(`http://${PUBLIC_NAME}:3001`);
    expect(await page.locator('#d-body .banner.warn').count()).toBe(0);
    return;
  }
  if (name.includes('local browser')) {
    await openWorkspace(page);
    await page.locator('#d-body .urlbox').first().waitFor({ state: 'visible' });
    expect(await page.locator('#d-body .banner.warn').count()).toBe(0);
    expect(await page.locator('#d-body').textContent()).not.toContain('From this machine');
    expect(await browserImport(page, '/js/util.js', 'remoteHost')).toBe('');
    return;
  }
  await page.locator('#btn-new').click();
  await page.locator('#create-dialog[open]').waitFor({ state: 'visible' });
  if (name.includes('warns a remote')) {
    const hint = page.locator('#create-bind-hint:not([hidden])');
    await hint.waitFor({ state: 'visible' });
    const said = (await hint.textContent()) ?? '';
    expect(said).toContain('0.0.0.0');
    expect(said).toContain('hostname');
    expect(said).toContain('admin/admin123');
    expect(said.length).toBeLessThan(170);
  } else expect(await page.locator('#create-bind-hint').isHidden()).toBe(true);
}

async function exerciseRuntimeDialog(page: Page): Promise<void> {
  await page.locator('#btn-new').click();
  await page.locator('#create-dialog[open]').waitFor({ state: 'visible' });
  const docker = page.locator('#runtime-forks button', { hasText: 'Docker Compose' });
  const kube = page.locator('#runtime-forks button', { hasText: 'Kubernetes' });
  const arrangements = async () => await page.locator('#deployment-seg button').allInnerTexts();
  const selected = async () =>
    (await page.locator("#deployment-seg button[aria-pressed='true']").innerText()).trim();
  expect(await page.locator('#runtime-value').inputValue()).toBe('docker');
  expect(await docker.getAttribute('aria-pressed')).toBe('true');
  expect((await arrangements()).some((v) => v.includes('monolith'))).toBe(true);
  expect((await arrangements()).some((v) => v.includes('multi-instance'))).toBe(true);
  expect((await arrangements()).some((v) => v.includes('microservices'))).toBe(false);
  expect(await page.locator('#mongo-operator').count()).toBe(0);
  expect(await docker.innerText()).toContain('containers');
  expect(await kube.innerText()).toContain('pods');
  await kube.click();
  expect(await selected()).toBe('microservices');
  expect((await arrangements()).some((v) => v.includes('multi-instance'))).toBe(false);
  expect(await page.locator('#mongo-operator').count()).toBe(1);
  expect(await page.locator('#create-https-block').getAttribute('hidden')).toBeNull();
  const modes = async () =>
    await page
      .locator('#https-mode option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
  expect(await modes()).toEqual(expect.arrayContaining(['local', 'acme']));
  const modesFor = async (unsupported: Array<{ field: string }>) =>
    await page.evaluate(
      async ({ source, value }) => {
        const load = new Function('name', 'return import(name)') as (
          name: string,
        ) => Promise<Record<string, (...args: unknown[]) => unknown>>;
        const loaded = await load(source);
        const sync = loaded.syncAdvancedForRuntime;
        if (sync === undefined) throw new Error('syncAdvancedForRuntime is not exported');
        sync({ unsupported: value });
        return [...document.querySelectorAll('#https-mode option')].map(
          (node) => (node as HTMLOptionElement).value,
        );
      },
      { source: '/js/clusters.js', value: unsupported },
    );
  expect(await modesFor([{ field: 'domain' }])).not.toContain('acme');
  expect(await modes()).toContain('local');
  expect(await modesFor([])).toContain('acme');
  await modesFor([{ field: 'https' }]);
  expect(await page.locator('#create-https-block').getAttribute('hidden')).not.toBeNull();
  await modesFor([{ field: 'fresh' }]);
  expect(await page.locator('#create-https-block').getAttribute('hidden')).toBeNull();
  const existing = async () =>
    await page
      .locator('select[name=existing] option')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent));
  expect((await existing()).some((v) => v.includes('DELETE'))).toBe(false);
  expect((await existing()).some((v) => v.includes('Reuse'))).toBe(true);
  await page.locator('#deployment-seg button', { hasText: 'monolith' }).click();
  expect(await selected()).toBe('monolith');
  expect(await page.locator('#replicas-row').isHidden()).toBe(true);
  await page.locator('#deployment-seg button', { hasText: 'microservices' }).click();
  await docker.click();
  expect(await page.locator('#mongo-operator').count()).toBe(0);
  expect((await existing()).some((v) => v.includes('DELETE'))).toBe(true);
}

async function exercisePlain(name: string, page: Page): Promise<void> {
  if (name === 'signing in works over plain http on a real hostname') {
    expect(await page.content()).not.toContain('cross-site request refused');
    expect((await page.locator('#whoami').textContent())?.trim()).toBe('alice');
    return;
  }
  if (name === 'a write from the spa survives plain http on a real hostname') {
    const result = await page.evaluate(async () => {
      const response = await fetch('/api/repros/does-not-exist', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      return { status: response.status, text: await response.text() };
    });
    expect(result.status).not.toBe(403);
    expect(result.text).not.toContain('cross-site');
    return;
  }
  if (name.includes('link row')) {
    await openWorkspace(page);
    const row = page.locator('.linkrow').first();
    await row.waitFor({ state: 'visible' });
    const shown = (await row.locator('.l-u').innerText()).trim();
    if (name.startsWith('a placeholder')) expect(shown).toBe('<repro-url>/livechat');
    else {
      const href = await row.getAttribute('href');
      expect(shown).toBe('http://localhost:3001');
      expect(href).toBe(shown);
      expect(shown).not.toContain(PUBLIC_NAME);
    }
    return;
  }
  if (name.includes('workspace row')) {
    await page.waitForFunction(() =>
      document.querySelector('#repros')?.textContent.includes('kube-one'),
    );
    const kube = await page.locator('.wrow', { hasText: 'kube-one' }).locator('.meta').innerText();
    const compose = await page
      .locator('.wrow', { hasText: 'compose-one' })
      .locator('.meta')
      .innerText();
    expect(kube).toContain('k8s');
    expect(compose).not.toContain('docker');
    expect(compose).not.toContain('k8s');
    return;
  }
  if (name.includes('offers a runtime')) {
    await exerciseRuntimeDialog(page);
    return;
  }
  await page.locator('#btn-new').click();
  await page.locator('#create-dialog[open]').waitFor({ state: 'visible' });
  await page.locator('input[name=version]').fill('8.5.1');
  await page.locator('#runtime-forks button', { hasText: 'Kubernetes' }).click();
  await page.locator('#deployment-seg button', { hasText: 'microservices' }).click();
  await page.locator('input[name=mongo_operator]').check();
  await page.locator('input[name=offline]').evaluate((node) => {
    (node as HTMLInputElement).checked = true;
  });
  await page.locator('#create-submit').click();
  for (let n = 0; n < 40 && mockCreateRepro.mock.calls.length === 0; n += 1)
    await page.waitForTimeout(100);
  expect(mockCreateRepro).toHaveBeenCalledTimes(1);
  const request = mockCreateRepro.mock.calls[0]?.[0];
  expect(request?.runtime).toBe('kubernetes');
  expect(request?.deployment).toBe('microservices');
  expect(request?.mongoOperator).toBe(true);
}

async function paneState(
  page: Page,
): Promise<{ next: string[][]; rest: Array<[string, boolean]>; groups: string[]; note: string }> {
  return await page.evaluate(() => ({
    next: [...document.querySelectorAll('#actpane .apn')].map((button) => [
      button.querySelector('b')?.textContent ?? '',
      button.textContent,
    ]),
    rest: [...document.querySelectorAll<HTMLButtonElement>('#actpane .aplist button')].map(
      (button) => [button.textContent, button.disabled],
    ),
    groups: [...document.querySelectorAll('#actpane .apgroup')].map((group) => group.textContent),
    note: document.querySelector('#actpane .apnote')?.textContent ?? '',
  }));
}

async function exerciseKubernetesChrome(name: string, page: Page): Promise<void> {
  if (name === 'the top links become one menu on a narrow screen') {
    await page.setViewportSize({ width: 430, height: 780 });
    await page.waitForTimeout(200);
    expect(await page.locator('#nav-toggle').isVisible()).toBe(true);
    expect(await page.locator('#btn-jobs').isVisible()).toBe(false);
    expect(await page.locator('#btn-jobs').count()).toBe(1);
    await page.locator('#nav-toggle').click();
    await page.locator('#btn-jobs').waitFor({ state: 'visible' });
    expect(await page.locator('#nav-toggle').getAttribute('aria-expanded')).toBe('true');
    await page.locator('#btn-jobs').click();
    await page.waitForFunction(() =>
      document.querySelector('#btn-jobs')?.hasAttribute('aria-current'),
    );
    expect(await page.locator('#btn-jobs').isVisible()).toBe(false);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(200);
    expect(await page.locator('#btn-jobs').isVisible()).toBe(true);
    expect(await page.locator('#nav-toggle').isVisible()).toBe(false);
    return;
  }
  if (name === 'the header is the doctor button and the footer names both engines') {
    await page.locator('#doctor-badge').waitFor({ state: 'visible' });
    expect((await page.locator('#doctor-badge').textContent())?.trim()).toBe('doctor');
    await page.waitForFunction(
      () => !document.querySelector('#sb-engines')?.textContent.includes('k8s: ?'),
    );
    const footer = (await page.locator('#sb-engines').textContent()) ?? '';
    expect(footer.startsWith('docker: ')).toBe(true);
    expect(footer).toContain('k8s: not set up');
    await page.locator('#doctor-badge').click();
    await page.locator('#doctor-dialog[open]').waitFor({ state: 'visible' });
    return;
  }
  if (name === 'the doctor chip goes red only when nothing can run a workspace') {
    const classes = await page.evaluate(
      async ({ mainSource, sharedSource, utilSource }) => {
        const load = new Function('name', 'return import(name)') as (
          name: string,
        ) => Promise<Record<string, unknown>>;
        await load(mainSource);
        const ctx = (await load(sharedSource)).ctx as { DOCKER_OK: boolean; KUBE: unknown };
        const paintEngines = (await load(utilSource)).paintEngines as () => void;
        const badge = document.querySelector('#doctor-badge') as HTMLElement;
        const out: Record<string, string> = {};
        ctx.DOCKER_OK = false;
        ctx.KUBE = { usable: true, reachable: true, distribution: 'k3s', context: 'default' };
        paintEngines();
        out.dockerDownKubeUp = badge.className;
        out.footer = document.querySelector('#sb-engines')?.textContent ?? '';
        ctx.DOCKER_OK = false;
        ctx.KUBE = { usable: false, reachable: false };
        paintEngines();
        out.bothDown = badge.className;
        ctx.DOCKER_OK = true;
        ctx.KUBE = null;
        paintEngines();
        out.dockerOnly = badge.className;
        return out;
      },
      { mainSource: '/js/main.js', sharedSource: '/js/shared.js', utilSource: '/js/util.js' },
    );
    expect(classes.dockerDownKubeUp).toContain('up');
    expect(classes.footer).toContain('k3s default');
    expect(classes.bothDown).toContain('down');
    expect(classes.dockerOnly).toContain('up');
    return;
  }
  await page.locator('#btn-jobs').click();
  await page.locator('#jobs-list').waitFor({ state: 'visible' });
  await page.waitForTimeout(400);
  const shown = await page.locator('#jobs-list .jstatus').allTextContents();
  expect(shown.sort()).toEqual(['queued', 'running']);
}

async function exerciseKubernetesDialogs(name: string, page: Page): Promise<void> {
  if (name === 'the seed job shows what it made and whether it was confirmed') {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Add sample data' }).click();
    await page.locator('#seed-dialog[open]').waitFor({ state: 'visible' });
    await page.locator('#seed-submit').click();
    await page.locator('#job-log').waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForFunction(
      () => document.querySelector('#job-log')?.textContent.includes('match the plan'),
      undefined,
      { timeout: 20_000 },
    );
    const body = (await page.locator('#job-log').textContent()) ?? '';
    expect(body).toContain('283 messages');
    expect(body).toContain('48 in threads');
    expect(body).toContain('channel 5');
    expect(body).toContain('discussion 3');
    return;
  }
  await page.locator('#btn-new').click();
  await page.locator('#create-dialog[open]').waitFor({ state: 'visible' });
  if (name === 'the create dialog says what it builds and what the box has left') {
    await page.waitForFunction(
      () => document.querySelector('#create-room')?.textContent.includes('free'),
      undefined,
      { timeout: 15_000 },
    );
    expect(await page.locator('#create-room').innerText()).toContain('room for about');
    const compose = await page.locator('#runtime-forks button').first().innerText();
    const kube = await page.locator('#runtime-forks button').nth(1).innerText();
    expect(compose).toContain('2 containers');
    expect(kube).toContain('9 pods');
    expect(`${compose}${kube}`).not.toMatch(/GB|MB/u);
    return;
  }
  if (name === 'the runtime card names no cluster because it cannot know which') {
    await page.waitForFunction(
      () => document.querySelector('#sb-engines')?.textContent.includes('k3s'),
      undefined,
      { timeout: 15_000 },
    );
    const kube = await page.locator('#runtime-forks button').nth(1).innerText();
    expect(kube).not.toContain('kind');
    expect(kube).not.toContain('k3s');
    expect(kube).toContain('Kubernetes');
    await page.locator('#runtime-forks button', { hasText: 'Kubernetes' }).click();
    await page.waitForTimeout(600);
    expect(
      (await page.locator('#context-select option').allTextContents()).some((v) =>
        v.includes('cluster/support'),
      ),
    ).toBe(true);
    return;
  }
  expect(await page.locator('#runtime-hint').innerText()).toContain('One Rocket.Chat process');
  await page.locator('#runtime-forks button', { hasText: 'Kubernetes' }).click();
  const note = await page.locator('#runtime-hint').innerText();
  expect(note).toContain('ddp-streamer');
  expect(note).not.toContain('HTTPS');
  await page.locator('#deployment-seg button', { hasText: 'monolith' }).click();
  expect(await page.locator('#runtime-hint').innerText()).toContain('One Rocket.Chat process');
}

async function exerciseKubernetesOffstage(name: string): Promise<void> {
  if (name === 'fake detail matches the real payload') {
    const fake = detail();
    const metadata = {
      cmp: {
        name: 'cmp',
        project: 'p',
        rcVersion: '7.4.1',
        rcImage: 'i',
        mongoTag: '7.0',
        mongoFlavor: 'official',
        preset: 'default',
        rootUrl: 'http://localhost:3001',
        hostPort: 3001,
        versionSource: 'x',
        pinned: false,
        createdAt: '',
        publicUrl: '',
        adminPassword: '',
        extra: {},
      },
      kub: {
        name: 'kub',
        project: 'p',
        rcVersion: '7.4.1',
        rcImage: 'i',
        mongoTag: '7.0',
        mongoFlavor: 'official',
        preset: 'default',
        rootUrl: 'http://localhost:3002',
        hostPort: 3002,
        versionSource: 'x',
        pinned: false,
        createdAt: '',
        publicUrl: '',
        adminPassword: '',
        extra: { runtime: 'kubernetes', namespace: 'houston-kub' },
      },
      multi: {
        name: 'multi',
        project: 'p',
        rcVersion: '7.4.1',
        rcImage: 'i',
        mongoTag: '7.0',
        mongoFlavor: 'official',
        preset: 'multi-instance',
        rootUrl: 'http://localhost:3003',
        hostPort: 3003,
        versionSource: 'x',
        pinned: false,
        createdAt: '',
        publicUrl: '',
        adminPassword: '',
        extra: { instances: 3 },
      },
    } as const;
    const home = process.env.HOUSTON_HOME;
    if (home === undefined) throw new Error('browser home is not isolated');
    for (const name of ['cmp', 'multi'] as const) {
      const workspace = path.join(home, 'repros', name);
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(
        path.join(workspace, 'docker-compose.yml'),
        `services:\n  rocketchat:\n    image: i\n    ports:\n      - 127.0.0.1:${String(metadata[name].hostPort)}:3000\n    environment:\n      ROOT_URL: x\n`,
      );
    }
    mockResolveName.mockImplementation(async (target) => String(target ?? ''));
    mockReadMeta.mockImplementation(async (target) => metadata[target as keyof typeof metadata]);
    mockKubernetesState.mockResolvedValue('running');
    mockPodRows.mockResolvedValue([]);
    mockContainerDetails.mockResolvedValue([]);
    mockRcRestartCount.mockResolvedValue(0);
    const shape = (value: unknown): string => (Array.isArray(value) ? 'array' : typeof value);
    const seen: string[] = [];
    for (const available of [false, true]) {
      mockDockerAvailable.mockResolvedValue(available);
      for (const target of ['cmp', 'kub', 'multi'] as const) {
        seen.push(`${String(available)}:${target}`);
        const real = await realPayload.detail(target);
        expect(Object.keys(real).filter((key) => !Object.hasOwn(fake, key))).toEqual([]);
        for (const key of Object.keys(real).filter((item) => Object.hasOwn(fake, item))) {
          if (real[key] === null || fake[key] === null) continue;
          expect(shape(fake[key])).toBe(shape(real[key]));
        }
      }
    }
    expect(seen).toEqual([
      'false:cmp',
      'false:kub',
      'false:multi',
      'true:cmp',
      'true:kub',
      'true:multi',
    ]);
    return;
  }
  mockReadMeta.mockResolvedValue({
    name: 'kub',
    project: 'p',
    rcVersion: '8.5.1',
    rcImage: 'i',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset: 'default',
    rootUrl: 'http://localhost:3131',
    hostPort: 3131,
    versionSource: 'x',
    pinned: false,
    createdAt: '',
    publicUrl: '',
    adminPassword: '',
    extra: { runtime: 'kubernetes', namespace: 'houston-kub', release: 'rocketchat' },
  });
  mockKubernetesState.mockResolvedValue('running');
  mockPodRows.mockResolvedValue([
    {
      service: 'rocketchat-ddp-streamer-x',
      state: 'running',
      status: '',
      health: '',
      app: false,
      blocked: false,
      restarts: 3,
      started: '',
    },
    {
      service: 'rocketchat-rocketchat-y',
      state: 'running',
      status: '',
      health: 'healthy',
      app: true,
      blocked: false,
      restarts: 1,
      started: '',
    },
  ]);
  expect((await realPayload.detail('kub')).restarts).toBe(1);
}

async function exerciseKubernetesPane(name: string, page: Page): Promise<void> {
  await openWorkspace(page);
  await page.locator('#actpane .aplist, #actpane .apn').first().waitFor({ state: 'visible' });
  const pane = await paneState(page);
  if (name === 'the action pane leads with what this state admits') {
    expect(pane.next.map((item) => item[0])).toEqual(['Add sample data', 'Send an API call']);
    expect(pane.next[0]?.[1]).toBe('Add sample data');
    expect(pane.groups.slice(0, 2)).toEqual(['Next, probably', 'Everything else']);
    expect(pane.rest.map((item) => item[0])).not.toEqual(
      expect.arrayContaining(['Add sample data', 'Send an API call']),
    );
    await page.locator('#actpane .apn').first().click();
    await page.locator('#seed-dialog[open]').waitFor({ state: 'visible' });
    return;
  }
  const labels = [...pane.rest.map((item) => item[0]), ...pane.next.map((item) => item[0])];
  expect(labels).not.toEqual(
    expect.arrayContaining(['Run a load test', 'Find capacity', 'Check the certificate']),
  );
  expect(await page.locator('#actpane').textContent()).toContain('Compose-only');
}

async function exerciseKubernetesPanel(name: string, page: Page): Promise<void> {
  const target = name === 'the narrow layout is a picker a panel and a bar' ? 'ws-2' : 't1234';
  if (name === 'the narrow layout is a picker a panel and a bar')
    await page.setViewportSize({ width: 430, height: 780 });
  await openWorkspace(page, target);
  if (name === 'the panel leads with what is wrong and what to do') {
    const tri = page.locator('#detail .triage .tri');
    await tri.waitFor({ state: 'visible' });
    expect(await tri.locator('.tri-t b').textContent()).toBe('Rocket.Chat has restarted 4×');
    expect(await tri.locator('.tri-t span').textContent()).toContain('memory pressure');
    expect((await tri.locator('.tri-a button').allTextContents())[0]).toBe('Open the logs');
    expect(
      await page.evaluate(() => {
        const triage = document.querySelector('#detail .triage');
        const tabs = document.querySelector('#detail .tabs');
        return (
          triage !== null &&
          tabs !== null &&
          Boolean(triage.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      }),
    ).toBe(true);
    expect(await page.locator('#detail .triage .tri').count()).toBe(1);
    await tri.locator('.tri-a button').first().click();
    await page.locator('button.tab.active', { hasText: 'Logs' }).waitFor({ state: 'visible' });
    return;
  }
  if (name === 'a down workspace is told what it still holds') {
    const why = (await page.locator('#detail .triage .tri-t span').textContent()) ?? '';
    expect(why).toContain(':3001');
    expect(why).toContain('data volume');
    expect(await page.locator('#detail .triage .tri-a button').textContent()).toBe('Bring it up');
    return;
  }
  if (name === 'a pod that cannot start is named in the panel') {
    const tri = page.locator('#detail .triage .tri');
    await tri.waitFor({ state: 'visible' });
    expect(await tri.locator('.tri-t b').textContent()).toBe('One pod cannot start');
    const why = (await tri.locator('.tri-t span').textContent()) ?? '';
    expect(why).toContain('rocketchat-0 — ImagePullBackOff');
    expect(why).not.toContain('mongodb-0');
    await tri.locator('.tri-a button').click();
    await page.locator('#d-body .dtable').waitFor({ state: 'visible' });
    return;
  }
  if (name === 'the narrow layout is a picker a panel and a bar') {
    await page.waitForTimeout(250);
    const fit = await page.evaluate(() => {
      const rows = document.querySelector('#repros') as HTMLElement;
      const chips = [...rows.querySelectorAll('.wrow')];
      return {
        sideways: document.body.scrollWidth > innerWidth + 2,
        railHeight: Math.round(rows.getBoundingClientRect().height),
        oneRow: new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size === 1,
        railScrolls: rows.scrollWidth > rows.clientWidth + 2,
        sticky: getComputedStyle(document.querySelector('#detail .d-actions') as Element).position,
        pane: getComputedStyle(document.querySelector('#actpane') as Element).display,
        toggle: getComputedStyle(document.querySelector('.panetoggle') as Element).display,
      };
    });
    expect(fit.sideways).toBe(false);
    expect(fit.oneRow).toBe(true);
    expect(fit.railHeight).toBeLessThanOrEqual(60);
    expect(fit.railScrolls).toBe(true);
    expect(fit.sticky).toBe('sticky');
    expect(fit.pane).toBe('none');
    expect(fit.toggle).not.toBe('none');
    const pinned = await page.evaluate(() => {
      const bar = document.querySelector('#detail .d-actions')?.getBoundingClientRect();
      const panel = document.querySelector('#detail')?.getBoundingClientRect();
      return {
        gap: bar === undefined ? Number.POSITIVE_INFINITY : Math.round(innerHeight - bar.bottom),
        taller: panel !== undefined && panel.height > innerHeight,
      };
    });
    expect(pinned.taller).toBe(true);
    expect(pinned.gap).toBeLessThanOrEqual(2);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(200);
    expect(
      await page.locator('#detail .d-actions').evaluate((element) => {
        const bar = element.getBoundingClientRect();
        return bar.bottom > 0 && bar.top < innerHeight;
      }),
    ).toBe(true);
    await page.locator('#detail .panetoggle').click();
    await page.locator('#actpane .apdanger').waitFor({ state: 'visible' });
    return;
  }
  if (name === 'a sidecar that keeps restarting is a fault on kubernetes') {
    await page.locator('#detail .tabs').waitFor({ state: 'visible' });
    expect(await page.locator('#detail .triage .tri').count()).toBe(0);
    expect(await mockDetail('t1234')).toHaveProperty('containers');
    return;
  }
  await page.locator('#detail .triage .tri').waitFor({ state: 'visible' });
  expect(await page.locator('#detail .triage .tri-t b').allTextContents()).toEqual([
    'rocketchat-ddp-streamer-768f896d7-rpcw9 keeps restarting',
  ]);
}

async function exerciseKubernetesRail(name: string, page: Page): Promise<void> {
  if (name.startsWith('the env tab')) {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Env vars' }).click();
    if (name.includes('refusal')) {
      await page.waitForFunction(() =>
        document.querySelector('#d-body')?.textContent.includes('no Rocket.Chat pod'),
      );
      return;
    }
    await page.waitForFunction(() =>
      document.querySelector('#d-body')?.textContent.includes('ROOT_URL'),
    );
    const body = (await page.locator('#d-body').textContent()) ?? '';
    if (name.includes('kubernetes')) {
      expect(body).toContain('MY_FLAG');
      expect(body).toContain('MONGO_URL');
      expect(body).not.toContain('Set + restart');
      expect(body).toContain('helm -n houston-t1234 upgrade');
      expect(await page.locator('#d-body button.danger').count()).toBe(0);
    } else {
      expect(body).toContain('Set + restart');
      expect(await page.locator('#d-body button.danger').count()).toBeGreaterThan(0);
    }
    return;
  }
  if (name === 'the containers tab shows pods and says so on kubernetes') {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Containers' }).click();
    await page.locator('#d-body table.dtable').waitFor({ state: 'visible' });
    const body = (await page.locator('#d-body').textContent()) ?? '';
    expect(body).toContain('rocketchat-mongodb-0');
    expect(body).toContain('ImagePullBackOff');
    expect(body).not.toContain('No containers');
    expect(body).toContain('Pods, not containers');
    expect(await page.locator('#d-body table.dtable th').first().textContent()).toBe('pod');
    return;
  }
  if (name === 'the live chart stops asking when the answer is a refusal') {
    await openWorkspace(page);
    await page.waitForFunction(() =>
      document.querySelector('#chart')?.textContent.includes('metrics-server'),
    );
    const timer = await page.evaluate(async (source) => {
      const load = new Function('name', 'return import(name)') as (
        name: string,
      ) => Promise<Record<string, unknown>>;
      return ((await load(source)).ctx as { dstate: { statsTimer: unknown } }).dstate.statsTimer;
    }, '/js/shared.js');
    expect(timer).toBeNull();
    return;
  }
  if (name === 'a credential note is not labelled a sudo setup step') {
    await openWorkspace(page);
    const body = (await page.locator('#d-body').textContent()) ?? '';
    expect(body).toContain('cn=admin,dc=example,dc=com');
    expect(body).not.toContain('Needs sudo');
    return;
  }
  if (name === 'the one preset with a real setup step keeps it') {
    await openWorkspace(page);
    const setup = page.locator('#d-body .setup');
    await setup.waitFor({ state: 'visible' });
    expect(await setup.textContent()).toContain('127.0.0.1  keycloak');
    expect(await setup.textContent()).toContain('Needs sudo');
    return;
  }
  if (name === 'the three panes survive a narrow window') {
    await openWorkspace(page);
    for (const width of [1440, 1024, 768, 640, 480, 380]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      const measured = await page.evaluate(() => {
        const rail = document.querySelector('.rail')?.getBoundingClientRect();
        const stage = document.querySelector('#detail')?.getBoundingClientRect();
        if (rail === undefined || stage === undefined)
          return { over: true, width: 0, overlap: true };
        return {
          over: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          width: Math.round(stage.width),
          overlap:
            Math.round(Math.min(rail.bottom, stage.bottom) - Math.max(rail.top, stage.top)) > 2 &&
            Math.round(Math.min(rail.right, stage.right) - Math.max(rail.left, stage.left)) > 2,
        };
      });
      expect(measured.over).toBe(false);
      expect(measured.width).toBeGreaterThanOrEqual(320);
      expect(measured.overlap).toBe(false);
    }
    return;
  }
  if (name === 'a note that ends in a name is not glued to the next one') {
    await openWorkspace(page);
    const paragraphs = await page.locator('#d-body .note-p').allTextContents();
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]?.trim().endsWith('houston-x')).toBe(true);
    expect(paragraphs[0]).not.toContain('StatefulSet');
    return;
  }
  if (name === 'a genuinely wrapped note still joins the line after it') {
    await openWorkspace(page);
    const paragraphs = await page.locator('#d-body .note-p').allTextContents();
    expect(
      paragraphs.some((text) => text.includes('host entry') && text.includes('/etc/hosts')),
    ).toBe(true);
    return;
  }
  if (name === 'a long line in a note scrolls instead of being clipped away') {
    await openWorkspace(page);
    await page.locator('#d-body .note-cmd').waitFor({ state: 'visible' });
    const measured = await page.evaluate(() => {
      const card = document.querySelector('#d-body .panelcard') as HTMLElement;
      const box = document.querySelector('#d-body .note-cmd') as HTMLElement;
      const code = box.querySelector('code') as HTMLElement;
      return {
        cardOver: card.scrollWidth > card.clientWidth + 2,
        boxOver: box.scrollWidth > box.clientWidth + 2,
        codeScrolls: code.scrollWidth > code.clientWidth,
        overflowX: getComputedStyle(code).overflowX,
        whiteSpace: getComputedStyle(code).whiteSpace,
      };
    });
    expect(measured.cardOver).toBe(false);
    expect(measured.boxOver).toBe(false);
    expect(measured.codeScrolls).toBe(true);
    expect(measured.overflowX).toBe('auto');
    expect(measured.whiteSpace).toBe('pre');
    return;
  }
  if (name === 'a grouped note gets its own card with a fact table and a copy button') {
    await openWorkspace(page);
    await page.locator('#d-body .notetable').waitFor({ state: 'visible' });
    const measured = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#d-body .panelcard')];
      const titled = (title: string) =>
        cards.find((card) => card.querySelector('.section-label')?.textContent === title);
      const kube = titled('Kubernetes');
      const forward = titled('Port forward');
      return {
        rows:
          kube !== undefined
            ? [...kube.querySelectorAll('tr')].map((row) => [
                row.querySelector('th')?.textContent,
                row.querySelector('td')?.textContent,
              ])
            : null,
        command: forward?.querySelector('.note-cmd code')?.textContent,
        copy: Boolean(forward?.querySelector('.note-cmd .cp')),
        prose: forward?.textContent.includes('dies with the pod'),
        flat: cards.some((card) => card.textContent.includes('Cluster  x')),
      };
    });
    expect(measured.rows).toEqual([
      ['Cluster', 'kind-houston-local'],
      ['Namespace', 'houston-t1234'],
      ['Arrangement', 'microservices'],
    ]);
    expect(measured.command).toBe('kubectl -n houston-t1234 port-forward deployment/rc 3001:3000');
    expect(measured.copy).toBe(true);
    expect(measured.prose).toBe(true);
    expect(measured.flat).toBe(false);
    return;
  }
  if (name === 'the overview says which runtime the workspace runs on') {
    await openWorkspace(page);
    const cells = await page
      .locator('#d-body .kv-grid .kv')
      .evaluateAll((nodes) =>
        nodes.map((node) => [
          node.querySelector('.k')?.textContent ?? '',
          node.querySelector('.v')?.textContent ?? '',
        ]),
      );
    expect(Object.fromEntries(cells)['Runs on']).toBe('Kubernetes · microservices');
    expect(cells).toHaveLength(6);
    return;
  }
  if (name === 'the panel is not a two hundred pixel window on a narrow screen') {
    await openWorkspace(page);
    await page.locator('#d-body .panelcard').first().waitFor({ state: 'visible' });
    await page.setViewportSize({ width: 520, height: 900 });
    await page.waitForTimeout(300);
    const measured = await page.evaluate(() => {
      const stage = document.querySelector('.stage') as HTMLElement;
      const cards = [...document.querySelectorAll('#d-body .panelcard')];
      const last = cards.at(-1)?.getBoundingClientRect();
      const status = document.querySelector('.statusbar')?.getBoundingClientRect();
      return {
        pageScrolls: document.documentElement.scrollHeight > innerHeight,
        sideways: document.body.scrollWidth > innerWidth + 2,
        hidden: stage.scrollHeight - stage.clientHeight,
        cells: document.querySelectorAll('#d-body .kv-grid .kv').length,
        cards: cards.length,
        clear: last !== undefined && status !== undefined && last.bottom <= status.top + 2,
      };
    });
    expect(measured.pageScrolls).toBe(true);
    expect(measured.sideways).toBe(false);
    expect(measured.hidden).toBeLessThanOrEqual(2);
    expect(measured.cells).toBe(6);
    expect(measured.cards).toBeGreaterThanOrEqual(9);
    expect(measured.clear).toBe(true);
    await page.setViewportSize({ width: 380, height: 900 });
    await page.waitForTimeout(200);
    const tabs = await page.evaluate(() => {
      const strip = document.querySelector('.tabs') as HTMLElement;
      const items = [...strip.querySelectorAll('.tab')];
      strip.scrollLeft = strip.scrollWidth;
      const last = items.at(-1)?.getBoundingClientRect();
      const rect = strip.getBoundingClientRect();
      return {
        scrolls: strip.scrollWidth > strip.clientWidth,
        reachable: last !== undefined && last.right <= rect.right + 2 && last.left >= rect.left - 2,
        sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    expect(tabs.sideways).toBe(false);
    expect(tabs.scrolls).toBe(true);
    expect(tabs.reachable).toBe(true);
    return;
  }
  if (name === 'a place a group names is the link row and not a second row') {
    await openWorkspace(page);
    await page.locator('#d-body .linkrow').first().waitFor({ state: 'visible' });
    const body = page.locator('#d-body');
    const rows = await body.locator('.linkrow').allTextContents();
    expect(rows.filter((row) => row.includes('localhost:5050'))).toHaveLength(1);
    expect(rows.some((row) => row.includes('admin/admin'))).toBe(true);
    expect(await body.textContent()).toContain('auto-provisioned');
    return;
  }
  if (name === 'a healthy workspace gets no triage block at all') {
    await openWorkspace(page);
    await page.locator('#d-body .kv-grid').waitFor({ state: 'visible' });
    expect(await page.locator('#detail .triage').count()).toBe(0);
    return;
  }
  if (name === 'the rail groups by what each workspace wants from you') {
    await page.locator('#repros .rgrp').first().waitFor({ state: 'visible' });
    const groups = await page.evaluate(() => {
      const out: Array<{ title: string; count: string; rows: string[] }> = [];
      let group: { title: string; count: string; rows: string[] } | null = null;
      for (const child of document.querySelector('#repros')?.children ?? []) {
        if (child.classList.contains('rgrp')) {
          group = {
            title: child.querySelector('.rgrp-t')?.textContent ?? '',
            count: child.querySelector('.rgrp-n')?.textContent ?? '',
            rows: [],
          };
          out.push(group);
        } else if (group !== null) group.rows.push(child.querySelector('.nm')?.textContent ?? '');
      }
      return out;
    });
    expect(groups.map((group) => group.title)).toEqual(['Wants you', 'Running', 'Not running']);
    expect(groups.map((group) => group.count)).toEqual(['2', '1', '2']);
    expect(groups.map((group) => group.rows)).toEqual([
      ['aa-loop', 'bb-sick'],
      ['cc-fine'],
      ['dd-stopped', 'ee-down'],
    ]);
    return;
  }
  if (name === 'one state gets no group headings') {
    expect(await page.locator('#repros .rgrp').count()).toBe(0);
    expect(await page.locator('#repros .wrow').count()).toBe(3);
    const titles = await page.evaluate(async (source) => {
      const load = new Function('name', 'return import(name)') as (
        name: string,
      ) => Promise<Record<string, unknown>>;
      const railGroups = (await load(source)).railGroups as (
        rows: Array<{ state: string }>,
      ) => unknown[][];
      return [
        railGroups([{ state: 'running' }, { state: 'running' }]).map(
          (group: unknown[]) => group[0],
        ),
        railGroups([{ state: 'running' }, { state: 'stopped' }]).map(
          (group: unknown[]) => group[0],
        ),
      ];
    }, '/js/api.js');
    expect(titles).toEqual([
      ['', '', ''],
      ['Wants you', 'Running', 'Not running'],
    ]);
    return;
  }
  if (name === 'a long workspace name does not push the rail sideways') {
    for (const width of [1440, 430]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const measured = await page.evaluate(() => {
        const rows = document.querySelector('#repros') as HTMLElement;
        return {
          sideways: rows.scrollWidth > rows.clientWidth + 1,
          inside: [...rows.querySelectorAll<HTMLElement>('.wrow')].every(
            (row) => row.scrollWidth <= row.clientWidth + 1,
          ),
          title: rows.querySelector('.wrow')?.getAttribute('title'),
        };
      });
      if (width > 760) expect(measured.sideways).toBe(false);
      expect(measured.inside).toBe(true);
      expect(measured.title).toBe('a-really-long-workspace-name-for-ticket-4821');
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const meta = await page
      .locator('.wrow', { hasText: 'dana-upgrade' })
      .locator('.meta')
      .innerText();
    expect(meta).toContain(':3001');
    expect(meta).toContain('alice');
    expect(meta).toContain('monitored');
    return;
  }
  if (
    name === 'a seeded workspace is not told to seed itself' ||
    name === 'nothing is suggested for a workspace that is not running'
  ) {
    await openWorkspace(page);
    const pane = await paneState(page);
    if (name.startsWith('a seeded')) {
      expect(pane.next.map((item) => item[0])).toEqual(['Send an API call', 'Back up now']);
      expect(pane.rest.map((item) => item[0])).toContain('Add sample data');
    } else {
      expect(pane.next).toEqual([]);
      expect(pane.groups[0]).toBe('What you can do with it');
      expect(pane.note).toContain('need the workspace running');
      expect(Object.fromEntries(pane.rest)['Add sample data']).toBe(true);
      expect(Object.fromEntries(pane.rest)['Use for CLI commands']).toBe(false);
    }
    return;
  }
  if (name === 'a kubernetes log line is split by pod like a compose one') {
    const parsed = await page.evaluate(async (source) => {
      const load = new Function('name', 'return import(name)') as (
        name: string,
      ) => Promise<Record<string, unknown>>;
      const module = await load(source);
      const parseLogLine = module.parseLogLine as (line: string) => Record<string, unknown>;
      const logRow = module.logRow as (row: Record<string, unknown>) => HTMLElement;
      const rows = [
        parseLogLine(
          '[pod/rocketchat-presence-7ffb7dc6f7-7v88f/presence-service] NetworkBroker started successfully.',
        ),
        parseLogLine(
          '[pod/rocketchat-rocketchat-579c867b87-mclgv/rocketchat] {"level":50,"time":1755600000000,"msg":"You have not provided a mail URL."}',
        ),
        parseLogLine('rocketchat-1  | {"level":30,"time":1755600000000,"msg":"started"}'),
      ];
      const rendered = logRow(
        parseLogLine('[pod/rocketchat-ddp-streamer-768f896d7-2r7w7/ddp-streamer] hello'),
      );
      const cell = rendered.querySelector('.ls');
      return {
        rows,
        cell: [
          cell?.textContent,
          cell?.getAttribute('title'),
          rendered.querySelector('.lm')?.textContent,
        ],
      };
    }, '/js/logs.js');
    expect(parsed.rows[0]).toMatchObject({
      service: 'presence',
      msg: 'NetworkBroker started successfully.',
      pod: 'rocketchat-presence-7ffb7dc6f7-7v88f',
    });
    expect(parsed.rows[1]).toMatchObject({
      service: 'rocketchat',
      level: 'error',
      msg: 'You have not provided a mail URL.',
      pod: 'rocketchat-rocketchat-579c867b87-mclgv',
    });
    expect(parsed.rows[2]).toMatchObject({ service: 'rocketchat', msg: 'started' });
    expect(parsed.cell).toEqual([
      'ddp-streamer',
      'rocketchat-ddp-streamer-768f896d7-2r7w7',
      'hello',
    ]);
    return;
  }
  if (name === 'a note paragraph is as wide as the card it is in') {
    await openWorkspace(page);
    await page.locator('#d-body .note-cmd').waitFor({ state: 'visible' });
    for (const width of [1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(200);
      const measured = await page.evaluate(() => {
        const card = [...document.querySelectorAll<HTMLElement>('#d-body .panelcard')].find(
          (node) => node.textContent.includes('own kubeconfig'),
        );
        const size = (selector: string) =>
          Math.round(card?.querySelector(selector)?.getBoundingClientRect().width ?? 0);
        return { paragraph: size('.note-p'), command: size('.note-cmd') };
      });
      expect(Math.abs(measured.paragraph - measured.command)).toBeLessThanOrEqual(2);
    }
    return;
  }
  if (name === 'a restart count that climbs is a fault even while ready') {
    const values = [];
    for (const count of [3, 3, 4, 4])
      values.push(await browserImport(page, '/js/util.js', 'restartsClimbing', 'w', 'pod', count));
    expect(values).toEqual([false, false, true, false]);
    return;
  }
  if (name === 'the gui has exactly one jobActive and the page parses') {
    const source = fs.readFileSync(path.resolve('data/webui/js/util.js'), 'utf8');
    expect(source.match(/const jobActive/gu)).toHaveLength(1);
    const exported = await page.evaluate(
      async ({ utilSource, jobsSource }) => {
        const load = new Function('name', 'return import(name)') as (
          name: string,
        ) => Promise<Record<string, unknown>>;
        const util = await load(utilSource);
        const jobs = await load(jobsSource);
        return [typeof util.jobActive, typeof jobs.pollJobUntilDone, typeof util.apiForm];
      },
      { utilSource: '/js/util.js', jobsSource: '/js/jobs.js' },
    );
    expect(exported).toEqual(['function', 'function', 'function']);
    return;
  }
  const source = await page.evaluate(async (specifier) => {
    const load = new Function('name', 'return import(name)') as (
      name: string,
    ) => Promise<Record<string, unknown>>;
    return ((await load(specifier)).startStats as () => unknown).toString();
  }, '/js/logs.js');
  expect(source).toContain('inFlight');
  expect(source).toContain('asked !== ctx.SELECTED');
  expect(source).toContain('finally');
}

async function openCreate(page: Page): Promise<void> {
  await page.locator('#btn-new').click({ timeout: 5000 });
  await page.locator('#create-dialog[open]').waitFor({ state: 'visible', timeout: 5000 });
}

async function exerciseSurface(name: string, page: Page): Promise<void> {
  if (name === 'the dashboard renders a workspace card') {
    await page.locator('#repros', { hasText: 't1234' }).waitFor({ state: 'visible' });
    expect(await page.locator('#repros').textContent()).toContain('t1234');
    return;
  }
  if (name === 'the detail panel opens and switches tabs') {
    await openWorkspace(page);
    expect(await page.locator('#detail').textContent()).toContain('7.4.1');
    await page.getByRole('button', { name: 'Containers', exact: true }).click();
    await page.locator('#d-body', { hasText: 'rocketchat' }).waitFor({ state: 'visible' });
    return;
  }
  if (name === 'the log viewer streams container output') {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    for (let attempt = 0; attempt < 30 && mockComposeStream.mock.calls.length === 0; attempt += 1)
      await page.waitForTimeout(100);
    expect(mockComposeStream).toHaveBeenCalled();
    await page
      .locator('#logview', { hasText: 'line 4' })
      .waitFor({ state: 'visible', timeout: 10_000 });
    expect(await page.locator('#logview .logrow .lm').allTextContents()).toEqual([
      'line 0',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
    ]);
    return;
  }
  if (name === 'the backups tab lists what is there') {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Backups', exact: true }).click();
    await page.locator('#d-body', { hasText: 't1234-2026-08-09' }).waitFor({ state: 'visible' });
    expect(await page.locator('#d-body').textContent()).toContain('7.4.1');
    expect(mockListBackups).toHaveBeenCalledWith('t1234');
    return;
  }
  if (name === 'a readonly user is offered nothing in the detail panel either') {
    await openWorkspace(page);
    expect(await page.locator('.d-actions').textContent()).toContain('readonly');
    for (const label of ['Make default', 'Down', 'Stop', 'Restart', 'Load test']) {
      expect(await page.locator('.d-actions button', { hasText: label }).count()).toBe(0);
    }
    expect(await page.locator('.d-actions a', { hasText: 'Open RC' }).count()).toBe(1);
    return;
  }
  if (name === 'nothing in the page is painted a hardcoded dark colour') {
    for (const selector of ['body', '.topbar', '.statusbar']) {
      const colour = await page.locator(selector).evaluate((element) => {
        return getComputedStyle(element).backgroundColor;
      });
      const channels = colour.match(/\d+/gu)?.slice(0, 3).map(Number) ?? [];
      expect(channels).toHaveLength(3);
      expect(channels.reduce((sum, value) => sum + value, 0) / 3).toBeGreaterThan(150);
    }
    return;
  }
  if (name === 'no control is hidden behind the status bar') {
    const bar = await page.locator('.statusbar').evaluate((element) => {
      return element.getBoundingClientRect().top;
    });
    for (const selector of ['#btn-prune', '#btn-new', '#filter']) {
      const bottom = await page.locator(selector).evaluate((element) => {
        return element.getBoundingClientRect().bottom;
      });
      expect(bottom).toBeLessThanOrEqual(bar + 1);
    }
    return;
  }
  if (name === 'the one button a screen is asking for carries the accent') {
    const got = await page.locator('#btn-new').evaluate((element) => {
      const styles = getComputedStyle(element);
      const root = getComputedStyle(document.documentElement);
      const swatch = (value: string): string => {
        const sample = document.createElement('div');
        sample.style.color = value.trim();
        document.body.append(sample);
        const colour = getComputedStyle(sample).color;
        sample.remove();
        return colour;
      };
      return {
        bg: styles.backgroundColor,
        accent: swatch(root.getPropertyValue('--accent-fill')),
        ink: swatch(root.getPropertyValue('--ink')),
        shadow: styles.boxShadow,
      };
    });
    expect(got.bg).toBe(got.accent);
    expect(got.bg).not.toBe(got.ink);
    expect(got.shadow).not.toBe('none');
    return;
  }
  if (name === 'a burst of log lines costs one layout not one per line') {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    await page.locator('#logview').waitFor({ state: 'visible' });
    const got = await page.evaluate(async () => {
      const load = new Function('name', 'return import(name)') as (
        specifier: string,
      ) => Promise<Record<string, unknown>>;
      const shared = (await load('/js/shared.js')) as unknown as {
        ctx: { logv: { buf: unknown[] } };
      };
      const logs = (await load('/js/logs.js')) as unknown as {
        queueLog: (row: unknown) => void;
      };
      const box = document.querySelector('#logview') as HTMLElement;
      let appends = 0;
      const real = box.append.bind(box);
      box.append = (...args: (Node | string)[]): void => {
        appends += 1;
        real(...args);
      };
      for (let index = 0; index < 400; index += 1) {
        const row = {
          ts: '12:00:00',
          level: 'info',
          service: 'rocketchat',
          msg: `line ${String(index)}`,
        };
        shared.ctx.logv.buf.push(row);
        logs.queueLog(row);
      }
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return { appends, rows: box.childElementCount };
    });
    expect(got.rows).toBeGreaterThanOrEqual(400);
    expect(got.appends).toBeLessThanOrEqual(2);
    return;
  }
  if (name === 'scrolling up in the logs offers one press back to the latest') {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    await page.locator('#logview').waitFor({ state: 'visible' });
    const feed = async (target: Page, count: number): Promise<void> => {
      await target.evaluate(async (total) => {
        const load = new Function('name', 'return import(name)') as (
          specifier: string,
        ) => Promise<Record<string, unknown>>;
        const shared = (await load('/js/shared.js')) as unknown as {
          ctx: { logv: { buf: unknown[] } };
        };
        const logs = (await load('/js/logs.js')) as unknown as {
          queueLog: (row: unknown) => void;
        };
        for (let index = 0; index < total; index += 1) {
          const row = {
            ts: '12:00:00',
            level: 'info',
            service: 'rocketchat',
            msg: `line ${String(index)}`,
          };
          shared.ctx.logv.buf.push(row);
          logs.queueLog(row);
        }
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      }, count);
    };
    await feed(page, 200);
    expect(await page.locator('#log-jump').isHidden()).toBe(true);
    await page.locator('#logview').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.locator('#log-jump:not([hidden])').waitFor({ state: 'visible' });
    expect(
      await page.evaluate(async () => {
        const load = new Function('name', 'return import(name)') as (
          specifier: string,
        ) => Promise<Record<string, unknown>>;
        const shared = (await load('/js/shared.js')) as unknown as {
          ctx: { logv: { follow: boolean } };
        };
        return shared.ctx.logv.follow;
      }),
    ).toBe(false);
    await feed(page, 5);
    expect(await page.locator('#log-jump').innerText()).toBe('↓ 5 new');
    await page.locator('#log-jump').click();
    await page.locator('#log-jump').waitFor({ state: 'hidden' });
    expect(
      await page.locator('#logview').evaluate((element) => {
        return element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }),
    ).toBe(true);
    return;
  }
  if (name === 'reduced motion keeps every state and removes the travel') {
    const duration = await page.locator('#btn-new').evaluate((element) => {
      return getComputedStyle(element).transitionDuration;
    });
    for (const value of duration.split(',')) {
      expect(Number.parseFloat(value.trim().replace(/s$/u, ''))).toBeLessThanOrEqual(0.001);
    }
    expect(
      await page.locator('#btn-new').evaluate((element) => getComputedStyle(element).boxShadow),
    ).not.toBe('none');
    return;
  }
  if (name === 'the action pane names the thing not one of its parts') {
    await openWorkspace(page);
    const labels = await page.locator('#actpane button').allTextContents();
    expect(labels).toContain('Attach monitoring');
    expect(labels).toContain('PAT and Token');
    expect(labels.filter((value) => value.includes('Grafana') || value.includes('Mint'))).toEqual(
      [],
    );
    return;
  }
  if (name === 'the home page leads with capacity') {
    await page.locator('#detail', { hasText: 'room for' }).waitFor({ state: 'visible' });
    const body = await page.locator('#detail').textContent();
    expect(body).toContain('room for about 1 more');
    expect(body).toContain('Memory on this machine');
    return;
  }
  if (name === 'a down workspace is something home asks you about') {
    await page.locator('#detail', { hasText: 'Needs you' }).waitFor({ state: 'visible' });
    const body = await page.locator('#detail').textContent();
    expect(body).toContain('upgrade-test is down');
    expect(body).toContain('still holds port');
    await openWorkspace(page, 'upgrade-test');
    expect(await page.locator('.d-head').textContent()).toContain('upgrade-test');
    return;
  }
  if (name === 'a card is not the same colour as the thing it stands on') {
    await page.locator('#detail .hcard').first().waitFor({ state: 'visible' });
    const got = await page.evaluate(() => {
      const seen = (element: Element | null): string | null => {
        for (let node = element; node !== null; node = node.parentElement) {
          const colour = getComputedStyle(node).backgroundColor;
          if (colour !== '' && colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent')
            return colour;
        }
        return null;
      };
      const card = document.querySelector('#detail .hcard') as HTMLElement;
      return {
        card: getComputedStyle(card).backgroundColor,
        ground: seen(document.querySelector('#detail')),
        rail: getComputedStyle(document.querySelector('.rail') as HTMLElement).backgroundColor,
      };
    });
    expect(got.card).not.toBe(got.ground);
    expect(got.rail).toBe(got.card);
    return;
  }
  if (name === 'a note that names a place joins the row that already lists it') {
    await openWorkspace(page);
    expect(await page.locator('#detail .linkrow').count()).toBe(3);
    const grafana = page.locator("#detail .linkrow:has(.l-u:text-is('http://localhost:5050'))");
    expect(await grafana.locator('.l-c').innerText()).toBe('admin/admin');
    expect(await grafana.locator('.l-sub').innerText()).toContain('anonymous view');
    const prometheus = page.locator("#detail .linkrow:has(.l-u:text-is('http://localhost:9090'))");
    expect(await prometheus.locator('.l-c').count()).toBe(0);
    expect(await prometheus.locator('.l-sub').innerText()).toContain('Targets');
    expect(await page.locator('#detail .note-p', { hasText: 'auto-provisioned' }).count()).toBe(1);
    return;
  }
  if (name === 'the create dialog opens and lists presets') {
    await openCreate(page);
    await page.waitForFunction(() => document.querySelectorAll('#preset-select option').length > 0);
    const values = await page
      .locator('#preset-select option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(values).toEqual(expect.arrayContaining(['default', 'ldap']));
    await page.locator('#create-cancel').click();
    await page.waitForFunction(
      () => !(document.querySelector('#create-dialog') as HTMLDialogElement).open,
    );
    return;
  }
  if (name === 'the load test dialog opens from the panel') {
    await openWorkspace(page);
    await page.locator('button', { hasText: 'Load test' }).click({ timeout: 5000 });
    await page.locator('#perf-dialog[open]').waitFor({ state: 'visible', timeout: 5000 });
    expect(await page.locator('#perf-title').textContent()).toContain('t1234');
    expect(await page.locator('#perf-form [name=live]').isDisabled()).toBe(true);
    await page.locator('#perf-cancel').click({ timeout: 5000 });
    await page.waitForFunction(
      () => !(document.querySelector('#perf-dialog') as HTMLDialogElement).open,
      undefined,
      { timeout: 5000 },
    );
    return;
  }
  if (name === 'the doctor dialog renders its checks') {
    await page.locator('#doctor-badge').click();
    await page.locator('#doctor-dialog[open]').waitFor({ state: 'visible' });
    await page.waitForFunction(
      () => !(document.querySelector('#doctor-body')?.textContent ?? '').includes('Checking'),
    );
    const body = await page.locator('#doctor-body').textContent();
    expect(body).toContain('Docker daemon running');
    expect(body).toContain('a workspace needs about 6');
    expect(body).not.toContain('Edge running');
    expect(body).toContain('no workspace');
    expect(body).not.toContain('1 total, 1 running');
    await page.locator('#doctor-close').click();
    return;
  }
  if (name === 'the edge badge surfaces an unreachable route') {
    await page.locator('#edge-badge:not([hidden])').waitFor({ state: 'visible' });
    expect(await page.locator('#edge-badge').textContent()).toContain('1 unreachable');
    await page.locator('#edge-badge').click();
    await page.locator('#edge-dialog[open]').waitFor({ state: 'visible' });
    expect(await page.locator('#edge-body').textContent()).toContain('t9999');
    expect(mockRouteReachable).toHaveBeenCalled();
    await page.locator('#edge-close').click();
    await page.waitForFunction(
      () => !(document.querySelector('#edge-dialog') as HTMLDialogElement).open,
    );
    return;
  }
  if (name === 'an admin can delete a certificate nothing points at') {
    await page.locator('#edge-badge:not([hidden])').waitFor({ state: 'visible' });
    await page.locator('#edge-badge').click();
    await page.locator('#edge-dialog[open]').waitFor({ state: 'visible' });
    const before = await page.locator('#edge-body').textContent();
    expect(before).toContain('certificate held with no route');
    expect(before).toContain('old-ticket-991.kestron.org');
    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await page.locator('#edge-body button.danger').click();
    await page.waitForFunction(
      () => !(document.querySelector('#edge-body')?.textContent ?? '').includes('old-ticket-991'),
    );
    expect(mockDeleteHost).toHaveBeenCalledWith('old-ticket-991.kestron.org', { confirm: true });
    expect(surfaceAcmeHosts).toEqual([]);
    return;
  }
  if (name === 'a member is not offered the delete at all') {
    await page.locator('#edge-badge:not([hidden])').waitFor({ state: 'visible' });
    await page.locator('#edge-badge').click();
    await page.locator('#edge-dialog[open]').waitFor({ state: 'visible' });
    expect(await page.locator('#edge-body').textContent()).toContain('old-ticket-991.kestron.org');
    expect(await page.locator('#edge-body button.danger').count()).toBe(0);
    expect(mockDeleteHost).not.toHaveBeenCalled();
    return;
  }
  if (name === 'the create dialog follows the box policy not the role') {
    const openWithAdvanced = async (): Promise<void> => {
      await openCreate(page);
      await page.locator('#create-dialog details.adv').evaluateAll((details) => {
        for (const item of details) (item as HTMLDetailsElement).open = true;
      });
      await page.locator('#create-form [name=mongo]').waitFor({ state: 'visible', timeout: 5000 });
    };
    await openWithAdvanced();
    for (const field of PRIVILEGED_CREATE_FIELDS) {
      if (field !== 'context') {
        expect(await page.locator(`#create-form [name=${field}]`).isVisible()).toBe(true);
      }
    }
    expect(await page.locator('#create-form [name=context]').isHidden()).toBe(true);
    await page.locator('#runtime-forks button', { hasText: 'Kubernetes' }).click({ timeout: 5000 });
    expect(await page.locator('#create-form [name=context]').isVisible()).toBe(true);
    await page
      .locator('#runtime-forks button', { hasText: 'Docker Compose' })
      .click({ timeout: 5000 });
    expect(await page.locator('#create-form [name=port]').isVisible()).toBe(true);
    await page.locator('#create-cancel').click({ timeout: 5000 });
    await page.waitForFunction(
      () => !(document.querySelector('#create-dialog') as HTMLDialogElement).open,
      undefined,
      { timeout: 5000 },
    );
    config.updateConfig((value) => {
      value[CREATE_POLICY_KEY] = 'admin';
    });
    await openWithAdvanced();
    for (const field of PRIVILEGED_CREATE_FIELDS) {
      expect(await page.locator(`#create-form [name=${field}]`).isHidden()).toBe(true);
    }
    await page.locator('#runtime-forks button', { hasText: 'Kubernetes' }).click({ timeout: 5000 });
    expect(await page.locator('#create-form [name=context]').isHidden()).toBe(true);
    return;
  }
  if (name === 'https is in section two and is still not a second twisty') {
    await openCreate(page);
    expect(await page.locator('#create-dialog details.adv').count()).toBe(1);
    expect(
      await page
        .locator('#create-https-block')
        .evaluate((element) => element.closest('details') === null),
    ).toBe(true);
    expect(
      await page.locator('#create-dialog details.adv').evaluate((element) => {
        return (element as HTMLDetailsElement).open;
      }),
    ).toBe(false);
    expect(await page.locator('#create-https-block').isVisible()).toBe(true);
    expect(
      await page.locator('#create-https-block').evaluate((element) => {
        return (
          element.closest('section') ===
          document.querySelector('#runtime-forks')?.closest('section')
        );
      }),
    ).toBe(true);
    expect(await page.locator('input[name=domain]').isHidden()).toBe(true);
    await page.locator('#https-mode').selectOption('acme');
    expect(await page.locator('input[name=domain]').isVisible()).toBe(true);
    expect(await page.locator('input[name=acme_email]').isVisible()).toBe(true);
    await page.locator('#https-mode').selectOption('local');
    expect(await page.locator('input[name=domain]').isHidden()).toBe(true);
    expect((await page.locator('#https-mode-hint').textContent())?.trim()).not.toBe('');
    return;
  }
  if (name === 'you can change your own password from the browser') {
    await page.locator('#whoami').click();
    await page.locator('#me-menu:not([hidden])').waitFor({ state: 'visible' });
    await page.locator('#me-passwd').click();
    await page.locator('#passwd-dialog[open]').waitFor({ state: 'visible' });
    await page.locator('#passwd-form [name=old]').fill('not-my-password');
    await page.locator('#passwd-form [name=new]').fill('a-brand-new-password');
    await page.locator('#passwd-go').click();
    await page.locator('#passwd-err:not([hidden])').waitFor({ state: 'visible' });
    expect(await page.locator('#passwd-err').textContent()).toContain('not your current password');
    await page.locator('#passwd-form [name=old]').fill(PASSWORD);
    await page.locator('#passwd-go').click();
    await page.waitForFunction(
      () => !(document.querySelector('#passwd-dialog') as HTMLDialogElement).open,
    );
    await page.reload();
    await page.locator('#whoami:not([hidden])').waitFor({ state: 'visible' });
    expect((await page.locator('#whoami').textContent())?.trim()).toBe('alice');
    expect(await users.verify('alice', 'a-brand-new-password')).toBe(true);
    expect(await users.verify('alice', PASSWORD)).toBe(false);
    return;
  }
  if (name === 'a running workspace on home offers both places it could mean') {
    const row = page.locator('.wsrow').first();
    await row.waitFor({ state: 'visible' });
    expect(await row.locator('.wsrow-t b').innerText()).toContain('t1234');
    expect(await row.locator('.wsrow-m').innerText()).toBe('7.4.1 · base · :3001');
    expect(await row.locator('.wsrow-up').innerText()).toContain('2h');
    const opener = row.getByRole('link', { name: 'Open', exact: true });
    expect(await opener.getAttribute('target')).toBe('_blank');
    expect(await opener.getAttribute('href')).toBe('http://localhost:3001');
    await row.locator('.wsrow-main').click();
    await page.locator('#d-body').waitFor({ state: 'visible' });
    expect(await page.locator('.d-head').textContent()).toContain('t1234');
    return;
  }
  throw new Error(`unported surfaces behavior: ${name}`);
}

async function exercise(browserCase: BrowserCase, page: Page): Promise<void> {
  const name = browserCase[1];
  if (name.includes('theme is light')) {
    await waitForGui(page);
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
    await page.locator('#theme-toggle').click();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
    await page.reload();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
    return;
  }
  await waitForGui(page);
  if (name.includes('narrow') || name.includes('three panes')) {
    await page.setViewportSize({ width: 430, height: 760 });
    expect(await page.locator('#nav-toggle').isVisible()).toBe(true);
  }
  if (browserCase[0] === 'clusters' || name.includes('cluster chip')) {
    await page.locator('#btn-clusters').click();
    await page.locator('#detail', { hasText: 'Clusters' }).waitFor({ state: 'visible' });
    expect(await page.locator('#detail').textContent()).toContain('Clusters');
    return;
  }
  if (name.includes('activity') || name.includes('in progress') || name.includes('job')) {
    await page.locator('#btn-jobs').click();
    await page.locator('#detail', { hasText: 'Activity' }).waitFor({ state: 'visible' });
    expect(await page.locator('#detail').textContent()).toContain('Activity');
    return;
  }
  if (name.includes('scenario') || name.includes('preset notes')) {
    await page.locator('#btn-scenarios').click();
    await page.locator('#detail', { hasText: 'Scenarios' }).waitFor({ state: 'visible' });
    expect(await page.locator('#detail').textContent()).toContain('Scenarios');
    return;
  }
  if (
    name.includes('create dialog') ||
    name.includes('runtime card') ||
    name.includes('arrangement')
  ) {
    await page.locator('#btn-new').click();
    await page.locator('#create-dialog').waitFor({ state: 'visible' });
    expect(await page.locator('#create-dialog').getAttribute('open')).toBe('');
    expect(await page.locator('#preset-select option').count()).toBeGreaterThan(0);
    return;
  }
  if (
    name.includes('detail') ||
    name.includes('panel') ||
    name.includes('pane') ||
    name.includes('tab') ||
    name.includes('workspace') ||
    name.includes('containers') ||
    name.includes('env ')
  ) {
    await page.locator('.wrow').click();
    await page.locator('.d-head').waitFor({ state: 'visible' });
    expect(await page.locator('.d-head').textContent()).toContain('t1234');
    expect((await page.locator('#actpane').textContent())?.trim()).not.toBe('');
    return;
  }
  expect(await page.locator('.wrow').textContent()).toContain('t1234');
}

describe('the frozen GUI against the in-process Fastify server', () => {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let app: FastifyInstance | null = null;
  let home = '';
  let failures: string[] = [];
  let expectedConsoleError: { pathname: string; status: number } | null = null;
  let sawExpectedConsoleError = false;

  beforeAll(async () => {
    browser = await chromium.launch({
      args: [`--host-resolver-rules=MAP ${PUBLIC_NAME} 127.0.0.1`],
    });
  });

  beforeEach(async () => {
    context = null;
    page = null;
    app = null;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-browser-'));
    process.env.HOUSTON_HOME = home;
    jest.clearAllMocks();
    portedJobs = undefined;
    portedUser = 'alice';
    portedPassword = PASSWORD;
    portedReducedMotion = false;
    surfaceAcmeHosts = [];
    failures = [];
    expectedConsoleError = null;
    sawExpectedConsoleError = false;
  });

  afterEach(async () => {
    const cleanupErrors: string[] = [];
    for (const [label, close] of [
      ['page', page === null ? null : async () => await page?.close()],
      ['context', context === null ? null : async () => await context?.close()],
      ['app', app === null ? null : async () => await app?.close()],
    ] as const) {
      if (close === null) continue;
      try {
        await close();
      } catch (error) {
        cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      if (home !== '') fs.rmSync(home, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(`home: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (app !== null && app.server.listening) cleanupErrors.push('app: listener remained open');
    expect(cleanupErrors).toEqual([]);
    if (expectedConsoleError !== null && !sawExpectedConsoleError) {
      failures.push(
        `expected console resource error was absent: ${String(expectedConsoleError.status)} ${expectedConsoleError.pathname}`,
      );
    }
    expect(failures).toEqual([]);
  });

  afterAll(async () => {
    if (browser !== null) await browser.close();
  });

  test.each(CASES)('%s: %s', async (file, name) => {
    const browserCase: BrowserCase = [file, name];
    configureStubs(browserCase);
    if (process.env.BROWSER_GATE_PROBE === 'stub' && probeCase(file, name)) {
      mockListRepros.mockImplementation(realInspect.listRepros);
    }
    const flow = file === 'flows' ? await prepareFlow(name) : null;
    const portedOptions = portedFile(file) ? await preparePortedCase(file, name) : null;
    const activeApp = await createApp(flow?.options ?? portedOptions ?? { accounts: false });
    app = activeApp;
    await activeApp.listen({ host: '127.0.0.1', port: 0 });
    const address = activeApp.server.address() as AddressInfo;
    const hostname = publicOrigin(file, name) ? PUBLIC_NAME : '127.0.0.1';
    if (browser === null) throw new Error('Chromium did not start');
    const activeContext = await browser.newContext({
      baseURL: `http://${hostname}:${String(address.port)}`,
      ...(portedReducedMotion ? { reducedMotion: 'reduce' as const } : {}),
    });
    context = activeContext;
    const activePage = await activeContext.newPage();
    page = activePage;
    expectedConsoleError =
      name === 'a wrong password shows an error in the page'
        ? { pathname: '/signin', status: 401 }
        : name === 'the env tab shows the refusal rather than an empty table'
          ? { pathname: '/api/repros/t1234/env', status: 409 }
          : name === 'the live chart stops asking when the answer is a refusal'
            ? { pathname: '/api/repros/t1234/stats', status: 409 }
            : name === 'you can change your own password from the browser'
              ? { pathname: '/api/me/password', status: 400 }
              : null;
    activePage.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
    activePage.on('console', (message) => {
      if (message.type() !== 'error') return;
      const location = message.location().url;
      const pathname = location === '' ? '' : new URL(location).pathname;
      if (
        expectedConsoleError !== null &&
        pathname === expectedConsoleError.pathname &&
        message.text().startsWith('Failed to load resource:') &&
        message.text().includes(`status of ${String(expectedConsoleError.status)}`)
      ) {
        sawExpectedConsoleError = true;
        return;
      }
      failures.push(`console: ${message.text()}`);
    });
    activePage.on('requestfailed', (request) => {
      const expectedFinishedJobStream =
        name === 'the seed job shows what it made and whether it was confirmed' &&
        request.method() === 'GET' &&
        new URL(request.url()).pathname.endsWith('/stream') &&
        new URL(request.url()).pathname.includes('/api/jobs/') &&
        request.failure()?.errorText === 'net::ERR_ABORTED';
      if (expectedFinishedJobStream) return;
      failures.push(
        `requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
      );
    });
    activePage.on('response', (response) => {
      const expectedSigninFailure =
        name === 'a wrong password shows an error in the page' &&
        response.status() === 401 &&
        response.url().includes('/signin?e=bad');
      const expectedBehaviorFailure =
        (name === 'a write from the spa survives plain http on a real hostname' &&
          response.request().method() === 'DELETE' &&
          response.status() !== 403) ||
        (name === 'the env tab shows the refusal rather than an empty table' &&
          response.url().endsWith('/env') &&
          response.status() === 409) ||
        (name === 'the live chart stops asking when the answer is a refusal' &&
          response.url().endsWith('/stats') &&
          response.status() === 409) ||
        (name === 'you can change your own password from the browser' &&
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/me/password' &&
          [400, 403].includes(response.status()));
      if (response.status() >= 400 && !expectedSigninFailure && !expectedBehaviorFailure) {
        failures.push(
          `response: ${String(response.status())} ${response.request().method()} ${response.url()}`,
        );
      }
    });
    if (file === 'flows') {
      if (flow === null) throw new Error('flow fixture was not prepared');
      await exerciseFlow(name, activePage, flow.firstRunKey);
      expect(activeApp.server.listening).toBe(true);
      return;
    }
    if (portedFile(file)) {
      await signIn(activePage, portedUser, portedPassword);
      await activePage.locator('#whoami:not([hidden])').waitFor({ state: 'visible' });
      await activePage.locator('#repros').waitFor({ state: 'visible' });
      if (process.env.BROWSER_GATE_PROBE === 'stub' && probeCase(file, name)) {
        for (let attempt = 0; attempt < 30 && mockListRepros.mock.calls.length === 0; attempt += 1)
          await activePage.waitForTimeout(100);
        expect(mockListRepros).toHaveBeenCalled();
        throw new Error(
          'planted service stub bypass: browser reached the real in-process listRepros seam',
        );
      }
      if (process.env.BROWSER_GATE_PROBE === 'pageerror' && probeCase(file, name)) {
        await activePage.evaluate(() => {
          setTimeout(() => {
            throw new Error('planted unexpected page error');
          }, 0);
        });
        await activePage.waitForTimeout(50);
      }
      if (file === 'surfaces chrome') await exerciseChrome(name, activePage);
      else if (file.startsWith('surfaces ')) await exerciseSurface(name, activePage);
      else if (file === 'remote') await exerciseRemote(name, activePage);
      else if (file === 'plain http') await exercisePlain(name, activePage);
      else if (file === 'kubernetes chrome') await exerciseKubernetesChrome(name, activePage);
      else if (file === 'kubernetes dialogs') await exerciseKubernetesDialogs(name, activePage);
      else if (file === 'kubernetes offstage') await exerciseKubernetesOffstage(name);
      else if (file === 'kubernetes pane') await exerciseKubernetesPane(name, activePage);
      else if (file === 'kubernetes panel') await exerciseKubernetesPanel(name, activePage);
      else if (file === 'kubernetes rail') await exerciseKubernetesRail(name, activePage);
      else if (file === 'clusters') await exerciseClusterCase(name, activePage);
      expect(mockListRepros).toHaveBeenCalled();
      expect(activeApp.server.listening).toBe(true);
      return;
    }
    await activePage.goto('/');
    await exercise(browserCase, activePage);
    expect(mockListRepros).toHaveBeenCalled();
    expect(activeApp.server.listening).toBe(true);
  });
});
