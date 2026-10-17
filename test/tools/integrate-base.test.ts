/**
 * `tools/integrate-base.js`: the base-merge repairs, held to what a hand merge produced.
 *
 * The first block holds the pin table to THIS tree: every site matches once and reads what
 * the source measures, so a renamed test or a reworded title fails here rather than in the
 * next merge. The rest drives the merge itself -- the fixture's three-way verdict merge,
 * the joined note above `FLOOR`, and a whole `git merge` in a scratch repository with the
 * measurement stubbed, because the real one runs this suite.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describeCommands } from '../../src/cli/capabilities';
import { COMMAND_SPECS } from '../../src/cli/spec-data';

interface Site {
  readonly file: string;
  readonly metric: string;
}
interface Counts {
  paths: number;
  options: number;
  flags: number;
  json: number;
  floor: number;
}
interface Fixture {
  verdicts: unknown[];
  cases: Record<string, unknown>;
}
interface Tool {
  SITES: readonly Site[];
  toWords(n: number): string;
  fromWords(text: string): number;
  readSites(file: string, text: string): number[];
  resolveCommentHunks(text: string): { text: string; resolved: number };
  mergeSiteFile(
    file: string,
    ancestor: string,
    ours: string,
    theirs: string,
  ): { text: string; conflicted: boolean; values: { merged: number[] } };
  mergeFixture(
    ancestor: string | null,
    ours: string,
    theirs: string,
  ): { text: string; baseWins: string[][]; appended: number };
  renderFixture(fixture: Fixture): string;
  measureCounts(root: string): Omit<Counts, 'floor'>;
  run(options: {
    root: string;
    write?: boolean;
    dryRun?: boolean;
    force?: boolean;
    measure: (root: string) => Counts;
  }): { ok: boolean; lines: string[] };
}

const ROOT = path.resolve(__dirname, '..', '..');
const tool = require('../../tools/integrate-base.js') as Tool;
const { FLOOR } = require('../../tools/jest-zero-skips.js') as { FLOOR: number };

describe('the pins the tool owns, on this tree', () => {
  it('finds every site exactly once, reading what the source measures', () => {
    const measured = { ...tool.measureCounts(ROOT), floor: FLOOR };
    expect(measured.paths).toBe(COMMAND_SPECS.length);
    expect(measured.flags).toBe(
      describeCommands().reduce((total, command) => total + command.flags.length, 0),
    );
    for (const file of new Set(tool.SITES.map((site) => site.file))) {
      const values = tool.readSites(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
      const metrics = tool.SITES.filter((site) => site.file === file).map((site) => site.metric);
      expect(values).toEqual(metrics.map((metric) => measured[metric as keyof Counts]));
    }
  });

  it('reproduces the usage-error fixture byte for byte, so a merge moves no line nobody changed', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'test/fixtures/cli/usage-error.json'), 'utf8');
    expect(tool.renderFixture(JSON.parse(raw) as Fixture)).toBe(raw);
  });

  it('spells a count the way a test title does, and reads it back', () => {
    expect(tool.toWords(45)).toBe('forty-five');
    expect(tool.toWords(40)).toBe('forty');
    expect(tool.toWords(102)).toBe('one hundred and two');
    for (let n = 0; n <= 999; n += 1) expect(tool.fromWords(tool.toWords(n))).toBe(n);
  });
});

// ---------------------------------------------------------------------------------------

const V = (text: string) => ({ code: 2, stdout: '', stderr: text });

function fixture(verdicts: unknown[], cases: Record<string, unknown>): string {
  return tool.renderFixture({ verdicts, cases });
}

/** Each case path, with the verdict it points at. */
function meaning(raw: string): Record<string, unknown> {
  const doc = JSON.parse(raw) as Fixture;
  const out: Record<string, unknown> = {};
  const walk = (node: Record<string, unknown>, at: string) => {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'number') out[`${at}${key}`] = doc.verdicts[value];
      else walk(value as Record<string, unknown>, `${at}${key} > `);
    }
  };
  walk(doc.cases, '');
  return out;
}

