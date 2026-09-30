import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  JsonSyntaxError,
  JsonFloat,
  JsonNumber,
  decodeError,
  dumps,
  loads,
  orderedDict,
  shownLoaded,
  spelled,
} from '../../src/lib/json-text';

/**
 * What earlier releases' JSON reader and writer answered for the corpora below, recorded:
 * the decode error per CORPUS entry, the text per document and layout, the writes after
 * the edits, and each member written and represented.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'lib', 'json-text.json'), 'utf8'),
) as {
  decode_errors: ({ msg: string; pos: number; lineno: number; colno: number } | null)[];
  encoder_layouts: string[][];
  lost_layouts: string[][];
  edits: string[];
  members: string[][];
};

/**
 * Documents earlier releases' decoder has an opinion about.
 *
 * Every message in its closed set is here, plus the two shapes a customer dump actually
 * arrives in: an HTML error page from an expired share link, and a download that stopped.
 */
const CORPUS: readonly string[] = [
  '',
  '   ',
  '<html>x',
  '<html><body>Link expired</body></html>',
  '[1,2',
  '[1,2]x',
  '[{"a":1}\n,{"b"}]',
  '{',
  '{ ',
  '{"a"',
  '{"a" 1}',
  '{"a":}',
  '{"a":1,}',
  '{"a":1 "b":2}',
  '[',
  '[,]',
  '[1,]',
  '[1 2]',
  '"abc',
  '"a\tb"',
  '"a\\qb"',
  '"a\\u12"',
  '"a\\u00e9b"',
  'nul',
  'tru',
  'fals',
  '01',
  '-',
  '1.',
  '1e',
  '{"a":1}extra',
  '[[1],',
  '{"a": [1, {"b": }]}',
  '\n\n  [1,\n2',
  '{1:2}',
  "'a'",
  '[1,2,]',
  '{"a":1}\n\n\n  x',
  '[\n  1,\n  ,\n]',
  '[]',
  '{}',
  ' [1, 2, {"a": [true, false, null]}] ',
  '"\\u00e9"',
  '-1.5e10',
  '{"a":\n\n"b"}',
  '[{"_id": "x", "value": 1}]',
];

describe('the decoder error', () => {
  it('names the same fault, at the same place, as earlier releases', () => {
    // A customer dump is exactly the file that arrives wrong, and `configimport` reports
    // where by line and column. The two engines agree on neither the words nor always the
    // position: earlier releases say "Expecting value" at 1:1 where V8 says "Unexpected
    // token '<', \"<html>x\" is not valid JSON" and gives no position at all.
    const expected = RECORDED.decode_errors;
    const ours = CORPUS.map((text) => {
      try {
        loads(text);
        return null;
      } catch (error) {
        if (!(error instanceof JsonSyntaxError)) throw error;
        return {
          msg: error.msg,
          pos: error.pos,
          lineno: error.lineno,
          colno: error.colno,
        };
      }
    });
    expect(ours).toEqual(expected);
  });

  it('parses everything earlier releases parse, to the same value', () => {
    const valid = CORPUS.filter((text) => {
      try {
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    });
    expect(valid.length).toBeGreaterThan(5);
    for (const text of valid) expect(loads(text)).toEqual(JSON.parse(text));
  });

  it('renders the message the way earlier releases render it', () => {
    // The whole message is what `api --data` prints verbatim, so the assembled sentence
    // matters as much as its parts.
    const recorded = "Expecting ',' delimiter: line 1 column 5 (char 4)";
    let said = '';
    try {
      loads('[1,2');
    } catch (error) {
      said = (error as Error).message;
    }
    expect(said).toBe(recorded);
  });

  it('reads NaN, Infinity and -Infinity as earlier releases read them, and nowhere else', () => {
    // Earlier releases write them for a float that is one, so a record or a manifest they
    // wrote was not JSON to `JSON.parse`.
    const documents = [
      '{"a": NaN, "b": [Infinity, -Infinity], "c": "NaN"}',
      '[NaN]',
      'Infinity',
      '{"NaN": 1, "x": "-Infinity"}',
      '[1, NaN, {"deep": [-Infinity]}]',
    ];
    // What earlier releases read, each non-finite float tagged with its spelling.
    const nan = ['float', 'nan'];
    const recorded = [
      {
        a: nan,
        b: [
          ['float', 'inf'],
          ['float', '-inf'],
        ],
        c: 'NaN',
      },
      [nan],
      ['float', 'inf'],
      { NaN: 1, x: '-Infinity' },
      [1, nan, { deep: [['float', '-inf']] }],
    ];
    const tag = (value: unknown): unknown => {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        return ['float', Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf'];
      }
      if (Array.isArray(value)) return value.map(tag);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tag(v)]));
      }
      return value;
    };
    expect(documents.map((d) => tag(loads(d)))).toEqual(recorded);
    // Still the decoder's own error for what earlier releases refuse: `nan` is not the constant.
    expect(() => loads('[nan]')).toThrow('Expecting value: line 1 column 2 (char 1)');
  });

  it("refuses a leading BOM in earlier releases' words, and leaves any later one to the scanner", () => {
    // Earlier releases check a text for U+FEFF before they decode anything; the scanner saw
    // the BOM as a stray character and said "Expecting value", which drops the one hint that
    // names the file's fault.
    const documents = [
      '\uFEFF[]',
      '\uFEFF',
      '\uFEFF\uFEFF[1]',
      '\uFEFF{"a": 1}',
      ' \uFEFF[]',
      '[\uFEFF]',
    ];
    const bom = 'Unexpected UTF-8 BOM: line 1 column 1 (char 0)';
    const recorded = [
      bom,
      bom,
      bom,
      bom,
      ...Array<string>(2).fill('Expecting value: line 1 column 2 (char 1)'),
    ];
    const ours = documents.map((text) => {
      try {
        loads(text);
        return null;
      } catch (error) {
        if (!(error instanceof JsonSyntaxError)) throw error;
        return error.message;
      }
    });
    expect(ours).toEqual(recorded);
    expect(ours[0]).toBe('Unexpected UTF-8 BOM: line 1 column 1 (char 0)');
  });

  it('re-raises the engine error when the scanner finds nothing wrong', () => {
    // A disagreement between the two parsers would be a real finding, so it is surfaced as
    // itself rather than dressed up as one of earlier releases' messages.
    expect(decodeError('[1, 2]')).toBeNull();
    expect(decodeError('{"a": 1}')).toBeNull();
  });
});

