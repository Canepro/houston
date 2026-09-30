/**
 * Where this build's version comes from: one source, never a literal.
 *
 * Earlier releases resolved their version from the installed package metadata, never a
 * literal. This build reads `package.json` -- the one place a release moves it -- and the placeholder
 * `lib/jsonout.ts` starts with must never be what the CLI reports.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-version-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

it('reports the package version, from package metadata rather than a placeholder', () => {
  const declared = (
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }
  ).version;
  const proc = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'cli.js'), '--version'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HOUSTON_HOME: home },
  });
  expect({ status: proc.status, stderr: proc.stderr }).toEqual({ status: 0, stderr: '' });
  expect(proc.stdout).toBe(`houston ${declared}\n`);
  expect(declared).not.toBe('');
  expect(['0.0.0', '0.0.0-dev']).not.toContain(declared);
});
