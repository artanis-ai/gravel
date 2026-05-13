"""Auto-patch raw HTTP clients for OpenAI- and Anthropic-shaped calls.

Port of `packages/sdk-ts/src/tracing/fetch.ts`. Catches projects that
bypass the provider SDKs and POST directly — a common shape for minimal
services that don't want a heavyweight client.

Python has no single global `fetch` to wrap; the four transports that
matter in production today are:

  * `httpx` — sync `Client.send`, async `AsyncClient.send` (covers both
    `client.post(...)` and the streaming `stream(...)` variants).
  * `requests` — sync, the long-tail incumbent.
  * `aiohttp` — async, dominant in async-first apps.
  * `urllib.request.urlopen` — stdlib fallback; small services + a few
    SDKs (e.g. our own `_github_api.py`) reach for it.

Each transport gets a thin wrapper that calls a shared classifier +
persist helper. Detection is path-based (works against api.openai.com,
api.anthropic.com, and any OpenAI-compatible proxy — Azure, vLLM, mock
servers — that mirrors the canonical paths).

Patches no-op silently when the target library isn't installed (matches
the lazy-import pattern of the SDK patches). All emit best-effort
traces: a parse failure or persist failure must never break the
customer's HTTP call. Spec: tracing.md §1 + §6.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime
from typing import Any

from . import gravel_context_singleton
from .persist import make_record, now_utc, persist_trace

log = logging.getLogger("gravel.tracing.fetch")

_PATCHED_HTTPX = False
_PATCHED_REQUESTS = False
_PATCHED_AIOHTTP = False
_PATCHED_URLLIB = False

# Originals captured at first patch so `_reset_for_tests` can restore
# them. Production never calls reset; tests use it between scenarios.
_ORIGINAL_HTTPX_SYNC: Any = None
_ORIGINAL_HTTPX_ASYNC: Any = None
_ORIGINAL_REQUESTS_SEND: Any = None
_ORIGINAL_AIOHTTP_REQUEST: Any = None
_ORIGINAL_URLLIB_URLOPEN: Any = None


# -------------------- shared helpers --------------------


def _is_disabled() -> bool:
    if os.environ.get("GRAVEL_TRACING_DISABLED") == "1":
        return True
    return gravel_context_singleton.is_tracing_disabled()


_OPENAI_CHAT_RE = re.compile(r"/chat/completions(\?|$)")
_OPENAI_RESPONSES_RE = re.compile(r"/responses(\?|$)")
_OPENAI_RESPONSES_HOST_RE = re.compile(r"api\.openai\.com|/v1/")
_OPENAI_EMBEDDINGS_RE = re.compile(r"/embeddings(\?|$)")
_ANTHROPIC_MESSAGES_PATH_RE = re.compile(r"/v1/messages(\?|$)")
_ANTHROPIC_MESSAGES_HOST_RE = re.compile(r"api\.anthropic\.com.*/messages")


def _classify(url: str) -> tuple[str, str] | None:
    """Return `(provider, trace_name)` if `url` matches a known shape.

    Same matchers as the TS implementation so a host that flips between
    JS and Python sees identical trace names — the dashboard can group
    cross-stack traces by `name` without case-splitting on language."""
    if _OPENAI_CHAT_RE.search(url):
        return ("openai", "fetch:openai.chat.completions")
    if _OPENAI_RESPONSES_RE.search(url) and _OPENAI_RESPONSES_HOST_RE.search(url):
        return ("openai", "fetch:openai.responses")
    if _OPENAI_EMBEDDINGS_RE.search(url):
        return ("openai", "fetch:openai.embeddings")
    if _ANTHROPIC_MESSAGES_PATH_RE.search(url) or _ANTHROPIC_MESSAGES_HOST_RE.search(url):
        return ("anthropic", "fetch:anthropic.messages")
    return None


def _parse_request_body(body: Any) -> Any:
    """Best-effort decode of the outgoing request body. Returns the
    parsed dict for JSON, the raw string for text, a sentinel for
    binary / unreadable streams. Never raises."""
    if body is None:
        return None
    if isinstance(body, bytes):
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            return "<binary>"
        try:
            return json.loads(text)
        except (json.JSONDecodeError, ValueError):
            return text
    if isinstance(body, str):
        try:
            return json.loads(body)
        except (json.JSONDecodeError, ValueError):
            return body
    if isinstance(body, dict):
        return body
    if isinstance(body, (list, tuple)):
        # Some clients accept a list of (k, v) pairs (form-encoded).
        try:
            return dict(body)
        except (TypeError, ValueError):
            return "<unreadable-body>"
    return "<unreadable-body>"


def _parse_response_body(provider: str, body: Any) -> dict[str, Any]:
    """Extract model + token counts from a provider's JSON response.

    Returns `{}` for non-dict bodies. Pulls both OpenAI- and Anthropic-
    style usage keys; downstream code passes whatever's present through
    to the sample row's `metadata` jsonb."""
    if not isinstance(body, dict):
        return {}
    out: dict[str, Any] = {"parsed": body}
    model = body.get("model")
    if isinstance(model, str):
        out["model"] = model
    usage = body.get("usage")
    if isinstance(usage, dict):
        if provider == "openai":
            ti = usage.get("prompt_tokens") or usage.get("input_tokens")
            to = usage.get("completion_tokens") or usage.get("output_tokens")
        else:  # anthropic
            ti = usage.get("input_tokens")
            to = usage.get("output_tokens")
        if isinstance(ti, int):
            out["tokens_input"] = ti
        if isinstance(to, int):
            out["tokens_output"] = to
    return out


