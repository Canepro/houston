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
  readonly messages: number;
  readonly reactions: boolean;
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
    messages: 5,
    reactions: false,
  },
  standard: {
    users: 20,
    channels: 5,
    private: 2,
    teams: 2,
    teamChannels: 2,
    discussions: 3,
    dms: 5,
    messages: 20,
    reactions: true,
  },
  large: {
    users: 100,
    channels: 12,
    private: 4,
    teams: 3,
    teamChannels: 2,
    discussions: 6,
    dms: 20,
    messages: 100,
    reactions: true,
  },
};
