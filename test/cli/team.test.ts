/**
 * The shared-box behaviour the recorded 1.x answers in `handlers/team.test.ts` do not
 * already drive -- who the CLI thinks you are, the account verbs, and what `serve` says
 * about its own posture (team-server.md §3.3 and §7).
 *
 * Every case that resets the module registry requires a FRESH app, executor and service
 * module, because a refusal is recognised by class identity.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FastifyInstance } from 'fastify';

import type * as AuditNS from '../../src/core/audit';
import type * as DestroyNS from '../../src/core/lifecycle/destroy';
import type * as InspectNS from '../../src/core/lifecycle/inspect';
import type * as NamingNS from '../../src/core/lifecycle/naming';
import type * as OwnershipNS from '../../src/core/lifecycle/ownership';
import type * as TypesNS from '../../src/core/lifecycle/types';
import type * as RecordNS from '../../src/core/runner/record';
import type * as SessionsNS from '../../src/core/sessions';
import type * as UsersNS from '../../src/core/users';
import type * as ContextNS from '../../src/lib/context';
import type * as ErrorsNS from '../../src/lib/errors';
import type * as PolicyNS from '../testsetup-policy';

import type * as ActorNS from '../../src/cli/handlers/actor';
import type * as AppNS from '../../src/cli/app';
import type * as HandlersNS from '../../src/cli/handlers';
import type * as ServeNS from '../../src/cli/serve';

const GOOD = 'correct-horse-battery';

let home = '';
let previous: string | undefined;
let previousUser: string | undefined;
beforeEach(() => {
  previous = process.env.HOUSTON_HOME;
  previousUser = process.env.USER;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-team-cli-'));
  process.env.HOUSTON_HOME = home;
  delete process.env.HOUSTON_USER;
  jest.resetModules();
});
afterEach(() => {
  process.env.HOUSTON_HOME = previous;
  if (previousUser === undefined) delete process.env.USER;
  else process.env.USER = previousUser;
  delete process.env.HOUSTON_USER;
  fs.rmSync(home, { recursive: true, force: true });
  for (const id of [
    'node:fs',
    'node:os',
    '../../src/core/lifecycle/create-docker',
    '../../src/core/lifecycle/destroy',
  ]) {
    jest.dontMock(id);
  }
  jest.doMock('../../src/core/runner/host', () =>
    (require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
  );
  jest.dontMock('../../src/core/runner/engine');
  jest.dontMock('../../src/core/rcapi');
  jest.resetModules();
});

const users = () => require('../../src/core/users') as typeof UsersNS;

/**
 * The OS login this process reports, as glibc's getlogin() would, and the same user as the
 * effective one. `/proc/self/loginuid` names a uid no password database lists, which only the
 * mocked `os.userInfo()` can name; an Error is a process no login marked.
 */
function loginIs(name: string | Error): void {
  const uid = 3_999_999;
  const real = jest.requireActual<typeof fs>('node:fs');
  jest.doMock('node:fs', () => ({
    ...real,
    readFileSync: (file: fs.PathOrFileDescriptor, ...rest: never[]) =>
      file === '/proc/self/loginuid'
        ? Buffer.from(name instanceof Error ? '4294967295' : String(uid))
        : real.readFileSync(file, ...rest),
  }));
  jest.doMock('node:os', () => ({
    ...jest.requireActual<object>('node:os'),
    userInfo: () => {
      if (name instanceof Error) throw name;
      return { username: name, uid, gid: uid, shell: '', homedir: '' };
    },
  }));
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  argv: string[],
  dependencies: HandlersNS.HandlerDependencies = {},
): Promise<Ran> {
  const app = require('../../src/cli/app') as typeof AppNS;
  const { createExecutor } = require('../../src/cli/handlers') as typeof HandlersNS;
  let stdout = '';
  let stderr = '';
  const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const io = {
    writeOut: (value: string) => {
      stdout += value;
    },
    writeErr: (value: string) => {
      stderr += value;
    },
  };
  try {
    const code = await app.runCli(argv, { execute: createExecutor(io, dependencies), io });
    return { code, stdout, stderr };
  } finally {
    write.mockRestore();
  }
}

