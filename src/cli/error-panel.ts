/**
 * What a usage error is drawn with: the console's width, word wrapping in terminal cells,
 * and the rounded `Error` panel.
 *
 * The frozen CLI reports a usage error as one block: the Usage line, a
 * `Try '<command> --help' for help.` line, then the message inside a panel as wide as the
 * console. The owner's decision is that the TypeScript CLI prints those bytes exactly as
 * earlier releases did, uncoloured -- so the width, the wrap and the point where a message
 * is cut are the established ones. Every function here reproduces one step of that
 * rendering exactly; nothing is a lookalike.
 *
 * LEFT OUT, on purpose: colour and styles (the owner chose uncoloured output; on a terminal
 * the established output also carries SGR codes and this does not), legacy Windows consoles,
 * Jupyter, the ASCII box substituted on a non-UTF-8 stream, and the `UNICODE_VERSION`
 * override -- the width table is the latest one, which is what applies when that is unset.
 */
import * as tty from 'node:tty';

import { toInt } from '../lib/format';

import { CELL_WIDTHS, NARROW_TO_WIDE } from './cell-widths';

// ---------------------------------------------------------------------------- cells

/** Characters known to be one cell wide without a table lookup. */
const SINGLE_CELL_RANGES: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0xa0, 0xac],
  [0xae, 0x2ff],
  [0x370, 0x482],
  [0x2500, 0x25fc],
  [0x2800, 0x28ff],
];

const ZWJ = 0x200d;
const VS16 = 0xfe0f;

function codes(text: string): number[] {
  return Array.from(text, (ch) => ch.codePointAt(0) as number);
}

function fromCodes(points: readonly number[]): string {
  return String.fromCodePoint(...points);
}

function isSingleCell(point: number): boolean {
  return SINGLE_CELL_RANGES.some(([start, end]) => point >= start && point <= end);
}

/** A code point's width: 0, 1 or 2 cells. */
export function characterCells(point: number): number {
  if ((point && point < 32) || (point >= 0x7f && point < 0xa0)) return 0;
  const last = CELL_WIDTHS[CELL_WIDTHS.length - 1] as readonly [number, number, number];
  if (point > last[1]) return 1;
  let lower = 0;
  let upper = CELL_WIDTHS.length - 1;
  while (lower <= upper) {
    const index = (lower + upper) >> 1;
    const [start, end, width] = CELL_WIDTHS[index] as readonly [number, number, number];
    if (point < start) upper = index - 1;
    else if (point > end) lower = index + 1;
    else return width;
  }
  return 1;
}

/** The cells `text` occupies, zero-width joiners and VS16 included. */
export function cellLen(text: string): number {
  return cellLenOf(codes(text));
}

function cellLenOf(points: readonly number[]): number {
  if (points.every(isSingleCell)) return points.length;
  if (!points.includes(ZWJ) && !points.includes(VS16)) {
    return points.reduce((sum, point) => sum + characterCells(point), 0);
  }
  let total = 0;
  let last: number | null = null;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index] as number;
    if (point === ZWJ) {
      // The joiner AND the character it joins are skipped: the count advances twice here.
      index += 1;
      continue;
    }
    if (point === VS16) {
      if (last !== null) {
        total += NARROW_TO_WIDE.has(last) ? 1 : 0;
        last = null;
      }
      continue;
    }
    const width = characterCells(point);
    if (width) {
      last = point;
      total += width;
    }
  }
  return total;
}

type Span = [start: number, end: number, cells: number];

