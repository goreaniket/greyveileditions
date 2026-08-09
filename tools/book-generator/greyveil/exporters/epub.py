"""EPUB exporter for Greyveil reader-style digital editions."""

from __future__ import annotations

import html
import math
import textwrap
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path

from greyveil.exporters.common import (
    ExportTheme,
    block_html,
    block_plain_text,
    book_number_label,
    css_font_stack,
    hide_folio_for_unit,
    media_type_for,
    output_path,
    preferred_cover,
    safe_xml_id,
    theme_from_model,
    unit_label,
    unit_phase,
    unit_subtitle,
)
from greyveil.models import BookModel, ChapterBlock, ChapterUnit


POINTS_PER_INCH = 72


@dataclass(frozen=True)
class FixedGeometry:
    width_px: int
    height_px: int
    inside_px: int
    outside_px: int
    top_px: int
    bottom_px: int
    content_width_px: int
    content_height_px: int
    body_size_px: float
    line_height_px: float

    @classmethod
    def from_theme(cls, theme: ExportTheme) -> "FixedGeometry":
        width_px = round(theme.trim_width_in * POINTS_PER_INCH)
        height_px = round(theme.trim_height_in * POINTS_PER_INCH)
        inside_px = round(theme.inside_margin_in * POINTS_PER_INCH)
        outside_px = round(theme.outside_margin_in * POINTS_PER_INCH)
        top_px = round(theme.top_margin_in * POINTS_PER_INCH)
        bottom_px = round(theme.bottom_margin_in * POINTS_PER_INCH)
        return cls(
            width_px=width_px,
            height_px=height_px,
            inside_px=inside_px,
            outside_px=outside_px,
            top_px=top_px,
            bottom_px=bottom_px,
            content_width_px=width_px - inside_px - outside_px,
            content_height_px=height_px - top_px - bottom_px,
            body_size_px=theme.body_size_pt,
            line_height_px=theme.body_line_pt,
        )


@dataclass(frozen=True)
class FixedPage:
    id: str
    filename: str
    title: str
    kind: str
    body_html: str
    css_href: str
    nav_label: str = ""
    folio: int | None = None


@dataclass(frozen=True)
class BlockFragment:
    html: str
    plain: str
    type: str
    lines: int


