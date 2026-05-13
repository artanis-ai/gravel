"""Async HTTP client for POST /api/judge on the Gravel control plane.

Server contract is snake-case JSON, validated by Zod on the server.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import httpx

DEFAULT_CONTROL_PLANE_URL = "https://gravel.artanis.ai"
DEFAULT_TIMEOUT_SECONDS = 30.0
JUDGE_PATH = "/api/judge"

JudgeType = Literal["trace", "live"]


# ---------- Error type ----------


class JudgeError(Exception):
    """Raised when the judge endpoint returns a non-2xx response."""

    def __init__(self, status: int, body: Any):
        self.status = status
        self.body = body
        if isinstance(body, dict):
            msg = body.get("error") or str(body)
        else:
            msg = str(body)
        super().__init__(f"[gravel.judge] HTTP {status}: {msg}")


# ---------- Response types ----------


@dataclass
class CriterionVerdict:
    score: float
    reasoning: str


@dataclass
class Verdict:
    """The 'verdict' object inside a successful judge response."""

    score: float
    passed: bool
    reasoning: str
    breakdown: dict[str, CriterionVerdict] = field(default_factory=dict)


@dataclass
class JudgeResponse:
    verdict: Verdict
    judge_version: str
    tokens: dict[str, int]


# ---------- Env loading ----------


def _read_dotenv(cwd: Path) -> dict[str, str]:
    """Mirror wizard/migrate.py:_read_env — process env wins; .env then .env.local."""
    out: dict[str, str] = {}
    for name in (".env", ".env.local"):
        p = cwd / name
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            if "=" not in line or line.startswith("#"):
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip("'\"")
            if k and k not in out:
                out[k] = v
    return out


def _resolve_env(
    *,
    api_key: str | None,
    project_id: str | None,
    control_plane_url: str | None,
    cwd: Path | str | None,
) -> tuple[str, str, str]:
    cwd_path = Path(cwd) if cwd else Path.cwd()
    dotenv = _read_dotenv(cwd_path)

    def _get(name: str) -> str | None:
        return os.environ.get(name) or dotenv.get(name)

    resolved_key = api_key or _get("GRAVEL_API_KEY")
    resolved_project = project_id or _get("GRAVEL_PROJECT_ID")
    resolved_url = (
        control_plane_url
        or _get("GRAVEL_CONTROL_PLANE_URL")
        or DEFAULT_CONTROL_PLANE_URL
    )

    if not resolved_key:
        raise JudgeError(
            0,
            {
                "error": (
                    "GRAVEL_API_KEY is not set. Provide api_key=... or set the env var "
                    "(also accepted from .env / .env.local)."
                )
            },
        )
    if not resolved_project:
        raise JudgeError(
            0,
            {
                "error": (
                    "GRAVEL_PROJECT_ID is not set. Provide project_id=... or set the env var "
                    "(also accepted from .env / .env.local)."
                )
            },
        )
    return resolved_key, resolved_project, resolved_url.rstrip("/")


# ---------- Public client ----------


def _parse_response(payload: Any) -> JudgeResponse:
    if not isinstance(payload, dict):
        raise JudgeError(200, {"error": "Malformed judge response", "details": payload})
    verdict_raw = payload.get("verdict") or {}
    breakdown_raw = verdict_raw.get("breakdown") or {}
    breakdown: dict[str, CriterionVerdict] = {}
    if isinstance(breakdown_raw, dict):
        for key, val in breakdown_raw.items():
            if not isinstance(val, dict):
                continue
            breakdown[key] = CriterionVerdict(
                score=float(val.get("score", 0.0)),
                reasoning=str(val.get("reasoning", "")),
            )
    verdict = Verdict(
        score=float(verdict_raw.get("score", 0.0)),
        passed=bool(verdict_raw.get("passed", False)),
        reasoning=str(verdict_raw.get("reasoning", "")),
        breakdown=breakdown,
    )
    return JudgeResponse(
        verdict=verdict,
        judge_version=str(payload.get("judge_version", "")),
        tokens=dict(payload.get("tokens") or {}),
    )


async def judge_call(
    *,
    type: JudgeType,
    input: Any,
    output: Any,
    criteria: list[str],
    expected_correction: str | None = None,
    prompt_context: str | None = None,
    judge_version: str = "auto",
    project_id: str | None = None,
    api_key: str | None = None,
    control_plane_url: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    client: httpx.AsyncClient | None = None,
    cwd: Path | str | None = None,
) -> JudgeResponse:
    """Call POST /api/judge.

    Reads ``GRAVEL_API_KEY``, ``GRAVEL_PROJECT_ID`` and ``GRAVEL_CONTROL_PLANE_URL``
    from the environment (or ``.env`` / ``.env.local`` in ``cwd``) when not passed
    explicitly. Raises :class:`JudgeError` on non-2xx responses or transport errors.
    """
    resolved_key, resolved_project, resolved_url = _resolve_env(
        api_key=api_key,
        project_id=project_id,
        control_plane_url=control_plane_url,
        cwd=cwd,
    )

    body = {
        "project_id": resolved_project,
        "type": type,
        "input": input,
        "output": output,
        "expected_correction": expected_correction,
        "prompt_context": prompt_context,
        "criteria": list(criteria),
        "judge_version": judge_version,
    }
    headers = {
        "Authorization": f"Bearer {resolved_key}",
        "Content-Type": "application/json",
    }
    url = f"{resolved_url}{JUDGE_PATH}"

    owns_client = client is None
    http_client = client or httpx.AsyncClient(timeout=timeout)
    try:
        try:
            response = await http_client.post(url, json=body, headers=headers)
        except httpx.TimeoutException as exc:
            raise JudgeError(0, {"error": f"Request timed out after {timeout}s: {exc}"}) from exc
        except httpx.HTTPError as exc:
            raise JudgeError(0, {"error": f"Transport error: {exc}"}) from exc
    finally:
        if owns_client:
            await http_client.aclose()

    if response.status_code < 200 or response.status_code >= 300:
        try:
            err_body: Any = response.json()
        except ValueError:
            err_body = response.text
        raise JudgeError(response.status_code, err_body)

    try:
        payload = response.json()
    except ValueError as exc:
        raise JudgeError(response.status_code, {"error": f"Invalid JSON: {exc}"}) from exc
    return _parse_response(payload)
