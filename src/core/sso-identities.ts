/**
 * Which Okta person is which houston account: `<home>/sso-identities.json`.
 *
 * The `users` file keeps the shape 1.x reads, so the link lives beside it rather than in a
 * new column. A binding is keyed by the provider's `(issuer, sub)`, never by a username or an
 * email: both change, and both are reused when somebody leaves, and a reused one must not
 * inherit the old account.
 *
 * A binding is never deleted. `users remove` and `users unlink-sso` turn it into a tombstone,
 * so the person's next Okta sign-in is refused rather than quietly creating the account again,
 * and the name stays refused to any other Okta person. An approval is an admin's `users
 * link-sso <name>`: the one way an exact-name admin account, or a tombstoned name, is linked.
 *
 * NO LOCK HERE. Every write happens under `locks/users.lock`, taken by `core/users` (a removed
 * account's tombstone lands in the same lock as the removal) or `core/sso`; the lock is not
 * re-entrant, so this module cannot take it as well.
 *
 * A FILE IT CANNOT READ IS NOT AN EMPTY ONE. Read as empty, a damaged file would forget every
 * tombstone, and a removed person's next sign-in would create their account again. It throws,
 * and Okta sign-in refuses until it is repaired; password sign-in never reads it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../lib/config';
import { ValidationError } from '../lib/errors';
import { joinPath } from '../lib/home';

export const IDENTITIES_FILE = 'sso-identities.json';
export const IDENTITIES_VERSION = 1;

export interface Binding {
  issuer: string;
  sub: string;
  /** The houston account. */
  name: string;
  email: string;
  /** The provider's username (`preferred_username`), for display only. */
  display: string;
  status: 'active' | 'disabled';
  at: string;
}

export interface Approval {
  name: string;
  at: string;
}

export interface Identities {
  version: number;
  bindings: Binding[];
  approvals: Approval[];
}

const BINDING_TEXT = ['issuer', 'sub', 'name', 'email', 'display', 'at'] as const;

export function identitiesFile(): string {
  return joinPath(config.home(), IDENTITIES_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valid(doc: unknown): doc is Identities {
  return (
    isRecord(doc) &&
    doc.version === IDENTITIES_VERSION &&
    Array.isArray(doc.bindings) &&
    Array.isArray(doc.approvals) &&
    doc.bindings.every(
      (item) =>
        isRecord(item) &&
        BINDING_TEXT.every((key) => typeof item[key] === 'string') &&
        (item.status === 'active' || item.status === 'disabled'),
    ) &&
    doc.approvals.every(
      (item) => isRecord(item) && typeof item.name === 'string' && typeof item.at === 'string',
    )
  );
}

/** The document, or an empty one when there is no file. Throws for one it cannot read. */
export function read(): Identities {
  const target = identitiesFile();
  let text: string;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: IDENTITIES_VERSION, bindings: [], approvals: [] };
    }
    throw unreadable(target);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw unreadable(target);
  }
  if (!valid(doc)) throw unreadable(target);
  return doc;
}

function unreadable(target: string): ValidationError {
  return new ValidationError(
    `cannot read ${target} as houston's Okta links (version ${String(IDENTITIES_VERSION)}). ` +
      'Okta sign-in is refused until it is restored from a backup; password sign-in is unaffected.',
  );
}

/** Replace the file atomically, owner-only from creation. Call under `users.lock`. */
export function write(doc: Identities): void {
  const target = identitiesFile();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${String(process.pid)}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Disable every binding of `name` and drop its approval. Whether anything changed. */
export function tombstone(doc: Identities, name: string): boolean {
  let changed = false;
  for (const binding of doc.bindings) {
    if (binding.name === name && binding.status === 'active') {
      binding.status = 'disabled';
      binding.at = new Date().toISOString();
      changed = true;
    }
  }
  const approvals = doc.approvals.filter((item) => item.name !== name);
  changed ||= approvals.length !== doc.approvals.length;
  doc.approvals = approvals;
  return changed;
}

/**
 * Tombstone `name` in the file, for `users remove`. Call under `users.lock`.
 *
 * An unreadable file is left as it is and the removal goes ahead: Okta sign-in is already
 * refused while it is unreadable, and refusing the removal would keep a compromised account
 * signed in.
 */
export function forget(name: string): void {
  let doc: Identities;
  try {
    doc = read();
  } catch {
    return;
  }
  if (tombstone(doc, name)) write(doc);
}

/** Each account's active binding, for listings. Empty when the file cannot be read. */
export function linked(): Map<string, Binding> {
  try {
    return new Map(
      read()
        .bindings.filter((item) => item.status === 'active')
        .map((item) => [item.name, item]),
    );
  } catch {
    return new Map();
  }
}
