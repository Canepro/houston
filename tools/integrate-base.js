#!/usr/bin/env node
/**
 * `node tools/integrate-base.js [--dry-run] [--write] [--force]` -- the mechanical part of
 * merging the base branch into a PR branch, and of moving the pins a changed command surface
 * or an added test moves.
 *
 * WHY. Every base merge into a long-lived PR branch repeated the same four repairs by hand,
 * and each one cost a full run to discover:
 *
 *   - `FLOOR` in `tools/jest-zero-skips.js`: both sides added tests, so the merged suite is
 *     larger than either side's floor, and both sides added a comment line above it.
 *   - `test/fixtures/cli/usage-error.json`: both sides recorded verdicts. Each side's case
 *     keys point at indices in that side's own verdict list, so a textual merge is wrong
 *     even when git reports no conflict.
 *   - the command-surface counts the tests pin (paths, options, flags, JSON commands): both
 *     sides added commands, so `45` on one side and `46` on the other is `47` merged, and git
 *     takes `46` silently when both sides made the same edit.
 *   - a duplicate `require` left by a resolved hunk, which only fails when the tool runs.
 *
 * WHAT IT DOES. Run it on the PR branch after `git merge --no-commit --no-ff <base>`. Without
 * `--no-commit` a merge git finishes cleanly is committed before this can repair the fixture:
 *
 *   1. It merges the three owned files above from the merge base, `HEAD` (ours) and
 *      `MERGE_HEAD` (the base, theirs), stages each one it resolves cleanly, and leaves
 *      anything else in them as conflict markers. The base wins where both sides changed
 *      the same fixture case, and every such case is printed.
 *   2. While other paths are unmerged it stops and lists them. Source conflicts are a
 *      judgement, and this tool does not make it.
 *   3. Once nothing is unmerged it MEASURES: the counts from `COMMAND_SPECS` and
 *      `describeCommands()`, and the suite size from a collection-only Jest run (`-t` with a
 *      pattern no test has, so every test is collected and none runs). A measured value
 *      replaces the arithmetic one, and a disagreement is printed.
 *   4. It checks every `tools/**\/*.js` parses (`node --check`, which is what catches a
 *      duplicate `const`) and that no change since `HEAD` leaves a conflict marker.
 *
 * Rerun it until it exits 0. Outside a merge it only measures and reports; `--write` moves
 * the pins to the measured values, which is the acknowledgement a changed surface asks for.
 *
 * THE FLOOR NEVER GOES DOWN HERE. A measured suite smaller than the floor means the merge
 * lost tests, so the tool reports it and leaves the floor alone. Lowering it stays a
 * commit that removes tests and says why.
 *
 * NOT DONE, on purpose: regenerating the skill (`yarn skill:generate`), re-recording usage
 * verdicts for a new command (`USAGE_RECORD_FOR=<command>`), or resolving any source
 * conflict. CONTRIBUTING.md ("Merging the base branch") has the whole procedure.
 */
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const FIXTURE = 'test/fixtures/cli/usage-error.json';
const FLOOR_FILE = 'tools/jest-zero-skips.js';

/**
 * Every pinned number this tool owns: one regex per site, each with one capture, and each
 * matching exactly once in its file. A site that matches zero or two times fails the run,
 * so the table cannot drift into describing nothing. `words` spells the number out.
 */
