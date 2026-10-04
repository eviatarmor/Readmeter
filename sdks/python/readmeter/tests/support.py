"""Shared test helpers. Tests run against the real Rust core, never a mock."""

from __future__ import annotations

import json
from pathlib import Path

from readmeter import _ffi

HASH_KEY = "000102030405060708090a0b0c0d0e0f"

ROOT = _ffi.repo_root() or Path(__file__).resolve().parents[4]
FIXTURES = ROOT / "conformance" / "fixtures"


def fixture_paths() -> list[Path]:
    return sorted(FIXTURES.rglob("*.json"))


def load_fixture(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))
