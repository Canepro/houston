/**
 * The layering rule, machine-checked.
 *
 *   A module imports only from a strictly lower layer, never sideways within a layer,
 *   never upward; anything two siblings both need moves DOWN into their package's
 *   layer-0 module; the only permitted upward reference is a registry a lower layer
 *   owns and an upper layer registers into.
 *
 * The rule comes with an L0-L4 table of named layers; this enforces it on `src/`.
 *
 * TWO REFINEMENTS OF THAT TABLE, both measured rather than chosen:
 *
 *  1. `lock` sits BELOW `config`, not beside it. The table puts them together at L1,
 *     but `config` is one of the five lock sites, so it has to import `lock` -- and
 *     two modules in one layer may not import each other. The mechanism sits below the
 *     layer that needs it.
 *
 *  2. Layers are RANKS, finer-grained than the five names. `errors` must be below
 *     `lock` (lock raises `PreflightError`), and `version-spec` below `versions`. A
 *     five-bucket table cannot say that, and a rule that cannot say it permits the
 *     sideways edge it exists to forbid.
 *
 * Rules are GENERATED from the rank table below rather than written out. A hand-kept
 * list of "rank 2 may not reach rank 3, 4, 5, 6" is n-squared lines that drift the
 * first time a rank is inserted, and a drifted layer rule fails open.
 */

/**
 * Rank -> the modules at it. A module may import strictly LOWER ranks only: not its
 * own rank (that is the sideways edge) and not any higher one.
 *
 * Every rank's rule is live whether or not the rank holds a module yet, so the first
 * module to land in one is checked on the commit that adds it rather than on the
 * commit that remembers to add a rule.
 */
const { RANKS, pathOf } = require('./tools/dependency-policy');

/** "rank N may not import rank N or above", for every N. */
function layerRules() {
  const rules = [];
  for (let from = 0; from < RANKS.length; from += 1) {
    const fromPath = pathOf(from);
    if (!fromPath) continue;
    const atOrAbove = [];
    for (let to = from; to < RANKS.length; to += 1) {
      const toPath = pathOf(to);
      if (toPath) atOrAbove.push(toPath);
    }
    if (atOrAbove.length === 0) continue;
    rules.push({
      name: `layer-${from}-imports-down-only`,
      comment:
        `Rank ${from} may import strictly lower ranks only. An edge to its own rank ` +
        'is the sideways import the layering rule forbids; an edge to a higher rank ' +
        'is the upward one. Move what both siblings need DOWN a rank.',
      severity: 'error',
      from: { path: fromPath },
      to: { path: `(${atOrAbove.join('|')})` },
    });
  }
  return rules;
}

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment:
        'The tree has no import cycles, and a cycle would bring back the load-order ' +
        'hazards the layering exists to rule out.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment: 'A module nothing imports and that imports nothing is usually a leftover.',
      severity: 'warn',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)index\\.ts$'] },
      to: {},
    },
    {
      name: 'only-exec-launches-processes',
      comment:
        'The process-launch seam: 40 launch sites with no single funnel is 40 places to get quoting, ' +
        'timeouts and error typing subtly different. eslint carries the same rule for ' +
        'the cases depcruise cannot see.',
      severity: 'error',
      from: { pathNot: '^src/seams/exec\\.ts$' },
      to: { path: '^(node:)?child_process$', dependencyTypes: ['core'] },
    },
    {
      name: 'only-kube-exec-launches-kubectl',
      comment:
        'The Kubernetes seam. `core/kube/exec.ts` owns which client state a call may ' +
        "see -- houston's own kubeconfig and Helm homes, or the user's untouched -- and " +
        'a call that went around it would run against whichever one happened to be ' +
        'inherited. That is the defect `env_for` was written for: the rule lived at ' +
        'eight call sites and a fix to it reached one.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/core/kube/exec\\.ts$' },
      to: { path: '^src/seams/kubectl\\.ts$' },
    },
    {
      name: 'only-eks-launches-aws',
      comment:
        'The AWS seam. `core/eks.ts` owns every decision about whose account is being ' +
        "spent in, which region a cluster lands in, and whether a cluster is houston's " +
        'to destroy -- and a call that went around it would reach AWS with none of ' +
        'those made. The module has no oracle at any price, so the funnel is the only ' +
        'thing a gate can check about it.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/core/eks\\.ts$' },
      to: { path: '^src/seams/aws-cli\\.ts$' },
    },
    {
      name: 'only-rcapi-speaks-http',
      comment:
        'The Rocket.Chat HTTP seam. Everything that knows a Rocket.Chat path lives in ' +
        '`core/rcapi.ts`, and the seam knows none -- so a second importer is a second ' +
        'place that decides what a timeout is and what a transport failure looks like. ' +
        'The `fetch` global itself is fenced by `no-restricted-globals` in eslint, ' +
        'because a global has no specifier for this rule to key on.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/core/rcapi\\.ts$' },
      to: { path: '^src/seams/rc-http\\.ts$' },
    },
    {
      name: 'not-to-dev-dep',
      comment: 'Production source must not reach a devDependency.',
      severity: 'error',
      from: { path: '^src' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    ...layerRules(),
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // The cruise reads src/ (`tools/depcruise.js`), which holds production code only: the
    // specs and the suite's setup files live under test/.
    // LOAD-BEARING: measured, not assumed. With this false, a type-only import edge is
    // invisible -- and the self-test proved the difference is real on TS 5.9.3: the same
    // two files report a cycle with it on and "no dependency violations found" with it
    // off. That is the silent-no-op failure mode this whole gate exists to avoid.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['require', 'node'] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
