"""Auto-patch for the `anthropic` Python SDK.

Wraps `anthropic.Anthropic().messages.create` (sync + stream).

Same approach as the OpenAI patch — patch the resource class so every client
inherits the wrapper.
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

log = logging.getLogger("gravel.tracing.anthropic")

_PATCHED = False


def _is_disabled() -> bool:
    if os.environ.get("GRAVEL_TRACING_DISABLED") == "1":
        return True
    if gravel_context_singleton.is_tracing_disabled():
        return True
    # Suppress when the Langchain handler is recording the outer
    # ChatAnthropic call — avoids double-tracing.
    return gravel_context_singleton.is_sdk_tracing_disabled()


def _safe_dump(obj: Any) -> Any:
    if obj is None or isinstance(obj, (str, int, float, bool, list, dict)):
        return obj
    if hasattr(obj, "model_dump"):
        try:
            return obj.model_dump()
        except Exception as exc:  # noqa: BLE001
            log.debug("model_dump failed; falling back to repr: %s", exc)
    if hasattr(obj, "to_dict"):
        try:
            return obj.to_dict()
        except Exception as exc:  # noqa: BLE001
            log.debug("to_dict failed; falling back to repr: %s", exc)
    return repr(obj)


def _input_snapshot(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Render kwargs to JSON-safe shapes.

    `messages` and `system` are the rich payloads we always normalise.
    For everything else (including `output_format` on `parse()`, which
    is a pydantic class) fall through `_safe_dump` so the persister
    doesn't crash on non-JSON-serialisable types — those would
    otherwise drop the trace entirely.
    """
    snapshot: dict[str, Any] = {}
    for k, v in kwargs.items():
        if k == "messages" and isinstance(v, (list, tuple)):
            snapshot[k] = [_safe_dump(m) for m in v]
        elif k == "system":
            snapshot[k] = _safe_dump(v)
        elif v is None or isinstance(v, (str, int, float, bool, list, dict, tuple)):
            snapshot[k] = v
        else:
            # Anything else (pydantic class for output_format,
            # arbitrary objects in extra_body, etc.) gets dumped
            # defensively. _safe_dump falls back to repr() on
            # unrecognised types so the trace persists.
            snapshot[k] = _safe_dump(v)
    return snapshot


class _StreamTee:
    def __init__(
        self,
        inner: Iterator[Any],
        *,
        kwargs: dict[str, Any],
        started_at: Any,
        trace_name: str = "anthropic.messages.create",
    ) -> None:
        self._inner = inner
        self._kwargs = kwargs
        self._started_at = started_at
        self._trace_name = trace_name
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
        error_data = (
            {"message": str(error), "type": type(error).__name__}
            if error is not None
            else None
        )
        record = make_record(
            name=self._trace_name,
            started_at=self._started_at,
            completed_at=completed_at,
            model=str(self._kwargs.get("model")) if self._kwargs.get("model") else None,
            status=status,
            input_data=_input_snapshot(self._kwargs),
            output_data={"chunks": self._chunks} if status == "ok" else None,
            error_data=error_data,
            metadata=gravel_context_singleton.get_metadata(),
            extra_observations=[
                ObservationRecord(type="state", data={"chunk_count": len(self._chunks)}, key="stream")
            ],
        )
        try:
            persist_trace(record)
        except Exception as exc:  # noqa: BLE001
            log.warning("persist_trace raised in stream flush: %s", exc)


def _wrap_method(original: Callable[..., Any], *, trace_name: str) -> Callable[..., Any]:
    """Build a wrapper for `Messages.<method>` that:
      - records ONE row under `trace_name`
      - suppresses fetch_patch via fetch_tracing_disabled while
        the underlying httpx call runs (no double-record)
      - handles stream=True via _StreamTee
      - records errors with the same trace_name + error metadata

    Used for `Messages.create` (`anthropic.messages.create`) and
    `Messages.parse` (`anthropic.messages.parse` — structured output;
    Claude's de_platform install caught this as missing in 2026-05-20).
    """
    @functools.wraps(original)
    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        if _is_disabled():
            return original(self, *args, **kwargs)

        started_at = now_utc()
        is_stream = bool(kwargs.get("stream"))
        try:
            # Suppress raw-fetch tracing for the underlying httpx call —
            # the SDK patch already captures a richer trace. Without
            # this each call writes two rows (SDK + fetch).
            result = gravel_context_singleton.run_with_fetch_tracing_disabled(
                lambda: original(self, *args, **kwargs)
            )
        except Exception as exc:
            completed_at = now_utc()
            record = make_record(
                name=trace_name,
                started_at=started_at,
                completed_at=completed_at,
                model=str(kwargs.get("model")) if kwargs.get("model") else None,
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
                kwargs=kwargs,
                started_at=started_at,
                trace_name=trace_name,
            )

        completed_at = now_utc()
        dumped = _safe_dump(result)
        record = make_record(
            name=trace_name,
            started_at=started_at,
            completed_at=completed_at,
            model=str(kwargs.get("model")) if kwargs.get("model") else (
                dumped.get("model") if isinstance(dumped, dict) else None
            ),
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


# Backwards-compat alias: tests may still import the v0.8.x name.
_wrap_create = _wrap_method


def install() -> bool:
    global _PATCHED
    if _PATCHED:
        return True
    try:
        from anthropic.resources.messages import (  # type: ignore[import-not-found]
            Messages,
        )
    except ImportError:
        return False

    # Wrap .create (the canonical message API).
    if not getattr(Messages.create, "__gravel_patched__", False):
        Messages.create = _wrap_method(  # type: ignore[method-assign]
            Messages.create, trace_name="anthropic.messages.create"
        )
    # Wrap .parse (structured output; added in v0.9.1 — Claude's
    # de_platform dogfooding caught .parse() going unpatched and
    # only landing as a generic fetch:anthropic.messages row with no
    # model / input richness).
    if hasattr(Messages, "parse") and not getattr(Messages.parse, "__gravel_patched__", False):
        Messages.parse = _wrap_method(  # type: ignore[method-assign]
            Messages.parse, trace_name="anthropic.messages.parse"
        )

    _PATCHED = True
    log.debug("anthropic patch installed (create + parse)")
    return True


def uninstall() -> None:
    global _PATCHED
    try:
        from anthropic.resources.messages import (  # type: ignore[import-not-found]
            Messages,
        )
    except ImportError:
        _PATCHED = False
        return

    for method_name in ("create", "parse"):
        method = getattr(Messages, method_name, None)
        if method is None:
            continue
        wrapped = getattr(method, "__wrapped__", None)
        if wrapped is not None:
            setattr(Messages, method_name, wrapped)  # type: ignore[method-assign]
    _PATCHED = False


install()
