import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';

import { ReproError, ValidationError } from '../lib/errors';
import { quotedText } from '../lib/format';
import { setOnboardingVersion } from '../lib/onboarding';
import {
  activate,
  active,
  emit,
  errorEnvelope,
  EventWriter,
  jsonModeReset,
  reply,
  setHoustonVersion,
  envelopeWarnings,
  loggedFailure,
} from '../lib/jsonout';

import type * as EventlogNS from '../core/eventlog';
import type * as ExecNS from '../seams/exec';

import { floatArgument, intArgument, judgeArgv, renderUsage } from './usage-error';
import type { HelpTarget, Verdict } from './usage-error';
import type * as ActorNS from './handlers/actor';
import { HoustonHelp, renderCommandHelp, renderRootHelp, renderSkillHelp } from './help';
import type { ConsoleEnvironment } from './error-panel';
import { COMMAND_SPECS } from './spec-data';
import type { CommandSpec, OptionSpec } from './spec-types';
import { preserveFloatFields } from './wire';

const PACKAGE_VERSION = (require('../../package.json') as { version: string }).version;
const exitCodes = new WeakMap<Command, number>();

export interface Invocation {
  readonly spec: CommandSpec;
  readonly arguments: Readonly<Record<string, string | number | null>>;
  readonly options: Readonly<Record<string, string | number | boolean | string[] | null>>;
  /** Present only for a JSON-active command whose declaration says it streams. */
  readonly events: EventWriter | null;
}

/**
 * A command may intentionally return nonzero after its envelope. With `failure`, that
 * envelope is the error one, carrying `data`: a loadtest that missed its SLO exited 1 under
 * `ok: true, error: null`, so a script branching on `ok` and one branching on the exit code
 * read two different answers.
 */
export interface CommandOutcome {
  readonly data: unknown;
  readonly exitCode: number;
  readonly commandOutcome: true;
  readonly failure?: ReproError;
}

/**
 * `exitCode` from -255 to 255. A NEGATIVE one is a child's death by a signal handed on as
 * the child's return code: the `end` record says -15 and the process exits 241, which is
 * what Node's `process.exitCode = -15` does and what earlier releases exit with too
 * (Kubernetes `logs`).
 */
export function commandOutcome(
  data: unknown,
  exitCode: number,
  failure?: ReproError,
): CommandOutcome {
  if (!Number.isInteger(exitCode) || exitCode < -255 || exitCode > 255) {
    throw new Error(`invalid process exit code: ${String(exitCode)}`);
  }
  return failure === undefined
    ? { data, exitCode, commandOutcome: true }
    : { data, exitCode, commandOutcome: true, failure };
}

function isCommandOutcome(value: unknown): value is CommandOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<CommandOutcome>).commandOutcome === true
  );
}

/**
 * The operator answered "no" to a destructive prompt.
 *
 * NOT A `ReproError`. A declined confirmation prints `Aborted.` on stderr and exits 1 -- no
 * `error:` prefix, because nothing went wrong.
 * An earlier version raised `ValidationError('cancelled')`, so every declined prompt exited 2
 * with `error: cancelled`, and a script told "invalid input" about a question it declined.
 * It is never reached in JSON mode: there is nobody to prompt, and the refusal to proceed
 * without `--yes` comes first.
 */
export class Aborted extends Error {
  constructor() {
    super('Aborted.');
    this.name = 'Aborted';
  }
}

export type CommandExecutor = (invocation: Invocation) => Promise<unknown>;

export interface CliIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface BuildCliOptions {
  readonly execute: CommandExecutor;
  readonly io?: CliIo;
  /** The terminal a usage error is sized for; the process's own when absent. */
  readonly console?: ConsoleEnvironment;
}

const processIo: CliIo = {
  writeOut: (text) => process.stdout.write(text),
  writeErr: (text) => process.stderr.write(text),
};