const SITES = [
  { file: FLOOR_FILE, metric: 'floor', pattern: /^const FLOOR = (\d+);$/mu },
  {
    file: 'test/cli/foundation.test.ts',
    metric: 'paths',
    pattern: /registers all (\d+) unique paths/u,
  },
  { file: 'test/cli/foundation.test.ts', metric: 'flags', pattern: /and all (\d+) logical flags/u },
  {
    file: 'test/cli/foundation.test.ts',
    metric: 'paths',
    pattern: /expect\(paths\)\.toHaveLength\((\d+)\)/u,
  },
  {
    file: 'test/cli/foundation.test.ts',
    metric: 'paths',
    pattern: /expect\(new Set\(paths\)\.size\)\.toBe\((\d+)\)/u,
  },
  {
    file: 'test/cli/foundation.test.ts',
    metric: 'options',
    pattern: /spec\.options\.length, 0\)\)\.toBe\((\d+)\)/u,
  },
  {
    file: 'test/cli/foundation.test.ts',
    metric: 'flags',
    pattern: /command\.flags\.length, 0\)\)\.toBe\((\d+)\)/u,
  },
  {
    file: 'test/cli/foundation.test.ts',
    metric: 'json',
    pattern: /described\.filter\(\(command\) => command\.json\)\)\.toHaveLength\((\d+)\)/u,
  },
  {
    file: 'test/cli/invariants/command-surface.test.ts',
    metric: 'paths',
    words: true,
    pattern: /registers exactly the ([a-z]+(?:[ -][a-z]+)*) commands the table declares/u,
  },
  {
    file: 'test/cli/invariants/command-surface.test.ts',
    metric: 'paths',
    pattern: /expect\(declared\)\.toHaveLength\((\d+)\)/u,
  },
  {
    file: 'test/cli/invariants/command-surface.test.ts',
    metric: 'json',
    pattern: /expect\(advertised\.size\)\.toBe\((\d+)\)/u,
  },
  {
    file: 'test/cli/invariants/command-surface.test.ts',
    metric: 'paths',
    pattern: /expect\(described\)\.toHaveLength\((\d+)\)/u,
  },
  {
    file: 'test/cli/invariants/command-surface.test.ts',
    metric: 'flags',
    pattern: /expect\(flags\)\.toBe\((\d+)\)/u,
  },
  { file: 'test/cli/render-human.test.ts', metric: 'paths', pattern: /all (\d+) routable paths/u },
  {
    file: 'test/cli/render-human.test.ts',
    metric: 'paths',
    pattern: /expect\(COMMAND_SPECS\)\.toHaveLength\((\d+)\)/u,
  },
  {
    file: 'test/cli/invariants/printed-commands.test.ts',
    metric: 'paths',
    pattern: /expect\(COMMAND_SPECS\)\.toHaveLength\((\d+)\)/u,
  },
  {
    file: 'test/cli/invariants/source-rules.test.ts',
    metric: 'json',
    pattern: /expect\(speakers\.length\)\.toBe\((\d+)\)/u,
  },
];

class Refusal extends Error {}

// ---------------------------------------------------------------------------------------
// Numbers, as digits and as the words a test title spells them in.

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen',
]; // prettier-ignore
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0..999 in words, hyphenated as a title spells it: `forty-five`, `one hundred and two`. */
function toWords(n) {
  if (!Number.isInteger(n) || n < 0 || n > 999) throw new Refusal(`cannot spell ${String(n)}`);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 === 0 ? '' : `-${ONES[n % 10]}`);
  const rest = n % 100;
  return `${ONES[Math.floor(n / 100)]} hundred${rest === 0 ? '' : ` and ${toWords(rest)}`}`;
}

function fromWords(text) {
  for (let n = 0; n <= 999; n += 1) if (toWords(n) === text) return n;
  throw new Refusal(`cannot read "${text}" as a number`);
}

// ---------------------------------------------------------------------------------------
// Sites.

function sitesIn(file) {
  return SITES.filter((site) => site.file === file);
}

/** The value at every site in `text`, in `SITES` order. Each must match exactly once. */
function readSites(file, text) {
  return sitesIn(file).map((site) => {
    const global = new RegExp(site.pattern.source, `${site.pattern.flags}g`);
    const matches = [...text.matchAll(global)];
    if (matches.length !== 1) {
      throw new Refusal(
        `${file}: the ${site.metric} pin ${String(site.pattern)} matches ` +
          `${String(matches.length)} times, not once. The SITES table in ` +
          'tools/integrate-base.js no longer describes this file; update it.',
      );
    }
    return site.words ? fromWords(matches[0][1]) : Number(matches[0][1]);
  });
}

function spell(site, value) {
  return site.words ? toWords(value) : String(value);
}

function placeholder(index) {
  return `@@integrate-base:${String(index)}@@`;
}

/** Replace the captured number at each site with `replace(site, index)`. */
function rewriteSites(file, text, replace) {
  let out = text;
  sitesIn(file).forEach((site, index) => {
    out = out.replace(site.pattern, (whole, captured) =>
      whole.replace(captured, replace(site, index)),
    );
  });
  return out;
}

// ---------------------------------------------------------------------------------------
// The text merge: git's own three-way merge, with every owned number taken out first.

const MARKER = /^(<{7}|\|{7}|={7}|>{7})(?: |$)/u;

function hasMarkers(text) {
  return text.split('\n').some((line) => MARKER.test(line));
}

