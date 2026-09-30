/**
 * What the frozen CLI does with an argv BEFORE any command runs: print help, print the
 * version, report a usage error, or run the command -- decided by the rules below.
 *
 * ## Why this exists, and why it follows these rules exactly
 *
 * The TypeScript CLI parses with commander, and on a valid argv commander agrees with the
 * established CLI. On edge argv it did not: commander checks required options before unknown
 * ones, names errors in its own words, prints each one twice, has an implicit `help`
 * command, reads `--help` after `--` as an operand, answers `--help --version` with the
 * version, exits 0 with no argument, and puts an envelope on stdout for a `--json` usage
 * error. The owner's decision is that TypeScript reports these exactly as earlier releases
 * report them.
 * "Exactly" is not reachable by adjusting commander's messages, because the ORDER in which
 * errors are found is part of the answer -- so this is that order, reproduced:
 *
 *   1. The option parser walks the tokens. An unknown option (`NoSuchOption`, with its
 *      close matches), an option missing its value or given one it does not take fails
 *      HERE, before any value is looked at.
 *   2. The processing order: eager parameters first (`--help`, the root's `--version`),
 *      then the parameters as they appeared on the command line, then the rest in
 *      declaration order. Each is type-converted and checked for a required value;
 *      the first that fails is the error, and an eager `--help` stops everything.
 *   3. Leftover positional tokens are `Got unexpected extra argument(s) (...)`.
 *   4. A group (the root, `skill`) resolves its command AFTER its own parameters: `No such
 *      command`, with the close command names suggested, or `Missing command.`; a name that
 *      looks like an option (after `--`) is parsed as the group's options again.
 *   5. The group then runs its CALLBACK -- and only then parses the command's own argv. The
 *      root has one, `beforeAnyCommand` (`./app`), and it reads the accounts file on every
 *      invocation; `skill` has none (measured). So with a `users` that is a directory, or
 *      mode 000, the CLI answers `up --bogus`, `up --help`, `-- up --help`, `skill` and
 *      `skill install --help` with `error: cannot read .../users: Is a directory` and
 *      exit 2 -- where steps 1-4 at the root (`--help`, `--version`, no
 *      argument, `nosuch`, `--`, `-- --help`) still answer as they always do, because they
 *      end before the callback runs. `judgeArgv`'s caller supplies the callback; a
 *      `ReproError` it throws is the answer.
 *
 * The model is built from COMMAND_SPECS -- the declaration `capabilities` and help come from
 * -- and `test/cli/usage-error.test.ts` holds it, parameter by parameter, to the model the
 * previous implementation builds at run time, and holds the verdicts and their bytes to
 * that CLI's own output.
 *
 * A usage error is rendered as the usage-error block (`./error-panel`): the Usage line and the Try
 * line when the error carries a command's context -- an error from the token walk in step 1
 * other than an unknown option has none -- then the boxed Error panel.
 */
import { getCloseMatches } from '../lib/close-matches';
import { parseFloat_, toInt, quotedText } from '../lib/format';

import { commandUsage } from './help';
import {
  PROCESS_CONSOLE,
  consoleWidth,
  errorPanel,
  formatterColumns,
  printed,
} from './error-panel';
import type { ConsoleEnvironment } from './error-panel';
import { COMMAND_SPECS } from './spec-data';
import type { CommandSpec } from './spec-types';

// ----------------------------------------------------------------------------- model

type ValueType = 'string' | 'integer' | 'number' | 'boolean';

interface Param {
  readonly kind: 'option' | 'argument';
  readonly dest: string;
  /** The parameter's names, in declaration order; an argument's is its own name. */
  readonly opts: readonly string[];
  readonly secondary: readonly string[];
  readonly flag: boolean;
  readonly eager: boolean;
  readonly required: boolean;
  readonly multiple: boolean;
  readonly type: ValueType;
  readonly role?: 'help' | 'version';
}

/** What a group answers with help for; a command answers with its spec. */
export type HelpTarget = 'root' | 'skill' | CommandSpec;

interface CommandModel {
  /** The command path: `houston`, `houston skill`, `houston skill install`. */
  readonly path: string;
  /** What the Usage line writes after `Usage: <path> `. */
  readonly usageArgs: string;
  readonly params: readonly Param[];
  readonly target: HelpTarget;
  readonly group: {
    readonly commands: ReadonlyMap<string, CommandModel>;
    readonly noArgsIsHelp: boolean;
    /** Whether the group has a callback, run between resolving a command and parsing it. */
    readonly callback: boolean;
  } | null;
}