def export_epub(model: BookModel, repo_root: Path, output: Path | None = None) -> Path:
    errors = [issue.message for issue in model.issues if issue.severity == "error"]
    if errors:
        raise ValueError("Cannot export EPUB with validation errors: " + "; ".join(errors))

    destination = output_path(repo_root, "epub", model.slug, ".epub", output)
    theme = theme_from_model(model)
    geometry = FixedGeometry.from_theme(theme)
    identifier = f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, 'greyveil:' + model.slug)}"
    cover = preferred_cover(model.cover_assets, roles=("print", "source", "web"))
    pages = build_fixed_pages(model, theme, geometry, cover)

    with zipfile.ZipFile(destination, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        archive.writestr("META-INF/container.xml", container_xml())
        archive.writestr("EPUB/styles/greyveil-fixed.css", fixed_stylesheet(theme, geometry))
        archive.writestr("EPUB/nav.xhtml", fixed_nav_xhtml(model, pages))
        if cover and cover.resolved_path:
            archive.write(cover.resolved_path, "EPUB/images/cover" + cover.resolved_path.suffix.lower())
        for page in pages:
            archive.writestr("EPUB/" + page.filename, fixed_page_xhtml(page, geometry))
        archive.writestr(
            "EPUB/package.opf",
            fixed_package_opf(model, identifier, pages, cover),
        )

    return destination


def container_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""


def build_fixed_pages(model: BookModel, theme: ExportTheme, geometry: FixedGeometry, cover) -> list[FixedPage]:
    pages: list[FixedPage] = []

    pages.append(
        FixedPage(
            id="cover",
            filename="cover.xhtml",
            title=f"{model.metadata.title} Cover",
            kind="cover",
            css_href="styles/greyveil-fixed.css",
            body_html=cover_page_body(model, cover),
            nav_label="Cover",
        )
    )
    pages.append(
        FixedPage(
            id="title-page",
            filename="pages/p0001-title.xhtml",
            title=f"{model.metadata.title} Title",
            kind="title",
            css_href="../styles/greyveil-fixed.css",
            body_html=title_page_body(model),
            nav_label="Title Page",
        )
    )

    page_index = 2
    folio = 1
    for unit in model.chapters:
        if unit.kind == "opening":
            continue

        unit_pages = build_unit_pages(unit, theme, geometry, start_index=page_index)
        hide_folio = hide_folio_for_unit(unit)
        for unit_page_index, page in enumerate(unit_pages):
            page_index += 1
            nav_label = unit.short_title or unit.title if unit_page_index == 0 else ""
            page_folio = None if hide_folio else folio
            if not hide_folio:
                folio += 1
            pages.append(
                FixedPage(
                    id=page.id,
                    filename=page.filename,
                    title=page.title,
                    kind=page.kind,
                    css_href=page.css_href,
                    body_html=page.body_html,
                    nav_label=nav_label,
                    folio=page_folio,
                )
            )

    return pages


def cover_page_body(model: BookModel, cover) -> str:
    title = html.escape(model.metadata.title)
    if cover and cover.resolved_path:
        return (
            '<main class="page page--cover" epub:type="cover">'
            f'<img class="cover-image" src="images/cover{cover.resolved_path.suffix.lower()}" alt="{title} cover"/>'
            "</main>"
        )
    return (
        '<main class="page page--cover page--cover-fallback" epub:type="cover">'
        f"<h1>{title}</h1>"
        "</main>"
    )


def title_page_body(model: BookModel) -> str:
    metadata = model.metadata
    parts = [
        '<main class="page page--title" epub:type="titlepage">',
        '<div class="title-rule title-rule--a"></div>',
        '<div class="title-rule title-rule--b"></div>',
        '<section class="title-block">',
    ]
    if metadata.series:
        parts.append(f'<p class="title-kicker">{html.escape(metadata.series.upper())}</p>')
    if metadata.book_number:
        parts.append(f'<p class="title-kicker">{html.escape(book_number_label(metadata.book_number).upper())}</p>')
    parts.append(f'<h1>{html.escape(metadata.title.upper())}</h1>')
    if metadata.subtitle:
        parts.append(f'<p class="title-subtitle">{html.escape(metadata.subtitle)}</p>')
    if metadata.author:
        parts.append(f'<p class="title-author">{html.escape(metadata.author)}</p>')
    if metadata.publisher:
        imprint = metadata.publisher
        if metadata.edition_year:
            imprint = f"{imprint} {metadata.edition_year}"
        parts.append(f'<p class="title-imprint">{html.escape(imprint)}</p>')
    parts.extend(["</section>", "</main>"])
    return "\n".join(parts)


def build_unit_pages(
    unit: ChapterUnit,
    theme: ExportTheme,
    geometry: FixedGeometry,
    *,
    start_index: int,
) -> list[FixedPage]:
    fragments = fragments_from_blocks(unit, geometry)
    first_capacity = first_page_capacity(unit, geometry)
    continuation_capacity = continuation_page_capacity(geometry)
    chunks = paginate_fragments(fragments, first_capacity, continuation_capacity, geometry)
    if not chunks:
        chunks = [[]]

    pages: list[FixedPage] = []
    for chunk_index, chunk in enumerate(chunks):
        number = start_index + chunk_index
        first = chunk_index == 0
        filename = f"pages/p{number:04d}-{safe_xml_id(unit.id, 'unit')}"
        if not first:
            filename += f"-{chunk_index + 1}"
        filename += ".xhtml"
        body = unit_page_body(unit, chunk, first=first)
        pages.append(
            FixedPage(
                id=f"{safe_xml_id(unit.id, 'unit')}-{chunk_index + 1}",
                filename=filename,
                title=unit.title,
                kind=unit.kind or "chapter",
                css_href="../styles/greyveil-fixed.css",
                body_html=body,
            )
        )
    return pages


def unit_page_body(unit: ChapterUnit, fragments: list[BlockFragment], *, first: bool) -> str:
    classes = [
        "page",
        "page--unit",
        f"page--{safe_xml_id(unit.kind or 'chapter', 'kind')}",
        "page--unit-first" if first else "page--continuation",
    ]
    parts = [f'<main class="{" ".join(classes)}" data-unit-id="{html.escape(unit.id)}">']
    if first:
        parts.append(unit_fixed_header(unit))
        frame_class = "flow-frame flow-frame--first"
    else:
        frame_class = "flow-frame flow-frame--continuation"
    parts.append(f'<section class="{frame_class}">')
    parts.extend(fragment.html for fragment in fragments)
    parts.append("</section>")
    parts.append("__FOLIO__")
    parts.append("</main>")
    return "\n".join(parts)


def unit_fixed_header(unit: ChapterUnit) -> str:
    phase = unit_phase(unit)
    subtitle = unit_subtitle(unit)
    if unit.kind == "chapter":
        kicker = phase or unit_label(unit)
    elif unit.kind == "part":
        kicker = unit_label(unit)
    else:
        kicker = unit.kind or unit_label(unit)

    parts = [
        '<header class="unit-header">',
        '<span class="reader-rule reader-rule--a"></span>',
        '<span class="reader-rule reader-rule--b"></span>',
    ]
    if kicker:
        parts.append(f'<p class="unit-kicker">{html.escape(kicker.upper())}</p>')
    parts.append(f"<h1>{html.escape(unit.title)}</h1>")
    if subtitle:
        parts.append(f'<p class="unit-subtitle">{html.escape(subtitle)}</p>')
    parts.append("</header>")
    return "\n".join(parts)


def fragments_from_blocks(unit: ChapterUnit, geometry: FixedGeometry) -> list[BlockFragment]:
    fragments: list[BlockFragment] = []
    for block in unit.blocks:
        fragments.extend(block_to_fragments(block, unit, geometry))
    return fragments


def block_to_fragments(block: ChapterBlock, unit: ChapterUnit, geometry: FixedGeometry) -> list[BlockFragment]:
    if block.type == "space":
        return [BlockFragment('<div class="space-break" aria-hidden="true"></div>', "", "space", 1)]
    if block.type in {"section-break", "divider"}:
        return [
            BlockFragment(
                '<div class="reader-section-break" aria-hidden="true"><span></span><span></span></div>',
                "",
                "section-break",
                3,
            )
        ]

    plain = block_plain_text(block)
    if not plain:
        return []

    block_type = block.type
    chars = chars_per_line(block_type, geometry)
    max_lines = max(8, continuation_page_capacity(geometry) - 2)
    pieces = split_text_to_fit(plain, chars * max_lines) if estimated_lines(plain, chars) > max_lines else [plain]
    result: list[BlockFragment] = []
    for piece_index, piece in enumerate(pieces):
        html_text = block_html(block) if len(pieces) == 1 else html.escape(piece)
        result.append(
            BlockFragment(
                fragment_html(block_type, unit, html_text),
                piece,
                block_type,
                line_cost(piece, block_type, geometry, continued=piece_index > 0),
            )
        )
    return result


def fragment_html(block_type: str, unit: ChapterUnit, html_text: str) -> str:
    if block_type == "quote":
        return f'<blockquote class="reader-quote">{html_text}</blockquote>'
    if block_type == "toc-heading":
        return f'<p class="toc-line toc-heading">{html_text}</p>'
    if block_type == "toc-chapter":
        return f'<p class="toc-line toc-chapter">{html_text}</p>'
    if block_type == "toc-line":
        return f'<p class="toc-line">{html_text}</p>'
    if block_type == "heading":
        return f"<h2>{html_text}</h2>"
    if unit.kind == "dedication":
        return f'<p class="dedication-text">{html_text}</p>'
    return f'<p class="reader-paragraph">{html_text}</p>'


def paginate_fragments(
    fragments: list[BlockFragment],
    first_capacity: int,
    continuation_capacity: int,
    geometry: FixedGeometry,
) -> list[list[BlockFragment]]:
    pages: list[list[BlockFragment]] = []
    current: list[BlockFragment] = []
    remaining = first_capacity
    capacity = first_capacity

    for fragment in fragments:
        if fragment.lines > remaining and current:
            pages.append(current)
            current = []
            capacity = continuation_capacity
            remaining = continuation_capacity

        if fragment.lines > capacity and fragment.plain:
            for split_fragment in split_oversized_fragment(fragment, capacity, geometry):
                if split_fragment.lines > remaining and current:
                    pages.append(current)
                    current = []
                    capacity = continuation_capacity
                    remaining = continuation_capacity
                current.append(split_fragment)
                remaining -= min(split_fragment.lines, remaining)
            continue

        current.append(fragment)
        remaining -= fragment.lines

    if current:
        pages.append(current)
    return pages


def split_oversized_fragment(fragment: BlockFragment, capacity: int, geometry: FixedGeometry) -> list[BlockFragment]:
    chars = chars_per_line(fragment.type, geometry)
    target_chars = max(chars, chars * max(1, capacity - 1))
    pieces = split_text_to_fit(fragment.plain, target_chars)
    return [
        BlockFragment(
            fragment_html(fragment.type, ChapterUnit("", "", "", "", "", 0, []), html.escape(piece)),
            piece,
            fragment.type,
            min(capacity, line_cost(piece, fragment.type, geometry, continued=index > 0)),
        )
        for index, piece in enumerate(pieces)
    ]


def split_text_to_fit(text: str, target_chars: int) -> list[str]:
    words = text.split()
    if not words:
        return [text]
    pieces: list[str] = []
    current: list[str] = []
    current_len = 0
    for word in words:
        next_len = current_len + len(word) + (1 if current else 0)
        if current and next_len > target_chars:
            pieces.append(" ".join(current))
            current = [word]
            current_len = len(word)
        else:
            current.append(word)
            current_len = next_len
    if current:
        pieces.append(" ".join(current))
    return pieces


def first_page_capacity(unit: ChapterUnit, geometry: FixedGeometry) -> int:
    line_box = effective_line_box_px(geometry)
    if unit.kind == "chapter":
        usable_px = geometry.height_px - 242 - geometry.bottom_px - 24
    elif unit.kind in {"contents"}:
        usable_px = geometry.height_px - 150 - geometry.bottom_px - 24
    elif unit.kind in {"dedication"}:
        usable_px = geometry.height_px - 258 - geometry.bottom_px - 24
    elif unit.kind in {"part"}:
        usable_px = geometry.height_px - 210 - geometry.bottom_px - 24
    else:
        usable_px = geometry.height_px - 172 - geometry.bottom_px - 24
    return max(6, math.floor(usable_px / line_box))


def continuation_page_capacity(geometry: FixedGeometry) -> int:
    line_box = effective_line_box_px(geometry)
    usable_px = geometry.content_height_px - 26
    return max(8, math.floor(usable_px / line_box))


def effective_line_box_px(geometry: FixedGeometry) -> float:
    return geometry.line_height_px + 4


def chars_per_line(block_type: str, geometry: FixedGeometry) -> int:
    if block_type.startswith("toc-"):
        return max(46, math.floor(geometry.content_width_px / 4.8))
    if block_type == "quote":
        return max(32, math.floor(geometry.content_width_px / 6.5))
    return max(42, math.floor(geometry.content_width_px / 5.6))


def estimated_lines(text: str, chars: int) -> int:
    return max(1, math.ceil(max(1, len(text)) / max(1, chars)))


def line_cost(text: str, block_type: str, geometry: FixedGeometry, *, continued: bool) -> int:
    chars = chars_per_line(block_type, geometry)
    lines = estimated_lines(text, chars)
    if block_type == "quote":
        return lines + 3
    if block_type.startswith("toc-"):
        return lines + (1 if block_type == "toc-heading" else 0)
    if block_type == "heading":
        return lines + 2
    return lines


def fixed_page_xhtml(page: FixedPage, geometry: FixedGeometry) -> str:
    body = page.body_html
    if page.folio is None:
        body = body.replace("__FOLIO__", "")
    else:
        body = body.replace(
            "__FOLIO__",
            f'<footer class="page-folio"><span></span><b>{page.folio}</b></footer>',
        )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width={geometry.width_px}, height={geometry.height_px}"/>
  <title>{html.escape(page.title)}</title>
  <link rel="stylesheet" type="text/css" href="{html.escape(page.css_href)}"/>
</head>
<body class="fixed-layout-body">
{body}
</body>
</html>
"""


def fixed_nav_xhtml(model: BookModel, pages: list[FixedPage]) -> str:
    toc_items = "\n".join(
        f'      <li><a href="{html.escape(page.filename)}">{html.escape(page.nav_label)}</a></li>'
        for page in pages
        if page.nav_label
    )
    page_items = "\n".join(
        f'      <li><a href="{html.escape(page.filename)}">{index}</a></li>'
        for index, page in enumerate(pages, start=1)
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>{html.escape(model.metadata.title)} Navigation</title>
  <link rel="stylesheet" type="text/css" href="styles/greyveil-fixed.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>{html.escape(model.metadata.title)}</h1>
    <ol>
{toc_items}
    </ol>
  </nav>
  <nav epub:type="page-list" id="page-list" hidden="">
    <h2>Pages</h2>
    <ol>
{page_items}
    </ol>
  </nav>
</body>
</html>
"""


def fixed_package_opf(
    model: BookModel,
    identifier: str,
    pages: list[FixedPage],
    cover,
) -> str:
    cover_item = ""
    cover_meta = ""
    if cover and cover.resolved_path:
        suffix = cover.resolved_path.suffix.lower()
        cover_item = f'    <item id="cover-image" href="images/cover{suffix}" media-type="{media_type_for(cover.resolved_path)}" properties="cover-image"/>\n'
        cover_meta = '    <meta name="cover" content="cover-image"/>\n'

    page_items = "\n".join(
        f'    <item id="{html.escape(page.id)}" href="{html.escape(page.filename)}" media-type="application/xhtml+xml"/>'
        for page in pages
    )
    spine_items = "\n".join(f'    <itemref idref="{html.escape(page.id)}"/>' for page in pages)
    metadata = model.metadata
    subtitle = f"    <dc:description>{html.escape(metadata.subtitle)}</dc:description>\n" if metadata.subtitle else ""
    series = f"    <meta property=\"belongs-to-collection\">{html.escape(metadata.series)}</meta>\n" if metadata.series else ""
    book_number = (
        f"    <meta property=\"group-position\">{html.escape(book_number_label(metadata.book_number).replace('Book ', ''))}</meta>\n"
        if metadata.book_number
        else ""
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="en" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">{identifier}</dc:identifier>
    <dc:title>{html.escape(metadata.title)}</dc:title>
    <dc:creator>{html.escape(metadata.author)}</dc:creator>
    <dc:publisher>{html.escape(metadata.publisher)}</dc:publisher>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-08-09T00:00:00Z</meta>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:orientation">portrait</meta>
    <meta property="rendition:spread">none</meta>
    <meta property="rendition:flow">paginated</meta>
{subtitle}{series}{book_number}{cover_meta}  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="styles/greyveil-fixed.css" media-type="text/css"/>
{cover_item}{page_items}
  </manifest>
  <spine page-progression-direction="ltr">
{spine_items}
  </spine>
</package>
"""


def fixed_stylesheet(theme: ExportTheme, geometry: FixedGeometry) -> str:
    body_font = css_font_stack(theme.body_font, "Georgia, serif")
    display_font = css_font_stack(theme.display_font, "Georgia, serif")
    sans_font = css_font_stack(theme.sans_font, "Arial, sans-serif")
    rule_color = rgba(theme.accent, 0.18)
    edge_color = rgba(theme.accent, 0.085)
    return f"""
@namespace epub "http://www.idpf.org/2007/ops";

@page {{
  margin: 0;
  size: {geometry.width_px}px {geometry.height_px}px;
}}

html,
body {{
  width: {geometry.width_px}px;
  height: {geometry.height_px}px;
  margin: 0;
  padding: 0;
  overflow: hidden;
}}

body {{
  background: {theme.paper};
  color: {theme.text};
  font-family: {body_font};
  font-size: {geometry.body_size_px}px;
  line-height: {geometry.line_height_px}px;
}}

.page {{
  position: relative;
  width: {geometry.width_px}px;
  height: {geometry.height_px}px;
  box-sizing: border-box;
  overflow: hidden;
  background: {theme.paper};
  color: {theme.text};
}}

.page:not(.page--cover)::before {{
  content: "";
  position: absolute;
  left: 22px;
  right: 22px;
  top: 20px;
  bottom: 20px;
  border-top: 1px solid {rgba(theme.text, 0.10)};
  border-bottom: 1px solid {rgba(theme.text, 0.10)};
  pointer-events: none;
}}

.page:not(.page--cover)::after {{
  content: "";
  position: absolute;
  top: 34px;
  bottom: 34px;
  left: 25px;
  width: 1px;
  background: {theme.accent};
  opacity: .16;
  pointer-events: none;
}}

.page--cover {{
  background: {theme.heading};
}}

.cover-image {{
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}}

.page--cover-fallback {{
  display: grid;
  place-items: center;
  color: {theme.paper};
  font-family: {display_font};
}}

.title-block {{
  position: absolute;
  left: {geometry.inside_px}px;
  top: 164px;
  width: {geometry.content_width_px}px;
}}

.title-rule,
.reader-rule {{
  position: absolute;
  height: 1px;
  background: {theme.accent};
}}

.title-rule--a {{
  left: {geometry.inside_px}px;
  top: 138px;
  width: 96px;
  opacity: .48;
}}

.title-rule--b {{
  left: {geometry.inside_px + 14}px;
  top: 150px;
  width: 58px;
  opacity: .26;
}}

.title-kicker,
.unit-kicker {{
  margin: 0 0 5px;
  color: {theme.warm};
  font-family: {sans_font};
  font-size: 8.5px;
  font-weight: 700;
  line-height: 11px;
  letter-spacing: .12em;
}}

.title-block h1 {{
  margin: 16px 0 10px;
  max-width: 7.6ch;
  color: {theme.heading};
  font-family: {display_font};
  font-size: {min(theme.title_size_pt, 49)}px;
  font-weight: 700;
  line-height: .92;
}}

.title-subtitle {{
  max-width: 30ch;
  margin: 0 0 28px;
  color: {theme.muted};
  font-family: {display_font};
  font-size: 14.2px;
  line-height: 19px;
}}

.title-author,
.title-imprint {{
  margin: 0 0 5px;
  color: {theme.accent};
  font-family: {sans_font};
  font-size: 8px;
  line-height: 12px;
}}

.unit-header {{
  position: absolute;
  left: {geometry.inside_px}px;
  top: 66px;
  width: {geometry.content_width_px}px;
  min-height: 138px;
  box-sizing: border-box;
  padding: 28px 0 18px 22px;
}}

.page--chapter .unit-header {{
  min-height: 176px;
  padding-top: 34px;
}}

.page--part .unit-header,
.page--dedication .unit-header {{
  top: 176px;
  min-height: 118px;
  text-align: center;
  padding-left: 0;
}}

.reader-rule--a {{
  left: 0;
  top: 0;
  width: 72px;
  opacity: .46;
}}

.reader-rule--b {{
  left: 12px;
  top: 12px;
  width: 42px;
  opacity: .24;
}}

.page--part .reader-rule--a,
.page--dedication .reader-rule--a {{
  left: 50%;
  width: 76px;
  transform: translateX(-54px);
}}

.page--part .reader-rule--b,
.page--dedication .reader-rule--b {{
  left: 50%;
  width: 44px;
  transform: translateX(-10px);
}}

.unit-header h1 {{
  max-width: 15ch;
  margin: 0;
  color: {theme.heading};
  font-family: {display_font};
  font-size: {theme.chapter_title_size_pt}px;
  font-weight: 700;
  line-height: 1.02;
}}

.page--part .unit-header h1,
.page--dedication .unit-header h1 {{
  max-width: 12ch;
  margin-inline: auto;
  color: {theme.accent};
  text-align: center;
}}

.unit-subtitle {{
  max-width: 24ch;
  margin: 6px 0 0;
  color: {theme.muted};
  font-family: {display_font};
  font-size: 15px;
  line-height: 17px;
}}

.flow-frame {{
  position: absolute;
  left: {geometry.inside_px}px;
  width: {geometry.content_width_px}px;
  box-sizing: border-box;
  overflow: hidden;
}}

.flow-frame--first {{
  top: 172px;
  bottom: {geometry.bottom_px + 22}px;
}}

.page--chapter .flow-frame--first {{
  top: 242px;
}}

.page--contents .flow-frame--first {{
  top: 150px;
}}

.page--dedication .flow-frame--first {{
  top: 305px;
  text-align: center;
}}

.page--part .flow-frame--first {{
  top: 306px;
  text-align: center;
}}

.flow-frame--continuation {{
  top: {geometry.top_px}px;
  bottom: {geometry.bottom_px + 22}px;
}}

.reader-paragraph {{
  margin: 0;
  color: {theme.text};
  font-family: {body_font};
  font-size: {geometry.body_size_px}px;
  line-height: {geometry.line_height_px}px;
  text-indent: 1.08em;
}}

.reader-paragraph:first-child,
.reader-section-break + .reader-paragraph,
.reader-quote + .reader-paragraph {{
  text-indent: 0;
}}

.reader-paragraph + .reader-paragraph {{
  margin-top: 4px;
}}

.toc-line {{
  margin: 0 0 4px;
  color: {theme.muted};
  font-family: {sans_font};
  font-size: {theme.contents_size_pt}px;
  line-height: 13px;
}}

.toc-heading {{
  margin-top: 10px;
  color: {theme.accent};
  font-size: 10.5px;
  font-weight: 700;
}}

.toc-chapter {{
  color: {theme.text};
}}

.reader-section-break {{
  position: relative;
  height: 42px;
  margin: 4px 0;
}}

.reader-section-break span {{
  position: absolute;
  top: 50%;
  left: 0;
  height: 1px;
  background: {theme.accent};
}}

.reader-section-break span:first-child {{
  width: 44px;
  opacity: .50;
  transform: translate(-6px, -4px);
}}

.reader-section-break span:last-child {{
  width: 27px;
  opacity: .28;
  transform: translate(12px, 7px);
}}

.reader-quote {{
  margin: 14px 0;
  padding: 9px 0 9px 18px;
  border-left: 1px solid {rgba(theme.accent, 0.42)};
  color: {theme.accent};
  font-family: {display_font};
  font-size: 13.3px;
  line-height: 18px;
}}

.dedication-text {{
  margin: 0 auto 10px;
  max-width: 28ch;
  color: {theme.accent};
  font-family: {display_font};
  font-size: 19px;
  line-height: 24px;
  text-align: center;
}}

.space-break {{
  height: 16px;
}}

.page-folio {{
  position: absolute;
  left: 0;
  right: 0;
  bottom: 14px;
  display: grid;
  justify-items: center;
  gap: 5px;
  color: {theme.subtle};
  font-family: {sans_font};
  font-size: 8px;
  line-height: 1;
}}

.page-folio span {{
  display: block;
  width: 24px;
  height: 1px;
  background: {theme.accent};
  opacity: .34;
}}

nav {{
  box-sizing: border-box;
  width: {geometry.width_px}px;
  min-height: {geometry.height_px}px;
  padding: {geometry.top_px}px {geometry.outside_px}px {geometry.bottom_px}px {geometry.inside_px}px;
  background: {theme.paper};
  color: {theme.text};
  font-family: {sans_font};
}}

nav h1 {{
  margin: 0 0 18px;
  color: {theme.heading};
  font-family: {display_font};
  font-size: 30px;
  line-height: 1;
}}

nav ol {{
  margin: 0;
  padding-left: 20px;
}}

nav li {{
  margin-bottom: 6px;
}}

a {{
  color: {theme.accent_strong};
  text-decoration: none;
}}
""".strip()


def rgba(hex_value: str, alpha: float) -> str:
    value = hex_value.lstrip("#")
    if len(value) != 6:
        return f"rgba(0, 0, 0, {alpha})"
    red = int(value[0:2], 16)
    green = int(value[2:4], 16)
    blue = int(value[4:6], 16)
    return f"rgba({red}, {green}, {blue}, {alpha})"

