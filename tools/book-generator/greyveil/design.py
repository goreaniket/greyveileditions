"""Design-spec validation helpers."""

from __future__ import annotations

from pathlib import Path
from typing import List

from .models import DesignSpec, ValidationIssue
from .utils import load_json


REQUIRED_DESIGN_KEYS = (
    "bookSlug",
    "title",
    "coverSpecification",
    "colorSystem",
    "typography",
    "pageGeometry",
    "semanticPageTypes",
)


def load_design_spec(path: Path, issues: List[ValidationIssue]) -> DesignSpec | None:
    if not path.exists():
        issues.append(ValidationIssue("error", f"Missing design spec: {path}"))
        return None

    try:
        raw = load_json(path)
    except Exception as exc:  # noqa: BLE001 - keep validation reporting friendly.
        issues.append(ValidationIssue("error", f"Could not parse design spec: {exc}"))
        return None

    for key in REQUIRED_DESIGN_KEYS:
        if key not in raw:
            issues.append(ValidationIssue("error", f"design-spec.json missing required key: {key}"))

    has_export_contract = isinstance(raw.get("generationContract"), dict)
    if not has_export_contract:
        issues.append(ValidationIssue("warning", "design-spec.json has no generationContract block yet."))

    return DesignSpec(source_path=path, raw=raw, has_export_contract=has_export_contract)
