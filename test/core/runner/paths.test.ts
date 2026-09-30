import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../../src/lib/config';
import { markerPath } from '../../../src/lib/lock';
import { baselinesDir } from '../../../src/perf/baseline';
import { auditPath } from '../../../src/core/audit';
import * as edgePaths from '../../../src/core/edge/paths';
import { clusterDir } from '../../../src/core/eks';
import { logPath } from '../../../src/core/eventlog';
import { keyPath } from '../../../src/core/firstrun';
import { journalDir } from '../../../src/core/journal';
import { ownedKubeconfig } from '../../../src/core/kube/exec';
import { sessionsFile } from '../../../src/core/sessions';
import { acmeDir, caDir } from '../../../src/core/tls';
import { usersFile } from '../../../src/core/users';

import { lockPath } from '../../../src/core/runner/locks';
import {
  atomicWrite,
  exists,
  mintProjectName,
  remove,
  restrict,
  workspace,
} from '../../../src/core/runner/paths';

function mode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

describe('atomicWrite', () => {
  it('never leaves a reader a partial file, and cleans its temp up', async () => {
    const target = path.join(config.home(), 'atomic.txt');
    await atomicWrite(target, 'first');
    await atomicWrite(target, 'second');
    expect(fs.readFileSync(target, 'utf8')).toBe('second');
    expect(fs.readdirSync(config.home()).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('gives every concurrent writer its own temp path', async () => {
    // A fixed `<name>.tmp` meant two web jobs touching one repro shared a temp file and
    // clobbered each other, which defeats the atomicity this exists to provide.
    const target = path.join(config.home(), 'concurrent.txt');
    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        atomicWrite(target, `writer-${String(index)}`),
      ),
    );
    expect(fs.readFileSync(target, 'utf8')).toMatch(/^writer-\d+$/);
    expect(fs.readdirSync(config.home()).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('applies the mode to the temp file, so the target is never briefly world-readable', async () => {
    const target = path.join(config.home(), 'private.key');
    await atomicWrite(target, 'a private key', { mode: 0o600 });
    expect(mode(target)).toBe(0o600);
  });

  it('removes the temp file when the rename fails', async () => {
    const directory = path.join(config.home(), 'nested');
    fs.mkdirSync(path.join(directory, 'blocked'), { recursive: true });
    await expect(atomicWrite(path.join(directory, 'blocked'), 'x')).rejects.toThrow();
    expect(fs.readdirSync(directory).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });
});

describe('a workspace on disk', () => {
  it('is found by either marker, so a Kubernetes workspace is not invisible', async () => {
    expect(await exists('absent')).toBe(false);

    fs.mkdirSync(workspace('compose-only'), { recursive: true });
    fs.writeFileSync(path.join(workspace('compose-only'), 'docker-compose.yml'), 'services: {}\n');
    expect(await exists('compose-only')).toBe(true);

    fs.mkdirSync(workspace('record-only'), { recursive: true });
    fs.writeFileSync(path.join(workspace('record-only'), 'repro.json'), '{}');
    expect(await exists('record-only')).toBe(true);
  });

  it('mints the project name from the prefix, for a NEW workspace only', () => {
    expect(mintProjectName('TICKET-1')).toBe(`${config.PROJECT_PREFIX}TICKET-1`);
    expect(workspace('TICKET-1')).toBe(path.join(config.reprosDir(), 'TICKET-1'));
  });

  it('is removed idempotently', async () => {
    fs.mkdirSync(workspace('gone'), { recursive: true });
    await remove('gone');
    await remove('gone');
    expect(fs.existsSync(workspace('gone'))).toBe(false);
  });

  it('forgives a record it cannot delete, exactly as earlier releases do', async () => {
    // Earlier releases remove a record ignoring every failure, and `force: true`
    // forgives only ENOENT. A container's root-owned file (EACCES, reproduced here with a
    // 0555 directory holding a file) rejected out of teardown and prune after the
    // containers or the namespace were already down.
    const stuck = workspace('stuck');
    fs.mkdirSync(stuck, { recursive: true });
    fs.writeFileSync(path.join(stuck, 'repro.json'), '{}');
    fs.chmodSync(stuck, 0o555);
    try {
      await expect(remove('stuck')).resolves.toBeUndefined();
      expect(fs.existsSync(stuck)).toBe(true);
    } finally {
      fs.chmodSync(stuck, 0o700);
    }
    await remove('stuck');
    expect(fs.existsSync(stuck)).toBe(false);
  });
});

describe('restrict', () => {
  it('locks the root down and leaves mounted content readable inside it', async () => {
    // The 0700 ROOT is what keeps other local users out. Files stay 0644 and nested
    // directories 0755 because half of what lives here is bind-mounted into containers
    // that run as non-root: 0600 made Prometheus crash-loop on its own config, and a
    // 0700 directory made it glob an unreadable file_sd_configs and scrape nothing.
    const root = workspace('restricted');
    fs.mkdirSync(path.join(root, 'prometheus', 'file_sd_configs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'prometheus', 'prometheus.yml'), 'global: {}\n', {
      mode: 0o600,
    });
    await restrict(root);

    expect(mode(root)).toBe(0o700);
    expect(mode(path.join(root, 'prometheus'))).toBe(0o755);
    expect(mode(path.join(root, 'prometheus', 'file_sd_configs'))).toBe(0o755);
    expect(mode(path.join(root, 'prometheus', 'prometheus.yml'))).toBe(0o644);
  });

  it('is never fatal on a path it cannot change', async () => {
    await expect(restrict(path.join(config.home(), 'not-here'))).resolves.toBeUndefined();
  });
});

describe('every state path', () => {
  it('is spelled as earlier releases spell it, whatever HOUSTON_HOME holds', () => {
    // Each of these was `path.join(<a path under the home>, ...)`, and `path.join` folds a
    // `..` against the text before it: with `HOUSTON_HOME=link/../hh` and `link ->
    // other/sub` earlier releases kept every file in `other/hh`, where the kernel takes it,
    // and this build in `hh` under the working directory -- two state directories, each
    // claimed by a different release. Earlier releases keep the `..` and a two-slash root,
    // and drop `.`, doubled and trailing slashes; so must every join below the home.
    const rows = ['link/../hh', 'x/..', 'a//b/./c/', '//srv/h', '.'];
    const previous = process.env.HOUSTON_HOME;
    let ours: string[][];
    try {
      ours = rows.map((row) => {
        process.env.HOUSTON_HOME = row;
        return [
          workspace('alpha'),
          lockPath('alpha'),
          markerPath(config.home()),
          usersFile(),
          sessionsFile(),
          auditPath(),
          logPath(),
          journalDir(),
          keyPath(),
          clusterDir('c1'),
          edgePaths.routePath('alpha'),
          edgePaths.certsDir(),
          edgePaths.composePath(),
          ownedKubeconfig(),
          baselinesDir(),
          caDir(),
          acmeDir(),
        ];
      });
    } finally {
      process.env.HOUSTON_HOME = previous;
    }
    // What earlier releases spelled each of the same paths as, for each row, recorded.
    const recorded = (
      JSON.parse(
        fs.readFileSync(
          path.join(__dirname, '..', '..', 'fixtures', 'core', 'runner', 'paths.json'),
          'utf8',
        ),
      ) as { statePaths: string[][] }
    ).statePaths;
    expect(ours).toEqual(recorded);
  });
});
