"""Integration test against the live control plane.

Skipped unless ``GRAVEL_INTEGRATION=1`` is set. Captures credentials at module
import time so the autouse env-cleaning fixture in conftest.py does not strip
them out before the test reads them.
"""
from __future__ import annotations

import os

import pytest

from artanis_gravel import judge_call

_INTEGRATION_ENABLED = os.environ.get("GRAVEL_INTEGRATION") == "1"
_AMBIENT_API_KEY = (
    os.environ.get("GRAVEL_API_KEY") or "ak_TBVF5BAETAHJW2QWECYJ4169YG6CGG4X"
)
_AMBIENT_PROJECT_ID = (
    os.environ.get("GRAVEL_PROJECT_ID") or "00000000-0000-0000-0000-000000000001"
)
_AMBIENT_URL = os.environ.get("GRAVEL_CONTROL_PLANE_URL") or "https://gravel.artanis.ai"


@pytest.mark.skipif(not _INTEGRATION_ENABLED, reason="set GRAVEL_INTEGRATION=1 to run")
@pytest.mark.asyncio
async def test_real_judge_call() -> None:
    response = await judge_call(
        type="trace",
        input={"question": "What is 2 + 2?"},
        output={"answer": "4"},
        criteria=["accuracy"],
        expected_correction=None,
        prompt_context=None,
        api_key=_AMBIENT_API_KEY,
        project_id=_AMBIENT_PROJECT_ID,
        control_plane_url=_AMBIENT_URL,
    )
    assert 0.0 <= response.verdict.score <= 1.0
    assert isinstance(response.judge_version, str) and response.judge_version
    assert "input" in response.tokens
