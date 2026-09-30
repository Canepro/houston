/**
 * `yarn lint:truthiness` -- prove the rule that makes `if (answer)` an error is LIVE.
 *
 * A three-state answer must never be read as a plain condition, and TypeScript cannot
 * make that fail at run time: every object is truthy in a condition, a phantom
 * brand does not change that, and removing `valueOf`/`toString` does not either. So the
 * failure mode of collapsing the three states here is a SILENT `true` -- and the
 * collapse that deleted a live cluster happened at a CONSUMER, which is exactly where a
 * silent true would land.
 *
 * What stands in for the raise is `@typescript-eslint/strict-boolean-expressions` with
 * objects disallowed. A lint rule nobody has tried to break is a rule nobody knows is
 * on, so this plants the misuse in a real consumer file OUTSIDE `src/core/kube/`, runs
 * ESLint on it, requires that exact rule to reject that exact line, and restores the
 * tree.
 *
 * The negative half matters as much: the same file with `answer.state` read properly
 * must lint CLEAN, or the gate would pass on a rule that rejects everything.
 *
 * It also asserts the rule is configured with `allowNullableObject: false`, because the
 * default for that option is `true` and flipping it would silently take the teeth out
 * while leaving the rule name in the config.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ESLINT = path.join(ROOT, 'node_modules', '.bin', 'eslint');
const RULE = '@typescript-eslint/strict-boolean-expressions';

/**
 * A CONSUMER, deliberately outside `kube/`. The collapse the rule exists to stop did
 * not happen inside the package that defines `Answer`; it happened where somebody
 * consumed one.
 */
const CONSUMER_DIR = path.join(ROOT, 'src', 'core', '__truthiness_consumer__');
const CONSUMER = path.join(CONSUMER_DIR, 'consumer.ts');

const HEADER = [
  "import { askObject, type Answer } from '../kube/ask';",
  '',
  'export async function namespaceIsReady(context: string): Promise<string> {',
  "  const answer: Answer = await askObject('namespace', 'houston-x', { context });",
].join('\n');

const MISUSE = [
  HEADER,
  '  // THE PLANTED LINE. An Answer object is always truthy, so this reads REFUSED as',
  '  // "it is there" -- the collapse that deleted a live cluster.',
  "  if (answer) return 'ready';",
  "  return 'not ready';",
  '}',
  '',
].join('\n');

const CORRECT = [
  HEADER,
  "  if (answer.state === 'present') return 'ready';",
  "  if (answer.state === 'absent') return 'not ready';",
  "  return 'refused';",
  '}',
  '',
].join('\n');

const results = [];

function check(name, ok, detail) {
  results.push({ name, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}\n`);
}

function lint(relative) {
  const result = spawnSync(ESLINT, [relative], { cwd: ROOT, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function withConsumer(source, body) {
  if (fs.existsSync(CONSUMER_DIR)) {
    throw new Error(`refusing to overwrite ${CONSUMER_DIR}, which already exists`);
  }
  fs.mkdirSync(CONSUMER_DIR, { recursive: true });
  try {
    fs.writeFileSync(CONSUMER, source, 'utf8');
    return body(path.relative(ROOT, CONSUMER));
  } finally {
    fs.rmSync(CONSUMER_DIR, { recursive: true, force: true });
  }
}

function main() {
  // 1. The rule is configured, and configured with its teeth in.
  const printed = spawnSync(ESLINT, ['--print-config', 'src/core/kube/ask.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const config = JSON.parse(printed.stdout);
  const entry = config.rules[RULE];
  const options = Array.isArray(entry) ? entry[1] : undefined;
  check(
    'strict-boolean-expressions is an error with objects disallowed',
    Array.isArray(entry) && entry[0] === 2 && options && options.allowNullableObject === false,
    JSON.stringify(entry),
  );

  // 2. The planted misuse is REJECTED, by that rule, on that line.
  const rejected = withConsumer(MISUSE, (relative) => lint(relative));
  const plantedLine = MISUSE.split('\n').findIndex((line) => line.includes('if (answer)')) + 1;
  check(
    'a planted `if (answer)` at a consumer outside kube/ fails lint',
    rejected.status !== 0 && rejected.output.includes(RULE),
    `exit=${String(rejected.status)}`,
  );
  check(
    'the failure names the planted line itself, not the file in general',
    new RegExp(`\\b${String(plantedLine)}:\\d+\\s+error`, 'u').test(rejected.output),
    `expected line ${String(plantedLine)}`,
  );

  // 3. The same consumer reading `answer.state` lints CLEAN, so the gate is not simply
  //    a rule that rejects everything it is shown.
  const accepted = withConsumer(CORRECT, (relative) => lint(relative));
  check(
    'the same consumer switching on answer.state lints clean',
    accepted.status === 0,
    accepted.output.trim().split('\n').slice(0, 3).join(' | '),
  );

  // 4. The tree is exactly as it was.
  check('the planted consumer is gone afterwards', !fs.existsSync(CONSUMER_DIR));
}

try {
  main();
  const failed = results.filter((row) => !row.ok);
  process.stdout.write(
    failed.length === 0
      ? `lint:truthiness PASSED -- ${String(results.length)} checks; a planted \`if (answer)\` ` +
          'at a consumer outside kube/ is rejected by strict-boolean-expressions\n'
      : `lint:truthiness FAILED -- ${String(failed.length)} of ${String(results.length)} checks\n`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  fs.rmSync(CONSUMER_DIR, { recursive: true, force: true });
  process.stderr.write(`${error.stack ?? String(error)}\n`);
  process.exitCode = 2;
}
