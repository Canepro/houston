'use strict';

const base = require('./jest.config.js');

module.exports = {
  ...base,
  displayName: 'frozen-gui-browser',
  roots: ['<rootDir>/test/web/browser'],
  testMatch: ['**/*.browser.test.ts'],
  testPathIgnorePatterns: [],
  testResultsProcessor: '<rootDir>/tools/browser-results.js',
  // The browser project's own count gate is `tools/browser-results.js`: EXACTLY 218 passed and
  // zero skipped, whether or not this is CI. The zero-skips reporter's floor is a claim about
  // the ordinary suite, and its source scan already reads this project's spec from there.
  reporters: ['default'],
  testTimeout: 30000,
};
