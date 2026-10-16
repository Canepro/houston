import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../../src/lib/config';
import type * as PolicyNS from '../../testsetup-policy';
import { type Metadata, metadata, readCompose, write } from '../../../src/core/runner/record';

import type * as InspectNS from '../../../src/core/lifecycle/inspect';
import type * as PayloadNS from '../../../src/core/lifecycle/payload';
import { envRows, since } from '../../../src/core/lifecycle/payload';

/** Numbers are normalised because the recorded run read the clock too; the UNIT is the contract. */
const shape = (value: string) => value.replace(/\d+/gu, '<n>');

describe("the panel's pure helpers", () => {
  it('phrases a relative time the way earlier releases do', () => {
    const stamps = [
      '2001-01-01T00:00:00Z',
      '2001-01-01T00:00:00+00:00',
      '2001-01-01 00:00:00+00:00',
      'not-a-date',
      '2999-01-01T00:00:00Z',
      '2001-01-01T00:00:00.500+02:30',
      '',
    ];
    // What earlier releases phrased each stamp as, digits normalised, recorded.
    const recorded = ['<n> days', '<n> days', '<n> days', '', '', '<n> days', ''];
    expect(stamps.map((stamp) => shape(since(stamp)))).toEqual(recorded);
    // A timestamp earlier releases cannot parse at all is "", never a guess.
    expect(since('not-a-date')).toBe('');
    expect(since('')).toBe('');
    expect(since('2999-01-01T00:00:00Z')).toBe('');
  });

  it('builds the env table exactly as earlier releases do, credentials masked', () => {
    const dictDoc = {
      services: {
        rocketchat: {
          environment: {
            MONGO_URL: 'mongodb://user:secret@mongo:27017/rocketchat',
            REG_TOKEN: 'licence-token',
            PLAIN: 'v',
            EMPTY: '',
          },
        },
      },
    };
    const listDoc = {
      services: {
        'rocketchat-1': {
          environment: ['A=1', 'B=with=equals', 'C', 'PASSWORD_KEY=x'],
        },
      },
    };
    // What earlier releases built for each document, recorded.
    const recorded = [
      [
        { key: 'EMPTY', value: '', override: false },
        {
          key: 'MONGO_URL',
          value: 'mongodb://user:********@mongo:27017/rocketchat',
          override: false,
        },
        { key: 'PLAIN', value: 'v', override: true },
        { key: 'REG_TOKEN', value: '********', override: false },
      ],
      [
        { key: 'A', value: '1', override: false },
        { key: 'B', value: 'with=equals', override: false },
        { key: 'C', value: '', override: false },
        { key: 'PASSWORD_KEY', value: '********', override: false },
      ],
      [],
      [],
    ];
    expect([
      envRows(dictDoc, { PLAIN: 'override' }),
      envRows(listDoc),
      envRows({}),
      envRows({ services: { rocketchat: { environment: 7 } } }),
    ]).toEqual(recorded);
  });

  it("shows a compose file's env as earlier releases showed it, typed values and all", async () => {
    // Read and rendered the way `info --json` does it. Earlier releases read the file with a
    // YAML 1.1 loader and showed each typed value as its own text: `yes` is True, `~` is None,
    // and a bare `1e8` is a string, which was 100000000 here. Left out: a float that is a
    // whole number (`3.0` is `3` across JSON) and a timestamp with an offset, whose text the
    // loader normalises.
    const hand =
      'services:\n  rocketchat:\n    environment:\n      A: yes\n      B: ~\n      C: .inf\n' +
      '      D: 010\n      E: 1.5\n      F: 22:22\n      G: -.inf\n      H: .nan\n      I: 1e8\n' +
      '      J: 0o17\n      K: 2026-01-01\n      L: 2026-01-01 10:00:00\n      M: -.5\n';
    await write('typed', hand, metadata({ name: 'typed' }));
    // What earlier releases showed for that file, recorded.
    const recorded = [
      { key: 'A', value: 'True', override: false },
      { key: 'B', value: 'None', override: false },
      { key: 'C', value: 'inf', override: false },
      { key: 'D', value: '8', override: false },
      { key: 'E', value: '1.5', override: false },
      { key: 'F', value: '1342', override: false },
      { key: 'G', value: '-inf', override: false },
      { key: 'H', value: 'nan', override: false },
      { key: 'I', value: '1e8', override: false },
      { key: 'J', value: '0o17', override: false },
      { key: 'K', value: '2026-01-01', override: false },
      { key: 'L', value: '2026-01-01 10:00:00', override: false },
      { key: 'M', value: '-.5', override: false },
    ];
    expect(envRows(await readCompose('typed'))).toEqual(recorded);
  });
});

