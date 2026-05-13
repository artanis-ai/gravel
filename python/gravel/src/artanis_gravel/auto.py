"""Import-side-effect tracing entry point. Parity with `src/auto.ts`.

Usage::

    # top of app entry
    import artanis_gravel.auto  # noqa: F401

For each supported provider that's actually installed, we install the patch
and skip silently if the SDK isn't present. The `GRAVEL_TRACING_DISABLED=1`
env var short-circuits everything before any patching happens.

The persister still needs a runtime config (engine + environment id) before
traces will actually flush. Call
`artanis_gravel.tracing.set_gravel_tracing_config(...)` from your app once the
DB is open. Until then, patches fire and discard captured records (warning
logged on first miss).
"""
from __future__ import annotations

import logging
import os

log = logging.getLogger("gravel.tracing.auto")

DISABLED = os.environ.get("GRAVEL_TRACING_DISABLED") == "1"


def _install_openai() -> bool:
    try:
        from .tracing import openai_patch  # noqa: F401 — import installs the patch
    except ImportError:
        return False
    return True


def _install_anthropic() -> bool:
    try:
        from .tracing import anthropic_patch  # noqa: F401
    except ImportError:
        return False
    return True


def _install_langchain() -> bool:
    # Langchain patch deliberately does NOT auto-install at import — it's a
    # heavier callback registration that we only want to perform when
    # langchain_core is genuinely importable.
    try:
        from .tracing import langchain_patch
    except ImportError:
        return False
    return langchain_patch.install()


def _install_fetch() -> bool:
    """Patch raw HTTP transports (httpx, requests, aiohttp, urllib).

    Each individual library is patched only when importable, so a host
    with just `requests` doesn't pay any cost for `aiohttp`. Catches
    customers who POST to OpenAI / Anthropic directly without going
    through their official SDKs."""
    from .tracing import fetch_patch

    fetch_patch.patch_all()
    return True


def _run() -> None:
    if DISABLED:
        log.info("[gravel] tracing disabled via GRAVEL_TRACING_DISABLED=1")
        return

    installed: list[str] = []
    if _install_openai():
        installed.append("openai")
    if _install_anthropic():
        installed.append("anthropic")
    if _install_langchain():
        installed.append("langchain")
    if _install_fetch():
        installed.append("fetch")

    if installed:
        log.info("[gravel] tracing patched for: %s", ", ".join(installed))
    else:
        log.debug("[gravel] no supported provider SDKs detected; tracing inactive")


_run()
