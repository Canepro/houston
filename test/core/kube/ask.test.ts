import { DockerError } from '../../../src/lib/errors';
import type { KubectlResult } from '../../../src/seams/kubectl';

import {
  ABSENT,
  PRESENT,
  REFUSED,
  absent,
  answer,
  answerWhy,
  askList,
  askObject,
  classify,
  items,
  present,
  refused,
  require_,
  why,
} from '../../../src/core/kube/ask';
import { kube } from '../../../src/core/kube/exec';
import { CONTEXT } from '../../../src/core/kube/names';

const realRun = kube.run;
let calls: readonly string[][] = [];

function reply(overrides: Partial<KubectlResult> = {}): void {
  const recorded: string[][] = [];
  calls = recorded;
  kube.run = (argv) => {
    recorded.push([...argv]);
    return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '', ...overrides });
  };
}

afterEach(() => {
  kube.run = realRun;
});

function result(overrides: Partial<KubectlResult> = {}): KubectlResult {
  return { argv: ['kubectl'], returncode: 0, stdout: '', stderr: '', ...overrides };
}

describe('the three states', () => {
  it('are distinct, and none of them is an alias of another', () => {
    expect(new Set([REFUSED, ABSENT, PRESENT]).size).toBe(3);
    expect(present(answer(PRESENT, { kind: 'Namespace' }))).toBe(true);
    expect(absent(answer(ABSENT))).toBe(true);
    expect(refused(answer(REFUSED))).toBe(true);
    expect(present(answer(REFUSED))).toBe(false);
  });

  it('narrows to a document only once PRESENT is established', () => {
    // The type is what stands in for an answer that refuses to be read as a boolean: a
    // consumer cannot reach `doc` without saying which state it means. `yarn lint:truthiness`
    // covers the other half, which no type system can express in JavaScript.
    const value = answer(PRESENT, { metadata: { name: 'houston-x' } });
    if (present(value)) expect(value.doc.metadata).toEqual({ name: 'houston-x' });
    else throw new Error('present() failed to narrow');
  });

  it('reads an empty list as "the cluster has none", never as a refusal', () => {
    // Treating those as the same is what made doctor report "0 nodes, no StorageClass,
    // no ingress" for a cluster with all three.
    expect(items(answer(PRESENT, { items: [] }))).toEqual([]);
    expect(items(answer(REFUSED))).toEqual([]);
    expect(refused(answer(REFUSED))).toBe(true);
  });

  it('refuses to guess when a path must not', () => {
    const refusal = answer(REFUSED, null, result({ returncode: 1, stderr: 'permission denied' }));
    expect(() => require_(refusal, 'the namespace', { context: 'prod' })).toThrow(DockerError);
    try {
      require_(refusal, 'the namespace', { context: 'prod' });
    } catch (error) {
      expect((error as Error).message).toContain("cluster 'prod'");
      expect((error as Error).message).toContain('permission denied');
      expect((error as Error).message).toContain('refusing to guess');
    }
    expect(require_(answer(ABSENT), 'the namespace', { context: 'prod' }).state).toBe(ABSENT);
  });
});

describe('classifying a finished kubectl', () => {
  it('reads absence from the PAYLOAD, never from the exit code', () => {
    // A zero exit means the API server answered. --ignore-not-found turns "not there"
    // into exit 0 with an empty payload, which is the whole reason it is passed.
    expect(classify(result({ stdout: '' }), { single: true }).state).toBe(ABSENT);
    expect(classify(result({ stdout: '{"kind":"Namespace"}' }), { single: true }).state).toBe(
      PRESENT,
    );
    // And there is no ABSENT for a list: an empty collection is a fact the cluster
    // asserted, so exit 0 with nothing is PRESENT with no items.
    const list = classify(result({ stdout: '{"items":[]}' }), { single: false });
    expect(list.state).toBe(PRESENT);
    expect(items(list)).toEqual([]);
  });

  it('separates a kubeconfig problem from an absent object', () => {
    // The first cut matched "not found", which also matches "Error in configuration:
    // context was not found for specified context" -- a kubeconfig problem read as an
    // absent namespace, the exact confusion this module exists to prevent.
    const configProblem = result({
      returncode: 1,
      stderr: 'error: context was not found for specified context: kind-houston-local',
    });
    expect(classify(configProblem, { single: true }).state).toBe(REFUSED);

    const reallyAbsent = result({
      returncode: 1,
      stderr: 'Error from server (NotFound): namespaces "houston-x" not found',
    });
    expect(classify(reallyAbsent, { single: true }).state).toBe(ABSENT);
    // A LIST never gets that second chance: absence of a collection is not a thing.
    expect(classify(reallyAbsent, { single: false }).state).toBe(REFUSED);
  });

  it('calls an unparseable answer refused, because it is not absence', () => {
    expect(classify(result({ stdout: 'not json at all' }), { single: true }).state).toBe(REFUSED);
  });
});

