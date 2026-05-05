"""Unit tests for artanis_gravel.analyze.client."""
from __future__ import annotations

import pytest
import httpx
from pytest_httpx import HTTPXMock

from artanis_gravel.analyze import analyze_prompt, AnalyzeError


@pytest.mark.asyncio
async def test_missing_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GRAVEL_API_KEY", raising=False)
    with pytest.raises(AnalyzeError) as exc:
        await analyze_prompt(prompt="hi")
    assert exc.value.status == 0


@pytest.mark.asyncio
async def test_happy_path(httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GRAVEL_API_KEY", "ak_test")
    monkeypatch.setenv("GRAVEL_CONTROL_PLANE_URL", "https://example.test")
    httpx_mock.add_response(
        url="https://example.test/api/analyze",
        method="POST",
        json={
            "issues": [
                {"id": "i1", "type": "contradiction", "severity": "error", "range": [0, 5], "message": "..."},
            ],
            "usage": {"inputTokens": 100, "outputTokens": 20, "tasks": 1},
        },
    )
    res = await analyze_prompt(prompt="hello")
    assert len(res.issues) == 1
    assert res.issues[0].type == "contradiction"
    assert res.issues[0].range == (0, 5)
    assert res.usage.input_tokens == 100


@pytest.mark.asyncio
async def test_non_2xx_raises(httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GRAVEL_API_KEY", "ak_bad")
    httpx_mock.add_response(
        url="https://gravel.artanis.ai/api/analyze",
        method="POST",
        status_code=401,
        json={"error": "invalid or expired API key"},
    )
    with pytest.raises(AnalyzeError) as exc:
        await analyze_prompt(prompt="hi")
    assert exc.value.status == 401
