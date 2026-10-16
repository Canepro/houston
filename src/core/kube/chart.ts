/**
 * Which chart version, and the values houston hands it.
 *
 * `valuesFor` is the one place those values are built, and the conformance harness asks the
 * REAL published chart whether they are valid -- a key the chart ships commented out is
 * invisible to a YAML parse and silently ignored by helm, which surfaces as "the setting had
 * no effect" and never as an error.
 */
import * as config from '../../lib/config';
import { CreateFailedError, ValidationError } from '../../lib/errors';
import { nullEmit, type Emit } from '../../lib/events';
import { toTextYaml } from '../../lib/format';
import { BUILD_IMAGE } from '../../lib/versions';

import { why } from './ask';
import { kube } from './exec';
import { splitImage } from './manifests';
import {
  APPLY_TIMEOUT,
  CHART,
  HELM_REPO,
  HELM_REPO_URL,
  MONGO_OPLOG_URL,
  MONGO_URL,
} from './names';
import { LICENSE_KEY, LICENSE_SECRET, REG_TOKEN_KEY } from './operator';
import { versionKey } from './tools';

/**
 * Add and refresh the Rocket.Chat chart repo in houston's own Helm home.
 *
 * `own: true` UNCONDITIONALLY, and that is correct rather than an oversight -- it has been
 * read as a bug twice, so: every helm call that needs this repo reads it through `helmEnv`,
 * which always points HELM_* at houston's directories whatever cluster is targeted. Writer
 * and readers therefore agree by construction.
 *
 * The obvious-looking alternative would fix the older mismatch by writing `rocketchat` into
 * the USER's repositories.yaml -- mutating their Helm configuration as a side effect of
 * running a repro tool, which is the one thing `ownedEnv` exists to prevent.
 *
 * No context is threaded in because none is needed: `repo add`, `repo update` and `search
 * repo` contact no cluster at all.
 */
export async function ensureRepo(_emit: Emit = nullEmit): Promise<void> {
  await kube.run(['helm', 'repo', 'add', HELM_REPO, HELM_REPO_URL, '--force-update'], {
    timeout: APPLY_TIMEOUT,
    own: true,
  });
  const res = await kube.run(['helm', 'repo', 'update', HELM_REPO], {
    timeout: APPLY_TIMEOUT,
    own: true,
  });
  if (res.returncode !== 0) {
    throw new CreateFailedError(
      `could not read the Rocket.Chat chart repository (${HELM_REPO_URL}): ${why(res)}`,
    );
  }
}

/**
 * The oldest chart series whose values schema is the one `valuesFor` emits.
 *
 * MEASURED against the live index: it holds 96 chart versions, and below 3.0.0 there is
 * exactly ONE -- 0.1.0, appVersion 1.16.0 -- with nothing in between. So the floor rule
 * ("newest chart whose appVersion is at or below the request"), which is correct everywhere
 * else, drops any request below chart 3.0.0's appVersion straight onto a 1.16-era chart.
 * That chart predates every values key houston sets, so it would render something, and not a
 * working workspace.
 *
 * Refusing is better than that, because the tool HAS an answer for these versions: the
 * Docker runtime handles them natively.
 */
export const OLDEST_CHART_SERIES = 3;

interface ChartEntry {
  version?: unknown;
  app_version?: unknown;
}

function atOrBelow(left: readonly number[], right: readonly number[]): boolean {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b;
  }
  return true;
}

