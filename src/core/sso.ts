/**
 * Okta sign-in for the web GUI: OpenID Connect, authorization code with PKCE, as a
 * confidential client.
 *
 * A person who opens houston from the Okta tile or the "Sign in with Okta" button lands on
 * the dashboard as the right houston account, without a houston password. Password sign-in
 * stays as the way back in when the provider is down or misconfigured, and nothing here can
 * stop `serve`, a password sign-in, a live session or the API: every failure is a `Refusal`
 * carrying a fixed reason code, which the sign-in page turns into a fixed sentence.
 *
 * ## Who becomes which account
 *
 * After the ID token and `/userinfo` are verified, with a verified email in an allowed domain:
 *
 *  1. A binding for `(issuer, sub)` exists: active and the account is there -> that account,
 *     with its current role (Okta never changes a role). Disabled -> refused, unless an admin
 *     approved the name again with `users link-sso`.
 *  2. The handle -- the local part of `preferred_username` (else of the email), normalised as
 *     every account name is, so `first.last` is `first-last` -- names an existing account:
 *     a member or readonly one is linked on first sign-in; an admin one only after `users
 *     link-sso <name>`; one bound to another person, or tombstoned, is refused.
 *  3. No such account: created with that handle and the configured role (never admin), with
 *     a minted password nobody is shown, when `sso.provision` allows it and the box has a
 *     local admin.
 *
 * Any OTHER account is never considered: houston `lovekesh` and Okta `lovekesh.kumar` are two
 * accounts, by the owner's decision. No email mapping, and no override that links a different
 * name; `houston chown` hands workspaces over if that is ever wanted.
 *
 * ## The protocol, and what is checked
 *
 * Discovery from the configured issuer only, whose document must name the same issuer and
 * HTTPS endpoints on its origin; metadata and keys cached for an hour, the keys fetched again
 * once (at most once a minute) for an unknown `kid`. The ID token is RS256 only, verified with
 * `node:crypto` against the JWKS key its `kid` names (`jose` is ESM-only, and this build and
 * its tests are CommonJS); then `iss`, `aud` (this client alone), `azp` when present, `exp`,
 * `iat` and the `nonce`. Profile claims come from `/userinfo`, whose `sub` must be the token's,
 * because Okta's ID token "may not include all claims". Every call goes through the HTTP seam
 * without following a redirect, under a deadline and a 256 KiB cap; the code exchange is never
 * retried. Tokens are dropped once read and never logged.
 *
 * Pending sign-ins live in this process's memory -- one `houston serve` per home -- single
 * use, ten minutes, at most 512, each tied to the browser that started it by a cookie.
 */
import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';
import * as fs from 'node:fs';

import * as config from '../lib/config';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { quotedText } from '../lib/format';
import { joinPath } from '../lib/home';
import { rcHttp } from '../seams/rc-http';

import { audit, record as auditRecord } from './audit';
import { revokeUser } from './sessions';
import * as identities from './sso-identities';
import * as users from './users';

// --- settings -----------------------------------------------------------------------

export const SECRET_ENV = 'HOUSTON_SSO_CLIENT_SECRET';
export const SECRET_FILE = 'sso.env';
export const PROVISION_CHOICES: readonly string[] = Object.freeze(['off', 'member', 'readonly']);

/** The `config` keys, stored under these names in config.yaml. */
export const SETTING_KEYS: readonly string[] = Object.freeze([
  'sso.issuer',
  'sso.client_id',
  'sso.public_url',
  'sso.email_domains',
  'sso.provision',
]);

/** What setting `sso.issuer` needs first: setting the issuer last is what turns Okta on. */
const NEEDED_FIRST: readonly string[] = ['sso.client_id', 'sso.public_url', 'sso.email_domains'];

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface Settings {
  readonly issuer: string;
  readonly clientId: string;
  /** The origin browsers use, without a trailing slash; the callback is `<it>/signin`. */
  readonly publicUrl: string;
  readonly emailDomains: readonly string[];
  readonly provision: string;
  readonly secret: string;
}

export type Readiness =
  | { readonly state: 'off' }
  | { readonly state: 'broken'; readonly why: string }
  | { readonly state: 'ready'; readonly settings: Settings };

