# Feature map

| Feature | Recipe | Applicability and baseline status |
| --- | --- | --- |
| Discovery and missing workspace | [capabilities](capabilities.md) | Mandatory offline path on every v2 candidate. |
| Attachable evidence | [evidence](evidence.md) | Drive when `evidence` is advertised; otherwise pending. |
| Resource inspection | [inspect](inventory.md) | Drive offline fixtures when `inspect` is advertised; live resources pending. |
| SSH access handoff | [access](access.md) | Pending the actual v2 payload consumer and environment contract. |
| Onboarding and capture | [onboarding and capture](onboarding-capture.md) | Pending prerequisite and browser/capture recipes. |

Read capability command paths and their flags at each exact candidate revision.
An entry being present establishes discovery only. It does not prove that feature
works. The parent extends and runs every applicable pending recipe after the
migration ports are integrated. `PASS_SCOPED` never means the full migration passed.
