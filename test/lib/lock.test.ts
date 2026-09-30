import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PreflightError } from '../../src/lib/errors';
import type * as LockNS from '../../src/lib/lock';
import {
  DISPATCH_ROUTE_ENV,
  DISPATCH_TABLE_ENV,
  DUAL_IMPLEMENTATION,
  MARKER_NAME,
  THIS_IMPLEMENTATION,
  claim,
  conflictReason,
  consumeDispatch,
  homeIsEmpty,
  markerPath,
  readImplementation,
  requireThisImplementation,
} from '../../src/lib/lock';

/** The marker earlier releases write into a home they own: state on disk, kept as they wrote it. */
const EARLIER_MARKER = 'python';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-lock-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function writeMarker(text: string): void {
  fs.writeFileSync(markerPath(home), text, 'utf8');
}

describe('what this build calls itself', () => {
  it('is NOT what earlier releases call themselves', () => {
    // The whole mechanism is a no-op otherwise: the refusal fires on finding a name
    // that is neither this build's nor dual-v1, so two builds sharing one name would
    // wave each other straight through.
    expect(THIS_IMPLEMENTATION).toBe('typescript');
    expect(THIS_IMPLEMENTATION).not.toBe(EARLIER_MARKER);
  });

  it('uses the same file name as earlier releases', () => {
    // They have to read each other's marker, so the name is a shared constant and not
    // an implementation detail either side may rename.
    expect(MARKER_NAME).toBe('IMPLEMENTATION');
    expect(markerPath(home)).toBe(path.join(home, 'IMPLEMENTATION'));
  });
});

describe('reading a marker', () => {
  it('is null for a home that has never been claimed', () => {
    expect(readImplementation(home)).toBeNull();
  });

  it.each([
    ['an empty file', ''],
    ['whitespace only', '   \n  \n'],
  ])('is null for %s rather than throwing', (_label, body) => {
    writeMarker(body);
    expect(readImplementation(home)).toBeNull();
  });

  it('is null for a home that does not exist at all', () => {
    expect(readImplementation(path.join(home, 'nope', 'deeper'))).toBeNull();
  });

  it('reads the first line, trimmed and lowercased', () => {
    writeMarker(`  ${EARLIER_MARKER.toUpperCase()}  \nand some notes\n`);
    expect(readImplementation(home)).toBe(EARLIER_MARKER);
  });
});

describe('claiming', () => {
  it('writes this build"s name into a fresh home', () => {
    expect(claim(home)).toBe(THIS_IMPLEMENTATION);
    expect(fs.readFileSync(markerPath(home), 'utf8')).toBe(`${THIS_IMPLEMENTATION}\n`);
  });

  it('creates the home when it is missing, at 0700', () => {
    const fresh = path.join(home, 'nested');
    expect(claim(fresh)).toBe(THIS_IMPLEMENTATION);
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o700);
  });

  it('writes the marker at 0600', () => {
    claim(home);
    expect(fs.statSync(markerPath(home)).mode & 0o777).toBe(0o600);
  });

  it('NEVER overwrites an existing marker, including dual-v1', () => {
    writeMarker(`${EARLIER_MARKER}\n`);
    expect(claim(home)).toBe(EARLIER_MARKER);
    expect(fs.readFileSync(markerPath(home), 'utf8')).toBe(`${EARLIER_MARKER}\n`);

    fs.rmSync(markerPath(home));
    writeMarker(`${DUAL_IMPLEMENTATION}\n`);
    expect(claim(home)).toBe(DUAL_IMPLEMENTATION);
    expect(fs.readFileSync(markerPath(home), 'utf8')).toBe(`${DUAL_IMPLEMENTATION}\n`);
  });

  it('is idempotent for this build', () => {
    expect(claim(home)).toBe(THIS_IMPLEMENTATION);
    expect(claim(home)).toBe(THIS_IMPLEMENTATION);
  });

  it('makes 0700 the home alone, and its missing parents as earlier releases do', () => {
    // `HOUSTON_HOME=a/b/c/home`: earlier releases leave a, a/b and a/b/c at the umask's
    // mode, where a recursive mkdir made all four 0700 -- on every command's first run,
    // since the claim is the first write to a home.
    const modes = (root: string): string[] =>
      ['a', 'a/b', 'a/b/c', 'a/b/c/home'].map((relative) =>
        (fs.statSync(path.join(root, relative)).mode & 0o777).toString(8),
      );
    // What earlier releases' claim left under a 022 umask, recorded.
    const recorded = ['755', '755', '755', '700'];

    const saved = process.umask(0o022);
    try {
      const ours = path.join(home, 'typescript');
      expect(claim(path.join(ours, 'a', 'b', 'c', 'home'))).toBe(THIS_IMPLEMENTATION);
      expect(modes(ours)).toEqual(recorded);
      expect(modes(ours)[3]).toBe('700');
    } finally {
      process.umask(saved);
    }
  });
});

