"""The service layer: everything both front-ends call, and nothing either of them owns.

Deliberately EMPTY of code. This file used to re-export `events` at module scope, which
put `houston.services` inside the 17-module import cycle phase 1 was cutting, and step
1.10 deleted it. It is back only because a package has to have one to be packaged:
`find_packages` will not discover a directory without an `__init__.py`, so
`houston.services.doctor` and every module under it was built into a wheel that did not
contain them — found by `tools/wheel_smoke.py`, which exists for exactly this.

**Nothing may be added here.** An import at this scope is executed before any submodule
can be handed back, so it becomes an edge from every one of them to this file, and the
cycle comes with it. `tools/scc_check.py` gates on that; the emptiness is the mechanism.
"""
