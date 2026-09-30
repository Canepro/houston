/**
 * The text of a float, which is not `String(number)`.
 *
 * It is the shortest decimal that round-trips, switches to an exponent outside
 * `[-4, 16)`, always keeps a decimal point (`2.0` is `'2.0'`) and pads the exponent to two
 * digits (`1e-5` is `'1e-05'`). JavaScript's `String` switches at different
 * bounds and drops the `.0`, so a settings dump holding a float would print differently
 * from the import plan earlier releases printed.
 *
 * The shortest digits come from `toExponential()` with no argument, which is the
 * shortest form that round-trips.
 *
 * NOT REPRODUCIBLE ACROSS THE WIRE: a JSON `2.0` and a JSON `2` both arrive as the number
 * 2, so which of `'2.0'` and `'2'` the document meant cannot be recovered here. Every JSON
 * parser on this side loses it, and the consequence is confined to the display string --
 * the APPLIED value is the same number either way.
 *
 * This module is a rank-0 leaf rather than a section of `format.ts`, because a module at
 * `format`'s own rank needs it: `redact.ts` builds its URL pattern from `STRIP_CHARS`,
 * and two modules of rank 1 may not import each other. One implementation at
 * the bottom, re-exported upward.
 */
export function floatString(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';

  const [mantissa = '', expText = '0'] = value.toExponential().split('e');
  const exponent = Number(expText);
  const negative = mantissa.startsWith('-');
  const digits = negative ? mantissa.slice(1).replace('.', '') : mantissa.replace('.', '');
  const sign = negative ? '-' : '';

  if (exponent < -4 || exponent >= 16) {
    const head = digits.length > 1 ? `${digits[0] as string}.${digits.slice(1)}` : digits;
    const marker = exponent < 0 ? '-' : '+';
    return `${sign}${head}e${marker}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  if (exponent >= 0) {
    const pointAt = exponent + 1;
    const body =
      digits.length > pointAt
        ? `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`
        : `${digits.padEnd(pointAt, '0')}.0`;
    return sign + body;
  }
  return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
}

/**
 * Every character `stripText` removes, which is not the set JavaScript's `trim()` removes.
 *
 * The two disagree in both directions: this set holds the four information separators
 * and NEL (`\x1c`-`\x1f`, `\x85`) and JavaScript's does not, while JavaScript strips the
 * BOM (`\ufeff`) and this set does not. `String.prototype.trim` is therefore not `stripText`,
 * and `scaleResult` was the first place that mattered. This is the one implementation.
 *
 * It is also exactly the `\s` of the established patterns, measured over every code point
 * (`redact.test.ts` holds that measurement), so a pattern that must match as they did
 * spells its `\s` from this set rather than from JavaScript's `\s`, which differs from it
 * the same two ways `trim()` does.
 */
export const STRIP_CHARS: ReadonlySet<string> = new Set([
  '\t',
  '\n',
  '\v',
  '\f',
  '\r',
  ' ',
  '\u001c',
  '\u001d',
  '\u001e',
  '\u001f',
  '\u0085',
  '\u00a0',
  '\u1680',
  '\u2000',
  '\u2001',
  '\u2002',
  '\u2003',
  '\u2004',
  '\u2005',
  '\u2006',
  '\u2007',
  '\u2008',
  '\u2009',
  '\u200a',
  '\u2028',
  '\u2029',
  '\u202f',
  '\u205f',
  '\u3000',
]);

/** `text` with every `STRIP_CHARS` character stripped from both ends. */
export function stripText(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && STRIP_CHARS.has(text[start] as string)) start += 1;
  while (end > start && STRIP_CHARS.has(text[end - 1] as string)) end -= 1;
  return text.slice(start, end);
}

/**
 * A number that is a FLOAT, so a writer keeps its `.0`.
 *
 * The JSON and the YAML writer both spell the float `1.0` as `1.0`, and JavaScript has one
 * number type where that distinction is already gone by the time a value arrives. A caller
 * that knows the value is a float wraps it here rather than guessing from the value: the
 * backup manifest knows `dump_seconds` is a float, and config.yaml's reader knows which
 * scalars the YAML 1.1 float resolver built.
 *
 * It sits at rank 0, below both of its writers -- `json-text` and `yaml-dump` -- and the
 * reader that makes one for YAML (`config`), which could not reach it where it was, in
 * `json-text` at rank 3. `json-text` re-exports it.
 */
export class JsonFloat {
  constructor(readonly value: number) {}
}
