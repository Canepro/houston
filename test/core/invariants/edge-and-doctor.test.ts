/**
 * INVARIANT: a route names a container, and every doctor row carries a watchable id.
 *
 * MECHANISM: BEHAVIOURAL.
 *
 * Earlier releases' route guard was a search of the source for the name of the helper that
 * computes the backend -- a name, not a URL, and true of a module that computed one and then
 * used something else. The route file is a value; the
 * backend it names is in it.
 */
import type * as nodeFsNS from 'node:fs';
import type * as nodeOsNS from 'node:os';
import type * as nodePathNS from 'node:path';

import type * as DoctorNS from '../../../src/core/doctor';
import type * as RouteYmlNS from '../../../src/core/edge/routeyml';

afterEach(() => {
  jest.resetModules();
});

describe('an edge route', () => {
  it('addresses the container and never the service alias', async () => {
    const routeyml = require('../../../src/core/edge/routeyml') as typeof RouteYmlNS;
    const yml = await routeyml.workspaceRouteYml('w1', 'w1.houston.localhost', { local: true });
    // EVERY workspace calls its service `rocketchat`, and from an edge attached to many
    // such networks the bare name resolves deterministically to ONE of them -- which looks
    // stable under testing and would silently serve the wrong workspace for ever.
    expect(yml).toContain('houston-w1-rocketchat-1');
    expect(yml).not.toMatch(/http:\/\/rocketchat:/u);
  });

  it('names every instance of a multi-instance workspace, still by container', async () => {
    const routeyml = require('../../../src/core/edge/routeyml') as typeof RouteYmlNS;
    const yml = await routeyml.workspaceRouteYml('w2', 'w2.houston.localhost', { instances: 3 });
    expect(yml).toContain('houston-w2-rocketchat-1');
    expect(yml).toContain('houston-w2-rocketchat-2-1');
    expect(yml).not.toMatch(/http:\/\/rocketchat:/u);
  });
});

describe('a home houston cannot write', () => {
  it('is reported as home-writable rather than blamed on kind', async () => {
    const fs = require('node:fs') as typeof nodeFsNS;
    const path = require('node:path') as typeof nodePathNS;
    const os = require('node:os') as typeof nodeOsNS;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-invariant-ro-'));
    const previous = process.env.HOUSTON_HOME;
    fs.chmodSync(home, 0o500);
    process.env.HOUSTON_HOME = home;
    try {
      const doctor = require('../../../src/core/doctor') as typeof DoctorNS;
      const rows = await doctor.checkIdentity({
        context: '',
        dockerUp: false,
        cloud: null,
        owned: null,
      });
      const hits = rows.filter((row) => row.check === 'home-writable');
      // A read-only HOUSTON_HOME passed `doctor` and surfaced as a KIND problem: the error
      // came out of the kind probe, which writes houston's own kubeconfig directory, and
      // was attributed to Docker. The symptom was found and blamed on the wrong thing.
      expect(hits.length).toBe(1);
      expect(hits[0]?.status).toBe('fail');
      expect(String(hits[0]?.message)).toContain('not writable');
      expect(doctor.CHECKS).toContain('home-writable');
    } finally {
      fs.chmodSync(home, 0o700);
      fs.rmSync(home, { recursive: true, force: true });
      if (previous === undefined) delete process.env.HOUSTON_HOME;
      else process.env.HOUSTON_HOME = previous;
    }
  });

  it('says nothing about writability when the home is writable', async () => {
    const doctor = require('../../../src/core/doctor') as typeof DoctorNS;
    const rows = await doctor.checkIdentity({
      context: '',
      dockerUp: false,
      cloud: null,
      owned: null,
    });
    expect(rows.filter((row) => row.check === 'home-writable')).toEqual([]);
    // And every row it DOES file carries an id a caller can watch, which is the published
    // half of `doctor --json`: without one a caller can count failures and nothing else.
    for (const row of rows) {
      expect(`${String(row.check)} declared`).toBe(
        (doctor.CHECKS as readonly string[]).includes(String(row.check))
          ? `${String(row.check)} declared`
          : `${String(row.check)} UNDECLARED`,
      );
      expect(['ok', 'warn', 'fail']).toContain(row.status);
    }
  });
});
