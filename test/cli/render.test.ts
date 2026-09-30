/**
 * The boxed panel against the panels earlier releases drew, byte for byte off a terminal --
 * and, below it, the fixed-width box and `wrapWords` against the boxes and the wrapping
 * earlier releases printed.
 *
 * An earlier version measured each row as `key + value + 2` and then padded every key to the
 * widest one, so a long value beside a SHORT label pushed through the right-hand border --
 * visible on every `info`, `env` and `tls-status` panel whose longest value was not also on
 * its longest label. Code points, not UTF-16 units: an emoji or a CJK name is one character
 * wide in the count.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { wrapWords, writeBox, writePanel, type WrapOptions } from '../../src/cli/render';

type Wrapped = { lines: string[] } | { error: string };

/**
 * What earlier releases printed, recorded in the order each test below builds its cases: each
 * panel by its title, each wrap with its text, width and options, and each box.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cli', 'render.json'), 'utf8'),
) as {
  panels: { title: string; printed: string }[];
  wrap: ({ text: string; width: number; options: WrapOptions } & Wrapped)[];
  boxes: { title: string; width: number; printed: string }[];
};

const PANELS: [string, [string, string][]][] = [
  [
    'TLS: w',
    [
      ['Endpoint', 't1.example.com:443'],
      ['Issuer', 'CN = houston local CA'],
      ['Valid for', 't1.example.com'],
      ['Expires', 'Nov 23 2026'],
    ],
  ],
  ['a title far wider than any of its rows', [['a', 'b']]],
  [
    'full width',
    [
      ['', 'a value printed without a label, wider than the rest'],
      ['k', 'v'],
    ],
  ],
  [
    'code points',
    [
      ['名前', '値 😀'],
      ['longer label', 'x'],
    ],
  ],
  ['empty', []],
];

it('draws every panel exactly as earlier releases did', () => {
  expect(RECORDED.panels.map((panel) => panel.title)).toEqual(PANELS.map(([title]) => title));
  const recorded = RECORDED.panels.map((panel) => panel.printed);
  const ours = PANELS.map(([title, rows]) => {
    let text = '';
    writePanel({ writeOut: (value) => (text += value), writeErr: () => undefined }, title, rows);
    return text;
  });
  expect(ours).toEqual(recorded);
});

/**
 * `wrapWords` against the wrapping earlier releases printed, for `houston presets`.
 * The corpus reaches what the notes' former look-alike (split on JavaScript's `\s` and
 * expanding a tab to eight spaces) got wrong at the defaults:
 * a hyphenated word broken after its hyphen, the em-dash rules, a long word cut after its
 * last hyphen that fits, tabs that expand to a column rather than to eight spaces, a
 * no-break space that earlier releases keep inside a word, a lone NEL a line end drops,
 * Unicode letters around a hyphen, and an indent wider than the line.
 */
const WRAP_TEXTS = [
  'Simulates an air-gapped workspace with no Rocket.Chat Cloud connectivity.',
  "MinIO S3-compatible storage wired as RC's file upload backend (bucket 'houston-uploads').",
  'a well-known multi-instance-horizontal-scaling tail, re-run e.g. x-y and 5-10 or x-1-y',
  'em--dash between words, --flag, word---word, a--1 and trailing-- dashes --',
  '/tmp/-home-laborant-rc-repro/some-very-long-hyphenated-path-name-here/and-more-of-it',
  '----leading-hyphens-then-a-long-word-that-will-not-fit anywhere',
  `${'x'.repeat(50)} tail`,
  'tab\tat\tcolumns\t\tand\na newline\r\vand\fform feed',
  'café-bar naïve-x 名前-とても 😀-emoji',
  'no break space stays inside a word, x \u0085 y and \u001cseparator',
  '   leading and trailing spaces   ',
  '',
  ' ',
];
const WRAP_WIDTHS = [1, 2, 5, 7, 10, 13, 20, 36, 56, 84];
const WRAP_OPTIONS: WrapOptions[] = [
  {},
  { subsequentIndent: ' '.repeat(16) },
  { initialIndent: '    ', subsequentIndent: '  ', breakOnHyphens: false },
];

/**
 * Where earlier releases' wrapping never returns: an initial indent wider than the width
 * and text that starts with whitespace (measured: `' '` at width 2 with a four-space initial
 * indent). Those cases have no recorded answer, so they are held to terminating instead.
 */
function neverReturnedBefore(text: string, width: number, options: WrapOptions): boolean {
  return width > 0 && width < (options.initialIndent ?? '').length && /^[\t\n\v\f\r ]/u.test(text);
}

it('wraps as earlier releases wrapped, byte for byte, at every width and option', () => {
  const cases = WRAP_TEXTS.flatMap((text) =>
    [...WRAP_WIDTHS, 0, -1].flatMap((width) =>
      WRAP_OPTIONS.map((options) => [text, width, options] as const),
    ),
  ).filter(([text, width, options]) => !neverReturnedBefore(text, width, options));
  expect(RECORDED.wrap).toHaveLength(cases.length);
  cases.forEach(([text, width, options], at) => {
    let ours: Wrapped;
    try {
      ours = { lines: wrapWords(text, width, options) };
    } catch (error) {
      // The CLI prints `name: message`, so the class name earlier releases printed is what
      // has to match.
      ours = { error: `${(error as Error).name}: ${(error as Error).message}` };
    }
    const recorded = RECORDED.wrap[at];
    const answer: Wrapped | undefined =
      recorded === undefined
        ? undefined
        : 'lines' in recorded
          ? { lines: recorded.lines }
          : { error: recorded.error };
    expect([text, width, options, ours]).toEqual([
      recorded?.text,
      recorded?.width,
      recorded?.options,
      answer,
    ]);
  });
});

it('returns where earlier releases would not, dropping only the whitespace it cannot place', () => {
  const indent = { initialIndent: '    ', subsequentIndent: '  ', breakOnHyphens: false };
  expect(neverReturnedBefore(' ', 2, indent)).toBe(true);
  expect(wrapWords(' ', 2, indent)).toEqual([]);
  expect(wrapWords('   ab cd', 1, indent)).toEqual(['    a', '  b', '  c', '  d']);
});

it('draws every box exactly as earlier releases did', () => {
  const boxes: [string, string[], number][] = [
    ['airgapped', ['Simulates an air-gapped', 'workspace'], 36],
    ['a title far wider than the box it sits on', ['x'], 10],
    ['wide line', ['a line longer than its box pushes through the border'], 12],
    ['code points', ['名前 😀', ''], 20],
    ['empty', [], 5],
    ['one', ['a'], 1],
  ];
  expect(RECORDED.boxes.map((box) => [box.title, box.width])).toEqual(
    boxes.map(([title, , width]) => [title, width]),
  );
  const recorded = RECORDED.boxes.map((box) => box.printed);
  const ours = boxes.map(([title, lines, width]) => {
    let text = '';
    writeBox(
      { writeOut: (value) => (text += value), writeErr: () => undefined },
      title,
      lines,
      width,
    );
    return text;
  });
  expect(ours).toEqual(recorded);
});
