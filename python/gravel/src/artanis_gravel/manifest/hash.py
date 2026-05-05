"""Prompt content hash normalization.

Identical algorithm to packages/sdk-ts/src/manifest/hash.ts. CI verifies
output equivalence.
"""
from __future__ import annotations

import hashlib
import re
import secrets


def normalize(text: str) -> str:
    # 1. Convert line endings to \n.
    out = text.replace("\r\n", "\n").replace("\r", "\n")
    # 2. Strip trailing whitespace on each line.
    out = "\n".join(re.sub(r"[ \t]+$", "", line) for line in out.split("\n"))
    # 3. Strip leading + trailing blank lines.
    out = re.sub(r"^(\s*\n)+", "", out)
    out = re.sub(r"(\n\s*)+$", "", out)
    return out


def hash_prompt(text: str) -> str:
    return "sha256:" + hashlib.sha256(normalize(text).encode("utf-8")).hexdigest()


def generate_prompt_id(path: str, char_start: int | None = None) -> str:
    seed = f"{path}:{char_start if char_start is not None else 'file'}:{secrets.token_hex(8)}"
    return "p_" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:12]