/**
 * An integer option's value: whitespace, a sign, underscores between digits and any decimal
 * digit of Unicode 15.0 are all accepted, and `0x10` and `1e3` are not (`intArgument` in
 * `./usage-error` says how). An earlier version took `/^-?\\d+$/`, so `--tail 1_0` and
 * `--port ' 80'` were usage errors here, where earlier releases ran them.
 *
 * AN INTEGER JAVASCRIPT CANNOT HOLD EXACTLY IS STILL REFUSED, and that is a known
 * deviation: `--tail 9007199254740993` runs in the previous implementation. It is kept
 * because no numeric option means anything at that size -- a port, a replica count,
 * seconds, lines -- and rounding the value to the nearest double would hand the command a
 * number nobody typed. Only the value the command is given is refused (`keptNumber`):
 * `--tail 9007199254740993 --tail 5` runs, as it always has.
 */
function parseInteger(raw: string): number {
  let value: number;
  try {
    value = intArgument(raw);
  } catch {
    throw new InvalidArgumentError(`not a valid integer: ${raw}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new InvalidArgumentError(`integer is out of range: ${raw}`);
  }
  return value;
}

/**
 * A float option's value, as `floatArgument` reads it -- where `Number()` also accepts
 * `0x10` and `''` and turns `1_0` into NaN. Infinity and NaN parse, as they always have; the
 * command's own validation decides what to do with them.
 */
function parseFloatValue(raw: string): number {
  try {
    return floatArgument(raw);
  } catch {
    throw new InvalidArgumentError(`not a valid number: ${raw}`);
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function commanderName(long: string): string {
  const positive = long.includes('/--no-') ? (long.split('/')[0] as string) : long;
  return positive
    .slice(2)
    .replace(/-([a-z0-9])/gu, (_match, letter: string) => letter.toUpperCase());
}

function optionFlags(option: OptionSpec, long = option.long): string {
  const value =
    option.value === 'boolean'
      ? ''
      : ` <${option.value === 'integer' ? 'integer' : option.value === 'float' ? 'number' : 'string'}>`;
  return `${option.short === undefined ? '' : `${option.short}, `}${long}${value}`;
}

/**
 * The number an int or float option was given, converted ONCE, from the occurrence that is
 * kept. Each occurrence is STORED over the one before and only what is left is type-cast,
 * so an occurrence a later one overrides is never read as a number at all.
 *
 * Commander calls an `argParser` on EVERY occurrence, and while `parseInteger` and
 * `parseFloatValue` were one, an occurrence that is thrown away still refused the whole
 * argv here, in commander's words. Measured against the previous implementation (fresh
 * HOUSTON_HOME, no network): `audit -n 𑛐 --lines 2` and `audit -n abc --lines 2` run there,
 * exit 0, and were exit 2 here; `logs --name nope --tail abc --tail 5`, the same with 4301
 * zeros or 9007199254740993 first, and `stats --name nope --for abc --for 1` are `no repro
 * named 'nope'`, exit 4, there and were exit 2 here. So numeric options have no
 * `argParser`, commander keeps the last text as it keeps any option's, and this converts
 * that.
 *
 * `judgeArgv` has already put the kept text through the same conversion, so the one
 * refusal left is `parseInteger`'s beyond 2**53, the known deviation -- reported as
 * commander reported it from an `argParser`, and so, as before, as a usage error by `runCli`.
 */
function keptNumber(command: Command, option: OptionSpec, raw: string): number {
  try {
    return option.value === 'integer' ? parseInteger(raw) : parseFloatValue(raw);
  } catch (error) {
    if (!(error instanceof InvalidArgumentError)) throw error;
    return command.error(
      `error: option '${optionFlags(option)}' argument '${raw}' is invalid. ${error.message}`,
      { exitCode: error.exitCode, code: error.code },
    );
  }
}

/**
 * An ordinary `--no-X` is a flag of its own: `--no-domain` and `--domain` are two
 * parameters of `serve`, `--no-rollback` and `--rollback` two of `upgrade`, and neither
 * clears the other whatever the order.
 *
 * Commander reads any `--no-` spelling as the NEGATION of `--X` and stores it on X's
 * attribute, as false. So `serve --no-domain` served, and rewrote the edge for, the name
 * 'false'; `serve --domain ''` was read as --no-domain, because the flag was taken from X's
 * value source; and `upgrade --rollback --no-rollback` ran the upgrade where it should roll
 * back, because the last one won. Only a `negatablePair` (`--diag/--no-diag`) is one
 * parameter with two spellings, and keeps commander's negation, last one winning. Every
 * other `--no-X` is registered as a plain boolean under its own
 * attribute (`noDomain`), and read from there.
 */
function makeOption(spec: OptionSpec, long = spec.long): Option {
  const option = new Option(optionFlags(spec, long), spec.description);
  if (!spec.negatablePair) option.negate = false;
  if (spec.hidden) option.hideHelp();
  if (spec.required) option.makeOptionMandatory();
  // No `argParser` for an int or float: commander would call it on every occurrence, and
  // only the one kept is converted (`keptNumber`).
  if (spec.repeatable) option.argParser(collect).default([]);
  if (!spec.repeatable && spec.defaultValue !== null && spec.defaultValue !== undefined) {
    option.default(spec.defaultValue);
  }
  return option;
}

function addOptions(command: Command, spec: CommandSpec): void {
  const merged: ({ kind: 'option'; value: OptionSpec } | { kind: 'json' })[] = spec.options.map(
    (value) => ({ kind: 'option', value }),
  );
  if (spec.json.mode === 'flag') {
    merged.splice(spec.json.option?.index ?? merged.length, 0, { kind: 'json' });
  }
  for (const entry of merged) {
    if (entry.kind === 'json') {
      command.addOption(
        new Option('--json', spec.json.option?.description ?? 'machine-readable JSON'),
      );
      continue;
    }
    if (entry.value.negatablePair) {
      const [positive, negative] = entry.value.long.split('/');
      command.addOption(makeOption(entry.value, positive));
      const { short: _short, ...withoutShort } = entry.value;
      command.addOption(makeOption(withoutShort, negative));
    } else {
      command.addOption(makeOption(entry.value));
    }
  }
}

function normalizeOptions(
  command: Command,
  spec: CommandSpec,
): Record<string, string | number | boolean | string[] | null> {
  const raw = command.opts<Record<string, unknown>>();
  const out: Record<string, string | number | boolean | string[] | null> = {};
  for (const option of spec.options) {
    const name = commanderName(option.long);
    let value = raw[name];
    if (
      (option.value === 'integer' || option.value === 'float') &&
      typeof value === 'string' &&
      command.getOptionValueSource(name) === 'cli'
    ) {
      value = keptNumber(command, option, value);
    }
    if (option.repeatable && value === undefined) value = [];
    if (value === undefined) value = option.defaultValue ?? null;
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean' &&
      value !== null &&
      !(Array.isArray(value) && value.every((item) => typeof item === 'string'))
    ) {
      throw new ValidationError(`invalid value for ${option.long}`);
    }
    out[option.key] = value;
  }
  if (spec.json.mode === 'flag') out.json_out = raw.json === true;
  return out;
}

function normalizeArguments(
  spec: CommandSpec,
  values: readonly unknown[],
): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (let index = 0; index < spec.arguments.length; index += 1) {
    const argument = spec.arguments[index] as (typeof spec.arguments)[number];
    const value = values[index] ?? argument.defaultValue ?? null;
    if (typeof value !== 'string' && typeof value !== 'number' && value !== null) {
      throw new ValidationError(`invalid value for ${argument.name}`);
    }
    out[argument.name] = value;
  }
  // Validate before dispatch, before any onboarding or setup writer runs.
  if (
    spec.path === 'onboard' &&
    (out.action === 'status' || out.action === 'complete' || out.action === 'setup') &&
    typeof out.id === 'string' &&
    out.id !== ''
  ) {
    throw new ValidationError(`\`onboard ${out.action}\` does not take a grant ID`);
  }
  return out;
}

