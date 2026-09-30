/**
 * `pathHome()` and the path helpers beside it, in real environments.
 *
 * Under Jest `process.env` is the test file's own copy and `os.homedir()` is native, so
 * moving HOME here would move nothing; each HOME row is therefore a fresh process, started
 * with that exact environment. The in-process tests of the sites that call `pathHome()`
 * mock `node:os` with the HOME they want instead, and the premise those mocks stand on --
 * that `os.homedir()` IS `HOME`, verbatim, whenever HOME is set -- is checked here.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type * as OsNS from 'node:os';
import * as path from 'node:path';

import type * as HomeNS from '../../src/lib/home';
import { pathResolve, joinPath } from '../../src/lib/home';

const ROOT = path.resolve(__dirname, '..', '..');

/** This environment minus every variable that could choose a home, plus `home` as HOME. */
function environment(home: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['HOME', 'HOUSTON_HOME', 'RC_REPRO_HOME']) delete env[name];
  if (home !== null) env.HOME = home;
  return env;
}

function run(file: string, args: string[], home: string | null): Record<string, string> {
  const proc = spawnSync(file, args, { cwd: ROOT, encoding: 'utf8', env: environment(home) });
  if (proc.status !== 0) throw new Error(`${file} failed: ${proc.stderr}`);
  return JSON.parse(proc.stdout) as Record<string, string>;
}

const TYPESCRIPT = [
  '-e',
  `require(${JSON.stringify(path.join(ROOT, 'tools', 'ts-require'))}).install();` +
    "const os = require('node:os');" +
    `const { pathHome } = require(${JSON.stringify(path.join(ROOT, 'src', 'lib', 'home.ts'))});` +
    'process.stdout.write(JSON.stringify({ homedir: os.homedir(), pathHome: pathHome() }));',
];

/** `home` imported afresh with `os.homedir()` answering `homedir()`, handed to `use`. */
function withHomedir<T>(homedir: () => string, use: (home: typeof HomeNS) => T): T {
  jest.resetModules();
  jest.doMock('node:os', () => ({
    ...jest.requireActual<typeof OsNS>('node:os'),
    homedir,
  }));
  try {
    return use(require('../../src/lib/home') as typeof HomeNS);
  } finally {
    jest.dontMock('node:os');
    jest.resetModules();
  }
}

describe('pathHome', () => {
  // The rows `lib/home.ts` tabulates: unset, empty, the root spelled two ways, and a path
  // bare and with one and two trailing slashes. `null` is HOME unset, and then the home is
  // the password database's, trailing slashes stripped.
  const passwordHome = os.userInfo().homedir.replace(/\/+$/u, '') || '/';
  it.each<[string | null, string]>([
    [null, passwordHome],
    ['', '/'],
    ['/', '/'],
    ['//', '/'],
    ['/tmp/x', '/tmp/x'],
    ['/tmp/x/', '/tmp/x'],
    ['/tmp/x//', '/tmp/x'],
  ])('hands os.homedir() HOME verbatim for HOME=%j, and pathHome() is %j', (row, expected) => {
    const ours = run(process.execPath, TYPESCRIPT, row);
    // The premise every mocked site test stands on: HOME, verbatim, whenever it is set --
    // `''` included -- and the password database only when it is not.
    expect(ours.homedir).toBe(row ?? os.userInfo().homedir);
    expect(ours.pathHome).toBe(expected);
  });

  // HOME unset: `os.homedir()` returns the password-database entry UNALTERED -- measured
  // with a bind-mounted passwd in a user namespace, `/fake/home//` came back as
  // `/fake/home//` and `` as `` -- and pathHome strips it as expanduser does.
  it.each([
    ['/home/someone/', '/home/someone'],
    ['/home/someone//', '/home/someone'],
    ['/', '/'],
    ['//', '/'],
    ['', '/'],
  ])('reads a password-database home of %j as %j', (entry, expected) => {
    expect(
      withHomedir(
        () => entry,
        (home) => home.pathHome(),
      ),
    ).toBe(expected);
  });
});

