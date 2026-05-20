"""Auto-patch for the `anthropic` Python SDK.

Wraps `anthropic.Anthropic().messages.create` (sync + stream=True),
`.parse` (structured output, added in v0.9.1), and `.stream` (the
context-manager helper, added in v0.9.2).

Same approach as the OpenAI patch: patch the resource class so every
client inherits the wrapper. The `.stream` helper also needs class-
level patches on `MessageStreamManager.__enter__` and
`MessageStream.__exit__` because the user-visible API is a context
manager: we capture (started_at, model, input) on the `.stream()`
call, hand the capture off through `__enter__`, and record the row
on `__exit__` once the stream has fully iterated (using
`MessageStream.get_final_message()` to grab the consolidated output).
Cross-stack parity with the TS `wrapMessagesStream` helper.
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


def _wrap_stream(original: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap `Messages.stream` so the returned `MessageStreamManager`
    carries enough state for `MessageStream.__exit__` to record a row
    once the user finishes iterating.

    `MessageStream` is what the user actually interacts with inside
    `with client.messages.stream(...) as stream:`; the manager is just
    the context-manager shim. The class-level patches in
    `_patch_message_stream_for_tracing()` propagate the capture state
    across the enter / exit boundary.
    """
    @functools.wraps(original)
    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        if _is_disabled():
            return original(self, *args, **kwargs)

        started_at = now_utc()
        manager = gravel_context_singleton.run_with_fetch_tracing_disabled(
            lambda: original(self, *args, **kwargs)
        )
        # Stash the capture on the manager instance. Plain attribute
        # assignment works fine on the SDK's manager class. The
        # __enter__ patch propagates this onto the MessageStream.
        try:
            setattr(manager, "_gravel_capture", {
                "started_at": started_at,
                "model": str(kwargs.get("model")) if kwargs.get("model") else None,
                "input": _input_snapshot(kwargs),
            })
        except Exception as exc:  # noqa: BLE001
            log.debug("failed to attach _gravel_capture to manager: %s", exc)
        return manager

    wrapper.__gravel_patched__ = True  # type: ignore[attr-defined]
    return wrapper


