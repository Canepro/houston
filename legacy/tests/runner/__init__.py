"""A package so pytest imports these specs by their full path.

Without it, `tests/services/k8s/test_exec.py` and `tests/test_exec.py` are both the
module `test_exec` and the second one to be collected fails with "import file mismatch".
The directories mirror `houston/`, so the collision is not a coincidence -- it is what
co-locating by module name produces, and it recurs for every name the source tree uses
twice.
"""
