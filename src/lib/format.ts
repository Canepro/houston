/**
 * Number formatting that rounds half to EVEN, because JavaScript's rounds the other way at
 * a tie.
 *
 * MEASURED, NOT ASSUMED. Fixed point with N decimals and rounding to a whole number both
 * round half to EVEN here; `toFixed` and `Math.round` round half AWAY FROM ZERO. They agree
 * on almost every input and disagree on exactly the ones a report is most likely to
 * contain -- a mean that lands on a half, a percentage of a round count:
 *
 *     value      formatFixed(v, 0)  v.toFixed(0)  roundHalfEven(v)  Math.round(v)
 *     0.5        '0'                '1'           0                 1
 *     2.5        '2'                '3'           2                 3
 *     -0.5       '-0'               '-1'          0                 -0
 *     1234.5     '1234'             '1235'        1234              1235
 *     0.125      '0.12' (2 places)  '0.13'        -                 -
 *
 * That last row is the one worth noticing: 0.125 is EXACTLY representable, so it is a true
 * tie and the two rules genuinely differ. 2.675 is not (it is 2.67499...), so both give
 * '2.67' and a test built only from values like it would find nothing.
 *
 * `perf/` renders these numbers into reports, verdicts and SLO lines that a person reads
 * beside the ones earlier releases wrote, so a one-digit difference is a difference in the
 * product. The helpers here exist so that every format string goes through one
 * implementation rather than each one re-deciding.
 *
 * ## How the tie is detected
 *
 * Not by scaling -- `value * 10 ** digits` introduces the very error being measured. Every
 * double has a FINITE decimal expansion, so the expansion is taken as a string and rounded
 * as a decimal. `toFixed(100)` is the widest Node offers; for the magnitudes this package
 * deals in, the expansion fits, and any digits beyond it are far below the rounding
 * position and cannot manufacture a tie there.
 */
import { CASE_FOLDS, DECIMAL_DIGITS, NOT_PRINTABLE } from './unicode-tables';

/** The widest fractional expansion `toFixed` will produce. */
const EXPANSION = 100;

/**
 * `value` in fixed point with `digits` places, half to EVEN.
 *
 * Keeps the `-0` of a negative value that rounds to zero, because that is the spelling
 * earlier releases printed and reports are compared against.
 */
export function formatFixed(value: number, digits: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';

  const negative = value < 0 || Object.is(value, -0);
  const abs = Math.abs(value);

  // The exact decimal expansion, wide enough that the digit after the cut and everything
  // behind it are visible.
  const expansion = abs.toFixed(Math.min(EXPANSION, Math.max(digits + 30, digits)));
  const [whole = '0', fraction = ''] = expansion.split('.');

  const kept = fraction.slice(0, digits).padEnd(digits, '0');
  const rest = fraction.slice(digits);
  const rounded = roundDecimal(whole, kept, rest);
  const body = digits > 0 ? `${rounded.whole}.${rounded.kept}` : rounded.whole;
  return negative ? `-${body}` : body;
}

/**
 * Seconds to one decimal place, half to EVEN -- the duration shape every service writes.
 *
 * `Math.round` is half AWAY FROM ZERO, so a duration of exactly 1.25s would be `1.3` where
 * the established shape is `1.2`. `formatFixed` already spells the half-even rule, so the
 * number is parsed back out of it rather than re-derived.
 */
export function roundSeconds(milliseconds: number): number {
  return Number(formatFixed(milliseconds / 1000, 1));
}

/**
 * Round a decimal split into (whole, kept, rest) with half-to-EVEN, carrying if needed.
 *
 * `rest` is everything after the cut. A tie is `rest` being exactly "5" followed by zeros;
 * anything else decides by its first digit, which is what makes 2.675 round down (its
 * expansion is 2.67499...) while 0.125 is a real tie.
 */
function roundDecimal(whole: string, kept: string, rest: string): { whole: string; kept: string } {
  if (rest === '') return { whole, kept };
  const first = rest.charCodeAt(0) - 48;
  const tie = first === 5 && /^50*$/u.test(rest);

  let roundUp: boolean;
  if (first > 5) roundUp = true;
  else if (first < 5) roundUp = false;
  else if (!tie) roundUp = true;
  else {
    // A true tie: go to the EVEN neighbour.
    const last =
      kept === '' ? whole.charCodeAt(whole.length - 1) - 48 : kept.charCodeAt(kept.length - 1) - 48;
    roundUp = last % 2 === 1;
  }
  if (!roundUp) return { whole, kept };

  // Increment the (whole + kept) digit string by one, carrying across the decimal point.
  const digits = (whole + kept).split('');
  let index = digits.length - 1;
  for (;;) {
    if (index < 0) {
      digits.unshift('1');
      break;
    }
    const next = (digits[index] as string).charCodeAt(0) - 48 + 1;
    if (next < 10) {
      digits[index] = String(next);
      break;
    }
    digits[index] = '0';
    index -= 1;
  }
  const keptLength = kept.length;
  const joined = digits.join('');
  return {
    whole: keptLength === 0 ? joined : joined.slice(0, joined.length - keptLength),
    kept: keptLength === 0 ? '' : joined.slice(joined.length - keptLength),
  };
}

/**
 * `value` rounded to a whole number, half to EVEN.
 *
 * `Math.round(2.5)` is 3 and this is 2. Used wherever a count or a ratio is rounded to a
 * whole number.
 */
export function roundHalfEven(value: number): number {
  if (!Number.isFinite(value)) return value;
  const asString = formatFixed(value, 0);
  const parsed = Number(asString);
  // `formatFixed` keeps the `-0`; a whole number rounded from it is a plain 0.
  return Object.is(parsed, -0) ? 0 : parsed;
}

/**
 * `text` read as a float -- a decimal with single underscores allowed between digits, or
 * `inf`, `infinity` or `nan` in any case -- which is not `Number(text)`.
 *
 * Measured rather than assumed. The two differ in both directions:
 *
 *     text        parseFloat_     Number(text)
 *     '1_000'     1000            NaN          underscores between digits are allowed
 *     'Infinity'  Infinity        Infinity     (agree)
 *     ''          throws          0            the dangerous one
 *     '0x10'      throws          16           and so is this
 *     ' 42 '      42              42           (agree)
 *
 * `Number('')` being 0 and `Number('0x10')` being 16 are what make a bare `Number` wrong
 * for parsing something a user typed: an empty SLO threshold would silently become a gate
 * of zero, which every run passes.
 *
 * Throws a `RangeError` named `InvalidValue`, so a caller can tell "not a number" from a
 * number it did not like.
 */
