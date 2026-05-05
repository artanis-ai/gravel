"""Pre-commit hook installer. Parity with packages/sdk-ts/src/manifest/hook.ts."""
from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Literal


HookMode = Literal["husky", "pre-commit-framework", "native", "skipped"]


@dataclass
class HookInstallResult:
    mode: HookMode
    path: str | None = None
    already_installed: bool = False


_NATIVE_BODY = """#!/usr/bin/env sh
# Added by Gravel — keep .artanis/manifest.json in sync with prompts in your code.
python -m artanis_gravel manifest --check || {
  echo ""
  echo "Gravel: Your prompt manifest is out of date."
  echo "Run:    python -m artanis_gravel manifest --update"
  echo "Then:   git add .artanis/manifest.json && git commit"
  echo ""
  echo "(To bypass: git commit --no-verify)"
  exit 1
}
"""

_PRECOMMIT_LOCAL = """  - repo: local
    hooks:
      - id: gravel-manifest
        name: Gravel manifest check
        entry: python -m artanis_gravel manifest --check
        language: system
        pass_filenames: false
"""


def install_hook(repo_root: str | Path) -> HookInstallResult:
    root = Path(repo_root)

    husky = root / ".husky" / "pre-commit"
    if husky.exists():
        content = husky.read_text(encoding="utf-8")
        if "artanis_gravel manifest" in content or "@artanis/gravel manifest" in content:
            return HookInstallResult(mode="husky", path=str(husky), already_installed=True)
        sep = "" if content.endswith("\n") else "\n"
        husky.write_text(content + sep + "python -m artanis_gravel manifest --check\n")
        return HookInstallResult(mode="husky", path=str(husky))

    pcf = root / ".pre-commit-config.yaml"
    if pcf.exists():
        content = pcf.read_text(encoding="utf-8")
        if "gravel-manifest" in content:
            return HookInstallResult(mode="pre-commit-framework", path=str(pcf), already_installed=True)
        sep = "" if content.endswith("\n") else "\n"
        if "repos:" in content:
            pcf.write_text(content + sep + _PRECOMMIT_LOCAL)
        else:
            pcf.write_text("repos:\n" + _PRECOMMIT_LOCAL)
        return HookInstallResult(mode="pre-commit-framework", path=str(pcf))

    git_hooks = root / ".git" / "hooks"
    if not git_hooks.exists():
        return HookInstallResult(mode="skipped")

    hook = git_hooks / "pre-commit"
    if hook.exists():
        content = hook.read_text(encoding="utf-8")
        if "artanis_gravel manifest" in content or "@artanis/gravel manifest" in content:
            return HookInstallResult(mode="native", path=str(hook), already_installed=True)
        sep = "" if content.endswith("\n") else "\n"
        hook.write_text(content + sep + "python -m artanis_gravel manifest --check\n")
    else:
        hook.write_text(_NATIVE_BODY)
    hook.chmod(hook.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return HookInstallResult(mode="native", path=str(hook))


# Suppress unused-import warning when os is only used elsewhere.
_ = os
