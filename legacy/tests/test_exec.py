"""Behavioral contract for the single process-launch boundary."""

from __future__ import annotations

import os
import sys

import pytest

from houston import exec as process


def test_run_preserves_text_input_cwd_and_replacement_environment(tmp_path) -> None:
    script = "import os,sys; print(os.getcwd()); print(os.getenv('ONLY')); print(sys.stdin.read())"
    result = process.run(
        [sys.executable, "-c", script], input="payload", capture_output=True, text=True,
        cwd=tmp_path, env={"ONLY": "present"}, check=True,
    )

    assert result.stdout.splitlines() == [str(tmp_path), "present", "payload"]


def test_run_preserves_bytes_and_missing_binary_exceptions() -> None:
    result = process.run([sys.executable, "-c", "import sys;sys.stdout.buffer.write(b'raw')"],
                         capture_output=True, check=True)
    assert result.stdout == b"raw"
    with pytest.raises(FileNotFoundError):
        process.run(["/definitely/not/a/houston-command"])


def test_run_preserves_check_and_timeout_exceptions() -> None:
    with pytest.raises(process.CalledProcessError) as failed:
        process.run([sys.executable, "-c", "raise SystemExit(7)"], check=True)
    assert failed.value.returncode == 7

    with pytest.raises(process.TimeoutExpired):
        process.run([sys.executable, "-c", "import time; time.sleep(5)"], timeout=0.01)


def test_popen_preserves_streaming_and_process_control() -> None:
    child = process.popen(
        [sys.executable, "-c", "print('line', flush=True)"],
        stdout=process.PIPE, stderr=process.STDOUT, text=True,
        env=dict(os.environ), start_new_session=True,
    )

    assert child.stdout is not None
    assert child.stdout.readline() == "line\n"
    assert child.wait(timeout=5) == 0
