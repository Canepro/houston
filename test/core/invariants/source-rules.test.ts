/**
 * INVARIANT: four shape rules the service layer is held to.
 *
 * MECHANISM: ts-morph.
 *
 * Each of these is about EVERY call site at once, so there is no one call to drive. The
 * versions earlier releases held matched text: a fallback expression that must not appear, a
 * call counted to exactly three, a name that must not be among the called. Two of them record
 * in their own comments that the count broke the moment the guard's spelling changed while the
 * property held, and the edge's top-tier guard records the opposite -- a comment mentioning
 * the edge's start call counted as calling it. A syntax tree answers the question actually
 * being asked and reads no prose.
 */
import * as path from 'node:path';

import { Project, SyntaxKind, type Node, type SourceFile } from 'ts-morph';

const ROOT = path.resolve(__dirname, '..', '..', '..');

function project(): Project {
  return new Project({
    tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });
}

function sourcesUnder(...segments: string[]): SourceFile[] {
  const created = project();
  created.addSourceFilesAtPaths([path.join(ROOT, ...segments, '**', '*.ts')]);
  return created.getSourceFiles();
}

describe('the requested bind is read in one place', () => {
  /** Every expression that derives a bind from the REQUEST rather than asking for it. */
  function inlinedBindDerivations(file: SourceFile): string[] {
    const found: string[] = [];
    for (const binary of file.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (binary.getOperatorToken().getKind() !== SyntaxKind.BarBarToken) continue;
      // The OUTERMOST `||` of a chain. `a || b || c` is two nested binaries, and
      // reporting both would name one derivation twice.
      const parent = binary.getParent();
      if (
        parent?.getKind() === SyntaxKind.BinaryExpression &&
        parent.asKindOrThrow(SyntaxKind.BinaryExpression).getOperatorToken().getKind() ===
          SyntaxKind.BarBarToken
      ) {
        continue;
      }
      const text = binary.getText().replace(/\s+/gu, ' ');
      if (/\breq\.bind\b/u.test(text) && /bind_host|bindHost/u.test(text)) {
        found.push(`${path.basename(file.getFilePath())}: ${text}`);
      }
    }
    return found;
  }

  it('recognises the derivation it forbids', () => {
    const planted = project().createSourceFile(
      'planted-bind.ts',
      `export const bind = req.bind || cfg.bind_host || '';`,
    );
    expect(inlinedBindDerivations(planted)).toEqual([
      "planted-bind.ts: req.bind || cfg.bind_host || ''",
    ]);
  });

  it('is derived only by the function that owns the rule', () => {
    const files = sourcesUnder('src', 'core', 'lifecycle');
    expect(files.length).toBeGreaterThan(15);
    const request = files.find((file) => path.basename(file.getFilePath()) === 'request.ts');
    expect(request?.getFunction('requestedBindHost')).toBeDefined();
    // The derivation gates the create and the publish gates on the same value. Two
    // spellings of it is two answers, and the one that matters is the one that publishes.
    expect(files.filter((file) => file !== request).flatMap(inlinedBindDerivations)).toEqual([]);
  });
});

describe('an in-service seed runs only where the caller has been consulted', () => {
  /** Creation consults seedHere; recovery consults the abandoned request journal. */
  function unguardedSeeds(file: SourceFile): string[] {
    const found: string[] = [];
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const target = call.getExpression().getText();
      if (!target.endsWith('runSeedInline')) continue;
      let scope: Node | undefined = call.getFirstAncestor(
        (node) =>
          node.getKind() === SyntaxKind.FunctionDeclaration ||
          node.getKind() === SyntaxKind.ArrowFunction ||
          node.getKind() === SyntaxKind.MethodDeclaration,
      );
      // A seed inside a callback is guarded by whatever encloses the callback too.
      let consulted = false;
      while (scope !== undefined && !consulted) {
        consulted =
          /seedHere|seed_here/u.test(scope.getText()) ||
          scope
            .getDescendantsOfKind(SyntaxKind.CallExpression)
            .some((c) => c.getExpression().getText() === 'pendingSeed');
        scope = scope.getFirstAncestor(
          (node) =>
            node.getKind() === SyntaxKind.FunctionDeclaration ||
            node.getKind() === SyntaxKind.ArrowFunction ||
            node.getKind() === SyntaxKind.MethodDeclaration,
        );
      }
      if (!consulted) {
        found.push(`${path.basename(file.getFilePath())}:${String(call.getStartLineNumber())}`);
      }
    }
    return found;
  }

  it('recognises a seed nobody asked about', () => {
    const planted = project().createSourceFile(
      'planted-seed.ts',
      `
export async function finish(meta: unknown, req: { seed: boolean }) {
  if (req.seed) await seeding.runSeedInline(meta, 'small', false, emit);
}
`,
    );
    expect(unguardedSeeds(planted)).toEqual(['planted-seed.ts:3']);
  });

  it('finds none in the service layer', () => {
    // `seedHere` exists so the two front-ends CANNOT BOTH seed: with it set the CLI runs
    // the seed after the create returns, so seeding here as well seeds twice.
    //
    // THE LIFECYCLE PACKAGE, which is the scope earlier releases' walk had.
    // `web/routes/data.ts` is the other side of the same rule: the route IS the caller
    // asking for a seed, so it has nothing to consult.
    const files = sourcesUnder('src', 'core', 'lifecycle');
    const sites = files.flatMap((file) =>
      file
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((call) => call.getExpression().getText().endsWith('runSeedInline')),
    );
    // The positive control: the walk found the call sites it is about.
    expect(sites.length).toBeGreaterThanOrEqual(4);
    expect(files.flatMap(unguardedSeeds)).toEqual([]);
  });

  it('accepts recovery that reads the abandoned request after its CLI owner exited', () => {
    const planted = project().createSourceFile(
      'recovery-seed.ts',
      `
export async function finish(meta: unknown) {
  const pending = pendingSeed(meta.name);
  if (pending.seed) await seeding.runSeedInline(meta, pending.seed_profile, false, emit);
}
`,
    );
    expect(unguardedSeeds(planted)).toEqual([]);
  });
});

