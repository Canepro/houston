# Feature map

| Feature | Recipe | Applicability and baseline status |
| --- | --- | --- |
| Discovery and missing workspace | [capabilities](capabilities.md) | Mandatory offline path on every v2 candidate. |
| Attachable evidence | [evidence](evidence.md) | Drive when `evidence` is advertised; otherwise pending. |
| Resource inspection | [inspect](inventory.md) | Drive offline JSON and human fixtures when `inspect` is advertised; both must identify the requested workspace/runtime. Live resources pending. |
| SSH access handoff | [access](access.md) | Probe the clean Docker fixture and the Kubernetes fixture. A non-object `data` value fails the run. Drive when either object includes `data.access`, and then require the contract and actual response name/runtime on both loopback runtimes. When both objects omit the field, the port stays pending. Wildcard guidance must be null in both local and SSH sessions. No SSH execution. |
| Onboarding and capture | [onboarding and capture](onboarding-capture.md) | Drive synthetic-home onboarding persistence and local teardown authority refusals when `onboard` is advertised. Live engine behavior and successful browser capture remain pending. |
| Goal-first setup | [setup](setup.md) | Drive when `onboard` advertises `--show`; buffered prompts included; shared API requires its separate check. |

Read capability command paths and their flags at each exact candidate revision.
An entry being present establishes discovery only. It does not prove that feature
works. The parent extends and runs every applicable pending recipe after the
migration ports are integrated. `PASS_SCOPED` never means the full migration passed.

Every command receipt is a shared safety check: the helper scans its stdout and
stderr at capture time, then requires both regular files for every expected
command label and scans every retained command receipt again before
`PASS_SCOPED`. It also rejects a symlink, FIFO, socket, or other special entry
anywhere in the retained evidence tree before `PASS_SCOPED`. The candidate
temp directory under scratch is scanned for the synthetic sentinel before that
scratch tree is removed. Failure receipts and a hash manifest may remain after a failed
scan. Require `summary.result: PASS_SCOPED` and successful `summary.receipt_scan`;
file existence alone proves no verdict. Bundle attachments retain their recipe-specific scan.

The shared finalization contract is in [Doctor](../SKILL.md#doctor) and
[Cleanup](../SKILL.md#cleanup). Use the actual printed summary path and exit
status. PASS also requires a real evidence directory, regular receipts and the
original bytes of mandatory provenance, every emitted feature snapshot, and
every command stdout and stderr stream, including empty and failed outputs.
Read the authoritative inventory named by the printed summary's `inventory`
field. Its hashes include that summary and exclude the inventory itself.
If no summary can be written, stdout contains no path and stderr reports the
primary error and cleanup facts. A missing inventory after a finalizer failure
is incomplete proof.
The candidate manifest includes every nonignored untracked file, including literal
root colon filenames and files inside new untracked directories. The Git metadata
exclusion applies only at the root; nonignored nested Git metadata participates. Shared
[file work limits](../SKILL.md#cleanup) bound scan/hash bytes, directory work,
and finalizer time. Exhaustion fails with cleanup facts and an incomplete
inventory when necessary; it cannot certify a partial scan.
The Python safety regression drives actual verifier `main` with a synthetic
candidate CLI; it does not replace the real Houston CLI integration sweep.