const HELP: Param = {
  kind: 'option',
  dest: 'help',
  opts: ['--help'],
  secondary: [],
  flag: true,
  eager: true,
  required: false,
  multiple: false,
  type: 'boolean',
  role: 'help',
};

const VALUE_TYPE: Readonly<Record<string, ValueType>> = {
  string: 'string',
  integer: 'integer',
  float: 'number',
  boolean: 'boolean',
};

function leaf(spec: CommandSpec): CommandModel {
  const params: Param[] = spec.arguments.map((argument) => ({
    kind: 'argument',
    dest: argument.name,
    opts: [argument.name],
    secondary: [],
    flag: false,
    eager: false,
    required: argument.required,
    multiple: false,
    type: VALUE_TYPE[argument.value] as ValueType,
  }));
  const options: Param[] = spec.options.map((option) => {
    const [positive, negative] = option.long.split('/') as [string, string | undefined];
    const names = option.short === undefined ? [positive] : [positive, option.short];
    return {
      kind: 'option',
      dest: option.key,
      opts: option.shortFirst ? [...names].reverse() : names,
      secondary: option.negatablePair && negative !== undefined ? [negative] : [],
      flag: option.value === 'boolean',
      eager: false,
      required: option.required,
      multiple: option.repeatable,
      type: VALUE_TYPE[option.value] as ValueType,
    };
  });
  if (spec.json.mode === 'flag') {
    options.splice(spec.json.option?.index ?? options.length, 0, {
      kind: 'option',
      dest: 'json_out',
      opts: ['--json'],
      secondary: [],
      flag: true,
      eager: false,
      required: false,
      multiple: false,
      type: 'boolean',
    });
  }
  const usage = commandUsage(spec);
  return {
    path: `houston ${spec.path}`,
    usageArgs: usage.slice(`Usage: houston ${spec.path} `.length),
    params: [...params, ...options, HELP],
    target: spec,
    group: null,
  };
}

function buildModel(): CommandModel {
  const skill = new Map<string, CommandModel>();
  const top = new Map<string, CommandModel>();
  for (const spec of COMMAND_SPECS) {
    if (spec.path.startsWith('skill ')) skill.set(spec.path.slice('skill '.length), leaf(spec));
    else top.set(spec.path, leaf(spec));
  }
  top.set('skill', {
    path: 'houston skill',
    usageArgs: '[OPTIONS] COMMAND [ARGS]...',
    params: [HELP],
    target: 'skill',
    group: { commands: skill, noArgsIsHelp: false, callback: false },
  });
  return {
    path: 'houston',
    usageArgs: '[OPTIONS] COMMAND [ARGS]...',
    params: [
      {
        kind: 'option',
        dest: 'version',
        opts: ['--version', '-V'],
        secondary: [],
        flag: true,
        eager: true,
        required: false,
        multiple: false,
        type: 'boolean',
        role: 'version',
      },
      HELP,
    ],
    target: 'root',
    group: { commands: top, noArgsIsHelp: true, callback: true },
  };
}

let MODEL: CommandModel | null = null;
function model(): CommandModel {
  MODEL ??= buildModel();
  return MODEL;
}

// -------------------------------------------------------------------------- outcomes

/** A usage error: the message, and the command context it carries (null for none). */
class UsageProblem {
  constructor(
    public message: string,
    readonly context: CommandModel | null,
  ) {}

  /** What the panel shows. */
  formatted(): string {
    return this.message;
  }
}

/** `NoSuchOption`, whose close matches are appended when it is shown, not when raised. */
class NoSuchOption extends UsageProblem {
  constructor(
    name: string,
    context: CommandModel,
    readonly possibilities: readonly string[] = [],
  ) {
    super(`No such option: ${name}`, context);
  }

  override formatted(): string {
    if (this.possibilities.length === 0) return this.message;
    return `${this.message} (Possible options: ${[...this.possibilities].sort(compareCodePoints).join(', ')})`;
  }
}

/** String order by code point, not by UTF-16 unit. */
function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (ch) => ch.codePointAt(0) as number);
  const b = Array.from(right, (ch) => ch.codePointAt(0) as number);
  for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
    if (a[at] !== b[at]) return (a[at] as number) - (b[at] as number);
  }
  return a.length - b.length;
}

