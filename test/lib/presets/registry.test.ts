import {
  DYNAMIC_PRESETS,
  REGISTRY,
  builders,
  register,
  registerScenario,
  scenarios,
} from '../../../src/lib/presets/registry';

import type * as ModNS from '../../../src/lib/presets/registry';

/** The dynamic preset names earlier releases register, sorted, as they reported them. */
const RECORDED_BUILDERS = [
  'email',
  'ldap',
  'livechat',
  'multi-instance',
  'oidc',
  's3_minio',
  'saml',
];

describe('the leaf registry', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('holds exactly the builders earlier releases hold', () => {
    // Loading the LOADER is what registers them: the import points downward, from the
    // loader to the registry, never from the registry up to its owners.
    require('../../../src/lib/presets/index');
    expect(Object.keys(builders()).sort()).toEqual(RECORDED_BUILDERS);
  });

  it('refuses to answer at all while an owner is missing', () => {
    // A half-registered catalogue is the failure mode this check exists for: a caller
    // that got six of seven would render a preset list missing one and report success.
    jest.resetModules();
    const fresh = require('../../../src/lib/presets/registry') as typeof ModNS;
    expect(() => fresh.builders()).toThrow('preset modules did not register builders');
    expect(() => fresh.scenarios()).toThrow('preset modules did not register builders');
  });

  it('refuses a second registration under a name it already holds', () => {
    jest.resetModules();
    const fresh = require('../../../src/lib/presets/registry') as typeof ModNS;
    const build = () => {
      throw new Error('never called');
    };
    fresh.register('x', build);
    expect(() => {
      fresh.register('x', build);
    }).toThrow("preset builder 'x' is already registered");
    fresh.registerScenario('x', {});
    expect(() => {
      fresh.registerScenario('x', {});
    }).toThrow("preset scenario 'x' is already registered");
  });

  it('names the same seven dynamic presets earlier releases name', () => {
    expect([...DYNAMIC_PRESETS].sort()).toEqual(RECORDED_BUILDERS);
  });

  it('hands back a COPY, so a caller cannot edit the catalogue', () => {
    require('../../../src/lib/presets/index');
    const copy = builders();
    delete copy.saml;
    expect(Object.keys(REGISTRY)).toContain('saml');
    const scen = scenarios();
    delete scen.ldap;
    expect(Object.keys(scenarios())).toContain('ldap');
  });

  it('registers exactly one scenario, which is ldap', () => {
    require('../../../src/lib/presets/index');
    expect(Object.keys(scenarios()).sort()).toEqual(['ldap']);
  });

  // `register` is exercised by every builder module at import; naming it here keeps the
  // import from reading as unused to a reader skimming the file.
  it('exposes the two registration entry points the builders call', () => {
    expect(typeof register).toBe('function');
    expect(typeof registerScenario).toBe('function');
  });
});
