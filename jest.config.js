// Jest + @swc/jest, NOT ts-jest.
//
// `jest.mock` is callable inside a test BODY, which is how this suite replaces a module
// for one test and no other. swc compiles the CommonJS output the rest of the build emits, with no type checking --
// types are `yarn typecheck`'s job, and making the test runner do it twice only makes
// a red suite slower to read.
//
// BROWSER TESTS use the `playwright` LIBRARY inside a Jest spec with the server
// IN-PROCESS. Never `@playwright/test`: it runs the server out-of-process, where it
// sees none of the monkeypatches, and they would be silently dropped while the suite
// stayed green.
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // Integration specs start child processes, hash passwords and load both applications.
  // Three workers on a shared four-CPU host repeatedly exceeded Jest's five-second
  // default in otherwise passing cases. Bound concurrency and allow scheduling
  // headroom; explicit per-test timing contracts retain their own deadlines.
  maxWorkers: 2,
  // Recycle an idle worker after a large integration file, before memory can
  // accumulate across the rest of the suite. This never interrupts a test.
  workerIdleMemoryLimit: '512MB',
  testTimeout: 30_000,
  // THE SETUP FILES every spec runs under. Teardown needs the test framework loaded, so
  // these are `setupFilesAfterEnv` rather than `setupFiles`.
  //
  //   testsetup.ts          a fresh HOUSTON_HOME per file
  //   testsetup-engine.ts   the engine answers healthy
  //   testsetup-cloud.ts    the six tools are ABSENT
  //   testsetup-network.ts  a non-loopback fetch or http(s) request fails the test
  //
  // Each registers module mocks or hooks BEFORE the test file is evaluated, so a test that
  // owns a stub for the same module registers after and wins -- which is how a test's own
  // stub wins over the shared one. `test/testsetup-*.test.ts` prove each one.
  setupFilesAfterEnv: [
    '<rootDir>/test/testsetup.ts',
    '<rootDir>/test/testsetup-engine.ts',
    '<rootDir>/test/testsetup-cloud.ts',
    '<rootDir>/test/testsetup-network.ts',
  ],
  // The suite lives in test/, mirroring src/ path for path; src/ holds production code only.
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['<rootDir>/test/web/browser/'],
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: { parser: { syntax: 'typescript' }, target: 'es2020' },
        module: { type: 'commonjs' },
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
  restoreMocks: true,
  // A SKIPPED TEST CANNOT BE CALLED GREEN, under `--ci`. `yarn test:zero-skips:selftest` plants each defect it claims to
  // see and requires the run to fail naming it; the file says what it cannot see.
  reporters: ['default', '<rootDir>/tools/jest-zero-skips.js'],
};