describe('joinPath', () => {
  // The segments a home or HOUSTON_SKILL_HOME joins with. `path.join` answered `x/...` for
  // the first and `/x/...` for the second; earlier releases keep both as spelled, and the kernel
  // then refuses `nonexistent/..` where it finds `x`.
  it.each<[string[], string]>([
    [['nonexistent/../x', '.claude/skills', 'houston'], 'nonexistent/../x/.claude/skills/houston'],
    [['//x', '.agents/skills', 'houston'], '//x/.agents/skills/houston'],
    [['///x', '.agents/skills', 'houston'], '/x/.agents/skills/houston'],
    [['x/', '.claude/skills', 'houston'], 'x/.claude/skills/houston'],
    [['x//y/./z/', '.claude/skills', 'houston'], 'x/y/z/.claude/skills/houston'],
    [['/', '.claude/skills', 'houston'], '/.claude/skills/houston'],
    [['//', '.claude/skills', 'houston'], '//.claude/skills/houston'],
    [['.', '.claude/skills', 'houston'], '.claude/skills/houston'],
    [['./a/..', 'b'], 'a/../b'],
    [['a', '/abs', 'c'], '/abs/c'],
    [['a', '', 'c'], 'a/c'],
    [['', 'b'], 'b'],
    [['~', 'b'], '~/b'],
    [['..', '..', 'b'], '../../b'],
    [['/..', 'b'], '/../b'],
    [['a/.', '.'], 'a'],
    [['.'], '.'],
    [[''], '.'],
    [['////a//b'], '/a/b'],
    [['//a', '//b'], '//b'],
    [['a', '//b/', 'c'], '//b/c'],
    [['//x/', '..', 'y'], '//x/../y'],
  ])('joins %j as earlier releases join it: %j', (segments, expected) => {
    expect(joinPath(...segments)).toBe(expected);
  });
});

describe('pathExpandUser', () => {
  // The ports this replaces joined `pathHome()` onto the text after a leading `~` with
  // `path.join`: `~root/x` was the CURRENT user's `root/x`, `~/x/` kept its slash, a HOME
  // of `/a/../b` became `/b`, and a path with no `~` was not spelled as earlier releases
  // spell it at all. A `~name` nobody has is refused, as earlier releases refuse it. The HOME rows
  // are set through the `node:os` mock, whose premise the `pathHome` rows above check.
  const REFUSED = 'HomeUnknown: Could not determine home directory.';
  const me = os.userInfo().username;
  const mine = os.userInfo().homedir;
  const TARGETS = ['~', '~/', '~/x/', '~//x/./y//', '~/../x', './~/x', '~/~'];

  /** What the home-independent targets expand to, under every HOME. */
  const FIXED: [string, string][] = [
    ['/~/x', '/~/x'],
    ['a/~', 'a/~'],
    ['x//y/./', 'x/y'],
    ['x/../y', 'x/../y'],
    ['', '.'],
    [`~${me}`, mine],
    [`~${me}/x/`, `${mine}/x`],
    ['~root/x', '/root/x'],
    ['~no-such-user-houston/x', REFUSED],
    ['~root:x', REFUSED],
  ];

  const answer = (fn: () => string): string => {
    try {
      return fn();
    } catch (error) {
      return `${(error as Error).name}: ${(error as Error).message}`;
    }
  };

  it.each<[string, string[]]>([
    [
      '/home/u',
      ['/home/u', '/home/u', '/home/u/x', '/home/u/x/y', '/home/u/../x', '/home/u/x', '/home/u/~'],
    ],
    [
      '/home/u/',
      ['/home/u', '/home/u', '/home/u/x', '/home/u/x/y', '/home/u/../x', '/home/u/x', '/home/u/~'],
    ],
    [
      '/a/../b',
      ['/a/../b', '/a/../b', '/a/../b/x', '/a/../b/x/y', '/a/../b/../x', '/a/../b/x', '/a/../b/~'],
    ],
    [
      '//srv/u',
      ['//srv/u', '//srv/u', '//srv/u/x', '//srv/u/x/y', '//srv/u/../x', '//srv/u/x', '//srv/u/~'],
    ],
    ['', ['/', '/', '/x', '/x/y', '/../x', '/x', '/~']],
    ['~elsewhere', [REFUSED, REFUSED, REFUSED, REFUSED, REFUSED, REFUSED, REFUSED]],
  ])('expands a leading ~ as earlier releases do under HOME=%j', (home, expected) => {
    const ours = withHomedir(
      () => home,
      (fresh) =>
        [...TARGETS, ...FIXED.map(([target]) => target)].map((target) =>
          answer(() => fresh.pathExpandUser(target)),
        ),
    );
    expect(ours).toEqual([...expected, ...FIXED.map(([, value]) => value)]);
  });
});

