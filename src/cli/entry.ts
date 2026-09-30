/**
 * The emitted build's entry: `bin/houston` execs `node dist/cli/entry.js` once `tsc` has
 * emitted it, and `node tools/cli.js` (this same body, over the source through swc) on a
 * checkout that has not been built. Kept behind a late lookup so the parser and help gates
 * can load `handlers` without eagerly constructing service dependencies, and so a test can
 * replace the registry. `runMain` is the CLI's main: the command inside its durable
 * event-log record.
 */
import type * as HandlersNS from './handlers';

async function main(): Promise<void> {
  const { runMain } = require('./handlers') as typeof HandlersNS;
  process.exitCode = await runMain(process.argv.slice(2));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
