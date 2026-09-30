"""Recovery dispatch is registered by side-effect owners, not imported by journal."""

from __future__ import annotations

import inspect


def test_recovery_handlers_are_registered_without_journal_importing_their_owners():
    from houston.services import journal, recovery

    recovery.install()
    repairable = set(journal.KINDS) - set(journal.ADVISORY)
    assert repairable <= set(journal.repair_kinds())
    assert journal.CLUSTER_UNFINISHED in journal.subject_predicate_kinds()

    source = inspect.getsource(journal._repair) + inspect.getsource(journal.still_there)
    for owner in ("constrain", "mongoprof", "services import k8s", "services import eks"):
        assert owner not in source, f"journal still imports handler owner {owner}"
