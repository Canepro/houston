/**
 * INVARIANT: every job kind lands in a pool somebody decided on.
 *
 * MECHANISM: COMPILE for totality, ts-morph for the two rules that are genuinely about
 * the submit sites, behaviour for the ceiling itself.
 *
 * Earlier releases parsed their web routes for job submit sites, counted them (`>= 14`, "or
 * the parser drifted"), and matched each kind string to the callable beside it. Its weakness
 * is in that sentence: the count is the only thing standing between a drifted parser and
 * a guard that silently checks nothing. Here `JobKind` is closed and `POOL_OF` is
 * `Record<JobKind, PoolName>`, so a kind with no ceiling decision does not compile and a
 * ceiling for a kind nothing submits does not compile either. The walk that remains is
 * the part a type cannot state -- that two kinds running the SAME work share a ceiling,
 * and that no declared kind is dead.
 */
import * as path from 'node:path';

import { Project, SyntaxKind } from 'ts-morph';

import { JOB_KINDS, POOL_OF, type JobKind, type PoolName } from '../../../src/web/jobs';

const ROOT = path.resolve(__dirname, '..', '..', '..');

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type _KindIsTheTuple = Assert<Equal<JobKind, (typeof JOB_KINDS)[number]>>;
type _PoolMapIsTotal = Assert<Equal<typeof POOL_OF, Record<JobKind, PoolName>>>;

/** Every `submit(app, '<kind>', <target>, …)` the route layer makes. */
function submitSites(): { kind: string; target: string; where: string }[] {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths([path.join(ROOT, 'src', 'web', '**', '*.ts')]);
  const found: { kind: string; target: string; where: string }[] = [];
  for (const file of project.getSourceFiles()) {
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() !== 'submit') continue;
      const args = call.getArguments();
      const kind = args[1];
      const target = args[2];
      if (kind === undefined || target === undefined) continue;
      const kinds =
        kind.getKind() === SyntaxKind.StringLiteral
          ? [kind.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue()]
          : kind
              .getDescendantsOfKind(SyntaxKind.StringLiteral)
              .map((literal) => literal.getLiteralValue());
      for (const one of kinds) {
        found.push({
          kind: one,
          target: target.getText().replace(/\s+/gu, ' '),
          where: `${path.basename(file.getFilePath())}:${String(call.getStartLineNumber())}`,
        });
      }
    }
  }
  return found;
}

describe('job kinds and the ceilings they run under', () => {
  it('declares a ceiling for every kind and no ceiling for a kind that does not exist', () => {
    expect(JOB_KINDS).toHaveLength(23);
    expect(new Set(JOB_KINDS).size).toBe(JOB_KINDS.length);
    expect(Object.keys(POOL_OF).sort()).toEqual([...JOB_KINDS].sort());
    for (const kind of JOB_KINDS) {
      expect(['heavy', 'measure', 'none']).toContain(POOL_OF[kind]);
    }
  });

  it('submits every declared kind, and submits nothing it has not declared', () => {
    const sites = submitSites();
    // The positive control earlier releases' guard spelled as `>= 14`. Kept, and raised to what
    // the tree really holds, because a drifted walk and a clean tree look identical.
    expect(sites.length).toBeGreaterThanOrEqual(21);
    const submitted = new Set(sites.map((site) => site.kind));
    expect(
      [...submitted].filter((kind) => !(JOB_KINDS as readonly string[]).includes(kind)),
    ).toEqual([]);
    expect([...JOB_KINDS].filter((kind) => !submitted.has(kind))).toEqual([]);
  });

  it('gives the same work the same ceiling however it is labelled', () => {
    const byTarget = new Map<string, Set<string>>();
    for (const site of submitSites()) {
      const kinds = byTarget.get(site.target) ?? new Set<string>();
      kinds.add(site.kind);
      byTarget.set(site.target, kinds);
    }
    const disagreeing: string[] = [];
    for (const [target, kinds] of byTarget) {
      const pools = new Set([...kinds].map((kind) => POOL_OF[kind as JobKind]));
      if (pools.size > 1)
        disagreeing.push(`${target} is submitted as ${[...kinds].sort().join(', ')}`);
    }
    expect(disagreeing).toEqual([]);
  });

  it('bounds the work that costs an engine a whole workspace', () => {
    // A maintained list, as in earlier releases: adding an unpooled engine-heavy kind should be
    // a visible decision rather than an omission.
    const engineHeavy: JobKind[] = [
      'create',
      'up',
      'backup',
      'restore',
      'rollback',
      'upgrade',
      'teardown',
      'prune',
      'scale',
      'clear-scale',
      'seed',
      'config-import',
      'monitor',
      'monitor-off',
    ];
    for (const kind of engineHeavy) {
      expect(POOL_OF[kind]).toBe('heavy');
    }
    // Doing and undoing share a ceiling: `scale` was pooled and `clear-scale` was not,
    // which bounds half the work.
    for (const [doing, undoing] of [
      ['scale', 'clear-scale'],
      ['monitor', 'monitor-off'],
      ['seed', 'config-import'],
    ] as [JobKind, JobKind][]) {
      expect(POOL_OF[doing]).toBe(POOL_OF[undoing]);
    }
    // And measurement is a pool of ONE, separate from the engine ceiling, because two
    // load tests on one box measure each other.
    expect(POOL_OF.loadtest).toBe('measure');
    expect(POOL_OF.capacity).toBe('measure');
    // The reads stay unpooled on purpose: `ready` is what the dashboard polls every few
    // seconds, and a ceiling there queues the GUI's own refresh behind everything else.
    for (const cheap of ['ready', 'state', 'env'] as JobKind[]) {
      expect(POOL_OF[cheap]).toBe('none');
    }
  });
});
