/**
 * The Helm release: installing it, upgrading it, and undoing a failed one.
 *
 * Tier k3. `helmRollbackOnFailure` picks the flag by the helm actually installed --
 * `--atomic` does not exist in helm 4, it is `--rollback-on-failure` -- because a flag helm
 * does not recognise turns a working install into a broken one.
 */
import { CreateFailedError, DockerError } from '../../lib/errors';
import { info, nullEmit, warn, type Emit } from '../../lib/events';
import { dumps } from '../../lib/json-text';

import { why } from './ask';
import { helmEnv, kube } from './exec';
import { containerSecurityContext } from './manifests';
import {
  APPLY_TIMEOUT,
  CHART,
  INSTALL_TIMEOUT,
  PROBE_TIMEOUT,
  RELEASE,
  isOurs,
  tuning,
} from './names';
import { tool } from './tools';

/** `kubectl apply` a manifest from stdin, so no temp file is left behind. */
export async function apply(
  manifest: string,
  { namespace, context }: { namespace: string; context: string },
): Promise<void> {
  const res = await kube.run(
    ['kubectl', '--context', context, '-n', namespace, 'apply', '-f', '-'],
    { input: manifest, timeout: APPLY_TIMEOUT, own: isOurs(context) },
  );
  if (res.returncode !== 0) throw new CreateFailedError(`kubectl apply failed: ${why(res)}`);
}

function mapOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function listOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/**
 * One line naming what the pods in `namespace` are doing, or '' if it cannot ask.
 *
 * Deliberately best-effort and deliberately silent on failure: this runs beside an install
 * that is going perfectly well, and a progress report that turned a slow create into a
 * failed one would be worse than the silence it replaces.
 */
