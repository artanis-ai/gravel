"""Bounded-concurrency eval runner.

Each row is judged via :func:`artanis_gravel.judge.judge_call`. For ``type='live'``
the row's ``output`` is produced by awaiting ``run_pipeline(input)`` first.

Per-row exceptions are captured on the :class:`Result`; the run completes the
remaining rows. The aggregate :class:`RunResult` reports counts.
"""
from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

import httpx

from ..judge import JudgeError, JudgeResponse, judge_call

EvalType = Literal["trace", "live"]


@dataclass
class Row:
    id: str
    input: Any
    output: Any = None
    expected_correction: str | None = None
    prompt_context: str | None = None


@dataclass
class Result:
    row_id: str
    response: JudgeResponse | None = None
    error: str | None = None
    error_status: int | None = None


@dataclass
class RunResult:
    run_id: str
    type: EvalType
    results: list[Result] = field(default_factory=list)
    succeeded: int = 0
    failed: int = 0


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def run_eval(
    *,
    run_id: str,
    type: EvalType,  # noqa: A002 — public API mirrors the server's snake_case schema
    rows: list[Row],
    criteria: list[str],
    run_pipeline: Callable[[Any], Awaitable[Any]] | Callable[[Any], Any] | None = None,
    concurrency: int = 4,
    on_result: Callable[[Result], Awaitable[None]] | None = None,
    judge_version: str = "auto",
    project_id: str | None = None,
    api_key: str | None = None,
    control_plane_url: str | None = None,
    timeout: float = 30.0,
    client: httpx.AsyncClient | None = None,
) -> RunResult:
    """Run a batch eval over ``rows`` with bounded parallelism.

    Args:
        run_id: Identifier the caller uses to correlate results upstream.
        type: ``'trace'`` (output is supplied) or ``'live'`` (output is produced
            by ``run_pipeline``).
        rows: Rows to judge.
        criteria: Criteria forwarded to each judge call.
        run_pipeline: Required when ``type='live'``. Called once per row.
        concurrency: Maximum in-flight judge calls.
        on_result: Optional async callback invoked once per row, in completion
            order, after the row finishes (success or failure).
        judge_version, project_id, api_key, control_plane_url, timeout, client:
            Forwarded to :func:`judge_call`. ``client`` is reused across rows
            when supplied, which is the recommended pattern for large runs.
    """
    if concurrency < 1:
        raise ValueError("concurrency must be >= 1")
    if type == "live" and run_pipeline is None:  # noqa: A001
        raise ValueError("run_pipeline is required when type='live'")

    eval_type = type
    semaphore = asyncio.Semaphore(concurrency)
    aggregate = RunResult(run_id=run_id, type=eval_type, results=[None] * len(rows))  # type: ignore[list-item]
    callback_lock = asyncio.Lock() if on_result else None

    owns_client = client is None
    http_client = client or httpx.AsyncClient(timeout=timeout)

    async def _process(idx: int, row: Row) -> None:
        async with semaphore:
            result = Result(row_id=row.id)
            try:
                output: Any = row.output
                if eval_type == "live":
                    assert run_pipeline is not None
                    output = await _maybe_await(run_pipeline(row.input))
                response = await judge_call(
                    type=eval_type,
                    input=row.input,
                    output=output,
                    criteria=criteria,
                    expected_correction=row.expected_correction,
                    prompt_context=row.prompt_context,
                    judge_version=judge_version,
                    project_id=project_id,
                    api_key=api_key,
                    control_plane_url=control_plane_url,
                    timeout=timeout,
                    client=http_client,
                )
                result.response = response
            except JudgeError as exc:
                result.error = str(exc)
                result.error_status = exc.status
            except Exception as exc:  # noqa: BLE001 — collect anything the row raised
                result.error = f"{exc.__class__.__name__}: {exc}"
            aggregate.results[idx] = result
        if on_result is not None and callback_lock is not None:
            async with callback_lock:
                try:
                    await on_result(result)
                except Exception:  # noqa: BLE001
                    # The callback's failure must not abort the run.
                    pass

    try:
        await asyncio.gather(*(_process(i, row) for i, row in enumerate(rows)))
    finally:
        if owns_client:
            await http_client.aclose()

    aggregate.succeeded = len([r for r in aggregate.results if r and r.error is None])
    aggregate.failed = len([r for r in aggregate.results if r and r.error is not None])
    return aggregate
