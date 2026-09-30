#!/usr/bin/env node
/**
 * The account lookup's timing property, measured with a number rather than asserted with a
 * comment.
 *
 *   yarn test:timing -- --n 1000
 *
 * THE PROPERTY. `users.verify` must cost the same whether or not the name exists, because
 * a response-time difference enumerates accounts. An unknown name is therefore checked
 * against `DUMMY_HASH` -- a well-formed line of random bytes -- so that branch performs
 * exactly ONE scrypt derivation, the same as a known name with a wrong password.
 *
 * THE DEFECT THIS GATE EXISTS FOR was the obvious version of that line:
 *
 *     check(password, await hashPassword('dummy-not-a-real-password'))
 *
 * which derives scrypt TWICE -- once to build the dummy, once to check against it. The
 * side channel the line was written to close was created by it instead, twice as loud as
 * the early return it replaced. Measured on an earlier release before the fix: 46.6 ms unknown
 * against 23.7 ms known, a ratio of 1.97. The gate is < 1.10.
 *
 * ## Why `UV_THREADPOOL_SIZE` is pinned, and why this file re-executes itself
 *
 * `crypto.scrypt` is asynchronous and runs on libuv's threadpool. With the default four
 * threads, four derivations proceed AT ONCE, so wall-clock per call measures contention
 * rather than work -- and the ratio it reports is meaningless. libuv reads
 * `UV_THREADPOOL_SIZE` once, when the pool is first used, and Node has usually touched it
 * before any of this file runs. Setting the variable here would therefore be a comment that
 * looks like a control. So the script re-executes itself with the variable set, and refuses
 * to measure anything if it somehow arrives unset.
 *
 * ## Why the median, interleaved
 *
 * The mean of a timing sample is dominated by whatever else the machine did during it, and
 * a long GC pause or a scheduler decision lands in one arm or the other depending only on
 * when it happened. So the two arms are INTERLEAVED -- one known, one unknown, n times --
 * which puts any drift in both, and the comparison is of medians, which a handful of
 * outliers cannot move.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const THREADPOOL = '1';

/**
 * Re-exec with the threadpool pinned, because libuv has already read the variable.
 *
 * `HOUSTON_TIMING_PINNED` marks the child so this cannot recurse. Everything else about
 * the environment is inherited, so the measurement runs on the same interpreter and the
 * same machine as the caller asked for.
 */
if (process.env.HOUSTON_TIMING_PINNED !== '1') {
  const child = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, UV_THREADPOOL_SIZE: THREADPOOL, HOUSTON_TIMING_PINNED: '1' },
  });
  process.exit(child.status ?? 1);
}

if (process.env.UV_THREADPOOL_SIZE !== THREADPOOL) {
  process.stderr.write(
    `test:timing refuses to measure: UV_THREADPOOL_SIZE is ` +
      `${JSON.stringify(process.env.UV_THREADPOOL_SIZE)} rather than ${THREADPOOL}. ` +
      'An unpinned threadpool runs derivations concurrently and the ratio below would ' +
      'measure contention instead of work.\n',
  );
  process.exit(1);
}

function parseArgs(argv) {
  let n = 1000;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--') continue;
    if (flag === '--n') {
      n = Number.parseInt(argv[index + 1] ?? '', 10);
      index += 1;
      if (!Number.isInteger(n) || n < 1) throw new Error('--n must be a positive integer');
      continue;
    }
    throw new Error(`unknown argument ${flag}`);
  }
  return { n };
}

/** The ratio the gate refuses above. The original defect measured 1.97. */
const MAX_RATIO = 1.1;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

async function main() {
  const { n } = parseArgs(process.argv.slice(2));

  // An isolated home: this adds an account and writes audit lines, and doing that in
  // somebody's real state directory is how a test becomes somebody else's problem.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-timing-'));
  process.env.HOUSTON_HOME = home;
  process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));

  require(path.join(ROOT, 'tools', 'ts-require')).install();
  const users = require(path.join(ROOT, 'src', 'core', 'users.ts'));

  const password = 'correct horse battery staple';
  const wrong = 'wrong horse battery staple';
  await users.add('known', password, 'admin');

  // Warm up both paths: the first derivation on a cold threadpool pays for the thread and
  // for whatever the runtime lazily initialises, and that cost lands in whichever arm
  // happens to run first.
  for (let i = 0; i < 5; i += 1) {
    await users.verify('known', wrong);
    await users.verify('nobody-at-all', wrong);
  }

  const knownSamples = [];
  const unknownSamples = [];
  for (let i = 0; i < n; i += 1) {
    // INTERLEAVED, so any drift during the run lands in both arms rather than in one.
    let started = process.hrtime.bigint();
    await users.verify('known', wrong);
    knownSamples.push(Number(process.hrtime.bigint() - started) / 1e6);

    started = process.hrtime.bigint();
    await users.verify('nobody-at-all', wrong);
    unknownSamples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }

  const known = median(knownSamples);
  const unknown = median(unknownSamples);
  const ratio = unknown / known;

  // THE INSTRUMENT HAS TO BE SHOWN CAPABLE OF SEEING THE DEFECT, or "1.00x" means only
  // that both arms cost the same as each other -- which a measurement that resolves
  // nothing also reports. So a third arm performs the DEFECTIVE sequence with the module's
  // own primitives: build a dummy hash, then check against it. Two derivations, which is
  // what the bad line did. Its ratio must come out ABOVE the gate; if it does not, the
  // measurement is too coarse to be trusted and the PASS above is worthless.
  const proofCount = Math.min(n, 50);
  const defectiveSamples = [];
  const controlSamples = [];
  for (let i = 0; i < proofCount; i += 1) {
    let started = process.hrtime.bigint();
    await users.check(wrong, await users.hashPassword('dummy-not-a-real-password'));
    defectiveSamples.push(Number(process.hrtime.bigint() - started) / 1e6);

    started = process.hrtime.bigint();
    await users.verify('known', wrong);
    controlSamples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const defective = median(defectiveSamples) / median(controlSamples);

  const report = {
    type: 'houston.timing.v1',
    n,
    threadpool: Number(THREADPOOL),
    knownMedianMs: Number(known.toFixed(4)),
    unknownMedianMs: Number(unknown.toFixed(4)),
    ratio: Number(ratio.toFixed(4)),
    maxRatio: MAX_RATIO,
    defectiveRatio: Number(defective.toFixed(4)),
    resolves: defective >= MAX_RATIO,
    ok: ratio < MAX_RATIO && defective >= MAX_RATIO,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.resolves) {
    process.stdout.write(
      `test:timing FAILED -- the deliberately DEFECTIVE two-derivation sequence measured ` +
        `${report.defectiveRatio}x, which is inside the ${MAX_RATIO} gate. This ` +
        'measurement cannot see the defect it exists for, so its verdict on the real ' +
        'path means nothing.\n',
    );
  } else {
    process.stdout.write(
      `test:timing ${report.ok ? 'PASSED' : 'FAILED'} -- unknown-user verify is ` +
        `${report.ratio}x a known-user one at n=${n} (known ${report.knownMedianMs} ms, ` +
        `unknown ${report.unknownMedianMs} ms, medians of interleaved samples, ` +
        `UV_THREADPOOL_SIZE=${THREADPOOL}); the gate is < ${MAX_RATIO}. The planted ` +
        `two-derivation defect measures ${report.defectiveRatio}x over ${proofCount} ` +
        'samples, so this measurement does resolve it; the original defect was 1.97\n',
    );
  }
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
