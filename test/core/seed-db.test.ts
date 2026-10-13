import type { Metadata } from '../../src/core/runner/record';
import type * as SeedDbNS from '../../src/core/seed-db';

const META: Metadata = {
  name: 'seed-db-test',
  project: 'houston-test',
  rcVersion: '7.4.1',
  rcImage: 'image',
  mongoTag: '7.0',
  mongoFlavor: 'official',
  preset: 'default',
  rootUrl: 'http://localhost:3001',
  hostPort: 3001,
  versionSource: 'map',
  pinned: false,
  createdAt: '2026-10-09',
  publicUrl: '',
  adminPassword: '',
  extra: {},
};
function docker(uris: string[] = ['mongodb://mongodb:27017/tenant?replicaSet=rs0']) {
  jest.resetModules();
  const calls: { argv: readonly string[]; input: string }[] = [];
  let current = uris;
  jest.doMock('../../src/core/runner/record', () => ({
    readCompose: async () => ({
      services: {
        mongodb: {},
        ...Object.fromEntries(
          uris.map((_, i) => [`rocketchat-${i}`, { environment: ['MONGO_URL=recorded-value'] }]),
        ),
      },
    }),
  }));
  jest.doMock('../../src/core/runner/engine', () => ({
    compose: async (_name: string, argv: readonly string[], options: { input?: string }) => {
      calls.push({ argv, input: options.input ?? '' });
      if (argv.includes('node'))
        return {
          exitCode: 0,
          stdout: JSON.stringify({ uri: current[Number((argv[2] as string).split('-').at(-1))] }),
          stderr: '',
        };
      if (argv.includes('--eval'))
        return {
          exitCode: 1,
          stdout: '',
          stderr: "TypeError: Cannot read properties of undefined (reading 'findOne')",
        };
      return { exitCode: 0, stdout: 'HOUSTON_SEED:{"ok":true}\n', stderr: '' };
    },
  }));
  return {
    mod: require('../../src/core/seed-db') as typeof SeedDbNS,
    calls,
    change: (value: string[]) => {
      current = value;
    },
  };
}

