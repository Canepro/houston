/**
 * INVARIANT: the shape rules the Kubernetes package is held to.
 *
 * MECHANISM: ts-morph, and these are the ones that genuinely need the syntax tree.
 *
 * Each of these is a claim about a SHAPE that appears in many functions, not about one
 * value a call produces: "no read anywhere answers a failed call with an empty literal"
 * cannot be driven, because driving it means enumerating the reads -- which is the walk.
 * What differs from earlier releases is the matching. Their versions were substring searches over
 * module text (a prefix test that must not appear, a list of process, socket and file calls that
 * must not appear) and they read prose: a comment explaining why a module must not start the
 * edge counted as starting it, which a sibling guard over the edge package recorded as exactly
 * that trap. A syntax tree does not read comments.
 *
 * EVERY RULE HERE PROVES ITS OWN MATCHER. A walk that silently matches nothing is the
 * failure mode this repository keeps paying for, so each test feeds the matcher a planted
 * example of the construct it forbids and asserts it is recognised, then asserts the real
 * tree is clean.
 */
import * as path from 'node:path';

import { Project, SyntaxKind, type SourceFile, type FunctionDeclaration } from 'ts-morph';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const KUBE = path.join(ROOT, 'src', 'core', 'kube');

function project(): Project {
  return new Project({
    tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });
}

function kubeSources(): SourceFile[] {
  const created = project();
  created.addSourceFilesAtPaths([path.join(KUBE, '**', '*.ts')]);
  return created.getSourceFiles();
}

/**
 * Functions that answer a failed call with an empty literal.
 *
 * Shared by the real walk and by the planted-example control below, so the control
 * cannot drift away from the matcher it is meant to be proving.
 */
function emptyAnswersOnFailure(file: SourceFile, allowed: ReadonlySet<string>): string[] {
  const offenders: string[] = [];
  const functions: FunctionDeclaration[] = file.getFunctions();
  for (const fn of functions) {
    const name = fn.getName() ?? '';
    if (allowed.has(name)) continue;
    // A signature that admits null is DECLARING the third answer, so returning it is the
    // fix rather than the defect. This is what makes the walk teach the pattern instead of
    // forbidding a token.
    const returns = fn.getReturnTypeNode()?.getText() ?? '';
    if (returns.includes('null')) continue;
    for (const statement of fn.getDescendantsOfKind(SyntaxKind.IfStatement)) {
      const condition = statement.getExpression().getText().replace(/\s+/gu, '');
      if (!/returncode!==0|returncode!=0/u.test(condition)) continue;
      const then = statement.getThenStatement();
      const body =
        then.getKind() === SyntaxKind.Block
          ? then.asKindOrThrow(SyntaxKind.Block).getStatements()
          : [then];
      if (body.length !== 1) continue;
      const only = body[0];
      if (only === undefined || only.getKind() !== SyntaxKind.ReturnStatement) continue;
      const value = only.asKindOrThrow(SyntaxKind.ReturnStatement).getExpression();
      const text = value === undefined ? 'undefined' : value.getText().replace(/\s+/gu, '');
      if (
        ['[]', '{}', "''", '""', '0', 'false', 'undefined', 'newMap()', 'newSet()'].includes(text)
      ) {
        offenders.push(`${path.basename(file.getFilePath())}:${name} -> ${text}`);
      }
    }
  }
  return offenders;
}

describe('a Kubernetes read never answers a failed call with an empty one', () => {
  /**
   * The functions allowed to, each for a reason.
   */
  const ALLOWED = new Set([
    'workspaceReady',
    'podRows',
    'workspacePvcs',
    'containerSecurityContext',
    // `podsWaiting` returns a PROGRESS LINE, not a finding: '' means "say nothing this
    // tick", and the only caller skips the emit on it.
    'podsWaiting',
    // THESE TWO ARE THE HAZARD AND ARE CARRIED, NOT ENDORSED, and this walk is how they
    // became visible at all. Both write `if (res.returncode !== 0 || <empty>)` -- a
    // COMPOUND condition -- and earlier releases' walk only matches a bare comparison, so it
    // has never seen either of them. `mongoToolAuth` answering `''` to a refused
    // `kubectl get secret` sends `mongodump` at an operator-managed MongoDB with no
    // credentials; `mongoPodsTheOperatorKeeps` answering an empty set to a refused read
    // would scale down the pods the operator will not give up. Fixing either changes what the
    // command DOES, which would no longer be byte-identical to earlier releases, so it is named
    // here and left for a deliberate behaviour change. Being on this list is the record that
    // somebody looked.
    'mongoToolAuth',
    'mongoPodsTheOperatorKeeps',
    // `false` here is "not this machine", which REFUSES: an unreadable kubeconfig server
    // keeps houston's CA key on this box. The failed read lands on the safe side.
    'serverIsThisMachine',
  ]);

  it('recognises the construct it forbids', () => {
    const planted = project().createSourceFile(
      'planted.ts',
      `
export async function storageClasses(): Promise<string[]> {
  const res = await kube.run(['kubectl', 'get', 'storageclass']);
  if (res.returncode !== 0) {
    return [];
  }
  return [res.stdout];
}
`,
    );
    // THE POSITIVE CONTROL. Without it a walk that matched nothing -- a renamed field, a
    // changed spelling of the guard -- would report a clean tree and keep reporting one.
    expect(emptyAnswersOnFailure(planted, new Set())).toEqual(['planted.ts:storageClasses -> []']);
    // And the escape hatches really are escape hatches.
    expect(emptyAnswersOnFailure(planted, new Set(['storageClasses']))).toEqual([]);
  });

  it('finds none in the package', () => {
    const files = kubeSources();
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.flatMap((file) => emptyAnswersOnFailure(file, ALLOWED));
    expect(offenders).toEqual([]);
  });
});