const FLOAT_GRAMMAR =
  /^[+-]?(?:(?:\d+(?:_\d+)*)?\.?(?:\d+(?:_\d+)*)?(?:[eE][+-]?\d+(?:_\d+)*)?|inf|infinity|nan)$/iu;

export function parseFloat_(text: string): number {
  // Unicode whitespace and Unicode digits, as `numberText` reads them: `'١'` is 1, where
  // an ASCII `\d` refused it, and `'\x1c2'` is refused, where `stripText` would have made it 2.
  const trimmed = numberText(String(text));
  const refused = () => namedError('InvalidValue', `${quotedText(String(text))} is not a number`);
  if (trimmed === '') throw refused();
  if (!FLOAT_GRAMMAR.test(trimmed)) throw refused();
  const body = trimmed.replace(/_/gu, '');
  // The regex accepts a lone sign or a lone dot; `Number` reports those as NaN, which is
  // indistinguishable from a real 'nan' without this check.
  const bare = body.replace(/^[+-]/u, '');
  if (bare === '' || bare === '.') throw refused();
  if (/^(?:inf|infinity)$/iu.test(bare)) return body.startsWith('-') ? -Infinity : Infinity;
  if (/^nan$/iu.test(bare)) return NaN;
  const value = Number(body);
  if (Number.isNaN(value)) throw refused();
  return value;
}

/**
 * The general format `g` -- six significant digits, trailing zeros stripped, and an
 * exponent outside `[1e-5, 1e6)`.
 *
 * Measured rather than assumed, because `toPrecision(6)` KEEPS the trailing zeros `g`
 * drops and picks a different exponent boundary:
 *
 *     value        formatG(v)      (v).toPrecision(6)
 *     2.0          '2'             '2.00000'
 *     1e-5         '1e-05'         '0.0000100000'
 *     1234567.0    '1.23457e+06'   '1.23457e+6'
 *
 * The exponent is two digits minimum with a sign, which `toExponential` does not do
 * either. `--cpus` is rendered through this, so a cap of `2` that printed as `2.00000`
 * would be handed to `docker update` verbatim.
 */
export function formatG(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';

  const exponent = Math.floor(Math.log10(Math.abs(value)));
  // The `g` rule: use the exponential form when the exponent is < -4 or >= the
  // precision (6 by default).
  if (exponent < -4 || exponent >= 6) {
    const [mantissa, exp] = value.toExponential(5).split('e') as [string, string];
    const trimmed = mantissa.includes('.')
      ? mantissa.replace(/0+$/u, '').replace(/\.$/u, '')
      : mantissa;
    const sign = exp.startsWith('-') ? '-' : '+';
    const digits = exp.replace(/^[+-]/u, '').padStart(2, '0');
    return `${trimmed}e${sign}${digits}`;
  }
  const fixed = value.toFixed(Math.max(0, 5 - exponent));
  return fixed.includes('.') ? fixed.replace(/0+$/u, '').replace(/\.$/u, '') : fixed;
}

/**
 * A percentage -- multiply by 100, then the same round-half-to-even fixed formatting, then
 * a `%`.
 *
 * Measured: `0.0125` at two places is `'1.25%'` and at one place `'1.2%'`, which is the
 * tie rule again (1.25 -> 1.2, to the even neighbour) and not what `toFixed` gives.
 */
export function formatPercent(value: number, digits: number): string {
  return `${formatFixed(value * 100, digits)}%`;
}

/**
 * Fixed point with a sign ALWAYS shown, including for a value that rounds to zero.
 *
 * `formatSigned(0.4, 0)` is `'+0'` and `formatSigned(-0.4, 0)` is `'-0'`, which is how a
 * baseline delta of "no meaningful change" reads in a report: a bare `0` would look like
 * the metric was not measured.
 */
export function formatSigned(value: number, digits: number): string {
  const body = formatFixed(value, digits);
  return body.startsWith('-') ? body : `+${body}`;
}

/**
 * Whether one character is printable: false for everything Unicode calls Other or
 * Separator, except the ASCII space. `quotedText` escapes exactly those code points, and this is
 * the half an earlier version was missing -- a NUL, a NEL, a DEL, a BOM, an NBSP or a U+2028
 * reached the message raw. The audit log's field sanitiser asks it too (`lib/audit.ts`).
 *
 * Read from the Unicode 15.0 table in `./unicode-tables`, not `/[\p{C}\p{Z}]/u`: that asks
 * Node's Unicode, 17.0 in Node 24. Measured, the two disagree on 10,615 code points, every
 * one assigned in 16.0 or 17.0 and so still `Cn` -- non-printable -- in 15.0. Asking Node,
 * `houston 𑛐` (U+116D0) said `No such command '𑛐'.`, where the message must escape it:
 * `No such command '\u{116d0}'.`.
 */
export function isPrintableText(ch: string): boolean {
  const point = ch.codePointAt(0) as number;
  let lower = 0;
  let upper = NOT_PRINTABLE.length - 1;
  while (lower <= upper) {
    const middle = (lower + upper) >> 1;
    const [first, last] = NOT_PRINTABLE[middle] as readonly [number, number];
    if (point < first) upper = middle - 1;
    else if (point > last) lower = middle + 1;
    else return false;
  }
  return true;
}

let FOLDS: Map<number, string> | undefined;

/**
 * Unicode full case folding, from the Unicode 15.0 table in `./unicode-tables`.
 *
 * Not `toLowerCase()`, which is a different mapping: `ß` folds to `ss` and lowers to itself,
 * `ς` and `µ` fold to `σ` and `μ`, `Σ` folds to `σ` wherever it stands where lowering makes
 * it `ς` at the end of a word, and a Cherokee small letter folds to its CAPITAL. Lowered,
 * two spellings of one host name were two hosts, so `edge delete STRASSE.example` kept the
 * route, certificate and key of `Straße.example`, which folding makes the same name.
 */
export function foldCase(text: string): string {
  FOLDS ??= new Map(CASE_FOLDS.map(([point, folded]) => [point, String.fromCodePoint(...folded)]));
  let out = '';
  for (const ch of text) out += FOLDS.get(ch.codePointAt(0) as number) ?? ch;
  return out;
}

