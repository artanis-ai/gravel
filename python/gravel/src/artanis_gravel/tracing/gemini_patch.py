"""Auto-patch for the `google-genai` Python SDK (Gemini).

Wraps:
  - `genai.Client().models.generate_content`
  - `genai.Client().models.generate_content_stream`

Strategy: we monkey-patch the *classes* (`google.genai.models.Models.generate_content`,
`google.genai.models.Models.generate_content_stream`) rather than every instance. That
way the patch fires for every client the user constructs, including ones built
before/after `import artanis_gravel.auto` — same pattern as `openai_patch.py`.

Streaming: `generate_content_stream` returns an iterator of `GenerateContentResponse`
chunks. We tee the iterator: the user's loop is unaffected (gets the same chunks in
the same order); we accumulate a parallel buffer and persist at stream close.

Async note: the SDK also exposes `client.aio.models.generate_content(...)` on a
separate `AsyncModels` class. The sync patch only covers `Models`; async tracing is
on the roadmap and will land symmetrically across openai_patch / anthropic_patch /
gemini_patch when it does.
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

log = logging.getLogger("gravel.tracing.gemini")

_PATCHED = False


def _is_disabled() -> bool:
    """Honour env-level kill switch + per-context disable + the
    Langchain handler's `sdk_tracing_disabled` flag (so LC's inner
    ChatGoogleGenerativeAI → google.genai doesn't double-trace)."""
    if os.environ.get("GRAVEL_TRACING_DISABLED") == "1":
        return True
    if gravel_context_singleton.is_tracing_disabled():
        return True
    return gravel_context_singleton.is_sdk_tracing_disabled()


# ---------- response shape extraction ----------


def _safe_dump(obj: Any) -> Any:
    """Best-effort serialise a google-genai pydantic response object."""
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
    if "contents" in snapshot:
        snapshot["contents"] = _safe_dump(snapshot["contents"])
    if "config" in snapshot:
        snapshot["config"] = _safe_dump(snapshot["config"])
    return snapshot


def _model_of(kwargs: dict[str, Any], result: Any | None) -> str | None:
    if "model" in kwargs:
        return str(kwargs["model"])
    if result is not None:
        for attr in ("model_version", "model"):
            v = getattr(result, attr, None)
            if v:
                return str(v)
    return None


# ---------- streaming wrapper ----------


class _StreamTee:
    """Wraps the iterator returned by `generate_content_stream`. Forwards every
    chunk to the caller and accumulates a parallel buffer for persistence at
    stream close."""

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


def _wrap_call(
    original: Callable[..., Any],
    *,
    trace_name: str,
    streaming: bool,
) -> Callable[..., Any]:
    """Build the patched callable. Captures input/output and persists
    after the call completes (or after the stream is exhausted)."""

    @functools.wraps(original)
    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        if _is_disabled():
            return original(self, *args, **kwargs)

        started_at = now_utc()

        try:
            # Suppress the raw-fetch patch for the duration of the
            # underlying SDK call: google-genai routes through httpx,
            # which fetch_patch wraps, but the SDK patch already
            # captures a richer trace.
            result = gravel_context_singleton.run_with_fetch_tracing_disabled(
                lambda: original(self, *args, **kwargs)
            )
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

        if streaming:
            return _StreamTee(
                iter(result),
                name=trace_name,
                kwargs=kwargs,
                started_at=started_at,
            )

        completed_at = now_utc()
        dumped = _safe_dump(result)
        record = make_record(
            name=trace_name,
            started_at=started_at,
            completed_at=completed_at,
            model=_model_of(kwargs, result),
            status="ok",
            input_data=_input_snapshot(kwargs),
            output_data=dumped if isinstance(dumped, dict) else {"value": dumped},
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
    """Patch the google-genai SDK in place. Returns True on success, False if
    the SDK isn't installed (caller should silently skip)."""
    global _PATCHED
    if _PATCHED:
        return True
    try:
        from google.genai.models import Models  # type: ignore[import-not-found]
    except ImportError:
        return False
    except Exception as exc:  # noqa: BLE001 — defensive: SDK still in flux upstream
        log.debug("google.genai.models import raised %r; skipping Gemini patch", exc)
        return False

    if not getattr(Models.generate_content, "__gravel_patched__", False):
        Models.generate_content = _wrap_call(  # type: ignore[method-assign]
            Models.generate_content,
            trace_name="gemini.models.generate_content",
            streaming=False,
        )
    if hasattr(Models, "generate_content_stream") and not getattr(
        Models.generate_content_stream, "__gravel_patched__", False
    ):
        Models.generate_content_stream = _wrap_call(  # type: ignore[method-assign]
            Models.generate_content_stream,
            trace_name="gemini.models.generate_content_stream",
            streaming=True,
        )

    _PATCHED = True
    log.debug("gemini patch installed")
    return True


def uninstall() -> None:
    """Best-effort restore — primarily for tests. Reaches the original via
    `__wrapped__` (set by functools.wraps)."""
    global _PATCHED
    try:
        from google.genai.models import Models  # type: ignore[import-not-found]
    except ImportError:
        _PATCHED = False
        return

    for attr in ("generate_content", "generate_content_stream"):
        method = getattr(Models, attr, None)
        if method is None:
            continue
        wrapped = getattr(method, "__wrapped__", None)
        if wrapped is not None:
            setattr(Models, attr, wrapped)

    _PATCHED = False


# Auto-install on import (the auto.py module imports this module after env check).
install()
