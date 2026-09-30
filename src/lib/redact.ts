/**
 * Credential redaction shared by services, with no houston dependencies.
 *
 * It is a LEAF on purpose: `events.ts` deliberately imports nothing from the package and is
 * imported by thirteen modules, so redaction lives in its own dependency-free module.
 * Importing orchestration here would create a startup import cycle. Its one import is
 * `float-text`, a rank-0 leaf with no imports of its own, for its whitespace set.
 */

import { STRIP_CHARS } from './float-text';

/**
 * Key-name fragments that mean the VALUE is a credential.
 *
 * Substring matching rather than exact names, because the keys these have to catch are
 * whatever a preset author or a customer's dump happened to call them.
 */
export const SECRET_KEY_HINTS: readonly string[] = Object.freeze([
  'password',
  'pass',
  'secret',
  'token',
  '_key',
  'apikey',
  'credential',
]);

export const REDACTED = '********';

/**
 * The whitespace of `STRIP_CHARS`, as the inside of a character class.
 *
 * NOT JavaScript's `\s`, which the pattern below used to be written with: JavaScript's
 * holds the BOM and not the information separators `\x1c`-`\x1f` or NEL, and this set is
 * the reverse. Inside `[^...]` that decides where a password ENDS, so a `MONGO_URL`
 * password holding a BOM, which earlier releases masked, was printed in the clear by `env`
 * and the env panel, and one holding `\x1c` or NEL the other way round.
 * Built from `STRIP_CHARS` rather than typed, because a control character in a regex
 * literal is `no-control-regex` however it is spelled.
 */
const SPACE_CLASS = [...STRIP_CHARS]
  .map((char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`)
  .join('');

/**
 * A credential embedded in a URL: `scheme://user:password@host`.
 *
 * This must inspect VALUES rather than names, because a name such as `MONGO_URL` reveals
 * nothing about the secret inside it. Global, because every occurrence is replaced and a
 * value can hold more than one URL.
 */
export const URL_USERINFO = new RegExp(
  `([a-zA-Z][a-zA-Z0-9+.-]*://[^/${SPACE_CLASS}:@]+):([^/${SPACE_CLASS}@]+)@`,
  'gu',
);

/** Mask credentials named by their key or embedded in URL userinfo. */
export function redactEnv(key: string, value: string): string {
  const low = key.toLowerCase();
  if (value && SECRET_KEY_HINTS.some((h) => low.includes(h))) return REDACTED;
  return (value || '').replace(URL_USERINFO, `$1:${REDACTED}@`);
}