/**
 * How a non-printable code point is written inside quotes: `\xNN` under 0x100, `\uNNNN`, then
 * `\u{NNNNN}` for an astral one -- JavaScript's own escapes, so a quoted value can be pasted
 * back into a script. `stored` keeps the eight-digit `\UNNNNNNNN` that data files written
 * by earlier releases hold, and that those releases read back.
 */
function escapeCodePoint(codePoint: number, dialect: Dialect): string {
  const hex = codePoint.toString(16);
  if (codePoint < 0x100) return `\\x${hex.padStart(2, '0')}`;
  if (codePoint < 0x10000) return `\\u${hex.padStart(4, '0')}`;
  return dialect === 'stored' ? `\\U${hex.padStart(8, '0')}` : `\\u{${hex}}`;
}

/**
 * The two spellings a value can be written in. `shown` is what a person reads: `null`,
 * `true`, `{"a": [1.0, null]}`. `stored` is what earlier releases wrote into files and
 * payloads other programs read back -- a compose environment value `True`, a list
 * `['a', None]` -- and it is kept exactly, because those files are shared with them.
 */
type Dialect = 'shown' | 'stored';

/**
 * A string in quotes, which is how a message quotes a value: `'alpha'`.
 *
 * Single quotes unless the value contains one and no double quote. The messages that use
 * it carry wording scripts match on, or are pasted into a ticket, so the rule is kept
 * rather than approximated with a hard-coded pair of quotes. A backslash, the quote, `\n`,
 * `\r` and `\t` are escaped, and a non-printable code point is written as
 * `escapeCodePoint` spells it.
 */
export function quotedText(value: string): string {
  return quotedTop(value, 'shown');
}

/** `quotedText`, in a dialect and with a quote character chosen by the caller. */
function quotedIn(value: string, dialect: Dialect, quote: string): string {
  let out = quote;
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (!isPrintableText(ch)) out += escapeCodePoint(ch.codePointAt(0) as number, dialect);
    else out += ch;
  }
  return out + quote;
}

/** A string on its own in `dialect`: the same quote rule in both, only the escapes differ. */
function quotedTop(value: string, dialect: Dialect): string {
  return quotedIn(value, dialect, value.includes("'") && !value.includes('"') ? '"' : "'");
}

/** A string as a value inside a container is written in `dialect`. */
function quotedMember(value: string, dialect: Dialect): string {
  return dialect === 'shown' ? quotedIn(value, 'shown', '"') : quotedTop(value, 'stored');
}

/**
 * The established truthiness: false for null, undefined, false, 0, '', [], {} -- and TRUE
 * for a NaN. This said false for NaN, so a NaN a document holds (JSON and YAML both read
 * one) was falsy where earlier releases held it truthy: a sidecar's NaN version read as
 * none, a preset's `requires_license: .nan` as no licence.
 *
 * `toText` handles "the value, or empty"; this is the bare truth test, where JavaScript's
 * truthiness disagrees in the other direction — an empty array and an empty object are
 * BOTH truthy in JavaScript and falsy here. A summary, a detail payload and a config bag
 * are all cases where a JSON `[]` means "nothing was measured" and must not read as `true`.
 */
export function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/**
 * The text of a float, which is not `String(number)`: `5.0`, `1e-07`, `inf`.
 *
 * Lives in the rank-0 leaf `float-text.ts` because `redact.ts` needs its whitespace set and
 * shares this module's rank; re-exported here so the rest of the code keeps one import.
 */
import * as fs from 'node:fs';

import { JsonFloat, STRIP_CHARS, floatString, stripText } from './float-text';

export { stripText };
export { floatString };

/**
 * A value as a person reads it: `null`, `true`, `12`, `1.5`, `'alpha'`, and a container as
 * JSON spells one -- `["a", 1.0]`, `{"k": null}`.
 *
 * `data`'s import plan shows each setting's value this way, and a settings dump holds
 * strings, numbers, booleans, nulls and whole lists and mappings. A string alone is quoted
 * as a message quotes a value (`quotedText`); inside a container it is double-quoted, as JSON is.
 */
export function shownValue(value: unknown): string {
  return textWithin(value, new Set(), undefined, undefined, 'shown', false);
}

/**
 * What a caller knows of a value that its JavaScript shape no longer says.
 *
 * `json-text.loads` keeps BESIDE what it built what a double and a JavaScript object lose of
 * the document -- that `5.0` was a float, that `12345678901234567890` was exact, a mapping's key
 * order -- and this module sits a rank below it, so it cannot look that table up itself.
 * `json-text.shownLoaded` hands it in through this.
 */
export interface Spellings {
  /** The text of a value the caller wraps (an integral float, an int past 2**53), or undefined. */
  readonly scalar: (value: unknown) => string | undefined;
  /** The text the caller kept for the number `container[key]` still holds, or undefined. */
  readonly member: (container: object, key: string, held: unknown) => string | undefined;
  /** A mapping's keys in document order. */
  readonly keys: (container: object) => string[];
}

/**
 * `shownValue`, with what `spellings` knows of the value. A function of its own rather than a
 * second parameter, because `shownValue` is handed to `.map` as it is, where a second
 * parameter would receive the index.
 */
export function shownSpelled(value: unknown, spellings: Spellings): string {
  return textWithin(value, new Set(), spellings, undefined, 'shown', false);
}

/** The ISO text of the date, or of the datetime (a space between), a Date stands for. */
type DateText = ((value: Date) => string | undefined) | undefined;

/** The ISO text (a space between) of the UTC datetime at a Date's instant: what else it can be. */
function utcDatetimeText(value: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  let out = `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-`;
  out += `${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:`;
  out += pad(value.getUTCSeconds());
  const micro = value.getUTCMilliseconds() * 1000;
  if (micro !== 0) out += `.${pad(micro, 6)}`;
  return `${out}+00:00`;
}

/** An offset of `offset` seconds in the stored spelling, `datetime.timedelta(...)`. */
function storedOffset(offset: number): string {
  const days = Math.floor(offset / 86400);
  const seconds = offset - days * 86400;
  const parts = [
    ...(days === 0 ? [] : [`days=${String(days)}`]),
    ...(seconds === 0 ? [] : [`seconds=${String(seconds)}`]),
  ];
  return `datetime.timedelta(${parts.join(', ')})`;
}

/**
 * A date or a datetime from its ISO text, in the stored spelling earlier releases wrote into
 * a compose environment value: `datetime.date(2026, 1, 1)`, a datetime's second only when it
 * or the microsecond is set, its microsecond only when set, then its tzinfo --
 * `datetime.timezone.utc` for a zero offset, or the fixed offset.
 */