function parsedUrl(key: string, given: string): URL {
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new ValidationError(`${key} must be a URL (got ${quotedText(given)})`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ValidationError(`${key} takes no user, query or fragment (got ${quotedText(given)})`);
  }
  return url;
}

/**
 * The value `config set <key> <given>` stores, or a `ValidationError` saying why not.
 *
 * The issuer is stored EXACTLY as given, because discovery compares it byte for byte with
 * the provider's own; the public URL is reduced to its origin.
 */
export function checkSetting(key: string, given: string): string {
  if (given !== given.trim() || /\s/u.test(given)) {
    throw new ValidationError(`${key} takes no spaces (got ${quotedText(given)})`);
  }
  switch (key) {
    case 'sso.issuer': {
      if (parsedUrl(key, given).protocol !== 'https:') {
        throw new ValidationError(`${key} must be an https URL (got ${quotedText(given)})`);
      }
      return given;
    }
    case 'sso.public_url': {
      const url = parsedUrl(key, given);
      const local = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
      if ((url.protocol !== 'https:' && !local) || url.pathname !== '/') {
        throw new ValidationError(
          `${key} is the origin people open houston at, https://<host>[:port] (http only ` +
            `on localhost) (got ${quotedText(given)})`,
        );
      }
      return url.origin;
    }
    case 'sso.client_id':
      if (!/^[\x21-\x7e]{1,255}$/u.test(given)) {
        throw new ValidationError(`${key} must be the Okta app's client ID`);
      }
      return given;
    case 'sso.email_domains': {
      const domains = given.toLowerCase().split(',');
      if (!domains.every((domain) => DOMAIN_RE.test(domain))) {
        throw new ValidationError(
          `${key} takes domains separated by commas, e.g. rocket.chat (got ${quotedText(given)})`,
        );
      }
      return domains.join(',');
    }
    case 'sso.provision':
      if (!PROVISION_CHOICES.includes(given)) {
        throw new ValidationError(
          `${key} takes ${PROVISION_CHOICES.join(', ')} -- never admin (got ${quotedText(given)})`,
        );
      }
      return given;
    default:
      throw new ValidationError(`unknown key ${quotedText(key)}`);
  }
}

/** Refuse `config set sso.issuer` while a setting it needs is missing. */
export function requireReadyForIssuer(stored: Readonly<Record<string, unknown>>): void {
  const missing = NEEDED_FIRST.filter((key) => String(stored[key] ?? '') === '');
  if (missing.length > 0) {
    throw new ValidationError(
      `set ${missing.join(', ')} first: setting sso.issuer is what turns Okta sign-in on`,
    );
  }
}

/**
 * The client secret: `HOUSTON_SSO_CLIENT_SECRET` from the environment, else `<home>/sso.env`.
 *
 * Never config.yaml, which `config list` prints. The file is read strictly: a regular file
 * this user owns with no access for anyone else, holding exactly one
 * `HOUSTON_SSO_CLIENT_SECRET=<secret>` line (blank and `#` lines aside), taken literally.
 */
