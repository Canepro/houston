import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as lock from '../../src/lib/lock';

import * as promote from '../../src/core/promote';

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * A home exactly as an earlier release left it after claiming it and adding one admin --
 * every file, its mode and its bytes, recorded -- and the marker bytes it writes for a
 * home it shares with this build. The marker it claims with is its own name, read from the
 * recorded file rather than retyped here.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'core', 'promote.json'), 'utf8'),
) as { home: Record<string, { mode: string; bytes: string }>; dualMarker: string };
const RETIRED_MARKER = (RECORDED.home['IMPLEMENTATION']?.bytes ?? '').trimEnd();

let home: string;
let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-spec-'));
  home = path.join(base, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  delete process.env.HOUSTON_PEER_VALIDATOR;
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
  delete process.env.HOUSTON_PEER_VALIDATOR;
});

function plant(value: string): void {
  fs.writeFileSync(path.join(home, 'IMPLEMENTATION'), `${value}\n`, { mode: 0o600 });
}

describe('the lock order', () => {
  it('names the four fixed locks and expands the runner lock per workspace', () => {
    fs.mkdirSync(path.join(home, 'repros', 'TICKET-9'), { recursive: true });
    fs.mkdirSync(path.join(home, 'repros', 'TICKET-1'), { recursive: true });
    expect(promote.lockPaths(home)).toEqual([
      '.config.lock',
      'locks/users.lock',
      'locks/sessions.lock',
      'logs/houston.log',
      // SORTED, not directory order: the order is the deadlock-avoidance property, and
      // `readdir` order differs between implementations on the same directory.
      'locks/TICKET-1.lock',
      'locks/TICKET-9.lock',
    ]);
  });

  it('is the same list earlier releases name', () => {
    // Not a copy of the list: earlier releases held the same five entries in their own
    // lock module. This pins THIS build's spelling, so a drift from it is visible.
    expect([...lock.LOCK_ORDER]).toEqual([
      '.config.lock',
      'locks/users.lock',
      'locks/sessions.lock',
      'logs/houston.log',
      'locks/<workspace>.lock',
    ]);
  });
});

describe('the serve liveness file', () => {
  it('reports a live pid', () => {
    fs.writeFileSync(path.join(home, 'serve.pid'), `${String(process.pid)}\n`);
    expect(promote.serveIsRunning(home)).toBe(process.pid);
  });

  it('treats a stale pid as no server, rather than blocking for ever', () => {
    // A crash leaves the file behind, so its existence cannot be the signal. The reader
    // asks the kernel, which is why a pid nothing owns answers null.
    fs.writeFileSync(path.join(home, 'serve.pid'), '2147483646\n');
    expect(promote.serveIsRunning(home)).toBeNull();
  });

  it('treats a malformed pid as no server', () => {
    // A whole decimal number, not `parseInt`: `123abc` is not a pid, and reading it as 123
    // would name some unrelated process as the server.
    for (const raw of ['', 'not-a-pid', '123abc', '0', '-1', ' ']) {
      fs.writeFileSync(path.join(home, 'serve.pid'), `${raw}\n`);
      expect(promote.serveIsRunning(home)).toBeNull();
    }
  });

  it('is absent when no file exists', () => {
    expect(promote.serveIsRunning(home)).toBeNull();
  });
});

