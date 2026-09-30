"""Pure MongoDB/kernel compatibility rule (SERVER-121912)."""

from __future__ import annotations

import re


MONGO8_BAD_KERNEL = (6, 19)


def _kernel_major_minor(kernel: str) -> tuple[int, int] | None:
    match = re.match(r"(\d+)\.(\d+)", kernel or "")
    return (int(match.group(1)), int(match.group(2))) if match else None


def mongo_kernel_conflict(mongo_tag: str, kernel: str) -> str:
    """Why this MongoDB cannot start on this kernel, or an empty string."""
    version = _kernel_major_minor(kernel)
    if not version or version < MONGO8_BAD_KERNEL:
        return ""
    try:
        mongo_major = int(str(mongo_tag).split(".")[0])
    except (ValueError, AttributeError):
        return ""
    if mongo_major < 8:
        return ""
    shown = ".".join(str(number) for number in version)
    return (f"MongoDB {mongo_tag} cannot start on this engine's kernel ({shown}) — "
            "mongod 8.0 exits on kernel 6.19 and newer (SERVER-121912). Use an "
            "engine on an older kernel, or a Rocket.Chat version that pairs with "
            "MongoDB 7.0.")
