/**
 * How a person reaches a loopback-bound workspace from where they are.
 *
 * On the machine that runs it, the recorded URL opens. Over SSH it does not: the
 * workspace listens on the server's loopback only, which is the posture that makes fixed
 * `admin/admin123` credentials acceptable, so the answer is a tunnel the person pastes on
 * their own machine. This module only computes that advice from the record and the
 * session's environment. It opens nothing and changes no bind.
 */
import { hostname } from 'node:os';

import { ValidationError } from '../../lib/errors';
import type { Metadata } from '../runner/record';

export interface AccessHandoff {
  readonly mode: 'local' | 'remote_ssh';
  readonly bind: 'loopback';
  readonly host_port: number;
  readonly local_port: number;
  /** The preset's browser-facing side services, forwarded on the same port numbers. */
  readonly side_ports: readonly number[];
  readonly browser_url: string;
  /** The HTTPS address the shared edge serves for this workspace, when it has one. */
  readonly public_url: string | null;
  readonly tunnel_command: string | null;
  readonly note: string | null;
}

export type AccessEnvironment = Readonly<Record<string, string | undefined>>;
type AccessRecord = Pick<Metadata, 'extra' | 'hostPort' | 'rootUrl' | 'publicUrl'>;

const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/u;
const REMOTE_NOTE =
  'The workspace listens on loopback on the remote host only. Run the tunnel command on your ' +
  'machine, then open the browser URL there. Credentials stay private to that tunnel. If the ' +
  'local port is occupied, set HOUSTON_SSH_LOCAL_PORT on the remote command and request the ' +
  'handoff again.';
const PORT_RANGE = 'must be an integer between 1024 and 65535';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function trimmed(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const candidate = (value ?? '').trim();
    if (candidate !== '') return candidate;
  }
  return '';
}

function extraOf(meta: AccessRecord): Record<string, unknown> {
  const extra: unknown = meta.extra;
  return typeof extra === 'object' && extra !== null && !Array.isArray(extra)
    ? (extra as Record<string, unknown>)
    : {};
}

export function loopback(value: string): boolean {
  const host = value
    .trim()
    .replace(/^\[|\]$/gu, '')
    .toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255);
}

function sshSession(env: AccessEnvironment): boolean {
  return ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'].some((key) => (env[key] ?? '').trim() !== '');
}

/** `SSH_CONNECTION` is "client-ip client-port server-ip server-port". */
function connectionFields(env: AccessEnvironment): string[] {
  const fields = (env.SSH_CONNECTION ?? '').trim().split(/\s+/u);
  return fields.length === 4 ? fields : [];
}

function remoteHost(env: AccessEnvironment): string {
  return trimmed(
    env.HOUSTON_SSH_HOST,
    connectionFields(env)[2],
    env.HOSTNAME,
    hostname(),
    'remote-host',
  );
}

function remoteUser(env: AccessEnvironment): string {
  return trimmed(env.HOUSTON_SSH_USER, env.USER, env.LOGNAME, 'user');
}

/**
 * The port the SSH server answers on. `ssh` defaults to 22, so a session that came in on
 * another port would be told to reconnect on one that is not listening; the fourth field
 * of SSH_CONNECTION is where the server told us.
 */
function remoteSshPort(env: AccessEnvironment): number {
  const raw = trimmed(env.HOUSTON_SSH_PORT, connectionFields(env)[3]);
  if (raw === '') return 22;
  const port = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('HOUSTON_SSH_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function safeDestinationPart(value: string, label: string): string {
  if (
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || code === 0x7f);
    })
  ) {
    throw new ValidationError(`${label} must not contain control characters`);
  }
  return value;
}

