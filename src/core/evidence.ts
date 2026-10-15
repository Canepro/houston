/**
 * A secret-safe, backend-neutral record of what was deployed and how it behaved: the
 * thing a person attaches to a support case.
 *
 * `info --json` is the wrong thing to attach. Its `login` block carries the admin password
 * and its `root_url` is whatever was recorded, path and userinfo included. Two properties
 * follow from "attachable", and neither is optional:
 *
 * - SECRET-SAFE. The root URL is reduced to its origin, and no token, licence or password
 *   appears anywhere. A record that leaks a credential cannot be attached to anything,
 *   which makes it worthless.
 * - BACKEND-NEUTRAL. The `repro` block is the same shape for Docker and Kubernetes, and
 *   `runtime` keeps one shape with different contents, so a consumer reads it without
 *   branching on where the workspace ran.
 *
 * `license` and `retention` are recorded because a conclusion drawn from a run depends on
 * them. An unlicensed microservices workspace can look healthy while not behaving as
 * licensed, and citing it as proof without that caveat is the harm the field prevents. The
 * cleanup handle is a literal command rather than a description, so a person can paste it
 * months later without knowing the runtime.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { imageRef } from '../lib/compose';
import * as config from '../lib/config';
import { ValidationError } from '../lib/errors';
import { isTruthy, toText } from '../lib/format';
import { pathExpandUser } from '../lib/home';
import * as presets from '../lib/presets/index';
import { CONTEXT as KUBE_CONTEXT, isOurs } from './kube/names';
import { kube } from './kube/exec';
import { namespaceFor } from './kube/namespace';
import * as naming from './lifecycle/naming';
import { detail } from './lifecycle/payload';
import { composeLogsCapture } from './runner/engine';
import { composeVersion, dockerServerVersion } from './runner/host';
import * as paths from './runner/paths';
import { type Metadata, readMeta } from './runner/record';
import * as topology from './topology';

/** The rendered deployment artifact, whichever runtime produced it. Hashed, whichever exists. */
const ARTIFACTS: readonly string[] = ['docker-compose.yml', path.join('kubernetes', 'values.yaml')];

/** Only these reasons may appear on a retained run, so nobody invents a softer one. */
const RETAIN_REASONS: readonly string[] = ['persisted preference', 'explicit task'];

/** What `writeBundle` returns: where it wrote, and every file, relative to it. */
export interface Bundle {
  path: string;
  files: string[];
}

