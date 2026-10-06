/** Workspace inspection and lifecycle operations. */

import { performance } from 'node:perf_hooks';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import * as audit from '../../core/audit';
import { login } from '../../core/lifecycle/admin';
import { createRepro } from '../../core/lifecycle/create-docker';
import { teardown } from '../../core/lifecycle/destroy';
import { describe, listRepros } from '../../core/lifecycle/inspect';
import { deriveFor, resolveName } from '../../core/lifecycle/naming';
import { maySetPrivilegedFields, setOwner } from '../../core/lifecycle/ownership';
import { detail } from '../../core/lifecycle/payload';
import {
  checkStateRequest,
  checkTeardownRequest,
  requireEngine,
} from '../../core/lifecycle/preconditions';
import { prune } from '../../core/lifecycle/pruning';
import { waitAndFinalize } from '../../core/lifecycle/ready';
import { setState } from '../../core/lifecycle/state';
import { createReq, PRIVILEGED_CREATE_FIELDS } from '../../core/lifecycle/types';
import * as monitor from '../../core/monitor';
import { containerIds } from '../../core/runner/engine';
import { updateConfig as updateLockedConfig } from '../../core/runner/locks';
import { dockerStats } from '../../core/runner/queries';
import { adminPass, readMeta } from '../../core/runner/record';
import * as topology from '../../core/topology';
import * as config from '../../lib/config';
import { NotReadyError, ValidationError, errorText } from '../../lib/errors';
import { joinPath } from '../../lib/home';
import { quotedText, toTextAny, stripText, isTruthy } from '../../lib/format';
import { userPath } from '../../lib/presets';
import {
  actor,
  bag,
  bool,
  kubeContext,
  oneDecimal,
  orText,
  queryBool,
  requestBody,
  strings,
  submit,
} from '../route-deps';
import type * as EnvvarsNS from '../../core/envvars';
import type * as KubeContextNS from '../../core/kube/context';
import type * as KubeStatusNS from '../../core/kube/status';
import type * as RcapiNS from '../../core/rcapi';
import type * as TlsNS from '../../core/tls';
import type * as ResourcesNS from '../../perf/resources';

function envvarsModule(): typeof EnvvarsNS {
  return require('../../core/envvars') as typeof EnvvarsNS;
}

function kubeModules(): {
  context: typeof KubeContextNS;
  status: typeof KubeStatusNS;
} {
  return {
    context: require('../../core/kube/context') as typeof KubeContextNS,
    status: require('../../core/kube/status') as typeof KubeStatusNS,
  };
}

function rcapiModule(): typeof RcapiNS {
  return require('../../core/rcapi') as typeof RcapiNS;
}

function resourcesModule(): typeof ResourcesNS {
  return require('../../perf/resources') as typeof ResourcesNS;
}

function tlsModule(): typeof TlsNS {
  return require('../../core/tls') as typeof TlsNS;
}

const API_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

function createRequest(request: FastifyRequest) {
  const body = requestBody(request.body, true);
  const version = stripText(isTruthy(body.version) ? toTextAny(body.version) : '');
  if (version === '') throw new ValidationError('`version` is required, e.g. {"version": "8.5.1"}');
  const fields: Record<string, unknown> = { actor: actor(request) };
  const names: Readonly<Record<string, string>> = {
    version: 'version',
    preset: 'preset',
    name: 'name',
    port: 'port',
    root_url: 'rootUrl',
    bind: 'bind',
    rc_image: 'rcImage',
    mongo: 'mongo',
    reg_token: 'regToken',
    params: 'params',
    seed: 'seed',
    seed_here: 'seedHere',
    seed_profile: 'seedProfile',
    pin: 'pin',
    wait: 'wait',
    offline: 'offline',
    no_pull: 'noPull',
    fresh: 'fresh',
    force: 'force',
    monitor: 'monitor',
    stats: 'stats',
    runtime: 'runtime',
    deployment: 'deployment',
    replicas: 'replicas',
    context: 'context',
    mongo_operator: 'mongoOperator',
    https: 'https',
    domain: 'domain',
    acme_email: 'acmeEmail',
    acme_staging: 'acmeStaging',
    acme_challenge: 'acmeChallenge',
    acme_dns_provider: 'acmeDnsProvider',
    ingress_class: 'ingressClass',
    env: 'env',
    bind_public: 'bindPublic',
  };
  for (const [wire, internal] of Object.entries(names)) {
    if (Object.hasOwn(body, wire)) fields[internal] = body[wire];
  }
  return createReq(fields as unknown as Parameters<typeof createReq>[0]);
}