describe('refusing to promote', () => {
  it('refuses an unclaimed home', async () => {
    await expect(promote.promote(home)).rejects.toThrow(/names no owner/u);
    expect(fs.existsSync(lock.transitionPath(home))).toBe(false);
  });

  it('refuses a marker it does not understand, without rewriting it', async () => {
    plant('rust');
    await expect(promote.promote(home)).rejects.toThrow(/not a marker this build/u);
    expect(fs.readFileSync(path.join(home, 'IMPLEMENTATION'), 'utf8')).toBe('rust\n');
    expect(fs.existsSync(lock.transitionPath(home))).toBe(false);
  });

  it('is a no-op on a home that is already dual-v1', async () => {
    plant('dual-v1');
    const result = await promote.promote(home);
    expect(result).toEqual({ marker: 'dual-v1', promoted: false, reason: 'already-dual' });
    // No journal was ever written, so nothing is left for a recovery to find.
    expect(fs.existsSync(lock.transitionPath(home))).toBe(false);
  });

  it('refuses with no peer validator, and leaves the marker and no journal', async () => {
    plant(RETIRED_MARKER);
    // The whole meaning of `dual-v1` is that BOTH builds read the home and agreed. With
    // no second reader there is nothing to agree with, and assuming would write the one
    // claim the marker is not allowed to make on one build's word.
    await expect(promote.promote(home)).rejects.toThrow(/HOUSTON_PEER_VALIDATOR/u);
    expect(fs.readFileSync(path.join(home, 'IMPLEMENTATION'), 'utf8')).toBe(`${RETIRED_MARKER}\n`);
    expect(fs.existsSync(lock.transitionPath(home))).toBe(false);
  });

  it('refuses while a transition journal already exists', async () => {
    plant(RETIRED_MARKER);
    lock.beginTransition(home, { started_by: `${RETIRED_MARKER}:4242` });
    await expect(promote.promote(home)).rejects.toThrow(/already exists|in\s+flight/u);
    // AND THE JOURNAL SURVIVES. A second promotion losing the race must not clean up
    // after the first one, which is still running.
    expect(fs.existsSync(lock.transitionPath(home))).toBe(true);
  });

  it('refuses a live serve, removing its own journal but not the marker', async () => {
    plant(RETIRED_MARKER);
    fs.writeFileSync(path.join(home, 'serve.pid'), `${String(process.pid)}\n`);
    process.env.HOUSTON_PEER_VALIDATOR = 'true';
    await expect(promote.promote(home)).rejects.toThrow(/serve` is running/u);
    expect(fs.readFileSync(path.join(home, 'IMPLEMENTATION'), 'utf8')).toBe(`${RETIRED_MARKER}\n`);
    expect(fs.existsSync(lock.transitionPath(home))).toBe(false);
  });
});

describe('asking the other build', () => {
  // The peer runs through the exec seam as a real process.
  const SLOW = 60_000;

  it(
    'refuses a peer that is this build',
    async () => {
      plant(RETIRED_MARKER);
      // Pointing the peer at THIS build makes the comparison a build agreeing with
      // itself, which agrees whatever it got wrong. The marker says two implementations
      // checked the home, so this has to be a refusal rather than the easiest way to pass.
      process.env.HOUSTON_PEER_VALIDATOR = `${process.execPath} ${path.join(ROOT, 'tools', 'validate-state.js')}`;
      await expect(promote.promote(home)).rejects.toThrow(/which is this build/u);
      expect(fs.readFileSync(path.join(home, 'IMPLEMENTATION'), 'utf8')).toBe(
        `${RETIRED_MARKER}\n`,
      );
      expect(fs.existsSync(lock.transitionPath(home))).toBe(false);
    },
    SLOW,
  );

  it(
    'refuses a peer speaking another schema rather than diffing it',
    async () => {
      plant(RETIRED_MARKER);
      process.env.HOUSTON_PEER_VALIDATOR = `${process.execPath} -e "console.log(JSON.stringify({schema: 'other'}))" --`;
      await expect(promote.promote(home)).rejects.toThrow(/disagree about the QUESTION/u);
      expect(fs.existsSync(lock.transitionPath(home))).toBe(false);
    },
    SLOW,
  );
});

describe('recovering an interrupted promotion', () => {
  it('does nothing on a home with no journal', async () => {
    plant(RETIRED_MARKER);
    // EXACTLY the three keys earlier releases answer with: an earlier version added
    // `promoted: false`, a key they never write, to both early answers.
    expect(await promote.recover(home)).toEqual({
      recovered: false,
      reason: 'no-transition',
      marker: RETIRED_MARKER,
    });
  });

  it('refuses to recover from a journal that is a directory', async () => {
    // A directory is in flight -- it refuses every command -- but no promotion wrote it and
    // `clearTransition` cannot unlink it. Recovering promoted the home to dual-v1 on its
    // strength, left it there and reported success, so the home stayed refused for good.
    plant(RETIRED_MARKER);
    fs.mkdirSync(lock.transitionPath(home));
    await expect(promote.recover(home)).rejects.toThrow(/is a directory/u);
    expect(fs.readFileSync(path.join(home, 'IMPLEMENTATION'), 'utf8')).toBe(`${RETIRED_MARKER}\n`);
    expect(fs.statSync(lock.transitionPath(home)).isDirectory()).toBe(true);
  });

  it('only clears the journal once the swap has landed', async () => {
    // The state a kill between the marker replacement and the cleanup leaves. Recovery
    // must NOT re-validate here: the promotion already happened, and by now the other
    // build may legitimately have written to the home -- so no peer is configured, and
    // re-validating would refuse.
    plant('dual-v1');
    lock.beginTransition(home, { from: RETIRED_MARKER, to: 'dual-v1' });
    expect(await promote.recover(home)).toEqual({
      recovered: true,
      reason: 'completed-cleanup',
      marker: 'dual-v1',
    });
    expect(fs.existsSync(lock.transitionPath(home))).toBe(false);
    expect(fs.readFileSync(path.join(home, 'IMPLEMENTATION'), 'utf8')).toBe('dual-v1\n');
  });
});

describe('the transition journal', () => {
  it('is created once and refuses the second caller', () => {
    expect(lock.beginTransition(home, { a: 1 })).toBe(true);
    expect(lock.beginTransition(home, { a: 2 })).toBe(false);
    // The FIRST caller's record survives: the loser must not overwrite the winner's.
    expect(lock.readTransition(home)).toEqual({ a: 1 });
  });

  it('counts as in flight even when it cannot be parsed', () => {
    fs.writeFileSync(lock.transitionPath(home), 'not json at all\n');
    expect(lock.readTransition(home)).toEqual({});
    expect(lock.transitionReason(home)).toMatch(/in\s+flight/u);
  });

  it('is absent, not empty, when nothing is in flight', () => {
    expect(lock.readTransition(home)).toBeNull();
    expect(lock.transitionReason(home)).toBeNull();
  });

  it('counts as in flight whenever it is present, even unreadable or not UTF-8', () => {
    // PRESENCE is the signal, so a journal that cannot be read is still one. A directory or
    // an unreadable file read as null here -- every command went ahead -- and earlier releases
    // let a non-UTF-8 one through: the one file every build must read as "stop", read two ways.
    const target = lock.transitionPath(home);
    const shapes: [string, () => void][] = [
      [
        'not-utf8',
        () => fs.writeFileSync(target, Buffer.from('{"started_by": "\xff"}\n', 'latin1')),
      ],
      ['directory', () => fs.mkdirSync(target)],
      ['dangling-symlink', () => fs.symlinkSync(path.join(home, 'nowhere'), target)],
      [
        'unreadable',
        () => {
          fs.writeFileSync(target, '{}\n');
          fs.chmodSync(target, 0o000);
        },
      ],
    ];
    const seen = shapes.map(([shape, make]) => {
      fs.rmSync(target, { recursive: true, force: true });
      plant('typescript');
      make();
      let refused = '';
      try {
        lock.requireThisImplementation(home);
      } catch (error) {
        refused = (error as Error).message;
      }
      return [shape, lock.readTransition(home), /in\s+flight/u.test(refused)];
    });
    expect(seen).toEqual(shapes.map(([shape]) => [shape, {}, true]));
  });

  it('blocks every command while it exists, whoever owns the home', () => {
    // Checked BEFORE ownership: a promotion in flight is holding all five locks, and a
    // command from the home's OWN build would invalidate the validation just as surely
    // as one from the other build.
    plant('typescript');
    lock.beginTransition(home, { started_by: 'typescript:1' });
    expect(() => lock.requireThisImplementation(home)).toThrow(/in\s+flight/u);
  });

  it('stops blocking once cleared', () => {
    plant('typescript');
    lock.beginTransition(home, { started_by: 'typescript:1' });
    lock.clearTransition(home);
    expect(() => lock.requireThisImplementation(home)).not.toThrow();
  });
});

describe('the marker writer', () => {
  it('replaces atomically and keeps the file 0600', () => {
    plant('typescript');
    const before = fs.statSync(path.join(home, 'IMPLEMENTATION')).ino;
    lock.writeMarker(home, 'dual-v1');
    const after = fs.statSync(path.join(home, 'IMPLEMENTATION'));
    expect(fs.readFileSync(path.join(home, 'IMPLEMENTATION'), 'utf8')).toBe('dual-v1\n');
    // A DIFFERENT inode: temp-then-rename, not truncate-and-write. A truncate leaves a
    // window where the marker is empty, and an empty marker reads as "never claimed".
    expect(after.ino).not.toBe(before);
    expect(after.mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind', () => {
    plant(RETIRED_MARKER);
    lock.writeMarker(home, 'dual-v1');
    expect(fs.readdirSync(home).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});

describe('comparing two validation documents', () => {
  const base = {
    schema: promote.SUMMARY_SCHEMA,
    build: 'typescript',
    formats: { a: { x: 1, y: [1, 2] } },
  };

  it('finds nothing when they match', () => {
    expect(promote.differences(base, structuredClone(base))).toEqual([]);
  });

  it('names the path of a changed value', () => {
    const other = structuredClone(base);
    (other.formats.a as { x: number }).x = 2;
    expect(promote.differences(base, other)).toEqual(['.a.x']);
  });

  it('names a key that one side has and the other does not', () => {
    // ABSENCE, not just inequality: `extra.runtime` missing means docker, so a build
    // that materialised the key has changed the meaning while every resolved value
    // still matches.
    const other = structuredClone(base) as { formats: { a: Record<string, unknown> } };
    other.formats.a.runtime = 'docker';
    expect(promote.differences(base, other as never)).toEqual(['.a.runtime']);
  });

  it('does not confuse an absent key with an explicit null', () => {
    const withNull = structuredClone(base) as { formats: { a: Record<string, unknown> } };
    withNull.formats.a.gone = null;
    expect(promote.differences(base, withNull as never)).toEqual(['.a.gone']);
  });
});

describe('validating a home', () => {
  it('reports every format, and absence as absence', async () => {
    const summary = await promote.validateHome(home);
    expect(summary.schema).toBe(promote.SUMMARY_SCHEMA);
    // A peer pointed at the SAME build would agree with itself every time, whatever
    // either of them got wrong, so the document says which build answered.
    expect(summary.build).toBe('typescript');
    // THE WHOLE TABLE. A format missing from the validator is a format promotion never
    // checked, and the marker would then claim more than was measured.
    expect(Object.keys(summary.formats).sort()).toEqual([
      'acme',
      'audit',
      'backups',
      'ca',
      'clusters',
      'config',
      'edge',
      'eventlog',
      'firstrun',
      'journal',
      'presets',
      'sessions',
      'users',
      'workspaces',
    ]);
    // An empty home is EMPTY, not defaulted: a validator that filled in what it could
    // not find would assert the very thing it exists to check.
    expect((summary.formats.config as { present: boolean }).present).toBe(false);
    expect((summary.formats.users as { names: string[] }).names).toEqual([]);
  });

  it('leaves HOUSTON_HOME as it found it', async () => {
    // It has to set the variable to read a home that is not the ambient one, and a
    // validator that leaked that into the calling process would silently retarget every
    // reader after it.
    const before = process.env.HOUSTON_HOME;
    await promote.validateHome(home);
    expect(process.env.HOUSTON_HOME).toBe(before);
  });
});

describe('adopting a home the retired build wrote (the marker window)', () => {
  /** A home exactly as an earlier release left it: its files, recorded byte for byte. */
  function recordedHome(): void {
    for (const [relative, { mode, bytes }] of Object.entries(RECORDED.home)) {
      const file = path.join(home, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, 'utf8');
      fs.chmodSync(file, parseInt(mode, 8));
    }
  }

  it('validates and promotes a home an earlier release wrote', async () => {
    recordedHome();
    const notice = await promote.adoptRetiredHome(home);
    expect(typeof notice).toBe('string');
    expect(notice).toContain(lock.DUAL_IMPLEMENTATION);
    expect(lock.readImplementation(home)).toBe(lock.DUAL_IMPLEMENTATION);
    // And the other way: the marker left behind is the bytes an earlier release writes for
    // a shared home, which it accepts as its own.
    expect(fs.readFileSync(path.join(home, 'IMPLEMENTATION'), 'utf8')).toBe(RECORDED.dualMarker);
    expect(lock.transitionReason(home)).toBeNull();
    // Once: the marker changed, so the notice has nothing left to say.
    expect(await promote.adoptRetiredHome(home)).toBeNull();
  });

  it("promotes with this build's reading alone when no peer is configured", async () => {
    recordedHome();
    delete process.env.HOUSTON_PEER_VALIDATOR;
    const result = await promote.promote(home, { peer: 'optional' });
    expect(result).toMatchObject({
      promoted: true,
      marker: lock.DUAL_IMPLEMENTATION,
      from: RETIRED_MARKER,
    });
  });

  it('refuses a home an earlier release wrote that it cannot read, and leaves it be', async () => {
    recordedHome();
    // The accounts file, where the earlier release wrote it.
    const accounts = path.join(home, 'users');
    fs.writeFileSync(accounts, Buffer.from([0xff, 0xfe, 0x00, 0x7b]));
    await expect(promote.adoptRetiredHome(home)).rejects.toThrow();
    expect(lock.readImplementation(home)).toBe(RETIRED_MARKER);
    expect(lock.transitionReason(home)).toBeNull();
  });

  it("leaves dual-v1, this build's own and unclaimed homes alone", async () => {
    for (const marker of [lock.DUAL_IMPLEMENTATION, lock.THIS_IMPLEMENTATION, null]) {
      if (marker === null) fs.rmSync(path.join(home, 'IMPLEMENTATION'), { force: true });
      else plant(marker);
      expect(await promote.adoptRetiredHome(home)).toBeNull();
      expect(lock.readImplementation(home)).toBe(marker);
    }
  });

  it('refuses while a transition journal exists, and leaves the journal for recovery', async () => {
    recordedHome();
    lock.beginTransition(home, { started_by: `${RETIRED_MARKER}:4242` });
    await expect(promote.adoptRetiredHome(home)).rejects.toThrow(/in flight|transition/iu);
    expect(lock.readImplementation(home)).toBe(RETIRED_MARKER);
    expect(lock.transitionReason(home)).not.toBeNull();
  });

  it('still asks the peer when one is configured', async () => {
    recordedHome();
    process.env.HOUSTON_PEER_VALIDATOR = `${process.execPath} -e "process.exit(1)"`;
    await expect(promote.adoptRetiredHome(home)).rejects.toThrow(/peer validator/u);
    expect(lock.readImplementation(home)).toBe(RETIRED_MARKER);
    expect(lock.transitionReason(home)).toBeNull();
  });
});