/** An eager parameter's callback ended the parse. */
class EagerExit {
  constructor(
    readonly role: 'help' | 'version',
    readonly command: CommandModel,
  ) {}
}

export type Verdict =
  /**
   * The argv is accepted; the command runs. `argv` is the same invocation as the command
   * path followed by the command's own tokens -- without a group-level `--`, which commander
   * would otherwise read as ending the command's options too.
   */
  | { readonly kind: 'run'; readonly argv: readonly string[] }
  /** Help on stdout, and this exit (2 for a group called with nothing, as `noArgsIsHelp`). */
  | { readonly kind: 'help'; readonly target: HelpTarget; readonly exit: 0 | 2 }
  | { readonly kind: 'version' }
  /** A usage error: these bytes on stderr, exit 2, nothing on stdout. */
  | { readonly kind: 'usage'; readonly stderr: string };

// --------------------------------------------------------------------------- parsing

interface ParsingState {
  rargs: string[];
  largs: string[];
  readonly opts: Map<string, unknown>;
  readonly order: Param[];
}

interface Parser {
  readonly long: ReadonlyMap<string, [Param, boolean]>;
  readonly short: ReadonlyMap<string, [Param, boolean]>;
  readonly interspersed: boolean;
  readonly command: CommandModel;
}

/** The prefix of an option-looking token (`--`, `-`, or none). */
function splitOpt(token: string): string {
  const chars = Array.from(token);
  const first = chars[0] ?? '';
  if (/^[\p{L}\p{N}]$/u.test(first)) return '';
  if ((chars[1] ?? '') === first) return chars.slice(0, 2).join('');
  return first;
}

function parserFor(command: CommandModel): Parser {
  const long = new Map<string, [Param, boolean]>();
  const short = new Map<string, [Param, boolean]>();
  for (const param of command.params) {
    if (param.kind !== 'option') continue;
    for (const [names, constant] of [
      [param.opts, true],
      [param.secondary, false],
    ] as const) {
      for (const name of names) {
        (splitOpt(name).length === 1 ? short : long).set(name, [param, constant]);
      }
    }
  }
  return { long, short, interspersed: command.group === null, command };
}

function takesValue(param: Param): boolean {
  return !param.flag;
}

function store(state: ParsingState, param: Param, value: unknown): void {
  if (param.multiple) {
    const previous = (state.opts.get(param.dest) as unknown[] | undefined) ?? [];
    state.opts.set(param.dest, [...previous, value]);
  } else {
    state.opts.set(param.dest, value);
  }
  state.order.push(param);
}

function valueFromState(name: string, state: ParsingState): string {
  if (state.rargs.length < 1) {
    throw new UsageProblem(`Option ${quotedText(name)} requires an argument.`, null);
  }
  return state.rargs.shift() as string;
}

function matchLong(parser: Parser, name: string, explicit: string | null, state: ParsingState) {
  const found = parser.long.get(name);
  if (found === undefined) {
    throw new NoSuchOption(name, parser.command, getCloseMatches(name, [...parser.long.keys()]));
  }
  const [param, constant] = found;
  if (takesValue(param)) {
    if (explicit !== null) state.rargs.unshift(explicit);
    store(state, param, valueFromState(name, state));
  } else if (explicit !== null) {
    throw new UsageProblem(`Option ${quotedText(name)} does not take a value.`, null);
  } else {
    store(state, param, constant);
  }
}

function matchShort(parser: Parser, token: string, state: ParsingState): void {
  const chars = Array.from(token);
  const prefix = chars[0] as string;
  for (let at = 1; at < chars.length; at += 1) {
    const name = `${prefix}${chars[at] as string}`;
    const found = parser.short.get(name);
    if (found === undefined) throw new NoSuchOption(name, parser.command);
    const [param, constant] = found;
    if (takesValue(param)) {
      if (at + 1 < chars.length) state.rargs.unshift(chars.slice(at + 1).join(''));
      store(state, param, valueFromState(name, state));
      return;
    }
    store(state, param, constant);
  }
}

