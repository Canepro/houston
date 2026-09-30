#!/usr/bin/env node
'use strict';

const path = require('node:path');

require(path.join(__dirname, 'ts-require')).install();

async function main() {
  // Kept behind this late lookup so the parser/help gates can load without eagerly
  // constructing service dependencies, and handler tests can replace the registry.
  // `runMain` runs the command inside its durable event-log record.
  const { runMain } = require(path.join(__dirname, '..', 'src', 'cli', 'handlers.ts'));
  process.exitCode = await runMain(process.argv.slice(2));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
