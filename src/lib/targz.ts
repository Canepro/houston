/**
 * The small part of tar a backup bundle needs: read a `.tar.gz` member, extract one safely,
 * and write one.
 *
 * WHY NOT A DEPENDENCY. The bundle format is a gzipped tar because earlier releases wrote
 * one, and this build reads and writes the same files. `tar` on PATH is not portable enough
 * to be the contract (GNU and BSD differ on flags and on what a member name may contain),
 * and a third-party tar package would be the only dependency in a tree that ships exactly
 * one. So this is a header parser, and it is deliberately NARROW: ustar/GNU/PAX entries,
 * regular files and directories, which is everything a bundle written from a staging
 * directory houston built itself holds.
 *
 * UNSAFE ENTRIES ARE REFUSED, exactly as they always have been: a bundle can arrive from a
 * colleague, so an absolute path, a `..`, a symlink, a hard link or a device node is
 * untrusted input rather than a curiosity.
 *
 * THE GZIP LAYER IS A LAZY READER, not `zlib.createGunzip()`. The gunzip stream checked the
 * CRC trailer of the whole file, reading ahead of the tar walker to reach it, where the
 * established reader stops at the end-of-archive block and never reads the trailer: a
 * bundle whose trailer alone was damaged restored in earlier releases and was refused here,
 * and a bit-flipped manifest was a "zlib error: ... incorrect data check" where the
 * established report is the malformed JSON it decompressed. `GzipReader` parses the header
 * itself, inflates the raw deflate data only as far as the walker asks, and checks a trailer
 * only when the walker reads past the end of the deflate data.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { interruptPoint } from '../seams/exec';

import { ValidationError } from './errors';
import {
  compareCodePoints,
  toInt,
  intFromText,
  fileErrorOf,
  quotedText,
  roundHalfEven,
} from './format';
import { floatString, stripText } from './float-text';

const BLOCK = 512;

/**
 * The unsafe-entry refusal, as a `ReproError`.
 *
 * It EXTENDS `ValidationError` rather than `Error`: the refusal is a `ValidationError`
 * raised straight out of reading the manifest and unpacking the archive, so a caller that
 * only knows the error contract must be able to map it to a status. As a plain `Error` it
 * escaped the `http_status` taxonomy for any caller that did not special-case it. The name
 * is quoted by `quotedText`, so a name containing a quote, a backslash or a control character
 * reads exactly as the established message writes it.
 */
export class UnsafeBundleEntry extends ValidationError {
  constructor(readonly entryName: string) {
    super(`bundle contains an unsafe entry: ${quotedText(entryName)}`);
    this.name = 'UnsafeBundleEntry';
  }
}

/**
 * The archive reader's refusal, with its own words for a tar stream that ends early:
 * "empty file" and "truncated header" at the first header, "unexpected end of data" inside
 * a member. The walker said "archive ended inside a member" for all three, and that
 * sentence went into the UNREADABLE line of `backups` and the refusal of `restore`.
 */
export class TarReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableBundle';
  }
}

/**
 * A bad gzip member, which counts as an OS-level error: a member header that is not gzip, or
 * a trailer whose CRC or length disagrees with what was decompressed. It carries a `code` so
 * a caller that sorts failures by "has an errno-like code" words it as the OS error it is.
 */
export class BadGzip extends Error {
  readonly code = 'BadGzip';

  constructor(message: string) {
    super(message);
    this.name = 'BadGzip';
  }
}

/** The error for a file that ended inside a member. `gzipFailure` names it truncation. */
function endedEarly(): Error {
  const error = new Error('Compressed file ended before the end-of-stream marker was reached');
  error.name = 'TruncatedData';
  (error as NodeJS.ErrnoException).code = 'Z_BUF_ERROR';
  return error;
}

/** The bytes a file starts with, in hex, for the refusal of one that is not gzip. */
function leadingBytes(data: Buffer): string {
  return [...data].map((byte) => `0x${byte.toString(16).padStart(2, '0')}`).join(' ');
}

/** The header flags `readHeader` acts on. */
const FHCRC = 2;
const FEXTRA = 4;
const FNAME = 8;
const FCOMMENT = 16;

/** How much of the compressed file is handed to the inflater at a time. */
const READ_SIZE = 64 * 1024;

/**
 * A gzip reader over a file: `next()` is its read, one decompressed chunk at a time, and
 * null at the end of the last member.
 *
 * LAZY, as the established reader is. The inflater is paused after every chunk it produces
 * and resumed only when the walker has taken them all, so it never runs more than a chunk
 * or two ahead of what has been asked for: a corrupt byte after the end-of-archive block is
 * never decoded, and the data before a corrupt byte is handed over before its error is. A
 * member's trailer is read only when the walker asks for data past the end of its deflate
 * data, and then in full: the CRC and the length checked against what was decompressed,
 * zero padding skipped, and another member's header, or the end of the file, after it.
 */
class GzipReader {
  private position = 0;
  private state: 'header' | 'member' | 'trailer' | 'done' = 'header';
  private engine: zlib.InflateRaw | null = null;
  private queue: Buffer[] = [];
  private failure: unknown = null;
  private ended = false;
  private pumping: Promise<void> = Promise.resolve();
  private wake: (() => void) | null = null;
  private dataStart = 0;
  private crc = 0;
  private size = 0;
  private closed = false;

  private constructor(private readonly handle: fs.promises.FileHandle) {}

  /**
   * `source` opened for reading, a directory refused at the open, where Node's opens it and
   * fails the first read -- with no path in the error.
   */
  static async open(source: string): Promise<GzipReader> {
    const handle = await fs.promises.open(source, 'r');
    try {
      if ((await handle.stat()).isDirectory()) {
        throw Object.assign(
          new Error(`EISDIR: illegal operation on a directory, open '${source}'`),
          {
            code: 'EISDIR',
            errno: -21,
            syscall: 'open',
            path: source,
          },
        );
      }
    } catch (error) {
      await handle.close();
      throw error;
    }
    return new GzipReader(handle);
  }

