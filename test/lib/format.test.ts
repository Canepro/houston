import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  compareCodePoints,
  formatFixed,
  formatG,
  formatPercent,
  formatSigned,
  parseFloat_,
  pathIsFile,
  foldCase,
  containsChecked,
  decodeUtf8Strict,
  dictGetChecked,
  floatString,
  hashableKey,
  toInt,
  toBigInt,
  intFromText,
  isSpaceText,
  iterateChecked,
  orElse,
  urlQuote,
  quotedText,
  shownValue,
  splitFields,
  toTextAny,
  storedText,
  toTextYaml,
  stripText,
  isTruthy,
  urlUnquote,
  roundHalfEven,
  roundSeconds,
} from '../../src/lib/format';
import { safeLoadYaml, safeLoadConstructed, yamlDateText } from '../../src/lib/config';
import { CASE_FOLDS, NOT_PRINTABLE, UNICODE_VERSION } from '../../src/lib/unicode-tables';

/**
 * What earlier releases answered for the larger corpora below, recorded, one key per test.
 * Negative zero was handed over spelled out, so its sign is part of what they answered.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'lib', 'format.json'), 'utf8'),
) as Record<string, unknown>;

/** The recorded answer for one test, which must exist. */
function recorded<T>(key: string): T {
  expect(Object.keys(RECORDED)).toContain(key);
  return RECORDED[key] as T;
}

/** The sha256 of `JSON.stringify(value)`: how a whole recorded table is held. */
function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Values chosen so the two rounding rules actually disagree somewhere.
 *
 * A corpus of ordinary measurements would pass under either rule and prove nothing, so
 * this is built around exact ties -- halves, quarters, eighths -- which are the doubles
 * that are exactly representable and therefore genuinely halfway.
 */
const VALUES = [
  0,
  -0,
  0.5,
  1.5,
  2.5,
  3.5,
  4.5,
  -0.5,
  -1.5,
  -2.5,
  0.125,
  0.375,
  2.675,
  1.005,
  1234.5,
  999.5,
  0.05,
  0.15,
  0.25,
  0.35,
  42,
  42.4,
  42.6,
  1 / 3,
  2 / 3,
  1e-7,
  123456.789,
  0.0001,
];

describe('formatFixed', () => {
  it.each([
    [0.5, 0, '0'],
    [1.5, 0, '2'],
    [2.5, 0, '2'],
    [3.5, 0, '4'],
    [1234.5, 0, '1234'],
    [0.125, 2, '0.12'],
    [0.375, 2, '0.38'],
    // Not a tie: 2.675 is really 2.67499..., so both rules round it down.
    [2.675, 2, '2.67'],
  ])('formats %p to %p places as %p, half to EVEN', (value, digits, expected) => {
    expect(formatFixed(value, digits)).toBe(expected);
  });

  it("keeps earlier releases' -0 for a negative that rounds to zero", () => {
    expect(formatFixed(-0.5, 0)).toBe('-0');
    expect(formatFixed(-0.4, 0)).toBe('-0');
    expect(formatFixed(-0, 2)).toBe('-0.00');
  });

  it('differs from toFixed exactly where the tie rule differs', () => {
    // The assertion that makes this module worth having: if these agreed, it would not.
    expect(formatFixed(0.5, 0)).not.toBe((0.5).toFixed(0));
    expect(formatFixed(2.5, 0)).not.toBe((2.5).toFixed(0));
    expect(formatFixed(0.125, 2)).not.toBe((0.125).toFixed(2));
    // And agrees everywhere else, which is most of the time.
    expect(formatFixed(42.4, 0)).toBe((42.4).toFixed(0));
    expect(formatFixed(1 / 3, 4)).toBe((1 / 3).toFixed(4));
  });

  it('matches earlier releases for every value at 0, 1, 2 and 4 places', () => {
    const digits = [0, 1, 2, 4];
    const expected = recorded<string[][]>('fixed');
    expect(digits.map((d) => VALUES.map((v) => formatFixed(v, d)))).toEqual(expected);
  });
});

describe('roundHalfEven', () => {
  it('rounds a tie to the even neighbour, as earlier releases do', () => {
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(Math.round(2.5)).toBe(3);
  });

  it('answers a plain 0 for -0.5, not -0, because the rounding returns an integer', () => {
    expect(Object.is(roundHalfEven(-0.5), 0)).toBe(true);
    expect(Object.is(Math.round(-0.5), -0)).toBe(true);
  });

  it('matches earlier releases for every value', () => {
    expect(VALUES.map(roundHalfEven)).toEqual(recorded<number[]>('round'));
  });
});

describe('roundSeconds', () => {
  it('is milliseconds to seconds at one place, half to even, as earlier releases round it', () => {
    // The duration shape every service writes, as earlier releases wrote it: 1250ms is
    // 1.25s, which they put at 1.2 and `Math.round` at 1.3.
    const samples = [0, 40, 950, 999, 1000, 1049, 1250, 1350, 2250, 60000, 1250050];
    const recordedSeconds = [0.0, 0.0, 0.9, 1.0, 1.0, 1.0, 1.2, 1.4, 2.2, 60.0, 1250.0];
    expect(samples.map((ms) => roundSeconds(ms))).toEqual(recordedSeconds);
  });
});

