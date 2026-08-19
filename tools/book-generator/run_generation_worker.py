#!/usr/bin/env python
"""External worker entry point for durable Greyveil generation jobs.

Run this in a trusted environment with a checkout of this repository and
SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY. It intentionally is not an Edge
Function: DOCX processing and PDF/EPUB/DOCX rendering must not run in a public
request. The worker claims queued rows, records real stage transitions, and
keeps every candidate artifact in the private generation-candidates bucket.
"""

from __future__ import annotations

import json
import os
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

from docx import Document

from generate_book import main as generate_book_main
from greyveil.importer import detect_metadata, import_docx, parse_manuscript
from greyveil.jobs import GenerationStage, utc_now
from greyveil.loader import load_book
from greyveil.qa import validate_generated_outputs


ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
STAGES = {
    "IMPORTING": 8, "NORMALIZING": 24, "VALIDATING_SOURCE": 38,
    "GENERATING_PDF": 52, "GENERATING_EPUB": 66, "GENERATING_DOCX": 80,
    "VALIDATING_OUTPUTS": 92,
}


def request(path: str, method: str = "GET", body: object | None = None, content_type: str = "application/json") -> object:
    if not URL or not KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required by the external worker.")
    payload = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    headers = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Prefer": "return=representation"}
    if payload is not None:
        headers["Content-Type"] = content_type
    with urllib.request.urlopen(urllib.request.Request(URL + path, data=payload, headers=headers, method=method), timeout=60) as response:
        raw = response.read()
    return json.loads(raw) if raw and content_type == "application/json" else raw


def patch_job(job_id: str, **changes: object) -> None:
    history = changes.pop("stage_history", None)
    if history is not None:
        changes["stage_history"] = history
    request(f"/rest/v1/book_generation_jobs?id=eq.{urllib.parse.quote(job_id)}", "PATCH", changes)


def advance(job: dict, stage: str) -> None:
    history = list(job.get("stage_history") or [])
    history.append({"stage": stage, "progress": STAGES[stage], "occurredAt": utc_now()})
    patch_job(job["id"], status=stage, progress=STAGES[stage], started_at=job.get("started_at") or utc_now(), stage_history=history)


def storage_download(bucket: str, path: str, destination: Path) -> None:
    raw = request(f"/storage/v1/object/{bucket}/{urllib.parse.quote(path, safe='/')}", content_type="application/octet-stream")
    destination.write_bytes(raw)


def storage_upload(bucket: str, path: str, source: Path, mime: str) -> None:
    request(f"/storage/v1/object/{bucket}/{urllib.parse.quote(path, safe='/')}", "POST", source.read_bytes(), mime)


def detect(job: dict, manuscript: Path) -> None:
    document = Document(manuscript)
    parsed = parse_manuscript(document)
    metadata = detect_metadata(document, parsed["opening"])
    patch_job(job["id"], status="AWAITING_REVIEW", progress=24, metadata=metadata, warnings=[], completed_at=utc_now())


def run(job: dict) -> None:
    with tempfile.TemporaryDirectory(prefix=f"greyveil-job-{job['id']}-") as temp:
        work = Path(temp)
        manuscript = work / "manuscript.docx"
        storage_download("generation-inputs", job["manuscript_path"], manuscript)
        cover = None
        if job.get("cover_path"):
            cover = work / Path(job["cover_path"]).name
            storage_download("generation-inputs", job["cover_path"], cover)
        if not (job.get("metadata") or {}).get("title"):
            advance(job, "IMPORTING")
            detect(job, manuscript)
            return
        advance(job, "IMPORTING")
        result = import_docx(ROOT, manuscript, design_from=job.get("design_source_slug") or "the-last-shift", cover_path=cover, metadata_overrides=job["metadata"])
        if result.status != "imported":
            raise RuntimeError(result.error or "; ".join(result.warnings) or "Import requires founder review.")
        slug = result.slug
        output = work / "output"
        for stage, flag in (("GENERATING_PDF", "--pdf"), ("GENERATING_EPUB", "--epub"), ("GENERATING_DOCX", "--docx")):
            advance(job, stage)
            if generate_book_main([slug, flag, "--output-dir", str(output)]) != 0:
                raise RuntimeError(f"Existing generator failed during {stage}.")
        advance(job, "VALIDATING_OUTPUTS")
        model = load_book(ROOT, slug)
        files = {"pdf": output / "pdf" / f"{slug}.pdf", "epub": output / "epub" / f"{slug}.epub", "docx": output / "docx" / f"{slug}-print-editable.docx"}
        report = validate_generated_outputs(model, files)
        qa = {"source": not any(issue.severity == "error" for issue in model.issues), "pdf": files["pdf"].is_file(), "epub": files["epub"].is_file(), "docx": files["docx"].is_file(), "metadata": bool(job["metadata"].get("title")), "ok": report.ok}
        if not report.ok:
            raise RuntimeError("; ".join(report.errors))
        if not job.get("book_id"):
            series_title = ""
            if job.get("series_id"):
                series_rows = request(f"/rest/v1/series?id=eq.{urllib.parse.quote(str(job['series_id']))}&select=title")
                series_title = (series_rows[0] if series_rows else {}).get("title", "")
            created = request("/rest/v1/books", "POST", [{
                "title": job["metadata"].get("title", slug), "slug": slug, "series": series_title,
                "series_id": job.get("series_id"), "book_number": job.get("book_number"),
                "visibility": "private", "is_public": False, "is_active": False,
                "price_amount": job.get("price_amount"),
            }])
            if not created:
                raise RuntimeError("Candidate book record could not be created.")
            job["book_id"] = created[0]["id"]
            patch_job(job["id"], book_id=job["book_id"])
        candidate = {}
        for kind, file in files.items():
            path = f"jobs/{job['id']}/{file.name}"
            storage_upload("generation-candidates", path, file, {"pdf": "application/pdf", "epub": "application/epub+zip", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}[kind])
            candidate[kind] = path
        patch_job(job["id"], status="READY_TO_PUBLISH", progress=100, qa=qa, candidate=candidate, warnings=report.warnings, completed_at=utc_now())


def claim_one() -> dict | None:
    rows = request("/rest/v1/book_generation_jobs?status=eq.QUEUED&order=created_at.asc&limit=1")
    return rows[0] if rows else None


def main() -> int:
    job = claim_one()
    if not job:
        print("No queued Greyveil generation jobs.")
        return 0
    try:
        run(job)
        print(f"Processed generation job {job['id']}")
        return 0
    except Exception as exc:  # noqa: BLE001 - persist an operator-readable worker failure.
        patch_job(job["id"], status="FAILED", error=str(exc), completed_at=utc_now())
        print(f"Generation job {job['id']} failed: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
