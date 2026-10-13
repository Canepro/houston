import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as seam from '../../../src/seams/docker-cli';
import { SpawnFailure } from '../../../src/seams/exec';

import type * as HostNS from '../../../src/core/runner/host';
import {
  composeStandaloneVersion,
  composeVersion,
  dockerCapacity,
  dockerKernelVersion,
  dockerServerVersion,
  engine,
  hostMemory,
} from '../../../src/core/runner/host';

// OPTS OUT of `test/testsetup-engine.ts`, because this file tests the functions that
// fixture replaces: "asks the right question for each version it reports" is about what
// `composeVersion` puts on argv, and a fixture answering "2.29.0" in its place would make
// the test about the fixture. The docker SEAM underneath is still this file's own mock, so
// nothing here reaches a real engine.
jest.unmock('../../../src/core/runner/host');

jest.mock('../../../src/seams/docker-cli', () => ({
  docker: jest.fn(),
  firstLine: jest.fn(),
  DOCKER_TTL_MS: 3_000,
  dockerAvailable: jest.fn(),
}));

const dockerMock = seam.docker as jest.MockedFunction<typeof seam.docker>;
const firstLineMock = seam.firstLine as jest.MockedFunction<typeof seam.firstLine>;

function answer(overrides: Partial<Awaited<ReturnType<typeof seam.docker>>> = {}) {
  return { argv: ['docker'], exitCode: 0, signal: null, stdout: '', stderr: '', ...overrides };
}

describe('what the engine says about itself', () => {
  it('reads cpus and memory, and answers null for anything it cannot', async () => {
    dockerMock.mockResolvedValue(answer({ stdout: '8 16764637184\n' }));
    expect(await dockerCapacity()).toEqual([8, 16_764_637_184]);

    dockerMock.mockResolvedValue(answer({ exitCode: 1 }));
    expect(await dockerCapacity()).toBeNull();

    dockerMock.mockResolvedValue(answer({ stdout: 'not two numbers' }));
    expect(await dockerCapacity()).toBeNull();

    // Never raises: callers use this on best-effort restore paths where a launch failure
    // (docker gone, a fork failure) must not escape.
    dockerMock.mockRejectedValue(new SpawnFailure(['docker'], new Error('gone')));
    expect(await dockerCapacity()).toBeNull();
  });

  it('asks the right question for each version it reports', async () => {
    firstLineMock.mockResolvedValue('29.7.2');
    expect(await dockerServerVersion()).toBe('29.7.2');
    expect(await composeVersion()).toBe('29.7.2');
    expect(await composeStandaloneVersion()).toBe('29.7.2');
    expect(await dockerKernelVersion()).toBe('29.7.2');

    expect(firstLineMock.mock.calls.map((call) => call[0])).toEqual([
      ['docker', 'version', '--format', '{{.Server.Version}}'],
      ['docker', 'compose', 'version', '--short'],
      // The STANDALONE binary, asked only when the plugin has already failed: a box can
      // have `docker-compose` on PATH printing a perfectly good v2 help text while
      // `docker compose` does not exist, because the binary was never put where the
      // docker CLI looks for plugins.
      ['docker-compose', 'version', '--short'],
      ['docker', 'info', '--format', '{{.KernelVersion}}'],
    ]);
  });
});

describe('what the machine says about itself', () => {
  it('reports MemAvailable rather than MemFree, in megabytes', async () => {
    // MemFree excludes the page cache, which the kernel reclaims on demand, so `free`
    // looks alarming on a healthy box and reassuring on a doomed one.
    const memory = await hostMemory();
    if (!fs.existsSync('/proc/meminfo')) {
      expect(memory).toBeNull();
      return;
    }
    expect(memory).not.toBeNull();
    const [total, available, swap] = memory as [number, number, number];
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const field = (name: string) =>
      Math.floor(Number(new RegExp(`^${name}:\\s+(\\d+)`, 'mu').exec(text)?.[1] ?? 0) / 1024);
    expect(total).toBe(field('MemTotal'));
    expect(Math.abs(available - field('MemAvailable'))).toBeLessThan(512);
    expect(swap).toBe(field('SwapTotal'));
  });
});

