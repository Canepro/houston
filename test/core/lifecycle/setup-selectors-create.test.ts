/** Saved setup defaults must choose the same workspace lock and recovery journal as explicit axes. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as config from '../../../src/lib/config';
import { createRepro } from '../../../src/core/lifecycle/create-docker';
import { createReq } from '../../../src/core/lifecycle/types';
import { reqContext } from '../../../src/core/lifecycle/request';
import { openEntries } from '../../../src/core/journal';
import { lockPath } from '../../../src/core/runner/locks';
import { metadata, writeRecord } from '../../../src/core/runner/record';
import { holdsFileLock } from '../../../src/seams/fs/lock';
import type * as CreateK8sNS from '../../../src/core/lifecycle/create-k8s';

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
