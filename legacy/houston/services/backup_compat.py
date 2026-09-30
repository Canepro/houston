"""Pure version and preset compatibility policy for backup restores.

Kept apart from the archive and runtime operations so the web UI can ask what a
restore would mean without depending on the code that stops a workspace or invokes
MongoDB tools.
"""

from packaging.version import InvalidVersion, Version


def _ver(value: str):
    try:
        return Version(str(value))
    except InvalidVersion:
        return None


def compatibility(manifest: dict, meta) -> dict:
    """Whether this bundle may be restored into this repro.

    Returns {allowed, requires_flag, blocked_reason, warnings, direction}. The web
    UI calls this to decide what to enable BEFORE the user commits to anything.
    """
    warnings: list[str] = []
    src, dst = str(manifest.get("rc_version", "")), str(meta.rc_version)
    sv, dv = _ver(src), _ver(dst)
    direction, requires_flag, blocked = "same", "", ""

    if not sv or not dv:
        warnings.append(f"cannot compare versions {src!r} and {dst!r}; proceeding blind")
    elif dv > sv:
        direction = "upgrade"
        requires_flag = "allow_upgrade"
        warnings.append(
            f"{src} data into a {dst} workspace: Rocket.Chat will run migrations on "
            "boot. That is an upgrade test, not a plain restore.")
    elif dv < sv:
        direction = "downgrade"
        blocked = (f"{src} data cannot be restored into an older {dst} workspace: "
                   "Rocket.Chat does not support downgrading a migrated database.")

    smt, dmt = _ver(manifest.get("mongo_tag", "")), _ver(meta.mongo_tag)
    if smt and dmt and smt.major != dmt.major:
        warnings.append(
            f"MongoDB major differs (dump from {smt}, target runs {dmt}); a restore "
            "across majors can fail on feature compatibility.")

    if manifest.get("preset") and manifest["preset"] != meta.preset:
        warnings.append(
            f"the dump came from preset {manifest['preset']!r} but this repro is "
            f"{meta.preset!r}; the data may reference services that do not exist here.")
    if manifest.get("sidecar_volumes"):
        warnings.append(
            "sidecar data is NOT in this bundle "
            f"({', '.join(manifest['sidecar_volumes'])}); uploads and IdP state will "
            "be missing even though the database references them.")
    if manifest.get("live"):
        warnings.append("this dump was taken with --live, so it may be inconsistent.")

    return {"allowed": not blocked, "blocked_reason": blocked, "direction": direction,
            "requires_flag": requires_flag, "warnings": warnings,
            "from_version": src, "to_version": dst}
