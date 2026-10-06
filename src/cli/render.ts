/**
 * The terminal prose the human renderers share: the boxed key/value panel, and one line.
 *
 * It writes what the CLI has always written when stdout is not a terminal -- no colour,
 * everything on stdout. It sits below the handler registry and every handler leaf so both can
 * draw the same panel; two copies of the box arithmetic is how the right-hand border came to
 * stop lining up in the first place.
 */
import { stripText } from '../lib/format';

import type { CliIo } from './app';
import { type ConsoleEnvironment, PROCESS_CONSOLE, cellLen } from './error-panel';

/** A string's length in code points, not UTF-16 units. */
function width(value: string): number {
  return [...value].length;
}

/** `value` padded with spaces on the right to `size`, counted the way `width` counts. */
export function ljust(value: string, size: number): string {
  return value + ' '.repeat(Math.max(0, size - width(value)));
}

/**
 * A titled ASCII box of label/value rows. An empty label prints its value full-width.
 *
 * THE WIDTH IS THE WIDEST CELL AS PRINTED, label padding included. An earlier version measured
 * each row as `key + value + 2` and then padded every key to the widest one, so any row
 * whose value was long beside a SHORT key overflowed the right-hand border -- measured on
 * `tls-status`, where `issuer  CN = houston local CA` pushed through it. ASCII on purpose:
 * box-drawing glyphs are East-Asian "ambiguous" width and render double-wide in some
 * terminals.
 */
export function writePanel(
  io: CliIo,
  title: string,
  rows: readonly (readonly [string, string])[],
): void {
  const labelWidth = Math.max(0, ...rows.filter(([label]) => label !== '').map(([l]) => width(l)));
  const cells = rows.map(([label, value]) =>
    label === '' ? value : `${ljust(label, labelWidth)}  ${value}`,
  );
  const inner = Math.max(width(title) + 2, ...cells.map(width));
  io.writeOut(`+- ${title} ${'-'.repeat(inner - width(title) + 1)}+\n`);
  for (const cell of cells) io.writeOut(`|  ${ljust(cell, inner)}  |\n`);
  io.writeOut(`+${'-'.repeat(inner + 4)}+\n`);
}

/** One line of prose on stdout: a `✓` line, a warning, a note, a hint or a plain echo. */
export function say(io: CliIo, message: string): void {
  io.writeOut(`${message}\n`);
}

function width_(value: string): number {
  return [...value].length;
}

/**
 * `lines`, already wrapped to `inner` columns, under a titled top border.
 *
 * Unlike `writePanel`, the box does not grow to its content: every box one command draws has
 * the SAME inner width, so a column of them lines up whatever each one holds. A title wider
 * than the box still gets one dash, and a line wider than it pushes through the right-hand
 * border -- `ljust` pads, it never cuts -- exactly as the established box does.
 */
export function writeBox(io: CliIo, title: string, lines: readonly string[], inner: number): void {
  io.writeOut(`+- ${title} ${'-'.repeat(Math.max(1, inner - width(title) - 1))}+\n`);
  for (const line of lines) io.writeOut(`| ${ljust(line, inner)} |\n`);
  io.writeOut(`+${'-'.repeat(Math.max(0, inner + 2))}+\n`);
}

/** How the wrap is configured, where it departs from the defaults. */
export interface WrapOptions {
  readonly initialIndent?: string;
  readonly subsequentIndent?: string;
  /** Whether a line may end after a hyphen inside a word: true by default. */
  readonly breakOnHyphens?: boolean;
}

// The word-separator pattern, piece by piece, under its established names. Two traps in
// the translation. The wrap's whitespace is ASCII only (`'\t\n\x0b\x0c\r '`), NOT `\s`,
// which takes a no-break space that must stay inside a word. And a word character is
// Unicode (a letter, a number or `_`), where JavaScript's `\w` is ASCII even under the `u`
// flag -- so `café-bar` would stop being a hyphenated word.
const TW_WS = '[\\t\\n\\v\\f\\r ]';
const TW_NWS = '[^\\t\\n\\v\\f\\r ]';
const WORD_CHARS = '[\\p{L}\\p{N}_]';
/** A word character or one of `!"'&.,?`. */
const TW_WORD_PUNCT = '[\\p{L}\\p{N}_!"\'&.,?]';
/** A letter: a word character that is not a decimal digit (`Nd`). */
const TW_LETTER = '[\\p{L}\\p{Nl}\\p{No}_]';

