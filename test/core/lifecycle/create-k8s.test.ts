import * as config from '../../../src/lib/config';
import { nullEmit } from '../../../src/lib/events';

import { kubeCreate, settleAddressing } from '../../../src/core/lifecycle/create-k8s';
import { missingMonitorAttach } from '../../../src/core/lifecycle/request';
import { createReq } from '../../../src/core/lifecycle/types';

interface Settled {
  reg_token: string;
  bind_host: string;
  root: string;
  microservices: boolean;
  preset: string;
}

function ours(req: Parameters<typeof kubeCreate>[0]['req']): Settled {
  const job = kubeCreate({ req, emit: nullEmit, monitorAttach: missingMonitorAttach });
  settleAddressing(job);
  return {
    reg_token: job.regToken,
    bind_host: job.bindHost,
    root: job.root,
    microservices: job.microservices,
    preset: job.presetForNotes?.name ?? '',
  };
}

describe('settling a Kubernetes create', () => {
  it('reads a falsy recorded token as no token, exactly as earlier releases do', () => {
    // A config key holding `false` (or `0`) is NOT the string "false". `String(false)`
    // would make it a truthy licence token, which then reaches the chart through a
    // Secret -- the one field `--reg-token` exists to keep deliberate.
    config.updateConfig((cfg) => {
      cfg.reg_token = false;
      cfg.bind_host = false;
    });
    // What earlier releases settled each request to, over the same config, recorded.
    const recorded: Settled[] = [
      {
        reg_token: '',
        bind_host: '127.0.0.1',
        root: 'http://localhost:0',
        microservices: false,
        preset: 'default',
      },
      {
        reg_token: 'explicit',
        bind_host: '0.0.0.0',
        root: 'http://localhost:0',
        microservices: false,
        preset: 'default',
      },
    ];
    expect([
      ours(createReq({ version: '8.5.1' })),
      ours(createReq({ version: '8.5.1', regToken: 'explicit', bind: '0.0.0.0' })),
    ]).toEqual(recorded);
    expect(ours(createReq({ version: '8.5.1' })).reg_token).toBe('');
  });
});
