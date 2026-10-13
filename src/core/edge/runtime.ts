/**
 * Starting, stopping, adopting and forgetting. Tier 6 of `src/core/edge/`.
 *
 * Nothing in the package imports this, which is what being the top of the tiers means.
 */
import * as fs from 'node:fs';
import { constants as osConstants } from 'node:os';
import * as path from 'node:path';

import { toYaml, type ComposeDoc } from '../../lib/compose';
import { ConflictError, ReproError, ValidationError } from '../../lib/errors';
import { joinPath } from '../../lib/home';
import { foldCase } from '../../lib/format';
import { orderedDict } from '../../lib/json-text';
import { compose as composeSeam } from '../../seams/docker-cli';
import { Interrupted } from '../../seams/exec';
import { exists } from '../runner/paths';
import { readCompose, readMeta, write as writeRecord } from '../runner/record';
import { ISSUED_FILE, MODE_ACME, SERVICE, issuedPath } from '../tls';

import { forgetAcme, hasAcme } from './acme';
import {
  composeRun,
  dockerRun,
  down,
  foreignEdge,
  holdersOf443,
  LAUNCH_FAILURE_CODE,
  ourContainer,
  publishesPorts,
  running,
  why,
  type DockerResult,
} from './engine';
import { attach, attachedNetworks, backendContainer } from './networks';
import * as paths from './paths';
import * as edgeRoutes from './routes';
import * as edgeSpec from './spec';
import { edge, resolveEdge, startResult, type StartResult } from './types';

/**
 * Move a workspace that runs its OWN Traefik onto the edge, without recreating it.
 *
 * Four steps, none of which stops Rocket.Chat or MongoDB:
 *
 *   1. remove ONLY the workspace's traefik container -- this is what frees 443
 *   2. attach the edge to the workspace's network, live
 *   3. write the route
 *   4. rewrite the compose file so a future `up` matches reality
 *
 * Step 4 is a file write and is NOT applied: compose files take effect on the next `up`,
 * so nothing restarts now. That is the difference from the first version, which called
 * `up` here and therefore recreated every container -- minutes of downtime per workspace,
 * and a rebuild is where an incompatibility or a lost volume would come from. Twenty
 * workspaces is now twenty seconds.
 */
export async function adopt(name: string): Promise<{ name: string; host: string }> {
  return await paths.edgeLock(async () => await adoptLocked(name));
}

async function adoptLocked(name: string): Promise<{ name: string; host: string }> {
  const meta = await readMeta(name);
  // `orderedDict(extra)`: a copy that writes back in the record's key order and spelling, where a
  // spread is a new object in JavaScript's order.
  const extra = orderedDict(meta.extra);
  const host = (meta.publicUrl || '').split('://').slice(-1)[0]?.split('/')[0] ?? '';
  if (extra.tls !== MODE_ACME || host === '') {
    throw new ValidationError(
      `'${name}' is not a --domain workspace, so there is nothing to move onto the edge`,
    );
  }

  // 1. Its Traefik, and only its Traefik. `docker rm -f` on one container leaves every
  //    other service in the project running.
  await dockerRun(['rm', '-f', await backendContainer(name, SERVICE)]);

  // 2. Live attach -- no restart of anything. Only if the edge exists yet: adoption
  //    usually runs BEFORE it starts, because freeing 443 is the whole reason it could
  //    not. `reattachAll()` picks these up after the start.
  if (await running()) await attach(name);

  // 3 + 4.
  const instances = typeof extra.instances === 'number' ? extra.instances : 1;
  const doc = await readCompose(name);
  const services = doc.services;
  if (services !== null && typeof services === 'object') {
    delete (services as Record<string, unknown>)[SERVICE];
  }
  extra.edge = true;
  // It no longer publishes 443, and leaving the claim would make every later workspace
  // allocate around a port this one does not hold.
  extra.tls_ports = [];
  await writeRecord(name, toYaml(doc as unknown as ComposeDoc), { ...meta, extra });
  await edgeRoutes.register(name, host, { instances });
  return { name, host };
}

/** What `systemdUnit` copies from the shell that printed it, in this order. */
const SERVICE_ENVIRONMENT = [
  'PATH',
  'HOUSTON_HOME',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
] as const;