function storedDate(text: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2})(?:\.(\d{6}))?(?:([-+])(\d{2}):(\d{2}))?)?$/u.exec(
      text,
    );
  if (match === null) return quotedMember(text, 'stored');
  const [, year, month, day, hour, minute, second, micro, sign, tzHour, tzMinute] = match;
  const date = [year, month, day].map(Number);
  if (hour === undefined) return `datetime.date(${date.join(', ')})`;
  const fields = [...date, Number(hour), Number(minute)];
  if (Number(second) !== 0 || micro !== undefined) fields.push(Number(second));
  if (micro !== undefined) fields.push(Number(micro));
  let tz = '';
  if (sign !== undefined) {
    const offset = (Number(tzHour) * 3600 + Number(tzMinute) * 60) * (sign === '-' ? -1 : 1);
    tz =
      offset === 0
        ? ', tzinfo=datetime.timezone.utc'
        : `, tzinfo=datetime.timezone(${storedOffset(offset)})`;
  }
  return `datetime.datetime(${fields.join(', ')}${tz})`;
}

/**
 * A value the YAML loader built, as a user preset's environment value is WRITTEN into the
 * generated compose file (and helm values), as config's `safeLoadConstructed` holds it:
 * `storedText`, plus a Date as the date or datetime `dateText` says it stands for -- its ISO
 * text alone, the stored date spelling inside a container.
 *
 * This is data, not a message: the compose file is shared with earlier releases, which
 * regenerate and read it, and Rocket.Chat reads the value. So it keeps the spelling those
 * files have always held -- `True`, `None`, `inf`, `[1, 2]` -- where `String(v)` wrote `true`,
 * `null`, `Infinity` and `1,2`, a mapping as `[object Object]`, an int past 2**53 rounded,
 * and a date as the Date's own text in the box's time zone.
 */
export function toTextYaml(value: unknown, dateText: NonNullable<DateText>): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return dateText(value) ?? utcDatetimeText(value);
  return textWithin(value, new Set(), undefined, dateText, 'stored', false);
}

/**
 * A value in `dialect`, knowing which containers are being written on the way down to it.
 *
 * A YAML alias can hold itself -- `bind_host: &x [*x]` in `config.yaml` -- and the loader
 * builds the real cycle. A list or a mapping guards it: a container met again while it is
 * still being written is `[...]` or `{...}`, so `config get bind_host` prints `[[...]]`. This
 * recursed until the stack ran out, and the command died with a RangeError and a JavaScript
 * stack. The guard is per PATH: `open` is emptied on the way back up, so an alias shared
 * without a cycle -- `[*s, *s]` -- still prints in full twice. An empty list is `[]` before
 * the guard is consulted; it holds nothing to recurse into.
 */
function textWithin(
  value: unknown,
  open: Set<object>,
  spellings: Spellings | undefined,
  dateText: DateText,
  dialect: Dialect,
  nested: boolean,
): string {
  const spelled = spellings?.scalar(value);
  if (spelled !== undefined) return spelled;
  const stored = dialect === 'stored';
  const inner = (held: unknown) => textWithin(held, open, spellings, dateText, dialect, true);
  if (value === null || value === undefined) return stored ? 'None' : 'null';
  if (typeof value === 'boolean') {
    if (stored) return value ? 'True' : 'False';
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string')
    return nested ? quotedMember(value, dialect) : quotedTop(value, dialect);
  if (typeof value === 'number') {
    // A JSON integer arrives as an integral number and its text is its digits, so `String`
    // is the right spelling for it -- see the caveat on `floatString` for the `2.0` case
    // that no JavaScript parser can tell apart from `2`.
    return Number.isInteger(value) ? String(value) : floatString(value);
  }
  // The rest are what a YAML document holds that JSON does not (`safeLoadConstructed`):
  // an int past 2**53, a float a number cannot say is one, a date, a mapping with keys that
  // are not strings, a set. Each was `String(value)` quoted, or `{}`.
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof JsonFloat) return floatString(value.value);
  if (value instanceof Date) {
    if (!stored) return dateText?.(value) ?? utcDatetimeText(value);
    // Only where the caller says what its Dates stand for: the stored text of config.yaml's
    // plain object still prints `{}` for one.
    if (dateText !== undefined) return storedDate(dateText(value) ?? utcDatetimeText(value));
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (open.has(value)) return '[...]';
    open.add(value);
    const body = value
      .map((held, index) => spellings?.member(value, String(index), held) ?? inner(held))
      .join(', ');
    open.delete(value);
    return `[${body}]`;
  }
  if (value instanceof Set) {
    // Members in the order the set holds them. A set cannot hold itself -- it is
    // unhashable -- so there is no cycle to guard. Shown, a set reads as the list it is to a
    // person; stored, it keeps the spelling earlier releases wrote.
    const body = [...(value as Set<unknown>)].map(inner).join(', ');
    if (!stored) return `[${body}]`;
    return value.size === 0 ? 'set()' : `{${body}}`;
  }
  if (typeof value === 'object') {
    if (open.has(value)) return '{...}';
    open.add(value);
    // A Map is what a YAML document with keys that are not strings builds; a plain object is
    // what JSON built, whose number spellings and key order the caller may hold.
    const bag = value as Record<string, unknown>;
    const entries: [unknown, string][] =
      value instanceof Map
        ? [...(value as Map<unknown, unknown>)].map(([key, held]) => [key, inner(held)])
        : (spellings === undefined ? Object.keys(bag) : spellings.keys(bag)).map((key) => [
            key,
            spellings?.member(bag, key, bag[key]) ?? inner(bag[key]),
          ]);
    const body = entries.map(([key, text]) => `${inner(key)}: ${text}`).join(', ');
    open.delete(value);
    return `{${body}}`;
  }
  return quotedText(String(value));
}

/**
 * A value as a row or a message shows it: `shownValue`, with a string as itself rather than
 * quoted -- `alpha`, `null`, `true`, `["a"]`.
 */
export function toTextAny(value: unknown): string {
  return typeof value === 'string' ? value : shownValue(value);
}

/**
 * A value in the stored spelling earlier releases wrote -- a string as itself, `None`, `True`,
 * `['a']` -- for the few places it becomes DATA another program reads: a Traefik route's port,
 * an env name or value written into a compose file, a kube context passed to kubectl, a
 * field coerced into a record earlier releases also read. Never for a message.
 */
export function storedText(value: unknown): string {
  return typeof value === 'string'
    ? value
    : textWithin(value, new Set(), undefined, undefined, 'stored', false);
}

