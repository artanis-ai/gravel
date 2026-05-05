"""Framework / package-manager / DB / auth detection. Parity with src/wizard/detect.ts."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

PackageManager = Literal["pnpm", "yarn", "bun", "npm", "uv", "poetry", "pip", "pipenv"]
Framework = Literal[
    "next-app-router", "next-pages-router", "express", "fastify", "hono",
    "fastapi", "django", "flask", "generic-node", "generic-asgi", "generic-wsgi",
]
DbDriver = Literal["postgres", "sqlite", "mysql", "unknown"]
AuthProvider = Literal[
    "clerk", "next-auth", "better-auth", "lucia", "auth0",
    "fastapi-users", "django-auth", "unknown",
]


@dataclass
class DetectionResult:
    cwd: str
    language: Literal["ts", "python"]
    package_manager: PackageManager
    framework: Framework
    database: dict  # {"driver": DbDriver, "envVar": str | None}
    auth: AuthProvider
    existing_tracers: list[str] = field(default_factory=list)
    has_git: bool = False


def detect(cwd: str | Path | None = None) -> DetectionResult:
    cwd = Path(cwd) if cwd else Path.cwd()

    py_result = _detect_python(cwd)
    if py_result is not None:
        return py_result

    ts_result = _detect_ts(cwd)
    if ts_result is not None:
        return ts_result

    return DetectionResult(
        cwd=str(cwd),
        language="ts",
        package_manager="npm",
        framework="generic-node",
        database={"driver": "unknown", "envVar": None},
        auth="unknown",
        existing_tracers=[],
        has_git=(cwd / ".git").exists(),
    )


def _detect_python(cwd: Path) -> DetectionResult | None:
    has_pyproject = (cwd / "pyproject.toml").exists()
    has_manage = (cwd / "manage.py").exists()
    has_reqs = (cwd / "requirements.txt").exists()
    if not (has_pyproject or has_manage or has_reqs):
        return None

    pm: PackageManager
    if (cwd / "uv.lock").exists():
        pm = "uv"
    elif (cwd / "poetry.lock").exists():
        pm = "poetry"
    elif (cwd / "Pipfile.lock").exists():
        pm = "pipenv"
    else:
        pm = "pip"

    text = ""
    for f in ("pyproject.toml", "requirements.txt", "Pipfile"):
        p = cwd / f
        if p.exists():
            text += p.read_text(encoding="utf-8", errors="ignore") + "\n"
    text_lower = text.lower()

    framework: Framework = "generic-asgi"
    if has_manage or "django" in text_lower:
        framework = "django"
    elif "fastapi" in text_lower:
        framework = "fastapi"
    elif "flask" in text_lower:
        framework = "flask"

    auth: AuthProvider = (
        "django-auth" if (has_manage or "django.contrib.auth" in text_lower)
        else "fastapi-users" if "fastapi-users" in text_lower
        else "unknown"
    )

    db_env = _read_env_var(cwd, ["DATABASE_URL", "POSTGRES_URL"])
    database = _infer_db(db_env)

    existing: list[str] = []
    if "sentry-sdk" in text_lower:
        existing.append("Sentry")
    if "langsmith" in text_lower:
        existing.append("LangSmith")
    if "langfuse" in text_lower:
        existing.append("Langfuse")

    return DetectionResult(
        cwd=str(cwd),
        language="python",
        package_manager=pm,
        framework=framework,
        database=database,
        auth=auth,
        existing_tracers=existing,
        has_git=(cwd / ".git").exists(),
    )


def _detect_ts(cwd: Path) -> DetectionResult | None:
    pkg = cwd / "package.json"
    if not pkg.exists():
        return None
    import json
    p = json.loads(pkg.read_text(encoding="utf-8"))
    deps = {**p.get("dependencies", {}), **p.get("devDependencies", {})}

    pm: PackageManager
    if (cwd / "pnpm-lock.yaml").exists():
        pm = "pnpm"
    elif (cwd / "yarn.lock").exists():
        pm = "yarn"
    elif (cwd / "bun.lockb").exists():
        pm = "bun"
    else:
        pm = "npm"

    framework: Framework = "generic-node"
    if "next" in deps:
        framework = "next-app-router" if (cwd / "app").exists() else "next-pages-router"
    elif "express" in deps:
        framework = "express"
    elif "fastify" in deps:
        framework = "fastify"
    elif "hono" in deps:
        framework = "hono"

    auth: AuthProvider = "unknown"
    if any(k.startswith("@clerk/") for k in deps):
        auth = "clerk"
    elif "next-auth" in deps:
        auth = "next-auth"
    elif "better-auth" in deps:
        auth = "better-auth"
    elif "lucia" in deps:
        auth = "lucia"
    elif any(k.startswith("@auth0/") for k in deps):
        auth = "auth0"

    db_env = _read_env_var(cwd, ["DATABASE_URL", "POSTGRES_URL", "NEON_DATABASE_URL"])
    database = _infer_db(db_env)

    existing: list[str] = []
    if any(k.startswith("@sentry/") for k in deps):
        existing.append("Sentry")
    if "langsmith" in deps:
        existing.append("LangSmith")
    if "langfuse" in deps:
        existing.append("Langfuse")

    return DetectionResult(
        cwd=str(cwd),
        language="ts",
        package_manager=pm,
        framework=framework,
        database=database,
        auth=auth,
        existing_tracers=existing,
        has_git=(cwd / ".git").exists(),
    )


def _read_env_var(cwd: Path, candidates: list[str]) -> tuple[str, str] | None:
    for f in (".env.local", ".env"):
        p = cwd / f
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            m = re.match(r"\s*(\w+)\s*=\s*(.+?)\s*$", line)
            if not m:
                continue
            name, raw = m.group(1), m.group(2)
            if name not in candidates:
                continue
            value = raw.strip("'\"")
            return name, value
    return None


def _infer_db(env: tuple[str, str] | None) -> dict:
    if env is None:
        return {"driver": "unknown", "envVar": None}
    name, value = env
    if value.startswith("postgres"):
        return {"driver": "postgres", "envVar": name}
    if value.startswith("mysql"):
        return {"driver": "mysql", "envVar": name}
    if value.startswith("file:") or value.endswith(".db"):
        return {"driver": "sqlite", "envVar": name}
    return {"driver": "unknown", "envVar": name}
