/** The `serve` command's security and lifetime policy around the shared Fastify app. */

import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import type * as FsNS from 'node:fs';
import type * as NetNS from 'node:net';
import type * as PathNS from 'node:path';

import type * as AuditNS from '../core/audit';
import type * as EdgeEngineNS from '../core/edge/engine';
import type * as EdgeNetworksNS from '../core/edge/networks';
import type * as EdgePathsNS from '../core/edge/paths';
import type * as EdgeRuntimeNS from '../core/edge/runtime';
import type * as EdgeSpecNS from '../core/edge/spec';
import type * as EdgeTypesNS from '../core/edge/types';
import type { Edge, StartResult } from '../core/edge/types';
import type * as FirstrunNS from '../core/firstrun';
import type * as AdminNS from '../core/lifecycle/admin';
import type * as PreconditionsNS from '../core/lifecycle/preconditions';
import type * as PromoteNS from '../core/promote';
import type * as RecoveryNS from '../core/recovery';
import type * as SessionsNS from '../core/sessions';
import type * as TlsNS from '../core/tls';
import type * as AcmeNS from '../core/edge/acme';
import type * as EndpointsNS from '../core/kube/endpoints';
import type * as UsersNS from '../core/users';
import type * as ConfigNS from '../lib/config';
import { ReproError, ValidationError, errorText } from '../lib/errors';
import { joinPath } from '../lib/home';
import { quotedText } from '../lib/format';
import { mkdirParents } from '../lib/mkdir-parents';
import { nullEmit } from '../lib/events';
import type * as ExecNS from '../seams/exec';
import type { AppOptions } from '../web/app';
import type * as WebAppNS from '../web/app';
import type { TrustedNetwork } from '../web/security';

export interface ServeOptions {
  readonly port?: number;
  readonly domain?: string;
  readonly email?: string;
  readonly noDomain?: boolean;
  readonly bind?: string;
  readonly allowHost?: readonly string[];
  readonly noOpen?: boolean;
  readonly printService?: boolean;
  readonly insecure?: boolean;
  readonly trustProxy?: readonly string[];
}

export interface ServeIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface ServeDependencies {
  readonly home: () => string;
  readonly loadConfig: () => Record<string, unknown>;
  readonly saveConfig: (value: Record<string, unknown>) => void;
  readonly normalizeAllowHost: (value: string) => readonly [string, string];
  readonly normalizeDomain: (value: string) => readonly [string, string];
  readonly servedDomain: () => string;
  readonly bridgeAddress: () => Promise<string>;
  readonly resolveEdge: (domain: string, email: string, overrides: Partial<Edge>) => Edge;
  readonly requireDocker: () => Promise<void>;
  readonly writeEdge: (value: Edge) => Promise<void>;
  readonly ensureEdge: (options: {
    readonly acmeEmail: string;
    readonly acmeStaging: boolean;
  }) => Promise<StartResult>;
  readonly edgePortHolder: (port: number) => Promise<string>;
  readonly edgeDirectory: () => string;
  readonly edgeProject: string;
  readonly edgeAddresses: () => Promise<string[]>;
  readonly anyUsers: () => boolean;
  readonly listUsers: () => readonly { readonly name: string }[];
  readonly roleOf: (name: string) => string;
  readonly implicitAdmins: () => string[];
  readonly mintFirstRun: () => string;
  readonly createApp: (options: AppOptions) => Promise<FastifyInstance>;
  /** Repair what a killed previous process left half-done; see `recoverInterruptedWork`. */
  readonly recoverInterrupted: () => Promise<readonly RecoveryNS.RecoverRow[]>;
  /** The GUI name's certificate report after the edge starts (`reportGuiTls`). */
  readonly reportGuiTls: (io: ServeIo, domain: string) => Promise<void>;
  readonly dnsEnvPath: () => string;
  readonly waitForShutdown: (app: FastifyInstance) => Promise<void>;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly executable: readonly [string, ...string[]];
  readonly user: () => string;
  readonly systemdUnit: (command: string, user: string) => string;
  readonly servePidPath: (home: string) => string;
  readonly tightenPrivateState: (say: (line: string) => void) => void;
  readonly writePid: (target: string, pid: number) => boolean;
  readonly removeOwnedPid: (target: string, pid: number) => void;
}

export interface RunningServe {
  readonly printed: false;
  readonly bind: string;
  readonly port: number;
  readonly domain: string;
  readonly url: string;
}

export interface PrintedServe {
  readonly printed: true;
  readonly command: string;
}

/** The first-run stop: printed on stderr, exit 3, and no `error:` -- nothing failed. */
export interface RefusedServe {
  readonly printed: false;
  readonly refused: true;
  readonly exitCode: number;
}

export type ServeResult = RunningServe | PrintedServe | RefusedServe;

