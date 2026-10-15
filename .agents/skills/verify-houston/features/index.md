# Feature map

| Feature | Recipe | Applicability and baseline status |
| --- | --- | --- |
| Discovery and missing workspace | [capabilities](capabilities.md) | Mandatory offline path on every v2 candidate. |
| Attachable evidence | [evidence](evidence.md) | Drive when `evidence` is advertised; otherwise pending. |
| Resource inspection | [inspect](inventory.md) | Drive offline fixtures when `inspect` is advertised; live resources pending. |
| SSH access handoff | [access](access.md) | Drive when `info` includes `data.access`; otherwise pending. No SSH execution. |
| Onboarding and capture | [onboarding and capture](onboarding-capture.md) | Drive synthetic-home onboarding persistence when `onboard` is advertised. Engine gates, goal-first setup and successful browser capture remain pending. |

Read capability command paths and their flags at each exact candidate revision.
An entry being present establishes discovery only. It does not prove that feature
works. The parent extends and runs every applicable pending recipe after the
migration ports are integrated. `PASS_SCOPED` never means the full migration passed.