/** Strictly greater, so an equal pair keeps the FIRST maximal entry, as `max` does. */
function greater(left: readonly number[], right: readonly number[]): boolean {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

/** The newest chart whose app version does not run ahead of Rocket.Chat's. */
export function bestChartAtOrBelow(entries: ChartEntry[], rcVersion: string): string {
  const want = versionKey(rcVersion);
  const exact = entries.find((entry) => String(entry.app_version ?? '') === rcVersion);
  if (exact !== undefined) return String(exact.version);

  const candidates = entries.filter((entry) =>
    atOrBelow(versionKey(String(entry.app_version ?? '0')), want),
  );
  // OLDER THAN EVERY CHART. There is no floor left to stand on, and the branch that used to
  // catch this fell back to the NEWEST chart -- the furthest possible thing from what was
  // asked. Measured: RC 1.0.0 resolved to chart 7.0.2, which deploys 8.6.1.
  if (candidates.length === 0) {
    let oldest = entries[0] as ChartEntry;
    for (const entry of entries) {
      if (
        greater(
          versionKey(String(oldest.app_version ?? '0')),
          versionKey(String(entry.app_version ?? '0')),
        )
      ) {
        oldest = entry;
      }
    }
    throw new ValidationError(
      `the Kubernetes runtime cannot reproduce Rocket.Chat ${rcVersion}: no chart deploys ` +
        `it or anything older — the oldest is ${String(oldest.version)} (appVersion ` +
        `${String(oldest.app_version)}). Use the Docker runtime for this version by ` +
        'leaving `--runtime` off.',
    );
  }
  let best = candidates[0] as ChartEntry;
  for (const entry of candidates) {
    if (greater(versionKey(String(entry.version)), versionKey(String(best.version)))) {
      best = entry;
    }
  }
  const chosen = String(best.version);
  // A CHART FROM ANOTHER ERA IS NOT A MATCH, it is the floor rule running out of charts at
  // the old end. See OLDEST_CHART_SERIES for the measurement.
  if ((versionKey(chosen)[0] ?? -1) < OLDEST_CHART_SERIES) {
    throw new ValidationError(
      `the Kubernetes runtime cannot reproduce Rocket.Chat ${rcVersion}: the oldest chart ` +
        `that deploys it is ${chosen} (appVersion ${String(best.app_version)}), which ` +
        'predates every values key houston sets, so it would install something other than ' +
        'what you asked for. Use the Docker runtime for this version — it supports it ' +
        'natively — by leaving `--runtime` off.',
    );
  }
  // DELIBERATELY SILENT WHEN THE CHART IS MERELY BEHIND THE APP. That is the normal case,
  // and a line saying so fired on essentially every create immediately before `chart X for
  // Rocket.Chat Y` said the same thing more clearly.
  return chosen;
}

/**
 * Pin a chart version for a Rocket.Chat version.
 *
 * Most Rocket.Chat releases have no chart with a matching appVersion, so an exact match
 * cannot be required. Exact match if one exists, else the newest chart whose appVersion is
 * at or BELOW the request -- a floor, so the chart is never newer than the app it deploys.
 *
 * An unreadable index is terminal rather than falling back to an unpinned chart. For a tool
 * whose whole job is version-matching, `helm install` without `--version` deploys different
 * software after the next chart release.
 */
export async function resolveChartVersion(
  rcVersion: string,
  _emit: Emit = nullEmit,
): Promise<string> {
  // `own: true` for the same reason as `ensureRepo`, which is what populated this index: the
  // chart index lives in houston's Helm home, and reading it touches no cluster.
  const res = await kube.run(['helm', 'search', 'repo', CHART, '--versions', '-o', 'json'], {
    timeout: APPLY_TIMEOUT,
    own: true,
  });
  if (res.returncode !== 0) {
    throw new CreateFailedError(`could not read the Rocket.Chat chart index: ${why(res)}`);
  }
  let entries: unknown;
  try {
    entries = JSON.parse(res.stdout || '[]');
  } catch {
    throw new CreateFailedError('the Rocket.Chat chart index was not valid JSON');
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new CreateFailedError(`no versions found for the chart '${CHART}'`);
  }
  return bestChartAtOrBelow(entries as ChartEntry[], rcVersion);
}

/**
 * Values that make the CHART emit an env var houston also puts in `extraEnv`.
 *
 * Keyed by the value, named by the variable, because the collision is one-to-one and the
 * next one to be added will be too.
 */
export const CHART_CONDITIONAL_ENV: Readonly<Record<string, string>> = Object.freeze({
  license: 'OVERWRITE_SETTING_Show_Setup_Wizard',
  registrationToken: 'REG_TOKEN',
});

export interface ChartEnvEntry {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef: { name: string; key: string } };
}

/**
 * Variables `--env` and `--setting` must not add to the chart's `extraEnv`. Most are emitted
 * by the chart itself; `ROCKETCHAT_LICENSE` is reserved for the existing `--license` Secret
 * lifecycle, which reaches the container through `extraEnv`.
 */
export const CHART_OWNED_ENV: Readonly<Record<string, string>> = Object.freeze({
  ROOT_URL: 'use --root-url, or --domain for a public name',
  MONGO_URL: 'the chart reads it from the workspace Secret',
  REG_TOKEN: 'use --reg-token',
  MAIL_URL: 'the chart owns it',
  INSTANCE_IP: 'the chart sets it to the pod IP',
  DEPLOY_PLATFORM: 'the chart owns it',
  ROCKETCHAT_LICENSE: 'use --license',
  LICENSE_DEBUG: 'the chart owns it',
  OVERWRITE_SETTING_Prometheus_Enabled: 'the chart sets it (prometheusScraping)',
  OVERWRITE_SETTING_Prometheus_Port: 'the chart sets it (prometheusScraping)',
  MS_METRICS: 'the chart owns it',
  MS_METRICS_PORT: 'the chart owns it',
  DB_WATCHERS: 'the chart owns it',
  MOLECULER_LOG_LEVEL: 'the chart owns it',
  HEARTBEAT_INTERVAL: 'the chart owns it',
  HEARTBEAT_TIMEOUT: 'the chart owns it',
  RETRY_ENABLED: 'the chart owns it',
});

