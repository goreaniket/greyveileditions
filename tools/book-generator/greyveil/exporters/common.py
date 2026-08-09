"""Shared helpers for Greyveil book exporters."""

from __future__ import annotations

import html
import mimetypes
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Sequence

from greyveil.models import BookAsset, BookModel, ChapterBlock, ChapterUnit
from greyveil.utils import first_string


TRIM_WIDTH_IN = 5.5
TRIM_HEIGHT_IN = 8.5


@dataclass(frozen=True)
class ExportTheme:
    trim_width_in: float
    trim_height_in: float
    inside_margin_in: float
    outside_margin_in: float
    top_margin_in: float
    bottom_margin_in: float
    gutter_in: float
    body_font: str
    display_font: str
    sans_font: str
    body_size_pt: float
    body_line_pt: float
    first_line_indent_in: float
    title_size_pt: float
    chapter_title_size_pt: float
    chapter_number_size_pt: float
    contents_size_pt: float
    paper: str
    paper_soft: str
    text: str
    heading: str
    muted: str
    subtle: str
    rule: str
    accent: str
    accent_strong: str
    warm: str

    @property
    def content_width_in(self) -> float:
        return (
            self.trim_width_in
            - self.inside_margin_in
            - self.outside_margin_in
            - self.gutter_in
        )


def theme_from_model(model: BookModel, *, print_mode: bool = False) -> ExportTheme:
    design = model.design.raw if model.design else {}
    mapping = export_mapping(design, print_mode=print_mode)
    colors = design.get("colorSystem", {}).get("light", {}) if isinstance(design, dict) else {}
    fonts = design.get("fonts", {}) if isinstance(design, dict) else {}
    print_palette = mapping.get("printPalette", {}) if isinstance(mapping, dict) else {}

    gutter = parse_inches(mapping.get("gutterMargin"), 0.14 if print_mode else 0.0)
    trim_value = first_string(
        mapping.get("trimSize"),
        mapping.get("pageSize"),
        mapping.get("pageBox"),
        "5.5in x 8.5in",
    )
    body_size_pt = parse_points(first_string(mapping.get("bodyFontSize"), mapping.get("body")), 11.5)

    return ExportTheme(
        trim_width_in=parse_trim(trim_value, TRIM_WIDTH_IN, 0),
        trim_height_in=parse_trim(trim_value, TRIM_HEIGHT_IN, 1),
        inside_margin_in=parse_inches(first_string(mapping.get("insideMargin"), mapping.get("innerMargin")), 0.72),
        outside_margin_in=parse_inches(first_string(mapping.get("outsideMargin"), mapping.get("outerMargin")), 0.62),
        top_margin_in=parse_inches(mapping.get("topMargin"), 0.72),
        bottom_margin_in=parse_inches(mapping.get("bottomMargin"), 0.74),
        gutter_in=gutter,
        body_font=font_primary(first_string(mapping.get("bodyFont"), mapping.get("body"), fonts.get("body"), "Georgia")),
        display_font=font_primary(first_string(mapping.get("displayFont"), fonts.get("display"), "Georgia")),
        sans_font=font_primary(first_string(fonts.get("interface"), "Arial")),
        body_size_pt=body_size_pt,
        body_line_pt=parse_leading(first_string(mapping.get("bodyLineSpacing"), mapping.get("lineSpacing")), body_size_pt, 18.7),
        first_line_indent_in=parse_inches(mapping.get("firstLineIndent"), 0.18),
        title_size_pt=parse_points(mapping.get("titleSize"), 49.0),
        chapter_title_size_pt=parse_points(first_string(mapping.get("chapterTitleSize"), mapping.get("chapterTitle")), 29.0),
        chapter_number_size_pt=parse_points(mapping.get("chapterNumberSize"), 10.0),
        contents_size_pt=parse_points(mapping.get("contentsEntrySize"), 8.8),
        paper=hex_color(first_string(print_palette.get("paper"), colors.get("paper")), "#F7F1E6"),
        paper_soft=hex_color(first_string(colors.get("paperSoft")), "#EFE7D9"),
        text=hex_color(first_string(print_palette.get("text"), colors.get("text")), "#24303C"),
        heading=hex_color(first_string(colors.get("heading")), "#192533"),
        muted=hex_color(first_string(colors.get("mutedText")), "#5D6976"),
        subtle=hex_color(first_string(colors.get("subtleText")), "#7E8791"),
        rule=hex_color(first_string(colors.get("pageRule")), "#D8D2C8"),
        accent=hex_color(first_string(print_palette.get("accent"), colors.get("accent")), "#405678"),
        accent_strong=hex_color(first_string(colors.get("accentStrong")), "#2E3F61"),
        warm=hex_color(
            first_string(colors.get("warmMist"), colors.get("warm"), colors.get("warmCounterpoint"), colors.get("mist")),
            "#7E8F9B",
        ),
    )