/**
 * `hubLoggedIn`, with `home` as the user's home. The home is `os.homedir()`, which under Jest
 * is the real account's -- and a CI runner's holds a Docker Hub login, so every "no login"
 * answer here was a yes there. Setting `process.env.HOME` does not move it: Jest's copy of
 * the environment is not the one the native call reads.
 */
function hubLoggedInWithHome(home: string): typeof HostNS.hubLoggedIn {
  jest.resetModules();
  jest.doMock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: () => home }));
  return (require('../../../src/core/runner/host') as typeof HostNS).hubLoggedIn;
}

describe('whether the client is logged in to Docker Hub', () => {
  let scratch = '';
  let hubLoggedIn: typeof HostNS.hubLoggedIn;
  const saved = { ...process.env };

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-hub-'));
    hubLoggedIn = hubLoggedInWithHome(path.join(scratch, 'home'));
  });

  afterEach(() => {
    process.env.REGISTRY_AUTH_FILE = saved.REGISTRY_AUTH_FILE;
    process.env.DOCKER_CONFIG = saved.DOCKER_CONFIG;
    if (saved.REGISTRY_AUTH_FILE === undefined) delete process.env.REGISTRY_AUTH_FILE;
    if (saved.DOCKER_CONFIG === undefined) delete process.env.DOCKER_CONFIG;
    fs.rmSync(scratch, { recursive: true, force: true });
    jest.dontMock('node:os');
    jest.resetModules();
  });

  it('says yes for a hub entry, no for a readable file without one', async () => {
    const auth = path.join(scratch, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({ auths: { 'index.docker.io': {} } }));
    process.env.REGISTRY_AUTH_FILE = auth;
    expect(await hubLoggedIn()).toBe(true);

    fs.writeFileSync(auth, JSON.stringify({ auths: { 'ghcr.io': {} } }));
    expect(await hubLoggedIn()).toBe(false);
  });

  it('reads every auths shape as earlier releases do, and skips a file that is not UTF-8', async () => {
    // Earlier releases read a falsy `auths` as none and then asked whether it holds the
    // registry: a null, false, 0 or '' is no login (a TypeError stack here -- `in` on null),
    // a list holds its elements, a string its substrings; a file that is not UTF-8 is
    // skipped, and a NaN is read where JSON.parse refused the file.
    const shapes: (string | Buffer)[] = [
      '{"auths": null}',
      '{"auths": false}',
      '{"auths": 0}',
      '{"auths": ""}',
      '{"auths": "docker.io"}',
      '{"auths": "ghcr.io"}',
      '{"auths": ["docker.io"]}',
      '{"auths": ["ghcr.io"]}',
      '{"auths": {"docker.io": {}}}',
      '{"auths": {"docker.io": NaN}}',
      '{}',
      Buffer.concat([
        Buffer.from('{"auths": {"docker.io": {"n": "'),
        Buffer.from([0xe9]),
        Buffer.from('"}}}'),
      ]),
    ];
    const auth = path.join(scratch, 'auth.json');
    process.env.REGISTRY_AUTH_FILE = auth;
    delete process.env.DOCKER_CONFIG;
    // What earlier releases answered for each shape, in order, recorded.
    const recorded: (boolean | null)[] = [
      false,
      false,
      false,
      false,
      true,
      false,
      true,
      false,
      true,
      true,
      false,
      null,
    ];
    const ours: (boolean | null)[] = [];
    for (const shape of shapes) {
      fs.writeFileSync(auth, shape);
      ours.push(await hubLoggedIn());
    }
    expect(ours).toEqual(recorded);
  });

  it('reads DOCKER_CONFIG=<dir>/.json as a directory, as earlier releases do', async () => {
    const dir = path.join(scratch, 'cfg', '.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{"auths": {"docker.io": {}}}');
    delete process.env.REGISTRY_AUTH_FILE;
    process.env.DOCKER_CONFIG = dir;
    expect(await hubLoggedIn()).toBe(true);
  });

  it('honours DOCKER_CONFIG as a directory', async () => {
    fs.writeFileSync(
      path.join(scratch, 'config.json'),
      JSON.stringify({ auths: { 'https://index.docker.io/v1/': {} } }),
    );
    process.env.DOCKER_CONFIG = scratch;
    expect(await hubLoggedIn()).toBe(true);
  });
});

