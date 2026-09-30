import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { fileErrorOf } from '../../src/lib/format';
import { mkdirParents } from '../../src/lib/mkdir-parents';

let scratch = '';
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-mkdir-'));
});
afterEach(() => {
  for (const entry of walk(scratch)) fs.chmodSync(path.join(scratch, entry), 0o700);
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Every directory under `root`, relative, deepest last. */
function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (relative: string): void => {
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full);
    if (!stat.isDirectory()) return;
    out.push(relative);
    try {
      for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name));
    } catch {
      /* a directory this user may not list */
    }
  };
  visit('.');
  return out;
}

/** `mode path` for every entry under `root`, so a listing compares with a recorded one. */
function listing(root: string): string[] {
  const out: string[] = [];
  const visit = (relative: string): void => {
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full);
    out.push(`${(stat.mode & 0o7777).toString(8)} ${relative}`);
    if (!stat.isDirectory()) return;
    try {
      for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name));
    } catch {
      /* listed as far as it can be */
    }
  };
  visit('.');
  return out;
}

/*
 * Earlier releases make the LEAF 0700 and every missing parent at the umask's mode;
 * `fs.mkdirSync({ recursive: true, mode: 0o700 })` made them all 0700. Each shape is set up
 * and made here, and its verdict and tree must be the ones earlier releases produced for the
 * same shape, recorded under a 022 umask -- which is why each case runs under one.
 */
describe('making a directory and its missing parents at a mode', () => {
  const RECORDED_UMASK = 0o022;

  // Each shape, with what earlier releases answered (`{ROOT}` for the root it was made in)
  // and the tree they left.
  const SHAPES: readonly [string, string, (root: string) => void, string, string[]][] = [
    [
      'three missing parents',
      'a/b/c/home',
      () => undefined,
      'made',
      ['755 .', '755 a', '755 a/b', '755 a/b/c', '700 a/b/c/home'],
    ],
    [
      'a leaf that exists at another mode',
      'kept',
      (root) => fs.mkdirSync(path.join(root, 'kept'), 0o755),
      'made',
      ['755 .', '755 kept'],
    ],
    [
      'a parent this user may not write',
      'ro/a/b',
      (root) => fs.mkdirSync(path.join(root, 'ro'), 0o555),
      'FileError: {ROOT}/ro/a: Permission denied',
      ['755 .', '555 ro'],
    ],
    [
      'a file where the leaf goes',
      'file',
      (root) => fs.writeFileSync(path.join(root, 'file'), ''),
      'FileError: {ROOT}/file: File exists',
      ['755 .', '644 file'],
    ],
    [
      'a file where a parent goes',
      'file/a/b',
      (root) => fs.writeFileSync(path.join(root, 'file'), ''),
      'FileError: {ROOT}/file/a/b: Not a directory',
      ['755 .', '644 file'],
    ],
    [
      'a dangling link where the leaf goes',
      'link',
      (root) => fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'link')),
      'FileError: {ROOT}/link: File exists',
      ['755 .', '777 link'],
    ],
  ];

  it.each(SHAPES)('%s', (_label, relative, shape, verdict, tree) => {
    const saved = process.umask(RECORDED_UMASK);
    try {
      const oursRoot = path.join(scratch, 'made');
      fs.mkdirSync(oursRoot);
      shape(oursRoot);

      let ours = 'made';
      try {
        mkdirParents(path.join(oursRoot, relative), 0o700);
      } catch (error) {
        const raised = fileErrorOf(error);
        ours = `${raised.name}: ${raised.message}`;
      }

      expect(ours).toBe(verdict.split('{ROOT}').join(oursRoot));
      expect(listing(oursRoot)).toEqual(tree);
    } finally {
      process.umask(saved);
    }
  });

  it('leaves the parents to the umask, so they are not all 0700', () => {
    // The shape of the finding itself, stated without any recording: only a 077 umask could
    // make a parent 0700, and then the leaf-only rule is invisible.
    const probe = path.join(scratch, 'probe');
    fs.mkdirSync(probe);
    const umaskMode = fs.statSync(probe).mode & 0o777;
    mkdirParents(path.join(scratch, 'a', 'b', 'home'), 0o700);
    expect(fs.statSync(path.join(scratch, 'a')).mode & 0o777).toBe(umaskMode);
    expect(fs.statSync(path.join(scratch, 'a', 'b')).mode & 0o777).toBe(umaskMode);
    expect(fs.statSync(path.join(scratch, 'a', 'b', 'home')).mode & 0o777).toBe(0o700);
  });
});
