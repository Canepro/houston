jest.mock('../../../src/core/lifecycle/naming', () => ({
  resolveName: async (name: string) => name,
}));
jest.mock('../../../src/core/lifecycle/preconditions', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
  requireEngine: jest.fn(async () => undefined),
}));
jest.mock('../../../src/core/lifecycle/admin', () => ({
  login: jest.fn(async () => ({ token: 'admin-token', userId: 'admin-id' })),
}));
jest.mock('../../../src/core/runner/record', () => ({
  ...jest.requireActual('../../../src/core/runner/record'),
  adminPass: () => 'admin123',
  readMeta: jest.fn(async () => ({ name: 'demo', rootUrl: 'http://127.0.0.1:3000' })),
}));
jest.mock('../../../src/core/rcapi', () => ({
  ...jest.requireActual('../../../src/core/rcapi'),
  call: jest.fn(async () => [200, '{}']),
}));

import * as rcapi from '../../../src/core/rcapi';
import { createApp } from '../../../src/web/app';

const mockCall = jest.mocked(rcapi.call);

describe('the Rocket.Chat API console route', () => {
  it('treats JSON null as no body, as earlier releases do, and omits the request body', async () => {
    const app = await createApp({ accounts: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/repros/demo/call',
        payload: { path: '/api/v1/info', data: 'null' },
      });
      expect(response.statusCode).toBe(200);
      expect(mockCall).toHaveBeenCalledWith(
        'http://127.0.0.1:3000',
        'GET',
        '/api/v1/info',
        expect.any(Object),
      );
      const options = mockCall.mock.calls[0]?.[3];
      expect(options).toBeDefined();
      expect(Object.hasOwn(options as object, 'data')).toBe(false);
    } finally {
      await app.close();
    }
  });
});