/** One span per grapheme, covering every code point. */
function splitGraphemes(points: readonly number[]): Span[] {
  const spans: Span[] = [];
  let index = 0;
  let last: number | null = null;
  while (index < points.length) {
    const point = points[index] as number;
    if (point === ZWJ || point === VS16) {
      if (spans.length === 0) {
        spans.push([index, index + 1, 0]);
        index += 1;
        continue;
      }
      const previous = spans[spans.length - 1] as Span;
      if (point === ZWJ) {
        index += index < points.length - 1 ? 2 : 1;
        spans[spans.length - 1] = [previous[0], index, previous[2]];
      } else {
        index += 1;
        let cells = previous[2];
        if (last !== null && NARROW_TO_WIDE.has(last)) {
          last = null;
          cells += 1;
        }
        spans[spans.length - 1] = [previous[0], index, cells];
      }
      continue;
    }
    const width = characterCells(point);
    if (width) {
      last = point;
      spans.push([index, index + 1, width]);
    } else if (spans.length > 0) {
      const previous = spans[spans.length - 1] as Span;
      spans[spans.length - 1] = [previous[0], index + 1, previous[2]];
    } else {
      spans.push([index, index + 1, 0]);
    }
    index += 1;
  }
  return spans;
}

/** `text` in pieces of at most `width` cells. */
function chopCells(points: readonly number[], width: number): number[][] {
  // The established rendering fails outright on a zero width; a console that narrow draws
  // nothing useful either way, and this must not loop.
  if (width < 1) return [[...points]];
  if (points.every(isSingleCell)) {
    const out: number[][] = [];
    for (let at = 0; at < points.length; at += width) out.push(points.slice(at, at + width));
    return out;
  }
  const lines: number[][] = [];
  let size = 0;
  let offset = 0;
  for (const [start, , cells] of splitGraphemes(points)) {
    if (size + cells > width) {
      lines.push(points.slice(offset, start));
      offset = start;
      size = 0;
    }
    size += cells;
  }
  if (size) lines.push(points.slice(offset));
  return lines;
}

/** A crop: the longest prefix within `total` cells. */
function cropCells(points: readonly number[], total: number): number[] {
  if (points.every(isSingleCell)) return points.slice(0, total);
  if (total <= 0) return [];
  const out: number[] = [];
  let size = 0;
  for (const [start, end, cells] of splitGraphemes(points)) {
    if (size + cells > total) {
      // A double-width character cut in half becomes a space.
      if (size < total) out.push(0x20);
      break;
    }
    out.push(...points.slice(start, end));
    size += cells;
  }
  return out;
}

// -------------------------------------------------------------------------- wrapping

/**
 * What the wrap treats as whitespace: TAB through CR, the separators 0x1C-0x1F, space, NEL,
 * and every Unicode space, line and paragraph separator.
 */
const SPACE_CHARS = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000,
]);

/** A line's words: `\s*\S+\s*` matched repeatedly from the start, `\s` being `SPACE_CHARS`. */
function words(points: readonly number[]): [start: number, word: number[]][] {
  const out: [number, number[]][] = [];
  let at = 0;
  while (at < points.length) {
    const start = at;
    while (at < points.length && SPACE_CHARS.has(points[at] as number)) at += 1;
    if (at === points.length) break;
    while (at < points.length && !SPACE_CHARS.has(points[at] as number)) at += 1;
    while (at < points.length && SPACE_CHARS.has(points[at] as number)) at += 1;
    out.push([start, points.slice(start, at)]);
  }
  return out;
}

function rstripped(points: readonly number[]): number[] {
  let end = points.length;
  while (end > 0 && SPACE_CHARS.has(points[end - 1] as number)) end -= 1;
  return points.slice(0, end);
}

/** The code point offsets to break `text` at, a word wider than `width` folded. */
function divideLine(points: readonly number[], width: number): number[] {
  const breaks: number[] = [];
  let offset = 0;
  for (const [begin, word] of words(points)) {
    let start = begin;
    const wordLength = cellLenOf(rstripped(word));
    const remaining = width - offset;
    if (remaining >= wordLength) {
      offset += cellLenOf(word);
    } else if (wordLength > width) {
      const folded = chopCells(word, width);
      folded.forEach((line, index) => {
        if (start) breaks.push(start);
        if (index === folded.length - 1) offset = cellLenOf(line);
        else start += line.length;
      });
    } else if (offset && start) {
      breaks.push(start);
      offset = cellLenOf(word);
    }
  }
  return breaks;
}

