/**
 * INVARIANT: every advertised error code can be raised, and every raisable one is
 * advertised.
 *
 * MECHANISM: ts-morph walk of the gate raises, checked against the published registry.
 *
 * `capabilities` publishes a set of codes a caller is told to branch on. Publishing one
 * nothing raises teaches a caller to write a branch that never runs; raising one nothing
 * publishes hands a caller a code it was never told about. Earlier releases' guard records
 * in its own comment that its first form asserted `"GATE" not in advertised` -- a hardcoded name,
 * which cannot notice that the thing it names has changed, and did not when the first
 * gate was actually raised.
 *
 * `errors.test.ts` already covers the registry half (advertised ⊆ reachable, sorted, no
 * duplicates) by reading the tables. What is here is the half no table can answer: what
 * the TREE can actually throw.
 */
import * as path from 'node:path';

import { Project, SyntaxKind, type SourceFile } from 'ts-morph';

import {
  AuthorityGateError,
  ERROR_CLASSES,
  GATE_CODES,
  RAISED_GATE_CODES,
  ReproError,
  errorCodes,
} from '../../../src/lib/errors';

import { GRANTS, requireGrant } from '../../../src/lib/onboarding';

const ROOT = path.resolve(__dirname, '..', '..', '..');

function productionSources(): SourceFile[] {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths([path.join(ROOT, 'src', '**', '*.ts')]);
  return project.getSourceFiles();
}

/** Every gate code this build can actually throw, read off the `new` expressions. */
function gateCodesRaisedIn(file: SourceFile): { code: string; where: string }[] {
  const found: { code: string; where: string }[] = [];
  for (const created of file.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    if (created.getExpression().getText() !== 'AuthorityGateError') continue;
    const where = `${path.basename(file.getFilePath())}:${String(created.getStartLineNumber())}`;
    // The options object is the second argument; `code` is a property on it. Read from
    // the tree rather than by searching the file for `code:`, which would also find the
    // `code` of every other error and every unrelated object in the module.
    const options = created.getArguments()[1];
    const property = options
      ?.asKind(SyntaxKind.ObjectLiteralExpression)
      ?.getProperty('code')
      ?.asKind(SyntaxKind.PropertyAssignment);
    const literal = property?.getInitializer()?.asKind(SyntaxKind.StringLiteral);
    // No explicit code means the class default, which `errorCodes()` already publishes.
    found.push({ code: literal?.getLiteralValue() ?? String(ReproError.code), where });
  }
  return found;
}

describe('the published error-code set is exactly what this build can produce', () => {
  it('recognises a gate raise, including one that takes the class default', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const planted = project.createSourceFile(
      'planted.ts',
      `
export function refuse() {
  throw new AuthorityGateError('nope', { kind: 'cluster', code: 'GATE_INVENTED' });
}
export function refuseTwo() {
  throw new AuthorityGateError('nope', { kind: 'cluster' });
}
`,
    );
    // THE POSITIVE CONTROL. A walk that matched no raises would report a clean tree and
    // would go on reporting one after the next gate landed.
    expect(gateCodesRaisedIn(planted).map((found) => found.code)).toEqual([
      'GATE_INVENTED',
      String(ReproError.code),
    ]);
  });

  it('raises no gate code it has not written down', () => {
    const raised = productionSources().flatMap(gateCodesRaisedIn);
    // Grant codes come from a registry rather than literal throw expressions. Exercise
    // each declared refusal so the inventory proves the dynamic path can raise its code.
    for (const spec of GRANTS) {
      let refusal: unknown;
      try {
        requireGrant(spec.id, {});
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(AuthorityGateError);
      expect(refusal).toMatchObject({ code: spec.gate });
      raised.push({ code: spec.gate, where: `grant:${spec.id}` });
    }

    // A positive control with teeth: this build really does raise gates, so an empty walk
    // is a broken walk rather than a tree with no gates in it.
    expect(raised.length).toBeGreaterThanOrEqual(3);
    const codes = new Set(
      raised.map((found) => found.code).filter((code) => code.startsWith('GATE')),
    );
    expect([...codes].sort()).toEqual([...RAISED_GATE_CODES].sort());
    for (const { code, where } of raised) {
      if (!code.startsWith('GATE')) continue;
      expect(`${where} ${code}`).toBe(
        `${where} ${Object.keys(GATE_CODES).find((k) => k === code) ?? 'UNDECLARED'}`,
      );
    }
  });

  it('advertises nothing a caller could never meet', () => {
    const advertised = new Set(errorCodes());
    const classCodes = new Set(
      ERROR_CLASSES.filter((cls) => cls.advertised).map((cls) => String(cls.code)),
    );
    for (const code of advertised) {
      const reachable = classCodes.has(code) || RAISED_GATE_CODES.includes(code);
      expect(`${code}:${String(reachable)}`).toBe(`${code}:true`);
    }
  });
});
