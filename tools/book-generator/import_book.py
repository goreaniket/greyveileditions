#!/usr/bin/env python
"""Import a DOCX manuscript into Greyveil source and optionally generate outputs."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from generate_book import main as generate_book_main
from greyveil.importer import ImportResult, import_docx
from greyveil.jobs import GenerationStage
from greyveil.loader import load_book
from greyveil.qa import validate_generated_outputs


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_inbox(root: Path) -> Path:
    return root / "tools" / "book-generator" / "inbox"


def inbox_manuscripts(inbox: Path) -> list[Path]:
    if not inbox.is_dir():
        return []
    return sorted(path for path in inbox.glob("*.docx") if not path.name.startswith("~$"))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import DOCX manuscripts into Greyveil book source.")
    parser.add_argument("manuscript", nargs="?", type=Path, help="Path to one DOCX manuscript.")
    parser.add_argument("--process-inbox", action="store_true", help="Import every non-temporary DOCX in the inbox.")
    parser.add_argument("--inbox-dir", type=Path, help="Override the default tools/book-generator/inbox directory.")
    parser.add_argument("--cover", type=Path, help="Explicit JPEG or PNG cover image.")
    parser.add_argument("--design-from", default="the-last-shift", help="Existing book whose design configuration is inherited.")
    parser.add_argument("--generate", action="store_true", help="Run the existing generator and structural output QA after import.")
    parser.add_argument("--output-dir", type=Path, help="Base output directory when --generate is used.")
    parser.add_argument("--json", action="store_true", help="Print the final job/result record as JSON.")
    args = parser.parse_args(argv)
    if bool(args.manuscript) == bool(args.process_inbox):
        parser.error("Provide one manuscript or use --process-inbox.")
    if args.cover and args.process_inbox:
        parser.error("--cover is only supported for a single manuscript import.")
    if args.output_dir and not args.generate:
        parser.error("--output-dir requires --generate.")
    return args


def process_import(root: Path, manuscript: Path, args: argparse.Namespace) -> ImportResult:
    result = import_docx(root, manuscript, design_from=args.design_from, cover_path=args.cover)
    if result.status != "imported" or not args.generate:
        if result.status == "imported":
            result.job.advance(GenerationStage.COMPLETE)
        return result

    output_dir = (args.output_dir or (root / "output")).resolve()
    stages = (
        (GenerationStage.GENERATING_PDF, "--pdf"),
        (GenerationStage.GENERATING_EPUB, "--epub"),
        (GenerationStage.GENERATING_DOCX, "--docx"),
    )
    for stage, flag in stages:
        result.job.advance(stage)
        code = generate_book_main([result.slug, flag, "--output-dir", str(output_dir)])
        if code != 0:
            result.status = "failed"
            result.error = f"Existing generator failed during {stage.value}."
            result.job.fail(result.error)
            return result

    result.job.advance(GenerationStage.VALIDATING_OUTPUTS)
    model = load_book(root, result.slug)
    report = validate_generated_outputs(
        model,
        {
            "pdf": output_dir / "pdf" / f"{result.slug}.pdf",
            "epub": output_dir / "epub" / f"{result.slug}.epub",
            "docx": output_dir / "docx" / f"{result.slug}-print-editable.docx",
        },
    )
    for warning in report.warnings:
        result.job.add_warning(warning)
    if not report.ok:
        result.status = "failed"
        result.error = "; ".join(report.errors)
        result.job.fail(result.error)
        return result
    result.status = "complete"
    result.job.advance(GenerationStage.COMPLETE)
    return result


def print_result(result: ImportResult, as_json: bool = False) -> None:
    payload = {
        "status": result.status,
        "manuscript": result.manuscript.name,
        "slug": result.slug,
        "bookPath": str(result.book_path) if result.book_path else "",
        "metadata": result.metadata,
        "missingFields": result.missing_fields,
        "warnings": result.warnings,
        "error": result.error,
        "job": result.job.to_dict(),
    }
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    if result.status == "complete":
        print(f"{result.manuscript.name}  SUCCESS")
    elif result.status == "imported":
        print(f"{result.manuscript.name}  IMPORTED")
    elif result.status == "needs_attention":
        detail = "; ".join(result.warnings or result.missing_fields)
        print(f"{result.manuscript.name}  NEEDS ATTENTION: {detail}")
    else:
        print(f"{result.manuscript.name}  FAILED: {result.error}")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    root = repo_root()
    manuscripts = [args.manuscript] if args.manuscript else inbox_manuscripts(args.inbox_dir or default_inbox(root))
    if not manuscripts:
        print("No DOCX manuscripts found to import.")
        return 0

    results = [process_import(root, manuscript, args) for manuscript in manuscripts]
    for result in results:
        print_result(result, args.json)
    return 0 if all(result.status in {"imported", "complete"} for result in results) else 2


if __name__ == "__main__":
    raise SystemExit(main())
