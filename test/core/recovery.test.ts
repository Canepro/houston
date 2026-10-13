import * as journal from '../../src/core/journal';
import { install } from '../../src/core/recovery';
import type * as recoveryNS from '../../src/core/recovery';

/** The handler set earlier releases answered after install, sorted and joined, recorded. */
const RECORDED_KINDS =
  'bench_workspace,constraints_applied,e2ee_default_off,email_2fa_off,mongo_profiler_on,' +
  'rate_limiter_off,rc_metrics_on,rocketchat_stopped';

describe('the recovery registry', () => {
  it('installs every repair handler earlier releases install, and no more', async () => {
    // The evidence: this build answers the same handler set after install as earlier
    // releases did, which is only possible if every side-effect owner registers its
    // handler here too.
    install();
    expect(journal.repairKinds().join(',')).toBe(RECORDED_KINDS);
    expect(journal.repairKinds()).toEqual([
      'bench_workspace',
      'constraints_applied',
      'e2ee_default_off',
      'email_2fa_off',
      'mongo_profiler_on',
      'rate_limiter_off',
      'rc_metrics_on',
      'rocketchat_stopped',
    ]);
  });

  it('is idempotent, so a second startup cannot throw on an owned kind', () => {
    install();
    expect(() => {
      install();
    }).not.toThrow();
  });

  it('installs before delegating, so a caller cannot forget the extensions', async () => {
    // Before `install()`, the recovery core on its own knows only what happened to be
    // imported. `recover()` must answer with the full set without a separate call.
    jest.resetModules();
    const fresh = require('../../src/core/journal') as typeof journal;
    const recovery = require('../../src/core/recovery') as typeof recoveryNS;
    const rows = await recovery.recover();
    expect(Array.isArray(rows)).toBe(true);
    expect(fresh.repairKinds()).toContain('rocketchat_stopped');
    jest.resetModules();
    install();
  });
});