/** Just enough of a workspace for `readMeta` to find it. */
async function workspace(name: string, owner = ''): Promise<void> {
  const record = require('../../src/core/runner/record') as typeof RecordNS;
  await record.writeRecord(
    name,
    record.metadata({
      name,
      project: `houston-${name}`,
      rcVersion: '8.5.1',
      mongoTag: '6.0',
      hostPort: 3000,
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      extra: owner === '' ? {} : { created_by: owner },
    }),
  );
  fs.writeFileSync(path.join(home, 'repros', name, 'docker-compose.yml'), 'services: {}\n');
}

describe('who the CLI thinks you are', () => {
  const actor = () =>
    (require('../../src/cli/handlers/actor') as typeof ActorNS).cliActorAndOrigin()[0];

  it('is nobody until somebody creates an account, whatever HOUSTON_USER says', () => {
    // Team mode is opt-in: until `users add`, every workspace keeps the name it always had.
    process.env.HOUSTON_USER = 'alice';
    expect(actor()).toBe('');
  });

  it('is the login name when it matches an account', async () => {
    await users().add('alice', GOOD);
    loginIs('alice');
    expect(actor()).toBe('alice');
  });

  it('is not guessed from a login name no account has', async () => {
    // Better the shared namespace than one nobody can sign in to from the GUI.
    await users().add('alice', GOOD);
    loginIs('root');
    delete process.env.USER;
    expect(actor()).toBe('');
  });

  it('is HOUSTON_USER over the login name, lowercased to the name rules', async () => {
    // The OS account and the GUI account are often not the same name.
    await users().add('alice', GOOD);
    loginIs('ubuntu');
    process.env.HOUSTON_USER = 'Alice';
    expect(actor()).toBe('alice');
  });

  it('falls back to USER when there is no controlling terminal', async () => {
    // There is no login name to be had under cron and in containers.
    await users().add('alice', GOOD);
    loginIs(new Error('no tty'));
    process.env.USER = 'alice';
    expect(actor()).toBe('alice');
  });

  it('reaches the create request `up` builds, which is what namespaces the name', async () => {
    await users().add('alice', GOOD);
    loginIs('alice');
    const seen: Record<string, string> = {};
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual<object>('../../src/core/rcapi'),
      releaseInfo: async () => ({ status: 404, json: () => ({}) }),
    }));
    jest.doMock('../../src/core/lifecycle/create-docker', () => ({
      ...jest.requireActual<object>('../../src/core/lifecycle/create-docker'),
      createRepro: async (req: TypesNS.CreateReq) => {
        const naming = require('../../src/core/lifecycle/naming') as typeof NamingNS;
        seen.actor = req.actor;
        seen.name = naming.deriveFor(req);
        throw new Error('stop before any docker work');
      },
    }));
    await run(['up', '-v', '8.5.1']);
    expect(seen).toEqual({ actor: 'alice', name: 'alice-rc8-5-1' });
  });

  it('is published to the audit log the GUI writes, from a CLI command', async () => {
    // The CLI could not reach audit() at all: it lived in the web layer.
    await users().add('alice', GOOD);
    loginIs('alice');
    await workspace('alice-rc8-5-1', 'alice');
    let during = '';
    jest.doMock('../../src/core/lifecycle/destroy', () => ({
      ...jest.requireActual<object>('../../src/core/lifecycle/destroy'),
      teardown: async (name: string) => {
        during = (require('../../src/core/audit') as typeof AuditNS).actor();
        return { name, removed: true, runtime: 'docker' };
      },
    }));
    const ran = await run(['down', '-n', 'alice-rc8-5-1', '--volumes', '--yes']);
    expect(ran.code).toBe(0);
    expect(during).toBe('alice');
  });
});

