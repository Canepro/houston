/**
 * A three-valued answer, because a refused read is not an empty one.
 *
 * Tier k1. `Answer` is PRESENT, ABSENT or REFUSED, and the whole module exists so a caller
 * cannot write `if (askObject(...))` and silently treat "the cluster would not say" as "it is
 * not there". That conflation is the defect `namespaceLabels` was fixed for in v0.70.9 and
 * the one this vocabulary exists to make unwritable.
 *
 * ## Why this is a discriminated union and not a class
 *
 * The previous implementation's `Answer` refuses a truth test with a `TypeError`, which
 * makes `if answer:` a runtime error at the moment it is written. TypeScript has no
 * equivalent: EVERY object is truthy in a condition, a phantom brand does not change that,
 * and removing `valueOf` and `toString` does not either -- so the failure mode here is a
 * silent `true` rather than a raise. The collapse that deleted a live cluster happened at a
 * CONSUMER, which is exactly where a silent `true` would land.
 *
 * Two things replace the raise, and they are both needed:
 *
 *  1. `Answer<T>` is a discriminated union on `state`, so a consumer that wants a
 *     document has to narrow before it can read one. That is the type system doing what
 *     it can.
 *  2. `@typescript-eslint/strict-boolean-expressions` with objects disallowed makes
 *     `if (answer)` an ERROR rather than a silent always-true. That is the part a type
 *     cannot do, and `yarn lint:truthiness` plants the misuse in a real consumer OUTSIDE
 *     this package, requires lint to reject that exact line, and restores the tree --
 *     because a rule nobody has tried to break is a rule nobody knows is on.
 *
 * Consumers switch on `answer.state` or use the `present`/`absent`/`refused` guards.
 */
import { DockerError } from '../../lib/errors';

import { kube, type KubectlResult } from './exec';
import { PROBE_TIMEOUT, isOurs } from './names';

/**
 * The three answers an external tool can give about a thing, and the reason this module
 * has a type for them at all. `namespaceLabels` has said it since it was written -- "'I
 * could not ask' and 'it is not there' are different answers and only one of them is
 * safe to act on" -- and it was the ONLY function that implemented it. Five others
 * collapsed the three back to two, each by reading a non-zero exit as a negative answer,
 * and that one habit produced a `down --volumes` that deleted a workspace's record while
 * its namespace was still there, a `prune` that reported namespaces reclaimed that were
 * still Terminating, and a `doctor` that reported "0 nodes, no StorageClass, no ingress"
 * for a cluster with all three.
 *
 * MEASURED, not assumed: kubectl exits 1 for BOTH "namespace absent" and "context does
 * not exist", so no threshold on the exit code can separate them.
 */
export const REFUSED = 'refused';
export const ABSENT = 'absent';
export const PRESENT = 'present';

export type AnswerState = typeof REFUSED | typeof ABSENT | typeof PRESENT;

export type KubeDocument = Record<string, unknown>;

/**
 * What the cluster said about one thing.
 *
 * `absent` is a fact the cluster asserted and is safe to act on. `refused` means nobody
 * knows -- a wrong context, an expired credential, an RBAC denial, an API server that is
 * not answering -- and acting on it as though it meant "no" is the defect this type
 * exists to make unwritable.
 */
export type Answer =
  | { readonly state: typeof PRESENT; readonly doc: KubeDocument; readonly res?: KubectlResult }
  | { readonly state: typeof ABSENT; readonly doc: null; readonly res?: KubectlResult }
  | { readonly state: typeof REFUSED; readonly doc: null; readonly res?: KubectlResult };

export function answer(
  state: AnswerState,
  doc: KubeDocument | null = null,
  res?: KubectlResult,
): Answer {
  const base = res === undefined ? {} : { res };
  if (state === PRESENT) return { state: PRESENT, doc: doc ?? {}, ...base };
  if (state === ABSENT) return { state: ABSENT, doc: null, ...base };
  return { state: REFUSED, doc: null, ...base };
}

