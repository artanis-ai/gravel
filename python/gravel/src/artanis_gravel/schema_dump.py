"""Dumps a normalized text representation of the SQLAlchemy schema.

Used by the schema-drift CI check. Produces output diff-able with
packages/sdk-ts/src/schema/dump.ts output.
"""
from __future__ import annotations

import sys

from .schema import ALL_TABLES


_TYPE_MAP = {
    "VARCHAR": "text",
    "TEXT": "text",
    "STRING": "text",
    "JSON": "json",
    "JSONB": "json",
    "INTEGER": "integer",
    "BIGINT": "integer",
    "BIGINTEGER": "integer",
    "DATETIME": "timestamp",
    "TIMESTAMP": "timestamp",
    # GravelTimestamp is the custom TypeDecorator declared in
    # schema.py: BIGINT on SQLite, TIMESTAMPTZ on Postgres. The drift
    # CI compares at the logical level (what kind of value lives in
    # this column?), not per-dialect storage, so we collapse it to
    # the same "timestamp" label the TS Drizzle postgres schema dumps.
    "GRAVELTIMESTAMP": "timestamp",
    "BOOLEAN": "boolean",
}


def _normalize_type(col) -> str:
    raw = type(col.type).__name__.upper()
    return _TYPE_MAP.get(raw, raw.lower())


def _fk_target(col) -> str | None:
    for fk in col.foreign_keys:
        return f"{fk.column.table.name}.{fk.column.name}"
    return None


def dump() -> str:
    out = []
    for table in sorted(ALL_TABLES, key=lambda t: t.name):
        out.append(f"TABLE {table.name}")
        for col in sorted(table.columns, key=lambda c: c.name):
            flags = []
            if not col.nullable and not col.primary_key:
                flags.append("NOT NULL")
            # Drift compare: treat any default as equivalent. TS
            # Drizzle's `.default(now)` and Python SQLAlchemy's
            # Python-side `default=<callable>` both mean "user
            # doesn't have to supply this on insert"; the dump
            # shouldn't distinguish the SQL-side vs Python-side
            # variant, only the presence of a default.
            if col.server_default is not None or col.default is not None:
                flags.append("DEFAULT")
            target = _fk_target(col)
            if target:
                flags.append(f"FK -> {target}")
            line = f"  {col.name} {_normalize_type(col)}"
            if flags:
                line += " " + " ".join(flags)
            out.append(line)
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def main() -> None:
    sys.stdout.write(dump())


if __name__ == "__main__":
    main()