/**
 * Refuse an action the command does not have, in the established wording, as a usage error.
 *
 * One place for the positional-action commands that refuse an unknown action FIRST, so it
 * has to say what each of those commands has always said: `edge` lists `delete <host>` rather
 * than a bare `delete`, and `cluster` has a sentence of its own. Every one is a
 * `ValidationError` (exit 2, VALIDATION_FAILED): `edge frob` exited 1 where `cluster frob`
 * exited 2, one mistake with two codes.
 *
 * Not `users`: its handler refuses an unknown action itself, before it asks for the name, in
 * the same words.
 */
function validateAction(value: unknown, path: string, choices: readonly string[]): void {
  if (typeof value === 'string' && choices.includes(value)) return;
  const shown = quotedText(String(value));
  if (path === 'cluster') {
    throw new ValidationError(`unknown action ${shown}. Want: ${choices.join(' | ')}.`);
  }
  const want =
    path === 'edge'
      ? 'status | start | stop | restart | logs | delete <host>'
      : choices.join(' | ');
  throw new ValidationError(`unknown action ${shown} (want: ${want})`);
}

/**
 * Commander results are an untrusted boundary; validate cross-field meaning here.
 *
 * NOTHING ABOUT `api` IS CHECKED HERE, and that is the established order rather than an
 * omission. This used to refuse any method outside GET/POST/PUT/DELETE/PATCH and
 * `JSON.parse` the `--data`, both before the handler ran -- so an unknown workspace exited 1
 * (or 2) where `api` has always exited 4, a stopped engine 1 where it exits 3, a workspace
 * still booting 1 where it exits 5; `--pat` with a bad body minted no token where `api`
 * mints one (and audits it) before it ever reads the body; the refusal quoted V8's words
 * rather than the established ones; and HEAD and OPTIONS, which `api` sends, were refused
 * outright. `api` has NO method allowlist -- any method is sent upper-cased -- and it parses
 * `--data` only after the name, the engine and the login. The handler already does both in
 * that order.
 *
 * NOR ARE NUMBERS BOUNDED HERE. This refused a negative `--port`, `--replicas`, `--tail`,
 * `--vus`, `--users`, `--slowms`, `--start`, `--max` or `--nodes`, and a `--port` over
 * 65535, on every command before its handler ran. None of them has a declared min or max,
 * so each command answers for itself, after its name resolution and its engine preflight:
 * `up --port 70000` with Docker stopped is "Docker isn't running",
 * exit 3, where this said "port must be between 0 and 65535", exit 2; with Docker running
 * it is the create's own "--port 70000 is out of range (want 1024-65535)"; `up --replicas
 * -1` is the topology's "--replicas must be at least 1."; and `logs --tail -3` runs
 * `docker compose logs --tail -3`, exit 0.
 */
