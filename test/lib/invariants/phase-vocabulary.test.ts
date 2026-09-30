/**
 * INVARIANT: every phase this build emits is in the published vocabulary.
 *
 * Earlier releases' guard searched every source file for `phase="([a-z_]+)"` and compared
 * what it found with the published phases.
 *
 * MECHANISM: COMPILE. `Event.phase` is typed `EmittedPhase`, so a phase outside the
 * vocabulary is a type error at the emit site. That is strictly stronger than the search
 * in three ways: it sees a phase passed through a variable, it sees one built by
 * concatenation, and it cannot be narrowed by a file moving. This spec does not re-run
 * the search -- `yarn typecheck` is the check. What it does is prove the type is the
 * vocabulary and not a copy of it, prove the exception list is closed and honest, and
 * prove the emit sites it protects actually exist, so the invariant cannot pass by
 * covering nothing.
 *
 * THE SEARCH MISSED ONE, WHICH IS WHY THE MECHANISM CHANGED. `[a-z_]+` has no digit in
 * it, so the four `phase="k6"` sites in earlier releases' perf service matched nothing and
 * that guard reported a clean vocabulary for as long as they existed.
 * `k6` is in `UNPUBLISHED_PHASES` here: named, bounded by the compiler, and asserted
 * below to be the only one.
 */
import * as path from 'node:path';

import { Project, SyntaxKind } from 'ts-morph';

import {
  PHASES,
  UNPUBLISHED_PHASES,
  event,
  type EmittedPhase,
  type Event,
  type Phase,
} from '../../../src/lib/events';
import { EventWriter, PHASES as PUBLISHED_PHASES } from '../../../src/lib/jsonout';

const ROOT = path.resolve(__dirname, '..', '..', '..');

/** `true` only when the two types are identical, not merely mutually assignable. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

// COMPILE-TIME, and these lines are the invariant rather than a description of it. Each
// stops compiling the moment the type stops being the tuple's member type -- which is
// what "widen it back to `string` to make a build go green" looks like in a diff.
type _PhaseIsTheTuple = Assert<Equal<Phase, (typeof PHASES)[number]>>;
type _EmittedIsPhasePlusExceptions = Assert<
  Equal<EmittedPhase, Phase | (typeof UNPUBLISHED_PHASES)[number]>
>;
type _EventPhaseIsClosed = Assert<Equal<Event['phase'], EmittedPhase>>;

describe('the phase vocabulary is the type, not a copy of it', () => {
  it('publishes the same tuple the emitters are typed by', () => {
    // IDENTITY, not equality. Two lists with the same members today is exactly the drift
    // earlier releases' guard existed to catch, and it would catch it with the compiler
    // agreeing with the wrong one.
    expect(PUBLISHED_PHASES).toBe(PHASES);
    expect(PHASES).toHaveLength(22);
    expect(new Set(PHASES).size).toBe(PHASES.length);
    expect(Object.isFrozen(PHASES)).toBe(true);
  });

  it('names exactly one unpublished phase, and it is a bounded defect rather than a hole', () => {
    expect([...UNPUBLISHED_PHASES]).toEqual(['k6']);
    for (const phase of UNPUBLISHED_PHASES) {
      expect(PHASES).not.toContain(phase);
      // What a caller actually receives. The wire promise -- branch on any published
      // phase and never meet one that is not -- holds for this phase too; what is lost
      // is a caller watching for k6 progress, which is the cost being recorded.
      const wire = new EventWriter().event({ phase, message: 'm' });
      expect(wire.phase).toBe('info');
      expect(wire.detail).toEqual({ phase_raw: phase });
    }
  });

  it('is not vacuous: production really does emit phases through the typed seam', () => {
    const project = new Project({
      tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
      skipAddingFilesFromTsConfig: true,
    });
    project.addSourceFilesAtPaths([path.join(ROOT, 'src', '**', '*.ts')]);
    const emitted = new Set<string>();
    let sites = 0;
    for (const file of project.getSourceFiles()) {
      for (const assignment of file.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
        if (assignment.getName() !== 'phase') continue;
        sites += 1;
        const initialiser = assignment.getInitializer();
        if (initialiser?.getKind() === SyntaxKind.StringLiteral) {
          emitted.add(initialiser.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue());
        }
      }
    }
    // A POSITIVE CONTROL for the whole mechanism. If the walk finds nothing -- a layout
    // change, a renamed property -- the assertions below would pass over an empty set,
    // which is the silent-no-op mode every check in this repository is written against.
    expect(sites).toBeGreaterThan(100);
    expect(emitted.size).toBeGreaterThan(15);
    const vocabulary = new Set<string>([...PHASES, ...UNPUBLISHED_PHASES]);
    expect([...emitted].filter((phase) => !vocabulary.has(phase))).toEqual([]);
  });

  it('defaults an unnamed phase to the one published for exactly that', () => {
    const built: Event = event('something happened');
    const phase: EmittedPhase = built.phase;
    expect(phase).toBe('info');
    expect(PHASES).toContain('info');
  });
});
