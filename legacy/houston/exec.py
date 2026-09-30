"""The single boundary through which Houston launches operating-system processes.

This module deliberately does not normalize results or exceptions. Callers depend on
the distinctions made by :mod:`subprocess`: inherited versus captured streams,
text versus bytes, replacement environments, timeouts, ``check=True``, and a missing
binary raising ``OSError``. Keeping a tiny pass-through API centralizes the launch
authority without erasing any of those contracts.
"""

from __future__ import annotations

import subprocess
from typing import Any


PIPE = subprocess.PIPE
STDOUT = subprocess.STDOUT
DEVNULL = subprocess.DEVNULL
CompletedProcess = subprocess.CompletedProcess
Process = subprocess.Popen
SubprocessError = subprocess.SubprocessError
CalledProcessError = subprocess.CalledProcessError
TimeoutExpired = subprocess.TimeoutExpired


def run(*args: Any, **kwargs: Any) -> CompletedProcess:
    """Run to completion with exactly the standard-library semantics requested."""
    return subprocess.run(*args, **kwargs)


def popen(*args: Any, **kwargs: Any) -> Process:
    """Start a streaming/interactive child with standard-library semantics."""
    return subprocess.Popen(*args, **kwargs)