function validateInvocation(invocation: Invocation): void {
  const a = invocation.arguments;
  // Not `config`: `config` checks the KEY before the action, so `config frob` has always
  // been `unknown key ''` and was `unknown action 'frob'` here. Its handler refuses an
  // unknown action itself, in the established order.
  const actions: Readonly<Record<string, readonly string[]>> = {
    edge: ['status', 'start', 'stop', 'restart', 'logs', 'delete'],
  };
  const variants = invocation.spec.json.variants;
  const choices =
    variants?.argument === 'action' ? Object.keys(variants.byValue) : actions[invocation.spec.path];
  if (choices !== undefined) validateAction(a.action, invocation.spec.path, choices);
}

function commandName(spec: CommandSpec): string {
  return spec.path.split(' ').at(-1) as string;
}

function replyKind(invocation: Invocation): string {
  const advertised = invocation.spec.json.schema;
  if (advertised === undefined) throw new Error(`${invocation.spec.path} has no JSON schema`);
  const variants = invocation.spec.json.variants;
  if (variants === undefined) return schemaKind(advertised);
  const value = String(invocation.arguments[variants.argument]);
  const schema = variants.byValue[value];
  if (schema === undefined) {
    throw new Error(`${invocation.spec.path} has no schema for ${variants.argument}=${value}`);
  }
  return schemaKind(schema);
}

function schemaKind(schema: string): string {
  const match = /^houston\.(.+)\.v1$/u.exec(schema);
  if (match?.[1] === undefined) throw new Error(`unsupported CLI schema ${schema}`);
  return match[1];
}

