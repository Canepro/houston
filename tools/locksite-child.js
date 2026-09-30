/**
 * One of the five lock sites, as a child process a test can SIGKILL.
 *
 * A lock is only worth what it is worth when the holder dies without warning, and
 * that cannot be tested inside the process running the test: `process.exit` runs
 * cleanup, and a thrown error unwinds. So each site's critical section lives here, is
 * driven from a real second process, and the test kills it mid-section.
 *
 * The five are the five lock sites: the workspace lock (`reproLock`), the config file, the
 * users file, the sessions file and the event log's rotation. The SHAPE of each
 * critical section is reproduced here -- read-modify-write, temp-plus-rename,
 * append-then-rotate -- because the shape is what decides whether an interrupted
 * holder loses a record. This file asserts the mechanism the service modules stand on,
 * apart from the modules themselves.
 *
 * Every site prints `OK <id>` on stdout AFTER the write it just made is durable, so a
 * test can ask the far harder question than "did it crash": is every record the child
 * said it committed still readable afterwards?
 */
'use strict';

const fs = require('fs');
const path = require('path');

require(path.join(__dirname, 'ts-require')).install();

const lock = require(path.join(__dirname, '..', 'src', 'seams', 'fs', 'lock.ts'));

/**
 * The lock, or deliberately nothing.
 *
 * `HOUSTON_LOCKSITE_UNLOCKED=1` runs each critical section with no lock at all. It
 * exists so the SIGKILL tests can be PROVEN rather than believed: a test that passes
 * with the lock and also without it is not testing the lock. The proof is rerunnable
 * instead of a one-off stash, and the switch is read here in test tooling rather than
 * anywhere production code could see it.
 */
const UNLOCKED = process.env.HOUSTON_LOCKSITE_UNLOCKED === '1';