describe('merging the usage-error fixture', () => {
  const ancestor = fixture([V('a'), V('b')], {
    group: { keep: 0, oursEdits: 1, theirsEdits: 0, theirsDrops: 0, bothEdit: 0, oursDrops: 1 },
  });
  // Ours: its verdicts in a different order, so its indices mean something else.
  const ours = fixture([V('b'), V('a'), V('ours')], {
    group: { keep: 1, oursEdits: 1, theirsEdits: 1, theirsDrops: 1, bothEdit: 2, oursAdds: 2 },
  });
  const theirs = fixture([V('a'), V('b'), V('theirs')], {
    group: { keep: 0, oursEdits: 1, theirsEdits: 2, bothEdit: 1, oursDrops: 2, theirsAdds: 2 },
  });

  it('takes each side its own changes, by verdict rather than by index', () => {
    const merged = tool.mergeFixture(ancestor, ours, theirs);
    expect(meaning(merged.text)).toEqual({
      'group > keep': V('a'),
      'group > oursEdits': V('a'),
      'group > theirsEdits': V('theirs'),
      'group > bothEdit': V('b'),
      'group > oursDrops': V('theirs'),
      'group > theirsAdds': V('theirs'),
      'group > oursAdds': V('ours'),
    });
    // The base's list keeps its order; the one verdict only ours uses is appended.
    expect((JSON.parse(merged.text) as Fixture).verdicts).toEqual([
      V('a'),
      V('b'),
      V('theirs'),
      V('ours'),
    ]);
    expect(merged.appended).toBe(1);
  });

  it('lets the base win where both sides changed a case, and names every one', () => {
    const merged = tool.mergeFixture(ancestor, ours, theirs);
    expect(merged.baseWins).toEqual([
      ['group', 'bothEdit'],
      ['group', 'oursDrops'],
    ]);
  });

  it('refuses a side not in the recorder layout rather than rewrite lines nobody changed', () => {
    const reflowed = JSON.stringify(JSON.parse(ours), null, 2);
    expect(() => tool.mergeFixture(ancestor, reflowed, theirs)).toThrow(/layout/u);
  });
});

// ---------------------------------------------------------------------------------------

describe('the note above FLOOR', () => {
  const conflict = (ours: string[], base: string[], theirs: string[], after: string) =>
    [
      'module.exports = {};',
      '<<<<<<< ours',
      ...ours,
      '||||||| base',
      ...base,
      '=======',
      ...theirs,
      '>>>>>>> theirs',
      after,
    ].join('\n');

  it('joins two notes: theirs, then the lines only ours wrote', () => {
    const text = conflict(
      ['// shared.', '// ours: total 105.'],
      ['// shared.', '// total 100.'],
      ['// theirs: total 110.'],
      'const FLOOR = 115;',
    );
    const joined = tool.resolveCommentHunks(text);
    expect(joined.resolved).toBe(1);
    // `// shared.` stays gone: ours left it alone and theirs removed it.
    expect(joined.text.split('\n')).toEqual([
      'module.exports = {};',
      '// theirs: total 110.',
      '// ours: total 105.',
      'const FLOOR = 115;',
    ]);
  });

  it('leaves a comment conflict anywhere else, and any code conflict, to the person merging', () => {
    const elsewhere = conflict(['// a'], [], ['// b'], 'function other() {}');
    expect(tool.resolveCommentHunks(elsewhere).resolved).toBe(0);
    const code = conflict(['const a = 1;'], [], ['// b'], 'const FLOOR = 1;');
    expect(tool.resolveCommentHunks(code).resolved).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// A real `git merge`, in a scratch repository that holds every pinned file.

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'integrate-base test',
  GIT_AUTHOR_EMAIL: 'integrate-base@example.invalid',
  GIT_COMMITTER_NAME: 'integrate-base test',
  GIT_COMMITTER_EMAIL: 'integrate-base@example.invalid',
};

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: process.env });
  return `${result.stdout}${result.stderr}`;
}

interface Tree extends Counts {
  notes: string[];
  other: string;
  cases: Record<string, number>;
}