describe('the dispatch variables', () => {
  it('are read once, name this build only for its own route, and are then forgotten', () => {
    for (const [route, want] of [
      ['ts', 'dispatcher'],
      ['py', 'direct'],
      [undefined, 'direct'],
    ] as const) {
      if (route === undefined) delete process.env[DISPATCH_ROUTE_ENV];
      else process.env[DISPATCH_ROUTE_ENV] = route;
      process.env[DISPATCH_TABLE_ENV] = 'mixed';
      expect([route, consumeDispatch()]).toEqual([route, want]);
      expect(process.env[DISPATCH_ROUTE_ENV]).toBeUndefined();
      expect(process.env[DISPATCH_TABLE_ENV]).toBeUndefined();
    }
  });
});

describe('a fresh home, claimed for both (the marker window)', () => {
  const previous = process.env[DISPATCH_TABLE_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[DISPATCH_TABLE_ENV];
    else process.env[DISPATCH_TABLE_ENV] = previous;
  });

  it('is empty when absent or an empty directory, and nothing else is', () => {
    expect(homeIsEmpty(path.join(home, 'absent'))).toBe(true);
    expect(homeIsEmpty(home)).toBe(true);
    fs.writeFileSync(path.join(home, 'config.yaml'), 'bind_host: 127.0.0.1\n');
    expect(homeIsEmpty(home)).toBe(false);
    expect(homeIsEmpty(path.join(home, 'config.yaml'))).toBe(false);
  });

  it('is claimed for both builds, absent or empty', () => {
    delete process.env[DISPATCH_TABLE_ENV];
    const absent = path.join(home, 'absent');
    const empty = path.join(home, 'empty');
    fs.mkdirSync(empty);
    for (const fresh of [absent, empty]) {
      requireThisImplementation(fresh);
      expect(readImplementation(fresh)).toBe(DUAL_IMPLEMENTATION);
    }
  });

  it('is claimed for this build when anything is in it', () => {
    delete process.env[DISPATCH_TABLE_ENV];
    fs.writeFileSync(path.join(home, 'config.yaml'), 'bind_host: 127.0.0.1\n');
    requireThisImplementation(home);
    expect(readImplementation(home)).toBe(THIS_IMPLEMENTATION);
  });

  it('is claimed for both whatever the table variable says', () => {
    // The table variable is not read: no run is dispatched, and a fresh home is `dual-v1`
    // so an earlier release run against it never races this one.
    for (const word of ['single', 'mixed', undefined, 'MIXED', '']) {
      const fresh = path.join(home, `table-${String(word)}`);
      if (word === undefined) delete process.env[DISPATCH_TABLE_ENV];
      else process.env[DISPATCH_TABLE_ENV] = word;
      requireThisImplementation(fresh);
      expect([word, readImplementation(fresh)]).toEqual([word, DUAL_IMPLEMENTATION]);
    }
  });
});

describe('the refusal', () => {
  it('says nothing about a home this build owns', () => {
    claim(home);
    expect(conflictReason(home)).toBeNull();
  });

  it('says nothing about an unclaimed home', () => {
    expect(conflictReason(home)).toBeNull();
  });

  it('says nothing about a dual-v1 home', () => {
    writeMarker(`${DUAL_IMPLEMENTATION}\n`);
    expect(conflictReason(home)).toBeNull();
  });

  it('names the other build, this build, the path, and the way out', () => {
    writeMarker(`${EARLIER_MARKER}\n`);
    const reason = conflictReason(home);
    expect(reason).toContain(markerPath(home));
    expect(reason).toContain(`'${EARLIER_MARKER}'`);
    expect(reason).toContain(`'${THIS_IMPLEMENTATION}'`);
    // The consequence, not just the fact -- this is what stops somebody deleting the
    // marker to get past it.
    expect(reason).toContain('races docker compose against');
    expect(reason).toContain('HOUSTON_HOME=<a new path>');
  });
});

