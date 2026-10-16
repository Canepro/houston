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
 * Hints for a key that runs its words together, which only an attachable artifact checks: a
 * YAML or JSON key such as `privatekey` has no boundary to split, where `SECRET_KEY_HINTS` is
 * also the list earlier releases mask env and log output by.
 */
const JOINED_KEY_HINTS: readonly string[] = ['privatekey', 'sshkey'];

const HEADER_KEY = /^(?:(?:proxy|http)_)?(?:authorization(?:_?headers?)?|auth_?headers?)$/u;

/**
 * Words containing `pass` that are not credentials: anything ending in `bypass`
 * (`--proxybypass`, `--bypassfile`), and a few whole words (`--nopass`, `--lowpass`). Checked
 * after the digits and the named forms are removed, so any other word ending in `pass` or a
 * password spelling is a credential: `--requirepass`, `--installpassword`, `--db2pass`.
 */
const NOT_A_PASS =
  /^(?:[a-z0-9]*bypass|compass|trespass|overpass|underpass|surpass|lowpass|highpass|bandpass|allpass|nopass|skippass|mispass)$/u;

/**
 * One word of an option name that names a credential:
 * - a word ending in `pass`, `password`, `passwd` or `passphrase`, digits allowed anywhere
 *   before it and after it, with the named forms `in`, `out`, `code`, `file`, `key`
 *   (`-passin`, `--passcode`), unless its ending is NOT_A_PASS.
 * - a credential stem, alone or ending a joined name (`--accesstoken`, `--rootpassword`).
 * - a credential stem followed by `key`, `accesskey`, `file`, `value`, `data`, `string` or
 *   `text`: `--secretkey`, `--secretaccesskey`, `--apikeyvalue`, `--sshkeydata`.
 */
const PASS_WORD = /^[a-z0-9]*pass\d*(?:w[o0]rd|wd|phrase)?\d*(?:in|out|code|file|key)?\d*$/u;
const STEM =
  'password|passwd|passphrase|secret|token|apikey|credential|privatekey|sshkey|accesskey';
const STEM_WORD = new RegExp(
  `(?:${STEM})s?\\d*$|^(?:${STEM})(?:key|accesskey|file|value|data|string|text)s?\\d*$`,
  'u',
);

function credentialWord(word: string): boolean {
  if (PASS_WORD.test(word)) {
    const core = word
      .replace(/\d+$/u, '')
      .replace(/(?:in|out|code|file|key)$/u, '')
      .replace(/\d+$/u, '')
      .replace(/\d*(?:w[o0]rd|wd|phrase)$/u, '')
      .replace(/\d+$/u, '');
    return !NOT_A_PASS.test(core);
  }
  return STEM_WORD.test(word);
}

/**
 * Whether a key names a credential, for an artifact a person attaches. The hints are written in
 * environment spelling (`_key`, `rocketchat_license`), and an artifact also holds keys spelled
 * `privateKey`, `private-key` or `SSHKey`, so each word boundary also becomes `_` before
 * matching, an acronym's end included. The key as written is matched too, so a split cannot
 * hide a hint it already held. `keycloakUrl` and `monkeyPatch` hold no word `key`.
 */
export function credentialKey(key: string): boolean {
  const words = keyWords(key);
  const lowered = key.toLowerCase();
  // Header names are credentials; nearby policy/count fields are not. Match complete
  // normalized names so authorizationEnabled and authHeaderCount remain readable.
  return (
    HEADER_KEY.test(words) ||
    [...SECRET_KEY_HINTS, ...JOINED_KEY_HINTS].some(
      (hint) => lowered.includes(hint) || words.includes(hint),
    )
  );
}

/** A key's words lower-cased and joined by `_`, at each case change and non-alphanumeric. */
function keyWords(key: string): string {
  return key
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1_$2')
    .replace(/(\p{Ll}|\p{Nd})(\p{Lu})/gu, '$1_$2')
    .replace(/[^\p{L}\p{Nd}]/gu, '_')
    .toLowerCase();
}

