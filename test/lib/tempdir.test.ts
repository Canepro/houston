import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as TempdirNS from '../../src/lib/tempdir';
import { candidateTempdirList, defaultTempdir } from '../../src/lib/tempdir';

let scratch = '';
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-tempdir-'));
  fs.mkdirSync(path.join(scratch, 'ok'));
  fs.writeFileSync(path.join(scratch, 'afile'), 'not a directory');
  fs.mkdirSync(path.join(scratch, 'readonly'), 0o500);
});
afterEach(() => {
  fs.chmodSync(path.join(scratch, 'readonly'), 0o700);
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Ours as the CLI's last line words an unhandled error: `Name: message`. */
function verdict(run: () => string): string {
  try {
    return run();
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

/*
 * `os.tmpdir()` is `$TMPDIR` as given, so a TMPDIR that was deleted made every backup and
 * restore an ENOENT stack where earlier releases fall back to /tmp. The candidate list, the
 * probe that decides which candidate is usable, and the refusal when none is, each against
 * what earlier releases answered in the same environment and the same working directory,
 * recorded -- the scratch directory and the working directory spelled as this run's.
 */
describe('the temporary directory root', () => {
  it.each([
    ['none of the three set', {}, []],
    ['an empty TMPDIR, which is skipped', { TMPDIR: '', TMP: '/b' }, ['/b']],
    [
      'all three, in their fixed order',
      { TMP: '/c', TEMP: '/b', TMPDIR: '/a' },
      ['/a', '/b', '/c'],
    ],
    ['a relative TMPDIR, kept as given', { TMPDIR: 'rel/../x' }, ['rel/../x']],
  ])('lists its candidates as earlier releases do: %s', (_label, vars, first) => {
    // Recorded: the variables that are set, then the three fixed places, then the working
    // directory.
    const expected = [...first, '/tmp', '/var/tmp', '/usr/tmp', process.cwd()];
    expect(candidateTempdirList(vars)).toEqual(expected);
  });

  it.each([
    ['a directory that is gone, then one that is usable', ['gone', 'ok'], 'ok'],
    ['a file where a directory should be', ['afile', 'ok'], 'ok'],
    ['a directory it may not write into', ['readonly', 'ok'], 'ok'],
    ['a spelling with a .. that is folded before the probe', ['gone/../ok'], 'ok'],
    ['nothing usable at all', ['gone', 'afile/sub'], null],
  ])('settles on the directory earlier releases pick: %s', (_label, names, settled) => {
    // Spelled by hand, not `path.join`, which would fold the `..` before either side sees it.
    const spelled = names.map((name) => `${scratch}/${name}`);
    // Recorded: the usable directory, folded, or the refusal naming every candidate.
    const expected =
      settled === null
        ? `FileError: no usable temporary directory found in ${scratch}/gone, ${scratch}/afile/sub`
        : `${scratch}/${settled}`;
    expect(verdict(() => defaultTempdir(spelled))).toEqual(expected);
  });

  it('makes a relative candidate absolute, and keeps a root of exactly two slashes', () => {
    // Not `path.resolve`: the working directory joined on, then the path normalised the way
    // earlier releases normalise it, which keeps `//` where Node makes it `/`.
    const spelled = [path.relative(process.cwd(), path.join(scratch, 'ok')), `/${scratch}/ok`];
    // Recorded: the relative one made absolute, the doubled slash kept.
    const expected = [`${scratch}/ok`, `/${scratch}/ok`];
    spelled.forEach((one, at) => {
      expect(defaultTempdir([one])).toEqual(expected[at]);
    });
  });

  it('answers once for the process, as earlier releases do', () => {
    // Recorded: asked again after TMPDIR changed, the answer is still the first one.
    const expected = [path.join(scratch, 'ok'), path.join(scratch, 'ok')];
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP };
    try {
      process.env.TMPDIR = path.join(scratch, 'gone');
      process.env.TEMP = path.join(scratch, 'ok');
      jest.isolateModules(() => {
        const tempdir = require('../../src/lib/tempdir') as typeof TempdirNS;
        const first = tempdir.tempRoot();
        process.env.TMPDIR = path.join(scratch, 'readonly');
        expect([first, tempdir.tempRoot()]).toEqual(expected);
      });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('making a temporary directory', () => {
  it('makes <dir>/<prefix><8 of [a-z0-9_]> at 0700 in the directory the root settles on', () => {
    const vars = { TMPDIR: path.join(scratch, 'gone'), TEMP: path.join(scratch, 'ok') };
    // Recorded from earlier releases in the same environment: the directory, one name they
    // made, and its mode.
    const made = [path.join(scratch, 'ok'), 'houston-backup-fwa5qm01', 0o700] as const;
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP };
    try {
      Object.assign(process.env, vars);
      jest.isolateModules(() => {
        const tempdir = require('../../src/lib/tempdir') as typeof TempdirNS;
        const ours = tempdir.makeTempDir('houston-backup-');
        const shape = (name: string) => name.replace(/^houston-backup-[a-z0-9_]{8}$/u, '<name>');
        expect([
          path.dirname(ours),
          shape(path.basename(ours)),
          fs.statSync(ours).mode & 0o777,
        ]).toEqual([made[0], shape(made[1]), made[2]]);
        expect(shape(made[1])).toBe('<name>');
      });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