interface ResolvedOptions {
  readonly port: number;
  readonly domain: string;
  readonly email: string;
  readonly noDomain: boolean;
  readonly bind: string;
  readonly allowHost: readonly string[];
  readonly noOpen: boolean;
  readonly printService: boolean;
  readonly insecure: boolean;
  readonly trustProxy: readonly string[];
}

interface ProxySet {
  readonly networks: TrustedNetwork[];
  readonly usable: string[];
  readonly problems: string[];
}

const DEFAULT_PORT = 7070;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const WILDCARD = new Set(['0.0.0.0', '::', '[::]']);

function optionsWithDefaults(options: ServeOptions): ResolvedOptions {
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ValidationError('--port must be an integer between 0 and 65535');
  }
  return {
    port,
    domain: options.domain ?? '',
    email: options.email ?? '',
    noDomain: options.noDomain ?? false,
    bind: options.bind ?? '',
    allowHost: [...(options.allowHost ?? [])],
    noOpen: options.noOpen ?? false,
    printService: options.printService ?? false,
    insecure: options.insecure ?? false,
    trustProxy: [...(options.trustProxy ?? [])],
  };
}

function defaultIo(): ServeIo {
  return {
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  };
}

function waitForSignal(_app: FastifyInstance): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

function openBrowser(url: string): Promise<void> {
  const exec = require('../seams/exec') as typeof ExecNS;
  const argv: [string, ...string[]] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd.exe', '/c', 'start', '', url]
        : ['xdg-open', url];
  return exec.startDetached(argv).then(() => undefined);
}

/**
 * Home to 0700 and the users, sessions and audit files to 0600, each only when its mode lets
 * the group or others in, and SAID -- the reassurance a shared-box admin reads before the
 * URL. A mode already private is left alone and not mentioned; a filesystem error anywhere is
 * silent, and one on home skips the files too.
 */
function tightenPrivateState(say: (line: string) => void): void {
  const fs = require('node:fs') as typeof FsNS;
  const path = require('node:path') as typeof PathNS;
  const config = require('../lib/config') as typeof ConfigNS;
  const users = require('../core/users') as typeof UsersNS;
  const sessions = require('../core/sessions') as typeof SessionsNS;
  const audit = require('../core/audit') as typeof AuditNS;
  const home = config.home();
  try {
    // The home made with its parents and NO mode, then the chmod: a recursive mkdir at
    // 0700 also made every missing parent 0700.
    fs.mkdirSync(home, { recursive: true });
    if ((fs.statSync(home).mode & 0o077) !== 0) {
      fs.chmodSync(home, 0o700);
      say(`  tightened ${home} to 0700 (it holds accounts, sessions and the audit log)`);
    }
  } catch {
    return;
  }
  for (const target of [users.usersFile(), sessions.sessionsFile(), audit.auditPath()]) {
    try {
      if (fs.existsSync(target) && (fs.statSync(target).mode & 0o077) !== 0) {
        fs.chmodSync(target, 0o600);
        say(`  tightened ${path.basename(target)} to 0600`);
      }
    } catch {
      // Best effort: failure to repair an old mode must not make the GUI unavailable.
    }
  }
}

