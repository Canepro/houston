#!/usr/bin/env node
/**
 * Prove the layer gate can SEE a violation, then remove it.
 *
 * `dependency-cruiser` `tryImport`s `typescript` and walks `SyntaxKind`. When that
 * import does not take, it does not fail -- it falls back to a non-TypeScript parser,
 * finds nothing, and reports "no dependency violations found" on a tree full of them.
 * A layer gate in that state is a green light with no bulb, and nothing about its
 * output distinguishes it from a clean tree. The difference was measured on TS 5.9.3,
 * and this is that measurement wired in as a CI step.
 *
 * Four things are planted, all as NEW files -- no existing source is edited, so an
 * interrupted run cannot leave a real module modified:
 *
 *   1. a CYCLE, which must be reported by `no-circular`;
 *   2. a rank-0 -> rank-4 edge, which must be reported by the downward-only rule;
 *   3. a FORBIDDEN IMPORT of `node:child_process`, which must be reported by
 *      `only-exec-launches-processes`;
 *   4. the upward edge is TYPE-ONLY, so it exists nowhere in the emitted JavaScript.
 *      Reporting it is only possible through the TypeScript compiler API, which is
 *      the specific thing a silent fallback would lose.
 *
 * The real `.dependency-cruiser.js` is used unmodified. A self-test against a relaxed
 * copy of the config would prove something about the copy.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROBE_DIR = path.join(ROOT, 'src', '__depcruise_selftest__');

const PLANTED = {
  'rank0.ts': [
    '// PLANTED by tools/depcruise-selftest.js. Deleted again by the same run.',
    "import type { Rank4 } from './rank4';",
    'export type Rank0 = { peer: Rank4 };',
    'export const rank0 = 1;',
    '',
  ].join('\n'),
  'rank4.ts': [
    '// PLANTED by tools/depcruise-selftest.js. Deleted again by the same run.',
    "import { rank0 } from './rank0';",
    "import { spawnSync } from 'node:child_process';",
    'export type Rank4 = { n: number };',
    "export const rank4 = rank0 + Number(typeof spawnSync === 'function');",
    '',
  ].join('\n'),
};

/** Every rule name the planted tree must trigger, and what each one proves. */
const MUST_REPORT = [
  ['no-circular', 'a planted import cycle'],
  ['layer-0-imports-down-only', 'a planted rank-0 to rank-4 import'],
  ['only-exec-launches-processes', 'a planted import of node:child_process'],
];

const BIN = path.join(ROOT, 'node_modules', '.bin', 'depcruise');
const GATE = path.join(ROOT, 'tools', 'depcruise.js');

/**
 * The exit code of the run CI ACTUALLY GATES ON.
 *
 * `--output-type json` reports every violation in its payload and still exits 0, so
 * reading the status off the JSON run would assert nothing — it is 0 on a clean tree
 * and 0 on a planted one alike. `yarn depcruise` uses the default `err` reporter, and
 * that is the exit code a CI step turns into a red build, so that is the one checked.
 */
function depcruiseExitCode() {
  const proc = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8' });
  if (proc.error) throw new Error(`could not run ${GATE}: ${proc.error.message}`);
  return proc.status;
}