function kubernetes(realFunnel = false, overrideUri?: string) {
  jest.resetModules();
  const uri =
    overrideUri ??
    'mongodb://scram-user:private%40password@mongodb-0.mongodb-svc.houston-seed-db-test.svc.cluster.local:27017/custom_seed?authSource=admin';
  const calls: { argv: readonly string[]; input: string }[] = [];
  const identity = { uid: 'original-namespace-uid', owner: 'houston', workspace: META.name };
  const respond = async (argv: readonly string[], options: { input?: string } = {}) => {
    calls.push({ argv, input: options.input ?? '' });
    if (argv[0] !== 'kubectl')
      return { argv, returncode: 127, stdout: '', stderr: `spawn ${String(argv[0])} ENOENT` };
    const kind = argv[argv.indexOf('get') + 1];
    let body: unknown;
    if (argv.includes('exec'))
      return { argv, returncode: 0, stdout: 'HOUSTON_SEED:{"ok":true}\n', stderr: '' };
    if (kind === 'namespace')
      body = {
        metadata: {
          uid: identity.uid,
          labels: {
            'app.kubernetes.io/managed-by': identity.owner,
            'houston.io/workspace': identity.workspace,
          },
        },
      };
    else if (kind === 'pods')
      body = {
        items: [
          {
            spec: {
              containers: [
                {
                  name: 'rocketchat',
                  env: [
                    {
                      name: 'MONGO_URL',
                      valueFrom: { secretKeyRef: { name: 'mongodb-scram', key: 'uri' } },
                    },
                  ],
                },
              ],
            },
          },
        ],
      };
    else if (kind === 'secret') body = { data: { uri: Buffer.from(uri).toString('base64') } };
    else throw new Error(`unexpected Kubernetes call ${argv.join(' ')}`);
    return { argv, returncode: 0, stdout: JSON.stringify(body), stderr: '' };
  };
  if (realFunnel) {
    jest.dontMock('../../src/core/kube/exec');
    jest.doMock('../../src/seams/kubectl', () => ({ kubectl: { run: respond } }));
  } else {
    jest.doMock('../../src/core/kube/exec', () => ({
      envFor: () => undefined,
      kube: { run: respond },
    }));
  }
  return {
    mod: require('../../src/core/seed-db') as typeof SeedDbNS,
    calls,
    identity,
    meta: {
      ...META,
      extra: { runtime: 'kubernetes', context: 'local-test', namespace: 'houston-seed-db-test' },
    },
  };
}
describe('historical seed target preflight', () => {
  afterEach(() => jest.resetModules());
  it('resolves every live instance and feeds MongoDB its credentials through transformed stdin', async () => {
    const uri = 'mongodb://seed-user:very-private@mongodb:27017/tenant?authSource=tenant';
    const { mod, calls } = docker([uri, uri]);
    const db = await mod.seedDatabase(META, 'admin-id');
    await db.run("print('HOUSTON_SEED:'+JSON.stringify({ok:true}));");
    expect(calls.filter((c) => c.argv.includes('node'))).toHaveLength(2);
    for (const call of calls.filter((c) => c.argv.includes('mongosh'))) {
      expect(call.argv).toEqual(expect.arrayContaining(['--file', '/dev/stdin']));
      expect(call.argv.join(' ')).not.toContain('very-private');
      expect(call.input).toContain('seed-user:very-private@127.0.0.1:27017/tenant');
    }
    expect(db.target).not.toContain('very-private');
  });
  it('refuses disagreement between live instances before any historical write', async () => {
    const { mod, calls } = docker(['mongodb://mongodb:27017/one', 'mongodb://mongodb:27017/two']);
    await expect(mod.seedDatabase(META, 'admin')).rejects.toThrow('agree on MONGO_URL');
    expect(calls.some((c) => c.argv.includes('mongosh'))).toBe(false);
  });
  it('refuses external targets rather than falling back to the conventional database', async () => {
    const { mod, calls } = docker(['mongodb://external.example:27017/customer']);
    await expect(mod.seedDatabase(META, 'admin')).rejects.toThrow('external or unresolved');
    expect(calls.some((c) => c.argv.includes('mongosh'))).toBe(false);
  });
  it('revalidates the live target before a later date chunk', async () => {
    const { mod, change } = docker();
    const db = await mod.seedDatabase(META, 'admin');
    change(['mongodb://mongodb:27017/changed']);
    await expect(db.assertTarget()).rejects.toThrow('changed during seeding');
  });
  it('keeps ownership stable across a version upgrade and credential rotation', async () => {
    const a = docker(['mongodb://user:old@mongodb:27017/tenant']);
    const first = await a.mod.seedDatabase(META, 'admin');
    const b = docker(['mongodb://user:new@mongodb:27017/tenant']);
    const second = await b.mod.seedDatabase(
      { ...META, rcVersion: '8.5.1', createdAt: 'later' },
      'admin',
    );
    expect(second.target).toBe(first.target);
  });
  it.each(['mongodb+srv://host/tenant', 'mongodb://mongodb:27017', 'mongodb://mongodb:27017/%ZZ'])(
    'refuses an unidentifiable URI %s with a preflight error',
    (uri) => {
      const { mod } = docker();
      try {
        mod.mongoTarget(uri);
        throw new Error('accepted');
      } catch (error) {
        expect(error).toMatchObject({ code: 'PREFLIGHT_FAILED', exitCode: 3 });
      }
    },
  );
  it('passes the kubectl executable through the real Kubernetes funnel for lookup and MongoDB execution', async () => {
    const { mod, calls, meta } = kubernetes(true);
    const prepared = mod.seedDatabase(meta, 'admin-id');
    await prepared.catch(() => undefined);
    expect(calls[0]?.argv[0]).toBe('kubectl');
    const database = await prepared;
    await expect(
      database.run("print('HOUSTON_SEED:'+JSON.stringify({ok:true}));"),
    ).resolves.toEqual({ ok: true });
    expect(calls.some((call) => call.argv.includes('get'))).toBe(true);
    expect(calls.filter((call) => call.argv.includes('exec'))).toHaveLength(2);
    for (const call of calls) {
      expect(call.argv.slice(0, 5)).toEqual([
        'kubectl',
        '--context',
        'local-test',
        '-n',
        'houston-seed-db-test',
      ]);
      expect(call.argv.join(' ')).not.toContain('private');
    }
    for (const call of calls.filter((item) => item.argv.includes('exec')))
      expect(call.input).toContain(
        'scram-user:private%40password@127.0.0.1:27017/custom_seed?authSource=admin',
      );
  });
  it('accepts the owned StatefulSet headless MongoDB hostname while refusing another namespace', async () => {
    const uri =
      'mongodb://scram-user:private%40password@mongodb-0.mongodb:27017/custom_seed?authSource=admin';
    const owned = kubernetes(true, uri);
    await expect(owned.mod.seedDatabase(owned.meta, 'admin-id')).resolves.toEqual(
      expect.objectContaining({ run: expect.any(Function), assertTarget: expect.any(Function) }),
    );
    const mongo = owned.calls.find((call) => call.argv.includes('mongosh'))!;
    expect(mongo.argv).toEqual(
      expect.arrayContaining(['kubectl', 'exec', 'mongodb-0', '-c', 'mongod']),
    );
    expect(mongo.input).toContain(
      'scram-user:private%40password@127.0.0.1:27017/custom_seed?authSource=admin',
    );
    const foreign = kubernetes(
      true,
      uri.replace('.mongodb:', '.mongodb.another-namespace.svc.cluster.local:'),
    );
    await expect(foreign.mod.seedDatabase(foreign.meta, 'admin-id')).rejects.toThrow(
      'MongoDB is outside the owned namespace',
    );
    expect(foreign.calls.some((call) => call.argv.includes('exec'))).toBe(false);
  });
  it('resolves Kubernetes SCRAM secrets and custom databases without putting credentials on argv', async () => {
    const { mod, calls, meta } = kubernetes();
    const db = await mod.seedDatabase(meta, 'admin-id');
    await db.assertTarget();
    const executions = calls.filter((c) => c.argv.includes('exec'));
    expect(executions).toHaveLength(2);
    for (const call of executions) {
      expect(call.argv).toEqual(
        expect.arrayContaining([
          '--context',
          'local-test',
          '-n',
          'houston-seed-db-test',
          'mongodb-0',
          '-c',
          'mongod',
          '--file',
          '/dev/stdin',
        ]),
      );
      expect(call.argv.join(' ')).not.toContain('private');
      expect(call.input).toContain(
        'scram-user:private%40password@127.0.0.1:27017/custom_seed?authSource=admin',
      );
    }
    expect(db.target).not.toContain('private');
  });
  it.each(['uid', 'owner', 'workspace'] as const)(
    'refuses a changed Kubernetes namespace %s before any later database execution',
    async (field) => {
      const { mod, calls, meta, identity } = kubernetes();
      const db = await mod.seedDatabase(meta, 'admin-id');
      identity[field] = 'replacement';
      await expect(db.assertTarget()).rejects.toThrow('namespace identity or ownership changed');
      expect(calls.filter((c) => c.argv.includes('exec'))).toHaveLength(1);
    },
  );
  it('refuses Kubernetes namespaces with no verified UID before opening MongoDB', async () => {
    const { mod, calls, meta, identity } = kubernetes();
    identity.uid = '';
    await expect(mod.seedDatabase(meta, 'admin-id')).rejects.toThrow(
      'namespace has no verified identity',
    );
    expect(calls.some((c) => c.argv.includes('exec'))).toBe(false);
  });
});
