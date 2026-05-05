"""Unit tests for artanis_gravel.judge.judge_call."""
from __future__ import annotations

import httpx
import pytest
from pytest_httpx import HTTPXMock

from artanis_gravel.judge import JudgeError, judge_call

JUDGE_URL = "https://gravel.artanis.ai/api/judge"


def _set_creds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GRAVEL_API_KEY", "ak_test_unit")
    monkeypatch.setenv("GRAVEL_PROJECT_ID", "00000000-0000-0000-0000-0000000000aa")


@pytest.mark.asyncio
async def test_success_parses_verdict(
    httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_creds(monkeypatch)
    httpx_mock.add_response(
        url=JUDGE_URL,
        method="POST",
        json={
            "verdict": {
                "score": 0.82,
                "passed": True,
                "reasoning": "Looks good.",
                "breakdown": {
                    "accuracy": {"score": 0.9, "reasoning": "Matches expected."},
                    "tone": {"score": 0.74, "reasoning": "Slightly terse."},
                },
            },
            "judge_version": "v1.2",
            "tokens": {"input": 142, "output": 88},
        },
    )

    response = await judge_call(
        type="trace",
        input={"q": "Capital of France?"},
        output={"a": "Paris"},
        criteria=["accuracy", "tone"],
        expected_correction=None,
        prompt_context=None,
    )

    assert response.verdict.score == pytest.approx(0.82)
    assert response.verdict.passed is True
    assert response.judge_version == "v1.2"
    assert response.tokens == {"input": 142, "output": 88}
    assert set(response.verdict.breakdown.keys()) == {"accuracy", "tone"}
    assert response.verdict.breakdown["accuracy"].score == pytest.approx(0.9)

    sent = httpx_mock.get_request()
    assert sent is not None
    assert sent.headers["authorization"] == "Bearer ak_test_unit"
    body = sent.read()
    import json

    parsed = json.loads(body)
    assert parsed["project_id"] == "00000000-0000-0000-0000-0000000000aa"
    assert parsed["type"] == "trace"
    assert parsed["criteria"] == ["accuracy", "tone"]
    assert parsed["judge_version"] == "auto"


@pytest.mark.asyncio
async def test_explicit_args_override_env(
    httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GRAVEL_API_KEY", "env_key")
    monkeypatch.setenv("GRAVEL_PROJECT_ID", "env_project")
    httpx_mock.add_response(
        url="https://example.test/api/judge",
        method="POST",
        json={
            "verdict": {"score": 1.0, "passed": True, "reasoning": "ok", "breakdown": {}},
            "judge_version": "v1",
            "tokens": {"input": 1, "output": 1},
        },
    )

    await judge_call(
        type="trace",
        input="x",
        output="y",
        criteria=["c"],
        api_key="explicit_key",
        project_id="explicit_project",
        control_plane_url="https://example.test/",
    )

    sent = httpx_mock.get_request()
    assert sent is not None
    assert sent.headers["authorization"] == "Bearer explicit_key"
    import json

    body = json.loads(sent.read())
    assert body["project_id"] == "explicit_project"


@pytest.mark.asyncio
async def test_401_raises_judge_error(
    httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_creds(monkeypatch)
    httpx_mock.add_response(
        url=JUDGE_URL,
        method="POST",
        status_code=401,
        json={"error": "Invalid API key"},
    )

    with pytest.raises(JudgeError) as exc_info:
        await judge_call(
            type="trace",
            input="x",
            output="y",
            criteria=["c"],
        )

    assert exc_info.value.status == 401
    assert exc_info.value.body == {"error": "Invalid API key"}


@pytest.mark.asyncio
async def test_400_raises_judge_error_with_details(
    httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_creds(monkeypatch)
    httpx_mock.add_response(
        url=JUDGE_URL,
        method="POST",
        status_code=400,
        json={"error": "Validation failed", "details": {"criteria": "must be non-empty"}},
    )

    with pytest.raises(JudgeError) as exc_info:
        await judge_call(
            type="trace",
            input="x",
            output="y",
            criteria=[],
        )

    assert exc_info.value.status == 400
    assert exc_info.value.body["details"] == {"criteria": "must be non-empty"}


@pytest.mark.asyncio
async def test_timeout_raises_judge_error(
    httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_creds(monkeypatch)
    httpx_mock.add_exception(httpx.ReadTimeout("simulated"))

    with pytest.raises(JudgeError) as exc_info:
        await judge_call(
            type="trace",
            input="x",
            output="y",
            criteria=["c"],
            timeout=1.0,
        )

    assert exc_info.value.status == 0
    assert "timed out" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_missing_api_key_raises_immediately() -> None:
    with pytest.raises(JudgeError) as exc_info:
        await judge_call(
            type="trace",
            input="x",
            output="y",
            criteria=["c"],
            project_id="proj_x",
        )
    assert "GRAVEL_API_KEY" in str(exc_info.value)


@pytest.mark.asyncio
async def test_missing_project_id_raises_immediately(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GRAVEL_API_KEY", "k")
    with pytest.raises(JudgeError) as exc_info:
        await judge_call(
            type="trace",
            input="x",
            output="y",
            criteria=["c"],
        )
    assert "GRAVEL_PROJECT_ID" in str(exc_info.value)


@pytest.mark.asyncio
async def test_dotenv_fallback(
    httpx_mock: HTTPXMock, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / ".env").write_text(
        "GRAVEL_API_KEY=dotenv_key\nGRAVEL_PROJECT_ID=dotenv_project\n",
        encoding="utf-8",
    )
    httpx_mock.add_response(
        url=JUDGE_URL,
        method="POST",
        json={
            "verdict": {"score": 0.5, "passed": False, "reasoning": "ok", "breakdown": {}},
            "judge_version": "v1",
            "tokens": {"input": 0, "output": 0},
        },
    )

    response = await judge_call(
        type="trace",
        input="x",
        output="y",
        criteria=["c"],
        cwd=tmp_path,
    )
    assert response.verdict.passed is False

    sent = httpx_mock.get_request()
    assert sent is not None
    assert sent.headers["authorization"] == "Bearer dotenv_key"
