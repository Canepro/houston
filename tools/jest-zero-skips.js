'use strict';
/**
 * A skipped test cannot be called green.
 *
 * A suite that skips reports green while testing nothing: that is how a broken same-origin
 * form POST once shipped past 570 passing HTTP tests. Jest has that hole under several
 * spellings: `it.skip`,
 * `describe.skip`, `xit`, `.todo`, a stray `.only`, and a conditional guard that picks one of
 * those at runtime.
 *
 * `tools/browser-results.js` already does this job for the browser suite and set the
 * convention followed here: a gate nobody has watched fail is a gate that does not work, so
 * `yarn test:zero-skips:selftest` plants each defect and requires the run to fail naming it.
 *
 * ## Two checks, because one of them cannot be made at runtime
 *
 * **The run.** Zero pending, zero todo, and at least `FLOOR` tests over the whole suite.
 * That catches what actually skipped on this machine.
 *
 * **The source.** `test/seams/exec.test.ts` selects
 * `(process.platform === 'win32' ? describe.skip : describe)`. On Linux nothing skips, the
 * run reports zero, and a runtime-only gate passes -- while the same suite on another machine
 * drops a whole `describe` in silence. A guard that does not fire HERE is still a guard, so
 * every authored skip construct must be named in `PERMITTED` with a written reason: the
 * reviewer decides that a guard is allowed, not the platform the gate happened to run on. A
 * permission that no longer matches anything fails too, so the list cannot drift into
 * describing nothing.
 *
 * ## When it enforces, and why it stands down when it does
 *
 * Only with `--ci` (`globalConfig.ci`, which `CI=1` in the environment also sets): `yarn test
 * --ci` is the gate and CI runs it; an ordinary `yarn test` stays a development loop.
 *
 * The RUNTIME skip check stands down on a NAME-FILTERED run (`-t`), and that is not a
 * convenience. Jest reports a test a `-t` pattern did not select with status `pending` --
 * exactly what `it.skip` produces -- so on such a run the two cannot be told apart, and any
 * verdict would be a guess. A proof that plants one break and runs only the test meant to
 * catch it runs that way, with `CI: '1'` and a `-t`; a reporter that counted the unselected
 * tests as skips would fail every such run. The
 * SOURCE check does not stand down there.
 *
 * The FLOOR stands down on any filtered run -- a run of one file is not the suite and has no
 * business asserting the suite's size. A path filter does NOT silence the runtime check: a
 * pending test inside a selected file is a real skip.
 *
 * NOT DETECTABLE, and named so the gap is recorded rather than implied: a test that returns
 * early from its own body, or wraps its assertions in an `if`. Neither is a skip to Jest, and
 * no reporter can tell either from a test that finished.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * The floor: the measured size of the whole suite.
 *
 * A count cannot say whether a single behaviour is covered. This number is for the one thing
 * a count is good at: noticing that a run collected far less than it used to, which is what a
 * broken `testMatch`, a crashed worker or a `.only` looks like from the outside. It is set to
 * the measured count in the commit that adds tests, and lowered only in a commit that removes
 * tests and says why; git holds its history.
 */