def export_mapping(design: dict, *, print_mode: bool) -> dict:
    if not isinstance(design, dict):
        return {}

    combined = design.get("futureWordPdfMapping")
    if isinstance(combined, dict):
        return combined

    pdf = design.get("futurePdfMapping")
    word = design.get("futureWordMapping")
    merged: dict = {}
    if isinstance(pdf, dict):
        merged.update(pdf)
    if isinstance(word, dict):
        merged.update(word)

    if print_mode and isinstance(word, dict):
        merged.update(word)
    elif not print_mode and isinstance(pdf, dict):
        merged.update(pdf)

    return merged


def parse_points(value: object, fallback: float) -> float:
    return parse_number(value, fallback)


def parse_leading(value: object, body_size_pt: float, fallback: float) -> float:
    parsed = parse_number(value, fallback)
    if parsed <= 3:
        return body_size_pt * parsed
    return parsed


def parse_inches(value: object, fallback: float) -> float:
    return parse_number(value, fallback)


def parse_trim(value: object, fallback: float, index: int) -> float:
    if not isinstance(value, str):
        return fallback
    values = [float(match) for match in re.findall(r"([0-9]+(?:\.[0-9]+)?)", value)]
    return values[index] if len(values) > index else fallback


def parse_number(value: object, fallback: float) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return fallback
    match = re.search(r"([0-9]+(?:\.[0-9]+)?)", value)
    return float(match.group(1)) if match else fallback


def hex_color(value: str, fallback: str) -> str:
    if isinstance(value, str):
        match = re.search(r"#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])", value)
        if match:
            raw = match.group(1)
            if len(raw) == 3:
                raw = "".join(ch * 2 for ch in raw)
            return f"#{raw.upper()}"
    return fallback.upper()


def hex_no_hash(value: str) -> str:
    return hex_color(value, "#000000").lstrip("#")


def font_primary(font_stack: str) -> str:
    if not font_stack:
        return "Georgia"
    return font_stack.split(",")[0].strip().strip("\"'")


def css_font_stack(primary: str, fallback: str) -> str:
    if " " in primary:
        return f"'{primary}', {fallback}"
    return f"{primary}, {fallback}"


def preferred_cover(
    assets: Iterable[BookAsset],
    roles: Sequence[str] = ("print", "web", "source"),
) -> BookAsset | None:
    available = {asset.role: asset for asset in assets if asset.exists and asset.resolved_path}
    for role in roles:
        asset = available.get(role)
        if asset:
            return asset
    return next(iter(available.values()), None)


def book_number_label(value: str) -> str:
    clean = value.strip()
    return clean if clean.lower().startswith("book ") else f"Book {clean}"


def unit_label(unit: ChapterUnit) -> str:
    return first_string(unit.raw.get("label"), unit.raw.get("number"), unit.short_title, unit.title)


def unit_phase(unit: ChapterUnit) -> str:
    return first_string(unit.raw.get("phase"))


def unit_subtitle(unit: ChapterUnit) -> str:
    return first_string(unit.raw.get("subtitle"))


def hide_folio_for_unit(unit: ChapterUnit) -> bool:
    return unit.kind in {"opening", "contents", "dedication", "feedback"}


def iter_text_runs(block: ChapterBlock) -> Iterator[tuple[str, bool, bool]]:
    runs = block.raw.get("runs")
    if isinstance(runs, list):
        for run in runs:
            if isinstance(run, dict):
                value = run.get("text", run.get("content", ""))
                text = value if isinstance(value, str) else str(value)
                if text:
                    yield text, bool(run.get("bold")), bool(run.get("italic"))
            elif isinstance(run, str) and run:
                yield run, False, False
        return

    text = block.text or html_to_plain(block.html)
    if text:
        yield text, False, False


def block_plain_text(block: ChapterBlock) -> str:
    return "".join(text for text, _bold, _italic in iter_text_runs(block)).strip()


def block_html(block: ChapterBlock) -> str:
    parts: list[str] = []
    for text, bold, italic in iter_text_runs(block):
        escaped = html.escape(text).replace("\n", "<br/>")
        if italic:
            escaped = f"<em>{escaped}</em>"
        if bold:
            escaped = f"<strong>{escaped}</strong>"
        parts.append(escaped)
    if parts:
        return "".join(parts)
    return html.escape(block_plain_text(block)).replace("\n", "<br/>")


def html_to_plain(value: str) -> str:
    if not value:
        return ""
    text = re.sub(r"<br\s*/?>", "\n", value, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text).strip()


def safe_xml_id(value: str, fallback: str = "item") -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip()).strip("-").lower()
    if not slug:
        slug = fallback
    if slug[0].isdigit():
        slug = f"{fallback}-{slug}"
    return slug


def media_type_for(path: Path) -> str:
    guessed, _encoding = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def output_path(repo_root: Path, subdir: str, slug: str, suffix: str, explicit: Path | None = None) -> Path:
    if explicit:
        path = explicit
    else:
        path = repo_root / "output" / subdir / f"{slug}{suffix}"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path
