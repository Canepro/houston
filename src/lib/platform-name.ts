import * as os from 'node:os';

/**
 * The platform string in its established spelling: `<system>-<release>-<machine>`, with
 * `-with-glibc<version>` after it on a glibc Linux host.
 */
export function platformName(): string {
  const system = os.type();
  const base = `${system}-${os.release()}-${os.machine()}`;
  if (system !== 'Linux') {
    // macOS and Windows spell it from other sources; this is a uname-style fallback.
    return base;
  }

  let glibc: string | undefined;
  try {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    glibc = report.header?.glibcVersionRuntime;
  } catch {
    // An unknown libc is allowed: the string then has no libc part.
  }
  // A musl or otherwise unknown libc would need its spelling from another source.
  return glibc ? `${base}-with-glibc${glibc}` : base;
}