// Rich seed profiles, recovery, historical metadata, and actual Kubernetes runtime seams.
// Twenty-seven re-verification regressions also cover shutdown, bind links, Kubernetes
// polling, SAML registration, shared namespace deletion and ordered progress.
// Thirty-eight post-integration cases cover shared-edge transactions, scoped origin
// readiness, SAML reload/idempotence, limiter-safe seeding and public preset guidance.
// Thirty-nine release-completion cases cover bounded SAML registration, awaited failure-safe
// backend shutdown, rate-limited star readback, truthful unreadable-seed reasons, and the
// process shutdown bound after the HTTP server closes with a live log-follow handle, and
// configuration-before-enable plus bounded OIDC registration across replica roots, and
// checked owned-edge ingress recovery with preservation guards for other runtimes/homes.
// Sixty-eight blocker regression and boundary cases cover namespace identity, verified quiescence,
// terminal job access/audit and complete atomic port publication.
// The e2ee preset (its settings, test users and the enforced-version refusal), the owner kept
// through a rebuild, the dashed email code, the Kubernetes typo wording and the origin's port.
// Seeding under E2EE room defaults and against 8.8.0's request validation: the encryption
// defaults held off and journalled, their repair, the marker in customFields, one invite per user.
// A supervised port-forward that restarts its kubectl, stops with it and gives up on a dead
// target; and the license line on an unlicensed microservices workspace.
// `serve` names an earlier serve from this home when its port is in use.
// Okta sign-in: settings and secret, every ID token and provider check, each way a person
// resolves to an account, the /signin start and callback, the CLI link verbs, and the seam's cap;
// and the review's: control characters in `next`, a stale link on a re-created account, the
// canonical redirect made once, and no audit line for an unstarted callback.
// The final re-verification's fixes: up resolving a name the actor may act on, a rebuild's
// monitoring, pin and port, the operator password off every argv, the operator's memory and
// PodMonitor, serve's shutdown, and the usage and wording answers it found untrue.
// Bind enforcement covers protocol preservation, ephemeral long ports and invalid addresses.
// Compose interpolation brackets an IPv6 bind before variable port fields, and monitoring reads
// that bind back from both short and long syntax.
// Whole-value interpolation refusals: 11 cases; IPv6 and long-syntax regressions: 2; total 4525.
// Seven licence-warning cases, the licensed-user microservices regression, and two
// end-to-end registration-token normalization regressions add ten exercised Jest cases above
// the bind-enforcement base. One chart-consumer regression covers the winning Kubernetes token,
// and one covers final Kubernetes licence precedence and warning presence.
// R5 adds one workspace-owner credential promotion regression; collection measures 4538.
// R6 adds one mixed-replica credential lifecycle regression; collection measures 4539.
// R7 adds one equivalent-file regression and two interrupted-create cleanup cases; total 4542.
// R8 adds two interrupted-install controls and one workspace-identity control; total 4545.
// CI on 21aa5b3 measured 4550. This commit adds one created-namespace rollback regression.
// Evidence-closeout regressions cover bundle help, Kubernetes ownership proof,
// runtime-correct artifact selection, registration-token provenance, normalized presets,
// public URL plus byte-preserved cleanup rendering, artifact URL and scalar redaction,
// metadata-only Docker records, legacy catalogue uncertainty in both licence-output paths,
// provisional licensing, Compose-list and env-file token presence, legacy sidecar
// attribution, a preset-only Kubernetes token, and evidence reading `effective_license` before
// the Secret lifecycle flag: 47 cases over 4551, total 4598. One more records the token
// Helm accepted when a re-up stops after Helm: total 4599. One more masks user-only URL
// credentials in the evidence bundle: CI on fe95a08 measured 4600.
const FLOOR = 4601;

/** Every authored construct that removes a test from a run or inverts what it asserts. */
const SKIP_CONSTRUCTS = [
  'describe.skip',
  'describe.only',
  'xdescribe',
  'fdescribe',
  'it.skip',
  'it.only',
  'it.todo',
  'it.failing',
  'xit',
  'fit',
  'test.skip',
  'test.only',
  'test.todo',
  'test.failing',
  'xtest',
];

/** The constructs a reviewer has looked at and allowed, each with its reason. */
const PERMITTED = [
  {
    file: 'test/seams/exec.test.ts',
    construct: 'describe.skip',
    reason:
      'A platform guard, not a disabled test. `processGroup: true` asks for a POSIX session ' +
      'and `process.kill(-pid, ...)` addresses a process group; Windows has neither, so the ' +
      'block is selected away there. Houston is not supported on Windows, and the block runs ' +
      'on Linux, on macOS and in CI.',
  },
];

function specFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) specFiles(absolute, found);
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(absolute);
  }
  return found;
}

/**
 * The text with comments removed, so prose about `it.skip` is not read as a use of it.
 *
 * Deliberately crude and fail-LOUD: it strips line and block comments and nothing else. A
 * string literal holding one of these constructs is reported, and the answer to that is a
 * `PERMITTED` row with a reason -- not a cleverer parser whose blind spots nobody has listed.
 */
