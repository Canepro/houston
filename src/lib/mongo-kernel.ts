/**
 * The pure MongoDB/kernel compatibility rule (SERVER-121912).
 *
 * A dependency-free leaf, which is what makes it reachable from both the Compose create path
 * and `doctor` without either importing the other -- the same shape `redact.ts` has.
 *
 * MongoDB 8.0's `mongod` exits on kernel 6.19 and newer. The symptom names neither the
 * kernel nor MongoDB, so the rule exists to turn it into a sentence that does.
 */

/** The first kernel this rule refuses, inclusive. */
export const MONGO8_BAD_KERNEL: readonly [number, number] = Object.freeze([6, 19]);

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

/** Why this MongoDB cannot start on this kernel, or an empty string. */
export function mongoKernelConflict(mongoTag: string, kernel: string | null | undefined): string {
  const version = kernelMajorMinor(kernel);
  if (version === null) return '';
  if (version[0] < MONGO8_BAD_KERNEL[0]) return '';
  if (version[0] === MONGO8_BAD_KERNEL[0] && version[1] < MONGO8_BAD_KERNEL[1]) return '';

  const mongoMajor = leadingMajor(mongoTag);
  if (mongoMajor === null) return '';
  if (mongoMajor < 8) return '';
  const shown = `${String(version[0])}.${String(version[1])}`;
  return (
    `MongoDB ${mongoTag} cannot start on this engine's kernel (${shown}) — ` +
    'mongod 8.0 exits on kernel 6.19 and newer (SERVER-121912). Use an ' +
    'engine on an older kernel, or a Rocket.Chat version that pairs with ' +
    'MongoDB 7.0.'
  );
}