/**
 * Keys whose list value is an argument sequence: a Compose or Kubernetes `command`,
 * `entrypoint` or `args`. In such a list a credential flag and the argument after it are
 * separate items, so neither item names its own credential. A healthcheck `test` is one too, but
 * only under its parent: see `argumentListKey`.
 */
export const ARGUMENT_LIST_KEYS: readonly string[] = Object.freeze([
  'command',
  'entrypoint',
  'args',
]);

/** Whether `key` names a healthcheck: `healthcheck`, or an extension field such as `x-healthcheck`. */
export function healthcheckKey(key: string): boolean {
  return /health[-_]?check/iu.test(key);
}

/**
 * Whether `key`, inside an object held under `parent`, is an argument list. `test` is one only
 * in a healthcheck; anywhere else it is arbitrary data, such as a chart value, and masking it
 * would erase whatever it holds from the whole bundle.
 */
export function argumentListKey(key: string, parent = ''): boolean {
  return ARGUMENT_LIST_KEYS.includes(key) || (key === 'test' && healthcheckKey(parent));
}

/**
 * Whether an argument item is a flag whose NEXT item is its credential value: `--password` or
 * `--reg-token`. `--flag=value` carries its own value and is read as an assignment instead;
 * `--port` and a plain argument are not flags of this kind. The flag's own words decide:
 * `--proxy-bypass-list` holds the letters `pass` and no credential word.
 */
export function credentialFlag(item: string): boolean {
  const flag = /^--?([A-Za-z][^=\s]*)$/u.exec(item)?.[1];
  if (flag === undefined) return false;
  const words = keyWords(flag);
  return (
    HEADER_KEY.test(words) ||
    /(?:^|_)rocketchat_license(?:_|$)/u.test(words) ||
    words
      .split('_')
      .some((word, index) => credentialWord(word) || (index > 0 && /^keys?$/u.test(word)))
  );
}

/**
 * Whether the text before an `=` names a credential: a key (`DB_PASSWORD`), or the last word of
 * a command line, which is a flag when it starts with `-` and is judged as one.
 */
function assignsCredential(before: string): boolean {
  const last = before.split(/\s+/u).pop() ?? '';
  return last.startsWith('-') ? credentialFlag(last) : credentialKey(before);
}

/** Whether a flag hands its credential to the NEXT argument, rather than switching a mode. */
export function valueTakingCredentialFlag(flag: string): boolean {
  return credentialFlag(flag) && !/-(?:stdin|file|fd|env|prompt|cmd|command)$/u.test(flag);
}

/** Whether one argument word is, or assigns, a credential flag: `--password`, `--password=x`. */
export function credentialFlagWord(word: string): boolean {
  const equals = word.indexOf('=');
  return credentialFlag(equals > 0 ? word.slice(0, equals) : word);
}

/**
 * Whether a command string names a credential flag anywhere: in any quoted, nested, or
 * backtick-substituted part, in `--flag=value` form, or as `-p` beside a user flag. Splitting at
 * every quote and shell operator only finds flags; it is not how the command parses.
 */
