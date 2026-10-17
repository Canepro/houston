const MIN_PROTECTED_FRAGMENT_LENGTH = 8;

/**
 * Distinct substantial slices of a synthetic protected marker. Markers must be long enough that
 * a truncation or one-character alteration still leaves one of these slices readable.
 */
function uniqueProtectedFragments(marker: string): string[] {
  if (marker.length < MIN_PROTECTED_FRAGMENT_LENGTH * 2 + 1)
    throw new Error(
      `protected marker must be at least ${MIN_PROTECTED_FRAGMENT_LENGTH * 2 + 1} characters`,
    );

  const fragments = new Set<string>();
  for (let start = 0; start <= marker.length - MIN_PROTECTED_FRAGMENT_LENGTH; start += 1)
    fragments.add(marker.slice(start, start + MIN_PROTECTED_FRAGMENT_LENGTH));
  return [...fragments];
}

/** Reject any readable, meaningful fragment while allowing stronger masking or safe reformatting. */
export function assertProtectedFragmentsWithheld(output: string, markers: readonly string[]): void {
  for (const marker of markers) {
    if (uniqueProtectedFragments(marker).some((fragment) => output.includes(fragment)))
      throw new Error('redaction output exposes a protected marker fragment');
  }
}
