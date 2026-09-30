/**
 * `src/cli/error-panel.ts` against the panels earlier releases drew.
 *
 * It is held to what earlier releases printed for a usage error with no command context,
 * recorded, so what it prints is exactly the panel a usage error draws: the console it
 * builds, the width it reads from COLUMNS, the wrap, the fold, the box.
 * The corpus is chosen to reach every branch the module claims -- words that fit, words that
 * fold, double-width and zero-width characters, emoji joined by ZWJ and widened by VS16,
 * tabs, the control codes the renderer strips, and lines a break leaves ending in a space.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CELL_WIDTHS, NARROW_TO_WIDE } from '../../src/cli/cell-widths';
import {
  cellLen,
  consoleWidth,
  errorPanel,
  formatterColumns,
  printed,
  consoleColumns,
} from '../../src/cli/error-panel';

/**
 * What earlier releases drew, recorded case by case in the order the tests below build their
 * cases: the Error panel for each message at each width (COLUMNS set to the width), and each
 * printed line at each console width.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cli', 'error-panel.json'), 'utf8'),
) as {
  panels: { message: string; width: number; panel: string }[];
  printed: { text: string; width: number; printed: string }[];
};

const sha256 = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const MESSAGES = [
  'No such option: --bogus',
  'No such option: --js (Possible options: --json)',
  "Invalid value for '--port': 'abc' is not a valid int.",
  "No such command 'lst'. Did you mean 'list', 'cluster'?",
  'Got unexpected extra argument(s) (a b c d e f g h i j k l m n o p q r s t u v w x y z)',
  `No such option: --${'x'.repeat(130)}`,
  'No such option: --名前はとても長いオプションです',
  'No such option: --café and --naïve',
  'emoji \u{1F468}‍\u{1F469}‍\u{1F467} family and ❤️ heart and #️',
  'tab\there\tand\t\tthere',
  'bell\x07 back\x08 vt\x0b ff\x0c cr\x0d end',
  'two\nlines\n\nand a blank',
  '   leading spaces and trailing   ',
  'a-very-long-hyphenated-word-that-does-not-fit-on-any-line-at-narrow-widths ok',
  ' ',
  '',
];
const WIDTHS = [10, 13, 20, 37, 50, 80, 100, 150];

const HOST = (env: Record<string, string>, ttys: number[] = [], columns = 91) => ({
  env,
  isatty: (fd: number) => ttys.includes(fd),
  columns: (fd: number) => (ttys.includes(fd) ? columns : null),
});

describe('this renderer draws what earlier releases drew', () => {
  test('the Error panel, byte for byte, at every width', () => {
    const cases = MESSAGES.flatMap((message) => WIDTHS.map((width) => [message, width] as const));
    const expected = RECORDED.panels;
    expect(expected).toHaveLength(cases.length);
    cases.forEach(([message, width], at) => {
      const ours = errorPanel(message, consoleWidth(HOST({ COLUMNS: String(width) })));
      const recorded = expected[at];
      expect([message, width, ours]).toEqual([recorded?.message, recorded?.width, recorded?.panel]);
    });
  });

  test('a printed line -- the Usage and Try lines -- wraps where earlier releases wrapped it', () => {
    const texts = [
      'Usage: houston config-import [OPTIONS] {settings_file}',
      "Try 'houston skill install --help' for help.",
      'Usage: houston users [OPTIONS] [action] [name] [role]\n' +
        '                     [role-continued]',
      ...MESSAGES,
    ];
    const cases = texts.flatMap((text) => WIDTHS.map((width) => [text, width] as const));
    const expected = RECORDED.printed;
    expect(expected).toHaveLength(cases.length);
    cases.forEach(([text, width], at) => {
      const recorded = expected[at];
      expect([text, width, printed(text, width)]).toEqual([
        recorded?.text,
        recorded?.width,
        recorded?.printed,
      ]);
    });
  });

  test('cellLen measures the same strings as earlier releases did', () => {
    const texts = [...MESSAGES, '\u0000', '\u007f\u009f', '\u{1F1FA}\u{1F1F8}', 'a‍b'];
    const expected = [23, 47, 53, 54, 86, 148, 48, 34, 35, 15, 22, 19, 33, 77, 1, 0, 0, 0, 2, 1];
    texts.forEach((text, at) => expect([text, cellLen(text)]).toEqual([text, expected[at]]));
  });

  test('the width table is the one earlier releases measured with', () => {
    // The whole table as earlier releases loaded it, pinned as its size and the sha256 of its
    // JSON -- the inclusive ranges, and the sorted code points a VS16 widens -- with the edges
    // spelled out, so a change says where it is.
    const table = {
      widths: {
        count: 464,
        sha256: '464decc0ba39936b2ff58bc31990639f627d1d938d2ff121f60fbf8f8b5e8298',
      },
      wide: {
        count: 213,
        sha256: 'e4b862ea5fe7f65f7169d2933299482ef1048b48854092b788603103504a4b36',
      },
    };
    const wide = [...NARROW_TO_WIDE].sort((a, b) => a - b);
    expect({ count: CELL_WIDTHS.length, sha256: sha256(CELL_WIDTHS) }).toEqual(table.widths);
    expect({ count: wide.length, sha256: sha256(wide) }).toEqual(table.wide);
    // The first and last ranges; combining marks; Hangul Jamo; the zero-width space to the
    // right-to-left mark, ZWJ among them; the variation selectors; the fullwidth forms; the
    // emoticons; and the tag and variation-selector supplement at the top of the space.
    expect(CELL_WIDTHS[0]).toEqual([0, 0, 0]);
    expect(CELL_WIDTHS[CELL_WIDTHS.length - 1]).toEqual([917504, 921599, 0]);
    for (const range of [
      [768, 879, 0],
      [4352, 4447, 2],
      [8203, 8207, 0],
      [12272, 12329, 2],
      [65024, 65039, 0],
      [65281, 65376, 2],
      [128507, 128591, 2],
    ]) {
      expect(CELL_WIDTHS).toContainEqual(range);
    }
    // `❤` is in no range -- one cell -- and is widened only by a VS16.
    expect(CELL_WIDTHS.find(([from, to]) => from <= 0x2764 && 0x2764 <= to)).toBeUndefined();
    expect(wide.slice(0, 10)).toEqual([35, 42, 48, 49, 50, 51, 52, 53, 54, 55]);
    expect(wide.slice(-5)).toEqual([128740, 128741, 128745, 128752, 128755]);
    expect(wide).toContain(0x2764);
  });

  test('the console width follows the order of precedence earlier releases used', () => {
    // TERMINAL_WIDTH, then COLUMNS; a dumb TERMINAL is 80 unless LINES is set too; then the
    // first of fds 0, 1, 2 that is a terminal; then 80.
    expect(consoleWidth(HOST({}))).toBe(80);
    expect(consoleWidth(HOST({ COLUMNS: '120' }))).toBe(120);
    expect(consoleWidth(HOST({ COLUMNS: 'wide' }))).toBe(80);
    expect(consoleWidth(HOST({ TERMINAL_WIDTH: '60', COLUMNS: '120' }))).toBe(60);
    expect(consoleWidth(HOST({ TERMINAL_WIDTH: '6_0' }))).toBe(60);
    expect(consoleWidth(HOST({}, [0]))).toBe(91);
    expect(consoleWidth(HOST({}, [1], 70))).toBe(70);
    expect(consoleWidth(HOST({ COLUMNS: '100', TERM: 'dumb' }, [2]))).toBe(80);
    expect(consoleWidth(HOST({ COLUMNS: '100', LINES: '9', TERM: 'dumb' }, [2]))).toBe(100);
    expect(consoleWidth(HOST({ COLUMNS: '100', TERM: 'dumb' }))).toBe(100);
    expect(consoleWidth(HOST({ COLUMNS: '100', TERM: 'dumb', FORCE_COLOR: '1' }))).toBe(80);
    expect(consoleWidth(HOST({ COLUMNS: '100', TERM: 'dumb', TTY_COMPATIBLE: '1' }))).toBe(80);
    expect(
      consoleWidth(HOST({ COLUMNS: '100', TERM: 'dumb', _TYPER_FORCE_DISABLE_TERMINAL: '1' }, [2])),
    ).toBe(100);
  });

  test("the help formatter reads COLUMNS, then stdout's terminal, then 80", () => {
    expect(formatterColumns(HOST({}))).toBe(80);
    expect(formatterColumns(HOST({ COLUMNS: ' 40 ' }))).toBe(40);
    expect(formatterColumns(HOST({ COLUMNS: '0' }, [1], 55))).toBe(55);
    expect(formatterColumns(HOST({}, [0], 55))).toBe(80);
  });

  test('the terminal size with a 90x24 fallback -- `houston presets` -- asks what earlier releases asked', () => {
    // Measured by earlier releases off a terminal, so each fallback is the 90 passed in.
    // Earlier releases read any Unicode decimal digit: fullwidth `７０` and Arabic-Indic `٦٠`
    // drew 66- and 56-column boxes there and 84-column ones here.
    const values = [
      '100',
      ' 60 ',
      '6_0',
      '100abc',
      '1e2',
      '0',
      '-3',
      'wide',
      '',
      '７０',
      '٦٠',
      '٦_0',
      '𝟝𝟘',
      '²⁰',
    ];
    const recorded = [100, 60, 60, 90, 90, 90, 90, 90, 90, 70, 60, 60, 50, 90];
    expect(values.map((COLUMNS) => consoleColumns(90, HOST({ COLUMNS })))).toEqual(recorded);
    expect(consoleColumns(90, HOST({}))).toBe(90);
    expect(consoleColumns(90, HOST({}, [1], 70))).toBe(70);
    expect(consoleColumns(90, HOST({}, [1], 0))).toBe(90);
  });
});