export function commandCarriesCredential(text: string): boolean {
  const words = text.split(/[\s'"`;&|()<>\\]+/u).filter((word) => word !== '');
  if (words.some(credentialFlagWord)) return true;
  return (
    (words.includes('-p') && words.some(userArgument)) ||
    httpUserPassword(words) ||
    authorizationHeaders(words).length > 0
  );
}

/** `curl -u user:pass`, `--proxy-user` and wget's `--user=user:pass` carry a password. */
export function httpUserPassword(words: readonly string[]): boolean {
  return httpUsers(words).length > 0;
}

/** A header flag whose value, or `--header=value`, is one request header. */
const HEADER_FLAG = /^(?:-H|--header|--proxy-header)$/u;
const HEADER_ATTACHED = /^(?:--header=|--proxy-header=|-H)(.*)$/su;
const AUTHORIZATION_HEADER = /^\s*(?:proxy-)?authorization\s*:\s*(.*)$/isu;

/**
 * The values of the `Authorization:` and `Proxy-Authorization:` headers that `words` hand to a
 * header flag (`-H`, `--header`, `--proxy-header`, attached or not), empty when the header has
 * none. Other headers are not credentials.
 */
export function authorizationHeaders(words: readonly string[]): string[] {
  const values: string[] = [];
  words.forEach((word, index) => {
    const header = HEADER_FLAG.test(word) ? words[index + 1] : HEADER_ATTACHED.exec(word)?.[1];
    const value = AUTHORIZATION_HEADER.exec(header ?? '')?.[1];
    if (value !== undefined) values.push(value.trim());
  });
  return values;
}

/** Schemes that name how a credential is sent and are not the credential. */
const AUTHORIZATION_SCHEME = /^(?:bearer|basic|digest|negotiate|ntlm|token)$/iu;

/**
 * The strings that give away an `Authorization:` header value, for copies elsewhere: the value
 * and the credential after its scheme (`Bearer abc` holds `abc`). A bare scheme and a shell
 * variable (`$TOKEN`) hold no secret, and registering either would mask it everywhere.
 */
export function authorizationCredentials(value: string): string[] {
  const scheme = /^(\S+)[ \t]+(\S.*)$/su.exec(value);
  const credential = scheme?.[2] ?? value;
  if (credential === '' || credential.startsWith('$')) return [];
  if (scheme === null && AUTHORIZATION_SCHEME.test(value)) return [];
  return scheme === null ? [value] : [value, credential];
}

/** The start of a word that holds its own user value: `--user=`, `--proxy-user=`, `-u`, `-U`. */
export const HTTP_USER_PREFIX = /^(?:--(?:proxy-)?user=|-[uU])/u;

/** A `user:password` value of a curl or wget command, and the word that holds it. */
export interface HttpUser {
  readonly value: string;
  readonly password: string;
  /** Index of the word holding the value; `attached` when it follows `-u` or `--user=` there. */
  readonly index: number;
  readonly attached: boolean;
}

/**
 * The `user:password` values after a curl or wget in `words`: `-u v`, `--user v`, `--user=v`,
 * `-uv`, and curl's `-U`, `--proxy-user` in the same four spellings (`-U` is wget's
 * `--user-agent`, so it counts for curl only). A long option is never read as an attached `-u`:
 * an attached short option is a single dash and one letter. Only words after the program count,
 * so `docker run -u root:root curlimage/curl` names a user and group, not a password. A value
 * without a colon has no password in it.
 */
export function httpUsers(words: readonly string[]): HttpUser[] {
  const program = words.findIndex((word) => /(?:^|\/)(?:curl|wget)$/u.test(word));
  if (program < 0) return [];
  const curl = /curl$/u.test(words[program] ?? '');
  const separateFlag = curl ? /^(?:-[uU]|--user|--proxy-user)$/u : /^(?:-u|--user|--proxy-user)$/u;
  const attachedFlag = curl
    ? /^(?:--(?:proxy-)?user=|-[uU](?!-))(.*)$/su
    : /^(?:--(?:proxy-)?user=|-u(?!-))(.*)$/su;
  const users: HttpUser[] = [];
  for (let index = program + 1; index < words.length; index += 1) {
    const word = words[index] ?? '';
    const separate = separateFlag.test(word);
    const attached = separate ? undefined : attachedFlag.exec(word)?.[1];
    const next = words[index + 1] ?? '';
    const value = separate ? next : attached;
    const colon = value?.indexOf(':') ?? -1;
    if (value === undefined || colon < 0) continue;
    users.push({
      value,
      password: value.slice(colon + 1),
      index: separate ? index + 1 : index,
      attached: !separate,
    });
  }
  return users;
}

/** Whether one argument names a user: `-u x`, `-ux`, `--user[=x]`, `--username[=x]`. */
export function userArgument(word: string): boolean {
  return /^(?:-u.*|--user(?:name)?(?:=.*)?)$/u.test(word);
}

/**
 * `8080`, `8080:80`, `8000-8010:80/udp`, `127.0.0.1:8080:80`, `[::1]:8080:80`, `0.0.0.0::80`:
 * every part a port number or range, after an optional bind address and before an optional
 * protocol, which `-p` publishes rather than hides.
 */
export function portSpelling(value: string): boolean {
  const bound = value.replace(/^(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|\[[0-9A-Fa-f:.]+\]):/u, '');
  const parts = bound.replace(/\/(?:tcp|udp|sctp)$/u, '').split(':');
  const maximum = bound === value ? 3 : 2;
  return (
    parts.length <= maximum &&
    parts.every((part, index) =>
      part === ''
        ? bound !== value && index === 0 && parts.length === 2
        : /^[0-9]{1,5}(?:-[0-9]{1,5})?$/u.test(part) &&
          part.split('-').every((port) => Number(port) <= 65535),
    )
  );
}

/**
 * Whether `flag` takes `value` as a credential: a long credential flag (`--password`), or `-p`
 * in a command that also names a user, as `mongosh -u x -p` and `mysql -p -u x` write it.
 * Elsewhere `-p` is a port or `mkdir -p`, and masking those would erase evidence.
 */
export function credentialArgument(flag: string, value: string, userGiven: boolean): boolean {
  // A value may start with `-`; only a bare long option is the next argument instead.
  if (valueTakingCredentialFlag(flag)) return value !== '' && !/^--[A-Za-z][\w-]*$/u.test(value);
  // A following option or a port is the next argument, not a password `-p` was asked for.
  return (
    flag === '-p' && userGiven && value !== '' && !value.startsWith('-') && !portSpelling(value)
  );
}

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

/** One JSON string token; the text is already known to be valid JSON. */
const JSON_STRING = /"(?:[^"\\]|\\.)*"/y;
const JSON_SPACE = /[ \t\n\r]*/y;
/** A number, `true`, `false` or `null`: everything else a JSON value can start with. */
const JSON_LITERAL = /[^,\]}\s]+/y;

