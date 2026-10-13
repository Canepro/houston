/**
 * A fake OpenID Connect provider, for the Okta sign-in specs: the HTTP seam's answers for
 * discovery, keys, the code exchange and `/userinfo`, with an ID token signed by real RSA
 * keys, so every check `core/sso` makes runs against a token it could really meet.
 *
 * Shared by `test/core/sso.test.ts`, the session routes' spec and the browser spec; it is
 * not a spec itself.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import type { HttpResponse, RequestOptions } from '../../../src/seams/rc-http';

export const ISSUER = 'https://idp.example.test';
export const CLIENT = '0oa-test-client';
export const SECRET = 'not-a-real-secret';

/** What the seam throws for a provider that does not answer. */
export class Unreachable extends Error {}

export interface Key {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwk: Record<string, unknown>;
}

function rsaKey(kid: string, modulusLength = 2048): Key {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig' } };
}

export const KEY_A = rsaKey('key-a');
export const KEY_B = rsaKey('key-b');

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** The provider: what it answers, and what it was asked. */
export class FakeIdp {
  keys: Key[] = [KEY_A];
  signWith: Key = KEY_A;
  person = {
    sub: '00u-ana',
    preferred_username: 'ana.lopez@rocket.chat',
    email: 'ana.lopez@rocket.chat',
    email_verified: true as unknown,
  };
  header: Record<string, unknown> = {};
  claims: Record<string, unknown> = {};
  userinfo: Record<string, unknown> = {};
  discovery: Record<string, unknown> = {};
  down = false;
  /** Per code: the nonce and PKCE challenge its authorize request carried. */
  readonly started = new Map<string, { nonce: string; challenge: string }>();
  readonly calls: { url: string; options: RequestOptions }[] = [];

  /** `redirectUri` is what the token request must carry: `<sso.public_url>/signin`. */
  constructor(readonly redirectUri: string) {}

  answer(url: string, options: RequestOptions = {}): HttpResponse {
    this.calls.push({ url, options });
    if (this.down) throw new Unreachable(`could not reach ${url}`);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return reply(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth2/v1/authorize`,
        token_endpoint: `${ISSUER}/oauth2/v1/token`,
        userinfo_endpoint: `${ISSUER}/oauth2/v1/userinfo`,
        jwks_uri: `${ISSUER}/oauth2/v1/keys`,
        ...this.discovery,
      });
    }
    if (url === `${ISSUER}/oauth2/v1/keys`)
      return reply(200, { keys: this.keys.map((k) => k.jwk) });
    if (url === `${ISSUER}/oauth2/v1/token`) return this.token(options);
    if (url === `${ISSUER}/oauth2/v1/userinfo`) {
      if (options.headers?.Authorization !== 'Bearer at-123') return reply(401, {});
      return reply(200, { ...this.person, ...this.userinfo });
    }
    return reply(404, {});
  }

  private token(options: RequestOptions = {}): HttpResponse {
    const form = new URLSearchParams(String(options.body));
    const begun = this.started.get(form.get('code') ?? '');
    const basic = Buffer.from(`${CLIENT}:${SECRET}`).toString('base64');
    if (
      options.method !== 'POST' ||
      options.headers?.Authorization !== `Basic ${basic}` ||
      form.get('grant_type') !== 'authorization_code' ||
      form.get('redirect_uri') !== this.redirectUri ||
      begun === undefined ||
      createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url') !== begun.challenge
    ) {
      return reply(400, { error: 'invalid_grant' });
    }
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'RS256', kid: this.signWith.kid, ...this.header });
    const body = b64({
      iss: ISSUER,
      aud: CLIENT,
      sub: this.person.sub,
      iat: now,
      exp: now + 3600,
      nonce: begun.nonce,
      ...this.claims,
    });
    const signature = sign(
      'RSA-SHA256',
      Buffer.from(`${head}.${body}`),
      this.signWith.privateKey,
    ).toString('base64url');
    return reply(200, {
      token_type: 'Bearer',
      access_token: 'at-123',
      id_token: `${head}.${body}.${signature}`,
    });
  }
}

export function reply(status: number, doc: unknown): HttpResponse {
  const text = JSON.stringify(doc);
  return { status, ok: status < 400, text, headers: {}, url: '', json: () => JSON.parse(text) };
}
