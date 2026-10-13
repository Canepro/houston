import * as fs from 'node:fs';
import * as path from 'node:path';

import * as YAML from 'yaml';

import * as config from '../../../src/lib/config';
import { resolve as resolvePreset } from '../../../src/lib/presets/index';

import { acmeIssuerManifest, caIssuerManifest } from '../../../src/core/kube/certmanager';
import { kube } from '../../../src/core/kube/exec';
import {
  containerSecurityContext,
  mongoManifest,
  recordRendered,
  renderScenarioManifest,
  requireSafeName,
  scalar,
  splitImage,
} from '../../../src/core/kube/manifests';
import { MONGO_SERVICE, OWNER_LABEL_KEY, WORKSPACE_LABEL } from '../../../src/core/kube/names';
import {
  mongoRbacManifest,
  mongoSecretManifest,
  mongoUrlSecretManifest,
  mongodbCommunityManifest,
  regTokenSecretManifest,
} from '../../../src/core/kube/operator';

const realRun = kube.run;

afterEach(() => {
  kube.run = realRun;
});

/**
 * The YAML 1.1 scalars that are not strings, plus the shapes that end a scalar.
 *
 * Every one of these is a STRING that a YAML 1.1 reader -- which is what `kubectl` and
 * every Kubernetes client use -- turns into something else, or that ends the scalar and
 * starts a new node. `compose.ts` solves the same problem by emitting through a library
 * with `compat: 'yaml-1.1'`; these manifests are templates, so the quoting is explicit and
 * this is what points a test at it.
 */
const INJECTION_CORPUS = [
  'yes',
  'no',
  'on',
  'off',
  'y',
  'n',
  'Y',
  'N',
  'True',
  'TRUE',
  '0755',
  '12:30:45',
  '.inf',
  '~',
  'null',
  '',
  '-leading-dash',
  ' leading space',
  'embedded: colon',
  'embedded\nnewline',
  '---',
  'embedded\ttab',
  // Written as ESCAPES rather than as the characters themselves: an editor or a
  // formatter that normalised them away would silently take three cases out of this
  // corpus, and the file would still look right.
  'u2028\u2028separator',
  'u2029\u2029separator',
  'nel\u0085separator',
];

/** What earlier releases rendered and wrote for the cases below, recorded. */
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'core', 'kube', 'manifests.json'),
    'utf8',
  ),
) as { templates: string[]; valuesYaml: string };