function jsonToken(pattern: RegExp, text: string, at: number): string {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0] ?? '';
}

/** Where each object and array of a valid JSON text ends, by where it opens; one pass. */
function jsonEnds(text: string): Map<number, number> {
  const ends = new Map<number, number>();
  const open: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') i += jsonToken(JSON_STRING, text, i).length - 1;
    else if (char === '{' || char === '[') open.push(i);
    else if (char === '}' || char === ']') ends.set(open.pop() ?? 0, i + 1);
  }
  return ends;
}

/** The index after the JSON value at `at`. */
function jsonValueEnd(text: string, at: number, ends: ReadonlyMap<number, number>): number {
  const open = text[at];
  if (open === '{' || open === '[') return ends.get(at) ?? text.length;
  return at + jsonToken(open === '"' ? JSON_STRING : JSON_LITERAL, text, at).length;
}

/**
 * Whether the object at `at` has a `name` member naming a credential, in any member position.
 * `JSON.parse` keeps only the last duplicate `name`, but the retained bytes hold every member and
 * a reader may take the first, so ANY credential name counts, as for duplicate YAML names. Every
 * `value` member of the object is then the credential, as the same object in YAML is
 * (`{name: DB_PASSWORD, value: ...}`).
 */
function namesCredential(text: string, at: number, ends: ReadonlyMap<number, number>): boolean {
  let named = false;
  let i = at + 1;
  for (;;) {
    i += jsonToken(JSON_SPACE, text, i).length;
    if (text[i] === '}' || i >= text.length) return named;
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    const key = jsonToken(JSON_STRING, text, i);
    i += key.length;
    i += jsonToken(JSON_SPACE, text, i).length + 1;
    i += jsonToken(JSON_SPACE, text, i).length;
    const end = jsonValueEnd(text, i, ends);
    if ((JSON.parse(key) as string) === 'name') {
      const value = text.slice(i, end);
      named ||= credentialKey(value.startsWith('"') ? (JSON.parse(value) as string) : value);
    }
    i = end;
  }
}