function clientSecret(): string {
  const fromEnv = process.env[SECRET_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const file = joinPath(config.home(), SECRET_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new ValidationError(
      `no client secret: put ${SECRET_ENV}=<secret> in ${file} (mode 0600), or set ${SECRET_ENV}`,
    );
  }
  if (!stat.isFile()) throw new ValidationError(`${file} is not a regular file`);
  if ((stat.mode & 0o077) !== 0) throw new ValidationError(`${file} must be mode 0600`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new ValidationError(`${file} must be owned by the user running houston`);
  }
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line !== '' && !line.startsWith('#'));
  const secret = lines.length === 1 ? (lines[0] ?? '').slice(SECRET_ENV.length + 1) : '';
  if (
    !(lines[0] ?? '').startsWith(`${SECRET_ENV}=`) ||
    !/^[\x21-\x7e]+$/u.test(secret) ||
    /^["']/u.test(secret)
  ) {
    throw new ValidationError(
      `${file} must hold exactly one line, ${SECRET_ENV}=<secret>, unquoted and without spaces`,
    );
  }
  return secret;
}

/** Whether Okta sign-in is off, set up but unusable (and why), or ready. Never throws. */
export function readiness(): Readiness {
  try {
    const stored = config.loadConfig();
    const value = (key: string): string => {
      const raw = stored[key];
      return raw === undefined || raw === null ? '' : String(raw);
    };
    if (value('sso.issuer') === '') return { state: 'off' };
    const checked = (key: string): string => {
      if (value(key) === '') throw new ValidationError(`${key} is not set`);
      return checkSetting(key, value(key));
    };
    return {
      state: 'ready',
      settings: {
        issuer: checked('sso.issuer'),
        clientId: checked('sso.client_id'),
        publicUrl: checked('sso.public_url'),
        emailDomains: checked('sso.email_domains').split(','),
        provision: value('sso.provision') === '' ? 'off' : checked('sso.provision'),
        secret: clientSecret(),
      },
    };
  } catch (error) {
    return { state: 'broken', why: error instanceof Error ? error.message : String(error) };
  }
}

// --- talking to the provider --------------------------------------------------------

/** Why a sign-in did not complete: a fixed code the sign-in page turns into a sentence. */
export class Refusal extends Error {
  constructor(readonly code: string) {
    super(`Okta sign-in refused: ${code}`);
    this.name = 'Refusal';
  }
}

export const MAX_BYTES = 256 * 1024;
const LOOKUP_MS = 5_000;
const TOKEN_MS = 10_000;
const TOTAL_MS = 25_000;
const CACHE_MS = 3_600_000;
const KEY_REFRESH_MS = 60_000;
const SKEW_SECONDS = 60;

interface Provider {
  readonly issuer: string;
  readonly authorize: string;
  readonly token: string;
  readonly userinfo: string;
  readonly jwks: string;
  readonly at: number;
}

let provider: Provider | null = null;
let keys: { issuer: string; at: number; byKid: Map<string, KeyObject> } | null = null;
let keysFetchedAt = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One JSON answer from the provider, or a Refusal: `down` unanswered, `provider` refused. */
async function fetchJson(
  url: string,
  until: number,
  timeoutMs: number,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Record<string, unknown>> {
  const left = until - Date.now();
  if (left <= 0) throw new Refusal('down');
  let answer;
  try {
    answer = await rcHttp.request(url, {
      ...options,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', ...options.headers },
      timeoutMs: Math.min(timeoutMs, left),
      followRedirects: false,
      maxBytes: MAX_BYTES,
    });
  } catch {
    throw new Refusal('down');
  }
  if (answer.status !== 200) throw new Refusal('provider');
  let doc: unknown;
  try {
    doc = answer.json();
  } catch {
    throw new Refusal('provider');
  }
  if (!isRecord(doc)) throw new Refusal('provider');
  return doc;
}

async function discover(issuer: string, until: number): Promise<Provider> {
  if (provider?.issuer === issuer && Date.now() - provider.at < CACHE_MS) return provider;
  const doc = await fetchJson(
    `${issuer.replace(/\/$/u, '')}/.well-known/openid-configuration`,
    until,
    LOOKUP_MS,
  );
  if (doc.issuer !== issuer) throw new Refusal('provider');
  const origin = new URL(issuer).origin;
  const endpoint = (key: string): string => {
    const value = doc[key];
    let url: URL | null;
    try {
      url = typeof value === 'string' ? new URL(value) : null;
    } catch {
      url = null;
    }
    if (url === null || url.protocol !== 'https:' || url.origin !== origin) {
      throw new Refusal('provider');
    }
    return url.href;
  };
  provider = {
    issuer,
    authorize: endpoint('authorization_endpoint'),
    token: endpoint('token_endpoint'),
    userinfo: endpoint('userinfo_endpoint'),
    jwks: endpoint('jwks_uri'),
    at: Date.now(),
  };
  return provider;
}

async function signingKey(found: Provider, kid: string, until: number): Promise<KeyObject> {
  const fresh = keys?.issuer === found.issuer && Date.now() - keys.at < CACHE_MS;
  const known = fresh ? keys?.byKid.get(kid) : undefined;
  if (known !== undefined) return known;
  if (fresh && Date.now() - keysFetchedAt < KEY_REFRESH_MS) throw new Refusal('token');
  keysFetchedAt = Date.now();
  const doc = await fetchJson(found.jwks, until, LOOKUP_MS);
  const byKid = new Map<string, KeyObject>();
  for (const jwk of Array.isArray(doc.keys) ? (doc.keys as unknown[]) : []) {
    if (
      !isRecord(jwk) ||
      jwk.kty !== 'RSA' ||
      typeof jwk.kid !== 'string' ||
      typeof jwk.n !== 'string' ||
      typeof jwk.e !== 'string' ||
      (jwk.use !== undefined && jwk.use !== 'sig') ||
      (jwk.alg !== undefined && jwk.alg !== 'RS256')
    ) {
      continue;
    }
    try {
      const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048) byKid.set(jwk.kid, key);
    } catch {
      // A key that does not parse is a key nobody signed with.
    }
  }
  keys = { issuer: found.issuer, at: Date.now(), byKid };
  const key = byKid.get(kid);
  if (key === undefined) throw new Refusal('token');
  return key;
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function jsonPart(part: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new Refusal('token');
  }
  if (!isRecord(value)) throw new Refusal('token');
  return value;
}

/** The ID token's claims once its signature and every claim this client relies on hold. */
async function verifiedClaims(
  token: string,
  found: Provider,
  settings: Settings,
  nonce: string,
  until: number,
): Promise<Record<string, unknown>> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/u.test(part))) {
    throw new Refusal('token');
  }
  const [head = '', body = '', signature = ''] = parts;
  const header = jsonPart(head);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) {
    throw new Refusal('token');
  }
  const key = await signingKey(found, header.kid, until);
  const signed = Buffer.from(`${head}.${body}`);
  if (!verifySignature('RSA-SHA256', signed, key, Buffer.from(signature, 'base64url'))) {
    throw new Refusal('token');
  }
  const claims = jsonPart(body);
  const now = Date.now() / 1000;
  const audience = claims.aud;
  const forUs =
    audience === settings.clientId ||
    (Array.isArray(audience) && audience.length === 1 && audience[0] === settings.clientId);
  if (
    claims.iss !== found.issuer ||
    !forUs ||
    (claims.azp !== undefined && claims.azp !== settings.clientId) ||
    typeof claims.exp !== 'number' ||
    claims.exp + SKEW_SECONDS < now ||
    typeof claims.iat !== 'number' ||
    claims.iat > now + SKEW_SECONDS ||
    typeof claims.nonce !== 'string' ||
    !sameText(claims.nonce, nonce) ||
    typeof claims.sub !== 'string' ||
    claims.sub === ''
  ) {
    throw new Refusal('token');
  }
  return claims;
}

