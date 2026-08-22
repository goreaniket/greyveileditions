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
import re
import shutil
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator

from docx import Document

from generate_book import main as generate_book_main
from greyveil.importer import detect_metadata, import_docx, normalize_approved_slug, parse_manuscript
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
CANDIDATE_KINDS = frozenset({"pdf", "epub", "docx", "source", "cover", "qa"})
COVER_INPUT_PATTERN = re.compile(r"^jobs/([0-9a-f-]{36})/cover\.(png|jpe?g|webp)$")
HEARTBEAT_INTERVAL_SECONDS = 5 * 60
HEARTBEAT_MAX_SILENCE_SECONDS = 20 * 60
HEARTBEAT_REQUEST_TIMEOUT_SECONDS = 10


class ClaimLostError(RuntimeError):
    """The database no longer recognizes this worker's claim token."""


class HeartbeatUnavailableError(RuntimeError):
    """Heartbeat transport stayed unavailable too close to lease expiry."""


class ClaimHeartbeat:
    """Renew one claim in the background without preventing process shutdown."""

    def __init__(
        self,
        job: dict,
        *,
        interval_seconds: float = HEARTBEAT_INTERVAL_SECONDS,
        max_silence_seconds: float = HEARTBEAT_MAX_SILENCE_SECONDS,
        heartbeat_fn: Callable[[dict], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if interval_seconds <= 0 or max_silence_seconds <= interval_seconds:
            raise ValueError("Heartbeat timing must preserve a positive lease-safety margin.")
        self.job = job
        self.interval_seconds = interval_seconds
        self.max_silence_seconds = max_silence_seconds
        self.heartbeat_fn = heartbeat_fn or heartbeat_job
        self.clock = clock
        self._last_confirmed = clock()
        self._failure: RuntimeError | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def is_running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("Generation claim heartbeat was already started.")
        self._renew()
        self.raise_if_unhealthy()
        self._thread = threading.Thread(target=self._run, name="greyveil-claim-heartbeat", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=HEARTBEAT_REQUEST_TIMEOUT_SECONDS + 1)

    def raise_if_unhealthy(self) -> None:
        with self._lock:
            failure = self._failure
            last_confirmed = self._last_confirmed
        if failure is None and self.clock() - last_confirmed >= self.max_silence_seconds:
            self._record_failure(
                HeartbeatUnavailableError("Generation worker heartbeat exceeded its safe retry window.")
            )
            with self._lock:
                failure = self._failure
        thread = self._thread
        if failure is None and thread is not None and not thread.is_alive() and not self._stop.is_set():
            self._record_failure(HeartbeatUnavailableError("Generation claim heartbeat stopped unexpectedly."))
            with self._lock:
                failure = self._failure
        if failure is not None:
            raise failure

    def _run(self) -> None:
        try:
            while not self._stop.wait(self.interval_seconds):
                self._renew()
                with self._lock:
                    if self._failure is not None:
                        return
        except BaseException:  # Thread death must become visible to main-thread checkpoints.
            self._record_failure(HeartbeatUnavailableError("Generation claim heartbeat stopped unexpectedly."))

    def _renew(self) -> None:
        try:
            self.heartbeat_fn(self.job)
        except ClaimLostError:
            self._record_failure(ClaimLostError("Generation job claim was lost to another worker."))
        except Exception:  # noqa: BLE001 - transport failures get a bounded grace window.
            with self._lock:
                last_confirmed = self._last_confirmed
            if self.clock() - last_confirmed >= self.max_silence_seconds:
                self._record_failure(
                    HeartbeatUnavailableError("Generation worker heartbeat exceeded its safe retry window.")
                )
        else:
            with self._lock:
                self._last_confirmed = self.clock()

    def _record_failure(self, failure: RuntimeError) -> None:
        with self._lock:
            if self._failure is None:
                self._failure = failure
        self._stop.set()


@dataclass(frozen=True)
class GenerationWorkspace:
    """A deterministic, disposable filesystem boundary for one generation job."""

    root: Path
    inputs: Path
    repository: Path
    outputs: Path
    candidates: Path


def canonical_job_id(value: object) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, AttributeError, TypeError) as exc:
        raise RuntimeError("Generation job has an invalid UUID.") from exc


def validate_job_input_paths(job: dict) -> tuple[str, str | None]:
    """Require every input object to be owned by the current job UUID."""
    job_id = canonical_job_id(job.get("id"))
    manuscript_path = job.get("manuscript_path")
    expected_manuscript = f"jobs/{job_id}/manuscript.docx"
    if manuscript_path != expected_manuscript:
        raise RuntimeError("Generation manuscript path is not bound to the current job UUID.")
    cover_path = job.get("cover_path") or None
    if cover_path is not None:
        match = COVER_INPUT_PATTERN.fullmatch(str(cover_path))
        if not match or match.group(1) != job_id:
            raise RuntimeError("Generation cover path is not bound to the current job UUID.")
    return expected_manuscript, cover_path


def job_workspace_path(job_id: object, temp_root: Path | None = None) -> Path:
    """Resolve a UUID-only workspace path without accepting user path fragments."""
    system_temp = Path(tempfile.gettempdir()).resolve()
    selected_temp = (temp_root or system_temp).resolve()
    if selected_temp != system_temp and system_temp not in selected_temp.parents:
        raise RuntimeError("Generation workspace root is outside the trusted temporary directory.")
    expected_base = selected_temp / "greyveil-generation"
    base = expected_base.resolve()
    if base != expected_base:
        raise RuntimeError("Generation workspace root is redirected outside its trusted path.")
    expected_target = base / canonical_job_id(job_id)
    target = expected_target.resolve()
    if target != expected_target or target.parent != base:
        raise RuntimeError("Generation workspace escaped its trusted temporary root.")
    return target


def remove_job_workspace(job_id: object, temp_root: Path | None = None, *, ignore_errors: bool = False) -> None:
    """Revalidate the exact temp/UUID boundary immediately before recursive deletion."""
    root = job_workspace_path(job_id, temp_root)
    if root.exists():
        shutil.rmtree(root, ignore_errors=ignore_errors)


@contextmanager
def isolated_job_workspace(job_id: object, temp_root: Path | None = None) -> Iterator[GenerationWorkspace]:
    """Start clean for a job and remove all temporary inputs and outputs on exit."""
    root = job_workspace_path(job_id, temp_root)
    remove_job_workspace(job_id, temp_root)
    workspace = GenerationWorkspace(
        root=root,
        inputs=root / "inputs",
        repository=root / "repository",
        outputs=root / "outputs",
        candidates=root / "candidates",
    )
    for directory in (workspace.inputs, workspace.repository, workspace.outputs, workspace.candidates):
        directory.mkdir(parents=True, exist_ok=True)
    try:
        yield workspace
    finally:
        remove_job_workspace(job_id, temp_root, ignore_errors=True)


def authoritative_job_slug(job: dict) -> str:
    """Use the canonical Book slug for regeneration, otherwise the approved Admin slug."""
    if job.get("book_id") is not None:
        try:
            book_id = int(job["book_id"])
        except (TypeError, ValueError) as exc:
            raise RuntimeError("Generation job has an invalid Book id.") from exc
        if book_id <= 0:
            raise RuntimeError("Generation job has an invalid Book id.")
        rows = request(f"/rest/v1/books?id=eq.{book_id}&select=slug")
        if not isinstance(rows, list) or len(rows) != 1:
            raise RuntimeError("Existing Book canonical slug could not be resolved.")
        candidate = rows[0].get("slug") if isinstance(rows[0], dict) else None
    else:
        candidate = (job.get("metadata") or {}).get("slug")
    try:
        return normalize_approved_slug(candidate)
    except ValueError as exc:
        authority = "canonical Book" if job.get("book_id") is not None else "Admin-approved"
        raise RuntimeError(f"The {authority} slug is missing or unsafe.") from exc


def candidate_object_path(job_id: object, kind: str, filename: str) -> str:
    canonical_id = canonical_job_id(job_id)
    if kind not in CANDIDATE_KINDS:
        raise RuntimeError("Candidate artifact kind is not allowed.")
    if (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", filename or "")
        or ".." in filename
        or Path(filename).name != filename
    ):
        raise RuntimeError("Candidate artifact filename is unsafe.")
    return f"jobs/{canonical_id}/{kind}/{filename}"


def request(
    path: str,
    method: str = "GET",
    body: object | None = None,
    content_type: str = "application/json",
    extra_headers: dict[str, str] | None = None,
    timeout_seconds: float = 60,
) -> object:
    if not URL or not KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required by the external worker.")
    payload = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    headers = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Prefer": "return=representation"}
    if payload is not None:
        headers["Content-Type"] = content_type
    if extra_headers:
        headers.update(extra_headers)
    with urllib.request.urlopen(
        urllib.request.Request(URL + path, data=payload, headers=headers, method=method),
        timeout=timeout_seconds,
    ) as response:
        raw = response.read()
    return json.loads(raw) if raw and content_type == "application/json" else raw


def heartbeat_job(job: dict) -> None:
    """Renew only the exact service-owned claim; false means authority was lost."""
    valid = request("/rest/v1/rpc/greyveil_worker_heartbeat_generation_job", "POST", {
        "target_job_id": canonical_job_id(job.get("id")),
        "claim_token": canonical_job_id(job.get("_claim_token")),
    }, timeout_seconds=HEARTBEAT_REQUEST_TIMEOUT_SECONDS)
    if valid is not True:
        raise ClaimLostError("Generation job claim was lost to another worker.")


def require_live_claim(job: dict) -> None:
    heartbeat = job.get("_heartbeat")
    if isinstance(heartbeat, ClaimHeartbeat):
        heartbeat.raise_if_unhealthy()


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
    require_live_claim(job)
    release_job(job, status="AWAITING_REVIEW", progress=24, metadata=metadata, warnings=[], completed_at=utc_now())


def source_archive(repository_root: Path, candidate_dir: Path, slug: str) -> Path:
    """Archive only the imported book source; the archive stays private."""
    source = repository_root / "assets" / "books" / slug
    return Path(shutil.make_archive(str(candidate_dir / f"{slug}-source"), "zip", source.parent, source.name))


def cover_file(repository_root: Path, slug: str) -> Path:
    model = load_book(repository_root, slug)
    for role in ("web", "source", "print"):
        cover = next((asset for asset in model.cover_assets if asset.role == role and asset.exists), None)
        if cover and cover.resolved_path:
            return cover.resolved_path
    raise RuntimeError("Imported source has no cover asset.")


def cover_mime(path: Path) -> str:
    return {".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}.get(path.suffix.lower(), "image/jpeg")


def upload_candidate(job: dict, kind: str, file: Path, mime: str) -> dict[str, object]:
    """Replace only this job's candidate object so retries converge on one path."""
    path = candidate_object_path(job.get("id"), kind, file.name)
    storage_upload("generation-candidates", path, file, mime, upsert=True)
    return {"path": path, "file_name": file.name, "file_size": file.stat().st_size, "mime_type": mime}


def run(job: dict) -> None:
    job_id = canonical_job_id(job.get("id"))
    manuscript_path, cover_path = validate_job_input_paths(job)
    require_live_claim(job)
    with isolated_job_workspace(job_id) as workspace:
        manuscript = workspace.inputs / "manuscript.docx"
        storage_download("generation-inputs", manuscript_path, manuscript)
        require_live_claim(job)
        cover = None
        if cover_path:
            cover = workspace.inputs / f"cover{Path(cover_path).suffix.lower()}"
            storage_download("generation-inputs", cover_path, cover)
            require_live_claim(job)
        if not (job.get("metadata") or {}).get("title"):
            advance(job, "IMPORTING")
            detect(job, manuscript)
            return
        slug = authoritative_job_slug(job)
        try:
            design_source_slug = normalize_approved_slug(job.get("design_source_slug") or "the-last-shift")
        except ValueError as exc:
            raise RuntimeError("Generation design-source slug is unsafe.") from exc
        metadata = dict(job.get("metadata") or {})
        metadata["slug"] = slug
        job["metadata"] = metadata
        require_live_claim(job)
        patch_job(job, metadata=metadata)
        advance(job, "IMPORTING")
        result = import_docx(
            ROOT,
            manuscript,
            design_from=design_source_slug,
            cover_path=cover,
            metadata_overrides=metadata,
            workspace_root=workspace.repository,
            approved_slug=slug,
        )
        require_live_claim(job)
        if result.status != "imported":
            raise RuntimeError(result.error or "; ".join(result.warnings) or "Import requires founder review.")
        if result.slug != slug:
            raise RuntimeError("Imported slug did not match the authoritative generation slug.")
        for stage, flag in (("GENERATING_PDF", "--pdf"), ("GENERATING_EPUB", "--epub"), ("GENERATING_DOCX", "--docx")):
            advance(job, stage)
            if generate_book_main([
                slug, flag,
                "--repo-root", str(workspace.repository),
                "--output-dir", str(workspace.outputs),
            ]) != 0:
                raise RuntimeError(f"Existing generator failed during {stage}.")
            require_live_claim(job)
        advance(job, "VALIDATING_OUTPUTS")
        model = load_book(workspace.repository, slug)
        files = {
            "pdf": workspace.outputs / "pdf" / f"{slug}.pdf",
            "epub": workspace.outputs / "epub" / f"{slug}.epub",
            "docx": workspace.outputs / "docx" / f"{slug}-print-editable.docx",
        }
        report = validate_generated_outputs(model, files)
        require_live_claim(job)
        qa = {"source": not any(issue.severity == "error" for issue in model.issues), "pdf": files["pdf"].is_file(), "epub": files["epub"].is_file(), "docx": files["docx"].is_file(), "metadata": bool(metadata.get("title")), "ok": report.ok}
        if not report.ok:
            raise RuntimeError("; ".join(report.errors))
        if not job.get("book_id"):
            series_title = ""
            if job.get("series_id"):
                series_rows = request(f"/rest/v1/series?id=eq.{urllib.parse.quote(str(job['series_id']))}&select=title")
                series_title = (series_rows[0] if series_rows else {}).get("title", "")
            require_live_claim(job)
            created = request("/rest/v1/books", "POST", [{
                "title": metadata.get("title", slug), "slug": slug, "series": series_title,
                "series_id": job.get("series_id"), "book_number": job.get("book_number"),
                "visibility": "private", "is_public": False, "is_active": False,
                "price_amount": job.get("price_amount"),
            }])
            require_live_claim(job)
            if not created:
                raise RuntimeError("Candidate book record could not be created.")
            job["book_id"] = created[0]["id"]
            patch_job(job, book_id=job["book_id"])
        archive = source_archive(workspace.repository, workspace.candidates, slug)
        require_live_claim(job)
        front_cover = cover_file(workspace.repository, slug)
        candidate: dict[str, object] = {"version": job_id, "slug": slug}
        for kind, file in {**files, "source": archive, "cover": front_cover}.items():
            require_live_claim(job)
            mime = cover_mime(file) if kind == "cover" else MIMES[kind]
            candidate[kind] = upload_candidate(job, kind, file, mime)
            require_live_claim(job)
        qa_file = workspace.candidates / "qa.json"
        qa_file.write_text(json.dumps({"qa": qa, "warnings": report.warnings, "errors": report.errors}, indent=2), encoding="utf-8")
        candidate["qa"] = upload_candidate(job, "qa", qa_file, MIMES["qa"])
        require_live_claim(job)
        release_job(job, status="READY_TO_PUBLISH", progress=100, qa=qa, candidate=candidate, warnings=report.warnings, completed_at=utc_now())


def candidate_entry(job: dict, kind: str) -> dict:
    entry = (job.get("candidate") or {}).get(kind)
    path = entry.get("path") if isinstance(entry, dict) else None
    if not isinstance(entry, dict) or not isinstance(path, str) or not path.startswith(f"jobs/{job['id']}/{kind}/"):
        raise RuntimeError(f"Candidate {kind} is missing or has an unsafe path.")
    return entry


def promote(job: dict) -> None:
    """Copy verified private candidates before atomically switching DB references."""
    require_live_claim(job)
    if not (job.get("qa") or {}).get("ok"):
        raise RuntimeError("Publication requires a successful QA result.")
    slug = (job.get("candidate") or {}).get("slug")
    if not isinstance(slug, str) or not slug.replace("-", "").isalnum():
        raise RuntimeError("Candidate has an unsafe or missing slug.")
    published: dict[str, dict] = {}
    for kind in ("pdf", "epub", "docx", "source", "cover"):
        require_live_claim(job)
        entry = candidate_entry(job, kind)
        temp_dir = Path(tempfile.mkdtemp(prefix="greyveil-promote-"))
        source = temp_dir / entry["file_name"]
        try:
            storage_download("generation-candidates", entry["path"], source)
            require_live_claim(job)
            bucket = "book-covers" if kind == "cover" else "book-files"
            target = f"published/{slug}/{job['id']}/{kind}/{entry['file_name']}"
            storage_upload(bucket, target, source, entry["mime_type"], upsert=True)
            require_live_claim(job)
            published[kind] = {**entry, "path": target, "bucket": bucket}
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
    require_live_claim(job)
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
    heartbeat = ClaimHeartbeat(job)
    job["_heartbeat"] = heartbeat
    try:
        heartbeat.start()
        if job["status"] == "PUBLISH_REQUESTED":
            promote(job)
        else:
            run(job)
        print(f"Processed generation job {job['id']}")
        return 0
    except Exception as exc:  # noqa: BLE001 - persist an operator-readable worker failure.
        heartbeat.stop()
        try:
            release_job(job, status="FAILED", error=str(exc), completed_at=utc_now())
        except Exception:  # noqa: BLE001 - never mask the original worker failure.
            print(f"Generation job {job['id']} failure state could not be recorded.")
        print(f"Generation job {job['id']} failed: {exc}")
        return 1
    finally:
        heartbeat.stop()
        job.pop("_heartbeat", None)


if __name__ == "__main__":
    raise SystemExit(main())