/** Numeric credentials and URL login names match whole scalars; `7` must not erase `27017`. */
export type KnownSecret = string | { readonly value: string; readonly whole: true };

/** Replace known values after decoding a scalar, never across JSON syntax. */
export function redactKnownValues(value: string, secrets: readonly KnownSecret[]): string {
  if (secrets.some((item) => typeof item !== 'string' && item.value === value)) return REDACTED;
  return [
    ...new Set(secrets.filter((item): item is string => typeof item === 'string' && item !== '')),
  ]
    .sort((left, right) => right.length - left.length)
    .reduce((masked, item) => masked.replaceAll(item, REDACTED), value);
}

/**
 * Discover credentials before rendering so aliases and earlier copies cannot escape. JSON
 * tokens are walked in source order, including duplicate members and original scalar spellings.
 * The caller bounds object traversal; the depth limit also bounds nested JSON strings.
 */
export function discoverTextSecrets(
  text: string,
  add: (value: string, whole?: boolean) => void,
  depth = 0,
): void {
  if (depth > 100) throw new RangeError('artifact credential nesting exceeds limit');
  let valid = false;
  try {
    JSON.parse(text);
    valid = true;
  } catch {
    // Ordinary text, a URL or an assignment.
  }
  if (valid) {
    const ends = jsonEnds(text);
    /** The decoded strings of the array at `at`, and `''` for any other item. */
    const itemsOf = (at: number): string[] => {
      const items: string[] = [];
      let i = at + 1;
      for (;;) {
        i += jsonToken(JSON_SPACE, text, i).length;
        if (text[i] === ']' || i >= text.length) return items;
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        const end = jsonValueEnd(text, i, ends);
        items.push(text[i] === '"' ? (JSON.parse(text.slice(i, end)) as string) : '');
        i = end;
      }
    };
    /** An argument as its flag logic reads it: a string's text, a number's spelling, else `''`. */
    const argumentText = (at: number): string => {
      if (text[at] === '"') return JSON.parse(jsonToken(JSON_STRING, text, at)) as string;
      return text[at] === '{' || text[at] === '[' ? '' : jsonToken(JSON_LITERAL, text, at);
    };
    const walk = (
      at: number,
      secret: boolean,
      level: number,
      argv = false,
      parent = '',
    ): number => {
      if (level > 100) throw new RangeError('artifact credential nesting exceeds limit');
      const open = text[at];
      if (open === '"') {
        const token = jsonToken(JSON_STRING, text, at);
        const decoded = JSON.parse(token) as string;
        if (secret) add(decoded);
        // A command string with a credential flag is attached whole: its spelling as decoded
        // text and as the JSON-escaped text the artifact holds.
        if (argv && /\s/u.test(decoded) && commandCarriesCredential(decoded)) {
          add(decoded);
          add(token.slice(1, -1));
        }
        discoverTextSecrets(decoded, add, level + 1);
        return at + token.length;
      }
      if (open !== '{' && open !== '[') {
        const token = jsonToken(JSON_LITERAL, text, at);
        if (secret) {
          add(token, true);
          add(String(JSON.parse(token)), true);
        }
        return at + token.length;
      }
      const named = open === '{' && namesCredential(text, at, ends);
      // In an argument array, the item after a credential flag is its value.
      const items = argv && open === '[' ? itemsOf(at) : [];
      const userGiven = items.some(userArgument);
      for (const user of httpUsers(items)) {
        add(user.value);
        add(user.password);
      }
      for (const header of authorizationHeaders(items)) {
        for (const credential of authorizationCredentials(header)) add(credential);
      }
      let flag = '';
      let i = at + 1;
      for (;;) {
        i += jsonToken(JSON_SPACE, text, i).length;
        if (text[i] === '}' || text[i] === ']') return i + 1;
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        let member = secret;
        let list = false;
        let key = '';
        if (open === '{') {
          const token = jsonToken(JSON_STRING, text, i);
          key = JSON.parse(token) as string;
          discoverTextSecrets(key, add, level + 1);
          member ||= credentialKey(key) || (key === 'value' && named);
          list = argumentListKey(key, parent);
          i += token.length;
          i += jsonToken(JSON_SPACE, text, i).length + 1;
          i += jsonToken(JSON_SPACE, text, i).length;
        }
        const item = argumentText(i);
        const isString = text[i] === '"';
        if (flag !== '') member ||= credentialArgument(flag, item, userGiven);
        // The items of an argument array are argument strings too: `["sh", "-c", "..."]`.
        i = walk(i, member, level + 1, open === '[' ? argv : list, key);
        flag = argv && open === '[' && isString ? item : '';
      }
    };
    walk(jsonToken(JSON_SPACE, text, 0).length, false, depth);
    return;
  }
  // Inspect a complete assignment's RHS before URL matching, so a JSON string ends its URL.
  const equals = text.indexOf('=');
  if (equals > 0 && !text.slice(0, equals).includes('://')) {
    const value = text.slice(equals + 1);
    // `--password-file=/run/secrets/x` names where a secret is, not the secret.
    const lastWord = text.slice(0, equals).split(/\s+/u).pop() ?? '';
    const modeSwitch = credentialFlag(lastWord) && !valueTakingCredentialFlag(lastWord);
    if (assignsCredential(text.slice(0, equals)) && !modeSwitch) add(value);
    discoverTextSecrets(value, add, depth + 1);
    return;
  }
  const urls = new RegExp(URL_ANY_USERINFO.source, 'gu');
  for (const match of text.matchAll(urls)) {
    const info = match[0].slice((match[1] ?? '').length, -1);
    add(info);
    const colon = info.indexOf(':');
    if (colon >= 0) {
      add(info.slice(0, colon), true);
      add(info.slice(colon + 1));
    }
  }
}

