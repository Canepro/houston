/**
 * SSH guidance for loopback-bound workspaces.
 *
 * This module never opens a tunnel or changes a bind. It only gives the person who ran
 * houston over SSH a command they can run on their own machine. Both the JSON detail
 * payload and the human CLI panels use this one answer so they cannot disagree about
 * whether localhost is reachable.
 */
import { hostname } from 'node:os';

import { ValidationError } from '../../lib/errors';
import type { Metadata } from '../runner/record';

export interface AccessHandoff {
  readonly mode: 'local' | 'remote_ssh';
  readonly bind: 'loopback';
  readonly host_port: number;
  readonly local_port: number;
  readonly browser_url: string;
  readonly tunnel_command: string | null;
  readonly note: string | null;
}

export type AccessEnvironment = Readonly<Record<string, string | undefined>>;
type AccessRecord = Pick<Metadata, 'extra' | 'hostPort' | 'rootUrl'>;

const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/u;
const REMOTE_NOTE =
  'The workspace listens on loopback on the remote host only. Run the tunnel command on your ' +
  'machine, then open the browser URL there. Credentials stay private to that tunnel. If the ' +
  'local port is occupied, set HOUSTON_SSH_LOCAL_PORT on the remote command and request the ' +
  'handoff again.';

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

function rootHost(rootUrl: string): string {
  try {
    return new URL(rootUrl).hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  } catch {
    return '';
  }
}

function loopback(value: string): boolean {
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

function remoteHost(env: AccessEnvironment): string {
  const connection = (env.SSH_CONNECTION ?? '').trim().split(/\s+/u);
  const server = connection.length === 4 ? connection[2] : '';
  return trimmed(env.HOUSTON_SSH_HOST, server, env.HOSTNAME, hostname(), 'remote-host');
}

function remoteUser(env: AccessEnvironment): string {
  return trimmed(env.HOUSTON_SSH_USER, env.USER, env.LOGNAME, 'user');
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
    throw new ValidationError('HOUSTON_SSH_LOCAL_PORT must be an integer between 1024 and 65535');
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new ValidationError('HOUSTON_SSH_LOCAL_PORT must be an integer between 1024 and 65535');
  }
  return port;
}

function forwardTarget(rootUrl: string): string {
  return rootHost(rootUrl) === '::1' ? '[::1]' : '127.0.0.1';
}

function bindOf(meta: AccessRecord, resolvedBindHost: string): string {
  const resolved = resolvedBindHost.trim();
  if (resolved !== '') return resolved;
  const recorded = text(extraOf(meta).bind_host).trim();
  return recorded || rootHost(meta.rootUrl);
}

/**
 * The SSH handoff for a loopback-bound recorded workspace, or null when no tunnel guidance
 * applies. `resolvedBindHost` lets the detail payload pass its compose-derived answer. Human
 * output deliberately leaves it empty and uses persisted state, so `houston info` stays useful
 * if a half-created workspace has no compose file.
 */
export function handoff(
  meta: AccessRecord,
  env: AccessEnvironment = process.env,
  resolvedBindHost = '',
): AccessHandoff | null {
  if (!loopback(bindOf(meta, resolvedBindHost))) return null;

  const remotePort = Number(meta.hostPort);
  if (!sshSession(env)) {
    return {
      mode: 'local',
      bind: 'loopback',
      host_port: remotePort,
      local_port: remotePort,
      browser_url: meta.rootUrl || `http://localhost:${String(remotePort)}`,
      tunnel_command: null,
      note: null,
    };
  }

  const selectedPort = localPort(remotePort, env);
  const user = safeDestinationPart(remoteUser(env), 'HOUSTON_SSH_USER');
  const host = safeDestinationPart(remoteHost(env), 'HOUSTON_SSH_HOST');
  const target = forwardTarget(meta.rootUrl);
  const destination = shellWord(`${user}@${host}`);
  // This deliberately strengthens the historical suggestion: `GatewayPorts` can widen an
  // unqualified `-L` bind, and `--` keeps an operator-supplied destination from becoming an
  // SSH option.
  const forward = `127.0.0.1:${String(selectedPort)}:${target}:${String(remotePort)}`;
  return {
    mode: 'remote_ssh',
    bind: 'loopback',
    host_port: remotePort,
    local_port: selectedPort,
    browser_url: `http://127.0.0.1:${String(selectedPort)}`,
    tunnel_command: `ssh -N -L ${forward} -- ${destination}`,
    note: REMOTE_NOTE,
  };
}