describe('the YAML injection corpus', () => {
  it.each(INJECTION_CORPUS)('quotes %j rather than interpolating it raw', (value) => {
    const emitted = scalar(value);
    // Round-tripped through a real YAML parser: whatever the quoting, the value that
    // comes back must be the string that went in.
    const document = YAML.parse(`key: ${emitted}\nafter: sentinel\n`) as Record<string, unknown>;
    expect(document.key).toBe(value);
    // And nothing it carried may have started a new node or eaten the next key.
    expect(document.after).toBe('sentinel');
    expect(Object.keys(document)).toEqual(['key', 'after']);
  });

  it('leaves an ordinary name plain, so the documents stay readable', () => {
    for (const value of ['rocketchat', 'houston-TICKET-1234', 'app.kubernetes.io/managed-by']) {
      expect(scalar(value)).toBe(value);
    }
  });

  it('quotes every YAML 1.1 boolean, special, number and indicator exactly as JSON does, and leaves a plain name plain', () => {
    // `no` is a legal workspace name and `on` a legal account name, and both land in a
    // label. kubectl parses YAML 1.1, where eleven spellings of each boolean are boolean, so
    // an unquoted one reached the API server as `false` and was refused. The corpus earlier
    // releases quote, value for value, and the exact form they emit: a double-quoted JSON
    // string.
    const hostile = [
      // The eleven booleans, the specials, the numerics and the sexagesimals.
      ...['y', 'Y', 'yes', 'Yes', 'YES', 'n', 'N', 'no', 'No', 'NO'],
      ...['true', 'True', 'TRUE', 'false', 'False', 'FALSE'],
      ...['on', 'On', 'ON', 'off', 'Off', 'OFF'],
      ...['~', 'null', 'Null', 'NULL', '.inf', '.nan', '-.inf'],
      ...['0', '007', '0x1f', '0b101', '1_000', '1.5', '1e3', '-3', '12:30:45', '1:30'],
      // Anything a YAML reader could mistake for structure.
      ...['', ' ', 'a: b', 'a #c', ' lead', 'trail ', '-dash', '?q', '[x]', '{x}', '#h'],
      ...['&a', '*a', '!t', '|b', '>f', '%p', '@r'],
    ];
    for (const value of hostile)
      expect([value, scalar(value)]).toEqual([value, JSON.stringify(value)]);
    // An ORDINARY name is left exactly as it was, so every real workspace's manifests are
    // unchanged.
    for (const ordinary of ['tkt-1234', 'lovekesh', 'my-workspace', 'a', 'rc8-5-1']) {
      expect(scalar(ordinary)).toBe(ordinary);
    }
  });

  it('refuses a value that could not be a Kubernetes name at all', () => {
    // Quoting keeps the DOCUMENT well formed; it does not make `houston-a b` a namespace.
    expect(requireSafeName('houston-ticket-1234', 'namespace')).toBe('houston-ticket-1234');
    for (const bad of ['houston a', 'Houston', '-leading', 'trailing-', 'a'.repeat(254), '']) {
      expect(() => requireSafeName(bad, 'namespace')).toThrow(/not a legal Kubernetes name/u);
    }
  });
});

/** The parts of the StatefulSet the pod-level cases read. */
interface MongoStatefulSet {
  spec: {
    template: {
      spec: {
        securityContext?: { runAsNonRoot?: boolean; seccompProfile?: { type?: string } };
        containers: {
          readinessProbe?: { exec: { command: string[] } };
          securityContext?: {
            allowPrivilegeEscalation?: boolean;
            capabilities?: { drop?: string[] };
          };
          resources?: { requests?: { memory?: string }; limits?: Record<string, string> };
        }[];
      };
    };
  };
}