export function present(value: Answer): value is Extract<Answer, { state: typeof PRESENT }> {
  return value.state === PRESENT;
}

export function absent(value: Answer): boolean {
  return value.state === ABSENT;
}

export function refused(value: Answer): boolean {
  return value.state === REFUSED;
}

/**
 * The objects of a list read; empty for a list that legitimately holds none.
 *
 * Empty is only ever "the cluster has none of these" -- a refused read never reaches
 * here, because `refused` is a separate state and not an empty list. That equivalence is
 * exactly what made `doctor` report "0 nodes".
 */
export function items(value: Answer): KubeDocument[] {
  const raw = value.doc?.items;
  return Array.isArray(raw) ? (raw as KubeDocument[]) : [];
}

/**
 * The line that explains a failure, not the first 400 characters of noise.
 *
 * Written after a `helm install` failure reported two harmless warnings and hid its own
 * reason. Every tool here puts its diagnostics FIRST and its error LAST -- helm emits
 * klog warnings then `Error: ...`, kubectl emits deprecation notices then the message --
 * so taking a prefix reliably shows the least useful part.
 */
export function why(res: KubectlResult | undefined, { limit = 400 } = {}): string {
  const text = `${res?.stderr ?? ''}\n${res?.stdout ?? ''}`;
  const raw = text.split('\n').filter((line) => line.trim() !== '');
  const lines = raw.map((line) => line.trim());
  if (lines.length === 0) return 'no reason given';

  let named: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (/^(error|Error|ERROR|fatal|Fatal)\b/u.test(line) || line.toLowerCase().includes('error:')) {
      named.push(index);
    }
  }
  // Warnings are not errors, however loudly they are printed. klog prefixes them with
  // I/W and a timestamp, and helm's install failure sits after them.
  named = named.filter((index) => !/^[IWD]\d{4} /u.test(lines[index] ?? ''));
  const at = named.length > 0 ? (named[named.length - 1] as number) : lines.length - 1;

  // THE CONTINUATION LINES ARE THE REASON, and they were being thrown away. The premise
  // above -- diagnostics first, error last -- holds for klog and inverts for a Helm
  // TEMPLATE error, which announces the location on the `Error:` line and puts the cause
  // on the indented lines after it. So the file and line survived and "nil pointer" did
  // not. Indentation is the signal helm itself uses, and a line that starts a new
  // diagnostic is never indented.
  const chosen = [lines[at] ?? ''];
  for (let next = at + 1; next < raw.length; next += 1) {
    const line = raw[next] ?? '';
    if (!/^\s/u.test(line)) break;
    chosen.push(lines[next] ?? '');
  }
  return chosen.join(' ').slice(0, limit);
}

/** The reason a particular answer came back, or '' when there is no process behind it. */
export function answerWhy(value: Answer, { limit = 400 } = {}): string {
  return value.res === undefined ? '' : why(value.res, { limit });
}

/**
 * Raise unless the cluster actually answered. For paths that must not guess.
 *
 * The wording is `namespaceLabels`' own, because it was right: it names the cluster,
 * quotes the tool, and says why a guess is not on offer.
 */
export function require_(value: Answer, what: string, { context }: { context: string }): Answer {
  if (refused(value)) {
    throw new DockerError(
      `could not ask cluster '${context}' about ${what}: ${answerWhy(value)}` +
        " — refusing to guess, because 'I cannot ask' and 'it is not there' are " +
        'different answers and only one of them is safe to act on',
    );
  }
  return value;
}

/**
 * Turn a finished kubectl into one of the three answers.
 *
 * The rule, and the only rule: a zero exit means the API server answered. Absence is
 * then read from the PAYLOAD -- empty for a single object fetched with
 * `--ignore-not-found` -- and never from the exit code.
 */