function bag(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A URL reduced to `scheme://host[:port]`, dropping path, query and userinfo, or
 * `REDACTED` for anything that is not an http(s) URL with a host. Credentials in a URL are
 * the classic accidental leak, and a path can carry a ticket id or a customer name. The
 * origin is all evidence needs.
 */
export function safeOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'REDACTED';
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') {
    return 'REDACTED';
  }
  // `URL` keeps a bracketed IPv6 hostname bracketed, and drops a port that is the
  // scheme's default, which is the origin as a browser would print it.
  return parsed.port === ''
    ? `${parsed.protocol}//${parsed.hostname}`
    : `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
}

/** The exact command that removes this workspace, valid on any machine holding it. */
export function cleanupCommand(name: string): string {
  return `houston down --name ${name} --volumes --yes`;
}

async function artifactOf(name: string): Promise<{ name: string; sha256: string }> {
  const ws = paths.workspace(name);
  for (const candidate of ARTIFACTS) {
    try {
      const bytes = await fs.readFile(path.join(ws, candidate));
      return { name: candidate, sha256: createHash('sha256').update(bytes).digest('hex') };
    } catch {
      continue;
    }
  }
  return { name: '', sha256: '' };
}

/**
 * How houston knows the workspace is its own, stated so a teardown decision is auditable
 * after the fact. A name prefix is not ownership: Kubernetes proves it by label, Compose by
 * the record that names the project.
 */
function ownershipOf(meta: Metadata, runtime: string): Record<string, unknown> {
  if (runtime === topology.KUBERNETES) {
    return { proof: 'label', managed_by: 'houston', namespace: toText(bag(meta.extra).namespace) };
  }
  return { proof: 'record', managed_by: 'houston', project: meta.project };
}

/**
 * Whether a licence was needed and whether one was supplied. Never the value, only
 * whether and from where. `extra.licensed` is set by `--license` on either runtime; a
 * registration token is not recorded in the metadata at all, so it cannot be reported
 * here and `source` names only what the record can prove.
 */
function licenseOf(meta: Metadata, deployment: string): Record<string, unknown> {
  let required = deployment === topology.MICROSERVICES;
  if (!required && meta.preset !== '') {
    try {
      required = presets.load(meta.preset).requiresLicense;
    } catch {
      // A preset this install no longer has must not break the evidence for a workspace
      // that was built from it; "not required" is the only answer the record supports.
      required = false;
    }
  }
  const supplied = bag(meta.extra).licensed === true;
  return { required, supplied, source: supplied ? 'license' : null };
}

/**
 * Retain or tear down, from what was asked. A retained run must name why, and the reason
 * is one of two so an agent cannot invent a soft justification for leaving state behind.
 */
export function resolveRetention({
  retained = null,
  reason = '',
}: { retained?: boolean | null; reason?: string } = {}): {
  retained: boolean;
  reason: string | null;
} {
  if (retained === true) {
    const why = reason.trim() === '' ? 'explicit task' : reason.trim();
    if (!RETAIN_REASONS.includes(why)) {
      throw new ValidationError(
        `retained evidence reason must be ${RETAIN_REASONS.map((r) => `'${r}'`).join(' or ')}`,
      );
    }
    return { retained: true, reason: why };
  }
  return { retained: false, reason: null };
}

function servicesOf(containers: unknown): { service: string; state: string; status: string }[] {
  return (Array.isArray(containers) ? containers : []).map((row) => {
    const item = bag(row);
    return {
      service: toText(item.service),
      state: toText(item.state),
      status: toText(item.status),
    };
  });
}

/**
 * The evidence record for a workspace. Reads the same detail `info` reads, then keeps
 * only what is safe to attach: the `login` block and the recorded URLs never reach the
 * output, and the `env` rows (masked for a panel, not for a stranger) are dropped whole.
 */
export async function record(
  name: string,
  retention: { retained?: boolean | null; reason?: string } = {},
): Promise<Record<string, unknown>> {
  const target = await naming.resolveName(name);
  const meta = await readMeta(target);
  const d = await detail(target);
  const runtime = topology.ofMeta(meta);
  const deployment = toText(d.deployment);
  const extra = bag(meta.extra);

  let engine: Record<string, unknown>;
  if (runtime === topology.KUBERNETES) {
    engine = {
      kind: 'kubernetes',
      context: toText(d.context),
      cluster: toText(d.cluster),
      namespace: toText(d.namespace),
    };
  } else {
    engine = {
      kind: 'compose',
      docker_version: (await dockerServerVersion()) ?? '',
      compose_version: (await composeVersion()) ?? '',
    };
  }

  const keep = resolveRetention(retention);
  const payload: Record<string, unknown> = {
    // Identical shape on both runtimes, so a consumer never branches here.
    repro: {
      name: meta.name,
      preset: meta.preset,
      runtime,
      deployment,
      rc_version: meta.rcVersion,
      rc_image: imageRef(meta.rcImage, meta.rcVersion),
      mongo_tag: meta.mongoTag,
      mongo_flavor: meta.mongoFlavor,
      // Origin only: never a path, query or userinfo.
      root_url: safeOrigin(meta.rootUrl),
      public_url: meta.publicUrl === '' ? '' : safeOrigin(meta.publicUrl),
      host_port: meta.hostPort,
      bind_host: toText(d.bind_host),
      version_source: meta.versionSource,
      created_at: meta.createdAt,
    },
    runtime: { state: toText(d.state), services: servicesOf(d.containers), engine },
    artifact: await artifactOf(target),
    ownership: ownershipOf(meta, runtime),
    license: licenseOf(meta, deployment),
    retention: {
      retained: keep.retained,
      reason: keep.reason,
      cleanup: cleanupCommand(meta.name),
      owner: 'houston',
      created_at: meta.createdAt,
    },
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
  };
  // Sample data is evidence too: the plan and the readback are counts and names, never
  // credentials. Additive, so an unseeded record keeps its established shape.
  if (isTruthy(extra.seed)) payload.seed = structuredClone(extra.seed);
  return payload;
}

function kvTable(rows: readonly (readonly [string, string])[]): string[] {
  return [
    '| | |',
    '|---|---|',
    ...rows.filter(([, v]) => v !== '').map(([k, v]) => `| ${k} | ${v} |`),
  ];
}

/**
 * The record as the page a person opens. The JSON is the machine contract and stays
 * authoritative; this is the same facts in the order a reader needs them: what was
 * deployed, what state it is in, and how to clean it up. It renders only from `payload`,
 * which is already secret-safe, so the readable view cannot leak what the machine view
 * withheld.
 */
export function renderMarkdown(payload: Record<string, unknown>): string {
  const repro = bag(payload.repro);
  const license = bag(payload.license);
  const runtime = bag(payload.runtime);
  const name = toText(repro.name) || '?';
  let mongo = toText(repro.mongo_tag);
  if (mongo !== '' && toText(repro.mongo_flavor) !== '')
    mongo += ` (${toText(repro.mongo_flavor)})`;
  const lines = [
    `# Workspace \`${name}\` — Rocket.Chat ${toText(repro.rc_version) || '?'}`,
    '',
    ...kvTable([
      ['Rocket.Chat', `${toText(repro.rc_version)} (\`${toText(repro.rc_image)}\`)`],
      ['MongoDB', mongo],
      ['Runtime', toText(repro.runtime)],
      ['Deployment', toText(repro.deployment)],
      ['Preset', toText(repro.preset) || 'none'],
      ['URL', toText(repro.root_url)],
      ['Created', toText(repro.created_at)],
      [
        'Licensed',
        license.supplied === true
          ? 'yes'
          : license.required === true
            ? 'no (required)'
            : 'not required',
      ],
      ['State', toText(runtime.state)],
    ]),
    '',
  ];
  const services = Array.isArray(runtime.services) ? runtime.services : [];
  if (services.length > 0) {
    lines.push('## Runtime', '', '| Service | State | Status |', '|---|---|---|');
    for (const row of services) {
      const svc = bag(row);
      lines.push(`| ${toText(svc.service)} | ${toText(svc.state)} | ${toText(svc.status)} |`);
    }
    lines.push('');
  }
  const cleanup = toText(bag(payload.retention).cleanup);
  if (cleanup !== '') lines.push('## Cleanup', '', '```bash', cleanup, '```', '');
  return lines.join('\n');
}

