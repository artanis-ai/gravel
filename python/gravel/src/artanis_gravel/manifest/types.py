"""Manifest schema types. Parity with packages/sdk-ts/src/manifest/types.ts."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

MANIFEST_VERSION = 1
MANIFEST_PATH = ".artanis/manifest.json"

PromptType = Literal["file", "embedded"]


@dataclass
class ManifestPromptFile:
    id: str
    path: str
    hash: str
    type: PromptType = "file"


@dataclass
class ManifestPromptEmbedded:
    id: str
    path: str
    hash: str
    line_start: int
    line_end: int
    char_start: int
    char_end: int
    var_name: str | None = None
    type: PromptType = "embedded"


ManifestPrompt = ManifestPromptFile | ManifestPromptEmbedded


@dataclass
class Manifest:
    version: int = MANIFEST_VERSION
    last_full_scan_commit: str | None = None
    last_full_scan_at: str | None = None
    prompts: list[ManifestPrompt] = field(default_factory=list)


def empty_manifest() -> Manifest:
    return Manifest()
