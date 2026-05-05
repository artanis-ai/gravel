"""artanis-gravel — embedded prompt management, tracing, and evals.

Public API surface:

    from artanis_gravel import GravelConfig, GravelUser, define_config

Spec: gravel-cloud/docs/spec/api-surface.md
"""
from .types import (
    GravelConfig,
    GravelUser,
    GravelRequest,
    GravelDatabaseConfig,
    GravelAuthConfig,
    GravelEvalsConfig,
    define_config,
    resolve_config,
    DEFAULT_MOUNT_PATH,
    DEFAULT_PRODUCT_NAME,
    DEFAULT_TABLE_PREFIX,
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
]

__version__ = "0.0.1"
