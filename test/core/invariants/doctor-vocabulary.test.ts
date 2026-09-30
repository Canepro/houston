/**
 * INVARIANT: every row `doctor` files carries a declared, watchable check id.
 *
 * MECHANISM: COMPILE, plus a ts-morph positive control and a behavioural order check.
 *
 * Earlier releases walked their checks package: one module per subject, each declaring
 * its subject, with the run order compared against the directory listing. None of those
 * three could see a row filed under a literal that no module declared as its SUBJECT --
 * `Report.line` takes an id per CALL, and a module files rows under several. Here
 * `line()` is typed `CheckId`, so all ninety-odd call sites are checked by the compiler,
 * including the ones that override the id with `check:`. What this spec adds is the
 * evidence a type alone cannot give: that the vocabulary is the published one, that
 * there really are call sites for the compiler to be checking, and that `RUN_ORDER` is
 * still the whole of what runs.
 */
import * as path from 'node:path';

import { Project, SyntaxKind } from 'ts-morph';

import {
  CHECKS,
  RUN_ORDER,
  Report,
  type CheckId,
  type CheckStatus,
} from '../../../src/core/doctor';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DOCTOR = path.join(ROOT, 'src', 'core', 'doctor.ts');

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type _CheckIdIsTheTuple = Assert<Equal<CheckId, (typeof CHECKS)[number]>>;
type _StatusIsClosed = Assert<Equal<CheckStatus, 'ok' | 'warn' | 'fail'>>;

function doctorSource() {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });
  return project.addSourceFileAtPath(DOCTOR);
}

describe('the doctor check vocabulary', () => {
  it('is the published 45, in report order, with the fallback first', () => {
    expect(CHECKS).toHaveLength(45);
    expect(CHECKS[0]).toBe('preflight');
    expect(new Set(CHECKS).size).toBe(CHECKS.length);
    expect(Object.isFrozen(CHECKS)).toBe(true);
  });

  it('is not vacuous: every id the module files a row under is a declared one', () => {
    const file = doctorSource();
    const used = new Set<string>();
    let sites = 0;
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const target = call.getExpression().getText();
      if (target !== 'line' && !target.endsWith('.line')) continue;
      const first = call.getArguments()[0];
      if (first?.getKind() !== SyntaxKind.StringLiteral) continue;
      sites += 1;
      used.add(first.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue());
    }
    // The positive control. A walk that matched nothing would assert nothing, and would
    // look exactly like a module that had stopped filing rows.
    expect(sites).toBeGreaterThan(80);
    expect([...used].filter((id) => !(CHECKS as readonly string[]).includes(id))).toEqual([]);

    // And the `check:` overrides, which are the half earlier releases' per-module subject
    // walk could not see at all.
    const overrides = new Set<string>();
    for (const assignment of file.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (assignment.getName() !== 'check') continue;
      const initialiser = assignment.getInitializer();
      if (initialiser?.getKind() !== SyntaxKind.StringLiteral) continue;
      overrides.add(initialiser.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue());
    }
    expect(overrides.size).toBeGreaterThan(20);
    expect([...overrides].filter((id) => !(CHECKS as readonly string[]).includes(id))).toEqual([]);
  });

  it('runs every check the module defines, and nothing it does not', () => {
    const file = doctorSource();
    const defined = file
      .getFunctions()
      .map((fn) => fn.getName() ?? '')
      .filter((name) => /^check[A-Z]/u.test(name));
    const listed = RUN_ORDER.map(([, fn]) => fn.name);
    expect(defined.length).toBeGreaterThan(10);
    expect([...listed].sort()).toEqual([...defined].sort());
    expect(new Set(RUN_ORDER.map(([name]) => name)).size).toBe(RUN_ORDER.length);
  });

  it('files a row whose id nothing declared under preflight rather than throwing', () => {
    const report = new Report();
    // The cast is what makes the branch reachable: `CheckId` closes the set at every
    // production call site, and this is what still happens when one arrives anyway.
    report.line('not-a-declared-id' as CheckId, 'warn', 'something happened');
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ check: 'preflight', status: 'warn' });
    expect(String(report.rows[0]?.message)).toContain('not-a-declared-id');
    expect(String(report.rows[0]?.message)).toContain('something happened');
  });
});
