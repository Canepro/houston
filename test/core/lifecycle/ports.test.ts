/**
 * `core/lifecycle/ports`: which host port a workspace gets, and what its record says it is.
 */
import type * as ErrorsNS from '../../../src/lib/errors';
import { nullEmit } from '../../../src/lib/events';

import type * as CreateDockerNS from '../../../src/core/lifecycle/create-docker';
import type * as PortsNS from '../../../src/core/lifecycle/ports';
import type * as RecordNS from '../../../src/core/runner/record';
import type * as TypesNS from '../../../src/core/lifecycle/types';
import type * as VersionsNS from '../../../src/lib/versions';

const ISOLATED = [
  '../../../src/core/runner/ports',
  '../../../src/core/runner/paths',
  '../../../src/core/runner/record',
  '../../../src/core/lifecycle/ports',
  '../../../src/core/lifecycle/sizing',
  '../../../src/core/lifecycle/ready',
  '../../../src/lib/versions',
];

afterEach(() => {
  for (const module of ISOLATED) jest.dontMock(module);
  jest.resetModules();
});

describe('picking a host port', () => {
  it('refuses a port another workspace already claims', async () => {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/ports', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/ports'),
      usedPorts: async () => new Set([8300]),
    }));
    const ports = require('../../../src/core/lifecycle/ports') as typeof PortsNS;
    // The class from the SAME registry the fresh module threw from: after `resetModules` an
    // import at the top of this file is a different class object with the same name.
    const { ConflictError } = require('../../../src/lib/errors') as typeof ErrorsNS;
    await expect(
      ports.pickHostPort(8300, { instances: 1 } as Parameters<typeof PortsNS.pickHostPort>[1], ''),
    ).rejects.toThrow(ConflictError);
  });
});

describe('the recorded root_url', () => {
  it('is always the local port, while Rocket.Chat still advertises the override', async () => {
    // A record's root_url is what houston's OWN calls use -- login, PAT, seeding, load tests,
    // and `ready`, which polls it. `--root-url` used to displace it with a public https name,
    // and `ready` then waited 300s on DNS while localhost answered 200 the whole time.
    const written: { yaml: string; meta: RecordNS.Metadata }[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/runner/paths', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/paths'),
      exists: async () => false,
    }));
    jest.doMock('../../../src/core/lifecycle/sizing', () => ({
      ...jest.requireActual<object>('../../../src/core/lifecycle/sizing'),
      checkCapacity: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual<object>('../../../src/core/lifecycle/ports'),
      checkSidecarPorts: async () => undefined,
      pickHostPort: async () => 3001,
    }));
    jest.doMock('../../../src/lib/versions', () => {
      const actual = jest.requireActual<typeof VersionsNS>('../../../src/lib/versions');
      return {
        ...actual,
        resolve: (version: string) => actual.resolve(version, { offline: true }),
      };
    });
    jest.doMock('../../../src/core/runner/record', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/record'),
      write: async (_name: string, yaml: string, meta: RecordNS.Metadata) => {
        written.push({ yaml, meta });
      },
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual<object>('../../../src/core/lifecycle/ready'),
      upCompose: async () => 0,
    }));
    const { createRepro } =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const { createReq } = require('../../../src/core/lifecycle/types') as typeof TypesNS;

    await createRepro(
      createReq({
        version: '8.5.1',
        name: 'urlcase',
        rootUrl: 'https://lab.example.com',
        wait: false,
        offline: true,
      }),
      nullEmit,
    );

    expect(written).toHaveLength(1);
    expect(written[0]?.meta.rootUrl).toBe('http://localhost:3001');
    // ...or `--root-url` would do nothing at all.
    expect(written[0]?.yaml).toContain('ROOT_URL: https://lab.example.com');
  });
});

describe('a port block past the top of the range', () => {
  it('is refused as a validation error, not truncated', async () => {
    // Three instances need a four-port block, and 65535 has no room for one.
    jest.resetModules();
    const ports = require('../../../src/core/lifecycle/ports') as typeof PortsNS;
    const { ValidationError } = require('../../../src/lib/errors') as typeof ErrorsNS;
    await expect(
      ports.pickHostPort(65535, { instances: 3 } as Parameters<typeof PortsNS.pickHostPort>[1], ''),
    ).rejects.toThrow(ValidationError);
  });
});