/** BEL, BS, VT, FF and CR, which are removed from the text on the way in. */
const STRIPPED = new Set([0x07, 0x08, 0x0b, 0x0c, 0x0d]);

function stripControlCodes(text: string): string {
  return Array.from(text)
    .filter((ch) => !STRIPPED.has(ch.codePointAt(0) as number))
    .join('');
}

/** Tabs expanded at 8: each tab to a space, then out to the next multiple of eight. */
function expandTabs(points: readonly number[]): number[] {
  if (!points.includes(0x09)) return [...points];
  const out: number[] = [];
  let part: number[] = [];
  let position = 0;
  for (const point of points) {
    part.push(point);
    if (point === 0x09) {
      part[part.length - 1] = 0x20;
      position += cellLenOf(part);
      const remainder = position % 8;
      if (remainder) {
        for (let pad = 0; pad < 8 - remainder; pad += 1) part.push(0x20);
        position += 8 - remainder;
      }
      out.push(...part);
      part = [];
    }
  }
  out.push(...part);
  return out;
}

/**
 * `text` wrapped at `width` -- no justification, a word wider than the line folded -- as
 * its lines. A line may end in a space: whitespace a break leaves at the end of a line is
 * kept unless the line is longer than `width`.
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of stripControlCodes(text).split('\n')) {
    const points = expandTabs(codes(raw));
    const offsets = divideLine(points, width);
    const bounds = [0, ...offsets, points.length];
    for (let at = 0; at < bounds.length - 1; at += 1) {
      let line = points.slice(bounds[at], bounds[at + 1]);
      if (line.length > width) {
        const trailing = line.length - rstripped(line).length;
        line = line.slice(0, line.length - Math.min(trailing, line.length - width));
      }
      if (cellLenOf(line) > width) line = cropCells(line, width);
      out.push(fromCodes(line));
    }
  }
  return out;
}

/** `text` printed at `width`: each wrapped line and a newline. */
export function printed(text: string, width: number): string {
  return wrap(text, width)
    .map((line) => `${line}\n`)
    .join('');
}

/** A line padded with spaces, or cropped, to exactly `width` cells. */
function fitCells(line: string, width: number): string {
  const points = codes(line);
  const size = cellLenOf(points);
  if (size > width) return fromCodes(cropCells(points, width));
  return line + ' '.repeat(width - size);
}

/**
 * The boxed error panel printed at `width`: the ROUNDED box, the `Error` title on the left
 * and padded by one space each side, the message wrapped inside one space of padding on
 * each side.
 */
export function errorPanel(message: string, width: number): string {
  const title = ' Error ';
  const inner = width - 2;
  let top: string;
  if (width <= 4) top = `╭${'─'.repeat(Math.max(0, inner))}╮`;
  else {
    // The title left-aligned in `width - 4`: cropped to the room, then rule.
    const room = width - 4;
    const shown = cellLen(title) > room ? fromCodes(cropCells(codes(title), room)) : title;
    top = `╭─${shown}${'─'.repeat(room - cellLen(shown))}─╮`;
  }
  const body = wrap(message, Math.max(0, inner - 2)).map(
    (line) => `│ ${fitCells(line, Math.max(0, inner - 2))} │`,
  );
  return `${[top, ...body, `╰${'─'.repeat(Math.max(0, inner))}╯`].join('\n')}\n`;
}

// ---------------------------------------------------------------------------- width

/** What the stderr console needs to know about the process it runs in. */
export interface ConsoleEnvironment {
  readonly env: NodeJS.ProcessEnv;
  /** Whether a file descriptor is a terminal. */
  readonly isatty: (fd: number) => boolean;
  /** A terminal file descriptor's columns, or null where they cannot be read. */
  readonly columns: (fd: number) => number | null;
}

function terminalColumns(fd: number): number | null {
  if (!tty.isatty(fd)) return null;
  if (fd === 1 && process.stdout.isTTY) return process.stdout.columns;
  if (fd === 2 && process.stderr.isTTY) return process.stderr.columns;
  // Nothing in Node sizes a terminal on stdin, so a write stream is opened on it just long
  // enough to ask. This only runs on the way out of a usage error.
  try {
    const stream = new tty.WriteStream(fd);
    const columns = stream.columns;
    stream.destroy();
    return columns;
  } catch {
    return null;
  }
}

