"""Fast scan. Parity with packages/sdk-ts/src/manifest/scan.ts.

As of v0.9.0 the scan walks the WHOLE repo (respecting .gitignore via
`git ls-files`) instead of only the conventional `prompts/`,
`templates/`, etc. dirs. Falls back to a filesystem walk with a
conservative ignore list when the project isn't a git checkout.
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .hash import generate_prompt_id, hash_prompt
from .types import Manifest, ManifestPromptEmbedded, ManifestPromptFile

# Allowlist of file extensions the fast scan picks up. v0.9.0 added
# `.markdown` / `.mdx` / `.mdc` per Olly's dogfooding (Cursor rules,
# MDX docs).
PROMPT_FILE_EXTS = {".md", ".markdown", ".txt", ".mdx", ".mdc"}

# Directory names anywhere in the path that mean the file is
# documentation about prompts rather than a prompt. Applied as a
# path-segment filter on every candidate (post-walk), so we skip
# `prompts/docs/foo.md`, `templates/examples/foo.md`, etc.
DOC_DIR_NAMES = {
    "docs",
    "doc",
    "documentation",
    "examples",
    # v0.10.0 additions from Olly's dogfooding (2026-05-21): markdown
    # here is repo metadata or test fixtures, not user-edited prompts.
    ".github",
    "tests",
    "test",
    "__tests__",
    "spec",
    "specs",
    "__fixtures__",
    "fixtures",
    # Knowledge-base / agent context the host app reads at runtime.
    "kb",
    "knowledge",
    "knowledgebase",
}

# Case-insensitive denylist of doc-file stems (without extension).
# Without this, a README.md sitting next to a real prompt would end
# up in the manifest as a fake prompt entry.
DOC_FILE_STEMS = {
    "README",
    "CHANGELOG",
    "CONTRIBUTING",
    "LICENSE",
    "LICENCE",
    "NOTICE",
    "AUTHORS",
    "MAINTAINERS",
    "HISTORY",
    "CHANGES",
    "SECURITY",
    "CODE_OF_CONDUCT",
    "COPYING",
    "INSTALL",
    "TODO",
    "ROADMAP",
    "USAGE",
    # v0.10.0: AI agent config files (Cursor / Aider / etc. seed
    # system prompts from these; they're not user-edited prompts).
    "CLAUDE",
    "GEMINI",
    "AGENTS",
    # GitHub templates.
    "ISSUE_TEMPLATE",
    "PULL_REQUEST_TEMPLATE",
    # Dependency manifests in .txt form.
    "REQUIREMENTS",
    "REQUIREMENTS-DEV",
    "PIPFILE",
    "CONSTRAINTS",
    # Other commonly-co-located metadata.
    "CONFIG",
    "VERSION",
}

# FS-walk fallback's ignore list: only kicks in when git isn't
# available. When git is there, .gitignore decides.
FS_FALLBACK_IGNORE_DIRS = {
    "node_modules",
    ".git",
    ".venv",
    "venv",
    ".env",
    "__pycache__",
    "dist",
    "build",
    "out",
    "target",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".pytest_cache",
    ".mypy_cache",
    ".tox",
    ".gradle",
    ".idea",
    ".vscode",
    "coverage",
    "vendor",
}


@dataclass
class FastScanResult:
    manifest: Manifest
    added: int = 0
    removed: int = 0
    changed: int = 0
    unchanged: int = 0


def fast_scan(repo_root: str | Path, current: Manifest) -> FastScanResult:
    repo_root = Path(repo_root)
    new_prompts: list[ManifestPromptFile | ManifestPromptEmbedded] = []
    result = FastScanResult(
        manifest=Manifest(
            version=current.version,
            last_full_scan_commit=current.last_full_scan_commit,
            last_full_scan_at=current.last_full_scan_at,
            prompts=[],
        )
    )

    # 1. Update / preserve existing entries.
    for prompt in current.prompts:
        file_path = repo_root / prompt.path
        try:
            content = file_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            result.removed += 1
            continue

        if isinstance(prompt, ManifestPromptFile):
            new_hash = hash_prompt(content)
            if new_hash == prompt.hash:
                new_prompts.append(prompt)
                result.unchanged += 1
            else:
                new_prompts.append(
                    ManifestPromptFile(
                        id=prompt.id, path=prompt.path, hash=new_hash
                    )
                )
                result.changed += 1
        else:
            slice_ = content[prompt.char_start : prompt.char_end]
            new_hash = hash_prompt(slice_)
            if new_hash == prompt.hash:
                new_prompts.append(prompt)
                result.unchanged += 1
            else:
                new_prompts.append(
                    ManifestPromptEmbedded(
                        id=prompt.id,
                        path=prompt.path,
                        hash=new_hash,
                        line_start=prompt.line_start,
                        line_end=prompt.line_end,
                        char_start=prompt.char_start,
                        char_end=prompt.char_end,
                        var_name=prompt.var_name,
                    )
                )
                result.changed += 1

    # 2. Discover new file-type prompts anywhere in the repo.
    known_paths = {p.path for p in current.prompts}
    for rel in _walk_repo_files(repo_root):
        if rel in known_paths:
            continue
        rel_path = Path(rel)
        if rel_path.suffix.lower() not in PROMPT_FILE_EXTS:
            continue
        if rel_path.stem.upper() in DOC_FILE_STEMS:
            continue
        if any(seg.lower() in DOC_DIR_NAMES for seg in rel.split("/")):
            continue
        try:
            content = (repo_root / rel).read_text(encoding="utf-8")
        except FileNotFoundError:
            continue
        new_prompts.append(
            ManifestPromptFile(
                id=generate_prompt_id(rel),
                path=rel,
                hash=hash_prompt(content),
            )
        )
        result.added += 1

    new_prompts.sort(key=lambda p: p.path)
    result.manifest.prompts = new_prompts
    return result


def _walk_repo_files(repo_root: Path) -> list[str]:
    """Repo-relative, forward-slashed paths of every candidate file.

    Tries `git ls-files --cached --others --exclude-standard` first
    (respects .gitignore + global ignore + .git/info/exclude). Falls
    back to a filesystem walk with FS_FALLBACK_IGNORE_DIRS when git
    isn't available or the directory isn't a working tree.
    """
    git_listed = _git_list_files(repo_root)
    if git_listed is not None:
        return git_listed
    return _fs_walk_files(repo_root)


def _git_list_files(repo_root: Path) -> list[str] | None:
    """Return tracked + untracked-but-not-ignored files via git, or
    `None` when git is unavailable / not a working tree."""
    try:
        res = subprocess.run(
            [
                "git",
                "-C",
                str(repo_root),
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
            check=False,
            capture_output=True,
        )
    except FileNotFoundError:
        # git binary missing.
        return None
    if res.returncode != 0:
        return None
    out: list[str] = []
    # git emits forward-slashed paths already.
    for p in res.stdout.split(b"\x00"):
        if p:
            out.append(p.decode("utf-8"))
    return out


def _fs_walk_files(repo_root: Path) -> list[str]:
    """Walk with dir-level pruning so we don't descend into node_modules
    / .venv / etc. on large repos."""
    out: list[str] = []
    root_str = str(repo_root)
    for dirpath, dirnames, filenames in os.walk(root_str):
        # Prune in-place so os.walk doesn't descend into ignored dirs.
        dirnames[:] = [
            d
            for d in dirnames
            if d not in FS_FALLBACK_IGNORE_DIRS and not d.startswith(".")
        ]
        for name in filenames:
            rel = os.path.relpath(os.path.join(dirpath, name), root_str)
            out.append(rel.replace(os.sep, "/"))
    return out


def diff_manifests(a: Manifest, b: Manifest) -> str:
    a_by_id = {p.id: p for p in a.prompts}
    b_by_id = {p.id: p for p in b.prompts}
    lines: list[str] = []
    for pid, p in a_by_id.items():
        after = b_by_id.get(pid)
        if not after:
            lines.append(f"- {p.path} (removed)")
        elif after.hash != p.hash:
            lines.append(f"~ {p.path} (content changed)")
    for pid, p in b_by_id.items():
        if pid not in a_by_id:
            lines.append(f"+ {p.path} (added)")
    return "\n".join(lines)
