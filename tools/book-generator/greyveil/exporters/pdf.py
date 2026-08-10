"""Reader-faithful PDF exporter for Greyveil books."""

from __future__ import annotations

import html
from pathlib import Path
from typing import List, Sequence

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import inch
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
    block_html,
    block_plain_text,
    book_number_label,
    hide_folio_for_unit,
    is_quote_block,
    output_path,
    preferred_cover,
    theme_from_model,
    unit_label,
    unit_phase,
    unit_subtitle,
)


BODY_FONT = "GreyveilBody"
DISPLAY_FONT = "GreyveilDisplay"
SANS_FONT = "GreyveilSans"


class SectionRule(Flowable):
    def __init__(
        self,
        width: float = 96,
        color=colors.HexColor("#7E8F9B"),
        *,
        align: str = "left",
        height: float = 24,
    ):
        super().__init__()
        self.width = width
        self.height = height
        self.color = color
        self.align = align

    def wrap(self, _available_width, _available_height):
        return self.width, self.height

    def draw(self):
        self.canv.saveState()
        self.canv.setStrokeColor(self.color)
        self.canv.setLineWidth(0.6)
        y = self.height / 2
        self.canv.line(0, y + 3, self.width * 0.72, y + 3)
        self.canv.line(14, y - 3, self.width, y - 3)
        self.canv.restoreState()


class FullBleedCover(Flowable):
    """Draw the cover image to the complete PDF trim box."""

    def __init__(self, image_path: Path, page_size: tuple[float, float]):
        super().__init__()
        self.image_path = image_path
        self.page_width, self.page_height = page_size
        self.width = self.page_width
        self.height = self.page_height

    def wrap(self, _available_width, _available_height):
        return self.page_width, self.page_height

    def draw(self):
        with PILImage.open(self.image_path) as source:
            image_width, image_height = source.size
        scale = max(self.page_width / image_width, self.page_height / image_height)
        draw_width = image_width * scale
        draw_height = image_height * scale
        x = (self.page_width - draw_width) / 2
        y = (self.page_height - draw_height) / 2
        self.canv.drawImage(
            str(self.image_path),
            x,
            y,
            width=draw_width,
            height=draw_height,
            preserveAspectRatio=False,
            mask="auto",
        )


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

    register_fonts()
    styles = build_styles(theme)
    story: List[Flowable] = []

    append_cover(story, model, page_size)
    append_opening_page(story, model, styles, theme)
    append_units(story, model.chapters, styles, theme)

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
                onPageEnd=lambda canvas, template_doc: draw_page_folio(canvas, template_doc, theme, page_size),
            ),
        ]
    )
    doc.build(story)
    return destination


def export_pdf_prototype(model: BookModel, repo_root: Path, output: Path | None = None) -> Path:
    destination = output or repo_root / "output" / "pdf" / f"{model.slug}-prototype.pdf"
    return export_pdf(model, repo_root, destination)


def register_fonts() -> None:
    font_candidates = {
        BODY_FONT: [
            Path("C:/Windows/Fonts/georgia.ttf"),
            Path("C:/Windows/Fonts/times.ttf"),
        ],
        DISPLAY_FONT: [
            Path("C:/Windows/Fonts/georgia.ttf"),
            Path("C:/Windows/Fonts/times.ttf"),
        ],
        SANS_FONT: [
            Path("C:/Windows/Fonts/arial.ttf"),
        ],
    }

    for name, candidates in font_candidates.items():
        if name in pdfmetrics.getRegisteredFontNames():
            continue
        for path in candidates:
            if path.exists():
                pdfmetrics.registerFont(TTFont(name, str(path)))
                break
        else:
            fallback = "Helvetica" if name == SANS_FONT else "Times-Roman"
            pdfmetrics.registerFontFamily(name, normal=fallback)


def build_styles(theme: ExportTheme):
    sheet = getSampleStyleSheet()
    text_color = colors.HexColor(theme.text)
    heading_color = colors.HexColor(theme.heading)
    accent = colors.HexColor(theme.accent)
    muted = colors.HexColor(theme.muted)

    sheet.add(
        ParagraphStyle(
            name="GreyveilOpeningSeries",
            parent=sheet["Normal"],
            fontName=SANS_FONT,
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
            fontName=DISPLAY_FONT,
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
            fontName=DISPLAY_FONT,
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
            fontName=SANS_FONT,
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
            fontName=DISPLAY_FONT,
            fontSize=theme.chapter_title_size_pt,
            leading=theme.chapter_title_size_pt * 1.08,
            alignment=TA_LEFT,
            textColor=heading_color,
            spaceAfter=20,
        )
    )
    sheet.add(
        ParagraphStyle(
            name="GreyveilChapterNumber",
            parent=sheet["Normal"],
            fontName=SANS_FONT,
            fontSize=theme.chapter_number_size_pt,
            leading=theme.chapter_number_size_pt + 2,
            alignment=TA_LEFT,
            textColor=accent,
            spaceAfter=8,
        )
    )
    sheet.add(
        ParagraphStyle(
            name="GreyveilBody",
            parent=sheet["BodyText"],
            fontName=BODY_FONT,
            fontSize=theme.body_size_pt,
            leading=theme.body_line_pt,
            firstLineIndent=theme.first_line_indent_in * inch,
            alignment=TA_LEFT,
            textColor=text_color,
            spaceAfter=4,
        )
    )
    sheet.add(
        ParagraphStyle(
            name="GreyveilFrontMatter",
            parent=sheet["BodyText"],
            fontName=BODY_FONT,
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
            fontName=SANS_FONT,
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
            fontName=DISPLAY_FONT,
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
            fontName=DISPLAY_FONT,
            fontSize=22,
            leading=27,
            alignment=TA_CENTER,
            textColor=accent,
            spaceBefore=10,
            spaceAfter=10,
        )
    )
    return sheet


