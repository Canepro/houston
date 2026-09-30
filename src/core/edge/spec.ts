/**
 * The edge's compose document, and the spec read back off disk. Tier 4 of `core/edge/`.
 */
import * as fs from 'node:fs';

import * as YAML from 'yaml';

import { toYaml, type ComposeDoc } from '../../lib/compose';
import { joinPath } from '../../lib/home';
import { isTruthy, storedText } from '../../lib/format';
import { dumps as jsonDumps, loads as jsonLoads } from '../../lib/json-text';
import { atomicWrite } from '../runner/paths';
import { TRAEFIK_TAG, acmeArgs, acmeDir, dnsEnvPath, dnsEnvVars } from '../tls';

import { dockerRun, running } from './engine';
import * as paths from './paths';
import { CONTAINER, DYNAMIC_DIR, SPEC_FILE } from './paths';
import { guiRouteYml } from './routeyml';
import { asTlsSpec, edge, fromDocument, toDocument, type Edge } from './types';

export function installed(): boolean {
  try {
    return fs.statSync(paths.composePath()).isFile();
  } catch {
    return false;
  }
}

/**
 * The hostname the edge was set up with, or ''.
 *
 * Recorded at `write()` so other code paths can NAME it -- the port-443 error is far more
 * useful saying "held by the edge, which serves support.xyz.com" than "held by something".
 * Read back from disk rather than passed around, because the code that needs it (`up`) is
 * a different process from the one that set it up (`serve`).
 */
