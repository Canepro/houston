/**
 * Where a workspace lives on disk, and how anything is written into it.
 *
 * Asynchronous, because `serve` has no threadpool for a synchronous handler, so a state
 * owner that blocks on a write blocks every request and every job stream in the process.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as config from '../../lib/config';
import { LICENSE_ENV_FILE } from '../../lib/compose';
import { joinPath } from '../../lib/home';
import { pathExists } from '../../lib/format';

/**
 * Write via a temp file in the same directory plus a rename, so readers never see a
 * partially written file -- rename is atomic on the same filesystem.
 *
 * The temp name is unique per call: a fixed `<name>.tmp` meant two concurrent writers
 * (two web jobs touching the same repro) shared one temp path and clobbered each
 * other, defeating the atomicity this exists to provide.
 *
 * `mode` is applied to the TEMP FILE, before the rename -- so the target never exists
 * at the umask's permissions even for an instant. Callers writing a private key pass
 * 0o600: `edge.issueLocalCert` wrote `certs/<host>.key` through here and it landed at
 * whatever the umask allowed, typically 0644, on a box where `~/.houston` is only
 * tightened to 0700 by `serve` or a config save -- neither of which runs on a
 * CLI-only `up --https`.
 */
export async function atomicWrite(
  target: string,
  content: string,
  options: { mode?: number } = {},
): Promise<void> {
  const unique = `${String(process.pid)}.${randomBytes(4).toString('hex')}`;
  const temporary = joinPath(path.dirname(target), `${path.basename(target)}.${unique}.tmp`);
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: options.mode });
    if (options.mode !== undefined) await fs.chmod(temporary, options.mode);
    await fs.rename(temporary, target);
  } finally {
    // A no-op after a successful rename; the cleanup that matters is the failed one.
    await fs.rm(temporary, { force: true });
  }
}

/** The Compose project a NEW workspace's containers are created under. */
export function mintProjectName(name: string): string {
  return config.PROJECT_PREFIX + name;
}

export function workspace(name: string): string {
  // `name` under `reprosDir()`, and every path in a workspace joined the same way, with
  // `joinPath`: `path.join` folded a `..` in the home against the text before it, which
  // the kernel -- and so the previous implementation -- resolves through a symlink
  // instead. With `HOUSTON_HOME=link/../hh` an earlier version and the previous
  // implementation listed, read and wrote two different workspace trees.
  return joinPath(config.reprosDir(), name);
}

/**
 * Whether a workspace is here, whatever runtime it runs on.
 *
 * This used to be `(workspace/docker-compose.yml).exists()` -- a repro WAS a compose
 * file, which was true of every workspace this tool had ever made. A Kubernetes
 * workspace has no compose file, so it would have been invisible to `list`, `info`,
 * `down` and the name-collision check, and `up` would have silently created a second
 * one over the top of it.
 *
 * Either marker counts, which is strictly more permissive than before: no workspace
 * that used to be found can stop being found.
 *
 * It is deliberately more permissive than `readMeta`, and that gap is a real state
 * rather than an oversight: each file goes through `atomicWrite` but the PAIR is not
 * atomic, so a kill between them leaves a directory this accepts and `readMeta`
 * rejects. Staying permissive is what lets `down` clean such a directory up; `write`
 * writes repro.json FIRST so the surviving half is the one that can be read.
 */
export async function exists(name: string): Promise<boolean> {
  // Either marker, through `pathExists`, which is false only for "not there" and throws
  // otherwise -- so a workspace behind a directory it may not enter is a permission error,
  // as it always was, not "no repro named" and exit 4.
  const root = workspace(name);
  return (
    pathExists(joinPath(root, 'docker-compose.yml')) || pathExists(joinPath(root, 'repro.json'))
  );
}

/**
 * Keep a workspace's contents away from other local users. Best-effort.
 *
 * The DIRECTORY is what does the work: 0700 means no other user can traverse into the
 * workspace, so nothing inside it is reachable whatever its own mode. Mounted files stay
 * group/other readable, and that is not a compromise -- it is required. Half of what
 * lives here is bind-mounted INTO a container, and those run as non-root (Prometheus
 * as 65534, Grafana, Loki, the OTel collector), so 0600 made them unreadable and
 * Prometheus crash-looped on "open /etc/prometheus/prometheus.yml: permission denied".
 *
 * The Compose licence env file and its unfinished atomic temporaries stay 0600.
 * Compose reads that file on the host; no non-root container mounts it.
 *
 * Only the ROOT is 0700. Nested directories are 0755, because some volumes mount a
 * DIRECTORY rather than a file and the container then has to list it -- Prometheus
 * globs `/etc/prometheus/file_sd_configs/*.yml`, and with that directory at 0700 it
 * started cleanly and scraped nothing at all, which is worse than crashing.
 *
 * Never fatal: a workspace on a filesystem that cannot represent these modes (some
 * network shares) must still be usable -- refusing to create a repro over a permission
 * bit would trade a small exposure for a broken tool.
 */
export async function restrict(root: string): Promise<void> {
  try {
    await fs.chmod(root, 0o700);
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolute = joinPath(directory, entry.name);
        // This file is read as an env_file by Compose, never bind-mounted into a
        // non-root container. Keep it and any interrupted atomic temporary private.
        const license =
          directory === root &&
          (entry.name === LICENSE_ENV_FILE ||
            (entry.name.startsWith(`${LICENSE_ENV_FILE}.`) && entry.name.endsWith('.tmp')));
        await fs.chmod(absolute, entry.isDirectory() ? 0o755 : license ? 0o600 : 0o644);
        if (entry.isDirectory()) await walk(absolute);
      }
    };
    await walk(root);
  } catch {
    /* see the docstring: never fatal */
  }
}

/**
 * The workspace directory removed, every error ignored.
 *
 * SWALLOWED, and `force: true` is not the same thing: it forgives only ENOENT, so a
 * root-owned file a container left behind (EACCES) or a held-open one (EBUSY) rejected
 * here. Every caller treats removal as best-effort -- teardown and prune have already
 * taken the containers or the namespace down and report what they removed -- and a
 * rejection left the default set and the edge route registered for a workspace that is
 * gone. All of it is forgiven, as it always has been.
 */
export async function remove(name: string): Promise<void> {
  try {
    await fs.rm(workspace(name), { recursive: true, force: true });
  } catch {
    // see the docstring: never fatal
  }
}