describe('the Kubernetes detail, of a workspace that is down', () => {
  afterEach(() => {
    jest.dontMock('../../../src/core/kube/status');
    jest.dontMock('../../../src/core/lifecycle/inspect');
    jest.resetModules();
  });

  /**
   * The pod read is asked for only when the state is not `down`, so a pod read that
   * FAILED is no failure of a down workspace's detail; `Promise.all` made it one -- `info`
   * on a Kubernetes workspace whose namespace was gone ended in a TypeError stack where
   * earlier releases reported it down. Up, the same failure is still one.
   */
  it.each([
    ['down', 'the detail, with no containers'],
    ['running', 'the pod read failure'],
  ])('with a state of %s and a pod read that fails, gives %s', async (state) => {
    jest.resetModules();
    const failure = new TypeError("Cannot read properties of null (reading 'metadata')");
    jest.doMock('../../../src/core/kube/status', () => ({
      ...jest.requireActual('../../../src/core/kube/status'),
      podRows: async () => {
        throw failure;
      },
    }));
    jest.doMock('../../../src/core/lifecycle/inspect', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/inspect'),
      kubernetesState: async () => state,
    }));
    const payload = require('../../../src/core/lifecycle/payload') as typeof PayloadNS;
    const meta = metadata({ name: 'k1', project: 'houston-k1', extra: { runtime: 'kubernetes' } });
    const answer = payload.kubernetesDetail({}, meta, 'k1', meta.extra);
    if (state === 'down') {
      await expect(answer).resolves.toMatchObject({ state: 'down', containers: [], restarts: 0 });
    } else {
      await expect(answer).rejects.toBe(failure);
    }
  });
});

describe('the shapes `since` deliberately declines', () => {
  it('answers "" for the three shapes earlier releases handled differently, all unreachable here', () => {
    // The deviation is EXECUTABLE rather than prose: each answer is pinned. `2026-01-01`
    // would raise TypeError out of earlier releases' panel read; the whole-hour offset and the
    // ISO basic format parse there and not here. A Kubernetes pod's startTime is RFC 3339
    // with a colon-bearing offset, which agrees exactly on both sides.
    const naive = '2026-01-01T00:00:00';
    const hourOffset = '2026-01-01T00:00:00+01';
    const basic = '20260101T000000Z';
    expect(since(naive)).toBe('');
    expect(since(hourOffset)).toBe('');
    expect(since(basic)).toBe('');
    // The colon-bearing offset these all approximate IS read, to the same day.
    expect(shape(since('2001-01-01T00:00:00+01:00'))).toBe(shape(since('2001-01-01T00:00:00Z')));
  });
});

function sampleMeta(name: string, values: Partial<Metadata> = {}): Metadata {
  return metadata({
    name,
    project: `houston-${name}`,
    rcVersion: '8.5.1',
    rcImage: 'i',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset: 'default',
    rootUrl: 'http://localhost:3000',
    hostPort: 3000,
    versionSource: 'map',
    ...values,
  });
}