describe('why a tool failed', () => {
  it('takes the error line, not the first 400 characters of noise', () => {
    // Every tool here puts diagnostics FIRST and its error LAST, so a prefix reliably
    // shows the least useful part.
    const res = result({
      stderr: [
        'W0914 10:00:00.000000 1 warnings.go:70] deprecated API',
        'some chatter',
        'Error: UPGRADE FAILED: no deployed releases',
      ].join('\n'),
    });
    expect(why(res)).toBe('Error: UPGRADE FAILED: no deployed releases');
  });

  it('keeps the indented continuation lines, which are the actual reason', () => {
    // A Helm template error announces the location on the `Error:` line and puts the
    // cause on the lines after it, so the file survived and "nil pointer" did not.
    const res = result({
      stderr: [
        'Error: UPGRADE FAILED: rocketchat/templates/podmonitor.yaml:24:18',
        '  executing "..." at <.Values.podMonitor.enabled>:',
        '    nil pointer evaluating interface {}.enabled',
        'unindented, so a new diagnostic',
      ].join('\n'),
    });
    expect(why(res)).toBe(
      'Error: UPGRADE FAILED: rocketchat/templates/podmonitor.yaml:24:18 ' +
        'executing "..." at <.Values.podMonitor.enabled>: ' +
        'nil pointer evaluating interface {}.enabled',
    );
  });

  it('falls back to the last non-empty line, and says so when there is none', () => {
    expect(why(result({ stdout: 'first\nlast' }))).toBe('last');
    expect(why(result())).toBe('no reason given');
    expect(answerWhy(answer(ABSENT))).toBe('');
  });
});

describe('the questions themselves', () => {
  it('asks for one object with --ignore-not-found and json', async () => {
    reply({ stdout: '{"kind":"Namespace"}' });
    const value = await askObject('namespace', 'houston-x', { context: CONTEXT });
    expect(value.state).toBe(PRESENT);
    expect(calls[0]).toEqual([
      'kubectl',
      '--context',
      CONTEXT,
      'get',
      'namespace',
      'houston-x',
      '--ignore-not-found',
      '-o',
      'json',
    ]);
  });

  it('puts -A AFTER the subcommand, because kubectl refuses it before', async () => {
    // Placed before `get`, kubectl answers "flags cannot be placed before plugin name:
    // --context" -- which Answer correctly refused to read as "this cluster has no
    // Services".
    reply({ stdout: '{"items":[]}' });
    await askList('service', { context: 'prod', allNamespaces: true, selector: 'a=b' });
    expect(calls[0]).toEqual([
      'kubectl',
      '--context',
      'prod',
      'get',
      'service',
      '-o',
      'json',
      '-A',
      '-l',
      'a=b',
    ]);
  });

  it('scopes to a namespace only when not asking across all of them', async () => {
    reply({ stdout: '{"items":[]}' });
    await askList('pod', { context: 'prod', namespace: 'houston-x' });
    expect(calls[0]?.slice(0, 5)).toEqual(['kubectl', '--context', 'prod', '-n', 'houston-x']);

    reply({ stdout: '{"items":[]}' });
    await askList('pod', { context: 'prod', namespace: 'houston-x', allNamespaces: true });
    expect(calls[0]).not.toContain('-n');
  });
});