function gitMergeFile(ours, ancestor, theirs, style = '--diff3') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrate-base-'));
  try {
    const files = { ours, base: ancestor, theirs };
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    const result = childProcess.spawnSync(
      'git',
      [
        'merge-file',
        '-p',
        ...(style === '' ? [] : [style]),
        '-L',
        'ours',
        '-L',
        'base',
        '-L',
        'theirs',
        'ours',
        'base',
        'theirs',
      ],
      { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.status === null || result.status < 0) {
      throw new Error(`git merge-file failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function isComment(line) {
  return /^\s*\/\//u.test(line);
}

/** The fixture merged by verdict, or null when a side is one the merge refuses. */
function verdictMerge(sides) {
  try {
    return mergeFixture(sides.ancestor, sides.ours, sides.theirs).text;
  } catch (error) {
    if (error instanceof Refusal) return null;
    throw error;
  }
}

/** A conflicted file with its marker labels (`<<<<<<< HEAD`, branch names) taken off. */
function unlabelled(text) {
  return text.replace(/^(<{7}|\|{7}|>{7}) .*$/gmu, '$1');
}

/**
 * True when a conflicted file is still exactly git's conflict output, in any of its three
 * styles: nobody has resolved part of it. A file someone resolved one hunk of keeps its
 * markers, so markers alone do not say the file is untouched.
 */
function asGitLeftIt(current, sides) {
  if (!hasMarkers(current)) return false;
  const want = unlabelled(current);
  return ['', '--diff3', '--zdiff3'].some(
    (style) =>
      unlabelled(gitMergeFile(sides.ours, sides.ancestor ?? '', sides.theirs, style)) === want,
  );
}

/** True when only comment lines stand between line `from` and the `FLOOR` declaration. */
function notesFloor(lines, from) {
  for (let at = from; at < lines.length; at += 1) {
    if (lines[at].startsWith('const FLOOR = ')) return true;
    if (!isComment(lines[at])) return false;
  }
  return false;
}

/**
 * Both sides wrote to the note above `FLOOR` -- each PR adds a line saying what its tests
 * cover, and often rewords the last line's total -- and git calls that a conflict. A hunk
 * of nothing but comments that runs straight into `FLOOR` is joined: theirs, then each line
 * of ours that is in neither the merge base nor theirs. A line ours left alone and theirs
 * removed stays removed. Any other hunk stays a conflict.
 */
function resolveCommentHunks(text) {
  const lines = text.split('\n');
  const out = [];
  let resolved = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('<<<<<<< ')) {
      out.push(lines[i]);
      continue;
    }
    const ancestorAt = lines.indexOf('||||||| base', i);
    const theirsAt = lines.indexOf('=======', ancestorAt);
    const endAt = lines.findIndex((line, at) => at > theirsAt && line.startsWith('>>>>>>> '));
    if (ancestorAt < 0 || theirsAt < 0 || endAt < 0) {
      out.push(lines[i]);
      continue;
    }
    const ours = lines.slice(i + 1, ancestorAt);
    const ancestor = lines.slice(ancestorAt + 1, theirsAt);
    const theirs = lines.slice(theirsAt + 1, endAt);
    const comments = [...ours, ...ancestor, ...theirs].every(isComment);
    if (comments && notesFloor(lines, endAt + 1)) {
      const known = new Set([...ancestor, ...theirs]);
      out.push(...theirs, ...ours.filter((line) => !known.has(line)));
      resolved += 1;
    } else {
      out.push(...lines.slice(i, endAt + 1));
    }
    i = endAt;
  }
  return { text: out.join('\n'), resolved };
}

/**
 * Merge one file that holds owned numbers. Each number becomes base + (ours - ancestor):
 * what the base has, plus what this branch added. Measurement corrects it later. The floor
 * is never written below either side's: a branch that removed tests would otherwise stage
 * a floor under the base's while a conflict elsewhere holds the measurement off.
 */
function mergeSiteFile(file, ancestor, ours, theirs) {
  const values = {
    ancestor: readSites(file, ancestor),
    ours: readSites(file, ours),
    theirs: readSites(file, theirs),
  };
  const neutral = (text) => rewriteSites(file, text, (_site, index) => placeholder(index));
  let text = gitMergeFile(neutral(ours), neutral(ancestor), neutral(theirs));
  let comments = 0;
  if (file === FLOOR_FILE) ({ text, resolved: comments } = resolveCommentHunks(text));
  const merged = sitesIn(file).map((site, index) => {
    const sum = values.theirs[index] + values.ours[index] - values.ancestor[index];
    return site.metric === 'floor' ? Math.max(sum, values.ours[index], values.theirs[index]) : sum;
  });
  sitesIn(file).forEach((site, index) => {
    text = text.split(placeholder(index)).join(spell(site, merged[index]));
  });
  return { text, values: { ...values, merged }, comments, conflicted: hasMarkers(text) };
}

// ---------------------------------------------------------------------------------------
// The usage-error fixture: a three-way merge of verdicts, not of text.

/** The fixture's own layout, as `serializeRecorded` in test/cli/usage-error.test.ts writes. */
function renderFixture(fixture) {
  const map = (node, indent) => {
    const entries = Object.entries(node);
    const inner = `${indent}  `;
    const body = entries.map(([key, value]) => {
      const rendered = isPlainObject(value) ? map(value, inner) : String(value);
      return `${inner}${JSON.stringify(key)}: ${rendered}`;
    });
    return ['{', ...(body.length === 0 ? [] : [body.join(',\n')]), `${indent}}`].join('\n');
  };
  const verdicts = fixture.verdicts.map((verdict) => `    ${JSON.stringify(verdict)}`);
  return `{\n  "verdicts": [\n${verdicts.join(',\n')}\n  ],\n  "cases": ${map(fixture.cases, '  ')}\n}\n`;
}

/** Every case path with the verdict it points at, as one comparable string. */
function fixtureMeaning(raw) {
  const fixture = JSON.parse(raw);
  const out = [];
  const walk = (node, at) => {
    for (const [key, value] of Object.entries(node)) {
      if (isPlainObject(value)) walk(value, [...at, key]);
      else out.push(JSON.stringify([...at, key, fixture.verdicts[value]]));
    }
  };
  walk(fixture.cases, []);
  return out.sort().join('\n');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFixture(raw, side) {
  const fixture = JSON.parse(raw);
  if (!Array.isArray(fixture.verdicts) || !isPlainObject(fixture.cases)) {
    throw new Refusal(`${FIXTURE} (${side}) is not a verdicts/cases document`);
  }
  if (renderFixture(fixture) !== raw) {
    throw new Refusal(
      `${FIXTURE} (${side}) is not in the layout the recorder writes, so a rewrite would ` +
        'move lines nobody changed. Resolve it by hand.',
    );
  }
  return fixture;
}

/**
 * Merge `cases` key by key, comparing VERDICTS (not indices, which are per side):
 * a case one side changed takes that side; a case both changed differently takes the base
 * and is reported; a case one side deleted and the other left alone is deleted. The base's
 * verdict list keeps its order; a verdict only ours uses is appended.
 */
function mergeFixture(ancestorRaw, oursRaw, theirsRaw) {
  const ancestor =
    ancestorRaw === null ? { verdicts: [], cases: {} } : parseFixture(ancestorRaw, 'base');
  const ours = parseFixture(oursRaw, 'ours');
  const theirs = parseFixture(theirsRaw, 'theirs');
  const verdicts = [...theirs.verdicts];
  const indexOf = new Map();
  verdicts.forEach((verdict, index) => {
    const key = JSON.stringify(verdict);
    if (!indexOf.has(key)) indexOf.set(key, index);
  });
  const fromOurs = (index) => {
    const key = JSON.stringify(ours.verdicts[index]);
    if (!indexOf.has(key)) {
      verdicts.push(ours.verdicts[index]);
      indexOf.set(key, verdicts.length - 1);
    }
    return indexOf.get(key);
  };
  const verdictOf = (doc, index) =>
    index === undefined ? undefined : JSON.stringify(doc.verdicts[index]);
  const baseWins = [];

  const merge = (a, o, t, at) => {
    const out = {};
    const keys = [...Object.keys(t), ...Object.keys(o).filter((key) => !(key in t))];
    for (const key of keys) {
      const where = [...at, key];
      const av = a[key];
      const ov = o[key];
      const tv = t[key];
      if ([av, ov, tv].some(isPlainObject)) {
        if (![av, ov, tv].every((value) => value === undefined || isPlainObject(value))) {
          throw new Refusal(`${FIXTURE}: ${where.join(' > ')} is a group on one side only`);
        }
        const child = merge(av ?? {}, ov ?? {}, tv ?? {}, where);
        if (Object.keys(child).length > 0 || tv !== undefined) out[key] = child;
        continue;
      }
      const A = verdictOf(ancestor, av);
      const O = verdictOf(ours, ov);
      const T = verdictOf(theirs, tv);
      if (O !== undefined && T !== undefined) {
        if (O === T || O === A) out[key] = tv;
        else if (T === A) out[key] = fromOurs(ov);
        else {
          out[key] = tv;
          baseWins.push(where);
        }
      } else if (T !== undefined) {
        // Ours has no such case: we deleted it, or the base added it.
        if (A === undefined) out[key] = tv;
        else if (T !== A) {
          out[key] = tv;
          baseWins.push(where);
        }
      } else if (O !== undefined) {
        // The base has no such case: it deleted it, or we added it.
        if (A === undefined) out[key] = fromOurs(ov);
        else if (O !== A) baseWins.push(where);
      }
    }
    return out;
  };

  const cases = merge(ancestor.cases, ours.cases, theirs.cases, []);
  return {
    text: renderFixture({ verdicts, cases }),
    baseWins,
    appended: verdicts.length - theirs.verdicts.length,
  };
}

// ---------------------------------------------------------------------------------------
// Git.

function git(root, args, allowFail = false) {
  const result = childProcess.spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result;
}

function show(root, rev, file) {
  const result = git(root, ['show', `${rev}:${file}`], true);
  return result.status === 0 ? result.stdout : null;
}

function mergeState(root) {
  const head = git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true);
  if (head.status !== 0) return null;
  const theirs = head.stdout.trim();
  const bases = git(root, ['merge-base', '--all', 'HEAD', theirs]).stdout.trim().split('\n');
  return { theirs, ancestor: bases[0], bases: bases.length };
}

function unmergedPaths(root) {
  const out = git(root, ['diff', '--name-only', '--diff-filter=U']).stdout.trim();
  return out === '' ? [] : out.split('\n');
}

function changedOnBothSides(root, merge, file) {
  const ancestor = show(root, merge.ancestor, file);
  return show(root, 'HEAD', file) !== ancestor && show(root, merge.theirs, file) !== ancestor;
}

// ---------------------------------------------------------------------------------------
// Measurement.

/** The four counts, from the same declarations the parser and `capabilities` read. */
function measureCounts(root) {
  require(path.join(root, 'tools', 'ts-require.js')).install();
  const { COMMAND_SPECS } = require(path.join(root, 'src', 'cli', 'spec-data.ts'));
  const { describeCommands } = require(path.join(root, 'src', 'cli', 'capabilities.ts'));
  const paths = COMMAND_SPECS.map((spec) => spec.path);
  if (new Set(paths).size !== paths.length) {
    throw new Refusal('COMMAND_SPECS declares the same path twice; that is a source conflict');
  }
  return {
    paths: paths.length,
    options: COMMAND_SPECS.reduce((total, spec) => total + spec.options.length, 0),
    flags: describeCommands().reduce((total, command) => total + command.flags.length, 0),
    json: COMMAND_SPECS.filter((spec) => spec.json.mode !== 'none').length,
  };
}

/**
 * The suite's size, from a run that collects every test and executes none: `-t` with a
 * pattern no test name has. Jest still loads each file and runs its `describe` bodies, so a
 * file that fails to load shows up as a failed suite and the count is not trusted.
 */
function measureFloor(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrate-base-collect-'));
  try {
    const output = path.join(dir, 'collect.json');
    const result = childProcess.spawnSync(
      process.execPath,
      [
        require.resolve('jest/bin/jest', { paths: [root] }),
        '--ci',
        '-t',
        'integrate-base: collect every test and run none',
        '--json',
        '--outputFile',
        output,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, HOUSTON_HOME: path.join(dir, 'home') },
      },
    );
    if (!fs.existsSync(output)) {
      throw new Refusal(`the collection run wrote no result: ${result.stderr.slice(-2000)}`);
    }
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    return collectionCount(root, result.status, report, result.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The count a collection run's report holds, or a refusal. Jest's exit code is part of the
 * verdict: the zero-skips reporter fails an authored `.skip` or `.only` through it alone,
 * and the report it leaves behind looks whole.
 */
function collectionCount(root, status, report, stderr) {
  const broken = report.testResults
    .filter((suite) => suite.status !== 'passed' && suite.message)
    .map((suite) => path.relative(root, suite.name));
  if (report.numRuntimeErrorTestSuites > 0 || broken.length > 0) {
    throw new Refusal(
      `${String(broken.length)} test file(s) failed to load, so the suite cannot be ` +
        `counted:\n    ${broken.join('\n    ')}`,
    );
  }
  if (report.numPassedTests !== 0 || report.numFailedTests !== 0) {
    throw new Refusal('the collection run executed tests; its pattern matched a test name');
  }
  if (status !== 0) {
    throw new Refusal(
      `the collection run exited ${String(status)}, so its count is not trusted:\n` +
        stderr.slice(-2000),
    );
  }
  return report.numTotalTests;
}

// ---------------------------------------------------------------------------------------
// Checks that need no merge.

function trackedTools(root) {
  return git(root, ['ls-files', '-z', '--', 'tools/*.js', 'tools/**/*.js'])
    .stdout.split('\0')
    .filter((file) => file !== '');
}

function syntaxProblems(root) {
  const problems = [];
  for (const file of trackedTools(root)) {
    const result = childProcess.spawnSync(process.execPath, ['--check', path.join(root, file)], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      const reason = result.stderr.split('\n').find((line) => /Error/u.test(line)) ?? '';
      problems.push(`${file} does not parse: ${reason.trim()}`);
    }
  }
  return problems;
}

function markerProblems(root) {
  const result = git(root, ['diff', '--check', 'HEAD'], true);
  return result.stdout
    .split('\n')
    .filter((line) => /conflict marker/u.test(line))
    .map((line) => `leftover ${line.trim()}`);
}

// ---------------------------------------------------------------------------------------
// The run.

function run(options) {
  const { root, dryRun = false, write = false, force = false, measure } = options;
  const out = [];
  const say = (line) => out.push(line);
  const problems = [];
  const merge = mergeState(root);
  const writes = new Map();
  const put = (file, text) => {
    writes.set(file, text);
    if (!dryRun) fs.writeFileSync(path.join(root, file), text);
  };

  if (merge !== null) {
    say(
      `merging ${merge.theirs.slice(0, 12)} into HEAD (merge base ${merge.ancestor.slice(0, 12)})`,
    );
    if (merge.bases > 1) {
      say(`  warning: ${String(merge.bases)} merge bases; the first stands in for all of them`);
    }
    const unmerged = unmergedPaths(root);
    const owned = [FIXTURE, ...new Set(SITES.map((site) => site.file))];
    for (const file of owned) {
      try {
        const conflicted = unmerged.includes(file);
        if (!fs.existsSync(path.join(root, file))) {
          problems.push(
            `${file} is missing from the tree (deleted on one side); resolve it by hand`,
          );
          continue;
        }
        const current = fs.readFileSync(path.join(root, file), 'utf8');
        // A pinned file git merged by itself is left to the measurement below. The fixture is
        // not: a textual merge of two sides' verdict indices is wrong even when it is clean.
        if (
          file === FIXTURE ? !conflicted && !changedOnBothSides(root, merge, file) : !conflicted
        ) {
          continue;
        }
        const sides = {
          ancestor: show(root, merge.ancestor, file),
          ours: show(root, 'HEAD', file),
          theirs: show(root, merge.theirs, file),
        };
        if (sides.ours === null || sides.theirs === null) {
          problems.push(`${file} is missing on one side; resolve it by hand`);
          continue;
        }
        // Untouched is what git left: conflict markers, or for the fixture, git's own clean
        // merge. Anything else someone wrote -- staged or not -- is theirs to keep, and is
        // not merged again: a side the fixture merge refuses cannot block a hand resolution.
        const untouched = conflicted
          ? asGitLeftIt(current, sides)
          : current === gitMergeFile(sides.ours, sides.ancestor ?? '', sides.theirs);
        if (!untouched && !force) {
          // This tool's own earlier write, on a rerun.
          if (file === FIXTURE && verdictMerge(sides) === current) continue;
          say(`  ${file}: already edited by hand, left alone (--force merges it anyway)`);
          continue;
        }
        const verdicts =
          file === FIXTURE ? mergeFixture(sides.ancestor, sides.ours, sides.theirs) : null;
        if (verdicts !== null) {
          put(file, verdicts.text);
          say(`  ${file}: merged, ${String(verdicts.appended)} verdict(s) appended from ours`);
          for (const where of verdicts.baseWins) {
            say(`    both sides changed ${where.join(' > ')}; the base's verdict stands`);
          }
          continue;
        }
        if (sides.ancestor === null) {
          problems.push(`${file} has no merge-base version; resolve it by hand`);
          continue;
        }
        const result = mergeSiteFile(file, sides.ancestor, sides.ours, sides.theirs);
        put(file, result.text);
        const moved = distinct(
          sitesIn(file)
            .map((site, index) => [site, index])
            .filter(([, index]) => result.values.merged[index] !== result.values.ours[index])
            .map(([site, index]) => `${site.metric} ${String(result.values.merged[index])}`),
        );
        say(
          `  ${file}: merged` +
            (moved.length > 0 ? `; ${moved.join(', ')} (base + ours - merge base)` : '') +
            (result.comments > 0 ? `; ${String(result.comments)} comment hunk(s) joined` : ''),
        );
        if (result.conflicted) problems.push(`${file} still has a conflict outside the pins`);
      } catch (error) {
        // One unreadable file is reported; the files already merged are still staged.
        if (!(error instanceof Refusal)) throw error;
        problems.push(error.message);
      }
    }
    if (!dryRun) {
      const clean = [...writes].filter(([, text]) => !hasMarkers(text)).map(([file]) => file);
      if (clean.length > 0) git(root, ['add', '--', ...clean]);
    }
    const left = dryRun
      ? unmerged.filter((file) => !writes.has(file) || hasMarkers(writes.get(file)))
      : unmergedPaths(root);
    if (left.length > 0) {
      problems.push(
        `${String(left.length)} path(s) still unmerged; resolve them, then rerun:\n    ` +
          left.join('\n    '),
      );
      return finish(out, problems);
    }
    if (dryRun && writes.size > 0) {
      // The measurement reads the tree on disk, which still holds what git left.
      problems.push(
        `dry run: ${String(writes.size)} file(s) above are not written, and the measurement ` +
          'reads the tree on disk; rerun without --dry-run to measure the merge',
      );
      return finish(out, problems);
    }
  }

  if (merge === null) {
    const committed = committedFixtureMerge(root);
    if (committed !== null) {
      if (write && !dryRun) {
        fs.writeFileSync(path.join(root, FIXTURE), committed);
        git(root, ['add', '--', FIXTURE]);
        say(`  ${FIXTURE}: merged by verdict; \`git commit --amend\` records it in the merge`);
      } else {
        problems.push(
          `HEAD is a merge git committed by itself with a textual merge of usage-error.json, ` +
            'which can point cases at the wrong verdicts; rerun with --write, then ' +
            '`git commit --amend`',
        );
      }
    }
  }

  // Measure the merged (or current) tree, and move each pin to what it measures.
  const adjust = merge !== null || write;
  let measured;
  try {
    measured = measure(root);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    problems.push(error.message);
    return finish(out, problems);
  }
  const bounds = lowerBounds(root, merge, force);
  for (const file of new Set(SITES.map((site) => site.file))) {
    if (!writes.has(file) && !fs.existsSync(path.join(root, file))) {
      problems.push(`${file} is missing from the tree, so its pins cannot be checked`);
      continue;
    }
    const text = writes.get(file) ?? fs.readFileSync(path.join(root, file), 'utf8');
    let current;
    try {
      current = readSites(file, text);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      problems.push(error.message);
      continue;
    }
    const changes = [];
    const next = rewriteSites(file, text, (site, index) => {
      const want = measured[site.metric];
      const least = bounds[site.metric];
      if (least !== undefined && want < least.value) {
        problems.push(
          site.metric === 'floor'
            ? `the suite collects ${String(want)} tests, below ${least.what} of ` +
                `${String(least.value)}: tests were lost. The floor is not lowered here.`
            : `the merged tree has ${String(want)} ${site.metric}, fewer than ${least.what} ` +
                `${String(least.value)}: a command one side added was lost. Pins left alone; ` +
                '--force moves them anyway.',
        );
        return spell(site, current[index]);
      }
      if (want !== current[index]) {
        changes.push(`${site.metric} ${String(current[index])} -> ${String(want)}`);
      }
      return spell(site, want);
    });
    if (changes.length === 0) continue;
    if (!adjust) {
      problems.push(
        `${file}: ${distinct(changes).join(', ')} (rerun with --write to move the pins)`,
      );
      continue;
    }
    if (!dryRun) {
      fs.writeFileSync(path.join(root, file), next);
      if (merge !== null && !hasMarkers(next)) git(root, ['add', '--', file]);
    }
    say(`  ${file}: ${dryRun ? 'would move' : 'measured'} ${distinct(changes).join(', ')}`);
    if (dryRun) problems.push(`dry run: ${file} is not written yet`);
  }
  say(
    `measured: ${String(measured.paths)} paths, ${String(measured.options)} options, ` +
      `${String(measured.flags)} flags, ${String(measured.json)} JSON commands, ` +
      `${String(measured.floor)} tests`,
  );

  problems.push(...syntaxProblems(root), ...markerProblems(root));
  return finish(out, problems);
}

