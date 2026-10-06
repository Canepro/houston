/**
 * The prose a workspace carries: what it is, how to reach it, what to do next.
 *
 * Every note is built here and rendered by whoever asked -- the CLI prints them, the GUI puts
 * them in a panel -- so nothing in this module may reach for the terminal UI.
 *
 * `noteGroup` is the one constructor; a group with no rows is dropped by
 * `noteGroupsOf`'s callers, so a builder can return an empty group rather than branching
 * at every call site.
 */
import * as config from '../../lib/config';
import { grafanaUrl, notes as monitoringNotes } from '../../lib/monitoring';
import { toText } from '../../lib/format';
import * as presets from '../../lib/presets/index';
import { ACME_ISSUER, CA_ISSUER, tlsSecretFor } from '../kube/certmanager';
import { forwardAlive } from '../kube/forward';
import { CONTEXT as KUBE_CONTEXT, RELEASE, isOurs } from '../kube/names';
import { MONITORING_NAMESPACE } from '../kube/monitoring';
import { OPERATOR_MIN_MONGO, OPERATOR_NAMESPACE } from '../kube/operator';
import { ownedKubeconfig } from '../kube/exec';
import { type Metadata } from '../runner/record';
import { MODE_ACME } from '../tls';
import * as topology from '../topology';

/** One field of a note group: a label and a value, rendered as a table row. */
export type NoteRow = readonly [string, unknown];

/**
 * Three kinds of content, because that is what is actually in there:
 *   rows      -- facts. Key and value, rendered as a table, never as a sentence.
 *   body      -- the thing a reader needs to KNOW. Prose, and only prose.
 *   commands  -- the thing a reader has to PASTE. Its own block, with a copy button.
 *
 * `kind` is what the panel keys on: a `scenario` group is fed back into the scenario card
 * instead of getting a card of its own.
 */
export interface NoteGroup {
  title: string;
  kind: string;
  rows: [string, unknown][];
  body: string[];
  commands: string[];
}

export function noteGroup(
  title: string,
  {
    rows = [],
    body = [],
    commands = [],
    kind = '',
  }: Partial<Pick<NoteGroup, 'rows' | 'body' | 'commands' | 'kind'>> = {},
): NoteGroup {
  return {
    title,
    kind,
    rows: rows.map((row) => [String(row[0]), row[1]]),
    body: [...body],
    commands: [...commands],
  };
}

/** `text` padded on the right to `width`, counted in CODE POINTS, not UTF-16 units. */
function padRight(text: string, width: number): string {
  const length = [...text].length;
  return length >= width ? text : text + ' '.repeat(width - length);
}

/**
 * The groups as the flat string list every existing consumer expects.
 *
 * Indentation is the contract the flat form already had and the CLI and the browser both
 * parse: a four-space line is something to paste. `key: value` rows become that same
 * shape so a terminal reader sees a list rather than a table it has no way to draw.
 */
export function flattenNotes(groups: readonly NoteGroup[]): string[] {
  const out: string[] = [];
  for (const group of groups) {
    const rows = group.rows;
    if (rows.length > 0) {
      const width = Math.max(...rows.map(([key]) => [...String(key)].length));
      out.push(`${group.title}:`);
      out.push(
        ...rows.map(([key, value]) => `    ${padRight(String(key), width)}  ${String(value)}`),
      );
    } else if (group.title) {
      out.push(`${group.title}:`);
    }
    out.push(...group.body);
    out.push(...group.commands.map((command) => `    ${command}`));
  }
  return out;
}