describe('requireThisImplementation', () => {
  it('claims an unclaimed, empty home for both and returns', () => {
    // `dual-v1` on write in the marker window; a non-empty unmarked home is still
    // claimed for this build, as the next describe shows.
    expect(() => requireThisImplementation(home)).not.toThrow();
    expect(readImplementation(home)).toBe(DUAL_IMPLEMENTATION);
  });

  it('returns for a home this build already owns', () => {
    claim(home);
    expect(() => requireThisImplementation(home)).not.toThrow();
  });

  it('returns for dual-v1 WITHOUT rewriting the marker', () => {
    writeMarker(`${DUAL_IMPLEMENTATION}\n`);
    expect(() => requireThisImplementation(home)).not.toThrow();
    expect(readImplementation(home)).toBe(DUAL_IMPLEMENTATION);
  });

  it('refuses a home an earlier release owns, as a PreflightError', () => {
    writeMarker(`${EARLIER_MARKER}\n`);
    // The taxonomy matters: PreflightError is exit 3 / HTTP 409, so a script can tell
    // "this environment is wrong" from "your input was wrong".
    expect(() => requireThisImplementation(home)).toThrow(PreflightError);
    try {
      requireThisImplementation(home);
    } catch (err) {
      expect((err as PreflightError).exitCode).toBe(3);
      expect((err as PreflightError).code).toBe('PREFLIGHT_FAILED');
    }
  });

  it('refuses without overwriting the evidence', () => {
    writeMarker(`${EARLIER_MARKER}\n`);
    expect(() => requireThisImplementation(home)).toThrow();
    expect(fs.readFileSync(markerPath(home), 'utf8')).toBe(`${EARLIER_MARKER}\n`);
  });

  it('refuses a home it cannot claim and says what to check', () => {
    // A marker path that is a DIRECTORY: it exists, cannot be read as a marker, and
    // cannot be created. The command must refuse rather than proceed.
    fs.mkdirSync(markerPath(home));
    expect(() => requireThisImplementation(home)).toThrow(/cannot safely claim/);
  });
});

describe('a claim that cannot complete', () => {
  it('is a preflight refusal that leaves no marker behind', () => {
    // A write that fails after the exclusive create must not leave a half-claimed home:
    // the next run has to find it unclaimed, not owned by an empty marker.
    // swc binds `import * as fs` to a copy, so the failure is injected through the module
    // registry into a fresh copy of the lock module.
    jest.isolateModules(() => {
      jest.doMock('fs', () => ({
        ...jest.requireActual<typeof fs>('fs'),
        writeFileSync: () => {
          throw new Error('no space');
        },
      }));
      const fresh = require('../../src/lib/lock') as typeof LockNS;
      expect(() => fresh.requireThisImplementation(home)).toThrow(/cannot safely claim/);
    });
    jest.dontMock('fs');
    expect(fs.existsSync(markerPath(home))).toBe(false);
  });
});

describe('a marker that cannot be read', () => {
  // Unknown bytes are neither safe ownership state: not this build, and not the name of some
  // other build either, which is what a lenient decode made of them.
  it('fails closed without being overwritten, whether it is not UTF-8 or only whitespace', () => {
    const bytes = Buffer.from([0xff, 0xfe, ...Buffer.from(' not utf-8 at all')]);
    fs.writeFileSync(markerPath(home), bytes);
    expect(readImplementation(home)).toBeNull();
    expect(conflictReason(home)).toBeNull();
    expect(() => requireThisImplementation(home)).toThrow(PreflightError);
    expect(() => requireThisImplementation(home)).toThrow(/cannot safely claim/);
    expect(fs.readFileSync(markerPath(home)).equals(bytes)).toBe(true);

    writeMarker('   \n\n');
    expect(readImplementation(home)).toBeNull();
    expect(conflictReason(home)).toBeNull();
    expect(() => requireThisImplementation(home)).toThrow(/cannot safely claim/);
    expect(fs.readFileSync(markerPath(home), 'utf8')).toBe('   \n\n');
  });
});

describe('reading a marker exactly as earlier releases read it', () => {
  // `trim()` strips U+FEFF and earlier releases' strip does not, so a marker saved with a BOM
  // named the earlier build here and an unknown build to earlier releases. Each corpus entry
  // is read byte for byte and compared with what earlier releases read, recorded.
  it('agrees with earlier releases on BOMs, odd whitespace and odd line breaks', () => {
    const corpus = [
      [0xef, 0xbb, 0xbf, ...Buffer.from(`${EARLIER_MARKER}\n`)],
      [0x1c, ...Buffer.from(EARLIER_MARKER), 0x1c, 0x0a],
      [...Buffer.from(EARLIER_MARKER.toUpperCase()), 0x0b, ...Buffer.from('extra')],
      [...Buffer.from('typescript\r\nwritten-by 1')],
      [...Buffer.from('dual-v1'), 0xe2, 0x80, 0xa8, ...Buffer.from('x')],
      [0xc2, 0x85, ...Buffer.from(EARLIER_MARKER)],
      [0xe3, 0x80, 0x80, ...Buffer.from(` ${EARLIER_MARKER} `)],
    ];
    const recorded = [
      `\ufeff${EARLIER_MARKER}`,
      EARLIER_MARKER,
      EARLIER_MARKER,
      'typescript',
      'dual-v1',
      EARLIER_MARKER,
      EARLIER_MARKER,
    ];
    const ours = corpus.map((raw) => {
      fs.writeFileSync(markerPath(home), Buffer.from(raw));
      return readImplementation(home);
    });
    expect(ours).toEqual(recorded);
  });
});
