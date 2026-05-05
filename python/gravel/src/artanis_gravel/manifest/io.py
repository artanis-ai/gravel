"""Read / write `.artanis/manifest.json`. Parity with src/manifest/io.ts."""
from __future__ import annotations

import dataclasses
import json
from pathlib import Path

from .types import (
    MANIFEST_PATH,
    MANIFEST_VERSION,
    Manifest,
    ManifestPromptEmbedded,
    ManifestPromptFile,
    empty_manifest,
)


def _prompt_from_dict(d: dict) -> ManifestPromptFile | ManifestPromptEmbedded:
    if d.get("type") == "embedded":
        return ManifestPromptEmbedded(
            id=d["id"],
            path=d["path"],
            hash=d["hash"],
            line_start=d["lineStart"],
            line_end=d["lineEnd"],
            char_start=d["charStart"],
            char_end=d["charEnd"],
            var_name=d.get("varName"),
        )
    return ManifestPromptFile(id=d["id"], path=d["path"], hash=d["hash"])


def _prompt_to_dict(p) -> dict:
    if isinstance(p, ManifestPromptEmbedded):
        out = {
            "id": p.id,
            "type": "embedded",
            "path": p.path,
            "hash": p.hash,
            "lineStart": p.line_start,
            "lineEnd": p.line_end,
            "charStart": p.char_start,
            "charEnd": p.char_end,
        }
        if p.var_name is not None:
            out["varName"] = p.var_name
        return out
    return {"id": p.id, "type": "file", "path": p.path, "hash": p.hash}


def read_manifest(repo_root: str | Path) -> Manifest:
    path = Path(repo_root) / MANIFEST_PATH
    if not path.exists():
        return empty_manifest()
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("version") != MANIFEST_VERSION:
        raise ValueError(
            f"[gravel] Manifest version {raw.get('version')} not supported by this SDK "
            f"(expected {MANIFEST_VERSION}). Update artanis-gravel."
        )
    return Manifest(
        version=raw["version"],
        last_full_scan_commit=raw.get("lastFullScanCommit"),
        last_full_scan_at=raw.get("lastFullScanAt"),
        prompts=[_prompt_from_dict(p) for p in raw.get("prompts", [])],
    )


def write_manifest(repo_root: str | Path, manifest: Manifest) -> None:
    path = Path(repo_root) / MANIFEST_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": manifest.version,
        "lastFullScanCommit": manifest.last_full_scan_commit,
        "lastFullScanAt": manifest.last_full_scan_at,
        "prompts": [_prompt_to_dict(p) for p in manifest.prompts],
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


# Suppress unused-import warning for dataclasses (re-export as needed elsewhere).
_ = dataclasses