/**
 * The unit that keeps `houston serve` up.
 *
 * Printed for the operator to install, never written by houston: writing it needs root,
 * and a tool that edits /etc/systemd on your behalf is a bigger thing to trust than one
 * that shows you the file. It also keeps this testable as a pure string, with no
 * privileged CI.
 *
 * `Restart=always` is only safe BECAUSE named accounts exist: with the old session token
 * every restart minted a new one and killed every bookmark.
 *
 * It carries the PATH of the shell that printed it. systemd starts a unit with its own
 * bare PATH, so under nvm `bin/houston`'s `exec node` failed with "node: not found"
 * (status 127) and the unit restarted forever; docker, aws and kubectl are found the same
 * way. AWS_PROFILE and the region go with it when set, or the GUI's EKS pages ask AWS
 * with the default profile rather than the one the operator signed in with.
 */
export function systemdUnit(
  execStart: string,
  user: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const lines = SERVICE_ENVIRONMENT.flatMap((key) => {
    // HOUSTON_HOME too, ABSOLUTE: a unit printed from a non-default home served `User=`'s
    // `~/.houston` -- other accounts, other workspaces -- and systemd starts it from `/`.
    const given = environment[key] ?? '';
    const value = key === 'HOUSTON_HOME' && given !== '' ? path.resolve(given) : given;
    // Inside quotes systemd reads C escapes, and `%` starts a specifier.
    const quoted = value.replace(/[\\"]/gu, '\\$&').replaceAll('%', '%%');
    return value === '' ? [] : [`Environment="${key}=${quoted}"\n`];
  });
  return (
    '[Unit]\n' +
    'Description=houston GUI\n' +
    'After=docker.service\n' +
    'Requires=docker.service\n' +
    '\n' +
    '[Service]\n' +
    `User=${user}\n` +
    lines.join('') +
    `ExecStart=${execStart}\n` +
    'Restart=always\n' +
    '\n' +
    '[Install]\n' +
    'WantedBy=multi-user.target\n'
  );
}

/**
 * Repair stale GUI state and materialise the requested edge configuration.
 *
 * `acmeEmail` MATTERS. A bare edge declares no resolver -- right for `up --https`, which
 * only ever serves local-CA names -- and a `--domain` workspace registered against it
 * produced routes Traefik rejected with "Router uses a nonexistent certificate resolver:
 * le", so the name 404'd while looking perfectly configured from the outside. The first
 * workspace that needs Let's Encrypt therefore teaches the edge how to ask.
 */
async function prepareEdge(acmeEmail: string, acmeStaging: boolean): Promise<void> {
  // Repair a GUI route left by an older houston. That version wrote one even with no
  // domain, producing ``Host(``)`` -- which Traefik rejects at every reload with "empty
  // args for matcher Host", plus a certResolver a bare edge never declares. Not writing it
  // any more does nothing for the edges that already have it, and nobody would think to
  // look in a generated directory.
  const gui = paths.routePath('_gui');
  if (edgeSpec.servedDomain() === '' && fs.existsSync(gui)) fs.rmSync(gui, { force: true });

  const wantAcme = acmeEmail !== '';
  if (!edgeSpec.installed()) {
    // Through `resolveEdge`, as the upgrade below and `serve` go: a bare `edge(...)` took the
    // default challenge, so the first edge `up` wrote ignored `acme.challenge` and the dns-01
    // credentials, and behind a tunnel asked for TLS-ALPN, which never validated.
    await edgeSpec.write(wantAcme ? resolveEdge('', acmeEmail, { acmeStaging }) : edge());
  } else if (wantAcme && !hasAcme()) {
    // Upgrade in place: keep whatever domain `serve` gave it, add the resolver.
    await edgeSpec.write(resolveEdge(edgeSpec.servedDomain(), acmeEmail, { acmeStaging }));
    await down(); // so the new flags are actually applied
  }
  // A container of ours that is UP but holds no ports cannot be repaired by the `compose
  // up -d` below: its resolved configuration has not changed, so compose leaves it exactly
  // as it is and reports success. Remove it first, so what follows is a real attempt that
  // either takes the ports or fails naming whoever has them.
  const stalled = await ourContainer();
  if (stalled !== '' && !(await publishesPorts(stalled))) await down();
}

/** Move every compatible pre-edge workspace off the shared HTTPS port. */
async function adoptLegacyPortHolders(): Promise<void> {
  // Workspaces from before the edge run their own Traefik on 443, which is exactly why the
  // edge cannot start. Moving them across is now instant and touches no data, so it
  // happens automatically rather than behind a flag -- the flag existed when doing this
  // meant recreating every container, and asking permission for something expensive is
  // very different from asking permission for removing one proxy container.
  for (const held of await holdersOf443()) {
    try {
      await adopt(held);
    } catch (error) {
      // One workspace that will not move must not stop the others, or the edge. Whatever
      // still holds the port is named by `portHolder()`.
      if (!(error instanceof ReproError) && !(error instanceof Error)) throw error;
      continue;
    }
  }
}

/**
 * Start the edge, and return what docker said. No network to create: it joins each
 * workspace's own.
 *
 * Returns the whole result rather than its return code, because the return code was all
 * the callers ever got and a failed start is precisely the moment the output matters.
 */
export async function up(options: { pull?: boolean } = {}): Promise<DockerResult> {
  return await paths.edgeLock(async () => await upLocked(options));
}

async function upLocked({ pull = true }: { pull?: boolean } = {}): Promise<DockerResult> {
  const other = await foreignEdge();
  if (other !== '') {
    // Refuse rather than replace. `compose up` would happily take the other home's
    // container, and the first anyone would know is every one of its names going dark.
    throw new ConflictError(
      'another houston edge is already running on this machine, from a different home:\n' +
        `    ${other}\n` +
        '  Starting this one would REPLACE it and take down every https name it serves.\n' +
        '  houston is designed around one shared home per box — set HOUSTON_HOME to the ' +
        'same\n  directory as the other user, or stop that edge first:\n' +
        `    HOUSTON_HOME=${path.dirname(other)} houston edge stop`,
    );
  }
  if (pull) await composeRun(['pull']); // non-fatal, exactly as `runner.up` does it
  const res = await composeRun(['up', '-d', '--remove-orphans']);
  if (res.returncode === 0) {
    // Every start, not just the first: a recreated container has none of its previous
    // attachments, and the route files that outlived it would then all answer 502.
    await edgeRoutes.reattachAll();
  }
  return res;
}

/**
 * Start the edge lazily, on the first route that needs it.
 *
 * Never at install and never on plain `serve`: a laptop that never asks for a name never
 * learns this exists. Workspace and GUI HTTPS remain unrelated.
 */
export async function ensureRunning(
  options: { acmeEmail?: string; acmeStaging?: boolean } = {},
): Promise<StartResult> {
  // Preparation and compose must see one generation. Locking only the final `up`
  // still lets a concurrent bare start replace a newly written ACME resolver.
  return await paths.edgeLock(async () => await ensureRunningLocked(options));
}

async function ensureRunningLocked({
  acmeEmail = '',
  acmeStaging = false,
}: { acmeEmail?: string; acmeStaging?: boolean } = {}): Promise<StartResult> {
  await prepareEdge(acmeEmail, acmeStaging);

  if (await running()) {
    // RUNNING IS NOT UP TO DATE. This returned true here, and the caller had already
    // rewritten the compose file -- `serve --domain X --email Y` calls `write(door)` first
    // -- so a changed resolver email, a changed domain or any new flag was written to disk
    // and never applied. The container kept the command line it was created with, `serve`
    // reported success, and nothing said the two disagreed. Found on a box whose
    // `acme.json` held an account for a MIStyped address while the corrected one was being
    // passed on every restart.
    //
    // `docker compose up -d` is the right instrument: it is idempotent and recreates the
    // container ONLY if the resolved configuration changed, so this costs one compose call
    // when nothing has and does the necessary thing when something has. The adoption loop
    // below is skipped -- nothing else can be holding :443 while this edge has it.
    const res = await up({ pull: false });
    return res.returncode === 0 ? startResult(true) : startResult(false, why(res));
  }
  await adoptLegacyPortHolders();
  const res = await up({ pull: false });
  return res.returncode === 0 ? startResult(true) : startResult(false, why(res));
}

/** Validate a destructive hostname request and return its claimed routes. */
async function validateHostDeletion(host: string, confirm: boolean): Promise<[string, string[]]> {
  const wanted = (host || '').trim().replace(/\.+$/u, '');
  if (wanted === '') {
    throw new ValidationError(
      'name a hostname to delete: `houston edge delete <host>`. `houston edge status` ' +
        'lists them.',
    );
  }
  const gui = edgeSpec.servedDomain();
  if (gui !== '' && foldCase(gui) === foldCase(wanted)) {
    throw new ConflictError(
      `${wanted} is the GUI's own name, so deleting it would take \`houston serve\` off ` +
        'HTTPS while you are probably using it. Stop the edge (`houston edge stop`) if ' +
        'that is really what you want.',
    );
  }
  const routes = edgeRoutes.routesFor(wanted);
  const live: string[] = [];
  for (const name of routes) {
    if (await exists(name)) live.push(name);
  }
  if (live.length > 0) {
    throw new ConflictError(
      `${wanted} still belongs to workspace '${live.join(', ')}' — deleting its ` +
        'certificate would leave a workspace that cannot serve its own name. `houston ' +
        `down --name ${String(live[0])} --volumes\` first, then delete the name.`,
    );
  }
  if (!confirm) {
    throw new ValidationError(
      `deleting ${wanted} removes its certificate and PRIVATE KEY and cannot be undone - ` +
        'pass confirm=true',
    );
  }
  return [wanted, routes];
}

/** Delete route, certificate, declaration, and ACME state for one hostname. */
async function deleteHostFiles(
  host: string,
  routes: readonly string[],
): Promise<[string[], boolean, boolean, string[]]> {
  // Passthrough first: the answer for a Kubernetes name is genuinely different, and saying
  // "certificate removed" about one that was never here would be a lie in the shape this
  // codebase keeps finding -- reporting the attempt as the outcome.
  const through = routes.filter((name) => edgeRoutes.isPassthrough(name));
  for (const name of routes) edgeRoutes.deregister(name);
  const crt = joinPath(paths.certsDir(), `${host}.crt`);
  const key = joinPath(paths.certsDir(), `${host}.key`);
  const hadCert = fs.existsSync(crt) || fs.existsSync(key);
  fs.rmSync(crt, { force: true });
  fs.rmSync(key, { force: true });
  const decl = joinPath(paths.dynamicDir(), `_cert-${host}.yml`);
  const hadDecl = fs.existsSync(decl);
  fs.rmSync(decl, { force: true });
  return [through, hadCert, hadDecl, await forgetAcme(host)];
}

/** Refresh our edge's in-memory ACME store, or identify a foreign edge. */
async function restartAfterAcmeDelete(
  stores: readonly string[],
  restart: boolean,
): Promise<[string, boolean | null]> {
  let foreign = '';
  let restarted: boolean | null = null;
  if (stores.length > 0 && restart) {
    if (await running()) {
      restarted = (await down()) === 0 && (await up({ pull: false })).returncode === 0;
    } else {
      foreign = await foreignEdge();
    }
  }
  return [foreign, restarted];
}

export interface HostDeletion {
  host: string;
  routes: string[];
  passthrough: string[];
  certificate: boolean;
  declaration: boolean;
  acme: string[];
  restarted: boolean | null;
  foreign: string;
  kept: string[];
}

/**
 * Forget `host` entirely: its routes, certificate, key, and ACME entry.
 *
 * Returns what actually went, per kind, so the caller reports the deletion it made instead
 * of the one it attempted.
 *
 * Three refusals, and each one is a case where deleting would break something the caller
 * can still see:
 *
 *  * a LIVE workspace still claims the name -- `down` it first, named in the error. A
 *    route whose workspace record is gone is the orphan this command exists for, so that
 *    one proceeds.
 *  * the name is the GUI's own -- deleting it takes `serve` off the network the operator
 *    is most likely using to run this.
 *  * `confirm` is not set. A private key is not recoverable and this is the only gate.
 *
 * `restart` is the part that is easy to get wrong. Traefik holds its ACME store in memory
 * and persists the whole file when a certificate changes, so an edit made underneath a
 * running Traefik can be written back from memory later -- the entry reappears, hours
 * after a command said it was deleted. Restarting rebuilds that memory from the edited
 * file. Routes are files, so every other name comes back with no re-registration; that
 * property is why a restart is affordable here.
 */
export async function deleteHost(
  host: string,
  options: { confirm?: boolean; restart?: boolean } = {},
): Promise<HostDeletion> {
  return await paths.edgeLock(async () => await deleteHostLocked(host, options));
}

async function deleteHostLocked(
  host: string,
  { confirm = false, restart = true }: { confirm?: boolean; restart?: boolean } = {},
): Promise<HostDeletion> {
  const [wanted, routes] = await validateHostDeletion(host, confirm);
  const [through, hadCert, hadDecl, stores] = await deleteHostFiles(wanted, routes);
  // Docker is asked ONLY for an ACME deletion. A route or a local certificate is read from
  // disk every time, so removing the file is already in effect; making a file deletion
  // depend on a daemon to decide it need not restart would be a cost with nothing bought.
  //
  // `running()` is HOME-AWARE -- it matches the compose project label AND the working
  // directory -- so `down()` here cannot reach an edge belonging to a different
  // HOUSTON_HOME, which every home naming its project `houston_edge` would otherwise make
  // trivially possible. That is not hypothetical: doing it by hand cost this box's owner
  // their edge once, following an error message that did not know about it either.
  //
  // Which leaves the case worth REPORTING rather than guarding: ours is not running and
  // somebody else's is. A foreign edge mounts its own home's ACME store, so the
  // certificate just deleted was this home's copy and NOT the one being served -- and a
  // plain "removed" would read as a name that stopped resolving.
  const [foreign, restarted] = await restartAfterAcmeDelete(stores, restart);
  return {
    host: wanted,
    routes: [...routes],
    passthrough: through,
    certificate: hadCert,
    declaration: hadDecl,
    acme: stores,
    restarted,
    foreign,
    kept: fs.existsSync(issuedPath()) ? [`acme/${ISSUED_FILE}`] : [],
  };
}

/**
 * Stream or dump the edge's own log, and return the exit code.
 *
 * The edge is where HTTPS actually succeeds or fails, and until now there was no way to
 * read it from houston: `edge` offered status/start/stop/restart, so the answer to "my
 * name serves nothing" lived in a container whose name you had to know.
 *
 * It matters most for ACME. Traefik requests certificates in the BACKGROUND after it
 * starts, so a name can be routed, the edge can be healthy, and issuance can still be
 * failing -- and the only record of why is here.
 */
export async function logs({ tail = 200, follow = false } = {}): Promise<number> {
  const args = ['logs', `--tail=${String(tail)}`];
  if (follow) args.push('-f');
  // NOT CAPTURED: the child inherits the terminal, so `-f` behaves like `docker compose
  // logs -f` and compose's own errors reach the reader in its words. This went through
  // composeRun, which captures, and dropped what it caught: `edge logs` printed nothing of
  // the log and `-f` nothing at all.
  //
  // Same contract otherwise: an absent `edge/` or docker must not be a stack trace. Not
  // reachable from the CLI, which guards on `installed()` first, and hardened anyway -- a
  // seam that raises for one caller raises for the next one. A Ctrl-C is not a launch
  // failure; it unwinds as the Interrupted it is.
  try {
    const res = await composeSeam(['-p', paths.PROJECT, ...args], { cwd: paths.edgeDir() });
    // `returncode`: a child a signal ended is minus that signal, the established convention.
    return res.exitCode ?? -(osConstants.signals[res.signal as NodeJS.Signals] as number);
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    return LAUNCH_FAILURE_CODE;
  }
}

export interface EdgeStatus {
  installed: boolean;
  running: boolean;
  routes: string[];
  attached: string[];
}

/** What `doctor` and the GUI report. */
export async function status(): Promise<EdgeStatus> {
  return {
    installed: edgeSpec.installed(),
    running: await running(),
    routes: edgeRoutes.registered(),
    // Which workspace networks it is currently joined to. A route with no attachment is a
    // 502 rather than an error, so the two belong side by side.
    attached: [...(await attachedNetworks())].sort(),
  };
}
