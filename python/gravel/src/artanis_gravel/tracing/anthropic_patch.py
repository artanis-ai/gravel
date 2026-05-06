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
    return gravel_context_singleton.is_tracing_disabled()


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
    snapshot = dict(kwargs)
    if "messages" in snapshot:
        snapshot["messages"] = [_safe_dump(m) for m in snapshot["messages"]]
    if "system" in snapshot:
        snapshot["system"] = _safe_dump(snapshot["system"])
    return snapshot


class _StreamTee:
    def __init__(
        self,
        inner: Iterator[Any],
        *,
        kwargs: dict[str, Any],
        started_at: Any,
    ) -> None:
        self._inner = inner
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
        error_data = (
            {"message": str(error), "type": type(error).__name__}
            if error is not None
            else None
        )
        record = make_record(
            name="anthropic.messages.create",
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


def _wrap_create(original: Callable[..., Any]) -> Callable[..., Any]:
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
                name="anthropic.messages.create",
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
            return _StreamTee(iter(result), kwargs=kwargs, started_at=started_at)

        completed_at = now_utc()
        dumped = _safe_dump(result)
        record = make_record(
            name="anthropic.messages.create",
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

    if not getattr(Messages.create, "__gravel_patched__", False):
        Messages.create = _wrap_create(Messages.create)  # type: ignore[method-assign]

    _PATCHED = True
    log.debug("anthropic patch installed")
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

    wrapped = getattr(Messages.create, "__wrapped__", None)
    if wrapped is not None:
        Messages.create = wrapped  # type: ignore[method-assign]
    _PATCHED = False


install()