function processOpts(parser: Parser, token: string, state: ParsingState): void {
  const equals = token.indexOf('=');
  const name = equals === -1 ? token : token.slice(0, equals);
  const explicit = equals === -1 ? null : token.slice(equals + 1);
  try {
    matchLong(parser, name, explicit, state);
  } catch (problem) {
    // "-foo" is tried as a long option first; failing that, as short options -- but a
    // two-character prefix ("--foo") never falls back to the short options.
    if (!(problem instanceof NoSuchOption)) throw problem;
    const two = Array.from(token).slice(0, 2).join('');
    if (two !== '-' && two !== '--') {
      matchShort(parser, token, state);
      return;
    }
    throw problem;
  }
}

/** The token walk: options first, then the positional arguments. */
function parseTokens(parser: Parser, args: readonly string[]): ParsingState {
  const state: ParsingState = { rargs: [...args], largs: [], opts: new Map(), order: [] };
  while (state.rargs.length > 0) {
    const token = state.rargs.shift() as string;
    if (token === '--') break;
    if (token.startsWith('-') && Array.from(token).length > 1) processOpts(parser, token, state);
    else if (parser.interspersed) state.largs.push(token);
    else {
      state.rargs.unshift(token);
      break;
    }
  }
  const positional = [...state.largs, ...state.rargs];
  for (const param of parser.command.params) {
    if (param.kind !== 'argument') continue;
    state.opts.set(param.dest, positional.length > 0 ? positional.shift() : null);
    state.order.push(param);
  }
  state.largs = positional;
  state.rargs = [];
  return state;
}

// ------------------------------------------------------------------------ processing

/** An `int` parameter's value; throws where the text is not an integer. */
export function intArgument(value: string): number {
  // `toInt` first reads any Unicode decimal digit as its ASCII value and strips surrounding
  // whitespace (`numberText`).
  return toInt(value);
}

/** A `float` parameter's value; throws where the text is not a number. */
export function floatArgument(value: string): number {
  return parseFloat_(value);
}

function convert(param: Param, value: string): void {
  try {
    if (param.type === 'integer') intArgument(value);
    else if (param.type === 'number') floatArgument(value);
  } catch {
    throw new UsageProblem(`${quotedText(value)} is not a valid ${param.type}.`, null);
  }
}

/** The parameter's names as an error quotes them: `'--name' / '-n'`. */
function hint(param: Param): string {
  return param.opts.map((name) => `'${name}'`).join(' / ');
}

/** One parameter's processing: convert, require, then the eager callbacks. */
function processParam(command: CommandModel, param: Param, state: ParsingState): void {
  const given = state.opts.get(param.dest);
  const values: readonly unknown[] =
    given === undefined || given === null ? [] : param.multiple ? (given as unknown[]) : [given];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    try {
      convert(param, value);
    } catch (problem) {
      if (!(problem instanceof UsageProblem)) throw problem;
      throw new UsageProblem(`Invalid value for ${hint(param)}: ${problem.message}`, command);
    }
  }
  if (param.required && values.length === 0) {
    const missing = param.kind === 'argument' ? 'Missing argument' : 'Missing option';
    throw new UsageProblem(`${missing} ${hint(param)}.`, command);
  }
  if (param.role !== undefined && given === true) throw new EagerExit(param.role, command);
}

/** The processing order: eager first, then as invoked, then as declared. */
function processingOrder(command: CommandModel, order: readonly Param[]): Param[] {
  const index = (param: Param) => {
    const at = order.indexOf(param);
    return at === -1 ? Number.POSITIVE_INFINITY : at;
  };
  return command.params
    .map((param, declared) => ({ param, declared }))
    .sort(
      (x, y) =>
        Number(!x.param.eager) - Number(!y.param.eager) ||
        index(x.param) - index(y.param) ||
        x.declared - y.declared,
    )
    .map(({ param }) => param);
}

/** The leftover tokens, once every parameter has been processed. */
function parseArgs(command: CommandModel, args: readonly string[]): string[] {
  const state = parseTokens(parserFor(command), args);
  for (const param of processingOrder(command, state.order)) processParam(command, param, state);
  return state.largs;
}

