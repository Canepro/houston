/**
 * Post-ready preset self-configuration, moved out of the CLI so both front ends run it
 * identically. Each handler reports via `emit` instead of printing.
 *
 * Behaviour is unchanged from the CLI's former post-ready handlers; only the output
 * mechanism differs (Event objects rather than printed lines and warnings).
 *
 * Every handler returns a BOOLEAN, and `runPostReady` collects the ones that answered
 * false. That is the whole point of the module's shape: a create that printed "could not
 * fetch/apply IdP cert" and then "starting" left the reader to work out for themselves
 * whether SAML actually worked -- the deployment succeeding and the configuration
 * succeeding are different answers to different questions.
 */
import * as config from '../lib/config';
import { quotedText } from '../lib/format';
import { type Emit, info, warn } from '../lib/events';

import { kube } from './kube/exec';
import { APPLY_TIMEOUT, CONTEXT, isOurs } from './kube/names';
import { namespaceFor } from './kube/namespace';
import * as rcapi from './rcapi';
import { composeExec } from './runner/engine';
import { adminPass, type Metadata } from './runner/record';
import * as topology from './topology';

/**
 * How long to wait for Keycloak to serve its SAML descriptor.
 *
 * Passed INTO `fetchSamlIdpCert`, which owns the retrying -- not layered on top of it.
 * Generous because on Kubernetes the image is pulled before the realm is imported.
 */
export const IDP_CERT_DEADLINE = 180.0;

/** One entry of a preset's `post_ready` list, as it is read back out of `repro.json`. */
export type Action = Record<string, unknown>;

/**
 * The sleep is an injected function with a real default, so a spec can replace it. The
 * production call sites pass nothing.
 */
export type Sleep = (seconds: number) => Promise<void>;

const realSleep: Sleep = (seconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });

export interface Options {
  readonly sleep?: Sleep;
}

/** Truthiness: false for null, undefined, false, 0, '', [] and {}. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * `meta.extra` when it is a mapping, else `{}`.
 *
 * The declared type says this cannot fail, and the declared type is optimistic: `extra`
 * is copied verbatim out of `repro.json` by `record.fromDocument`, so a hand-edited or
 * half-written record can hold a list, a string or null there and still satisfy the
 * compiler. Routed through `unknown` so the check is against what is on disk rather than
 * against what the annotation claims.
 */
function bagOf(value: Record<string, unknown>): Record<string, unknown> {
  const raw: unknown = value;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/**
 * `action["key"]` -- absent raises, rather than quietly becoming the string "undefined".
 *
 * A preset that names a `post_ready` action without the fields that action needs is a
 * broken preset, and it has always been refused, naming the key. Coercing the missing value
 * instead would PATCH a Rocket.Chat setting to the literal text `undefined` and report
 * success.
 */
function required(action: Action, key: string): unknown {
  if (!(key in action)) throw new Error(`a post_ready action is missing ${JSON.stringify(key)}`);
  return action[key];
}

/** The key's value, or `fallback` -- keyed on PRESENCE, so an explicit falsy value survives. */
function getOr(action: Action, key: string, fallback: unknown): unknown {
  return key in action ? action[key] : fallback;
}

/** An integer: a number truncated toward zero, a boolean as 1 or 0, text as signed digits. */
function toInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`${String(value)} is not an integer`);
    return Math.trunc(value);
  }
  const text = String(value ?? '').trim();
  if (!/^[+-]?\d+$/u.test(text)) {
    throw new RangeError(`'${text}' is not an integer`);
  }
  return Number.parseInt(text, 10);
}

/**
 * `quotedText(meta.preset)` in the summary below. Re-exported rather than re-implemented: the
 * quoting rule is the established one and there is one place here that spells it.
 */
export { quotedText };

/**
 * Run a command in a preset's side service, on either runtime.
 *
 * A post_ready action is a preset configuring ITSELF, and presets now exist on both
 * runtimes -- so the one call that reaches into a container had to stop being a Compose
 * call. `composeExec` on a Kubernetes workspace answers "no configuration file provided:
 * not found" -- docker compose's own words for "there is no compose project here" --
 * printed raw, in the middle of a create that then said it succeeded.
 */