/**
 * The lines of `text`, each with its ending when `keepends` is set, broken on more than
 * `\n`.
 *
 * It also breaks on CR (a CRLF is one break), VT, FF, the three information separators,
 * NEL and the two Unicode separators. Splitting on `\n` alone read a file holding any of
 * them as ONE line — `migrate` turned the account row `rc-repro-bob` into `houston-bob`
 * that way, because the whole file looked like a comment. A trailing terminator does not
 * add an empty line.
 *
 * Hoisted from `core/migrate.ts` when `data`'s scale-result parser needed the same rule;
 * one implementation rather than two that drift.
 */
const LINE_BOUNDARY = new Set([
  '\n',
  '\r',
  '\v',
  '\f',
  '\u001c',
  '\u001d',
  '\u001e',
  '\u0085',
  '\u2028',
  '\u2029',
]);

export function splitTextLines(text: string, keepends = false): string[] {
  const out: string[] = [];
  let start = 0;
  let at = 0;
  while (at < text.length) {
    const ch = text[at] as string;
    if (!LINE_BOUNDARY.has(ch)) {
      at += 1;
      continue;
    }
    let end = at + 1;
    if (ch === '\r' && text[end] === '\n') end += 1;
    out.push(keepends ? text.slice(start, end) : text.slice(start, at));
    at = end;
    start = end;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/**
 * A child's output read line by line with UNIVERSAL NEWLINES, fed as the pipe delivers it.
 *
 * `\r\n`, a bare `\r` and `\n` each end a line, and the last line is yielded when the pipe
 * closes even with no newline at all. `onLine` is handed each line without its ending. A
 * `\r` that ends a chunk is held for the next one, since it may be the first half of a
 * `\r\n`, and ends its line if the pipe closes instead. Not `splitTextLines`, which breaks on
 * more characters than universal newlines do.
 */
export function textLines(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  end: () => void;
} {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      const breaks = /\r\n|\r|\n/gu;
      let start = 0;
      for (let found = breaks.exec(pending); found !== null; found = breaks.exec(pending)) {
        if (found[0] === '\r' && found.index === pending.length - 1) break;
        onLine(pending.slice(start, found.index));
        start = found.index + found[0].length;
      }
      pending = pending.slice(start);
    },
    end() {
      if (pending === '') return;
      const last = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
      pending = '';
      onLine(last);
    },
  };
}

/**
 * `String(value)`, with null, undefined, false, 0, NaN, `[]` and `{}` read as the empty
 * string rather than as JavaScript spells them.
 *
 * The distinction that matters: `String(false)`, `String(0)` and `String(NaN)` produce
 * `"false"`, `"0"` and `"NaN"`, which are TRUTHY strings. A config value of `false` for
 * `reg_token` would reach a compose document, and a falsy `acme_email` would satisfy the
 * contact-email refusal -- both cases where a falsy value must read as empty.
 */
export function toText(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value === 0 || Number.isNaN(value) ? '' : String(value);
  if (Array.isArray(value)) return value.length === 0 ? '' : String(value);
  if (typeof value === 'object') return Object.keys(value).length === 0 ? '' : String(value);
  return String(value);
}

/** Whether one character is whitespace: exactly the set `stripText` removes. */
export function isSpaceText(ch: string): boolean {
  return STRIP_CHARS.has(ch);
}

/**
 * The words between runs of whitespace -- the `STRIP_CHARS` set -- with no empty string
 * at either end.
 *
 * Not `split(/\s+/)`, for the reason `stripText` is not `trim()`: the two whitespace sets
 * disagree in both directions, so folding a YAML description onto one line by joining its
 * words with a space would keep a NEL or a `\x1c` that the established fold removes, and
 * fold a BOM that it keeps.
 */
export function splitFields(text: string): string[] {
  const words: string[] = [];
  let word = '';
  for (const char of text) {
    if (!STRIP_CHARS.has(char)) word += char;
    else if (word !== '') {
      words.push(word);
      word = '';
    }
  }
  if (word !== '') words.push(word);
  return words;
}

/** A code point's decimal digit value, or null, from the Unicode 15.0 table in `./unicode-tables`. */
function decimalText(point: number): number | null {
  const run = DECIMAL_DIGITS.find(([first, last]) => first <= point && point <= last);
  return run === undefined ? null : run[2] + point - run[0];
}

/** The ASCII whitespace stripped at either end after the transform. */
const ASCII_SPACE = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/gu;

/**
 * The text an integer or a float is parsed from: each code point transformed, then the
 * ASCII whitespace at either end stripped. The transform keeps a code point below 127,
 * turns Unicode whitespace into a space and a decimal digit into its ASCII digit, and turns
 * anything else into `?` and stops there -- which no number's grammar accepts.
 *
 * Reproduced rather than approximated, because each approximation it replaces was measured
 * wrong:
 *
 *   - A digit's value is its Unicode decimal value, not its distance from the previous
 *     non-digit: the mathematical digits U+1D7CE..U+1D7FF are five ADJACENT runs of ten,
 *     so `--tail 𝟙𝟘` (U+1D7D9 U+1D7D8) read 99 where it is 10.
 *   - The digits are Unicode 15.0.0's, not Node 24's 17.0: `--tail 𑛐` (U+116D0, assigned
 *     in 16.0) read as a digit, where it is refused as `'\U000116d0' is not a valid int.`.
 *   - Only ASCII whitespace is stripped at the ends. The four information separators
 *     U+001C..U+001F are below 127, so the transform keeps them and the ASCII strip leaves
 *     them: `'\x1c7'` is refused although `stripText('\x1c7')` is `'7'`, which is what an
 *     earlier version did. A BOM is `?`, where `String#trim` strips it.
 */
export function numberText(value: string): string {
  let out = '';
  for (const ch of value) {
    const point = ch.codePointAt(0) as number;
    if (point < 127) {
      out += ch;
      continue;
    }
    if (isSpaceText(ch)) {
      out += ' ';
      continue;
    }
    const digit = decimalText(point);
    if (digit === null) {
      out += '?';
      break;
    }
    out += String(digit);
  }
  return out.replace(ASCII_SPACE, '');
}

/** The base-10 integer grammar on the transformed text: a sign, digits, single underscores. */
const INT_GRAMMAR = /^[+-]?[0-9](?:_?[0-9])*$/u;

