#!/usr/bin/env node
/**
 * `node tools/validate-state.js <home>` -- print this build's reading of a home.
 *
 * The PEER VALIDATOR entry point: another build names this command in
 * `HOUSTON_PEER_VALIDATOR` and compares what it prints with its own answer, which is what
 * makes "validated by both builds" a thing that happened rather than a claim.
 *
 * stdout carries the JSON document and nothing else, for the reason `jsonout` insists on
 * it: the caller parses one line and a stray print breaks it.
 */
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'tools', 'ts-require')).install();

const { validateHome } = require(path.join(ROOT, 'src', 'core', 'promote.ts'));

async function main() {
  const home = process.argv[2];
  if (home === undefined) {
    process.stderr.write('usage: node tools/validate-state.js <home>\n');
    return 2;
  }
  // SORTED KEYS, because the peer's document is compared with the other build's, which
  // writes its keys sorted. The comparison walks the
  // decoded documents rather than the bytes, but a stable spelling keeps a diff of the
  // two outputs readable by a person.
  process.stdout.write(`${JSON.stringify(sortKeys(await validateHome(home)))}\n`);
  return 0;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
