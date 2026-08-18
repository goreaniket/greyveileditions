"""Reader-faithful PDF exporter for Greyveil books."""

from __future__ import annotations

import html
import os
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import List, Sequence

import reportlab
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import inch
from reportlab.lib.rl_accel import unicode2T1
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch as reportlab_inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
)
from PIL import Image as PILImage

from greyveil.models import BookModel, ChapterBlock, ChapterUnit
from greyveil.exporters.common import (
    ExportTheme,
    block_plain_text,
    book_number_label,
    hide_folio_for_unit,
    is_quote_block,
    iter_text_runs,
    output_path,
    preferred_cover,
    theme_from_model,
    unit_label,
    unit_phase,
    unit_subtitle,
)


GENERIC_FONT_FAMILIES = {"cursive", "fantasy", "monospace", "sans-serif", "serif", "system-ui"}
VARIATION_SELECTORS = range(0xFE00, 0xFE10)
SPECIAL_GLYPH_FONTS = {
    "→": "Symbol",
    "≠": "Symbol",
    "✦": "ZapfDingbats",
}
FONT_FILES = {
    "cormorant garamond": {
        "normal": ("CormorantGaramond-Regular.ttf", "CormorantGaramond-Medium.ttf"),
        "bold": ("CormorantGaramond-Bold.ttf", "CormorantGaramond-SemiBold.ttf"),
        "italic": ("CormorantGaramond-Italic.ttf", "CormorantGaramond-MediumItalic.ttf"),
        "bold_italic": ("CormorantGaramond-BoldItalic.ttf", "CormorantGaramond-SemiBoldItalic.ttf"),
    },
    "georgia": {
        "normal": ("georgia.ttf", "Georgia.ttf"),
        "bold": ("georgiab.ttf", "Georgia Bold.ttf"),
        "italic": ("georgiai.ttf", "Georgia Italic.ttf"),
        "bold_italic": ("georgiaz.ttf", "Georgia Bold Italic.ttf"),
    },
    "times new roman": {
        "normal": ("times.ttf", "Times New Roman.ttf"),
        "bold": ("timesbd.ttf", "Times New Roman Bold.ttf"),
        "italic": ("timesi.ttf", "Times New Roman Italic.ttf"),
        "bold_italic": ("timesbi.ttf", "Times New Roman Bold Italic.ttf"),
    },
    "inter": {
        "normal": ("Inter-Regular.ttf",),
        "bold": ("Inter-Bold.ttf", "Inter-SemiBold.ttf"),
        "italic": ("Inter-Italic.ttf",),
        "bold_italic": ("Inter-BoldItalic.ttf", "Inter-SemiBoldItalic.ttf"),
    },
    "arial": {
        "normal": ("arial.ttf", "Arial.ttf"),
        "bold": ("arialbd.ttf", "Arial Bold.ttf"),
        "italic": ("ariali.ttf", "Arial Italic.ttf"),
        "bold_italic": ("arialbi.ttf", "Arial Bold Italic.ttf"),
    },
}


@dataclass(frozen=True)
class PdfFontFace:
    name: str
    coverage: frozenset[int] | None = None


@dataclass(frozen=True)
class PdfFontFamily:
    family: str
    normal: PdfFontFace | None
    bold: PdfFontFace | None
    italic: PdfFontFace | None
    bold_italic: PdfFontFace | None

    def variant(self, *, bold: bool = False, italic: bool = False) -> PdfFontFace | None:
        if bold and italic:
            return self.bold_italic
        if bold:
            return self.bold
        if italic:
            return self.italic
        return self.normal


