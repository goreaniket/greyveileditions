"""Dataclasses for the Step 12A normalized book model."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


JsonObject = Dict[str, Any]


@dataclass(frozen=True)
class ValidationIssue:
    severity: str
    message: str


@dataclass(frozen=True)
class BookMetadata:
    id: str
    slug: str
    title: str
    subtitle: str
    collection: str
    volume: str
    series: str
    book_number: str
    author: str
    publisher: str
    edition_year: str


@dataclass(frozen=True)
class BookAsset:
    role: str
    source_path: str
    resolved_path: Optional[Path]
    exists: bool


@dataclass(frozen=True)
class ChapterBlock:
    type: str
    text: str = ""
    html: str = ""
    raw: JsonObject = field(default_factory=dict)


@dataclass(frozen=True)
class ChapterUnit:
    id: str
    kind: str
    title: str
    short_title: str
    file_name: str
    index: int
    blocks: List[ChapterBlock]
    raw: JsonObject = field(default_factory=dict)


@dataclass(frozen=True)
class DesignSpec:
    source_path: Path
    raw: JsonObject
    has_export_contract: bool


@dataclass(frozen=True)
class BookModel:
    slug: str
    root_path: Path
    metadata: BookMetadata
    design: Optional[DesignSpec]
    theme_path: Optional[Path]
    cover_assets: List[BookAsset]
    chapters: List[ChapterUnit]
    issues: List[ValidationIssue]

    @property
    def cover_ok(self) -> bool:
        return any(asset.role == "web" and asset.exists for asset in self.cover_assets)

    @property
    def design_ok(self) -> bool:
        return self.design is not None

    @property
    def theme_ok(self) -> bool:
        return self.theme_path is not None and self.theme_path.exists()

    @property
    def block_types(self) -> List[str]:
        types = {block.type for chapter in self.chapters for block in chapter.blocks}
        return sorted(types)