/** Refuse an override that would duplicate chart output or bypass a dedicated contract. */
export function refuseChartOwnedEnv(overrides: Record<string, string | null>): void {
  for (const key of Object.keys(overrides)) {
    const reason =
      CHART_OWNED_ENV[key] ?? (key.startsWith('DEPLOY_') ? 'the chart owns it' : undefined);
    if (reason === undefined) continue;
    if (key === 'ROCKETCHAT_LICENSE') {
      throw new ValidationError(
        'ROCKETCHAT_LICENSE cannot be set with --env or --setting on Kubernetes: use --license. ' +
          "It is reserved for Houston's existing licence Secret reference.",
      );
    }
    throw new ValidationError(
      `${key} cannot be set with --env or --setting on Kubernetes: ${reason}. A second ` +
        'entry for a variable the chart writes is a server-side-apply conflict, not an ' +
        'override.',
    );
  }
}

/** Resolve credential payloads in memory, before any Helm or workspace values are built. */
export function credentialInputs(
  presetEnv: Record<string, unknown> | undefined,
  regToken = '',
  license = '',
  retainedLicense = false,
  overrides: Record<string, string | null> = {},
): { regToken: string; license: string; licensed: boolean } {
  const effective = (key: string): string => {
    const value = Object.hasOwn(overrides, key) ? overrides[key] : presetEnv?.[key];
    return value === null || value === undefined ? '' : toTextYaml(value, config.yamlDateText);
  };
  // Dedicated inputs and a retained licence Secret win over preset/override literals.
  const token = regToken.trim() || effective('REG_TOKEN').trim();
  const suppliedLicense = license.trim() === '' ? '' : license;
  const presetLicense = effective('ROCKETCHAT_LICENSE');
  const payload =
    suppliedLicense || (retainedLicense || presetLicense.trim() === '' ? '' : presetLicense);
  return { regToken: token, license: payload, licensed: retainedLicense || payload !== '' };
}

/**
 * The environment the chart passes to Rocket.Chat, registration token included.
 *
 * A MAP, in the order base < preset < `overrides`, as Compose builds it: a key set twice
 * replaces the earlier value in place. Appending put a second entry for the same name in
 * `extraEnv`, which server-side apply refuses. A null override removes the key.
 */
