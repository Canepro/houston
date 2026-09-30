/**
 * A JSON reader, and specifically the error it gives when a document fails -- and a JSON
 * writer, the one every state file goes through, in the spelling earlier releases wrote.
 *
 * `JSON.parse` is the right parser for a document that parses; this module exists for the
 * one that does not. A customer support dump is exactly the file that arrives wrong --
 * truncated by a download, an HTML error page from an expired share link, or the whole
 * bundle instead of the settings file inside it -- and `configimport` reports where it went
 * wrong by line and column. The two engines disagree completely about the words:
 *
 *   established : line 1, column 1: Expecting value
 *   V8          : Unexpected token '<', "<html>x" is not valid JSON
 *
 * so the same bad file would produce a different sentence from the established one. The
 * happy path still goes through `JSON.parse`; this scanner runs only after it has already
 * thrown, and its whole job is to find the FIRST fault and name it in the established words.
 *
 * It does not build values. `JSON.parse` does that, and a second value builder would be a
 * second set of rules about numbers and escapes.
 *
 * The writer is here for the opposite reason: `JSON.stringify` is NOT the established
 * writer, and the difference lands in files (see `dumps`).
 */
import { type Spellings, shownSpelled } from './format';
import { JsonFloat, floatString } from './float-text';

/** A decoder failure: one of a closed set of messages, with its line, column and char. */
export class JsonSyntaxError extends Error {
  constructor(
    readonly msg: string,
    readonly doc: string,
    readonly pos: number,
  ) {
    const lineno = countNewlines(doc, pos) + 1;
    const colno = pos - doc.lastIndexOf('\n', pos - 1);
    super(`${msg}: line ${String(lineno)} column ${String(colno)} (char ${String(pos)})`);
    this.name = 'JsonSyntaxError';
    this.lineno = lineno;
    this.colno = colno;
  }

  readonly lineno: number;
  readonly colno: number;
}

function countNewlines(doc: string, end: number): number {
  let n = 0;
  for (let i = 0; i < end && i < doc.length; i += 1) if (doc[i] === '\n') n += 1;
  return n;
}

/** JSON's insignificant whitespace: space, tab, LF, CR. */
const WS = new Set([' ', '\t', '\n', '\r']);

/**
 * The index after the whitespace that starts at `i`.
 *
 * Clamped to the document's length when `i` is past the end -- and the clamp is
 * load-bearing: `[` walks one past the bracket and must come back to report "Expecting
 * value" at index 1, not at index 2.
 */
function skipWs(s: string, i: number): number {
  let j = Math.min(i, s.length);
  while (j < s.length && WS.has(s[j] as string)) j += 1;
  return j;
}

/** The character at `i` -- the empty string past the end, never undefined. */
function at(s: string, i: number): string {
  return i >= 0 && i < s.length ? (s[i] as string) : '';
}

/** The JSON number grammar, anchored at `idx`. Returns the end index, or -1 for no match. */
function scanNumber(s: string, idx: number): number {
  const re = /(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/y;
  re.lastIndex = idx;
  const m = re.exec(s);
  return m === null ? -1 : re.lastIndex;
}

const BACKSLASH = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

/** A string, scanned from just after the opening quote. Returns the index after the close. */
function scanString(s: string, end: number): number {
  const begin = end - 1;
  let i = end;
  for (;;) {
    // The next terminator of any kind: a quote, a backslash or a control character.
    let terminatorAt = -1;
    for (let j = i; j < s.length; j += 1) {
      const ch = s.charCodeAt(j);
      if (ch === 0x22 || ch === 0x5c || ch < 0x20) {
        terminatorAt = j;
        break;
      }
    }
    if (terminatorAt < 0) throw new JsonSyntaxError('Unterminated string starting at', s, begin);
    const terminator = s[terminatorAt] as string;
    i = terminatorAt + 1;
    if (terminator === '"') return i;
    if (terminator !== '\\') {
      throw new JsonSyntaxError('Invalid control character at', s, terminatorAt);
    }
    if (i >= s.length) throw new JsonSyntaxError('Unterminated string starting at', s, begin);
    const esc = s[i] as string;
    if (esc !== 'u') {
      if (!BACKSLASH.has(esc)) throw new JsonSyntaxError('Invalid \\escape', s, terminatorAt);
      i += 1;
      continue;
    }
    const hex = s.slice(i + 1, i + 5);
    if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/u.test(hex)) {
      throw new JsonSyntaxError('Invalid \\uXXXX escape', s, i);
    }
    i += 5;
  }
}

