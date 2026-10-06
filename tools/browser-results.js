'use strict';

const EXPECTED = 145;

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