  async next(): Promise<Buffer | null> {
    for (;;) {
      if (this.state === 'done') return null;
      if (this.state === 'header') {
        if (!(await this.readHeader())) {
          this.state = 'done';
          return null;
        }
        this.startMember();
        this.state = 'member';
        continue;
      }
      if (this.state === 'trailer') {
        await this.readEof();
        this.state = 'header';
        continue;
      }
      const chunk = this.queue.shift();
      if (chunk !== undefined) {
        if (this.queue.length === 0) this.engine?.resume();
        return chunk;
      }
      if (this.failure !== null) throw this.failure;
      if (this.ended) {
        await this.pumping;
        this.position = this.dataStart + (this.engine?.bytesWritten ?? 0);
        this.engine = null;
        this.state = 'trailer';
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.engine?.destroy();
    this.engine = null;
    await this.handle.close();
  }

  /** Up to `count` bytes of the file at the current position, fewer only at its end. */
  private async read(count: number): Promise<Buffer> {
    const buffer = Buffer.alloc(count);
    let have = 0;
    while (have < count) {
      const { bytesRead } = await this.handle.read(buffer, have, count - have, this.position);
      if (bytesRead === 0) break;
      have += bytesRead;
      this.position += bytesRead;
    }
    return buffer.subarray(0, have);
  }

  /** Exactly `count` bytes, or the ended-early `TruncatedData` error. */
  private async readExact(count: number): Promise<Buffer> {
    const data = await this.read(count);
    if (data.length < count) throw endedEarly();
    return data;
  }

  /** A member's gzip header: false at the end of the file, where a member would start. */
  private async readHeader(): Promise<boolean> {
    const magic = await this.read(2);
    if (magic.length === 0) return false;
    if (magic.length !== 2 || magic[0] !== 0x1f || magic[1] !== 0x8b) {
      throw new BadGzip(`Not a gzipped file (it starts with ${leadingBytes(magic)})`);
    }
    const fixed = await this.readExact(8);
    if (fixed[0] !== 8) throw new BadGzip('Unknown compression method');
    const flag = fixed[1] as number;
    if ((flag & FEXTRA) !== 0) await this.readExact((await this.readExact(2)).readUInt16LE(0));
    // A name and a comment end at a NUL -- or at the end of the file, which is not an error.
    for (const bit of [FNAME, FCOMMENT]) {
      if ((flag & bit) === 0) continue;
      for (;;) {
        const one = await this.read(1);
        if (one.length === 0 || one[0] === 0) break;
      }
    }
    if ((flag & FHCRC) !== 0) await this.readExact(2);
    return true;
  }

  /** A member's trailer: its CRC and length, then any zero padding after it. */
  private async readEof(): Promise<void> {
    const trailer = await this.readExact(8);
    const crc = trailer.readUInt32LE(0);
    if (crc !== this.crc) {
      throw new BadGzip(`CRC check failed 0x${crc.toString(16)} != 0x${this.crc.toString(16)}`);
    }
    if (trailer.readUInt32LE(4) !== this.size % 2 ** 32) {
      throw new BadGzip('Incorrect length of data produced');
    }
    for (;;) {
      const one = await this.read(1);
      if (one.length === 0) break;
      if (one[0] !== 0) {
        this.position -= 1;
        break;
      }
    }
  }

  private poke(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private startMember(): void {
    const engine = zlib.createInflateRaw();
    this.engine = engine;
    this.queue = [];
    this.failure = null;
    this.ended = false;
    this.dataStart = this.position;
    this.crc = 0;
    this.size = 0;
    engine.on('data', (chunk: Buffer) => {
      if (this.engine !== engine) return;
      this.queue.push(chunk);
      this.crc = zlib.crc32(chunk, this.crc);
      this.size += chunk.length;
      engine.pause();
      this.poke();
    });
    engine.on('end', () => {
      if (this.engine !== engine) return;
      this.ended = true;
      this.poke();
    });
    engine.on('error', (error) => {
      if (this.engine !== engine) return;
      this.failure ??= error;
      this.poke();
    });
    this.pumping = this.pump(engine, this.position);
  }

  /**
   * Feed the member's compressed bytes, one read at a time and only as fast as the inflater
   * takes them. It stops where the deflate data ends -- the inflater consumed less than it
   * was given -- so what follows is left for the trailer; at the end of the file it ends the
   * inflater, which is zlib's "unexpected end of file" when the member is incomplete.
   */
  private async pump(engine: zlib.InflateRaw, start: number): Promise<void> {
    let position = start;
    let fed = 0;
    try {
      for (;;) {
        const buffer = Buffer.allocUnsafe(READ_SIZE);
        const { bytesRead } = await this.handle.read(buffer, 0, READ_SIZE, position);
        if (this.closed || engine.destroyed) return;
        if (bytesRead === 0) {
          engine.end();
          return;
        }
        position += bytesRead;
        fed += bytesRead;
        await new Promise<void>((resolve, reject) => {
          engine.write(buffer.subarray(0, bytesRead), (error) =>
            error === null || error === undefined ? resolve() : reject(error),
          );
        });
        if (engine.bytesWritten < fed) return;
      }
    } catch (error) {
      if (this.closed || this.engine !== engine) return;
      this.failure ??= error;
      engine.destroy();
      this.poke();
    }
  }
}

interface Header {
  name: string;
  size: number;
  typeflag: string;
  longName: string;
  paxPath: string;
}

function field(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return (end >= 0 ? raw.subarray(0, end) : raw).toString('utf8');
}

/**
 * A header the archive reader cannot use, in the established words: reading the next member
 * ends the archive on some and makes a `ReadError` of the others, depending on where the
 * header was.
 */
class HeaderError extends Error {
  constructor(
    readonly kind: 'empty' | 'truncated' | 'eof' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'HeaderError';
  }
}

/**
 * A number field, or an `invalid header` HeaderError.
 *
 * GNU BASE-256 when the first byte is 0o200 (or 0o377, negative): the GNU format uses this
 * for a value that does not fit the octal field -- a size at or above 8 GiB -- and reading
 * those bytes as octal text silently answered 0. The PAX format houston's bundles use writes
 * a PAX `size` record instead; see `paxSize` in `walk`. Otherwise ASCII up to the first
 * NUL, stripped, and read as octal, an empty field as 0: a field that is not octal makes
 * the header invalid. It answered 0, so a header garbled by a corrupt byte was walked as a
 * member of size 0 and the reader went on past where the established reader stops.
 */
function nti(block: Buffer, offset: number, length: number): number {
  const raw = block.subarray(offset, offset + length);
  if (raw[0] === 0o200 || raw[0] === 0o377) {
    let value = 0;
    for (let index = 1; index < raw.length; index += 1) {
      value = value * 256 + (raw[index] as number);
    }
    return raw[0] === 0o377 ? -(256 ** (raw.length - 1) - value) : value;
  }
  const end = raw.indexOf(0);
  const bytes = end >= 0 ? raw.subarray(0, end) : raw;
  if (bytes.some((byte) => byte >= 0x80)) throw new HeaderError('invalid', 'invalid header');
  const text = stripText(bytes.toString('latin1'));
  try {
    return intFromText(text === '' ? '0' : text, 8);
  } catch {
    throw new HeaderError('invalid', 'invalid header');
  }
}

/** The header's checksums: summed with the checksum field as spaces, unsigned and signed. */
function calcChecksums(block: Buffer): [number, number] {
  let unsigned = 256;
  let signed = 256;
  for (let index = 0; index < BLOCK; index += 1) {
    if (index >= 148 && index < 156) continue;
    const byte = block[index] as number;
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return [unsigned, signed];
}

/**
 * A header block's checks, in the established order, and the fields the walker uses: the
 * checksum, then every number field, any of which makes the header invalid. The walker
 * checked neither.
 */
function parseHeader(block: Buffer): { name: string; size: number; typeflag: string } {
  if (block.length === 0) throw new HeaderError('empty', 'empty header');
  if (block.length !== BLOCK) throw new HeaderError('truncated', 'truncated header');
  if (isZeroBlock(block)) throw new HeaderError('eof', 'end of file header');
  const checksum = nti(block, 148, 8);
  if (!calcChecksums(block).includes(checksum)) throw new HeaderError('invalid', 'bad checksum');
  let name = field(block, 0, 100);
  for (const [offset, length] of [
    [100, 8],
    [108, 8],
    [116, 8],
  ] as const) {
    nti(block, offset, length);
  }
  const size = nti(block, 124, 12);
  nti(block, 136, 12);
  nti(block, 329, 8);
  nti(block, 337, 8);
  const raw = field(block, 156, 1);
  // Old V7 tar marks a directory as a regular file (NUL type) whose name ends in `/`.
  const typeflag = raw === '' && name.endsWith('/') ? '5' : raw || '0';
  const prefix = field(block, 345, 155);
  if (prefix !== '' && !['L', 'K', 'S'].includes(typeflag)) name = `${prefix}/${name}`;
  return { name, size, typeflag };
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function paxRecords(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number.parseInt(body.subarray(at, space).toString('ascii'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.subarray(space + 1, at + length).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1).replace(/\n$/u, '');
    at += length;
  }
  return out;
}

/** A tar member header, with the long-name mechanisms already folded in. */
export interface Member {
  readonly name: string;
  readonly typeflag: string;
  readonly size: number;
}

function nameOf(header: Header): string {
  return header.paxPath !== ''
    ? header.paxPath
    : header.longName !== ''
      ? header.longName
      : header.name;
}

/**
 * Reject an entry that may not be extracted, before anything is written.
 *
 * The established rule: absolute, `..`, a symlink, a hard link or a device. A
 * directory name ending in `/` is fine; a `..` in ANY part is not.
 */
export function requireSafeMember(name: string, typeflag: string): void {
  const parts = name.split('/');
  if (
    path.isAbsolute(name) ||
    parts.includes('..') ||
    typeflag === '2' ||
    typeflag === '1' ||
    typeflag === '3' ||
    typeflag === '4' ||
    typeflag === '6'
  ) {
    throw new UnsafeBundleEntry(name);
  }
}

/**
 * The member types that are regular files, which is not only `'0'`. A CONTTYPE (`'7'`)
 * member is a regular file too, and a bundle whose manifest was one restored in earlier
 * releases and was "has no manifest.json" here. GNU sparse (`'S'`) is read as its stored data.
 */
const REGULAR_TYPES = new Set(['0', '7', 'S']);

/** The member types the archive reader knows; any OTHER type reads as a regular file too. */
const SUPPORTED_TYPES = new Set(['0', '1', '2', '3', '4', '5', '6', '7', 'L', 'K', 'S']);

/**
 * Whether reading the member hands back its data: a regular type, or one the archive reader
 * does not know -- a directory, a link or a device has none, which is "has no manifest.json".
 */
function readsAsFile(typeflag: string): boolean {
  return REGULAR_TYPES.has(typeflag) || !SUPPORTED_TYPES.has(typeflag);
}

/**
 * What a failure is when it happens while a HEADER is read: a zlib error is
 * `ReadError("zlib error: ...")`, and, for the first member, an OS error is
 * `ReadError("not a gzip file")`. A failure while reading or skipping a member's DATA
 * reaches the caller raw: `gzipFailure` names a zlib error there as the truncation that
 * reading the manifest and unpacking the archive report.
 */
function headerFailure(error: unknown, first: boolean): unknown {
  const code = String((error as { code?: unknown }).code ?? '');
  if (code === 'Z_DATA_ERROR') {
    return new TarReadError(`zlib error: ${zlibText(error)}`);
  }
  const osError =
    error instanceof BadGzip ||
    (typeof (error as NodeJS.ErrnoException).errno === 'number' && !code.startsWith('Z_'));
  if (first && osError) return new TarReadError('not a gzip file');
  return error;
}

/** A zlib data error in the established words: `Error -3 while decompressing data: <reason>`. */
function zlibText(error: unknown): string {
  const own = (error as { message?: unknown }).message;
  return `Error -3 while decompressing data: ${typeof own === 'string' ? own : String(error)}`;
}

/**
 * Iterate the members of `source`, calling `onMember` with a header and a chunk source.
 *
 * The callback must consume the member's data (or ignore it), and returning `false`
 * stops the scan -- which is what lets `readMember` stop after the manifest instead of
 * decompressing a multi-gigabyte archive to reach it.
 */
async function walk(
  source: string,
  onMember: (
    member: Member,
    readData: () => Promise<Buffer>,
    writeData: (target: string) => Promise<void>,
  ) => Promise<boolean | void>,
): Promise<void> {
  const reader = await GzipReader.open(source);
  let buffered: Buffer = Buffer.alloc(0);
  let longName = '';
  let paxPath = '';
  // A PAX `size` record, for the member after it. The PAX format bundles are written in puts
  // 0 in the ustar size field of a member of 8 GiB or more and the real size here, so a
  // bundle whose mongo.archive.gz reached 8 GiB read as a zero-length member followed by
  // archive bytes parsed as headers: UNREADABLE, "archive ended inside a member", where it
  // must be listed and restored.
  let paxSize: number | null = null;
  // Bytes of the tar stream consumed so far, which decides whether a header that is not
  // there is an error (at 0) or the end of the archive (past it).
  let consumed = 0;
  // Members handed over so far: until the first is, a header failure is the opening's.
  let yielded = 0;

  async function take(count: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let have = 0;
    while (have < count) {
      if (buffered.length === 0) {
        const chunk = await reader.next();
        if (chunk === null) {
          throw new TarReadError('unexpected end of data');
        }
        buffered = chunk;
      }
      const share = Math.min(buffered.length, count - have);
      parts.push(buffered.subarray(0, share));
      buffered = buffered.subarray(share);
      have += share;
      consumed += share;
    }
    return Buffer.concat(parts);
  }

  /**
   * The next header block: 512 bytes, or fewer only where the tar stream ends.
   * `parseHeader` says what a short one means, and the loop says what that
   * means where it was read.
   */
  async function readBlock(): Promise<Buffer> {
    return await takeUpTo(BLOCK);
  }

  /**
   * Up to `count` bytes, fewer only where the stream ends, which is how an extension
   * header's body is read. A body cut short is not an error there; the header after it is.
   */
  async function takeUpTo(count: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let have = 0;
    while (have < count) {
      if (buffered.length === 0) {
        const chunk = await reader.next();
        if (chunk === null) break;
        buffered = chunk;
      }
      const share = Math.min(buffered.length, count - have);
      parts.push(buffered.subarray(0, share));
      buffered = buffered.subarray(share);
      have += share;
      consumed += share;
    }
    return Buffer.concat(parts);
  }

  /**
   * `take`, without building the result.
   *
   * A member's data still has to be consumed to reach the next header, and `take` would
   * concatenate a multi-gigabyte archive member into one buffer. Skipping is the whole
   * reason `memberNames` and a full-stream manifest read can walk a real bundle.
   */
  async function discard(count: number): Promise<void> {
    let remaining = count;
    while (remaining > 0) {
      if (buffered.length === 0) {
        const chunk = await reader.next();
        if (chunk === null) {
          throw new TarReadError('unexpected end of data');
        }
        buffered = chunk;
      }
      const share = Math.min(buffered.length, remaining);
      buffered = buffered.subarray(share);
      remaining -= share;
      consumed += share;
    }
  }

  /** A read made while the next header is being read: its failures are `headerFailure`'s. */
  async function inHeader<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      throw headerFailure(error, yielded === 0);
    }
  }

  // Whether the header being read follows a PAX or GNU long-name header, which read it
  // themselves and raise its failure as a `ReadError` of its own.
  let afterExtension = false;
  try {
    for (;;) {
      const at = consumed;
      const block = await inHeader(readBlock);
      let parsed: { name: string; size: number; typeflag: string };
      try {
        parsed = parseHeader(block);
      } catch (error) {
        if (!(error instanceof HeaderError)) throw error;
        // After an extension header, any failure is a ReadError in its own words ("empty
        // header", "bad checksum", ...). Otherwise a zero block is the end of the archive,
        // and so is any header past the first that cannot be used -- a stream cut short, a
        // bad checksum, a number field that is not one; at the first they are "empty file",
        // "truncated header" and the rest in their own words. This walker read on through a
        // header a corrupt byte had garbled, and reached the gzip trailer the established
        // reader never reads.
        if (afterExtension) throw new TarReadError(error.message);
        if (error.kind === 'eof') break;
        if (at === 0) throw new TarReadError(error.kind === 'empty' ? 'empty file' : error.message);
        break;
      }
      afterExtension = false;
      const header: Header = {
        name: parsed.name,
        size: paxSize ?? parsed.size,
        typeflag: parsed.typeflag,
        longName,
        paxPath,
      };
      longName = '';
      paxPath = '';
      paxSize = null;

      if (header.typeflag === 'x' || header.typeflag === 'g') {
        // A PAX header is small (a path record), but skipping rather than buffering
        // keeps every non-payload member on one code path.
        const body = await inHeader(async () => await takeUpTo(header.size + pad(header.size)));
        const records = paxRecords(body.subarray(0, header.size));
        if (header.typeflag === 'x' && records.path !== undefined) paxPath = records.path;
        if (header.typeflag === 'x' && records.size !== undefined) {
          // The integer grammar (`toInt`), and 0 where the value is not an integer.
          try {
            paxSize = toInt(records.size);
          } catch {
            paxSize = 0;
          }
        }
        afterExtension = true;
        continue;
      }
      if (header.typeflag === 'L') {
        // The name ends at its first NUL.
        const body = await inHeader(async () => await takeUpTo(header.size + pad(header.size)));
        const end = body.subarray(0, header.size).indexOf(0);
        longName = body.subarray(0, end >= 0 ? end : header.size).toString('utf8');
        afterExtension = true;
        continue;
      }
      if (header.typeflag === 'K') {
        // GNU's long LINK name, for the member after it: a link, which is refused anyway.
        await inHeader(async () => await takeUpTo(header.size + pad(header.size)));
        afterExtension = true;
        continue;
      }

      const name = nameOf(header);
      // Through an object: a closure assignment to a plain `let` stays narrowed by
      // the compiler, which then calls the guard unreachable.
      const state = { emitted: false };
      const readData = async (): Promise<Buffer> => {
        state.emitted = true;
        const data = await take(header.size);
        await take(pad(header.size));
        return data;
      };
      // STREAMED, so a database archive larger than memory is never buffered. Through a
      // FileHandle opened before the first read, and CLOSED before a failed read is
      // rethrown: a WriteStream was still opening when the gunzip under it failed, the
      // caller's `finally` removed the staging directory, and the stream's own ENOENT was an
      // unhandled 'error' event that killed the process.
      const writeData = async (target: string): Promise<void> => {
        state.emitted = true;
        const handle = await fs.promises.open(target, 'w');
        try {
          let remaining = header.size;
          while (remaining > 0) {
            const chunk = await take(Math.min(remaining, 64 * 1024));
            await handle.write(chunk);
            remaining -= chunk.length;
          }
          await take(pad(header.size));
        } finally {
          await handle.close();
        }
      };
      yielded += 1;
      const goOn = await onMember(
        { name, typeflag: header.typeflag, size: header.size },
        readData,
        writeData,
      );
      if (!state.emitted) await discard(header.size + pad(header.size));
      if (goOn === false) break;
    }
  } finally {
    await reader.close();
  }
}

function pad(size: number): number {
  const remainder = size % BLOCK;
  return remainder === 0 ? 0 : BLOCK - remainder;
}

/**
 * One member's bytes, or null -- after the safety check over every member.
 * Streaming: a bundle whose archive member is larger than the requested one is never buffered.
 *
 * THE WHOLE STREAM IS READ, even after the wanted member is found, because every member is
 * enumerated, and the enumeration is what notices a bundle truncated AFTER the manifest.
 * Stopping early made a truncated bundle look healthy to `listBackups`; the decompression
 * cost is the same one earlier releases paid, and only the non-payload bytes are buffered.
 *
 * AND IN THE ESTABLISHED ORDER: every header first, then the safety check over all of them,
 * then the member, searched for from the END, so of two `manifest.json` members the LAST is
 * the one read -- the first was, and a bundle carrying both reached the opposite restore
 * verdict from the established one. Names are compared as stored, not normalised
 * (`./manifest.json` is not the manifest), with the trailing `/` a directory's name loses.
 */
export async function readMember(source: string, wanted: string): Promise<Buffer | null> {
  const target = wanted.replace(/\/+$/u, '');
  const members: Member[] = [];
  let found: Buffer | null = null;
  await walk(source, async (member, readData) => {
    members.push(member);
    const name = member.typeflag === '5' ? member.name.replace(/\/+$/u, '') : member.name;
    if (name !== target) return;
    // A ZERO-LENGTH member still counts: it reads as an empty file, and an empty manifest
    // is the "malformed manifest" branch -- skipping it here reported "has no
    // manifest.json" instead. A directory of that name is null.
    found = readsAsFile(member.typeflag) ? await readData() : null;
  });
  // THE SAME REFUSAL AS BEFORE AN EXTRACT, and for the same reason: a bundle can arrive
  // from a colleague, so a read of one is untrusted input too. Without this,
  // `listBackups` presented a bundle containing an absolute path or a symlink as healthy,
  // where its manifest must not be read at all. Every member is checked, after the whole
  // stream has been read.
  for (const member of members) requireSafeMember(member.name, member.typeflag);
  return found;
}

/** Member names in order, for a caller that wants to refuse before extracting. */
export async function memberNames(source: string): Promise<string[]> {
  const members: Member[] = [];
  await walk(source, async (member) => {
    members.push(member);
  });
  for (const member of members) requireSafeMember(member.name, member.typeflag);
  return members.map((member) => member.name);
}

/**
 * Extract every regular file and directory under `dest`, streaming each file to disk.
 *
 * Refuses an unsafe entry and aborts; the caller's `dest` is a temporary staging
 * directory, so a partial extraction never becomes state. The refusals come in the
 * established order -- a stream that cannot be read, then an unsafe member, then a
 * `SpecialFileError` for a type the extraction filter does not know -- although this walks
 * the archive once: an unsafe member is never written, so extracting the safe ones on the
 * way is invisible.
 */
export async function extractTarGz(source: string, dest: string): Promise<void> {
  // Through an object, as `walk`'s `state` is: the compiler keeps a `let` narrowed to its
  // initial `null` across the callback that assigns it.
  const refused: { unsafe: UnsafeBundleEntry | null; special: string | null } = {
    unsafe: null,
    special: null,
  };
  await walk(source, async (member, _readData, writeData) => {
    try {
      requireSafeMember(member.name, member.typeflag);
    } catch (error) {
      if (!(error instanceof UnsafeBundleEntry)) throw error;
      refused.unsafe ??= error;
      return;
    }
    if (refused.unsafe !== null || refused.special !== null) return;
    const target = path.join(dest, member.name);
    if (member.typeflag === '5' || member.name.endsWith('/')) {
      await fs.promises.mkdir(target, { recursive: true });
      return;
    }
    if (!REGULAR_TYPES.has(member.typeflag)) {
      refused.special = member.name;
      return;
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await writeData(target);
  });
  if (refused.unsafe !== null) throw refused.unsafe;
  if (refused.special !== null)
    throw new TarReadError(`${quotedText(refused.special)} is a special file`);
}

/** The record size: a written archive is padded with zero blocks to a multiple of it. */
const RECORDSIZE = BLOCK * 20;

/** The POSIX magic: `ustar`, NUL, then the version `00`. */
const POSIX_MAGIC = Buffer.from('ustar\u000000', 'latin1');

/** A member's fields, as the header writers take them. */
interface TarInfo {
  name: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  /** Seconds since the epoch, a FLOAT, which is why every member carries a PAX `mtime` record. */
  mtime: number;
  type: string;
  linkname: string;
  uname: string;
  gname: string;
  devmajor: number;
  devminor: number;
}

/** A string field in ASCII, NUL-padded to `length`: one `?` per character ASCII cannot hold. */
function stnAscii(value: string, length: number): Buffer {
  let text = '';
  for (const ch of value) text += (ch.codePointAt(0) as number) < 0x80 ? ch : '?';
  const out = Buffer.alloc(length);
  out.write(text.slice(0, length), 0, 'latin1');
  return out;
}

/** A ustar number field: octal in `digits - 1` places and a NUL. */
function itn(value: number, digits: number): Buffer {
  if (!(value >= 0 && value < 8 ** (digits - 1))) {
    const overflow = new Error('overflow in number field');
    overflow.name = 'InvalidValue';
    throw overflow;
  }
  return Buffer.from(
    `${Math.trunc(value)
      .toString(8)
      .padStart(digits - 1, '0')}\0`,
    'latin1',
  );
}

/** A ustar header block, its string fields in ASCII with `?` for what ASCII cannot hold. */
function createHeader(info: TarInfo): Buffer {
  const device = info.type === '3' || info.type === '4';
  const block = Buffer.alloc(BLOCK);
  Buffer.concat([
    stnAscii(info.name, 100),
    itn(info.mode & 0o7777, 8),
    itn(info.uid, 8),
    itn(info.gid, 8),
    itn(info.size, 12),
    itn(info.mtime, 12),
    Buffer.from('        ', 'latin1'),
    Buffer.from(info.type, 'latin1'),
    stnAscii(info.linkname, 100),
    POSIX_MAGIC,
    stnAscii(info.uname, 32),
    stnAscii(info.gname, 32),
    device ? itn(info.devmajor, 8) : Buffer.alloc(8),
    device ? itn(info.devminor, 8) : Buffer.alloc(8),
    Buffer.alloc(155),
  ]).copy(block);
  // The checksum field: the unsigned sum as six octal digits and a NUL, then the field's
  // own eighth byte, a space, left as it was.
  block.write(`${calcChecksums(block)[0].toString(8).padStart(6, '0')}\0`, 148, 7, 'latin1');
  return block;
}

/** A member's data: the bytes, padded with NULs to the next block. */
function payload(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.alloc(pad(data.length))]);
}

/**
 * A PAX extended header: `<length> <keyword>=<value>\n` records in UTF-8, each length
 * counting its own digits, under a `././@PaxHeader` member of type `x`.
 */
function paxHeader(records: readonly [string, string][]): Buffer {
  const parts: Buffer[] = [];
  for (const [keyword, value] of records) {
    const key = Buffer.from(keyword, 'utf8');
    const text = Buffer.from(value, 'utf8');
    const length = key.length + text.length + 3;
    let p = 0;
    for (;;) {
      const n = length + String(p).length;
      if (n === p) break;
      p = n;
    }
    parts.push(
      Buffer.from(`${String(p)} `, 'latin1'),
      key,
      Buffer.from('='),
      text,
      Buffer.from('\n'),
    );
  }
  const body = Buffer.concat(parts);
  const header = createHeader({
    name: '././@PaxHeader',
    mode: 0,
    uid: 0,
    gid: 0,
    size: body.length,
    mtime: 0,
    type: 'x',
    linkname: '',
    uname: '',
    gname: '',
    devmajor: 0,
    devminor: 0,
  });
  return Buffer.concat([header, payload(body)]);
}

/** Whether every character of `value` is ASCII. */
function isAscii(value: string): boolean {
  for (const ch of value) if ((ch.codePointAt(0) as number) >= 0x80) return false;
  return true;
}

/**
 * A member's header in the PAX format houston's bundles use: a PAX record for a string field
 * that is not ASCII or too long for its ustar field (`path`, `linkpath`, `uname`,
 * `gname`, in that order), and for a number field that does not fit or is a float (`uid`,
 * `gid`, `size`, `mtime`) -- a float goes in rounded half to even, and its float text in the
 * record.
 */
function tarHeaderOf(tarinfo: TarInfo): Buffer {
  const info = { ...tarinfo };
  const records: [string, string][] = [];
  for (const [field, keyword, length] of [
    ['name', 'path', 100],
    ['linkname', 'linkpath', 100],
    ['uname', 'uname', 32],
    ['gname', 'gname', 32],
  ] as const) {
    const value = info[field];
    if (!isAscii(value) || value.length > length) records.push([keyword, value]);
  }
  for (const [field, digits] of [
    ['uid', 8],
    ['gid', 8],
    ['size', 12],
    ['mtime', 12],
  ] as const) {
    const value = info[field];
    const isFloat = field === 'mtime';
    const whole = isFloat ? roundHalfEven(value) : value;
    let needsPax = false;
    if (!(whole >= 0 && whole < 8 ** (digits - 1))) {
      info[field] = 0;
      needsPax = true;
    } else if (isFloat) {
      info[field] = whole;
      needsPax = true;
    }
    if (needsPax) records.push([field, isFloat ? floatString(value) : String(value)]);
  }
  const header = createHeader(info);
  return records.length > 0 ? Buffer.concat([paxHeader(records), header]) : header;
}

/** The float mtime from the nanosecond count, built as `sec + nsec * 1e-9`. */
function statFloat(nanoseconds: bigint): number {
  let sec = nanoseconds / 1_000_000_000n;
  let nsec = nanoseconds % 1_000_000_000n;
  if (nsec < 0n) {
    nsec += 1_000_000_000n;
    sec -= 1n;
  }
  return Number(sec) + Number(nsec) * 1e-9;
}

/**
 * The user name for a uid and the group name for a gid, or '' where the database has none.
 *
 * `/etc/passwd` and `/etc/group` first, the first line with that id, as the `files` source
 * answers; then, for a uid, the running user through `os.userInfo()`, which asks the whole name
 * service. Node has neither lookup, so ANOTHER user or group known only to a network source is
 * '' here, where `getpwuid` or `getgrgid` would find it -- the limit `home.ts` records for `~name`.
 */
class Owners {
  private readonly cache = new Map<string, string>();

  user(uid: number): string {
    return this.lookup('/etc/passwd', uid, () => {
      try {
        const self = os.userInfo();
        return self.uid === uid ? self.username : '';
      } catch {
        return '';
      }
    });
  }

  group(gid: number): string {
    return this.lookup('/etc/group', gid, () => '');
  }

  private lookup(file: string, id: number, otherwise: () => string): string {
    const key = `${file}:${String(id)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    let table = '';
    try {
      table = fs.readFileSync(file, 'utf8');
    } catch {
      /* no such database: the name service below, or nothing */
    }
    let found: string | null = null;
    for (const line of table.split('\n')) {
      const fields = line.split(':');
      if (fields.length >= 3 && fields[2] === String(id)) {
        found = fields[0] ?? '';
        break;
      }
    }
    const name = found ?? otherwise();
    this.cache.set(key, name);
    return name;
  }
}

/** glibc's `gnu_dev_major` / `gnu_dev_minor`: a device number's major and minor. */
function deviceNumbers(rdev: bigint): [number, number] {
  const major = ((rdev >> 8n) & 0xfffn) | ((rdev >> 32n) & ~0xfffn);
  const minor = (rdev & 0xffn) | ((rdev >> 12n) & ~0xffn);
  return [Number(major), Number(minor)];
}

/**
 * A path's member fields, as the established archiver takes them: `lstat`, so a link is a
 * link; a second path to an inode already archived under another name a hard-link member;
 * a socket, or anything else a tar has no type for, null -- the writer skips it.
 */
function gettarinfo(
  absolute: string,
  arcname: string,
  inodes: Map<string, string>,
  owners: Owners,
  mtimeNs: ReadonlyMap<string, bigint> | undefined,
): TarInfo | null {
  const st = fs.lstatSync(absolute, { bigint: true });
  let type: string;
  let linkname = '';
  if (st.isFile()) {
    const inode = `${String(st.ino)}:${String(st.dev)}`;
    const earlier = inodes.get(inode);
    if (st.nlink > 1n && earlier !== undefined && arcname !== earlier) {
      type = '1';
      linkname = earlier;
    } else {
      type = '0';
      if (st.ino !== 0n) inodes.set(inode, arcname);
    }
  } else if (st.isDirectory()) {
    type = '5';
  } else if (st.isFIFO()) {
    type = '6';
  } else if (st.isSymbolicLink()) {
    type = '2';
    linkname = fs.readlinkSync(absolute);
  } else if (st.isCharacterDevice()) {
    type = '3';
  } else if (st.isBlockDevice()) {
    type = '4';
  } else {
    return null;
  }
  const uid = Number(st.uid);
  const gid = Number(st.gid);
  const [devmajor, devminor] =
    type === '3' || type === '4' ? deviceNumbers(st.rdev) : ([0, 0] as const);
  return {
    // A directory's name ends in `/`.
    name: type === '5' && !arcname.endsWith('/') ? `${arcname}/` : arcname,
    mode: Number(st.mode) & 0o7777,
    uid,
    gid,
    size: type === '0' ? Number(st.size) : 0,
    mtime: statFloat(mtimeNs?.get(absolute) ?? st.mtimeNs),
    type,
    linkname,
    uname: owners.user(uid),
    gname: owners.group(gid),
    devmajor,
    devminor,
  };
}

/**
 * A failed system call as the `FileError` `fileErrorOf` makes of it -- `ro/b.rcbak.partial:
 * Permission denied` -- for the CLI's unhandled-error line.
 */
function asOsError(error: unknown): unknown {
  const err = error as NodeJS.ErrnoException;
  const code = typeof err.code === 'string' ? err.code : '';
  if (typeof err.errno !== 'number' || code === '' || code.startsWith('Z_')) return error;
  return fileErrorOf(error);
}

/** Write until the whole buffer is down. */
function writeAll(fd: number, data: Buffer): void {
  let at = 0;
  while (at < data.length) at += fs.writeSync(fd, data, at, data.length - at);
}

/**
 * A gzip writer at level 9 over an open file, in the established framing: the header
 * written at once -- FNAME the file's base name in Latin-1 (none when it cannot be), MTIME
 * now, XFL 2 for level 9, OS 255 -- raw deflate at level 9, and the CRC-32 and length
 * trailer at `close`.
 * `zlib.createGzip` writes MTIME 0, OS 3 and no name, and cannot be told otherwise.
 */
class GzipWriter {
  private readonly deflate = zlib.createDeflateRaw({ level: 9 });
  private readonly done: Promise<void>;
  private failure: unknown = null;
  private crc = 0;
  private size = 0;

  constructor(
    private readonly fd: number,
    name: string,
  ) {
    const base = path.basename(name);
    let fname = Array.from(base).every((ch) => (ch.codePointAt(0) as number) <= 0xff)
      ? Buffer.from(base, 'latin1')
      : Buffer.alloc(0);
    if (fname.length >= 3 && fname.subarray(-3).equals(Buffer.from('.gz'))) {
      fname = fname.subarray(0, -3);
    }
    const header = Buffer.from([0x1f, 0x8b, 8, fname.length > 0 ? FNAME : 0, 0, 0, 0, 0, 2, 0xff]);
    header.writeUInt32LE(Math.floor(Date.now() / 1000), 4);
    writeAll(fd, fname.length > 0 ? Buffer.concat([header, fname, Buffer.from([0])]) : header);
    this.deflate.on('data', (chunk: Buffer) => {
      if (this.failure !== null) return;
      try {
        writeAll(this.fd, chunk);
      } catch (error) {
        this.failure = error;
        this.deflate.destroy();
      }
    });
    this.deflate.on('error', (error) => {
      this.failure ??= error;
    });
    this.done = new Promise<void>((resolve) => {
      this.deflate.once('end', resolve);
      this.deflate.once('close', resolve);
    });
  }

  /**
   * One piece of the tar stream. Each is where a Ctrl-C lands (`interruptPoint`):
   * `writeTarGzFromDir`'s `finally` removes the `.partial` and the staging directory goes
   * with the unwind.
   */
  async write(chunk: Buffer): Promise<void> {
    await interruptPoint();
    if (this.failure !== null) throw this.failure;
    this.crc = zlib.crc32(chunk, this.crc);
    this.size += chunk.length;
    await new Promise<void>((resolve, reject) => {
      this.deflate.write(chunk, (error) =>
        error === null || error === undefined ? resolve() : reject(this.failure ?? error),
      );
    });
  }

  async close(): Promise<void> {
    this.deflate.end();
    await this.done;
    if (this.failure !== null) throw this.failure;
    const trailer = Buffer.alloc(8);
    trailer.writeUInt32LE(this.crc, 0);
    trailer.writeUInt32LE(this.size % 2 ** 32, 4);
    writeAll(this.fd, trailer);
  }

  destroy(): void {
    this.deflate.destroy();
  }
}

/**
 * Write `dir` as a bundle has always been written: a gzipped tar at `<dest>.partial`, each
 * entry of `dir` added under its own name in sorted order, then renamed onto `dest`.
 *
 * It was its own minimal ustar writer: every member mode 0644 --
 * directories too, so a bundle unpacked by hand had directories nobody could enter -- uid and
 * gid 0 with no names, one mtime "now", no PAX records, no padding to the 10240-byte record,
 * a gzip header with no name and no time, and each file read whole into memory, which is a
 * RangeError for a mongodump archive over 2 GiB. Now each member is what the `lstat` of its
 * path makes -- mode, owner and group with their names, the float mtime as a PAX record, a
 * directory's real mode, a PAX `path` for a long or non-ASCII name, a link as a link -- in
 * the established order (entries sorted, a directory recursed in place), each file's bytes
 * streamed; then the end blocks and the record padding, under `GzipWriter`'s framing.
 * `mtimeNs`, when given, is the nanosecond mtime a staged path should carry: a copy that
 * keeps mode and mtime sets it exactly, and `utimes` here keeps only microseconds (see
 * `backup.copyWithMetadata`).
 *
 * The compressed bytes are not the ones earlier releases wrote -- Node's zlib is not the
 * system one -- but what they decompress to is: `targz.test.ts` compares the two tar
 * streams byte for byte.
 */
export async function writeTarGzFromDir(
  dir: string,
  dest: string,
  { mtimeNs }: { mtimeNs?: ReadonlyMap<string, bigint> } = {},
): Promise<void> {
  const temporary = `${dest}.partial`;
  try {
    // The partial file opened for writing before anything else: an --out nobody may write
    // into is a permission error there, not a WriteStream 'error' that rejected a promise
    // nothing was awaiting yet and escaped the handler.
    const fd = fs.openSync(temporary, 'w');
    let gzip: GzipWriter | null = null;
    try {
      gzip = new GzipWriter(fd, temporary);
      const writer = gzip;
      const inodes = new Map<string, string>();
      const owners = new Owners();
      let offset = 0;
      const emit = async (chunk: Buffer): Promise<void> => {
        await writer.write(chunk);
        offset += chunk.length;
      };
      const add = async (absolute: string, arcname: string): Promise<void> => {
        const info = gettarinfo(absolute, arcname, inodes, owners, mtimeNs);
        if (info === null) return;
        if (info.type === '0') {
          await addFile(absolute, info, emit);
          return;
        }
        await emit(tarHeaderOf(info));
        if (info.type !== '5') return;
        for (const child of fs.readdirSync(absolute).sort(compareCodePoints)) {
          await add(path.join(absolute, child), `${arcname}/${child}`);
        }
      };
      for (const item of fs.readdirSync(dir).sort(compareCodePoints)) {
        await add(path.join(dir, item), item);
      }
      // The end of the archive: two zero blocks, then zeros to the end of the record.
      await emit(Buffer.alloc(BLOCK * 2));
      const remainder = offset % RECORDSIZE;
      if (remainder > 0) await emit(Buffer.alloc(RECORDSIZE - remainder));
      await writer.close();
    } finally {
      gzip?.destroy();
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, dest);
  } catch (error) {
    throw asOsError(error);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* already renamed away */
    }
  }
}

/**
 * A regular file as a member: opened first, then the header and exactly `size` bytes -- a
 * `FileError` `unexpected end of data` if the file is shorter now -- then the padding to the
 * block.
 */
async function addFile(
  absolute: string,
  info: TarInfo,
  emit: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  const fd = fs.openSync(absolute, 'r');
  try {
    await emit(tarHeaderOf(info));
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let remaining = info.size;
    while (remaining > 0) {
      const want = Math.min(remaining, buffer.length);
      let have = 0;
      while (have < want) {
        const read = fs.readSync(fd, buffer, have, want - have, null);
        if (read === 0) break;
        have += read;
      }
      if (have < want) {
        const short = new Error('unexpected end of data');
        short.name = 'FileError';
        throw short;
      }
      await emit(buffer.subarray(0, have));
      remaining -= have;
    }
    if (info.size % BLOCK !== 0) await emit(Buffer.alloc(BLOCK - (info.size % BLOCK)));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * What a failure to decompress a bundle IS, in the established words.
 *
 * Two cases are told apart, where an earlier version did not. A stream that stops early is an
 * ended-early error -- "truncated, or still being written" -- while a file that is not gzip at all is
 * a `TarReadError`. Every `Z_` code was read as truncation, so random bytes were reported
 * as a bundle still being written.
 *
 * A zlib data error that reaches a caller is one met while a member's DATA was read or
 * skipped: `walk` has already made one met in a header `TarReadError("zlib error: ...")`, and
 * the gzip header is parsed by `GzipReader`, so `incorrect header check` no longer comes
 * from zlib at all. Outside a header read the zlib error reaches the manifest read and the
 * unpacking raw, and both report it as the truncation clause they share with the ended-early error.
 */
export function gzipFailure(error: unknown): { truncated: boolean; text: string } | null {
  const code = String((error as { code?: unknown }).code ?? '');
  // Read off the object, not through `instanceof Error`: a zlib error is built in Node's own
  // realm, which is not the realm a Jest sandbox (or any vm context) calls `Error`.
  const own = (error as { message?: unknown }).message;
  const message = typeof own === 'string' ? own : String(error);
  // A gzip stream cut short is the ended-early error, in its words.
  if (code === 'Z_BUF_ERROR') {
    return {
      truncated: true,
      text: 'Compressed file ended before the end-of-stream marker was reached',
    };
  }
  if (code === 'Z_DATA_ERROR') return { truncated: true, text: zlibText(error) };
  if (code.startsWith('Z_')) return { truncated: true, text: message };
  return null;
}