export function buildCli(options: BuildCliOptions): Command {
  const io = options.io ?? processIo;
  const commandSpecs = new WeakMap<Command, CommandSpec | 'root' | 'skill'>();
  const root = new Command('houston');
  commandSpecs.set(root, 'root');
  root
    .description('Launch version-matched Rocket.Chat reproduction environments.')
    .helpOption('--help', 'Show this message and exit.')
    .enablePositionalOptions()
    .version(
      `houston ${PACKAGE_VERSION}`,
      '--version, -V',
      'print the installed houston version and exit',
    )
    .allowExcessArguments(false)
    // There is no `help` command: `houston help up` is "No such command 'help'."
    .helpCommand(false)
    .exitOverride()
    // Commander reports a parse error itself AND throws it, which printed every usage error
    // twice ('error: X', then 'error: error: X'). Errors are `./usage-error`'s to report, so
    // commander's own reporting is switched off and only the throw is used.
    .configureOutput({ writeOut: io.writeOut, writeErr: io.writeErr, outputError: () => {} });
  root.createHelp = () => new HoustonHelp(commandSpecs);

  let skill: Command | null = null;
  for (const spec of COMMAND_SPECS) {
    let parent = root;
    if (spec.path.startsWith('skill ')) {
      if (skill === null) {
        skill = root
          .command('skill')
          .description('Install the agent skill that teaches a caller to drive houston.');
        skill.helpOption('--help', 'Show this message and exit.').allowExcessArguments(false);
        commandSpecs.set(skill, 'skill');
        skill.createHelp = () => new HoustonHelp(commandSpecs);
      }
      parent = skill;
    }
    const command = parent
      .command(commandName(spec))
      .description(spec.description.split('\n')[0] as string);
    command.helpOption('--help', 'Show this message and exit.').allowExcessArguments(false);
    commandSpecs.set(command, spec);
    command.createHelp = () => new HoustonHelp(commandSpecs);
    for (const argument of spec.arguments) {
      const syntax = argument.required ? `<${argument.name}>` : `[${argument.name}]`;
      if (argument.required) command.argument(syntax, argument.description);
      else command.argument(syntax, argument.description, argument.defaultValue);
    }
    addOptions(command, spec);
    command.action(async (...received: unknown[]) => {
      const commander = received.at(-1);
      if (!(commander instanceof Command)) throw new Error('Commander did not supply its command');
      const positional = received.slice(0, spec.arguments.length);
      const normalizedOptions = normalizeOptions(commander, spec);
      if (spec.json.mode === 'always' || normalizedOptions.json_out === true) activate();
      const invocation: Invocation = {
        spec,
        arguments: normalizeArguments(spec, positional),
        options: normalizedOptions,
        events: spec.json.streams && active() ? new EventWriter() : null,
      };
      validateInvocation(invocation);
      const result = await options.execute(invocation);
      const data = isCommandOutcome(result) ? result.data : result;
      const failure = isCommandOutcome(result) ? result.failure : undefined;
      if (active() && failure !== undefined) {
        emit(errorEnvelope(failure, { data: preserveFloatFields(data) }));
      } else if (active()) {
        reply(replyKind(invocation), preserveFloatFields(data));
      }
      if (isCommandOutcome(result)) exitCodes.set(root, result.exitCode);
    });
  }
  return root;
}

function helpText(target: HelpTarget): string {
  if (target === 'root') return renderRootHelp();
  if (target === 'skill') return renderSkillHelp();
  return renderCommandHelp(target);
}

/**
 * The root callback: who is running this, from the accounts file.
 *
 * `./usage-error` calls it once a command name resolves, before that command's argv is parsed --
 * so a `users` that cannot be read is the answer to `up --bogus` and `up --help`, as it has
 * always been. It used to run only inside the executor, after commander had parsed and
 * `validateInvocation` had checked the argv: measured with `users` a directory, earlier
 * releases answered `up --bogus`, `up --help`, `skill install --help` and `users bogus` with
 * `error: cannot read .../users: Is a directory` and exit 2, and this build
 * with the usage panel, the help, the help, and `unknown action` exit 1.
 *
 * Only the READ is here. The executor publishes the answer around the command
 * (`runWithContext`, which cannot outlive the call that opens it), reading it again, as
 * every command reads the actor again.
 */