/** An array, scanned from just after the `[`. Returns the index after the `]`. */
function scanArray(s: string, end: number, tokens?: [number, string][]): number {
  let i = end;
  let nextchar = at(s, i);
  if (nextchar === '' || WS.has(nextchar)) {
    i = skipWs(s, i + 1);
    nextchar = at(s, i);
  }
  if (nextchar === ']') return i + 1;
  for (;;) {
    i = scanOnce(s, i, tokens);
    nextchar = at(s, i);
    if (nextchar === '' || WS.has(nextchar)) {
      i = skipWs(s, i + 1);
      nextchar = at(s, i);
    }
    i += 1;
    if (nextchar === ']') break;
    if (nextchar !== ',') throw new JsonSyntaxError("Expecting ',' delimiter", s, i - 1);
    if (i < s.length && WS.has(s[i] as string)) {
      i += 1;
      if (i < s.length && WS.has(s[i] as string)) i = skipWs(s, i + 1);
    }
  }
  return i;
}

/** An object, scanned from just after the `{`. Returns the index after the `}`. */
function scanObject(s: string, end: number, tokens?: [number, string][]): number {
  let i = end;
  let nextchar = at(s, i);
  if (nextchar !== '"') {
    if (nextchar === '' || WS.has(nextchar)) {
      i = skipWs(s, i);
      nextchar = at(s, i);
    }
    if (nextchar === '}') return i + 1;
    if (nextchar !== '"') {
      throw new JsonSyntaxError('Expecting property name enclosed in double quotes', s, i);
    }
  }
  i += 1;
  for (;;) {
    i = scanString(s, i);
    if (at(s, i) !== ':') {
      i = skipWs(s, i);
      if (at(s, i) !== ':') throw new JsonSyntaxError("Expecting ':' delimiter", s, i);
    }
    i += 1;
    if (i < s.length && WS.has(s[i] as string)) {
      i += 1;
      if (i < s.length && WS.has(s[i] as string)) i = skipWs(s, i + 1);
    }
    i = scanOnce(s, i, tokens);
    nextchar = at(s, i);
    if (nextchar !== '' && WS.has(nextchar)) {
      i = skipWs(s, i + 1);
      nextchar = at(s, i);
    }
    i += 1;
    if (nextchar === '}') break;
    if (nextchar !== ',') throw new JsonSyntaxError("Expecting ',' delimiter", s, i - 1);
    i = skipWs(s, i);
    nextchar = at(s, i);
    i += 1;
    if (nextchar !== '"') {
      throw new JsonSyntaxError('Expecting property name enclosed in double quotes', s, i - 1);
    }
  }
  return i;
}

/** One value, scanned. Returns the index after it. */
function scanOnce(s: string, idx: number, tokens?: [number, string][]): number {
  if (idx >= s.length) throw new JsonSyntaxError('Expecting value', s, idx);
  const ch = s[idx] as string;
  if (ch === '"') return scanString(s, idx + 1);
  if (ch === '{') return scanObject(s, idx + 1, tokens);
  if (ch === '[') return scanArray(s, idx + 1, tokens);
  if (s.startsWith('null', idx)) return idx + 4;
  if (s.startsWith('true', idx)) return idx + 4;
  if (s.startsWith('false', idx)) return idx + 5;
  const numberEnd = scanNumber(s, idx);
  if (numberEnd >= 0) return numberEnd;
  for (const constant of ['NaN', 'Infinity', '-Infinity']) {
    if (s.startsWith(constant, idx)) {
      tokens?.push([idx, constant]);
      return idx + constant.length;
    }
  }
  throw new JsonSyntaxError('Expecting value', s, idx);
}