@dataclass(frozen=True)
class PdfFontRole:
    name: str
    requested: tuple[str, ...]
    families: tuple[PdfFontFamily, ...]

    def primary(self, *, bold: bool = False, italic: bool = False) -> str:
        for family in self.families:
            face = family.variant(bold=bold, italic=italic)
            if face:
                return face.name
        raise ValueError(f"No usable PDF font face for the {self.name} role")

    def font_for(self, char: str, *, bold: bool = False, italic: bool = False) -> str | None:
        if ord(char) in VARIATION_SELECTORS:
            return None
        for family in self.families:
            face = family.variant(bold=bold, italic=italic)
            if face and font_supports(face, char):
                return face.name
        fallback = SPECIAL_GLYPH_FONTS.get(char)
        if fallback:
            return fallback
        codepoint = f"U+{ord(char):04X}"
        name = unicodedata.name(char, "UNKNOWN CHARACTER")
        requested = " → ".join(self.requested)
        raise ValueError(f"Unsupported PDF glyph {codepoint} {name} in {self.name} font stack: {requested}")


@dataclass(frozen=True)
class PdfFontSet:
    body: PdfFontRole
    display: PdfFontRole
    sans: PdfFontRole


class SectionRule(Flowable):
    def __init__(
        self,
        primary_width: float,
        secondary_width: float,
        color=colors.HexColor("#7E8F9B"),
        *,
        horizontal_offset: float,
        vertical_offset: float,
        align: str = "left",
        height: float = 24,
    ):
        super().__init__()
        self.primary_width = primary_width
        self.secondary_width = secondary_width
        self.horizontal_offset = horizontal_offset
        self.vertical_offset = vertical_offset
        self.width = max(primary_width, horizontal_offset + secondary_width)
        self.height = height
        self.color = color
        self.align = align
        self.hAlign = align.upper()

    def wrap(self, _available_width, _available_height):
        return self.width, self.height

    def draw(self):
        self.canv.saveState()
        self.canv.setStrokeColor(self.color)
        self.canv.setLineWidth(0.6)
        y = self.height / 2
        self.canv.line(0, y + (self.vertical_offset / 2), self.primary_width, y + (self.vertical_offset / 2))
        self.canv.line(
            self.horizontal_offset,
            y - (self.vertical_offset / 2),
            self.horizontal_offset + self.secondary_width,
            y - (self.vertical_offset / 2),
        )
        self.canv.restoreState()


class FullBleedCover(Flowable):
    """Fit the complete cover artwork within the PDF trim box."""

    def __init__(self, image_path: Path, page_size: tuple[float, float], theme: ExportTheme):
        super().__init__()
        self.image_path = image_path
        self.page_width, self.page_height = page_size
        self.theme = theme
        self.width = self.page_width
        self.height = self.page_height

    def wrap(self, _available_width, _available_height):
        return self.page_width, self.page_height

    def draw(self):
        with PILImage.open(self.image_path) as source:
            image_width, image_height = source.size
        scale_fn = min if self.theme.cover_fit == "contain" else max
        scale = scale_fn(self.page_width / image_width, self.page_height / image_height)
        draw_width = image_width * scale
        draw_height = image_height * scale
        x = (self.page_width - draw_width) / 2
        y = (self.page_height - draw_height) / 2
        self.canv.saveState()
        self.canv.setFillColor(colors.HexColor(self.theme.paper))
        self.canv.rect(0, 0, self.page_width, self.page_height, stroke=0, fill=1)
        self.canv.drawImage(
            str(self.image_path),
            x,
            y,
            width=draw_width,
            height=draw_height,
            preserveAspectRatio=True,
            mask="auto",
        )
        self.canv.restoreState()


class FolioPolicy(Flowable):
    def __init__(self, hide_folio: bool):
        super().__init__()
        self.hide_folio = hide_folio

    def wrap(self, _available_width, _available_height):
        return 0, 0

    def draw(self):
        self.canv._greyveil_hide_folio = self.hide_folio