def _emit_sample(
    *,
    name: str,
    provider: str,
    url: str,
    method: str,
    request_body: Any,
    response_body: Any,
    response_status: int | None,
    response_status_text: str | None,
    started_at: datetime,
    finished_at: datetime,
    error_message: str | None,
) -> None:
    """Build a TraceRecord + hand it to `persist_trace`. Never raises."""
    parsed = _parse_response_body(provider, response_body) if response_body is not None else {}
    status = "errored" if error_message or (
        response_status is not None and not (200 <= response_status < 400)
    ) else "completed"
    output_data: dict[str, Any] | None
    if parsed.get("parsed") is not None:
        output_data = {"body": parsed["parsed"]}
    elif response_status is not None:
        output_data = {"status": response_status, "statusText": response_status_text}
    else:
        output_data = None
    metadata: dict[str, Any] = {}
    if "tokens_input" in parsed:
        metadata["tokens_input"] = parsed["tokens_input"]
    if "tokens_output" in parsed:
        metadata["tokens_output"] = parsed["tokens_output"]
    error_data = {"message": error_message} if error_message else None
    record = make_record(
        name=name,
        started_at=started_at,
        completed_at=finished_at,
        model=parsed.get("model"),
        status=status,
        input_data={"url": url, "method": method, "body": request_body},
        output_data=output_data,
        error_data=error_data,
        metadata=metadata or None,
    )
    try:
        persist_trace(record)
    except Exception as exc:  # noqa: BLE001 — persistence must never break user code
        log.debug("persist_trace raised; dropping fetch trace: %s", exc)


# -------------------- httpx --------------------


