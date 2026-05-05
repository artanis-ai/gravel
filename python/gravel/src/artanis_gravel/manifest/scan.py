"""Fast scan. Parity with packages/sdk-ts/src/manifest/scan.ts."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .hash import generate_prompt_id, hash_prompt
from .types import Manifest, ManifestPromptEmbedded, ManifestPromptFile

PROMPT_FILE_DIRS = ["prompts", "prompt", "templates", "assistants", "agents"]
PROMPT_FILE_EXTS = {".md", ".txt", ".prompt"}


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
    result = FastScanResult(manifest=Manifest(
        version=current.version,
        last_full_scan_commit=current.last_full_scan_commit,
        last_full_scan_at=current.last_full_scan_at,
        prompts=[],
    ))

    seen_paths: set[str] = set()

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
                new_prompts.append(ManifestPromptFile(
                    id=prompt.id, path=prompt.path, hash=new_hash,
                ))
                result.changed += 1
        else:
            slice_ = content[prompt.char_start:prompt.char_end]
            new_hash = hash_prompt(slice_)
            if new_hash == prompt.hash:
                new_prompts.append(prompt)
                result.unchanged += 1
            else:
                new_prompts.append(ManifestPromptEmbedded(
                    id=prompt.id,
                    path=prompt.path,
                    hash=new_hash,
                    line_start=prompt.line_start,
                    line_end=prompt.line_end,
                    char_start=prompt.char_start,
                    char_end=prompt.char_end,
                    var_name=prompt.var_name,
                ))
                result.changed += 1
        seen_paths.add(prompt.path)

    # Discover new file-type prompts.
    for d in PROMPT_FILE_DIRS:
        dir_abs = repo_root / d
        if not dir_abs.exists():
            continue
        for file in dir_abs.rglob("*"):
            if not file.is_file():
                continue
            if file.suffix not in PROMPT_FILE_EXTS:
                continue
            rel = str(file.relative_to(repo_root)).replace("\\", "/")
            if any(p.path == rel for p in current.prompts):
                continue
            content = file.read_text(encoding="utf-8")
            entry = ManifestPromptFile(
                id=generate_prompt_id(rel),
                path=rel,
                hash=hash_prompt(content),
            )
            new_prompts.append(entry)
            result.added += 1

    new_prompts.sort(key=lambda p: p.path)
    result.manifest.prompts = new_prompts
    return result


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
