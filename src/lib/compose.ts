/**
 * Build a docker-compose document for one repro.
 *
 * Built as a plain object (then dumped to YAML) rather than a fixed template, so presets can
 * deep-merge extra services / env / RC patches into it.
 *
 * **THIS MODULE IS PURE, and it sits below the service layer on purpose.** `docker compose
 * config` is an external check this code does not control: this module's document for
 * every preset x version x bind x instances combination was normalised under it and found
 * to be the same document as the one earlier releases generated.
 *
 * **Emission is the established safe dump's.** A YAML 1.2 emitter, measured, writes
 * `ALLOW_EMPTY_PASSWORD: yes` bare, which is CORRECT 1.2 -- and compose reads YAML 1.1,
 * where bare `yes` is a boolean, and rejects the value. The document is written by the
 * emitter in `yaml-dump.ts`, whose YAML 1.1 resolver quotes it, and READ back with the
 * established grammar (`record.ts`'s `readCompose`), since that emitter's output is what
 * every workspace earlier releases made holds.
 */

import { promises as fs } from 'node:fs';
import { isIP } from 'node:net';
import * as path from 'node:path';

import {
  ADMIN_EMAIL,
  ADMIN_NAME,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  DEFAULT_BIND_HOST,
  MONGO_OPLOG_URL,
  MONGO_URL,
  RC_CONTAINER_PORT,
  yamlDateText,
} from './config';
import { ValidationError } from './errors';
import * as monitoring from './monitoring';
import type { Preset } from './presets/types';
import { toTextYaml } from './format';
import { safeDump, type ImplicitResolver } from './yaml-dump';

/** A compose service body. Deliberately open: presets merge arbitrary keys into it. */
export type Service = Record<string, unknown>;