async function statsOf(name: string): Promise<{ cpu: number; mem_mb: number }> {
  const target = await resolveName(name);
  if ((await topology.ofRepro(target)) === topology.KUBERNETES) {
    const kube = kubeModules();
    const meta = await readMeta(target);
    const rows = await kube.status.podMetrics(target, {
      context: kubeContext(meta.extra),
    });
    return {
      cpu: oneDecimal(rows.reduce((sum, row) => sum + row.cpu_millicores, 0) / 10),
      mem_mb: oneDecimal(rows.reduce((sum, row) => sum + row.mem_bytes, 0) / 1e6),
    };
  }
  const ids = await containerIds(target);
  const resources = resourcesModule();
  const prefix = `${config.PROJECT_PREFIX}${target}-`;
  let cpu = 0;
  let memory = 0;
  for (const line of (await dockerStats(ids)).split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const full = parts[0] ?? '';
    const service = full.startsWith(prefix) ? full.slice(prefix.length) : full;
    if (service === 'rocketchat' || service.startsWith('rocketchat-')) {
      cpu += resources.parseCpu(parts[1] ?? '');
      memory += resources.parseMem(parts[2] ?? '')[0];
    }
  }
  return { cpu: oneDecimal(cpu), mem_mb: oneDecimal(memory / 1e6) };
}