describe('the encoder', () => {
  /**
   * Documents as TEXT, read by `loads` as earlier releases read them with their own, so the
   * encoder is handed the values theirs was -- NaN, a lone surrogate and a float's spelling cannot
   * be a JS literal. Integral floats (`1.0`, `-0.0`) are the next describe's: `loads` keeps
   * their spelling beside the value, and a value built here is `JsonFloat`'s business.
   */
  const DOCUMENTS: readonly string[] = [
    '{"X": "\\u00e9", "owner": "jos\\u00e9", "cmd": "chown --to Jos\\u00e9"}',
    '"cannot run \\u2014 wait"',
    '"\\u0085 \\u2028 \\u2029 \\ufeff \\u00a0 \\u65e5\\u672c\\u8a9e \\ud83d\\ude00 \\ud800x \\udfff"',
    '"\\u0000\\u0001\\u001f\\u007f \\" \\\\ / \\b\\f\\n\\r\\t"',
    '{"x": NaN, "y": Infinity, "z": -Infinity, "s": 1e-07, "m": 5e-05, "k": 0.0001}',
    '[1.5, 0.30000000000000004, 123.456, -2.5e-10, 1e+100, 1.7976931348623157e+308, 5e-324]',
    '{"b": 1, "a": [true, false, null, {"d": {}, "c": []}], "\\ud83d\\ude80": 2, "\\uffff": 3}',
    '[]',
    '{}',
    '[[], {}, [[1, 2], {"k": [3]}]]',
    '{"n": 0, "neg": -7, "big": 9007199254740991}',
    '"plain ascii, nothing to escape"',
  ];
  const LAYOUTS: readonly [string, Record<string, unknown>][] = [
    ['the default', {}],
    ['indented by 2', { indent: 2 }],
    ['indented by 0', { indent: 0 }],
    ['compact separators', { separators: [',', ':'] }],
    ['sorted keys', { sortKeys: true }],
    ['indented by 2, sorted keys', { indent: 2, sortKeys: true }],
  ];

  it('writes what earlier releases write, byte for byte, in every layout a writer here uses', () => {
    // The record, the event log and the envelope all go through this. `JSON.stringify`
    // wrote raw UTF-8, `null` for NaN and `1e-7` for `1e-07`, so a file rewritten here
    // changed bytes earlier releases had written.
    const ours = DOCUMENTS.map((d) => LAYOUTS.map(([, options]) => dumps(loads(d), options)));
    expect(ours).toEqual(RECORDED.encoder_layouts);
  });

  it('refuses a non-finite number and a cycle as earlier releases refuse them, in their words', () => {
    const recorded = [
      'Out of range float values are not JSON compliant: nan',
      'Out of range float values are not JSON compliant: inf',
      'Out of range float values are not JSON compliant: -inf',
      'Circular reference detected',
    ];
    const circular: unknown[] = [];
    circular.push(circular);
    const said = [
      () => dumps({ n: Number.NaN }, { allowNan: false }),
      () => dumps({ n: Number.POSITIVE_INFINITY }, { allowNan: false }),
      () => dumps({ n: new JsonFloat(Number.NEGATIVE_INFINITY) }, { allowNan: false }),
      () => dumps(circular),
    ].map((write) => {
      try {
        write();
        return null;
      } catch (error) {
        expect((error as Error).name).toBe('InvalidValue');
        return (error as Error).message;
      }
    });
    expect(said).toEqual(recorded);
  });

  it('keeps the .0 of a float the caller marked, and hands default what JSON cannot spell', () => {
    expect(dumps([new JsonFloat(2), new JsonFloat(1e-7), 2])).toBe('[2.0, 1e-07, 2]');
    // A `default` that stringifies is the event log's: a logger that throws is the defect it
    // is written against. Without one, what JSON.stringify left out stays out.
    expect(dumps({ a: 10n, b: undefined }, { default: (v) => String(v) })).toBe(
      '{"a": "10", "b": "undefined"}',
    );
    expect(dumps({ a: 1, b: undefined, c: [undefined] })).toBe('{"a": 1, "c": [null]}');
    expect(() => dumps({ a: 10n })).toThrow('Object of type bigint is not JSON serializable');
  });
});