describe('parseFloat_', () => {
  const CASES = [
    '300',
    '300.5',
    '1.5',
    ' 42 ',
    '1_000',
    '1e3',
    '1E-3',
    '.5',
    '5.',
    '+7',
    '-7',
    'inf',
    '-inf',
    'Infinity',
    'nan',
    'NaN',
    '',
    'abc',
    '1.2.3',
    '0x10',
    '1,000',
    '.',
    '+',
    // Only ASCII whitespace is stripped after earlier releases' transform: the information
    // separators are kept, so refused, where their strip removes them; a BOM is refused.
    '\u001c2',
    '2\u001f',
    '\ufeff2',
    '\u00a02\u2003',
    '١.٥',
  ];

  it('refuses what Number() silently accepts', () => {
    // These two are why a bare `Number` is wrong for a value a user typed: an empty SLO
    // threshold would become a gate of zero, which every run passes.
    expect(Number('')).toBe(0);
    expect(Number('0x10')).toBe(16);
    expect(() => parseFloat_('')).toThrow(RangeError);
    expect(() => parseFloat_('0x10')).toThrow(RangeError);
  });

  it('accepts what Number() refuses', () => {
    expect(Number('1_000')).toBeNaN();
    expect(parseFloat_('1_000')).toBe(1000);
  });

  it('agrees with earlier releases on every case, including which ones raise', () => {
    const mine = CASES.map((c) => {
      try {
        const v = parseFloat_(c);
        if (Number.isNaN(v)) return 'nan';
        if (v === Infinity) return 'inf';
        if (v === -Infinity) return '-inf';
        return v;
      } catch {
        return 'RAISES';
      }
    });
    expect(mine).toEqual(recorded('parse_float'));
  });
});

describe('formatG', () => {
  const G_VALUES = [
    2.0, 0.5, 2.5, 1.0, 0.25, 1e-5, 1e-4, 123456.0, 1234567.0, 1e20, 0.0001234, 100.0, 3.14159265,
    1e6, 1e7, 0.000001, 12345678901234.0, 0.0, -2.0, 0.125, 999999.0, 1000000.0,
  ];

  it('strips the trailing zeros toPrecision keeps', () => {
    // `--cpus` goes through this: a cap of 2 rendered as `2.00000` is handed to
    // `docker update` verbatim.
    expect(formatG(2.0)).toBe('2');
    expect((2.0).toPrecision(6)).toBe('2.00000');
    expect(formatG(0.5)).toBe('0.5');
  });

  it('uses a two-digit signed exponent, which toExponential does not', () => {
    expect(formatG(1e-5)).toBe('1e-05');
    expect(formatG(1234567)).toBe('1.23457e+06');
    expect((1234567).toExponential(5)).toBe('1.23457e+6');
  });

  it('matches earlier releases for every value', () => {
    expect(G_VALUES.map(formatG)).toEqual(recorded('format_g'));
  });
});

describe('formatPercent and formatSigned', () => {
  const PCT = [0.0, 0.004, 0.0125, 0.5, 1.0, -0.4, 0.4, 25.0, -25.0, 0.125];

  it('applies the tie rule after multiplying by a hundred', () => {
    // 0.0125 -> 1.25 -> '1.2' at one place, to the EVEN neighbour.
    expect(formatPercent(0.0125, 2)).toBe('1.25%');
    expect(formatPercent(0.0125, 1)).toBe('1.2%');
  });

  it('always shows a sign, including for a value that rounds to zero', () => {
    // A bare `0` in a baseline delta column would look like the metric was not measured.
    expect(formatSigned(0.4, 0)).toBe('+0');
    expect(formatSigned(-0.4, 0)).toBe('-0');
    expect(formatSigned(25, 0)).toBe('+25');
  });

  it('matches earlier releases for every value, at both precisions and signed', () => {
    // Recorded: each value as a percentage at two places and at one, and signed at none.
    const expected = recorded<Record<string, string[]>>('percent');
    expect(PCT.map((v) => formatPercent(v, 2))).toEqual(expected.p2);
    expect(PCT.map((v) => formatPercent(v, 1))).toEqual(expected.p1);
    expect(PCT.map((v) => formatSigned(v, 0))).toEqual(expected.s0);
  });
});

