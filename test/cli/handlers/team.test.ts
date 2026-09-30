/**
 * The shared-box CLI against earlier releases: who is running it, and what that changes.
 *
 * An earlier version never told the CLI who was running it -- only the web layer set the
 * actor -- so with accounts on the box a name typed without its owner prefix resolved to
 * nothing, two people's `up -v 8.5.1` derived one workspace, and `down --volumes` asked to
 * delete a colleague's data without naming them (§3.3 of the team-server design: anyone may
 * act on anything, but not without being told whose it is).
 *
 * The CLI is driven through the world the recorded runs saw: the accounts file and audit log
 * an earlier release wrote, and the records, in a HOUSTON_HOME of the test's own; the acting
 * user comes from HOUSTON_USER (the `asserted` origin earlier releases honour too), and the
 * teardown -- the one thing that would reach docker -- is stated, as it was for the recorded
 * runs. stdout, stderr and the exit code are compared exactly with what they printed.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as GetloginNS from '../../../src/lib/login-name';
import type * as AppNS from '../../../src/cli/app';
import type * as HandlersNS from '../../../src/cli/handlers';

import type * as ActorNS from '../../../src/cli/handlers/actor';

interface Printed {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * What earlier releases wrote and printed, recorded: the exact accounts file and audit log
 * an earlier release's `users add` left for alice, bob and root (all with the password
 * `correct-horse-battery`, root as an admin), and each case's run by its label, with the one
 * clock reading in a JSON envelope kept as `<t>`.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'cli', 'handlers', 'team.json'),
    'utf8',
  ),
) as { home: { users: string; 'audit.log': string }; cases: Record<string, Printed> };

interface Case {
  argv: string[];
  user: string;
  decline?: boolean;
  /** `alice-rc8-5-1`'s `extra`, when not the world's, written afresh before the run. */
  extra?: unknown;
}

const CASES: [string, Case][] = [
  [
    "down --volumes of a colleague's workspace, declined",
    { argv: ['down', '-n', 'alice-rc8-5-1', '--volumes'], user: 'bob', decline: true },
  ],
  [
    "down --volumes of a colleague's workspace, under --yes",
    { argv: ['down', '-n', 'alice-rc8-5-1', '--volumes', '--yes'], user: 'bob' },
  ],
  [
    'down --volumes of your own workspace, under --yes',
    { argv: ['down', '-n', 'alice-rc8-5-1', '--volumes', '--yes'], user: 'alice' },
  ],
  [
    'down --volumes --json without --yes',
    { argv: ['down', '-n', 'alice-rc8-5-1', '--volumes', '--json'], user: 'bob' },
  ],
  ['down, keeping the data', { argv: ['down', '-n', 'alice-rc8-5-1'], user: 'alice' }],
  [
    'a bare name finds the workspace its owner made',
    { argv: ['tls-status', '--name', 'test'], user: 'alice' },
  ],
  [
    "a bare name does not find somebody else's",
    { argv: ['tls-status', '--name', 'test'], user: 'bob' },
  ],
  [
    'an unknown name is exit 4 before anything is asked',
    { argv: ['down', '-n', 'nope', '--volumes', '--yes'], user: 'bob' },
  ],
  // The owner is the RAW value the record holds, and a hand-edited record can make it
  // anything JSON holds.
  [
    'chown of a record whose extra is null',
    { argv: ['chown', '-n', 'alice-rc8-5-1', '--to', 'bob'], user: 'bob', extra: null },
  ],
  [
    'chown by the actor "123" of a workspace the int 123 owns',
    { argv: ['chown', '-n', 'alice-rc8-5-1', '--to', 'bob'], user: '123', extra: { owner: 123 } },
  ],
  [
    'chown by an admin of a workspace whose owner is true',
    { argv: ['chown', '-n', 'alice-rc8-5-1', '--to', 'bob'], user: 'root', extra: { owner: true } },
  ],
  [
    'down --volumes of a workspace whose owner is a list, under --yes',
    {
      argv: ['down', '-n', 'alice-rc8-5-1', '--volumes', '--yes'],
      user: 'bob',
      extra: { owner: ['x'] },
    },
  ],
  // Earlier releases' whitespace strip is not `trim()`: it strips \x1c-\x1f and NEL and
  // keeps a BOM, the reverse of JavaScript, for the actor and for the new owner alike.
  // alice is the box's first account, so an admin; bob is a member, and the gate is his.
  [
    'chown by HOUSTON_USER=\\x1fbob of what bob owns, which is bob',
    {
      argv: ['chown', '-n', 'alice-rc8-5-1', '--to', 'alice'],
      user: '\x1fbob',
      extra: { created_by: 'bob' },
    },
  ],
  [
    'chown by HOUSTON_USER=\\ufeffbob of what bob owns, which is not bob',
    {
      argv: ['chown', '-n', 'alice-rc8-5-1', '--to', 'alice'],
      user: '\ufeffbob',
      extra: { created_by: 'bob' },
    },
  ],
  [
    'chown --to a name led by \\x1f and closed by NEL',
    { argv: ['chown', '-n', 'alice-rc8-5-1', '--to', '\x1fbob\u0085'], user: 'alice' },
  ],
  [
    'chown --to a name led by a BOM',
    { argv: ['chown', '-n', 'alice-rc8-5-1', '--to', '\ufeffbob'], user: 'alice' },
  ],
];

