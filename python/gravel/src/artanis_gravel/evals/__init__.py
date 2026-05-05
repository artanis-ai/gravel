"""Eval runner — bounded-concurrency batch judging for trace + live runs."""
from __future__ import annotations

from .runner import Result, Row, RunResult, run_eval

__all__ = ["run_eval", "Row", "Result", "RunResult"]