describe('quotedText', () => {
  it('quotes a string the way earlier releases quote it', () => {
    // Single quotes, EXCEPT when the value holds an apostrophe and no double quote -- the
    // one input on which a hard-coded pair agrees with earlier releases everywhere else.
    const corpus = [
      'saml',
      "o'brien",
      'say "hi"',
      'both \' and "',
      'a\tb',
      'a\nb',
      'back\\slash',
      '',
    ];
    const expected = [
      "'saml'",
      '"o\'brien"',
      '\'say "hi"\'',
      "'both \\' and \"'",
      "'a\\tb'",
      "'a\\nb'",
      "'back\\\\slash'",
      "''",
    ];
    expect(corpus.map(quotedText)).toEqual(expected);
  });

  it('escapes what earlier releases call non-printable', () => {
    // `quotedText` escapes everything earlier releases call non-printable: the C0/C1 controls,
    // DEL, the Unicode Separators other than the ASCII space, the format characters and
    // the private-use area. A customer `*-settings.json` value can hold any of them, and
    // these pass through `quotedText` into operator-facing prose.
    const corpus = [
      'null\u0000byte',
      'sep\u2028x',
      'nel\u0085x',
      'del\u007f',
      'esc\u001b[0m',
      'nbsp\u00a0x',
      'zwsp\u200bx',
      'bom\ufeffx',
      'ideo\u3000x',
      'ogham\u1680x',
      'fig\u2007x',
      'par\u2029x',
      'vt\u000bx',
      'ff\u000cx',
      'is4\u001cx',
      'c1\u009fx',
      'private\ue000x',
      'astral-format\udb40\udc01',
      'printable é—🚀',
      'quote\'and"',
      // Assigned after Unicode 15.0 -- a digit, an outlined digit, an Arabic letter -- so
      // printable to Node 24's \p{C}\p{Z} and still unassigned, escaped, to earlier releases.
      'u16-digit\u{116D0}x',
      'u16-outlined\u{1CCF0}x',
      'arabic\u088fx',
    ];
    expect(corpus.map(quotedText)).toEqual(recorded('repr_nonprintable'));
  });

  it("reads printability from earlier releases' table, not Node's Unicode", () => {
    // Every code point earlier releases call non-printable, as ranges, measured over the
    // whole code space: held by its hash, and by the ranges the edge cases fall in -- the
    // controls, DEL to NBSP, the soft hyphen, the line and paragraph separators, the BOM,
    // the private-use area and the code points Unicode assigned after 15.0.
    expect(UNICODE_VERSION).toBe('15.0.0');
    expect(sha256Json(NOT_PRINTABLE)).toBe(
      'df676bdb3710ab543ea929c757277c079700bb640d60cc58baea8a72fafdec5f',
    );
    expect(NOT_PRINTABLE).toHaveLength(712);
    for (const range of [
      [0, 31],
      [127, 160],
      [173, 173],
      [5760, 5760],
      [8191, 8207],
      [8232, 8239],
      [12284, 12288],
      [55292, 63743],
      [65277, 65280],
      [2191, 2199],
      [71370, 71423],
      [113824, 118527],
      [918000, 1114111],
    ]) {
      expect(NOT_PRINTABLE).toContainEqual(range);
    }
  });

  it('folds case with the table earlier releases fold with, not toLowerCase()', () => {
    // The table is earlier releases', code point for code point, held by its hash and by the
    // entries where folding and lowering part: ß, final and capital sigma, micro, a
    // ligature, dotted I, Cherokee (which folds a small letter to its capital) and an
    // astral Deseret letter -- which are the samples, too.
    expect(sha256Json(CASE_FOLDS)).toBe(
      '661466e49c100e00238e2bde53b9b6895cc82ff63dbeb5f2a7dace01c779b0fb',
    );
    expect(CASE_FOLDS).toHaveLength(1530);
    for (const entry of [
      [0x41, [0x61]],
      [0xdf, [0x73, 0x73]],
      [0x3a3, [0x3c3]],
      [0x3c2, [0x3c3]],
      [0xb5, [0x3bc]],
      [0xfb01, [0x66, 0x69]],
      [0x130, [0x69, 0x307]],
      [0x13f8, [0x13f0]],
      [0x10400, [0x10428]],
      [0x1e9e, [0x73, 0x73]],
      [0x212a, [0x6b]],
    ]) {
      expect(CASE_FOLDS).toContainEqual(entry);
    }
    const samples = ['Straße.EXAMPLE', 'ΣΟΦΟΣ σοφος', 'µ ﬁ İ ẞ', 'ᏸᏹ Ᏸ', '𐐀x', 'plain ascii'];
    const expected = [
      'strasse.example',
      '\u03c3\u03bf\u03c6\u03bf\u03c3 \u03c3\u03bf\u03c6\u03bf\u03c3',
      '\u03bc fi i\u0307 ss',
      '\u13f0\u13f1 \u13f0',
      '\u{10428}x',
      'plain ascii',
    ];
    expect(samples.map(foldCase)).toEqual(expected);
    expect(foldCase('Straße')).not.toBe('Straße'.toLowerCase());
  });

  it('spells null, true and false as a person reads them', () => {
    // These appear in `--set` errors a person reads off a failed create.
    expect(shownValue(null)).toBe('null');
    expect(shownValue(undefined)).toBe('null');
    expect(shownValue(true)).toBe('true');
    expect(shownValue(false)).toBe('false');
    expect(shownValue(12)).toBe('12');
    expect(shownValue('abc')).toBe("'abc'");
    const expected = ['null', 'true', 'false', '12', "'abc'"];
    expect([null, true, false, 12, 'abc'].map(shownValue)).toEqual(expected);
  });
});

