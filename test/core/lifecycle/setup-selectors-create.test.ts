/** Saved setup defaults must choose the same workspace lock and recovery journal as explicit axes. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as config from '../../../src/lib/config';
import { ConflictError } from '../../../src/lib/errors';
import { createRepro } from '../../../src/core/lifecycle/create-docker';
import { createReq, type CreateReq } from '../../../src/core/lifecycle/types';
import { reqContext } from '../../../src/core/lifecycle/request';
import { openEntries } from '../../../src/core/journal';
import {
  makeTool,
  preflight as preflightReport,
  type Preflight,
} from '../../../src/core/kube/tools';
import { lockPath } from '../../../src/core/runner/locks';
import { metadata, writeRecord } from '../../../src/core/runner/record';
import { holdsFileLock } from '../../../src/seams/fs/lock';
import type * as ContextNS from '../../../src/core/kube/context';
import type * as ProbeNS from '../../../src/core/kube/probe';
import type * as ReachabilityNS from '../../../src/core/kube/reachability';
import type * as RunnerPortsNS from '../../../src/core/runner/ports';
import type * as CreateK8sNS from '../../../src/core/lifecycle/create-k8s';

let mockPlanCluster: ((context?: string) => Promise<ContextNS.ClusterPlan>) | null = null;
let mockPreflight: (() => Promise<Preflight>) | null = null;
let mockHelmReachable: ((context?: string) => Promise<string>) | null = null;
let mockPortFree: ((port: number, host?: string) => Promise<boolean>) | null = null;

jest.mock('../../../src/core/kube/probe', () => {
  const actual = jest.requireActual<typeof ProbeNS>('../../../src/core/kube/probe');
  return {
    ...actual,
    preflight: () => (mockPreflight ?? actual.preflight)(),
  };
});
jest.mock('../../../src/core/kube/context', () => {
  const actual = jest.requireActual<typeof ContextNS>('../../../src/core/kube/context');
  return {
    ...actual,
    planCluster: (context = '') => (mockPlanCluster ?? actual.planCluster)(context),
  };
});
jest.mock('../../../src/core/kube/reachability', () => {
  const actual = jest.requireActual<typeof ReachabilityNS>('../../../src/core/kube/reachability');
  return {
    ...actual,
    helmReachable: (context?: string) => (mockHelmReachable ?? actual.helmReachable)(context),
  };
});
jest.mock('../../../src/core/runner/ports', () => {
  const actual = jest.requireActual<typeof RunnerPortsNS>('../../../src/core/runner/ports');
  return {
    ...actual,
    portFree: (port: number, host = '') => (mockPortFree ?? actual.portFree)(port, host),
  };
});
jest.mock('../../../src/core/lifecycle/create-k8s', () => ({
  ...jest.requireActual<typeof CreateK8sNS>('../../../src/core/lifecycle/create-k8s'),
  createKubernetes: jest.fn(),
}));
import { createKubernetes } from '../../../src/core/lifecycle/create-k8s';

it('uses the effective saved scenario name for the lock and unfinished journal before runtime work', async () => {
  config.saveConfig({
    default_deployment: 'microservices',
    default_scenarios: ['email'],
    [config.KUBE_CONTEXT_KEY]: 'shared-remote',
  });
  const seen: {
    preset: string;
    journal: string[];
    lock: boolean;
    implicit: boolean;
    context: string;
  }[] = [];
  jest.mocked(createKubernetes).mockImplementation(async (req) => {
    seen.push({
      preset: req.preset,
      journal: openEntries().map((entry) => entry.workspace),
      lock: holdsFileLock(lockPath('rc8-6-1-email')),
      implicit: req.implicitOwnedLocal,
      context: reqContext(req),
    });
    throw new Error('runtime boundary');
  });
  for (const selectors of [{ preset: '' }, { preset: 'email', deployment: 'microservices' }]) {
    await expect(createRepro(createReq({ version: '8.6.1', ...selectors }))).rejects.toThrow(
      'runtime boundary',
    );
  }
  expect(seen).toEqual([
    { preset: 'email', journal: ['rc8-6-1-email'], lock: true, implicit: true, context: '' },
    {
      preset: 'email',
      journal: ['rc8-6-1-email'],
      lock: true,
      implicit: false,
      context: config.defaultKubeContext(),
    },
  ]);
  expect(openEntries()).toEqual([]);
  expect(fs.existsSync(lockPath('rc8-6-1'))).toBe(false);
});

it('keeps an existing derived workspace on its recorded axes before applying changed setup defaults', async () => {
  config.saveConfig({ default_deployment: 'microservices', default_scenarios: ['email'] });
  await writeRecord(
    'rc8-6-1',
    metadata({
      name: 'rc8-6-1',
      project: 'houston-rc8-6-1',
      preset: 'ldap',
      extra: { runtime: 'kubernetes', deployment: 'monolith', context: 'recorded-context' },
    }),
  );
  jest.mocked(createKubernetes).mockImplementation(async (req) => {
    expect(req).toMatchObject({
      preset: 'ldap',
      runtime: 'kubernetes',
      deployment: 'monolith',
      implicitOwnedLocal: false,
    });
    expect(reqContext(req)).toBe('recorded-context');
    expect(holdsFileLock(lockPath('rc8-6-1'))).toBe(true);
    expect(openEntries().map((entry) => entry.workspace)).toEqual(['rc8-6-1']);
    throw new Error('existing runtime boundary');
  });
  await expect(createRepro(createReq({ version: '8.6.1', preset: '' }))).rejects.toThrow(
    'existing runtime boundary',
  );
  expect(fs.existsSync(path.join(config.home(), 'repros', 'rc8-6-1-email'))).toBe(false);
});

/**
 * `planClusterStep` is the remote-context guard. `helmReachable` is the first cluster
 * probe after that guard, and `ensureKubeconfig` does not create a cluster for a context
 * Houston does not own. Stopping there shows whether the guard refused the reuse.
 */