describe('the record a teardown leaves', () => {
  it('is an audit line naming the actor, the verb and the workspace', async () => {
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual<object>('../../src/core/runner/engine'),
      down: async () => 0,
    }));
    await workspace('alice-rc8-5-1', 'alice');
    const destroy = require('../../src/core/lifecycle/destroy') as typeof DestroyNS;
    const context = require('../../src/lib/context') as typeof ContextNS;
    const audit = require('../../src/core/audit') as typeof AuditNS;
    await context.runWithContext({ actor: 'alice' }, async () => {
      await destroy.teardown('alice-rc8-5-1', { volumes: true, confirm: true });
    });
    const line = fs.readFileSync(audit.auditPath(), 'utf8').trim();
    expect(line).toContain('alice');
    expect(line).toContain('down-volumes');
    expect(line).toContain('alice-rc8-5-1');
  });

  it('keeps the owner visible in the listing', async () => {
    jest.doMock('../../src/core/runner/host', () => ({
      ...(require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
      dockerAvailable: async () => false,
    }));
    await workspace('alice-rc8-5-1', 'alice');
    const inspect = require('../../src/core/lifecycle/inspect') as typeof InspectNS;
    const rows = await inspect.listRepros();
    expect(rows.map((row) => row.created_by)).toEqual(['alice']);
  });
});

describe('a workspace name that gets coerced', () => {
  it('says what it became, because two typed names can land on one workspace', () => {
    // `sanitize` is not injective: `../escape` and `escape` both become `escape`.
    const naming = require('../../src/core/lifecycle/naming') as typeof NamingNS;
    const { createReq } = require('../../src/core/lifecycle/types') as typeof TypesNS;
    const said: string[] = [];
    naming.warnNameCoerced(createReq({ version: '8.5.1', name: 'TICKET/1234' }), (event) => {
      said.push(event.message);
    });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("becomes 'ticket-1234'");
    expect(said[0]).toContain('same workspace');
    const quiet: string[] = [];
    naming.warnNameCoerced(createReq({ version: '8.5.1', name: 'ticket-1234' }), (event) => {
      quiet.push(event.message);
    });
    expect(quiet).toEqual([]);
  });
});