export async function podsWaiting(namespace: string, context: string): Promise<string> {
  const res = await kube.run(
    ['kubectl', '--context', context, '-n', namespace, 'get', 'pods', '-o', 'json'],
    { timeout: PROBE_TIMEOUT, own: isOurs(context) },
  );
  if (res.returncode !== 0) return '';
  let rows: Record<string, unknown>[];
  try {
    rows = listOf(mapOf(JSON.parse(res.stdout || '{}')).items);
  } catch {
    return '';
  }
  if (rows.length === 0) return 'no pods yet';
  const tally = new Map<string, number>();
  for (const pod of rows) {
    const status = mapOf(pod.status);
    let reason = '';
    for (const container of listOf(status.containerStatuses)) {
      const waiting = String(mapOf(mapOf(container.state).waiting).reason ?? '');
      if (waiting !== '') {
        reason = waiting;
        break;
      }
    }
    // ContainerCreating on a fresh cluster is almost always the image coming down, and
    // saying so is the difference between "it is stuck" and "it is doing the 1.6 GB".
    // Named as what it IS, not as what it is probably doing.
    const labels: Record<string, string> = {
      ContainerCreating: 'starting (usually pulling the image)',
      PodInitializing: 'initialising',
      ImagePullBackOff: 'cannot pull its image',
      ErrImagePull: 'cannot pull its image',
      CrashLoopBackOff: 'crashing on start',
    };
    const label =
      labels[reason] ?? (reason !== '' ? reason : String(status.phase ?? 'unknown').toLowerCase());
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  return [...tally.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([what, count]) => `${String(count)} ${what}`)
    .join(', ');
}

/**
 * Say what the longest step of a create is waiting for, while it waits.
 *
 * THE SILENCE THIS REPLACES WAS MEASURED: 254 seconds between "installing
 * rocketchat/rocketchat" and the next line, on a real EKS create. Both rollback flags
 * imply `--wait`, so helm blocks until the pods are Ready and prints nothing at all while
 * it does -- the output is captured and returns in one piece at the end.
 *
 * Four minutes of nothing is the single worst thing a create does to whoever is watching
 * it, and on a cloud cluster it is also the most expensive: it is where somebody decides
 * the tool has hung and kills it, leaving a half-installed release that the next `up` then
 * has to clear.
 *
 * Returns a stop function. It is a timer on the same event loop -- there is no second
 * thread to join and no window where a stopped reporter is still running.
 */
export function reportInstallProgress(namespace: string, context: string, emit: Emit): () => void {
  let waited = 0;
  let stopped = false;
  const timer = setInterval(() => {
    void (async () => {
      waited += 1;
      if (waited < tuning.INSTALL_QUIET_S) return;
      if ((waited - tuning.INSTALL_QUIET_S) % tuning.INSTALL_REPORT_EVERY_S !== 0) return;
      let doing: string;
      try {
        doing = await podsWaiting(namespace, context);
      } catch {
        return; // never fail a good install to report on it
      }
      // CHECKED AGAIN AFTER THE PROBE, not only before it. `podsWaiting` is a kubectl call
      // that can take PROBE_TIMEOUT, and the install can finish while it is in flight --
      // without this the reporter emits "still installing" AFTER the install has finished,
      // into the middle of the next phase's output.
      if (stopped || doing === '') return;
      const minutes = Math.trunc(waited / 60);
      const seconds = String(Math.trunc(waited) % 60).padStart(2, '0');
      info(emit, `still installing (${String(minutes)}m${seconds}s) — ${doing}`, {
        phase: 'boot',
      });
    })();
  }, 1000);
  // The timer must not hold the process open: this is a reporter, not work.
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * The flag that makes a failed install undo itself, named for the helm installed.
 *
 * `--atomic` DOES NOT EXIST IN HELM 4 -- it is `--rollback-on-failure`, checked against the
 * 4.2.3 on this box. So the usual advice for a wedged release ("just add --atomic") would
 * itself fail here, and a flag helm does not recognise turns a working install into a
 * broken one. `CORE_TOOLS` admits helm 3, which has `--atomic` and not the new name, so the
 * flag is chosen rather than written down.
 *
 * Empty for a helm too old to be sure about: no flag is the behaviour we already had, and
 * guessing wrong costs the install itself.
 */
export async function helmRollbackOnFailure(): Promise<string[]> {
  const found = await tool('helm');
  if (found.path === '' || found.version.length === 0) return [];
  return (found.version[0] as number) >= 4 ? ['--rollback-on-failure'] : ['--atomic'];
}

/**
 * Helm release statuses that mean "an operation died part-way and the release is LOCKED".
 * Helm refuses the next install or upgrade with "another operation
 * (install/upgrade/rollback) is in progress" -- a sentence whose central claim is false,
 * because nothing is in progress; the process that was doing it is gone.
 */
export const PENDING_STATES: readonly string[] = [
  'pending-install',
  'pending-upgrade',
  'pending-rollback',
];

/**
 * A release's STATUS and revision: `['', 0]` when there is no such release.
 *
 * `helm list -q` was the whole answer here, and from helm's own help: "By default, it lists
 * all releases in any status." So a release wedged in `pending-install` was reported
 * present exactly as a healthy one was, `up` went on to `helm upgrade --install`, and helm
 * refused it -- for every subsequent attempt, including `--force`, with no path out that
 * houston knew about.
 *
 * A release has a STATE, not a presence.
 */
export async function releaseState(
  release: string,
  namespace: string,
  context: string,
): Promise<[string, number]> {
  const res = await kube.run(
    ['helm', 'list', '--kube-context', context, '-n', namespace, '-o', 'json'],
    { timeout: APPLY_TIMEOUT, own: isOurs(context) },
  );
  if (res.returncode !== 0) {
    // Not "absent". The caller decides what to do about not knowing; guessing "there is
    // nothing there" here is what would delete a record for a release that exists.
    throw new DockerError(
      `could not list helm releases in ${namespace} on '${context}': ${why(res)}`,
    );
  }
  let rows: Record<string, unknown>[];
  try {
    rows = listOf(JSON.parse(res.stdout || '[]'));
  } catch {
    return ['', 0];
  }
  for (const item of rows) {
    if (item.name === release) {
      const revision = Number.parseInt(String(item.revision ?? 0), 10);
      return [String(item.status ?? ''), Number.isFinite(revision) ? revision : 0];
    }
  }
  return ['', 0];
}

/**
 * Free a release stuck in a pending state. Returns what was done, or ''.
 *
 * The remedy DEPENDS ON WHETHER THERE IS ANYTHING TO GO BACK TO, and getting that wrong is
 * why "just run helm rollback" is not the whole answer: a `pending-install` at revision 1
 * never had a successful revision, so a rollback has no target and fails. That one is
 * uninstalled instead -- nothing it created was ever serving.
 */
export async function clearPendingRelease(
  release: string,
  namespace: string,
  context: string,
  { emit = nullEmit }: { emit?: Emit } = {},
): Promise<string> {
  const [state, revision] = await releaseState(release, namespace, context);
  if (!PENDING_STATES.includes(state)) return '';
  const own = isOurs(context);
  let res;
  let action: string;
  if (revision <= 1) {
    warn(
      emit,
      `the '${release}' release is stuck in ${state} at revision ${String(revision)} — it ` +
        'never completed once, so it is being removed rather than rolled back',
      { phase: 'provision' },
    );
    res = await kube.run(
      ['helm', 'uninstall', release, '--kube-context', context, '-n', namespace],
      {
        timeout: APPLY_TIMEOUT,
        own,
      },
    );
    action = 'uninstalled';
  } else {
    warn(
      emit,
      `the '${release}' release is stuck in ${state} — rolling it back to revision ` +
        `${String(revision - 1)} before continuing`,
      { phase: 'provision' },
    );
    res = await kube.run(
      [
        'helm',
        'rollback',
        release,
        String(revision - 1),
        '--kube-context',
        context,
        '-n',
        namespace,
      ],
      { timeout: INSTALL_TIMEOUT, own },
    );
    action = `rolled back to revision ${String(revision - 1)}`;
  }
  if (res.returncode !== 0) {
    throw new CreateFailedError(
      `the '${release}' release in ${namespace} is stuck in ${state} and could not be ` +
        `freed: ${why(res)}. Nothing is actually in progress — the operation that was ` +
        `holding it has gone. Free it by hand with \`helm uninstall ${release} -n ` +
        `${namespace}\` and try again`,
    );
  }
  info(emit, `'${release}' ${action}`, { phase: 'provision' });
  return action;
}

/**
 * `helm install` with values on stdin, so nothing is written to disk.
 *
 * The release is `rocketchat` -- the official docs' own name -- so every command in them
 * works here by substituting the namespace.
 */
export async function install({
  namespace,
  context,
  values,
  chartVersion = '',
  emit = nullEmit,
}: {
  namespace: string;
  context: string;
  values: Record<string, unknown>;
  chartVersion?: string;
  emit?: Emit;
}): Promise<void> {
  // `upgrade --install`, not `install`. Bringing a workspace back up re-runs this sequence,
  // and plain `install` fails on a release that is already there.
  //
  // A RELEASE LEFT PENDING BY A KILLED OPERATION BLOCKS EVERY LATER ATTEMPT, and helm's
  // refusal says "another operation is in progress" -- which is not true and sends the
  // reader looking for a process that does not exist. Freed here rather than reported,
  // because the state is not something the person asking for a workspace did or can fix.
  try {
    await clearPendingRelease(RELEASE, namespace, context, { emit });
  } catch (error) {
    // Could not even list the releases. Let the install below fail on its own terms; its
    // message is about the thing actually being attempted.
    if (!(error instanceof DockerError)) throw error;
  }
  // THE SAME UNDO THE SHARED RELEASES GET. The rollback flag was applied to the operator
  // and the monitoring stack and not to the workspace's own release -- the one a workspace
  // actually is -- so a partly-applied Rocket.Chat upgrade stayed partly applied.
  const argv = [
    'helm',
    'upgrade',
    '--install',
    RELEASE,
    CHART,
    '--kube-context',
    context,
    '-n',
    namespace,
    '--values',
    '-',
    ...(await helmRollbackOnFailure()),
  ];
  if (chartVersion !== '') argv.push('--version', chartVersion);

  // BESIDE the install, not instead of it. helm is left exactly as it was -- one call whose
  // output comes back in one piece -- and a reporter runs alongside to say what the pods
  // are doing, because helm says nothing at all while `--wait` waits.
  const stop = reportInstallProgress(namespace, context, emit);
  let res;
  try {
    res = await kube.run(argv, {
      // `dumps(values)` on stdin: the values file helm reads, in the established bytes,
      // spaced and ASCII-escaped. `JSON.stringify` wrote it compact.
      input: dumps(values),
      timeout: INSTALL_TIMEOUT,
      env: helmEnv(context),
    });
  } finally {
    // In a `finally`, so a failed install does not leave a reporter describing a namespace
    // nothing is installing into any more.
    stop();
  }
  if (res.returncode !== 0) throw new CreateFailedError(`helm install failed: ${why(res)}`);
}

/**
 * The values a release was installed with -- its `values.yaml`, from helm itself.
 *
 * `helm get values` returns exactly the user-supplied values, which is what a values file
 * IS: the chart's computed defaults are its own business and come back only with `--all`.
 * So this is the guide's "your values.yaml", read from the live release rather than rebuilt
 * from our own records -- it cannot drift from what is actually deployed.
 */
export async function releaseValues(
  release: string,
  namespace: string,
  context: string,
): Promise<Record<string, unknown>> {
  const res = await kube.run(
    ['helm', 'get', 'values', release, '--kube-context', context, '-n', namespace, '-o', 'json'],
    { timeout: APPLY_TIMEOUT, own: isOurs(context) },
  );
  if (res.returncode !== 0) {
    throw new DockerError(
      `could not read the values of release '${release}' in ${namespace}: ${why(res)}`,
    );
  }
  let doc: unknown;
  try {
    doc = JSON.parse(res.stdout || 'null');
  } catch {
    doc = null;
  }
  // `helm get values` answers `null` for a release installed with no values of its own.
  // That is an empty values file, not a failure.
  return doc !== null && typeof doc === 'object' && !Array.isArray(doc)
    ? (doc as Record<string, unknown>)
    : {};
}

/** Give Helm the complete updated values file for an image upgrade. */
async function runImageUpgrade(
  namespace: string,
  context: string,
  chartVersion: string,
  values: Record<string, unknown>,
): Promise<void> {
  const res = await kube.run(
    [
      'helm',
      'upgrade',
      RELEASE,
      CHART,
      '--kube-context',
      context,
      '-n',
      namespace,
      '--version',
      chartVersion,
      '--values',
      '-',
    ],
    // `dumps(values)` on stdin, as the install above pipes it.
    { input: dumps(values), timeout: INSTALL_TIMEOUT, env: helmEnv(context) },
  );
  if (res.returncode !== 0) throw new DockerError(`helm upgrade failed: ${why(res)}`);
}

/**
 * Move a release to a new Rocket.Chat image, the way the official guide does.
 *
 * The guide says: change `image.tag` in your values and run `helm upgrade`. This is that,
 * with two differences it explicitly warns about or implies.
 *
 * First, the chart version IS pinned. The guide's own note says its command "does not pin a
 * chart version, so it installs the latest Rocket.Chat Helm chart" -- which for a tool whose
 * entire purpose is reproducing a customer's exact version would quietly deploy different
 * software than the one asked for.
 *
 * Second, the release's own values are carried over rather than a values file being
 * re-rendered. The one value that must NOT be carried over is the oplog URL: Rocket.Chat 8
 * dropped oplog tailing and chart 7.0.0 removed the key.
 *
 * THIS IS THE GUIDE'S PROCEDURE LITERALLY. It was `--reuse-values`, which is the one thing
 * the guide does not do, and two separate failures came of that. `--reuse-values` never
 * applies the NEW chart's defaults, so a chart that ADDS a templated value renders against a
 * map with no such key -- RC 7.4.0 to 7.10.15 crosses chart 6.23.2 to 6.26.0, which added
 * `podMonitor`, and it died on `nil pointer evaluating interface {}.enabled`. And it carries
 * values that were only ever correct for the chart they were computed against: carrying
 * `fsGroup: null` across the 6.26.0 to 7.0.0 boundary reintroduces the bug it was written to
 * fix. `--reset-then-reuse-values` has the same defect, so no reuse flag is passed at all.
 */
export async function upgradeImage({
  namespace,
  context,
  chartVersion,
  imageRepo,
  tag,
  oplog,
}: {
  namespace: string;
  context: string;
  chartVersion: string;
  imageRepo: string;
  tag: string;
  oplog: boolean;
}): Promise<void> {
  const values = await releaseValues(RELEASE, namespace, context);
  // RECOMPUTED FOR THE TARGET CHART, never carried.
  delete values.containerSecurityContext;
  Object.assign(values, await containerSecurityContext(chartVersion));
  values.image = { ...mapOf(values.image), repository: imageRepo, tag };
  if (!oplog) {
    // With a whole values file supplied, DELETING the key is how you say "not this any
    // more"; `--set ...=null` was the way to say it through a flag.
    delete values.externalMongodbOplogUrl;
  }
  await runImageUpgrade(namespace, context, chartVersion, values);
}