def _patch_message_stream_for_tracing() -> bool:
    """Idempotent class-level patches on `MessageStreamManager` so the
    captured (started_at, model, input) attached by `_wrap_stream`
    rides through the user's `with` block and gets recorded with the
    consolidated final message on exit.

    Why the manager (and not `MessageStream`)? The user's `with
    client.messages.stream(...) as stream:` invokes
    `MessageStreamManager.__enter__` / `__exit__`, not the inner
    `MessageStream.__exit__`. SDK source: manager's `__exit__` calls
    `self.__stream.close()`, NOT `self.__stream.__exit__()`. We need
    `__enter__` to stash the inner stream reference (so `__exit__` can
    fetch `get_final_message()`) and `__exit__` to write the row.

    Returns True when patches landed (or were already patched). Returns
    False if the streaming classes can't be imported (SDK missing or
    too old).
    """
    try:
        from anthropic.lib.streaming import MessageStreamManager  # type: ignore[import-not-found]
    except ImportError:
        return False

    if getattr(MessageStreamManager.__enter__, "__gravel_patched__", False):
        return True

    original_manager_enter = MessageStreamManager.__enter__
    original_manager_exit = MessageStreamManager.__exit__

    @functools.wraps(original_manager_enter)
    def patched_manager_enter(self: Any) -> Any:
        # Suppress fetch-level tracing for the entire stream
        # lifecycle (the HTTP request fires inside the SDK's __enter__
        # / first iteration, AFTER _wrap_stream has already returned).
        # Stash the token + a reference to the inner stream on the
        # manager so __exit__ can both pop the suppression and call
        # `inner.get_final_message()` to record the consolidated row.
        if getattr(self, "_gravel_capture", None) is not None:
            try:
                token = gravel_context_singleton.push_fetch_tracing_disabled()
                setattr(self, "_gravel_fetch_token", token)
            except Exception as exc:  # noqa: BLE001
                log.debug("failed to push fetch_tracing_disabled: %s", exc)
        stream = original_manager_enter(self)
        try:
            setattr(self, "_gravel_inner_stream", stream)
        except Exception as exc:  # noqa: BLE001
            log.debug("failed to attach _gravel_inner_stream: %s", exc)
        return stream

    patched_manager_enter.__gravel_patched__ = True  # type: ignore[attr-defined]
    MessageStreamManager.__enter__ = patched_manager_enter  # type: ignore[method-assign]

    @functools.wraps(original_manager_exit)
    def patched_manager_exit(self: Any, exc_type: Any, exc_val: Any, exc_tb: Any) -> Any:
        capture = getattr(self, "_gravel_capture", None)
        inner = getattr(self, "_gravel_inner_stream", None)
        fetch_token = getattr(self, "_gravel_fetch_token", None)
        try:
            return original_manager_exit(self, exc_type, exc_val, exc_tb)
        finally:
            # Pop fetch_tracing_disabled BEFORE recording our own row
            # so the record itself doesn't see a stale context. The
            # record's persistence runs through a separate async
            # persister anyway.
            if fetch_token is not None:
                try:
                    gravel_context_singleton.pop_fetch_tracing_disabled(fetch_token)
                except Exception as exc:  # noqa: BLE001
                    log.debug("failed to pop fetch_tracing_disabled: %s", exc)
            if capture is not None:
                completed_at = now_utc()
                output_data: Any = None
                if exc_type is None and inner is not None:
                    try:
                        final_msg = inner.get_final_message()
                        dumped = _safe_dump(final_msg)
                        output_data = dumped if isinstance(dumped, dict) else (
                            {"value": dumped} if dumped is not None else None
                        )
                    except Exception as exc:  # noqa: BLE001
                        log.debug("get_final_message failed: %s", exc)
                record = make_record(
                    name="anthropic.messages.stream",
                    started_at=capture["started_at"],
                    completed_at=completed_at,
                    model=capture.get("model"),
                    status="errored" if exc_type is not None else "ok",
                    input_data=capture.get("input"),
                    output_data=output_data,
                    error_data=(
                        {"message": str(exc_val), "type": exc_type.__name__}
                        if exc_type is not None
                        else None
                    ),
                    metadata=gravel_context_singleton.get_metadata(),
                )
                try:
                    persist_trace(record)
                except Exception as persist_exc:  # noqa: BLE001
                    log.warning("persist_trace raised on stream exit: %s", persist_exc)
                # Defuse so a manager re-used in a second `with` block
                # (unusual but possible) doesn't double-record. The
                # SDK creates a fresh manager per stream() call so this
                # is belt-and-braces.
                for attr in ("_gravel_capture", "_gravel_inner_stream", "_gravel_fetch_token"):
                    try:
                        delattr(self, attr)
                    except AttributeError:
                        pass

    patched_manager_exit.__gravel_patched__ = True  # type: ignore[attr-defined]
    MessageStreamManager.__exit__ = patched_manager_exit  # type: ignore[method-assign]
    return True


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
    # Wrap .parse (structured output; added in v0.9.1, Claude's
    # de_platform dogfooding caught .parse() going unpatched and
    # only landing as a generic fetch:anthropic.messages row with no
    # model / input richness).
    if hasattr(Messages, "parse") and not getattr(Messages.parse, "__gravel_patched__", False):
        Messages.parse = _wrap_method(  # type: ignore[method-assign]
            Messages.parse, trace_name="anthropic.messages.parse"
        )
    # Wrap .stream (context-manager streaming helper; added in v0.9.2
    # for cross-stack parity with the TS wrapMessagesStream patch).
    # Also installs the class-level MessageStreamManager.__enter__ +
    # MessageStream.__exit__ patches so the row records on stream exit
    # with the consolidated final message.
    if hasattr(Messages, "stream") and not getattr(Messages.stream, "__gravel_patched__", False):
        Messages.stream = _wrap_stream(Messages.stream)  # type: ignore[method-assign]
    _patch_message_stream_for_tracing()

    _PATCHED = True
    log.debug("anthropic patch installed (create + parse + stream)")
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

    for method_name in ("create", "parse", "stream"):
        method = getattr(Messages, method_name, None)
        if method is None:
            continue
        wrapped = getattr(method, "__wrapped__", None)
        if wrapped is not None:
            setattr(Messages, method_name, wrapped)  # type: ignore[method-assign]
    _PATCHED = False


install()
