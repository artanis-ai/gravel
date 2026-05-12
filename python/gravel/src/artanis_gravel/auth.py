"""HMAC-signed session for default-password mode.

Mirrors `packages/sdk-ts/src/auth/session.ts`. Same wire format so a
session minted on one platform validates on the other:

    cookie := <base64url(payload)>.<base64url(hmac-sha256(payload))>
    payload := {"exp": <unix ms>, "nonce": "<hex>"}

Spec: gravel-cloud/docs/spec/auth.md §2.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets as pysecrets
import time

SESSION_COOKIE = "gravel_session"
SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000  # 30 days


def _derive_secret(password: str) -> bytes:
    return hmac.new(password.encode(), b"gravel-session-v1", hashlib.sha256).digest()


def _b64url(buf: bytes) -> str:
    return base64.urlsafe_b64encode(buf).rstrip(b"=").decode()


def _from_b64url(s: str) -> bytes:
    s += "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s)


def sign_session(password: str, ttl_ms: int = SESSION_TTL_MS) -> str:
    payload = {
        "exp": int(time.time() * 1000) + ttl_ms,
        "nonce": pysecrets.token_hex(8),
    }
    payload_b64 = _b64url(json.dumps(payload).encode())
    secret = _derive_secret(password)
    sig = hmac.new(secret, payload_b64.encode(), hashlib.sha256).digest()
    return f"{payload_b64}.{_b64url(sig)}"


def verify_session(cookie: str, password: str) -> bool:
    parts = cookie.split(".")
    if len(parts) != 2:
        return False
    payload_b64, sig_b64 = parts
    expected = hmac.new(_derive_secret(password), payload_b64.encode(), hashlib.sha256).digest()
    try:
        provided = _from_b64url(sig_b64)
    except Exception:
        return False
    if not hmac.compare_digest(expected, provided):
        return False
    try:
        payload = json.loads(_from_b64url(payload_b64))
    except Exception:
        return False
    if not isinstance(payload, dict):
        return False
    exp = payload.get("exp")
    if not isinstance(exp, int) or exp < int(time.time() * 1000):
        return False
    return True


def verify_password(presented: str, expected: str) -> bool:
    if len(presented) != len(expected):
        return False
    return hmac.compare_digest(presented.encode(), expected.encode())


def session_cookie_value(value: str, *, https: bool) -> str:
    parts = [
        f"{SESSION_COOKIE}={value}",
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=2592000",
    ]
    if https:
        parts.append("Secure")
    return "; ".join(parts)


def session_cookie_clear(*, https: bool) -> str:
    parts = [
        f"{SESSION_COOKIE}=",
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=0",
    ]
    if https:
        parts.append("Secure")
    return "; ".join(parts)
