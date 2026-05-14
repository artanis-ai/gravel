"""Auto-patch for Langchain.

Unlike OpenAI / Anthropic we do NOT monkey-patch — Langchain has a first-class
callback machinery (`BaseCallbackHandler`). We register one global handler via
`langchain_core.tracers.context.register_configure_hook`, which makes it
participate in every chain / LLM / agent / tool invocation that goes through
Langchain's primitives.

If the user is *also* calling OpenAI directly (e.g. `ChatOpenAI` ultimately
calls `openai.chat.completions.create`), the OpenAI patch will fire too.
We dedupe in the future via a Langchain-injected request id (spec §2 — backlog).
"""
from __future__ import annotations

import contextvars
import logging
import os
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from . import gravel_context_singleton
from .persist import (
    ObservationRecord,
    TraceRecord,
    persist_trace,
)

log = logging.getLogger("gravel.tracing.langchain")

_PATCHED = False


def _is_disabled() -> bool:
    if os.environ.get("GRAVEL_TRACING_DISABLED") == "1":
        return True
    return gravel_context_singleton.is_tracing_disabled()


# Defer the import of BaseCallbackHandler until install() so import of this
# module never raises when Langchain isn't installed.

GravelLangchainHandler: Any = None
_handler_var: contextvars.ContextVar[Any] | None = None