function beforeAnyCommand(): void {
  (require('./handlers/actor') as typeof ActorNS).cliActorAndOrigin();
}

/** The spec commander was running when it threw, for the context of its usage error. */
function commanderTarget(argv: readonly string[]): HelpTarget {
  const words = argv.filter((arg) => !arg.startsWith('-'));
  const [first, second] = words;
  const found = COMMAND_SPECS.find(
    (spec) => spec.path === first || spec.path === `${first ?? ''} ${second ?? ''}`,
  );
  return found ?? 'root';
}

/**
 * Whether this run wrote a usage panel. A broken pipe under the panel is answered with exit
 * 1 and the stream is not pacified, so stderr still fails to flush at shutdown: exit 120,
 * where a broken pipe anywhere else gives 1.
 */
let panelUsage = false;
export function usagePanelWritten(): boolean {
  return panelUsage;
}

export async function runCli(argv: readonly string[], options: BuildCliOptions): Promise<number> {
  jsonModeReset();
  panelUsage = false;
  setHoustonVersion(PACKAGE_VERSION);
  setOnboardingVersion(PACKAGE_VERSION);
  const io = options.io ?? processIo;
  // THE FROZEN VERDICT FIRST. Help, the version and every usage error are decided as the
  // frozen CLI decides them, in its order (`./usage-error`), before commander sees argv. A usage
  // error is the boxed usage-error panel on stderr and exit 2 -- and, under --json, ONE
  // error envelope on stdout. There was none ("the argv fails before any command runs"),
  // so a script parsing the last line of `up --json` with a mistyped `--port` read nothing,
  // where automation.md promises every reply is an envelope.
  try {
    // Inside the try, so a defect in the verdict itself is still reported through the
    // contract -- an envelope under --json, the stack trace on stderr, exit 1.
    let verdict: Verdict;
    try {
      verdict = judgeArgv(argv, options.console, beforeAnyCommand);
    } catch (error) {
      // The root callback refused, which is reported through `reportBeforeCommand`: JSON
      // mode from argv, since no command has parsed `--json` yet, and LOGGED, since this
      // home is not being refused -- its accounts file is.
      if (error instanceof ReproError) return reportBeforeCommand(error, argv, io, { log: true });
      // Anything else is unhandled, and the catch below reports it -- after JSON mode is
      // taken from argv here, for the same reason: an unhandled failure at this point has
      // always been reported through the same contract, so a `users` that is not UTF-8
      // answers `list --json` with a REPRO_ERROR envelope, where this build, with no command
      // yet to parse `--json`, wrote only the stack trace and the error line.
      if (argv.includes('--json')) activate();
      throw error;
    }
    if (verdict.kind === 'usage') {
      panelUsage = true;
      if (argv.includes('--json')) {
        activate();
        const failure = new ValidationError(verdict.message);
        emit(errorEnvelope(failure, { warnings: envelopeWarnings(failure) }));
      }
      io.writeErr(verdict.stderr);
      return 2;
    }
    if (verdict.kind === 'version') {
      io.writeOut(`houston ${PACKAGE_VERSION}\n`);
      return 0;
    }
    if (verdict.kind === 'help') {
      io.writeOut(helpText(verdict.target));
      return verdict.exit;
    }
    const cli = buildCli(options);
    await cli.parseAsync([...verdict.argv], { from: 'user' });
    return exitCodes.get(cli) ?? 0;
  } catch (error) {
    // An interrupt: exit 130, and nothing more -- no `error:` line, no envelope under
    // --json, no `error` record. Also for whatever a `catch` the interrupt passed through
    // turned it into on its way here: a handler for errors never claims an interrupt.
    const exec = require('../seams/exec') as typeof ExecNS;
    if (error instanceof exec.Interrupted || exec.interruptRaised()) return 130;
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    if (error instanceof CommanderError) {
      // `judgeArgv` accepted this argv and commander did not: the two parsers disagree,
      // which is a defect. It is still reported as a usage error, in the command's context,
      // rather than in commander's words -- and recorded, so the event log shows the defect.
      const message = error.message.replace(/^error: /u, '');
      try {
        const eventlog = require('../core/eventlog') as typeof EventlogNS;
        eventlog.failed(
          ValidationError.code,
          `commander refused an argv the verdict accepts: ${message}`,
        );
      } catch {
        /* never let logging change the exit */
      }
      panelUsage = true;
      io.writeErr(renderUsage(message, commanderTarget(argv), options.console));
      return 2;
    }
    if (error instanceof Aborted) {
      (options.io ?? processIo).writeErr('Aborted.\n');
      return 1;
    }
    // THE CONTRACT'S LAST LINE: anything that is neither a domain error nor a parse error is
    // unhandled, so its stack trace goes to stderr and it is still ONE envelope on stdout --
    // worded to say where to look, since the usual cause is a damaged file under HOUSTON_HOME.
    let failure: unknown = error;
    // Whether a stack trace went to stderr: the log's `trace`, which marks a defect.
    let traced = false;
    if (!(error instanceof ReproError)) {
      const text = (error as { message?: unknown }).message;
      const stack = (error as { stack?: unknown }).stack;
      if (typeof stack === 'string') {
        (options.io ?? processIo).writeErr(`${stack}\n`);
        traced = true;
      }
      failure = new ReproError(
        `${typeof text === 'string' ? text : String(error)} ` +
          '- this is unhandled, and the stack trace is on stderr. If it names a file under ' +
          'HOUSTON_HOME, that file is the problem.',
      );
    }
    if (active()) emit(errorEnvelope(failure, { warnings: envelopeWarnings(failure) }));
    const message = failure instanceof Error ? failure.message : String(failure);
    // The durable record carries the stable code beside the prose.
    // Best-effort and silent -- the failure being reported matters more than logging it.
    // Not for a failure the command reported directly (`doctor`): see `failDirectly`.
    try {
      const eventlog = require('../core/eventlog') as typeof EventlogNS;
      if (loggedFailure(failure)) {
        eventlog.failed(failure instanceof ReproError ? failure.code : ReproError.code, message, {
          stackTraceOnStderr: traced,
        });
      }
    } catch {
      /* never let logging change the exit */
    }
    (options.io ?? processIo).writeErr(`error: ${message}\n`);
    return failure instanceof ReproError ? failure.exitCode : 1;
  }
}

