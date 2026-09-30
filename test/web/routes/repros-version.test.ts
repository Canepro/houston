jest.mock('../../../src/core/rcapi', () => ({
  ...jest.requireActual('../../../src/core/rcapi'),
  releaseInfo: jest.fn(async () => ({
    status: 200,
    json: () => ({ compatibleMongoVersions: ['7.0'] }),
  })),
}));
jest.mock('../../../src/core/lifecycle/create-docker', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/create-docker'),
  createRepro: jest.fn(
    async (_request: unknown, _emit: unknown, options: Record<string, unknown>) => {
      const fetcher = options.versionFetcher as (() => unknown) | undefined;
      return { request: _request, release: fetcher?.() };
    },
  ),
}));

import * as rcapi from '../../../src/core/rcapi';
import { createApp } from '../../../src/web/app';

describe('live version resolution at the web front door', () => {
  it('leaves the release lookup to the job, and hands it the request as given', async () => {
    // The route prefetched the release document ahead of the job's own refusals; earlier
    // releases' create looks it up inside the job, where the pairing is resolved.
    const app = await createApp({ accounts: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/repros',
        payload: {
          version: '8.5.1',
          preset: null,
          rc_image: false,
          bind: false,
          reg_token: 0,
          context: false,
          offline: [],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(await app.jobs.drain()).toEqual([]);
      expect(app.jobs.get(response.json().job_id as string)?.result).toEqual({
        request: expect.objectContaining({
          rcImage: false,
          bind: false,
          regToken: 0,
          context: false,
          offline: [],
          preset: null,
        }),
        release: undefined,
      });
      expect(rcapi.releaseInfo).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('preserves an accepted untyped create label instead of JavaScript-stringifying it', async () => {
    const app = await createApp({ accounts: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/repros',
        payload: { version: '8.5.1', name: true, offline: true },
      });
      expect(response.statusCode).toBe(200);
      expect(await app.jobs.drain()).toEqual([]);
      expect(app.jobs.get(response.json().job_id as string)?.summary().label).toBe(true);
    } finally {
      await app.close();
    }
  });
});
