"""The MongoDB/kernel incompatibility is pure data below its three callers."""

from __future__ import annotations


def test_mongo_kernel_rule_lives_in_a_dependency_free_leaf():
    from houston.services import mongo_kernel

    assert mongo_kernel.mongo_kernel_conflict("8.0", "6.19.7")
    assert mongo_kernel.mongo_kernel_conflict("7.0", "6.19.7") == ""
    assert mongo_kernel.MONGO8_BAD_KERNEL == (6, 19)