function writePid(target: string, pid: number): boolean {
  const fs = require('node:fs') as typeof FsNS;
  const path = require('node:path') as typeof PathNS;
  const temporary = `${target}.${String(pid)}.tmp`;
  try {
    // The pid file's directory made with its parents, 0700 on the leaf only.
    mkdirParents(path.dirname(target), 0o700);
    fs.writeFileSync(temporary, `${String(pid)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Already renamed or the directory is unwritable.
    }
  }
}

function removeOwnedPid(target: string, pid: number): void {
  const fs = require('node:fs') as typeof FsNS;
  try {
    if (fs.readFileSync(target, 'utf8').trim() === String(pid)) fs.rmSync(target, { force: true });
  } catch {
    // Best effort on shutdown, matching the writer.
  }
}

/**
 * Set by `bin/houston`, this build's entry, to its own absolute path with its symlinks
 * resolved: the command the owner installed.
 */
const DISPATCHER_ENV = 'HOUSTON_DISPATCHER';

/**
 * What a unit's ExecStart runs: the `bin/houston` that ran this, else this build. It named
 * THIS build -- `node <checkout>/tools/cli.js` -- so a unit went stale the moment the build
 * behind the command moved. So a unit names `bin/houston`, this build's entry, whenever that
 * is what started the process. Run directly, not through it, this build still names itself.
 * systemd refuses a relative ExecStart, so a `bin/houston` path that is not absolute is not
 * used.
 */
function defaultExecutable(): readonly [string, ...string[]] {
  const path = require('node:path') as typeof PathNS;
  const dispatcher = process.env[DISPATCHER_ENV] ?? '';
  if (path.isAbsolute(dispatcher)) return [dispatcher];
  const script = process.argv[1];
  return script === undefined || script === ''
    ? ['houston']
    : [process.execPath, path.resolve(script)];
}

function defaultDependencies(): ServeDependencies {
  const config = require('../lib/config') as typeof ConfigNS;
  const tls = require('../core/tls') as typeof TlsNS;
  const edgeSpec = require('../core/edge/spec') as typeof EdgeSpecNS;
  const edgeEngine = require('../core/edge/engine') as typeof EdgeEngineNS;
  const edgeTypes = require('../core/edge/types') as typeof EdgeTypesNS;
  const edgeRuntime = require('../core/edge/runtime') as typeof EdgeRuntimeNS;
  const edgeNetworks = require('../core/edge/networks') as typeof EdgeNetworksNS;
  const edgePaths = require('../core/edge/paths') as typeof EdgePathsNS;
  const users = require('../core/users') as typeof UsersNS;
  const firstrun = require('../core/firstrun') as typeof FirstrunNS;
  const promote = require('../core/promote') as typeof PromoteNS;
  const preconditions = require('../core/lifecycle/preconditions') as typeof PreconditionsNS;
  const web = require('../web/app') as typeof WebAppNS;
  const recovery = require('../core/recovery') as typeof RecoveryNS;
  const admin = require('../core/lifecycle/admin') as typeof AdminNS;
  return {
    home: config.home,
    loadConfig: () => config.loadConfig(false),
    saveConfig: config.saveConfig,
    normalizeAllowHost: tls.normalizeAllowHost,
    normalizeDomain: tls.normalizeDomain,
    servedDomain: edgeSpec.servedDomain,
    bridgeAddress: edgeEngine.bridgeAddress,
    resolveEdge: edgeTypes.resolveEdge,
    requireDocker: preconditions.requireDocker,
    writeEdge: edgeSpec.write,
    ensureEdge: edgeRuntime.ensureRunning,
    edgePortHolder: edgeEngine.portHolder,
    edgeDirectory: edgePaths.edgeDir,
    edgeProject: edgePaths.PROJECT,
    edgeAddresses: edgeNetworks.containerAddresses,
    anyUsers: users.anyUsers,
    listUsers: users.listUsers,
    roleOf: users.roleOf,
    implicitAdmins: users.implicitAdmins,
    mintFirstRun: firstrun.mint,
    createApp: web.createApp,
    recoverInterrupted: () => recovery.recover(nullEmit, { login: admin.login }),
    reportGuiTls: async (io, domain) => {
      await reportGuiTls(io, domain);
    },
    dnsEnvPath: tls.dnsEnvPath,
    waitForShutdown: waitForSignal,
    openBrowser,
    executable: defaultExecutable(),
    user: () => process.env.USER || 'houston',
    systemdUnit: edgeRuntime.systemdUnit,
    servePidPath: promote.servePidPath,
    tightenPrivateState,
    writePid,
    removeOwnedPid,
  };
}

function isZeroAddress(address: string, family: number): boolean {
  if (family === 4) return address.split('.').every((part) => Number(part) === 0);
  return address
    .split(':')
    .filter((part) => part !== '')
    .every((part) => /^0+$/u.test(part));
}

function proxySet(entries: readonly string[]): ProxySet {
  const net = require('node:net') as typeof NetNS;
  const networks: TrustedNetwork[] = [];
  const usable: string[] = [];
  const problems: string[] = [];
  for (const raw of entries) {
    for (const value of raw.split(',')) {
      const part = value.trim();
      if (part === '') continue;
      const pieces = part.split('/');
      const address = pieces[0] ?? '';
      const family = net.isIP(address);
      const maximum = family === 6 ? 128 : 32;
      const prefix = pieces.length === 1 ? maximum : Number(pieces[1]);
      if (
        pieces.length > 2 ||
        family === 0 ||
        !Number.isInteger(prefix) ||
        prefix < 0 ||
        prefix > maximum
      ) {
        problems.push(
          `--trust-proxy ${quotedText(part)} is not an address or CIDR, so it was ignored — no proxy is trusted by it.`,
        );
        continue;
      }
      const block = new net.BlockList();
      const type = family === 6 ? 'ipv6' : 'ipv4';
      if (pieces.length === 1) block.addAddress(address, type);
      else block.addSubnet(address, prefix, type);
      const matchesNothing = prefix === maximum && isZeroAddress(address, family);
      if (prefix === 0) {
        problems.push(
          `--trust-proxy ${part} trusts X-Forwarded-* from ANY client, not just a proxy: ` +
            'anyone can then claim X-Forwarded-Proto: https to get a Secure cookie and ' +
            'silence the unencrypted warning, and set X-Forwarded-For to dodge the sign-in ' +
            "throttle. Name the proxy's own address instead.",
        );
      } else if (matchesNothing) {
        const every = family === 4 ? '0.0.0.0/0' : '::/0';
        const single = `${family === 4 ? '0.0.0.0' : '::'}/${String(maximum)}`;
        problems.push(
          `--trust-proxy ${part} means the single address ${single}, which no proxy has — ` +
            `did you mean ${every}? As it stands nothing is trusted and the session cookie ` +
            'will not be marked Secure.',
        );
      }
      networks.push({ contains: (candidate) => block.check(candidate, type) });
      if (!matchesNothing) usable.push(part);
    }
  }
  return { networks, usable, problems };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function serveCommand(
  options: ResolvedOptions,
  executable: readonly string[],
  resolved: { domain: string; email: string; bind: string; allowHost: readonly string[] },
  service: boolean,
): string {
  const parts = [...executable, 'serve'];
  if (resolved.domain !== '') {
    parts.push('--domain', resolved.domain, '--email', resolved.email);
  } else {
    parts.push('--bind', resolved.bind);
    if (options.insecure) parts.push('--insecure');
    for (const proxy of options.trustProxy) parts.push('--trust-proxy', proxy);
  }
  if (options.port !== DEFAULT_PORT) parts.push('--port', String(options.port));
  for (const host of resolved.allowHost) parts.push('--allow-host', host);
  if (service) parts.push('--no-open');
  return parts.map(shellQuote).join(' ');
}

function serviceText(command: string, dependencies: ServeDependencies): string {
  return (
    '\n# systemd — survives logout, restarts on crash, starts on boot.\n' +
    `# Write this to /etc/systemd/system/houston.service:\n\n` +
    // The unit already ends in a newline, and one more follows it.
    `${dependencies.systemdUnit(command, dependencies.user())}\n` +
    '# Then:\n' +
    '    sudo tee /etc/systemd/system/houston.service > /dev/null   # paste the above\n' +
    '    sudo systemctl daemon-reload\n' +
    '    sudo systemctl enable --now houston\n' +
    '    systemctl status houston && journalctl -u houston -f\n' +
    '\n# No systemd? nohup survives logout — and nothing else:\n' +
    // `config.home() / 'serve.log'`: `path.join` folded a `..` in the home.
    `    nohup ${command} > ${joinPath(dependencies.home(), 'serve.log')} 2>&1 &\n` +
    '# It will NOT restart on crash, NOT come back after a reboot,\n' +
    '# NOT rotate that log, and there is no `status` to ask.\n'
  );
}

/** The lowercased reason for each bind failure the refusal names. */
const BIND_STRERROR: Readonly<Record<string, string>> = {
  EADDRINUSE: 'address already in use',
  EACCES: 'permission denied',
  EADDRNOTAVAIL: 'address not available',
};

/**
 * The line logged when the listener cannot bind, or null for a failure that is not one.
 *
 * The line is `cannot listen on <host>:<port>: <reason, lowercased>` -- `address already in
 * use` for a port another process holds, `address not available` for an address this box
 * does not have -- with an IPv6 host in brackets, `[::1]:80`.
 */
function bindRefusal(error: unknown, bind: string, port: number): string | null {
  // Read by shape, not `instanceof Error`: a Node core error need not come from this realm.
  if (typeof error !== 'object' || error === null) return null;
  const failure = error as { syscall?: unknown; code?: unknown; address?: unknown; port?: unknown };
  if (failure.syscall !== 'listen' && failure.syscall !== 'bind') return null;
  const net = require('node:net') as typeof NetNS;
  const host = typeof failure.address === 'string' ? failure.address : bind;
  const at = typeof failure.port === 'number' ? failure.port : port;
  const where = net.isIP(host) === 6 ? `[${host}]:${String(at)}` : `${host}:${String(at)}`;
  const code = typeof failure.code === 'string' ? failure.code : '';
  const strerror = BIND_STRERROR[code];
  if (strerror === undefined) return null;
  return `cannot listen on ${where}: ${strerror}`;
}

function actualPort(app: FastifyInstance, fallback: number): number {
  const address = app.server.address();
  return address !== null && typeof address !== 'string' ? (address as AddressInfo).port : fallback;
}

function localUrl(
  bind: string,
  port: number,
  allowHost: readonly string[],
  setupKey: string,
): string {
  const loopback = LOOPBACK.has(bind);
  const host = loopback
    ? 'localhost'
    : (allowHost.find((value) => value !== '*') ?? (WILDCARD.has(bind) ? '<this-box>' : bind));
  const path = setupKey === '' ? '/' : `/setup#k=${setupKey}`;
  return `http://${host}:${String(port)}${path}`;
}

/** The URL, then how people sign in. */
function announce(
  io: ServeIo,
  dependencies: ServeDependencies,
  values: {
    readonly url: string;
    readonly domain: string;
    readonly door: Edge | null;
    readonly loopback: boolean;
    readonly setupKey: string;
    readonly trusted: readonly string[];
    readonly accounts: boolean;
  },
): void {
  const say = (line: string): void => io.writeOut(`${line}\n`);
  say(`houston GUI: ${values.url}`);
  if (values.door !== null) {
    if (values.door.wildcard) {
      say(
        `  one *.${values.domain} certificate covers every workspace — no per-name ` +
          'issuance, no weekly limit to hit.',
      );
    } else {
      say(
        '  each workspace name gets its own certificate. A DNS API token in ' +
          `${dependencies.dnsEnvPath()} would make it one wildcard.`,
      );
    }
    say(
      `  ${values.domain} must already resolve to this machine, or the certificate cannot ` +
        'be issued.',
    );
    say("  the first request may take a few seconds while Let's Encrypt issues it.");
    say(
      '  workspaces published under this name: houston up -v <X.Y.Z> --domain ' +
        `<ticket>.${values.domain}`,
    );
  }
  if (values.accounts) {
    // One line naming the posture, so an operator can read how people sign in and whether
    // the transport is believed, without inferring it from flags.
    const how =
      values.domain !== ''
        ? 'https, arranged by houston'
        : values.trusted.length > 0
          ? `https when the proxy says so, trusted from ${values.trusted.join(', ')}`
          : values.loopback
            ? 'loopback, so nothing crosses a network'
            : 'PLAIN HTTP on a reachable interface';
    say(`  auth: named accounts over ${how}`);
    if (values.loopback && values.domain === '') {
      say('  reachable from this machine only. To share it:');
      say('    houston serve --domain <name.example.com> --email you@example.com');
      say(
        '    …or, behind a lab/proxy already doing TLS: --bind 0.0.0.0 --allow-host ' +
          '<name>\n      --trust-proxy <its address>',
      );
    }
    if (values.domain === '' && values.trusted.length === 0 && !values.loopback) {
      say(
        '  ⚠ the session cookie will NOT be marked Secure, and the sign-in page will warn\n' +
          '    about an unencrypted connection. If TLS terminates at a proxy in front,\n' +
          '    tell houston which one: --trust-proxy <its address>',
      );
    }
    const names = dependencies
      .listUsers()
      .map((user) => `${user.name} (${dependencies.roleOf(user.name)})`)
      .join(', ');
    say(`  sign in as: ${names}`);
    const implicit = dependencies.implicitAdmins();
    if (implicit.length > 0) {
      say(`  ⚠ admin by default (blank role): ${implicit.join(', ')}`);
      say(`    narrow one with: houston users role ${implicit[0] ?? ''} member`);
    }
    say('  every action is recorded against the account that took it.');
  } else if (values.setupKey !== '') {
    say('  this link creates the first account. It is single-use and expires in 15 minutes.');
    say('  the part after # never reaches the server, so it cannot appear in a log.');
    say('  prefer a terminal? `houston users add <name>`, then start this again.');
  }
}

/**
 * STARTUP RECOVERY: what the last process was killed in the middle of is still true.
 *
 * Recovery runs before the server accepts a request, and an earlier version of this module
 * MISSED it: no front door called `core/recovery` at all, although that module's own
 * docstring says the front doors are its only callers. The shutdown drain is bounded and a
 * SIGKILL or an OOM skips it
 * entirely, so a previous run can have left Rocket.Chat stopped after an interrupted backup,
 * the API rate limiter off, or CPU caps applied after an interrupted load test -- with
 * nothing in memory recording it. `journal.recover` acts only on notes whose owning process
 * is provably gone, so a CLI operation running right now is left alone.
 *
 * Before the listener. And NEVER fatal: a box that cannot be repaired must still serve, or
 * one stuck workspace becomes an outage of the whole GUI. The three lines are the
 * established ones, word for word.
 */
async function recoverInterruptedWork(io: ServeIo, dependencies: ServeDependencies): Promise<void> {
  try {
    for (const row of await dependencies.recoverInterrupted()) {
      io.writeErr(`houston: ${row.repaired ? 'repaired' : 'STILL BROKEN'}: ${row.what}\n`);
    }
  } catch (error) {
    io.writeErr(`houston: could not check for interrupted work: ${errorText(error)}\n`);
  }
}

/**
 * Resolve, secure, start and own the TypeScript GUI listener.
 *
 * The CLI handler supplies already-parsed values, but this boundary still validates them.
 * Stateful modules are loaded at call time and every one is injectable so tests can prove
 * ordering without starting Docker, a browser, or a real listener.
 */
export async function serve(
  supplied: ServeOptions,
  overrides: Partial<ServeDependencies> = {},
  suppliedIo?: ServeIo,
): Promise<ServeResult> {
  const options = optionsWithDefaults(supplied);
  const dependencies = { ...defaultDependencies(), ...overrides };
  const io = suppliedIo ?? defaultIo();
  // Warnings, notes and hints off a terminal: every line on stdout.
  const say = (line: string): void => io.writeOut(`${line}\n`);

  // The allowed hosts, normalised.
  const allowed: string[] = [];
  for (const given of options.allowHost) {
    const [host, fixed] = dependencies.normalizeAllowHost(given);
    allowed.push(host);
    if (fixed !== '') say(`  using --allow-host ${host} (${fixed})`);
  }
  const allowHost = [...allowed];
  const hasAccounts = dependencies.anyUsers();

  // The front door: the domain, its contact email, the bind and the edge they imply.
  let domain = options.domain;
  let email = options.email;
  let bind = options.bind;
  let door: Edge | null = null;
  if (domain === '' && !options.noDomain) {
    domain = dependencies.servedDomain();
    if (domain !== '') say(`  serving ${domain} (set up earlier; --no-domain for a local session)`);
  }
  if (domain !== '') {
    const normalized = dependencies.normalizeDomain(domain);
    domain = normalized[0];
    if (normalized[1] !== '') say(`  using --domain ${domain} (${normalized[1]})`);
    const config = dependencies.loadConfig();
    const remembered = String(config.acme_email ?? '');
    email = email || remembered;
    if (email === '') {
      throw new ReproError(
        "a Let's Encrypt certificate needs a contact email:\n" +
          `  houston serve --domain ${domain} --email you@example.com\n` +
          'It is remembered after the first use, or set it once with:\n' +
          '  houston config set acme.email you@example.com',
      );
    }
    if (options.email !== '' && options.email !== remembered) {
      dependencies.saveConfig({ ...config, acme_email: email });
    }
    if (options.port === 0) {
      // TypeScript-only: `--port 0` exists here for tests and has no stable backend port.
      throw new ValidationError(
        '--port 0 cannot be used with --domain because the edge needs a stable backend port',
      );
    }
    bind = bind || (await dependencies.bridgeAddress());
    if (bind === '') {
      throw new ReproError(
        'could not read the Docker bridge address, which is how the front door reaches the GUI.\n' +
          '  Is Docker running? `houston doctor` checks.',
      );
    }
    allowed.push(domain);
    door = dependencies.resolveEdge(domain, email, { guiHost: bind, guiPort: options.port });
  } else {
    bind = bind || '127.0.0.1';
  }
  const loopback = LOOPBACK.has(bind);
  const resolved = { domain, email, bind, allowHost };

  // The first-run key: no accounts starts only on loopback with no domain. The refusal is
  // amber and two steps, NOT a red `error:` -- it is the documented first-run sequence -- but
  // it still exits 3, because `serve` did not serve. Whole block on stderr.
  let setupKey = '';
  if (!hasAccounts) {
    if (loopback && domain === '') {
      setupKey = dependencies.mintFirstRun();
    } else {
      io.writeErr(
        'houston needs an account before it will serve on an interface other than loopback.\n' +
          '\n  1. create one — the password is generated and shown once:\n' +
          '       houston users add <name>\n' +
          '  2. start it again:\n' +
          `       ${serveCommand(options, ['houston'], resolved, false)}\n\n`,
      );
      return { printed: false, refused: true, exitCode: 3 };
    }
  }

  // No password in the clear. `--trust-proxy` counts as SAID even when it matches nothing --
  // the list given is what is tested -- and its problems are warned below instead.
  const tlsUpstream = domain !== '' || options.insecure || options.trustProxy.length > 0;
  if (hasAccounts && !loopback && !tlsUpstream) {
    // A plain error with exit 3, as the no-accounts stop above, but a plain ReproError --
    // REPRO_ERROR in the event log, not PREFLIGHT_FAILED.
    throw new ReproError(
      `signing in over plain http on ${bind} puts the password on the wire once, and the\n` +
        '  session cookie on every request after it — both readable by anyone on the path.\n' +
        '  Refused by default.\n' +
        '  Have a hostname pointing here? Let houston do the TLS:\n' +
        '    houston serve --domain <your-domain> --email you@example.com\n' +
        '  TLS proxy on THIS box? Keep the GUI on loopback and point the proxy at it:\n' +
        `    houston serve --bind 127.0.0.1 --port ${String(options.port)} --allow-host <your-domain>\n` +
        '  TLS terminating upstream (remote proxy, lab, load balancer)?\n' +
        '    name the peer, so the cookie is marked Secure too:\n' +
        "      --trust-proxy <the proxy's address>\n" +
        '  Nothing doing TLS at all, on a network you trust?\n' +
        '    add --insecure to the command you just ran\n' +
        '  --trust-proxy and --insecure answer different questions: the first says who is\n' +
        '  encrypting it, the second says nobody is and you accept that. If there is a\n' +
        '  proxy, name it — it is the better answer and --insecure is then not needed.',
      { exitCode: 3 },
    );
  }

  // A warning when the bind is reachable from elsewhere.
  const parsedProxies = proxySet(options.trustProxy);
  if (!loopback && door === null) {
    say(
      `  ⚠ binding ${bind} exposes docker control (create/delete repros + volumes) to ` +
        'your network — use only if you mean to.',
    );
  }
  if (allowed.includes('*')) {
    say("  ⚠ --allow-host '*' accepts ANY Host header — only on a trusted/ephemeral network.");
  }
  for (const problem of parsedProxies.problems) say(`  ⚠ ${problem}`);
  if (allowHost.length > 0 && loopback && domain === '') {
    say(
      `  note: --allow-host ${allowHost[0] ?? ''} names who may reach this, but the bind is still\n` +
        '        loopback, so nothing off this machine can. Add --bind 0.0.0.0 if you\n' +
        '        meant to publish it.',
    );
  }
  if (!loopback && door === null && allowHost.length === 0) {
    say(
      '  ⚠ nothing is in --allow-host, so only localhost is accepted — a request by any\n' +
        "    other name will be a 403. Add --allow-host <the name you will type>, or '*'.",
    );
  }

  // The service unit is printed after every check, never before.
  const command = serveCommand(options, dependencies.executable, resolved, true);
  if (options.printService) {
    io.writeOut(serviceText(command, dependencies));
    if (!hasAccounts) {
      io.writeOut(
        '\n# Note: no accounts exist, so this would refuse to start on a\n' +
          '# reachable interface. `houston users add <name>` first.\n',
      );
    }
    return { printed: true, command };
  }

  // Opening the front door: the edge, when a domain asks for one.
  let edgeAddresses: string[] = [];
  if (door !== null) {
    await dependencies.requireDocker();
    say('starting the edge (one Traefik, :80 and :443 for every name)…');
    await dependencies.writeEdge(door);
    const started = await dependencies.ensureEdge({
      acmeEmail: email,
      acmeStaging: door.acmeStaging,
    });
    if (!started.ok) {
      const holder = await dependencies.edgePortHolder(443);
      throw new ReproError(
        'the edge did not start' +
          (holder !== '' ? ` — ${holder} is holding :443.` : '.') +
          (started.why !== '' ? `\n  docker said: ${started.why}` : '') +
          `\n  Its compose project is \`${dependencies.edgeProject}\` in ` +
          `${dependencies.edgeDirectory()}; \`houston edge status\` reports it.` +
          `\n  Full output: cd ${dependencies.edgeDirectory()} && docker compose -p ` +
          `${dependencies.edgeProject} up`,
      );
    }
    await dependencies.reportGuiTls(io, domain);
    edgeAddresses = await dependencies.edgeAddresses();
  }

  const edgeProxies = proxySet(edgeAddresses);
  const trustedProxies = [...parsedProxies.networks, ...edgeProxies.networks];
  const trustedNames = [...parsedProxies.usable, ...edgeProxies.usable];
  // The announcement, the app, the browser and the pid file, and only then the recovery and
  // the bind. The announcement comes BEFORE the listener, so a port in use is refused after
  // it, and its URL names the port that was ASKED for: `--port 0` announces
  // http://localhost:0/, as it always has, useless as that is -- the port it binds is not
  // known when it speaks.
  dependencies.tightenPrivateState(say);
  const url =
    domain !== '' ? `https://${domain}/` : localUrl(bind, options.port, allowed, setupKey);
  announce(io, dependencies, {
    url,
    domain,
    door,
    loopback,
    setupKey,
    trusted: trustedNames,
    accounts: hasAccounts,
  });
  const app = await dependencies.createApp({
    allowHosts: allowed,
    accounts: true,
    publicHttps: domain !== '',
    firstRun: setupKey !== '',
    trustedProxies,
  });
  if (!options.noOpen && loopback) {
    try {
      await dependencies.openBrowser(url);
    } catch {
      // Headless hosts are normal; the printed URL remains the interface.
    }
  }

  const pidPath = dependencies.servePidPath(dependencies.home());
  const pidWritten = dependencies.writePid(pidPath, process.pid);
  try {
    await recoverInterruptedWork(io, dependencies);
    try {
      await app.listen({ host: bind, port: options.port });
    } catch (error) {
      const refusal = bindRefusal(error, bind, options.port);
      if (refusal === null) throw error;
      // The startup failure: ONE `error:` line on stderr and exit 3, the preflight code --
      // the server refusing to start, said once.
      io.writeErr(`error: ${refusal}\n`);
      return { printed: false, refused: true, exitCode: 3 };
    }
    await dependencies.waitForShutdown(app);
    return { printed: false, bind, port: actualPort(app, options.port), domain, url };
  } finally {
    if (pidWritten) dependencies.removeOwnedPid(pidPath, process.pid);
    await app.close();
  }
}

function realSleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** `value` with every trailing character that is in `chars` removed. */
function rstrip(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1] as string)) end -= 1;
  return value.slice(0, end);
}

