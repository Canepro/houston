/**
 * The CLI's verdict on an argv, held to the verdict earlier releases gave, byte for byte.
 *
 * The CLI runs IN-PROCESS on each argv at each width, as `runCli` with a stub executor, so
 * a verdict of "run" is observable and nothing a command does can happen. What earlier
 * releases answered for the same argv at the same width was recorded the same way: their
 * real command-line app with every command replaced by a stub. For each argv the verdicts
 * must agree -- run, help for the same target, the version, or a usage error -- and a usage
 * error must be the same bytes on stderr with nothing on stdout.
 *
 * The corpus is generated from COMMAND_SPECS so every command and option is reached: unknown
 * long and short options, near misses with their "Possible options", options missing their
 * value, flags given one, values that are not numbers, required options and arguments left
 * out, extra arguments, `--help` before and after an error, and the root and `skill` group
 * shapes as earlier releases answered them. Each recorded verdict is keyed by its argv and
 * width; a case with no recorded verdict is a mismatch, never a pass.
 *
 * The same corpus runs again in homes whose accounts file cannot be read -- a directory, and
 * mode 000 -- because the root callback reads it on every invocation, and earlier releases
 * run it BETWEEN resolving the command's name and parsing the command's argv. There they
 * answer `up --bogus` and `up --help` with `error: cannot read .../users: ...` and exit 2,
 * and only what the root answers itself -- `--help`, `--version`, no argument, an unknown
 * command -- is answered as in a sound home. That failure was recorded as their `main`
 * reports it, which is the path a real run takes. The home's path is kept as `<home>` in the
 * recorded answers and put back from this run's.
 *
 * A verdict of "run" carries the NUMBERS the command was handed, too: `--tail 𝟙𝟘` runs,
 * and only the value -- 10 in earlier releases, 99 in an earlier version of this one -- says
 * whether the digits were read as earlier releases read them.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DECIMAL_DIGITS, UNICODE_VERSION } from '../../src/lib/unicode-tables';

import { runCli } from '../../src/cli/app';
import type { Invocation } from '../../src/cli/app';
import type { ConsoleEnvironment } from '../../src/cli/error-panel';
import { COMMAND_SPECS } from '../../src/cli/spec-data';
import type { CommandSpec } from '../../src/cli/spec-types';

const SPECS: readonly CommandSpec[] = COMMAND_SPECS;

/** A number as JSON carries it: finite as itself, the rest as `nan`, `inf` and `-inf`. */
type Numbers = Readonly<Record<string, number | string>>;