export function register(app: FastifyInstance): void {
  app.get('/api/repros', async () => ({ repros: await listRepros() }));
  app.get<{ Params: { name: string } }>(
    '/api/repros/:name',
    async (request) => await describe(request.params.name),
  );
  app.get<{ Params: { name: string } }>(
    '/api/repros/:name/detail',
    async (request) => await detail(request.params.name),
  );
  app.get<{ Params: { name: string } }>(
    '/api/repros/:name/stats',
    async (request) => await statsOf(request.params.name),
  );

  app.post('/api/repros', async (request) => {
    const req = createRequest(request);
    const privileged = PRIVILEGED_CREATE_FIELDS.filter((field) => {
      const keys: Record<string, keyof typeof req> = {
        rc_image: 'rcImage',
        reg_token: 'regToken',
        bind: 'bind',
        context: 'context',
      };
      return isTruthy(req[keys[field] as keyof typeof req]);
    });
    if (privileged.length > 0 && !maySetPrivilegedFields(actor(request))) {
      const extra = privileged.includes('bind')
        ? '  For a workspace everyone on this box should reach, `houston config set bind_host 0.0.0.0` sets it once for the box.'
        : '';
      throw new ValidationError(
        `${privileged.join(', ')} is limited to admins on this box (\`gui.create_policy admin\`) — ` +
          'they decide what code runs and where it listens. An admin can widen it again with ' +
          '`houston config set gui.create_policy anyone`.' +
          extra,
      );
    }
    if (isTruthy(req.context)) {
      const [known] = await kubeModules().context.contexts();
      if (known.length > 0 && !known.includes(req.context)) {
        throw new ValidationError(
          `no kubeconfig context named ${quotedText(req.context)} on this server. It can see: ` +
            known.map(quotedText).join(', '),
        );
      }
    }
    if (isTruthy(req.preset)) {
      try {
        userPath(req.preset);
      } catch (error) {
        throw new ValidationError(errorText(error));
      }
    }
    // The release lookup is the JOB's, inside `createRepro` where the pairing is resolved:
    // the request holding a response open for it answered nothing the job does not answer
    // again.
    return submit(
      app,
      'create',
      (emit) =>
        createRepro(req, emit, {
          streamOutput: true,
          monitorAttach: monitor.attach,
        }),
      // A typed name is labelled -- and so audited -- as the workspace it makes: with
      // accounts `gui-1` becomes `alice-gui-1`, and the audit said `create gui-1`, a name
      // nothing on the box answers to. The same function the create uses. A derived name
      // waits on the version lookup, so that label stays the version asked for, and a name
      // that is not a string keeps the label earlier releases gave it.
      {
        label:
          typeof req.name === 'string' && isTruthy(req.name)
            ? deriveFor(req)
            : ((isTruthy(req.name) ? req.name : req.version) as string),
      },
    );
  });

  app.post<{ Params: { name: string } }>('/api/repros/:name/state', async (request) => {
    const action = requestBody(request.body, true).action;
    const target = await checkStateRequest(request.params.name, action);
    return submit(app, 'state', (emit) => setState(target, action, emit), { label: target });
  });

  app.post<{ Params: { name: string } }>('/api/repros/:name/up', async (request) => {
    const target = await resolveName(request.params.name);
    const meta = await readMeta(target);
    const req = createReq({
      version: meta.rcVersion,
      name: target,
      wait: true,
      offline: true,
      ...(topology.axesOfMeta(meta) as Partial<ReturnType<typeof createReq>>),
    });
    return submit(app, 'up', (emit) => createRepro(req, emit, { streamOutput: true }), {
      label: target,
    });
  });

  app.post<{ Params: { name: string } }>('/api/repros/:name/ready', async (request) => {
    const meta = await readMeta(await resolveName(request.params.name));
    return submit(app, 'ready', (emit) => waitAndFinalize(meta, emit), { label: meta.name });
  });

  app.post<{ Params: { name: string } }>('/api/repros/:name/default', async (request) => {
    const target = await resolveName(request.params.name);
    await updateLockedConfig((cfg) => {
      cfg.default_repro = target;
    });
    return { ok: true, default: target };
  });

  app.post<{ Params: { name: string } }>('/api/repros/:name/pat', async (request) => {
    const rcapi = rcapiModule();
    const body = requestBody(request.body, false);
    const target = await resolveName(request.params.name);
    await requireEngine(target);
    const meta = await readMeta(target);
    const label = orText(body.label, 'houston');
    const bypass2fa = body.bypass_2fa === undefined || bool(body.bypass_2fa);
    try {
      const auth = await login(meta);
      const token = await rcapi.generatePat(meta.rootUrl, auth, adminPass(meta), {
        tokenName: label,
        bypass2fa,
        workspace: meta.name,
      });
      if (token === '')
        throw new NotReadyError('Rocket.Chat did not return a token (is it ready?)');
      return {
        token,
        user_id: auth.userId,
        label,
        bypass_2fa: bypass2fa,
        root_url: meta.rootUrl,
      };
    } catch (error) {
      if (error instanceof NotReadyError) throw error;
      throw new NotReadyError(
        `could not create a token (is it ready? \`houston ready -n ${meta.name}\`): ${errorText(error)}`,
      );
    }
  });

  app.get<{ Params: { name: string } }>(
    '/api/repros/:name/env',
    async (request) => await envvarsModule().current(request.params.name),
  );

  app.post<{ Params: { name: string } }>('/api/repros/:name/env', async (request) => {
    const envvars = envvarsModule();
    const body = requestBody(request.body, true);
    const target = await resolveName(request.params.name);
    const rawSets = isTruthy(body.set) ? body.set : {};
    const rawSettings = isTruthy(body.setting) ? body.setting : {};
    if (typeof rawSets !== 'object' || Array.isArray(rawSets)) {
      throw new ValidationError('`set` must be an object of KEY: VALUE');
    }
    if (typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
      throw new ValidationError('`setting` must be an object of SettingId: VALUE');
    }
    const rawUnset = isTruthy(body.unset) ? body.unset : [];
    if (!Array.isArray(rawUnset)) {
      throw new ValidationError('`unset` must be a list of key names');
    }
    const sets = {
      ...(rawSets as Record<string, string>),
      ...envvars.prefixSettings(rawSettings as Record<string, unknown>),
    } as Record<string, string>;
    const unset = strings(rawUnset);
    return submit(
      app,
      'env',
      (emit) =>
        envvars.setEnv(target, sets, unset, {
          restart: body.restart === undefined || bool(body.restart),
          emit,
        }),
      { label: target },
    );
  });

  app.get<{ Params: { name: string } }>('/api/repros/:name/tls', async (request) => {
    const tls = tlsModule();
    const meta = await readMeta(await resolveName(request.params.name));
    if (!isTruthy(meta.publicUrl))
      throw new ValidationError(`${quotedText(meta.name)} was not created with --https`);
    const extra = bag(meta.extra);
    const mode = orText(extra.tls);
    const host = (meta.publicUrl.split('://', 2)[1] ?? '').split(':', 1)[0] ?? '';
    const rawPorts = Array.isArray(extra.tls_ports) ? extra.tls_ports : [443];
    const port = Number(rawPorts[0] ?? 443);
    const cafile = mode === tls.MODE_LOCAL ? joinPath(tls.caDir(), tls.CA_CRT) : '';
    const report =
      orText(extra.tls_terminates) === 'cluster'
        ? await tls.verify(host, { port, cafile })
        : await tls.verify('127.0.0.1', { port, cafile, sni: host });
    const out: Record<string, unknown> = {
      ...report,
      mode,
      public_url: meta.publicUrl,
      name: meta.name,
    };
    if (mode === tls.MODE_ACME) {
      const publicReport = await tls.verify(host);
      out.public_issuer = publicReport.issuer;
      out.public_error = publicReport.error;
    }
    return out;
  });

  app.post<{ Params: { name: string } }>('/api/repros/:name/call', async (request) => {
    const rcapi = rcapiModule();
    const body = requestBody(request.body, true);
    const target = await resolveName(request.params.name);
    await requireEngine(target);
    const meta = await readMeta(target);
    const method = orText(body.method, 'GET').toUpperCase();
    if (!API_METHODS.includes(method as (typeof API_METHODS)[number])) {
      throw new ValidationError(
        `unsupported method ${quotedText(method)} (use ${API_METHODS.join(', ')})`,
      );
    }
    const apiPath = stripText(orText(body.path));
    if (apiPath === '') throw new ValidationError('no API path given, e.g. /api/v1/me');
    const raw = stripText(orText(body.data));
    let payload: unknown;
    try {
      const parsed = raw === '' ? undefined : JSON.parse(raw);
      payload = parsed === null ? undefined : parsed;
    } catch (error) {
      throw new ValidationError(`request body is not valid JSON: ${errorText(error)}`);
    }
    const usePat = bool(body.pat);
    const twoFa = bool(body.two_fa);
    let auth;
    try {
      auth = await login(meta);
      if (usePat) {
        auth = {
          token: await rcapi.generatePat(meta.rootUrl, auth, adminPass(meta), {
            bypass2fa: true,
            workspace: meta.name,
          }),
          userId: auth.userId,
        };
      }
    } catch (error) {
      throw new NotReadyError(
        `could not authenticate (is it ready? \`houston ready -n ${meta.name}\`): ${errorText(error)}`,
      );
    }
    audit.record('api-call', `${meta.name} ${method} ${apiPath}`);
    const extraHeaders = twoFa ? await rcapi.password2faHeaders(adminPass(meta)) : undefined;
    const started = performance.now();
    let result: [number, string];
    try {
      result = await rcapi.call(meta.rootUrl, method, apiPath, {
        auth,
        ...(payload === undefined ? {} : { data: payload }),
        ...(extraHeaders === undefined ? {} : { extraHeaders }),
      });
    } catch (error) {
      if (!(error instanceof rcapi.RequestFailed)) throw error;
      throw new NotReadyError(`request failed: ${errorText(error)}`);
    }
    return {
      status: result[0],
      text: result[1],
      tag: `${usePat ? 'PAT' : 'admin'}${twoFa ? '+2fa' : ''}`,
      elapsed_ms: oneDecimal(performance.now() - started),
      url: `${meta.rootUrl.replace(/\/+$/u, '')}/${apiPath.replace(/^\/+/, '')}`,
    };
  });

  app.post<{ Params: { name: string } }>(
    '/api/repros/:name/owner',
    async (request) =>
      await setOwner(request.params.name, orText(requestBody(request.body, true).to), {
        by: actor(request),
      }),
  );

  app.delete<{
    Params: { name: string };
    Querystring: { volumes?: unknown; confirm?: unknown };
  }>('/api/repros/:name', async (request) => {
    const volumes = queryBool(request.query.volumes, false, 'volumes');
    const confirm = queryBool(request.query.confirm, false, 'confirm');
    const target = await checkTeardownRequest(request.params.name, { volumes, confirm });
    return submit(app, 'teardown', (emit) => teardown(target, { volumes, confirm, emit }), {
      label: target,
    });
  });

  app.post('/api/prune', async (request) => {
    const body = requestBody(request.body, false);
    return submit(app, 'prune', (emit) =>
      prune({ confirm: bool(body.confirm), orphans: bool(body.orphans), emit }),
    );
  });
}
