"""Import-side-effect tracing entry point. Parity with src/auto.ts.

BLOCKER: provider patches not implemented. v0 only emits a notice.
"""
from __future__ import annotations

import importlib.util
import os

DISABLED = os.environ.get("GRAVEL_TRACING_DISABLED") == "1"


def _detect() -> list[str]:
    detected: list[str] = []
    for mod in ("openai", "anthropic", "langchain", "vercel_ai"):
        if importlib.util.find_spec(mod) is not None:
            detected.append(mod)
    return detected


if DISABLED:
    print("[gravel] tracing disabled via GRAVEL_TRACING_DISABLED=1")
else:
    detected = _detect()
    if detected:
        print(
            f"[gravel] tracing scaffolding active for: {', '.join(detected)} "
            "(BLOCKER: provider patches not yet implemented — see github.com/artanis-ai/gravel)"
        )