const STOPPED_AFTER_REMOTE_GUARD = 'stopped after remote-context guard';
const RECORDED_REMOTE = 'recorded-remote';
const SAVED_REMOTE = 'shared-remote';

function toolsPresent(): Preflight {
  return preflightReport({
    tools: {
      kubectl: makeTool({ name: 'kubectl', path: '/usr/bin/kubectl', version: [1, 36] }),
      helm: makeTool({ name: 'helm', path: '/usr/bin/helm', version: [3, 15] }),
    },
  });
}

function removeRepro(name: string): void {
  fs.rmSync(path.join(config.home(), 'repros', name), { recursive: true, force: true });
}

function flaglessUp(): CreateReq {
  return createReq({
    version: '8.6.1',
    preset: '',
    runtime: '',
    context: '',
    deployment: '',
    offline: true,
  });
}

function installRealCreateBoundary(savedRemote: string): {
  planned: string[];
  axesAtCreate: Pick<
    CreateReq,
    'runtime' | 'deployment' | 'preset' | 'context' | 'implicitOwnedLocal'
  > | null;
  atGuard: { journal: string[]; emailLock: boolean } | null;
} {
  const planned: string[] = [];
  const seen: {
    axesAtCreate: Pick<
      CreateReq,
      'runtime' | 'deployment' | 'preset' | 'context' | 'implicitOwnedLocal'
    > | null;
    atGuard: { journal: string[]; emailLock: boolean } | null;
  } = { axesAtCreate: null, atGuard: null };
  mockPreflight = () => Promise.resolve(toolsPresent());
  mockPortFree = () => Promise.resolve(true);
  mockPlanCluster = (requested = '') => {
    planned.push(requested);
    return Promise.resolve({
      context: requested || savedRemote,
      distribution: 'k3s',
      create: false,
    });
  };
  mockHelmReachable = () => {
    seen.atGuard = {
      journal: openEntries().map((entry) => entry.workspace),
      emailLock: holdsFileLock(lockPath('rc8-6-1-email')),
    };
    return Promise.reject(new Error(STOPPED_AFTER_REMOTE_GUARD));
  };
  const actual = jest.requireActual<typeof CreateK8sNS>('../../../src/core/lifecycle/create-k8s');
  jest.mocked(createKubernetes).mockImplementation((req, emit, options) => {
    seen.axesAtCreate = {
      runtime: req.runtime,
      deployment: req.deployment,
      preset: req.preset,
      context: req.context,
      implicitOwnedLocal: req.implicitOwnedLocal,
    };
    return actual.createKubernetes(req, emit, options);
  });
  return {
    planned,
    get axesAtCreate() {
      return seen.axesAtCreate;
    },
    get atGuard() {
      return seen.atGuard;
    },
  };
}

it('reuses a remote workspace that exists only under the saved scenario suffix on its recorded context', async () => {
  removeRepro('rc8-6-1');
  config.saveConfig({
    default_deployment: 'microservices',
    default_scenarios: ['email'],
    [config.KUBE_CONTEXT_KEY]: SAVED_REMOTE,
  });
  await writeRecord(
    'rc8-6-1-email',
    metadata({
      name: 'rc8-6-1-email',
      project: 'houston-rc8-6-1-email',
      preset: 'email',
      extra: {
        runtime: 'kubernetes',
        deployment: 'monolith',
        context: RECORDED_REMOTE,
      },
    }),
  );
  const boundary = installRealCreateBoundary(SAVED_REMOTE);
  await expect(createRepro(flaglessUp())).rejects.toThrow(STOPPED_AFTER_REMOTE_GUARD);
  expect(boundary.axesAtCreate).toEqual({
    runtime: 'kubernetes',
    deployment: 'monolith',
    preset: 'email',
    context: RECORDED_REMOTE,
    implicitOwnedLocal: false,
  });
  expect(boundary.planned).toContain(RECORDED_REMOTE);
  expect(boundary.atGuard).toEqual({
    journal: ['rc8-6-1-email'],
    emailLock: true,
  });
  expect(fs.existsSync(path.join(config.home(), 'repros', 'rc8-6-1'))).toBe(false);
  expect(openEntries()).toEqual([]);
});

it('refuses a new workspace when saved microservices would plan a remote context', async () => {
  removeRepro('rc8-6-1');
  removeRepro('rc8-6-1-email');
  config.saveConfig({
    default_deployment: 'microservices',
    default_scenarios: ['email'],
    [config.KUBE_CONTEXT_KEY]: SAVED_REMOTE,
  });
  const boundary = installRealCreateBoundary(SAVED_REMOTE);
  await expect(createRepro(flaglessUp())).rejects.toThrow(
    new ConflictError(
      "saved microservices default requires Houston's owned local Kind cluster; " +
        `'${SAVED_REMOTE}' needs an explicit --context choice.`,
    ),
  );
  expect(boundary.axesAtCreate).toMatchObject({
    deployment: 'microservices',
    preset: 'email',
    implicitOwnedLocal: true,
  });
  expect(boundary.atGuard).toBeNull();
  expect(fs.existsSync(path.join(config.home(), 'repros', 'rc8-6-1-email'))).toBe(false);
  expect(openEntries()).toEqual([]);
});
