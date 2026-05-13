"""In-memory rate limit for default-password login attempts.

Port of `packages/sdk-ts/src/auth/rate-limit.ts`. Same constants so a
host that flips between TS and Python SDKs behaves the same way:

    * 5 attempts per IP per minute
    * 30-second base lockout, doubled on each consecutive lockout
    * Successful login resets the bucket

Process-local. Sufficient for single-host default-password mode;
distributed deployments should configure a real auth provider rather
than rely on this. Spec: gravel-cloud/docs/spec/auth.md §2.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

WINDOW_S = 60.0
MAX_ATTEMPTS = 5
BASE_LOCKOUT_S = 30.0


@dataclass
class _Bucket:
    attempts: list[float] = field(default_factory=list)  # epoch seconds
    locked_until: float = 0.0
    consecutive_lockouts: int = 0


_lock = threading.Lock()
_buckets: dict[str, _Bucket] = {}


@dataclass
class RateLimitOutcome:
    allowed: bool
    retry_after_ms: int = 0


def attempt_login(ip: str, *, now: float | None = None) -> RateLimitOutcome:
    """Record a login attempt for `ip`. Returns whether the attempt is
    allowed and (if not) how many ms to back off.

    `now` is exposed so tests can fast-forward without monkey-patching
    time.time. Production callers leave it None.
    """
    t = now if now is not None else time.time()
    with _lock:
        bucket = _buckets.setdefault(ip, _Bucket())
        if bucket.locked_until > t:
            return RateLimitOutcome(False, int((bucket.locked_until - t) * 1000))

        bucket.attempts = [a for a in bucket.attempts if t - a < WINDOW_S]

        if len(bucket.attempts) >= MAX_ATTEMPTS:
            bucket.consecutive_lockouts += 1
            bucket.locked_until = t + BASE_LOCKOUT_S * (2 ** (bucket.consecutive_lockouts - 1))
            bucket.attempts = []
            return RateLimitOutcome(False, int((bucket.locked_until - t) * 1000))

        bucket.attempts.append(t)
        return RateLimitOutcome(True)


def record_success(ip: str) -> None:
    """Clear an IP's bucket after a successful login. Resets both the
    in-window attempt count and any accumulated lockout backoff so a
    legitimate user who fat-fingered once isn't penalised forever."""
    with _lock:
        _buckets.pop(ip, None)


def _reset_for_tests() -> None:
    """Test seam: drops every bucket. Use in test fixtures so each
    case starts from a clean slate."""
    with _lock:
        _buckets.clear()