describe('users and config from the terminal', () => {
  it('creates the role it was given, and the service default when none is', async () => {
    // The `add` branch never read the role, so `users add contractor readonly` made an
    // account that could destroy workspaces and read credentials out of container logs.
    await users().add('first', GOOD);
    for (const [name, want] of [
      ['ro', 'readonly'],
      ['mem', 'member'],
      ['adm', 'admin'],
    ] as const) {
      expect((await run(['users', 'add', name, want])).code).toBe(0);
      expect({ name, role: users().roleOf(name) }).toEqual({ name, role: want });
    }
    expect((await run(['users', 'add', 'plain'])).code).toBe(0);
    expect(users().roleOf('plain')).toBe('member');
  });

  it('refuses a role that does not exist, and creates nothing', async () => {
    // A typo in a role came out as a member, indistinguishable from success.
    await users().add('first', GOOD);
    const ran = await run(['users', 'add', 'typo', 'reedonly']);
    expect(ran.code).not.toBe(0);
    expect(`${ran.stdout}${ran.stderr}`).toContain('unknown role');
    expect(users().roleOf('typo')).toBe('');
  });

  // The handler passed argv to `add`, which stores what it is given: `:ADMIN` in the file
  // and `role=ADMIN` in the audit, and a leading line break split the line so a member
  // read back as an implicit admin. Earlier releases store the role normalised.
  it.each([['ADMIN'], [' Member '], ['ReadOnly'], ['\rmember'], ['\nmember'], ['\x0breadonly']])(
    'stores the role %j as earlier releases do, normalised in the users file',
    async (role) => {
      const codes = [(await run(['users', 'add', 'first'])).code];
      codes.push((await run(['users', 'add', 'dave', role])).code);
      expect(codes).toEqual([0, 0]);
      expect(users().roleOf('dave')).toBe(users().normaliseRole(role));
    },
  );

  it('mints the password on add and shows it exactly once', async () => {
    const ran = await run(['users', 'add', 'bob']);
    expect(ran.code).toBe(0);
    const words = ran.stdout
      .replaceAll('|', ' ')
      .split(/\s+/u)
      .filter((word) => word.length >= 16);
    let minted = '';
    for (const word of words) if (await users().verify('bob', word)) minted = word;
    expect(minted).not.toBe('');
    expect(ran.stdout.split(minted)).toHaveLength(2);
    expect(ran.stdout).toContain('Shown once');
  });

  it('still lets a password be typed, and then shows nothing', async () => {
    const answers = ['a-typed-out-password', 'a-typed-out-password'];
    const ran = await run(['users', 'add', 'carol', '--ask-password'], {
      prompt: async () => answers.shift() ?? '',
    });
    expect(ran.code).toBe(0);
    expect(await users().verify('carol', 'a-typed-out-password')).toBe(true);
    expect(ran.stdout).not.toContain('Shown once');
  });

  it('refuses a typed password that does not match its repeat', async () => {
    const answers = ['one-good-password', 'a-different-password'];
    const ran = await run(['users', 'add', 'dave', '--ask-password'], {
      prompt: async () => answers.shift() ?? '',
    });
    expect(ran.code).not.toBe(0);
    expect(`${ran.stdout}${ran.stderr}`).toContain('do not match');
    expect(users().listUsers()).toEqual([]);
  });

  it('mints on passwd too, and the reset reaches the live sessions', async () => {
    const sessions = require('../../src/core/sessions') as typeof SessionsNS;
    await users().add('erin', GOOD, 'admin');
    const token = await sessions.create('erin');
    expect(await sessions.verify(token)).not.toBeNull();
    const ran = await run(['users', 'passwd', 'erin']);
    expect(ran.code).toBe(0);
    expect(await users().verify('erin', GOOD)).toBe(false);
    let minted = '';
    for (const word of ran.stdout.replaceAll('|', ' ').split(/\s+/u)) {
      if (word.length >= 16 && (await users().verify('erin', word))) minted = word;
    }
    expect(minted).not.toBe('');
    sessions.resetCache();
    expect(await sessions.verify(token)).toBeNull();
  });

  // Earlier releases revoke after the role is written and say so; this build wrote the role
  // and kept every session.
  it('signs the account out on a role change, as earlier releases do, and nobody else', async () => {
    const sessions = require('../../src/core/sessions') as typeof SessionsNS;
    await users().add('alice', GOOD, 'admin');
    await users().add('bob', GOOD, 'member');
    await sessions.create('bob', { label: 'Firefox on Linux' });
    await sessions.create('bob', { label: 'curl' });
    const alice = await sessions.create('alice', { label: 'Chrome on macOS' });
    const ran = await run(['users', 'role', 'bob', 'readonly']);
    expect(ran.code).toBe(0);
    // The second line says who was signed out because of it. The lines after it are the
    // roles-bound-the-GUI hint.
    expect(ran.stdout.split('\n')[1]).toBe(
      '  2 active session(s) signed out, so it takes effect now.',
    );
    sessions.resetCache();
    expect(await sessions.verify(alice)).not.toBeNull();
  });

  it('refuses a policy typo rather than silently meaning strict', async () => {
    const bad = await run(['config', 'set', 'gui.create_policy', 'anyonr']);
    expect(bad.code).not.toBe(0);
    expect(`${bad.stdout}${bad.stderr}`).toContain("takes 'anyone'");
    await users().add('bob', GOOD, 'member');
    const ownership = () => require('../../src/core/lifecycle/ownership') as typeof OwnershipNS;
    expect(ownership().maySetPrivilegedFields('bob')).toBe(true);
    expect((await run(['config', 'set', 'gui.create_policy', 'admin'])).code).toBe(0);
    expect(ownership().maySetPrivilegedFields('bob')).toBe(false);
  });

  it('answers --version and -V eagerly, naming the build', async () => {
    const VERSION = (require('../../package.json') as { version: string }).version;
    for (const flag of ['--version', '-V']) {
      const ran = await run([flag]);
      expect({ flag, code: ran.code }).toEqual({ flag, code: 0 });
      expect(ran.stdout).toContain(VERSION);
      expect(ran.stdout).toContain('houston');
    }
    expect((await run(['--version', 'list'])).code).toBe(0);
  });
});