/**
 * Find the first fault, with the message and position the established decoder reports.
 *
 * Only called on a document `JSON.parse` has already rejected. If the scanner somehow
 * finds nothing wrong -- a disagreement between the two parsers, which would be a real
 * finding -- the caller's own error is raised rather than a fabricated one.
 */
export function decodeError(text: string, tokens?: [number, string][]): JsonSyntaxError | null {
  try {
    const end = skipWs(text, scanOnce(text, skipWs(text, 0), tokens));
    if (end !== text.length) return new JsonSyntaxError('Extra data', text, end);
    return null;
  } catch (error) {
    if (error instanceof JsonSyntaxError) return error;
    throw error;
  }
}

/** Stands in for a constant while `JSON.parse` reads the rest; private-use, so no document's. */
const CONSTANT_MARK = '\uE000pyjson\uE001';
const CONSTANTS: Readonly<Record<string, number>> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  '-Infinity': Number.NEGATIVE_INFINITY,
};

/** The keyword a caller of `loads` may pass. */
export interface LoadsOptions {
  /**
   * A document that is ONE number comes back as a `JsonNumber` when its double would not
   * spell what the document wrote: an integer past 2**53, or a float that is integral
   * (`3.0`). For the caller that writes the value straight back out -- `api -d`, whose body
   * is the document read and written again -- and for no reader that wants a number back.
   */
  spelledRoot?: boolean;
}

/**
 * `text` parsed as JSON, raising `JsonSyntaxError` with the established message and
 * position.
 *
 * And ACCEPTING the constants `NaN`, `Infinity` and `-Infinity` as values: `dumps` writes
 * them for a float that is one, so a record or a manifest written that way and read back
 * was, to `JSON.parse`, not JSON at all -- a workspace with a NaN in its record vanished
 * from `list` and crashed `info`. The scanner already knows where each constant stands
 * outside a string; each is swapped for a marker string that `JSON.parse` reads, and the
 * reviver puts the number back.
 *
 * The values are plain -- objects, arrays, doubles -- so every reader reads what it read
 * before. What a plain value cannot hold of the document is kept BESIDE it, for `dumps`
 * (see `spell`): a rewrite of what this read writes back what the document said.
 *
 * And REFUSING before it scans: a text that starts with U+FEFF is `Unexpected UTF-8 BOM`
 * at position 0, before the decoder sees a character. Without
 * that check the BOM reached the scanner as a stray character and was "Expecting value" --
 * so a settings dump a Windows editor had saved lost the one sentence that names what is
 * wrong with it, and a BOM-led manifest or record was refused in other words than the
 * established ones. Only the FIRST character: a BOM anywhere after it is the scanner's to
 * report.
 */
export function loads(text: string, options: LoadsOptions = {}): unknown {
  if (text.startsWith('\uFEFF')) {
    throw new JsonSyntaxError('Unexpected UTF-8 BOM', text, 0);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const tokens: [number, string][] = [];
    const decoded = decodeError(text, tokens);
    if (decoded !== null) throw decoded;
    if (tokens.length === 0 || text.includes(CONSTANT_MARK)) throw error;
    let rebuilt = '';
    let last = 0;
    for (const [position, constant] of tokens) {
      rebuilt += `${text.slice(last, position)}${JSON.stringify(CONSTANT_MARK + constant)}`;
      last = position + constant.length;
    }
    rebuilt += text.slice(last);
    value = JSON.parse(rebuilt, (_key, member: unknown) =>
      typeof member === 'string' && member.startsWith(CONSTANT_MARK)
        ? (CONSTANTS[member.slice(CONSTANT_MARK.length)] ?? member)
        : member,
    );
  }
  return spell(text, value, options);
}