/**
 * Logs for the bundle, best effort: a bundle must not fail on an engine that is asleep.
 * One file per pod on Kubernetes, because nine interleaved components are unreadable and
 * the failing one is what a reader wants; Compose already labels each line with its
 * service, so one capture is enough there.
 */
async function writeLogs(
  name: string,
  meta: Metadata,
  payload: Record<string, unknown>,
  dir: string,
): Promise<string[]> {
  const written: string[] = [];
  const runtime = toText(bag(payload.repro).runtime);
  try {
    await fs.mkdir(dir, { recursive: true });
    if (runtime === topology.KUBERNETES) {
      const extra = bag(meta.extra);
      const context = isTruthy(extra[config.EXTRA_CONTEXT])
        ? toText(extra[config.EXTRA_CONTEXT])
        : KUBE_CONTEXT;
      const ns = await namespaceFor(name);
      for (const svc of servicesOf(bag(payload.runtime).services)) {
        if (svc.service === '') continue;
        const res = await kube.run(
          [
            'kubectl',
            '--context',
            context,
            '-n',
            ns,
            'logs',
            svc.service,
            '--all-containers=true',
            '--tail=500',
          ],
          { own: isOurs(context) },
        );
        if (res.returncode !== 0) continue;
        await fs.writeFile(path.join(dir, `${svc.service}.log`), res.stdout, 'utf8');
        written.push(`logs/${svc.service}.log`);
      }
    } else {
      const text = await composeLogsCapture(name, { tail: 500 });
      if (text !== '') {
        await fs.writeFile(path.join(dir, 'compose.log'), text, 'utf8');
        written.push('logs/compose.log');
      }
    }
  } catch {
    // The record and the artifact are the bundle; logs are what the engine would add.
  }
  return written;
}

/**
 * A bundle: the record, its readable rendering, the rendered deployment artifact and the
 * logs. Opt-in rather than the default, because the single JSON document is the machine
 * contract and a directory is what a person attaches to a case.
 */
export async function writeBundle(
  name: string,
  dest: string,
  payload: Record<string, unknown>,
): Promise<Bundle> {
  const target = await naming.resolveName(name);
  const meta = await readMeta(target);
  const out = pathExpandUser(dest);
  await fs.mkdir(out, { recursive: true });
  const written = ['manifest.json', 'README.md'];
  await fs.writeFile(
    path.join(out, 'manifest.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(path.join(out, 'README.md'), renderMarkdown(payload), 'utf8');
  const artifact = toText(bag(payload.artifact).name);
  if (artifact !== '') {
    const source = path.join(paths.workspace(target), artifact);
    const copy = path.join(out, path.basename(artifact));
    try {
      await fs.copyFile(source, copy);
      written.push(path.basename(artifact));
    } catch {
      // The hash in the record still names what was deployed.
    }
  }
  written.push(...(await writeLogs(target, meta, payload, path.join(out, 'logs'))));
  return { path: out, files: written.sort() };
}