export async function execIn(
  meta: Metadata,
  service: string,
  argv: readonly string[],
): Promise<number | null> {
  if (topology.ofMeta(meta) !== topology.KUBERNETES) {
    return await composeExec(meta.name, service, argv);
  }
  const extra = bagOf(meta.extra);
  const ctxValue = extra[config.EXTRA_CONTEXT];
  const context = String(truthy(ctxValue) ? ctxValue : CONTEXT);
  const nsValue = extra.namespace;
  // Asked only when none is recorded: asking kubectl to mint the namespace name for a
  // workspace that already recorded one is a subprocess spent on an answer that was
  // already on disk.
  const namespace = String(truthy(nsValue) ? nsValue : await namespaceFor(meta.name));
  const pod = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      namespace,
      'get',
      'pod',
      '-l',
      `app=houston-${service}`,
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ],
    { own: isOurs(context) },
  );
  const target = (pod.stdout || '').trim();
  if (!target) return 1;
  const res = await kube.run(
    ['kubectl', '--context', context, '-n', namespace, 'exec', target, '--', ...argv],
    { timeout: APPLY_TIMEOUT, own: isOurs(context) },
  );
  return res.returncode;
}

async function prSamlIdpCert(
  meta: Metadata,
  auth: rcapi.Auth,
  action: Action,
  emit: Emit,
  sleep: Sleep,
): Promise<boolean> {
  info(emit, 'fetching IdP cert (Keycloak first boot can take ~30s)...', { phase: 'post_ready' });
  // ONE call. `fetchSamlIdpCert` already retries to its own deadline -- its docstring says
  // "Retries until the IdP (e.g. Keycloak, which boots slowly) is serving" -- and v0.54.1
  // wrapped it in a second 20-attempt loop without reading that. 20 x 90s is thirty
  // minutes of a create that looks hung, which is how the operational audit found it: the
  // SAML workspace sat in "still waiting for the IdP to serve its descriptor" for half an
  // hour.
  //
  // The deadline is raised instead, and only here: Keycloak on Kubernetes has to pull its
  // image before it can boot, which the Compose default did not allow for.
  const cert = await rcapi.fetchSamlIdpCert(String(required(action, 'descriptor_url')), {
    timeout: IDP_CERT_DEADLINE,
  });
  if (
    truthy(cert) &&
    (await rcapi.setSetting(
      meta.rootUrl,
      auth,
      adminPass(meta),
      String(required(action, 'setting')),
      cert,
    ))
  ) {
    const enable = action.enable_setting;
    if (truthy(enable)) {
      await rcapi.setSetting(meta.rootUrl, auth, adminPass(meta), String(enable), false);
      await sleep(1);
      await rcapi.setSetting(meta.rootUrl, auth, adminPass(meta), String(enable), true);
    }
    info(emit, 'IdP cert applied; SAML login button registered.', { phase: 'post_ready' });
    return true;
  }
  warn(emit, 'could not fetch/apply IdP cert (is the IdP up?)', { phase: 'post_ready' });
  return false;
}

async function prKeycloakMasterSslOff(
  meta: Metadata,
  _auth: rcapi.Auth,
  action: Action,
  emit: Emit,
  _sleep: Sleep,
): Promise<boolean> {
  const svc = String(getOr(action, 'service', 'keycloak'));
  const port = getOr(action, 'port', 8080);
  const kcadm = '/opt/keycloak/bin/kcadm.sh';
  const script =
    `${kcadm} config credentials --server http://localhost:${String(port)} ` +
    `--realm master --user admin --password admin >/dev/null && ` +
    `${kcadm} update realms/master -s sslRequired=NONE`;
  // Through whichever runtime owns this workspace -- see `execIn`.
  if ((await execIn(meta, svc, ['bash', '-lc', script])) === 0) {
    info(emit, 'Keycloak admin console enabled over HTTP.', { phase: 'post_ready' });
    return true;
  }
  warn(
    emit,
    'could not relax Keycloak master-realm sslRequired ' +
      '(is Keycloak up yet?) - the admin console may reject HTTP',
    { phase: 'post_ready' },
  );
  return false;
}

