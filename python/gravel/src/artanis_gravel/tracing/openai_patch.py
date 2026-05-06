"""Auto-patch for the `openai` Python SDK.

Wraps:
  - `openai.OpenAI().chat.completions.create`
  - `openai.OpenAI().responses.create`
  - `openai.OpenAI().embeddings.create`

Strategy: we monkey-patch the *classes* (e.g. `openai.resources.chat.completions.Completions.create`)
rather than every instance. That way the patch fires for every client the user
constructs, including ones built before/after `import artanis_gravel.auto`.

Streaming: we tee the iterator. The user's loop is unaffected (gets the same
chunks in the same order); we accumulate a parallel buffer and persist at
stream close. Errors during streaming flush an `errored` trace and re-raise.
"""
from __future__ import annotations

import functools
import logging
import os
from typing import Any, Callable, Iterator

from . import gravel_context_singleton
from .persist import (
    ObservationRecord,
    make_record,
    now_utc,
    persist_trace,
)

log = logging.getLogger("gravel.tracing.openai")

_PATCHED = False


def _is_disabled() -> bool:
    """Honour env-level kill switch + per-context disable."""
    if os.environ.get("GRAVEL_TRACING_DISABLED") == "1":
        return True
    return gravel_context_singleton.is_tracing_disabled()


# ---------- response shape extraction ----------


def _safe_dump(obj: Any) -> Any:
    """Best-effort serialise an OpenAI pydantic response or dict."""
    if obj is None or isinstance(obj, (str, int, float, bool, list, dict)):
        return obj
    if hasattr(obj, "model_dump"):
        try:
            return obj.model_dump()
        except Exception as exc:  # noqa: BLE001 — pydantic edge cases shouldn't kill tracing
            log.debug("model_dump failed; falling back to repr: %s", exc)
    if hasattr(obj, "to_dict"):
        try:
            return obj.to_dict()
        except Exception as exc:  # noqa: BLE001
            log.debug("to_dict failed; falling back to repr: %s", exc)
    return repr(obj)