def export_pdf(model: BookModel, repo_root: Path, output: Path | None = None) -> Path:
    errors = [issue.message for issue in model.issues if issue.severity == "error"]
    if errors:
        raise ValueError("Cannot export PDF with validation errors: " + "; ".join(errors))

    destination = output_path(repo_root, "pdf", model.slug, ".pdf", output)
    theme = theme_from_model(model)
    page_size = (theme.trim_width_in * reportlab_inch, theme.trim_height_in * reportlab_inch)

    fonts = resolve_pdf_fonts(theme, repo_root, model)
    styles = build_styles(theme, fonts)
    story: List[Flowable] = []

    append_cover(story, model, theme, page_size)
    append_opening_page(story, model, styles, theme, fonts)
    append_units(story, model.chapters, styles, theme, fonts)

    doc = BaseDocTemplate(
        str(destination),
        pagesize=page_size,
        leftMargin=theme.inside_margin_in * inch,
        rightMargin=theme.outside_margin_in * inch,
        topMargin=theme.top_margin_in * inch,
        bottomMargin=theme.bottom_margin_in * inch,
        title=model.metadata.title,
        author=model.metadata.author,
    )
    cover_frame = Frame(0, 0, page_size[0], page_size[1], id="cover", leftPadding=0, bottomPadding=0, rightPadding=0, topPadding=0)
    body_frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="body")
    doc.addPageTemplates(
        [
            PageTemplate(id="cover", frames=[cover_frame]),
            PageTemplate(
                id="body",
                frames=[body_frame],
                onPage=lambda canvas, template_doc: draw_page_base(canvas, template_doc, theme, page_size),
                onPageEnd=lambda canvas, template_doc: draw_page_folio(canvas, template_doc, theme, page_size, fonts),
            ),
        ]
    )
    doc.build(story)
    return destination


def export_pdf_prototype(model: BookModel, repo_root: Path, output: Path | None = None) -> Path:
    destination = output or repo_root / "output" / "pdf" / f"{model.slug}-prototype.pdf"
    return export_pdf(model, repo_root, destination)


def resolve_pdf_fonts(theme: ExportTheme, repo_root: Path, model: BookModel) -> PdfFontSet:
    font_index = index_font_files(font_search_roots(repo_root, model))
    return PdfFontSet(
        body=resolve_font_role("body", theme.body_font_stack, font_index, fallback_kind="serif"),
        display=resolve_font_role("display", theme.display_font_stack, font_index, fallback_kind="serif"),
        sans=resolve_font_role("sans", theme.sans_font_stack, font_index, fallback_kind="sans"),
    )


def font_search_roots(repo_root: Path, model: BookModel) -> tuple[Path, ...]:
    roots = [
        model.root_path / "fonts",
        repo_root / "assets" / "fonts",
        repo_root / "tools" / "book-generator" / "fonts",
        Path(reportlab.__file__).resolve().parent / "fonts",
    ]
    if sys.platform == "win32":
        windows_dir = os.environ.get("WINDIR")
        if windows_dir:
            roots.append(Path(windows_dir) / "Fonts")
    elif sys.platform == "darwin":
        roots.extend((Path("/Library/Fonts"), Path("/System/Library/Fonts")))
    else:
        roots.extend((Path("/usr/local/share/fonts"), Path("/usr/share/fonts")))

    unique: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        normalized = str(root.resolve()).casefold() if root.exists() else str(root).casefold()
        if normalized not in seen:
            seen.add(normalized)
            unique.append(root)
    return tuple(unique)


def index_font_files(roots: Sequence[Path]) -> dict[str, Path]:
    indexed: dict[str, Path] = {}
    for root in roots:
        if not root.is_dir():
            continue
        try:
            paths = root.rglob("*")
            for path in paths:
                if path.is_file() and path.suffix.casefold() in {".otf", ".ttf"}:
                    indexed.setdefault(path.name.casefold(), path)
        except OSError:
            continue
    return indexed


def resolve_font_role(
    role_name: str,
    requested: Sequence[str],
    font_index: dict[str, Path],
    *,
    fallback_kind: str,
) -> PdfFontRole:
    families: list[PdfFontFamily] = []
    for family in requested:
        normalized = family.casefold()
        if normalized in GENERIC_FONT_FAMILIES:
            continue
        file_names = FONT_FILES.get(normalized)
        if not file_names:
            continue
        resolved = register_font_family(role_name, family, file_names, font_index)
        if resolved:
            families.append(resolved)

    families.append(standard_font_family(fallback_kind))
    return PdfFontRole(name=role_name, requested=tuple(requested), families=tuple(families))


