"""Focused untrusted-input, artifact, and Storage-boundary regressions."""

from __future__ import annotations

import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from docx import Document
from PIL import Image as PILImage


BOOK_GENERATOR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BOOK_GENERATOR))

import run_generation_worker as worker  # noqa: E402
from greyveil import importer  # noqa: E402
from greyveil import resource_limits  # noqa: E402
from greyveil.resource_limits import ResourceLimitError, validate_docx_archive  # noqa: E402


class ResourceLimitTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="greyveil-limits-")
        self.root = Path(self.temp_dir.name)
        self.manuscript = self.root / "manuscript.docx"
        document = Document()
        document.add_paragraph("Chapter 1", style="Heading 1")
        document.add_paragraph("Bounded fixture text.")
        document.save(self.manuscript)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_valid_docx_passes_archive_preflight(self) -> None:
        self.assertIsNone(validate_docx_archive(self.manuscript))

    def test_docx_entry_count_total_size_and_ratio_are_bounded(self) -> None:
        cases = (
            ("MAX_DOCX_ZIP_ENTRIES", 1, "too many ZIP entries"),
            ("MAX_DOCX_UNCOMPRESSED_BYTES", 1, "uncompressed-size"),
            ("MAX_DOCX_COMPRESSION_RATIO", 1, "compression ratio"),
        )
        for setting, value, message in cases:
            with self.subTest(setting=setting), patch.object(resource_limits, setting, value):
                with self.assertRaisesRegex(ResourceLimitError, message):
                    validate_docx_archive(self.manuscript)

    def test_docx_rejects_unsafe_entry_names_before_parsing(self) -> None:
        unsafe = self.root / "unsafe.docx"
        with zipfile.ZipFile(unsafe, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("word/document.xml", "<document/>")
            archive.writestr("../outside.bin", b"unsafe")
        with self.assertRaisesRegex(ResourceLimitError, "unsafe ZIP entry"):
            validate_docx_archive(unsafe)

    def test_manuscript_and_generated_artifact_file_sizes_are_bounded(self) -> None:
        with patch.object(resource_limits, "MAX_MANUSCRIPT_BYTES", self.manuscript.stat().st_size - 1):
            with self.assertRaisesRegex(ResourceLimitError, "Manuscript exceeds"):
                validate_docx_archive(self.manuscript)

        artifact = self.root / "candidate.pdf"
        artifact.write_bytes(b"1234")
        with patch.dict(resource_limits.ARTIFACT_SIZE_LIMITS, {"pdf": 3}):
            with self.assertRaisesRegex(ResourceLimitError, "Generated PDF artifact exceeds"):
                resource_limits.validate_generated_artifact("pdf", artifact)

    def test_cover_file_size_and_decoded_pixels_are_bounded(self) -> None:
        cover = self.root / "cover.png"
        PILImage.new("RGB", (4, 4), (20, 30, 40)).save(cover, "PNG")
        with patch.object(importer, "MAX_COVER_BYTES", cover.stat().st_size - 1):
            with self.assertRaisesRegex(ValueError, "valid PNG"):
                importer.validate_cover_image(cover)
        with patch.object(importer, "MAX_COVER_PIXELS", 15):
            with self.assertRaisesRegex(ValueError, "valid PNG"):
                importer.validate_cover_image(cover)

    def test_storage_download_streams_chunks_and_enforces_declared_size(self) -> None:
        class Response:
            headers = {"Content-Length": "6"}

            def __init__(self) -> None:
                self.chunks = iter((b"ab", b"cd", b"ef", b""))
                self.read_calls = 0

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size: int) -> bytes:
                self.read_calls += 1
                return next(self.chunks)

        response = Response()
        destination = self.root / "download.bin"
        with (
            patch.object(worker, "URL", "https://project.supabase.co"),
            patch.object(worker, "KEY", "service-role-key"),
            patch.object(worker.urllib.request, "urlopen", return_value=response),
        ):
            worker.storage_download("private", "object.bin", destination, max_bytes=6, expected_bytes=6)
        self.assertEqual(destination.read_bytes(), b"abcdef")
        self.assertGreater(response.read_calls, 2)

        oversized = self.root / "oversized.bin"
        response.headers = {"Content-Length": "7"}
        with (
            patch.object(worker, "URL", "https://project.supabase.co"),
            patch.object(worker, "KEY", "service-role-key"),
            patch.object(worker.urllib.request, "urlopen", return_value=response),
            self.assertRaisesRegex(ResourceLimitError, "exceeds"),
        ):
            worker.storage_download("private", "object.bin", oversized, max_bytes=6)
        self.assertFalse(oversized.exists())

    def test_buffered_upload_fallback_is_bounded_before_request(self) -> None:
        artifact = self.root / "candidate.bin"
        artifact.write_bytes(b"bounded")
        with patch.object(worker, "request") as request:
            worker.storage_upload("private", "candidate.bin", artifact, "application/octet-stream", max_bytes=7)
        request.assert_called_once()

        with patch.object(worker, "request") as request, self.assertRaisesRegex(ResourceLimitError, "upload safety"):
            worker.storage_upload("private", "candidate.bin", artifact, "application/octet-stream", max_bytes=6)
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
