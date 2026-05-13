"""Async HTTP client for POST /api/analyze (Mallet proxy).

The control plane forwards prompts to the Mallet worker after
verifying the customer's Gravel API key. Returns structured findings
(contradictions, ambiguities, best-practice violations).

"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

import httpx

DEFAULT_CONTROL_PLANE_URL = "https://gravel.artanis.ai"
DEFAULT_TIMEOUT_SECONDS = 60.0
ANALYZE_PATH = "/api/analyze"


class AnalyzeError(Exception):
    """Raised when /api/analyze returns a non-2xx response."""

    def __init__(self, status: int, body: Any):
        self.status = status
        self.body = body
        if isinstance(body, dict):
            msg = body.get("error") or str(body)
        else:
            msg = str(body)
        super().__init__(f"[gravel.analyze] HTTP {status}: {msg}")


@dataclass
class AnalyzeIssue:
    type: str
    message: str
    severity: str | None = None
    range: tuple[int, int] | None = None
    id: str | None = None


@dataclass
class AnalyzeUsage:
    input_tokens: int
    output_tokens: int
    tasks: int


@dataclass
class AnalyzeResponse:
    issues: list[AnalyzeIssue] = field(default_factory=list)
    usage: AnalyzeUsage = field(default_factory=lambda: AnalyzeUsage(0, 0, 0))


def _parse_response(payload: dict[str, Any]) -> AnalyzeResponse:
    issues_raw = payload.get("issues", []) or []
    usage_raw = payload.get("usage", {}) or {}
    issues = [
        AnalyzeIssue(
            type=str(i.get("type", "unknown")),
            message=str(i.get("message", "")),
            severity=i.get("severity"),
            range=tuple(i["range"]) if isinstance(i.get("range"), (list, tuple)) and len(i["range"]) == 2 else None,
            id=i.get("id"),
        )
        for i in issues_raw
        if isinstance(i, dict)
    ]
    usage = AnalyzeUsage(
        input_tokens=int(usage_raw.get("inputTokens", usage_raw.get("input_tokens", 0)) or 0),
        output_tokens=int(usage_raw.get("outputTokens", usage_raw.get("output_tokens", 0)) or 0),
        tasks=int(usage_raw.get("tasks", 0) or 0),
    )
    return AnalyzeResponse(issues=issues, usage=usage)


async def analyze_prompt(
    *,
    prompt: str,
    api_key: str | None = None,
    control_plane_url: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    client: httpx.AsyncClient | None = None,
) -> AnalyzeResponse:
    """Run Mallet analysis on `prompt`.

    `api_key` defaults to `GRAVEL_API_KEY`. `control_plane_url` defaults
    to `GRAVEL_CONTROL_PLANE_URL` or `https://gravel.artanis.ai`.
    """
    key = api_key or os.environ.get("GRAVEL_API_KEY")
    if not key:
        raise AnalyzeError(0, "GRAVEL_API_KEY not set")
    base = (control_plane_url or os.environ.get("GRAVEL_CONTROL_PLANE_URL") or DEFAULT_CONTROL_PLANE_URL).rstrip("/")
    url = f"{base}{ANALYZE_PATH}"

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=timeout)
    try:
        try:
            res = await client.post(
                url,
                headers={"authorization": f"Bearer {key}"},
                json={"prompt": prompt},
                timeout=timeout,
            )
        except httpx.TimeoutException as exc:
            raise AnalyzeError(0, f"request timed out: {exc}") from exc
        except httpx.HTTPError as exc:
            raise AnalyzeError(0, f"transport error: {exc}") from exc
        if res.status_code >= 400:
            try:
                body = res.json()
            except Exception:
                body = res.text
            raise AnalyzeError(res.status_code, body)
        return _parse_response(res.json())
    finally:
        if owns_client:
            await client.aclose()
