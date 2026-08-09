"""Load Greyveil reader source files into a normalized Step 12A model."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

from .design import load_design_spec
from .models import BookAsset, BookMetadata, BookModel, ChapterBlock, ChapterUnit, ValidationIssue
from .utils import first_string, int_or_default, load_json, resolve_repo_path


SUPPORTED_BLOCK_TYPES = {
    "paragraph",
    "space",
    "toc-line",
    "toc-heading",
    "toc-chapter",
    "quote",
    "section-break",
    "divider",
    "heading",
    "image",
}


def load_book(repo_root: Path, slug: str) -> BookModel:
    issues: List[ValidationIssue] = []
    book_root = repo_root / "assets" / "books" / slug

    if not book_root.exists():
        issues.append(ValidationIssue("error", f"Book folder not found: {book_root}"))

    book_json_path = book_root / "book.json"
    book_json: Dict[str, Any] = {}
    if book_json_path.exists():
        try:
            book_json = load_json(book_json_path)
        except Exception as exc:  # noqa: BLE001 - validation should collect readable errors.
            issues.append(ValidationIssue("error", f"Could not parse book.json: {exc}"))
    else:
        issues.append(ValidationIssue("error", f"Missing book.json: {book_json_path}"))

    metadata = build_metadata(book_json, slug)

    design_file = first_string(book_json.get("designSpecFile"), "design-spec.json")
    design_path = resolve_repo_path(repo_root, book_root, design_file) or (book_root / "design-spec.json")
    design = load_design_spec(design_path, issues)

    theme_file = first_string(book_json.get("themeStylesheet"), book_json.get("themeStylesheetFile"), "theme.css")
    theme_path = resolve_repo_path(repo_root, book_root, theme_file) or (book_root / "theme.css")
    if not theme_path.exists():
        issues.append(ValidationIssue("error", f"Missing theme stylesheet: {theme_path}"))

    cover_assets = locate_cover_assets(repo_root, book_root, book_json, issues)
    chapters = load_chapters(book_root, issues)

    return BookModel(
        slug=slug,
        root_path=book_root,
        metadata=metadata,
        design=design,
        theme_path=theme_path if theme_path.exists() else None,
        cover_assets=cover_assets,
        chapters=chapters,
        issues=issues,
    )


def build_metadata(book_json: Dict[str, Any], fallback_slug: str) -> BookMetadata:
    return BookMetadata(
        id=first_string(book_json.get("id"), fallback_slug),
        slug=first_string(book_json.get("slug"), fallback_slug),
        title=first_string(book_json.get("title"), fallback_slug),
        subtitle=first_string(book_json.get("subtitle")),
        collection=first_string(book_json.get("collection")),
        volume=first_string(book_json.get("volume")),
        series=first_string(book_json.get("series"), book_json.get("seriesDisplay")),
        book_number=first_string(book_json.get("bookNumber"), book_json.get("book_number")),
        author=first_string(book_json.get("author")),
        publisher=first_string(book_json.get("publisher")),
        edition_year=first_string(book_json.get("editionYear")),
    )


def locate_cover_assets(
    repo_root: Path,
    book_root: Path,
    book_json: Dict[str, Any],
    issues: List[ValidationIssue],
) -> List[BookAsset]:
    cover = book_json.get("cover") if isinstance(book_json.get("cover"), dict) else {}
    configured = {
        "web": first_string(cover.get("web"), book_json.get("coverUrl")),
        "print": first_string(cover.get("print")),
        "source": first_string(cover.get("source")),
    }

    assets: List[BookAsset] = []
    for role, source_path in configured.items():
        resolved = resolve_repo_path(repo_root, book_root, source_path) if source_path else None
        exists = bool(resolved and resolved.exists())
        assets.append(BookAsset(role=role, source_path=source_path, resolved_path=resolved, exists=exists))
        if source_path and not exists:
            issues.append(ValidationIssue("error", f"Configured {role} cover missing: {source_path}"))

    cover_dir = book_root / "cover"
    if not cover_dir.exists():
        issues.append(ValidationIssue("error", f"Missing cover folder: {cover_dir}"))
    elif not any(cover_dir.iterdir()):
        issues.append(ValidationIssue("error", f"Cover folder is empty: {cover_dir}"))

    if not any(asset.role == "web" and asset.exists for asset in assets):
        issues.append(ValidationIssue("error", "No usable web cover asset was found."))

    return assets


def load_chapters(book_root: Path, issues: List[ValidationIssue]) -> List[ChapterUnit]:
    chapters_dir = book_root / "chapters"
    if not chapters_dir.exists():
        issues.append(ValidationIssue("error", f"Missing chapters folder: {chapters_dir}"))
        return []

    chapter_files = sorted(chapters_dir.glob("*.json"))
    if not chapter_files:
        issues.append(ValidationIssue("error", f"No chapter JSON files found in: {chapters_dir}"))
        return []

    units: List[ChapterUnit] = []
    seen_indexes = set()
    for fallback_index, path in enumerate(chapter_files):
        try:
            raw = load_json(path)
        except Exception as exc:  # noqa: BLE001
            issues.append(ValidationIssue("error", f"Could not parse chapter file {path.name}: {exc}"))
            continue

        index = int_or_default(raw.get("index"), fallback_index)
        if index in seen_indexes:
            issues.append(ValidationIssue("warning", f"Duplicate chapter index {index} in {path.name}."))
        seen_indexes.add(index)

        blocks = normalize_blocks(raw.get("elements", []), issues, path.name)
        units.append(
            ChapterUnit(
                id=first_string(raw.get("id"), path.stem),
                kind=first_string(raw.get("kind"), "chapter"),
                title=first_string(raw.get("title"), path.stem),
                short_title=first_string(raw.get("shortTitle"), raw.get("title"), path.stem),
                file_name=path.name,
                index=index,
                blocks=blocks,
                raw=raw,
            )
        )

    units.sort(key=lambda unit: (unit.index, unit.file_name))
    return units


def normalize_blocks(elements: Any, issues: List[ValidationIssue], file_name: str) -> List[ChapterBlock]:
    if not isinstance(elements, list):
        issues.append(ValidationIssue("error", f"{file_name} has no elements array."))
        return []

    blocks: List[ChapterBlock] = []
    for item in elements:
        if not isinstance(item, dict):
            issues.append(ValidationIssue("warning", f"{file_name} contains a non-object content element."))
            continue

        block_type = first_string(item.get("type"), "paragraph")
        if block_type not in SUPPORTED_BLOCK_TYPES:
            issues.append(ValidationIssue("warning", f"{file_name} contains unrecognized block type: {block_type}"))

        blocks.append(
            ChapterBlock(
                type=block_type,
                text=element_text(item),
                html=first_string(item.get("html")),
                raw=item,
            )
        )

    return blocks


def element_text(item: Dict[str, Any]) -> str:
    direct = first_string(item.get("text"), item.get("content"), item.get("label"))
    if direct:
        return direct

    runs = item.get("runs")
    if not isinstance(runs, list):
        return ""

    parts = []
    for run in runs:
        if isinstance(run, dict):
            value = run.get("text", run.get("content", ""))
            parts.append(value if isinstance(value, str) else str(value))
        elif isinstance(run, str):
            parts.append(run)
    return "".join(parts).strip()
