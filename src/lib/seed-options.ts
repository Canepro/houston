/** Static seed choices shared by both front ends; discovery does no I/O. */
import { ValidationError } from './errors';
import { PROFILES } from './seed-profiles';

export const MAX_HISTORY_DAYS = 36_500;
export const SCENARIOS = Object.freeze({
  'room-states': {
    title: 'Room states',
    description: 'Read-only, broadcast, and archived rooms',
    rooms: 3,
    messages: 15,
    pins: 3,
    minimumUsers: 1,
  },
  permissions: {
    title: 'Permissions',
    description: 'Alice owns, Bob moderates, Carol is muted, Dave stays outside',
    rooms: 1,
    messages: 5,
    pins: 1,
    minimumUsers: 4,
  },
});
export interface SeedSelection {
  readonly scenarios: readonly string[];
  readonly historyDays: number | null;
}

export function seedSelection(scenarios: unknown = [], historyDays: unknown = null): SeedSelection {
  if (
    !Array.isArray(scenarios) ||
    !scenarios.every((value: unknown) => typeof value === 'string')
  ) {
    throw new ValidationError('seed scenarios must be a list of scenario names');
  }
  const names = [...new Set(scenarios as string[])].sort();
  for (const name of names) {
    if (!Object.hasOwn(SCENARIOS, name))
      throw new ValidationError(
        `unknown seed scenario '${name}' (want ${Object.keys(SCENARIOS).join(' | ')})`,
      );
  }
  if (
    historyDays !== null &&
    historyDays !== undefined &&
    (typeof historyDays !== 'number' ||
      !Number.isSafeInteger(historyDays) ||
      historyDays < 1 ||
      historyDays > MAX_HISTORY_DAYS)
  ) {
    throw new ValidationError(
      `history days must be an integer from 1 to ${String(MAX_HISTORY_DAYS)}`,
    );
  }
  return {
    scenarios: names,
    historyDays: historyDays === undefined ? null : (historyDays as number | null),
  };
}

export function seedCatalogue() {
  return {
    profiles: Object.entries(PROFILES).map(([name, shape]) => ({
      name,
      users: shape.users,
      rooms:
        1 +
        shape.channels +
        shape.private +
        shape.teams * (1 + shape.teamChannels) +
        shape.discussions +
        shape.dms +
        shape.groupDms,
      messages_per_channel: shape.messages,
    })),
    scenarios: Object.entries(SCENARIOS).map(([name, details]) => ({ name, ...details })),
    history: { supported: true, unit: 'days', minimum: 1, maximum: MAX_HISTORY_DAYS },
  };
}
