"""`gravel doctor`. Parity with src/cli/doctor.ts."""
from __future__ import annotations

from pathlib import Path

from ..manifest import read_manifest
from .detect import detect
from .migrate import _read_env


def run_doctor() -> None:
    cwd = Path.cwd()
    detection = detect(cwd)
    env = _read_env(cwd)
    try:
        manifest = read_manifest(cwd)
    except Exception:
        manifest = None

    print("Gravel doctor")
    print("─────────────")
    print(f"Language:        {detection.language}")
    print(f"Framework:       {detection.framework}")
    print(f"Package manager: {detection.package_manager}")
    print(f"Database driver: {detection.database['driver']} (env: {detection.database['envVar'] or 'none'})")
    print(f"Auth provider:   {detection.auth}")
    print(f"Existing tracers: {', '.join(detection.existing_tracers) if detection.existing_tracers else 'none'}")
    print(f"Git repo:        {'yes' if detection.has_git else 'no'}")
    print(f"Manifest:        {f'{len(manifest.prompts)} prompts' if manifest else 'missing'}")
    print(f"GRAVEL_PROJECT_ID: {env.get('GRAVEL_PROJECT_ID', '<unset>')}")
    print(f"GRAVEL_API_KEY:    {'<set>' if env.get('GRAVEL_API_KEY') else '<unset>'}")
    print(f"GRAVEL_ADMIN_PASSWORD: {'<set>' if env.get('GRAVEL_ADMIN_PASSWORD') else '<unset>'}")
    print(f"GRAVEL_TRACING_DISABLED: {env.get('GRAVEL_TRACING_DISABLED', '<unset>')}")