function writeLine(io: ServeIo, line: string): void {
  io.writeOut(`${line}\n`);
}

/**
 * A cluster holding this host's :80/:443, as a sentence, or "".
 *
 * THE EDGE STARTING IS NOT THE EDGE WORKING. A k3s ServiceLB claims host ports by DNAT
 * rather than by binding, so the edge binds both ports, compose reports success, and the
 * start path said "every registered name is served again" about a box where no name was
 * served at all -- for two days, with `edge status` agreeing the edge was running.
 */
export async function portClaimNote(): Promise<string> {
  const endpoints = require('../core/kube/endpoints') as typeof EndpointsNS;
  let claim: Awaited<ReturnType<typeof endpoints.portClaimingCluster>>;
  try {
    // 3s, not the probe default: this is a warning on the way to starting a proxy.
    claim = await endpoints.portClaimingCluster({ timeout: 3 });
  } catch {
    // a warning must never break a start
    return '';
  }
  if (claim === null) return '';
  const took = claim.ports
    .filter((port) => port === 80 || port === 443)
    .map((port) => `:${String(port)}`)
    .join(', ');
  return (
    `cluster ${quotedText(claim.context)} holds this host's ${took} at ${claim.address} ` +
    `(${claim.service}), so the edge is bound but cannot receive: names answer ` +
    'from the cluster, not from houston.\n' +
    '  Give the ports back: kubectl -n kube-system patch svc ' +
    `${claim.service.split('/').at(-1) ?? ''} -p ` +
    `'{"spec":{"type":"NodePort"}}'\n` +
    '  A k3s reinstall undoes that patch. Permanently: install with ' +
    '`--disable traefik --disable servicelb`, or put those two under ' +
    '`disable:` in /etc/rancher/k3s/config.yaml.'
  );
}