// --- pending sign-ins ---------------------------------------------------------------

export const PENDING_MAX = 512;
export const PENDING_MS = 600_000;

interface Pending {
  readonly browser: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly next: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly at: number;
}

const pending = new Map<string, Pending>();

function token(): string {
  return randomBytes(32).toString('base64url');
}

/** A new id for the browser cookie that ties a callback to the browser that started it. */
export function newBrowserId(): string {
  return token();
}

/** Whether `value` is an id `newBrowserId` could have made. */
export function isBrowserId(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(value);
}

/**
 * Begin a sign-in: remember it, and return the provider URL to send the browser to.
 *
 * Over the cap, the OLDEST pending sign-in goes. Refusing the newest instead would let
 * anyone who can reach the page block every sign-in for ten minutes.
 */
export async function start(settings: Settings, browser: string, next: string): Promise<string> {
  const found = await discover(settings.issuer, Date.now() + TOTAL_MS);
  const now = Date.now();
  for (const [state, entry] of pending) if (now - entry.at > PENDING_MS) pending.delete(state);
  while (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value ?? '');
  const state = token();
  const entry: Pending = {
    browser,
    nonce: token(),
    verifier: token(),
    next,
    issuer: settings.issuer,
    clientId: settings.clientId,
    redirectUri: `${settings.publicUrl}/signin`,
    at: now,
  };
  pending.set(state, entry);
  const url = new URL(found.authorize);
  for (const [name, value] of Object.entries({
    response_type: 'code',
    client_id: settings.clientId,
    redirect_uri: entry.redirectUri,
    scope: 'openid profile email',
    state,
    nonce: entry.nonce,
    code_challenge: createHash('sha256').update(entry.verifier).digest('base64url'),
    code_challenge_method: 'S256',
  })) {
    url.searchParams.set(name, value);
  }
  return url.href;
}

