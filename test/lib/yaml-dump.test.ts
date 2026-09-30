import { createHash } from 'node:crypto';

import { JsonFloat } from '../../src/lib/float-text';
import { safeDump } from '../../src/lib/yaml-dump';

/*
 * This YAML writer against the text earlier releases wrote, byte for byte, over a generated
 * corpus.
 *
 * A document is built from a small tagged JSON, because JSON alone cannot carry what the
 * writers are handed: a mapping with non-string keys, a set, bytes, a float that is NaN,
 * infinite or -0, a date, and one object met twice (which the serializer anchors). Earlier
 * releases decoded the same text into their own values and dumped them; what they wrote is
 * recorded as the sha256 of the JSON array of every document's text, beside a handful of
 * documents' texts spelled out -- the edge cases -- so a failure still names one.
 */

/** The sha256 of `JSON.stringify` of every document's text, in order. */
function corpusHash(texts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(texts)).digest('hex');
}

type Encoded =
  | null
  | boolean
  | number
  | string
  | Encoded[]
  | { $t: 'dict'; v: [Encoded, Encoded][] }
  | { $t: 'set'; v: Encoded[] }
  | { $t: 'bytes'; v: string }
  | { $t: 'float'; v: string }
  | { $t: 'int'; v: string }
  | { $t: 'date'; v: string }
  | { $t: 'datetime'; v: string }
  | { $t: 'def'; id: number; v: Encoded }
  | { $t: 'ref'; id: number };

