"""Utility helpers for Greyveil source loading."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional


def load_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return data


def resolve_repo_path(repo_root: Path, book_root: Path, source_path: str) -> Optional[Path]:
    if not source_path or not isinstance(source_path, str):
        return None

    normalized = source_path.strip().replace("\\", "/")
    if normalized.startswith("/"):
        return repo_root / normalized.lstrip("/")

    return book_root / normalized


def first_string(*values: Any) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float)):
            return str(value)
    return ""


def int_or_default(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
