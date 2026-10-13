/**
 * Tier k4: the tier that WRITES, and most of what it writes is shared.
 *
 * The helm release, the MongoDB operator, the chart values, cert-manager, the ingress
 * controller and the monitoring stack. Four of those six are one object per CLUSTER, not one
 * per workspace, so every case here is about the two questions that decide whether a write is
 * safe: is this ours to touch, and is anybody else still using it.
 *
 * The third question runs underneath both: an answer nobody could read is not a "no". `ask`
 * gives that a type; this is the tier where acting on it wrongly uninstalls somebody else's
 * database operator.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as YAML from 'yaml';

import { presetDir } from '../../../src/lib/config';
import {
  CreateFailedError,
  DockerError,
  PreflightError,
  ValidationError,
} from '../../../src/lib/errors';
import type { Event } from '../../../src/lib/events';
import { load as loadPreset, resolve as resolvePreset } from '../../../src/lib/presets/index';
import type { KubectlResult } from '../../../src/seams/kubectl';
import { CA_CRT, CA_KEY, caDir } from '../../../src/core/tls-local';
import { KUBERNETES } from '../../../src/core/topology';

import {
  bestChartAtOrBelow,
  chartEnv,
  refuseChartOwnedEnv,
  resolveChartVersion,
  valuesFor,
  type ChartEnvEntry,
} from '../../../src/core/kube/chart';
import {
  ACME_PRODUCTION,
  CA_ISSUER,
  CERT_MANAGER_DEPLOYMENTS,
  CERT_MANAGER_INTERVAL,
  acmeIssuerManifest,
  caIssuerManifest,
  certManagerInstalled,
  ensureAcmeIssuer,
  ensureCaIssuer,
  ensureCertManager,
  ensureIssuer,
  issuerName,
} from '../../../src/core/kube/certmanager';
import { kube } from '../../../src/core/kube/exec';
import { forwardAlive, listedService } from '../../../src/core/kube/forward';
import { ensureIngress, ingressValues, toolsIngressManifest } from '../../../src/core/kube/ingress';
import {
  GRAFANA_DELETE_WAIT,
  MONITORING_LABEL,
  MONITORING_NAMESPACE,
  monitoringInstalled,
  monitoringWanted,
  removeMonitoring,
} from '../../../src/core/kube/monitoring';
import { CONTEXT, OWNER_LABEL_KEY, OWNER_OF_LABEL, tuning } from '../../../src/core/kube/names';
import {
  MONGO_APP_DB,
  MONGO_APP_USER,
  MONGO_DB_SERVICE_ACCOUNT,
  OPERATOR_NAMESPACE,
  OPERATOR_RELEASE,
  REG_TOKEN_KEY,
  REG_TOKEN_SECRET,
  ensureOperator,
  mongoRbacManifest,
  mongoSecretManifest,
  mongodbCommunityManifest,
  mongodbResources,
  operatorEnabled,
  operatorIsOurs,
  operatorMongoUrl,
  operatorSupports,
  operatorVersion,
  operatorWatchScope,
  operatorWatches,
  regTokenSecretManifest,
  removeOperator,
} from '../../../src/core/kube/operator';
import {
  PENDING_STATES,
  apply,
  clearPendingRelease,
  helmRollbackOnFailure,
  install,
  releaseState,
  upgradeImage,
} from '../../../src/core/kube/release';

const realRun = kube.run;

type Rule = [(argv: readonly string[]) => boolean, Partial<KubectlResult>];

/** Every argv the scripted kube saw; a call with stdin records the payload after it. */
let seen: string[][] = [];

function script(rules: Rule[], fallback: Partial<KubectlResult> = {}): void {
  seen = [];
  kube.run = (argv, options) => {
    seen.push([...argv, ...(options?.input === undefined ? [] : ['<stdin>', options.input])]);
    const hit = rules.find(([matches]) => matches(argv));
    return Promise.resolve({
      argv,
      returncode: 0,
      stdout: '',
      stderr: '',
      ...(hit === undefined ? fallback : hit[1]),
    });
  };
}

const has =
  (...needles: string[]) =>
  (argv: readonly string[]) =>
    needles.every((needle) => argv.includes(needle));

const json = (value: unknown) => ({ stdout: JSON.stringify(value) });

const REFUSED = {
  returncode: 1,
  stderr: 'error: You must be logged in to the server (Unauthorized)',
};

/** One helm release row, as `helm list -o json` prints it. */
const listed = (name: string, status: string, revision: number) =>
  json([{ name, status, revision }]);

const names = (entry: ChartEnvEntry) => entry.name;

const ran = (verb: string) => seen.some((argv) => argv.includes(verb));

afterEach(() => {
  kube.run = realRun;
});

