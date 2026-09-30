/**
 * Every test file gets its own `HOUSTON_HOME`, and none of them can reach a real one.
 *
 * Jest runs this before every test file. The rule it
 * enforces is in `CLAUDE.md`: a test that writes into `~/.houston` adds users, creates
 * workspaces or leaves ACME material in somebody's actual state directory, and the
 * failure is invisible until it is somebody else's problem.
 *
 * `setupFilesAfterEnv` runs once per test FILE in its own module registry, so each file gets a
 * distinct directory and files cannot see each other's state. The directory is removed
 * afterwards.
 *
 * The legacy `RC_REPRO_*` names are cleared too. They are read as deprecated aliases, so
 * one left in the ambient environment would silently redirect a test's state and print a
 * deprecation warning into the middle of the run.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-jest-'));

for (const name of Object.keys(process.env)) {
  if (name.startsWith('HOUSTON_') || name.startsWith('RC_REPRO_')) {
    delete process.env[name];
  }
}
process.env.HOUSTON_HOME = home;

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