/** Apply each setting; return the ids that did not take. */
async function applySettings(
  meta: Metadata,
  auth: rcapi.Auth,
  settings: Record<string, unknown>,
): Promise<string[]> {
  const failed: string[] = [];
  for (const [sid, val] of Object.entries(settings)) {
    if (!(await rcapi.setSetting(meta.rootUrl, auth, adminPass(meta), sid, val))) failed.push(sid);
  }
  return failed;
}

/**
 * Create RC's Custom OAuth provider, then CONFIGURE it -- and report either.
 *
 * Both halves used to be unreportable. The handler returned nothing on every path, and
 * `runPostReady` collects a failure only on an explicit false, so the oidc preset's one
 * self-config action could not appear in the "only partly configured" summary that exists
 * precisely for this -- the warning printed, the summary said nothing, and `up` exited 0.
 *
 * Worse, every `setSetting` result was discarded. `addOauthService` creating the provider
 * is not the same as the provider being usable: the settings carry the realm URL, the
 * client id and the secret, and a provider created WITHOUT them renders a login button
 * that points nowhere. That is the failure a support engineer sees as "I click the OIDC
 * button and the page is blank" -- the button is real, the endpoint behind it is empty,
 * and nothing in the create said so.
 */
async function prCreateOauthProvider(
  meta: Metadata,
  auth: rcapi.Auth,
  action: Action,
  emit: Emit,
  sleep: Sleep,
): Promise<boolean> {
  if (
    !(await rcapi.addOauthService(
      meta.rootUrl,
      auth,
      adminPass(meta),
      String(required(action, 'name')),
    ))
  ) {
    warn(emit, 'could not create the OAuth provider', { phase: 'post_ready' });
    return false;
  }
  const settings = { ...(required(action, 'settings') as Record<string, unknown>) };
  // The provider's settings are created BY the method above, and RC's settings are cached
  // -- so the first PATCH can land before the id exists. Retried rather than slept past: a
  // fixed sleep is either too short on a loaded box or wasted on a fast one, and this is
  // the window in which a wrong answer looks like success.
  let failed = await applySettings(meta, auth, settings);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (failed.length === 0) break;
    await sleep(2);
    const subset: Record<string, unknown> = {};
    for (const key of failed) subset[key] = settings[key];
    failed = await applySettings(meta, auth, subset);
  }
  if (failed.length > 0) {
    const named = [...failed].sort().slice(0, 4).join(', ');
    warn(
      emit,
      `the OAuth provider exists but ${failed.length} of its ` +
        `${Object.keys(settings).length} settings did not apply: ` +
        `${named}${failed.length > 4 ? '…' : ''}. Its login button will render ` +
        `and lead nowhere.`,
      { phase: 'post_ready' },
    );
    return false;
  }
  info(emit, 'OIDC provider created and configured; login button registered.', {
    phase: 'post_ready',
  });
  return true;
}

async function prLivechatSetup(
  meta: Metadata,
  auth: rcapi.Auth,
  action: Action,
  emit: Emit,
  _sleep: Sleep,
): Promise<boolean> {
  const url = meta.rootUrl;
  const pw = adminPass(meta);
  const agents: { agentId: string; username: string }[] = [
    { agentId: auth.userId, username: config.ADMIN_USERNAME },
  ];
  await rcapi.addLivechatAgent(url, auth, pw, config.ADMIN_USERNAME);
  const wanted = toInt(getOr(action, 'agents', 1));
  for (let i = 2; i <= wanted; i += 1) {
    const u = `agent${String(i)}`;
    await rcapi.createUser(url, auth, pw, u);
    await rcapi.addLivechatAgent(url, auth, pw, u);
    const uid = await rcapi.getUserId(url, auth, u);
    if (truthy(uid)) agents.push({ agentId: String(uid), username: u });
  }
  const available = await rcapi.setLivechatAvailable(url, auth, pw);

  const dept = action.department;
  let deptOk = false;
  if (truthy(dept)) {
    const deptId = await rcapi.ensureLivechatDepartment(url, auth, pw, String(dept));
    if (truthy(deptId)) {
      deptOk = await rcapi.assignLivechatAgents(url, auth, pw, String(deptId), agents);
    }
  }

  const canned = await rcapi.saveCannedResponse(
    url,
    auth,
    pw,
    'hello',
    'Hi! Thanks for reaching out - how can I help?',
  );
  if (!canned) {
    info(
      emit,
      '(canned responses & business hours are Enterprise features - pass ' +
        '--reg-token to enable, else set them up manually)',
      { phase: 'post_ready' },
    );
  }
  // REPORTED, like every other handler. This returned nothing on both paths, so a livechat
  // workspace whose agent could not be made available printed a warning and was still
  // counted as fully configured -- the same hole the oidc action had. `canned` is
  // deliberately NOT part of the verdict: it fails on a workspace with no licence, which
  // is the normal case and not a fault.
  if (!available) {
    warn(emit, 'set up the Omnichannel agent manually (Admin -> Omnichannel -> Agents)', {
      phase: 'post_ready',
    });
    return false;
  }
  let summary = `Omnichannel: ${agents.length} agent(s) available`;
  if (deptOk) summary += `, '${String(dept)}' department created + assigned`;
  info(emit, `${summary} - log into RC to go online.`, { phase: 'post_ready' });
  return true;
}

