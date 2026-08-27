"""Fail-closed resource limits for untrusted generation inputs and artifacts."""

from __future__ import annotations

import re
import zipfile
from pathlib import Path, PurePosixPath


MEBIBYTE = 1024 * 1024
MAX_MANUSCRIPT_BYTES = 32 * MEBIBYTE
MAX_COVER_BYTES = 20 * MEBIBYTE
MAX_COVER_PIXELS = 40_000_000
MAX_DOCX_ZIP_ENTRIES = 4_096
MAX_DOCX_UNCOMPRESSED_BYTES = 256 * MEBIBYTE
MAX_DOCX_ENTRY_BYTES = 64 * MEBIBYTE
MAX_DOCX_COMPRESSION_RATIO = 200
MAX_ZIP_ENTRY_NAME_LENGTH = 512
ARTIFACT_SIZE_LIMITS = {
    "pdf": 96 * MEBIBYTE,
    "epub": 64 * MEBIBYTE,
    "docx": 64 * MEBIBYTE,
    "source": 64 * MEBIBYTE,
    "cover": MAX_COVER_BYTES,
    "qa": 2 * MEBIBYTE,
}
DOCX_REQUIRED_ENTRIES = frozenset({"[Content_Types].xml", "word/document.xml"})
DOCX_COMPRESSION_METHODS = frozenset({zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED})


class ResourceLimitError(ValueError):
    """An input or generated artifact exceeds a safe processing boundary."""


def validate_file_size(path: Path, maximum_bytes: int, label: str) -> int:
    """Require a regular, non-empty file no larger than the supplied bound."""
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ResourceLimitError(f"{label} is missing or unreadable.") from exc
    if not path.is_file() or size < 1:
        raise ResourceLimitError(f"{label} must be a non-empty file.")
    if size > maximum_bytes:
        raise ResourceLimitError(f"{label} exceeds the {maximum_bytes // MEBIBYTE} MiB safety limit.")
    return size


def validate_docx_archive(path: Path) -> None:
    """Inspect DOCX ZIP metadata before any member is decompressed by python-docx."""
    validate_file_size(path, MAX_MANUSCRIPT_BYTES, "Manuscript")
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_DOCX_ZIP_ENTRIES:
                raise ResourceLimitError("Manuscript DOCX contains too many ZIP entries.")

            names: set[str] = set()
            total_compressed = 0
            total_uncompressed = 0
            for entry in entries:
                _validate_entry_name(entry.filename)
                if entry.flag_bits & 0x1:
                    raise ResourceLimitError("Encrypted DOCX entries are not supported.")
                if entry.compress_type not in DOCX_COMPRESSION_METHODS:
                    raise ResourceLimitError("Manuscript DOCX uses an unsupported ZIP compression method.")

                names.add(entry.filename)
                if entry.is_dir():
                    continue
                if entry.file_size > MAX_DOCX_ENTRY_BYTES:
                    raise ResourceLimitError("A manuscript DOCX entry exceeds the per-entry safety limit.")
                if entry.file_size and entry.file_size / max(entry.compress_size, 1) > MAX_DOCX_COMPRESSION_RATIO:
                    raise ResourceLimitError("Manuscript DOCX compression ratio exceeds the safety limit.")
                total_compressed += entry.compress_size
                total_uncompressed += entry.file_size
                if total_uncompressed > MAX_DOCX_UNCOMPRESSED_BYTES:
                    raise ResourceLimitError("Manuscript DOCX expands beyond the uncompressed-size safety limit.")

            if total_uncompressed and total_uncompressed / max(total_compressed, 1) > MAX_DOCX_COMPRESSION_RATIO:
                raise ResourceLimitError("Manuscript DOCX total compression ratio exceeds the safety limit.")
            if not DOCX_REQUIRED_ENTRIES.issubset(names):
                raise ResourceLimitError("Manuscript is not a valid DOCX package.")
    except zipfile.BadZipFile as exc:
        raise ResourceLimitError("Manuscript is not a valid DOCX file.") from exc


def artifact_size_limit(kind: str) -> int:
    try:
        return ARTIFACT_SIZE_LIMITS[kind]
    except KeyError as exc:
        raise ResourceLimitError("Generated artifact kind is not allowed.") from exc


def validate_generated_artifact(kind: str, path: Path) -> int:
    return validate_file_size(path, artifact_size_limit(kind), f"Generated {kind.upper()} artifact")


def _validate_entry_name(name: str) -> None:
    normalized = name.replace("\\", "/")
    parts = PurePosixPath(normalized).parts
    if (
        not name
        or len(name) > MAX_ZIP_ENTRY_NAME_LENGTH
        or name.startswith(("/", "\\"))
        or re.match(r"^[A-Za-z]:", name)
        or ".." in parts
    ):
        raise ResourceLimitError("Manuscript DOCX contains an unsafe ZIP entry name.")
