/**
 * The name pools and the deterministic choices made from them.
 *
 * Tier 1. Every function here is pure and deterministic, which is the property the whole
 * package rests on: a plan that cannot say what a room will contain is a plan nothing can
 * check.
 */
import { dictGetChecked, iterateChecked, orElse, isTruthy, storedText } from '../lib/format';

import { THREAD_EVERY } from './kinds';

// Realistic pools; overflow gets a numeric suffix (e.g. alice, bob, …, alice2).
// NOTE: deliberately avoids `userN` names, which the ldap/saml presets use.
export const FIRST_NAMES: readonly string[] = Object.freeze([
  'alice',
  'bob',
  'carol',
  'dave',
  'erin',
  'frank',
  'grace',
  'heidi',
  'ivan',
  'judy',
  'mallory',
  'niaj',
  'olivia',
  'peggy',
  'quinn',
  'rupert',
  'sybil',
  'trent',
  'uma',
  'victor',
  'wendy',
  'xavier',
  'yvonne',
  'zack',
]);

export const CHANNEL_NAMES: readonly string[] = Object.freeze([
  'team-chat',
  'dev',
  'support',
  'random',
  'announcements',
  'design',
  'qa',
  'ops',
  'product',
  'sales',
  'incidents',
  'watercooler',
]);

export const PRIVATE_NAMES: readonly string[] = Object.freeze([
  'leadership',
  'private-project',
  'security',
  'hiring',
]);

export const TEAM_NAMES: readonly string[] = Object.freeze([
  'platform',
  'customer-success',
  'infrastructure',
]);

export const TEAM_CHANNEL_NAMES: readonly string[] = Object.freeze([
  'planning',
  'standup',
  'incidents',
  'releases',
]);

export const DISCUSSION_NAMES: readonly string[] = Object.freeze([
  'customer escalation 4821',
  'rollback plan',
  'release checklist',
  'post-mortem draft',
  'capacity for Q3',
  'onboarding questions',
]);

export const MESSAGES: readonly string[] = Object.freeze([
  'Hey team, any update on this?',
  'Can someone review my PR when you get a chance?',
  'Deploying to staging now 🚀',
  'Heads up: maintenance window tonight at 10pm.',
  'Thanks, that fixed it!',
  "I'm seeing the same issue on my end.",
  "Let's sync about this in standup.",
  'Docs are updated, please take a look.',
  "Good morning! What's on the agenda today?",
  'Anyone free for a quick call?',
  'Ticket #4821 is resolved.',
  'Nice work everyone 👏',
  'Reminder: submit your timesheets.',
  'Rolling back the last change, it broke the build.',
  'LGTM ✅',
  'Where did we land on the pricing question?',
]);

export const REPLIES: readonly string[] = Object.freeze([
  'Good catch — looking now.',
  'Same here, reproduced on 8.5.1.',
  'Fixed in the branch, pushing shortly.',
  'Can you share the log line?',
  "Agreed, let's do that.",
]);

export const EMOJI: readonly string[] = Object.freeze([':+1:', ':tada:', ':eyes:', ':rocket:']);

export function username(i: number): string {
  const base = FIRST_NAMES[i % FIRST_NAMES.length] as string;
  const grp = Math.floor(i / FIRST_NAMES.length);
  return grp === 0 ? base : `${base}${String(grp + 1)}`;
}

export function poolName(pool: readonly string[], i: number, sep = '-'): string {
  const base = pool[i % pool.length] as string;
  const grp = Math.floor(i / pool.length);
  return grp === 0 ? base : `${base}${sep}${String(grp + 1)}`;
}

export function channelName(i: number): string {
  return poolName(CHANNEL_NAMES, i);
}

export function privateName(i: number): string {
  return poolName(PRIVATE_NAMES, i);
}

export function teamName(i: number): string {
  return poolName(TEAM_NAMES, i);
}

/**
 * Prefixed with the team, because a channel name is unique workspace-wide.
 *
 * Two teams both wanting `planning` is the common case, and the second create would fail
 * with a name clash rather than producing the second team's channel.
 */