def _patch_httpx() -> None:
    """Wrap httpx.Client.send + AsyncClient.send. Both are called by
    every other httpx surface (post, get, stream, etc.) so one patch
    point covers everything."""
    global _PATCHED_HTTPX, _ORIGINAL_HTTPX_SYNC, _ORIGINAL_HTTPX_ASYNC
    if _PATCHED_HTTPX:
        return
    try:
        import httpx
    except ImportError:
        return
    _PATCHED_HTTPX = True

    if _ORIGINAL_HTTPX_SYNC is None:
        _ORIGINAL_HTTPX_SYNC = httpx.Client.send
        _ORIGINAL_HTTPX_ASYNC = httpx.AsyncClient.send
    orig_sync = _ORIGINAL_HTTPX_SYNC
    orig_async = _ORIGINAL_HTTPX_ASYNC

    def _sync_send(self: Any, request: Any, **kwargs: Any) -> Any:
        if _is_disabled():
            return orig_sync(self, request, **kwargs)
        url = str(request.url)
        shape = _classify(url)
        if shape is None:
            return orig_sync(self, request, **kwargs)
        provider, name = shape
        started = now_utc()
        req_body = _parse_request_body(request.content if hasattr(request, "content") else None)
        method = request.method.upper() if hasattr(request, "method") else "GET"
        response = None
        err: str | None = None
        try:
            response = orig_sync(self, request, **kwargs)
        except Exception as e:  # noqa: BLE001
            err = str(e) or type(e).__name__
        body = _safe_read_response_json(response)
        status = getattr(response, "status_code", None) if response is not None else None
        status_text = getattr(response, "reason_phrase", None) if response is not None else None
        _emit_sample(
            name=name,
            provider=provider,
            url=url,
            method=method,
            request_body=req_body,
            response_body=body,
            response_status=status,
            response_status_text=status_text,
            started_at=started,
            finished_at=now_utc(),
            error_message=err,
        )
        if err is not None and response is None:
            raise RuntimeError(err)
        return response

    async def _async_send(self: Any, request: Any, **kwargs: Any) -> Any:
        if _is_disabled():
            return await orig_async(self, request, **kwargs)
        url = str(request.url)
        shape = _classify(url)
        if shape is None:
            return await orig_async(self, request, **kwargs)
        provider, name = shape
        started = now_utc()
        req_body = _parse_request_body(request.content if hasattr(request, "content") else None)
        method = request.method.upper() if hasattr(request, "method") else "GET"
        response = None
        err: str | None = None
        try:
            response = await orig_async(self, request, **kwargs)
        except Exception as e:  # noqa: BLE001
            err = str(e) or type(e).__name__
        body = _safe_read_response_json(response)
        status = getattr(response, "status_code", None) if response is not None else None
        status_text = getattr(response, "reason_phrase", None) if response is not None else None
        _emit_sample(
            name=name,
            provider=provider,
            url=url,
            method=method,
            request_body=req_body,
            response_body=body,
            response_status=status,
            response_status_text=status_text,
            started_at=started,
            finished_at=now_utc(),
            error_message=err,
        )
        if err is not None and response is None:
            raise RuntimeError(err)
        return response

    httpx.Client.send = _sync_send  # type: ignore[assignment]
    httpx.AsyncClient.send = _async_send  # type: ignore[assignment]


def _safe_read_response_json(response: Any) -> Any:
    """Pull JSON out of an httpx Response without consuming it from the
    caller's perspective. httpx caches `.content` after first read, so
    subsequent `.json()` / `.text` access by the user still works."""
    if response is None:
        return None
    try:
        ctype = response.headers.get("content-type", "")
    except Exception:  # noqa: BLE001 — defensive against weird response stubs
        return None
    if "application/json" not in ctype:
        return None
    try:
        return response.json()
    except (json.JSONDecodeError, ValueError, UnicodeDecodeError):
        return None
    except Exception as exc:  # noqa: BLE001
        log.debug("response.json() raised; dropping body capture: %s", exc)
        return None


# -------------------- requests --------------------


