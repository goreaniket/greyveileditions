"""Focused structural validation for generated Greyveil publications."""

from __future__ import annotations

import zipfile
import re
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree as ET

from pypdf import PdfReader

from .models import BookModel


@dataclass
class OutputQaReport:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def validate_generated_outputs(model: BookModel, outputs: dict[str, Path]) -> OutputQaReport:
    report = OutputQaReport()
    pdf_text = validate_pdf(model, outputs.get("pdf"), report)
    epub_text = validate_epub(model, outputs.get("epub"), report)
    docx_text = validate_docx(model, outputs.get("docx"), report)
    expected = expected_unit_markers(model)
    for format_name, text in (("PDF", pdf_text), ("EPUB", epub_text), ("DOCX", docx_text)):
        if text:
            validate_ordered_markers(format_name, text, expected, report)
    return report


def validate_pdf(model: BookModel, path: Path | None, report: OutputQaReport) -> str:
    if not path or not path.exists() or path.stat().st_size == 0:
        report.errors.append("PDF output is missing or empty.")
        return ""
    try:
        reader = PdfReader(str(path))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception as exc:  # noqa: BLE001 - report validation failures cleanly.
        report.errors.append(f"PDF is not readable: {exc}")
        return ""
    if not text.strip():
        report.errors.append("PDF contains no extractable text.")
    elif model.metadata.title and not contains_text(text, model.metadata.title):
        report.errors.append("PDF does not contain the expected book title.")
    return text


def validate_epub(model: BookModel, path: Path | None, report: OutputQaReport) -> str:
    if not path or not path.exists() or path.stat().st_size == 0:
        report.errors.append("EPUB output is missing or empty.")
        return ""
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if not names or names[0] != "mimetype" or archive.read("mimetype") != b"application/epub+zip":
                report.errors.append("EPUB mimetype is missing, misplaced, or invalid.")
                return ""
            container = "META-INF/container.xml"
            if container not in names:
                report.errors.append("EPUB container.xml is missing.")
                return ""
            container_root = ET.fromstring(archive.read(container))
            rootfile = next((node.attrib.get("full-path") for node in container_root.iter() if node.tag.endswith("rootfile")), "")
            if not rootfile or rootfile not in names:
                report.errors.append("EPUB package document is missing.")
                return ""
            package = ET.fromstring(archive.read(rootfile))
            manifest = {node.attrib.get("id", ""): node.attrib.get("href", "") for node in package.iter() if node.tag.endswith("item")}
            spine = [node.attrib.get("idref", "") for node in package.iter() if node.tag.endswith("itemref")]
            if not spine or any(item_id not in manifest for item_id in spine):
                report.errors.append("EPUB spine references a missing manifest item.")
            package_dir = Path(rootfile).parent
            pieces: list[str] = []
            for item_id in spine:
                href = manifest.get(item_id, "")
                xhtml_name = (package_dir / href).as_posix()
                if not href or xhtml_name not in names:
                    report.errors.append(f"EPUB manifest content is missing: {href or item_id}.")
                    continue
                if href.endswith((".xhtml", ".html")):
                    document = ET.fromstring(archive.read(xhtml_name))
                    pieces.append("".join(document.itertext()))
            return "\n".join(pieces)
    except (OSError, zipfile.BadZipFile, ET.ParseError) as exc:
        report.errors.append(f"EPUB is not structurally valid: {exc}")
        return ""


def validate_docx(model: BookModel, path: Path | None, report: OutputQaReport) -> str:
    if not path or not path.exists() or path.stat().st_size == 0:
        report.errors.append("DOCX output is missing or empty.")
        return ""
    try:
        with zipfile.ZipFile(path) as archive:
            if "word/document.xml" not in archive.namelist():
                report.errors.append("DOCX word/document.xml is missing.")
                return ""
            document = ET.fromstring(archive.read("word/document.xml"))
            return "".join(document.itertext())
    except (OSError, zipfile.BadZipFile, ET.ParseError) as exc:
        report.errors.append(f"DOCX is not structurally valid: {exc}")
        return ""


def expected_unit_markers(model: BookModel) -> list[str]:
    markers: list[str] = []
    for unit in model.chapters:
        marker = unit.title.strip()
        if marker and marker not in markers:
            markers.append(marker)
        content = next((block.text.strip() for block in unit.blocks if block.text.strip()), "")
        if content and content not in markers:
            markers.append(content)
    return markers


def validate_ordered_markers(format_name: str, text: str, markers: list[str], report: OutputQaReport) -> None:
    position = -1
    for marker in markers:
        found = normalized_text(text).find(normalized_text(marker), position + 1)
        if found < 0:
            report.errors.append(f"{format_name} is missing expected unit marker: {marker}.")
            return
        if found < position:
            report.errors.append(f"{format_name} unit ordering is invalid near: {marker}.")
            return
        position = found


def normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def contains_text(text: str, marker: str) -> bool:
    return normalized_text(marker) in normalized_text(text)