export function chartEnv(
  adminPassword: string,
  host: string,
  presetEnv: Record<string, unknown> | undefined,
  regTokenSecret: string,
  rootUrl: string,
  overrides: Record<string, string | null> = {},
  licensed = false,
): ChartEnvEntry[] {
  // THE WORKSPACE HAS TO BE USABLE ON ARRIVAL, which is what these give and what Kubernetes
  // was missing entirely. `up` printed "Login admin / admin123" for a workspace where that
  // user had never been created and the setup wizard was still waiting.
  //
  // DEPLOY_METHOD and DEPLOY_PLATFORM are NOT here, and were, for one commit. The chart sets
  // them itself, and a second entry for the same key is not an override but a conflict:
  // "server-side apply failed ... duplicate entries for key [name=DEPLOY_PLATFORM]". So
  // anything the chart already provides must not be repeated here.
  const env: ChartEnvEntry[] = [
    { name: 'OVERWRITE_SETTING_Show_Setup_Wizard', value: 'completed' },
    { name: 'ADMIN_USERNAME', value: config.ADMIN_USERNAME },
    { name: 'ADMIN_NAME', value: config.ADMIN_NAME },
    { name: 'ADMIN_EMAIL', value: config.ADMIN_EMAIL },
    { name: 'ADMIN_PASS', value: adminPassword || config.ADMIN_PASSWORD },
    { name: 'ALLOW_UNSAFE_QUERY_AND_FIELDS_API_PARAMS', value: 'false' },
  ];
  // ROOT_URL, WHICH THIS RUNTIME HAD NEVER SET. The chart emits one only from
  // `.Values.host`, and nothing passed that -- so Rocket.Chat ran on its built-in default
  // while every human reached it on an allocated port. ROOT_URL is what absolute links,
  // OAuth callbacks and CORS derive from.
  //
  // Only when there is no `host`: with one, the chart writes ROOT_URL itself and a second
  // entry here would be a duplicate-key apply failure rather than a win.
  if (rootUrl !== '' && host === '') env.push({ name: 'ROOT_URL', value: rootUrl });
  // A scenario's Rocket.Chat settings are the SHARED half of the Scenario contract, so they
  // ride extraEnv here exactly as they ride the service environment on Compose. AFTER the
  // base list, so a preset can override a default rather than being overridden by one.
  // `toTextYaml` of the value the preset's YAML holds, as compose.ts writes it.
  const byName = new Map(env.map((entry) => [entry.name, entry]));
  for (const [key, value] of Object.entries(presetEnv ?? {})) {
    byName.set(String(key), { name: String(key), value: toTextYaml(value, config.yamlDateText) });
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) byName.delete(key);
    else byName.set(key, { name: key, value: String(value) });
  }
  // Credential literals belong only in Secret manifests sent on stdin. Direct values
  // callers without a prepared Secret fail closed instead of persisting those literals.
  byName.delete('REG_TOKEN');
  byName.delete('ROCKETCHAT_LICENSE');
  if (regTokenSecret !== '') {
    // By REFERENCE, so the token is never a value in this document. The chart renders
    // extraEnv verbatim, so valueFrom survives -- verified against the published chart.
    byName.set('REG_TOKEN', {
      name: 'REG_TOKEN',
      valueFrom: { secretKeyRef: { name: regTokenSecret, key: REG_TOKEN_KEY } },
    });
  }
  if (licensed) {
    // Replace a preset literal in the same map before serializing `extraEnv`: a second entry
    // is an apply conflict, while the dedicated Secret remains the final effective source.
    byName.set('ROCKETCHAT_LICENSE', {
      name: 'ROCKETCHAT_LICENSE',
      valueFrom: { secretKeyRef: { name: LICENSE_SECRET, key: LICENSE_KEY } },
    });
  }
  return [...byName.values()];
}

/** Refuse the two URL shapes the chart cannot render safely. */
export function validateRootAddress(rootUrl: string, host: string): void {
  // REFUSED, not normalised. A caller that hands a URL where a hostname belongs has a bug,
  // and quietly stripping the scheme would hide it -- the whole point of this guard is that
  // `https://http://...` was shippable once. `:` catches a port, which the chart would
  // concatenate just as happily.
  if (host !== '' && (host.includes('/') || host.includes(':'))) {
    throw new ValidationError(
      `chart value \`host\` must be a bare hostname, not '${host}' — the chart renders it ` +
        'as `ROOT_URL: https://{host}` and as the Ingress rule host, so a scheme or a port ' +
        'corrupts both. Pass a full URL as `root_url` instead.',
    );
  }
  if (host !== '' && rootUrl !== '') {
    throw new ValidationError(
      'pass `host` or `root_url`, never both: `host` makes the chart emit its own ROOT_URL ' +
        'and `root_url` puts one in extraEnv, and two entries for the same variable is a ' +
        'server-side-apply conflict, not an override.',
    );
  }
}

/** Values shared by every Rocket.Chat chart deployment. */
function baseChartValues(
  repo: string,
  tag: string,
  microservices: boolean,
  replicas: number,
  env: ChartEnvEntry[],
): Record<string, unknown> {
  // A CI BUILD moves under the same tag, so it is pulled every time, and its microservice
  // images live beside it on ghcr (Docker Hub has releases only). stream-hub is not built
  // for pull requests or FIPS (measured), so it stays off.
  const build = repo === BUILD_IMAGE;
  const ghcr = (service: string) => ({
    image: { repository: `ghcr.io/rocketchat/${service}`, pullPolicy: 'Always' },
  });
  return {
    // pullPolicy and the NATS cluster name are the guide's own values.yaml. IfNotPresent
    // also matters here specifically: a repro box re-creates workspaces on the same
    // versions constantly, and Always would re-pull 1.6 GB each time.
    image: { repository: repo, tag, pullPolicy: build ? 'Always' : 'IfNotPresent' },
    // `enabled` FOLLOWS microservices, because NATS is what the microservices talk over and
    // a monolith never opens a connection to it. The chart defaults it on independently, so
    // `--deployment monolith` ran a 3-pod NATS cluster that nothing used -- three more pods
    // to schedule, to wait for, and to tear down.
    nats: { enabled: microservices, cluster: { name: 'rocketchat-nats-cluster' } },
    replicaCount: Math.max(1, Math.trunc(replicas) || 1),
    microservices: build
      ? {
          enabled: microservices,
          presence: ghcr('presence-service'),
          ddpStreamer: ghcr('ddp-streamer-service'),
          account: ghcr('account-service'),
          authorization: ghcr('authorization-service'),
          streamHub: { enabled: false },
        }
      : { enabled: microservices },
    mongodb: { enabled: false },
    extraEnv: env,
  };
}

