/**
 * The YAML houston authors, as documents rather than as strings.
 *
 * Tier k3. Every manifest this package applies is built here, so what goes into a cluster can
 * be read in one place -- and so a test can assert on the document instead of grepping the
 * command line that carried it.
 *
 * ## The injection corpus, and why interpolation is not enough
 *
 * This YAML is built from string templates, and the MongoDB tag "is the one
 * caller-supplied value that can add structure rather than fill a slot", so it is
 * re-validated here as well as at the boundary. The same is true of every other value
 * that reaches a template -- a workspace name, an owner, a storage class. YAML 1.1 reads
 * `yes`, `no`, `on`, `off`, `y`, `n`, `0755`, `12:30:45`, `.inf` and `~` as things that
 * are not strings, and a value carrying `": "`, a newline, a leading `-` or `---` can end
 * the scalar and start a new key.
 *
 * So values are EMITTED rather than interpolated: `scalar()` quotes anything that is not
 * unambiguously a plain string, and `requireSafeName()` refuses the shapes that are not
 * legal Kubernetes names in the first place. `test/core/kube/manifests.test.ts` holds
 * the injection corpus to that rule.
 */
import * as fs from 'node:fs/promises';

import * as YAML from 'yaml';

import * as config from '../../lib/config';
import { joinPath } from '../../lib/home';
import { safeDump } from '../../lib/yaml-dump';
import { requireValidMongoTag } from '../../lib/versions';
import { atomicWrite } from '../runner/paths';

import { kube } from './exec';
import {
  APPLY_TIMEOUT,
  CHART,
  MONGO_DIRECT_URI,
  MONGO_SERVICE,
  MONGO_VOLUME_GB,
  mongoImage,
} from './names';
import { labelsFor } from './namespace';

/**
 * The plain-scalar shapes YAML 1.1 reads as something other than a string, plus the
 * punctuation that can end a scalar and start a new node.
 *
 * `compose.ts` solves the same problem by emitting through a YAML library with
 * `compat: 'yaml-1.1'`. These manifests are hand-written templates rather than a
 * document tree, so the quoting has to be explicit -- and explicit is what a corpus can
 * be pointed at.
 */
