# Feature map

| Feature | Recipe | Applicability and baseline status |
| --- | --- | --- |
| Discovery and missing workspace | [capabilities](capabilities.md) | Mandatory offline path on every v2 candidate. |
| Attachable evidence | [evidence](evidence.md) | Drive when `evidence` is advertised; otherwise pending. |
| Workspace inventory | [inventory](inventory.md) | Pending candidate-specific inventory recipe and fixtures. |
| Access | [access](access.md) | Pending identity and authorization fixtures. |
| Onboarding and capture | [onboarding and capture](onboarding-capture.md) | Pending prerequisite and browser/capture recipes. |

Read capability command paths and their flags at each exact candidate revision.
An entry being present establishes discovery only. It does not prove that feature
works. The parent extends and runs every applicable pending recipe after the
migration ports are integrated. `PASS_SCOPED` never means the full migration passed.