function distinct(items) {
  return [...new Set(items)];
}

/**
 * When HEAD is a merge whose fixture is still git's own textual merge of its parents, and
 * that differs from the merge by verdict, the merge by verdict. Otherwise null. This is the
 * merge `git merge` without `--no-commit` finishes before this tool can run.
 */
function committedFixtureMerge(root) {
  if (git(root, ['rev-parse', '-q', '--verify', 'HEAD^2'], true).status !== 0) return null;
  const bases = git(root, ['merge-base', 'HEAD^1', 'HEAD^2'], true);
  if (bases.status !== 0) return null;
  const ancestor = show(root, bases.stdout.trim(), FIXTURE);
  const ours = show(root, 'HEAD^1', FIXTURE);
  const theirs = show(root, 'HEAD^2', FIXTURE);
  // Only one side changed it: git's merge is that side's file, which is right.
  if (ours === null || theirs === null || ancestor === null) return null;
  if (ours === ancestor || theirs === ancestor || ours === theirs) return null;
  const current = fs.readFileSync(path.join(root, FIXTURE), 'utf8');
  if (current !== gitMergeFile(ours, ancestor, theirs)) return null;
  try {
    const merged = mergeFixture(ancestor, ours, theirs).text;
    // Different bytes are not a wrong merge; a case pointing at a different verdict is.
    return fixtureMeaning(merged) === fixtureMeaning(current) ? null : merged;
  } catch (error) {
    if (error instanceof Refusal) return null;
    throw error;
  }
}