function withoutComments(text) {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, (block) => block.replaceAll(/[^\n]/gu, ' '))
    .replaceAll(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

/** Every authored skip construct under `test/`, with where it is. */
function authoredSkips(roots = [path.join(ROOT, 'test')]) {
  const found = [];
  const patterns = SKIP_CONSTRUCTS.map((construct) => [
    construct,
    construct.includes('.')
      ? // A MEMBER construct (`it.skip`) counts wherever it appears -- called, or merely
        // selected, which is what `(cond ? describe.skip : describe)` does. Not preceded by an
        // identifier character or a dot, so `describe.skip` does not match inside
        // `xdescribe.skip`.
        new RegExp(`(^|[^\\w.$])${construct.replaceAll('.', '\\.')}\\b`, 'u')
      : // A BARE identifier (`fit`, `xit`) counts only when it is CALLED, or `.each`ed.
        // MEASURED: the browser spec holds a local `const fit = await page.evaluate(...)`,
        // and matching the name alone reported it eight times.
        new RegExp(`(^|[^\\w.$])${construct}\\s*(\\(|\\.each\\b)`, 'u'),
  ]);
  for (const root of roots) {
    for (const absolute of specFiles(root).sort()) {
      const relative = path.relative(ROOT, absolute).split(path.sep).join('/');
      const lines = withoutComments(fs.readFileSync(absolute, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        for (const [construct, pattern] of patterns) {
          if (pattern.test(line)) {
            found.push({ file: relative, construct, line: index + 1, text: line.trim() });
          }
        }
      });
    }
  }
  return found;
}

function sourceProblems(roots) {
  const problems = [];
  const used = new Set();
  for (const skip of authoredSkips(roots)) {
    const at = PERMITTED.findIndex(
      (row) => row.file === skip.file && row.construct === skip.construct,
    );
    if (at === -1) {
      problems.push(
        `authored skip construct with no written reason: ${skip.file}:${String(skip.line)} ` +
          `uses ${skip.construct} -- ${skip.text.slice(0, 120)}`,
      );
    } else {
      used.add(at);
    }
  }
  PERMITTED.forEach((row, index) => {
    if (!used.has(index)) {
      problems.push(
        `PERMITTED allows ${row.construct} in ${row.file}, which is not there any more; ` +
          'remove the row rather than keep a permission for nothing',
      );
    }
  });
  return problems;
}

/** Every test the run did not actually execute, named. */
function notRun(results) {
  const rows = [];
  for (const suite of results.testResults ?? []) {
    // `testResults` in the reporter API, `assertionResults` in `--json` output. MEASURED:
    // reading only the second, the gate failed a planted skip without naming it.
    for (const assertion of suite.testResults ?? suite.assertionResults ?? []) {
      if (assertion.status === 'passed' || assertion.status === 'failed') continue;
      const file = path
        .relative(ROOT, suite.testFilePath ?? suite.name ?? '')
        .split(path.sep)
        .join('/');
      rows.push(`${assertion.status}: ${file} -- ${assertion.fullName}`);
    }
  }
  return rows;
}

function filtered(global) {
  const patterns = global.testPathPatterns;
  const byPath =
    patterns !== undefined && patterns !== null && typeof patterns.isSet === 'function'
      ? patterns.isSet()
      : Array.isArray(patterns) && patterns.length > 0;
  const byName = typeof global.testNamePattern === 'string' && global.testNamePattern !== '';
  const bySelection =
    global.onlyChanged === true ||
    global.onlyFailures === true ||
    global.lastCommit === true ||
    (typeof global.changedSince === 'string' && global.changedSince !== '') ||
    global.findRelatedTests === true;
  return { byPath, byName, whole: !byPath && !byName && !bySelection };
}

class ZeroSkipsReporter {
  constructor(globalConfig) {
    this._global = globalConfig ?? {};
    this._error = undefined;
  }

  /** Jest fails the run when a reporter reports an error here (`@jest/core` hasErrors). */
  getLastError() {
    return this._error;
  }

  onRunComplete(_contexts, results) {
    if (this._global.ci !== true) return;
    const scope = filtered(this._global);
    const problems = [];

    if (scope.byName) {
      process.stderr.write(
        'zero-skips gate: a -t pattern is active, and Jest reports every test it did not ' +
          'select as pending -- the status a skip has. The runtime check stands down for ' +
          'this run; the source check does not.\n',
      );
    } else {
      const skipped = notRun(results);
      if (skipped.length > 0) {
        problems.push(
          `${String(skipped.length)} test(s) did not run:\n    ${skipped.join('\n    ')}`,
        );
      }
      if ((results.numPendingTests ?? 0) > 0 || (results.numTodoTests ?? 0) > 0) {
        problems.push(
          `jest counted ${String(results.numPendingTests)} skipped and ` +
            `${String(results.numTodoTests)} todo; both must be zero`,
        );
      }
    }

    if (scope.whole) {
      const floor = process.env.HOUSTON_SKIP_GATE_PROBE === 'count' ? FLOOR + 1 : FLOOR;
      if (results.numTotalTests < floor) {
        problems.push(
          `the suite collected ${String(results.numTotalTests)} tests, below the floor of ` +
            `${String(floor)}. That is what a broken testMatch, a crashed worker or a stray ` +
            '.only looks like from the outside.',
        );
      }
    }

    problems.push(...sourceProblems());

    if (problems.length > 0) {
      // PRINTED HERE, not left to Jest: `@jest/core` reads `getLastError()` only to turn the
      // run's success false, and never prints it. MEASURED -- the first version failed
      // `yarn test --ci` with exit 1, 1954 passed, and not one word of why.
      const text = `zero-skips gate FAILED:\n  - ${problems.join('\n  - ')}`;
      process.stderr.write(`\n${text}\n`);
      this._error = new Error(text);
      return;
    }
    process.stderr.write(
      `zero-skips gate: ${String(results.numPassedTests)} passed, zero skipped, zero todo` +
        `${scope.whole ? `, floor ${String(FLOOR)} met` : ''}; ` +
        `${String(PERMITTED.length)} reviewed platform guard in the source\n`,
    );
  }
}

module.exports = ZeroSkipsReporter;
module.exports.FLOOR = FLOOR;
module.exports.PERMITTED = PERMITTED;
module.exports.authoredSkips = authoredSkips;
module.exports.sourceProblems = sourceProblems;
