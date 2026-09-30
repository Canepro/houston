"""THE admin login every service function goes through.

Tier 0. Named `admin` rather than `auth` because `auth` is what every caller names
the local it binds the result to, and a module shadowed by a local is a module
nobody can reach from inside the function that needs it most.

Its own module because of who calls it: `seed`, `pat`, `api`, `loadtest`,
`monitor`, `upgrade` and readiness all authenticate through this one function, and the
suite patches it from four different subjects. Filing it under `ready` would have made
`seeding` import `ready` while `ready` imports `seeding` -- the map said to, and the
cycle check added in the previous commit is what caught it.
"""
from __future__ import annotations

from houston import config, rcapi, runner

def login(meta: runner.Metadata) -> rcapi.Auth:
    """THE admin login every service function goes through.

    `password=` is not optional here even though `rcapi.login` has a default. The
    default is the shared loopback `admin123`, and a workspace with a public name
    has its own -- so leaving it off would authenticate `pat`, `api`, `seed`,
    `loadtest`, `monitor`, `upgrade` and readiness with the wrong password and
    return a 401 that names nothing.
    """
    return rcapi.login(meta.root_url, password=meta.admin_pass,
                       mailpit_url=meta.extra.get(config.EXTRA_MAILPIT_URL))