def _input_snapshot(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Capture the request payload without mutating the user's dict."""
    snapshot = dict(kwargs)
    # Defensive deep-ish copy of messages to avoid pydantic-model identity bleed.
    if "messages" in snapshot:
        snapshot["messages"] = [_safe_dump(m) for m in snapshot["messages"]]
    if "input" in snapshot:
        snapshot["input"] = _safe_dump(snapshot["input"])
    return snapshot


def _model_of(kwargs: dict[str, Any], result: Any | None) -> str | None:
    if "model" in kwargs:
        return str(kwargs["model"])
    if result is not None:
        for attr in ("model",):
            v = getattr(result, attr, None)
            if v:
                return str(v)
    return None


# ---------- streaming wrapper ----------


class _StreamTee:
    """Wraps an OpenAI streaming iterator. Forwards every chunk to the caller
    and accumulates a parallel buffer for persistence at stream close."""

    def __init__(
        self,
        inner: Iterator[Any],
        *,
        name: str,
        kwargs: dict[str, Any],
        started_at: Any,
    ) -> None:
        self._inner = inner
        self._name = name
        self._kwargs = kwargs
        self._started_at = started_at
        self._chunks: list[Any] = []
        self._closed = False

    def __iter__(self) -> "_StreamTee":
        return self

    def __next__(self) -> Any:
        try:
            chunk = next(self._inner)
        except StopIteration:
            self._flush(status="ok", error=None)
            raise
        except Exception as exc:
            self._flush(status="errored", error=exc)
            raise
        self._chunks.append(_safe_dump(chunk))
        return chunk

    # passthrough for context-manager-style usage
    def __enter__(self) -> "_StreamTee":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc is not None:
            self._flush(status="errored", error=exc)
        else:
            self._flush(status="ok", error=None)
        close = getattr(self._inner, "__exit__", None)
        if callable(close):
            close(exc_type, exc, tb)

    def close(self) -> None:
        close = getattr(self._inner, "close", None)
        if callable(close):
            close()

    def _flush(self, *, status: str, error: BaseException | None) -> None:
        if self._closed:
            return
        self._closed = True
        completed_at = now_utc()
        output = {"chunks": self._chunks}
        error_data = (
            {"message": str(error), "type": type(error).__name__}
            if error is not None
            else None
        )
        record = make_record(
            name=self._name,
            started_at=self._started_at,
            completed_at=completed_at,
            model=_model_of(self._kwargs, None),
            status=status,
            input_data=_input_snapshot(self._kwargs),
            output_data=output if status == "ok" else None,
            error_data=error_data,
            metadata=gravel_context_singleton.get_metadata(),
            extra_observations=[
                ObservationRecord(type="state", data={"chunk_count": len(self._chunks)}, key="stream")
            ],
        )
        try:
            persist_trace(record)
        except Exception as exc:  # noqa: BLE001 — never re-raise from tracing
            log.warning("persist_trace raised in stream flush: %s", exc)


# ---------- generic wrap ----------


def _wrap_create(
    original: Callable[..., Any],
    *,
    trace_name: str,
) -> Callable[..., Any]:
    """Build the patched `create` callable. Captures input/output and persists
    after the call completes (or after the stream is exhausted)."""

    @functools.wraps(original)
    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        if _is_disabled():
            return original(self, *args, **kwargs)

        started_at = now_utc()
        is_stream = bool(kwargs.get("stream"))

        try:
            result = original(self, *args, **kwargs)
        except Exception as exc:
            completed_at = now_utc()
            record = make_record(
                name=trace_name,
                started_at=started_at,
                completed_at=completed_at,
                model=_model_of(kwargs, None),
                status="errored",
                input_data=_input_snapshot(kwargs),
                error_data={"message": str(exc), "type": type(exc).__name__},
                metadata=gravel_context_singleton.get_metadata(),
            )
            try:
                persist_trace(record)
            except Exception as persist_exc:  # noqa: BLE001
                log.warning("persist_trace raised on error path: %s", persist_exc)
            raise

        if is_stream:
            return _StreamTee(
                iter(result),
                name=trace_name,
                kwargs=kwargs,
                started_at=started_at,
            )

        completed_at = now_utc()
        record = make_record(
            name=trace_name,
            started_at=started_at,
            completed_at=completed_at,
            model=_model_of(kwargs, result),
            status="ok",
            input_data=_input_snapshot(kwargs),
            output_data=_safe_dump(result) if isinstance(_safe_dump(result), dict) else {"value": _safe_dump(result)},
            metadata=gravel_context_singleton.get_metadata(),
        )
        try:
            persist_trace(record)
        except Exception as exc:  # noqa: BLE001
            log.warning("persist_trace raised on success path: %s", exc)
        return result

    wrapper.__gravel_patched__ = True  # type: ignore[attr-defined]
    return wrapper


# ---------- install ----------


def install() -> bool:
    """Patch the openai SDK in place. Returns True on success, False if the
    SDK isn't installed (caller should silently skip)."""
    global _PATCHED
    if _PATCHED:
        return True
    try:
        from openai.resources.chat.completions import (  # type: ignore[import-not-found]
            Completions as ChatCompletions,
        )
        from openai.resources.embeddings import (  # type: ignore[import-not-found]
            Embeddings,
        )
    except ImportError:
        return False

    # Responses API (added in openai>=1.40); optional.
    Responses = None
    try:
        from openai.resources.responses import (  # type: ignore[import-not-found]
            Responses as _Responses,
        )

        Responses = _Responses
    except ImportError:
        log.debug("openai.resources.responses not available; skipping that patch")

    if not getattr(ChatCompletions.create, "__gravel_patched__", False):
        ChatCompletions.create = _wrap_create(  # type: ignore[method-assign]
            ChatCompletions.create,
            trace_name="openai.chat.completions.create",
        )
    if not getattr(Embeddings.create, "__gravel_patched__", False):
        Embeddings.create = _wrap_create(  # type: ignore[method-assign]
            Embeddings.create,
            trace_name="openai.embeddings.create",
        )
    if Responses is not None and not getattr(Responses.create, "__gravel_patched__", False):
        Responses.create = _wrap_create(  # type: ignore[method-assign]
            Responses.create,
            trace_name="openai.responses.create",
        )

    _PATCHED = True
    log.debug("openai patch installed")
    return True


def uninstall() -> None:
    """Best-effort restore — primarily for tests. Reaches the original via
    `__wrapped__` (set by functools.wraps)."""
    global _PATCHED
    try:
        from openai.resources.chat.completions import (  # type: ignore[import-not-found]
            Completions as ChatCompletions,
        )
        from openai.resources.embeddings import (  # type: ignore[import-not-found]
            Embeddings,
        )
    except ImportError:
        _PATCHED = False
        return

    for klass in (ChatCompletions, Embeddings):
        wrapped = getattr(klass.create, "__wrapped__", None)
        if wrapped is not None:
            klass.create = wrapped  # type: ignore[method-assign]

    try:
        from openai.resources.responses import (  # type: ignore[import-not-found]
            Responses,
        )

        wrapped = getattr(Responses.create, "__wrapped__", None)
        if wrapped is not None:
            Responses.create = wrapped  # type: ignore[method-assign]
    except ImportError:
        pass

    _PATCHED = False


# Auto-install on import (the auto.py module imports this module after env check).
install()