/**
 * What `JSON.parse` loses of a document, kept per container it built.
 *
 * A rewrite through this build lost three things.
 * A mapping keeps its keys in document order, where a JavaScript object enumerates the ones
 * that look like array indices FIRST: `{"b": 1, "2": 2}` was written `{"2": 2, "b": 1}`, by
 * `chown` over a hand-edited `extra.env` and by `api -d` on the wire. An integer in the
 * document has no ceiling, where a double holds one exactly only to 2**53: `extra.seed.n`
 * 12345678901234567890 was rewritten 12345678901234567000, and `api -d` sent that. And a
 * float that is integral is the same mechanism once more: `1e16` read as a double was
 * written back as the int `10000000000000000`, where `dumps` writes its float text, `1e+16`.
 *
 * Kept BESIDE the value rather than in it, and that is the point. A `Map`, a bigint or a
 * wrapper in the tree would be a new type for every reader of a record -- `Metadata.extra`
 * alone has dozens -- where these are only ever wrong on the way back out. `dumps` is the
 * one reader of this table: a member still holding the double it was read as is written in
 * the document's spelling, and one a mutation replaced is written as itself; a key it no
 * longer has is skipped, and one it gained follows the document's, as a mapping appends it.
 *
 * NOT REPRODUCED: the order among keys gained after the read when one of them looks like an
 * index. JavaScript enumerates that one first and nothing records when it was added. No
 * writer adds one -- `env` refuses a name that is not an identifier, and the record's own
 * keys are words -- so what reaches a file is the document's order plus words appended.
 */
interface Spelling {
  /** The keys in document order, where that is not the order JavaScript enumerates. */
  readonly order: readonly string[] | undefined;
  /** By key (an array's by index): the double read there, and the text `dumps` writes for it. */
  readonly numbers: ReadonlyMap<string, readonly [number, string]>;
}

const SPELLINGS = new WeakMap<object, Spelling>();

/** What `spell` learns of one value from the text: a number's spelling, or a container's. */
type Shape =
  | null
  | { readonly kind: 'number'; readonly spelling: string }
  | {
      readonly kind: 'object';
      readonly keys: readonly string[];
      readonly members: ReadonlyMap<string, Shape>;
    }
  | { readonly kind: 'array'; readonly items: readonly Shape[] };

/**
 * `value`, with what its text says beside it (`Spelling`), for `dumps`.
 *
 * `JSON.parse` still builds every value -- the escapes, the numbers and `__proto__` are its
 * rules, as the module comment says they must be. The text is walked a second time only
 * for what the value cannot say, and a walk that disagreed with the parser (which would be
 * a real finding) leaves the value as the parser built it.
 */
function spell(text: string, value: unknown, options: LoadsOptions): unknown {
  let shape: Shape;
  try {
    shape = shapeAt(text, 0)[1];
  } catch {
    return value;
  }
  annotate(value, shape);
  if (options.spelledRoot === true && shape?.kind === 'number' && typeof value === 'number') {
    return new JsonNumber(value, shape.spelling);
  }
  return value;
}

/**
 * The text `dumps` writes for a number literal, or null where its double already writes
 * it.
 *
 * An integer literal is exact at any size: `String` of the double spells it only below
 * 2**53 (and not at all from 1e21, where it turns to `1e+21`). A literal with a point or an
 * exponent is a float, which `dumps` spells by `floatString` unless it is integral, because
 * only the integral ones are indistinguishable from an int once parsed.
 */
function spellingOf(literal: string): string | null {
  const value = Number(literal);
  if (!/[.eE]/u.test(literal)) {
    const exact = BigInt(literal).toString();
    return String(value) === exact ? null : exact;
  }
  return Number.isInteger(value) ? floatString(value) : null;
}