def _patch_requests() -> None:
    """Wrap requests.Session.send. Every requests.* function (get, post,
    requests.request, etc.) funnels through Session.send eventually."""
    global _PATCHED_REQUESTS, _ORIGINAL_REQUESTS_SEND
    if _PATCHED_REQUESTS:
        return
    try:
        import requests
    except ImportError:
        return
    _PATCHED_REQUESTS = True

    if _ORIGINAL_REQUESTS_SEND is None:
        _ORIGINAL_REQUESTS_SEND = requests.Session.send
    orig = _ORIGINAL_REQUESTS_SEND

    def _send(self: Any, request: Any, **kwargs: Any) -> Any:
        if _is_disabled():
            return orig(self, request, **kwargs)
        url = getattr(request, "url", "")
        shape = _classify(url)
        if shape is None:
            return orig(self, request, **kwargs)
        provider, name = shape
        started = now_utc()
        body = _parse_request_body(getattr(request, "body", None))
        method = getattr(request, "method", "GET").upper()
        response = None
        err: str | None = None
        try:
            response = orig(self, request, **kwargs)
        except Exception as e:  # noqa: BLE001
            err = str(e) or type(e).__name__
        resp_body: Any = None
        status = None
        status_text = None
        if response is not None:
            status = getattr(response, "status_code", None)
            status_text = getattr(response, "reason", None)
            try:
                if "application/json" in response.headers.get("content-type", ""):
                    # response.json() consumes the buffer; clone via .content
                    # so the user's subsequent .text / .json still works.
                    raw = response.content
                    resp_body = json.loads(raw.decode("utf-8")) if raw else None
            except (json.JSONDecodeError, ValueError, UnicodeDecodeError):
                resp_body = None
            except Exception as exc:  # noqa: BLE001
                log.debug("requests response body read failed: %s", exc)
        _emit_sample(
            name=name,
            provider=provider,
            url=url,
            method=method,
            request_body=body,
            response_body=resp_body,
            response_status=status,
            response_status_text=status_text,
            started_at=started,
            finished_at=now_utc(),
            error_message=err,
        )
        if err is not None and response is None:
            raise RuntimeError(err)
        return response

    requests.Session.send = _send  # type: ignore[assignment]


# -------------------- aiohttp --------------------


def _patch_aiohttp() -> None:
    """Wrap aiohttp.ClientSession._request — the single internal entry
    every public verb (get/post/put/...) calls into."""
    global _PATCHED_AIOHTTP, _ORIGINAL_AIOHTTP_REQUEST
    if _PATCHED_AIOHTTP:
        return
    try:
        import aiohttp
    except ImportError:
        return
    _PATCHED_AIOHTTP = True

    if _ORIGINAL_AIOHTTP_REQUEST is None:
        _ORIGINAL_AIOHTTP_REQUEST = aiohttp.ClientSession._request  # type: ignore[attr-defined]
    orig = _ORIGINAL_AIOHTTP_REQUEST

    async def _request(self: Any, method: str, str_or_url: Any, **kwargs: Any) -> Any:
        if _is_disabled():
            return await orig(self, method, str_or_url, **kwargs)
        url = str(str_or_url)
        shape = _classify(url)
        if shape is None:
            return await orig(self, method, str_or_url, **kwargs)
        provider, name = shape
        started = now_utc()
        req_body = _parse_request_body(kwargs.get("json") or kwargs.get("data"))
        response = None
        err: str | None = None
        try:
            response = await orig(self, method, str_or_url, **kwargs)
        except Exception as e:  # noqa: BLE001
            err = str(e) or type(e).__name__
        resp_body: Any = None
        status = None
        status_text = None
        if response is not None:
            status = getattr(response, "status", None)
            status_text = getattr(response, "reason", None)
            try:
                ctype = response.headers.get("content-type", "")
                if "application/json" in ctype:
                    # Use response.read() then parse — calling .json()
                    # twice would consume the buffer on the user's side.
                    raw = await response.read()
                    resp_body = json.loads(raw.decode("utf-8")) if raw else None
            except (json.JSONDecodeError, ValueError, UnicodeDecodeError):
                resp_body = None
            except Exception as exc:  # noqa: BLE001
                log.debug("aiohttp response body read failed: %s", exc)
        _emit_sample(
            name=name,
            provider=provider,
            url=url,
            method=method.upper(),
            request_body=req_body,
            response_body=resp_body,
            response_status=status,
            response_status_text=status_text,
            started_at=started,
            finished_at=now_utc(),
            error_message=err,
        )
        if err is not None and response is None:
            raise RuntimeError(err)
        return response

    aiohttp.ClientSession._request = _request  # type: ignore[assignment]


# -------------------- urllib --------------------