describe('isSpaceText', () => {
  it('is the whitespace test earlier releases apply, over every code point', () => {
    // Every code point earlier releases call whitespace, recorded over the whole code space.
    const expected = [
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000,
      0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028,
      0x2029, 0x202f, 0x205f, 0x3000,
    ];
    const ours: number[] = [];
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (isSpaceText(String.fromCodePoint(point))) ours.push(point);
    }
    expect(ours).toEqual(expected);
  });
});

describe('shownValue and toTextAny', () => {
  it("reproduces earlier releases' shown text for every JSON shape a settings dump holds", () => {
    // A support dump's values reach the config-import plan's display strings, which print
    // each value's shown text. `String()` is a different string for a list, a mapping and a
    // float: the shown text of `["a"]` is `["a"]` and of 2.0 is `2.0`.
    const corpus: unknown[] = [
      null,
      true,
      false,
      0,
      1,
      -1,
      12,
      1.5,
      0.1,
      123456.789,
      1e16,
      1.5e-5,
      1e-4,
      -0.5,
      '',
      'abc',
      "it's",
      'has"double',
      'line\nbreak',
      [1, 'a', null, true, 1.5],
      { a: 1, b: [2, 'x'] },
      [],
      {},
    ];
    expect(corpus.map(shownValue)).toEqual(recorded('repr_json'));
  });

  it('spells floats the way earlier releases do, exponent bounds and all', () => {
    // `floatString` switches to scientific outside [-4, 16), keeps the `.0`, and pads the exponent
    // to two digits -- three things `String()` do differently. Earlier releases were handed
    // each value as a FLOAT, so 2.0 is the float 2.0 and not the integer 2.
    const transport = [2.0, 100.0, 0.1, 123456.789, 1e15, 1e16, 1.5e-5, 1e-4];
    const expected = [
      '2.0',
      '100.0',
      '0.1',
      '123456.789',
      '1000000000000000.0',
      '1e+16',
      '1.5e-05',
      '0.0001',
    ];
    expect(transport.map(floatString)).toEqual(expected);
    expect(floatString(-0.0)).toBe('-0.0');
    expect(floatString(Number.NaN)).toBe('nan');
    expect(floatString(Number.POSITIVE_INFINITY)).toBe('inf');
    expect(floatString(Number.NEGATIVE_INFINITY)).toBe('-inf');
  });

  it('prints a self-referencing value the way earlier releases do, rather than overflowing the stack', () => {
    // `bind_host: &x [*x]` in config.yaml: both loaders build the real cycle, earlier
    // releases print `[[...]]`, and this recursed until a RangeError. Lists in dicts,
    // dicts in lists, a document that is itself the cycle, and a shared alias WITHOUT one,
    // which the per-path guard must still print in full twice.
    const documents = [
      'a: &x [*x]',
      'a: &x {k: *x}',
      'a: &x [{k: *x}]',
      'a: &x {k: [*x]}',
      'a: &x [*x, *x, 1]',
      'a: &x [[*x]]',
      'a: &x {k: &y [*x, *y]}',
      'a: &x {k: *x, j: [*x, {m: *x}]}',
      'a: &x [a, *x, {b: *x}, []]',
      's: &s [1]\na: [*s, *s, {t: *s}]',
      '&top {a: *top}',
      '&top [*top]',
    ];
    // Recorded: each document's shown text, and the text of its `a` (or of itself without one).
    const ours = documents.map((text) => {
      const value = safeLoadYaml(text);
      const held =
        typeof value === 'object' && value !== null && !Array.isArray(value) && 'a' in value
          ? (value as Record<string, unknown>).a
          : value;
      return [shownValue(value), toTextAny(held)];
    });
    expect(ours).toEqual(recorded('yaml_cycles'));
    expect(ours[0]).toEqual(['{"a": [[...]]}', '[[...]]']);
  });

  it('spells the text of every value a YAML read builds, as safeLoadConstructed holds it', () => {
    // A user preset's env is written as the text of the YAML value (compose and the chart),
    // and `String` of the JavaScript one was another value: `true`, `null`, `Infinity`,
    // `1,2`, `[object Object]`, an int past 2**53 rounded, `1.0` as `1`, and a date as the
    // Date's own text in the box's time zone. Inside a container it is the stored text: a
    // mapping's keys as typed, a date as `datetime.date(...)`.
    const documents = [
      'v: true',
      'v: no',
      'v: null',
      'v: ~',
      'v: 42',
      'v: -0',
      'v: 12345678901234567890',
      'v: -12345678901234567890',
      'v: 0x1FFFFFFFFFFFFFFFF',
      `v: 0b${'1'.repeat(70)}`,
      'v: 0777777777777777777777',
      'v: 1:0:0:0:0:0:0:0:0:0:0',
      'v: !!int 12345678901234567890',
      'v: 1.0',
      'v: -0.0',
      'v: 2.5',
      'v: 1.0e+20',
      'v: 1.0e-7',
      'v: .inf',
      'v: -.inf',
      'v: .nan',
      'v: !!float 3',
      'v: 1_000.0',
      'v: 1:30.0',
      'v: 2026-01-01',
      'v: !!timestamp 2026-1-1',
      'v: 2026-01-01 10:00:00',
      'v: 2026-01-01T10:00:00Z',
      'v: 2026-01-01 10:00:00.5+05:30',
      'v: 2026-01-01 10:00:30.25-05:00',
      'v: 2001-12-14t21:59:43.10-05:00',
      'v: {a: 1, 1: b, true: c, f: 1.0, ~: n, 2.0: t}',
      "v: [1, x, 1.0, null, true, 'it''s', 12345678901234567890]",
      'v: [2026-01-01, 2026-01-01 10:00:00, 2026-01-01T10:00:00Z, 2026-01-01 10:00:00+05:30]',
      'v: [2026-01-01 10:00:00.000001-10:00, 2026-01-01 10:00:00.5]',
      'v: {2026-01-01: d}',
      'v: []',
      'v: {}',
      'v: !!set {a}',
      'v: !!set {}',
      'v: plain',
      'v: "3.0"',
      'v: [[1, [2.0]], {k: [12345678901234567890]}]',
      'v: &x [*x]',
      'v: &x {k: *x}',
    ];
    const ours = documents.map((text) =>
      toTextYaml((safeLoadConstructed(text) as Map<unknown, unknown>).get('v'), yamlDateText),
    );
    expect(ours).toEqual(recorded('yaml_text'));
    expect(ours.slice(0, 7)).toEqual([
      'True',
      'False',
      'None',
      'None',
      '42',
      '0',
      '12345678901234567890',
    ]);
  });

  it('drops only the quotes the text of a value drops', () => {
    expect(toTextAny('abc')).toBe('abc');
    expect(toTextAny(null)).toBe('null');
    expect(toTextAny(true)).toBe('true');
    expect(toTextAny(12)).toBe('12');
    expect(toTextAny(['a', 1])).toBe('["a", 1]');
    expect(toTextAny({ a: 'b' })).toBe('{"a": "b"}');
    // The stored spelling, for the data earlier releases read back, is the one that differs.
    expect(storedText(null)).toBe('None');
    expect(storedText(true)).toBe('True');
    expect(storedText(['a', 1])).toBe("['a', 1]");
    expect(storedText({ a: 'b' })).toBe("{'a': 'b'}");
  });
});

