/**
 * Let a plain CommonJS tool `require()` a `.ts` module from `src/`.
 *
 * `tools/cli.js` and the helper processes the specs start are repo tooling, not shipped
 * source, so they are plain `.js` -- but they have to call the real `src/` modules. Calling
 * a hand-copied JavaScript transcription of `compose.ts` instead would prove that the
 * transcription works, which is not the question.
 *
 * Two options were available. Requiring `dist/` would test what ships, but makes every
 * tool depend on a build step having been run and on it being CURRENT -- a stale `dist/`
 * turns a failure into a pass for the previous edit, silently, which is the exact class
 * of error a check exists to catch. So the source is compiled on the
 * fly instead, with `@swc/core` and the same options `jest.config.js` gives
 * `@swc/jest` -- the two therefore load identical code, and there is no build artefact
 * to go stale.
 *
 * `@swc/core` is already a dependency. This adds none.
 *
 * NOTE what this is not: it is not a type checker. `yarn typecheck` is the gate for
 * that, and swc strips types without looking at them -- which is also why a run through
 * this hook cannot substitute for `yarn typecheck`.
 */
'use strict';

const fs = require('fs');
const Module = require('module');

const swc = require('@swc/core');

const OPTIONS = {
  jsc: { parser: { syntax: 'typescript' }, target: 'es2020' },
  module: { type: 'commonjs' },
  sourceMaps: 'inline',
};

let installed = false;

/** Install the `.ts` require hook. Idempotent. */
function install() {
  if (installed) return;
  installed = true;
  Module._extensions['.ts'] = function compileTs(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const { code } = swc.transformSync(source, { ...OPTIONS, filename });
    module._compile(code, filename);
  };
}

module.exports = { install };
