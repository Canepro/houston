"""The single-page app itself, and the reason this module registers LAST.

`StaticFiles(..., html=True)` mounted at `/` matches EVERY path. Anything registered
after it is unreachable, and an API route that lands behind it does not 404 — it answers
200 with `index.html`, which no status-code assertion catches and which looks, from the
browser, exactly like an endpoint returning nonsense.

So `spa` is the last entry in `routes.REGISTRATION_ORDER`, and `tests/test_web_routes.py`
asserts there is exactly one Mount in `app.routes` and that it is the final one, rather
than trusting this docstring.

The path comes from `importlib.resources`, not from `__file__` arithmetic: the GUI ships
as package data and has to be found the same way inside a wheel as in a checkout.
"""
from __future__ import annotations

from importlib import resources

from fastapi.staticfiles import StaticFiles

from houston.web.context import AppContext

#: The module's one entry point. There are no handlers here -- a mount is not a route
#: function -- so unlike its siblings this really is the whole public surface.
__all__ = ("register",)


def register(app, ctx: AppContext) -> None:
    """Mount the SPA at `/`. MUST be the last registration on the application."""
    webui = resources.files("houston").joinpath("data", "webui")
    app.mount("/", StaticFiles(directory=str(webui), html=True), name="ui")