/**
 * The integer-string digit limit, 4300: a string of more digits than this is refused --
 * measured, leading zeros count and a sign, whitespace and underscores do not -- so
 * `--tail` given 4301 zeros is `... is not a valid int.`, where this build accepted it and
 * left commander to refuse it in other words. The limit is fixed; no environment variable
 * moves it.
 */
const INT_MAX_STR_DIGITS = 4300;

/**
 * `value` read by the integer grammar, which is not `Number()` and not `parseInt`.
 *
 * Measured rather than assumed:
 *
 *     value      toInt(value) Number(value)   parseInt(value, 10)
 *     '3.7'      throws       3.7             3
 *     '0x10'     throws       16              0
 *     '1e3'      throws       1000            1
 *     '1_000'    1000         NaN             NaN
 *     ' 42 '     42           42              42
 *     ''         throws       0               NaN
 *     '12 files' throws       NaN             12
 *     '７０'     70           NaN             NaN
 *
 * A caller that wants a fallback catches the throw; a caller that wants the established
 * failure does not. `parseInt`'s trailing-garbage acceptance and `Number`'s empty-string
 * zero are the two shapes that silently produce a wrong pid or level.
 *
 * Any Unicode decimal digit counts: `COLUMNS='７０'` (fullwidth) or `'٦٠'` (Arabic-Indic)
 * sizes `houston presets` 70 or 60 wide, where reading only ASCII digits fell back to 90
 * columns, an 84-column box instead of a 66- or 56-column one (t1-presets verifier).
 */
export function toInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    // A NaN is not a value at all and an infinity is out of range, spelled `infinity`
    // whatever its sign; a caller tells the two apart by name.
    if (Number.isNaN(value)) throw namedError('InvalidValue', 'NaN is not an integer');
    if (!Number.isFinite(value)) throw namedError('OutOfRange', 'infinity is not an integer');
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    // An integer has no negative zero: `'-0'` reads as 0, where `parseInt` gives -0.
    const parsed = Number.parseInt(intDigits(value), 10);
    return parsed === 0 ? 0 : parsed;
  }
  throw new TypeError(expectedText('an integer', value));
}

/**
 * The text the integer grammar reads a string as, or its refusal: the sign and the ASCII digits,
 * underscores gone -- Unicode digits folded and whitespace stripped as `numberText` does.
 */
function intDigits(value: string): string {
  const text = numberText(value);
  if (!INT_GRAMMAR.test(text)) {
    throw new RangeError(`${quotedText(value)} is not an integer`);
  }
  const digits = text.replace(/[^0-9]/gu, '').length;
  if (digits > INT_MAX_STR_DIGITS) throw new RangeError(tooManyDigits(digits));
  return text.replace(/_/gu, '');
}

/**
 * A string read by the integer grammar, EXACT: `toInt`'s reading and refusals, as a bigint.
 *
 * An integer read from text has no ceiling, and a double holds one exactly only to 2**53: a
 * `--scale messages=9007199254740993@general` was refused as `9,007,199,254,740,992`
 * exceeding the cap, a number nobody typed. For the caller that compares or
 * quotes what was typed; `toInt` stays the reader for a caller that wants a number.
 */
export function toBigInt(value: string): bigint {
  return BigInt(intDigits(value));
}

/** The refusal of an integer written with more digits than any reader here accepts. */
function tooManyDigits(digits: number): string {
  return `an integer of ${String(digits)} digits is too long (the limit is ${String(INT_MAX_STR_DIGITS)})`;
}

/** The integer grammar's digits for each base given here, a prefix naming the base allowed. */
const INT_BASE_GRAMMAR: Readonly<Record<2 | 8 | 10 | 16, RegExp>> = {
  2: /^[+-]?(?:0[bB]_?)?[01](?:_?[01])*$/u,
  8: /^[+-]?(?:0[oO]_?)?[0-7](?:_?[0-7])*$/u,
  10: INT_GRAMMAR,
  16: /^[+-]?(?:0[xX]_?)?[0-9a-fA-F](?:_?[0-9a-fA-F])*$/u,
};

/**
 * A string read by the integer grammar in `base`, refusals in the established class and words.
 *
 * What the YAML 1.1 int constructor spends: base 2 after `0b`, base 8 for a leading zero,
 * base 16 after `0x`, base 10 otherwise. As `toInt` reads a string -- Unicode whitespace
 * and Unicode digits, single underscores between digits -- and with a prefix that names
 * the base allowed (`0o17` in base 8, `0x_1f` in base 16). A refusal names the text, quoted
 * and cut to 200 characters, and the base when it is not 10; base 10 alone has the
 * 4300-digit limit, which applies only to a base that is not a power of two.
 *
 * A JavaScript number, as every integer this code reads is: exact to 2**53, the nearest
 * double beyond it.
 */
export function intFromText(value: string, base: 2 | 8 | 10 | 16): number {
  const text = numberText(value);
  if (!INT_BASE_GRAMMAR[base].test(text)) {
    const shown = Array.from(quotedText(value)).slice(0, 200).join('');
    const kind = base === 10 ? 'an integer' : `a base-${String(base)} integer`;
    throw namedError('InvalidValue', `${shown} is not ${kind}`);
  }
  const negative = text.startsWith('-');
  const named = { 2: /^0[bB]/u, 8: /^0[oO]/u, 10: /^$/u, 16: /^0[xX]/u }[base];
  const body = text.replace(/^[+-]/u, '').replace(named, '').replace(/_/gu, '');
  if (base === 10 && body.length > INT_MAX_STR_DIGITS) {
    throw namedError('InvalidValue', tooManyDigits(body.length));
  }
  const prefix = { 2: '0b', 8: '0o', 10: '', 16: '0x' }[base];
  const magnitude = Number(BigInt(`${prefix}${body}`));
  // An integer has no negative zero.
  return negative && magnitude !== 0 ? -magnitude : magnitude;
}

/**
 * String order by code point, where `Array.prototype.sort` compares UTF-16 units and so
 * puts an astral character (`😀`, U+1F600) BELOW a BMP one above the surrogates (`Ａ`,
 * U+FF21).
 */
export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0) as number);
  const b = Array.from(right, (char) => char.codePointAt(0) as number);
  for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
    if (a[at] !== b[at]) return (a[at] as number) - (b[at] as number);
  }
  return a.length - b.length;
}

/**
 * Where a strict UTF-8 decode stops, and the reason it gives, so the byte range and the reason
 * a refusal reports are exact. A lead byte with too
 * few bytes after it is "unexpected end of data" over the rest of the input, unless the
 * byte after it already cannot continue it.
 */