/** The pinned files as this tree spells them, cut down to the lines the pins live on. */
function tree(state: Tree): Record<string, string> {
  return {
    'tools/jest-zero-skips.js': [
      "'use strict';",
      ...state.notes,
      `const FLOOR = ${String(state.floor)};`,
      'module.exports = { FLOOR };',
      '',
    ].join('\n'),
    'test/cli/foundation.test.ts': [
      `test('registers all ${String(state.paths)} unique paths and all ${String(state.flags)} logical flags', () => {`,
      `  expect(paths).toHaveLength(${String(state.paths)});`,
      `  expect(new Set(paths).size).toBe(${String(state.paths)});`,
      `  expect(specs.reduce((total, spec) => total + spec.options.length, 0)).toBe(${String(state.options)});`,
      `  expect(described.reduce((total, command) => total + command.flags.length, 0)).toBe(${String(state.flags)});`,
      `  expect(described.filter((command) => command.json)).toHaveLength(${String(state.json)});`,
      '});',
      '',
    ].join('\n'),
    'test/cli/invariants/command-surface.test.ts': [
      `it('registers exactly the ${tool.toWords(state.paths)} commands the table declares', () => {`,
      `  expect(declared).toHaveLength(${String(state.paths)});`,
      `  expect(advertised.size).toBe(${String(state.json)});`,
      `  expect(described).toHaveLength(${String(state.paths)});`,
      `  expect(flags).toBe(${String(state.flags)});`,
      '});',
      '',
    ].join('\n'),
    'test/cli/render-human.test.ts': [
      `test('all ${String(state.paths)} routable paths have a renderer', () => {`,
      `  expect(COMMAND_SPECS).toHaveLength(${String(state.paths)});`,
      '});',
      '',
    ].join('\n'),
    'test/cli/invariants/printed-commands.test.ts': `expect(COMMAND_SPECS).toHaveLength(${String(state.paths)});\n`,
    'test/cli/invariants/source-rules.test.ts': `expect(speakers.length).toBe(${String(state.json)});\n`,
    'test/fixtures/cli/usage-error.json': fixture([V('a'), V('b'), V('c')], {
      corpus: state.cases,
    }),
    'other.txt': `${state.other}\n`,
  };
}

