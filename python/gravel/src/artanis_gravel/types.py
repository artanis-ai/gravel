"""Public type surface — Python mirror of packages/sdk-ts/src/types.ts.

Stable across minor versions. Spec: gravel-cloud/docs/spec/api-surface.md
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, TypedDict

GravelRole = Literal["user", "admin"]


@dataclass
class GravelUser:
    id: str
    first_name: str
    role: GravelRole
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class GravelRequest:
    """Framework-agnostic request shape passed to get_user."""

    url: str
    method: str
    headers: dict[str, str]
    cookies: dict[str, str]
    raw: Any  # framework-native request object (FastAPI Request, Django HttpRequest, etc.)


class GravelDatabaseConfig(TypedDict, total=False):
    url: str
    table_prefix: str  # default 'gravel_'


GetUserFn = Callable[[GravelRequest], "GravelUser | None | Awaitable[GravelUser | None]"]
RunPipelineFn = Callable[[Any], "Any | Awaitable[Any]"]


class GravelAuthConfig(TypedDict, total=False):
    get_user: GetUserFn
    default_password: str


class GravelEvalsConfig(TypedDict, total=False):
    concurrency: dict  # {"trace": int, "live": int}
    judge_version: str  # "auto" | "v1" | "v2" | ...


@dataclass
class GravelConfig:
    database: GravelDatabaseConfig
    auth: GravelAuthConfig
    mount_path: str = "/admin/ai"
    product_name: str = "Gravel"
    run_pipeline: RunPipelineFn | None = None
    environments: list[str] = field(default_factory=lambda: ["prod"])
    hide_artanis_branding: bool = False
    evals: GravelEvalsConfig = field(default_factory=lambda: {})
    scrub_input: Callable[[Any], Any] | None = None
    scrub_output: Callable[[Any], Any] | None = None


# ---------- Defaults ----------

DEFAULT_MOUNT_PATH = "/admin/ai"
DEFAULT_PRODUCT_NAME = "Gravel"
DEFAULT_TABLE_PREFIX = "gravel_"
DEFAULT_CONCURRENCY = {"trace": 5, "live": 2}
DEFAULT_ENVIRONMENT = "prod"


def define_config(**kwargs) -> GravelConfig:
    """Helper for explicit config construction."""
    return GravelConfig(**kwargs)


@dataclass
class ResolvedGravelConfig:
    database: dict
    auth: GravelAuthConfig
    mount_path: str
    product_name: str
    environments: list[str]
    hide_artanis_branding: bool
    evals: dict
    run_pipeline: RunPipelineFn | None = None
    scrub_input: Callable[[Any], Any] | None = None
    scrub_output: Callable[[Any], Any] | None = None


def resolve_config(config: GravelConfig) -> ResolvedGravelConfig:
    """Apply defaults + validate. Mirrors src/types.ts resolveConfig."""
    auth = config.auth or {}
    if not auth.get("get_user") and not auth.get("default_password"):
        raise ValueError(
            "[gravel] Auth misconfigured: provide either auth['get_user'] or "
            "auth['default_password']."
        )
    if auth.get("get_user") and auth.get("default_password"):
        warnings.warn(
            "[gravel] Both get_user and default_password set; default password ignored.",
            stacklevel=2,
        )

    db = dict(config.database)
    db.setdefault("table_prefix", DEFAULT_TABLE_PREFIX)

    evals = dict(config.evals)
    concurrency = dict(evals.get("concurrency", {}))
    concurrency.setdefault("trace", DEFAULT_CONCURRENCY["trace"])
    concurrency.setdefault("live", DEFAULT_CONCURRENCY["live"])
    evals["concurrency"] = concurrency
    evals.setdefault("judge_version", "auto")

    return ResolvedGravelConfig(
        database=db,
        auth=auth,
        mount_path=config.mount_path or DEFAULT_MOUNT_PATH,
        product_name=config.product_name or DEFAULT_PRODUCT_NAME,
        environments=list(config.environments) if config.environments else [DEFAULT_ENVIRONMENT],
        hide_artanis_branding=bool(config.hide_artanis_branding),
        evals=evals,
        run_pipeline=config.run_pipeline,
        scrub_input=config.scrub_input,
        scrub_output=config.scrub_output,
    )
