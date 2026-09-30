"""Static seed-profile data shared by planning and capability discovery."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Shape:
    users: int
    channels: int
    private: int
    teams: int
    team_channels: int
    discussions: int
    dms: int
    messages: int
    reactions: bool


PROFILES: dict[str, Shape] = {
    "small": Shape(users=5, channels=2, private=1, teams=1, team_channels=2,
                   discussions=2, dms=2, messages=5, reactions=False),
    "standard": Shape(users=20, channels=5, private=2, teams=2, team_channels=2,
                      discussions=3, dms=5, messages=20, reactions=True),
    "large": Shape(users=100, channels=12, private=4, teams=3, team_channels=2,
                   discussions=6, dms=20, messages=100, reactions=True),
}
