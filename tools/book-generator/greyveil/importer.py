"""Conservative DOCX-to-Greyveil source import.

The importer preserves Word text and semantic structure; it does not rewrite
manuscript prose or create a second rendering pipeline.
"""

from __future__ import annotations

import copy
import json
import os
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from docx import Document
from docx.enum.text import WD_BREAK
from docx.oxml.ns import qn

from .jobs import GenerationJob, GenerationStage, utc_now
from .loader import load_book


IMPORTER_SCHEMA_VERSION = "greyveil.docx-import/v1"
SAFE_DEFAULT_PUBLISHER = "Greyveil Editions"
IMAGE_SUFFIXES = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}
STRUCTURE_PATTERNS = (
    (re.compile(r"^chapter\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b", re.I), "chapter"),
    (re.compile(r"^(?:part|arc|phase)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b", re.I), "part"),
)
SPECIAL_UNITS = {
    "copyright": "frontmatter",
    "disclaimer": "frontmatter",
    "dedication": "dedication",
    "author's note": "frontmatter",
    "authors note": "frontmatter",
    "prologue": "prologue",
    "introduction": "introduction",
    "epilogue": "epilogue",
    "final reflection": "ending",
    "about the author": "frontmatter",
}


@dataclass
class ImportResult:
    status: str
    job: GenerationJob
    manuscript: Path
    slug: str = ""
    book_path: Path | None = None
    metadata: dict[str, str] = field(default_factory=dict)
    missing_fields: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    error: str = ""


