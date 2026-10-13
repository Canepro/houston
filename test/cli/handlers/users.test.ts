/**
 * `users` against earlier releases: every line their `users` command prints, from the same
 * accounts and sessions files.
 *
 * Each row writes its files into a fresh home, runs one argv, and compares stdout, stderr
 * and the exit code exactly with what earlier releases printed for it, recorded. The minted
 * password is the one thing a run chooses for itself, so the recorded runs and this one are
 * handed the same one -- sixteen characters, as earlier releases mint them -- and the panel it
 * is drawn in is compared with the rest. A typed password is answered as the recorded runs
 * answered it, the question and a newline on stdout, so a line printed BEFORE the prompt is
 * seen to be before it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as AppNS from '../../../src/cli/app';
import type * as HandlersNS from '../../../src/cli/handlers';

const MINTED = 'Pinned-Minted-16';
const TYPED = 'correct-horse-battery\ncorrect-horse-battery\n';

/** An accounts file: each row is `name:created[:role]`, the hash put in after the name. */
function accounts(rows: readonly string[], header = true): string {
  const lines = rows.map((row) =>
    row.replace(':', ':scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA:'),
  );
  const head = header
    ? '# houston GUI accounts. Managed by `houston users`.\n# name:hash:created_at[:role]\n'
    : '';
  return `${head}${lines.join('\n')}\n`;
}

const NOW = Math.floor(Date.now() / 1000);
const TEAM = accounts([
  'alice:2026-01-02:admin',
  'bob:2026-01-03:member',
  'carol:2026-01-04:readonly',
]);
/** Two of bob's sessions and one of alice's, alive, in the layout the sessions file has. */
const SESSIONS =
  '# houston GUI sessions. Managed by the server; delete a line to revoke it.\n' +
  '# houston-state: 1\n# sha256(token)\tuser\tcreated\tlast_seen\tlabel\torigin\n' +
  [
    ['1', 'bob', 'curl'],
    ['2', 'bob', 'Firefox on Linux'],
    ['3', 'alice', 'Chrome on macOS'],
  ]
    .map(
      ([sid, user, label]) =>
        `${(sid as string).repeat(64)}\t${user}\t${NOW}\t${NOW}\t${label}\tsession\n`,
    )
    .join('');

type Files = Readonly<Record<string, string>>;
const CASES: [string, Files, string[], string | null][] = [
  ['the empty listing, both of its lines', {}, ['users', 'list'], null],
  ['the listing, with the date each account was made', { users: TEAM }, ['users', 'list'], null],
  ['the default action, which is the listing', { users: TEAM }, ['users'], null],
  [
    'a blank role column, marked implicit and explained',
    { users: accounts(['alice:2026-01-02', 'bob:2026-01-03:member']) },
    ['users', 'list'],
    null,
  ],
  [
    'a full ISO timestamp line, shown with its effective role',
    { users: accounts(['alice:2026-01-02T08:52:23+00:00', 'bob:2026-01-03:member']) },
    ['users', 'list'],
    null,
  ],
  [
    'columns the service reads as admin or member, shown as it reads them',
    {
      users: accounts(
        [
          'alice:2026-01-02:ADMIN',
          'bob:2026-01-03: Member ',
          'carol:2026-01-04:superuser',
          'dave:2026-01-05:readonly',
        ],
        false,
      ),
    },
    ['users', 'list'],
    null,
  ],
  ['the first account: its role, and the first-run link spent', {}, ['users', 'add', 'bob'], null],
  ['a role given', { users: TEAM }, ['users', 'add', 'dave', 'readonly'], null],
  ['an admin given', { users: TEAM }, ['users', 'add', 'dave', 'ADMIN'], null],
  [
    "a two-letter name: the password is the panel's label",
    { users: TEAM },
    ['users', 'add', 'ab'],
    null,
  ],
  ['a dotted name says what it became', { users: TEAM }, ['users', 'add', 'Lucy.Felix'], null],
  ['what it became, before the conflict', { users: TEAM }, ['users', 'add', 'BOB'], null],
  [
    'a name with a quote in it, quoted with the other quote',
    { users: TEAM },
    ['users', 'add', "O'Brien"],
    null,
  ],
  [
    'a typed password: the note before the prompt, and the role after',
    { users: TEAM },
    ['users', 'add', 'Lucy.Felix', 'readonly', '--ask-password'],
    TYPED,
  ],
  [
    'the first account, from a typed password',
    {},
    ['users', 'add', 'bob', '--ask-password'],
    TYPED,
  ],
  [
    'passwd: the note, the panel, and the sessions it ended',
    { users: TEAM, sessions: SESSIONS },
    ['users', 'passwd', 'Bob'],
    null,
  ],
  [
    'role: the sessions signed out, and what roles bound',
    { users: TEAM, sessions: SESSIONS },
    ['users', 'role', 'bob', 'readonly'],
    null,
  ],
  ['role to the role it has already', { users: TEAM }, ['users', 'role', 'bob', 'member'], null],
  ['role, both words normalised', { users: TEAM }, ['users', 'role', 'Bob', 'ADMIN'], null],
  [
    'remove, and the sessions it ended',
    { users: TEAM, sessions: SESSIONS },
    ['users', 'remove', 'bob'],
    null,
  ],
];

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * What earlier releases printed for each case, by its label, each run in a fresh home
 * holding the case's files and minting MINTED.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'cli', 'handlers', 'users.json'),
    'utf8',
  ),
) as Record<string, Ran>;

