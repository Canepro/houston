import { JsonFloat } from '../lib/jsonout';

// `elapsed_s` is the seed's total rounded to 2 places, a float in `up --seed --json`'s
// data.seed even when it is integral.
const EXACT_FLOAT_FIELDS = new Set([
  'dump_seconds',
  'restore_seconds',
  'boot_seconds',
  'elapsed_s',
]);

/**
 * Preserve the established float spelling (`5.0`, not `5`) at the CLI envelope boundary only.
 *
 * A float a command already marked passes through as it is: walked as an object, it was
 * rebuilt as a plain `{"value": ...}`, and the envelope wrote that where the number goes.
 */
export function preserveFloatFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => preserveFloatFields(item));
  if (typeof value !== 'object' || value === null || value instanceof JsonFloat) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] =
      EXACT_FLOAT_FIELDS.has(key) && typeof child === 'number'
        ? new JsonFloat(child)
        : preserveFloatFields(child);
  }
  return out;
}

/** Validate the process-level JSON/NDJSON contract without normalising its content. */
export function parseJsonTranscript(
  text: string,
  streams: boolean,
): { events: Record<string, unknown>[]; envelope: Record<string, unknown> } {
  const rawLines = text.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  if (rawLines.length === 0 || rawLines.some((line) => line === '')) {
    throw new Error('JSON stdout must contain complete, non-empty lines');
  }
  const lines = rawLines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(`stdout line ${String(index + 1)} is prose or invalid JSON`);
    }
  });
  if (lines.some((line) => typeof line !== 'object' || line === null || Array.isArray(line))) {
    throw new Error('every JSON stdout line must be an object');
  }
  const objects = lines as Record<string, unknown>[];
  const envelope = objects.at(-1) as Record<string, unknown>;
  if (typeof envelope.schema !== 'string' || !envelope.schema.startsWith('houston.')) {
    throw new Error('the final JSON line is not an envelope');
  }
  if (envelope.schema === 'houston.event.v1') {
    throw new Error('the final JSON line is an event, not the envelope');
  }
  const events = objects.slice(0, -1);
  if (!streams && events.length > 0) throw new Error('a non-streaming command wrote extra stdout');
  for (const event of events) {
    if (event.schema !== 'houston.event.v1') {
      throw new Error('an envelope or prose appeared before the final line');
    }
  }
  return { events, envelope };
}