function commit(root: string, state: Tree, message: string): void {
  for (const [file, text] of Object.entries(tree(state))) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

const ANCESTOR: Tree = {
  paths: 45,
  options: 187,
  flags: 202,
  json: 16,
  floor: 100,
  notes: ['// The suite.', '// Total 100.'],
  other: 'ancestor',
  cases: { one: 0, two: 1 },
};
// The base added a JSON command (two flags, two options) and ten tests.
const THEIRS: Tree = {
  ...ANCESTOR,
  paths: 46,
  options: 189,
  flags: 204,
  json: 17,
  floor: 110,
  notes: ['// The suite.', '// The base adds ten: total 110.'],
  other: 'theirs',
  cases: { one: 0, two: 2, three: 1 },
};
// The branch added a plain command (one flag, one option) and five tests.
const OURS: Tree = {
  ...ANCESTOR,
  paths: 46,
  options: 188,
  flags: 203,
  floor: 105,
  notes: ['// The suite.', '// The branch adds five: total 105.'],
  other: 'ours',
  cases: { zero: 1, one: 0, two: 1 },
};
const MERGED = { paths: 47, options: 190, flags: 205, json: 17, floor: 115 };

describe('a base merge, end to end', () => {
  let root: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [key, value] of Object.entries(GIT_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-integrate-base-'));
    git(root, 'init', '-q', '-b', 'base');
    commit(root, ANCESTOR, 'ancestor');
    git(root, 'checkout', '-q', '-b', 'branch');
    commit(root, OURS, 'branch');
    git(root, 'checkout', '-q', 'base');
    commit(root, THEIRS, 'base');
    git(root, 'checkout', '-q', 'branch');
    git(root, 'merge', '-q', 'base');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
  const unmerged = () => git(root, 'diff', '--name-only', '--diff-filter=U').trim();
  const never = (): Counts => {
    throw new Error('measured while paths were still unmerged');
  };

  it('merges every pinned file, stages it, and stops at the conflict it does not own', () => {
    const result = tool.run({ root, measure: never });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/1 path\(s\) still unmerged[^]*other\.txt/u);
    expect(unmerged()).toBe('other.txt');
    // The files git could not merge carry base + ours - merge base already.
    const expected = tree({ ...THEIRS, ...MERGED, notes: [], cases: {} });
    for (const file of [
      'test/cli/foundation.test.ts',
      'test/cli/invariants/command-surface.test.ts',
      'test/cli/invariants/source-rules.test.ts',
    ]) {
      expect(read(file)).toBe(expected[file]);
    }
    // Both sides wrote 46 here, so git merged it without a word. 47 waits for the measurement.
    expect(read('test/cli/render-human.test.ts')).toContain('all 46 routable paths');
    expect(read('tools/jest-zero-skips.js')).toBe(
      tree({
        ...THEIRS,
        floor: 115,
        notes: [
          '// The suite.',
          '// The base adds ten: total 110.',
          '// The branch adds five: total 105.',
        ],
      })['tools/jest-zero-skips.js'],
    );
    expect(meaning(read('test/fixtures/cli/usage-error.json'))).toEqual({
      'corpus > zero': V('b'),
      'corpus > one': V('a'),
      'corpus > two': V('c'),
      'corpus > three': V('b'),
    });
  });

  it('then measures: the counts and the floor move to what the merged tree holds', () => {
    tool.run({ root, measure: never });
    fs.writeFileSync(path.join(root, 'other.txt'), 'resolved\n');
    git(root, 'add', 'other.txt');
    // A test both sides carried was counted twice: 113, not 115, and still above both sides.
    const result = tool.run({ root, measure: () => ({ ...MERGED, floor: 113 }) });
    expect(result.lines.join('\n')).toMatch(/floor 115 -> 113/u);
    expect(result.ok).toBe(true);
    expect(read('tools/jest-zero-skips.js')).toMatch(/^const FLOOR = 113;$/mu);
    const expected = tree({ ...THEIRS, ...MERGED, notes: [], cases: {} });
    for (const file of Object.keys(expected).filter((name) => name.startsWith('test/cli/'))) {
      expect(read(file)).toBe(expected[file]);
    }
    // Everything it wrote is staged.
    expect(git(root, 'diff', '--name-only')).toBe('');
  });

  it('never lowers the floor below either side: a smaller suite lost tests', () => {
    tool.run({ root, measure: never });
    fs.writeFileSync(path.join(root, 'other.txt'), 'resolved\n');
    git(root, 'add', 'other.txt');
    const result = tool.run({ root, measure: () => ({ ...MERGED, floor: 108 }) });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(
      /collects 108 tests, below the larger side's floor of 110/u,
    );
    expect(read('tools/jest-zero-skips.js')).toMatch(/^const FLOOR = 115;$/mu);
  });

  it('leaves a pinned file someone already resolved by hand', () => {
    const file = 'test/cli/foundation.test.ts';
    fs.writeFileSync(path.join(root, file), 'resolved by hand\n');
    const result = tool.run({ root, measure: never });
    expect(result.lines.join('\n')).toContain(`${file}: already edited by hand`);
    expect(read(file)).toBe('resolved by hand\n');
  });

  it('reports a conflict marker left behind and a tool that no longer parses', () => {
    tool.run({ root, measure: never });
    fs.writeFileSync(
      path.join(root, 'other.txt'),
      '<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n',
    );
    fs.writeFileSync(
      path.join(root, 'tools', 'dup.js'),
      "'use strict';\nconst os = require('node:os');\nconst os = require('node:os');\n",
    );
    git(root, 'add', 'other.txt', 'tools/dup.js');
    const result = tool.run({ root, measure: () => MERGED });
    const text = result.lines.join('\n');
    expect(result.ok).toBe(false);
    expect(text).toMatch(/tools\/dup\.js does not parse/u);
    expect(text).toMatch(/leftover other\.txt:1: leftover conflict marker/u);
  });

  it('outside a merge, reports a stale pin and moves it only with --write', () => {
    fs.writeFileSync(path.join(root, 'other.txt'), 'resolved\n');
    git(root, 'add', 'other.txt');
    tool.run({ root, measure: () => MERGED });
    git(root, 'commit', '-q', '-m', 'merge');
    const grown = { ...MERGED, paths: 48 };
    const report = tool.run({ root, measure: () => grown });
    expect(report.ok).toBe(false);
    expect(report.lines.join('\n')).toMatch(/paths 47 -> 48 \(rerun with --write/u);
    expect(read('test/cli/render-human.test.ts')).toContain('all 47 routable paths');
    const written = tool.run({ root, write: true, measure: () => grown });
    expect(written.ok).toBe(true);
    expect(read('test/cli/render-human.test.ts')).toContain('all 48 routable paths');
    expect(read('test/cli/invariants/command-surface.test.ts')).toContain(
      'the forty-eight commands',
    );
  });
});
