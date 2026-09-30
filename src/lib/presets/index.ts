/**
 * Load reproduction presets.
 *
 * A preset bundles Rocket.Chat env vars and backing services into a named scenario. Built-ins
 * are shipped in `data/presets`; a file of the same name in `~/.houston/presets` overrides
 * the built-in so users can tweak or add their own.
 *
 * THE SEVEN BUILDER IMPORTS BELOW ARE LOAD-BEARING. The owners could register themselves on
 * first use, with the registry importing each of them; here the import moves DOWNWARD into
 * the loader instead: a rank-3 registry reaching up to a rank-6 builder is the edge the
 * layer gate exists to forbid, and a dynamic `require()` would evade the gate rather than
 * satisfy it. The check that all seven arrived stays in `registry.builders()`, which is the
 * half with teeth.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../config';
import { joinPath } from '../home';
import {
  compareCodePoints,
  decodeUtf8Strict,
  toInt,
  fileErrorText,
  quotedText,
  toTextAny,
  isTruthy,
  valueKind,
  expectedText,
} from '../format';

import { safeLoad, safeLoadOrdered } from './common';
import * as registry from './registry';
import type { Scenario } from './scenario';
import { emptyPreset, type Preset } from './types';

import './email';
import './ldap';
import './livechat';
import './multi-instance';
import './oidc';
import './s3-minio';
import './saml';

/**
 * `core/topology.ts`'s `DOCKER`. Spelled out rather than imported because presets is the
 * lower layer and must not depend on core; the two must stay equal, which is the guarantee
 * an import would have given.
 */
const RUNTIME_DEFAULT = 'docker';

type Raw = Record<string, unknown>;

/**
 * The items of `value`, over what a YAML read gives back: a list's items, a string's
 * characters, a mapping's keys. Anything else is a TypeError, which the listing does not
 * catch -- `notes: 5` ends `houston presets`, where a silent `[]` printed the catalogue --
 * and `notes: abc` is three notes, not none.
 */
function iterate(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return Array.from(value);
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.keys(value);
  }
  throw new TypeError(expectedText('a list', value));
}

/** `value`, or `fallback` for a falsy one -- null, false, '', 0, `[]`, `{}`. */
function or_<T>(value: unknown, fallback: T): unknown {
  if (value === null || value === undefined || value === false) return fallback;
  if (value === '' || value === 0) return fallback;
  if (Array.isArray(value) && value.length === 0) return fallback;
  if (typeof value === 'object' && Object.keys(value).length === 0) return fallback;
  return value;
}

/**
 * The order a preset file wrote its `params_help` keys in, for every `params_help` object
 * `parse` built from one.
 *
 * `houston presets` prints one `--set` line per key, in the order the file wrote them. A
 * JavaScript object lists every integer-like key first whatever order it was written in,
 * so a user file with `users`, `"10"`, `alpha` printed `--set 10` above `--set users`,
 * where it belongs below it (t1-presets verifier, measured). The `Preset` shape stays the
 * established one, field for field, so the order travels beside it rather than in it;
 * `paramsHelpItems` is the one reader.
 */
const PARAMS_HELP_ORDER = new WeakMap<object, readonly string[]>();

/**
 * The `params_help` entries: in the order the file wrote the keys where `parse` read them from
 * one, else in the object's own order -- the builders' literals, whose keys are all words.
 */
export function paramsHelpItems(help: Record<string, unknown>): [string, unknown][] {
  const order = PARAMS_HELP_ORDER.get(help);
  if (order === undefined) return Object.entries(help);
  return order.map((key) => [key, help[key]]);
}

/**
 * Record `help`'s key order from the file's own mapping. Kept only when the ordered read
 * names exactly the keys the plain one did: a key that is not a string (`? [a, b]`, or a
 * `10` beside a `"10"`) stringifies differently in the two, and the object's own order is
 * then the one left.
 */
function rememberParamsHelpOrder(text: string, help: Record<string, unknown>): void {
  const own = Object.keys(help);
  if (own.length === 0) return;
  const doc = safeLoadOrdered(text);
  const rows = doc instanceof Map ? (doc.get('params_help') as unknown) : undefined;
  if (!(rows instanceof Map)) return;
  const keys = [...(rows as Map<unknown, unknown>).keys()].map(String);
  const same =
    keys.length === own.length &&
    new Set(keys).size === keys.length &&
    keys.every((key) => Object.hasOwn(help, key));
  if (same) PARAMS_HELP_ORDER.set(help, keys);
}