describe('the MongoDB manifest', () => {
  const parse = (text: string) =>
    YAML.parseAllDocuments(text).map((doc) => doc.toJS() as Record<string, unknown>);

  it('is two valid documents, a headless Service and a StatefulSet', () => {
    const docs = parse(mongoManifest('ticket', '8.0'));
    expect(docs.map((doc) => doc.kind)).toEqual(['Service', 'StatefulSet']);
    const [service, statefulset] = docs as [Record<string, unknown>, Record<string, unknown>];
    // publishNotReadyAddresses: a headless Service does NOT publish DNS for a not-ready
    // pod, and this pod cannot be ready until the replica set is initiated -- so
    // `rs.initiate` could not resolve the member to check it is itself.
    expect((service.spec as Record<string, unknown>).publishNotReadyAddresses).toBe(true);
    expect((service.spec as Record<string, unknown>).clusterIP).toBe('None');
    expect((statefulset.spec as Record<string, unknown>).serviceName).toBe(MONGO_SERVICE);
  });

  it('probes readiness with a direct connection, which answers before the set is initiated', () => {
    // The manifest half of the circular wait: a probe that cannot pass until initiation
    // keeps the pod unready forever, and Kubernetes gives no hint the PROBE is the problem.
    const [, statefulset] = parse(mongoManifest('t', '8.0')) as [unknown, MongoStatefulSet];
    const command =
      statefulset.spec.template.spec.containers[0]?.readinessProbe?.exec.command ?? [];
    expect(command.some((part) => part.includes('directConnection=true'))).toBe(true);
  });

  it('satisfies Pod Security restricted, so a pod is ever created', () => {
    // With no securityContext, under PSA `restricted` the StatefulSet was ACCEPTED and
    // no pod was ever created -- and every diagnostic went blind, the PVC sat Pending
    // pointing at storage, which was not the problem.
    const [, statefulset] = parse(mongoManifest('t', '8.0')) as [unknown, MongoStatefulSet];
    const pod = statefulset.spec.template.spec;
    expect(pod.securityContext?.runAsNonRoot).toBe(true);
    expect(pod.securityContext?.seccompProfile?.type).toBe('RuntimeDefault');
    const container = pod.containers[0];
    expect(container?.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(container?.securityContext?.capabilities?.drop).toEqual(['ALL']);
    // Requests, so a namespace quota cannot reject the pod outright; no CPU limit, because
    // throttling mongod during a restore turns a backup test into a timeout.
    expect(container?.resources?.requests?.memory).toBeTruthy();
    expect('cpu' in (container?.resources?.limits ?? {})).toBe(false);
  });

  it('quotes a hostile name in the label block a real manifest carries, and leaves a plain one plain', () => {
    // The helper, one layer up. A plain name must still be emitted plain, or every manifest
    // on every box changes to fix a case almost nobody hits.
    const plain = mongoManifest('tkt-1234', '7.0', { owner: 'lovekesh' });
    expect(plain).toContain('houston.io/workspace: tkt-1234');
    expect(plain).toContain('houston.io/owner: lovekesh');

    const hostile = mongoManifest('no', '7.0', { owner: 'on' });
    expect(hostile).toContain('houston.io/workspace: "no"');
    expect(hostile).toContain('houston.io/owner: "on"');
    // And it still parses as the STRING that went in, which the API server refused before.
    for (const doc of YAML.parseAllDocuments(hostile, { version: '1.1' })) {
      const js = doc.toJS() as { metadata?: { labels?: Record<string, unknown> } } | null;
      const labels = js?.metadata?.labels ?? {};
      if (WORKSPACE_LABEL in labels) {
        expect(labels[WORKSPACE_LABEL]).toBe('no');
        expect(labels['houston.io/owner']).toBe('on');
      }
    }
  });

  it('puts the ownership labels at every nesting level, each at its own indent', () => {
    // The first version reused one 4-space block everywhere, and inside
    // `volumeClaimTemplates` that put the labels at the same level as `metadata`, so they
    // became keys of the template item. Valid YAML and an invalid manifest -- which a
    // parse test cannot see, which is why this walks to the exact places.
    const [, statefulset] = parse(mongoManifest('ticket', '8.0', { owner: 'alice' })) as [
      unknown,
      Record<string, unknown>,
    ];
    const spec = statefulset.spec as Record<string, unknown>;
    const podLabels = (
      (spec.template as Record<string, unknown>).metadata as Record<string, unknown>
    ).labels as Record<string, string>;
    const claim = (spec.volumeClaimTemplates as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
    const claimMeta = claim.metadata as Record<string, unknown>;

    expect((statefulset.metadata as Record<string, unknown>).labels).toMatchObject({
      [OWNER_LABEL_KEY]: 'houston',
      [WORKSPACE_LABEL]: 'ticket',
      'houston.io/owner': 'alice',
    });
    expect(podLabels[WORKSPACE_LABEL]).toBe('ticket');
    expect(podLabels.app).toBe(MONGO_SERVICE);
    // The labels are INSIDE metadata, not beside it.
    expect(claimMeta.labels).toMatchObject({ [WORKSPACE_LABEL]: 'ticket' });
    expect(claimMeta.name).toBe('data');
    expect(Object.keys(claim).sort()).toEqual(['metadata', 'spec']);
  });

  it('omits storageClassName entirely when none was chosen', () => {
    // Omitted makes Kubernetes use the cluster's default, which is what keeps this working
    // unchanged on kind (standard), k3s (local-path) and a real cluster.
    const without = mongoManifest('ticket', '8.0');
    expect(without).not.toContain('storageClassName');

    const withClass = mongoManifest('ticket', '8.0', { storageClass: 'gp3' });
    const [, statefulset] = parse(withClass) as [unknown, Record<string, unknown>];
    const claim = (
      (statefulset.spec as Record<string, unknown>).volumeClaimTemplates as Record<
        string,
        unknown
      >[]
    )[0] as Record<string, unknown>;
    expect((claim.spec as Record<string, unknown>).storageClassName).toBe('gp3');
  });

  it('re-checks the tag here, not only where --mongo is accepted', () => {
    // This builds YAML from a template, so the tag is a caller-supplied value that could
    // add structure rather than fill a slot. Two checks rather than one because the
    // boundary is the useful error and the template is the one that must not be wrong.
    expect(() => mongoManifest('ticket', '8.0\n')).toThrow();
    expect(() => mongoManifest('ticket', 'a: b')).toThrow();
    expect(() => mongoManifest('ticket', '../../etc/passwd')).toThrow();
  });

  it('survives a workspace name and owner carrying the corpus', () => {
    // These reach the labels, which is a place a caller-supplied value lands in the
    // document. Structure must not change, whatever they carry.
    for (const hostile of ['yes', '12:30:45', 'a: b', '---']) {
      const docs = parse(mongoManifest(hostile, '8.0', { owner: hostile }));
      expect(docs.map((doc) => doc.kind)).toEqual(['Service', 'StatefulSet']);
      expect(
        ((docs[1] as Record<string, unknown>).metadata as Record<string, unknown>).labels as Record<
          string,
          string
        >,
      ).toMatchObject({ [WORKSPACE_LABEL]: hostile });
    }
  });

  it('puts a storage class in the claim, and not inside the line above it', () => {
    // `storageClassName` was indented eight spaces and spliced in beside `accessModes`,
    // which sits at six -- so it became a child of a scalar and the API server refused the
    // WHOLE two-document manifest with `error converting YAML to JSON: yaml: did not find
    // expected key`. Service included; nothing was created.
    //
    // Earlier releases had the same defect, and nothing in them passes this argument, which
    // is how a documented, public parameter went its whole life without once producing a
    // usable document. Found by sending the manifests to a real API server; fixed in both,
    // each with a test proven to fail against the pre-fix code.
    //
    // THE ERRORS ARE THE ASSERTION, and that is the point worth keeping: this parser
    // RECOVERS -- `toJS()` returns exactly the document that was meant, with
    // `storageClassName` in the right place -- and only `doc.errors` says the source was
    // malformed. Go's YAML, which is what kubectl and every Kubernetes client run, does not
    // recover. So a test that reads the parsed object passes while the manifest is
    // unusable, which is the same shape as the labels-beside-`metadata` bug this file
    // already records: valid enough to parse, and rejected by the server.
    const docs = YAML.parseAllDocuments(mongoManifest('t', '8.0', { storageClass: 'local-path' }));
    expect(docs.flatMap((doc) => doc.errors.map((error) => error.message))).toEqual([]);
    const parsed = docs.map((doc) => doc.toJS() as Record<string, unknown>);
    const sts = parsed.find((doc) => doc.kind === 'StatefulSet') as {
      spec: { volumeClaimTemplates: Record<string, { [key: string]: unknown }>[] };
    };
    const claim = sts.spec.volumeClaimTemplates[0] as unknown as Record<string, unknown> & {
      spec: Record<string, unknown>;
    };
    expect(claim.spec.storageClassName).toBe('local-path');
    // And it belongs to the CLAIM's spec, not to the template item: the same
    // mis-indentation one level out is what put the labels beside `metadata` once.
    expect('storageClassName' in claim).toBe(false);
    // Omitted entirely when empty, which is what makes the cluster's default apply.
    expect(mongoManifest('t', '8.0')).not.toContain('storageClassName');
  });
});

describe('every manifest template, against the text earlier releases render', () => {
  it('is what earlier releases render, byte for byte, comments included, as kubectl apply receives it', () => {
    // The StatefulSet's PodSecurity comment was reworded in an earlier version -- `the pod-failure
    // probe` for `terminal_pod_failure` -- and the MongoDBCommunity resource lost two
    // comments' worth of lines and the quotes on `version:`. None of it changes what the
    // cluster does; all of it changes the bytes piped to `kubectl apply -f -` and recorded
    // beside the workspace. What earlier releases rendered for the same arguments, recorded,
    // is the fixture.
    const recorded = RECORDED.templates;
    const ours = [
      mongoManifest('ticket', '8.0', { owner: 'alice', storageClass: 'gp3' }),
      mongoManifest('t', '7.0.14'),
      mongoRbacManifest('ticket', { owner: 'alice' }),
      mongoSecretManifest('ticket', { adminPassword: 'a', appPassword: 'b', owner: 'alice' }),
      mongodbCommunityManifest('ticket', '8.0', { owner: 'alice', storageGb: 7 }),
      mongodbCommunityManifest('t', '7.0.14'),
      regTokenSecretManifest('ticket', { token: 'tok', owner: 'alice' }),
      mongoUrlSecretManifest('ticket', {
        mongoUrl: 'mongodb://x',
        oplogUrl: 'mongodb://y',
        owner: 'alice',
      }),
      caIssuerManifest('CERT\nPEM\n', 'KEY\nPEM\n'),
      acmeIssuerManifest(
        { mode: 'acme', acmeEmail: 'a@b.c', acmeStaging: true },
        { ingressClass: 'nginx' },
      ),
    ];
    expect(ours).toEqual(recorded);
    expect(recorded[0]).toContain('-- `terminal_pod_failure` finds\n');
    expect(recorded[4]).toContain('  version: "8.0.0"\n');
  });
});

describe('the chart’s image and values', () => {
  it('splits a tag only when what follows the colon is not a path', () => {
    // `resolve()` returns the REPOSITORY only, so a naive split on the last colon returns
    // the whole repository as the tag -- truthy, so an `|| rcVersion` fallback does not
    // save it, and the chart fed it to semverCompare.
    expect(splitImage('registry.rocket.chat/rocketchat/rocket.chat', '8.5.1')).toEqual([
      'registry.rocket.chat/rocketchat/rocket.chat',
      '8.5.1',
    ]);
    expect(splitImage('rocketchat/rocket.chat:7.10.0', '8.5.1')).toEqual([
      'rocketchat/rocket.chat',
      '7.10.0',
    ]);
    // A host with a port is not a tag.
    expect(splitImage('registry:5000/org/img', '8.5.1')).toEqual([
      'registry:5000/org/img',
      '8.5.1',
    ]);
  });

  it('drops the chart’s container fsGroup only where the chart actually sets one', async () => {
    // fsGroup is a POD-level field. Helm 4 applies server-side and the API server refuses
    // the whole Deployment, which makes every Rocket.Chat 7.x install fail. Injecting it
    // unconditionally put a literal `fsGroup: null` onto chart 7.0.0's container -- the
    // same undeclared field, arrived at from the other direction.
    kube.run = (argv) =>
      Promise.resolve({
        argv,
        returncode: 0,
        stdout: 'containerSecurityContext:\n  runAsUser: 999\n  fsGroup: 999\n',
        stderr: '',
      });
    expect(await containerSecurityContext('6.26.0')).toEqual({
      containerSecurityContext: { fsGroup: null },
    });

    kube.run = (argv) =>
      Promise.resolve({
        argv,
        returncode: 0,
        stdout: 'containerSecurityContext:\n  runAsUser: 65533\n',
        stderr: '',
      });
    expect(await containerSecurityContext('7.0.0')).toEqual({});

    kube.run = (argv) => Promise.resolve({ argv, returncode: 1, stdout: '', stderr: 'no chart' });
    expect(await containerSecurityContext('7.0.0')).toEqual({});
  });

  it('binds a scenario manifest to this workspace', () => {
    expect(renderScenarioManifest('label: __HOUSTON_NAME__\nother: __HOUSTON_NAME__', 'tk')).toBe(
      'label: tk\nother: tk',
    );
  });

  it("gives the livechat demo page the workspace's address, not the placeholder", () => {
    // Compose's file writer fills `{{ROOT_URL}}`; on Kubernetes the page went into its
    // ConfigMap as written, so the widget was asked for at `{{ROOT_URL}}/livechat` and 404'd:
    // the demo page never loaded the widget on this runtime.
    const manifest = resolvePreset('livechat', 'kubernetes', {}).kubernetesManifests[0] as string;
    expect(manifest).toContain('{{ROOT_URL}}');
    const body = renderScenarioManifest(manifest, 'tk', 'https://tk.houston.localhost');
    expect(body).not.toContain('{{ROOT_URL}}');
    expect(body).toContain("'https://tk.houston.localhost/livechat'");
  });
});

describe('what a Kubernetes workspace writes down', () => {
  it('records the values and manifests for READING, and no secrets', async () => {
    // A Compose workspace has a docker-compose.yml you can read; a Kubernetes one had
    // nothing but repro.json, because values go to `helm --values -` on stdin.
    const written = await recordRendered('tk', {
      values: {
        image: { repository: 'rocketchat/rocket.chat', tag: '8.5.1' },
        mongodb: { image: { tag: '8.0' }, enabled: false },
      },
      manifests: { mongodb: mongoManifest('tk', '8.0'), empty: '' },
    });
    const out = path.join(config.reprosDir(), 'tk', 'kubernetes');
    expect(written).toEqual([path.join(out, 'values.yaml'), path.join(out, 'mongodb.yaml')]);
    // An empty manifest writes no file rather than an empty one.
    expect(fs.existsSync(path.join(out, 'empty.yaml'))).toBe(false);

    const values = YAML.parse(fs.readFileSync(path.join(out, 'values.yaml'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(values).toEqual({
      image: { repository: 'rocketchat/rocket.chat', tag: '8.5.1' },
      mongodb: { image: { tag: '8.0' }, enabled: false },
    });
    // `8.0` IS a YAML number, so it is quoted on the way out -- a tag read back as the
    // float 8 is a different tag, and this is the same emission rule `compose.ts` needs.
    // Earlier releases quote it with `'`, not `"`. `8.5.1` is not a number in any YAML
    // version, so it stays plain.
    const text = fs.readFileSync(path.join(out, 'values.yaml'), 'utf8');
    expect(text).toContain("tag: '8.0'");
    expect(text).toContain('tag: 8.5.1');
  });

  it('writes values.yaml as earlier releases write it, keys in their given order', async () => {
    // `recordRendered`, and the file `upgrade` reads back and rewrites. The `yaml` package
    // with YAML 1.1 options quoted `8.0` with `"` and never folded a long value, so the file
    // was not the one earlier releases write.
    const values = {
      image: { repository: 'registry.rocket.chat/rocketchat/rocket.chat', tag: '8.5.1' },
      extraEnv: [
        { name: 'OVERWRITE_SETTING_Show_Setup_Wizard', value: 'completed' },
        { name: 'FEATURE', value: 'no' },
        { name: 'NOTE', value: 'a value long enough that writer folds it '.repeat(3) },
      ],
      mongodb: { enabled: false, image: { tag: '8.0' } },
      replicaCount: 1,
      podAnnotations: {},
      _chart_version: '6.28.0',
    };
    await recordRendered('tk', { values, manifests: {} });
    // What earlier releases wrote for the same values, recorded.
    const recorded = RECORDED.valuesYaml;
    const text = fs.readFileSync(
      path.join(config.reprosDir(), 'tk', 'kubernetes', 'values.yaml'),
      'utf8',
    );
    expect(text).toBe(recorded);
    expect(recorded).toContain("\n- name: FEATURE\n  value: 'no'\n");
  });
});
