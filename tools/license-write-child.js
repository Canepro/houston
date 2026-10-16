/** A real create workspace writer for the external licence interruption test. */
'use strict';
const path = require('node:path');
require('./ts-require').install();
const root = path.join(__dirname, '..', 'src');
// Only the external engine discovery seam is replaced. No engine is contacted, and
// the actual lifecycle, record, filesystem and permission code run in this child.
const host = require(path.join(root, 'core/runner/host.ts'));
require.cache[require.resolve(path.join(root, 'core/runner/host.ts'))].exports = {
  ...host,
  engine: async () => null,
};
const create = require(path.join(root, 'core/lifecycle/create-docker.ts'));
const { createReq } = require(path.join(root, 'core/lifecycle/types.ts'));
const { nullEmit } = require(path.join(root, 'lib/events.ts'));
const versions = require(path.join(root, 'lib/versions.ts'));
const presets = require(path.join(root, 'lib/presets/index.ts'));
async function main() {
  const [name, bytes] = process.argv.slice(2);
  const plan = create.createPlan({
    req: createReq({ version: '8.5.1', name, license: `RCV3_${'x'.repeat(Number(bytes))}` }),
    emit: nullEmit,
  });
  plan.reproName = name;
  plan.resolved = versions.resolve('8.5.1', { offline: true });
  plan.pre = presets.load('default', {});
  plan.hostPort = 3320;
  plan.root = 'http://localhost:3320';
  plan.bindHost = '127.0.0.1';
  await create.buildDocument(plan);
  create.buildRecord(plan);
  await create.writeTheWorkspace(plan);
}
main().catch((error) => {
  process.stderr.write(`${error.stack ?? String(error)}\n`);
  process.exitCode = 1;
});