const YAML11_BOOLEANS =
  /^(y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/u;

const YAML11_NUMERIC = /^[-+]?(0[boxX]?[0-9a-fA-F_]*|[0-9][0-9_]*(\.[0-9_]*)?([eE][-+]?[0-9]+)?)$/u;

const YAML11_SPECIAL = /^(~|null|Null|NULL|\.inf|\.Inf|\.INF|[-+]\.inf|\.nan|\.NaN|\.NAN)$/u;

/** Sexagesimal: YAML 1.1 reads `12:30:45` as 45045. */
const YAML11_SEXAGESIMAL = /^[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+(\.[0-9_]*)?$/u;

/**
 * One value, emitted so a YAML 1.1 reader gets back the string that went in.
 *
 * Double quotes with the two escapes JSON needs, because a double-quoted YAML scalar and
 * a JSON string are the same grammar for everything these values can hold.
 */
export function scalar(value: string): string {
  // Anything that could end the scalar, start a new node, carry an indicator, or be
  // read as a line break by a YAML parser. U+0085, U+2028 and U+2029 are line breaks in
  // YAML even though JavaScript's `\n` is not one of them.
  const structural = /[\n\r\t\u0085\u2028\u2029]/u;
  const indicator = /^[\s\-?:,[\]{}#&*!|>'"%@`]/u;
  const plain =
    value !== '' &&
    !YAML11_BOOLEANS.test(value) &&
    !YAML11_NUMERIC.test(value) &&
    !YAML11_SPECIAL.test(value) &&
    !YAML11_SEXAGESIMAL.test(value) &&
    !structural.test(value) &&
    !indicator.test(value) &&
    !value.includes(': ') &&
    !value.includes(' #') &&
    value.trim() === value;
  return plain ? value : JSON.stringify(value);
}

/**
 * Refuse a value that is not a legal Kubernetes object name.
 *
 * Quoting keeps the DOCUMENT well formed; it does not make `houston-a b` a namespace. A
 * name that cannot exist should be refused where it is written down rather than where the
 * API server rejects the whole apply.
 */
export function requireSafeName(value: string, what: string): string {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(value) || value.length > 253) {
    throw new TypeError(
      `${what} '${value}' is not a legal Kubernetes name: lower-case letters, digits and ` +
        'dashes only, starting and ending with a letter or digit.',
    );
  }
  return value;
}

/**
 * Drop `fsGroup` from the chart's CONTAINER securityContext, if it puts one there.
 *
 * `fsGroup` is a POD-level field. Chart 6.26.0 -- the exact-match chart for Rocket.Chat
 * 7.10.0 -- ships it on the container, where the field does not exist. Helm 3 applied
 * client-side and silently dropped it; Helm 4 applies server-side, and the API server
 * refuses the whole Deployment with "field not declared in schema". That makes every
 * Rocket.Chat 7.x install fail on this runtime, which went unseen because every live run
 * so far used 8.5.1: chart 7.0.0 fixed it upstream.
 *
 * `null` rather than a replacement map, because Helm MERGES values: passing `{runAsUser:
 * 999}` leaves the chart's `fsGroup: 999` in place underneath. `null` is Helm's delete.
 *
 * And it is applied only where the chart actually has the field, which is why this reads
 * the chart's own values first. Injecting `fsGroup: null` unconditionally put a literal
 * `fsGroup: null` onto chart 7.0.0's container -- the same undeclared field, arrived at
 * from the other direction.
 */
export async function containerSecurityContext(
  chartVersion: string,
): Promise<Record<string, unknown>> {
  const res = await kube.run(['helm', 'show', 'values', CHART, '--version', chartVersion], {
    timeout: APPLY_TIMEOUT,
    own: true,
  });
  if (res.returncode !== 0) return {};
  let values: unknown;
  try {
    values = YAML.parse(res.stdout || '', { uniqueKeys: false });
  } catch {
    return {};
  }
  const current =
    values !== null && typeof values === 'object'
      ? (values as Record<string, unknown>).containerSecurityContext
      : undefined;
  if (current === null || typeof current !== 'object' || !('fsGroup' in current)) return {};
  return { containerSecurityContext: { fsGroup: null } };
}

/** The headless Service and the metadata preceding the pod template. */
function mongoServiceAndStatefulSetHead(labelYaml: string): string {
  return `apiVersion: v1
kind: Service
metadata:
  name: ${MONGO_SERVICE}
  labels:
${labelYaml}
spec:
  clusterIP: None
  # The same circular dependency as the readiness probe, one layer down. A headless
  # Service does NOT publish DNS for a not-ready pod, and this pod cannot be ready
  # until the replica set is initiated -- so \`rs.initiate\` could not resolve
  # \`${MONGO_SERVICE}-0.${MONGO_SERVICE}\` to check the member is itself, and mongod
  # refused with "no host described in new configuration ... maps to this node".
  # Publishing not-ready addresses is the standard bootstrap pattern for a
  # StatefulSet database; the MongoDB operator does the same.
  publishNotReadyAddresses: true
  selector:
    app: ${MONGO_SERVICE}
  ports:
  - port: 27017
    name: mongo
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${MONGO_SERVICE}
  labels:
${labelYaml}
spec:
  serviceName: ${MONGO_SERVICE}
  replicas: 1
  selector:
    matchLabels:
      app: ${MONGO_SERVICE}
`;
}

/**
 * The secured mongod container and its replica-set readiness probe.
 *
 * Its YAML comments are the established ones byte for byte, the helpers they name
 * included: they go to `kubectl apply -f -` and into the recorded manifest, and a reworded
 * comment would make both differ from what earlier releases send.
 */
function mongoPodTemplate(tag: string, podLabels: string): string {
  return `  template:
    metadata:
      labels:
        app: ${MONGO_SERVICE}
${podLabels}
    spec:
      # PodSecurity \`restricted\` REJECTS A POD WITHOUT THIS, and it rejects it in the
      # quietest possible way: the StatefulSet is accepted, no pod is ever created,
      # and every diagnostic houston has goes blind -- \`terminal_pod_failure\` finds
      # no pod, \`pod_rows\` is empty, \`storage_blocker\` says nothing, and the PVC sits
      # Pending pointing at storage, which is not the problem. The user paid a 300s
      # wait and got an error naming \`kubectl describe pod mongodb-0\`, a pod that
      # does not exist. Mirrors what the operator path already sets.
      securityContext:
        runAsNonRoot: true
        runAsUser: 999
        fsGroup: 999
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: mongod
        image: ${scalar(mongoImage(tag))}
        args: ["--replSet", "rs0", "--bind_ip_all"]
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
        # Requests so the scheduler can place it and a namespace quota does not
        # reject the pod outright; no CPU limit, because throttling mongod during a
        # restore is how a backup test becomes a timeout.
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            memory: 2Gi
        ports:
        - containerPort: 27017
        volumeMounts:
        - name: data
          mountPath: /data/db
        readinessProbe:
          exec:
            command: ["mongosh", "${MONGO_DIRECT_URI}", "--quiet", "--eval",
                      "db.adminCommand('ping')"]
          initialDelaySeconds: 10
          periodSeconds: 5
`;
}

/**
 * A single-node MongoDB replica set with a PVC.
 *
 * A replica set rather than a standalone mongod because Rocket.Chat needs change streams.
 * `volumeClaimTemplates` rather than nothing, so the data survives a pod reschedule.
 *
 * `storageClassName` is omitted when empty, which makes Kubernetes use the cluster's
 * default. That is what keeps this working unchanged on kind (`standard`), k3s
 * (`local-path`) and a real cluster.
 *
 * THE TAG IS RE-CHECKED HERE, not only where `--mongo` is accepted: this function builds
 * YAML from a template, so the tag is a caller-supplied value that could add structure
 * rather than fill a slot. Two checks rather than one because the boundary is the useful
 * error and the template is the one that must not be wrong.
 */
export function mongoManifest(
  name: string,
  tag: string,
  { owner = '', storageClass = '' }: { owner?: string; storageClass?: string } = {},
): string {
  requireValidMongoTag(tag);
  const labels = labelsFor(name, owner);

  /**
   * Label block at a given indent. Every nesting level needs its own: the first version
   * reused one 4-space block everywhere, and inside `volumeClaimTemplates` that put the
   * labels at the same level as `metadata`, so they became keys of the template item. The
   * result is valid YAML and an invalid manifest -- which a parse test cannot see, and
   * the API server rejected with "unknown field
   * spec.volumeClaimTemplates[0].app.kubernetes.io/managed-by".
   */
  const at = (indent: number): string =>
    Object.entries(labels)
      .map(([key, value]) => `${' '.repeat(indent)}${scalar(key)}: ${scalar(value)}`)
      .join('\n');

  // SIX SPACES, which is `accessModes`' own indent. This was eight on both sides -- so
  // `storageClassName` became a child of the scalar above it and the whole two-document
  // manifest stopped parsing, Service included. Found by sending the documents to a real
  // API server; fixed in the previous implementation too, with a test proven to fail first.
  const scLine = storageClass === '' ? '' : `\n      storageClassName: ${scalar(storageClass)}`;
  return (
    mongoServiceAndStatefulSetHead(at(4)) +
    mongoPodTemplate(tag, at(8)) +
    `  volumeClaimTemplates:
  - metadata:
      name: data
      labels:
${at(8)}
    spec:
      accessModes: ["ReadWriteOnce"]${scLine}
      resources:
        requests:
          storage: ${String(MONGO_VOLUME_GB)}Gi
`
  );
}

/** `[repository, tag]` for the chart, which wants them separately: see `lib/compose`. */
export { splitImage } from '../../lib/compose';

/**
 * Bind a scenario's native resources to this namespace-local workspace.
 *
 * A scenario adapter cannot know the workspace name when it renders, so it writes a
 * placeholder and the lifecycle fills it in. The label it feeds -- `houston.io/repro` --
 * is what makes the resource show up under this workspace's ownership rather than
 * floating in the namespace unattributed.
 */
export function renderScenarioManifest(manifest: string, name: string, advertised = ''): string {
  const bound = manifest.split('__HOUSTON_NAME__').join(name);
  // The address a BROWSER reaches Rocket.Chat at, which Compose's file writer fills into a
  // page (the livechat demo's widget loads from it). Left as written when not known.
  return advertised === '' ? bound : bound.split('{{ROOT_URL}}').join(advertised);
}

/**
 * Write what was sent to helm and kubectl into the workspace directory.
 *
 * A Compose workspace has a docker-compose.yml you can read; a Kubernetes one had nothing
 * but repro.json, because values go to `helm --values -` and manifests to `kubectl apply
 * -f -` on stdin. That is good for secrets and bad for answering "what did it actually
 * deploy" -- especially once the cluster is gone, when the live `helm get values` is no
 * longer there to ask.
 *
 * So they are written for READING. Re-running `up` regenerates them, exactly as it
 * regenerates docker-compose.yml, and editing them changes nothing.
 *
 * SECRETS ARE NOT WRITTEN. The MongoDB URL carries a generated SCRAM password and lives
 * only in a Kubernetes Secret; putting it here would undo the whole point of moving it off
 * `helm get values`. `values.yaml` names the Secret instead, which is what the running
 * release does too.
 */
export async function recordRendered(
  name: string,
  { values, manifests }: { values: Record<string, unknown>; manifests: Record<string, string> },
): Promise<string[]> {
  const out = joinPath(config.reprosDir(), name, 'kubernetes');
  await fs.mkdir(out, { recursive: true });
  const written = [joinPath(out, 'values.yaml')];
  // `safeDump(values)`, keys in document order, through `yaml-dump.ts`'s YAML 1.1
  // emitter. The `yaml` package with YAML 1.1 options kept `'no'` quoted and a list at its
  // key's column, but quoted with `"` where the established file has `'8.0'` and never
  // folded a long value at the 80th column, so the file `up` wrote was not the established
  // one -- and `upgrade` reads and rewrites it.
  await atomicWrite(joinPath(out, 'values.yaml'), safeDump(values));
  for (const [label, manifest] of Object.entries(manifests)) {
    if (manifest === '') continue;
    const target = joinPath(out, `${label}.yaml`);
    await atomicWrite(target, manifest);
    written.push(target);
  }
  return written;
}