/**
 * The value of `metric` in `text`, from the first of its pins that reads, or null. One pin
 * at a time: an unreadable pin elsewhere in the file does not hide this one.
 */
function pinValue(text, metric) {
  for (const site of SITES.filter((candidate) => candidate.metric === metric)) {
    const global = new RegExp(site.pattern.source, `${site.pattern.flags}g`);
    const matches = [...text.matchAll(global)];
    if (matches.length !== 1) continue;
    try {
      return site.words ? fromWords(matches[0][1]) : Number(matches[0][1]);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
    }
  }
  return null;
}

/** The value of `metric` in `rev`, or null when no pin of it there can be read. */
function pinnedAt(root, rev, metric) {
  for (const file of distinct(SITES.filter((site) => site.metric === metric).map((s) => s.file))) {
    const text = show(root, rev, file);
    const value = text === null ? null : pinValue(text, metric);
    if (value !== null) return value;
  }
  return null;
}

/**
 * How low each measured value may go, by metric.
 *
 * The floor: outside a merge, the floor as it stands -- only a commit that removes tests
 * lowers it. In a merge, the larger of the two sides' floors, not the arithmetic sum, which
 * counts twice a test both sides carry (a shared commit, a cherry-pick): the merged suite
 * holds everything either side held unless the merge lost some.
 *
 * The command counts, in a merge where neither side removed any: the larger side's. A
 * merged registry smaller than that dropped a command one side added. `--force` lifts this
 * one; a side that removed commands lifts it too, since then the smaller count is the point.
 * A merge base with no readable pin cannot show a removal, so there the bound stands.
 */