describe('the detail panel', () => {
  afterEach(() => {
    jest.doMock('../../../src/core/runner/host', () =>
      (require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    jest.dontMock('../../../src/core/runner/queries');
    jest.resetModules();
  });

  /** A payload module over a docker the case states: down, or answering these queries. */
  function load(docker: false | Record<string, unknown>) {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/host', () => ({
      ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
      dockerAvailable: async () => docker !== false,
    }));
    if (docker !== false) {
      jest.doMock('../../../src/core/runner/queries', () => ({
        ...jest.requireActual('../../../src/core/runner/queries'),
        ...docker,
      }));
    }
    return {
      payload: require('../../../src/core/lifecycle/payload') as typeof PayloadNS,
      inspect: require('../../../src/core/lifecycle/inspect') as typeof InspectNS,
    };
  }

  it('agrees with the list about a crash-looping workspace, and shows the restarts', async () => {
    // The list read compose's project aggregate, where the healthy Mongo's "running(1)"
    // made a crash loop read "running" while the detail called it "stopped". The same
    // workspace, through both paths, must report the same state.
    const crash = 'Restarting (1) 5 seconds ago';
    await write('r', 'services: {}\n', sampleMeta('r'));
    const { payload, inspect } = load({
      projectStates: async () => ({ 'houston-r': 'restarting(1), running(1)' }),
      rcStatusByProject: async () => ({ 'houston-r': crash }),
      servicesByProject: async () => ({}),
      containerDetails: async () => [
        { service: 'rocketchat', state: 'restarting', status: crash, health: '' },
        { service: 'mongo', state: 'running', status: 'Up 2 hours', health: '' },
      ],
      rcRestartCount: async () => 7,
    });
    const listed = (await inspect.listRepros()).find((row) => row.name === 'r');
    const detailed = await payload.detail('r');
    expect([listed?.state, detailed.state]).toEqual(['restarting', 'restarting']);
    // The crash loop is visible.
    expect(detailed.restarts).toBe(7);
  });

  it('says whether this workspace is the default', async () => {
    // The panel offers "Make default" only where it would change something. The list
    // always carried `default`; the detail did not.
    for (const name of ['a', 'b']) {
      await write(name, 'services:\n  rocketchat: {}\n', sampleMeta(name));
    }
    const { payload } = load(false);
    expect((await payload.detail('a')).is_default).toBe(false);
    config.updateConfig((cfg) => {
      cfg.default_repro = 'a';
    });
    expect((await payload.detail('a')).is_default).toBe(true);
    expect((await payload.detail('b')).is_default).toBe(false);
  });

  it('recovers the bind host of a workspace older than the key, from its compose file', async () => {
    // The bind host was only ever written INTO the port mappings, so the panel could say
    // nothing true about reaching an older workspace from another machine.
    await write(
      'old',
      'services:\n  rocketchat:\n    image: i\n    ports:\n    - 0.0.0.0:3001:3000\n' +
        '    environment:\n      ROOT_URL: x\n',
      sampleMeta('old', { rootUrl: 'http://localhost:3001', hostPort: 3001 }),
    );
    const { payload } = load(false);
    expect((await payload.detail('old')).bind_host).toBe('0.0.0.0');
  });

  it.each([null, []])(
    'reads malformed extra %j as having no recorded env, as earlier releases do',
    async (extra) => {
      // Earlier releases read the recorded env only out of an extra that is an object, where
      // `meta.extra.env` read through the null and `info --json` was a TypeError stack.
      await write(
        'bare',
        'services:\n  rocketchat:\n    image: i\n    environment:\n      ROOT_URL: x\n',
        sampleMeta('bare'),
      );
      const file = path.join(config.reprosDir(), 'bare', 'repro.json');
      const blob = JSON.parse(fs.readFileSync(file, 'utf8')) as object;
      fs.writeFileSync(file, JSON.stringify({ ...blob, extra }));
      // What earlier releases' detail showed as the env of that record, docker down, recorded.
      const recorded = [{ key: 'ROOT_URL', value: 'x', override: false }];
      const { payload } = load(false);
      expect((await payload.detail('bare')).env).toEqual(recorded);
    },
  );

  it('carries the HTTPS fields the panel keys its row and its check off', async () => {
    // The list carried public_url/tls and the detail did not, so the whole feature was
    // invisible in the panel even though the links were right.
    await write(
      'g',
      'services:\n  rocketchat: {}\n',
      sampleMeta('g', {
        rcVersion: '8.6.1',
        publicUrl: 'https://g.houston.localhost:8443',
        extra: { tls: 'local', tls_ports: [8443] },
      }),
    );
    await write('plain', 'services:\n  rocketchat: {}\n', sampleMeta('plain'));
    const { payload } = load(false);
    const d = await payload.detail('g');
    expect([d.public_url, d.tls]).toEqual(['https://g.houston.localhost:8443', 'local']);
    // The clickable link prefers https, and the plain port stays available.
    const urls = (d.links as { url: string }[]).map((link) => link.url);
    expect(urls).toEqual(
      expect.arrayContaining(['https://g.houston.localhost:8443', 'http://localhost:3000']),
    );
    // A workspace without --https grows neither the row nor the action.
    const plain = await payload.detail('plain');
    expect([plain.public_url, plain.tls]).toEqual(['', '']);
  });

  it('says which version a rollback returns to, only while one can be made', async () => {
    // The GUI had no rollback control, though the route worked: the panel needs to know
    // whether one can be made and to what, and `rollback` needs the recorded pre-upgrade
    // bundle to still be on disk.
    const bundle = path.join(config.reprosDir(), '..', 'pre-upgrade.rcbak');
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.writeFileSync(bundle, '');
    const upgraded = { upgraded_from: '8.4.0', last_upgrade_backup: bundle };
    await write('up', 'services: {}\n', sampleMeta('up', { extra: upgraded }));
    // `upgrade --no-backup` clears the bundle; a rollback clears `upgraded_from`.
    await write('nb', 'services: {}\n', sampleMeta('nb', { extra: { upgraded_from: '8.4.0' } }));
    await write(
      'rb',
      'services: {}\n',
      sampleMeta('rb', { extra: { last_upgrade_backup: bundle } }),
    );
    await write(
      'gone',
      'services: {}\n',
      sampleMeta('gone', {
        extra: { upgraded_from: '8.4.0', last_upgrade_backup: `${bundle}.deleted` },
      }),
    );
    const { payload } = load(false);
    const answers = [];
    for (const name of ['up', 'nb', 'rb', 'gone']) {
      answers.push((await payload.detail(name)).rollback_to);
    }
    expect(answers).toEqual(['8.4.0', '', '', '']);
    // A path no home can expand is a hand-edited record: "", not a panel that will not open.
    expect(
      payload.rollbackTarget({ upgraded_from: '8.4.0', last_upgrade_backup: '~no-such-user-x/b' }),
    ).toBe('');
  });

  it('reports an unknown state, not down, when docker cannot be asked', async () => {
    // `containerDetails` answers [] both for "none" and for "could not ask docker", so the
    // detail asserted `down` while the list said `?` for the same repro -- and the panel
    // then offered a Bring up button that could only fail.
    await write('unasked', 'services:\n  rocketchat: {}\n', sampleMeta('unasked'));
    const { payload } = load(false);
    const d = await payload.detail('unasked');
    expect([d.state, d.health, d.uptime]).toEqual(['?', '', '']);
    expect(d.containers).toEqual([]);
  });

  it('cannot contradict its own containers: a running RC over an exited mongo is degraded', async () => {
    // State AND health were derived from the Rocket.Chat container alone, which serves
    // /api/info perfectly well with no database behind it.
    await write('dbgone', 'services: {}\n', sampleMeta('dbgone'));
    const { payload } = load({
      containerDetails: async () => [
        { service: 'mongodb', state: 'exited', status: 'Exited (0) 3 minutes ago', health: '' },
        {
          service: 'rocketchat',
          state: 'running',
          status: 'Up 2 hours (healthy)',
          health: 'healthy',
        },
      ],
      rcRestartCount: async () => 0,
    });
    const d = await payload.detail('dbgone');
    expect(d.state).toBe('running'); // it IS running; that part was never wrong
    expect(d.health).toBe('degraded');
    expect(d.degraded).toBe('mongodb is exited');
  });
});
