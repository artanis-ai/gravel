"""Random password + .env additions. Parity with src/wizard/env.ts."""
from __future__ import annotations

import secrets
import string
from pathlib import Path


def generate_password() -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(32))


def write_env_additions(cwd: str | Path, vars_: dict[str, str]) -> None:
    cwd = Path(cwd)
    local = cwd / ".env.local"
    fallback = cwd / ".env"
    target = local if local.exists() else (fallback if fallback.exists() else local)
    existing = target.read_text(encoding="utf-8") if target.exists() else ""

    lines: list[str] = []
    if "GRAVEL_PROJECT_ID" not in existing:
        lines.append("# Added by Gravel wizard")
    for k, v in vars_.items():
        if f"{k}=" in existing:
            continue
        lines.append(f"{k}={v}")
    if not lines:
        return
    sep = "" if existing.endswith("\n") else ("\n" if existing else "")
    target.write_text(existing + sep + "\n".join(lines) + "\n", encoding="utf-8")