export function teamChannelName(teamI: number, i: number): string {
  return `${teamName(teamI)}-${poolName(TEAM_CHANNEL_NAMES, i)}`;
}

/**
 * A rotating window over the user list: deterministic, and varied per room.
 *
 * `random.sample` gave a different membership on every run, which is why nothing
 * downstream could state what a room would contain. The stride of 3 keeps consecutive
 * rooms from having identical membership without needing randomness.
 */
export function members(names: readonly string[], index: number, size: number): string[] {
  if (names.length === 0) return [];
  const width = Math.max(1, Math.min(size, names.length));
  const out: string[] = [];
  for (let j = 0; j < width; j += 1) out.push(names[(index * 3 + j) % names.length] as string);
  return out;
}

export function threads(messages: number, every: number = THREAD_EVERY): number[] {
  if (messages === 0) return [];
  const out: number[] = [];
  for (let i = 0; i < messages; i += every) out.push(i);
  return out;
}

/**
 * The i-th DM pair, walking increasing gaps so no pair repeats early.
 *
 * A random pair per DM drew with replacement across DMs, so the same pair could be
 * picked twice -- and the second `im.create` returns the SAME room, so a plan asking for
 * five DM rooms could produce four.
 *
 * Walking `gap` gives `n * floor((n - 1) / 2)` distinct pairs before any repeats. The bound is
 * not `n * (n // 2)`: at `gap == n / 2` on an even user count the pair {a, a + gap} is the
 * same unordered pair as {a + gap, a}, so that last band of gaps yields half as many. No
 * profile comes near the limit -- `large` asks for 20 DMs from 100 users, where the bound
 * is 4,950 -- but a caller passing --users 4 with 20 DMs would, and it should get repeats
 * rather than a wrong promise.
 */
export function dmPair(names: readonly string[], i: number): [string, string] {
  const n = names.length;
  // The gap wraps within 1..n-1 so it can never be a multiple of n, because a gap of 0
  // pairs a user WITH THEMSELVES -- `im.create` accepts that and makes a self-DM, which is
  // a real Rocket.Chat object and not what a plan asking for a conversation between two
  // people meant. It appeared the moment `--users 2` was passed with the default five DMs.
  const gap = 1 + (Math.floor(i / n) % (n - 1));
  const a = i % n;
  return [names[a] as string, names[(a + gap) % n] as string];
}

/**
 * A message with a `t` is the SERVER talking about the room, not a person talking in it.
 *
 * Rather than list them (there are dozens -- `uj`, `au`, `ru`, `room_changed_topic`,
 * `discussion-created`, ...), anything carrying a `t` at all is treated as a system
 * message, which is what the client does to decide whether to render it as a grey line.
 */
export function isContent(message: unknown): boolean {
  // No truthy `t` (`isTruthy`: an empty list is no `t` either), and a message that is not
  // a mapping raises, which ends the readback as it always has.
  return !isTruthy(dictGetChecked(message, 't'));
}

/** A `get` in the shape `check.ts` builds: `(body, why)`, the body any truthy JSON value. */
export type Getter = (
  path: string,
  headers: Record<string, string>,
  params?: Record<string, string | number | boolean>,
) => Promise<[unknown, string]>;

export async function inTeam(
  get: Getter,
  hdr: Record<string, string>,
  teamName_: string,
  roomName: string,
): Promise<boolean> {
  // Each member read, `or` and loop by the established rules (`dictGetChecked`, `orElse`,
  // `iterateChecked`), stopping at the first room that matches.
  const [body] = await get('/api/v1/teams.info', hdr, { teamName: teamName_ });
  const teamId = dictGetChecked(orElse(dictGetChecked(orElse(body, {}), 'teamInfo'), {}), '_id');
  if (!isTruthy(teamId)) return false;
  const [rooms] = await get('/api/v1/teams.listRooms', hdr, {
    teamId: typeof teamId === 'string' ? teamId : storedText(teamId),
    count: 100,
  });
  for (const r of iterateChecked(orElse(dictGetChecked(orElse(rooms, {}), 'rooms'), []))) {
    if (dictGetChecked(r, 'name') === roomName) return true;
  }
  return false;
}
