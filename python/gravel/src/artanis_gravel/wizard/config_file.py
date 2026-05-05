"""Generates gravel_config.py for Python users. Parity with src/wizard/config-file.ts."""
from __future__ import annotations

from pathlib import Path

from .detect import DetectionResult


def generate_config_file(detection: DetectionResult, cwd: str | Path, *, mount_path: str) -> str:
    cwd = Path(cwd)
    if detection.language == "python":
        path = cwd / "gravel_config.py"
        if path.exists():
            return str(path)
        path.write_text(_py_content(detection, mount_path), encoding="utf-8")
        return str(path)
    # Defer to TS in mixed-language repos. Wizard logic for that combination
    # is handled by the TS side.
    return str(cwd / "gravel.config.ts")


def _py_content(d: DetectionResult, mount_path: str) -> str:
    db_env = d.database["envVar"] or "DATABASE_URL"
    if d.auth == "django-auth":
        auth_block = """\
async def get_user(req):
    django_user = req.scope.get('user')
    if not django_user or not getattr(django_user, 'is_authenticated', False):
        return None
    return GravelUser(
        id=str(django_user.id),
        first_name=django_user.first_name or 'User',
        role='admin' if django_user.groups.filter(name='gravel_admin').exists() else 'user',
    )

"""
        auth_kw = "auth={'get_user': get_user}"
    else:
        auth_block = ""
        auth_kw = "auth={'default_password': os.environ['GRAVEL_ADMIN_PASSWORD']}"

    return (
        "import os\n"
        "from artanis_gravel import GravelConfig, GravelUser\n\n"
        + auth_block
        + "config = GravelConfig(\n"
        f"    mount_path='{mount_path}',\n"
        f"    database={{'url': os.environ['{db_env}']}},\n"
        f"    {auth_kw},\n"
        ")\n"
    )