/**
 * The `users` command's refusals in the order earlier releases make them: the TYPED name is
 * tested for emptiness, then normalised, then each action checks what it checks -- the
 * password prompt checks the name before any prompt, the role after it. Each row is a
 * refusal, so nothing is written.
 *
 * A typed password is answered as the recorded runs answered it: the question and a newline
 * on stdout, which is where a prompt asked BEFORE a refusal shows.
 */
describe('users refusals, in the order earlier releases make them', () => {
  const SEED =
    '# houston GUI accounts. Managed by `houston users`.\n# name:hash:created_at[:role]\n' +
    ['alice:2026-01-02:admin', 'bob:2026-01-03:member', 'carol:2026-01-04:readonly']
      .map((row) => row.replace(':', ':scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA:'))
      .join('\n') +
    '\n';
  const LONG = 'abcdefghijklmnopqrstuvwxyz0123456';
  const TYPED = 'correct-horse-battery\ncorrect-horse-battery\n';
  const CASES: [string, string[], string | null][] = [
    ['passwd validates the name as add does', ['users', 'passwd', LONG], null],
    ['remove looks the empty normalised name up', ['users', 'remove', '!!!'], null],
    ['role looks it up once the role is valid', ['users', 'role', '!!!', 'admin'], null],
    ['role refuses the role before the lookup', ['users', 'role', '!!!', 'frob'], null],
    ['an unknown action with no name asks for the name', ['users', 'ls'], null],
    ['the same, for an action with a quote in it', ['users', "it's"], null],
    ['an unknown action with a name is refused as unknown', ['users', 'rm', 'bob'], null],
    ['add refuses the name before any prompt', ['users', 'add', LONG, '--ask-password'], TYPED],
    [
      'add refuses the role after the prompt, before the length',
      ['users', 'add', 'bob', 'superuser', '--ask-password'],
      'short\nshort\n',
    ],
    [
      'passwd refuses a role after the prompt',
      ['users', 'passwd', 'bob', 'admin', '--ask-password'],
      TYPED,
    ],
    ['role with no role is exit 1', ['users', 'role', 'bob'], null],
    ['a name with no letter or digit is invalid, exit 2', ['users', 'add', '!!!'], null],
    ['add with no name', ['users', 'add'], null],
    ['passwd with a role', ['users', 'passwd', 'bob', 'admin'], null],
  ];
  it.each(CASES)('%s', async (_label, argv, typed) => {
    fs.writeFileSync(path.join(home, 'users'), SEED, { mode: 0o600 });
    const answers = (typed ?? '').split('\n');
    const ran = await run(argv, {
      prompt: async (question) => {
        process.stdout.write(`${question}: \n`);
        return answers.shift() ?? '';
      },
    });
    expect(ran.code).not.toBe(0);
    expect(fs.readFileSync(path.join(home, 'users'), 'utf8')).toBe(SEED);
  });
});

// --- serve ------------------------------------------------------------------------------