describe('the helm release', () => {
  it('has a STATE, not a presence, so a wedged one is not reported healthy', async () => {
    // `helm list -q` lists releases in ANY status, so one stuck in pending-install was
    // reported present exactly as a healthy one, `up` went on to `upgrade --install`, and
    // helm refused that for every subsequent attempt with no path out.
    script([], listed('rocketchat', 'pending-install', 1));
    expect(await releaseState('rocketchat', 'houston-x', 'prod')).toEqual(['pending-install', 1]);
    script([], json([]));
    expect(await releaseState('rocketchat', 'houston-x', 'prod')).toEqual(['', 0]);
  });

  it('will not call a release absent when it could not ask', async () => {
    // Guessing "there is nothing there" is what would delete the record for a release that
    // exists.
    script([], REFUSED);
    await expect(releaseState('rocketchat', 'houston-x', 'prod')).rejects.toBeInstanceOf(
      DockerError,
    );
  });

  it('uninstalls a revision-1 pending release and rolls back a later one', async () => {
    // A pending-install at revision 1 never completed once, so a rollback has no target and
    // fails. That one is uninstalled instead -- nothing it created was ever serving.
    for (const state of PENDING_STATES) {
      script([], listed('rocketchat', state, 1));
      const events: Event[] = [];
      expect(
        await clearPendingRelease('rocketchat', 'houston-x', 'prod', {
          emit: (event) => events.push(event),
        }),
      ).toBe('uninstalled');
      expect(ran('uninstall')).toBe(true);
      expect(events.some((event) => event.level === 'warn')).toBe(true);
    }

    script([], listed('rocketchat', 'pending-upgrade', 4));
    expect(await clearPendingRelease('rocketchat', 'houston-x', 'prod')).toBe(
      'rolled back to revision 3',
    );
    expect(seen.find((argv) => argv.includes('rollback'))).toContain('3');
  });

  it('leaves a healthy release entirely alone', async () => {
    script([], listed('rocketchat', 'deployed', 2));
    expect(await clearPendingRelease('rocketchat', 'houston-x', 'prod')).toBe('');
    expect(ran('uninstall')).toBe(false);
    expect(ran('rollback')).toBe(false);
  });

  it('names the rollback flag for the helm that is actually installed', async () => {
    // `--atomic` DOES NOT EXIST IN HELM 4 -- it is `--rollback-on-failure` -- and a flag helm
    // does not recognise turns a working install into a broken one. PATH is pointed at a stub
    // so the assertion is about the version string and not about this box's helm.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-helm-'));
    const realPath = process.env.PATH;
    fs.writeFileSync(path.join(bin, 'helm'), '#!/bin/sh\n', { mode: 0o755 });
    process.env.PATH = bin;
    try {
      script([], { stdout: 'v4.2.3+g43e8b7f' });
      expect(await helmRollbackOnFailure()).toEqual(['--rollback-on-failure']);
      script([], { stdout: 'v3.15.2+g1a2b3c4' });
      expect(await helmRollbackOnFailure()).toEqual(['--atomic']);
      // A version string this does not parse gets NO flag: no flag is the behaviour we
      // already had, and guessing wrong costs the install itself.
      script([], { stdout: 'nothing parseable' });
      expect(await helmRollbackOnFailure()).toEqual([]);
      // And no helm at all is not a guess either.
      process.env.PATH = '';
      expect(await helmRollbackOnFailure()).toEqual([]);
    } finally {
      if (realPath === undefined) delete process.env.PATH;
      else process.env.PATH = realPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('applies a manifest on STDIN, so no temp file ever holds a secret', async () => {
    script([]);
    await apply('kind: Secret\n', { namespace: 'houston-x', context: 'prod' });
    const call = seen[0] ?? [];
    expect(call.slice(0, 8)).toEqual([
      'kubectl',
      '--context',
      'prod',
      '-n',
      'houston-x',
      'apply',
      '-f',
      '-',
    ]);
    expect(call).toContain('kind: Secret\n');

    script([], { returncode: 1, stderr: 'Error from server: forbidden' });
    await expect(
      apply('kind: Secret\n', { namespace: 'houston-x', context: 'prod' }),
    ).rejects.toBeInstanceOf(CreateFailedError);
  });
});

describe('the MongoDB operator', () => {
  const OPT_IN = 'HOUSTON_MONGO_OPERATOR';
  const saved = process.env[OPT_IN];

  afterEach(() => {
    if (saved === undefined) delete process.env[OPT_IN];
    else process.env[OPT_IN] = saved;
  });

  it('needs an explicit opt-in, and still refuses a version it cannot manage', () => {
    delete process.env[OPT_IN];
    // Opt-in until it is proven: routing 6.0+ to the operator by default replaced a verified
    // StatefulSet with a path whose PVC never bound.
    expect(operatorEnabled()).toBe(false);
    expect(operatorSupports('8.0')).toBe(false);
    // `--mongo-operator` satisfies the opt-in, and only the VERSION floor still applies:
    // silently ignoring the flag would be worse than the fallback it asks to skip.
    expect(operatorSupports('8.0', { forced: true })).toBe(true);
    expect(operatorSupports('6.0', { forced: true })).toBe(true);
    expect(operatorSupports('5.0', { forced: true })).toBe(false);
    expect(operatorSupports('4.4', { forced: true })).toBe(false);
    expect(operatorSupports('not-a-version', { forced: true })).toBe(false);

    process.env[OPT_IN] = '1';
    expect(operatorEnabled()).toBe(true);
    expect(operatorSupports('8.0')).toBe(true);
    for (const old of ['3.6', '4.4', '5.0', 'nonsense']) {
      expect([old, operatorSupports(old)]).toEqual([old, false]);
    }
    for (const current of ['6.0', '7.0', '8.0', '8.2']) {
      expect([current, operatorSupports(current)]).toEqual([current, true]);
    }
  });

  it('gives the operator a three-part version, or it never reconciles', () => {
    // Given "8.0" the operator ACCEPTS the resource and then never reconciles it, so the
    // workspace sits at no `.status.phase` until the wait gives up -- and the failure names
    // nothing, because the resource exists and the operator is healthy.
    expect(operatorVersion('8.0')).toBe('8.0.0');
    expect(operatorVersion('8')).toBe('8.0.0');
    expect(operatorVersion('8.0.4')).toBe('8.0.4');
    // And the resource carries it: a bare tag never reconciles.
    expect(
      (YAML.parse(mongodbCommunityManifest('t', '8.0')) as { spec: { version: string } }).spec
        .version,
    ).toBe('8.0.0');
  });

  it('reads ownership off the CRD, not off houston’s own release name', () => {
    // Helm stamps every resource it manages, so the CRD itself says who owns it.
    expect(
      operatorIsOurs({
        state: 'present',
        doc: {
          metadata: {
            annotations: {
              'meta.helm.sh/release-name': 'mongodb-kubernetes-operator',
              'meta.helm.sh/release-namespace': 'houston-system',
            },
          },
        },
      }),
    ).toBe(true);
    // No annotations means it was applied by something other than helm, so it is nobody's
    // release and emphatically not ours.
    expect(operatorIsOurs({ state: 'present', doc: { metadata: {} } })).toBe(false);
    expect(operatorIsOurs({ state: 'absent', doc: null })).toBe(false);
    expect(operatorIsOurs({ state: 'refused', doc: null })).toBe(false);
  });

  it('REFUSES when it cannot tell whether the cluster already has one', async () => {
    // The action on the other side of this question installs CLUSTER-SCOPED CRDs, so getting
    // it wrong on a shared cluster reaches other people's databases. This is the one place in
    // the tier where a refused read becomes a refusal rather than a best guess.
    script([], REFUSED);
    await expect(ensureOperator({ context: 'prod' })).rejects.toBeInstanceOf(PreflightError);
    await expect(ensureOperator({ context: 'prod' })).rejects.toThrow(/cluster-scoped CRDs/u);
    // It says what the cluster said, and names the permission that would fix it.
    script([], { returncode: 1, stderr: 'Error from server (Forbidden): forbidden: crds' });
    const said = (
      (await ensureOperator({ context: 'prod' }).catch((error: unknown) => error)) as Error
    ).message;
    expect(said).toContain('forbidden');
    expect(said).toContain('customresourcedefinitions');
    // And it refused before writing anything, the helm repo add included.
    expect(ran('helm')).toBe(false);
  });

  it('adopts a foreign operator that watches us, and refuses one that does not', async () => {
    const foreign = json({ metadata: { annotations: {} } });
    const watching = (scope: string) =>
      json({
        items: [
          {
            metadata: { namespace: 'mongodb-system' },
            spec: {
              template: {
                spec: { containers: [{ env: [{ name: 'WATCH_NAMESPACE', value: scope }] }] },
              },
            },
          },
        ],
      });

    script([
      [has('crd'), foreign],
      [has('deployments'), watching('*')],
    ]);
    const events: Event[] = [];
    await ensureOperator({
      context: 'prod',
      namespace: 'houston-x',
      emit: (event) => events.push(event),
    });
    expect(events.map((event) => event.message).join(' ')).toContain('adopting the MongoDB');
    // Adoption installs nothing, which is the whole of what makes it safe.
    expect(ran('upgrade')).toBe(false);

    script([
      [has('crd'), foreign],
      [has('deployments'), watching('team-a,team-b')],
    ]);
    await expect(ensureOperator({ context: 'prod', namespace: 'houston-x' })).rejects.toThrow(
      /does not include 'houston-x'/u,
    );
    // The refusal names the scope it read, and nothing was written on the way to it.
    await expect(ensureOperator({ context: 'prod', namespace: 'houston-x' })).rejects.toThrow(
      /team-a,team-b/u,
    );
    expect(ran('upgrade')).toBe(false);

    // A scope that cannot be READ still adopts -- adopting installs nothing, which is the
    // conservative action -- and says it was not read.
    script([
      [has('crd'), foreign],
      [has('deployments'), { returncode: 1, stderr: 'Error from server (Forbidden): RBAC denied' }],
    ]);
    const unread: Event[] = [];
    await ensureOperator({
      context: 'prod',
      namespace: 'houston-x',
      emit: (event) => unread.push(event),
    });
    expect(
      unread.some(
        (event) => event.message.includes('adopting') && event.message.includes('RBAC denied'),
      ),
    ).toBe(true);
    expect(ran('upgrade')).toBe(false);

    // AND IT STILL INSTALLS ITS OWN. Adoption must not become "never install", or the
    // ordinary case -- an empty cluster -- silently stops working.
    script([[has('crd'), { stdout: '' }]]);
    await ensureOperator({ context: 'prod', namespace: 'houston-x' });
    expect(ran('upgrade')).toBe(true);

    // And a CRD that is OUR OWN release is upgraded, not adopted -- every workspace after
    // the first on houston's own cluster.
    script([
      [
        has('crd'),
        json({
          metadata: {
            annotations: {
              'meta.helm.sh/release-name': OPERATOR_RELEASE,
              'meta.helm.sh/release-namespace': OPERATOR_NAMESPACE,
            },
          },
        }),
      ],
    ]);
    await ensureOperator({ context: 'prod', namespace: 'houston-x' });
    expect(ran('upgrade')).toBe(true);
  });

  it('waits for a terminating shared namespace before installing an operator for a restored workspace', async () => {
    let gone = false;
    const terminating = json({
      metadata: { name: OPERATOR_NAMESPACE, deletionTimestamp: '2026-10-10T00:00:00Z' },
      status: { phase: 'Terminating' },
    });
    script([[has('get', 'namespace', OPERATOR_NAMESPACE), terminating]]);
    const scripted = kube.run;
    kube.run = async (argv, options) => {
      if (argv.includes('wait') && argv.includes(`namespace/${OPERATOR_NAMESPACE}`)) gone = true;
      if (argv.includes('upgrade') && !gone) {
        return {
          argv,
          returncode: 1,
          stdout: '',
          stderr: 'cannot create Secret in terminating namespace',
        };
      }
      return await scripted(argv, options);
    };
    await expect(
      ensureOperator({ context: 'prod', namespace: 'houston-copy' }),
    ).resolves.toBeUndefined();
    expect(gone).toBe(true);
    expect(ran('upgrade')).toBe(true);
  });

  it('does not install the operator when its previous namespace teardown cannot finish', async () => {
    script([
      [
        has('get', 'namespace', OPERATOR_NAMESPACE),
        json({ metadata: { name: OPERATOR_NAMESPACE }, status: { phase: 'Terminating' } }),
      ],
      [
        has('wait', `namespace/${OPERATOR_NAMESPACE}`),
        { returncode: 1, stderr: 'error: deletion timed out' },
      ],
    ]);
    await expect(ensureOperator({ context: 'prod', namespace: 'houston-copy' })).rejects.toThrow(
      'houston-system has not finished its previous teardown: error: deletion timed out',
    );
    expect(ran('upgrade')).toBe(false);
  });

  it('reads a watch scope as a list, and an unset one as everything', () => {
    expect(operatorWatches('*', 'houston-x')).toBe(true);
    expect(operatorWatches('', 'houston-x')).toBe(true);
    expect(operatorWatches('houston-x,other', 'houston-x')).toBe(true);
    expect(operatorWatches('other', 'houston-x')).toBe(false);
  });

  it('reads a fieldRef scope as the operator’s own namespace, and a refusal as unreadable', async () => {
    // `WATCH_NAMESPACE` set through a fieldRef is the chart's single-namespace default. That
    // is a real answer -- own namespace only -- and reporting it as unreadable would make
    // houston adopt an operator it has just been told does not cover it.
    script([
      [
        has('deployments'),
        json({
          items: [
            {
              metadata: { namespace: 'platform' },
              spec: {
                template: {
                  spec: {
                    containers: [
                      { env: [{ name: 'WATCH_NAMESPACE', valueFrom: { fieldRef: {} } }] },
                    ],
                  },
                },
              },
            },
          ],
        }),
      ],
    ]);
    expect(await operatorWatchScope('c')).toEqual(['platform', '']);

    script([], { returncode: 1, stderr: 'denied' });
    const [scope, unreadable] = await operatorWatchScope('c');
    // A refusal is not an empty scope.
    expect(scope).toBe('');
    expect(unreadable).not.toBe('');

    expect(operatorWatches('*', 'houston-t1')).toBe(true);
    expect(operatorWatches('a,houston-t1', 'houston-t1')).toBe(true);
    expect(operatorWatches('a,b', 'houston-t1')).toBe(false);
  });

  it('will not remove the shared operator on a read it could not make', async () => {
    script([
      [has('list'), listed('mongodb-kubernetes-operator', 'deployed', 1)],
      [has('mongodbcommunity'), REFUSED],
    ]);
    const events: Event[] = [];
    expect(await removeOperator({ context: 'prod', emit: (event) => events.push(event) })).toBe(
      false,
    );
    expect(events.some((event) => event.level === 'warn')).toBe(true);
    expect(ran('uninstall')).toBe(false);
  });

  it('leaves the operator up while another workspace holds a MongoDBCommunity', async () => {
    const installed: Rule = [has('list'), listed('mongodb-kubernetes-operator', 'deployed', 1)];
    script([installed, [has('mongodbcommunity'), { stdout: 'houston-a\nhouston-b\n' }]]);
    const events: Event[] = [];
    expect(
      await removeOperator({
        context: 'prod',
        excluding: 'houston-a',
        emit: (event) => events.push(event),
      }),
    ).toBe(false);
    expect(ran('uninstall')).toBe(false);
    // And it says whose.
    expect(events.map((event) => event.message).join(' ')).toContain('still used by b');

    // The workspace being destroyed must not be counted as still needing it.
    script([installed, [has('mongodbcommunity'), { stdout: 'houston-a\n' }]]);
    expect(await removeOperator({ context: 'prod', excluding: 'houston-a' })).toBe(true);
    expect(ran('uninstall')).toBe(true);
    // The CRD is never touched -- deleting it deletes every MongoDBCommunity in the cluster,
    // every other workspace's database -- nor the namespace it shares with monitoring.
    const deletes = seen.filter((argv) => argv.includes('delete'));
    expect(deletes.some((argv) => argv.includes('crd'))).toBe(false);
    expect(deletes.some((argv) => argv.includes('namespace'))).toBe(false);

    // A cluster that never had it is not an error, and says nothing.
    script([[has('list'), json([])]]);
    expect(await removeOperator({ context: 'prod' })).toBe(false);
    expect(ran('uninstall')).toBe(false);
  });

  it('answers null rather than an empty reference count', async () => {
    script([], REFUSED);
    expect(await mongodbResources('prod')).toBeNull();
    script([], { stdout: 'houston-a\nhouston-b\nhouston-a\n' });
    expect(await mongodbResources('prod')).toEqual(['houston-a', 'houston-b']);
  });

  it('builds an authenticated URL with authSource on BOTH forms', () => {
    // The oplog URL addresses the `local` database but the user is defined in the app
    // database, so without authSource the driver authenticated against `local` and looked for
    // a user that has never existed there.
    const app = operatorMongoUrl('houston-x', 'sekrit');
    const oplog = operatorMongoUrl('houston-x', 'sekrit', { oplog: true });
    expect(app).toContain('/rocketchat?replicaSet=mongodb&authSource=rocketchat');
    expect(oplog).toContain('/local?replicaSet=mongodb&authSource=rocketchat');
    // The operator names its service `<name>-svc`, not `<name>`.
    expect(app).toContain('mongodb-0.mongodb-svc.houston-x.svc.cluster.local:27017');
    // It carries the credentials, and names the replica set the operator builds.
    expect(app).toContain('rocketchat:sekrit@');
    expect(app).toContain('replicaSet=mongodb');
  });

  it('writes manifests whose owner labels survive a YAML 1.1 reader', () => {
    // `yes`, `no`, `on`, `off` and `y` are BOOLEANS in YAML 1.1, which is what Kubernetes
    // parses; an unquoted one is a label value the apply rejects for not being a string.
    for (const [owner, manifest] of [
      ['yes', mongoRbacManifest('ws', { owner: 'yes' })],
      ['no', mongoSecretManifest('ws', { adminPassword: 'x', appPassword: 'y', owner: 'no' })],
      ['off', mongodbCommunityManifest('ws', '8.0', { owner: 'off' })],
      ['y', regTokenSecretManifest('ws', { token: '0755', owner: 'y' })],
    ] as [string, string][]) {
      const docs = YAML.parseAllDocuments(manifest).map(
        (doc) => doc.toJS() as Record<string, unknown>,
      );
      expect(docs.length).toBeGreaterThan(0);
      for (const doc of docs) {
        const labels = ((doc.metadata as { labels?: Record<string, unknown> }).labels ??
          {}) as Record<string, unknown>;
        expect(labels[OWNER_LABEL_KEY]).toBe('houston');
        expect(labels[OWNER_OF_LABEL]).toBe(owner);
      }
    }
    // And the same for a secret VALUE that YAML 1.1 would read as octal.
    const secret = YAML.parse(regTokenSecretManifest('ws', { token: '0755' })) as {
      stringData: Record<string, unknown>;
    };
    expect(secret.stringData.token).toBe('0755');
  });

  it('gives the operator BOTH volume claims, because the override replaces the list', () => {
    // Overriding volumeClaimTemplates REPLACES the operator's list rather than merging with
    // it, while both of the pod's containers mount both volumes -- so a list that drops one
    // leaves the pod referencing a claim nothing creates, and it never schedules.
    const doc = YAML.parse(mongodbCommunityManifest('ws', '8.0')) as {
      spec: { statefulSet: { spec: { volumeClaimTemplates: { metadata: { name: string } }[] } } };
    };
    expect(
      doc.spec.statefulSet.spec.volumeClaimTemplates.map((entry) => entry.metadata.name),
    ).toEqual(['data-volume', 'logs-volume']);
  });

  it("lifts the mongod container above the operator's 500M, where the backup tools run", () => {
    // mongodump runs inside `-c mongod`, under its limit: a backup seconds after a re-up had
    // the container OOMKilled, which crash-looped Rocket.Chat too. The hand-written
    // StatefulSet's values, which run the same tools in the same place.
    const doc = YAML.parse(mongodbCommunityManifest('ws', '8.0')) as {
      spec: {
        statefulSet: {
          spec: {
            template?: {
              spec: { containers: { name: string; resources: Record<string, unknown> }[] };
            };
          };
        };
      };
    };
    const containers = doc.spec.statefulSet.spec.template?.spec.containers ?? [];
    expect(containers.map((container) => container.name)).toEqual(['mongod']);
    expect(containers[0]?.resources).toEqual({
      requests: { cpu: '100m', memory: '256Mi' },
      limits: { memory: '2Gi' },
    });
  });

  it('grants clusterMonitor, which is what makes the oplog URL work', () => {
    // readWrite on the app database alone cannot read `local`, so Rocket.Chat below 8.x --
    // the only versions that still tail the oplog -- authenticated and then failed to tail.
    const doc = YAML.parse(mongodbCommunityManifest('ws', '8.0')) as {
      spec: { users: { name: string; roles: { name: string }[] }[] };
    };
    const app = doc.spec.users.find((user) => user.name === 'rocketchat');
    expect(app?.roles.map((role) => role.name)).toEqual(['readWrite', 'clusterMonitor']);
    // On the databases the roles live in: readWrite on the app database cannot read `local`.
    expect(
      (app?.roles as unknown as { name: string; db: string }[]).map((role) => role.db),
    ).toEqual([MONGO_APP_DB, 'admin']);
  });
});

describe('the chart', () => {
  const INDEX = [
    { version: '7.0.2', app_version: '8.6.1' },
    { version: '6.26.0', app_version: '7.10.0' },
    { version: '6.23.2', app_version: '7.4.0' },
    { version: '3.0.0', app_version: '6.0.0' },
    { version: '0.1.0', app_version: '1.16.0' },
  ];

  it('never picks a chart newer than the app it deploys', () => {
    expect(bestChartAtOrBelow(INDEX, '7.10.0')).toBe('6.26.0'); // an exact appVersion
    expect(bestChartAtOrBelow(INDEX, '7.5.0')).toBe('6.23.2'); // the floor below it
    expect(bestChartAtOrBelow(INDEX, '9.0.0')).toBe('7.0.2'); // newer than every chart
  });

  it('refuses a version whose only chart is from another era', () => {
    // Below chart 3.0.0's appVersion there is exactly ONE chart in the live index -- 0.1.0,
    // appVersion 1.16.0 -- so the floor rule lands there and it predates every values key
    // houston sets. It would install something, and not what was asked for.
    expect(() => bestChartAtOrBelow(INDEX, '2.0.0')).toThrow(ValidationError);
    expect(() => bestChartAtOrBelow(INDEX, '2.0.0')).toThrow(/predates every values key/u);
    // Older than EVERY chart is the other end, and it used to fall back to the NEWEST:
    // measured, RC 1.0.0 resolved to chart 7.0.2, which deploys 8.6.1.
    expect(() => bestChartAtOrBelow(INDEX, '1.0.0')).toThrow(/no chart deploys it/u);
  });

  it('refuses a URL where the chart wants a bare hostname', () => {
    // The chart renders `value: https://{{ .Values.host }}`, so it CONCATENATES: a full URL
    // here rendered `ROOT_URL = https://http://localhost:32812`.
    const base = { rcVersion: '8.5.1', rcImage: 'rc', microservices: false };
    expect(() => valuesFor({ ...base, host: 'http://x' })).toThrow(ValidationError);
    expect(() => valuesFor({ ...base, host: 'x:443' })).toThrow(/bare hostname/u);
    // And never both, because two entries for one variable is an apply conflict.
    expect(() => valuesFor({ ...base, host: 'x.test', rootUrl: 'https://x.test' })).toThrow(
      /never both/u,
    );
  });

  it('sets ROOT_URL only where the chart will not, and never repeats a chart’s own key', () => {
    const base = { rcVersion: '8.5.1', rcImage: 'rc', microservices: false };
    const withUrl = valuesFor({ ...base, rootUrl: 'http://localhost:3000' });
    expect(
      (withUrl.extraEnv as ChartEnvEntry[]).find((entry) => entry.name === 'ROOT_URL')?.value,
    ).toBe('http://localhost:3000');
    // A port-forward workspace has no ingress host.
    expect('host' in withUrl).toBe(false);
    // With a `host` the chart writes ROOT_URL itself, and a second entry is a
    // duplicate-key apply failure rather than a win.
    const withHost = valuesFor({ ...base, host: 'x.test' });
    expect((withHost.extraEnv as ChartEnvEntry[]).map(names)).not.toContain('ROOT_URL');
    expect(withHost.host).toBe('x.test');
    // DEPLOY_METHOD and DEPLOY_PLATFORM are the chart's own, and were here for one commit:
    // "server-side apply failed ... duplicate entries for key [name=DEPLOY_PLATFORM]".
    for (const key of ['DEPLOY_METHOD', 'DEPLOY_PLATFORM']) {
      expect((withHost.extraEnv as ChartEnvEntry[]).map(names)).not.toContain(key);
    }
  });

  it('passes the registration token by reference, never as a literal value', () => {
    // `helm get values rocketchat` prints values in full to anyone who can read the
    // namespace, and houston also writes them to the workspace directory for a human.
    const values = valuesFor({
      rcVersion: '8.5.1',
      rcImage: 'rc',
      microservices: false,
      regTokenSecret: 'houston-reg-token',
    });
    const entry = (values.extraEnv as ChartEnvEntry[]).find((each) => each.name === 'REG_TOKEN');
    expect(entry?.valueFrom).toEqual({
      secretKeyRef: { name: 'houston-reg-token', key: 'token' },
    });
    expect(entry?.value).toBeUndefined();
  });

  it('turns NATS off for a monolith, because nothing would talk to it', () => {
    // The chart defaults it on independently of microservices, so `--deployment monolith` ran
    // a 3-pod NATS cluster that nothing used.
    const base = { rcVersion: '8.5.1', rcImage: 'rc' };
    expect(
      (valuesFor({ ...base, microservices: false }).nats as { enabled: boolean }).enabled,
    ).toBe(false);
    expect((valuesFor({ ...base, microservices: true }).nats as { enabled: boolean }).enabled).toBe(
      true,
    );
    // The cluster NAME stays either way: it is what the chart's own values call it.
    const clusterName = (microservices: boolean) =>
      (valuesFor({ ...base, microservices }).nats as { cluster: { name: string } }).cluster.name;
    expect(clusterName(false)).toBe(clusterName(true));
  });

  it('always keeps MongoDB external', () => {
    // The bundled path is Bitnami, which publishes amd64-only images, and chart 7.0.2
    // defaults MongoDB to 6.0.10 while declaring appVersion 8.6.1 -- which Rocket.Chat 8.6.1
    // rejects outright.
    const values = valuesFor({ rcVersion: '8.5.1', rcImage: 'rc', microservices: false });
    expect((values.mongodb as { enabled: boolean }).enabled).toBe(false);
  });

  it('lets a preset override a base default rather than the other way round', () => {
    const env = chartEnv('pw', '', { ADMIN_PASS: 'from-the-preset' }, '', '');
    expect(env.filter((entry) => entry.name === 'ADMIN_PASS').at(-1)?.value).toBe(
      'from-the-preset',
    );
  });

  it('holds each variable ONCE: base < preset < override, and a null override removes it', () => {
    // Appending gave `extraEnv` a second ADMIN_PASS whenever a preset or `up --env` named
    // one, and two entries for one name is a server-side-apply refusal, not an override.
    const env = chartEnv(
      'pw',
      '',
      { ADMIN_PASS: 'from-the-preset', OVERWRITE_SETTING_Site_Name: 'Preset' },
      '',
      '',
      { OVERWRITE_SETTING_Site_Name: 'Override', ADMIN_EMAIL: null, EXTRA: 'x' },
    );
    const names = env.map((entry) => entry.name);
    expect(names.length).toBe(new Set(names).size);
    const got = Object.fromEntries(env.map((entry) => [entry.name, entry.value]));
    expect(got).toMatchObject({
      ADMIN_PASS: 'from-the-preset',
      OVERWRITE_SETTING_Site_Name: 'Override',
      EXTRA: 'x',
    });
    expect('ADMIN_EMAIL' in got).toBe(false);
  });

  it('references the licence Secret, never the licence', () => {
    const env = chartEnv('pw', '', {}, '', '', {}, true);
    expect(env.find((entry) => entry.name === 'ROCKETCHAT_LICENSE')).toEqual({
      name: 'ROCKETCHAT_LICENSE',
      valueFrom: { secretKeyRef: { name: 'houston-license', key: 'license' } },
    });
    expect(
      chartEnv('pw', '', {}, '', '').some((entry) => entry.name === 'ROCKETCHAT_LICENSE'),
    ).toBe(false);
  });

  it('pulls a CI build every time, with its microservices from ghcr', () => {
    const build = valuesFor({
      rcVersion: '8.10.0.dev0',
      rcImage: 'ghcr.io/rocketchat/rocket.chat:develop',
      microservices: true,
    });
    expect(build.image).toEqual({
      repository: 'ghcr.io/rocketchat/rocket.chat',
      tag: 'develop',
      pullPolicy: 'Always',
    });
    const ms = build.microservices as Record<
      string,
      { image?: { repository: string; pullPolicy: string }; enabled?: boolean }
    >;
    expect(ms.ddpStreamer?.image).toEqual({
      repository: 'ghcr.io/rocketchat/ddp-streamer-service',
      pullPolicy: 'Always',
    });
    expect(ms.streamHub).toEqual({ enabled: false });
    // A release is untouched.
    const release = valuesFor({
      rcVersion: '8.5.1',
      rcImage: 'registry.rocket.chat/rocketchat/rocket.chat',
      microservices: true,
    });
    expect(release.microservices).toEqual({ enabled: true });
    expect((release.image as { pullPolicy: string }).pullPolicy).toBe('IfNotPresent');
  });

  it('refuses an override of a variable the chart writes itself, naming what to use', () => {
    expect(() => refuseChartOwnedEnv({ ROOT_URL: 'http://x' })).toThrow(/use --root-url/u);
    expect(() => refuseChartOwnedEnv({ DEPLOY_METHOD: 'x' })).toThrow(ValidationError);
    expect(() => refuseChartOwnedEnv({ OVERWRITE_SETTING_Prometheus_Enabled: 'false' })).toThrow(
      /server-side-apply conflict/u,
    );
    expect(() =>
      refuseChartOwnedEnv({ ADMIN_PASS: 'x', OVERWRITE_SETTING_Site_Name: 'y' }),
    ).not.toThrow();
  });

  it("writes a user preset's env as the text earlier releases give what its YAML holds", () => {
    // Earlier releases write each value as their own text of it, the same conversion their
    // compose writer makes: `String` wrote `true`, `null`, `Infinity`, `[object Object]`, a
    // rounded int past 2**53 and a date in the box's time zone where earlier releases write
    // `True`, `None`, `inf`, `{'a': 1}`, the digits and `2026-01-01`.
    const document = [
      'name: mine',
      'env:',
      '  FLAG: true',
      '  NOTHING: null',
      '  BIG: 12345678901234567890',
      '  FLOAT: 1.0',
      '  INF: .inf',
      '  DATE: 2026-01-01',
      '  NESTED: {a: 1, 1: b}',
      '  LIST: [1, 2.0, x]',
      '  PLAIN: text',
      '',
    ].join('\n');
    fs.mkdirSync(presetDir(), { recursive: true });
    fs.writeFileSync(path.join(presetDir(), 'mine.yaml'), document, 'utf8');
    // What earlier releases wrote as the chart env for the same preset, recorded.
    const recorded: ChartEnvEntry[] = [
      { name: 'OVERWRITE_SETTING_Show_Setup_Wizard', value: 'completed' },
      { name: 'ADMIN_USERNAME', value: 'admin' },
      { name: 'ADMIN_NAME', value: 'Admin' },
      { name: 'ADMIN_EMAIL', value: 'admin@example.com' },
      { name: 'ADMIN_PASS', value: 'pw' },
      { name: 'ALLOW_UNSAFE_QUERY_AND_FIELDS_API_PARAMS', value: 'false' },
      { name: 'FLAG', value: 'True' },
      { name: 'NOTHING', value: 'None' },
      { name: 'BIG', value: '12345678901234567890' },
      { name: 'FLOAT', value: '1.0' },
      { name: 'INF', value: 'inf' },
      { name: 'DATE', value: '2026-01-01' },
      { name: 'NESTED', value: "{'a': 1, 1: 'b'}" },
      { name: 'LIST', value: "[1, 2.0, 'x']" },
      { name: 'PLAIN', value: 'text' },
    ];
    expect(chartEnv('pw', '', loadPreset('mine', {}).env, '', '')).toEqual(recorded);
    expect(recorded.find((entry) => entry.name === 'FLAG')?.value).toBe('True');
  });
});

describe('cert-manager and the ingress', () => {
  it('is keyed on the CRD, because the release can be named anything', async () => {
    script([], {
      stdout: 'customresourcedefinition.apiextensions.k8s.io/certificates.cert-manager.io\n',
    });
    expect(await certManagerInstalled('prod')).toBe(true);
    script([], { returncode: 1 });
    expect(await certManagerInstalled('prod')).toBe(false);
  });

  it('will not install six CRDs into somebody else’s cluster uninvited', async () => {
    // Six CRDs and an admission webhook change what a cluster IS, for every workload in it --
    // not something to do to somebody else's ON THE WAY TO booting a repro.
    script([
      [has('crd'), { returncode: 1 }],
      [has('nodes'), { stdout: 'aws://eu-west-1/i-1 v1.30.0 m5.large ip-10-0-0-1' }],
    ]);
    await expect(ensureCertManager({ context: 'prod' })).rejects.toBeInstanceOf(PreflightError);
    expect(ran('apply')).toBe(false);
    // Named as the guide's own one-line prerequisite, so the refusal is actionable.
    const said = (
      (await ensureCertManager({ context: 'prod' }).catch((error: unknown) => error)) as Error
    ).message;
    expect(said).toContain('kubectl apply -f');
    expect(said).toContain('cert-manager.yaml');
    expect(said).toContain('not on this machine');
    // And it says what would change the answer.
    expect(said).toContain('adopts it as soon as it');
    // Unknown locality must not read as local.
    script([], { returncode: 1 });
    await expect(ensureCertManager({ context: 'prod', distribution: '' })).rejects.toBeInstanceOf(
      PreflightError,
    );
    expect(ran('apply')).toBe(false);
  });

  it('builds the ACME issuer as a DOCUMENT, so an email cannot add keys to it', () => {
    // This was a template string and `acmeEmail` is caller-supplied, so an address carrying
    // newlines added its own keys to `spec.acme` and the result was valid YAML cert-manager
    // accepts. A ClusterIssuer is CLUSTER-SCOPED, so `skipTLSVerify: true` injected here
    // would apply to every workspace on the box.
    const manifest = acmeIssuerManifest(
      { mode: 'acme', acmeEmail: 'a@b.test\n    skipTLSVerify: true' },
      { ingressClass: 'traefik' },
    );
    const doc = YAML.parse(manifest) as {
      kind: string;
      apiVersion: string;
      spec: { acme: Record<string, unknown> };
    };
    expect(doc.spec.acme.email).toBe('a@b.test\n    skipTLSVerify: true');
    expect('skipTLSVerify' in doc.spec.acme).toBe(false);
    // Exactly the four keys the issuer has: pre-fix a hostile address rendered six.
    expect(Object.keys(doc.spec.acme).sort()).toEqual(
      ['email', 'privateKeySecretRef', 'server', 'solvers'].sort(),
    );
    expect([doc.kind, doc.apiVersion]).toEqual(['ClusterIssuer', 'cert-manager.io/v1']);
    // http01, and not tls-alpn, because cert-manager does not implement tls-alpn at all.
    expect(doc.spec.acme.solvers).toEqual([
      { http01: { ingress: { ingressClassName: 'traefik' } } },
    ]);
  });

  it('keeps the staging and production issuers apart by NAME', () => {
    // `privateKeySecretRef` holds the ACME account key, and pointing a production order at a
    // staging account fails in a way that names neither.
    expect(issuerName({ mode: 'acme' })).toBe('houston-acme');
    expect(issuerName({ mode: 'acme', acmeStaging: true })).toBe('houston-acme-staging');
    expect(issuerName({ mode: 'local' })).toBe('houston-ca');
  });

  it('puts the CA in as a Secret plus a ClusterIssuer that signs from it', () => {
    const docs = YAML.parseAllDocuments(caIssuerManifest('CERT-PEM', 'KEY-PEM')).map(
      (doc) => doc.toJS() as Record<string, unknown>,
    );
    const secret = docs.find((doc) => doc.kind === 'Secret') as Record<string, unknown>;
    const issuer = docs.find((doc) => doc.kind === 'ClusterIssuer') as Record<string, unknown>;
    expect(secret.type).toBe('kubernetes.io/tls');
    expect((secret.stringData as Record<string, string>)['tls.crt']?.trim()).toBe('CERT-PEM');
    // cert-manager reads exactly these two keys...
    expect(Object.keys(secret.stringData as object).sort()).toEqual(['tls.crt', 'tls.key']);
    // ...from the cluster-resource namespace, which is where a ClusterIssuer looks.
    expect((secret.metadata as { namespace: string }).namespace).toBe('cert-manager');
    expect((issuer.spec as { ca: { secretName: string } }).ca.secretName).toBe('houston-ca');
    expect((issuer.spec as { ca: { secretName: string } }).ca.secretName).toBe(
      (secret.metadata as { name: string }).name,
    );
    // Labelled as ours, so it can be told from a cluster's own issuers.
    expect((issuer.metadata as { labels: Record<string, string> }).labels[OWNER_LABEL_KEY]).toBe(
      'houston',
    );
  });

  it('adopts the cluster’s ingress class rather than installing over it', async () => {
    // The ingress controller is the component a support case is usually ABOUT, so a cluster
    // that already runs nginx must keep running nginx. Installing Traefik over the top would
    // reproduce the wrong thing in exactly the dimension that matters.
    script([], json({ items: [{ metadata: { name: 'nginx' } }] }));
    expect(await ensureIngress({ context: 'prod' })).toBe('nginx');
    expect(ran('upgrade')).toBe(false);
  });

  it('refuses a class the operator named that the cluster does not have', async () => {
    // Somebody who passes `--ingress-class alb` and gets nginx has been overruled without
    // being told.
    script([], json({ items: [{ metadata: { name: 'nginx' } }] }));
    await expect(ensureIngress({ context: 'prod', prefer: 'alb' })).rejects.toBeInstanceOf(
      PreflightError,
    );
    expect(await ensureIngress({ context: 'prod', prefer: 'nginx' })).toBe('nginx');
  });

  it('will not guess when it cannot read the classes at all', async () => {
    script([], REFUSED);
    await expect(ensureIngress({ context: 'prod' })).rejects.toBeInstanceOf(DockerError);
    await expect(ensureIngress({ context: 'prod' })).rejects.toThrow(/refusing to guess/u);
    // Reading a refused list as "no controller" would install one over a credential problem.
    expect(ran('upgrade')).toBe(false);
  });

  it('will not provision a billable load balancer in somebody’s account', async () => {
    // The chart's Service is a LoadBalancer by default, and on a managed cluster that
    // provisions a real one -- created implicitly, in somebody's account.
    script([
      [has('ingressclass'), json({ items: [] })],
      [has('nodes'), { stdout: 'aws://eu-west-1/i-1 v1.30.0 m5.large ip-10-0-0-1' }],
    ]);
    await expect(ensureIngress({ context: 'prod' })).rejects.toThrow(/LoadBalancer/u);
    expect(ran('upgrade')).toBe(false);
  });

  it('waits for the CLASS after installing, not just for the release', async () => {
    // helm returning means the Deployment is ready; the IngressClass is a separate object the
    // chart creates, so a create that read the classes straight afterwards found none and
    // refused for want of the thing it had just installed.
    let installed = false;
    script([]);
    const inner = kube.run;
    kube.run = (argv, options) => {
      if (argv.includes('upgrade')) installed = true;
      if (argv.includes('ingressclass')) {
        return Promise.resolve({
          argv,
          returncode: 0,
          stdout: JSON.stringify({ items: installed ? [{ metadata: { name: 'traefik' } }] : [] }),
          stderr: '',
        });
      }
      return inner(argv, options);
    };
    expect(
      await ensureIngress({
        context: 'prod',
        distribution: 'kind',
        sleep: () => Promise.resolve(),
      }),
    ).toBe('traefik');
    expect(ran('upgrade')).toBe(true);
  });

  it('writes the guide’s ingress block, and names the issuer in it', () => {
    expect(
      ingressValues('rc.example.test', {
        ingressClass: 'traefik',
        secretName: 'rc-tls',
        issuer: 'houston-acme',
      }),
    ).toEqual({
      host: 'rc.example.test',
      ingress: {
        enabled: true,
        ingressClassName: 'traefik',
        annotations: { 'cert-manager.io/cluster-issuer': 'houston-acme' },
        tls: [{ secretName: 'rc-tls', hosts: ['rc.example.test'] }],
      },
    });
    // With no issuer named it is houston's own CA -- a customer's values.yaml and houston's
    // differ only in the issuer NAME.
    expect(
      (
        ingressValues('ws.houston.localhost', { ingressClass: 'traefik', secretName: 'ws-tls' })
          .ingress as { annotations: Record<string, string> }
      ).annotations,
    ).toEqual({ 'cert-manager.io/cluster-issuer': CA_ISSUER });
  });
});

describe('the shared monitoring stack', () => {
  it('treats a pending release as "not installed", because it is', async () => {
    // `helm status` exits 0 for a release in any state, so this returned true for a namespace
    // holding no Prometheus and no Grafana: the install was skipped and `monitor` reported the
    // stack attached. The dashboards did not exist.
    script([], listed('monitoring', 'pending-install', 1));
    expect(await monitoringInstalled('prod')).toBe(false);
    script([], listed('monitoring', 'deployed', 1));
    expect(await monitoringInstalled('prod')).toBe(true);
    for (const state of ['pending-upgrade', 'failed']) {
      script([], listed('monitoring', state, 1));
      expect([state, await monitoringInstalled('prod')]).toEqual([state, false]);
    }
    // Absent is absent.
    script([], json([]));
    expect(await monitoringInstalled('prod')).toBe(false);
    // Could not ask is not "installed" either: the next step is an idempotent `upgrade
    // --install`, which is the safer way to be wrong.
    script([], REFUSED);
    expect(await monitoringInstalled('prod')).toBe(false);
  });

  it('answers null for a label it could not read, not false', async () => {
    // false here means "this workspace does not want monitoring", which is the INNER test of
    // the reference count -- so an unreadable namespace would uninstall a stack another
    // workspace is using.
    script([], REFUSED);
    expect(await monitoringWanted('houston-a', { context: 'prod' })).toBeNull();
    script([], json({ metadata: { labels: { 'houston.io/monitoring': 'true' } } }));
    expect(await monitoringWanted('houston-a', { context: 'prod' })).toBe(true);
    script([], json({ metadata: { labels: {} } }));
    expect(await monitoringWanted('houston-a', { context: 'prod' })).toBe(false);
    // A namespace that is GONE does not want it, and that is a real answer.
    script([], { stdout: '' });
    expect(await monitoringWanted('houston-a', { context: 'prod' })).toBe(false);
  });

  it('reports nothing rather than announcing wreckage that does not exist', async () => {
    // `monitor --off` on a workspace that never had monitoring ran the uninstall anyway, helm
    // answered "release: not found", and the fallback announced that "the monitoring stack
    // needed its finalizers cleared by hand".
    script([], json([]));
    const events: Event[] = [];
    expect(await removeMonitoring({ context: 'prod', emit: (event) => events.push(event) })).toBe(
      false,
    );
    expect(events).toEqual([]);
    expect(ran('uninstall')).toBe(false);
  });

  it('leaves the stack up while another workspace still wants it', async () => {
    script(
      [
        [has('list'), listed('monitoring', 'deployed', 1)],
        [
          has('-l'),
          json({
            items: [{ metadata: { name: 'houston-a' } }, { metadata: { name: 'houston-b' } }],
          }),
        ],
        [
          (argv) => argv.includes('houston-b'),
          json({ metadata: { labels: { 'houston.io/monitoring': 'true' } } }),
        ],
      ],
      json({ metadata: { labels: {} } }),
    );
    const events: Event[] = [];
    expect(
      await removeMonitoring({
        context: 'prod',
        excluding: 'houston-a',
        emit: (event) => events.push(event),
      }),
    ).toBe(false);
    expect(events.map((event) => event.message).join(' ')).toContain('still used by b');
    expect(ran('uninstall')).toBe(false);

    // And when nobody else wants it, it goes -- or the shared stack could never be reclaimed.
    script(
      [
        [has('list'), listed('monitoring', 'deployed', 1)],
        [
          has('-l'),
          json({
            items: [{ metadata: { name: 'houston-a' } }, { metadata: { name: 'houston-b' } }],
          }),
        ],
      ],
      json({ metadata: { labels: {} } }),
    );
    expect(await removeMonitoring({ context: 'prod', excluding: 'houston-a' })).toBe(true);
    expect(ran('uninstall')).toBe(true);
  });

  it('will not uninstall the stack on a namespace list it could not read', async () => {
    script([[has('list'), listed('monitoring', 'deployed', 1)]], REFUSED);
    const events: Event[] = [];
    expect(await removeMonitoring({ context: 'prod', emit: (event) => events.push(event) })).toBe(
      false,
    );
    expect(events.some((event) => event.level === 'warn')).toBe(true);
    expect(ran('uninstall')).toBe(false);
  });
});

describe('the port-forward', () => {
  it('is identified by its own argv, not merely by being alive', async () => {
    // A recycled pid belonging to a different workspace's forward -- or another user's, on a
    // shared box -- passed a liveness check dressed as an identity check.
    expect(await forwardAlive(0)).toBe(false);
    expect(await forwardAlive(null)).toBe(false);
    // This process is not a port-forward, whatever its pid is.
    expect(await forwardAlive(process.pid, { namespace: 'houston-x', hostPort: 3000 })).toBe(false);
  });

  it('parses a scenario publication row, and rejects a malformed one', () => {
    expect(listedService('keycloak 8081 8080 keycloak-deploy')).toEqual([
      'keycloak',
      8081,
      8080,
      'keycloak-deploy',
    ]);
    // Three fields means the deployment is named like the service.
    expect(listedService('keycloak 8081 8080')).toEqual(['keycloak', 8081, 8080, 'keycloak']);
    expect(listedService('')).toBeNull();
    expect(listedService('keycloak not-a-port 8080')).toBeNull();
    expect(listedService('a b c d e')).toBeNull();
  });
});

describe('cert-manager, adopted or installed like the ingress', () => {
  const realTries = tuning.CERT_MANAGER_TRIES;
  const realWebhookTries = tuning.CERT_MANAGER_WEBHOOK_TRIES;
  afterEach(() => {
    tuning.CERT_MANAGER_TRIES = realTries;
    tuning.CERT_MANAGER_WEBHOOK_TRIES = realWebhookTries;
  });
  /**
   * What the API server answered the ClusterIssuer apply on a k3s playground,
   * straight after "installed and answering": the webhook pod Ready, its CA bundle not yet
   * injected. The same answer earlier releases' tests were given.
   */
  const X509 =
    'Error from server (InternalError): error when creating "STDIN": Internal error ' +
    'occurred: failed calling webhook "webhook.cert-manager.io": failed to call webhook: ' +
    'Post "https://cert-manager-webhook.cert-manager.svc:443/validate?timeout=30s": tls: ' +
    'failed to verify certificate: x509: certificate signed by unknown authority';

  it('adopts one already there, and installs the guide’s manifest by kubectl otherwise', async () => {
    // The guide lists cert-manager as a prerequisite AND gives the command, so houston runs
    // the documented step. Installed BY KUBECTL as the guide does it, and that is
    // load-bearing: the static manifest has no startupapicheck Job, so no post-install hook
    // can fail and the `crds.enabled`-versus-`installCRDs` trap has nowhere to happen.
    script([], {
      stdout: 'customresourcedefinition.apiextensions.k8s.io/certificates.cert-manager.io\n',
    });
    await ensureCertManager({ context: 'c', distribution: 'k3s' });
    // Nothing is applied over a cert-manager already installed: the CRD was the one question.
    expect(seen.every((argv) => argv.includes('crd'))).toBe(true);

    // Absent on a local cluster: applied, then waited for.
    let asked = 0;
    script([]);
    kube.run = (argv, options) => {
      seen.push([...argv, ...(options?.input === undefined ? [] : ['<stdin>', options.input])]);
      const crd = argv.includes('crd');
      if (crd) asked += 1;
      return Promise.resolve({
        argv,
        returncode: crd && asked === 1 ? 1 : 0,
        stdout: crd && asked > 1 ? 'certificates.cert-manager.io' : '',
        stderr: '',
      });
    };
    await ensureCertManager({ context: 'c', distribution: 'kind', sleep: () => Promise.resolve() });
    const applied = seen.find((argv) => argv.includes('apply')) ?? [];
    expect(applied.slice(0, 2)).toEqual(['kubectl', '--context']);
    expect(applied.some((arg) => arg.endsWith('cert-manager.yaml'))).toBe(true);
    expect(applied.some((arg) => arg.includes('helm'))).toBe(false); // the guide uses kubectl
    // The WEBHOOK, not just the apply: an issuer created before it serves is accepted and
    // then never reconciled.
    expect(seen.filter((argv) => argv.includes('rollout'))).toHaveLength(
      CERT_MANAGER_DEPLOYMENTS.length,
    );
  });

  it('fails a cert-manager that was applied and never answered', async () => {
    // `kubectl apply` returns as soon as the objects are accepted; what matters is whether
    // the cluster can issue a Certificate, which is the CRD being there.
    tuning.CERT_MANAGER_TRIES = 2;
    script([[has('crd'), { returncode: 1 }]]);
    const failed = await ensureCertManager({
      context: 'c',
      distribution: 'kind',
      sleep: () => Promise.resolve(),
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(CreateFailedError);
    expect((failed as Error).message).toContain('CRDs never appeared');
  });

  it('says it is answering only once the webhook accepts an object, and fails one that never does', async () => {
    // "installed and answering" was said after the three rollouts and the CRD, and the very
    // next create -- the ClusterIssuer -- failed with `failed calling webhook
    // "webhook.cert-manager.io" ... x509`: the webhook pod Ready, cainjector not yet done.
    // MEASURED on a k3s playground, earlier releases included (exit 7), whenever the
    // images were cached.
    const said: string[] = [];
    const inputs: string[] = [];
    let crd = 0;
    let dry = 0;
    let failing = 2;
    seen = [];
    kube.run = (argv, options) => {
      seen.push([...argv]);
      if (argv.includes('crd')) {
        crd += 1;
        return Promise.resolve({
          argv,
          returncode: 0,
          stdout: crd > 1 ? 'certificates.cert-manager.io' : '',
          stderr: '',
        });
      }
      if (argv.includes('--dry-run=server')) {
        dry += 1;
        said.push(`dry-run ${String(dry)}`);
        inputs.push(options?.input ?? '');
        const fails = dry <= failing;
        return Promise.resolve({
          argv,
          returncode: fails ? 1 : 0,
          stdout: '',
          stderr: fails ? X509 : '',
        });
      }
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    const emit = (event: Event): void => {
      said.push(event.message);
    };
    await ensureCertManager({
      context: 'c',
      distribution: 'kind',
      sleep: () => Promise.resolve(),
      emit,
    });
    expect(said.slice(1)).toEqual([
      'dry-run 1',
      'dry-run 2',
      'dry-run 3',
      'cert-manager: installed and answering',
    ]);
    for (const manifest of inputs) {
      expect(manifest).toContain('kind: ClusterIssuer');
      expect(manifest).not.toContain('tls.key'); // a dry-run needs no private key
    }

    // One that never answers: refused, naming the webhook, and never called answering.
    said.length = 0;
    crd = 0;
    dry = 0;
    failing = 99;
    tuning.CERT_MANAGER_WEBHOOK_TRIES = 2;
    const failed = await ensureCertManager({
      context: 'c',
      distribution: 'kind',
      sleep: () => Promise.resolve(),
      emit,
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(CreateFailedError);
    expect((failed as Error).message).toBe(
      "cert-manager's webhook in 'c' never accepted an object, so nothing can create an " +
        `issuer or a Certificate there: ${X509}. \`kubectl --context c -n cert-manager logs ` +
        'deploy/cert-manager-webhook`, and `kubectl --context c get ' +
        'validatingwebhookconfiguration cert-manager-webhook -o yaml` for its caBundle.',
    );
    expect(dry).toBe(2);
    expect(said).not.toContain('cert-manager: installed and answering');
  });

  it('waits out the leader lease a removed cert-manager leaves: 25 refusals, then answering', async () => {
    // The third live run: `up --https` and `cluster prepare` exited 7, earlier releases too, the
    // webhook refusing every one of the wait's 20 dry-runs with the x509 error. cert-manager's
    // leader-election Leases are not in its manifest and outlive `kubectl delete -f` of it,
    // and a new cainjector waits a full lease duration (60 s) after it first sees one before it
    // injects the CA bundle. MEASURED on the playground: the webhook first accepted the dry-run
    // at +89 s, where the wait, borrowing the CRD wait's 20 x 3 s, had given up at 60 s. The
    // webhook now has its own bound, 180 s like the rollouts; the 26th dry-run is the measured
    // count at 3 s apart. The same fake earlier releases' tests used.
    const said: string[] = [];
    const slept: number[] = [];
    let crd = 0;
    let dry = 0;
    kube.run = (argv) => {
      if (argv.includes('crd')) {
        crd += 1;
        return Promise.resolve({
          argv,
          returncode: 0,
          stdout: crd > 1 ? 'certificates.cert-manager.io' : '',
          stderr: '',
        });
      }
      if (argv.includes('--dry-run=server')) {
        dry += 1;
        const refused = dry <= 25;
        return Promise.resolve({
          argv,
          returncode: refused ? 1 : 0,
          stdout: '',
          stderr: refused ? X509 : '',
        });
      }
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    await ensureCertManager({
      context: 'c',
      distribution: 'kind',
      sleep: (seconds) => {
        slept.push(seconds);
        return Promise.resolve();
      },
      emit: (event: Event) => {
        said.push(event.message);
      },
    });
    expect(said[said.length - 1]).toBe('cert-manager: installed and answering');
    expect(dry).toBe(26);
    expect(slept).toEqual(new Array<number>(25).fill(CERT_MANAGER_INTERVAL)); // 3 s apart
    // the rollout waits' --timeout=180s
    expect(tuning.CERT_MANAGER_WEBHOOK_TRIES * CERT_MANAGER_INTERVAL).toBe(180);
  });

  /** houston's CA, placed where `ensureCa` looks, so the local path uses it. */
  function withCa(body: () => Promise<void>): Promise<void> {
    const ca = caDir();
    fs.mkdirSync(ca, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(ca, CA_KEY),
      '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n',
    );
    fs.writeFileSync(
      path.join(ca, CA_CRT),
      '-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----\n',
    );
    return body().finally(() => fs.rmSync(ca, { recursive: true, force: true }));
  }

  describe('an issuer that is accepted and never ready', () => {
    const realIssuerTries = tuning.ISSUER_WAIT_TRIES;
    afterEach(() => {
      tuning.ISSUER_WAIT_TRIES = realIssuerTries;
    });

    it('says why an ACME issuer never registered: egress, or the contact address', async () => {
      // Registering an ACME account is a real call to Let's Encrypt FROM INSIDE the cluster,
      // so it fails on no pod egress or a rejected contact address -- and it should fail
      // once, here, rather than silently per Certificate afterwards.
      tuning.ISSUER_WAIT_TRIES = 2;
      script([[has('clusterissuer'), json({ metadata: {} })]]);
      const failed = await ensureAcmeIssuer(
        { mode: 'acme', acmeEmail: 'a@b.c' },
        { context: 'c', ingressClass: 'traefik', sleep: () => Promise.resolve() },
      ).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(PreflightError);
      expect((failed as Error).message).toContain('egress');
      expect((failed as Error).message).toContain('contact address');
    });

    it('refuses an issuer that never reconciles, rather than leaving it silent', async () => {
      // A ClusterIssuer created before cert-manager is ready is ACCEPTED and then never
      // reconciled -- no `.status` at all -- so no Certificate ever issues and nothing says
      // why. Waiting for Ready=True leaves a working issuer or a refusal, never the third.
      tuning.ISSUER_WAIT_TRIES = 2;
      await withCa(async () => {
        script([[has('clusterissuer'), json({ metadata: {} })]]);
        const failed = await ensureCaIssuer({ context: 'c', sleep: () => Promise.resolve() }).catch(
          (error: unknown) => error,
        );
        expect(failed).toBeInstanceOf(PreflightError);
        expect((failed as Error).message).toContain('did not become ready');
        // Name the failure mode, not just the wait.
        expect((failed as Error).message).toContain('says nothing');

        // And it returns quietly once the condition is there.
        script([
          [
            has('clusterissuer'),
            json({
              status: {
                conditions: [{ type: 'Ready', status: 'True', message: 'Signing CA verified' }],
              },
            }),
          ],
        ]);
        await expect(
          ensureCaIssuer({ context: 'c', sleep: () => Promise.resolve() }),
        ).resolves.toBe(undefined);
      });
    });
  });

  it('builds the ACME issuer in the official guide’s own shape', () => {
    // From docs.rocket.chat, with two deliberate departures: `ingressClassName` rather than
    // the deprecated `class`, and http01 and NOT tls-alpn, which cert-manager does not
    // implement at all.
    const doc = YAML.parse(
      acmeIssuerManifest(
        { mode: 'acme', acmeEmail: 'ops@example.com' },
        { ingressClass: 'traefik' },
      ),
    ) as { spec: { acme: Record<string, unknown> } };
    const acme = doc.spec.acme;
    expect(acme.server).toBe(ACME_PRODUCTION);
    expect(acme.email).toBe('ops@example.com');
    expect(
      String((acme.privateKeySecretRef as { name: string }).name).endsWith('-account-key'),
    ).toBe(true);
    expect(acme.solvers).toEqual([{ http01: { ingress: { ingressClassName: 'traefik' } } }]);
    expect(JSON.stringify(acme)).not.toContain('tlsALPN01');
  });

  it('dispatches the issuer on the SPEC, not on the caller', async () => {
    // One call site, two mechanisms. A branch at the caller is how `--https` and `--domain`
    // would drift into two code paths again. houston's CA is placed where `ensureCa` looks,
    // so the local path uses it rather than generating one.
    const ca = caDir();
    fs.mkdirSync(ca, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(ca, CA_KEY),
      '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n',
    );
    fs.writeFileSync(
      path.join(ca, CA_CRT),
      '-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----\n',
    );
    try {
      const ready = json({
        status: { conditions: [{ type: 'Ready', status: 'True', message: 'ok' }] },
      });
      const issued = () =>
        seen
          .filter((argv) => argv.includes('apply'))
          .map((argv) => String(argv[argv.indexOf('<stdin>') + 1]));

      script([[has('clusterissuer'), ready]]);
      await ensureIssuer({ mode: 'local' }, { context: 'c', ingressClass: 'traefik' });
      expect(issued()).toHaveLength(1);
      expect(issued()[0]).toContain(`secretName: ${CA_ISSUER}`);
      expect(issued()[0]).not.toContain('acme');

      script([[has('clusterissuer'), ready]]);
      await ensureIssuer(
        { mode: 'acme', acmeEmail: 'a@b.c' },
        { context: 'c', ingressClass: 'traefik' },
      );
      expect(issued()).toHaveLength(1);
      expect(issued()[0]).toContain('acme:');
      expect(issued()[0]).toContain('a@b.c');
    } finally {
      fs.rmSync(ca, { recursive: true, force: true });
    }
  });
});

describe('the chart values, further', () => {
  it('emits the oplog URL only for the versions that use it', () => {
    // RC 8.x dropped oplog tailing, so emitting it there is wrong in the other direction.
    const withOplog = valuesFor({
      rcVersion: '7.10.0',
      rcImage: 'i',
      microservices: false,
      oplog: true,
      mongoUrl: 'm',
      oplogUrl: 'o',
    });
    const without = valuesFor({
      rcVersion: '8.5.1',
      rcImage: 'i',
      microservices: false,
      oplog: false,
      mongoUrl: 'm',
    });
    expect(withOplog.externalMongodbOplogUrl).toBe('o');
    expect('externalMongodbOplogUrl' in without).toBe(false);
  });

  it('refuses a chart from another era, and says the runtime that has an answer', async () => {
    // MEASURED against the live index: below 3.0.0 there is exactly one chart -- 0.1.0,
    // appVersion 1.16.0 -- which predates every values key houston sets. Refusing beats that
    // and beats a pod that never starts, because the Docker runtime supports these natively.
    script(
      [],
      json([
        { version: '0.1.0', app_version: '1.16.0' },
        { version: '3.0.0', app_version: '3.7.2' },
        { version: '6.4.4', app_version: '6.4.4' },
        { version: '7.0.2', app_version: '8.6.1' },
      ]),
    );
    expect(await resolveChartVersion('6.4.4')).toBe('6.4.4'); // exact match still wins
    // The floor rule is correct wherever a same-era chart exists.
    expect(await resolveChartVersion('5.0.0')).toBe('3.0.0');
    for (const old of ['3.0.0', '2.4.14', '1.0.0']) {
      const refusal = await resolveChartVersion(old).catch((error: unknown) => error);
      expect([old, refusal instanceof ValidationError]).toEqual([old, true]);
      // A refusal that does not name the answer is half a refusal, and it shows WHY.
      expect((refusal as Error).message).toContain('Docker runtime');
      expect((refusal as Error).message).toContain('0.1.0');
      expect((refusal as Error).message).toContain('1.16.0');
    }
    // THE BOUNDARY ITSELF RESOLVES: refusing one version too many would take a working one.
    expect(await resolveChartVersion('3.7.2')).toBe('3.0.0');
    // Newer than every chart is the opposite case, and the newest is the honest best effort
    // -- said NOTHING about on the way, because a chart behind the app is the normal case.
    const said: Event[] = [];
    expect(await resolveChartVersion('99.0.0', (event) => said.push(event))).toBe('7.0.2');
    expect(said).toEqual([]);
  });

  it('delivers a scenario’s settings to the Rocket.Chat container', () => {
    // `valuesFor` took `presetEnv`, threaded it from `createWorkspace`, and never used it:
    // OpenLDAP deployed, ready and labelled, and Rocket.Chat with no LDAP setting at all.
    const preset = resolvePreset('ldap', KUBERNETES, { users: '7' });
    const values = valuesFor({
      rcVersion: '8.5.1',
      rcImage: 'i',
      microservices: false,
      presetEnv: preset.env,
    });
    const got = Object.fromEntries(
      (values.extraEnv as ChartEnvEntry[]).map((entry) => [entry.name, entry.value]),
    );
    expect(got.OVERWRITE_SETTING_LDAP_Host).toBe('openldap');
    expect(['true', 'True']).toContain(got.OVERWRITE_SETTING_LDAP_Enable);
    // The workspace's own admin env survives alongside it; INITIAL_USER does not come back.
    expect(got.ADMIN_USERNAME).toBeTruthy();
    expect('INITIAL_USER' in got).toBe(false);

    // Appended AFTER the base list, so a preset overrides a default rather than the reverse.
    const override = valuesFor({
      rcVersion: '8.5.1',
      rcImage: 'i',
      microservices: false,
      presetEnv: { ADMIN_NAME: 'Scenario' },
    });
    expect(
      (override.extraEnv as ChartEnvEntry[]).filter((entry) => entry.name === 'ADMIN_NAME').at(-1)
        ?.value,
    ).toBe('Scenario');
  });
});

describe('naming an ingress class', () => {
  it('is obeyed or refused, never quietly ignored, and a choice among several is said', async () => {
    // Somebody who passes `--ingress-class alb` and silently gets nginx has been overruled
    // without being told. The cluster's own default is listed first.
    script(
      [],
      json({
        items: [
          {
            metadata: {
              name: 'nginx',
              annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' },
            },
          },
          { metadata: { name: 'alb' } },
        ],
      }),
    );
    const said: string[] = [];
    const emit = (event: Event) => said.push(event.message);
    expect(await ensureIngress({ context: 'c', distribution: 'eks', prefer: 'alb', emit })).toBe(
      'alb',
    );
    expect(said.some((message) => message.includes('as asked'))).toBe(true);

    const refusal = await ensureIngress({
      context: 'c',
      distribution: 'eks',
      prefer: 'traefik',
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PreflightError);
    // The refusal says what the cluster actually has.
    expect((refusal as Error).message).toContain('traefik');
    expect((refusal as Error).message).toContain('nginx, alb');

    said.length = 0;
    expect(await ensureIngress({ context: 'c', distribution: 'eks', emit })).toBe('nginx');
    expect(
      said.some(
        (message) =>
          message.includes('this cluster has nginx, alb') && message.includes('--ingress-class'),
      ),
    ).toBe(true);

    // ONE class is the ordinary case and must not gain a choice-of-several sentence.
    script([], json({ items: [{ metadata: { name: 'traefik' } }] }));
    said.length = 0;
    expect(await ensureIngress({ context: 'c', distribution: 'eks', emit })).toBe('traefik');
    expect(said.some((message) => message.includes('--ingress-class'))).toBe(false);
  });
});

describe('the shared monitoring stack, taken down', () => {
  it('lives once per cluster, beside the operator, and not in a workspace', () => {
    // `helm template rocketchat/monitoring` renders a ClusterRole and ClusterRoleBinding at
    // FIXED names, so a per-workspace release collides at the second workspace exactly as
    // the operator's CRDs do.
    expect(MONITORING_NAMESPACE).toBe(OPERATOR_NAMESPACE);
    expect(MONITORING_NAMESPACE).toBe('houston-system');
    expect(MONITORING_LABEL).toBe('houston.io/monitoring');
  });

  it('clears the finalizers the moment the deletes stop working, before helm waits', async () => {
    // Nine minutes of silence, measured: the Grafana operator already gone, a resource
    // carrying its finalizer, four 60-second deletes that could never finish and a
    // five-minute `helm uninstall --wait` -- and only then the clearing, which worked at once.
    script([
      [has('list'), listed('monitoring', 'deployed', 1)],
      [has('-l'), json({ items: [] })],
      [
        (argv) => argv.includes('get') && argv.includes('jsonpath={.items[*].metadata.name}'),
        { stdout: 'wedged-one' },
      ],
    ]);
    expect(await removeMonitoring({ context: CONTEXT })).toBe(true);
    const patched = seen.findIndex((argv) => argv.join(' ').includes('finalizers'));
    const uninstalled = seen.findIndex((argv) => argv.includes('uninstall'));
    expect(patched).toBeGreaterThanOrEqual(0);
    expect(uninstalled).toBeGreaterThanOrEqual(0);
    expect(patched).toBeLessThan(uninstalled);
    // And the per-kind deadline is short: a delete still running after it is waiting on
    // something nothing will clear.
    const deletes = seen.filter((argv) => argv.includes('delete'));
    expect(deletes.length).toBeGreaterThan(0);
    for (const argv of deletes) expect(argv).toContain(`--timeout=${String(GRAFANA_DELETE_WAIT)}s`);
    expect(GRAFANA_DELETE_WAIT).toBeLessThanOrEqual(20);
  });

  it('does not let the workspace being destroyed vote to keep it', async () => {
    // `workspaceNamespaces` does not filter by phase, so a namespace still Terminating is
    // listed and labelled -- and without the exclusion, "does anyone else want this?" is
    // answered yes by the workspace being deleted.
    script([
      [has('list'), listed('monitoring', 'deployed', 1)],
      [has('-l'), json({ items: [{ metadata: { name: 'houston-going' } }] })],
      [
        (argv) => argv.includes('houston-going'),
        json({ metadata: { name: 'houston-going', labels: { [MONITORING_LABEL]: 'true' } } }),
      ],
    ]);
    const events: Event[] = [];
    expect(
      await removeMonitoring({ context: 'default', emit: (event) => events.push(event) }),
    ).toBe(false);
    expect(events.some((event) => event.message.includes('still used by going'))).toBe(true);
    expect(await removeMonitoring({ context: 'default', excluding: 'houston-going' })).toBe(true);
  });

  it('reclaims its volume, which helm does not take with the release', async () => {
    // A StatefulSet's PVCs outlive it by design, and nothing deleted the monitoring
    // one: a clean `monitor --off` left a 10 Gi claim Bound, permanently.
    script([
      [has('list'), listed('monitoring', 'deployed', 1)],
      [has('-l'), json({ items: [] })],
      [has('get', 'pvc'), { stdout: 'persistentvolumeclaim/prometheus-db-0\n' }],
    ]);
    expect(await removeMonitoring({ context: 'c' })).toBe(true);
    expect(seen.some((argv) => argv.includes('delete') && argv.includes('pvc'))).toBe(true);
  });
});

describe('the MongoDB operator, installed and removed', () => {
  it('is installed once per cluster, in its own namespace, watching all of them', async () => {
    // The guide installs the operator INTO the Rocket.Chat namespace, assuming one per
    // cluster. Its CRDs are cluster-scoped, so a second per-namespace install collides.
    script([]);
    await ensureOperator({ context: CONTEXT });
    const argv = seen.find((call) => call.includes('--install')) ?? [];
    expect(argv.slice(0, 3)).toEqual(['helm', 'upgrade', '--install']); // idempotent
    expect(argv[argv.indexOf('-n') + 1]).toBe(OPERATOR_NAMESPACE); // not a workspace's
    expect(argv).toContain('operator.watchNamespace=*'); // or it would not see the others
  });

  it('gives the database pod its service account in the WORKSPACE namespace', () => {
    // What held the operator path at Pending for three sessions: the chart creates the
    // account only where the chart is installed, the pod runs in the workspace namespace,
    // and WaitForFirstConsumer then holds both PVCs Pending -- which points at storage.
    const docs = Object.fromEntries(
      YAML.parseAllDocuments(mongoRbacManifest('t', { owner: 'o' }))
        .map((doc) => doc.toJS() as Record<string, unknown>)
        .map((doc) => [String(doc.kind), doc]),
    ) as Record<string, Record<string, unknown>>;
    expect(Object.keys(docs).sort()).toEqual(['Role', 'RoleBinding', 'ServiceAccount']);
    for (const doc of Object.values(docs)) {
      const meta = doc.metadata as { name: string; labels: Record<string, string> };
      expect(meta.name).toBe(MONGO_DB_SERVICE_ACCOUNT);
      // Owned like everything else, so `prune` and the ownership guards see it.
      expect(meta.labels['app.kubernetes.io/managed-by']).toBe('houston');
    }
    // The binding names the LOCAL account; pointing at the operator's namespace would apply
    // cleanly and still leave the pod unable to start.
    const binding = docs.RoleBinding as {
      subjects: Record<string, unknown>[];
      roleRef: { name: string };
    };
    expect(binding.subjects[0]).toEqual({ kind: 'ServiceAccount', name: MONGO_DB_SERVICE_ACCOUNT });
    expect(binding.roleRef.name).toBe(MONGO_DB_SERVICE_ACCOUNT);
    // Exactly what a member pod needs: its own password Secret, and its own Pod.
    const rules = Object.fromEntries(
      (docs.Role as { rules: { resources: string[]; verbs: string[] }[] }).rules.map((rule) => [
        rule.resources[0],
        [...rule.verbs].sort(),
      ]),
    );
    expect(rules).toEqual({ secrets: ['get'], pods: ['delete', 'get', 'patch'] });
  });

  it('asks for SCRAM and the two documented users, and keeps its volume', () => {
    // Auth is the gap the operator is adopted for: without it an authentication ticket
    // cannot be reproduced on Kubernetes at all. Names match the guide, so its commands work.
    const doc = YAML.parse(mongodbCommunityManifest('t', '8.0')) as {
      kind: string;
      spec: {
        type: string;
        members: number;
        security: { authentication: { modes: string[] } };
        users: { name: string; roles: { name: string }[]; scramCredentialsSecretName: string }[];
        statefulSet: {
          spec: {
            volumeClaimTemplates: { spec: { resources: { requests: { storage: string } } } }[];
          };
        };
      };
    };
    expect(doc.kind).toBe('MongoDBCommunity');
    expect([doc.spec.type, doc.spec.members]).toEqual(['ReplicaSet', 1]);
    expect(doc.spec.security.authentication.modes).toEqual(['SCRAM']);
    const users = Object.fromEntries(doc.spec.users.map((user) => [user.name, user]));
    expect(users.admin?.roles[0]?.name).toBe('root');
    expect(users[MONGO_APP_USER]?.roles[0]?.name).toBe('readWrite');
    expect(users[MONGO_APP_USER]?.scramCredentialsSecretName).toBe('rocketchat-scram-credentials');
    expect(
      doc.spec.statefulSet.spec.volumeClaimTemplates[0]?.spec.resources.requests.storage.endsWith(
        'Gi',
      ),
    ).toBe(true);
  });

  it('never lets the registration token become a value or an argument', async () => {
    // The EE licence token reaches Rocket.Chat by REFERENCE. Helm values are readable with
    // `helm get values` and are written to the workspace directory; and an argument is
    // visible to every user on the box through `ps`.
    const token = 'SUPERSECRETTOKEN';
    const secret = YAML.parse(regTokenSecretManifest('w', { token, owner: 'me' })) as {
      kind: string;
      type: string;
      stringData: Record<string, string>;
      metadata: { labels: Record<string, string> };
    };
    expect([secret.kind, secret.type]).toEqual(['Secret', 'Opaque']);
    expect(secret.stringData[REG_TOKEN_KEY]).toBe(token);
    // Teardown selects on ownership, so the Secret carries it.
    expect(secret.metadata.labels['app.kubernetes.io/managed-by']).toBe('houston');

    const base = {
      rcVersion: '8.5.1',
      rcImage: 'registry.rocket.chat/rocketchat/rocket.chat',
      microservices: false,
      mongoUrl: 'mongodb://mongodb:27017/rocketchat',
    };
    const values = valuesFor({ ...base, regTokenSecret: REG_TOKEN_SECRET });
    expect(JSON.stringify(values)).not.toContain(token);
    const entry = (values.extraEnv as ChartEnvEntry[]).find((each) => each.name === 'REG_TOKEN');
    expect(entry?.valueFrom).toEqual({
      secretKeyRef: { name: REG_TOKEN_SECRET, key: REG_TOKEN_KEY },
    });
    expect(entry !== undefined && 'value' in entry).toBe(false);
    // Without a token nothing is referenced -- no dangling secretKeyRef.
    expect(
      (valuesFor(base).extraEnv as ChartEnvEntry[]).some((each) => each.name === 'REG_TOKEN'),
    ).toBe(false);

    // Applied on stdin, so it is never visible in argv.
    script([]);
    await apply(regTokenSecretManifest('w', { token }), { namespace: 'ns', context: 'c' });
    const call = seen[0] ?? [];
    const argv = call.slice(0, call.indexOf('<stdin>'));
    expect(argv.join(' ')).not.toContain(token);
    expect(argv.slice(-2)).toEqual(['-f', '-']);
  });

  it('never fails a teardown for an operator it could not uninstall', async () => {
    // The workspace is already gone, and the next `--mongo-operator` is an `upgrade
    // --install` that repairs it. Reporting failure would leave a user believing their
    // workspace is still there.
    script(
      [
        [has('list'), listed(OPERATOR_RELEASE, 'deployed', 1)],
        [has('mongodbcommunity'), { stdout: '' }],
      ],
      { returncode: 1, stderr: 'uninstall exploded' },
    );
    const events: Event[] = [];
    expect(await removeOperator({ context: 'default', emit: (event) => events.push(event) })).toBe(
      false,
    );
    expect(events.some((event) => event.message.includes('could not be uninstalled'))).toBe(true);
  });
});

describe('installing the workspace’s own release', () => {
  const quiet = tuning.INSTALL_QUIET_S;
  const every = tuning.INSTALL_REPORT_EVERY_S;
  afterEach(() => {
    jest.useRealTimers();
    tuning.INSTALL_QUIET_S = quiet;
    tuning.INSTALL_REPORT_EVERY_S = every;
  });

  it('is `upgrade --install`, so bringing a workspace back up works', async () => {
    // `helm install` fails on a release that already exists, which is every `up` over an
    // existing workspace and every retry after a partial failure.
    script([[has('list'), json([])]]);
    await install({ namespace: 'ns', context: CONTEXT, values: {}, chartVersion: '7.0.0' });
    const installs = seen.filter((argv) => argv.slice(0, 3).join(' ') === 'helm upgrade --install');
    expect(installs).toHaveLength(1);
  });

  it('re-supplies the whole values file on an upgrade, recomputed for the target chart', async () => {
    // The guide says: change the image tag in your values and run `helm upgrade`. This did
    // `--reuse-values`, which never applies the NEW chart's defaults (RC 7.4.0 -> 7.10.15
    // crosses a chart that added `podMonitor`, and died on a nil pointer) and CARRIES
    // per-chart workarounds: `containerSecurityContext: {fsGroup: null}` is required on
    // chart 6.26.0 and breaks 7.0.0, which fixed the problem upstream.
    const release = {
      containerSecurityContext: { fsGroup: null },
      externalMongodbUrl: 'mongodb://keep-me',
      microservices: { enabled: true },
      externalMongodbOplogUrl: 'mongodb://local',
      image: { repository: 'old', tag: '7.4.0' },
    };
    const chartSetsFsGroup = (sets: boolean) =>
      script([
        [has('get', 'values'), json(release)],
        [
          has('show', 'values'),
          {
            stdout: sets
              ? 'containerSecurityContext:\n  runAsUser: 999\n  fsGroup: 999\n'
              : 'containerSecurityContext:\n  runAsUser: 999\n',
          },
        ],
      ]);
    const sent = () => {
      const argv = seen.filter((call) => call.includes('upgrade')).at(-1) ?? [];
      return {
        argv: argv.slice(0, argv.indexOf('<stdin>')),
        body: JSON.parse(argv[argv.indexOf('<stdin>') + 1] ?? '{}') as Record<string, unknown>,
      };
    };

    // The TARGET chart sets no `fsGroup` on the container, so nothing is sent for it.
    chartSetsFsGroup(false);
    await upgradeImage({
      namespace: 'ns',
      context: 'c',
      chartVersion: '7.0.0',
      imageRepo: 'r',
      tag: '8.0.0',
      oplog: false,
    });
    const { argv, body } = sent();
    expect(argv.slice(0, 2)).toEqual(['helm', 'upgrade']);
    expect(argv).toContain('--values');
    expect(argv).toContain('-');
    // A reuse flag is back, or the tag went on a flag: the guide supplies the whole file.
    expect(argv.some((arg) => arg.includes('reuse-values'))).toBe(false);
    expect(argv).not.toContain('--set');
    expect(body.image).toEqual({ repository: 'r', tag: '8.0.0' });
    // Create-time decisions survive the upgrade.
    expect(body.externalMongodbUrl).toBe('mongodb://keep-me');
    expect(body.microservices).toEqual({ enabled: true });
    // A workaround for the OLD chart is not carried onto the new one.
    expect('containerSecurityContext' in body).toBe(false);
    // RC 8 dropped oplog tailing; the key is removed, not carried.
    expect('externalMongodbOplogUrl' in body).toBe(false);

    // And where the target chart DOES need it, it is present -- recomputed, not reused.
    chartSetsFsGroup(true);
    await upgradeImage({
      namespace: 'ns',
      context: 'c',
      chartVersion: '6.26.0',
      imageRepo: 'r',
      tag: '7.10.15',
      oplog: false,
    });
    expect(sent().body.containerSecurityContext).toEqual({ fsGroup: null });
  });

  it('pipes the values file to helm in the bytes earlier releases pipe', async () => {
    // Earlier releases pipe the values as their JSON text on the install and on the image
    // upgrade: spaced, and `\uXXXX` past ASCII. `JSON.stringify` piped it compact and raw.
    const values = { image: { tag: '8.5.1' }, extraEnv: [{ name: 'X', value: 'caf\u00e9' }] };
    script([[has('list'), json([])]]);
    await install({ namespace: 'ns', context: CONTEXT, values, chartVersion: '7.0.0' });
    const piped = (argv: readonly string[] | undefined) =>
      argv === undefined ? '' : (argv[argv.indexOf('<stdin>') + 1] ?? '');
    expect(piped(seen.find((argv) => argv.includes('--install')))).toBe(
      '{"image": {"tag": "8.5.1"}, "extraEnv": [{"name": "X", "value": "caf\\u00e9"}]}',
    );
    script([
      [has('get', 'values'), json({ image: { repository: 'old', tag: '7.4.0' } })],
      [has('show', 'values'), { stdout: 'containerSecurityContext:\n  runAsUser: 999\n' }],
    ]);
    await upgradeImage({
      namespace: 'ns',
      context: 'c',
      chartVersion: '7.0.0',
      imageRepo: 'r',
      tag: '8.0.0',
      oplog: false,
    });
    expect(piped(seen.filter((argv) => argv.includes('upgrade')).at(-1))).toBe(
      '{"image": {"repository": "r", "tag": "8.0.0"}}',
    );
  });

  it('does not narrate a step that is already over', async () => {
    // A warm cluster installs in seconds, and "still installing" about a finished step is
    // noise, not progress.
    script([[has('list'), json([])]]);
    const said: string[] = [];
    await install({ namespace: 'ns', context: 'c', values: {}, emit: (e) => said.push(e.message) });
    expect(said.some((message) => message.includes('still installing'))).toBe(false);
    expect(seen.some((argv) => argv.includes('pods'))).toBe(false); // it never probed
  });

  it('says what the longest step of a create is waiting for, while it waits', async () => {
    // MEASURED on a real EKS create: 254 seconds between "installing rocketchat/rocketchat"
    // and the next line. The rollback flags imply `--wait`, so helm prints nothing while it
    // blocks, and four minutes of silence is where somebody decides it has hung.
    jest.useFakeTimers();
    tuning.INSTALL_QUIET_S = 1;
    tuning.INSTALL_REPORT_EVERY_S = 1;
    kube.run = (argv) => {
      const reply = (stdout: string) => ({ argv, returncode: 0, stdout, stderr: '' });
      if (argv.includes('list')) return Promise.resolve(reply('[]'));
      if (argv.includes('pods')) {
        return Promise.resolve(
          reply(
            JSON.stringify({
              items: [
                {
                  status: {
                    containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }],
                  },
                },
              ],
            }),
          ),
        );
      }
      if (argv.includes('upgrade')) {
        return new Promise((resolve) => setTimeout(() => resolve(reply('')), 2400));
      }
      return Promise.resolve(reply(''));
    };
    const said: string[] = [];
    const done = install({
      namespace: 'ns',
      context: 'c',
      values: {},
      emit: (e) => said.push(e.message),
    });
    await jest.advanceTimersByTimeAsync(3000);
    await done;
    const progress = said.filter((message) => message.includes('still installing'));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toContain('pulling the image');
  });
});

describe('an ingress on a cluster that is not on this machine', () => {
  it('is refused with the command to run instead, and an unknown locality is not read as local', async () => {
    // The chart's Service is a LoadBalancer, and on a managed cluster that provisions a
    // REAL load balancer -- billable, created implicitly, in somebody's account. Reads are
    // fine (deciding locality is itself one); only a helm call is forbidden.
    script([[has('ingressclass'), json({ items: [] })]]);
    const refused = ensureIngress({ context: 'prod', distribution: 'eks' });
    await expect(refused).rejects.toBeInstanceOf(PreflightError);
    await expect(refused).rejects.toThrow('not on this machine');
    await expect(refused).rejects.toThrow('helm install traefik');
    // The question is whether to spend money, so a locality nobody can name refuses too.
    await expect(ensureIngress({ context: 'prod', distribution: '' })).rejects.toBeInstanceOf(
      PreflightError,
    );
    expect(seen.filter((argv) => argv[0] === 'helm')).toEqual([]);
  });
});

describe("a workspace's preset UIs on Kubernetes", () => {
  it('are one Ingress on the same host and certificate Secret, each path to its Service', () => {
    const doc = JSON.parse(
      toolsIngressManifest('ws.example.test', {
        ingressClass: 'traefik',
        secretName: 'ws-tls',
        labels: { 'houston.io/repro': 'ws' },
        paths: [
          {
            preset: 'email',
            path: '/mailpit',
            service: 'mailpit',
            container_port: 8025,
            service_port: 8025,
          },
          {
            preset: 'livechat',
            path: '/livechat-demo',
            service: 'widget-site',
            container_port: 80,
            service_port: 80,
          },
        ],
      }),
    ) as {
      metadata: { name: string; annotations?: unknown };
      spec: {
        ingressClassName: string;
        tls: unknown[];
        rules: { host: string; http: { paths: { path: string; backend: unknown }[] } }[];
      };
    };
    expect(doc.metadata.name).toBe('houston-tools');
    // No cert-manager annotation: the chart's Ingress already owns that certificate.
    expect(doc.metadata.annotations).toBeUndefined();
    expect(doc.spec.tls).toEqual([{ hosts: ['ws.example.test'], secretName: 'ws-tls' }]);
    expect(doc.spec.rules[0]?.http.paths).toEqual([
      {
        path: '/mailpit',
        pathType: 'Prefix',
        backend: { service: { name: 'mailpit', port: { number: 8025 } } },
      },
      {
        path: '/livechat-demo',
        pathType: 'Prefix',
        backend: { service: { name: 'widget-site', port: { number: 80 } } },
      },
    ]);
  });
});