def register_font_family(
    role_name: str,
    family: str,
    file_names: dict[str, tuple[str, ...]],
    font_index: dict[str, Path],
) -> PdfFontFamily | None:
    faces: dict[str, PdfFontFace | None] = {}
    for variant in ("normal", "bold", "italic", "bold_italic"):
        path = next(
            (font_index[name.casefold()] for name in file_names.get(variant, ()) if name.casefold() in font_index),
            None,
        )
        faces[variant] = register_font_face(role_name, family, variant, path) if path else None

    if not faces["normal"]:
        return None
    return PdfFontFamily(family=family, **faces)


def register_font_face(role_name: str, family: str, variant: str, path: Path) -> PdfFontFace | None:
    family_alias = re.sub(r"[^a-zA-Z0-9]+", "", family)
    variant_alias = "" if variant == "normal" else "".join(part.title() for part in variant.split("_"))
    alias = f"Greyveil{role_name.title()}{family_alias}{variant_alias}"
    try:
        candidate = TTFont(alias, str(path))
        actual_family = candidate.face.familyName.decode("utf-8", errors="replace")
        if normalized_family(actual_family) != normalized_family(family):
            return None
        if alias not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(candidate)
            registered = candidate
        else:
            registered = pdfmetrics.getFont(alias)
    except Exception:  # noqa: BLE001 - an unusable face must fall through to the next declared family.
        return None
    return PdfFontFace(name=alias, coverage=frozenset(registered.face.charWidths))