interface Served {
  out: string;
  err: string;
  error: (Error & { exitCode?: number }) | null;
  bound: { host?: string; port?: number };
  app: Parameters<ServeNS.ServeDependencies['createApp']>[0] | null;
  door: string;
  started: boolean;
  result: ServeNS.ServeResult | null;
}

/**
 * `serve` without serving: the real posture, account and host-name rules, with the
 * listener, the edge and the browser stated.
 */
async function served(
  options: ServeNS.ServeOptions,
  overrides: Partial<ServeNS.ServeDependencies> = {},
): Promise<Served> {
  const { serve } = require('../../src/cli/serve') as typeof ServeNS;
  const seen: Served = {
    out: '',
    err: '',
    error: null,
    bound: {},
    app: null,
    door: '',
    started: false,
    result: null,
  };
  const app = {
    server: { address: () => ({ address: '', family: 'IPv4', port: seen.bound.port ?? 0 }) },
    listen: async (at: { host: string; port: number }) => {
      seen.bound = { host: at.host, port: at.port };
      return '';
    },
    close: async () => undefined,
  } as unknown as FastifyInstance;
  try {
    seen.result = await serve(
      options,
      {
        bridgeAddress: async () => '172.17.0.1',
        requireDocker: async () => undefined,
        writeEdge: async (door) => {
          seen.door = door.domain;
        },
        ensureEdge: async () => {
          seen.started = true;
          return { ok: true, why: '' };
        },
        edgeAddresses: async () => [],
        createApp: async (given) => {
          seen.app = given;
          return app;
        },
        recoverInterrupted: async () => [],
        // The certificate probe is the network.
        reportGuiTls: async () => undefined,
        waitForShutdown: async () => undefined,
        openBrowser: async () => undefined,
        tightenPrivateState: () => undefined,
        writePid: () => false,
        removeOwnedPid: () => undefined,
        ...overrides,
      },
      {
        writeOut: (text) => {
          seen.out += text;
        },
        writeErr: (text) => {
          seen.err += text;
        },
      },
    );
  } catch (error) {
    seen.error = error as Error & { exitCode?: number };
  }
  return seen;
}

const said = (one: Served) => `${one.out}${one.err}${one.error?.message ?? ''}`;

