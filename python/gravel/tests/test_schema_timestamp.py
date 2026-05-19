"""Cross-dialect bind/result tests for GravelTimestamp.

Olly's v0.6.2 install on de_platform surfaced a silent zero-trace bug:
GravelTimestamp.process_bind_param returned `int` unchanged on Postgres,
but the underlying column is TIMESTAMPTZ, so every INSERT failed with
'column \"created_at\" is of type timestamp with time zone but
expression is of type bigint'. The persister swallowed the error to
stderr and the dashboard stayed empty.

This test pins the *bind* contract for both dialects so a future regression
fails loudly:
    - SQLite (BIGINT storage): int(ms) in / int(ms) out
    - Postgres (TIMESTAMPTZ storage): int(ms) in / tz-aware datetime out
"""
from __future__ import annotations

from datetime import datetime, timezone

from artanis_gravel.schema import GravelTimestamp, _now_utc_ms


class _FakeDialect:
    def __init__(self, name: str) -> None:
        self.name = name


def test_bind_param_sqlite_int_passthrough() -> None:
    td = GravelTimestamp()
    ms = _now_utc_ms()
    got = td.process_bind_param(ms, _FakeDialect("sqlite"))
    assert isinstance(got, int)
    assert got == ms


def test_bind_param_sqlite_datetime_to_ms() -> None:
    td = GravelTimestamp()
    dt = datetime(2026, 5, 19, 12, 0, 0, tzinfo=timezone.utc)
    got = td.process_bind_param(dt, _FakeDialect("sqlite"))
    assert isinstance(got, int)
    assert got == int(dt.timestamp() * 1000)


def test_bind_param_postgres_int_to_datetime() -> None:
    """The Olly bug: int → TIMESTAMPTZ insert rejected by Postgres.

    Bind must convert int(ms) to a tz-aware datetime so the column
    accepts it.
    """
    td = GravelTimestamp()
    ms = _now_utc_ms()
    got = td.process_bind_param(ms, _FakeDialect("postgresql"))
    assert isinstance(got, datetime)
    assert got.tzinfo is not None  # tz-aware
    assert int(got.timestamp() * 1000) == ms  # round-trip preserved


def test_bind_param_postgres_datetime_passthrough() -> None:
    td = GravelTimestamp()
    dt = datetime(2026, 5, 19, 12, 0, 0, tzinfo=timezone.utc)
    got = td.process_bind_param(dt, _FakeDialect("postgresql"))
    assert got is dt  # passthrough; SQLAlchemy serialises natively


def test_bind_param_none_is_none() -> None:
    td = GravelTimestamp()
    for dialect in (_FakeDialect("sqlite"), _FakeDialect("postgresql")):
        assert td.process_bind_param(None, dialect) is None


def test_bind_param_postgres_isodate_string_to_datetime() -> None:
    """Dashboard filter params arrive as YYYY-MM-DD or ISO; bind must
    parse so the WHERE clause compares datetime-to-datetime."""
    td = GravelTimestamp()
    got = td.process_bind_param("2026-05-19", _FakeDialect("postgresql"))
    assert isinstance(got, datetime)
    assert got.year == 2026 and got.month == 5 and got.day == 19