function utf8Failure(bytes: Uint8Array): { start: number; end: number; reason: string } | null {
  const n = bytes.length;
  const follows = (at: number) =>
    at < n && (bytes[at] as number) >= 0x80 && (bytes[at] as number) <= 0xbf;
  const invalid = (start: number, length: number) => ({
    start,
    end: start + length,
    reason: 'invalid continuation byte',
  });
  let at = 0;
  while (at < n) {
    const lead = bytes[at] as number;
    if (lead < 0x80) {
      at += 1;
      continue;
    }
    if (lead < 0xc2 || lead > 0xf4) return { start: at, end: at + 1, reason: 'invalid start byte' };
    const size = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    const second = bytes[at + 1] as number;
    const secondBad =
      !follows(at + 1) ||
      (size === 3 && (lead === 0xe0 ? second < 0xa0 : lead === 0xed && second >= 0xa0)) ||
      (size === 4 && (lead === 0xf0 ? second < 0x90 : lead === 0xf4 && second >= 0x90));
    if (n - at < size) {
      if (n - at >= 2 && size > 2 && secondBad) return invalid(at, 1);
      if (n - at >= 3 && size === 4 && !follows(at + 2)) return invalid(at, 2);
      return { start: at, end: n, reason: 'unexpected end of data' };
    }
    if (secondBad) return invalid(at, 1);
    for (let next = 2; next < size; next += 1) if (!follows(at + next)) return invalid(at, next);
    at += size;
  }
  return null;
}

/**
 * Strict UTF-8 decoding: the text, or a refusal named `NotUtf8` that says where and why --
 * `/x/users is not valid UTF-8 (byte 0xff at position 21: invalid start byte)` -- where Node's
 * `toString` would put a U+FFFD in and carry on. `label` names what was read, usually its
 * path. A BOM is kept. A value error, so a `RangeError` here.
 */
export function decodeUtf8Strict(bytes: Uint8Array, label = 'the text'): string {
  const failure = utf8Failure(bytes);
  if (failure === null) return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  const { start, end, reason } = failure;
  const where =
    end === start + 1
      ? `byte 0x${(bytes[start] as number).toString(16).padStart(2, '0')} at position ${String(start)}`
      : `bytes at positions ${String(start)}-${String(end - 1)}`;
  throw namedError('NotUtf8', `${label} is not valid UTF-8 (${where}: ${reason})`);
}

/** A RangeError under a name a caller can test for: a bad value, one out of range, or bad UTF-8. */
export function namedError(
  name: 'InvalidValue' | 'OutOfRange' | 'NotUtf8',
  message: string,
): RangeError {
  const error = new RangeError(message);
  error.name = name;
  return error;
}

/**
 * What kind of value this is, with its article, for a message that reports what a caller
 * actually sent: `null`, `a list`, `an object`, `a boolean`, `an integer`, `a number`,
 * `a string`.
 *
 * Not `typeof`: a JSON body's list and null are both `object` to it, and an integer and a
 * fraction are both `number`.
 */
export function valueKind(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (value instanceof Date) return 'a date';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'boolean') return 'a boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number';
  if (typeof value === 'bigint') return 'an integer';
  if (typeof value === 'string') return 'a string';
  return `a ${typeof value}`;
}

/** The refusal of a value of the wrong kind: `expected an object, got a list`. */
export function expectedText(want: string, value: unknown): string {
  return `expected ${want}, got ${valueKind(value)}`;
}

/** The refusal of a value that cannot be a mapping key or a set member: `a list cannot be a key`. */
export function keyRefusal(value: unknown): string {
  return `${valueKind(value)} cannot be a key`;
}

/**
 * `container[key] = value`, a string key, on what a JSON or YAML document can hold.
 *
 * NOT JavaScript's `mapping[key] = value`, which assigns through the prototype chain: an env
 * var called `__proto__` passes the env name rule, and `__proto__` is an ACCESSOR on
 * `Object.prototype`. A string assigned to it was dropped without a word and a `null`
 * replaced the object's prototype, so the key never became one of the mapping's own -- not
 * listed, not written, not counted. Defined, it is an own key like any other:
 * appended when new, and an existing key keeps its place, as in a mapping. `JSON.parse` and the
 * YAML reader already make a `__proto__` read from disk an own key this way.
 *
 * Anything that is not a mapping is a TypeError that says what it was: a hand-edited
 * `"extra": null` is `expected an object, got null`. Written into a throwaway bag instead,
 * the value reached a generated file and never the record it was meant for.
 */
export function setItemChecked(container: unknown, key: string, value: unknown): void {
  if (Array.isArray(container) || container === null || typeof container !== 'object') {
    throw new TypeError(expectedText('an object', container));
  }
  Object.defineProperty(container, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * A member read on what a JSON answer holds: a mapping's own member, `fallback` when it has
 * none -- and on anything that is not a mapping, a TypeError, `expected an object, got a
 * list`.
 *
 * A missing value is `null`, as a JSON null already is. An index read
 * (`value.key ?? default`) asked nothing of a list or a string and reached through the
 * prototype for `constructor`, so a reader that must stop at such a value carried on.
 *
 * An integral float, `5.0`, reads as the double 5, so a refusal calls it an integer.
 */
export function dictGetChecked(value: unknown, key: string, fallback: unknown = null): unknown {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(expectedText('an object', value));
  }
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : fallback;
}

/** `left` when `isTruthy(left)`, otherwise `right`. */
export function orElse<L, R>(left: L, right: R): L | R {
  return isTruthy(left) ? left : right;
}

/**
 * The items a loop over `value` sees: a list's elements, a string's characters, a
 * mapping's keys -- and a TypeError for a number or a bool, `expected a list, got an integer`.
 * Null is not iterable either; every caller here guards it with `orElse(..., [])`.
 */
export function iterateChecked(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return Array.from(value);
  if (value !== null && typeof value === 'object') return Object.keys(value);
  throw new TypeError(expectedText('a list', value));
}

/**
 * Whether `container` holds the string `item`: an element of a list, a substring of a
 * string, a key of a mapping, and for a number or a bool the TypeError `expected a list, a
 * string or an object, got an integer`. Only a string equals a string, so an element of any other type
 * never matches.
 */
export function containsChecked(container: unknown, item: string): boolean {
  if (Array.isArray(container)) return container.some((element) => element === item);
  if (typeof container === 'string') return container.includes(item);
  if (container !== null && typeof container === 'object') return Object.hasOwn(container, item);
  throw new TypeError(expectedText('a list, a string or an object', container));
}

/**
 * `value` as a set member or mapping key: a list or a mapping cannot be one, and is refused
 * with `a list cannot be a key` before anything is added.
 */
export function hashableKey(value: unknown): unknown {
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
    throw new TypeError(keyRefusal(value));
  }
  return value;
}

