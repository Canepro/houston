/**
 * INVARIANT: exactly one thing announces the end of an operation.
 *
 * MECHANISM: ts-morph, and this is one the tree really is needed for.
 *
 * `waitAndFinalize` is the whole of `houston ready` and ONE STEP of several other
 * operations. MEASURED on a real EKS create: `done: ready` at 100% at 414s, then 46 more
 * seconds of seeding, then a second `done` -- in the GUI a progress bar that fills up and
 * then keeps going, in a log a run that finishes twice.
 *
 * The rule has TWO directions and they are asked at different scopes, on purpose:
 *
 *   handed off (`final=false`), so SOMETHING after it must announce the end -- and the
 *   thing that does may be the step that CALLS it, because 2b.15 left the upgrade's
 *   pull-and-recreate step handing off with the `done` one step up, where the upgrade is
 *   confirmed, which is correct and which a per-function read called a defect;
 *
 *   claimed the end, so nothing after it may announce again -- and this one stays
 *   per-function, because flattening it mixes branches that cannot both run: a rollback's
 *   own final wait is not on the path that reaches the success `done`.
 */
import * as path from 'node:path';

import { Project, SyntaxKind, type FunctionDeclaration, type SourceFile } from 'ts-morph';

const ROOT = path.resolve(__dirname, '..', '..', '..');

function sources(): SourceFile[] {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths([path.join(ROOT, 'src', 'core', '**', '*.ts')]);
  return project.getSourceFiles();
}

/** Every `waitAndFinalize(...)` in one function, and whether it handed the end off. */
function waits(fn: FunctionDeclaration): { line: number; handed: boolean }[] {
  const found: { line: number; handed: boolean }[] = [];
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!call.getExpression().getText().endsWith('waitAndFinalize')) continue;
    const args = call.getArguments();
    found.push({ line: call.getStartLineNumber(), handed: args[3]?.getText() === 'false' });
  }
  return found;
}

/** Where `fn` announces the end: an `info(..., { phase: 'done' ... })`, by line. */
function dones(fn: FunctionDeclaration): number[] {
  const found: number[] = [];
  for (const assignment of fn.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (assignment.getName() !== 'phase') continue;
    const value = assignment.getInitializer()?.asKind(SyntaxKind.StringLiteral);
    if (value?.getLiteralValue() === 'done') found.push(assignment.getStartLineNumber());
  }
  return found;
}

/** Where `caller` calls `name`, by line. */
function callsTo(caller: FunctionDeclaration, name: string): number[] {
  return caller
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => (call.getExpression().getText().split('.').at(-1) ?? '') === name)
    .map((call) => call.getStartLineNumber());
}

describe('the terminal event', () => {
  it('recognises both directions on a planted example', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const planted = project.createSourceFile(
      '/planted.ts',
      `
export async function handsOff(meta: unknown, emit: unknown) {
  await waitAndFinalize(meta, emit, 300.0, false);
}
export async function claimsAndKeepsWorking(meta: unknown, emit: unknown) {
  await waitAndFinalize(meta, emit);
  info(emit, 'done', { phase: 'done', pct: 100.0 });
}
`,
    );
    const [first, second] = planted.getFunctions();
    // The matcher sees the hand-off, sees the claim, and sees the announcement after it.
    expect(waits(first as FunctionDeclaration)).toEqual([{ line: 3, handed: true }]);
    expect(waits(second as FunctionDeclaration)).toEqual([{ line: 6, handed: false }]);
    expect(dones(second as FunctionDeclaration)).toHaveLength(1);
    expect(dones(first as FunctionDeclaration)).toEqual([]);
    expect(callsTo(second as FunctionDeclaration, 'waitAndFinalize')).toEqual([6]);
  });

  it('is answered, or not doubled, everywhere it is used', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of sources()) {
      const steps = file.getFunctions();
      for (const fn of steps) {
        const mine = waits(fn);
        if (mine.length === 0) continue;
        seen += mine.length;
        const where = `${path.basename(file.getFilePath())}::${fn.getName() ?? '?'}`;
        const after = Math.max(...mine.map((one) => one.line));
        const later = dones(fn).filter((line) => line > after);

        /** Does `caller` announce the end after line `at`, itself or through a step? */
        const finishedAfter = (caller: FunctionDeclaration, at: number): boolean => {
          if (dones(caller).some((line) => line > at)) return true;
          return steps.some(
            (step) =>
              step !== caller &&
              dones(step).length > 0 &&
              callsTo(caller, step.getName() ?? '\u0000').some((line) => line > at),
          );
        };
        const answeredByACaller = steps.some(
          (caller) =>
            caller !== fn &&
            callsTo(caller, fn.getName() ?? '\u0000').some((line) => finishedAfter(caller, line)),
        );

        if (mine.some((one) => one.handed)) {
          if (later.length === 0 && !answeredByACaller) {
            offenders.push(
              `${where}: passes final=false and nothing after it — here or in the step ` +
                'that calls it — announces the end',
            );
          }
        } else if (later.length > 0 || answeredByACaller) {
          offenders.push(
            `${where}: announces the end and then something after it does too — pass final=false`,
          );
        }
      }
    }
    // A walk that found no waits would pass over everything, which is how this guard would
    // degrade the next time the lifecycle moves.
    expect(seen).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });
});
