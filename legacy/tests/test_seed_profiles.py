"""The seed profile catalogue is data below both seed and jsonout."""

from __future__ import annotations


def test_seed_profiles_are_shared_from_a_leaf():
    from houston import seed, seed_profiles

    assert seed.PROFILES is seed_profiles.PROFILES
    assert seed.Shape is seed_profiles.Shape
    assert list(seed_profiles.PROFILES) == ["small", "standard", "large"]
