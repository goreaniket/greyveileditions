#!/usr/bin/env python
"""Greyveil Editions book generator entrypoint."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from greyveil.exporters.docx import export_docx
from greyveil.exporters.epub import export_epub
from greyveil.exporters.pdf import export_pdf, export_pdf_prototype
from greyveil.loader import load_book


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def ok_label(value: bool) -> str:
    return "OK" if value else "FAILED"


def print_summary(model) -> None:
    errors = [issue for issue in model.issues if issue.severity == "error"]
    warnings = [issue for issue in model.issues if issue.severity == "warning"]

    print(f"Book: {model.metadata.title or model.slug}")
    print(f"Series: {model.metadata.series or 'Unknown'}")
    print(f"Chapters: {len(model.chapters)}")
    print(f"Cover: {ok_label(model.cover_ok)}")
    print(f"Design spec: {ok_label(model.design_ok)}")
    print(f"Theme: {ok_label(model.theme_ok)}")
    print(f"Content model: {ok_label(not errors and bool(model.chapters))}")

    if model.block_types:
        print("Block types: " + ", ".join(model.block_types))

    if warnings:
        print("")
        print("Warnings:")
        for issue in warnings:
            print(f"- {issue.message}")

    if errors:
        print("")
        print("Errors:")
        for issue in errors:
            print(f"- {issue.message}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate and export Greyveil book source files.")
    parser.add_argument("slug", help="Book slug under assets/books/")
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Validate and normalize source files without exporting final files.",
    )
    parser.add_argument(
        "--pdf",
        action="store_true",
        help="Generate a reader-style digital/visual PDF.",
    )
    parser.add_argument(
        "--epub",
        action="store_true",
        help="Generate a reader-style digital/visual EPUB.",
    )
    parser.add_argument(
        "--docx",
        action="store_true",
        help="Generate a print-safe editable DOCX with mirrored binding geometry.",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Generate PDF, EPUB, and DOCX outputs.",
    )
    parser.add_argument(
        "--pdf-prototype",
        action="store_true",
        help="Legacy alias: generate the reader-style PDF at the prototype filename.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional output path for a single generated artifact.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Optional base output folder; format subfolders are created inside it.",
    )
    args = parser.parse_args(argv)
    selected = [args.pdf, args.epub, args.docx, args.pdf_prototype]
    if args.all:
        args.pdf = True
        args.epub = True
        args.docx = True
    export_count = sum(1 for value in [args.pdf, args.epub, args.docx, args.pdf_prototype] if value)
    if args.output and export_count > 1:
        parser.error("--output can only be used when generating one artifact.")
    if args.output and args.output_dir:
        parser.error("Use --output or --output-dir, not both.")
    if args.all and any(selected):
        parser.error("Use --all by itself or choose individual export flags.")
    return args


def output_for(args: argparse.Namespace, subdir: str, filename: str) -> Path | None:
    if args.output:
        return args.output
    if args.output_dir:
        return args.output_dir / subdir / filename
    return None


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])

    if not any([args.validate, args.pdf, args.epub, args.docx, args.pdf_prototype]):
        print("Choose --validate, --pdf, --epub, --docx, --all, or --pdf-prototype.")
        return 2

    root = repo_root()
    model = load_book(root, args.slug)
    print_summary(model)
    has_errors = any(issue.severity == "error" for issue in model.issues)

    if has_errors:
        return 1

    if args.pdf_prototype:
        output_path = export_pdf_prototype(
            model,
            root,
            output_for(args, "pdf", f"{model.slug}-prototype.pdf"),
        )
        print(f"PDF prototype: {output_path}")

    if args.pdf:
        output_path = export_pdf(model, root, output_for(args, "pdf", f"{model.slug}.pdf"))
        print(f"PDF: {output_path}")

    if args.epub:
        output_path = export_epub(model, root, output_for(args, "epub", f"{model.slug}.epub"))
        print(f"EPUB: {output_path}")

    if args.docx:
        output_path = export_docx(model, root, output_for(args, "docx", f"{model.slug}-print-editable.docx"))
        print(f"DOCX: {output_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
