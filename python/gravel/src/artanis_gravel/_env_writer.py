"""Server-side .env writer for the GitHub-App install callback.

Port of `packages/sdk-ts/src/handler/env.ts`. Used by the GH install
callback to persist resolved env vars into `.env.local` (or `.env` if
that's the only file present). Same precedence + overwrite semantics
as the TS version so a host that toggles between SDKs sees consistent
behaviour.

Lives here because the gravel CLI is a Go binary now; wizard-time
writes (gravel_config.py, mount route, GRAVEL_ADMIN_PASSWORD) belong
to the CLI. This helper is the small subset the dashboard handler
still needs at runtime.
"""
from __future__ import annotations

import re
from pathlib import Path

_KEY_RE = re.compile(r"^([A-Z_][A-Z0-9_]*)=")


def write_env_additions(
    cwd: str | Path,
    vars: dict[str, str],
    *,
    overwrite: bool = False,
) -> dict[str, str]:
    """Append the given env vars to `.env.local` (preferred, Next
    convention) or `.env`. Existing keys are skipped unless
    `overwrite=True`.

    Returns `{"file": ".env.local" | ".env"}` so callers can tell the
    user where the value landed. Mirrors the TS handler's return shape.
    """
    root = Path(cwd)
    local_path = root / ".env.local"
    fallback = root / ".env"
    target = local_path
    basename = ".env.local"
    existing = ""
    if local_path.exists():
        existing = local_path.read_text(encoding="utf-8")
    elif fallback.exists():
        existing = fallback.read_text(encoding="utf-8")
        target = fallback
        basename = ".env"

    if overwrite:
        seen: set[str] = set()
        out_lines: list[str] = []
        for line in existing.split("\n"):
            m = _KEY_RE.match(line)
            if m and m.group(1) in vars:
                seen.add(m.group(1))
                out_lines.append(f"{m.group(1)}={vars[m.group(1)]}")
            else:
                out_lines.append(line)
        updated = "\n".join(out_lines)
        additions = [f"{k}={v}" for k, v in vars.items() if k not in seen]
        if additions:
            sep = "" if updated.endswith("\n") else ("\n" if updated else "")
            updated = updated + sep + "\n".join(additions) + "\n"
        if updated != existing:
            target.write_text(updated, encoding="utf-8")
        return {"file": basename}

    additions: list[str] = []
    for k, v in vars.items():
        if f"{k}=" in existing:
            continue  # never overwrite
        additions.append(f"{k}={v}")
    if additions:
        sep = "" if existing.endswith("\n") else ("\n" if existing else "")
        target.write_text(existing + sep + "\n".join(additions) + "\n", encoding="utf-8")
    return {"file": basename}