const WORDSEP = new RegExp(
  // any whitespace
  `(${TW_WS}+` +
    // em-dash between words
    `|(?<=${TW_WORD_PUNCT})-{2,}(?=${WORD_CHARS})` +
    // word, possibly hyphenated
    `|${TW_NWS}+?(?:` +
    // hyphenated word
    `-(?:(?<=${TW_LETTER}{2}-)|(?<=${TW_LETTER}-${TW_LETTER}-))(?=${TW_LETTER}-?${TW_LETTER})` +
    // end of word
    `|(?=${TW_WS}|$)` +
    // em-dash
    `|(?<=${TW_WORD_PUNCT})(?=-{2,}${WORD_CHARS})` +
    `))`,
  'u',
);
const WORDSEP_SIMPLE = new RegExp(`(${TW_WS}+)`, 'u');

/** Tabs expanded to the next multiple of 8, the column restarting after `\n` or `\r`. */
function expandTabs(text: string): string {
  let out = '';
  let column = 0;
  for (const char of text) {
    if (char === '\t') {
      const pad = 8 - (column % 8);
      out += ' '.repeat(pad);
      column += pad;
    } else {
      out += char;
      column = char === '\n' || char === '\r' ? 0 : column + 1;
    }
  }
  return out;
}

/** The error a bad width is: a RangeError named `InvalidValue`. */
function valueError(message: string): Error {
  const error = new RangeError(message);
  error.name = 'InvalidValue';
  return error;
}

/**
 * `text` wrapped at `width` into lines, with every option not given at its default.
 *
 * AN EXACT COPY, NOT A LOOK-ALIKE, because `houston presets` is compared byte for byte with
 * the established output, and the defaults are where a look-alike goes wrong: breaking on
 * hyphens is ON -- measured on the `s3_minio` preset at COLUMNS=100, where a line ends on
 * `'houston-` and the next starts on `uploads'` -- tabs expand to the next multiple of 8
 * rather than to 8 spaces, and a word longer than a line is cut after its last hyphen that
 * fits when it has one. The notes pass `breakOnHyphens: false` (see `info`'s notes).
 *
 * Throws for a width below 1: `houston presets` at `COLUMNS=4` is `invalid width 0 (must be
 * > 0)`, unhandled, and exit 1, as it has always been.
 */
export function wrapWords(text: string, width: number, options: WrapOptions = {}): string[] {
  const initial = options.initialIndent ?? '';
  const subsequent = options.subsequentIndent ?? '';
  const hyphens = options.breakOnHyphens ?? true;
  // Tabs expanded and whitespace made spaces, then the text split into chunks.
  const munged = expandTabs(text).replace(/[\t\n\v\f\r]/gu, ' ');
  const chunks = munged.split(hyphens ? WORDSEP : WORDSEP_SIMPLE).filter((chunk) => chunk !== '');
  if (width <= 0) throw valueError(`invalid width ${String(width)} (must be > 0)`);
  // The chunks reversed, so the next one is always the last.
  chunks.reverse();
  const top = (): string => chunks[chunks.length - 1] as string;
  const lines: string[] = [];
  while (chunks.length > 0) {
    const line: string[] = [];
    let used = 0;
    const indent = lines.length > 0 ? subsequent : initial;
    const room = width - width_(indent);
    if (stripText(top()) === '' && lines.length > 0) chunks.pop();
    while (chunks.length > 0 && used + width_(top()) <= room) {
      used += width_(top());
      line.push(chunks.pop() as string);
    }
    if (chunks.length > 0 && width_(top()) > room) {
      // AN EMPTY CHUNK IS DROPPED HERE, where the established wrap loops forever: only a
      // line whose indent is wider than the width gets this far with one, it holds nothing
      // yet, and cutting "" leaves "". Once a line is out, the next pass drops that "" as
      // whitespace -- the same result as this -- but before the first, nothing does, and
      // measured, wrapping `' '` at 2 under a four-space initial indent never returns there.
      // No caller here passes an initial indent, so no established output is changed.
      if (top() === '') {
        chunks.pop();
        continue;
      }
      // A word longer than the line: at least one character per line, even under a wide indent.
      const space = room < 1 ? 1 : room - used;
      const chunk = [...top()];
      let end = space;
      if (hyphens && chunk.length > space) {
        // The last hyphen before the room runs out, and none in an empty range.
        const hyphen = space > 0 ? chunk.lastIndexOf('-', space - 1) : -1;
        if (hyphen > 0 && chunk.slice(0, hyphen).some((char) => char !== '-')) end = hyphen + 1;
      }
      line.push(chunk.slice(0, end).join(''));
      chunks[chunks.length - 1] = chunk.slice(end).join('');
    }
    if (line.length > 0 && stripText(line[line.length - 1] as string) === '') line.pop();
    if (line.length > 0) lines.push(indent + line.join(''));
  }
  return lines;
}

