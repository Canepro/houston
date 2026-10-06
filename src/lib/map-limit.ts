/**
 * `inputs` mapped through `run`, at most `limit` in flight, results in input order.
 *
 * Shared by the cluster ledger (one status per known context) and the region sweep (one
 * sweep per region): both are lists of independent, slow, read-only network calls whose
 * answers must come back in the order they were asked, so a document does not vary with
 * which call happened to finish first.
 */
export async function mapLimit<T, R>(
  inputs: readonly T[],
  limit: number,
  run: (input: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(inputs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= inputs.length) return;
      out[index] = await run(inputs[index] as T, index);
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, inputs.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return out;
}