let home = '';
let previous: string | undefined;

function writeRecord(name: string, extra: unknown): void {
  const dir = path.join(home, 'repros', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'repro.json'),
    JSON.stringify({
      name,
      project: `houston-${name}`,
      rc_version: '8.5.1',
      rc_image: '',
      mongo_tag: '6.0',
      mongo_flavor: '',
      preset: 'default',
      root_url: 'http://localhost:3000',
      host_port: 3000,
      version_source: '',
      pinned: false,
      created_at: '',
      public_url: '',
      admin_password: '',
      extra,
    }),
  );
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
}

beforeEach(() => {
  previous = process.env.HOUSTON_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-team-'));
  process.env.HOUSTON_HOME = home;
  // The world: the accounts file and audit log an earlier release wrote, byte for byte, as
  // it wrote them.
  fs.chmodSync(home, 0o700);
  for (const [file, text] of Object.entries(RECORDED.home)) {
    fs.writeFileSync(path.join(home, file), text, { mode: 0o600 });
  }
  for (const name of ['alice-rc8-5-1', 'alice-test']) writeRecord(name, { created_by: 'alice' });
});
afterEach(() => {
  jest.dontMock('../../../src/core/lifecycle/destroy');
  jest.resetModules();
  delete process.env.HOUSTON_USER;
  process.env.HOUSTON_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
});

async function typescript(one: Case) {
  jest.resetModules();
  process.env.HOUSTON_USER = one.user;
  jest.doMock('../../../src/core/lifecycle/destroy', () => ({
    ...jest.requireActual('../../../src/core/lifecycle/destroy'),
    teardown: async (name: string) => ({ name, removed: true, runtime: 'docker' }),
  }));
  const app = require('../../../src/cli/app') as typeof AppNS;
  const handlers = require('../../../src/cli/handlers') as typeof HandlersNS;
  let stdout = '';
  let stderr = '';
  let question: string | undefined;
  const io = {
    writeOut: (value: string) => {
      stdout += value;
    },
    writeErr: (value: string) => {
      stderr += value;
    },
  };
  // A JSON envelope is written to the process's own stdout, not through `io`.
  const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  let code: number;
  try {
    code = await app.runCli(one.argv, {
      execute: handlers.createExecutor(io, {
        confirm: async (asked: string) => {
          question = asked;
          return one.decline !== true;
        },
      }),
      io,
    });
  } finally {
    write.mockRestore();
  }
  return { code, stdout, stderr, question };
}

describe('the shared-box CLI, against earlier releases', () => {
  it.each(CASES)('%s', async (label, one) => {
    // A chown WRITES the record, so the run starts from the one the recorded run saw.
    const stage = () => {
      writeRecord(
        'alice-rc8-5-1',
        Object.hasOwn(one, 'extra') ? one.extra : { created_by: 'alice' },
      );
    };
    stage();
    const recorded = JSON.parse(
      JSON.stringify(RECORDED.cases[label]).replaceAll('<home>', home),
    ) as Printed;
    const ours = await typescript(one);
    if (one.decline === true) {
      // Earlier releases print the question on stdout (the recorded run echoes the typed
      // answer); this build hands it to the confirm function. The owner line comes BEFORE
      // it in both.
      expect(`${ours.stdout}${ours.question ?? '<never asked>'} [y/N]: n\n`).toBe(recorded.stdout);
      expect({ code: ours.code, stderr: ours.stderr }).toEqual({
        code: recorded.code,
        stderr: recorded.stderr,
      });
      return;
    }
    // The one field that is a clock reading.
    const stamp = (text: string) =>
      text.replace(/"generated_at": "[^"]+"/gu, '"generated_at": "<t>"');
    expect({ code: ours.code, stdout: stamp(ours.stdout), stderr: ours.stderr }).toEqual({
      ...recorded,
      stdout: stamp(recorded.stdout),
    });
  });
});

