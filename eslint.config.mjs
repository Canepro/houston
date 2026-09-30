// Stock `eslint` + `typescript-eslint`, NOT `@rocket.chat/eslint-config`.
//
// The Rocket.Chat config was tried, and it does not resolve outside the RC
// monorepo: the published tarball is `index.js` + `package.json`, and one of its
// twenty dependencies is a `patch:` protocol reference to a patch file living in the
// CONSUMER's project, which it does not ship. `yarn add` dies in the resolution step
// before anything installs.
//
// So "looking like Rocket.Chat's own code" is met by matching the RULES, which are
// readable in that package's `index.js`, rather than by depending on the package.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'build/**',
      '.venv/**',
      // The shipped assets: the frozen GUI is pinned by `yarn verify:gui-hash`, not linted,
      // and the k6 scripts run under k6's runtime, not Node's.
      'data/**',
      'coverage/**',
      // Local-only directories (see .gitignore): one person's tooling and notes, never linted.
      '.claude/**',
      '.agents/**',
      '.docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // THE SEAM RULE, in the linter rather than in review: only the designated module may
      // reach `child_process`. 40 launch sites with no single funnel is 40 places to get
      // quoting, timeouts and error typing subtly different.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'child_process',
              message: 'Only src/seams/exec.ts may launch a process. Route it through that seam.',
            },
            {
              name: 'node:child_process',
              message: 'Only src/seams/exec.ts may launch a process. Route it through that seam.',
            },
          ],
        },
      ],

      // THE HTTP SEAM RULE, and it has to be a GLOBALS rule rather than an imports one.
      // `fetch` is a global in Node 18+, so there is no module specifier for
      // dependency-cruiser or `no-restricted-imports` to key on -- the mechanism that
      // makes the process seam enforceable simply does not exist for this one. Without
      // this rule the funnel would be a convention, and the Rocket.Chat client alone has 44
      // call sites.
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Only src/seams/rc-http.ts may make an HTTP request. Route it through that seam.',
        },
      ],

      // `Answer` truthiness must be a compile error at CONSUMERS, and in JavaScript
      // every object is truthy -- so the failure mode of collapsing one is a silent
      // `true`. That collapse deleted a live cluster. These two catch the shapes a
      // type alone cannot.
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-explicit-any': 'error',

      // AN OBJECT IN A CONDITION IS AN ERROR, and this is the rule that makes the
      // Kubernetes `Answer` contract enforceable at a CONSUMER.
      //
      // A three-state answer must never be read as a plain condition, and TypeScript has no
      // way to make that fail at run time: every object is truthy, a phantom brand does not
      // change that, and deleting `valueOf`/`toString` does not either -- so the failure
      // mode of collapsing the three states is a SILENT `true`. The collapse that
      // deleted a live cluster happened at a consumer, which is where a silent true
      // lands. `yarn lint:truthiness` plants that exact misuse outside `kube/` and
      // requires this rule to reject it.
      //
      // Strings and numbers stay allowed on purpose. Truthiness on them is idiomatic and
      // the code leans on it in a hundred places (`meta.public_url || meta.root_url`);
      // banning it would mean rewriting semantics that are kept on purpose. Objects are
      // the one shape where truthiness is never a
      // question anyone meant to ask.
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowString: true,
          allowNumber: true,
          allowNullableObject: false,
          allowNullableBoolean: true,
          allowNullableString: true,
          allowNullableNumber: true,
          allowAny: false,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },
  {
    // The designated execution seam is the ONE production module allowed to reach
    // child_process. Keeping this as an exact-file override makes the exception closed.
    files: ['src/seams/exec.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // The designated HTTP seam is the ONE production module allowed to call `fetch`,
    // and the exception is an exact file for the same reason.
    files: ['src/seams/rc-http.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // `require()` inside a function body is the whole point of the CommonJS choice:
    // it resolves at call time, which is how 259 function-body imports keep the load order
    // free of cycles. The TypeScript rule that forbids it would forbid this tree's core idiom.
    files: ['**/*.ts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // TESTS MAY LAUNCH A PROCESS, and only tests.
    //
    // The seam rule above is about houston launching something: 40 production call
    // sites with no single funnel is 40 places to get quoting, timeouts and error
    // typing subtly different. A test that starts a child process to hold a lock, or to
    // run the CLI end to end, is not one of those -- it is the check itself, and routing it
    // through a production seam would mean the check could only see what that seam
    // already agrees about.
    //
    // Test code is everything under test/, and nothing under src/ is: the suite's setup
    // files live there too. `testsetup-cloud.ts` patches `child_process` as the backstop
    // beneath the process seam and `testsetup-network.ts` wraps the `fetch` global and
    // node's http(s) clients; both are what makes the suite unable to reach either, which
    // is the opposite of what the two rules exist to prevent. `.dependency-cruiser.js`
    // cruises src/ alone and the emit reads src/ alone, so the three gates draw one line.
    files: ['test/**/*.ts'],
    rules: { 'no-restricted-imports': 'off', 'no-restricted-globals': 'off' },
  },
  {
    // Repo tooling is plain CommonJS scripts, not part of the
    // typed source tree, so they are linted without the type-aware service.
    files: ['tools/**/*.js', '*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        // `tools/timing.js` re-executes ITSELF with UV_THREADPOOL_SIZE pinned, because
        // libuv reads that variable once and has already read it by the time any of this
        // runs. Naming the script it should re-run needs `__filename`.
        __filename: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