def _patch_urllib() -> None:
    """Wrap urllib.request.urlopen — the stdlib fallback. Reduced trace
    detail compared to httpx/requests/aiohttp because urllib's API
    doesn't expose the response body without consuming it from the
    caller; we capture request shape + status + headers only."""
    global _PATCHED_URLLIB, _ORIGINAL_URLLIB_URLOPEN
    if _PATCHED_URLLIB:
        return
    import urllib.request

    _PATCHED_URLLIB = True
    if _ORIGINAL_URLLIB_URLOPEN is None:
        _ORIGINAL_URLLIB_URLOPEN = urllib.request.urlopen
    orig = _ORIGINAL_URLLIB_URLOPEN

    def _urlopen(url: Any, *args: Any, **kwargs: Any) -> Any:
        if _is_disabled():
            return orig(url, *args, **kwargs)
        if hasattr(url, "full_url"):
            target = url.full_url
            method = url.get_method().upper() if hasattr(url, "get_method") else "GET"
            req_body = None
            try:
                if hasattr(url, "data") and url.data is not None:
                    req_body = _parse_request_body(url.data)
            except Exception:  # noqa: BLE001
                req_body = "<unreadable-body>"
        else:
            target = str(url)
            method = "GET"
            req_body = None
        shape = _classify(target)
        if shape is None:
            return orig(url, *args, **kwargs)
        provider, name = shape
        started = now_utc()
        response = None
        err: str | None = None
        try:
            response = orig(url, *args, **kwargs)
        except Exception as e:  # noqa: BLE001
            err = str(e) or type(e).__name__
        status = getattr(response, "status", None) if response is not None else None
        _emit_sample(
            name=name,
            provider=provider,
            url=target,
            method=method,
            request_body=req_body,
            response_body=None,  # don't consume the caller's stream
            response_status=status,
            response_status_text=None,
            started_at=started,
            finished_at=now_utc(),
            error_message=err,
        )
        if err is not None and response is None:
            raise RuntimeError(err)
        return response

    urllib.request.urlopen = _urlopen  # type: ignore[assignment]


def patch_all() -> None:
    """Install every available transport patch. Each individual patcher
    no-ops silently when the target library isn't installed, so this is
    safe to call from `artanis_gravel.auto` regardless of which subset
    of HTTP clients the user has."""
    if os.environ.get("GRAVEL_TRACING_DISABLED") == "1":
        return
    _patch_httpx()
    _patch_requests()
    _patch_aiohttp()
    _patch_urllib()


def _reset_for_tests() -> None:
    """Test seam: restore the original transport methods and clear the
    per-module idempotency flags so a test can re-run `patch_all` from
    a clean state. Without the restore, each call would stack a new
    wrapper on top and emit duplicate samples."""
    global _PATCHED_HTTPX, _PATCHED_REQUESTS, _PATCHED_AIOHTTP, _PATCHED_URLLIB
    if _ORIGINAL_HTTPX_SYNC is not None:
        try:
            import httpx

            httpx.Client.send = _ORIGINAL_HTTPX_SYNC  # type: ignore[assignment]
            httpx.AsyncClient.send = _ORIGINAL_HTTPX_ASYNC  # type: ignore[assignment]
        except ImportError:
            pass
    if _ORIGINAL_REQUESTS_SEND is not None:
        try:
            import requests

            requests.Session.send = _ORIGINAL_REQUESTS_SEND  # type: ignore[assignment]
        except ImportError:
            pass
    if _ORIGINAL_AIOHTTP_REQUEST is not None:
        try:
            import aiohttp

            aiohttp.ClientSession._request = _ORIGINAL_AIOHTTP_REQUEST  # type: ignore[assignment]
        except ImportError:
            pass
    if _ORIGINAL_URLLIB_URLOPEN is not None:
        import urllib.request

        urllib.request.urlopen = _ORIGINAL_URLLIB_URLOPEN  # type: ignore[assignment]
    _PATCHED_HTTPX = False
    _PATCHED_REQUESTS = False
    _PATCHED_AIOHTTP = False
    _PATCHED_URLLIB = False