/** A key JavaScript enumerates before the others: an array index, `0` to `2**32 - 2`. */
function isIndex(key: string): boolean {
  return /^(?:0|[1-9]\d{0,9})$/u.test(key) && Number(key) < 4294967295;
}

/**
 * The shape of the value at `start`, and the index after it.
 *
 * Over a document already accepted -- by `JSON.parse`, or by the scanner above for one
 * holding a constant -- so it only walks; anything unexpected is thrown, and `spell`
 * then leaves the value alone. A container nothing in which needs a spelling is `null`,
 * so the common record costs one walk and no table entry.
 */
function shapeAt(s: string, start: number): [number, Shape] {
  const i = skipWs(s, start);
  const ch = at(s, i);
  if (ch === '"') return [scanString(s, i + 1), null];
  if (ch === '{') return shapeObject(s, i + 1);
  if (ch === '[') return shapeArray(s, i + 1);
  for (const word of ['null', 'true', 'false', 'NaN', 'Infinity', '-Infinity']) {
    if (s.startsWith(word, i)) return [i + word.length, null];
  }
  const end = scanNumber(s, i);
  if (end < 0) throw new SyntaxError(`no value at ${String(i)}`);
  const spelling = spellingOf(s.slice(i, end));
  return [end, spelling === null ? null : { kind: 'number', spelling }];
}

function shapeObject(s: string, start: number): [number, Shape] {
  let i = skipWs(s, start);
  if (at(s, i) === '}') return [i + 1, null];
  // First occurrence for the position, last for the value: a mapping built from the pairs,
  // as `JSON.parse` builds its object.
  const keys: string[] = [];
  const members = new Map<string, Shape>();
  for (;;) {
    if (at(s, i) !== '"') throw new SyntaxError(`no key at ${String(i)}`);
    const keyEnd = scanString(s, i + 1);
    const token = s.slice(i, keyEnd);
    const key = token.includes('\\') ? (JSON.parse(token) as string) : token.slice(1, -1);
    i = skipWs(s, keyEnd);
    if (at(s, i) !== ':') throw new SyntaxError(`no ':' at ${String(i)}`);
    const [end, member] = shapeAt(s, i + 1);
    if (!members.has(key)) keys.push(key);
    members.set(key, member);
    i = skipWs(s, end);
    const next = at(s, i);
    i = skipWs(s, i + 1);
    if (next === '}') break;
    if (next !== ',') throw new SyntaxError(`no ',' at ${String(i)}`);
  }
  const needed = keys.some(isIndex) || [...members.values()].some((member) => member !== null);
  return [i, needed ? { kind: 'object', keys, members } : null];
}

function shapeArray(s: string, start: number): [number, Shape] {
  let i = skipWs(s, start);
  if (at(s, i) === ']') return [i + 1, null];
  const items: Shape[] = [];
  for (;;) {
    const [end, item] = shapeAt(s, i);
    items.push(item);
    i = skipWs(s, end);
    const next = at(s, i);
    i += 1;
    if (next === ']') break;
    if (next !== ',') throw new SyntaxError(`no ',' at ${String(i - 1)}`);
  }
  return [i, items.some((item) => item !== null) ? { kind: 'array', items } : null];
}

/** Record in `SPELLINGS` what `shape` says of `value` that `value` does not. */
function annotate(value: unknown, shape: Shape): void {
  if (shape === null || shape.kind === 'number' || value === null || typeof value !== 'object') {
    return;
  }
  const numbers = new Map<string, readonly [number, string]>();
  let order: readonly string[] | undefined;
  const visit = (key: string, member: unknown, sub: Shape): void => {
    if (sub?.kind !== 'number') annotate(member, sub);
    else if (typeof member === 'number') numbers.set(key, [member, sub.spelling]);
  };
  if (shape.kind === 'array') {
    if (!Array.isArray(value)) return;
    shape.items.forEach((sub, index) => visit(String(index), value[index], sub));
  } else {
    if (Array.isArray(value)) return;
    const bag = value as Record<string, unknown>;
    const own = Object.keys(bag);
    if (own.length === shape.keys.length && own.some((key, index) => key !== shape.keys[index])) {
      order = shape.keys;
    }
    for (const [key, sub] of shape.members) visit(key, bag[key], sub);
  }
  if (order !== undefined || numbers.size > 0) SPELLINGS.set(value, { order, numbers });
}