function lowerBounds(root, merge, force) {
  const bounds = {};
  const current = (metric) => pinnedAt(root, 'HEAD', metric);
  if (merge === null) {
    const text = fs.existsSync(path.join(root, FLOOR_FILE))
      ? fs.readFileSync(path.join(root, FLOOR_FILE), 'utf8')
      : '';
    // An unreadable floor is reported by the measurement loop, file by file.
    const floor = pinValue(text, 'floor');
    if (floor !== null) bounds.floor = { value: floor, what: 'the floor' };
    return bounds;
  }
  for (const metric of distinct(SITES.map((site) => site.metric))) {
    const ours = current(metric);
    const theirs = pinnedAt(root, merge.theirs, metric);
    const ancestor = pinnedAt(root, merge.ancestor, metric);
    if (ours === null || theirs === null) continue;
    const value = Math.max(ours, theirs);
    if (metric === 'floor') {
      bounds.floor = { value, what: "the larger side's floor" };
    } else if (!force && (ancestor === null || (ours >= ancestor && theirs >= ancestor))) {
      // With no readable merge base, a side that removed commands cannot be told apart, so
      // the bound stands and --force is the way past it.
      bounds[metric] = { value, what: "the larger side's" };
    }
  }
  return bounds;
}

function finish(out, problems) {
  if (problems.length > 0) out.push(`integrate-base: not done:\n  - ${problems.join('\n  - ')}`);
  else out.push('integrate-base: done; every owned file is merged and every pin measures true');
  return { ok: problems.length === 0, lines: out };
}

function measureAll(root) {
  return { ...measureCounts(root), floor: measureFloor(root) };
}

function main(argv) {
  const flags = new Set(argv);
  const known = new Set(['--dry-run', '--write', '--force']);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    process.stderr.write(
      `integrate-base: unknown argument ${unknown[0]}\n` +
        'usage: node tools/integrate-base.js [--dry-run] [--write] [--force]\n',
    );
    return 2;
  }
  try {
    const result = run({
      root: ROOT,
      dryRun: flags.has('--dry-run'),
      write: flags.has('--write'),
      force: flags.has('--force'),
      measure: measureAll,
    });
    process.stdout.write(`${result.lines.join('\n')}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stderr.write(`integrate-base: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  SITES,
  Refusal,
  toWords,
  fromWords,
  readSites,
  resolveCommentHunks,
  mergeSiteFile,
  mergeFixture,
  renderFixture,
  measureCounts,
  collectionCount,
  run,
};