export interface ComposeDoc {
  name: string;
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Spec {
  projectName: string;
  rcImage: string;
  rcTag: string;
  mongoTag: string;
  /** "bitnami-legacy" | "official" */
  mongoFlavor: string;
  /** Used only by the official flavor's init container. */
  mongoShell: string;
  oplog: boolean;
  rootUrl: string;
  /** houston-served TLS, independently of a customer's --root-url proxy. */
  publicUrl: string;
  hostPort: number;
  regToken: string | null;
  /** Whether the workspace holds an Enterprise licence in `LICENSE_ENV_FILE`. */
  licensed: boolean;
  preset: Preset;
  /** --monitor: add Prometheus + Grafana. */
  monitoring: boolean;
  /**
   * `up --env K=V` / `houston env --set`. Applied to every rocketchat service, LAST, so
   * it beats the preset. A null value removes the key.
   */
  envOverrides: Record<string, string | null>;
  containerPort: number;
  /**
   * Host interface published ports bind to (the official rocketchat-compose BIND_IP
   * pattern). Loopback by default: repros run weak fixed credentials, so they must not
   * be reachable from the local network unless asked.
   */
  bindHost: string;
  /**
   * The workspace's Rocket.Chat admin password. Empty means the shared loopback
   * `config.ADMIN_PASSWORD`. It is a SPEC field because the compose document is what
   * actually provisions the admin, so a password stored in repro.json and not put here
   * would be a record of a login that does not work.
   */
  adminPassword: string;
}

/** A `Spec` with the established defaults. */
export function spec(fields: Partial<Spec> & Pick<Spec, 'projectName' | 'preset'>): Spec {
  return {
    rcImage: '',
    rcTag: '',
    mongoTag: '',
    mongoFlavor: '',
    mongoShell: '',
    oplog: false,
    rootUrl: '',
    publicUrl: '',
    hostPort: 0,
    regToken: null,
    licensed: false,
    monitoring: false,
    envOverrides: {},
    containerPort: RC_CONTAINER_PORT,
    bindHost: DEFAULT_BIND_HOST,
    adminPassword: '',
    ...fields,
  };
}

/**
 * The rocketchat service name(s) in the compose doc: one 'rocketchat', or
 * 'rocketchat-1..N' for a multi-instance repro. Used for Prometheus targets.
 */
export function rcServiceNames(instances: number): string[] {
  const n = Math.max(1, instances || 1);
  if (n === 1) return ['rocketchat'];
  return Array.from({ length: n }, (_v, i) => `rocketchat-${i + 1}`);
}

/** Whether this is one of the service names Compose generation gives Rocket.Chat. */
export function isRocketChatServiceName(name: string): boolean {
  return name === 'rocketchat' || /^rocketchat-[1-9][0-9]*$/u.test(name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Recursively merge `patch` into `base` (patch wins), returning `base`. */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    const existing = base[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      deepMerge(existing, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

/** A deep copy, matching `copy.deepcopy` for the JSON-shaped values used here. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

interface EnvironmentEntry {
  present: boolean;
  value: unknown;
}

/** The final explicit value for one Compose environment name, if it has one. */
function environmentEntry(environment: unknown, name: string): EnvironmentEntry {
  if (isPlainObject(environment)) {
    return Object.prototype.hasOwnProperty.call(environment, name)
      ? { present: true, value: environment[name] }
      : { present: false, value: undefined };
  }
  if (!Array.isArray(environment)) return { present: false, value: undefined };
  // Compose also accepts `environment: [NAME=value]`. A bare name inherits an ambient host
  // value, which is not a value Houston can claim it supplied.
  let result: EnvironmentEntry = { present: false, value: undefined };
  for (const item of environment) {
    if (typeof item !== 'string') return { present: true, value: undefined };
    if (item === name) result = { present: true, value: undefined };
    else if (item.startsWith(`${name}=`)) {
      result = { present: true, value: item.slice(name.length + 1) };
    }
  }
  return result;
}

/**
 * Compose resolves unescaped `$NAME` and `${NAME}` only when it starts the service. Houston
 * deliberately does not inherit ambient values into its warning path, so only a known literal
 * can suppress a missing-token or missing-licence warning. `$$` is Compose's literal-dollar
 * escape and remains a supplied value.
 */
function isKnownNonBlankComposeValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  if (text === '') return false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '$') continue;
    if (text[index + 1] === '$') {
      index += 1;
      continue;
    }
    const next = text[index + 1] ?? '';
    if (next === '{' || /[A-Za-z_]/u.test(next)) return false;
  }
  return true;
}

/** Trim an explicit registration token in its final Compose environment. */
function normalizeRegToken(environment: unknown): void {
  if (isPlainObject(environment)) {
    const token = environment.REG_TOKEN;
    if (token !== null && token !== undefined) environment.REG_TOKEN = String(token).trim();
    return;
  }
  if (!Array.isArray(environment)) return;
  for (let index = 0; index < environment.length; index += 1) {
    const entry = environment[index];
    if (typeof entry === 'string' && entry.startsWith('REG_TOKEN=')) {
      environment[index] = `REG_TOKEN=${entry.slice('REG_TOKEN='.length).trim()}`;
    }
  }
}

/** One final env_file reference, without consulting the host environment. */
export function licenseEnvFiles(
  service: Service | undefined,
  projectDirectory: string,
): {
  path: string;
  raw: boolean;
  optional: boolean;
}[] {
  const files = service?.env_file;
  const entries = Array.isArray(files) ? files : files === undefined ? [] : [files];
  return entries.map((entry) => {
    const file = isPlainObject(entry) ? entry.path : entry;
    return {
      path:
        typeof file === 'string' && isKnownNonBlankComposeValue(file)
          ? path.resolve(projectDirectory, file.replace(/\$\$/gu, '$'))
          : '',
      raw: isPlainObject(entry) && entry.format === 'raw',
      optional: isPlainObject(entry) && entry.required === false,
    };
  });
}

/** Presence only. null means the file leaves that key unchanged. */
export interface EnvFileCredentials {
  readonly license: boolean | null;
  readonly token: boolean | null;
}

/**
 * Presence only: no credential text leaves this parser. Unsupported or interpolated
 * input cannot establish a licence or a registration token. null means the file leaves
 * that key unchanged.
 */
export function credentialsInEnvFile(text: string, raw: boolean): EnvFileCredentials {
  let license: boolean | null = null;
  let token: boolean | null = null;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    const entry = /^\s*(?:export\s+)?([A-Za-z0-9_.\-[\]]+)(?:\s*([=:])\s*(.*))?$/u.exec(line);
    if (entry === null) return { license: false, token: false };
    const key = entry[1];
    let value = entry[3] ?? '';
    let literal = raw;
    if (!raw) {
      const quote = value[0];
      if (quote === "'" || quote === '"') {
        // Consume quoted multiline values together, including unrelated keys. Their
        // contents must never be mistaken for subsequent assignments.
        const pattern = /^(?:'((?:[^'\\]|\\[\s\S])*)'|"((?:[^"\\]|\\[\s\S])*)")\s*(?:#.*)?$/u;
        while (!pattern.test(value) && index + 1 < lines.length) {
          index += 1;
          value += `\n${lines[index] ?? ''}`;
        }
        const quoted = pattern.exec(value);
        if (quoted === null) return { license: false, token: false };
        value = quoted[1] ?? quoted[2] ?? '';
        literal = quote === "'";
        if (!literal)
          value = value.replace(/\\([abfnrtv$"\\]|0[0-9]{0,3})/gu, (match, code: string) => {
            if (code.startsWith('0')) {
              // compose-go accepts one to three octal digits after the leading 0.
              // \040 is a space. Requiring three digits kept that text and cleared only \0040.
              const octal = code.slice(1);
              const number = Number.parseInt(octal, 8);
              return /^[0-7]{1,3}$/u.test(octal) && number <= 255
                ? String.fromCharCode(number)
                : match;
            }
            return (
              {
                a: '\x07',
                b: '\b',
                f: '\f',
                n: '\n',
                r: '\r',
                t: '\t',
                v: '\v',
                $: '$$',
                '"': '"',
                '\\': '\\',
              }[code] ?? match
            );
          });
      } else value = value.replace(/\s+#.*$/u, '').trim();
    }
    const present = literal ? value.trim() !== '' : isKnownNonBlankComposeValue(value);
    if (key === 'ROCKETCHAT_LICENSE') license = present;
    else if (key === 'REG_TOKEN') token = present;
  }
  return { license, token };
}

/** Presence states per env_file reference, keyed as the effective-credential readers expect. */
export interface EnvFileStates {
  readonly fileLicenses: ReadonlyMap<string, boolean | null>;
  readonly fileTokens: ReadonlyMap<string, boolean | null>;
}

/**
 * Read every env_file the named services reference, presence only. An unreadable or
 * unresolvable file supplies nothing; a missing optional file leaves earlier state unchanged.
 * `pending` holds files a create is about to write, as [relative path, content]; they replace
 * whatever is on disk, so they are read instead of it.
 */
export async function readEnvFileStates(
  doc: ComposeDoc,
  names: readonly string[],
  projectDirectory: string,
  pending: readonly (readonly [string, string])[] = [],
): Promise<EnvFileStates> {
  const generated = new Map(
    pending.map(([relative, content]) => [path.resolve(projectDirectory, relative), content]),
  );
  const fileLicenses = new Map<string, boolean | null>();
  const fileTokens = new Map<string, boolean | null>();
  for (const name of names) {
    for (const file of licenseEnvFiles(doc.services[name], projectDirectory)) {
      const key = JSON.stringify([file.path, file.raw, file.optional]);
      if (fileLicenses.has(key)) continue;
      if (file.path === '') {
        fileLicenses.set(key, false);
        fileTokens.set(key, false);
        continue;
      }
      try {
        const text = generated.get(file.path) ?? (await fs.readFile(file.path, 'utf8'));
        const found = credentialsInEnvFile(text, file.raw);
        fileLicenses.set(key, found.license);
        fileTokens.set(key, found.token);
      } catch (error) {
        const missing =
          file.optional && (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : false;
        fileLicenses.set(key, missing);
        fileTokens.set(key, missing);
      }
    }
  }
  return { fileLicenses, fileTokens };
}

/** Presence only: no licence text leaves this parser. null means the file leaves the key unchanged. */
export function licenseInEnvFile(text: string, raw: boolean): boolean | null {
  return credentialsInEnvFile(text, raw).license;
}

/**
 * Env files apply in order. A later known assignment replaces any earlier state.
 * null leaves the earlier state. An optional file with no recorded state is one Compose
 * skips, including a missing `.license.env` this run is not writing.
 */
function assignmentFromFiles(
  service: Service | undefined,
  projectDirectory: string,
  states: ReadonlyMap<string, boolean | null>,
  supplyingLicense: boolean,
): boolean {
  const licenseFile = path.resolve(projectDirectory, LICENSE_ENV_FILE);
  let present = false;
  for (const file of licenseEnvFiles(service, projectDirectory)) {
    if (supplyingLicense && file.path === licenseFile) {
      present = true;
      continue;
    }
    const state = states.get(JSON.stringify([file.path, file.raw, file.optional]));
    if (state === undefined) {
      if (file.optional) continue;
      present = false;
      continue;
    }
    if (state !== null) present = state;
  }
  return present;
}

function serviceHasLicense(
  service: Service | undefined,
  licensed: boolean,
  projectDirectory: string,
  fileLicenses: ReadonlyMap<string, boolean | null>,
): boolean {
  const entry = environmentEntry(service?.environment, 'ROCKETCHAT_LICENSE');
  return entry.present
    ? isKnownNonBlankComposeValue(entry.value)
    : assignmentFromFiles(service, projectDirectory, fileLicenses, licensed);
}

/** An explicit REG_TOKEN wins, including a blank one. Otherwise the ordered env files apply. */
function serviceHasToken(
  service: Service | undefined,
  projectDirectory: string,
  fileTokens: ReadonlyMap<string, boolean | null>,
): boolean {
  const entry = environmentEntry(service?.environment, 'REG_TOKEN');
  return entry.present
    ? isKnownNonBlankComposeValue(entry.value)
    : assignmentFromFiles(service, projectDirectory, fileTokens, false);
}

/** Whether every final Rocket.Chat service gets a known licence from its environment or file. */
export function hasEffectiveLicense(
  doc: ComposeDoc,
  instances: number,
  licensed: boolean,
  projectDirectory: string,
  fileLicenses: ReadonlyMap<string, boolean | null> = new Map(),
): boolean {
  return rcServiceNames(instances).every((name) =>
    serviceHasLicense(doc.services[name], licensed, projectDirectory, fileLicenses),
  );
}

/**
 * Whether any named Rocket.Chat service gets a known registration token, by the same rule
 * the create warnings use. Presence only; the evidence record never holds the value.
 */
export function suppliesRegToken(
  doc: ComposeDoc,
  names: readonly string[],
  projectDirectory: string,
  fileTokens: ReadonlyMap<string, boolean | null>,
): boolean {
  return names.some((name) => serviceHasToken(doc.services[name], projectDirectory, fileTokens));
}

/** Every replica needs a credential, but replicas may use different credential types. */
export function hasEffectiveCredential(
  doc: ComposeDoc,
  instances: number,
  licensed: boolean,
  projectDirectory: string,
  fileLicenses: ReadonlyMap<string, boolean | null> = new Map(),
  fileTokens: ReadonlyMap<string, boolean | null> = new Map(),
): boolean {
  return rcServiceNames(instances).every((name) => {
    const service = doc.services[name];
    return (
      serviceHasToken(service, projectDirectory, fileTokens) ||
      serviceHasLicense(service, licensed, projectDirectory, fileLicenses)
    );
  });
}

function rcEnvironment(s: Spec): Record<string, string> {
  const env: Record<string, string> = {
    ROOT_URL: s.rootUrl,
    PORT: String(s.containerPort),
    DEPLOY_METHOD: 'docker',
    DEPLOY_PLATFORM: 'compose',
    MONGO_URL,
    ALLOW_UNSAFE_QUERY_AND_FIELDS_API_PARAMS: 'false',
    // Every repro should be usable out of the box: skip the setup wizard (houston also
    // finalizes it over the API on `ready`) and auto-provision the first admin. Presets
    // only add their scenario-specific settings.
    OVERWRITE_SETTING_Show_Setup_Wizard: 'completed',
    // NO `INITIAL_USER`, and its absence is measured rather than assumed. It used to be
    // here as "yes", and Rocket.Chat parses this one as JSON: every boot of every
    // workspace logged `Error processing environment variable INITIAL_USER SyntaxError:
    // Unexpected token 'y', "yes" is not valid JSON`, on both runtimes, forever -- noise
    // in exactly the artefact a support engineer reads to find the customer's real
    // problem. `true` is what RC's docs use and it is WORSE: RC parses it, finds no
    // `_id`, and logs `No _id provided; Ignoring environment variable INITIAL_USER`.
    // Removing it entirely is what works, because the admin never came from it --
    // ADMIN_USERNAME/ADMIN_PASS/ADMIN_EMAIL below do that.
    ADMIN_USERNAME,
    ADMIN_NAME,
    ADMIN_EMAIL,
    ADMIN_PASS: s.adminPassword || ADMIN_PASSWORD,
  };
  if (s.oplog) {
    // RC < 8 only; deprecated in 8.x.
    env.MONGO_OPLOG_URL = MONGO_OPLOG_URL;
  }
  if (s.regToken) env.REG_TOKEN = s.regToken;
  // Preset env (OVERWRITE_SETTING_* etc.) wins over base defaults. The displayed form of
  // the value the preset's YAML holds: `String` wrote `true`, `null`, `Infinity`, `1,2`, `[object
  // Object]` and a date in the box's time zone where the established values are `True`,
  // `None`, `inf`, `[1, 2]`, `{'a': 1}` and `2026-01-01`.
  for (const [k, v] of Object.entries(s.preset.env)) env[k] = toTextYaml(v, yamlDateText);
  // Explicit user overrides win over everything, including the base keys: this is a
  // reproduction tool, so pointing MONGO_URL or ROOT_URL somewhere odd is a legitimate
  // thing to want. A null value means "remove this key entirely", which is how you unset
  // a base or preset default rather than merely blanking it.
  for (const [k, v] of Object.entries(s.envOverrides)) {
    if (v === null) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

/**
 * mongod asks for 64000 open files and warns on every boot that 1024 is too low. Docker's
 * default soft limit IS 1024, and normal Rocket.Chat traffic survives it -- but building
 * many collections and indexes at once does not: a `houston restore` hit EMFILE inside
 * WiredTiger, which panics and aborts the whole mongod rather than failing the one
 * operation. The container's hard limit is far higher, so raising the soft limit costs
 * nothing.
 */
const MONGO_ULIMITS = { nofile: { soft: 64000, hard: 64000 } };

function mongoServiceBitnami(s: Spec): Record<string, Service> {
  // Bitnami auto-initiates the replica set via REPLICA_SET_MODE=primary, so no separate
  // init container is needed.
  return {
    mongodb: {
      image: `docker.io/bitnamilegacy/mongodb:${s.mongoTag}`,
      restart: 'always',
      ulimits: clone(MONGO_ULIMITS),
      // Bitnami MongoDB images are published for amd64 only; pin the platform so they
      // run (under emulation) on Apple Silicon too.
      platform: 'linux/amd64',
      volumes: ['mongodb_data:/bitnami/mongodb'],
      environment: {
        MONGODB_REPLICA_SET_MODE: 'primary',
        MONGODB_REPLICA_SET_NAME: 'rs0',
        MONGODB_PORT_NUMBER: '27017',
        MONGODB_INITIAL_PRIMARY_HOST: 'mongodb',
        MONGODB_INITIAL_PRIMARY_PORT_NUMBER: '27017',
        MONGODB_ADVERTISED_HOSTNAME: 'mongodb',
        MONGODB_ENABLE_JOURNAL: 'true',
        ALLOW_EMPTY_PASSWORD: 'yes',
      },
    },
  };
}

function mongoServiceOfficial(s: Spec): Record<string, Service> {
  // Mirrors the official RocketChat/rocketchat-compose: MongoDB Inc's community-server
  // image (runs as uid 1001), so a fix-permission container chowns the data dir first,
  // then a one-shot container initiates the replica set. `directConnection=true` lets
  // mongosh reach the node before rs.initiate.
  const image = `docker.io/mongodb/mongodb-community-server:${s.mongoTag}-ubi8`;
  const sh = s.mongoShell; // mongosh for Mongo >= 5
  const uri = 'mongodb://mongodb:27017/?directConnection=true';
  // RETRIED, a minute at most. mongod checks that `mongodb` resolves to itself, and one
  // failed lookup made this single shot exit 1 and the whole `up` fail -- on rootless Podman
  // its DNS misses for a moment whenever a neighbouring workspace's network comes or goes
  // (measured: 3 in 38,302 lookups during a neighbour's up and down, `NodeNotFound` at
  // `replSetInitiate`). `var`, which every shell this image may carry parses.
  const initiate =
    'for (var i = 1; ; i++) { try { rs.status(); break } catch (e) { ' +
    "try { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongodb:27017' }] }); " +
    'break } catch (f) { if (i >= 30) throw f; sleep(2000) } } }';
  return {
    'mongodb-fix-permission': {
      image,
      user: '0',
      restart: 'on-failure',
      volumes: ['mongodb_data:/data/db:rw'],
      entrypoint: ['sh', '-c', 'chown -R 1001 /data/db'],
    },
    mongodb: {
      image,
      user: '1001',
      restart: 'always',
      ulimits: clone(MONGO_ULIMITS),
      depends_on: { 'mongodb-fix-permission': { condition: 'service_completed_successfully' } },
      volumes: ['mongodb_data:/data/db:rw'],
      entrypoint: ['mongod', '--replSet', 'rs0', '--bind_ip_all'],
      environment: { ALLOW_EMPTY_PASSWORD: 'yes' },
      healthcheck: {
        test: ['CMD', sh, uri, '--eval', "db.adminCommand('ping')"],
        interval: '10s',
        timeout: '10s',
        retries: 30,
        start_period: '20s',
      },
    },
    // THE CONNECTION RETRIED TOO, not only the initiate: the shell connects before `--eval`
    // runs, so a lookup of `mongodb` that missed at that moment ended this one shot -- a
    // fresh `up` under Podman's DNS churn lost one boot in fifteen, and every `restart`
    // re-runs it. The address and the script travel as environment so the shell quotes
    // nothing; `$$` is compose's escape for a `$` the shell is to read.
    'mongo-init': {
      image,
      restart: 'no',
      depends_on: { mongodb: { condition: 'service_healthy' } },
      entrypoint: [
        'sh',
        '-c',
        `for i in 1 2 3 4 5 6 7 8 9 10; do ${sh} "$$MONGO_URI" --eval "$$RS_INIT" && exit 0; ` +
          'sleep 2; done; exit 1',
      ],
      environment: { MONGO_URI: uri, RS_INIT: initiate },
    },
  };
}

/**
 * Healthcheck for a Rocket.Chat instance. Uses `node` (always in the RC image) to hit
 * /api/info, so we do not depend on curl/wget being present.
 */
const RC_HEALTHCHECK = {
  test: [
    'CMD',
    'node',
    '-e',
    "require('http').get('http://localhost:3000/api/info'," +
      "r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))",
  ],
  interval: '10s',
  timeout: '5s',
  retries: 30,
  start_period: '60s',
};

/** Normalise a depends_on (plain list or condition-map) to a condition-map. */
function asConditionMap(deps: unknown): Record<string, { condition: string }> {
  if (isPlainObject(deps)) return { ...deps } as Record<string, { condition: string }>;
  const out: Record<string, { condition: string }> = {};
  for (const d of Array.isArray(deps) ? deps : [])
    out[String(d)] = { condition: 'service_started' };
  return out;
}

/**
 * Clone the rocketchat service into N instances (rocketchat-1..N).
 *
 * Instances coordinate over NATS (the moleculer transporter), matching the official
 * RocketChat/rocketchat-compose. INSTANCE_IP is intentionally left unset -- the legacy
 * DDP-mesh address is not used once NATS is the transporter.
 *
 * The load balancer owns the workspace port (hostPort); each instance is ALSO published
 * directly on hostPort+i so you can open a specific instance in the browser (e.g. to
 * post on one and watch it arrive on another). Traefik reaches them over the compose
 * network by service name regardless.
 *
 * Cold start is serialised: only rocketchat-1 boots against the empty database (running
 * migrations and seeding settings); rocketchat-2..N wait for it to be healthy first, so
 * they never race it to insert the same records -- which on a fresh DB otherwise crashes
 * an instance with E11000 duplicate-key errors.
 */
function instanceServices(
  base: Service,
  n: number,
  hostPort: number,
  containerPort: number,
): Record<string, Service> {
  const out: Record<string, Service> = {};
  for (let i = 1; i <= n; i += 1) {
    const inst = clone(base);
    inst.ports = [`${hostPort + i}:${containerPort}`]; // direct access
    (inst.environment as Record<string, string>).TRANSPORTER = 'monolith+nats://nats:4222';
    inst.healthcheck = clone(RC_HEALTHCHECK);
    if (i > 1) {
      const deps = asConditionMap(inst.depends_on);
      deps['rocketchat-1'] = { condition: 'service_healthy' };
      inst.depends_on = deps;
    }
    out[`rocketchat-${i}`] = inst;
  }
  return out;
}

/** Add each name in `extra` to a service's depends_on (list or condition-dict). */
function addDepends(svc: Service, extra: readonly string[]): void {
  const deps = svc.depends_on;
  for (const dep of extra) {
    if (Array.isArray(deps)) {
      if (!deps.includes(dep)) deps.push(dep);
    } else if (isPlainObject(deps)) {
      if (!(dep in deps)) deps[dep] = { condition: 'service_started' };
    }
  }
}

/** The Prometheus/Grafana add-on, wired to every Rocket.Chat instance. */
function attachMonitoring(doc: ComposeDoc, rcServices: Record<string, Service>, s: Spec): void {
  if (!s.monitoring) return;
  deepMerge(doc.services, monitoring.services(s.publicUrl)); // bare ports; bound below
  Object.assign(doc.volumes, monitoring.volumes());
  for (const svc of Object.values(rcServices)) {
    (svc.environment as Record<string, string>)[monitoring.RC_METRICS_ENV] = 'true';
  }
}

/** Give the published host port to the preset's front end, and to nothing else. */
function publishThroughEntryService(
  doc: ComposeDoc,
  rcServices: Record<string, Service>,
  s: Spec,
): void {
  // A preset can hand the published host port to a front-end service (a load balancer)
  // instead of rocketchat -- the port is not known until `up`, so it is injected here
  // rather than in the preset.
  const entry = s.preset.entryService;
  if (!entry) return;
  if (!(entry in doc.services)) {
    // Silently skipping meant NOTHING published the host port: the repro booted and was
    // unreachable at its own advertised rootUrl.
    throw new Error(
      `preset ${JSON.stringify(s.preset.name)} sets entry_service ${JSON.stringify(entry)}, ` +
        `which is not one of its services (${Object.keys(doc.services).sort().join(', ')})`,
    );
  }
  (doc.services[entry] as Service).ports = [`${s.hostPort}:80`];
  // The front-end owns the published port now. Leaving the same host port on the RC
  // service too binds it twice and `up` fails with "port is already allocated" -- which
  // a single-instance preset setting entry_service would hit every time. Drop only the
  // colliding mapping, so multi-instance keeps its direct per-instance ports on
  // hostPort+i.
  for (const [svcName, svc] of Object.entries(rcServices)) {
    if (svcName === entry) continue;
    const ports = Array.isArray(svc.ports) ? svc.ports : [];
    const kept = ports.filter((p) => String(p).split(':')[0] !== String(s.hostPort));
    if (kept.length > 0) svc.ports = kept;
    else delete svc.ports;
  }
}

/**
 * `[repository, tag]` for the chart, which wants them separately, and `imageRef`.
 *
 * `versions.resolve` returns the REPOSITORY only -- compose composes it as
 * `${image}:${tag}` -- so a naive split on the last ':' of a tagless string returns the
 * whole repository as the tag. That is truthy, so an `|| rcVersion` fallback does not save
 * it, and the chart fed it to `semverCompare`, which failed the install with "invalid
 * semantic version" rather than anything naming the image.
 *
 * A colon only introduces a tag when nothing after it looks like a path segment:
 * `registry:5000/org/img` is a host with a port, not a tag.
 */
export function splitImage(rcImage: string, rcVersion: string): [string, string] {
  const at = rcImage.lastIndexOf(':');
  if (at >= 0) {
    const tail = rcImage.slice(at + 1);
    if (!tail.includes('/')) return [rcImage.slice(0, at), tail];
  }
  return [rcImage, rcVersion];
}

/**
 * The image reference to run: the image as given when it already names a tag (a CI build,
 * `--rc-image repo:tag`), else `<image>:<version>`. Appending unconditionally rendered
 * `repo:tag:8.5.1`, which no registry can resolve.
 */
export function imageRef(rcImage: string, rcVersion: string): string {
  const [repo, tag] = splitImage(rcImage, rcVersion);
  return `${repo}:${tag}`;
}

/** What `forEngine` needs to know about the engine a document will run on. */
export interface EngineShape {
  readonly kind: string;
  /** The engine's API socket on this host. */
  readonly socket: string;
  /** Where it keeps containers: `/var/lib/docker`, or Podman's graph root. */
  readonly rootDir: string;
}

const DOCKER_SOCKET = '/var/run/docker.sock';
const DOCKER_CONTAINERS = '/var/lib/docker/containers';

/**
 * The document as the engine it will run on needs it. Docker's is returned as it is, the
 * same object, so its bytes cannot move. On Podman (measured rootless, 4.9.3 and 6.1.3):
 * - logs to files (`k8s-file`), where its default is journald, which leaves nothing for the
 *   log collector to tail; the collector already reads that CRI line format;
 * - the Docker paths a service mounts become Podman's own: its socket for the API, and its
 *   container store for the logs (`/var/lib/docker` does not exist; creating it is refused);
 * - `label=disable`, so a host with SELinux lets the containers read the files houston
 *   mounts (harmless where there is none).
 */
export function forEngine(doc: ComposeDoc, engine: EngineShape | null): ComposeDoc {
  if (engine === null || engine.kind !== 'podman') return doc;
  const out = clone(doc);
  for (const service of Object.values(out.services)) {
    service.logging = { driver: 'k8s-file' };
    const options = Array.isArray(service.security_opt) ? service.security_opt.map(String) : [];
    // Idempotent: a document re-applied (monitoring attached later) is not doubled.
    if (!options.includes('label=disable')) service.security_opt = [...options, 'label=disable'];
    if (!Array.isArray(service.volumes)) continue;
    service.volumes = service.volumes.map((volume) => {
      const text = String(volume);
      if (text.startsWith(`${DOCKER_SOCKET}:`))
        return `${engine.socket}${text.slice(DOCKER_SOCKET.length)}`;
      if (text.startsWith(`${DOCKER_CONTAINERS}:`)) {
        return `${engine.rootDir}/overlay-containers${text.slice(DOCKER_CONTAINERS.length)}`;
      }
      return volume;
    });
  }
  return out;
}

/** The workspace file holding `ROCKETCHAT_LICENSE`, 0600, beside the compose document. */
export const LICENSE_ENV_FILE = '.license.env';

/** A FIPS build is published for amd64 only (measured on ghcr, 2026-10-08). */
export function isAmd64Only(rcImage: string): boolean {
  return /-fips(-gha-run-[0-9]+)?$/u.test(splitImage(rcImage, '')[1]);
}

/** The Rocket.Chat service, or N clones of it behind a load balancer. */
function rocketchatServices(n: number, official: boolean, s: Spec): Record<string, Service> {
  const rocketchat: Service = {
    image: imageRef(s.rcImage, s.rcTag),
    ...(isAmd64Only(s.rcImage) ? { platform: 'linux/amd64' } : {}),
    restart: 'always',
    environment: rcEnvironment(s),
    // The licence from a file of its own, never in `environment`: this document is printed
    // by `env`, read by the GUI and kept in the workspace for anyone to open.
    ...(s.licensed ? { env_file: [LICENSE_ENV_FILE] } : {}),
    ports: [`${s.hostPort}:${s.containerPort}`],
    // The same probe the cloned instances have always had. Without it Docker reports no
    // health for this service, and `detail()` then falls back to the container STATE --
    // which is "running" from the moment the process starts, minutes before Rocket.Chat
    // serves anything. The panel said "Health: running" on a workspace whose /api/info
    // was refusing the connection outright, which is the one question that field exists
    // to answer.
    //
    // Informational only: nothing declares depends_on service_healthy against the
    // single-instance service, so this changes what is REPORTED and not what anything
    // waits for.
    healthcheck: clone(RC_HEALTHCHECK),
    depends_on: official
      ? { 'mongo-init': { condition: 'service_completed_successfully' } }
      : ['mongodb'],
  };

  // Single instance (the default): one `rocketchat` service, unchanged. Many instances:
  // clone it into rocketchat-1..N behind a load balancer.
  return n === 1 ? { rocketchat } : instanceServices(rocketchat, n, s.hostPort, s.containerPort);
}

/** Return the compose document for `spec`. */
export function build(s: Spec): ComposeDoc {
  const official = s.mongoFlavor === 'official';
  const n = Math.max(1, s.preset.instances || 1);

  const rcServices = rocketchatServices(n, official, s);

  const services: Record<string, Service> = { ...rcServices };
  Object.assign(services, official ? mongoServiceOfficial(s) : mongoServiceBitnami(s));

  const doc: ComposeDoc = {
    name: s.projectName,
    services,
    volumes: { mongodb_data: { driver: 'local' } },
  };

  // --- apply the preset's backing services / volumes / RC patch / depends_on ---
  if (Object.keys(s.preset.services).length > 0) {
    deepMerge(doc.services, clone(s.preset.services));
  }
  if (Object.keys(s.preset.volumes).length > 0) {
    Object.assign(doc.volumes, clone(s.preset.volumes));
  }
  // The RC patch and extra depends_on apply to EVERY rocketchat instance.
  for (const svc of Object.values(rcServices)) {
    if (Object.keys(s.preset.rocketchat).length > 0) deepMerge(svc, clone(s.preset.rocketchat));
    addDepends(svc, s.preset.dependsOn);
  }
  // Presets and `--env` can win over the flag-derived token. Trim that final value before
  // Compose reads it, so the deployed token and the create-time warning describe one state.
  for (const name of rcServiceNames(n)) normalizeRegToken(doc.services[name]?.environment);

  publishThroughEntryService(doc, rcServices, s);

  // --- HTTPS ---
  // Nothing here. A workspace never terminates TLS: the edge does, for all of them, and
  // it reaches this one over the private network compose already made.
  //
  // So this document is IDENTICAL whether the workspace serves https or not, which is
  // the property the whole design rests on -- adding or removing a name is a route file
  // appearing or disappearing, and no container is ever rebuilt to gain or lose TLS.
  //
  // RC keeps its published http port. houston's own API calls use it, so nothing
  // internal has to trust the local CA, and `curl http://localhost:<port>` still works.

  attachMonitoring(doc, rcServices, s);

  bindPorts(doc, s.bindHost);

  return doc;
}

/** A port or a range of them: "8025", "8000-8005". Either side of a short-syntax entry. */
const PORT_RE = /^\d+(-\d+)?$/;

/**
 * Positions of a separator outside Compose interpolation and bracketed IPv6 literals.
 *
 * A port mapping's address and both port fields may use Compose variables. Their default
 * forms commonly contain `:`, so splitting the string at every colon turns a valid mapping
 * such as `${BIND_IP:-127.0.0.1}:${HOST_PORT:-8080}:${CONTAINER_PORT:-80}` into nonsense.
 */
export function topLevelPositions(text: string, separator: string): number[] {
  const positions: number[] = [];
  let interpolationDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (interpolationDepth > 0) {
      if (character === '{') interpolationDepth += 1;
      else if (character === '}') interpolationDepth -= 1;
      continue;
    }
    if (character === '$' && text[index + 1] === '{') {
      interpolationDepth = 1;
      index += 1;
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (character === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }
    if (character === separator && bracketDepth === 0) positions.push(index);
  }
  return positions;
}

/** A whole Compose variable expression, including its default or required form. */
function composeVariable(value: string): boolean {
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) return true;
  if (!value.startsWith('${')) return false;
  let depth = 0;
  let close = -1;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index] ?? '';
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close !== value.length - 1) return false;
  const expression = value.slice(2, -1);
  const name = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(expression);
  if (name === null) return false;
  const suffix = expression.slice(name[0].length);
  return suffix === '' || /^(?::-|:\?|:\+|-|\?|\+)/u.test(suffix);
}

function portField(value: string): boolean {
  return PORT_RE.test(value) || composeVariable(value);
}

function addressField(value: string): boolean {
  const ip = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  // Docker rejects scope IDs, though Node's isIP accepts them.
  return composeVariable(value) || (isIP(ip) !== 0 && !ip.includes('%'));
}

/**
 * Bind every published port to ONE host address. Applied to ALL services in one pass --
 * RC, multi-instance direct ports, the load balancer, and preset sidecars -- mirroring the
 * official rocketchat-compose `${BIND_IP}:${HOST_PORT}:${PORT}` pattern.
 *
 * A host address an entry already names is REPLACED, not kept. The bind host is the one
 * posture `info` reports and `detectBind` reads back, and a custom preset that writes
 * `0.0.0.0:9000:9000` would otherwise publish a sidecar on every interface of a remote
 * sandbox while the workspace says it is loopback-bound. Short syntax keeps its host port
 * (or its absence: `IP::CONTAINER` is an ephemeral host port), its range and its
 * `/protocol`; long syntax gets `host_ip` even when `published` is omitted for an
 * ephemeral host port.
 */
export function bindPorts(doc: ComposeDoc, bind: string): void {
  if (!bind) return;
  const shortBind = isIP(bind) === 6 ? `[${bind}]` : bind;
  for (const [name, svc] of Object.entries(doc.services)) {
    const ports = svc.ports;
    if (!Array.isArray(ports) || ports.length === 0) continue;
    const out: unknown[] = [];
    for (const p of ports) {
      // THE TYPE CHECK COMES FIRST. Stringifying compose long syntax gives the object's
      // text containing two colons, which once matched the IP-qualified branch below --
      // the object's text was appended as a ports entry. Any shape that is not a string
      // has to be recognised before it is stringified.
      if (isPlainObject(p)) {
        const long = { ...p };
        long.host_ip = bind;
        out.push(long);
        continue;
      }
      const entry = String(p);
      const slash = topLevelPositions(entry, '/')[0] ?? entry.length;
      if (composeVariable(entry.slice(0, slash))) {
        // The variable can expand to an entire mapping, including a wildcard address.
        // Its default cannot prove the shape of the value Compose will read later.
        throw new ValidationError(
          `whole-value Compose interpolation in port entry ${JSON.stringify(p)} in service ` +
            `${JSON.stringify(name)} cannot be safely bound to ${bind}. Use Compose ` +
            'long syntax with separate target and published fields, or resolve the mapping ' +
            'to literal ports before loading the preset.',
        );
      }
      const parsed = shortPort(entry);
      if (parsed === null) {
        // NOT SILENTLY PASSED THROUGH. Everything this function understands is bound
        // above; anything else is a published port it would be leaving on every
        // interface, which is the one outcome that must never be the default. Named so
        // the preset author can see what to change.
        throw new ValidationError(
          `port entry ${JSON.stringify(p)} in service ${JSON.stringify(name)} is a shape ` +
            `houston cannot bind to ${bind}. Write it as "HOST:CONTAINER", a range, or ` +
            'compose long syntax -- leaving it unbound would publish ' +
            'it on every interface.',
        );
      }
      out.push(`${shortBind}:${parsed.host}:${parsed.container}${parsed.protocol}`);
    }
    svc.ports = out;
  }
}

/**
 * The host-side and container-side of a compose short-syntax port entry, with its
 * protocol suffix, and WITHOUT the host address it may name: `[IP:][HOST:]CONTAINER[/PROTO]`,
 * where HOST and CONTAINER are each a port or a range, and HOST may be empty
 * (`IP::CONTAINER`). `null` for anything else.
 *
 * READ FROM THE RIGHT. The address may be dotted, bracketed IPv6, or the unbracketed IPv6
 * the Compose specification's own examples use (`::1:6000:6000`); counting colons from
 * the left refused the last of these. The two rightmost fields are the ports. Any
 * preceding address must be a valid IP literal before `bind` replaces it.
 */
function shortPort(entry: string): { host: string; container: string; protocol: string } | null {
  const slashes = topLevelPositions(entry, '/');
  const slash = slashes.length === 0 ? -1 : (slashes[slashes.length - 1] ?? -1);
  // Docker lowercases the protocol before it validates it, so `/UDP` is `/udp`.
  const protocol = slash === -1 ? '' : entry.slice(slash).toLowerCase();
  const rest = slash === -1 ? entry : entry.slice(0, slash);
  if (protocol !== '' && !/^\/[a-z]+$/u.test(protocol)) return null;
  const colons = topLevelPositions(rest, ':');
  const last = colons.length - 1;
  const containerStart = last < 0 ? 0 : (colons[last] ?? -1) + 1;
  const container = rest.slice(containerStart);
  const hostStart = last < 1 ? 0 : (colons[last - 1] ?? -1) + 1;
  const host = last < 0 ? '' : rest.slice(hostStart, colons[last] ?? rest.length);
  const address = last < 1 ? '' : rest.slice(0, colons[last - 1] ?? 0);
  if (address !== '' && !addressField(address)) return null;
  if (!portField(container)) return null;
  if (host !== '' && !portField(host)) return null;
  return { host, container, protocol };
}

export const HEADER = '# Generated by houston. Do not edit by hand -- re-run `houston up`.\n';

const TIME = String.raw`(?:[01]?[0-9]|2[0-3]):[0-5]?[0-9]:[0-5]?[0-9](?:[.,][0-9]+)?`;

/**
 * The plain scalars docker compose's reader types and this module's resolver does not --
 * the same three patterns earlier releases register, so the two writers stay equal byte for
 * byte.
 *
 * The safe dump writes a string PLAIN when its resolver, a YAML 1.1 one, would read the
 * bare text back as a string. compose-go reads the file with yaml.v3's resolver -- YAML
 * 1.2's numbers, plus the underscores, `0b` and timestamps it kept -- so the string reached
 * the container as a number: `env --set E1=1e8` gave E1=1e+08, `0o17` gave 15, `-.5` gave
 * -0.5, `12e03` gave 12000, `08` gave 8, `2001-1-2` gave `2001-01-02 00:00:00 +0000 UTC`,
 * and `2001-1-2T3:4:5+24:00` made docker refuse the whole file. Measured with `docker compose
 * -f FILE config --format json` over every string of up to four characters of
 * `0-9 + - . _ : a-f E o x O X B` and the lookalikes: 8,133 of 558,352 came back other than
 * they went in, every one written plain. Earlier releases' writer had the same defect. With
 * these the emitter quotes such a string by its own rules, in single quotes, as it already
 * quotes `'3000'` and `'yes'`.
 *
 * They are yaml.v3's `resolve()`: from a sign or a digit, with every `_` taken out, a Go
 * integer literal or a decimal float with an optional unsigned exponent; from a `.`,
 * `strconv.ParseFloat`; and the `time.Parse` layouts `2006-1-2`, with `T`/`t`, `15:4:5`, a
 * fraction and `Z` or `±hh:mm`, or with spaces and the time alone. A magnitude is past
 * them -- `1e999`, an integer past 64 bits in `0x`/`0o`/`0b`, 29 February of a common year
 * are strings to yaml.v3 and are quoted anyway, which reads back the same. `config.yaml`,
 * which only houston reads, is written without them.
 */
const COMPOSE_READER_TYPES: readonly ImplicitResolver[] = [
  [
    'tag:yaml.org,2002:int',
    new RegExp(
      String.raw`^(?:[-+]_*)?(?:0_*[xX]_*(?:[0-9a-fA-F]_*)+|0_*[oO]_*(?:[0-7]_*)+` +
        String.raw`|0_*[bB]_*(?:[01]_*)+|(?:(?:[0-9]_*)+(?:\._*(?:[0-9]_*)*)?|\._*(?:[0-9]_*)+)` +
        String.raw`(?:[eE]_*(?:[-+]_*)?(?:[0-9]_*)+)?)\n?$`,
    ),
    '-+0123456789',
  ],
  ['tag:yaml.org,2002:float', /^\.[0-9]+(?:_[0-9]+)*(?:[eE][-+]?[0-9]+(?:_[0-9]+)*)?\n?$/, '.'],
  [
    'tag:yaml.org,2002:timestamp',
    new RegExp(
      String.raw`^[0-9]{4}-(?:(?:0?[13578]|1[02])-(?:0?[1-9]|[12][0-9]|3[01])` +
        String.raw`|(?:0?[469]|11)-(?:0?[1-9]|[12][0-9]|30)|0?2-(?:0?[1-9]|[12][0-9]))` +
        String.raw`(?:[Tt]${TIME}(?:Z|[-+](?:[01][0-9]|2[0-4]):(?:[0-5][0-9]|60))| +${TIME})?\n?$`,
    ),
    '0123456789',
  ],
];

/**
 * The compose document as YAML: the header, then the document in block style with its keys
 * in their own order, through the emitter in `yaml-dump.ts`.
 *
 * It was the `yaml` package's emitter with `compat: 'yaml-1.1'`, and the package's choices
 * are not the established ones: `PORT: "3000"` where the established file holds `'3000'`,
 * the mongo init command on one 110-column line where the established file folds it at 80,
 * `1e8`, `0o17`, `-.5`, `y` and `N` quoted where the established resolver leaves them
 * plain, `café` raw where the established file escapes it, an empty key as `""` where the
 * established file holds `? ''`, anchors `&a1`, escapes in lower case. Every generated
 * document differed in its bytes from the established one, and every `env --set`,
 * `monitor` or `upgrade` of a workspace an earlier release made rewrote 7 to 16 of its
 * lines. The generated documents are now the established ones byte for byte, which is
 * stronger than `docker compose config` agreeing on them.
 *
 * What the package needed patching for is this emitter's own behaviour and needs nothing
 * more: `yes` is quoted because the resolver reads it as a bool, as it reads `=` and `<<`
 * as the value and merge tags; a tab, DEL, C1, U+2028/U+2029 and U+FFFE/U+FFFF are
 * double-quoted and escaped because the analyser calls them special; and a value of blank
 * lines holding spaces is double-quoted because a space before a line break rules out every
 * other style.
 *
 * Both writers quote `1e8`, `0o17` and `-.5` again since, for docker compose's reader rather
 * than the package's reasons: the resolver is the safe dump's and then
 * `COMPOSE_READER_TYPES`, here as in earlier releases, while `y` and `N` stay plain.
 */
export function toYaml(doc: ComposeDoc): string {
  return HEADER + safeDump(doc, { implicitResolvers: COMPOSE_READER_TYPES });
}
