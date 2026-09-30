"""The suite fails closed when a process patch no longer intercepts tooling."""

from __future__ import annotations

import pytest

from houston import exec as process


TOOLS = ("eksctl", "aws", "kubectl", "helm", "kind", "docker")


def _args(tool: str, *, string: bool, spend: bool):
    words = [tool, "create" if spend else "version", "fixture"]
    return " ".join(words) if string else words


@pytest.mark.parametrize("tool", TOOLS)
@pytest.mark.parametrize("string", (False, True), ids=("sequence", "string"))
def test_cloud_guard_reports_every_tool_unavailable(tool: str, string: bool) -> None:
    result = process.run(_args(tool, string=string, spend=False), capture_output=True,
                         text=True)

    assert result.returncode == 127
    assert result.stderr == f"{tool} is unavailable in the test suite"


@pytest.mark.parametrize("tool", TOOLS)
@pytest.mark.parametrize("string", (False, True), ids=("sequence", "string"))
def test_cloud_guard_refuses_every_spend_command(tool: str, string: bool) -> None:
    with pytest.raises(AssertionError, match=rf"run `{tool} create fixture`"):
        process.run(_args(tool, string=string, spend=True), capture_output=True,
                    text=True)


@pytest.mark.parametrize("tool", TOOLS)
def test_cloud_guard_never_starts_a_streaming_tool(tool: str) -> None:
    result = process.popen([tool, "version"], stdout=process.PIPE,
                           stderr=process.PIPE, text=True)

    assert isinstance(result, process.CompletedProcess)
    assert result.returncode == 127


def test_a_depointed_kubectl_patch_fails_before_the_operating_system(
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATH", "")

    with pytest.raises(AssertionError, match=r"run `kubectl create namespace"):
        process.run(["kubectl", "create", "namespace", "houston-test"],
                    capture_output=True, text=True)