/** Drop this browser's pending sign-ins, at sign-out. */
export function forgetBrowser(browser: string): void {
  if (!isBrowserId(browser)) return;
  for (const [state, entry] of pending) if (entry.browser === browser) pending.delete(state);
}

/** For tests: no pending sign-in, nothing cached. */
export function resetForTests(): void {
  pending.clear();
  provider = null;
  keys = null;
  keysFetchedAt = 0;
}

function formEncoded(value: string): string {
  return encodeURIComponent(value).replaceAll('%20', '+');
}

function localPart(value: string): string {
  const at = value.lastIndexOf('@');
  return at === -1 ? value : value.slice(0, at);
}

export interface Callback {
  readonly state: string;
  readonly code: string;
  readonly error: string;
}

export interface SignedIn {
  readonly name: string;
  readonly next: string;
}

/**
 * Complete a sign-in from the provider's redirect: the account to sign in as, or a Refusal.
 *
 * The pending entry is spent first, whatever happens next, so a callback cannot be replayed.
 */
export async function finish(
  settings: Settings,
  callback: Callback,
  browser: string,
): Promise<SignedIn> {
  const entry = pending.get(callback.state);
  pending.delete(callback.state);
  if (
    entry === undefined ||
    !sameText(entry.browser, browser) ||
    Date.now() - entry.at > PENDING_MS ||
    entry.issuer !== settings.issuer ||
    entry.clientId !== settings.clientId
  ) {
    throw new Refusal('expired');
  }
  if (callback.error !== '' || callback.code === '') throw new Refusal('denied');
  const until = Date.now() + TOTAL_MS;
  const found = await discover(settings.issuer, until);
  const basic = Buffer.from(
    `${formEncoded(settings.clientId)}:${formEncoded(settings.secret)}`,
  ).toString('base64');
  const tokens = await fetchJson(found.token, until, TOKEN_MS, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: entry.redirectUri,
      code_verifier: entry.verifier,
    }).toString(),
  });
  if (
    typeof tokens.id_token !== 'string' ||
    typeof tokens.access_token !== 'string' ||
    String(tokens.token_type).toLowerCase() !== 'bearer'
  ) {
    throw new Refusal('provider');
  }
  const claims = await verifiedClaims(tokens.id_token, found, settings, entry.nonce, until);
  const info = await fetchJson(found.userinfo, until, LOOKUP_MS, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (info.sub !== claims.sub) throw new Refusal('token');
  const email = typeof info.email === 'string' ? info.email.toLowerCase() : '';
  if (info.email_verified !== true || email.split('@').length !== 2) throw new Refusal('email');
  if (!settings.emailDomains.includes(email.split('@')[1] ?? '')) throw new Refusal('domain');
  const username = typeof info.preferred_username === 'string' ? info.preferred_username : '';
  const name = await resolveAccount({
    issuer: found.issuer,
    sub: claims.sub as string,
    email,
    username,
    provision: settings.provision,
  });
  return { name, next: entry.next };
}

// --- who it is here -----------------------------------------------------------------

interface Person {
  readonly issuer: string;
  readonly sub: string;
  readonly email: string;
  readonly username: string;
  readonly provision: string;
}

/**
 * The account a verified person signs in as, linking or creating it when the rules allow.
 *
 * Under `users.lock`, so the users file and the bindings change together and two first
 * sign-ins of one person cannot both create the account. The new account's hash is derived
 * before the lock, as `users.add` does, because scrypt is slow on purpose.
 */