export const PROCESS_CONSOLE: ConsoleEnvironment = {
  env: process.env,
  isatty: (fd) => tty.isatty(fd),
  columns: terminalColumns,
};

const DIGITS = /^[0-9]+$/u;

/** Whether stderr counts as a terminal, the environment's overrides decided first. */
function isTerminal(host: ConsoleEnvironment): boolean {
  const env = host.env;
  if (env._TYPER_FORCE_DISABLE_TERMINAL) return false;
  if (env.GITHUB_ACTIONS || env.FORCE_COLOR || env.PY_COLORS) return true;
  if (env.TTY_COMPATIBLE === '0') return false;
  if (env.TTY_COMPATIBLE === '1') return true;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '';
  return host.isatty(2);
}

/**
 * The width a usage error is drawn at, on stderr.
 *
 * `TERMINAL_WIDTH`, else `COLUMNS`, fixes it -- but only wins outright together with
 * `LINES`; otherwise a dumb terminal is 80 first. Without either, the size of the first of
 * stdin, stdout and stderr that is a terminal, and 80 when none is. The terminal size is
 * read from STDIN first, so `houston up --bogus 2>err.txt` at a terminal is as wide as that
 * terminal.
 */
export function consoleWidth(host: ConsoleEnvironment = PROCESS_CONSOLE): number {
  const env = host.env;
  const terminalWidth = env.TERMINAL_WIDTH;
  let fixed: number | null = null;
  if (terminalWidth) fixed = strictInt(terminalWidth);
  else if (env.COLUMNS !== undefined && DIGITS.test(env.COLUMNS)) fixed = Number(env.COLUMNS);
  const lines = env.LINES !== undefined && DIGITS.test(env.LINES) ? Number(env.LINES) : null;
  if (fixed !== null && lines !== null) return fixed;
  const term = (env.TERM ?? '').toLowerCase();
  if (isTerminal(host) && (term === 'dumb' || term === 'unknown')) return 80;
  if (fixed !== null) return fixed;
  let width: number | null = null;
  for (const fd of [0, 1, 2]) {
    width = host.isatty(fd) ? host.columns(fd) : null;
    if (width !== null) break;
  }
  if (env.COLUMNS !== undefined && DIGITS.test(env.COLUMNS)) width = Number(env.COLUMNS);
  return width || 80;
}

/**
 * The terminal's columns: `COLUMNS` when `toInt` reads a positive number from it, else
 * STDOUT's terminal, else `fallback`.
 *
 * `toInt`, not `parseInt`: `COLUMNS=100abc` is no width, so the terminal is asked, while
 * `parseInt` reads 100; `COLUMNS=' 60 '` and `6_0` are 60, and so are `٦٠` and `６０`, since
 * any Unicode decimal digit reads as its ASCII value -- which `toInt` first did not, drawing
 * an 84-column `houston presets` box where earlier releases drew a 56-column one. A
 * terminal that answers 0 columns is the fallback.
 */
export function consoleColumns(
  fallback: number,
  host: ConsoleEnvironment = PROCESS_CONSOLE,
): number {
  const columns = host.env.COLUMNS === undefined ? null : strictInt(host.env.COLUMNS);
  if (columns !== null && columns > 0) return columns;
  const stdout = host.isatty(1) ? host.columns(1) : null;
  return stdout || fallback;
}

/**
 * The columns the help formatter sizes the Usage line by: `COLUMNS` when it is a positive
 * integer, else STDOUT's terminal, else 80.
 */
export function formatterColumns(host: ConsoleEnvironment = PROCESS_CONSOLE): number {
  return consoleColumns(80, host);
}

/** `toInt(text)`, or null where it throws. */
function strictInt(text: string): number | null {
  try {
    return toInt(text);
  } catch {
    return null;
  }
}