/**
 * A string an artifact holds, with every URL's user info masked and, in `KEY=VALUE`, the
 * value of a credential key: the list-form environment entry `DB_PASSWORD=...`, a JSON string
 * included.
 */
export function redactAssignedText(
  value: string,
  knownSecrets: readonly KnownSecret[] = [],
): string {
  if (knownSecrets.some((item) => (typeof item === 'string' ? item : item.value) === value))
    return REDACTED;
  // A complete JSON value is masked member by member; its first `=` is inside a string.
  const json = redactJson(value, knownSecrets);
  if (json !== null) return json;
  const urlRedacted = redactAllUserinfo(value, knownSecrets);
  // A URL password or query can contain `=`, so the user info goes first.
  const equals = urlRedacted.indexOf('=');
  if (equals > 0 && assignsCredential(urlRedacted.slice(0, equals))) {
    return `${urlRedacted.slice(0, equals + 1)}${REDACTED}`;
  }
  return redactKnownValues(urlRedacted, knownSecrets);
}

/**
 * The JSON value at `at`, masked, and the index after it. A string is masked on its own, so a
 * URL ends with its string and a match cannot run on into the next string's `@`, and a
 * `KEY=VALUE` string is masked as the same list entry in YAML is. A member a credential key
 * names is masked whole, each scalar below it included, and so is the `value` beside a `name`
 * that names a credential, as in YAML. Everything else keeps its bytes, number spellings and
 * member order included.
 */
