"""Tracing public API — async-context propagation + per-call disable.

Mirrors `packages/sdk-ts/src/tracing/context.ts` (TS uses `AsyncLocalStorage`,
Python uses `contextvars`).

"""
from __future__ import annotations

import contextvars
import logging
import os
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable, Iterator, TypeVar

from .persist import TracingRuntimeConfig, set_gravel_tracing_config

_log = logging.getLogger("gravel.tracing.bootstrap")


def install_auto_tracing(engine: Any) -> bool:
    """One-shot bootstrap called by the framework adapters
    (`fastapi.create_gravel_router`, `asgi._build_context`,
    `django._build_proto_context`) right after they open the engine.

    Installs the openai / anthropic / langchain / fetch patches and
    points the persister at the same engine the dashboard reads from.
    Before this helper landed (pre-v0.5.22) every Python host that ran
    the wizard's traces pillar had the tables created but neither half
    of the runtime wired up — silent zero-trace failure.

    The provider patches are invoked through their explicit entrypoints
    (not `import artanis_gravel.auto`) so this function stays idempotent
    across test resets: a bare `import` is a no-op the second time and
    won't re-install patches that a test seam unwound.

    Skips silently when:
      - `engine` is None (prompts-only install, no DATABASE_URL)
      - `GRAVEL_TRACING_DISABLED=1` is set in the environment

    Returns True iff auto-tracing was actually installed, so callers
    can decide whether to emit a startup log line.
    """
    if engine is None:
        return False
    if os.environ.get("GRAVEL_TRACING_DISABLED") == "1":
        _log.info("auto-tracing skipped: GRAVEL_TRACING_DISABLED=1")
        return False
    try:
        from . import openai_patch  # noqa: F401 — module-level patch
    except ImportError:
        pass
    try:
        from . import anthropic_patch  # noqa: F401 — module-level patch
    except ImportError:
        pass
    try:
        from . import langchain_patch
        langchain_patch.install()
    except ImportError:
        pass
    from . import fetch_patch
    fetch_patch.patch_all()
    set_gravel_tracing_config(TracingRuntimeConfig(engine=engine))
    return True

T = TypeVar("T")


@dataclass
class _ContextState:
    metadata: dict[str, Any] = field(default_factory=dict)
    tracing_disabled: bool = False


_state: contextvars.ContextVar[_ContextState] = contextvars.ContextVar(
    "gravel_tracing_state",
    default=_ContextState(),
)


def _current_state() -> _ContextState:
    return _state.get()


class _GravelContext:
    """Singleton mirror of the TS `gravelContext` object.

    Exposes `get_metadata()` / `is_tracing_disabled()` for the auto-patches and
    `run(metadata, fn)` for synchronous nested execution. Async users should
    prefer `with_gravel_metadata` / `with_tracing_disabled` context managers
    (or, for a one-shot async helper, `awith_gravel_metadata`).
    """

    def get_metadata(self) -> dict[str, Any]:
        return dict(_current_state().metadata)

    def is_tracing_disabled(self) -> bool:
        return _current_state().tracing_disabled

    def run(self, metadata: dict[str, Any], fn: Callable[[], T]) -> T:
        prev = _current_state()
        new = _ContextState(
            metadata={**prev.metadata, **metadata},
            tracing_disabled=prev.tracing_disabled,
        )
        token = _state.set(new)
        try:
            return fn()
        finally:
            _state.reset(token)


gravel_context_singleton = _GravelContext()


@contextmanager
def gravel_context(metadata: dict[str, Any] | None = None) -> Iterator[_GravelContext]:
    """Sync/async-safe context manager exposing the current trace metadata.

    Usage::

        with gravel_context({"user_id": "u_123"}):
            client.chat.completions.create(...)
    """
    prev = _current_state()
    merged = {**prev.metadata, **(metadata or {})}
    token = _state.set(
        _ContextState(metadata=merged, tracing_disabled=prev.tracing_disabled)
    )
    try:
        yield gravel_context_singleton
    finally:
        _state.reset(token)


@contextmanager
def with_gravel_metadata(metadata: dict[str, Any]) -> Iterator[None]:
    """Context manager form: tag every trace inside the block with `metadata`."""
    prev = _current_state()
    token = _state.set(
        _ContextState(
            metadata={**prev.metadata, **metadata},
            tracing_disabled=prev.tracing_disabled,
        )
    )
    try:
        yield
    finally:
        _state.reset(token)


def with_gravel_metadata_call(
    metadata: dict[str, Any],
    fn: Callable[[], T],
) -> T:
    """Functional form mirroring the TS `withGravelMetadata(metadata, fn)`."""
    with with_gravel_metadata(metadata):
        return fn()


async def awith_gravel_metadata(
    metadata: dict[str, Any],
    fn: Callable[[], Awaitable[T] | T],
) -> T:
    """Async functional form. Awaits `fn()` if it returns an awaitable."""
    with with_gravel_metadata(metadata):
        result = fn()
        if hasattr(result, "__await__"):
            return await result  # type: ignore[no-any-return]
        return result  # type: ignore[return-value]


@contextmanager
def with_tracing_disabled() -> Iterator[None]:
    """Disable tracing for the duration of the block.

    Spec: tracing.md §9 — for sensitive flows or recursive eval pipelines.
    """
    prev = _current_state()
    token = _state.set(
        _ContextState(metadata=dict(prev.metadata), tracing_disabled=True)
    )
    try:
        yield
    finally:
        _state.reset(token)


@asynccontextmanager
async def awith_tracing_disabled() -> AsyncIterator[None]:
    """Async-flavoured `with_tracing_disabled` for `async with` callers."""
    with with_tracing_disabled():
        yield


__all__ = [
    "gravel_context",
    "gravel_context_singleton",
    "with_gravel_metadata",
    "with_gravel_metadata_call",
    "awith_gravel_metadata",
    "with_tracing_disabled",
    "awith_tracing_disabled",
    "set_gravel_tracing_config",
    "install_auto_tracing",
]
