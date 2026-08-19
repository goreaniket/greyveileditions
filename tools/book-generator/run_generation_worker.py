#!/usr/bin/env python
"""External worker entry point for durable Greyveil generation jobs.

Run this in a trusted environment with a checkout of this repository and
SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY. It intentionally is not an Edge
Function: DOCX processing and PDF/EPUB/DOCX rendering must not run in a public
request. The worker claims queued rows, records real stage transitions, and
keeps every candidate artifact in the private generation-candidates bucket.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from docx import Document

from generate_book import main as generate_book_main
from greyveil.importer import detect_metadata, import_docx, parse_manuscript
from greyveil.jobs import utc_now
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
MIMES = {
    "pdf": "application/pdf", "epub": "application/epub+zip",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "source": "application/zip", "qa": "application/json",
}


def request(path: str, method: str = "GET", body: object | None = None, content_type: str = "application/json", extra_headers: dict[str, str] | None = None) -> object:
    if not URL or not KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required by the external worker.")
    payload = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    headers = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Prefer": "return=representation"}
    if payload is not None:
        headers["Content-Type"] = content_type
    if extra_headers:
        headers.update(extra_headers)
    with urllib.request.urlopen(urllib.request.Request(URL + path, data=payload, headers=headers, method=method), timeout=60) as response:
        raw = response.read()
    return json.loads(raw) if raw and content_type == "application/json" else raw


def patch_job(job: dict, **changes: object) -> None:
    """Write only while this worker still owns the atomically claimed job."""
    changes["heartbeat_at"] = utc_now()
    query = urllib.parse.urlencode({"id": f"eq.{job['id']}", "worker_token": f"eq.{job['_claim_token']}"})
    updated = request(f"/rest/v1/book_generation_jobs?{query}", "PATCH", changes)
    if not updated:
        raise RuntimeError("Generation job claim was lost to another worker.")


def release_job(job: dict, **changes: object) -> None:
    changes["worker_token"] = None
    patch_job(job, **changes)


def advance(job: dict, stage: str) -> None:
    history = list(job.get("stage_history") or [])
    history.append({"stage": stage, "progress": STAGES[stage], "occurredAt": utc_now()})
    patch_job(job, status=stage, progress=STAGES[stage], started_at=job.get("started_at") or utc_now(), stage_history=history)


def storage_download(bucket: str, path: str, destination: Path) -> None:
    raw = request(f"/storage/v1/object/{bucket}/{urllib.parse.quote(path, safe='/')}", content_type="application/octet-stream")
    destination.write_bytes(raw)


def storage_upload(bucket: str, path: str, source: Path, mime: str, *, upsert: bool = False) -> None:
    request(f"/storage/v1/object/{bucket}/{urllib.parse.quote(path, safe='/')}", "POST", source.read_bytes(), mime, {"x-upsert": "true"} if upsert else None)


def detect(job: dict, manuscript: Path) -> None:
    document = Document(manuscript)
    parsed = parse_manuscript(document)
    metadata = detect_metadata(document, parsed["opening"])
    release_job(job, status="AWAITING_REVIEW", progress=24, metadata=metadata, warnings=[], completed_at=utc_now())


def source_archive(work: Path, slug: str) -> Path:
    """Archive only the imported book source; the archive stays private."""
    source = ROOT / "assets" / "books" / slug
    return Path(shutil.make_archive(str(work / f"{slug}-source"), "zip", source.parent, source.name))


def cover_file(slug: str) -> Path:
    covers = sorted((ROOT / "assets" / "books" / slug / "cover").glob("*"))
    if not covers:
        raise RuntimeError("Imported source has no cover asset.")
    return covers[0]


def cover_mime(path: Path) -> str:
    return {".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}.get(path.suffix.lower(), "image/jpeg")


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
            patch_job(job, book_id=job["book_id"])
        archive = source_archive(work, slug)
        front_cover = cover_file(slug)
        candidate: dict[str, object] = {"version": str(job["id"]), "slug": slug}
        for kind, file in {**files, "source": archive, "cover": front_cover}.items():
            path = f"jobs/{job['id']}/{kind}/{file.name}"
            mime = cover_mime(file) if kind == "cover" else MIMES[kind]
            storage_upload("generation-candidates", path, file, mime)
            candidate[kind] = {"path": path, "file_name": file.name, "file_size": file.stat().st_size, "mime_type": mime}
        qa_file = work / "qa.json"
        qa_file.write_text(json.dumps({"qa": qa, "warnings": report.warnings, "errors": report.errors}, indent=2), encoding="utf-8")
        qa_path = f"jobs/{job['id']}/qa/qa.json"
        storage_upload("generation-candidates", qa_path, qa_file, MIMES["qa"])
        candidate["qa"] = {"path": qa_path, "file_name": qa_file.name, "file_size": qa_file.stat().st_size, "mime_type": MIMES["qa"]}
        release_job(job, status="READY_TO_PUBLISH", progress=100, qa=qa, candidate=candidate, warnings=report.warnings, completed_at=utc_now())


def candidate_entry(job: dict, kind: str) -> dict:
    entry = (job.get("candidate") or {}).get(kind)
    path = entry.get("path") if isinstance(entry, dict) else None
    if not isinstance(entry, dict) or not isinstance(path, str) or not path.startswith(f"jobs/{job['id']}/{kind}/"):
        raise RuntimeError(f"Candidate {kind} is missing or has an unsafe path.")
    return entry


def promote(job: dict) -> None:
    """Copy verified private candidates before atomically switching DB references."""
    if not (job.get("qa") or {}).get("ok"):
        raise RuntimeError("Publication requires a successful QA result.")
    slug = (job.get("candidate") or {}).get("slug")
    if not isinstance(slug, str) or not slug.replace("-", "").isalnum():
        raise RuntimeError("Candidate has an unsafe or missing slug.")
    published: dict[str, dict] = {}
    for kind in ("pdf", "epub", "docx", "source", "cover"):
        entry = candidate_entry(job, kind)
        temp_dir = Path(tempfile.mkdtemp(prefix="greyveil-promote-"))
        source = temp_dir / entry["file_name"]
        try:
            storage_download("generation-candidates", entry["path"], source)
            bucket = "book-covers" if kind == "cover" else "book-files"
            target = f"published/{slug}/{job['id']}/{kind}/{entry['file_name']}"
            storage_upload(bucket, target, source, entry["mime_type"], upsert=True)
            published[kind] = {**entry, "path": target, "bucket": bucket}
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
    result = request("/rest/v1/rpc/greyveil_worker_finalize_generation_publication", "POST", {
        "target_job_id": job["id"], "claim_token": job["_claim_token"], "published_artifacts": published,
    })
    if not result:
        raise RuntimeError("Publication finalization was rejected; canonical records were not switched.")


def claim_one(target_job_id: str | None = None) -> dict | None:
    claim_token = str(uuid.uuid4())
    claimed = request("/rest/v1/rpc/greyveil_worker_claim_generation_job", "POST", {
        "claim_token": claim_token, "target_job_id": target_job_id,
    })
    if not claimed:
        return None
    job = claimed[0] if isinstance(claimed, list) else claimed
    job["_claim_token"] = claim_token
    return job


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Process one trusted Greyveil generation or publication job.")
    parser.add_argument("--once", action="store_true", help="Process at most one job (the default).")
    parser.add_argument("--job", help="Process one specific queued or publish-requested job UUID.")
    args = parser.parse_args(argv)
    job = claim_one(args.job)
    if not job:
        print("No eligible Greyveil generation jobs.")
        return 0
    try:
        if job["status"] == "PUBLISH_REQUESTED":
            promote(job)
        else:
            run(job)
        print(f"Processed generation job {job['id']}")
        return 0
    except Exception as exc:  # noqa: BLE001 - persist an operator-readable worker failure.
        try:
            release_job(job, status="FAILED", error=str(exc), completed_at=utc_now())
        except RuntimeError as release_error:
            if "claim was lost" not in str(release_error):
                raise
        print(f"Generation job {job['id']} failed: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