export type Handler = (
  meta: Metadata,
  auth: rcapi.Auth,
  action: Action,
  emit: Emit,
  sleep: Sleep,
) => Promise<boolean>;

/**
 * The action name a preset writes -> the handler that runs it.
 *
 * MUTABLE on purpose: a spec swaps entries in and out to drive `runPostReady` without
 * standing up four RC stubs, and reloads the table afterwards.
 * `resetActions` is the reload.
 */
export const POST_READY_ACTIONS: Record<string, Handler> = {
  saml_idp_cert: prSamlIdpCert,
  keycloak_master_ssl_off: prKeycloakMasterSslOff,
  create_oauth_provider: prCreateOauthProvider,
  livechat_setup: prLivechatSetup,
};

const BUILTIN_ACTIONS: Readonly<Record<string, Handler>> = Object.freeze({
  ...POST_READY_ACTIONS,
});

/** Put the table back the way it shipped. */
export function resetActions(): void {
  for (const key of Object.keys(POST_READY_ACTIONS)) delete POST_READY_ACTIONS[key];
  Object.assign(POST_READY_ACTIONS, BUILTIN_ACTIONS);
}

/**
 * Run a workspace's preset self-configuration. Returns the actions that did NOT complete.
 *
 * `null` when there was no admin session to run them with -- nothing ran, which is a
 * different answer from "they all succeeded".
 */
export async function runPostReady(
  meta: Metadata,
  auth: rcapi.Auth | null | undefined,
  emit: Emit,
  { sleep = realSleep }: Options = {},
): Promise<string[] | null> {
  const extra = bagOf(meta.extra);
  const raw = extra.post_ready;
  const actions: Action[] = Array.isArray(raw) ? (raw as Action[]) : [];
  if (auth === null || auth === undefined) {
    if (actions.length > 0) {
      warn(
        emit,
        'preset self-config skipped - could not log in as admin; ' +
          `re-run once reachable: houston ready --name ${meta.name}`,
        { phase: 'post_ready' },
      );
    }
    return null;
  }
  // COLLECTED, not just warned past. A create that printed "could not fetch/apply IdP
  // cert" and then "starting" left the reader to work out for themselves whether SAML
  // actually worked -- the deployment succeeded and the CONFIGURATION did not, and those
  // are different answers to different questions.
  const failed: string[] = [];
  for (const action of actions) {
    const name = action.action;
    const handler = truthy(name) ? POST_READY_ACTIONS[String(name)] : undefined;
    if (handler === undefined) continue;
    if ((await handler(meta, auth, action, emit, sleep)) === false) failed.push(String(name));
  }
  if (failed.length > 0) {
    warn(
      emit,
      `the workspace is RUNNING but its ${quotedText(meta.preset)} preset is only ` +
        `partly configured — these did not complete: ${failed.join(', ')}`,
      { phase: 'post_ready' },
    );
    warn(
      emit,
      `    Rocket.Chat itself is fine. Re-run the preset's ` +
        `self-configuration with: houston ready --name ${meta.name}`,
      { phase: 'post_ready' },
    );
  }
  return failed;
}