/** `names` (an object's own keys) in `order`, then any it gained since, in its own order. */
function documentOrder(names: readonly string[], order: readonly string[]): string[] {
  const present = new Set(names);
  const listed = order.filter((name) => present.has(name));
  const seen = new Set(listed);
  return [...listed, ...names.filter((name) => !seen.has(name))];
}

/**
 * A copy of an object `loads` built: a new object with the same members, in the
 * same order, with the same spellings -- which a spread `{...extra}` is not. It is a new
 * object in JavaScript's key order, with nothing beside it, so a record copied that way
 * before a rewrite lost what the table above keeps.
 *
 * Otherwise it IS the spread it replaces, so a call site changes in nothing else: the same
 * own keys (of a list or a string too, and none of null), each defined rather than
 * assigned, so a `__proto__` key stays a key.
 */
export function orderedDict(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value === null || value === undefined) return out;
  const bag = value as Record<string, unknown>;
  const spelling = typeof value === 'object' ? SPELLINGS.get(value) : undefined;
  const names =
    spelling?.order === undefined
      ? Object.keys(bag)
      : documentOrder(Object.keys(bag), spelling.order);
  for (const name of names) {
    Object.defineProperty(out, name, {
      value: bag[name],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (spelling !== undefined) {
    SPELLINGS.set(out, {
      order: spelling.order === undefined ? undefined : names,
      numbers: new Map(spelling.numbers),
    });
  }
  return out;
}

/**
 * A number with the text it was read from, which its double does not spell.
 *
 * Only `loads(text, { spelledRoot: true })` makes one, for a document that is a single
 * number a double does not spell: `api -d 12345678901234567890` sent `12345678901234567000`.
 * A number INSIDE a document needs no wrapper; `loads` keeps its spelling beside the
 * container that holds it.
 */
export class JsonNumber {
  constructor(
    readonly value: number,
    readonly spelling: string,
  ) {}
}

/** A number the document wrote as a FLOAT, so the writer keeps its `.0`: see `float-text`. */
export { JsonFloat };

/**
 * `container[key]` with the spelling `loads` kept for it, for a reader that takes a member
 * OUT of what `loads` built.
 *
 * The spelling a double loses is kept beside the CONTAINER (`Spelling`), so a value that
 * stays where it was read is written back right -- and one copied out of it is not. That is
 * how repro.json's own fields lost their floats: `fromDocument` copies each top-level field
 * onto the record, and a rewrite wrote `"host_port": 3100.0` back as `3100`. And how a
 * settings dump's values did: each is copied into the import plan, and its `5.0`, `-0.0`
 * and `1e+16` were printed and sent as `5`, `0` and `10000000000000000`.
 *
 * The member itself when nothing needs keeping -- a string, a container (which carries its
 * own table), a double that spells the document's value. Otherwise a `JsonFloat` for a float
 * that is integral, and a `JsonNumber` for an int past 2**53, which `dumps` and
 * `shownLoaded` write in the document's spelling.
 */
export function spelled(container: object, key: string): unknown {
  const member = (container as Record<string, unknown>)[key];
  const kept = SPELLINGS.get(container)?.numbers.get(key);
  if (kept === undefined || typeof member !== 'number' || !Object.is(kept[0], member)) {
    return member;
  }
  return /^-?\d+$/u.test(kept[1]) ? new JsonNumber(member, kept[1]) : new JsonFloat(member);
}

/** What `shownSpelled` needs of `loads`'s table, for `format` a rank below it. */
const LOADED_SPELLINGS: Spellings = {
  // A `JsonFloat` needs nothing from here: `shownSpelled` writes the float it wraps on its
  // own, as it does for one config.yaml's reader made.
  scalar: (value) => (value instanceof JsonNumber ? value.spelling : undefined),
  member: (container, key, held) => {
    const kept = SPELLINGS.get(container)?.numbers.get(key);
    return kept !== undefined && Object.is(kept[0], held) ? kept[1] : undefined;
  },
  keys: (container) => {
    const order = SPELLINGS.get(container)?.order;
    const names = Object.keys(container);
    return order === undefined ? names : documentOrder(names, order);
  },
};

/**
 * What `loads` built as a person reads it (`shownValue`), with what the document said kept: a float that is
 * integral keeps its `.0` (`5.0`, `-0.0`, `1e+16`, nested in a list too), an int past
 * 2**53 its digits, and a mapping its keys in document order.
 *
 * The text `dumps` writes for such a number is the same text, so the one table serves both
 * writers.
 * `shownValue` is the same function without the table, for a value no JSON document built.
 */
export function shownLoaded(value: unknown): string {
  return shownSpelled(value, LOADED_SPELLINGS);
}

/** The options a writer here spends. Every character outside ASCII is always escaped. */
export interface DumpsOptions {
  /** Null is one line; a number puts every member on a line of its own. */
  indent?: number | null;
  /** `[item, key]`. The default is `[', ', ': ']`, `[',', ': ']` with an indent. */
  separators?: readonly [string, string];
  /** Sort an object's keys, in code point order. */
  sortKeys?: boolean;
  /** On by default: NaN and the infinities are written bare. */
  allowNan?: boolean;
  /** `default=`: what a value JSON cannot spell is written as instead. */
  default?: (value: unknown) => unknown;
}

/**
 * `value` as JSON, byte for byte the established spelling -- the one the state files
 * earlier releases wrote already carry.
 *
 * `JSON.stringify` differs from it in four ways, and each reaches a file:
 *
 *   ASCII only    every character outside space..tilde is written as `\uXXXX` (an astral
 *                 one as its surrogate pair, DEL included); V8 writes it raw.
 *   constants     `NaN`, `Infinity` and `-Infinity` are written bare; V8 writes `null`, so
 *                 a record rewritten by it read back with a null where the number was.
 *   float text    a float is spelled by `floatString`: `1e-07`, `5e-05`; V8 `1e-7`, `0.00005`.
 *   layout        the separators are `', '` and `': '` unless told otherwise.
 *
 * A number that is integral is written as an int, because which of `1.0` and `1` the
 * document held is gone once JSON has been parsed (`floatString`'s doc comment);
 * a caller that knows wraps it in `JsonFloat`. Only a non-integral one is a float for
 * certain, and that is spelled by `floatString`. Except where `loads` read it: a member still
 * holding the double it was read as is written as its document spelled it, and an object's
 * keys in its document's order (`Spelling`), so `3.0` stays `3.0`, an int past 2**53 stays
 * digit for digit, and `{"b": 1, "2": 2}` keeps `b` first.
 *
 * What JSON cannot spell -- `undefined`, a bigint, a function, a symbol -- goes to
 * `default` when one is given, and what it returns is written instead. Without one,
 * `undefined` is left out of an object and written `null` in an array, which is what
 * `JSON.stringify` did for every writer this replaced (this code spells "absent" that way);
 * the others raise the TypeError `Object of type ... is not JSON serializable`.
 */
export function dumps(value: unknown, options: DumpsOptions = {}): string {
  const indent = options.indent ?? null;
  const [item, key] = options.separators ?? (indent === null ? [', ', ': '] : [',', ': ']);
  return encode(value, 0, {
    step: indent === null ? null : ' '.repeat(Math.max(0, indent)),
    item,
    key,
    sortKeys: options.sortKeys ?? false,
    allowNan: options.allowNan ?? true,
    fallback: options.default,
    open: new Set(),
  });
}

interface Encoding {
  /** One level of indent, or null for one line. */
  readonly step: string | null;
  readonly item: string;
  readonly key: string;
  readonly sortKeys: boolean;
  readonly allowNan: boolean;
  readonly fallback: ((value: unknown) => unknown) | undefined;
  /** The containers being written, to refuse a circular reference. */
  readonly open: Set<object>;
}

/** A bad value, as `format` names one: a RangeError named `InvalidValue`. */
function valueError(message: string): RangeError {
  const error = new RangeError(message);
  error.name = 'InvalidValue';
  return error;
}

/** A float's text (`floatString`), or one of the three constants. */
function encodeFloat(value: number, how: Encoding): string {
  if (Number.isFinite(value)) return floatString(value);
  if (!how.allowNan) {
    throw valueError(`Out of range float values are not JSON compliant: ${floatString(value)}`);
  }
  return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity';
}

function encode(value: unknown, depth: number, how: Encoding): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : encodeFloat(value, how);
  }
  if (value instanceof JsonFloat) return encodeFloat(value.value, how);
  if (value instanceof JsonNumber) return value.spelling;
  if (typeof value !== 'object') {
    if (how.fallback !== undefined) return encode(how.fallback(value), depth, how);
    if (value === undefined) return 'null';
    throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
  }
  if (how.open.has(value)) throw valueError('Circular reference detected');
  how.open.add(value);
  let members: string[];
  let brackets: string;
  // What `loads` kept beside this container of what it read (`Spelling`).
  const spelling = SPELLINGS.get(value);
  const member = (item: unknown, name: string): string => {
    const spelled = spelling?.numbers.get(name);
    return spelled !== undefined && Object.is(spelled[0], item)
      ? spelled[1]
      : encode(item, depth + 1, how);
  };
  if (Array.isArray(value)) {
    members = [];
    for (let i = 0; i < value.length; i += 1) members.push(member(value[i], String(i)));
    brackets = '[]';
  } else {
    const bag = value as Record<string, unknown>;
    let names = Object.keys(bag);
    if (spelling?.order !== undefined) names = documentOrder(names, spelling.order);
    if (how.fallback === undefined) names = names.filter((name) => bag[name] !== undefined);
    if (how.sortKeys) names.sort(compareCodePoints);
    members = names.map((name) => `${encodeString(name)}${how.key}${member(bag[name], name)}`);
    brackets = '{}';
  }
  how.open.delete(value);
  const [opening, closing] = [brackets[0] as string, brackets[1] as string];
  if (members.length === 0) return brackets;
  if (how.step === null) return `${opening}${members.join(how.item)}${closing}`;
  const inner = `\n${how.step.repeat(depth + 1)}`;
  return `${opening}${inner}${members.join(how.item + inner)}\n${how.step.repeat(depth)}${closing}`;
}

/**
 * Code point order for strings, not UTF-16 code unit order.
 *
 * The two differ only when a string contains an astral character (`\u{1f680}` sorts above
 * `\uffff` by code point and below it by UTF-16 unit).
 */
function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const ac = (a[i] as string).codePointAt(0) as number;
    const bc = (b[i] as string).codePointAt(0) as number;
    if (ac !== bc) return ac < bc ? -1 : 1;
  }
  return a.length - b.length;
}

const ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
});

/**
 * The quoted, ASCII-only spelling of one string.
 *
 * What is escaped is `([\\"]|[^\ -~])`, and it is applied here per UTF-16 unit -- so an
 * astral character is its surrogate pair, escaped one half at a time, and a lone surrogate
 * is escaped as itself.
 */
function encodeString(value: string): string {
  let out = '"';
  let plain = 0;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0x20 && unit <= 0x7e && unit !== 0x22 && unit !== 0x5c) continue;
    out += value.slice(plain, i);
    out += ESCAPES[value[i] as string] ?? `\\u${unit.toString(16).padStart(4, '0')}`;
    plain = i + 1;
  }
  return `${out}${value.slice(plain)}"`;
}