/**
 * The preset's `env`, each value as the YAML read typed it -- the int past 2**53 exact,
 * `1.0` a float, a mapping with its keys as typed -- for `compose.ts`, which writes
 * each as its `str` (`toTextYaml`). The plain read turned each into what JavaScript holds,
 * and the `str` of that is another value: `12345678901234567890` rounded, `1.0` spelled
 * `1`, `{1: a}` as `{'1': 'a'}`. A key the plain read had to stringify keeps its plain
 * value.
 */
function typedEnv(text: string, plain: unknown): Record<string, string> {
  const env = or_(plain, {}) as Record<string, string>;
  const doc = config.safeLoadConstructed(text);
  const held = doc instanceof Map ? (doc.get('env') as unknown) : undefined;
  if (!(held instanceof Map) || typeof env !== 'object' || Array.isArray(env)) return env;
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    // A defined property, as the reader made each: `__proto__` is a key here, not a setter.
    Object.defineProperty(out, key, {
      value: held.has(key) ? held.get(key) : env[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function parse(text: string, source: string): Preset {
  const raw = or_(safeLoad(text), {}) as unknown;
  // A LIST OR A SCALAR IS NOT A PRESET. Reading a field of either is a TypeError, which
  // is not a ReproError -- so one malformed file in the presets directory took out
  // `houston presets`, `/api/presets` and the create dialog, and made `capabilities`
  // report ZERO presets (it guards its own call with a catch-all, so the failure became
  // silence).
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `preset ${source} is ${valueKind(raw)}, not a mapping ` +
        "(a preset file is a YAML mapping with a 'name' key)",
    );
  }
  const doc = raw as Raw;
  if (or_(doc.name, '') === '') throw new Error(`preset ${source} is missing a 'name' field`);
  const paramsHelp = or_(doc.params_help, {}) as Record<string, string>;
  rememberParamsHelpOrder(text, paramsHelp);
  return {
    ...emptyPreset(String(doc.name)),
    description: doc.description === undefined ? '' : String(doc.description),
    env: typedEnv(text, doc.env),
    services: or_(doc.services, {}) as Record<string, Record<string, unknown>>,
    rocketchat: or_(doc.rocketchat, {}) as Raw,
    dependsOn: or_(doc.depends_on, []) as string[],
    // The established truth of `requires_license`, which is TRUE for a NaN -- `.nan`
    // printed `[needs license]` there and nothing here until isTruthy called a NaN truthy too.
    requiresLicense: isTruthy(doc.requires_license),
    source,
    notes: iterate(or_(doc.notes, [])).map(toTextAny),
    paramsHelp,
    instances: Math.trunc(Number(or_(doc.instances ?? 1, 1))),
    entryService: String(or_(doc.entry_service ?? '', '')),
    extra: or_(doc.extra, {}) as Raw,
    volumes: or_(doc.volumes, {}) as Raw,
    // The integer grammar (`toInt`): `ports: [abc]` is a refusal, which lists the file as
    // UNREADABLE, where `Number` made it a NaN port and printed the preset.
    ports: iterate(or_(doc.ports, [])).map((p) => toInt(p)),
    topology: String(or_(doc.topology ?? '', '')),
  };
}

/** Load builders so each can register itself with the leaf registry. */
function dynamicBuilders(): Record<string, registry.Builder> {
  return registry.builders();
}

/** The built-in scenario names, derived from the shipped catalogue. */
export function scenarioNames(): string[] {
  const dynamic = Object.keys(dynamicBuilders()).filter((name) => name !== 'multi-instance');
  // No DEPLOYMENT_PRESETS exclusion: deployments are not presets here. PR #3 modelled
  // "microservices" as a preset that implies Kubernetes; this branch models it as a
  // DEPLOYMENT under an explicit runtime, so there is nothing in the preset catalogue to
  // filter out.
  const static_ = builtinStems();
  return [...new Set([...dynamic, ...static_])].sort();
}

/** Built-in scenario registry; intentionally not a public plugin registry. */
function scenarioDefinitions(): Record<string, Scenario> {
  return registry.scenarios() as Record<string, Scenario>;
}

/**
 * A preset name, and nothing that can be read as a path.
 *
 * Joining `<name>.yaml` onto the presets directory looks like it confines the lookup to
 * that directory and does not: a component-by-component join DISCARDS the left operand
 * when the right is absolute, so `--preset /tmp/x` resolved to `/tmp/x.yaml` and the
 * presets directory was never consulted. No `..` and no existing presets dir required.
 *
 * That mattered because a preset is a container spec. Its `services:` is deep-merged into
 * the compose document, so any readable YAML on the box became an arbitrary image with
 * arbitrary bind mounts, running as whoever runs houston -- reproduced with
 * `volumes: ["/:/host:ro"]`. And `preset` is not in `PRIVILEGED_CREATE_FIELDS`, so
 * `POST /api/repros` is member+: on the shared server this file's own README warns about,
 * any member could hand the serve process a container spec. Two lesser consequences
 * travelled with it: naming another workspace's `docker-compose.yml` (valid YAML with
 * `name:` and `services:`) pulled that workspace's Keycloak/MinIO/LDAP and their
 * credentials into one of yours, and the three distinguishable errors made the create
 * dialog a filesystem oracle.
 *
 * The README already says "treat preset files as code -- they can run arbitrary containers
 * and mount files". That is only safe because of the sentence before it, "drop a YAML file
 * in ~/.houston/presets/<name>.yaml", and that sentence was not enforced anywhere. It is
 * now, at the one place every reader goes through.
 *
 * Node's `path.join` does NOT have that absolute-operand rule; `joinPath`, which this
 * module joins with, does -- and the check is here either way, because the guarantee
 * callers rely on is "a name, validated once", not "the joiner happens to be safe".
 */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/u;

/**
 * The user-preset file for `name`, or refuse a name that is not a name.
 *
 * Validated here rather than at the call sites so `load`, `resolve` and `listPresets` all
 * inherit it -- a check on two of the three is the shape this bug had in the first place.
 */
export function userPath(name: string): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(
      `${quotedText(String(name))} is not a preset name (want lower-case letters, digits, '-' ` +
        `and '_', starting with a letter or digit). A preset is a YAML file in ` +
        `${config.presetDir()}; it is named, never given as a path.`,
    );
  }
  const base = config.presetDir();
  const candidate = joinPath(base, `${name}.yaml`);
  // Belt and braces: the regex already forbids '/', '\\' and '.', so this cannot trigger
  // today. It is here because the regex is one edit away from being loosened, and the
  // consequence of loosening it is arbitrary container specs.
  try {
    if (path.dirname(fs.realpathSync(candidate)) !== fs.realpathSync(base)) {
      throw new Error(`preset ${quotedText(name)} resolves outside ${base}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('preset ')) throw error;
    // A filesystem error -- the file or the directory is simply not there yet.
  }
  return candidate;
}

/** The stems of the shipped `*.yaml` catalogue rows. */
function builtinStems(): string[] {
  const dir = config.dataPath('presets');
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith('.yaml'))
    .map((entry) => entry.slice(0, -'.yaml'.length));
}

/** Load a legacy dynamic or static preset without scenario dispatch. */
function loadNonScenario(name: string, params: registry.Params): Preset {
  const builders = dynamicBuilders();
  const builder = builders[name];
  if (builder !== undefined) return builder(params);

  const builtin = config.dataPath('presets', `${name}.yaml`);
  if (!fs.existsSync(builtin) || !fs.statSync(builtin).isFile()) {
    throw new Error(`unknown preset ${quotedText(name)} (run \`houston presets\` to list)`);
  }
  return parse(fs.readFileSync(builtin, 'utf8'), 'built-in');
}

/**
 * Return a preset by name.
 *
 * Precedence: a user file (~/.houston/presets/<name>.yaml) wins over everything -- so
 * users can override even a dynamic preset like `ldap`/`saml`. Otherwise a dynamic preset
 * is built from `params`, else the built-in YAML is used.
 */
export function load(name: string, params?: registry.Params | null): Preset {
  const given = params ?? {};
  const file = userPath(name);
  if (fs.existsSync(file)) return parse(fs.readFileSync(file, 'utf8'), file);

  const scenario = scenarioDefinitions()[name];
  if (scenario !== undefined) return scenario.resolve(given, RUNTIME_DEFAULT);
  return loadNonScenario(name, given);
}

/**
 * Resolve one preset through its built-in scenario adapter when present.
 *
 * `deploymentType` is an internal seam. Leaving it unset preserves the current catalogue
 * behaviour and uses the preset's own declared topology. A user YAML override always wins
 * and is never interpreted as a scenario.
 */
export function resolve(
  name: string,
  deploymentType?: string | null,
  params?: registry.Params | null,
): Preset {
  const given = params ?? {};
  const file = userPath(name);
  let preset: Preset;
  if (fs.existsSync(file)) {
    preset = parse(fs.readFileSync(file, 'utf8'), file);
  } else {
    const scenario = scenarioDefinitions()[name];
    if (scenario !== undefined) {
      const target =
        deploymentType !== null && deploymentType !== undefined && deploymentType !== ''
          ? deploymentType
          : RUNTIME_DEFAULT;
      return scenario.resolve(given, target);
    }
    preset = loadNonScenario(name, given);
  }

  // Enforced only when the preset actually declares a requirement.
  if (
    deploymentType !== null &&
    deploymentType !== undefined &&
    deploymentType !== '' &&
    preset.topology !== '' &&
    preset.topology !== deploymentType
  ) {
    throw new Error(
      `preset ${quotedText(name)} declares deployment type ${quotedText(preset.topology)}, ` +
        `not ${quotedText(deploymentType)}`,
    );
  }
  return preset;
}

/**
 * All available presets, user files shadowing built-ins, sorted by name.
 *
 * Three things here are the established behaviour and were not, each measured through
 * `houston presets` against the frozen CLI (t1-presets). BOTH SORTS are by code point:
 * user presets named `😀-emoji` and `Ａ-fullwidth` printed in opposite orders, and of two
 * files declaring one name, the one sorted last wins -- a different one here. `seen` is a
 * Map: a preset named `__proto__` set a plain object's prototype and vanished from the
 * list. And an unreadable file is named in the established words: the stem of a file
 * called `.yaml` is `.yaml` (a leading dot is no suffix), and a read that fails says
 * `<path>: Is a directory`, not Node's `EISDIR: ...`.
 */
export function listPresets(): Preset[] {
  const seen = new Map<string, Preset>();
  const builtinDir = config.dataPath('presets');
  for (const entry of fs.readdirSync(builtinDir)) {
    if (!entry.endsWith('.yaml')) continue;
    const p = parse(fs.readFileSync(path.join(builtinDir, entry), 'utf8'), 'built-in');
    seen.set(p.name, p);
  }

  for (const [name, build] of Object.entries(dynamicBuilders())) {
    seen.set(name, build({})); // default params, just for description/params_help
  }

  const userDir = config.presetDir();
  if (fs.existsSync(userDir)) {
    // A directory that cannot be listed, or a presets path that is a FILE, yields no user
    // presets -- the error is swallowed; `readdirSync` threw, and `houston presets`
    // printed a stack where it must print the catalogue.
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(userDir);
    } catch (error) {
      if (typeof (error as NodeJS.ErrnoException).errno !== 'number') throw error;
    }
    const files = entries.filter((entry) => entry.endsWith('.yaml')).sort(compareCodePoints);
    for (const entry of files) {
      const file = joinPath(userDir, entry);
      const stem = entry === '.yaml' ? entry : entry.slice(0, -'.yaml'.length);
      // PER FILE, because one bad one used to take out the whole catalogue: this feeds
      // `houston presets`, `/api/presets` and the create dialog, and `capabilities`
      // swallows the exception and reports ZERO presets. A file somebody is halfway
      // through writing must not do that. Reported the way `backup.listBackups` reports an
      // unreadable bundle -- named, not hidden.
      try {
        // A strict decode: a file that is not UTF-8 is a `NotUtf8` refusal, and so
        // UNREADABLE, where `readFileSync(file, 'utf8')` put a U+FFFD in and printed the box.
        const p = parse(decodeUtf8Strict(fs.readFileSync(file), file), file);
        seen.set(p.name, p);
      } catch (error) {
        // Every refusal is reported per file except a TypeError -- `toInt(null)` for
        // `ports: [null]` -- which ends the command, as it always has.
        if (error instanceof TypeError) throw error;
        const message =
          typeof (error as NodeJS.ErrnoException).errno === 'number'
            ? fileErrorText(error, file)
            : error instanceof Error
              ? error.message
              : String(error);
        seen.set(stem, {
          ...emptyPreset(stem),
          description: `UNREADABLE — ${message}`,
          error: message,
        });
      }
    }
  }

  return [...seen.keys()].sort(compareCodePoints).map((key) => seen.get(key) as Preset);
}