describe("earlier releases' strip and int, which JavaScript spells differently", () => {
  it("agrees with earlier releases' strip on every separator the two disagree about", () => {
    const corpus = [
      '  plain  ',
      '\t\n\v\f\r mixed \t\n',
      '\u001c\u001d\u001e\u001f info separators \u001c',
      '\u0085 NEL \u0085',
      '\ufeff BOM \ufeff',
      '\u00a0 nbsp \u00a0',
      '\u2028\u2029 line separators \u2028',
      '',
      '   ',
      'no-edges',
    ];
    const expected = [
      'plain',
      'mixed',
      'info separators',
      'NEL',
      '\ufeff BOM \ufeff',
      'nbsp',
      'line separators',
      '',
      '',
      'no-edges',
    ];
    expect(corpus.map(stripText)).toEqual(expected);
  });

  it("agrees with earlier releases' split on the same separators, which `\\s` does not", () => {
    // Splitting on whitespace and joining with one space is how `houston presets` folds a
    // YAML description onto one line; a NEL or an information separator is a word break to
    // earlier releases and part of a word to `/\s+/`, and a BOM is the other way round.
    const corpus = [
      '  two   words\n\tand　more  ',
      'a\u0085b\u001cc\u001fd',
      'bom﻿stays inside',
      'no break and line',
      '',
      '   ',
      'one',
    ];
    const expected = [
      ['two', 'words', 'and', 'more'],
      ['a', 'b', 'c', 'd'],
      ['bom\ufeffstays', 'inside'],
      ['no', 'break', 'and', 'line'],
      [],
      [],
      ['one'],
    ];
    expect(corpus.map(splitFields)).toEqual(expected);
  });

  it("agrees with earlier releases' integer reading on values and refusals", () => {
    const corpus = [
      '3',
      '+3',
      '-3',
      ' 42 ',
      '1_000',
      '0x10',
      '1e3',
      '3.7',
      '',
      '12 files',
      '_1',
      '1_',
      // Any Unicode decimal digit, and scripts may mix: `COLUMNS='７０'` sized
      // `houston presets` 70 wide in earlier releases and fell back to 90 here.
      '７０',
      '٦٠',
      '٦_0',
      ' -१२ ',
      '𝟙𝟘',
      '７x',
      '²',
      '½',
      // Earlier releases' strip removes U+001C..U+001F and their integer reading does not.
      '\u001c7',
      '7\u001f',
      '\ufeff7',
      '\u00a07\u2003',
      // Earlier releases' digit limit: 4300 digits pass, 4301 raise, a sign is not one.
      '0'.repeat(4300),
      `-${'0'.repeat(4300)}`,
      '0'.repeat(4301),
    ];
    const expected = recorded<({ value: number } | { error: string })[]>('int');
    const mine = corpus.map((text) => {
      try {
        return { value: toInt(text) };
      } catch (error) {
        return { error: (error as Error).constructor.name, message: (error as Error).message };
      }
    });
    // Messages are earlier releases' spelling; `RangeError` is this build's bad-value error.
    expect(mine.map((row) => ('value' in row ? row : { error: 'RangeError' }))).toEqual(
      expected.map((row) => ('value' in row ? row : { error: 'RangeError' })),
    );
    expect(
      mine.filter((row) => 'message' in row).map((row) => (row as { message: string }).message),
    ).toEqual(
      expected.filter((row) => 'message' in row).map((row) => (row as { message: string }).message),
    );
  });

  it("agrees with earlier releases' integer reading in the bases their YAML reader uses", () => {
    // Earlier releases' YAML integer reads base 8 for a leading zero, and base 2 and base 16
    // after `0b`/`0x`: an explicit `!!int 0o17` is 15 because base 8 takes its own prefix,
    // and a refusal quotes the text cut to 200 characters. Recorded: each value as the
    // nearest double's float text, or the refusal.
    const corpus: [string, 2 | 8 | 10 | 16][] = [
      ['101', 2],
      ['0b101', 2],
      ['0B1', 2],
      ['0b_1', 2],
      ['_1', 2],
      ['2', 2],
      ['', 2],
      [' 1 ', 2],
      ['0o17', 8],
      ['0O17', 8],
      ['017', 8],
      ['08', 8],
      ['00o17', 8],
      ['0o', 8],
      ['\u0661\u0662', 8],
      ['1f', 16],
      ['0x_1f', 16],
      ['0X1F', 16],
      ['0b1', 16],
      ['0x', 16],
      ['g', 16],
      ['-0', 10],
      ['1_000', 10],
      ['1__0', 10],
      ['\u001c7', 10],
      ['x'.repeat(300), 10],
      ['\u00e9'.repeat(300), 8],
      ['1'.repeat(4301), 10],
      ['1'.repeat(4301), 8],
      ['9007199254740993', 10],
    ];
    const mine = corpus.map(([text, base]) => {
      try {
        return { value: floatString(intFromText(text, base)) };
      } catch (error) {
        return { error: (error as Error).name, message: (error as Error).message };
      }
    });
    // As the nearest double, which is what a JavaScript number holds: 4301 octal digits are
    // no refusal, only too large for one.
    expect(mine).toEqual(recorded('int_base'));
  });

  it('reads every decimal digit Node knows as earlier releases do, and no other', () => {
    // Node 24's ICU is Unicode 17.0 and earlier releases' is 15.0: the ninety digits between
    // are digits to `\p{Nd}` and a refusal to earlier releases. The mathematical runs at
    // U+1D7CE sit end to end, which is where walking back to a run's zero goes wrong.
    // Recorded over every code point above ASCII: the 670 that earlier releases read as a
    // digit, with their values, held by the hash of the [code point, value] pairs; every
    // other code point is refused.
    const digits: string[] = [];
    for (let point = 0x80; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const char = String.fromCodePoint(point);
      if (/\p{Nd}/u.test(char)) digits.push(char);
    }
    expect(digits.length).toBeGreaterThan(700);
    const mine = digits.map((char) => {
      try {
        return toInt(char);
      } catch {
        return null;
      }
    });
    const read = digits.flatMap((char, at) =>
      mine[at] === null ? [] : [[char.codePointAt(0), mine[at]]],
    );
    expect(read).toHaveLength(670);
    expect(sha256Json(read)).toBe(
      'ae05fc8ca0259089facf177c779641d1076854835f4860d738a2be301e6c17dc',
    );
    const at = (point: number): number | null =>
      mine[digits.indexOf(String.fromCodePoint(point))] ?? null;
    // Arabic-Indic, fullwidth, the first and last mathematical runs, Nag Mundari (15.0);
    // and three digits assigned in 16.0 and later, which earlier releases refuse.
    expect([0x663, 0xff17, 0x1d7ce, 0x1d7ff, 0x1e4f9].map(at)).toEqual([3, 7, 0, 9, 9]);
    expect([0x116d0, 0x1ccf0, 0x1e5f1].map(at)).toEqual([null, null, null]);
  });

  it('truncates a float toward zero and refuses a non-finite one', () => {
    expect(toInt(3.9)).toBe(3);
    expect(toInt(-3.9)).toBe(-3);
    expect(toInt(true)).toBe(1);
    expect(toInt(false)).toBe(0);
    expect(() => toInt(Number.POSITIVE_INFINITY)).toThrow(/infinity is not an integer/);
  });
});