/**
 * Whether `domain` is really being served over TLS yet, and why not. Never fatal.
 *
 * Polled rather than asked once: ACME takes a few seconds on a good day, so a single probe
 * would report "not yet" for every healthy start and teach people to ignore it.
 */
export async function reportGuiTls(
  io: ServeIo,
  domain: string,
  {
    tries = 10,
    pause = 2.0,
    sleep = realSleep,
  }: { tries?: number; pause?: number; sleep?: (seconds: number) => Promise<void> } = {},
): Promise<void> {
  const tls = require('../core/tls') as typeof TlsNS;
  const acme = require('../core/edge/acme') as typeof AcmeNS;
  // BEFORE the wait: with a cluster holding the ports no challenge of any kind can
  // complete, so twenty seconds of "waiting for the certificate…" taught the reader that
  // this message means nothing.
  const claim = await portClaimNote();
  if (claim !== '') {
    writeLine(io, `  ⚠ https://${domain} cannot get a certificate — ${claim}`);
    return;
  }
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const got = await tls.verify('127.0.0.1', { port: 443, sni: domain, timeout: 5.0 });
    if (got.serving && !got.fallback) {
      writeLine(
        io,
        rstrip(`https://${domain} is serving a real certificate (${got.issuer})`, ' ()'),
      );
      return;
    }
    const why = await acme.acmeFailure({ domain });
    if (why !== '') {
      // Conclusive: Let's Encrypt has answered and said no. Stop waiting.
      writeLine(
        io,
        `  ⚠ https://${domain} has NO certificate yet, and Let's Encrypt refused:\n      ${why}`,
      );
      writeLine(
        io,
        `  The GUI itself is fine — this is the name, not the server. Check that ${domain} ` +
          "resolves to this host's public address and that :443 is reachable from the " +
          'internet (houston validates over TLS-ALPN on 443, not :80), then `houston edge restart`.',
      );
      writeLine(io, '  Full detail: `houston edge logs --tail 50`');
      return;
    }
    if (attempt < tries - 1) {
      if (attempt === 0) writeLine(io, `  waiting for the certificate for ${domain}…`);
      await sleep(pause);
    }
  }
  writeLine(
    io,
    `  ⚠ https://${domain} is not serving a real certificate yet. Traefik requests it in ` +
      'the background, so this may still complete.',
  );
  writeLine(io, '  Watch it: `houston edge logs -f`   ·   check it: `houston tls-status`');
}
