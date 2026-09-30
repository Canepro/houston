/**
 * `record.write`, in a process the test can kill between its two writes.
 *
 * The write-ahead ordering is the one property of that function that only an
 * interruption can show: repro.json goes down BEFORE docker-compose.yml, so a kill
 * between them leaves the half that `readMeta` can read and `up` regenerates, rather
 * than the half that is invisible to `list`, `prune` and port allocation while still
 * occupying the name. Asserting it from inside one process would only be asserting the
 * order of two lines.
 *
 * The compose payload is sized by the caller so the second write takes long enough for
 * a kill to land inside it. That is the window, and making it wide does not change
 * which write happens first.
 */
'use strict';

const path = require('path');

require(path.join(__dirname, 'ts-require')).install();

const record = require(path.join(__dirname, '..', 'src', 'core', 'runner', 'record.ts'));

async function main() {
  const [name, bytes] = process.argv.slice(2);
  const head = 'services:\n  rocketchat:\n    image: rocketchat/rocket.chat:8.5.1\n';
  const filler = `    # ${'x'.repeat(64)}\n`;
  const repeats = Math.max(0, Math.ceil((Number(bytes) - head.length) / filler.length));
  const compose = head + filler.repeat(repeats);
  const meta = record.metadata({
    name,
    project: `houston-${name}`,
    rcVersion: '8.5.1',
    rcImage: 'rocketchat/rocket.chat:8.5.1',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset: 'default',
    rootUrl: 'http://localhost:3000',
    hostPort: 3000,
    versionSource: 'live',
    createdAt: '2026-09-14T00:00:00Z',
  });
  process.stdout.write('START\n');
  await record.write(name, compose, meta);
  process.stdout.write('DONE\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? String(error)}\n`);
  process.exitCode = 1;
});