function shellWord(value: string): string {
  if (SAFE_SHELL_WORD.test(value)) return value;
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function localPort(remotePort: number, env: AccessEnvironment): number {
  const raw = (env.HOUSTON_SSH_LOCAL_PORT ?? '').trim();
  if (raw === '') return remotePort;
  if (!/^\d+$/u.test(raw)) {
    throw new ValidationError(`HOUSTON_SSH_LOCAL_PORT ${PORT_RANGE}`);
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new ValidationError(`HOUSTON_SSH_LOCAL_PORT ${PORT_RANGE}`);
  }
  return port;
}

/**
 * Refuse a session override that cannot produce a working command, BEFORE a create runs.
 * `up` prints the handoff after the workspace exists; failing there reported a failure
 * over a create that had completed, and skipped the seed `up --seed` had been asked for.
 */
export function validateEnvironment(env: AccessEnvironment = process.env, bind = ''): void {
  // Only a loopback workspace ever gets a handoff, so a workspace bound elsewhere must not
  // be refused over a tunnel override it will never read. An empty bind is the default,
  // which is loopback.
  if (!sshSession(env) || (bind !== '' && !loopback(bind))) return;
  localPort(1024, env);
  remoteSshPort(env);
}

function forwardTarget(bind: string): string {
  const host = bind
    .trim()
    .replace(/^\[|\]$/gu, '')
    .toLowerCase();
  if (host === '::1') return '[::1]';
  // `localhost` resolves on the server to whichever family its resolver prefers; the
  // IPv4 loopback is what Docker published on. Any other loopback address is kept as
  // the exact socket the workspace listens on.
  return host === 'localhost' ? '127.0.0.1' : host;
}

function bindOf(meta: AccessRecord, resolvedBindHost: string): string {
  const resolved = resolvedBindHost.trim();
  if (resolved !== '') return resolved;
  // rootUrl is Houston's local call target, even for a wildcard listener. It cannot prove
  // loopback privacy, so absent recovered or recorded bind data stays unknown.
  return text(extraOf(meta).bind_host).trim();
}

/**
 * The workspace's recorded browser-facing side ports, as numbers: the preset's
 * (phpLDAPadmin, Keycloak, Mailpit) and monitoring's (Prometheus, Grafana), whose URLs
 * `info` advertises and which a tunnel that forwards Rocket.Chat alone leaves unreachable.
 */
function sidePorts(meta: AccessRecord, remotePort: number): number[] {
  const extra = extraOf(meta);
  const recorded = [extra.sidecar_ports, extra.monitoring_ports].flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
  const ports = recorded
    .map((value) => Number(value))
    .filter(
      (port) => Number.isSafeInteger(port) && port >= 1 && port <= 65535 && port !== remotePort,
    );
  return [...new Set(ports)].sort((left, right) => left - right);
}

export function handoff(
  meta: AccessRecord,
  env: AccessEnvironment = process.env,
  resolvedBindHost = '',
): AccessHandoff | null {
  const bind = bindOf(meta, resolvedBindHost);
  if (!loopback(bind)) return null;

  const remotePort = Number(meta.hostPort);
  const publicUrl = text(meta.publicUrl).trim() || null;
  const sides = sidePorts(meta, remotePort);
  if (!sshSession(env)) {
    return {
      mode: 'local',
      bind: 'loopback',
      host_port: remotePort,
      local_port: remotePort,
      side_ports: sides,
      browser_url: meta.rootUrl || `http://localhost:${String(remotePort)}`,
      public_url: publicUrl,
      tunnel_command: null,
      note: null,
    };
  }

  const selectedPort = localPort(remotePort, env);
  if (sides.includes(selectedPort)) {
    // Two -L on one local port cannot both listen, and ExitOnForwardFailure then ends the
    // tunnel: refuse here, naming the clash, rather than print a command that cannot work.
    throw new ValidationError(
      `HOUSTON_SSH_LOCAL_PORT ${String(selectedPort)} is one of this workspace's side ports ` +
        `(${sides.join(', ')}), which the tunnel forwards on their own numbers; choose another`,
    );
  }
  const sshPort = remoteSshPort(env);
  const user = safeDestinationPart(remoteUser(env), 'HOUSTON_SSH_USER');
  const host = safeDestinationPart(remoteHost(env), 'HOUSTON_SSH_HOST');
  const target = forwardTarget(bind);
  const destination = shellWord(`${user}@${host}`);
  // One -L per forward; side services keep their port numbers so the URLs a preset
  // prints and the redirects it configured (SAML, OIDC) stay right through the tunnel.
  const forwards = [
    `127.0.0.1:${String(selectedPort)}:${target}:${String(remotePort)}`,
    ...sides.map((port) => `127.0.0.1:${String(port)}:${target}:${String(port)}`),
  ];
  const command = [
    'ssh',
    '-N',
    // Without this ssh keeps running after the forward it could not open, looking like a
    // working tunnel to a browser that then reaches whatever owns the local port.
    '-o',
    'ExitOnForwardFailure=yes',
    ...(sshPort === 22 ? [] : ['-p', String(sshPort)]),
    ...forwards.flatMap((forward) => ['-L', shellWord(forward)]),
    '--',
    destination,
  ].join(' ');
  const notes = [REMOTE_NOTE];
  if (sides.length > 0) {
    notes.push(
      `The preset's side services are forwarded on their own ports (${sides.join(', ')}), ` +
        'so their printed URLs work through the tunnel.',
    );
  }
  if (selectedPort !== remotePort) {
    notes.push(
      `Rocket.Chat's ROOT_URL still names port ${String(remotePort)}: absolute links it ` +
        '(invitations, password resets, OAuth callbacks) point at ' +
        `http://127.0.0.1:${String(remotePort)}, so free that port rather than override it ` +
        'when a flow depends on them.',
    );
  }
  if (publicUrl !== null) {
    notes.push(
      `The workspace also answers at ${publicUrl} through the shared HTTPS edge; the tunnel ` +
        'reaches the plain HTTP backend and does not exercise TLS.',
    );
  }
  return {
    mode: 'remote_ssh',
    bind: 'loopback',
    host_port: remotePort,
    local_port: selectedPort,
    side_ports: sides,
    browser_url: `http://127.0.0.1:${String(selectedPort)}`,
    public_url: publicUrl,
    tunnel_command: command,
    note: notes.join(' '),
  };
}