export function classify(res: KubectlResult, { single }: { single: boolean }): Answer {
  if (res.returncode !== 0) {
    // SECONDARY, AND ONLY EVER SECONDARY: the API server's own reason code.
    // `--ignore-not-found` makes an absent object exit 0 with an empty payload, so
    // reaching here at all means either a kubectl older than the flag or a call site
    // that did not pass it -- and in both cases the server's `(NotFound)` is still a
    // real assertion of absence, so throwing it away would be its own bug.
    //
    // The flag stays the primary test because THIS test was once the only one and got it
    // wrong: the first cut matched "not found", which also matches `Error in
    // configuration: context was not found for specified context: ...` -- a kubeconfig
    // problem read as an absent namespace, the exact confusion this module exists to
    // prevent. Only the API server says `Error from server (NotFound)`.
    if (single && why(res).toLowerCase().replace(/ /gu, '').includes('fromserver(notfound)')) {
      return answer(ABSENT, null, res);
    }
    return answer(REFUSED, null, res);
  }
  const raw = res.stdout.trim();
  if (single && raw === '') {
    // `--ignore-not-found` turns "not there" into exit 0 with nothing on stdout, which
    // is the whole reason it is passed. `-o json` rather than a jsonpath because a
    // jsonpath can be legitimately empty for an object that EXISTS -- a namespace with
    // no labels reads identically to no namespace at all.
    return answer(ABSENT, null, res);
  }
  let doc: unknown = {};
  if (raw !== '') {
    try {
      doc = JSON.parse(raw);
    } catch {
      // The server answered and we cannot parse it. That is not absence.
      return answer(REFUSED, null, res);
    }
  }
  return answer(
    PRESENT,
    doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? (doc as KubeDocument) : {},
    res,
  );
}

export interface AskOptions {
  readonly context: string;
  readonly namespace?: string;
  readonly timeout?: number;
}

/** Ask about ONE named object: PRESENT with its document, ABSENT, or REFUSED. */
export async function askObject(
  kind: string,
  name: string,
  { context, namespace = '', timeout = PROBE_TIMEOUT }: AskOptions,
): Promise<Answer> {
  const argv = ['kubectl', '--context', context];
  if (namespace) argv.push('-n', namespace);
  argv.push('get', kind, name, '--ignore-not-found', '-o', 'json');
  return classify(await kube.run(argv, { own: isOurs(context), timeout }), { single: true });
}

export interface AskListOptions extends AskOptions {
  readonly selector?: string;
  readonly allNamespaces?: boolean;
}

/**
 * Ask for a COLLECTION: PRESENT with `items` (possibly empty), or REFUSED.
 *
 * There is no ABSENT for a list. A cluster that holds no StorageClass answers with an
 * empty collection and exit 0; a cluster nobody could reach is REFUSED. Reading those as
 * the same empty list is what made `doctor` report "0 nodes, no StorageClass, no ingress"
 * for a cluster with all three.
 *
 * `allNamespaces` is `-A`, and it is NOT the default for a reason worth stating: without
 * it kubectl reads the CURRENT namespace, so a namespaced kind asked for without either
 * flag answers about `default` alone -- an empty, exit-0, entirely believable "there are
 * none of those here".
 */
export async function askList(
  kind: string,
  {
    context,
    namespace = '',
    selector = '',
    allNamespaces = false,
    timeout = PROBE_TIMEOUT,
  }: AskListOptions,
): Promise<Answer> {
  const argv = ['kubectl', '--context', context];
  if (namespace && !allNamespaces) argv.push('-n', namespace);
  argv.push('get', kind, '-o', 'json');
  if (allNamespaces) {
    // AFTER the subcommand, and that is not cosmetic. `--namespace` is a global flag and
    // may precede `get`; `--all-namespaces` belongs to `get` itself, and placed before it
    // kubectl answers "flags cannot be placed before plugin name: --context" -- which
    // `Answer` correctly refused to read as "this cluster has no Services".
    argv.push('-A');
  }
  if (selector) argv.push('-l', selector);
  return classify(await kube.run(argv, { own: isOurs(context), timeout }), { single: false });
}