function judge(
  command: CommandModel,
  args: readonly string[],
  callback: () => void,
  path: readonly string[] = [],
): Verdict {
  if (command.group === null) {
    const extra = parseArgs(command, args);
    if (extra.length > 0) {
      throw new UsageProblem(`Got unexpected extra argument(s) (${extra.join(' ')})`, command);
    }
    return { kind: 'run', argv: [...path, ...args] };
  }
  const { commands, noArgsIsHelp } = command.group;
  if (args.length === 0 && noArgsIsHelp) return { kind: 'help', target: command.target, exit: 2 };
  const rest = parseArgs(command, args);
  if (rest.length === 0) throw new UsageProblem('Missing command.', command);
  const name = rest[0] as string;
  const found = commands.get(name);
  if (found !== undefined) {
    // The command resolves, then the group's callback runs, and only then is the command's
    // argv parsed. Whatever the command's tokens say, even `--help`, is not looked at until
    // the callback returns.
    if (command.group.callback) callback();
    return judge(found, rest.slice(1), callback, [...path, name]);
  }
  // ANY usage error raised while resolving the command name gets the close command names
  // added to its message -- the re-parse's too.
  try {
    // A name that looks like an option -- only after `--` -- is parsed as this group's own
    // options again, which is how `-- --help` prints the root help.
    if (splitOpt(name) !== '') parseArgs(command, rest);
    throw new UsageProblem(`No such command ${quotedText(name)}.`, command);
  } catch (problem) {
    if (problem instanceof UsageProblem) {
      const close = getCloseMatches(name, [...commands.keys()]);
      if (close.length > 0) {
        problem.message = `${problem.message.replace(/\.+$/u, '')}. Did you mean ${close.map(quotedText).join(', ')}?`;
      }
    }
    throw problem;
  }
}

// ------------------------------------------------------------------------- rendering

/** The Usage line, wrapped at the help width: the terminal's columns up to 80, less 2, >= 50. */
function usageText(command: CommandModel, host: ConsoleEnvironment): string {
  const width = Math.max(Math.min(formatterColumns(host), 80) - 2, 50);
  const prefix = `Usage: ${command.path} `;
  // Wrapped greedily over single spaces. The pieces are `[OPTIONS]`, metavars and
  // `COMMAND [ARGS]...`: no hyphen to break at, and none longer than the room beside the
  // longest prefix, so greedy word wrapping IS the established wrap's answer here.
  const lines: string[] = [];
  let line = prefix;
  let fresh = true;
  for (const word of command.usageArgs.split(' ')) {
    if (!fresh && line.length + 1 + word.length > width) {
      lines.push(line);
      line = ' '.repeat(prefix.length) + word;
    } else {
      line = fresh ? line + word : `${line} ${word}`;
    }
    fresh = false;
  }
  lines.push(line);
  return lines.join('\n');
}

function render(problem: UsageProblem, host: ConsoleEnvironment): string {
  const width = consoleWidth(host);
  let out = '';
  if (problem.context !== null) {
    out += printed(usageText(problem.context, host), width);
    out += printed(`Try '${problem.context.path} --help' for help.`, width);
  }
  return out + errorPanel(problem.formatted(), width);
}

/**
 * The frozen CLI's answer to `argv` before any command runs. `host` is the process's
 * terminal and environment, which decide how wide a usage error is drawn.
 *
 * `rootCallback` is the root's callback (`beforeAnyCommand`), called exactly where step 5
 * above calls it: after a command name resolves, before its argv is parsed, and never for an
 * argv the root answers itself. Anything it throws propagates out of here unchanged -- it is
 * not a verdict but the failure reported instead of one.
 */
export function judgeArgv(
  argv: readonly string[],
  host: ConsoleEnvironment = PROCESS_CONSOLE,
  rootCallback: () => void = () => undefined,
): Verdict {
  try {
    return judge(model(), argv, rootCallback);
  } catch (outcome) {
    if (outcome instanceof EagerExit) {
      return outcome.role === 'version'
        ? { kind: 'version' }
        : { kind: 'help', target: outcome.command.target, exit: 0 };
    }
    if (outcome instanceof UsageProblem) return { kind: 'usage', stderr: render(outcome, host) };
    throw outcome;
  }
}

/** A usage error found after the verdict, drawn the same way, in `command`'s context. */
export function renderUsage(
  message: string,
  target: HelpTarget,
  host: ConsoleEnvironment = PROCESS_CONSOLE,
): string {
  const root = model();
  let command: CommandModel = root;
  if (target === 'skill') command = root.group?.commands.get('skill') ?? root;
  else if (target !== 'root') {
    const [first, second] = target.path.split(' ') as [string, string | undefined];
    const top = root.group?.commands.get(first);
    command = (second === undefined ? top : top?.group?.commands.get(second)) ?? root;
  }
  return render(new UsageProblem(message, command), host);
}