def append_cover(story: List[Flowable], model: BookModel, page_size: tuple[float, float]) -> None:
    cover = preferred_cover(model.cover_assets)
    if cover and cover.resolved_path and cover.resolved_path.exists():
        story.append(FullBleedCover(cover.resolved_path, page_size))
    story.append(NextPageTemplate("body"))
    story.append(PageBreak())


def append_opening_page(story: List[Flowable], model: BookModel, styles, theme: ExportTheme) -> None:
    metadata = model.metadata
    story.append(FolioPolicy(True))
    story.append(Spacer(1, 1.18 * inch))
    story.append(SectionRule(width=96, color=colors.HexColor(theme.accent), height=26))
    if metadata.series:
        story.append(Paragraph(escape(metadata.series.upper()), styles["GreyveilOpeningSeries"]))
    if metadata.book_number:
        story.append(Paragraph(escape(book_number_label(metadata.book_number).upper()), styles["GreyveilOpeningSeries"]))
    story.append(Spacer(1, 0.16 * inch))
    story.append(Paragraph(escape(metadata.title.upper()), styles["GreyveilOpeningTitle"]))
    if metadata.subtitle:
        story.append(Paragraph(escape(metadata.subtitle), styles["GreyveilSubtitle"]))
    story.append(Spacer(1, 0.34 * inch))
    if metadata.author:
        story.append(Paragraph(escape(metadata.author), styles["GreyveilMeta"]))
    if metadata.publisher:
        publisher = metadata.publisher
        if metadata.edition_year:
            publisher = f"{publisher} {metadata.edition_year}"
        story.append(Paragraph(escape(publisher), styles["GreyveilMeta"]))
    story.append(PageBreak())


def append_units(story: List[Flowable], units: Sequence[ChapterUnit], styles, theme: ExportTheme) -> None:
    exported = 0
    for unit_index, unit in enumerate(units):
        if unit.kind == "opening":
            continue
        if exported > 0:
            story.append(PageBreak())
        exported += 1

        story.append(FolioPolicy(hide_folio_for_unit(unit)))
        append_unit_header(story, unit, styles, theme)

        for block in unit.blocks:
            append_block(story, block, unit, styles)


def append_unit_header(story: List[Flowable], unit: ChapterUnit, styles, theme: ExportTheme) -> None:
    if unit.kind == "dedication":
        story.append(Spacer(1, 1.42 * inch))
        story.append(SectionRule(width=74, color=colors.HexColor(theme.accent), height=30))
        story.append(Paragraph(escape(unit.title), styles["GreyveilDedication"]))
        return

    top_space = 0.32 * inch if unit.kind == "chapter" else 0.22 * inch
    story.append(Spacer(1, top_space))
    story.append(SectionRule(width=86 if unit.kind == "chapter" else 72, color=colors.HexColor(theme.accent)))

    phase = unit_phase(unit)
    if phase:
        story.append(Paragraph(escape(phase.upper()), styles["GreyveilChapterNumber"]))
    elif unit.kind == "chapter":
        story.append(Paragraph(escape(unit_label(unit).upper()), styles["GreyveilChapterNumber"]))
    elif unit.kind:
        story.append(Paragraph(escape(unit.kind.upper()), styles["GreyveilChapterNumber"]))

    story.append(Paragraph(escape(unit.title), styles["GreyveilUnitTitle"]))
    subtitle = unit_subtitle(unit)
    if subtitle:
        story.append(Paragraph(escape(subtitle), styles["GreyveilSubtitle"]))


def append_block(story: List[Flowable], block: ChapterBlock, unit: ChapterUnit, styles) -> None:
    if block.type == "space":
        story.append(Spacer(1, 0.18 * inch))
        return
    if block.type in {"section-break", "divider"}:
        story.append(SectionRule())
        return

    text = block_html(block)
    if not text:
        return

    if is_quote_block(block.type):
        story.append(Paragraph(text, styles["GreyveilQuote"]))
    elif block.type.startswith("toc-"):
        story.append(Paragraph(text, styles["GreyveilContents"]))
    elif block.type == "heading":
        story.append(Paragraph(text, styles["GreyveilUnitTitle"]))
    elif unit.kind == "dedication":
        story.append(Paragraph(text, styles["GreyveilDedication"]))
    elif unit.kind in {"frontmatter", "contents"}:
        story.append(Paragraph(text, styles["GreyveilFrontMatter"]))
    else:
        story.append(Paragraph(text, styles["GreyveilBody"]))


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


def draw_page_folio(canvas, doc, theme: ExportTheme, page_size: tuple[float, float]) -> None:
    if getattr(canvas, "_greyveil_hide_folio", False):
        return
    if doc.page <= 1:
        return
    canvas.saveState()
    width, _height = page_size
    canvas.setStrokeColor(colors.HexColor(theme.accent))
    canvas.setFillColor(colors.HexColor(theme.subtle))
    canvas.setLineWidth(0.35)
    canvas.line((width / 2) - 12, 0.36 * inch, (width / 2) + 12, 0.36 * inch)
    try:
        canvas.setFont(SANS_FONT, 8)
    except Exception:  # noqa: BLE001 - fallback if a PDF font is unavailable.
        canvas.setFont("Helvetica", 8)
    canvas.drawCentredString(width / 2, 0.24 * inch, str(max(1, doc.page - 1)))
    canvas.restoreState()


def escape(value: str) -> str:
    block = ChapterBlock(type="paragraph", text=value or "")
    return html.escape(block_plain_text(block)).replace("\n", "<br/>")
