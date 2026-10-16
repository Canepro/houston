#!/usr/bin/env node
/**
 * Prove the zero-skips gate can fail, by making it fail every way it claims to.
 *
 * `tools/browser-results.js` set this convention for the browser suite, and its reason is
 * the reason for this file: a gate nobody has watched fail is a gate that does not work. The
 * failure the gate exists for -- a suite that reports green while testing nothing -- is
 * exactly a gate that was never exercised.
 *
 * THE CONTRACT:
 *
 *   1. the probe path must not exist and must not be tracked, or the run refuses;
 *   2. the unplanted probe PASSES first, so a later red cannot be the probe itself;
 *   3. each defect is planted ALONE, and the run must fail WITH THE WORDING THAT NAMES IT --
 *      a red for any other reason is rejected, because it is indistinguishable from a gate
 *      that never ran;
 *   4. the probe is removed in a `finally`, and its absence is asserted;
 *   5. the whole suite then passes under `--ci`, which is how a half-cleaned tree is caught
 *      here rather than in the next commit.
 *
 * SIGINT and SIGTERM remove the probe too. Do not run this beside another Jest run: the probe
 * lives under `test/` for the length of each case, because the source check must see it.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROBE_RELATIVE = 'test/__zero_skips_probe__.test.ts';
const PROBE = path.join(ROOT, PROBE_RELATIVE);

/** A passing test, so the baseline is green for a reason of its own. */
const SOUND = "it('is a probe that passes', () => {\n  expect(1 + 1).toBe(2);\n});";

const PLANTS = [
  {
    id: 'skip',
    what: 'an ordinary it.skip',
    body: `${SOUND}\n\nit.skip('is the planted skip', () => {\n  expect(true).toBe(true);\n});`,
    says: ['pending: test/__zero_skips_probe__.test.ts -- is the planted skip'],
  },
  {
    id: 'todo',
    what: 'an it.todo, which Jest counts apart from pending',
    body: `${SOUND}\n\nit.todo('is the planted todo');`,
    says: ['todo: test/__zero_skips_probe__.test.ts -- is the planted todo'],
  },
  {
    id: 'only',
    what: 'a stray .only, which silently drops the rest of its file',
    body: `${SOUND}\n\nit.only('is the only one that runs', () => {\n  expect(true).toBe(true);\n});`,
    says: ['pending: test/__zero_skips_probe__.test.ts -- is a probe that passes', 'uses it.only'],
  },
  {
    id: 'conditional-firing',
    what: 'a platform guard that fires on every supported Unix-like machine',
    body:
      `${SOUND}\n\n(process.platform !== 'win32' ? describe.skip : describe)('a guard', () => {\n` +
      "  it('never runs here', () => {\n    expect(true).toBe(true);\n  });\n});",
    says: ['pending:', 'authored skip construct with no written reason', PROBE_RELATIVE],
  },
  {
    id: 'conditional-inert',
    what: 'a platform guard that does NOT fire here, so only the source check can see it',
    body:
      `${SOUND}\n\n(process.platform === 'win32' ? describe.skip : describe)('a guard', () => {\n` +
      "  it('runs here and would not elsewhere', () => {\n    expect(true).toBe(true);\n  });\n});",
    says: ['authored skip construct with no written reason', `${PROBE_RELATIVE}:`],
    // The case a runtime-only gate waves through: nothing at all was skipped on this run.
    runtimeClean: true,
  },
];

function fail(message) {
  process.stderr.write(`zero-skips:selftest FAILED -- ${message}\n`);
  process.exitCode = 1;
  return false;
}

function jest(args, env = {}) {
  const result = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'jest'), args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

let planted = false;
function removeProbe() {
  if (!planted) return;
  fs.rmSync(PROBE, { force: true });
  planted = false;
  if (fs.existsSync(PROBE)) throw new Error(`could not remove ${PROBE_RELATIVE}`);
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    removeProbe();
    process.kill(process.pid, signal);
  });
}
function plant(body) {
  fs.writeFileSync(PROBE, `${body}\n`, 'utf8');
  planted = true;
}

function summary(output) {
  return (/^Tests:.*$/mu.exec(output) ?? [''])[0];
}

function main() {
  if (fs.existsSync(PROBE)) return fail(`${PROBE_RELATIVE} already exists; refusing to touch it`);
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', PROBE_RELATIVE], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (tracked.status === 0)
    return fail(`${PROBE_RELATIVE} is tracked; the probe must be disposable`);

  let ok = true;
  let caught = 0;
  try {
    plant(SOUND);
    const baseline = jest(['--ci', PROBE_RELATIVE]);
    if (baseline.status !== 0) {
      return fail(`the unplanted probe is already red:\n${baseline.output.slice(-2000)}`);
    }
    if (!baseline.output.includes('zero-skips gate:')) {
      return fail('the reporter said nothing on a --ci run: it is not registered');
    }
    const quiet = jest([PROBE_RELATIVE]);
    if (quiet.output.includes('zero-skips gate:')) {
      return fail('the reporter spoke on a run without --ci; it must be the CI gate only');
    }
    process.stdout.write('BASELINE  the probe passes, and the reporter speaks under --ci only\n');

    for (const one of PLANTS) {
      plant(one.body);
      const run = jest(['--ci', PROBE_RELATIVE]);
      if (run.status === 0) {
        ok = fail(`${one.id}: the run PASSED with ${one.what} planted`);
        continue;
      }
      const missing = one.says.filter((fragment) => !run.output.includes(fragment));
      if (missing.length > 0) {
        ok = fail(
          `${one.id}: the run failed, but not for the stated reason -- it never said ` +
            `${JSON.stringify(missing)}:\n${run.output.slice(-2000)}`,
        );
        continue;
      }
      if (one.runtimeClean === true) {
        const line = summary(run.output);
        if (line === '' || /skipped|todo|failed/u.test(line)) {
          ok = fail(
            `${one.id}: expected a run where nothing was skipped or failed at RUNTIME, so ` +
              `only the source check could object; the summary was ${JSON.stringify(line)}`,
          );
          continue;
        }
      }
      caught += 1;
      process.stdout.write(`CAUGHT    ${one.id} -- ${one.what}\n`);
    }

    // The floor is a claim about the WHOLE suite and stands down on a filtered run, which
    // is the only reason the cases above do not trip it. So this one runs everything.
    removeProbe();
    const floor = jest(['--ci'], { HOUSTON_SKIP_GATE_PROBE: 'count' });
    if (floor.status === 0) {
      ok = fail('count: the suite PASSED with the floor raised one above the real count');
    } else if (!floor.output.includes('below the floor of')) {
      ok = fail(
        `count: the suite failed, but not for the stated reason:\n${floor.output.slice(-2000)}`,
      );
    } else {
      caught += 1;
      process.stdout.write('CAUGHT    count -- a suite one test short of its floor\n');
    }
  } finally {
    removeProbe();
  }
  if (fs.existsSync(PROBE)) return fail(`${PROBE_RELATIVE} survived the run`);

  const green = jest(['--ci']);
  if (green.status !== 0) {
    return fail(
      `the suite is not green under --ci after the probe was removed:\n${green.output.slice(-2000)}`,
    );
  }
  process.stdout.write('RESTORED  the probe is gone and `yarn test --ci` is green\n');
  process.stdout.write(`${String(caught)}/${String(PLANTS.length + 1)} planted defects caught\n`);
  if (caught !== PLANTS.length + 1) ok = false;
  if (!ok) process.exitCode = 1;
  return ok;
}

try {
  main();
} catch (error) {
  removeProbe();
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
