/**
 * The hidden prompt, the only kind of prompt this CLI asks (every `prompt` here hides what
 * is typed), the yes/no confirmation (`confirm`), and the interrupt handling every question
 * shares.
 *
 * WHERE EACH BYTE GOES, measured against the frozen CLI on a pseudo-terminal: the question
 * goes to STDOUT with its trailing spaces stripped -- `Password for bob:` -- and the
 * password read then opens `/dev/tty`, turns ECHO off, writes a space there, reads one
 * line, restores the terminal and writes a newline there. Nothing typed is ever shown, and
 * the terminal is read even when stdin is a file. This asked a readline question on stdin
 * with the prompt on stderr and echo ON, so every character of a password typed into
 * `users add --ask-password` or `users passwd --ask-password` was printed back to the
 * terminal, and it refused with exit 2 whenever stdin was not a terminal.
 *
 * WITHOUT `/dev/tty` -- no controlling terminal: a detached job, cron -- the read falls back
 * to stdin: echo off on it if it is a terminal, else `Warning: Password input may be
 * echoed.` and a plain line read. Either way the space before the answer and the newline
 * after it go to STDERR. The fallback's other line, the previous implementation's runtime
 * warning (`GetPassWarning: ...`, with the library file and line it came from), is about
 * that runtime rather than houston, and is not reproduced.
 *
 * The line runs up to and excluding one `\n`, a `\r` before it kept, the last line without
 * one taken as it is. End of input and Ctrl-C are both an abort: a newline on stdout and
 * `Aborted.`. On the terminal the line is edited by readline rather than by the kernel's
 * line discipline, so only the editing keys differ (a mid-line Ctrl-D deletes forward here
 * and delivers the partial line there).
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import * as tty from 'node:tty';

import { stripText } from '../../lib/float-text';
import { Aborted } from '../app';

/** Something a Ctrl-C can arrive on: the process, and a readline interface in raw mode. */
interface SigintSource {
  once(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

/**
 * A question under Ctrl-C: an interrupted QUESTION is an abort, `Aborted.` on stderr and
 * exit 1, with an `end` record saying 1 -- not the silent 130 of an interrupt anywhere else
 * in a command. MEASURED against the previous implementation, by `kill -INT` and by Ctrl-C
 * typed on a pseudo-terminal: `down --name <ws> --volumes` leaves its question on stdout
 * with no newline and then `Aborted.`; `users add <name> --ask-password` writes a newline
 * to stdout first, which the hidden prompt does because the password read leaves the
 * cursor on the question's line (`hidden`).
 *
 * Holding a SIGINT listener while the question waits is also what tells `runMain`'s handler
 * that this command answers the interrupt itself. On a terminal, readline in terminal mode
 * reads Ctrl-C as a keypress and raises no signal; with no `SIGINT` listener on the interface
 * it rejected the pending question with an AbortError, which reached the contract's last
 * line as an unhandled error -- a JS stack, an `error` record with `trace: true` and exit 1
 * (measured on Node 24.20: `users add bob --ask-password`, Ctrl-C at the password).
 */
export async function interruptible<T>(
  source: SigintSource | null,
  answer: Promise<T>,
  hidden: boolean,
): Promise<T> {
  let abort = (): void => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      if (hidden) process.stdout.write('\n');
      reject(new Aborted());
    };
  });
  process.once('SIGINT', abort);
  source?.once('SIGINT', abort);
  try {
    return await Promise.race([answer, interrupted]);
  } finally {
    process.off('SIGINT', abort);
    source?.off('SIGINT', abort);
  }
}

/** Swallows readline's own echo and cursor movement: nothing typed may reach a terminal. */
function muted(): Writable {
  return new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
}

/** One line from a terminal in raw mode, echo swallowed; null at end of input (Ctrl-D). */
async function terminalLine(input: NodeJS.ReadableStream): Promise<string | null> {
  const rl = readline.createInterface({ input, output: muted(), terminal: true });
  try {
    return await interruptible(
      rl,
      new Promise<string | null>((resolve) => {
        rl.once('line', resolve);
        rl.once('close', () => {
          resolve(null);
        });
      }),
      true,
    );
  } finally {
    rl.close(); // leaves raw mode: the terminal's own echo is back
  }
}

/**
 * Stdin's lines across prompts: the second prompt reads the line after the first, from the
 * same buffer, as a buffered stdin does. Paused between reads, so a pipe left open does not
 * hold the process. The hidden prompt reads it only when stdin is not a terminal;
 * `confirm` always, since its terminal is read in cooked mode, a line at a time.
 */
class StdinLines {
  private buffer = Buffer.alloc(0);
  private ended = false;
  /** The read in flight's release, while one is. */
  private reading: (() => void) | null = null;

  /**
   * Abandons the read in flight: its listeners off and stdin paused. A question a Ctrl-C
   * interrupted leaves one behind, and stdin still flowing holds the process open after
   * `Aborted.` for as long as the pipe feeding it does.
   */
  stop(): void {
    this.reading?.();
  }