/** The parts of the values file that only appear when something asked for them. */
function applyOptionalValues(
  host: string,
  mongoSecret: string,
  mongoUrl: string,
  oplog: boolean,
  oplogUrl: string,
  values: Record<string, unknown>,
): void {
  if (mongoSecret !== '') {
    // The URL goes in a Secret and its NAME goes in the values, so `helm get values
    // rocketchat` no longer prints the password to anyone who can read the release.
    values.existingMongodbSecret = mongoSecret;
  } else {
    values.externalMongodbUrl = mongoUrl || MONGO_URL;
    // Rocket.Chat below 8.x still wants the oplog URL; 8.x deprecates it.
    if (oplog) values.externalMongodbOplogUrl = oplogUrl || MONGO_OPLOG_URL;
  }
  // The chart's own `host:` -- the Ingress rule host AND the source of its ROOT_URL. A bare
  // hostname, guarded by `validateRootAddress`.
  if (host !== '') values.host = host;
  // THE CHART SETS SOME OF THESE ITSELF, CONDITIONALLY, and a second entry for one env key
  // is not an override -- it is a server-side-apply failure. Chart 7.0.2 emits the wizard
  // key under `{{- if .Values.license }}` and REG_TOKEN under a registrationToken guard.
  // Nothing sets `license` today, so this is latent rather than broken -- which is exactly
  // when it is cheap to fix.
  for (const [valueKey, envName] of Object.entries(CHART_CONDITIONAL_ENV)) {
    const present = values[valueKey];
    if (present !== undefined && present !== null && present !== '' && present !== false) {
      values.extraEnv = (values.extraEnv as ChartEnvEntry[]).filter(
        (entry) => entry.name !== envName,
      );
    }
  }
}

export interface ValuesOptions {
  rcVersion: string;
  rcImage: string;
  microservices: boolean;
  replicas?: number;
  rootUrl?: string;
  host?: string;
  oplog?: boolean;
  mongoUrl?: string;
  oplogUrl?: string;
  mongoSecret?: string;
  regTokenSecret?: string;
  adminPassword?: string;
  presetEnv?: Record<string, unknown>;
  /** `up --env`/`--setting`, carried forward; merged last, a null removes the key. */
  envOverrides?: Record<string, string | null>;
  /** Whether the namespace holds the `houston-license` Secret to reference. */
  licensed?: boolean;
}

/**
 * Chart values for one workspace.
 *
 * `rootUrl` and `host` are TWO DIFFERENT SHAPES and only one may be given. `host` is a BARE
 * HOSTNAME, because that is what the chart's own values.yaml documents and what its template
 * does with it -- `value: https://{{ .Values.host }}`. So the chart CONCATENATES. An earlier
 * version assigned a full URL to `host`, which rendered `ROOT_URL =
 * https://http://localhost:32812`, verified by `helm template` against chart 7.0.2. It never
 * fired only because nothing passed it -- and that was its own defect: with `.Values.host`
 * unset the chart emits NO ROOT_URL at all.
 *
 * MongoDB is ALWAYS external, never the chart's bundled subchart: the bundled path is
 * Bitnami, which publishes amd64-only images so it cannot work on arm64 at all, and chart
 * 7.0.2 declares appVersion 8.6.1 while defaulting MongoDB to 6.0.10, which Rocket.Chat
 * 8.6.1 rejects outright.
 */
export function valuesFor({
  rcVersion,
  rcImage,
  microservices,
  replicas = 1,
  rootUrl = '',
  host = '',
  oplog = false,
  mongoUrl = '',
  oplogUrl = '',
  mongoSecret = '',
  regTokenSecret = '',
  adminPassword = '',
  presetEnv,
  envOverrides = {},
  licensed = false,
}: ValuesOptions): Record<string, unknown> {
  validateRootAddress(rootUrl, host);
  const [repo, tag] = splitImage(rcImage, rcVersion);
  const env = chartEnv(
    adminPassword,
    host,
    presetEnv,
    regTokenSecret,
    rootUrl,
    envOverrides,
    licensed,
  );
  const values = baseChartValues(repo, tag, microservices, replicas, env);
  applyOptionalValues(host, mongoSecret, mongoUrl, oplog, oplogUrl, values);
  return values;
}
