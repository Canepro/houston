/** Resolve the live managed MongoDB target. Secrets travel only on stdin. */
import { createHash } from 'node:crypto';

import { ConflictError, PreflightError } from '../lib/errors';
import { compose } from './runner/engine';
import { readCompose, type Metadata } from './runner/record';
import { kube, envFor } from './kube/exec';
import { OWNER_LABEL_KEY, OWNER_LABEL_VALUE, WORKSPACE_LABEL } from './kube/names';

type Bag = Record<string, unknown>;
const map = (value: unknown): Bag =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Bag) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const rows = (value: unknown): Bag[] => (Array.isArray(value) ? value.map(map) : []);

export interface SeedDatabase {
  readonly target: string;
  run(script: string): Promise<Bag>;
  assertTarget(): Promise<void>;
}

export function mongoTarget(uri: string): { database: string; hosts: string[]; local: string } {
  const match = /^mongodb:\/\/(?:([^@/]+)@)?([^/]+)\/([^?]+)(\?.*)?$/u.exec(uri);
  if (match === null)
    throw new PreflightError(
      'historical seed requires an explicit managed mongodb:// URI with a database',
    );
  let database: string;
  try {
    database = decodeURIComponent(match[3] as string);
  } catch {
    throw new PreflightError('historical seed database name is invalid');
  }
  if (database === '' || /[\s./\\"$\0]/u.test(database))
    throw new PreflightError('historical seed database name is invalid');
  const hosts = (match[2] as string).split(',');
  if (hosts.length !== 1)
    throw new PreflightError(
      'historical seed requires one positively identified managed MongoDB endpoint',
    );
  const local = `mongodb://${match[1] === undefined ? '' : `${match[1]}@`}127.0.0.1:27017/${match[3]}${match[4] ?? ''}`;
  return { database, hosts, local };
}

export async function seedDatabase(meta: Metadata, adminId: string): Promise<SeedDatabase> {
  let uri = '';
  let location: string;
  let invoke: (
    tool: string,
    script: string,
  ) => Promise<{ code: number | null; out: string; err: string }>;
  let resolve: () => Promise<string>;
  if (meta.extra.runtime === 'kubernetes') {
    const namespace = text(meta.extra.namespace);
    const context = text(meta.extra.context);
    if (namespace === '' || context === '')
      throw new PreflightError(
        'historical seed requires the recorded Kubernetes namespace and context',
      );
    const args = ['kubectl', '--context', context, '-n', namespace];
    const env = envFor(context);
    const get = async (kind: string, name = ''): Promise<Bag> => {
      const result = await kube.run(
        [...args, 'get', kind, ...(name === '' ? [] : [name]), '-o', 'json'],
        { ...(env === undefined ? {} : { env }) },
      );
      if (result.returncode !== 0)
        throw new PreflightError(`historical seed cannot read Kubernetes ${kind}`);
      try {
        return map(JSON.parse(result.stdout));
      } catch {
        throw new PreflightError(`historical seed received invalid Kubernetes ${kind}`);
      }
    };
    const ns = await get('namespace', namespace);
    const labels = map(map(ns.metadata).labels);
    if (labels[OWNER_LABEL_KEY] !== OWNER_LABEL_VALUE || labels[WORKSPACE_LABEL] !== meta.name)
      throw new PreflightError('historical seed namespace ownership does not match the workspace');
    const namespaceUid = text(map(ns.metadata).uid);
    if (namespaceUid === '')
      throw new PreflightError('historical seed namespace has no verified identity');
    location = `${context}:${namespace}:${namespaceUid}`;
    resolve = async () => {
      const currentNamespace = map((await get('namespace', namespace)).metadata);
      const currentLabels = map(currentNamespace.labels);
      if (
        currentNamespace.uid !== namespaceUid ||
        currentLabels[OWNER_LABEL_KEY] !== OWNER_LABEL_VALUE ||
        currentLabels[WORKSPACE_LABEL] !== meta.name
      )
        throw new ConflictError('the historical seed namespace identity or ownership changed');
      const pods = rows((await get('pods')).items);
      const uris: string[] = [];
      for (const pod of pods)
        for (const container of rows(map(pod.spec).containers)) {
          const variable = rows(container.env).find((v) => v.name === 'MONGO_URL');
          if (variable === undefined) continue;
          let value = text(variable.value);
          if (value === '') {
            const secretRef = map(map(variable.valueFrom).secretKeyRef);
            const secretName = text(secretRef.name);
            const key = text(secretRef.key);
            if (secretName === '' || key === '')
              throw new PreflightError('historical seed cannot resolve the live MONGO_URL source');
            const encoded = text(map((await get('secret', secretName)).data)[key]);
            if (encoded === '')
              throw new PreflightError('historical seed MongoDB credentials are unavailable');
            value = Buffer.from(encoded, 'base64').toString('utf8');
          }
          uris.push(value);
        }
      if (uris.length === 0 || uris.some((u) => u !== uris[0]))
        throw new PreflightError(
          'historical seed requires all live Rocket.Chat services to agree on MONGO_URL',
        );
      return uris[0] as string;
    };
    uri = await resolve();
    const endpoint = mongoTarget(uri).hosts[0] as string;
    if (
      !new RegExp(
        `^mongodb(?:-0(?:\\.mongodb(?:-svc)?(?:\\.${namespace.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:\\.svc(?:\\.cluster\\.local)?)?)?)?)?(?::27017)?$`,
        'u',
      ).test(endpoint)
    )
      throw new PreflightError('historical seed MongoDB is outside the owned namespace');
    invoke = async (tool, script) => {
      const result = await kube.run(
        [
          ...args,
          'exec',
          '-i',
          'mongodb-0',
          '-c',
          'mongod',
          '--',
          tool,
          '--quiet',
          '--nodb',
          ...(tool === 'mongosh'
            ? ['--file', '/dev/stdin']
            : ['--eval', "eval(cat('/dev/stdin'))"]),
        ],
        { ...(env === undefined ? {} : { env }), input: script, timeout: 120 },
      );
      return { code: result.returncode, out: result.stdout, err: result.stderr };
    };
  } else {
    const document = await readCompose(meta.name);
    const services = Object.entries(map(document.services)).filter(
      ([name, service]) =>
        /^(?:rc|rocketchat)(?:-?\d+)?$/u.test(name) ||
        map(map(service).environment).MONGO_URL !== undefined ||
        (Array.isArray(map(service).environment) &&
          (map(service).environment as unknown[]).some(
            (e) => typeof e === 'string' && e.startsWith('MONGO_URL='),
          )),
    );
    if (services.length === 0 || map(document.services).mongodb === undefined)
      throw new PreflightError('historical seed requires a managed MongoDB service');
    location = `docker:${meta.project}`;
    resolve = async () => {
      const uris: string[] = [];
      for (const [service] of services) {
        const response = await compose(
          meta.name,
          [
            'exec',
            '-T',
            service,
            'node',
            '-e',
            'process.stdout.write(JSON.stringify({uri:process.env.MONGO_URL}))',
          ],
          { capture: true, timeoutMs: 30_000 },
        );
        if (response.exitCode !== 0)
          throw new PreflightError(
            'historical seed cannot read the live Rocket.Chat database target',
          );
        try {
          uris.push(text(map(JSON.parse(String(response.stdout))).uri));
        } catch {
          throw new PreflightError('historical seed received an invalid database target');
        }
      }
      if (uris[0] === '' || uris.some((u) => u !== uris[0]))
        throw new PreflightError(
          'historical seed requires all live Rocket.Chat services to agree on MONGO_URL',
        );
      return uris[0] as string;
    };
    uri = await resolve();
    if (!/^mongodb(?::27017)?$/u.test(mongoTarget(uri).hosts[0] as string))
      throw new PreflightError('historical seed refuses an external or unresolved MongoDB target');
    invoke = async (tool, script) => {
      const result = await compose(
        meta.name,
        [
          'exec',
          '-T',
          'mongodb',
          tool,
          '--quiet',
          '--nodb',
          ...(tool === 'mongosh'
            ? ['--file', '/dev/stdin']
            : ['--eval', "eval(cat('/dev/stdin'))"]),
        ],
        { capture: true, timeoutMs: 120_000, input: script },
      );
      return { code: result.exitCode, out: String(result.stdout), err: String(result.stderr) };
    };
  }
  const parsed = mongoTarget(uri);
  const target = createHash('sha256')
    .update(
      JSON.stringify({ location, database: parsed.database, endpoint: parsed.hosts, adminId }),
    )
    .digest('hex');
  const run = async (script: string): Promise<Bag> => {
    const input = `var db = connect(${JSON.stringify(parsed.local)});\n${script}`;
    let result = await invoke('mongosh', input);
    if (
      result.code !== 0 &&
      /(?:executable file not found|mongosh: (?:not found|command not found))/u.test(
        result.err + result.out,
      )
    )
      result = await invoke('mongo', input);
    if (result.code !== 0)
      throw new PreflightError(
        'historical seed MongoDB execution failed; no credentials or commands are included in this error',
      );
    const line = result.out.split('\n').find((v) => v.startsWith('HOUSTON_SEED:'));
    if (line === undefined)
      throw new PreflightError('historical seed MongoDB did not return its expected receipt');
    try {
      return map(JSON.parse(line.slice('HOUSTON_SEED:'.length)));
    } catch {
      throw new PreflightError('historical seed MongoDB returned invalid data');
    }
  };
  const preflight = async (): Promise<void> => {
    const result = await run(
      `if (!db.users.findOne({_id:${JSON.stringify(adminId)}}) || !db.rocketchat_room.findOne({_id:'GENERAL'})) throw new Error('workspace identity mismatch');\nfor (var c of ['rocketchat_message','rocketchat_room','rocketchat_uploads','rocketchat_uploads.files']) db.getCollection(c).updateOne({_id:'houston-preflight-no-such-id'},{$set:{houstonPreflight:true}});\nprint('HOUSTON_SEED:'+JSON.stringify({ok:true}));`,
    );
    if (result.ok !== true)
      throw new PreflightError('historical seed MongoDB preflight was incomplete');
  };
  await preflight();
  return {
    target,
    run,
    assertTarget: async () => {
      if ((await resolve()) !== uri)
        throw new ConflictError('the live MongoDB target changed during seeding');
      await preflight();
    },
  };
}
