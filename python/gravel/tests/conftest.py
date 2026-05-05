"""Pytest config for the gravel SDK tests."""
from __future__ import annotations

import os

import pytest


@pytest.fixture(autouse=True)
def _clean_gravel_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip ambient GRAVEL_* vars so tests get deterministic env handling.

    Tests that need credentials set them explicitly via monkeypatch.setenv.
    Integration tests bypass this by reading os.environ before the patch
    inside their skipif guard.
    """
    for key in list(os.environ):
        if key.startswith("GRAVEL_"):
            monkeypatch.delenv(key, raising=False)