def _build_handler_class() -> Any:
    from langchain_core.callbacks import BaseCallbackHandler  # type: ignore[import-not-found]

    class _GravelLangchainHandler(BaseCallbackHandler):
        """Captures one trace per LLM / chain run + state observations for
        intermediate steps. Errors flush a trace with status='errored'."""

        # Langchain calls these handlers off the request thread; we keep the
        # state per `run_id` (UUID Langchain assigns to each invocation).
        def __init__(self) -> None:
            super().__init__()
            self._runs: dict[UUID, dict[str, Any]] = {}

        # ---- LLM ----

        def on_llm_start(
            self,
            serialized: dict[str, Any],
            prompts: list[str],
            *,
            run_id: UUID,
            parent_run_id: UUID | None = None,
            **kwargs: Any,
        ) -> None:
            if _is_disabled():
                return
            # Suppress the OpenAI / Anthropic SDK patches for the inner
            # call — the LC LLM run is the canonical trace, not both.
            token = gravel_context_singleton.push_sdk_tracing_disabled()
            self._runs[run_id] = {
                "name": "langchain.llm",
                "started_at": _now(),
                "input": {"prompts": prompts, "serialized": serialized, **kwargs},
                "model": _model_from_serialized(serialized),
                "states": [],
                "_sdk_token": token,
            }

        def on_chat_model_start(
            self,
            serialized: dict[str, Any],
            messages: list[list[Any]],
            *,
            run_id: UUID,
            parent_run_id: UUID | None = None,
            **kwargs: Any,
        ) -> None:
            if _is_disabled():
                return
            token = gravel_context_singleton.push_sdk_tracing_disabled()
            self._runs[run_id] = {
                "name": "langchain.chat_model",
                "started_at": _now(),
                "input": {
                    "messages": [[_dump(m) for m in batch] for batch in messages],
                    "serialized": serialized,
                    **kwargs,
                },
                "model": _model_from_serialized(serialized),
                "states": [],
                "_sdk_token": token,
            }

        def on_llm_end(self, response: Any, *, run_id: UUID, **kwargs: Any) -> None:
            self._finish(run_id, status="ok", output=_dump(response))

        def on_llm_error(
            self,
            error: BaseException,
            *,
            run_id: UUID,
            **kwargs: Any,
        ) -> None:
            self._finish(
                run_id,
                status="errored",
                output=None,
                error={"message": str(error), "type": type(error).__name__},
            )

        # ---- Chains ----

        def on_chain_start(
            self,
            serialized: dict[str, Any],
            inputs: dict[str, Any],
            *,
            run_id: UUID,
            parent_run_id: UUID | None = None,
            **kwargs: Any,
        ) -> None:
            if _is_disabled():
                return
            self._runs[run_id] = {
                "name": "langchain.chain",
                "started_at": _now(),
                "input": {"inputs": _dump(inputs), "serialized": serialized},
                "model": None,
                "states": [],
            }

        def on_chain_end(self, outputs: dict[str, Any], *, run_id: UUID, **kwargs: Any) -> None:
            self._finish(run_id, status="ok", output=_dump(outputs))

        def on_chain_error(
            self,
            error: BaseException,
            *,
            run_id: UUID,
            **kwargs: Any,
        ) -> None:
            self._finish(
                run_id,
                status="errored",
                output=None,
                error={"message": str(error), "type": type(error).__name__},
            )

        # ---- Tools ----
        # Tool invocations get their OWN trace row (name=langchain.tool) so
        # the reviewer can find them in the Samples list and give per-tool
        # feedback. We also leave a one-line state observation on the
        # parent run so the chain's narrative includes the tool call.

        def on_tool_start(
            self,
            serialized: dict[str, Any],
            input_str: str,
            *,
            run_id: UUID,
            parent_run_id: UUID | None = None,
            **kwargs: Any,
        ) -> None:
            if _is_disabled():
                return
            tool_name = serialized.get("name") if isinstance(serialized, dict) else None
            # LC sometimes hands us a structured `inputs: dict` alongside
            # the legacy `input_str: str` (which is str(kwargs_dict) and
            # therefore a Python repr, NOT JSON). Prefer the dict when
            # present so the dashboard renders structured rows instead
            # of having to round-trip the repr.
            structured_inputs = kwargs.get("inputs") if isinstance(kwargs.get("inputs"), dict) else None
            self._runs[run_id] = {
                "name": "langchain.tool",
                "started_at": _now(),
                "input": {
                    "input": structured_inputs if structured_inputs is not None else input_str,
                    "input_str": input_str,
                    "serialized": serialized,
                    **{k: v for k, v in kwargs.items() if k != "inputs"},
                },
                "model": None,
                "states": [],
                "parent_run_id": str(parent_run_id) if parent_run_id else None,
                "tool_name": tool_name,
            }
            if parent_run_id is not None:
                parent = self._runs.get(parent_run_id)
                if parent is not None:
                    parent["states"].append(
                        ObservationRecord(
                            type="state",
                            data={"event": "tool_start", "tool": tool_name, "input": input_str},
                            key="tool",
                        )
                    )

        def on_tool_end(
            self,
            output: Any,
            *,
            run_id: UUID,
            parent_run_id: UUID | None = None,
            **kwargs: Any,
        ) -> None:
            self._finish(run_id, status="ok", output=_dump(output))
            if parent_run_id is not None:
                parent = self._runs.get(parent_run_id)
                if parent is not None:
                    parent["states"].append(
                        ObservationRecord(
                            type="state",
                            data={"event": "tool_end", "output": _dump(output)},
                            key="tool",
                        )
                    )

        def on_tool_error(
            self,
            error: BaseException,
            *,
            run_id: UUID,
            parent_run_id: UUID | None = None,
            **kwargs: Any,
        ) -> None:
            self._finish(
                run_id,
                status="errored",
                output=None,
                error={"message": str(error), "type": type(error).__name__},
            )
            if parent_run_id is not None:
                parent = self._runs.get(parent_run_id)
                if parent is not None:
                    parent["states"].append(
                        ObservationRecord(
                            type="state",
                            data={"event": "tool_error", "message": str(error)},
                            key="tool",
                        )
                    )

        # ---- Retrievers ----
        # Same shape as tools: each retrieval gets its own trace row so the
        # reviewer can see which queries returned which documents.

        def on_retriever_start(
            self,
            serialized: dict[str, Any],
            query: str,
            *,
            run_id: UUID,
            parent_run_id: UUID | None = None,
            **kwargs: Any,
        ) -> None:
            if _is_disabled():
                return
            self._runs[run_id] = {
                "name": "langchain.retriever",
                "started_at": _now(),
                "input": {"query": query, "serialized": serialized, **kwargs},
                "model": None,
                "states": [],
                "parent_run_id": str(parent_run_id) if parent_run_id else None,
            }
            if parent_run_id is not None:
                parent = self._runs.get(parent_run_id)
                if parent is not None:
                    parent["states"].append(
                        ObservationRecord(
                            type="state",
                            data={"event": "retriever_start", "query": query},
                            key="retriever",
                        )
                    )

        def on_retriever_end(
            self,
            documents: Any,
            *,
            run_id: UUID,
            parent_run_id: UUID | None = None,
            **kwargs: Any,
        ) -> None:
            dumped = _dump(documents)
            doc_count = len(dumped) if isinstance(dumped, list) else None
            self._finish(
                run_id,
                status="ok",
                output={"documents": dumped, "count": doc_count} if doc_count is not None else dumped,
            )
            if parent_run_id is not None:
                parent = self._runs.get(parent_run_id)
                if parent is not None:
                    parent["states"].append(
                        ObservationRecord(
                            type="state",
                            data={"event": "retriever_end", "count": doc_count},
                            key="retriever",
                        )
                    )

        def on_retriever_error(
            self,
            error: BaseException,
            *,
            run_id: UUID,
            parent_run_id: UUID | None = None,
            **kwargs: Any,
        ) -> None:
            self._finish(
                run_id,
                status="errored",
                output=None,
                error={"message": str(error), "type": type(error).__name__},
            )
            if parent_run_id is not None:
                parent = self._runs.get(parent_run_id)
                if parent is not None:
                    parent["states"].append(
                        ObservationRecord(
                            type="state",
                            data={"event": "retriever_error", "message": str(error)},
                            key="retriever",
                        )
                    )

        # ---- internal ----

        def _finish(
            self,
            run_id: UUID,
            *,
            status: str,
            output: Any,
            error: dict[str, Any] | None = None,
        ) -> None:
            run = self._runs.pop(run_id, None)
            if run is None:
                return
            # Restore sdk_tracing_disabled if we pushed it at start
            # (only the LLM-shaped callbacks do).
            sdk_token = run.get("_sdk_token")
            if sdk_token is not None:
                try:
                    gravel_context_singleton.pop_sdk_tracing_disabled(sdk_token)
                except Exception:  # noqa: BLE001
                    pass
            completed_at = _now()
            obs: list[ObservationRecord] = [
                ObservationRecord(type="input", data=run["input"], key="input"),
            ]
            if output is not None:
                obs.append(
                    ObservationRecord(
                        type="output",
                        data=output if isinstance(output, dict) else {"value": output},
                        key="output",
                    )
                )
            if error is not None:
                obs.append(ObservationRecord(type="error", data=error, key="error"))
            obs.extend(run["states"])

            metadata = gravel_context_singleton.get_metadata()
            if run["model"]:
                metadata = {**metadata, "model": run["model"]}

            record = TraceRecord(
                name=run["name"],
                started_at=run["started_at"],
                completed_at=completed_at,
                status=status,
                observations=obs,
                metadata=metadata,
                model=run["model"],
            )
            try:
                persist_trace(record)
            except Exception as exc:  # noqa: BLE001
                log.warning("persist_trace raised in langchain handler: %s", exc)

    return _GravelLangchainHandler


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _dump(obj: Any) -> Any:
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, list):
        return [_dump(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _dump(v) for k, v in obj.items()}
    if hasattr(obj, "model_dump"):
        try:
            return obj.model_dump()
        except Exception:  # noqa: BLE001
            pass
    if hasattr(obj, "to_dict"):
        try:
            return obj.to_dict()
        except Exception:  # noqa: BLE001
            pass
    return repr(obj)


def _model_from_serialized(serialized: dict[str, Any] | None) -> str | None:
    if not serialized:
        return None
    kwargs = serialized.get("kwargs") or {}
    for key in ("model", "model_name", "deployment_name"):
        if key in kwargs:
            return str(kwargs[key])
    return None


def install() -> bool:
    """Register our handler globally via Langchain's configure-hook API.

    Returns False if `langchain_core` isn't installed.
    """
    global _PATCHED, GravelLangchainHandler, _handler_var
    if _PATCHED:
        return True
    try:
        from langchain_core.tracers.context import register_configure_hook  # type: ignore[import-not-found]
    except ImportError:
        return False

    handler_cls = _build_handler_class()
    GravelLangchainHandler = handler_cls
    _handler_var = contextvars.ContextVar(
        "gravel_langchain_handler", default=None
    )
    # Pre-set the handler so it's always picked up by configure().
    _handler_var.set(handler_cls())
    register_configure_hook(_handler_var, True)

    _PATCHED = True
    log.debug("langchain handler registered")
    return True


def uninstall() -> None:
    """Best-effort tear-down for tests. Langchain doesn't expose an unregister
    API, so we just clear the context var; new handler instances won't be
    constructed and `_handler_var.get()` will return None."""
    global _PATCHED
    if _handler_var is not None:
        _handler_var.set(None)
    _PATCHED = False


# Don't auto-install at import — Langchain is much heavier than the patches
# above. The `auto.py` module decides whether to install based on whether the
# package is importable.
