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
  // Not in earlier releases, which printed a licence wherever they printed env.
  'rocketchat_license',
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
 * A credential embedded in a URL authority: `scheme://user:password@host`.
 *
 * This must inspect VALUES rather than names, because a name such as `MONGO_URL` reveals
 * nothing about the secret inside it. The username can be empty and raw `@` bytes remain in
 * userinfo until the final authority delimiter, so the password capture extends to that
 * delimiter rather than stopping at the first `@`. Global, because every occurrence is
 * replaced and a value can hold more than one URL.
 */
export const URL_USERINFO = new RegExp(
  `([a-zA-Z][a-zA-Z0-9+.-]*://[^/${SPACE_CLASS}:?#]*):([^/${SPACE_CLASS}/?#]+)@`,
  'gu',
);

/**
 * The whole user info of a URL authority, user name included: `scheme://<userinfo>@`.
 * `URL_USERINFO` keeps the user name readable and needs a password, which is what earlier
 * releases print in logs and argv. An attachable artifact cannot assume the user name is not
 * itself the credential (`https://TOKEN@host`, `https://TOKEN:x-oauth-basic@host`), so the
 * evidence bundle masks all of it.
 *
 * The user info runs to the last `@` before whitespace or the authority's end, and may hold
 * any other character. `{`, `|`, `"` and the rest are not valid raw in user info, but a URL
 * parser accepts them and percent-encodes them, so a working `MONGO_URL` can carry one in its
 * password. Excluding them left that password in the clear. The cost is that one match can
 * run across a `"` or `,` into a later `@`; `redactAllUserinfo` keeps that inside one JSON
 * string.
 */
const URL_ANY_USERINFO = new RegExp(`([a-zA-Z][a-zA-Z0-9+.-]*://)[^/${SPACE_CLASS}?#]+@`, 'gu');

/**
 * Each string of a complete JSON text masked on its own, the rest kept byte for byte; null when
 * `text` is not JSON. A URL ends with its string, so a match must not run on into the next
 * string's `@`, which made `{"url":"https://idp","admin":"ops@example.com"}` lose its email.
 */
function redactJsonStrings(text: string): string | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  // In valid JSON every `"` outside a string opens one, so this finds exactly its strings.
  return text.replace(/"(?:[^"\\]|\\.)*"/gu, (token) => {
    const decoded = JSON.parse(token) as string;
    const masked = redactAllUserinfo(decoded);
    return masked === decoded ? token : JSON.stringify(masked);
  });
}

/**
 * Mask every URL's user info, user name included, for an artifact a person attaches.
 *
 * A JSON value, or `KEY=` followed by one, is masked string by string, a string holding JSON
 * included. Anything else is masked whole, which can mask more than the user info, never less.
 */
export function redactAllUserinfo(value: string): string {
  const json = redactJsonStrings(value);
  if (json !== null) return json;
  const equals = value.indexOf('=');
  // Not when the key holds a URL: `https://u:p=["x"]@h` is one URL whose password has a `=`.
  if (equals > 0 && !value.slice(0, equals).includes('://')) {
    const assigned = redactJsonStrings(value.slice(equals + 1));
    if (assigned !== null) return `${value.slice(0, equals + 1)}${assigned}`;
  }
  return value.replace(URL_ANY_USERINFO, `$1${REDACTED}@`);
}

/** Mask credentials named by their key or embedded in URL userinfo. */
export function redactEnv(key: string, value: string): string {
  const low = key.toLowerCase();
  if (value && SECRET_KEY_HINTS.some((h) => low.includes(h))) return REDACTED;
  return (value || '').replace(URL_USERINFO, `$1:${REDACTED}@`);
}

/** Flags whose whole value is a credential. */
const SECRET_FLAGS: readonly string[] = ['--reg-token'];
/** Flags whose value is `KEY=VALUE`, masked by `redactEnv`'s rule for that key. */
const PAIR_FLAGS: readonly string[] = ['--env', '-e', '--setting', '--set'];

function redactFlagValue(flag: string, value: string): string {
  if (SECRET_FLAGS.includes(flag)) return value ? REDACTED : value;
  if (!PAIR_FLAGS.includes(flag)) return value.replace(URL_USERINFO, `$1:${REDACTED}@`);
  const eq = value.indexOf('=');
  if (eq < 0) return value.replace(URL_USERINFO, `$1:${REDACTED}@`);
  return `${value.slice(0, eq + 1)}${redactEnv(value.slice(0, eq), value.slice(eq + 1))}`;
}

/**
 * A command line with its credentials masked, for the event log: `ps` is not the only
 * reader of an argv, and the log outlives the process. Every spelling the parser accepts:
 * `--flag value`, `--flag=value` and `-eKEY=VALUE`.
 */
export function redactArgv(argv: readonly string[]): string[] {
  return argv.map((token, i) => {
    const previous = argv[i - 1] ?? '';
    if (SECRET_FLAGS.includes(previous) || PAIR_FLAGS.includes(previous))
      return redactFlagValue(previous, token);
    const eq = token.indexOf('=');
    if (token.startsWith('--') && eq > 0)
      return `${token.slice(0, eq + 1)}${redactFlagValue(token.slice(0, eq), token.slice(eq + 1))}`;
    if (token.startsWith('-e') && token.length > 2)
      return `-e${redactFlagValue('-e', token.slice(2))}`;
    return token.replace(URL_USERINFO, `$1:${REDACTED}@`);
  });
}