def slugify(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return normalized or "untitled-book"


def import_docx(
    repo_root: Path,
    manuscript_path: Path,
    *,
    design_from: str = "the-last-shift",
    cover_path: Path | None = None,
    metadata_overrides: dict[str, str] | None = None,
) -> ImportResult:
    job = GenerationJob()
    manuscript_path = manuscript_path.resolve()
    job.advance(GenerationStage.IMPORTING)
    if manuscript_path.suffix.casefold() != ".docx" or not manuscript_path.is_file():
        return failed_result(job, manuscript_path, "Input must be an existing .docx manuscript.")

    try:
        document = Document(manuscript_path)
    except Exception as exc:  # noqa: BLE001 - provide a useful import result.
        return failed_result(job, manuscript_path, f"Could not parse DOCX: {exc}")

    job.advance(GenerationStage.NORMALIZING)
    parsed = parse_manuscript(document)
    metadata = detect_metadata(document, parsed["opening"])
    # Founder review happens before generation. Only explicit, non-empty admin
    # corrections replace detected values; manuscript text is never rewritten.
    for key, value in (metadata_overrides or {}).items():
        if isinstance(value, str) and value.strip():
            metadata[key] = value.strip()
    title = metadata.get("title", "")
    slug = slugify(title) if title else ""
    selected_cover = find_cover(manuscript_path, cover_path)
    missing_fields = []
    if not title:
        missing_fields.append("title")
    if not metadata.get("author"):
        missing_fields.append("author")
    if not selected_cover:
        missing_fields.append("cover")
    if not parsed["units"]:
        missing_fields.append("manuscript structure")
    if missing_fields:
        message = "Needs founder confirmation: " + ", ".join(missing_fields) + "."
        job.add_warning(message)
        return ImportResult(
            status="needs_attention",
            job=job,
            manuscript=manuscript_path,
            slug=slug,
            metadata=metadata,
            missing_fields=missing_fields,
            warnings=list(job.warnings),
        )

    destination = repo_root / "assets" / "books" / slug
    if destination.exists():
        return attention_result(job, manuscript_path, slug, metadata, f"Destination already exists: {destination}")

    reference = repo_root / "assets" / "books" / design_from
    if not (reference / "design-spec.json").is_file() or not (reference / "theme.css").is_file():
        return failed_result(job, manuscript_path, f"Design reference is not usable: {design_from}")

    staging: Path | None = Path(tempfile.mkdtemp(prefix=f".{slug}.import-", dir=destination.parent))
    try:
        write_imported_source(staging, parsed, metadata, slug, reference, selected_cover, manuscript_path)
        job.advance(GenerationStage.VALIDATING_SOURCE)
        staging_model = load_book(repo_root, staging.name)
        errors = [issue.message for issue in staging_model.issues if issue.severity == "error"]
        if errors:
            return failed_result(job, manuscript_path, "Imported source did not validate: " + "; ".join(errors), slug, metadata)
        for issue in staging_model.issues:
            if issue.severity == "warning":
                job.add_warning(issue.message)
        if destination.exists():
            return attention_result(job, manuscript_path, slug, metadata, f"Destination already exists: {destination}")
        os.replace(staging, destination)
        staging = None
        return ImportResult(
            status="imported",
            job=job,
            manuscript=manuscript_path,
            slug=slug,
            book_path=destination,
            metadata=metadata,
            warnings=list(job.warnings),
        )
    except Exception as exc:  # noqa: BLE001 - keep source failures separate from generator failures.
        return failed_result(job, manuscript_path, f"Could not finalize imported source: {exc}", slug, metadata)
    finally:
        if staging is not None and staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


def parse_manuscript(document: Document) -> dict[str, list[dict[str, Any]]]:
    opening: list[dict[str, Any]] = []
    units: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    image_counter = 0

    for paragraph_index, paragraph in enumerate(document.paragraphs, start=1):
        text = paragraph.text
        style_name = paragraph.style.name if paragraph.style else ""
        classification = classify_structure(text, style_name)
        if classification and classification[0] != "subheading":
            current = new_unit(classification[0], text, paragraph_index, len(units))
            units.append(current)
            continue

        block_type = "heading" if classification and classification[0] == "subheading" else paragraph_block_type(style_name)
        blocks = blocks_from_paragraph(paragraph, paragraph_index, block_type)
        image_blocks = image_blocks_from_paragraph(paragraph, paragraph_index, image_counter)
        image_counter += len(image_blocks)
        blocks.extend(image_blocks)
        if not blocks:
            continue

        if current is None:
            opening.extend(blocks)
        else:
            current["elements"].extend(blocks)

    if current is None and opening:
        # A title-page-only document is not a usable manuscript; its structure is
        # reported as needs_attention by the caller instead of inventing chapters.
        return {"opening": opening, "units": []}
    return {"opening": opening, "units": units}


def classify_structure(text: str, style_name: str) -> tuple[str, str] | None:
    normalized = text.strip()
    if not normalized:
        return None
    style = style_name.casefold()
    if style.startswith("heading 2") or style.startswith("heading 3"):
        return ("subheading", normalized)
    for label, kind in SPECIAL_UNITS.items():
        if normalized.casefold() == label:
            return (kind, normalized)
    for pattern, kind in STRUCTURE_PATTERNS:
        if pattern.match(normalized):
            return (kind, normalized)
    if style.startswith("heading 1"):
        return ("chapter", normalized)
    return None


def paragraph_block_type(style_name: str) -> str:
    style = style_name.casefold()
    if "quote" in style or "epigraph" in style:
        return "quote"
    return "paragraph"


def blocks_from_paragraph(paragraph, paragraph_index: int, block_type: str) -> list[dict[str, Any]]:
    text = paragraph.text
    has_page_break = paragraph.paragraph_format.page_break_before or any(run_has_page_break(run) for run in paragraph.runs)
    if not text:
        blocks = []
        if has_page_break:
            blocks.append({"type": "section-break", "sourceParagraph": paragraph_index, "sourcePageBreak": True})
        blocks.append({"type": "space", "sourceParagraph": paragraph_index})
        return blocks
    blocks: list[dict[str, Any]] = []
    if has_page_break:
        blocks.append({"type": "section-break", "sourceParagraph": paragraph_index, "sourcePageBreak": True})
    runs = [
        {key: value for key, value in {"text": run.text, "bold": run.bold, "italic": run.italic}.items() if value not in (None, "")}
        for run in paragraph.runs
        if run.text
    ]
    block: dict[str, Any] = {"type": block_type, "runs": runs or [{"text": text}], "sourceParagraph": paragraph_index}
    role = opening_role(paragraph.style.name if paragraph.style else "", text)
    if role:
        block["role"] = role
    if block_type == "heading":
        block["level"] = heading_level(paragraph.style.name if paragraph.style else "")
    blocks.append(block)
    return blocks


def run_has_page_break(run) -> bool:
    return any(
        element.tag.endswith("}br") and element.get(qn("w:type")) == "page"
        for element in run._element.iter()
    )


def image_blocks_from_paragraph(paragraph, paragraph_index: int, start_index: int) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    try:
        blips = paragraph._p.xpath(".//a:blip")
    except Exception:  # pragma: no cover - depends on nonstandard Word XML.
        return blocks
    for offset, blip in enumerate(blips, start=1):
        rel_id = blip.get(qn("r:embed"))
        if not rel_id:
            continue
        image_part = paragraph.part.related_parts.get(rel_id)
        if not image_part:
            continue
        blocks.append(
            {
                "type": "image",
                "sourceParagraph": paragraph_index,
                "_imageBlob": image_part.blob,
                "_imageSuffix": IMAGE_SUFFIXES.get(image_part.content_type, ".bin"),
                "_imageIndex": start_index + offset,
            }
        )
    return blocks


def opening_role(style_name: str, text: str) -> str:
    style = style_name.casefold()
    if style == "title" or "book title" in style:
        return "title"
    if style == "subtitle" or "book subtitle" in style:
        return "subtitle-line"
    if "author" in style:
        return "author"
    if "collection" in style:
        return "collection-line"
    if "series" in style:
        return "series-line"
    if "publisher" in style or "imprint" in style:
        return "publisher"
    if "book number" in style:
        return "book-number"
    if re.fullmatch(r"book\s+[ivxlcdm\d.]+", text.strip(), re.I):
        return "book-number"
    return ""


def heading_level(style_name: str) -> int:
    match = re.search(r"heading\s+([123])", style_name, flags=re.I)
    return int(match.group(1)) if match else 2


def new_unit(kind: str, title: str, paragraph_index: int, index: int) -> dict[str, Any]:
    identifier = slugify(title) or f"unit-{index + 1:02d}"
    return {
        "id": identifier,
        "kind": kind,
        "label": title,
        "title": title,
        "shortTitle": title,
        "index": index,
        "sourceHeadingParagraphs": [paragraph_index],
        "sourceRange": [paragraph_index, paragraph_index],
        "elements": [],
    }


def detect_metadata(document: Document, opening: list[dict[str, Any]]) -> dict[str, str]:
    properties = document.core_properties
    opening_values: dict[str, str] = {}
    for block in opening:
        role = str(block.get("role", ""))
        text = block_text(block)
        if role == "title" and "title" not in opening_values:
            opening_values["title"] = text
        elif role == "subtitle-line" and "subtitle" not in opening_values:
            opening_values["subtitle"] = text
        elif role == "author" and "author" not in opening_values:
            opening_values["author"] = text
        elif role == "collection-line" and "collection" not in opening_values:
            opening_values["collection"] = text
        elif role == "series-line" and "series" not in opening_values:
            opening_values["series"] = text
        elif role == "book-number" and "bookNumber" not in opening_values:
            opening_values["bookNumber"] = text
        elif role == "publisher" and "publisher" not in opening_values:
            opening_values["publisher"] = text
    core = {
        "title": string_value(properties.title),
        "subtitle": string_value(properties.subject),
        "author": string_value(properties.author),
        "language": string_value(getattr(properties, "language", "")),
    }
    metadata = {key: value for key, value in {**opening_values, **{key: value for key, value in core.items() if value}}.items() if value}
    metadata.setdefault("publisher", SAFE_DEFAULT_PUBLISHER)
    return metadata


def string_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def block_text(block: dict[str, Any]) -> str:
    return "".join(str(run.get("text", "")) for run in block.get("runs", []) if isinstance(run, dict)).strip()


def find_cover(manuscript: Path, explicit_cover: Path | None) -> Path | None:
    if explicit_cover:
        candidate = explicit_cover.resolve()
        return candidate if candidate.is_file() and candidate.suffix.casefold() in {".jpg", ".jpeg", ".png"} else None
    names = {
        f"{manuscript.stem}-cover.jpg".casefold(),
        f"{manuscript.stem}-cover.jpeg".casefold(),
        f"{manuscript.stem}-cover.png".casefold(),
        "cover.jpg",
        "cover.jpeg",
        "cover.png",
    }
    for candidate in manuscript.parent.iterdir():
        if candidate.is_file() and candidate.name.casefold() in names:
            return candidate
    return None


def write_imported_source(
    target: Path,
    parsed: dict[str, list[dict[str, Any]]],
    metadata: dict[str, str],
    slug: str,
    reference: Path,
    cover_source: Path,
    manuscript_path: Path,
) -> None:
    # The caller reserves this uniquely named staging directory before writing.
    target.mkdir(parents=True, exist_ok=True)
    (target / "chapters").mkdir()
    (target / "cover").mkdir()
    shutil.copy2(reference / "theme.css", target / "theme.css")
    write_json(target / "design-spec.json", imported_design(reference / "design-spec.json", metadata, slug, cover_source))

    cover_name = f"front-cover{cover_source.suffix.casefold()}"
    shutil.copy2(cover_source, target / "cover" / cover_name)
    # Relative cover roles validate in the staging directory and remain valid
    # once that directory is atomically renamed to the final slug.
    cover_repo_path = f"cover/{cover_name}"
    units = materialize_units(parsed, target, metadata, slug)
    book_json: dict[str, Any] = {
        "id": slug,
        "slug": slug,
        "title": metadata["title"],
        "author": metadata["author"],
        "publisher": metadata.get("publisher", SAFE_DEFAULT_PUBLISHER),
        "designSpecFile": "design-spec.json",
        "themeStylesheet": "theme.css",
        "cover": {
            "web": cover_repo_path,
            "print": cover_repo_path,
            "source": cover_repo_path,
            "alt": f"{metadata['title']} book cover",
        },
        "units": [unit_summary(unit) for unit in units],
    }
    for key in ("subtitle", "collection", "series", "bookNumber", "language", "copyright"):
        if metadata.get(key):
            book_json[key] = metadata[key]
    write_json(target / "book.json", book_json)
    write_json(
        target / "import-manifest.json",
        {
            "schemaVersion": IMPORTER_SCHEMA_VERSION,
            "sourceManuscript": manuscript_path.name,
            "importedAt": utc_now(),
            "detectedMetadata": metadata,
            "designReference": reference.name,
            "coverSource": cover_source.name,
            "warnings": [],
        },
    )


def materialize_units(
    parsed: dict[str, list[dict[str, Any]]], target: Path, metadata: dict[str, str], slug: str
) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []
    if any(block.get("role") == "title" for block in parsed["opening"]):
        opening = {
            "id": "opening",
            "kind": "opening",
            "label": "Opening",
            "title": metadata["title"],
            "shortTitle": "Opening",
            "index": 0,
            "openingMode": "source",
            "elements": parsed["opening"],
        }
        units.append(opening)
    units.extend(copy.deepcopy(parsed["units"]))
    seen_ids: set[str] = set()
    for index, unit in enumerate(units):
        base = unit["id"]
        suffix = 2
        while unit["id"] in seen_ids:
            unit["id"] = f"{base}-{suffix}"
            suffix += 1
        seen_ids.add(unit["id"])
        unit["index"] = index
        unit["file"] = f"chapters/{index:02d}-{unit['id']}.json"
        unit["sourceRange"] = source_range(unit)
        materialize_inline_images(unit["elements"], target)
        write_json(target / unit["file"], unit)
    return units


def materialize_inline_images(elements: list[dict[str, Any]], target: Path) -> None:
    image_dir = target / "images"
    for block in elements:
        blob = block.pop("_imageBlob", None)
        suffix = block.pop("_imageSuffix", "")
        index = block.pop("_imageIndex", None)
        if blob is None or index is None:
            continue
        image_dir.mkdir(exist_ok=True)
        name = f"inline-{index:03d}{suffix}"
        (image_dir / name).write_bytes(blob)
        block["src"] = f"images/{name}"


def source_range(unit: dict[str, Any]) -> list[int]:
    numbers = [int(block.get("sourceParagraph", 0)) for block in unit["elements"] if block.get("sourceParagraph")]
    heading = unit.get("sourceHeadingParagraphs", [])
    numbers.extend(int(value) for value in heading)
    return [min(numbers), max(numbers)] if numbers else [0, 0]


def unit_summary(unit: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "kind", "label", "title", "shortTitle", "file", "index", "sourceRange", "openingMode")
    return {key: unit[key] for key in keys if key in unit}


def imported_design(reference_path: Path, metadata: dict[str, str], slug: str, cover_source: Path) -> dict[str, Any]:
    raw = json.loads(reference_path.read_text(encoding="utf-8"))
    for key in ("bookSlug", "title", "collection", "series", "coverSpecification", "generationContract", "implementationBoundary"):
        raw.pop(key, None)
    raw["bookSlug"] = slug
    raw["title"] = metadata["title"]
    if metadata.get("collection"):
        raw["collection"] = metadata["collection"]
    if metadata.get("series"):
        raw["series"] = metadata["series"]
    raw["coverSpecification"] = {
        "sourceAsset": {"importedFilename": cover_source.name},
        "imageFitBehavior": "Use object-fit: contain. Preserve complete artwork and aspect ratio; do not crop or stretch.",
    }
    raw["generationContract"] = {
        "contractVersion": IMPORTER_SCHEMA_VERSION,
        "sourceOfTruth": "Imported manuscript normalized into Greyveil source blocks.",
        "sourceFiles": {"bookMetadata": "book.json", "chaptersDirectory": "chapters/", "coverDirectory": "cover/"},
    }
    return raw


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def failed_result(
    job: GenerationJob, manuscript: Path, error: str, slug: str = "", metadata: dict[str, str] | None = None
) -> ImportResult:
    job.fail(error)
    return ImportResult("failed", job, manuscript, slug=slug, metadata=metadata or {}, error=error, warnings=list(job.warnings))


def attention_result(
    job: GenerationJob, manuscript: Path, slug: str, metadata: dict[str, str], warning: str
) -> ImportResult:
    job.add_warning(warning)
    return ImportResult(
        "needs_attention",
        job,
        manuscript,
        slug=slug,
        metadata=metadata,
        warnings=list(job.warnings),
    )