describe("earlier releases' strict UTF-8 decode and sort, which Node spells differently", () => {
  it('stops where earlier releases stop, over the same bytes, with the same sentence', () => {
    // Every lead-byte class against every second, third and fourth byte class, and each
    // cut short: the short sequences are where "unexpected end of data" and "invalid
    // continuation byte" part, by the second byte's range for E0/ED/F0/F4.
    const leads = [0x41, 0x7f, 0x80, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xe1, 0xed, 0xee];
    leads.push(0xef, 0xf0, 0xf1, 0xf3, 0xf4, 0xf5, 0xff);
    const follows = [0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0];
    const corpus: number[][] = [];
    for (const lead of leads) {
      corpus.push([0x61, lead]);
      for (const second of follows) {
        corpus.push([0x61, lead, second]);
        for (const third of [0x41, 0x80, 0xbf, 0xc0]) {
          corpus.push([0x61, lead, second, third]);
          for (const fourth of [0x41, 0x80, 0xc0])
            corpus.push([0x61, lead, second, third, fourth, 0x7a]);
        }
      }
    }
    corpus.push([0xef, 0xbb, 0xbf, 0x61], []);
    expect(corpus.length).toBeGreaterThan(2000);
    const decoded = (bytes: number[]) => {
      try {
        return ['ok', decodeUtf8Strict(Uint8Array.from(bytes))];
      } catch (error) {
        return ['error', (error as Error).message];
      }
    };
    const mine = corpus.map(decoded);
    // What earlier releases decoded or refused for every sequence, held by its hash, and
    // spelled out for the edges: a sequence cut short after one byte and after two, an
    // overlong lead, a surrogate, the last code point and one past it, the first invalid
    // lead, a BOM and nothing at all.
    expect(sha256Json(mine)).toBe(
      'a6192a81d0a9b050b7d4a22a0719eda484f62a41174e2ee2ce2bc50f120389fc',
    );
    const cannot = 'the text is not valid UTF-8';
    for (const [bytes, answer] of [
      [
        [0x61, 0xc2],
        ['error', `${cannot} (byte 0xc2 at position 1: unexpected end of data)`],
      ],
      [
        [0x61, 0xc2, 0x80],
        ['ok', 'a\u0080'],
      ],
      [
        [0x61, 0xe0, 0x80],
        ['error', `${cannot} (byte 0xe0 at position 1: invalid continuation byte)`],
      ],
      [
        [0x61, 0xe0, 0xa0],
        ['error', `${cannot} (bytes at positions 1-2: unexpected end of data)`],
      ],
      [
        [0x61, 0xe0, 0xa0, 0x80],
        ['ok', 'a\u0800'],
      ],
      [
        [0x61, 0xed, 0xa0, 0x80],
        ['error', `${cannot} (byte 0xed at position 1: invalid continuation byte)`],
      ],
      [
        [0x61, 0xed, 0x9f, 0xbf],
        ['ok', 'a\ud7ff'],
      ],
      [
        [0x61, 0xf0, 0x90, 0x80],
        ['error', `${cannot} (bytes at positions 1-3: unexpected end of data)`],
      ],
      [
        [0x61, 0xf0, 0x8f, 0x80],
        ['error', `${cannot} (byte 0xf0 at position 1: invalid continuation byte)`],
      ],
      [
        [0x61, 0xf4, 0x90, 0x80],
        ['error', `${cannot} (byte 0xf4 at position 1: invalid continuation byte)`],
      ],
      [
        [0x61, 0xf4, 0x8f, 0xbf, 0x80, 0x7a],
        ['ok', 'a\u{10FFC0}z'],
      ],
      [
        [0x61, 0xf5],
        ['error', `${cannot} (byte 0xf5 at position 1: invalid start byte)`],
      ],
      [
        [0x61, 0xc0, 0x80],
        ['error', `${cannot} (byte 0xc0 at position 1: invalid start byte)`],
      ],
      [
        [0xef, 0xbb, 0xbf, 0x61],
        ['ok', '\ufeffa'],
      ],
      [[], ['ok', '']],
    ] as [number[], string[]][]) {
      expect(corpus).toContainEqual(bytes);
      expect([bytes, decoded(bytes)]).toEqual([bytes, answer]);
    }
    expect(mine.filter(([kind]) => kind === 'error').length).toBeGreaterThan(1000);
  });

  it('orders strings as earlier releases sort them, by code point rather than UTF-16 unit', () => {
    const words = [
      '😀-emoji',
      'Ａ-fullwidth',
      'a',
      'B',
      'é',
      'ab',
      '',
      '\u{10ffff}',
      '\uffff',
      'a b',
      'a-b',
    ];
    const expected = [
      '',
      'B',
      'a',
      'a b',
      'a-b',
      'ab',
      '\u00e9',
      '\uff21-fullwidth',
      '\uffff',
      '\u{1F600}-emoji',
      '\u{10FFFF}',
    ];
    expect([...words].sort(compareCodePoints)).toEqual(expected);
    expect([...words].sort()).not.toEqual(expected);
  });
});