/** Truthiness, as a function -- `unknown` may not appear in a conditional. */
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value !== '';
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Whether the value is an integer -- and `true`/`false` are not, deliberately. */
function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function bag(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The URL's hostname, or "" when it has none. */
function urlHostname(value: string): string {
  if (!value) return '';
  try {
    return new URL(value).hostname;
  } catch {
    // A scheme-less string has no hostname, and `new URL` throws on it: the same answer,
    // "".
    return '';
  }
}

/**
 * Correct `localhost` in a preset's own browser URLs, when it is wrong.
 *
 * `ldap` prints phpLDAPadmin, `s3_minio` its console, `email` Mailpit's inbox, `livechat`
 * a demo page -- all browser URLs, all written when the browser was assumed to be on the
 * docker host. On a workspace bound wide or given a public URL it is not, and `localhost`
 * then names the reader's own machine.
 *
 * KEYED ON THE NOTES THEMSELVES, which the first version got wrong: it fired whenever a
 * preset had side-service ports, so a `saml` workspace whose `idp_host` had already put
 * the real host in every line was told "the URLs above say localhost". They did not.
 */
export function localUrlNote(meta: Metadata, scenario: readonly NoteGroup[]): NoteGroup[] {
  const extra = bag(meta.extra);
  const body = scenario.flatMap((group) => group.body);
  if (!body.some((line) => line.includes('localhost'))) return [];
  const ports = (Array.isArray(extra.sidecar_ports) ? extra.sidecar_ports : []).filter(isInt);
  const bindHost = toText(extra.bind_host);
  const advertised = toText(extra.advertised_url);
  if (ports.length === 0 || !(advertised || !['', '127.0.0.1', 'localhost'].includes(bindHost))) {
    return [];
  }
  const host = urlHostname(advertised) || '<this-box>';
  const shown = [...ports].sort((a, b) => a - b).slice(0, 4);
  return [
    noteGroup("Reaching this preset's own pages", {
      body: [
        'The URLs above say `localhost`, which names whichever machine the browser ' +
          `is on. From anywhere but this box, use ${host} instead: ` +
          `${shown.map((port) => `http://${host}:${String(port)}`).join(', ')}.`,
        `Those ports are published on ${bindHost || '127.0.0.1'}, so they are ` +
          'reachable only as far as that bind allows.',
      ],
    }),
  ];
}

/**
 * The preset's own prose as the leading group. Empty for a plain workspace.
 *
 * DERIVED on every read, not remembered from the create. They used to be built once and
 * frozen into `repro.json`, so the "What works here" note told people `backup` had no
 * Kubernetes path for three releases after it grew one -- and the fix only reached
 * workspaces created after it.
 */
export function scenarioGroup(meta: Metadata): NoteGroup[] {
  const name = (meta.preset || '').trim();
  if (!name || name === 'default') return [];
  const extra = bag(meta.extra);
  const params = bag(extra.params);
  let pre;
  try {
    // The SAME resolution the create used, per runtime: a scenario yields native
    // manifests on Kubernetes and a compose service on Docker, and its notes follow the
    // shape it was built in.
    pre =
      topology.ofMeta(meta) === topology.KUBERNETES
        ? presets.resolve(name, topology.KUBERNETES, params)
        : presets.load(name, params);
  } catch {
    // A preset file removed after the create. This runs on a READ path (`info`, the GUI
    // panel), and a workspace whose preset is no longer loadable still has to be able to
    // describe itself rather than answer 500.
    return [];
  }
  const notes = [...pre.notes];
  if (notes.length === 0) return [];
  // kind="scenario", not a title the panel has to recognise by its prefix.
  return [noteGroup(`Scenario · ${pre.name}`, { kind: 'scenario', body: notes })];
}

/**
 * The HTTPS card for a Kubernetes workspace: where TLS actually terminates.
 *
 * On Compose the edge holds the certificate as a file; here it holds nothing for this
 * name -- it matches the SNI and forwards raw TCP, and the certificate is a
 * `kubernetes.io/tls` Secret that cert-manager filled from an annotation on the chart's
 * own Ingress.
 */
export function kubernetesHttpsGroup(
  meta: Metadata,
  extra: Record<string, unknown>,
  ns: string,
): NoteGroup[] {
  const local = toText(extra.tls) !== MODE_ACME;
  const endpoint = toText(extra.ingress_endpoint);
  const issuer = local ? CA_ISSUER : ACME_ISSUER;
  const body = [
    `${meta.publicUrl} is served by the chart's own Ingress in ${ns}. TLS ` +
      `terminates IN THE CLUSTER, from the Secret ${tlsSecretFor(meta.name)} ` +
      'that cert-manager issued -- so the failure modes a customer hits (a wrong ' +
      'secretName, an expired Certificate, an annotation naming a missing issuer) ' +
      'are the real ones here.',
  ];
  if (endpoint) {
    body.push(
      'The edge does not decrypt this name: it matches the SNI and forwards ' +
        `raw TCP to ${endpoint}. Nothing about the certificate is the edge's, and ` +
        '`houston edge logs` will not mention it.',
    );
  }
  body.push(
    local
      ? 'A locally-issued certificate: run `houston trust-ca` once and the browser ' +
          'accepts it, on every workspace on this box.'
      : "A publicly trusted certificate from Let's Encrypt, obtained by cert-manager " +
          "over the http-01 challenge. Renewal is cert-manager's, not the edge's.",
  );
  return [
    noteGroup('HTTPS', {
      body,
      commands: [
        `kubectl -n ${ns} describe certificate ${tlsSecretFor(meta.name)}`,
        `kubectl describe clusterissuer ${issuer}`,
        `houston tls-status --name ${meta.name}`,
      ],
    }),
  ];
}

/**
 * What to say about a MongoDB this workspace did not create and must not delete.
 *
 * There is no "reachable at <url>" note any more: the summary panel prints the URL
 * immediately above these notes, so the note was the fourth copy of one string on one
 * screen. What is NOT said anywhere else is what a non-loopback bind means.
 */
function sharedMongoNotes(): void {
  // Reserved for the wording the previous implementation kept here. It is deliberately
  // empty: every sentence that used to live in it was either moved to the panel or
  // withdrawn, and an empty function is the honest record of that.
}

/** The MongoDB group itself, and the notes about a database this workspace does not own. */
export function mongoGroupAndSharedNotes(
  extra: Record<string, unknown>,
  meta: Metadata,
  ns: string,
): [NoteGroup, NoteGroup[]] {
  let mongoGroup: NoteGroup;
  let shared: NoteGroup[];
  if (extra.mongo_managed_by === 'operator') {
    mongoGroup = noteGroup('MongoDB', {
      rows: [
        ['Version', meta.mongoTag],
        ['Image', toText(extra.mongo_image)],
        ['Managed by', 'the official operator'],
        ['Authentication', 'SCRAM'],
      ],
    });
    shared = [
      noteGroup('The MongoDB operator is shared', {
        body: [
          `One install in ${OPERATOR_NAMESPACE} watches every namespace, ` +
            'rather than one per workspace as the official guide shows. Its CRDs ' +
            'are cluster-scoped, so a second per-workspace install would collide ' +
            `on them. Nothing of it lives in ${ns} except the database, its Secrets ` +
            'and its ServiceAccount.',
        ],
        commands: [
          `kubectl -n ${OPERATOR_NAMESPACE} get pods`,
          `kubectl -n ${ns} get mongodbcommunity`,
        ],
      }),
    ];
  } else {
    mongoGroup = noteGroup('MongoDB', {
      rows: [
        ['Version', meta.mongoTag],
        ['Image', toText(extra.mongo_image)],
        ['Managed by', 'a plain StatefulSet'],
        ['Authentication', 'none'],
      ],
      body: [
        "This path is houston's own: the official guide documents only the " +
          'operator, which needs MongoDB ' +
          `${OPERATOR_MIN_MONGO.map(String).join('.')}+. Add ` +
          '`--mongo-operator` for the documented path, with authentication.',
      ],
    });
    shared = [];
  }
  sharedMongoNotes();
  return [mongoGroup, shared];
}

/**
 * Where MongoDB came from, which decides what a reader can do about it: the operator's
 * CRD, a StatefulSet houston made, or a shared one somebody else owns.
 */
export function kubernetesMongoGroup(
  bindHost: string,
  extra: Record<string, unknown>,
  meta: Metadata,
  ns: string,
): [string, NoteGroup, NoteGroup[]] {
  // The port-forward carries the bind host: a workspace created with `--bind 0.0.0.0`
  // needs `--address 0.0.0.0` to come back the same way.
  const addr =
    bindHost === '' || bindHost === '127.0.0.1' || bindHost === 'localhost'
      ? ''
      : `--address ${bindHost} `;
  const [mongoGroup, shared] = mongoGroupAndSharedNotes(extra, meta, ns);
  return [addr, mongoGroup, shared];
}

/** A port-forward that has died, and an address other machines can use. */
export function forwardAndReachNotes(
  addr: string,
  bindHost: string,
  extra: Record<string, unknown>,
  meta: Metadata,
  ns: string,
  port: number,
  root: string,
): [NoteGroup[], NoteGroup[]] {
  let forward: NoteGroup[] = [];
  const recordedPid = extra.port_forward_pid;
  if (
    ns &&
    typeof recordedPid === 'number' &&
    recordedPid !== 0 &&
    !forwardAlive(recordedPid, { namespace: ns, hostPort: port })
  ) {
    forward = [
      noteGroup('The URL is not published right now', {
        body: [
          `No port-forward is running for this workspace, so ${root} will not ` +
            'answer -- a forward dies with its pod, and houston does not keep one ' +
            'alive in the background. This says nothing about Rocket.Chat itself; ' +
            'the pods may be perfectly healthy.',
        ],
        commands: [
          `houston ready --name ${meta.name}`,
          `houston start --name ${meta.name}   # if it is stopped`,
        ],
      }),
    ];
  }
  let reach: NoteGroup[] = [];
  if (addr) {
    reach = [
      noteGroup('Reachable from other machines', {
        body: [
          `This workspace publishes on ${bindHost}, so it answers at ` +
            `http://<this-box>:${String(port)} from anything that can route here -- and it ` +
            `runs ${config.ADMIN_USERNAME}/${meta.adminPassword || config.ADMIN_PASSWORD}. Keep it off ` +
            'untrusted networks.',
        ],
      }),
    ];
  }
  return [forward, reach];
}

/** Step 3: the read-only commands, which are the ones a support case runs. */
export function lookAtWhatIsInside(ns: string, release: string): NoteGroup {
  return noteGroup('3 · Look at what is inside', {
    body: [
      'What is running, what Rocket.Chat is saying, and the values the release ' +
        'was installed with:',
    ],
    commands: [
      `kubectl -n ${ns} get pods`,
      `kubectl -n ${ns} logs -l app.kubernetes.io/name=rocketchat -f`,
      `helm -n ${ns} get values ${release}`,
    ],
  });
}

/** Step 2: the port-forward, which is tied to a pod and dies with it. */
export function openTheWayIn(
  ns: string,
  release: string,
  root: string,
  port: number,
  addr: string,
): NoteGroup {
  return noteGroup('2 · Open the way in', {
    body: [
      'Rocket.Chat is reached through a port-forward, which is tied to its pod ' +
        `and dies with it. This is the one houston started, so run it again if ` +
        `${root} stops answering:`,
    ],
    commands: [
      `kubectl -n ${ns} port-forward ${addr}deployment/${release}-rocketchat ${String(port)}:3000`,
    ],
  });
}

/**
 * The three numbered steps a support engineer follows on this runtime.
 *
 * Different enough from Compose's that one set of words would serve neither. THE ORDER
 * IS THE SEQUENCE somebody has to perform: the export has to come before every other
 * line, and the port-forward before anything that reaches Rocket.Chat itself, so the
 * three groups read top to bottom as: point your tools here, open the way in, then look
 * at what is inside.
 */
export function howToWorkWithIt(
  meta: Metadata,
  ns: string,
  context: string,
  release: string,
  root: string,
  port: number,
  addr: string,
  shared: readonly NoteGroup[],
): NoteGroup[] {
  return [
    // WHICH kubeconfig, and it is not the same answer on both clusters. houston keeps its
    // own only for the cluster it CREATED. The note said "export KUBECONFIG=<houston's
    // own>" unconditionally -- wrong three ways on an adopted cluster.
    isOurs(context)
      ? noteGroup('1 · Point kubectl and helm at this cluster', {
          body: [
            'houston keeps its own kubeconfig so creating a cluster cannot move the ' +
              'context you were using. A bare `kubectl` will not see this workspace ' +
              'until it is pointed here, and every command below assumes it:',
          ],
          commands: [`export KUBECONFIG=${ownedKubeconfig()}`],
        })
      : noteGroup('1 · Your kubectl already reaches this workspace', {
          // houston never moves kubectl's current context (a build puts it back where it
          // was), so the commands below reach this cluster only once it is pointed here.
          // "Every command below runs against '<context>'" and "# expect <context>" read as
          // a promise that was false on any box whose kubectl pointed somewhere else.
          body: [
            'This workspace lives in an existing cluster, so there is nothing to ' +
              'export -- houston used the kubeconfig this machine already has and wrote ' +
              'none of its own. The commands below use kubectl’s current context; point it ' +
              `at '${context}' first, or add \`--context ${context}\` to each of them.`,
          ],
          commands: [
            `kubectl config current-context   # if it is not ${context}: kubectl config use-context ${context}`,
          ],
        }),
    openTheWayIn(ns, release, root, port, addr),
    // HTTPS, WHICH THIS RUNTIME'S NOTES SAID NOTHING ABOUT, and it must NOT reuse the
    // Compose wording: that card names the edge as the terminator, which is false here.
    ...(meta.publicUrl ? kubernetesHttpsGroup(meta, bag(meta.extra), ns) : []),
    lookAtWhatIsInside(ns, release),
    // After the three steps, not before them: it carries two `kubectl` lines, and nothing
    // that needs the kubeconfig may appear above the export that sets it.
    ...shared,
  ];
}

/** What a Kubernetes workspace is and how to reach it, from its record. */
export function kubernetesNoteGroups(meta: Metadata): NoteGroup[] {
  const extra = bag(meta.extra);
  const ns = toText(extra.namespace) || meta.project || '';
  const release = toText(extra.release) || RELEASE;
  const context = toText(extra[config.EXTRA_CONTEXT]) || KUBE_CONTEXT;
  const micro = String(topology.axesOfMeta(meta).deployment ?? '') === topology.MICROSERVICES;
  const pods = micro ? 9 : 5;
  const bindHost = toText(extra.bind_host);
  const port = meta.hostPort || 3000;
  const root = meta.rootUrl || `http://localhost:${String(port)}`;
  const [addr, mongoGroup, shared] = kubernetesMongoGroup(bindHost, extra, meta, ns);
  const [forward, reach] = forwardAndReachNotes(addr, bindHost, extra, meta, ns, port, root);
  // A managed cluster by the name a person knows, its region and its kind; the ARN is
  // what a command needs and the summary carries it as `context`. And the one fact about
  // a managed cluster nothing on the workspace said: it bills whether or not this runs.
  const managed = /^arn:aws:eks:/u.test(context);
  const clusterRow = managed
    ? `${context.split('/').pop() ?? context} · ${context.split(':')[3] ?? ''} · EKS`
    : context;
  return [
    noteGroup('Kubernetes', {
      rows: [
        ['Cluster', clusterRow],
        ['Namespace', ns],
        ['Arrangement', micro ? 'microservices' : 'monolith'],
        ['Pods', `about ${String(pods)}`],
        ...(managed
          ? [
              [
                'Costs',
                'the cluster bills by the hour whether or not this workspace runs — ' +
                  '`houston cluster overview` prices it',
              ] as [string, string],
            ]
          : []),
      ],
    }),
    mongoGroup,
    ...forward,
    ...reach,
    ...howToWorkWithIt(meta, ns, context, release, root, port, addr, shared),
    noteGroup('Monitoring', {
      rows: isTruthy(extra.monitoring)
        ? [
            ['Grafana', grafanaUrl(isTruthy(extra.tls) ? meta.publicUrl : '', true)],
            ['Login', 'admin/admin; anonymous Viewer'],
          ]
        : [],
      body: [
        'Prometheus and Grafana are shared by the cluster, not installed per ' +
          `workspace: this puts one stack in ${MONITORING_NAMESPACE}, and \`--off\` ` +
          'leaves it up while any other workspace still wants it.',
      ],
      commands: [`houston monitor --name ${meta.name}`],
    }),
    // This used to say "logs, stats and backup have no Kubernetes path yet". Two of the
    // three were right and backup was not, so a stale note cost a capability that already
    // existed -- which is why this is derived and not read back out of a record.
    noteGroup('What works here', {
      body: [
        '`logs`, `stats`, `env`, `upgrade`, `backup`, `restore`, `seed`, ' +
          '`monitor`, `api`, `pat` and `token` all work on this runtime. `stats` ' +
          'needs metrics-server in the cluster and says so if it is missing; ' +
          '`env --set` refuses and hands over the `helm upgrade` that changes a ' +
          'value.',
      ],
    }),
  ];
}

/**
 * The add-ons a Compose workspace gained, each as its own group.
 *
 * Same three sources the create appended to the flat list -- the scenario, the edge, the
 * monitoring stack -- so this changes their shape and not one word of their content.
 */
export function composeNoteGroups(meta: Metadata): NoteGroup[] {
  const extra = bag(meta.extra);
  const groups: NoteGroup[] = [];
  if (isTruthy(extra.edge) && meta.publicUrl) {
    groups.push(
      noteGroup('HTTPS', {
        body: [
          `served by the edge at ${meta.publicUrl}`,
          'the edge holds :443 for the whole box; this workspace publishes none',
        ],
      }),
    );
  }
  if (isTruthy(extra.monitoring)) {
    const publicUrl = isTruthy(extra.tls) ? meta.publicUrl : '';
    groups.push(
      noteGroup('Monitoring', { body: monitoringNotes(grafanaUrl(publicUrl, !!publicUrl)) }),
    );
  }
  return groups;
}

/** Every group this workspace has, scenario first. The one entry point. */
export function noteGroupsOf(meta: Metadata): NoteGroup[] {
  const scenario = scenarioGroup(meta);
  if (topology.ofMeta(meta) === topology.KUBERNETES) {
    // Not corrected here: a Kubernetes workspace is reached through a port-forward the
    // reader runs themselves, so `localhost` is genuinely their localhost.
    return [...scenario, ...kubernetesNoteGroups(meta)];
  }
  return [...scenario, ...composeNoteGroups(meta), ...localUrlNote(meta, scenario)];
}
