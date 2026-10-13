/**
 * The room kinds, and the three strides the manifest is built from.
 *
 * Tier 0 of the package, which nothing in it may import upward from.
 */

/**
 * One message in every N gets a thread reply.
 *
 * A fixed stride rather than a probability, so the plan can state how many replies there
 * will be -- and so the readback can tell "the thread was not created" from "the dice said
 * no".
 */
export const THREAD_EVERY = 5;

/** And one in every N gets a reaction, on the profiles that ask for them. */
export const REACT_EVERY = 3;

/**
 * What a discussion created FROM a message starts with, before anyone posts into it.
 *
 * Rocket.Chat copies the parent message in as the discussion's anchor -- it comes back
 * with an empty `msg` and no `t`, so a message listing counts it as content -- and the
 * `reply` we send alongside becomes the first real line.
 *
 * MEASURED, on live 7.4.1 and 8.5.1, not assumed: the first guess was one, and the room
 * held two. It is stated here rather than absorbed into a fudge factor because a plan that
 * cannot say what a room will contain is the thing this module exists to stop being.
 *
 * 6.x was deliberately not measured -- it is out of support, and a floor nobody runs is a
 * claim nobody can maintain. If the number ever differs on a future release the room reads
 * as holding MORE than planned, which is reported and not a fault, so an unmeasured
 * version degrades quietly rather than failing.
 */
export const ANCHOR_MESSAGES = 2;

// --- the room kinds -----------------------------------------------------------
// Every shape of room Rocket.Chat has, because every one of them is something a customer
// files a ticket about. The kind decides which endpoint creates it and which endpoint
// reads it back; nothing else in this package branches on it.

/** public, standalone */
export const CHANNEL = 'channel';
/** private, standalone */
export const PRIVATE = 'private';
/** a public team's main room */
export const TEAM = 'team';
/** a private team's main room */
export const TEAM_PRIVATE = 'team-private';
/** public channel inside a team */
export const TEAM_CHANNEL = 'team-channel';
/** private channel inside a team */
export const TEAM_CHANNEL_PRIVATE = 'team-channel-private';
/** a child room of a parent room */
export const DISCUSSION = 'discussion';
export const DM = 'dm';
export const GROUP_DM = 'group-dm';
export const READ_ONLY = 'scenario-read-only';
export const BROADCAST = 'scenario-broadcast';
export const ARCHIVED = 'scenario-archived';
export const PERMISSIONS = 'scenario-permissions';
/** the room every workspace ships */
export const GENERAL = 'general';

/**
 * Kinds whose rooms a discussion may hang off.
 *
 * `general` is excluded on purpose: it is the one room a reader will already be looking
 * at, and burying the seeded discussions there makes them hard to find rather than easy.
 */
export const DISCUSSABLE: readonly string[] = Object.freeze([
  CHANNEL,
  PRIVATE,
  TEAM,
  TEAM_PRIVATE,
  TEAM_CHANNEL,
  TEAM_CHANNEL_PRIVATE,
]);

/**
 * Which kinds are private, for the readback (`groups.*` vs `channels.*`) and for anything
 * that wants to say so on screen.
 */
export const PRIVATE_KINDS: readonly string[] = Object.freeze([
  PRIVATE,
  TEAM_PRIVATE,
  TEAM_CHANNEL_PRIVATE,
  PERMISSIONS,
]);

/**
 * `get()`'s answer for "the server says this room does not exist", as opposed to "the
 * server could not be asked". One is a fault and the other is a gap in the check, and they
 * must never be the same value.
 */
export const ABSENT = '<absent>';