describe('pathResolve', () => {
  it('resolves as earlier releases do: every link followed before a `..` after it', () => {
    // `path.resolve` and `fs.realpathSync` fold `link/..` to nothing before any link is
    // read, so with `link -> other/sub` the managed backups directory under
    // `HOUSTON_HOME=link/../hh` was `hh` in the working directory; the kernel, and so
    // earlier releases, walk through the link to `other/hh`. The rows are that home and what
    // earlier releases do around it: relative and absolute links, a dangling one, a loop, a
    // file used as a directory, missing tails, and the spellings earlier releases rewrite.
    const tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'houston-resolve-')));
    fs.mkdirSync(path.join(tree, 'other', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(tree, 'other', 'hh', 'backups'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'file'), '');
    fs.symlinkSync('other/sub', path.join(tree, 'link'));
    fs.symlinkSync(path.join(tree, 'other'), path.join(tree, 'abslink'));
    fs.symlinkSync('link/../hh', path.join(tree, 'chain'));
    fs.symlinkSync('nowhere/else', path.join(tree, 'dangling'));
    fs.symlinkSync('loop2', path.join(tree, 'loop1'));
    fs.symlinkSync('loop1', path.join(tree, 'loop2'));
    const rows = [
      'link/../hh',
      'link/../hh/backups',
      'link/../hh/backups/new.tar.gz',
      'link/../hh/new/../backups/./x/',
      'link/..',
      'link',
      'abslink/sub/../hh',
      'chain',
      'chain/backups/../..',
      'dangling',
      'dangling/x/../y',
      'file',
      'file/x',
      'nowhere/../x',
      'a/b/../../c',
      '..',
      '.',
      '',
      '//other//./hh/',
      `${tree}/link/../hh`,
      `${tree}//link/../hh/`,
      'loop1',
      'loop1/x',
    ];
    const cwd = process.cwd();
    let ours: string[];
    try {
      process.chdir(tree);
      ours = rows.map((row) => {
        try {
          return pathResolve(row);
        } catch (error) {
          return `error: ${(error as Error).message}`;
        }
      });
    } finally {
      process.chdir(cwd);
    }
    fs.rmSync(tree, { recursive: true, force: true });
    // Row for row: the first is the finding, the last two the loop, answered as the kernel
    // answers them.
    expect(ours).toEqual([
      `${tree}/other/hh`,
      `${tree}/other/hh/backups`,
      `${tree}/other/hh/backups/new.tar.gz`,
      `${tree}/other/hh/backups/x`,
      `${tree}/other`,
      `${tree}/other/sub`,
      `${tree}/other/hh`,
      `${tree}/other/hh`,
      `${tree}/other`,
      `${tree}/nowhere/else`,
      `${tree}/nowhere/else/y`,
      `${tree}/file`,
      `${tree}/file/x`,
      `${tree}/x`,
      `${tree}/c`,
      path.dirname(tree),
      tree,
      tree,
      '/other/hh',
      `${tree}/other/hh`,
      `${tree}/other/hh`,
      `error: Symlink loop from '${tree}/loop1'`,
      `error: Symlink loop from '${tree}/loop1/x'`,
    ]);
  });
});