/** The decoding: a dict is a plain object while its keys allow one, else a Map. */
function decode(value: Encoded, refs: Map<number, unknown>, dates: Map<Date, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => decode(item, refs, dates));
  if (value === null || typeof value !== 'object') return value;
  switch (value.$t) {
    case 'def': {
      const body = value.v;
      if (Array.isArray(body)) {
        const out: unknown[] = [];
        refs.set(value.id, out);
        for (const item of body) out.push(decode(item, refs, dates));
        return out;
      }
      if (body !== null && typeof body === 'object' && body.$t === 'dict') {
        const out = new Map<unknown, unknown>();
        refs.set(value.id, out);
        for (const [key, item] of body.v)
          out.set(decode(key, refs, dates), decode(item, refs, dates));
        return out;
      }
      const made = decode(body, refs, dates);
      refs.set(value.id, made);
      return made;
    }
    case 'ref':
      return refs.get(value.id);
    case 'dict': {
      const pairs = value.v.map(([key, item]) => [
        decode(key, refs, dates),
        decode(item, refs, dates),
      ]);
      // A JavaScript object enumerates an integer-like key first; only a Map keeps the order.
      const plain = pairs.every(
        ([key]) => typeof key === 'string' && !/^(?:0|[1-9][0-9]*)$/.test(key),
      );
      if (!plain) return new Map(pairs as [unknown, unknown][]);
      const out: Record<string, unknown> = {};
      for (const [key, item] of pairs)
        Object.defineProperty(out, key as string, {
          value: item,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      return out;
    }
    case 'set':
      return new Set(value.v.map((item) => decode(item, refs, dates)));
    case 'bytes':
      return Buffer.from(value.v, 'base64');
    case 'int':
      return BigInt(value.v);
    case 'float': {
      const float = Number(
        value.v === 'nan'
          ? NaN
          : value.v === 'inf'
            ? Infinity
            : value.v === '-inf'
              ? -Infinity
              : value.v,
      );
      // A float a number cannot say is one is handed over as the writers are handed it.
      return Number.isInteger(float) ? new JsonFloat(float) : float;
    }
    case 'date':
    case 'datetime': {
      const date = new Date(0);
      dates.set(date, value.$t === 'date' ? value.v : value.v.replace('T', ' '));
      return date;
    }
  }
}

function ourDumps(docs: readonly Encoded[]): string[] {
  return docs.map((doc) => {
    const dates = new Map<Date, string>();
    try {
      return safeDump(decode(doc, new Map(), dates), { dateText: (date) => dates.get(date) ?? '' });
    } catch (error) {
      return `!error ${(error as Error).name}`;
    }
  });
}

/** A small deterministic generator, so a failure names a document that exists next run. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const int = (below: number): number => Math.floor(next() * below);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  return { next, int, pick };
}

/** Characters every rule of the scalar analysis and the three quoted writers turns on. */
const ALPHABET = [
  'a',
  'Z',
  '0',
  '1',
  ' ',
  '-',
  ':',
  '#',
  "'",
  '"',
  '\\',
  '\n',
  '\t',
  '\r',
  '?',
  ',',
  '[',
  ']',
  '{',
  '}',
  '!',
  '&',
  '*',
  '|',
  '>',
  '%',
  '@',
  '`',
  '.',
  '~',
  '=',
  '<',
  '_',
  'e',
  'y',
  'N',
  'é',
  ' ',
  '\u0085',
  ' ',
  ' ',
  '﻿',
  '\u001c',
  '\u0000',
  '\u007f',
  '퟿',
  '',
  '�',
  '￾',
  '\u{1F600}',
  '\u{10FFFF}',
  '\u0007',
];

/** Texts the resolver reads as something other than a string, and their near misses. */
const LOOKALIKES = [
  '1e8',
  '0o17',
  '1e-3',
  '-.5',
  '+.5',
  '1e+8',
  '12e03',
  '1.5e3',
  '5e21234',
  '0:0',
  '1:30',
  '1:30.5',
  '190:20:30',
  '0b101',
  '0x1F',
  '0x_',
  '0777',
  '1_000',
  '1__0.5',
  '._5',
  '.5',
  '1.',
  '-0',
  '+0',
  '.inf',
  '-.Inf',
  '+.INF',
  '.NaN',
  '.nan',
  'nan',
  'inf',
  'y',
  'n',
  'Y',
  'N',
  'yes',
  'No',
  'ON',
  'off',
  'True',
  'FALSE',
  'tRue',
  '~',
  'null',
  'Null',
  'NULL',
  '',
  '2026-01-01',
  '2026-1-1',
  '2026-1-1 1:00:00',
  '2001-12-14t21:59:43.10-05:00',
  '2026-01-01 10:00:00 +5',
  '=',
  '<<',
  '<',
  '==',
  '!',
  '&',
  '*',
  'true\n',
  'yes\n',
  'null\n',
  '1\n',
  '---',
  '...',
  '--- a',
  '...a',
  '- a',
  '-a',
  ':a',
  'a:',
  'a: b',
  'a #b',
  'a#b',
  '#a',
  '? a',
  '?a',
  "it's",
  "'q'",
  '"q"',
  '@a',
  '`a',
  '%a',
  ' a',
  'a ',
  '\na',
  'a\n',
  'a\n\nb',
  ' \n',
  '\n \n',
  'a b',
  '﻿a',
  'a\tb',
  '12345678901234567890',
];

/** Words of every length, so a long scalar crosses the 80th column at every offset. */
function sentence(g: ReturnType<typeof generator>, target: number): string {
  const words: string[] = [];
  let length = 0;
  while (length < target) {
    const word = 'abcdefghijklmnop'.slice(0, 1 + g.int(14));
    const special = g.next() < 0.15 ? g.pick(['é', "'", '\t', '"', '\\', '#', ':']) : '';
    const text = g.next() < 0.5 ? word + special : special + word;
    words.push(text);
    length += text.length + 1;
  }
  let out = '';
  for (const [at, word] of words.entries()) {
    out += at === 0 ? word : ' '.repeat(g.next() < 0.1 ? 2 + g.int(3) : 1) + word;
  }
  if (g.next() < 0.1) out = ` ${out}`;
  if (g.next() < 0.1) out = `${out} `;
  if (g.next() < 0.15) out = out.replace(' ', '\n');
  if (g.next() < 0.05) out = out.replace(' ', ' \n');
  return out;
}

function scalarText(g: ReturnType<typeof generator>): string {
  const roll = g.next();
  if (roll < 0.3) return g.pick(LOOKALIKES);
  if (roll < 0.55) {
    let out = '';
    for (let at = 1 + g.int(6); at > 0; at -= 1) out += g.pick(ALPHABET);
    return out;
  }
  if (roll < 0.85) return sentence(g, 40 + g.int(220));
  return 'k'.repeat(100 + g.int(60));
}

function scalar(g: ReturnType<typeof generator>): Encoded {
  const roll = g.next();
  if (roll < 0.6) return scalarText(g);
  if (roll < 0.66) return g.int(2) === 0;
  if (roll < 0.7) return null;
  if (roll < 0.76)
    return g.pick([0, 1, -1, 3000, 27017, 2 ** 31, -(2 ** 40), 12345678901234567000]);
  if (roll < 0.78)
    return { $t: 'int', v: g.pick(['10000000000000000000000', '-123456789012345678901234567890']) };
  // Only floats a number holds as a float: an integral one (1e16, 1.5e300) is an int here.
  if (roll < 0.86)
    return g.pick([0.5, -1.25, 1e-7, 6.8523015e5, 1.5e-300, 2.5e-10, 0.1, 1e15 + 0.5]);
  if (roll < 0.9) return { $t: 'float', v: g.pick(['nan', 'inf', '-inf', '-0.0']) };
  if (roll < 0.94)
    return {
      $t: 'bytes',
      v: Buffer.from(scalarText(g) + 'x'.repeat(g.int(90))).toString('base64'),
    };
  if (roll < 0.97) return { $t: 'date', v: g.pick(['2026-01-01', '0999-12-31', '2024-02-29']) };
  return {
    $t: 'datetime',
    v: g.pick([
      '2026-01-01T10:00:00',
      '2026-01-01T10:00:00.500000+02:00',
      '2001-12-14T21:59:43.100000-05:00',
    ]),
  };
}

function key(g: ReturnType<typeof generator>, typed: boolean): Encoded {
  if (typed && g.next() < 0.3) {
    return g.pick<Encoded>([
      1,
      0,
      -7,
      1.5,
      true,
      false,
      null,
      { $t: 'float', v: 'inf' },
      { $t: 'date', v: '2026-01-01' },
    ]);
  }
  if (g.next() < 0.1)
    return g.pick(['', '10', '2', '0', "''", 'k'.repeat(126), 'k'.repeat(123), 'a\nb']);
  return scalarText(g);
}

function node(
  g: ReturnType<typeof generator>,
  depth: number,
  shared: { id: number; seen: Encoded[] },
): Encoded {
  const roll = g.next();
  if (depth > 3 || roll < 0.45) return scalar(g);
  if (roll < 0.5 && shared.seen.length > 0) return { $t: 'ref', id: g.int(shared.seen.length) };
  let made: Encoded;
  if (roll < 0.53) made = g.int(2) === 0 ? [] : { $t: 'dict', v: [] };
  else if (roll < 0.75)
    made = Array.from({ length: 1 + g.int(4) }, () => node(g, depth + 1, shared));
  else if (roll < 0.78) made = { $t: 'set', v: [scalarText(g)] };
  else {
    const typed = g.next() < 0.2;
    const seen = new Set<string>();
    const pairs: [Encoded, Encoded][] = [];
    for (let at = 1 + g.int(5); at > 0; at -= 1) {
      const k = key(g, typed);
      // Keys earlier releases hold equal (1 and True, 0 and False, a repeat) collapse there.
      const identity = JSON.stringify(typeof k === 'boolean' ? Number(k) : k);
      if (seen.has(identity)) continue;
      seen.add(identity);
      pairs.push([k, node(g, depth + 1, shared)]);
    }
    made = { $t: 'dict', v: pairs };
  }
  if ((Array.isArray(made) || made.$t === 'dict') && g.next() < 0.1) {
    const id = shared.seen.length;
    shared.seen.push(made);
    return { $t: 'def', id, v: made };
  }
  return made;
}

/** The three documents each lookalike is written in: a mapping, a line long enough to fold, bare. */
function lookalikeDocs(text: string): Encoded[] {
  return [
    {
      $t: 'dict',
      v: [
        [text, text],
        ['x', [text, { $t: 'dict', v: [[text, 1]] }]],
      ],
    },
    {
      $t: 'dict',
      v: [['k', `${text} ${'w'.repeat(70)} ${text} ${'v'.repeat(30)} ${text}`]],
    },
    text,
  ];
}

describe('safeDump against the YAML earlier releases write', () => {
  it('writes every one- and two-character string as a key and as a value, as earlier releases do', () => {
    const texts = [...ALPHABET];
    for (const first of ALPHABET) for (const second of ALPHABET) texts.push(first + second);
    const docs: Encoded[] = texts.map((text) => ({ $t: 'dict', v: [[text, text]] }));
    docs.push(...texts.map((text) => [text]));
    expect(corpusHash(ourDumps(docs))).toBe(
      'b839d49858a6811051ccfde5144aaee30bb622578ccb8f3454712980615972dd',
    );
    // Each text as earlier releases wrote it: as a key with itself as the value, and as the
    // one item of a list.
    const spots: [string, string, string][] = [
      ["'", "'''': ''''\n", "- ''''\n"],
      [':', "':': ':'\n", "- ':'\n"],
      ['\n', "? '\n\n  '\n: '\n\n  '\n", "- '\n\n  '\n"],
      ['\u0085', '? "\\N"\n: "\\N"\n', '- "\\N"\n'],
      ['\ufeff', '"\\uFEFF": "\\uFEFF"\n', '- "\\uFEFF"\n'],
      ['\u{1F600}', '"\\U0001F600": "\\U0001F600"\n', '- "\\U0001F600"\n'],
      ['\u0000', '"\\0": "\\0"\n', '- "\\0"\n'],
      ['y', 'y: y\n', '- y\n'],
      ['- ', "'- ': '- '\n", "- '- '\n"],
      ['\u00e9', '"\\xE9": "\\xE9"\n', '- "\\xE9"\n'],
      ['?,', '?,: ?,\n', '- ?,\n'],
    ];
    for (const [text, asKey, asItem] of spots) {
      expect([text, ...ourDumps([{ $t: 'dict', v: [[text, text]] }, [text]])]).toEqual([
        text,
        asKey,
        asItem,
      ]);
    }
  });

  it('writes each lookalike, and a line of each long enough to fold, as earlier releases do', () => {
    const docs: Encoded[] = [];
    for (const text of LOOKALIKES) docs.push(...lookalikeDocs(text));
    expect(corpusHash(ourDumps(docs))).toBe(
      '3248d99d7235760327c3cac92d508836ddc2c7bfd2801c295c6fdbe57b94ff36',
    );
    // Each lookalike's three documents as earlier releases wrote them.
    const spots: [string, string, string, string][] = [
      [
        '1e8',
        '1e8: 1e8\nx:\n- 1e8\n- 1e8: 1\n',
        'k: 1e8 wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww 1e8\n  vvvvvvvvvvvvvvvvvvvvvvvvvvvvvv 1e8\n',
        '1e8\n...\n',
      ],
      [
        '190:20:30',
        "'190:20:30': '190:20:30'\nx:\n- '190:20:30'\n- '190:20:30': 1\n",
        'k: 190:20:30 wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww\n  190:20:30 vvvvvvvvvvvvvvvvvvvvvvvvvvvvvv 190:20:30\n',
        "'190:20:30'\n",
      ],
      [
        '2026-01-01',
        "'2026-01-01': '2026-01-01'\nx:\n- '2026-01-01'\n- '2026-01-01': 1\n",
        'k: 2026-01-01 wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww\n  2026-01-01 vvvvvvvvvvvvvvvvvvvvvvvvvvvvvv 2026-01-01\n',
        "'2026-01-01'\n",
      ],
      [
        'yes',
        "'yes': 'yes'\nx:\n- 'yes'\n- 'yes': 1\n",
        'k: yes wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww yes\n  vvvvvvvvvvvvvvvvvvvvvvvvvvvvvv yes\n',
        "'yes'\n",
      ],
      [
        '~',
        "'~': '~'\nx:\n- '~'\n- '~': 1\n",
        'k: ~ wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww ~ vvvvvvvvvvvvvvvvvvvvvvvvvvvvvv\n  ~\n',
        "'~'\n",
      ],
      [
        '',
        "? ''\n: ''\nx:\n- ''\n- ? ''\n  : 1\n",
        "k: ' wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww  vvvvvvvvvvvvvvvvvvvvvvvvvvvvvv '\n",
        "''\n",
      ],
      [
        "it's",
        "it's: it's\nx:\n- it's\n- it's: 1\n",
        "k: it's wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww it's\n  vvvvvvvvvvvvvvvvvvvvvvvvvvvvvv it's\n",
        "it's\n...\n",
      ],
      [
        '\ufeffa',
        '"\\uFEFFa": "\\uFEFFa"\nx:\n- "\\uFEFFa"\n- "\\uFEFFa": 1\n',
        'k: "\\uFEFFa wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww\\\n  \\ \\uFEFFa vvvvvvvvvvvvvvvvvvvvvvvvvvvvvv \\uFEFFa"\n',
        '"\\uFEFFa"\n',
      ],
      [
        '0x_',
        "'0x_': '0x_'\nx:\n- '0x_'\n- '0x_': 1\n",
        'k: 0x_ wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww 0x_\n  vvvvvvvvvvvvvvvvvvvvvvvvvvvvvv 0x_\n',
        "'0x_'\n",
      ],
    ];
    for (const [text, ...written] of spots) {
      expect([text, ...ourDumps(lookalikeDocs(text))]).toEqual([text, ...written]);
    }
  });

  it('writes 3000 generated documents as earlier releases do', () => {
    const g = generator(20260926);
    const docs: Encoded[] = [];
    for (let at = 0; at < 3000; at += 1) {
      const shared = { id: 0, seen: [] as Encoded[] };
      const roll = g.next();
      docs.push(roll < 0.85 ? node(g, 0, shared) : roll < 0.95 ? [node(g, 1, shared)] : scalar(g));
    }
    const ours = ourDumps(docs);
    expect(corpusHash(ours)).toBe(
      'b532daf163e2da5873b3111877bcecd426e2dda00cebec22bb4a6f04bea03aca',
    );
    // Documents that reach an edge -- a date, bytes, a float's text, a big int, -0, a set,
    // nested empties, an anchor, a folded quoted line, NaN and -inf -- as earlier releases
    // wrote them, by their place in the corpus.
    const spots: [number, string][] = [
      [23, '- 2026-01-01\n'],
      [39, '!!binary |\n  QA==\n'],
      [61, '1.0e-07\n...\n'],
      [94, '10000000000000000000000\n...\n'],
      [379, '-0.0\n...\n'],
      [609, '!!set\nY: null\n'],
      [1409, '- - []\n  - []\n'],
      [2366, '- !!set\n  "\\uE000}\\\\": null\n- tRue: &id001 {}\n- *id001\n'],
      [
        2526,
        "'abcdef  abcdefghijklm abcde :abcdef abcdefghi    #abcdefghijkl abcdefghijk a a''\n  abcd abcde abc'\n",
      ],
      [2561, '- .nan\n'],
      [2736, '- -.inf\n'],
    ];
    for (const [at, written] of spots) {
      expect({ at, doc: JSON.stringify(docs[at]), text: ours[at] }).toEqual({
        at,
        doc: JSON.stringify(docs[at]),
        text: written,
      });
    }
    // The corpus reaches every style and shape it is there to reach.
    const all = ours.join('');
    for (const shown of [
      "'",
      '"',
      '\\\n',
      '? ',
      '!!binary |',
      '!!set',
      '&id001',
      '*id001',
      '[]',
      '{}',
      '...\n',
      '.nan',
      '-0.0',
    ]) {
      expect(all).toContain(shown);
    }
  });

  it('writes a JsonFloat as the float it wraps, as a key and as a value, and never anchors it', () => {
    // config.yaml's reader hands the writer an integral float it read (`ratio: 3.0`, a `3.0:`
    // key) as a JsonFloat, and earlier releases write a float back; a number here is an int.
    // A float is never aliased, however often one object is met.
    const float = (v: string): Encoded => ({ $t: 'float', v });
    const docs: Encoded[] = [
      {
        $t: 'dict',
        v: [
          [float('3.0'), 'float-key'],
          [float('-0.0'), 'negative-zero-key'],
          ['ratio', float('3.0')],
          ['big', float('1e16')],
          ['huge', float('1e300')],
          ['neg', float('-0.0')],
          ['shared', { $t: 'def', id: 0, v: float('5.0') }],
          ['again', { $t: 'ref', id: 0 }],
          ['list', [float('2.0'), 2, { $t: 'ref', id: 0 }]],
        ],
      },
      float('1.0'),
      [float('0.0'), float('-7.0')],
    ];
    // What earlier releases wrote for each document, recorded.
    const recorded = [
      '3.0: float-key\n-0.0: negative-zero-key\nratio: 3.0\nbig: 1.0e+16\nhuge: 1.0e+300\nneg: -0.0\nshared: 5.0\nagain: 5.0\nlist:\n- 2.0\n- 2\n- 5.0\n',
      '1.0\n...\n',
      '- 0.0\n- -7.0\n',
    ];
    expect(ourDumps(docs)).toEqual(recorded);
    expect(recorded[0]).toContain('3.0: float-key\n-0.0: negative-zero-key\nratio: 3.0\n');
    expect(recorded[0]).toContain('big: 1.0e+16\n');
    expect(recorded[0]).toContain('shared: 5.0\nagain: 5.0\n');
  });

  it('anchors an object met twice as the serializer does, and never a string or bytes', () => {
    const list = [1];
    const map = { k: 'v' };
    const date = new Date(0);
    const doc = { a: list, b: map, c: list, d: [map, map], e: date, f: date, s: 'same', t: 'same' };
    const text = safeDump(doc, { dateText: () => '2026-01-01' });
    expect(text).toBe(
      'a: &id001\n- 1\nb: &id002\n  k: v\nc: *id001\nd:\n- *id002\n- *id002\ne: &id003 2026-01-01\n' +
        'f: *id003\ns: same\nt: same\n',
    );
    const recursive: unknown[] = [];
    recursive.push(recursive);
    expect(safeDump(recursive)).toBe('&id001\n- *id001\n');
  });
});