interface Outcome {
  readonly code: number | null;
  readonly ran: string | null;
  /** Every int and float parameter the command was called with, by name, when it ran. */
  readonly values: Numbers | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A verdict, as `shape` reduces an outcome to one. */
type Verdict = Record<string, unknown>;
/** A test's cases: each case's key, and the index of the verdict earlier releases gave. */
type Recorded = Readonly<Record<string, number>>;

/**
 * The verdicts earlier releases gave, by test and then by case. Each case's key is its argv
 * and width as JSON, with an argument longer than 64 characters spelt by its length and the
 * first 16 hex digits of its sha256, so the 4,300-digit texts do not make the key; its value
 * is an index into `verdicts`, where each distinct verdict is kept once.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cli', 'usage-error.json'), 'utf8'),
) as {
  verdicts: Verdict[];
  cases: {
    rootShapes: Recorded;
    corpus: Recorded;
    narrowUsage: Recorded;
    numbers: Recorded;
    overridden: Recorded;
    brokenHomes: Record<'a directory' | 'mode 000' | 'not UTF-8', Recorded>;
  };
};

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function caseKey(argv: readonly string[], columns: number | null): string {
  const spelt = argv.map((word) =>
    word.length > 64 ? `<${String(word.length)} chars, sha256 ${sha256(word).slice(0, 16)}>` : word,
  );
  return JSON.stringify([spelt, columns]);
}

/** The int and float parameters of an invocation, spelt as the recorded runs spell them. */
function numbers(invocation: Invocation): Numbers {
  const out: Record<string, number | string> = {};
  for (const [name, value] of Object.entries({ ...invocation.arguments, ...invocation.options })) {
    if (typeof value !== 'number') continue;
    if (Number.isFinite(value)) out[name] = value;
    else out[name] = Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf';
  }
  return out;
}

async function typescript(
  argv: readonly string[],
  columns: number | null,
  houstonHome: string | null,
): Promise<Outcome> {
  let stdout = '';
  let stderr = '';
  const previousHome = process.env.HOUSTON_HOME;
  if (houstonHome !== null) process.env.HOUSTON_HOME = houstonHome;
  const seen: { ran: string | null; values: Numbers | null } = { ran: null, values: null };
  const console: ConsoleEnvironment = {
    env: columns === null ? {} : { COLUMNS: String(columns) },
    isatty: () => false,
    columns: () => null,
  };
  // jsonout writes its envelope to process.stdout itself, so that is captured too: a usage
  // error under --json must leave stdout EMPTY, as earlier releases do.
  const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  try {
    const code = await runCli(argv, {
      execute: async (invocation) => {
        seen.ran = invocation.spec.path;
        seen.values = numbers(invocation);
        return {};
      },
      io: {
        writeOut: (text) => {
          stdout += text;
        },
        writeErr: (text) => {
          stderr += text;
        },
      },
      console,
    });
    const { ran, values } = seen;
    return { code: ran === null ? code : null, ran, values, stdout, stderr };
  } finally {
    write.mockRestore();
    process.env.HOUSTON_HOME = previousHome;
  }
}

/**
 * What a verdict IS, for comparison. Help is compared by the Usage paragraph it opens with,
 * whitespace collapsed: help is content-equal by the owner's decision (earlier releases wrap
 * it to the terminal and this renderer does not).
 */
function shape(outcome: Outcome) {
  if (outcome.ran !== null) {
    const values = Object.entries(outcome.values ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
    return { ran: outcome.ran, values: Object.fromEntries(values) };
  }
  const usage = /(?:^|\n) ?Usage:([^]*?)(?:\n\s*\n|$)/u.exec(outcome.stdout)?.[1] ?? null;
  if (outcome.stderr === '' && usage !== null) {
    return { code: outcome.code, help: usage.replace(/\s+/gu, ' ').trim() };
  }
  // An envelope's one moment-dependent field: the recorded run was at another moment.
  const stdout = outcome.stdout.replace(/"generated_at": "[^"]*"/gu, '"generated_at": "-"');
  // A stack trace is each runtime's own frames, so it is compared by being there, and the
  // line after it -- the report, `error: <message> - this is unhandled, ...` --
  // byte for byte.
  if (STACK_TRACE.test(outcome.stderr)) {
    return { code: outcome.code, stdout, stackTrace: lastLine(outcome.stderr) };
  }
  return { code: outcome.code, stdout, stderr: outcome.stderr };
}

/** A V8 stack's first frame, which is how a stack trace on stderr is recognised. */
const STACK_TRACE = /\n {4}at /u;

function lastLine(text: string): string {
  const lines = text.split('\n').filter((line) => line !== '');
  return lines[lines.length - 1] ?? '';
}

/**
 * `houstonHome` is the home the CLI runs in: by default an empty one of its own, or one this
 * file built with a broken accounts file, as the recorded runs had. Its path is spelt
 * `<home>` in a verdict, as it is in the recorded ones.
 */
async function compare(
  cases: readonly (readonly [readonly string[], number | null])[],
  recorded: Recorded,
  houstonHome: string | null = null,
) {
  const mismatches: unknown[] = [];
  for (const [argv, columns] of cases) {
    const typescriptOutcome = await typescript(argv, columns, houstonHome);
    const at = recorded[caseKey(argv, columns)];
    const expected = at === undefined ? undefined : RECORDED.verdicts[at];
    if (expected === undefined) {
      mismatches.push({ argv, columns, recorded: '<no recorded verdict>' });
      continue;
    }
    // A command's own validation of its values (`users -`: "unknown action") runs before
    // the executor here and inside the stubbed command in the recorded run. Both mean the
    // argv was accepted; what the command then says is for the real commands to answer, not
    // this stubbed harness.
    if ('ran' in expected && /^error: /u.test(typescriptOutcome.stderr)) continue;
    const ranIn = houstonHome ?? process.env.HOUSTON_HOME ?? '';
    const ours = JSON.stringify(shape(typescriptOutcome)).split(ranIn).join('<home>');
    if (ours !== JSON.stringify(expected)) {
      mismatches.push({ argv, columns, recorded: expected, typescript: JSON.parse(ours) });
    }
  }
  return mismatches;
}

/** Arguments that satisfy a command's required parameters, so a later error is the one seen. */
function required(spec: CommandSpec): string[] {
  const out: string[] = [];
  for (const argument of spec.arguments) if (argument.required) out.push('x');
  for (const option of spec.options) if (option.required) out.push(option.long, '8.5.1');
  return out;
}

function corpus(): string[][] {
  const out: string[][] = [];
  for (const spec of SPECS) {
    const base = spec.path.split(' ');
    const ok = [...base, ...required(spec)];
    out.push(
      [...base, '--bogus'],
      [...base, '-Z'],
      [...ok, '--bogus', '--help'],
      [...base, '--help', '--bogus'],
      [...base, '--help'],
      [...ok, 'e1', 'e2', 'e3', 'e4', 'e5'],
      [...base, '--bogus=1'],
      [...base, '-'],
    );
    if (spec.arguments.length === 0) out.push([...base, '--', '--help'], [...ok, 'stray']);
    for (const option of spec.options) {
      const [long] = option.long.split('/') as [string];
      if (option.value === 'boolean') {
        out.push([...base, `${long}=1`]);
      } else {
        out.push([...base, long]);
        if (option.short !== undefined) out.push([...base, option.short]);
        if (option.value === 'integer' || option.value === 'float') {
          out.push([...base, long, 'nope'], [...base, long, '1_0'], [...base, long, ' 7 ']);
        }
      }
      if (long.length > 5) out.push([...base, long.slice(0, -2)]);
    }
    if (spec.json.mode === 'flag') {
      out.push(
        [...base, '--json=yes'],
        [...base, '--js'],
        [...ok, '--json', '--bogus'],
        [...ok, '--json', 'stray'],
      );
    }
    if (
      spec.arguments.some((argument) => argument.required) ||
      spec.options.some((o) => o.required)
    ) {
      out.push([...base]);
    }
  }
  return out;
}

const ROOT_SHAPES: string[][] = [
  [],
  ['--help'],
  ['--version'],
  ['-V'],
  ['-h'],
  ['--verbose', 'up', '--help'],
  ['--version', 'up'],
  ['--help', 'up'],
  ['--', 'up', '--help'],
  ['--'],
  ['--', '--help'],
  ['--', '--'],
  ['--', '--bogus'],
  ['--', 'lst'],
  ['--', 'skill', 'install', '--help'],
  ['skill'],
  ['skill', '--help'],
  ['skill', 'install', '--help'],
  ['skill', 'status', '--help'],
  ['skill', 'frob'],
  ['skill', 'instal'],
  ['skill', '--', 'status', '--help'],
  ['skill', '--json', 'status', '--help'],
  ['skill', '--bogus'],
  ['nosuchcommand'],
  ['lst'],
  ['stat'],
  ['help'],
  ['help', 'up'],
  ['-', 'up', '--help'],
  ['--version=1'],
  ['--help=1'],
  ['LIST', '--help'],
  [''],
  ['_x'],
  ['-V', '--help'],
  ['--help', '--version'],
  ['-V', '--bogus'],
  ['--bogus', '-V'],
  ['-Vx'],
  ['-hV'],
  ['--vers'],
  ['up', '-h'],
  ['up', '-vx'],
  ['up', '--version'],
  ['up', '--version', '1', '--port', '5', '--port', 'x'],
  ['up', '--port', 'abc'],
  ['up', '--port', 'abc', '--bogus'],
  ['up', '--version', '8.5.1'],
  ['up', '--name', '--help', '--version', '8.5.1'],
  ['skill install'],
  ['--', 'skill status'],
  ['skill', 'status now'],
  ['audit', '-n', 'x'],
  ['audit', '--lines', 'x'],
  ['list'],
  ['versions', '8.5.1'],
  ['users', 'list', 'a', 'b', 'c'],
  ['config', 'set', 'k', 'v', 'extra'],
  ['api', 'GET'],
  ['--', 'up', '--version', '8.5.1'],
  // Names assigned after Unicode 15.0, which earlier releases escape in the message.
  ['\u{116D0}'],
  ['skill', '\u088f'],
];

/** Every int and float option, with the command that declares it. */
function numericOptions() {
  return SPECS.flatMap((spec) =>
    spec.options
      .filter((option) => option.value === 'integer' || option.value === 'float')
      .map((option) => [spec, option] as const),
  );
}

describe("the CLI's verdict on an argv is the one earlier releases gave", () => {
  test('the root and skill group shapes, at 80, 100, 44 and 20 columns', async () => {
    const cases = ROOT_SHAPES.flatMap((argv) =>
      [null, 100, 44, 20].map((columns) => [argv, columns] as const),
    );
    expect(await compare(cases, RECORDED.cases.rootShapes)).toEqual([]);
  }, 120_000);

  test('every command: unknown, misspelt, valueless and non-numeric options, extras, --help', async () => {
    const cases = corpus().map((argv) => [argv, null] as const);
    expect(cases.length).toBeGreaterThan(500);
    expect(await compare(cases, RECORDED.cases.corpus)).toEqual([]);
  }, 300_000);

  test('usage lines wrap as earlier releases wrapped them on a narrow terminal', async () => {
    const cases = ['config-import', 'config', 'users', 'api', 'skill install'].flatMap((name) =>
      [30, 44, 55, 56, 57].map((columns) => [[...name.split(' '), '--bogus'], columns] as const),
    );
    expect(await compare(cases, RECORDED.cases.narrowUsage)).toEqual([]);
  }, 120_000);

  test('every int and float option reads its digits and spaces as earlier releases did', async () => {
    const numeric = numericOptions();
    expect(numeric).toHaveLength(18);
    const cases = numeric.flatMap(([spec, { long }]) =>
      NUMBER_TEXTS.map(
        (text) => [[...spec.path.split(' '), ...required(spec), long, text], null] as const,
      ),
    );
    expect(await compare(cases, RECORDED.cases.numbers)).toEqual([]);
  }, 300_000);

  test('an int or float option given twice is read only from the occurrence earlier releases keep', async () => {
    // Earlier releases store each occurrence over the one before and convert what is left, so
    // a text a later occurrence overrides is never read as a number. Commander ran its
    // argParser on every occurrence, and each of these, overridden, refused the argv here and
    // ran in earlier releases (2026-09-25): `audit -n 𑛐 --lines 2`, `logs --tail abc --tail
    // 5`, and the 2**53 deviation reached even a value earlier releases throw away. The
    // reverse order, where the kept text is the bad one, is a usage error in both.
    const numeric = numericOptions();
    expect(numeric).toHaveLength(18);
    const cases = numeric.flatMap(([spec, option]) => {
      const base = [...spec.path.split(' '), ...required(spec)];
      const first = option.short ?? option.long;
      return [
        ...OVERRIDDEN_TEXTS.map(
          (text) => [[...base, first, text, option.long, '5'], null] as const,
        ),
        [[...base, option.long, '5', first, '\u{116D0}'], null] as const,
        [[...base, option.long, '5', option.long, 'abc'], null] as const,
      ];
    });
    expect(await compare(cases, RECORDED.cases.overridden)).toEqual([]);
  }, 300_000);

  test('the decimal-digit table is the one earlier releases read digits by', () => {
    // Every code point with a decimal digit value, as `[code point, value]`, in the Unicode
    // version earlier releases read digits by: pinned as its count and the sha256 of its
    // JSON, with the edges spelt out, so a change says where it is.
    const recorded = {
      version: '15.0.0',
      count: 680,
      sha256: '7a18033a45789a45ba44d8bbd7656be5746e2fabe38e9876fd8c4316828fc6a4',
    };
    const ours = DECIMAL_DIGITS.flatMap(([first, last, value]) =>
      Array.from({ length: last - first + 1 }, (_, at) => [first + at, value + at]),
    );
    expect(UNICODE_VERSION).toBe(recorded.version);
    expect({ count: ours.length, sha256: sha256(JSON.stringify(ours)) }).toEqual({
      count: recorded.count,
      sha256: recorded.sha256,
    });
    // ASCII, Arabic-Indic, Thai, fullwidth, the mathematical bold and double-struck runs
    // (where 𝟙𝟘 is 10), and the segmented digits that close the table.
    expect(ours.slice(0, 3)).toEqual([
      [48, 0],
      [49, 1],
      [50, 2],
    ]);
    for (const pair of [
      [57, 9],
      [1632, 0],
      [1785, 9],
      [3664, 0],
      [65296, 0],
      [65303, 7],
      [120782, 0],
      [120792, 0],
      [120793, 1],
      [120831, 9],
      [130032, 0],
    ]) {
      expect(ours).toContainEqual(pair);
    }
    expect(ours.slice(-1)).toEqual([[130041, 9]]);
    // Not digits there: superscripts, and what Unicode 16.0 added after that version.
    const codes = new Set(ours.map(([code]) => code));
    for (const code of [0xb2, 0x2070, 0x116d0, 0x1ccf0, 0x1ccf1])
      expect(codes.has(code)).toBe(false);
  });

  test('an integer beyond 2**53 ran in earlier releases and is refused here: a known deviation', async () => {
    // Kept on purpose: no numeric option means anything at that size, and JavaScript cannot
    // hold the value earlier releases would pass, so `parseInteger` refuses it rather than
    // round it.
    const argv = ['logs', '--tail', '9007199254740993'];
    // What earlier releases did with it: ran `logs` with a tail of 9007199254740993.
    const recorded = { ran: 'logs' };
    const ours = await typescript(argv, 200, null);
    expect(recorded.ran).toBe('logs');
    expect(ours.code).toBe(2);
    expect(ours.stderr).toContain('integer is out of range: 9007199254740993');
  });
});

/**
 * The texts an int or float option is given, each chosen where this build's reading of a
 * number and earlier releases' measured apart before the fix (2026-09-25, Node 24.20.0):
 */
const NUMBER_TEXTS: readonly string[] = [
  // U+1D7D9 U+1D7D8: the double-struck digits follow the bold ones with no gap, so walking
  // back to "the zero that starts the run" read 99; earlier releases read 10.
  '\u{1D7D9}\u{1D7D8}',
  '\u{1D7D8}',
  // Digits assigned in Unicode 16.0, which Node 24's \p{Nd} has and the Unicode 15.0 of
  // earlier releases does not: a usage error there, whose message escapes them as \u{116d0}.
  '\u{116D0}',
  '\u{1CCF1}\u{1CCF0}',
  // Digits both databases have, as a control.
  '\u0e51\u0e50',
  '\uff17',
  // Earlier releases read at most 4300 digits: zeros count, a sign, spaces and underscores do not.
  '0'.repeat(4300),
  '0'.repeat(4301),
  '1'.repeat(4301),
  `+${'0'.repeat(4300)}`,
  ` ${'0_'.repeat(4299)}0 `,
  `${'0_'.repeat(4300)}0`,
  // Whitespace: earlier releases turn Unicode spaces into ASCII ones and strip only ASCII
  // whitespace -- not the information separators, and not a BOM.
  '\u001c7',
  '7\u001f',
  '\ufeff7',
  '\u20037\u3000',
  '\u00857',
];

/**
 * Texts that, given to an int or float option and then overridden by a later occurrence,
 * refused the argv here while earlier releases never read them (measured 2026-09-25, before
 * commander lost its numeric argParser): a word, a digit Unicode 16.0 assigned, one digit
 * over the 4300 earlier releases read, an integer beyond 2**53, and an information separator
 * and a BOM, which earlier releases do not strip.
 */
const OVERRIDDEN_TEXTS: readonly string[] = [
  'abc',
  '\u{116D0}',
  '0'.repeat(4301),
  '9007199254740993',
  '\u001c7',
  '\ufeff7',
];

const brokenHomes: string[] = [];
afterAll(() => {
  for (const made of brokenHomes.splice(0)) fs.rmSync(made, { recursive: true, force: true });
});

type Broken = 'a directory' | 'mode 000' | 'not UTF-8';

/**
 * A home whose accounts file is there and cannot be read, and whether reading it really fails
 * -- which a file that is not UTF-8 does not: its bytes read, and it is the strict UTF-8
 * decode that fails, as a decode error rather than an OS error.
 */
function brokenHome(shape: Broken): { home: string; unreadable: boolean } {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-usage-users-'));
  brokenHomes.push(made);
  const users = path.join(made, 'users');
  if (shape === 'a directory') {
    fs.mkdirSync(users);
    return { home: made, unreadable: true };
  }
  if (shape === 'not UTF-8') {
    // `al\xffice`: 0xff is never UTF-8, so the decode stops at position 2.
    fs.writeFileSync(users, Buffer.from('al\xffice:x:2026-01-01:admin\n', 'latin1'));
    return { home: made, unreadable: false };
  }
  fs.writeFileSync(users, 'alice:x:2026-01-01:admin\n');
  fs.chmodSync(users, 0o000);
  let unreadable = false;
  try {
    fs.readFileSync(users);
  } catch {
    unreadable = true;
  }
  return { home: made, unreadable };
}

describe('with an accounts file that cannot be read, the root callback answers where earlier releases run it', () => {
  test.each(['a directory', 'mode 000', 'not UTF-8'] as const)(
    'users is %s: the root and skill shapes, and every command in the corpus',
    async (shape) => {
      const broken = brokenHome(shape);
      // Root reads a mode-000 file, so there that shape is the readable file it then is, and
      // is compared as that: earlier releases answered a readable accounts file, recorded
      // case by case, exactly as they answered a sound home, so those are its verdicts. The
      // directory and not-UTF-8 shapes carry the failure on every box.
      expect(broken.unreadable).toBe(
        shape === 'a directory' || (shape === 'mode 000' && process.getuid?.() !== 0),
      );
      const cases = [
        ...ROOT_SHAPES.flatMap((argv) => [null, 44].map((columns) => [argv, columns] as const)),
        ...corpus().map((argv) => [argv, null] as const),
      ];
      const recorded =
        shape === 'mode 000' && !broken.unreadable
          ? { ...RECORDED.cases.rootShapes, ...RECORDED.cases.corpus }
          : RECORDED.cases.brokenHomes[shape];
      expect(await compare(cases, recorded, broken.home)).toEqual([]);
    },
    300_000,
  );

  test.each([
    {
      shape: 'a directory',
      code: 2,
      refusal: /^error: cannot read .*users: Is a directory\n$/u,
      envelope: 'VALIDATION_FAILED',
    },
    {
      // Earlier releases catch only an OS error around the read, and a decode error is not
      // one: it escapes the callback and the app, and `main` reports it as unhandled, after
      // the stack trace.
      shape: 'not UTF-8',
      code: 1,
      refusal: new RegExp(
        '\\n {4}at [^]*\\nerror: .*users is not valid UTF-8 \\(byte 0xff at position 2: invalid ' +
          'start byte\\) - this is unhandled, and the stack trace is on stderr\\. ' +
          'If it names a file under HOUSTON_HOME, that file is the problem\\.\\n$',
        'u',
      ),
      envelope: 'REPRO_ERROR',
    },
  ] as const)(
    'users is $shape: the failure is the answer after the name resolves, and only then',
    async ({ shape, code, refusal, envelope }) => {
      // What the comparison above agreed on, stated: it is not an agreement to ignore the
      // file. `--help`, `--version`, `nosuch` and `-- --help` end at the root, before the
      // callback; `-- up --help` and `skill` resolve a name, and so reach it.
      const broken = brokenHome(shape);
      const answers: Record<string, unknown> = {};
      for (const argv of [
        ['up', '--bogus'],
        ['up', '--help'],
        ['--', 'up', '--help'],
        ['skill'],
        ['skill', 'install', '--help'],
        ['users', 'bogus'],
        ['--help'],
        ['--version'],
        ['nosuch'],
        ['--', '--help'],
      ]) {
        const got = await typescript(argv, null, broken.home);
        answers[argv.join(' ')] = refusal.test(got.stderr) ? got.code : 'answered';
      }
      expect(answers).toEqual({
        'up --bogus': code,
        'up --help': code,
        '-- up --help': code,
        skill: code,
        'skill install --help': code,
        'users bogus': code,
        '--help': 'answered',
        '--version': 'answered',
        nosuch: 'answered',
        '-- --help': 'answered',
      });
      // Under --json, one envelope, as earlier releases write it from argv.
      const json = await typescript(['list', '--json'], null, broken.home);
      expect(JSON.parse(json.stdout.trim()) as unknown).toMatchObject({
        ok: false,
        schema: 'houston.error.v1',
        error: { code: envelope },
      });
      expect(json.code).toBe(code);
    },
  );
});