function depcruise() {
  const proc = spawnSync(BIN, ['--output-type', 'json', 'src'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.error) {
    throw new Error(`could not run ${BIN}: ${proc.error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch {
    throw new Error(
      `depcruise did not produce JSON (exit ${proc.status}).\n` +
        `stdout: ${proc.stdout.slice(0, 2000)}\nstderr: ${proc.stderr.slice(0, 2000)}`,
    );
  }
  const violations = parsed.summary ? parsed.summary.violations || [] : [];
  return {
    status: proc.status,
    violations,
    names: violations.map((v) => v.rule && v.rule.name).filter(Boolean),
    /** One line per violation, so two runs can be compared as sets. */
    signature: new Set(
      violations.map(
        (v) => `${v.rule && v.rule.severity}:${v.rule && v.rule.name}:${v.from}->${v.to}`,
      ),
    ),
    errors: violations.filter((v) => v.rule && v.rule.severity === 'error'),
    modules: parsed.summary ? parsed.summary.totalCruised : 0,
    stderr: proc.stderr,
  };
}

/** `a \ b`, as a sorted array. */
function without(a, b) {
  return [...a].filter((item) => !b.has(item)).sort();
}

function fail(message) {
  process.stderr.write(`depcruise:selftest FAILED — ${message}\n`);
  process.exitCode = 1;
  return false;
}

function main() {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const paths = Object.keys(PLANTED).map((name) => path.join(PROBE_DIR, name));

  for (const p of paths) {
    if (fs.existsSync(p)) {
      return fail(`${path.relative(ROOT, p)} already exists; refusing to overwrite it`);
    }
  }

  // BEFORE. A green result after planting means nothing unless green means something
  // beforehand.
  //
  // The baseline is the violation SET, not "no violations at all". A standing WARNING
  // is legitimate here: `no-orphans` fires on a module that nothing imports yet.
  // Demanding an empty tree would leave two bad options -- exempt the rule and lose it
  // for a genuine orphan, or let the self-test fail for a reason that is not about the
  // gate. Comparing sets keeps the rule live, lets a standing warning clear itself when
  // its module is imported, and still proves the planted violations are NEW.
  //
  // ERRORS are different and are refused outright: an error-severity violation means
  // `yarn depcruise` is already red, and self-testing a gate that is currently failing
  // proves nothing about either.
  const before = depcruise();
  if (before.errors.length > 0) {
    return fail(
      `the tree already has ${before.errors.length} ERROR-severity violation(s) ` +
        `(${[...new Set(before.errors.map((v) => v.rule.name))].join(', ')}); ` +
        'fix those before self-testing the gate',
    );
  }
  if (before.violations.length > 0) {
    process.stdout.write(
      `  baseline  ${before.violations.length} standing warning(s): ` +
        `${[...new Set(before.names)].join(', ')}\n`,
    );
  }
  for (const [rule] of MUST_REPORT) {
    if (before.names.includes(rule)) {
      return fail(`${rule} is ALREADY firing before anything was planted`);
    }
  }
  const beforeExit = depcruiseExitCode();
  if (beforeExit !== 0) {
    return fail(`\`yarn depcruise\` exits ${beforeExit} on the unplanted tree`);
  }

  let after;
  let afterExit;
  try {
    for (const [name, body] of Object.entries(PLANTED)) {
      fs.writeFileSync(path.join(PROBE_DIR, name), body, 'utf8');
    }
    after = depcruise();
    afterExit = depcruiseExitCode();
  } finally {
    for (const p of paths) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
    try {
      fs.rmdirSync(PROBE_DIR);
    } catch {
      /* a future real directory or interrupted foreign run is not ours to remove */
    }
  }

  let ok = true;
  for (const [rule, what] of MUST_REPORT) {
    if (after.names.includes(rule)) {
      process.stdout.write(`  REPORTED  ${rule}  (${what})\n`);
    } else {
      ok = fail(
        `${rule} did NOT fire on ${what}. depcruise exited ${after.status} with ` +
          `${after.violations.length} violation(s): ${[...new Set(after.names)].join(', ') || 'none'}. ` +
          'This is the silent-no-op mode: the gate is green and blind.',
      );
    }
  }
  if (afterExit === 0) {
    ok = fail(
      '`yarn depcruise` exited 0 on a tree with a planted cycle and a planted seam ' +
        'bypass, so CI would go green on both',
    );
  }

  // AFTER. The planted files are gone and the tree reports EXACTLY what it reported
  // before -- not "nothing", which would be a different and weaker claim. This is also
  // how a half-cleaned run gets caught rather than poisoning the next commit.
  const restored = depcruise();
  const added = without(restored.signature, before.signature);
  const lost = without(before.signature, restored.signature);
  if (added.length > 0) {
    ok = fail(`cleanup left violations behind: ${added.join(' | ')}`);
  }
  if (lost.length > 0) {
    ok = fail(`the run made pre-existing violations disappear: ${lost.join(' | ')}`);
  }
  for (const p of paths) {
    if (fs.existsSync(p)) ok = fail(`${path.relative(ROOT, p)} was not removed`);
  }

  if (ok) {
    process.stdout.write(
      `depcruise:selftest PASSED — ${MUST_REPORT.length} planted violation classes, ` +
        `${MUST_REPORT.length} reported; \`yarn depcruise\` exit ${afterExit} while planted; ` +
        `tree back to its exact baseline afterwards ` +
        `(${restored.modules} modules, ${restored.violations.length} standing warning(s))\n`,
    );
  }
  return ok;
}

main();
