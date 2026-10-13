'use strict';

// Three Okta sign-in behaviors -- the button, the tile, a refusal -- extend 213.
// A list read that never answers, given up so the rail carries on, extends 212.
// Two behaviors extend 210: a running create shown on the rail after a reload, and the
// e2ee preset's options sent as its settings.
// Five retained-job History behaviors extend the 205 baseline.
// Five seed GUI behaviors and twenty-two re-verification regressions extend the 178 baseline.
const EXPECTED = 216;

module.exports = (results) => {
  const wanted = process.env.BROWSER_GATE_PROBE === 'count' ? EXPECTED + 1 : EXPECTED;
  if (
    results.numTotalTests !== wanted ||
    results.numPassedTests !== wanted ||
    results.numPendingTests !== 0 ||
    results.numFailedTests !== 0
  ) {
    throw new Error(
      `browser count gate: expected exactly ${wanted} passed and zero skipped; ` +
        `got ${results.numPassedTests} passed, ${results.numPendingTests} skipped, ` +
        `${results.numFailedTests} failed, ${results.numTotalTests} total`,
    );
  }
  process.stdout.write(`Browser count gate: exactly ${EXPECTED} passed, zero skipped\n`);
  return results;
};