function maskJsonValue(
  text: string,
  at: number,
  secret: boolean,
  ends: ReadonlyMap<number, number>,
  knownSecrets: readonly KnownSecret[],
): [string, number] {
  const open = text[at];
  if (open === '"') {
    const token = jsonToken(JSON_STRING, text, at);
    if (secret) return [JSON.stringify(REDACTED), at + token.length];
    const decoded = JSON.parse(token) as string;
    const masked = redactAssignedText(decoded, knownSecrets);
    return [masked === decoded ? token : JSON.stringify(masked), at + token.length];
  }
  if (open !== '{' && open !== '[') {
    const token = jsonToken(JSON_LITERAL, text, at);
    return [
      secret ||
      redactKnownValues(token, knownSecrets) !== token ||
      redactKnownValues(String(JSON.parse(token)), knownSecrets) !== String(JSON.parse(token))
        ? JSON.stringify(REDACTED)
        : token,
      at + token.length,
    ];
  }
  const close = open === '{' ? '}' : ']';
  const namedSecret = open === '{' && !secret && namesCredential(text, at, ends);
  let out = open;
  let i = at + 1;
  for (;;) {
    const space = jsonToken(JSON_SPACE, text, i);
    out += space;
    i += space.length;
    if (text[i] === close) return [out + close, i + 1];
    if (text[i] === ',') {
      out += ',';
      i += 1;
      continue;
    }
    let member = secret;
    if (open === '{') {
      const [key, afterKey] = maskJsonValue(text, i, false, ends, knownSecrets);
      const name = JSON.parse(text.slice(i, afterKey)) as string;
      member ||=
        key !== text.slice(i, afterKey) || credentialKey(name) || (name === 'value' && namedSecret);
      const colon = jsonToken(JSON_SPACE, text, afterKey);
      const valueAt = afterKey + colon.length + 1;
      const beforeValue = jsonToken(JSON_SPACE, text, valueAt);
      out += `${key}${colon}:${beforeValue}`;
      i = valueAt + beforeValue.length;
    }
    const [value, after] = maskJsonValue(text, i, member, ends, knownSecrets);
    out += value;
    i = after;
  }
}

/** `text` masked by `maskJsonValue` when it is one complete JSON value; null when it is not. */
function redactJson(text: string, knownSecrets: readonly KnownSecret[]): string | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  const leading = jsonToken(JSON_SPACE, text, 0);
  try {
    const [value, after] = maskJsonValue(text, leading.length, false, jsonEnds(text), knownSecrets);
    return `${leading}${value}${text.slice(after)}`;
  } catch (error) {
    // Nesting deeper than the stack: JSON.parse reads it, and walking it cannot. Withhold it.
    if (error instanceof RangeError) return REDACTED;
    throw error;
  }
}

/**
 * Mask every URL's user info, user name included, for an artifact a person attaches.
 *
 * A JSON value, or `KEY=` followed by one, is masked string by string, a string holding JSON
 * included, and its credentials are masked too: credential members, the `value` beside a
 * credential `name`, and credential `KEY=VALUE` strings. Anything else is masked whole, which
 * can mask more than the user info, never less.
 */
export function redactAllUserinfo(
  value: string,
  knownSecrets: readonly KnownSecret[] = [],
): string {
  const json = redactJson(value, knownSecrets);
  if (json !== null) return json;
  const equals = value.indexOf('=');
  // Not when the key holds a URL: `https://u:p=["x"]@h` is one URL whose password has a `=`.
  if (equals > 0 && !value.slice(0, equals).includes('://')) {
    const assigned = redactJson(value.slice(equals + 1), knownSecrets);
    if (assigned !== null) return `${value.slice(0, equals + 1)}${assigned}`;
  }
  return redactKnownValues(value.replace(URL_ANY_USERINFO, `$1${REDACTED}@`), knownSecrets);
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