/** glibc's `strerror` for the codes a file read can raise. */
const STRERROR: Readonly<Record<string, string>> = Object.freeze({
  EPERM: 'Operation not permitted',
  ENOENT: 'No such file or directory',
  EIO: 'Input/output error',
  ENXIO: 'No such device or address',
  EACCES: 'Permission denied',
  EBUSY: 'Device or resource busy',
  EEXIST: 'File exists',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EINVAL: 'Invalid argument',
  EMFILE: 'Too many open files',
  ENOSPC: 'No space left on device',
  EROFS: 'Read-only file system',
  ENAMETOOLONG: 'File name too long',
  ELOOP: 'Too many levels of symbolic links',
});

/**
 * The text of a Node filesystem error, as a Unix tool writes one: `/x: Permission denied`.
 *
 * Node says `EACCES: permission denied, open '/x'`, which puts the error code and the system
 * call in front of what an operator needs: the file, and the C library's reason. A code
 * this table does not know keeps Node's own message rather than a guess.
 */
export function fileErrorText(error: unknown, filename = ''): string {
  const err = error as NodeJS.ErrnoException;
  const code = typeof err.code === 'string' ? err.code : '';
  const number = typeof err.errno === 'number' ? Math.abs(err.errno) : NaN;
  const text = STRERROR[code];
  if (text === undefined || Number.isNaN(number)) {
    const own = (error as { message?: unknown }).message;
    return typeof own === 'string' ? own : String(error);
  }
  // A read that fails after its open (EISDIR comes from `read`, not `open`) carries no path,
  // and the message names the file either way; the caller's filename stands in.
  const named = typeof err.path === 'string' ? err.path : filename;
  return named !== '' ? `${named}: ${text}` : text;
}

/** The strerror text for a Node filesystem error, else the whole sentence. */
export function strerrorText(error: unknown, filename = ''): string {
  return (
    STRERROR[String((error as NodeJS.ErrnoException).code ?? '')] ?? fileErrorText(error, filename)
  );
}

/**
 * A Node filesystem error rewritten for a person: named `FileError`, its message
 * `fileErrorText`'s, its `code` kept for a caller that decides by it. For a failure that is
 * left unhandled, so the last line of the report names the file and the reason.
 */
export function fileErrorOf(error: unknown, filename = ''): Error {
  const out = new Error(fileErrorText(error, filename)) as NodeJS.ErrnoException;
  out.name = 'FileError';
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string') out.code = code;
  return out;
}

/** The C library's words for a socket error Node reports by code. */
const SOCKET_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection reset by peer',
  ECONNABORTED: 'Software caused connection abort',
  EPIPE: 'Broken pipe',
  ETIMEDOUT: 'Connection timed out',
  EADDRNOTAVAIL: 'Cannot assign requested address',
  EHOSTUNREACH: 'No route to host',
  EHOSTDOWN: 'Host is down',
  ENETUNREACH: 'Network is unreachable',
  ENETDOWN: 'Network is down',
  // getaddrinfo's failures, in its own words.
  ENOTFOUND: 'Name or service not known',
  EAI_AGAIN: 'Temporary failure in name resolution',
});

/**
 * The reason a connection failed, in the C library's words -- `Connection refused` -- where
 * Node's `ECONNREFUSED: connect ECONNREFUSED ::1:443` repeats the code and the address the
 * sentence around it already names. Of several addresses tried at once, the FIRST one's
 * error is reported. A code this table does not know keeps Node's words.
 */
export function socketErrorText(error: unknown): string {
  const failure = error as NodeJS.ErrnoException & { errors?: unknown[] };
  const first = (
    Array.isArray(failure.errors) && failure.errors.length > 0 ? failure.errors[0] : failure
  ) as NodeJS.ErrnoException;
  const known = SOCKET_ERRORS[String(first.code ?? '')];
  if (known === undefined) return `${failure.code ?? failure.name}: ${failure.message}`;
  return known;
}

/**
 * Whether `target` exists: false only for the errors that mean "not there" -- ENOENT,
 * ENOTDIR, EBADF, ELOOP -- and the error itself for any other, where `fs.existsSync` answers
 * false for every failure, a directory it may not enter included.
 */
export function pathExists(target: string): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code ?? '');
    if (['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP'].includes(code)) return false;
    throw fileErrorOf(error, target);
  }
}

/**
 * Whether `target` is a regular file: follows a symlink, is false for a path that is
 * absent, runs through a file (`ENOTDIR`), or loops -- and RAISES for any other failure, a
 * parent it may not search among them, as `pathExists` does. `fs.existsSync` answered
 * false for all of it.
 */
export function pathIsFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code ?? '');
    if (['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP'].includes(code)) return false;
    throw fileErrorOf(error, target);
  }
}

/**
 * Whether `target` is a directory: follows a symlink, and is false rather than an error
 * when it cannot tell.
 */
export function pathIsDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** The bytes `urlQuote` never escapes, whatever `safe` says: RFC 3986's unreserved set. */
const ALWAYS_SAFE = /^[A-Za-z0-9_.~-]$/u;

/**
 * Percent-encoding: the UTF-8 bytes of `text`, each one kept when it is a letter, a digit,
 * one of `_.-~` or in `safe`, and `%XX` in upper case otherwise. `encodeURIComponent`
 * keeps `!'()*` and escapes `/`, so it is not this.
 */
export function urlQuote(text: string, safe = '/'): string {
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out +=
      byte < 0x80 && (ALWAYS_SAFE.test(ch) || safe.includes(ch))
        ? ch
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * Percent-decoding: each `%XX` is a byte, and each run of them is decoded as UTF-8, an
 * invalid sequence becoming U+FFFD; a `%` not followed by two hex digits stays as it is.
 */
export function urlUnquote(text: string): string {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let out = '';
  let bytes: number[] = [];
  const flush = (): void => {
    if (bytes.length > 0) out += decoder.decode(Uint8Array.from(bytes));
    bytes = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const hex = text.slice(index + 1, index + 3);
    if (text[index] === '%' && /^[0-9A-Fa-f]{2}$/u.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      flush();
      out += text[index] as string;
    }
  }
  flush();
  return out;
}
