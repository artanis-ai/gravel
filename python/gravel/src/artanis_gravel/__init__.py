"""artanis-gravel — embedded prompt management, tracing, and evals.

Public API surface:

    from artanis_gravel import GravelConfig, GravelUser, define_config
    from artanis_gravel import judge_call, run_eval, Verdict, JudgeError

Spec: gravel-cloud/docs/spec/api-surface.md
"""
from .analyze import AnalyzeError, AnalyzeIssue, AnalyzeResponse, AnalyzeUsage, analyze_prompt
from .evals import Result, Row, RunResult, run_eval
from .judge import CriterionVerdict, JudgeError, JudgeResponse, Verdict, judge_call
from .tracing import (
    awith_gravel_metadata,
    awith_tracing_disabled,
    gravel_context,
    set_gravel_tracing_config,
    with_gravel_metadata,
    with_gravel_metadata_call,
    with_tracing_disabled,
)
from .types import (
    DEFAULT_MOUNT_PATH,
    DEFAULT_PRODUCT_NAME,
    DEFAULT_TABLE_PREFIX,
    GravelAuthConfig,
    GravelConfig,
    GravelDatabaseConfig,
    GravelEvalsConfig,
    GravelRequest,
    GravelUser,
    define_config,
    resolve_config,
)

__all__ = [
    "GravelConfig",
    "GravelUser",
    "GravelRequest",
    "GravelDatabaseConfig",
    "GravelAuthConfig",
    "GravelEvalsConfig",
    "define_config",
    "resolve_config",
    "DEFAULT_MOUNT_PATH",
    "DEFAULT_PRODUCT_NAME",
    "DEFAULT_TABLE_PREFIX",
    "judge_call",
    "Verdict",
    "JudgeResponse",
    "CriterionVerdict",
    "JudgeError",
    "run_eval",
    "Row",
    "Result",
    "RunResult",
    "analyze_prompt",
    "AnalyzeError",
    "AnalyzeIssue",
    "AnalyzeResponse",
    "AnalyzeUsage",
    "gravel_context",
    "with_gravel_metadata",
    "with_gravel_metadata_call",
    "awith_gravel_metadata",
    "with_tracing_disabled",
    "awith_tracing_disabled",
    "set_gravel_tracing_config",
]

__version__ = "0.0.1"