  async next(): Promise<string | null> {
    for (;;) {
      const at = this.buffer.indexOf(0x0a);
      if (at >= 0) {
        const line = this.buffer.subarray(0, at).toString('utf8');
        this.buffer = this.buffer.subarray(at + 1);
        return line;
      }
      if (this.ended) {
        if (this.buffer.length === 0) return null;
        const line = this.buffer.toString('utf8');
        this.buffer = Buffer.alloc(0);
        return line;
      }
      await this.fill();
    }
  }

  private fill(): Promise<void> {
    const stdin = process.stdin;
    return new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        settle();
      };
      const onEnd = (): void => {
        this.ended = true;
        settle();
      };
      const onError = (error: Error): void => {
        release();
        reject(error);
      };
      const release = (): void => {
        this.reading = null;
        stdin.off('data', onData);
        stdin.off('end', onEnd);
        stdin.off('error', onError);
        stdin.pause();
      };
      const settle = (): void => {
        release();
        resolve();
      };
      this.reading = release;
      stdin.on('data', onData);
      stdin.once('end', onEnd);
      stdin.once('error', onError);
      stdin.resume();
    });
  }
}

let stdinLines: StdinLines | null = null;

/** `open('/dev/tty', O_RDWR | O_NOCTTY)`, or null where that fails and the read uses stdin. */
function openTerminal(): number | null {
  try {
    return fs.openSync('/dev/tty', fs.constants.O_RDWR | fs.constants.O_NOCTTY);
  } catch {
    return null;
  }
}

/** The password read's answer, or null at end of input. */
async function readHiddenLine(): Promise<string | null> {
  const fd = openTerminal();
  if (fd !== null) {
    const input = new tty.ReadStream(fd);
    try {
      fs.writeSync(fd, ' ');
      const line = await terminalLine(input);
      if (line !== null) fs.writeSync(fd, '\n');
      return line;
    } finally {
      input.destroy();
      fs.closeSync(fd); // the stream does not close a descriptor it was handed
    }
  }
  if (process.stdin.isTTY) {
    process.stderr.write(' ');
    const line = await terminalLine(process.stdin);
    if (line !== null) process.stderr.write('\n');
    return line;
  }
  process.stderr.write('Warning: Password input may be echoed.\n ');
  stdinLines ??= new StdinLines();
  const line = await interruptible(null, stdinLines.next(), true);
  if (line !== null) process.stderr.write('\n');
  return line;
}

/**
 * A yes/no question with a default of no, a "no" ending the command, which is every
 * question this CLI asks before destroying something (`down --volumes`, `prune`'s
 * `Continue?` and `Delete the cluster?`, `edge delete`, `cluster delete`).
 *
 * It LOOPS: the answer is lower-cased and stripped (`stripText`); `y`/`yes` is yes, `n`/`no`
 * and the empty answer are no, and anything else writes `Error: invalid input` to stdout
 * and asks again. End of input and Ctrl-C are an abort, with NOTHING written -- no newline
 * after the question, unlike the hidden prompt's. On a stdin that is not a terminal the
 * line is the next one with its one `\n` removed, so a `\r` before it is part of the answer
 * until the strip removes it; the lines come from the process's one stdin buffer, so an
 * answer already read ahead is not lost between attempts.
 *
 * An earlier version read ONE line and took anything but y/yes as no, stripped with `trim()`:
 * `x` then `y` deleted the data in the established CLI and aborted here; a BOM before `y`
 * (which `stripText` keeps) aborted there and deleted here; `\x1cy` or `y\x85` (which it
 * removes and `trim()` does not) the other way round; and end of input wrote a newline the
 * established CLI does not.
 */
export async function confirm(question: string): Promise<boolean> {
  for (;;) {
    process.stdout.write(`${question} [y/N]: `);
    const lines = (stdinLines ??= new StdinLines());
    let line: string | null;
    try {
      line = await interruptible(null, lines.next(), false);
    } finally {
      lines.stop();
    }
    if (line === null) return false;
    const value = stripText(line.toLowerCase());
    if (value === 'y' || value === 'yes') return true;
    if (value === 'n' || value === 'no' || value === '') return false;
    process.stdout.write('Error: invalid input\n');
  }
}

/** The hidden prompt: the question, then a read that shows nothing typed. */
export async function hiddenPrompt(question: string): Promise<string> {
  // An empty entry is asked again, question and all, where this took '' as the password
  // and refused it as too short -- `users add bob --ask-password` with Enter pressed first.
  for (;;) {
    process.stdout.write(`${question}:`);
    const line = await readHiddenLine();
    if (line === null) {
      // End of input or Ctrl-C: a newline, then the abort.
      process.stdout.write('\n');
      throw new Aborted();
    }
    if (line !== '') return line;
  }
}
