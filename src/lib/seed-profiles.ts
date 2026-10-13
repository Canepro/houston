/**
 * Static seed-profile data shared by planning and capability discovery.
 *
 * Its own module because `capabilities` needs the profile names and their shapes without
 * importing the seeder, which reaches the RC seam.
 */

/** One profile's counts, readonly. */
export interface Shape {
  readonly users: number;
  readonly channels: number;
  readonly private: number;
  readonly teams: number;
  readonly teamChannels: number;
  readonly discussions: number;
  readonly dms: number;
  readonly groupDms: number;
  readonly messages: number;
  readonly reactions: boolean;
  readonly replyCount: number;
  readonly fileSets: number;
  readonly edits: number;
  readonly emoji: number;
}

export const PROFILES: Record<string, Shape> = {
  small: {
    users: 5,
    channels: 2,
    private: 1,
    teams: 1,
    teamChannels: 2,
    discussions: 2,
    dms: 2,
    groupDms: 1,
    messages: 5,
    reactions: true,
    replyCount: 2,
    fileSets: 1,
    edits: 2,
    emoji: 1,
  },
  standard: {
    users: 20,
    channels: 5,
    private: 2,
    teams: 2,
    teamChannels: 2,
    discussions: 3,
    dms: 5,
    groupDms: 3,
    messages: 20,
    reactions: true,
    replyCount: 3,
    fileSets: 3,
    edits: 6,
    emoji: 3,
  },
  large: {
    users: 100,
    channels: 12,
    private: 4,
    teams: 3,
    teamChannels: 2,
    discussions: 6,
    dms: 20,
    groupDms: 8,
    messages: 100,
    reactions: true,
    replyCount: 5,
    fileSets: 6,
    edits: 20,
    emoji: 6,
  },
};