async function resolveAccount(person: Person): Promise<string> {
  const handle = users.normalizeName(localPart(person.username) || localPart(person.email));
  const hashed = await users.hashPassword(users.mintPassword());
  const at = new Date().toISOString();
  return await users.withUsersLock(() => {
    let doc: identities.Identities;
    try {
      doc = identities.read();
    } catch {
      throw new Refusal('store');
    }
    const accounts = users.readAll();
    const approved = (name: string): boolean => doc.approvals.some((item) => item.name === name);
    const linkAs = (binding: identities.Binding, kind: string): string => {
      doc.approvals = doc.approvals.filter((item) => item.name !== binding.name);
      identities.write(doc);
      audit(binding.name, kind, `${binding.name} ${binding.email}`, { origin: 'sso' });
      return binding.name;
    };
    const fresh = (name: string): identities.Binding => ({
      issuer: person.issuer,
      sub: person.sub,
      name,
      email: person.email,
      display: person.username,
      status: 'active',
      at,
    });

    const bound = doc.bindings.find(
      (item) => item.issuer === person.issuer && item.sub === person.sub,
    );
    if (bound !== undefined) {
      const otherActive = doc.bindings.some(
        (item) => item !== bound && item.name === bound.name && item.status === 'active',
      );
      if (bound.status !== 'active') {
        if (!approved(bound.name) || !accounts.has(bound.name) || otherActive) {
          throw new Refusal('disabled');
        }
        bound.status = 'active';
        bound.email = person.email;
        bound.display = person.username;
        bound.at = at;
        return linkAs(bound, 'sso-link');
      }
      if (!accounts.has(bound.name)) {
        // Tombstoned now, so an account made later under this name does not inherit it.
        identities.tombstone(doc, bound.name);
        identities.write(doc);
        throw new Refusal('gone');
      }
      if (bound.email !== person.email || bound.display !== person.username) {
        bound.email = person.email;
        bound.display = person.username;
        identities.write(doc);
      }
      return bound.name;
    }

    try {
      users.requireValidName(handle);
    } catch {
      throw new Refusal('name');
    }
    const sameName = doc.bindings.filter((item) => item.name === handle);
    if (sameName.some((item) => item.status === 'active')) throw new Refusal('taken');
    const tombstoned = sameName.length > 0;
    const account = accounts.get(handle);
    if (account !== undefined) {
      if (!approved(handle)) {
        if (tombstoned) throw new Refusal('disabled');
        if (users.normaliseRole(account[2]) === 'admin') throw new Refusal('admin');
      }
      const binding = fresh(handle);
      doc.bindings.push(binding);
      return linkAs(binding, 'sso-link');
    }
    if (tombstoned) throw new Refusal('disabled');
    if (person.provision !== 'member' && person.provision !== 'readonly') {
      throw new Refusal('noaccount');
    }
    if (![...accounts.values()].some(([, , role]) => users.normaliseRole(role) === 'admin')) {
      throw new Refusal('noadmin');
    }
    accounts.set(handle, [hashed, at.slice(0, 10), person.provision]);
    users.writeAll(accounts);
    audit(handle, 'user-add', `${handle} role=${person.provision}`, { origin: 'sso' });
    const binding = fresh(handle);
    doc.bindings.push(binding);
    return linkAs(binding, 'sso-provision');
  });
}

/**
 * `users link-sso <name>`: let the Okta person whose username normalises to exactly `name`
 * link to that existing account -- the only way an admin account, or a name whose link was
 * removed, is linked. It cannot link a different name.
 */
export async function approveLink(name: string): Promise<void> {
  const stored = users.normalizeName(name);
  await users.withUsersLock(() => {
    if (!users.readAll().has(stored)) {
      throw new NotFoundError(`no user ${quotedText(stored)} (see \`houston users list\`)`);
    }
    const doc = identities.read();
    const active = doc.bindings.find((item) => item.name === stored && item.status === 'active');
    if (active !== undefined) {
      throw new ConflictError(
        `${quotedText(stored)} is already linked to the Okta user ${active.email}`,
      );
    }
    doc.approvals = doc.approvals.filter((item) => item.name !== stored);
    doc.approvals.push({ name: stored, at: new Date().toISOString() });
    identities.write(doc);
  });
  auditRecord('sso-approve', stored);
}

/**
 * `users unlink-sso <name>`: the link becomes a tombstone and the account's sessions end.
 * The account and its password stay. Returns how many sessions ended.
 */
export async function unlink(name: string): Promise<number> {
  const stored = users.normalizeName(name);
  await users.withUsersLock(() => {
    const doc = identities.read();
    if (!identities.tombstone(doc, stored)) {
      throw new NotFoundError(`${quotedText(stored)} is not linked to an Okta user`);
    }
    identities.write(doc);
  });
  auditRecord('sso-unlink', stored);
  return await revokeUser(stored);
}