describe('serve on a reachable interface', () => {
  it('serves the login over plain http when --insecure says the hop is protected', async () => {
    // The shared-box case: TLS terminates at a proxy this process cannot see.
    await users().add('alice', GOOD);
    const one = await served({
      bind: '0.0.0.0',
      port: 9955,
      allowHost: ['*'],
      insecure: true,
      noOpen: true,
    });
    expect(one.error).toBeNull();
    expect(one.bound).toEqual({ host: '0.0.0.0', port: 9955 });
    expect(one.app?.accounts).toBe(true);
    expect(one.app?.firstRun).toBe(false);
  });

  it('needs no flag on loopback', async () => {
    await users().add('alice', GOOD);
    const one = await served({ noOpen: true });
    expect(one.error).toBeNull();
    expect(one.app?.accounts).toBe(true);
  });

  it('refuses to start with no accounts, --insecure or not, and binds nothing', async () => {
    // The replacement for the old session token is not a smaller token.
    for (const insecure of [false, true]) {
      const one = await served({ bind: '0.0.0.0', insecure, noOpen: true });
      // Exit 3 with NO `error:`: the documented first-run stop, not a failure.
      expect({ insecure, result: one.result }).toEqual({
        insecure,
        result: { printed: false, refused: true, exitCode: 3 },
      });
      expect(said(one)).toContain('needs an account');
      expect(said(one)).toContain('users add');
      expect(one.bound).toEqual({});
    }
  });

  it.each([
    ['https://LAB/', "dropped 'https://'"],
    ['LAB/', 'dropped the trailing slash'],
    ['LAB:9944', 'dropped the port'],
    ['LAB.', 'dropped the trailing dot'],
    ['UPPER', 'lower-cased it'],
  ])('corrects --allow-host %s and says it %s', async (given, note) => {
    // Each was silently unmatchable: the Host guard strips the port off the INCOMING
    // header and compared it against the raw string it was given.
    const lab = '6a6ee0279ef1d3d348968822-0e9f82.node-ap-b1d4.iximiuz.com';
    const typed = given === 'UPPER' ? lab.toUpperCase() : given.replace('LAB', lab);
    await users().add('alice', GOOD);
    const one = await served({
      bind: '0.0.0.0',
      insecure: true,
      port: 9955,
      allowHost: [typed],
      noOpen: true,
    });
    expect(one.error).toBeNull();
    expect(one.out).toContain(note);
    expect(one.app?.allowHosts).toEqual([lab]);
    // And the URL is built from the corrected value.
    expect(one.out).toContain(`houston GUI: http://${lab}:9955/`);
  });

  it('keeps the * wildcard as it is', async () => {
    await users().add('alice', GOOD);
    const one = await served({ bind: '0.0.0.0', insecure: true, allowHost: ['*'], noOpen: true });
    expect(one.app?.allowHosts).toEqual(['*']);
  });

  it.each(['https://', '/', 'host/path'])(
    'refuses --allow-host %p rather than inventing a name',
    async (given) => {
      await users().add('alice', GOOD);
      const one = await served({
        bind: '0.0.0.0',
        insecure: true,
        allowHost: [given],
        noOpen: true,
      });
      expect(one.error).not.toBeNull();
      expect(said(one)).toContain('--allow-host');
      expect(one.bound).toEqual({});
    },
  );

  it('prints a placeholder rather than a URL nobody can open for a wildcard bind', async () => {
    await users().add('alice', GOOD);
    const one = await served({
      bind: '0.0.0.0',
      allowHost: ['*'],
      insecure: true,
      port: 7070,
      noOpen: true,
    });
    expect(one.out).not.toContain('http://0.0.0.0:7070/');
    expect(one.out).toContain('houston GUI: http://<this-box>:7070/');
  });

  it('prints the URL somebody can actually open, from the allowed host', async () => {
    await users().add('alice', GOOD);
    const one = await served({
      bind: '0.0.0.0',
      allowHost: ['18.232.139.213'],
      insecure: true,
      port: 7070,
      noOpen: true,
    });
    expect(one.out).toContain('houston GUI: http://18.232.139.213:7070/');
  });
});

describe('serve --domain', () => {
  it('binds the Docker bridge, starts the front door and refuses nothing', async () => {
    // Only the front door needs to reach the GUI; 0.0.0.0 would publish docker control.
    await users().add('alice', GOOD);
    const one = await served({ domain: 'support.example.com', email: 'ops@example.com' });
    expect(one.error).toBeNull();
    expect(one.bound.host).toBe('172.17.0.1');
    expect(one.started).toBe(true);
    // With --domain houston IS the TLS terminator; refusing it would be absurd.
    expect(said(one)).not.toContain('refused');
  });

  it('corrects a scheme in the domain rather than carrying it into the route', async () => {
    await users().add('alice', GOOD);
    const one = await served({ domain: 'https://support.example.com/', email: 'o@e.com' });
    expect(one.door).toBe('support.example.com');
  });

  it('does not warn about publishing the GUI before refusing to publish it', async () => {
    const one = await served({
      domain: 'rc.example.com',
      email: 'ops@example.com',
      bind: '172.17.0.1',
      noOpen: true,
    });
    expect(said(one)).not.toContain('publishes the GUI');
    expect(said(one)).toContain('needs an account');
  });

  it('renders an edge that refuses to start as its own message, at exit 8', async () => {
    // Another home's edge holding the port reached the top as a stack trace.
    const errors = require('../../src/lib/errors') as typeof ErrorsNS;
    await users().add('someone', GOOD, 'admin');
    const one = await served(
      { domain: 'gui.example.test', email: 'a@b.test', noOpen: true },
      {
        ensureEdge: async () => {
          throw new errors.ConflictError('another houston edge is already running');
        },
      },
    );
    expect(one.error?.exitCode).toBe(8);
    expect(one.error?.message).toBe('another houston edge is already running');
    expect(one.bound).toEqual({});
  });
});