describe('a client with no readable auth file anywhere', () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const name of ['REGISTRY_AUTH_FILE', 'DOCKER_CONFIG']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    jest.dontMock('node:os');
    jest.resetModules();
  });

  it('cannot tell, rather than saying no', async () => {
    // `null` is "can't tell". A `false` here would have doctor warn about Hub rate limits
    // to someone whose credentials are simply somewhere this does not look.
    delete process.env.REGISTRY_AUTH_FILE;
    delete process.env.DOCKER_CONFIG;
    const hubLoggedIn = hubLoggedInWithHome(path.join(os.tmpdir(), 'houston-no-such-home-for-hub'));
    expect(await hubLoggedIn()).toBeNull();
  });
});

describe('the auth files under HOME', () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const name of ['REGISTRY_AUTH_FILE', 'DOCKER_CONFIG']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    jest.dontMock('node:os');
    jest.resetModules();
  });

  it('are the ones earlier releases read, whatever HOME is spelled as', async () => {
    // With HOME set but EMPTY `os.homedir()` is '', and this read `.docker/config.json` in
    // the WORKING directory -- so a checkout holding one answered "logged in" where earlier
    // releases read `/.docker/config.json`. The working directory holds a decoy of both
    // files, and the rows are `lib/home.ts`'s. Under Jest the mock answers `os.homedir()`
    // with HOME verbatim, as the native call does (`lib/home.test.ts` checks that premise
    // against real processes).
    delete process.env.REGISTRY_AUTH_FILE;
    delete process.env.DOCKER_CONFIG;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-hub-home-'));
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-hub-cwd-'));
    const hub = JSON.stringify({ auths: { 'https://index.docker.io/v1/': {} } });
    for (const [dir, rel] of [
      [home, '.docker/config.json'],
      [decoy, '.docker/config.json'],
      [decoy, '.config/containers/auth.json'],
    ] as const) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), hub);
    }
    const rows = ['', '/', '//', `${home}/`, `${home}//`];
    const cwd = process.cwd();
    let current = '';
    try {
      jest.resetModules();
      jest.doMock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: () => current }));
      const fresh = require('../../../src/core/runner/host') as typeof HostNS;
      process.chdir(decoy);
      const ours: (boolean | null)[] = [];
      for (const row of rows) {
        current = row;
        ours.push(await fresh.hubLoggedIn());
      }
      // What earlier releases answered for each spelling of HOME, from the same decoy, recorded.
      const recorded = [null, null, null, true, true];
      expect(ours).toEqual(recorded);
      // And the rows that CAN hold one read it: the comparison is not all nulls.
      expect(ours.slice(3)).toEqual([true, true]);
    } finally {
      process.chdir(cwd);
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(decoy, { recursive: true, force: true });
    }
  });

  it('are the ones the kernel names when HOME or DOCKER_CONFIG walks back out of a symlink', async () => {
    // Earlier releases join the file name onto HOME and onto DOCKER_CONFIG and keep a `..`
    // for the kernel, which follows `link` first: with `link -> other/sub`, `<box>/link/../u`
    // is `<box>/other/u`. `path.join` folded it to `<box>/u`, nothing was there, and a login
    // earlier releases read was "cannot tell" here.
    const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'houston-hub-link-')));
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-hub-empty-'));
    const hub = JSON.stringify({ auths: { 'https://index.docker.io/v1/': {} } });
    fs.mkdirSync(path.join(box, 'other', 'sub'), { recursive: true });
    fs.symlinkSync('other/sub', path.join(box, 'link'));
    fs.mkdirSync(path.join(box, 'other', 'u', '.docker'), { recursive: true });
    fs.writeFileSync(path.join(box, 'other', 'u', '.docker', 'config.json'), hub);
    fs.mkdirSync(path.join(box, 'other', 'dc'));
    fs.writeFileSync(path.join(box, 'other', 'dc', 'config.json'), hub);
    // [HOME, DOCKER_CONFIG]: the login under HOME, then the one DOCKER_CONFIG names.
    const rows: [string, string][] = [
      [`${box}/link/../u`, ''],
      [empty, `${box}/link/../dc`],
      [empty, `${box}/link/../dc/`],
    ];
    let current = '';
    try {
      jest.resetModules();
      jest.doMock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: () => current }));
      const fresh = require('../../../src/core/runner/host') as typeof HostNS;
      delete process.env.REGISTRY_AUTH_FILE;
      const ours: (boolean | null)[] = [];
      for (const [row, dockerConfig] of rows) {
        current = row;
        process.env.DOCKER_CONFIG = dockerConfig;
        ours.push(await fresh.hubLoggedIn());
      }
      // What earlier releases answered for each row, over the same links, recorded.
      const recorded = [true, true, true];
      expect(ours).toEqual(recorded);
      expect(ours).toEqual([true, true, true]);
    } finally {
      fs.rmSync(box, { recursive: true, force: true });
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('which engine answers docker', () => {
  /** `docker info` and `docker version`, as JSON, keyed by the subcommand. */
  function engineAnswers(info: unknown, version: unknown = { Server: { Components: [] } }): void {
    dockerMock.mockImplementation(async (args: readonly string[]) =>
      answer({ stdout: JSON.stringify(args[0] === 'info' ? info : version) }),
    );
  }

  it('is Docker, which runs healthchecks', async () => {
    engineAnswers(
      {
        ServerVersion: '27.5.1',
        CgroupDriver: 'cgroupfs',
        SecurityOptions: [],
        KernelVersion: '6.8.0',
        NCPU: 4,
        MemTotal: 8,
      },
      { Server: { Components: [{ Name: 'Engine', Version: '27.5.1' }] } },
    );
    expect(await engine()).toMatchObject({
      kind: 'docker',
      healthchecks: true,
      shim: false,
      rootless: false,
    });
  });

  it('is Podman behind its socket, rootless on cgroupfs: no healthchecks (measured, 6.1.3)', async () => {
    engineAnswers(
      {
        ServerVersion: '6.1.3',
        CgroupDriver: 'cgroupfs',
        SecurityOptions: ['name=seccomp,profile=default', 'name=rootless'],
        KernelVersion: '6.1.167',
        NCPU: 4,
        MemTotal: 10_511_347_712,
      },
      { Server: { Components: [{ Name: 'Podman Engine', Version: '6.1.3' }, { Name: 'Engine' }] } },
    );
    expect(await engine()).toMatchObject({
      kind: 'podman',
      version: '6.1.3',
      rootless: true,
      cgroupDriver: 'cgroupfs',
      healthchecks: false,
      shim: false,
    });
  });

  it('is Podman as the podman-docker shim, in its own JSON; systemd runs healthchecks', async () => {
    engineAnswers({
      host: {
        cgroupManager: 'systemd',
        security: { rootless: false },
        kernel: '6.9.1',
        cpus: 2,
        memTotal: 4096,
      },
      version: { Version: '5.2.0' },
    });
    expect(await engine()).toMatchObject({
      kind: 'podman',
      version: '5.2.0',
      shim: true,
      healthchecks: true,
      kernel: '6.9.1',
    });
  });

  it("falls back to the shim's JSON where Docker's template fields do not exist", async () => {
    const shimInfo = {
      host: {
        cgroupManager: 'cgroupfs',
        security: { rootless: true },
        kernel: '6.1.167',
        cpus: 4,
        memTotal: 1234,
      },
    };
    firstLineMock.mockResolvedValue(null);
    dockerMock.mockImplementation(async (args: readonly string[]) =>
      args.includes('{{json .}}')
        ? answer({ stdout: JSON.stringify(shimInfo) })
        : answer({ exitCode: 125, stderr: "can't evaluate field NCPU" }),
    );
    expect(await dockerKernelVersion()).toBe('6.1.167');
    expect(await dockerCapacity()).toEqual([4, 1234]);
  });

  it('is null when nothing answers', async () => {
    dockerMock.mockResolvedValue(answer({ exitCode: 1 }));
    expect(await engine()).toBeNull();
  });
});