describe('who HOUSTON_USER and the login name say is running, against earlier releases', () => {
  // Earlier releases strip and lower-case both. `trim()` kept \x1c-\x1f and NEL and stripped
  // a BOM, so the actor every gate, audit line and event-log record starts from was a
  // different person here than in earlier releases.
  const NAMES: [string, string][] = [
    ['\\x1falice', '\x1falice'],
    ['\\ufeffalice', '\ufeffalice'],
    ['\\u0085Alice\\x1c', '\u0085Alice\x1c'],
  ];
  /** What earlier releases answered, `[actor, origin]`, for each name by its label. */
  const RECORDED_ACTOR: Record<'asserted' | 'login', Record<string, [string, string]>> = {
    asserted: {
      '\\x1falice': ['alice', 'asserted'],
      '\\ufeffalice': ['﻿alice', 'asserted'],
      '\\u0085Alice\\x1c': ['alice', 'asserted'],
    },
    login: {
      '\\x1falice': ['alice', 'local'],
      '\\ufeffalice': ['', 'system'],
      '\\u0085Alice\\x1c': ['alice', 'local'],
    },
  };

  afterEach(unmockBox);

  function ours(login: string): unknown {
    jest.resetModules();
    mockBox({ loginuid: String(UNLISTED), effective: { username: login, uid: UNLISTED } });
    return (require('../../../src/cli/handlers/actor') as typeof ActorNS).cliActorAndOrigin();
  }

  it.each(NAMES)('HOUSTON_USER=%s', (label, name) => {
    process.env.HOUSTON_USER = name;
    expect(ours('nobody')).toEqual(RECORDED_ACTOR.asserted[label]);
  });

  it.each(NAMES)('a login name of %s', (label, name) => {
    delete process.env.HOUSTON_USER;
    expect(ours(name)).toEqual(RECORDED_ACTOR.login[label]);
  });
});

/** A uid no real password database lists, so only the mocked `os.userInfo()` can name it. */
const UNLISTED = 3_999_999;

interface Box {
  /** What `/proc/self/loginuid` holds, or null for a kernel without one. */
  readonly loginuid: string | null;
  /** `/etc/passwd`; the box's own when absent. */
  readonly passwd?: string;
  /** Who `os.userInfo()` says the process is: the EFFECTIVE user. */
  readonly effective: { readonly username: string; readonly uid: number };
}

/**
 * The OS facts a login is read from, as a box would hold them. Standard input is never a
 * terminal here, and there is no utmp, so a login uid glibc cannot name leaves the login
 * name with no answer.
 */
function mockBox(box: Box): void {
  const real = jest.requireActual<typeof fs>('node:fs');
  const missing = (file: string) =>
    Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), {
      code: 'ENOENT',
    });
  jest.doMock('node:fs', () => ({
    ...real,
    readFileSync: (file: fs.PathOrFileDescriptor, ...rest: never[]) => {
      if (file === '/proc/self/loginuid') {
        if (box.loginuid === null) throw missing(file);
        return Buffer.from(box.loginuid);
      }
      if (file === '/etc/passwd' && box.passwd !== undefined) return box.passwd;
      if (file === '/var/run/utmp') throw missing(file);
      return real.readFileSync(file, ...rest);
    },
  }));
  jest.doMock('node:tty', () => ({
    ...jest.requireActual<object>('node:tty'),
    isatty: () => false,
  }));
  jest.doMock('node:os', () => ({
    ...jest.requireActual<object>('node:os'),
    userInfo: () => ({ ...box.effective, gid: box.effective.uid, shell: '', homedir: '' }),
  }));
}

function unmockBox(): void {
  for (const id of ['node:fs', 'node:tty', 'node:os']) jest.dontMock(id);
}

