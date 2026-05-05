"""Unit tests for artanis_gravel.evals.run_eval."""
from __future__ import annotations

import asyncio

import pytest
from pytest_httpx import HTTPXMock

from artanis_gravel import Result, Row, run_eval
from artanis_gravel.judge import JudgeResponse

JUDGE_URL = "https://gravel.artanis.ai/api/judge"


def _ok_payload(score: float = 0.7) -> dict:
    return {
        "verdict": {
            "score": score,
            "passed": score >= 0.5,
            "reasoning": "fine",
            "breakdown": {},
        },
        "judge_version": "v1",
        "tokens": {"input": 1, "output": 1},
    }


def _set_creds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GRAVEL_API_KEY", "ak_test_runner")
    monkeypatch.setenv("GRAVEL_PROJECT_ID", "00000000-0000-0000-0000-000000000099")


@pytest.mark.asyncio
async def test_runs_all_rows_and_invokes_callback(
    httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_creds(monkeypatch)
    rows = [Row(id=f"r{i}", input={"i": i}, output={"o": i}) for i in range(10)]
    for _ in rows:
        httpx_mock.add_response(url=JUDGE_URL, method="POST", json=_ok_payload())

    seen: list[Result] = []

    async def cb(r: Result) -> None:
        seen.append(r)

    result = await run_eval(
        run_id="run-1",
        type="trace",
        rows=rows,
        criteria=["accuracy"],
        concurrency=4,
        on_result=cb,
    )

    assert len(httpx_mock.get_requests()) == 10
    assert result.succeeded == 10
    assert result.failed == 0
    assert len(result.results) == 10
    assert all(isinstance(r.response, JudgeResponse) for r in result.results)
    assert {r.row_id for r in seen} == {f"r{i}" for i in range(10)}


@pytest.mark.asyncio
async def test_concurrency_is_bounded(
    httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_creds(monkeypatch)
    n = 12
    concurrency = 3
    rows = [Row(id=f"r{i}", input=i, output=i) for i in range(n)]

    in_flight = 0
    peak = 0
    lock = asyncio.Lock()

    async def custom_response(request):  # noqa: ANN001
        nonlocal in_flight, peak
        async with lock:
            in_flight += 1
            peak = max(peak, in_flight)
        # Yield so other tasks can pile up if concurrency is unbounded.
        await asyncio.sleep(0.02)
        async with lock:
            in_flight -= 1
        import httpx

        return httpx.Response(200, json=_ok_payload())

    httpx_mock.add_callback(
        custom_response, url=JUDGE_URL, method="POST", is_reusable=True
    )

    result = await run_eval(
        run_id="run-c",
        type="trace",
        rows=rows,
        criteria=["a"],
        concurrency=concurrency,
    )

    assert result.succeeded == n
    assert peak <= concurrency, f"peak in-flight {peak} exceeded concurrency {concurrency}"
    assert peak >= 2, f"expected some parallelism, got peak={peak}"


@pytest.mark.asyncio
async def test_errors_do_not_abort_run(
    httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_creds(monkeypatch)
    rows = [Row(id=f"r{i}", input=i, output=i) for i in range(5)]
    # Mix: one 500, rest succeed.
    httpx_mock.add_response(url=JUDGE_URL, method="POST", status_code=500, json={"error": "boom"})
    for _ in range(4):
        httpx_mock.add_response(url=JUDGE_URL, method="POST", json=_ok_payload())

    result = await run_eval(
        run_id="run-err",
        type="trace",
        rows=rows,
        criteria=["c"],
        concurrency=1,  # serialise so the queued mock responses match request order
    )

    assert len(result.results) == 5
    assert result.failed == 1
    assert result.succeeded == 4
    failed = [r for r in result.results if r.error is not None]
    assert len(failed) == 1
    assert failed[0].error_status == 500
    assert failed[0].response is None


@pytest.mark.asyncio
async def test_live_type_calls_run_pipeline(
    httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_creds(monkeypatch)
    rows = [Row(id=f"r{i}", input={"i": i}) for i in range(3)]
    for _ in rows:
        httpx_mock.add_response(url=JUDGE_URL, method="POST", json=_ok_payload())

    pipeline_calls: list = []

    async def pipeline(inp):  # noqa: ANN001
        pipeline_calls.append(inp)
        return {"computed": inp["i"] * 2}

    result = await run_eval(
        run_id="run-live",
        type="live",
        rows=rows,
        criteria=["acc"],
        run_pipeline=pipeline,
        concurrency=2,
    )

    assert result.succeeded == 3
    assert pipeline_calls == [{"i": 0}, {"i": 1}, {"i": 2}] or sorted(
        pipeline_calls, key=lambda x: x["i"]
    ) == [{"i": 0}, {"i": 1}, {"i": 2}]

    # Confirm the pipeline output was forwarded to the judge.
    import json

    bodies = [json.loads(r.read()) for r in httpx_mock.get_requests()]
    seen_outputs = sorted(b["output"]["computed"] for b in bodies)
    assert seen_outputs == [0, 2, 4]


@pytest.mark.asyncio
async def test_live_requires_run_pipeline(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    with pytest.raises(ValueError, match="run_pipeline"):
        await run_eval(
            run_id="x",
            type="live",
            rows=[Row(id="r0", input=1)],
            criteria=["a"],
        )


@pytest.mark.asyncio
async def test_pipeline_exception_captured(
    httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_creds(monkeypatch)
    httpx_mock.add_response(url=JUDGE_URL, method="POST", json=_ok_payload())

    async def pipeline(inp):  # noqa: ANN001
        if inp == "boom":
            raise RuntimeError("pipeline kaboom")
        return "ok"

    result = await run_eval(
        run_id="rp",
        type="live",
        rows=[Row(id="good", input="ok"), Row(id="bad", input="boom")],
        criteria=["a"],
        run_pipeline=pipeline,
        concurrency=2,
    )

    assert result.succeeded == 1
    assert result.failed == 1
    bad = next(r for r in result.results if r.row_id == "bad")
    assert bad.error is not None
    assert "pipeline kaboom" in bad.error
