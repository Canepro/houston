"""Wire journal recovery handlers from the modules that own each side effect."""

from __future__ import annotations


def install() -> None:
    """Install every recovery extension idempotently before journal recovery."""
    from houston import seed
    from houston.perf import mongoprof
    from houston.services import backup, eks, perf

    backup.install_journal_repairs()
    seed.install_journal_repairs()
    perf.install_journal_repairs()
    mongoprof.install_journal_repairs()
    eks._install_journal_subject_predicates()


def recover(*args, **kwargs):
    """Install extensions, then run recovery through its dependency-free core."""
    from houston.services import journal
    install()
    return journal.recover(*args, **kwargs)