function guarded(lockPath, body) {
  if (UNLOCKED) return Promise.resolve(body());
  return lock.withFileLock(lockPath, body, { timeoutMs: 30_000 });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** `config.save_config`'s shape: a temp file in the same directory, then a rename. */
function atomicWrite(file, content) {
  const tmp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The read-to-write window inside a critical section, held open on purpose.
 *
 * A lost update needs two writers to overlap between reading and writing, and these
 * sections are microseconds long -- so unlocked they would almost never collide and the
 * test would pass with the lock removed, which is a test that proves nothing. Widening
 * the window changes NOTHING about the locked behaviour, because the lock serialises
 * it; it only makes the unlocked outcome the certain one rather than the rare one.
 */
function window(ms) {
  return Number(ms) > 0 ? sleep(Number(ms)) : Promise.resolve();
}

/** `runner.repro_lock`: hold it and do nothing, so the test owns when the holder dies. */
async function hold(lockPath) {
  // The handle is never released. That is the test: the lock must come back because
  // the kernel dropped it when the holder died, not because anything unwound.
  await lock.acquireFileLock(lockPath, { timeoutMs: 30_000 });
  process.stdout.write('OK held\n');
  for (;;) await sleep(1_000);
}

/** `config.update_config`: read, mutate, write back, all inside one lock. */
async function config(lockPath, file, rounds, tag, delayMs, criticalMs) {
  for (let round = 0; round < Number(rounds); round += 1) {
    if (Number(delayMs) > 0) await sleep(Number(delayMs));
    await guarded(lockPath, async () => {
      const document = readJson(file, { writers: {}, total: 0 });
      await window(criticalMs);
      document.writers[tag] = (document.writers[tag] ?? 0) + 1;
      document.total += 1;
      atomicWrite(file, JSON.stringify(document));
    });
    process.stdout.write(`OK ${tag}-${String(round)}\n`);
  }
}

/** `users._write`: the whole file is rewritten under the lock and replaced atomically. */
async function users(lockPath, file, rounds, tag, delayMs, criticalMs) {
  for (let round = 0; round < Number(rounds); round += 1) {
    if (Number(delayMs) > 0) await sleep(Number(delayMs));
    await guarded(lockPath, async () => {
      const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
      await window(criticalMs);
      lines.push(`${tag}-${String(round)}:hash:created`);
      atomicWrite(file, lines.filter(Boolean).join('\n') + '\n');
    });
    process.stdout.write(`OK ${tag}-${String(round)}\n`);
  }
}

/**
 * `sessions`: the same rewrite, plus the compaction pass that drops expired rows.
 * Compaction is what makes a lost update invisible -- the row is simply not there.
 */
async function sessions(lockPath, file, rounds, tag, delayMs, criticalMs) {
  for (let round = 0; round < Number(rounds); round += 1) {
    if (Number(delayMs) > 0) await sleep(Number(delayMs));
    await guarded(lockPath, async () => {
      const rows = fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        : [];
      await window(criticalMs);
      const kept = rows.filter((row) => !row.startsWith('expired'));
      kept.push(`${tag}-${String(round)}\tuser\tcreated`);
      atomicWrite(file, kept.join('\n') + '\n');
    });
    process.stdout.write(`OK ${tag}-${String(round)}\n`);
  }
}

/**
 * `eventlog._write` plus `_rotate`, which is the one that can lose a record silently.
 *
 * The append is O_APPEND and needs no lock; the ROTATION does, because two processes
 * that both see the file over the cap would both rename it and one would carry the
 * other's records away. The append is deliberately OUTSIDE the lock, exactly as
 * `eventlog._write` has it, so this tests the real interleaving rather than a
 * fully-serialised one that could not lose anything anyway.
 */
async function eventlog(lockPath, file, rounds, tag, capBytes, delayMs, rotateDelayMs) {
  const cap = Number(capBytes);
  for (let round = 0; round < Number(rounds); round += 1) {
    if (Number(delayMs) > 0) await sleep(Number(delayMs));
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* not created yet, so nothing to rotate */
    }
    if (size > cap) {
      await guarded(lockPath, async () => {
        // The size is read INSIDE the section, as `eventlog._rotate` reads it inside
        // its flock. The lock is what makes this read and the rename that follows one
        // decision; without it two writers both read "over the cap" and both rename,
        // and the second rename carries the first one's records out of the only two
        // files anything reads.
        let current = 0;
        try {
          current = fs.statSync(file).size;
        } catch {
          /* somebody rotated it away already */
        }
        // The window between that decision and acting on it, held open on purpose. In
        // production it is one syscall wide, which makes the race rare rather than
        // impossible -- and a rare race is exactly what a test cannot see. Under the
        // lock this changes nothing, because the lock serialises it; unlocked it makes
        // the loss certain, so the proof can be RERUN rather than remembered.
        await window(rotateDelayMs);
        if (current > cap) {
          try {
            fs.renameSync(file, `${file}.1`);
          } catch (error) {
            // Somebody rotated between the decision and the rename. Losing that race
            // is fine; losing a record is not, which is what the test asserts.
            if (error.code !== 'ENOENT') throw error;
          }
        }
      });
    }
    const handle = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(handle, `${tag}-${String(round)}\n`);
    } finally {
      fs.closeSync(handle);
    }
    process.stdout.write(`OK ${tag}-${String(round)}\n`);
  }
}

const SITES = { hold, config, users, sessions, eventlog };

async function main() {
  const [site, ...rest] = process.argv.slice(2);
  const run = Object.prototype.hasOwnProperty.call(SITES, site) ? SITES[site] : undefined;
  if (run === undefined) throw new Error(`unknown lock site ${JSON.stringify(site)}`);
  await run(...rest);
}

main().then(
  () => {
    process.stdout.write('DONE\n');
  },
  (error) => {
    process.stderr.write(`${error.stack ?? String(error)}\n`);
    process.exitCode = 1;
  },
);