/**
 * A failure from OUTSIDE any command, through the same contract.
 *
 * The startup refusal happens before a command has parsed `--json`, so JSON mode comes from
 * argv here -- a caller that asked for JSON still gets exactly one envelope, the class's
 * own exit code, and no stack trace.
 *
 * NOT LOGGED BY DEFAULT -- a startup refusal is reported, never recorded, because the event
 * log is the first write under HOUSTON_HOME, and that refusal is the refusal to write there,
 * so nothing is appended to `logs/houston.log` in the home just refused, as an earlier
 * version did. The root callback's failure is logged, as it always has been, and passes
 * `{ log: true }`: it is recorded with its code before it is reported.
 */
export function reportBeforeCommand(
  failure: ReproError,
  argv: readonly string[],
  io: CliIo = processIo,
  { log = false }: { readonly log?: boolean } = {},
): number {
  jsonModeReset();
  setHoustonVersion(PACKAGE_VERSION);
  if (log) {
    // Best-effort and silent, as every other record of a failure is.
    try {
      (require('../core/eventlog') as typeof EventlogNS).failed(failure.code, failure.message);
    } catch {
      /* never let logging change the exit */
    }
  }
  if (argv.includes('--json')) activate();
  if (active()) emit(errorEnvelope(failure, { warnings: envelopeWarnings(failure) }));
  // An envelope that could not be written ends the report before its error line; the
  // failed write is not thrown on.
  if (process.stdout.errored !== null) return failure.exitCode;
  io.writeErr(`error: ${failure.message}\n`);
  return failure.exitCode;
}