describe('which kubeconfig to use is decided in one place', () => {
  it('is spelled out only inside envFor', () => {
    const exec = kubeSources().find((file) => path.basename(file.getFilePath()) === 'exec.ts');
    expect(exec).toBeDefined();
    const inside = exec?.getFunction('envFor')?.getText() ?? '';
    expect(inside).toContain('ownedEnv()');
    expect(inside).toContain('isOurs');

    // Every OTHER MODULE that reaches for both names is re-implementing the rule a fix
    // would land in `envFor` and miss. A call site passes `own:` or calls `envFor`.
    // `exec.ts` itself is the owner: `helmEnv` is helm's variant of the same decision and
    // belongs beside it, which is the whole point of there being one module for this.
    const offenders: string[] = [];
    for (const file of kubeSources()) {
      const basename = path.basename(file.getFilePath());
      if (basename === 'exec.ts') continue;
      for (const fn of file.getFunctions()) {
        const text = fn.getText();
        if (text.includes('ownedEnv()') && text.includes('isOurs(')) {
          offenders.push(`${basename}:${fn.getName() ?? '?'}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the label vocabulary is tier zero and talks to nothing', () => {
  it('imports no seam, no filesystem and no process', () => {
    const names = kubeSources().find((file) => path.basename(file.getFilePath()) === 'names.ts');
    expect(names).toBeDefined();
    const imports = (names?.getImportDeclarations() ?? []).map((node) =>
      node.getModuleSpecifierValue(),
    );
    // Pure vocabulary: a rank-0 module with no edges at all.
    expect(imports).toEqual([]);
    const calls = (names?.getDescendantsOfKind(SyntaxKind.CallExpression) ?? []).map((call) =>
      call.getExpression().getText(),
    );
    for (const forbidden of ['require', 'readFileSync', 'spawnSync', 'fetch']) {
      expect(calls).not.toContain(forbidden);
    }
  });

  it('selects by label and never by a name prefix', () => {
    for (const basename of ['names.ts', 'namespace.ts']) {
      const file = kubeSources().find((source) => path.basename(source.getFilePath()) === basename);
      expect(file).toBeDefined();
      // A name-prefix match is how a namespace somebody else called `houston-anything`
      // gets deleted. Asked of the tree, so the sentence explaining that in a comment is
      // not itself an offender -- which is the trap earlier releases' substring search hit.
      const prefixMatches = (file?.getDescendantsOfKind(SyntaxKind.CallExpression) ?? []).filter(
        (call) => {
          const target = call.getExpression().getText();
          if (!target.endsWith('.startsWith')) return false;
          return call
            .getArguments()
            .some((argument) => /NAMESPACE_PREFIX/u.test(argument.getText()));
        },
      );
      expect(prefixMatches.map((call) => call.getText())).toEqual([]);
    }
    const namespace = kubeSources().find(
      (source) => path.basename(source.getFilePath()) === 'namespace.ts',
    );
    expect(namespace?.getFullText()).toMatch(/OWNER_SELECTOR|isOurs/u);
  });
});

describe('a read-only probe issues no write verb', () => {
  /** kubectl and helm verbs that change a cluster. */
  const WRITES = new Set([
    'apply',
    'create',
    'delete',
    'patch',
    'replace',
    'install',
    'upgrade',
    'uninstall',
    'rollout',
    'scale',
    'annotate',
    'label',
    'cordon',
    'drain',
  ]);

  /** Every write verb the first position of a kubectl/helm argv literal names. */
  function writeVerbs(file: SourceFile): string[] {
    const found: string[] = [];
    for (const literal of file.getDescendantsOfKind(SyntaxKind.ArrayLiteralExpression)) {
      const words = literal
        .getElements()
        .filter((element) => element.getKind() === SyntaxKind.StringLiteral)
        .map((element) => element.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue());
      if (words[0] !== 'kubectl' && words[0] !== 'helm') continue;
      found.push(...words.filter((word) => WRITES.has(word)));
    }
    return found;
  }

  it('recognises a write verb in an argv literal', () => {
    const planted = project().createSourceFile(
      'planted-probe.ts',
      `export const argv = ['kubectl', 'delete', 'namespace', 'houston-x'];`,
    );
    expect(writeVerbs(planted)).toEqual(['delete']);
  });

  it('finds none in the read-only tiers', () => {
    // The tier-2 probes: everything `doctor` and every refusal may run freely.
    const readOnly = [
      'capabilities.ts',
      'reachability.ts',
      'replicaset.ts',
      'probe.ts',
      'status.ts',
    ];
    for (const basename of readOnly) {
      const file = kubeSources().find((source) => path.basename(source.getFilePath()) === basename);
      expect(file).toBeDefined();
      expect(file === undefined ? ['missing'] : writeVerbs(file)).toEqual([]);
    }
  });
});
