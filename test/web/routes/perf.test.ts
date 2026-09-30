jest.mock('../../../src/core/loadtest', () => ({
  ...jest.requireActual('../../../src/core/loadtest'),
  runLoadtest: jest.fn(async (request: unknown) => request),
  runCapacity: jest.fn(async (request: unknown) => request),
}));
jest.mock('../../../src/core/lifecycle/naming', () => ({
  resolveName: async (name: string) => name,
}));
jest.mock('../../../src/core/monitor', () => ({
  ...jest.requireActual('../../../src/core/monitor'),
  attach: jest.fn(async () => ({})),
  detach: jest.fn(async () => ({})),
}));

import * as loadtest from '../../../src/core/loadtest';
import * as monitor from '../../../src/core/monitor';
import { createApp } from '../../../src/web/app';

describe('performance request fields', () => {
  it("maps earlier releases' field names and preserves valid zero and false values", async () => {
    const app = await createApp({ accounts: false });
    try {
      const load = await app.inject({
        method: 'POST',
        url: '/api/repros/demo/loadtest',
        payload: { users_n: 0, vus: 0, diag: false, stats: false, live: false, slowms: 0 },
      });
      const capacity = await app.inject({
        method: 'POST',
        url: '/api/repros/demo/capacity',
        payload: { users_n: 0, start: 0, max_vus: 0, step_duration: '' },
      });
      expect(load.statusCode).toBe(200);
      expect(capacity.statusCode).toBe(200);
      expect(await app.jobs.drain()).toEqual([]);
      expect(app.jobs.get(load.json().job_id as string)?.result).toEqual(
        expect.objectContaining({
          name: 'demo',
          usersN: 0,
          vus: 0,
          diag: false,
          stats: false,
          live: false,
          slowms: 0,
        }),
      );
      expect(app.jobs.get(capacity.json().job_id as string)?.result).toEqual(
        expect.objectContaining({
          name: 'demo',
          usersN: 0,
          start: 0,
          maxVus: 0,
          stepDuration: '',
        }),
      );
    } finally {
      await app.close();
    }
  });
});

describe('the performance endpoints', () => {
  it('runs a load test as a job, and only the known fields reach the request', async () => {
    // An unknown field is dropped, not refused and not carried: the request is built field by field
    // from earlier releases' field names, so nothing a caller invents can reach the runner.
    const app = await createApp({ accounts: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/repros/x/loadtest',
        payload: { scenario: 'journey', vus: 20, bogus: 'drop' },
      });
      expect(response.statusCode).toBe(200);
      const id = String(response.json().job_id);
      expect(id).toMatch(/^job_/u);
      expect(await app.jobs.drain()).toEqual([]);
      expect(jest.mocked(loadtest.runLoadtest)).toHaveBeenCalledTimes(1);
      const request = app.jobs.get(id)?.result as Record<string, unknown>;
      expect(request).toMatchObject({ name: 'x', scenario: 'journey', vus: 20 });
      expect(request).not.toHaveProperty('bogus');
    } finally {
      await app.close();
    }
  });

  it('attaches the monitor, and detaches it when asked with off', async () => {
    const app = await createApp({ accounts: false });
    try {
      for (const off of ['false', 'true']) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/repros/x/monitor?off=${off}`,
        });
        expect(response.statusCode).toBe(200);
        expect(String(response.json().job_id)).toMatch(/^job_/u);
      }
      expect(await app.jobs.drain()).toEqual([]);
      expect(jest.mocked(monitor.attach).mock.calls.map((call) => call[0])).toEqual(['x']);
      expect(jest.mocked(monitor.detach).mock.calls.map((call) => call[0])).toEqual(['x']);
      expect(app.jobs.listJobs().map((job) => job.kind)).toEqual(['monitor-off', 'monitor']);
    } finally {
      await app.close();
    }
  });
});
