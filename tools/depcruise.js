#!/usr/bin/env node
/** Fail-closed dependency gate: classify every production module, then cruise edges. */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { coverageProblems } = require('./dependency-policy');

const problems = coverageProblems(ROOT);
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`  error ${problem}\n`);
  process.stderr.write(`x ${problems.length} dependency classification violation(s)\n`);
  process.exitCode = 2;
} else {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'depcruise');
  const result = spawnSync(bin, ['src'], { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status === null ? 1 : result.status;
}