def normalized_family(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def standard_font_family(kind: str) -> PdfFontFamily:
    if kind == "sans":
        names = ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique")
        family = "Helvetica"
    else:
        names = ("Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic")
        family = "Times"
    return PdfFontFamily(
        family=family,
        normal=PdfFontFace(names[0]),
        bold=PdfFontFace(names[1]),
        italic=PdfFontFace(names[2]),
        bold_italic=PdfFontFace(names[3]),
    )


def font_supports(face: PdfFontFace, char: str) -> bool:
    if face.coverage is not None:
        return ord(char) in face.coverage
    font = pdfmetrics.getFont(face.name)
    encoded = unicode2T1(char, [font])
    return bool(encoded) and all(encoded_font.fontName == face.name for encoded_font, _chunk in encoded)


def build_styles(theme: ExportTheme, fonts: PdfFontSet):
    sheet = getSampleStyleSheet()
    text_color = colors.HexColor(theme.text)
    heading_color = colors.HexColor(theme.heading)
    accent = colors.HexColor(theme.accent)
    muted = colors.HexColor(theme.muted)

    sheet.add(
        ParagraphStyle(
            name="GreyveilOpeningSeries",
            parent=sheet["Normal"],
            fontName=fonts.sans.primary(bold=True),
            fontSize=8.5,
            leading=11,
            alignment=TA_LEFT,
            textColor=colors.HexColor(theme.warm),
            spaceAfter=5,
        )
    )
    sheet.add(
        ParagraphStyle(
            name="GreyveilOpeningTitle",
            parent=sheet["Title"],
            fontName=fonts.display.primary(bold=True),
            fontSize=theme.title_size_pt,
            leading=theme.title_size_pt * 0.98,
            alignment=TA_LEFT,
            textColor=heading_color,
            spaceAfter=12,
        )
    )
    sheet.add(
        ParagraphStyle(
            name="GreyveilSubtitle",
            parent=sheet["Normal"],
            fontName=fonts.display.primary(italic=True),
            fontSize=14.2,
            leading=19,
            alignment=TA_LEFT,
            textColor=muted,
            spaceAfter=28,
        )
    )
    sheet.add(
        ParagraphStyle(
            name="GreyveilMeta",
            parent=sheet["Normal"],
            fontName=fonts.sans.primary(),
            fontSize=8,
            leading=12,
            alignment=TA_LEFT,
            textColor=accent,
            spaceAfter=5,
        )
    )
    sheet.add(
        ParagraphStyle(
            name="GreyveilUnitTitle",
            parent=sheet["Heading1"],
            fontName=fonts.display.primary(bold=True),
            fontSize=theme.chapter_title_size_pt,
            leading=theme.chapter_title_size_pt * 1.08,
            alignment=TA_LEFT,
            textColor=heading_color,
            spaceAfter=theme.opening_body_gap_pt,
        )
    )
    sheet.add(
        ParagraphStyle(
            name="GreyveilChapterNumber",
            parent=sheet["Normal"],
            fontName=fonts.sans.primary(bold=True),
            fontSize=theme.chapter_number_size_pt,
            leading=theme.chapter_number_size_pt + 2,
            alignment=TA_LEFT,
            textColor=accent,
            spaceAfter=theme.opening_kicker_gap_pt,
        )
    )
    sheet.add(
        ParagraphStyle(
            name="GreyveilBody",
            parent=sheet["BodyText"],
            fontName=fonts.body.primary(),
            fontSize=theme.body_size_pt,
            leading=theme.body_line_pt,
            firstLineIndent=theme.first_line_indent_in * inch,
            alignment=TA_LEFT,
            textColor=text_color,
            spaceAfter=theme.paragraph_spacing_pt,
        )
    )
    sheet.add(
        ParagraphStyle(
            name="GreyveilFrontMatter",
            parent=sheet["BodyText"],
            fontName=fonts.body.primary(),
            fontSize=max(9.8, theme.body_size_pt - 1.0),
            leading=16,
            alignment=TA_LEFT,
            textColor=text_color,
            spaceAfter=5,
        )
    )
    sheet.add(
        ParagraphStyle(
            name="GreyveilContents",
            parent=sheet["Normal"],
            fontName=fonts.sans.primary(),
            fontSize=theme.contents_size_pt,
            leading=13,
            textColor=text_color,
            spaceAfter=4,
        )
    )
    sheet.add(
        ParagraphStyle(
            name="GreyveilQuote",
            parent=sheet["BodyText"],
            fontName=fonts.display.primary(italic=True),
            fontSize=13.3,
            leading=18,
            leftIndent=18,
            rightIndent=18,
            textColor=accent,
            spaceBefore=10,
            spaceAfter=10,
        )
    )
    sheet.add(
        ParagraphStyle(
            name="GreyveilDedication",
            parent=sheet["Normal"],
            fontName=fonts.display.primary(italic=True),
            fontSize=22,
            leading=27,
            alignment=TA_CENTER,
            textColor=accent,
            spaceBefore=10,
            spaceAfter=10,
        )
    )
    return sheet


def append_cover(
    story: List[Flowable],
    model: BookModel,
    theme: ExportTheme,
    page_size: tuple[float, float],
) -> None:
    cover = preferred_cover(model.cover_assets)
    if cover and cover.resolved_path and cover.resolved_path.exists():
        story.append(FullBleedCover(cover.resolved_path, page_size, theme))
    story.append(NextPageTemplate("body"))
    story.append(PageBreak())


def append_opening_page(
    story: List[Flowable],
    model: BookModel,
    styles,
    theme: ExportTheme,
    fonts: PdfFontSet,
) -> None:
    metadata = model.metadata
    story.append(FolioPolicy(True))
    story.append(Spacer(1, theme.title_opening_top_in * inch))
    story.append(opening_rule(theme, title=True))
    if metadata.series:
        story.append(Paragraph(pdf_text(metadata.series.upper(), fonts.sans, bold=True), styles["GreyveilOpeningSeries"]))
    if metadata.book_number:
        story.append(
            Paragraph(
                pdf_text(book_number_label(metadata.book_number).upper(), fonts.sans, bold=True),
                styles["GreyveilOpeningSeries"],
            )
        )
    story.append(Spacer(1, 0.16 * inch))
    story.append(Paragraph(pdf_text(metadata.title.upper(), fonts.display, bold=True), styles["GreyveilOpeningTitle"]))
    if metadata.subtitle:
        story.append(Paragraph(pdf_text(metadata.subtitle, fonts.display, italic=True), styles["GreyveilSubtitle"]))
    story.append(Spacer(1, 0.34 * inch))
    if metadata.author:
        story.append(Paragraph(pdf_text(metadata.author, fonts.sans, bold=True), styles["GreyveilMeta"]))
    if metadata.publisher:
        publisher = metadata.publisher
        if metadata.edition_year:
            publisher = f"{publisher} {metadata.edition_year}"
        story.append(Paragraph(pdf_text(publisher, fonts.sans, bold=True), styles["GreyveilMeta"]))
    story.append(PageBreak())


def append_units(
    story: List[Flowable],
    units: Sequence[ChapterUnit],
    styles,
    theme: ExportTheme,
    fonts: PdfFontSet,
) -> None:
    exported = 0
    for unit_index, unit in enumerate(units):
        if unit.kind == "opening":
            continue
        if exported > 0:
            story.append(PageBreak())
        exported += 1

        story.append(FolioPolicy(hide_folio_for_unit(unit, theme)))
        append_unit_header(story, unit, styles, theme, fonts)

        for block in unit.blocks:
            append_block(story, block, unit, styles, fonts)


def append_unit_header(
    story: List[Flowable],
    unit: ChapterUnit,
    styles,
    theme: ExportTheme,
    fonts: PdfFontSet,
) -> None:
    if unit.kind == "dedication":
        story.append(Spacer(1, 1.42 * inch))
        story.append(opening_rule(theme, align="center"))
        story.append(Paragraph(pdf_text(unit.title, fonts.display, italic=True), styles["GreyveilDedication"]))
        return

    story.append(Spacer(1, theme.unit_opening_top_in * inch))
    story.append(opening_rule(theme))

    phase = unit_phase(unit)
    if phase:
        story.append(Paragraph(pdf_text(phase.upper(), fonts.sans, bold=True), styles["GreyveilChapterNumber"]))
    elif unit.kind == "chapter":
        story.append(
            Paragraph(pdf_text(unit_label(unit).upper(), fonts.sans, bold=True), styles["GreyveilChapterNumber"])
        )
    elif unit.kind:
        story.append(Paragraph(pdf_text(unit.kind.upper(), fonts.sans, bold=True), styles["GreyveilChapterNumber"]))

    story.append(Paragraph(pdf_text(unit.title, fonts.display, bold=True), styles["GreyveilUnitTitle"]))
    subtitle = unit_subtitle(unit)
    if subtitle:
        story.append(Paragraph(pdf_text(subtitle, fonts.display, italic=True), styles["GreyveilSubtitle"]))


def append_block(
    story: List[Flowable],
    block: ChapterBlock,
    unit: ChapterUnit,
    styles,
    fonts: PdfFontSet,
) -> None:
    if block.type == "space":
        story.append(Spacer(1, 0.18 * inch))
        return
    if block.type in {"section-break", "divider"}:
        story.append(divider_rule(theme))
        return

    if is_quote_block(block.type):
        role, style_name, italic = fonts.display, "GreyveilQuote", True
    elif block.type.startswith("toc-"):
        role, style_name, italic = fonts.sans, "GreyveilContents", False
    elif block.type == "heading":
        role, style_name, italic = fonts.display, "GreyveilUnitTitle", False
    elif unit.kind == "dedication":
        role, style_name, italic = fonts.display, "GreyveilDedication", True
    elif unit.kind in {"frontmatter", "contents"}:
        role, style_name, italic = fonts.body, "GreyveilFrontMatter", False
    else:
        role, style_name, italic = fonts.body, "GreyveilBody", False

    text = pdf_block_html(block, role, bold=block.type == "heading", italic=italic)
    if text:
        story.append(Paragraph(text, styles[style_name]))


def draw_page_base(canvas, doc, theme: ExportTheme, page_size: tuple[float, float]) -> None:
    canvas.saveState()
    width, height = page_size
    canvas._greyveil_hide_folio = False
    canvas.setFillColor(colors.HexColor(theme.paper))
    canvas.rect(0, 0, width, height, stroke=0, fill=1)
    canvas.setStrokeColor(colors.HexColor(theme.rule))
    canvas.setLineWidth(0.35)
    canvas.line(doc.leftMargin, 0.42 * inch, width - doc.rightMargin, 0.42 * inch)
    canvas.setStrokeColor(colors.HexColor(theme.accent))
    canvas.setLineWidth(0.45)
    canvas.setFillColor(colors.HexColor(theme.accent))
    canvas.setFillAlpha(0.14)
    canvas.rect(0.24 * inch, 0.43 * inch, 0.01 * inch, height - 0.86 * inch, stroke=0, fill=1)
    canvas.restoreState()


def draw_page_folio(
    canvas,
    doc,
    theme: ExportTheme,
    page_size: tuple[float, float],
    fonts: PdfFontSet,
) -> None:
    if getattr(canvas, "_greyveil_hide_folio", False):
        return
    if doc.page <= 1:
        return
    canvas.saveState()
    width, _height = page_size
    canvas.setStrokeColor(colors.HexColor(theme.accent))
    canvas.setFillColor(colors.HexColor(theme.subtle))
    canvas.setLineWidth(0.35)
    folio_y = theme.folio_bottom_in * inch
    half_rule = theme.folio_rule_width_in * inch / 2
    rule_y = folio_y + theme.folio_size_pt + (theme.folio_rule_gap_in * inch)
    canvas.line((width / 2) - half_rule, rule_y, (width / 2) + half_rule, rule_y)
    canvas.setFont(fonts.sans.primary(), theme.folio_size_pt)
    canvas.drawCentredString(width / 2, folio_y, str(max(1, doc.page - 1)))
    canvas.restoreState()


def opening_rule(theme: ExportTheme, *, title: bool = False, align: str = "left") -> SectionRule:
    if title:
        primary = theme.title_rule_primary_in
        secondary = theme.title_rule_secondary_in
        horizontal = theme.title_rule_horizontal_offset_in
        vertical = theme.title_rule_vertical_offset_in
        height = theme.title_rule_vertical_offset_in + theme.title_rule_clearance_in
    else:
        primary = theme.unit_rule_primary_in
        secondary = theme.unit_rule_secondary_in
        horizontal = theme.unit_rule_horizontal_offset_in
        vertical = theme.unit_rule_vertical_offset_in
        height = max(0.24, vertical * 1.8)
    return SectionRule(
        primary * inch,
        secondary * inch,
        color=colors.HexColor(theme.accent),
        horizontal_offset=horizontal * inch,
        vertical_offset=vertical * inch,
        align=align,
        height=height * inch,
    )


def divider_rule(theme: ExportTheme) -> SectionRule:
    return SectionRule(
        theme.divider_primary_width_in * inch,
        theme.divider_secondary_width_in * inch,
        color=colors.HexColor(theme.accent),
        horizontal_offset=theme.divider_horizontal_offset_in * inch,
        vertical_offset=theme.divider_vertical_offset_in * inch,
        height=theme.divider_height_in * inch,
    )


def pdf_text(
    value: str,
    role: PdfFontRole,
    *,
    bold: bool = False,
    italic: bool = False,
) -> str:
    block = ChapterBlock(type="paragraph", text=value or "")
    return pdf_inline_html(block_plain_text(block), role, bold=bold, italic=italic)


def pdf_block_html(
    block: ChapterBlock,
    role: PdfFontRole,
    *,
    bold: bool = False,
    italic: bool = False,
) -> str:
    return "".join(
        pdf_inline_html(text, role, bold=bold or run_bold, italic=italic or run_italic)
        for text, run_bold, run_italic in iter_text_runs(block)
    )


def pdf_inline_html(
    value: str,
    role: PdfFontRole,
    *,
    bold: bool = False,
    italic: bool = False,
) -> str:
    parts: list[str] = []
    current_font: str | None = None
    current_text: list[str] = []

    def flush() -> None:
        if current_font and current_text:
            escaped = html.escape("".join(current_text))
            parts.append(f'<font name="{current_font}">{escaped}</font>')
        current_text.clear()

    for char in value:
        if char == "\n":
            flush()
            current_font = None
            parts.append("<br/>")
            continue
        font_name = role.font_for(char, bold=bold, italic=italic)
        if font_name is None:
            continue
        if font_name != current_font:
            flush()
            current_font = font_name
        current_text.append(char)
    flush()
    return "".join(parts)