describe("earlier releases' is-a-file test, which fs.existsSync is not", () => {
  it('is false where earlier releases ignore the error, and raises what they raise otherwise', () => {
    // `config-import` asked `existsSync(file) && statSync(file).isFile()`, which is false for
    // EVERY failure; earlier releases ignore only ENOENT, ENOTDIR, EBADF and ELOOP, so a dump
    // in a directory it may not search is their permission error, not "no such file".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-isfile-'));
    const locked = path.join(dir, 'locked');
    try {
      fs.writeFileSync(path.join(dir, 'f'), '[]');
      fs.mkdirSync(path.join(dir, 'd'));
      fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'dangling'));
      fs.symlinkSync(path.join(dir, 'loop'), path.join(dir, 'loop'));
      fs.symlinkSync(path.join(dir, 'f'), path.join(dir, 'link'));
      fs.mkdirSync(locked);
      fs.writeFileSync(path.join(locked, 'f'), '[]');
      fs.chmodSync(locked, 0o000);
      const targets = ['f', 'd', 'missing', 'f/child', 'dangling', 'loop', 'link', 'locked/f'].map(
        (name) => path.join(dir, name),
      );
      // Recorded as a user who may not search `locked`.
      const expected = [
        true,
        false,
        false,
        false,
        false,
        false,
        true,
        ['FileError', `${path.join(dir, 'locked', 'f')}: Permission denied`],
      ];
      const ours = targets.map((target) => {
        try {
          return pathIsFile(target);
        } catch (error) {
          return [(error as Error).name, (error as Error).message];
        }
      });
      expect(ours.slice(0, -1)).toEqual(expected.slice(0, -1));
      // Root searches any directory, so the refusal is only there for everyone else.
      expect(ours.at(-1)).toEqual(process.getuid?.() === 0 ? true : expected.at(-1));
      const lockedOutcome = ours.at(-1);
      if (process.getuid?.() !== 0)
        expect(Array.isArray(lockedOutcome) ? lockedOutcome[0] : lockedOutcome).toBe('FileError');
    } finally {
      fs.chmodSync(locked, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isTruthy, which is earlier releases' truth test", () => {
  it('agrees with earlier releases on every JSON value, a NaN and an infinity included', () => {
    const values: unknown[] = [null, false, true, 0, -0, 0.5, NaN, Infinity, -Infinity];
    values.push('', 'x', ' ', [], [0], {}, { a: 1 });
    const expected = [false, false, true, false, false, true, true, true, true];
    expected.push(false, true, true, false, true, false, true);
    expect(values.map(isTruthy)).toEqual(expected);
  });
});

describe("a JSON answer's lookups, loops, membership and hashing, as earlier releases refuse them", () => {
  it('answers or raises as earlier releases do on every JSON value', () => {
    // What the seed readback applies to what Rocket.Chat sent: a key lookup on a mapping and
    // the TypeError on anything else, a loop over a list, a string's characters or a
    // mapping's keys and the TypeError for a number, membership likewise, and a set refusing
    // a list or a mapping. `null` is null; 5.5 is a fraction, 5 an integer. Recorded per value: the
    // lookup, the lookup with a default, the fallback, the loop, membership and hashing.
    const values: unknown[] = [null, true, false, 0, 5, 5.5, '', 'ab', [], [1, 'a'], {}, { a: 1 }];
    const run = (f: () => unknown): [string, unknown] => {
      try {
        return ['ok', f()];
      } catch (error) {
        return [(error as Error).name, (error as Error).message];
      }
    };
    const ours = values.map((v) => [
      run(() => dictGetChecked(v, 'a')),
      run(() => dictGetChecked(v, 'zz', 'dflt')),
      run(() => orElse(v, 'right')),
      run(() => (isTruthy(v) ? iterateChecked(v) : [])),
      run(() => containsChecked(v, 'a')),
      run(() => (hashableKey(v) === v ? 1 : 0)),
    ]);
    expect(ours).toEqual(recorded('json_answers'));
  });
});

describe("toBigInt, which is earlier releases' integer reading without the 2**53 ceiling", () => {
  it('reads and refuses as earlier releases do, and keeps every digit', () => {
    // Earlier releases' integers are exact at any size, where a double stops at 2**53: a
    // count of 9007199254740993 read as ...992 and was quoted back as a number nobody typed.
    const texts = [
      '9007199254740993',
      '99999999999999999999',
      '-12_345_678_901_234_567_890',
      ' +٣٣ ',
      '-0',
      '1'.repeat(4300),
      '1'.repeat(4301),
      '1e3',
      '',
      '1__0',
    ];
    const ours = texts.map((t) => {
      try {
        return ['ok', String(toBigInt(t))];
      } catch (error) {
        return ['refused', (error as Error).message];
      }
    });
    expect(ours).toEqual(recorded('big_int'));
  });
});

describe('urlQuote and urlUnquote', () => {
  const TEXTS = [
    '/',
    '/?a=1&b=2',
    'a b+c',
    "!'()*;,@$",
    '~_.-',
    'café €',
    '100%',
    '%zz%4',
    '%2F%2f',
    '%C3%A9%FF%E2%82',
    '%F0%9F%98%80 😀',
    'q=%2F&x',
  ];

  it("matches earlier releases' quoting (safe '/' and '/?=&') and unquoting on every text", () => {
    expect(TEXTS.map((text) => [urlQuote(text), urlQuote(text, '/?=&'), urlUnquote(text)])).toEqual(
      recorded('url'),
    );
  });
});