describe('what a double and a JavaScript object lose of a document', () => {
  // Earlier releases keep a mapping's keys in document order and an integer has no ceiling
  // there; a JavaScript object enumerates index-like keys first and a double is exact only
  // to 2**53. So a
  // record or a body this side read and wrote back came out as other bytes: `{"b": 1,
  // "2": 2}` as `{"2": 2, "b": 1}`, 12345678901234567890 as 12345678901234567000 -- and
  // `1e16`, a float, as the int 10000000000000000.
  const DOCUMENTS: readonly string[] = [
    '{"b": 1, "2": 2}',
    '{"env": {"b": "1", "10": "2", "a": "3", "2": "4"}}',
    '{"seed": {"n": 12345678901234567890}}',
    '{"x": NaN, "y": 1e-07, "z": 1e16, "big": 123456789012345678901234567890}',
    '{"runtime": "docker", "env": {"FOO": "bar"}, "10": "numeric-key", "b": 1}',
    '[3.0, -0.0, 1E2, 2.5e1, 1e400, -1e400, 0.5, 1e21, 1e22, 100.0]',
    '[1000000000000000000000, 9007199254740992, 9007199254740993, -9007199254740993, -0, 0]',
    '{"a": 1, "a": 2, "1": 3, "1": 4, "0": 5}',
    '{"__proto__": {"9": 1, "x": 2}, "4294967295": 1, "4294967294": 2, "01": 3, "-1": 4}',
    '{"\\u0031": 1, "a": 2, "\\u0030": 3}',
    '[[{"5": 5, "z": [1.0, {"3": 3.5e1, "q": 12345678901234567890123}]}]]',
    '{"k": [NaN, Infinity, 2.0, -Infinity]}',
    '{"deep": {"1": {"2": {"b": 1, "3": [1e16]}}}}',
  ];
  const LAYOUTS: readonly Record<string, unknown>[] = [
    {},
    { indent: 2 },
    { separators: [',', ':'] },
    { sortKeys: true },
  ];

  it('writes back what earlier releases read, in every layout, and reads it as JSON.parse does', () => {
    expect(DOCUMENTS.map((d) => LAYOUTS.map((options) => dumps(loads(d), options)))).toEqual(
      RECORDED.lost_layouts,
    );
    // And every reader of the value reads what it read before: plain objects, plain doubles.
    for (const text of DOCUMENTS.filter((d) => !/NaN|Infinity/u.test(d))) {
      expect(loads(text)).toEqual(JSON.parse(text));
    }
    expect(loads('{"seed": {"n": 12345678901234567890}}')).toEqual({
      seed: { n: 12345678901234567000 },
    });
  });

  it('follows the mapping through the edits a writer makes to it, and through a copy', () => {
    // A replaced member is written as itself, a removed key is gone, a new key goes last --
    // and `orderedDict` is the copy earlier releases make, where a spread was JavaScript's
    // order and nothing else. (Not a new key that looks like an index: no writer here adds
    // one. `Spelling` says why.) Recorded: earlier releases' writes of the edited mapping,
    // of its copy after two more edits, and of a copy of the document as read.
    const text =
      '{"runtime": "docker", "10": "n", "b": 1, "seed": {"n": 12345678901234567890}, ' +
      '"f": 1e16, "g": 3.0, "l": [9007199254740993, 2.0], "2": {"9": 1, "a": 2}}';
    const extra = loads(text) as Record<string, unknown>;
    extra.owner = 'bob';
    extra.b = 2;
    extra.g = 4;
    delete extra.runtime;
    (extra.l as unknown[]).push(1.5);
    const copy = orderedDict(extra);
    copy.namespace = 'x';
    copy.f = 5;
    expect([dumps(extra), dumps(copy), dumps(orderedDict(loads(text)))]).toEqual(RECORDED.edits);
    // A copy is otherwise the spread it replaces: the same own keys, `__proto__` among them.
    const odd = JSON.parse('{"__proto__": 1, "a": 2}') as unknown;
    expect(Object.keys(orderedDict(odd))).toEqual(['__proto__', 'a']);
    for (const value of [null, undefined, 'ab', ['x'], 5])
      expect(orderedDict(value)).toEqual({ ...(value as object) });
  });

  it('gives the writer of a bare number its spelling, and every other reader the number', () => {
    // A document that is one number has no container to keep its spelling beside, so the
    // caller that writes it back asks for a `JsonNumber` (`api -d 12345678901234567890`).
    const roots = [
      '12345678901234567890',
      '-9007199254740993',
      '3.0',
      '-0.0',
      '1e16',
      '5',
      '1e400',
    ];
    // What earlier releases wrote back for each root they read.
    const recorded = [
      '12345678901234567890',
      '-9007199254740993',
      '3.0',
      '-0.0',
      '1e+16',
      '5',
      'Infinity',
    ];
    expect(roots.map((d) => dumps(loads(d, { spelledRoot: true })))).toEqual(recorded);
    expect(loads('12345678901234567890', { spelledRoot: true })).toBeInstanceOf(JsonNumber);
    expect(loads('5', { spelledRoot: true })).toBe(5);
    expect(loads('12345678901234567890')).toBe(12345678901234567000);
  });

  it('keeps the spelling of a member taken out of its container, for dumps and shownLoaded alike', () => {
    // The spelling is kept beside the CONTAINER, so a member copied out of it -- a record's
    // top-level field, a dump's setting value -- lost it: `3100.0` was rewritten `3100`, and
    // a dump's `5.0`, `-0.0` and `1e+16` were printed and sent as `5`, `0` and
    // `10000000000000000`. The shown text of what loads built is the same table read by the
    // other writer: earlier releases spell a float in JSON as they show it. Recorded: each
    // member as earlier releases wrote it and showed it, and each document shown.
    const members = [
      '5.0',
      '-0.0',
      '1e16',
      '1E5',
      '0e0',
      '3100.0',
      '12345678901234567890',
      '-9007199254740993',
      '1.5',
      '7',
      '1e21',
      '1e400',
      '"x"',
      'null',
      'true',
      '[1.0, null, {"x": 2.0}]',
    ];
    const held = members.map((m) => spelled(loads(`{"v": ${m}}`) as object, 'v'));
    expect([
      held.map((v) => dumps(v)),
      held.map((v) => shownLoaded(v)),
      DOCUMENTS.map((d) => shownLoaded(loads(d))),
    ]).toEqual(RECORDED.members);
    // A member that needs nothing is the member itself, so every other reader is unchanged.
    expect(spelled({ v: 5 }, 'v')).toBe(5);
    expect(held[0]).toBeInstanceOf(JsonFloat);
    expect(held[6]).toBeInstanceOf(JsonNumber);
    expect(held[8]).toBe(1.5);
  });
});