export function servedDomain(): string {
  try {
    return fs.readFileSync(joinPath(paths.edgeDir(), 'domain'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Every flag Traefik is started with, and why each one is there. */
export function traefikCommand(value: Edge): string[] {
  return [
    // A DIRECTORY, not a single file: this is what makes registration a matter of writing
    // one file per workspace, with no restart. Verified live -- a second workspace was
    // routed with the container's restart count at 0.
    //
    // INFO, not Traefik's default of ERROR. At ERROR a Traefik that is healthy but has not
    // yet obtained a certificate logs NOTHING -- and that is exactly the state people get
    // stuck in: the name serves Traefik's own default certificate, `docker logs` comes
    // back empty, and an empty log reads as "no problem" when it means "no error YET".
    // Measured on two boxes on the same day: the one with a real DNS failure had nine ERR
    // lines and the one mid-issuance had none at all, which is exactly the wrong way round
    // for diagnosis.
    '--log.level=INFO',
    `--providers.file.directory=/etc/traefik/${DYNAMIC_DIR}`,
    '--providers.file.watch=true',
    // Container-internal ports, always 80/443 -- httpPort/httpsPort map onto these from
    // the host side, in `ports` below.
    '--entryPoints.websecure.address=:443',
    '--entryPoints.web.address=:80',
    // Typing the bare hostname reaches nothing otherwise: browsers try http first. Same
    // redirect the official rocketchat-compose Traefik files use.
    //
    // ...and :80 redirected to it, EXCEPT under http-01. An entryPoint redirection is a
    // middleware on the entrypoint applied to every router on it -- measured: an explicit
    // router for `/.well-known/acme-challenge/` on `web` still answered 301 -- so leaving
    // it on would redirect Let's Encrypt away from the challenge it came to fetch. The
    // cost is stated rather than hidden: while http-01 is in use, an `http://` URL does
    // not upgrade itself.
    ...(value.acmeChallenge === 'http'
      ? []
      : [
          '--entryPoints.web.http.redirections.entryPoint.to=websecure',
          '--entryPoints.web.http.redirections.entryPoint.scheme=https',
          '--entryPoints.web.http.redirections.entryPoint.permanent=true',
        ]),
    // Only with an email to register the ACME account against. Without one the edge still
    // serves every LOCAL-CA name perfectly well -- which is what lets `up --https` start it
    // with no configuration at all, on a box that has no public domain and never will. A
    // resolver declared with no email makes Traefik fail at startup, so this is a real
    // branch, not tidiness.
    //
    // A truth test on the email: a hand-edited `false` or `null` is no email too, where
    // `!== ''` declared a resolver registering the account `false`.
    ...(isTruthy(value.acmeEmail) ? acmeArgs(asTlsSpec(value)) : []),
  ];
}

/** The edge's compose document. Pure -- no disk, no Docker. */
export function composeDoc(value: Edge): ComposeDoc {
  const service: Record<string, unknown> = {
    image: `docker.io/traefik:${TRAEFIK_TAG}`,
    // The GUI and every workspace are unreachable while this is down.
    restart: 'unless-stopped',
    command: traefikCommand(value),
    volumes: [
      `./${DYNAMIC_DIR}:/etc/traefik/${DYNAMIC_DIR}:ro`,
      // Locally-signed certificates, for `--https` names. Without this mount the
      // declaration `issueLocalCert` writes points at a path that does not exist inside
      // the container, and Traefik quietly serves its own default certificate instead --
      // which looks exactly like a working setup until you read the issuer.
      './certs:/etc/traefik/certs:ro',
      // Shared with workspaces, so a certificate already issued for a name is reused
      // rather than re-requested against the weekly limit.
      `${acmeDir()}:/etc/traefik/acme`,
    ],
    // The port as the spec holds it: one held as 8080.0 is written `8080.0:80`, as it
    // always has been.
    ports: [`${storedText(value.httpPort)}:80`, `${storedText(value.httpsPort)}:443`],
    // No `networks` key at all. It joins each workspace's own network at runtime; naming
    // one here made compose refuse the project outright ("service edge refers to undefined
    // network edge") once the shared network was removed from the document. Declaring a
    // shared one is also exactly what would have put every workspace on the same network
    // and let them reach each other.
    //
    // How this container reaches the GUI, which is a HOST process (`houston serve`), not a
    // container -- so it is not on the edge network and cannot be reached by name.
    // host-gateway resolves to the bridge address.
    extra_hosts: ['host.docker.internal:host-gateway'],
  };
  if (value.acmeChallenge === 'dns') service.env_file = [dnsEnvPath()];
  return { services: { edge: service } } as unknown as ComposeDoc;
}

/** Materialise `<home>/edge/` -- compose file and the watched directory. */
export async function write(value: Edge): Promise<void> {
  fs.mkdirSync(paths.dynamicDir(), { recursive: true });
  // Before compose mounts it: a bind-mount source that does not exist is created by
  // Docker, owned by root, and then houston cannot write certificates into it.
  fs.mkdirSync(paths.certsDir(), { recursive: true });
  fs.mkdirSync(acmeDir(), { recursive: true });
  await atomicWrite(paths.composePath(), toYaml(composeDoc(value)));
  await atomicWrite(joinPath(paths.edgeDir(), 'domain'), `${value.domain}\n`);
  // THE WHOLE SPEC, because `current()` could only reconstruct the domain and the wildcard
  // flag -- it silently dropped the email, the GUI host and the GUI port, so nothing but
  // `serve --domain` could rebuild this edge faithfully. That is why `houston edge start`
  // could not apply a changed `acme.challenge`: it had no way to regenerate the compose
  // file without losing where the GUI lives.
  // THROUGH `toDocument`, so the keys on disk are the established `acme_email`/`gui_host`
  // spelling and not this interface's. The previous implementation reads this file too.
  //
  // Indented by 2, everything past ASCII escaped, so an IDN typed raw is written
  // `caf\u00e9.example`, and a float the spec was read holding keeps its `.0`.
  await atomicWrite(
    joinPath(paths.edgeDir(), SPEC_FILE),
    jsonDumps(toDocument(value), { indent: 2 }),
  );
  // ONLY with a domain. A bare edge (started by `up --https` on a box that has no public
  // name) has nothing to route to the GUI, and writing the route anyway produced
  // ``Host(``)`` -- which Traefik rejects at load with "empty args for matcher Host", and
  // then names a certResolver that a bare edge does not declare either. Two errors on
  // every start, for a route that cannot work.
  if (value.domain !== '') {
    await atomicWrite(paths.routePath('_gui'), guiRouteYml(value));
  } else {
    fs.rmSync(paths.routePath('_gui'), { force: true });
  }
}

/**
 * The edge as it was set up, or null. Read back from disk because `up` is a different
 * process from the `serve` that configured it.
 *
 * Prefers the recorded spec. The fallback below is what this used to be, and it is kept
 * for an edge written by a version that did not record one -- it reconstructs the domain
 * and infers the wildcard, and loses the email, the GUI host and the GUI port, which is
 * exactly why rebuilding from it was unsafe.
 */
export function current(): Edge | null {
  if (!installed()) return null;
  try {
    // `jsonLoads`, which keeps a float a float: 8080.0 is rebuilt as 8080.0, not 8080.
    const parsed: unknown = jsonLoads(
      fs.readFileSync(joinPath(paths.edgeDir(), SPEC_FILE), 'utf8'),
    );
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return fromDocument(parsed as Record<string, unknown>);
    }
  } catch {
    // Fall through rather than fail a start.
  }
  const domain = servedDomain();
  return edge({ domain, wildcard: domain !== '' && dnsEnvVars().length > 0 });
}

/**
 * `[only in the compose file, only in the running container]` for the edge's flags.
 *
 * RUNNING IS NOT UP TO DATE, which cost two days once: `config set acme.challenge http`
 * rewrote the compose file, the container kept the command line it was created with, and
 * every message said the edge was fine. `edge start` re-applies now, but nothing SAID when
 * the two had diverged -- and a reader who has just changed a setting has no way to tell
 * whether it took.
 *
 * Empty lists when they agree, or when there is nothing to compare. Compared as flag lists
 * rather than by order: compose and docker do not have to agree about ordering for the
 * configuration to be identical.
 */
export async function configDrift(): Promise<[string[], string[]]> {
  if (!installed() || !(await running())) return [[], []];
  let want: string[];
  try {
    const doc = YAML.parse(fs.readFileSync(paths.composePath(), 'utf8'), {
      uniqueKeys: false,
    }) as Record<string, unknown> | null;
    const services = (doc?.services ?? {}) as Record<string, Record<string, unknown>>;
    const service = Object.values(services)[0] ?? {};
    const command = service.command;
    want = Array.isArray(command) ? command.map((flag) => String(flag)) : [];
  } catch {
    return [[], []];
  }
  const out = await dockerRun(['inspect', CONTAINER, '--format', '{{json .Config.Cmd}}']);
  if (out.returncode !== 0) return [[], []];
  let got: string[];
  try {
    const parsed: unknown = JSON.parse(out.stdout || 'null');
    got = Array.isArray(parsed) ? parsed.map((flag) => String(flag)) : [];
  } catch {
    return [[], []];
  }
  if (want.length === 0 || got.length === 0) return [[], []];
  return [want.filter((flag) => !got.includes(flag)), got.filter((flag) => !want.includes(flag))];
}