describe('the workspace record carries the keys its readers ask for', () => {
  /**
   * Every `…extra['<key>'] = …` and `…extra.<key> = …` the lifecycle WRITES.
   *
   * Assignments only. A READ of `extra.runtime` is not a writer of it, and counting one
   * would make this pass on a key nothing writes any more -- which is the whole defect:
   * the writer stops writing it and every reader keeps asking for the old name and
   * getting nothing.
   */
  function keysWritten(files: readonly SourceFile[]): Set<string> {
    const written = new Set<string>();
    for (const file of files) {
      for (const binary of file.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        if (binary.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
        const target = binary.getLeft();
        if (target.getKind() === SyntaxKind.ElementAccessExpression) {
          const access = target.asKindOrThrow(SyntaxKind.ElementAccessExpression);
          if (!/\.extra$/u.test(access.getExpression().getText())) continue;
          const argument = access.getArgumentExpression();
          if (argument?.getKind() !== SyntaxKind.StringLiteral) continue;
          written.add(argument.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue());
        } else if (target.getKind() === SyntaxKind.PropertyAccessExpression) {
          const access = target.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
          if (!/\.extra$/u.test(access.getExpression().getText())) continue;
          written.add(access.getName());
        }
      }
      // `{ ...meta.extra, tls: 'local' }` and `Object.assign(meta.extra, { edge: name })`
      // are writes too, and the create uses both.
      for (const spread of file.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
        const parent = spread.getParent();
        const assigns =
          parent.getKind() === SyntaxKind.CallExpression &&
          /Object\.assign$/u.test(
            parent.asKindOrThrow(SyntaxKind.CallExpression).getExpression().getText(),
          );
        const intoExtra =
          assigns &&
          /\.extra$/u.test(
            parent.asKindOrThrow(SyntaxKind.CallExpression).getArguments()[0]?.getText() ?? '',
          );
        if (intoExtra !== true) continue;
        for (const property of spread.getProperties()) {
          const named = property.asKind(SyntaxKind.PropertyAssignment);
          if (named !== undefined) written.add(named.getName().replace(/^['"]|['"]$/gu, ''));
        }
      }
    }
    return written;
  }

  it('writes every record key a reader asks for by name', () => {
    const written = keysWritten([
      ...sourcesUnder('src', 'core', 'lifecycle'),
      ...sourcesUnder('src', 'core', 'runner'),
    ]);
    // The on-disk record's KEYS are a contract, and a rename of one is silent: the writer
    // stops writing it and every reader keeps asking for the old name and getting nothing.
    for (const key of [
      'bind_host',
      'namespace',
      'notes',
      'monitoring',
      'params',
      'created_by',
      'advertised_url',
      'post_ready',
      'instances',
      'sidecar_ports',
      'env',
      'tls',
      'edge',
      'distribution',
      'incomplete',
    ]) {
      expect(`${key}:${String(written.has(key))}`).toBe(`${key}:true`);
    }
    expect([...written].filter((key) => key.includes('.'))).toEqual([]);
  });
});

describe('only the top edge tier starts or stops the edge', () => {
  it('finds no lower tier reaching for the container', () => {
    // `up`, `down` and `ensureRunning` decide whether a container runs. CALLS, walked as a
    // tree: `types`' own comment mentions `ensureRunning(...)` while explaining why its answer
    // refuses to be read as a boolean, and earlier releases' text search reported the sentence.
    const allowed = new Set(['runtime.ts', 'engine.ts']);
    const offenders: string[] = [];
    let seen = 0;
    for (const file of sourcesUnder('src', 'core', 'edge')) {
      const basename = path.basename(file.getFilePath());
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const target = call.getExpression().getText().split('.').at(-1) ?? '';
        if (!['ensureRunning', 'composeRun'].includes(target)) continue;
        seen += 1;
        if (!allowed.has(basename)) offenders.push(`${basename}:${target}`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