describe('the login name, not the effective user, against earlier releases', () => {
  // An earlier version asked `os.userInfo()`, the EFFECTIVE uid's name. Earlier releases
  // take the LOGIN uid's name, and `$USER` where there is none -- so under `sudo -u` a
  // member ran an admin's chown, and in a container the actor was nobody, whom every owner gate
  // lets through. bob is a member here and root an admin. What earlier releases answered for
  // each box, from the login name the box gives, is recorded beside it.
  let previousUser: string | undefined;
  beforeEach(() => {
    previousUser = process.env.USER;
    delete process.env.HOUSTON_USER;
  });
  afterEach(() => {
    unmockBox();
    if (previousUser === undefined) delete process.env.USER;
    else process.env.USER = previousUser;
  });

  function ours(box: Box): unknown {
    jest.resetModules();
    mockBox(box);
    return (require('../../../src/cli/handlers/actor') as typeof ActorNS).cliActorAndOrigin();
  }

  it('is the person who logged in, under sudo -u an admin', () => {
    process.env.USER = 'root';
    const got = ours({
      loginuid: '1234',
      passwd: 'bob:x:1234:1234:,,,:/home/bob:/bin/bash\n',
      effective: { username: 'root', uid: 0 },
    });
    // Recorded with the login name `bob` and USER=root.
    const recorded = ['bob', 'local'];
    expect(got).toEqual(recorded);
    expect(got).toEqual(['bob', 'local']);
  });

  it('is $USER where no login marked the process: a container, cron', () => {
    process.env.USER = 'alice';
    const got = ours({ loginuid: '4294967295', effective: { username: 'nobody', uid: 65534 } });
    // Recorded with no login name to be had and USER=alice.
    const recorded = ['alice', 'local'];
    expect(got).toEqual(recorded);
    expect(got).toEqual(['alice', 'local']);
  });

  it('is $USER for a login uid the password database lacks, with no terminal to ask', () => {
    process.env.USER = 'alice';
    const got = ours({ loginuid: '1234', passwd: '', effective: { username: 'root', uid: 0 } });
    // Recorded with no login name to be had and USER=alice.
    const recorded = ['alice', 'local'];
    expect(got).toEqual(recorded);
    expect(got).toEqual(['alice', 'local']);
  });
});

describe("the login name, as glibc's getlogin() answers it", () => {
  const RECORD = process.arch === 'arm64' ? 400 : 384;

  /** A utmp file of `[ut_type, ut_line, ut_user]` records. */
  function utmp(...records: [number, string, string][]): Buffer {
    const table = Buffer.alloc(RECORD * records.length);
    records.forEach(([type, line, user], index) => {
      table.writeInt16LE(type, index * RECORD);
      table.write(line, index * RECORD + 8, 32, 'latin1');
      table.write(user, index * RECORD + 44, 32, 'utf8');
    });
    return table;
  }

  const PASSWD: Record<number, string> = { 1001: 'laborant' };
  const sources = (loginuid: string | null, tty: string | null, table: Buffer | null) => ({
    loginuid: () => (loginuid === null ? null : Buffer.from(loginuid).subarray(0, 12)),
    passwdName: (uid: number) => PASSWD[uid] ?? null,
    ttyName: () => tty,
    utmp: () => table,
  });
  const ON_PTS_3 = utmp([7, 'pts/3', 'dana']);

  const CASES: [string, ReturnType<typeof sources>, string | null][] = [
    ['a login uid the password database names', sources('1001', null, null), 'laborant'],
    [
      'no login uid, even on a terminal utmp knows',
      sources('4294967295', '/dev/pts/3', ON_PTS_3),
      null,
    ],
    ["strtoul's -1, which is no login uid", sources('-1', '/dev/pts/3', ON_PTS_3), null],
    [
      'a login uid nobody has, on a terminal utmp knows',
      sources('4242', '/dev/pts/3', ON_PTS_3),
      'dana',
    ],
    ['a login uid nobody has, and no terminal', sources('4242', null, ON_PTS_3), null],
    [
      'a login uid nobody has, on a terminal utmp does not know',
      sources('4242', '/dev/pts/9', ON_PTS_3),
      null,
    ],
    [
      'no loginuid file, on a getty line',
      sources(null, '/dev/tty1', utmp([6, 'tty1', 'LOGIN'])),
      'LOGIN',
    ],
    [
      'a trailing newline, which is not a number',
      sources('1001\n', '/dev/pts/3', ON_PTS_3),
      'dana',
    ],
    ['twelve bytes, more than glibc reads', sources('000000001001', null, null), null],
    ['a dead process on the line', sources('4242', '/dev/pts/3', utmp([8, 'pts/3', 'gone'])), null],
    ['no utmp at all', sources('4242', '/dev/pts/3', null), null],
  ];

  it.each(CASES)('%s', (_label, box, expected) => {
    const { getlogin } = jest.requireActual<typeof GetloginNS>('../../../src/lib/login-name');
    expect(getlogin(box)).toBe(expected);
  });
});