/** `_ASCII_MAP`: the terminal notes print ASCII, so a pasted command survives any terminal. */
export function asciiOf(text: string): string {
  const map: Readonly<Record<string, string>> = {
    '—': '-',
    '–': '-',
    '…': '...',
    '’': "'",
    '‘': "'",
    '“': '"',
    '”': '"',
    '→': '->',
    '←': '<-',
    '·': '-',
    ' ': ' ',
  };
  return [...text].map((char) => map[char] ?? char).join('');
}

// ---------------------------------------------------------------------------- tables and tone

/** An SGR sequence, the only kind of escape these renderers ever write. */
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');

/** A cell's width on the screen: terminal cells, the colour escapes not counted. */
function visibleCells(cell: string): number {
  return cellLen(cell.replace(SGR, ''));
}

/**
 * A column table: a header row and the rows under it, each column as wide as its widest
 * cell, two spaces between columns, no trailing spaces.
 *
 * TERMINAL CELLS, not code points: `ljust` counts points, and a CJK name is two cells per
 * point, so a column padded by points wandered right of its header on a real screen. A
 * painted cell is measured by what is visible, so colour never moves a column.
 */
export function writeTable(
  io: CliIo,
  head: readonly string[],
  rows: readonly (readonly string[])[],
): void {
  const widths = head.map((title, column) =>
    Math.max(visibleCells(title), ...rows.map((row) => visibleCells(row[column] ?? ''))),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => {
        const pad = column === cells.length - 1 ? 0 : (widths[column] ?? 0) - visibleCells(cell);
        return cell + ' '.repeat(Math.max(0, pad));
      })
      .join('  ')
      .replace(/ +$/u, '');
  io.writeOut(`${line(head)}\n`);
  for (const row of rows) io.writeOut(`${line(row)}\n`);
}

export type Tone = 'green' | 'amber' | 'red';

const TONES: Readonly<Record<Tone, string>> = { green: '32', amber: '33', red: '31' };

/**
 * Whether stdout wants colour: a terminal, unless NO_COLOR; never a pipe, unless FORCE_COLOR.
 *
 * The usage-error panel stays uncoloured whatever this says (the owner's standing
 * decision, in error-panel.ts); this is for the cluster renderers, which 1.x printed in
 * colour and 2.0 did not. Jest is not a terminal, so every pinned output stays as it is.
 */
export function colourWanted(host: ConsoleEnvironment = PROCESS_CONSOLE): boolean {
  const env = host.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  // `FORCE_COLOR=0` (and `false`) means OFF, as Node and every colour library read it; any
  // other set value forces it on. It read "set" as on, so FORCE_COLOR=0 turned colour on.
  if (env.FORCE_COLOR !== undefined) return !['', '0', 'false'].includes(env.FORCE_COLOR);
  return host.isatty(1);
}

/** `text` in one of the three tones, when the terminal wants it; the bare text otherwise. */
export function paint(
  text: string,
  tone: Tone,
  host: ConsoleEnvironment = PROCESS_CONSOLE,
): string {
  return colourWanted(host) ? `\u001b[${TONES[tone]}m${text}\u001b[0m` : text;
}