let home = '';
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.HOUSTON_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-users-'));
  process.env.HOUSTON_HOME = home;
  delete process.env.HOUSTON_USER;
  jest.resetModules();
});
afterEach(() => {
  jest.dontMock('../../../src/core/users');
  jest.resetModules();
  process.env.HOUSTON_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
});

async function typescript(argv: string[], typed: string | null): Promise<Ran> {
  jest.doMock('../../../src/core/users', () => ({
    ...jest.requireActual<object>('../../../src/core/users'),
    mintPassword: () => MINTED,
  }));
  const app = require('../../../src/cli/app') as typeof AppNS;
  const handlers = require('../../../src/cli/handlers') as typeof HandlersNS;
  let stdout = '';
  let stderr = '';
  const io = {
    writeOut: (value: string) => {
      stdout += value;
    },
    writeErr: (value: string) => {
      stderr += value;
    },
  };
  const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const answers = (typed ?? '').split('\n');
  try {
    const code = await app.runCli(argv, {
      execute: handlers.createExecutor(io, {
        prompt: async (question) => {
          process.stdout.write(`${question}: \n`);
          return answers.shift() ?? '';
        },
      }),
      io,
    });
    return { code, stdout, stderr };
  } finally {
    write.mockRestore();
  }
}

describe('users, line for line against earlier releases', () => {
  it.each(CASES.map(([label, files, argv, typed]) => [label, files, argv, typed] as const))(
    '%s',
    async (label, files, argv, typed) => {
      for (const [name, text] of Object.entries(files)) {
        fs.writeFileSync(path.join(home, name), text, { mode: 0o600 });
      }
      expect(await typescript(argv, typed)).toEqual(RECORDED[label]);
    },
  );
});

describe('a call that is wrong is a usage error, exit 2 (L7-07)', () => {
  // Each exited 1, a refusal of no more specific kind, where `cluster frob` exits 2.
  it.each([
    // Unknown before it is nameless: it asked for a name, and the name then got "unknown".
    [
      ['users', 'frob'],
      "unknown action 'frob' (want: list | add | passwd | remove | role | link-sso | unlink-sso)",
    ],
    [['users', 'frob', 'alice'], "unknown action 'frob'"],
    [['users', 'role', 'alice'], '`users role alice` needs a role'],
    [['users', 'passwd', 'alice', 'admin'], '`users passwd` takes no role'],
  ])('%j', async (argv, message) => {
    fs.writeFileSync(path.join(home, 'users'), TEAM, { mode: 0o600 });
    const ran = await typescript(argv, null);
    expect({ code: ran.code, stderr: ran.stderr }).toEqual({
      code: 2,
      stderr: expect.stringContaining(message) as string,
    });
  });
});