describe('serve --print-service', () => {
  it('writes an absolute ExecStart that reproduces its flags, and offers both ways', async () => {
    // systemd refuses a relative ExecStart outright; a service has no browser to open.
    await users().add('alice', GOOD);
    const one = await served({
      domain: 'd.example.com',
      email: 'o@e.com',
      port: 9000,
      printService: true,
    });
    expect(one.error).toBeNull();
    const exec = one.out.split('\n').find((line) => line.startsWith('ExecStart=')) ?? '';
    expect(exec.slice('ExecStart='.length).startsWith('/')).toBe(true);
    expect(exec).toContain('--domain d.example.com');
    expect(exec).toContain('--port 9000');
    expect(exec).toContain('--no-open');
    expect(one.out).toContain('systemctl enable --now houston');
    expect(one.out).toContain('nohup ');
    expect(one.out).toContain('NOT restart on crash');
    // It writes nothing and starts nothing.
    expect(one.started).toBe(false);
    expect(one.door).toBe('');
    expect(one.bound).toEqual({});
  });

  it('names the bin/houston that ran it, not the build behind it, and itself when run directly', async () => {
    // ExecStart named the build that printed it -- `node <checkout>/tools/cli.js` -- so a unit
    // went stale when the build behind bin/houston moved. The owner's decision of 2026-09-28:
    // name bin/houston, which exports its own absolute path as HOUSTON_DISPATCHER.
    // Run directly, or with a value systemd would refuse, this build's own absolute answer
    // stands.
    await users().add('alice', GOOD);
    const printed = async (): Promise<[string, string]> => {
      const one = await served({ domain: 'd.example.com', email: 'o@e.com', printService: true });
      expect(one.error).toBeNull();
      return [one.out.split('\n').find((line) => line.startsWith('ExecStart=')) ?? '', one.out];
    };
    const inherited = process.env.HOUSTON_DISPATCHER;
    try {
      process.env.HOUSTON_DISPATCHER = '/opt/houston/bin/houston';
      const [line, out] = await printed();
      expect(line).toBe(
        'ExecStart=/opt/houston/bin/houston serve --domain d.example.com --email o@e.com --no-open',
      );
      expect(out).toContain('    nohup /opt/houston/bin/houston serve --domain d.example.com');

      delete process.env.HOUSTON_DISPATCHER;
      const [own] = await printed();
      expect(own.slice('ExecStart='.length).startsWith('/')).toBe(true);
      expect(own).not.toContain('/opt/houston/bin/houston');
      for (const refused of ['bin/houston', '']) {
        process.env.HOUSTON_DISPATCHER = refused;
        expect({ refused, line: (await printed())[0] }).toEqual({ refused, line: own });
      }
    } finally {
      if (inherited === undefined) delete process.env.HOUSTON_DISPATCHER;
      else process.env.HOUSTON_DISPATCHER = inherited;
    }
  });
});

describe('serve --help', () => {
  it('teaches the localhost case first and does not offer --insecure unprompted', async () => {
    const ran = await run(['serve', '--help']);
    expect(ran.code).toBe(0);
    const flat = ran.stdout.replaceAll('│', ' ').split(/\s+/u).join(' ');
    expect(flat).not.toContain('deprecated: prefer --trust-proxy');
    expect(flat).not.toContain('--insecure');
    expect(flat).toContain('--trust-proxy');
    expect(flat).toContain('a bare 0.0.0.0 is one address and matches nothing');
    expect(flat).toContain('TRYING IT OUT? There is nothing to learn: houston serve');
    expect(flat).toContain('--no-domain for a local session');
  });
});
