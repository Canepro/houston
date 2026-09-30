import * as config from '../../../src/lib/config';
import { metadata } from '../../../src/core/runner/record';

import type * as AdminNS from '../../../src/core/lifecycle/admin';

/**
 * THE admin login every service function goes through.
 *
 * `password=` is not optional here even though `rcapi.login` has a default: the default is
 * the shared loopback `admin123`, and a workspace with a public name has its own -- so
 * omitting it authenticates `pat`, `api`, `seed`, `loadtest`, `monitor`, `upgrade` and
 * readiness with the wrong password and returns a 401 that names nothing.
 */
describe('the admin login', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('passes the workspace password and its Mailpit URL, exactly as earlier releases do', async () => {
    const cases = [
      { name: 'loopback', adminPassword: '', extra: {} },
      { name: 'public', adminPassword: 'generated-per-workspace', extra: {} },
      {
        name: 'mailpit',
        adminPassword: '',
        extra: { [config.EXTRA_MAILPIT_URL]: 'http://localhost:8025' },
      },
    ];
    // What earlier releases handed the login for each case, recorded: an empty workspace
    // password falls back to the shared loopback one.
    const recorded = [
      { root_url: 'http://localhost:3000', password: 'admin123', mailpit: false },
      { root_url: 'http://localhost:3000', password: 'generated-per-workspace', mailpit: false },
      { root_url: 'http://localhost:3000', password: 'admin123', mailpit: true },
    ];

    const captured: { root_url: string; password: string; mailpit: boolean }[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/rcapi', () => ({
      ...jest.requireActual('../../../src/core/rcapi'),
      login: async (rootUrl: string, options: { password?: string; mailpitUrl?: string }) => {
        captured.push({
          root_url: rootUrl,
          password: options.password ?? '',
          // Earlier releases passed no value where this passes `""` for an absent Mailpit
          // URL; both are "no Mailpit", and every consumer tests exactly that.
          mailpit: Boolean(options.mailpitUrl),
        });
        return { token: 't', userId: 'u' };
      },
    }));
    const admin = require('../../../src/core/lifecycle/admin') as typeof AdminNS;
    for (const item of cases) {
      await admin.login(
        metadata({
          name: item.name,
          project: `houston-${item.name}`,
          rcVersion: '8.5.1',
          rootUrl: 'http://localhost:3000',
          hostPort: 3000,
          adminPassword: item.adminPassword,
          extra: item.extra,
        }),
      );
    }
    expect(captured).toEqual(recorded);
  });
});
