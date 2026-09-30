jest.mock('../../../src/core/lifecycle/naming', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/naming'),
  resolveName: jest.fn(async () => 'k'),
}));
jest.mock('../../../src/core/topology', () => ({
  ...jest.requireActual('../../../src/core/topology'),
  ofRepro: jest.fn(async () => 'kubernetes'),
}));
jest.mock('../../../src/core/runner/engine', () => ({
  ...jest.requireActual('../../../src/core/runner/engine'),
  stream: jest.fn(async () => {
    throw new Error('compose must not be asked about a Kubernetes workspace');
  }),
}));
jest.mock('../../../src/core/runner/record', () => ({
  ...jest.requireActual('../../../src/core/runner/record'),
  readMeta: jest.fn(async () => ({ name: 'k', extra: { context: 'ctx' } })),
}));
jest.mock('../../../src/core/kube/status', () => ({
  ...jest.requireActual('../../../src/core/kube/status'),
  logProcess: jest.fn(),
}));

import * as kubeStatus from '../../../src/core/kube/status';
import * as engine from '../../../src/core/runner/engine';
import { createApp } from '../../../src/web/app';

describe('the REST log route', () => {
  it('asks the pods about a Kubernetes workspace, like the WebSocket route does', async () => {
    // The WebSocket handler dispatched on topology and the REST route beside it did not,
    // so the same workspace had a streaming view that worked and a REST one that answered
    // compose's "no configuration file provided".
    jest.mocked(kubeStatus.logProcess).mockImplementation(async (_name, options) => {
      options.onLine?.('pod line one');
      options.onLine?.('pod line two');
      return { code: 0, stdout: '', stderr: '' } as never;
    });
    const app = await createApp({ accounts: false });
    try {
      const response = await app.inject({ url: '/api/repros/k/logs' });
      expect(response.statusCode).toBe(200);
      expect(response.json().logs).toBe('pod line one\npod line two');
      const options = jest.mocked(kubeStatus.logProcess).mock.calls[0]?.[1];
      expect(options?.context).toBe('ctx');
      expect(options?.follow).toBe(false);
      expect(engine.stream).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
