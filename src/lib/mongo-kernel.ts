/**
 * The pure MongoDB/kernel compatibility rule (SERVER-121912).
 *
 * A dependency-free leaf, which is what makes it reachable from both the Compose create path
 * and `doctor` without either importing the other -- the same shape `redact.ts` has.
 *
 * MongoDB 8 and newer exit on kernel 6.19 through 7.0.13; 7.0.14 carries the kernel fix
 * (MongoDB's production notes). The symptom names neither the kernel nor MongoDB, so the
 * rule exists to turn it into a sentence that does.
 */

/** The first kernel this rule refuses, inclusive. */
export const MONGO8_BAD_KERNEL: readonly [number, number] = Object.freeze([6, 19]);

/** The first kernel with the fix, so the first one this rule lets through again. */
export const MONGO8_FIXED_KERNEL: readonly [number, number, number] = Object.freeze([7, 0, 14]);

/** `(\d+)\.(\d+)` read from the START of a kernel string, or null. */
export function kernelMajorMinor(kernel: string | null | undefined): [number, number] | null {
  const match = /^(\d+)\.(\d+)/u.exec(kernel ?? '');
  if (match === null) return null;
  return [Number.parseInt(match[1] as string, 10), Number.parseInt(match[2] as string, 10)];
}

/**
 * The integer before the first dot -- an optional sign and digits, surrounding whitespace
 * allowed -- or null, raising nowhere.
 *
 * NOT `parseInt`, which reads `8abc` as 8 where it must be refused -- and a refused
 * parse is the difference between "this tag cannot be understood" (report no conflict)
 * and a conflict claimed for a tag nobody can read.
 */
function leadingMajor(tag: string): number | null {
  const head = (String(tag).split('.')[0] ?? '').trim();
  if (!/^[+-]?\d+$/u.test(head)) return null;
  return Number.parseInt(head, 10);
}

/** Whether release `a` comes before release `b`; a missing part reads as 0. */
function before(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/** Why this MongoDB cannot start on this kernel, or an empty string. */
export function mongoKernelConflict(mongoTag: string, kernel: string | null | undefined): string {
  // The patch decides it at the top of the range: 7.0.13 is refused, 7.0.14 is not.
  const shown = /^\d+\.\d+(?:\.\d+)?/u.exec(kernel ?? '')?.[0];
  if (shown === undefined) return '';
  const version = shown.split('.').map((part) => Number.parseInt(part, 10));
  if (before(version, MONGO8_BAD_KERNEL) || !before(version, MONGO8_FIXED_KERNEL)) return '';

  const mongoMajor = leadingMajor(mongoTag);
  if (mongoMajor === null) return '';
  if (mongoMajor < 8) return '';
  return (
    `MongoDB ${mongoTag} cannot start on this engine's kernel (${shown}) — ` +
    'MongoDB 8 and newer exit on Linux kernel 6.19 through 7.0.13 (SERVER-121912). ' +
    'Use an engine on kernel 7.0.14 or newer (on a Mac or Windows, update Docker ' +
    'Desktop), or a Rocket.Chat version that pairs with MongoDB 7.0.'
  );
}
