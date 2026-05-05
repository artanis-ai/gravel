"""Judge client — talks to the Gravel control-plane judge endpoint.

Public surface:

    from artanis_gravel.judge import judge_call, Verdict, JudgeError, CriterionVerdict
"""
from __future__ import annotations

from .client import (
    CriterionVerdict,
    JudgeError,
    JudgeResponse,
    Verdict,
    judge_call,
)

__all__ = [
    "judge_call",
    "Verdict",
    "JudgeResponse",
    "CriterionVerdict",
    "JudgeError",
]
