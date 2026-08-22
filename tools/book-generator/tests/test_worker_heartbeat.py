"""Behavioral claim-heartbeat and stale-lease resilience checks."""

from __future__ import annotations

import sys
import tempfile
import threading
import unittest
import uuid
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


BOOK_GENERATOR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BOOK_GENERATOR))

import run_generation_worker as worker  # noqa: E402


ACTIVE_STATES = {
    "IMPORTING", "NORMALIZING", "VALIDATING_SOURCE", "GENERATING_PDF",
    "GENERATING_EPUB", "GENERATING_DOCX", "VALIDATING_OUTPUTS", "PUBLISH_REQUESTED",
}
LEASE_SECONDS = 30 * 60


class FakeLeaseStore:
    def __init__(self, job_id: str, token: str) -> None:
        self.now = 0.0
        self.job = {
            "id": job_id,
            "status": "IMPORTING",
            "worker_token": token,
            "claimed_at": self.now,
            "heartbeat_at": self.now,
        }

    def request(self, path: str, method: str = "GET", body=None, **_kwargs):
        if path != "/rest/v1/rpc/greyveil_worker_heartbeat_generation_job" or method != "POST":
            raise AssertionError(f"Unexpected request: {method} {path}")
        valid = (
            body["target_job_id"] == self.job["id"]
            and body["claim_token"] == self.job["worker_token"]
            and self.job["status"] in ACTIVE_STATES
        )
        if valid:
            self.job["heartbeat_at"] = self.now
        return valid

    def claim(self, token: str) -> bool:
        stale = (
            self.job["status"] in ACTIVE_STATES
            and self.job["heartbeat_at"] < self.now - LEASE_SECONDS
        )
        eligible = (
            self.job["worker_token"] is None
            and self.job["status"] in {"QUEUED", "PUBLISH_REQUESTED"}
        ) or stale
        if not eligible:
            return False
        self.job.update(worker_token=token, claimed_at=self.now, heartbeat_at=self.now)
        return True


class WorkerHeartbeatTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="greyveil-heartbeat-")
        self.temp_path = Path(self.temp_dir.name)
        self.job_id = str(uuid.uuid4())
        self.token = str(uuid.uuid4())

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_valid_claim_heartbeats_but_wrong_token_and_inactive_state_do_not(self) -> None:
        store = FakeLeaseStore(self.job_id, self.token)
        job = {"id": self.job_id, "_claim_token": self.token}
        store.now = 45
        with patch.object(worker, "request", side_effect=store.request):
            worker.heartbeat_job(job)
            self.assertEqual(store.job["heartbeat_at"], 45)

            with self.assertRaises(worker.ClaimLostError):
                worker.heartbeat_job({**job, "_claim_token": str(uuid.uuid4())})

            with self.assertRaises(worker.ClaimLostError):
                worker.heartbeat_job({**job, "id": str(uuid.uuid4())})

            for status in ("READY_TO_PUBLISH", "PUBLISHED", "FAILED", "CANCELLED"):
                with self.subTest(status=status):
                    store.job["status"] = status
                    with self.assertRaises(worker.ClaimLostError):
                        worker.heartbeat_job(job)
        self.assertEqual(store.job["heartbeat_at"], 45)

    def test_fresh_heartbeat_prevents_reclaim_but_stopped_worker_becomes_reclaimable(self) -> None:
        store = FakeLeaseStore(self.job_id, self.token)
        job = {"id": self.job_id, "_claim_token": self.token}
        with patch.object(worker, "request", side_effect=store.request):
            store.now = 15 * 60
            worker.heartbeat_job(job)
            store.now = 31 * 60
            worker.heartbeat_job(job)
            store.now = 40 * 60
            self.assertFalse(store.claim(str(uuid.uuid4())))

            # Once the healthy worker stops renewing, the unchanged 30-minute
            # reclaim rule makes the same job available to a new token.
            store.now = 62 * 60
            replacement = str(uuid.uuid4())
            self.assertTrue(store.claim(replacement))
            self.assertEqual(store.job["worker_token"], replacement)

    def test_transient_heartbeat_failure_can_recover_inside_safety_window(self) -> None:
        recovered = threading.Event()
        attempts = 0

        def heartbeat(_job: dict) -> None:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise OSError("temporary transport failure")
            recovered.set()

        claim = worker.ClaimHeartbeat(
            {"id": self.job_id, "_claim_token": self.token},
            interval_seconds=0.01,
            max_silence_seconds=0.5,
            heartbeat_fn=heartbeat,
        )
        claim.start()
        self.assertTrue(recovered.wait(1), "heartbeat did not recover")
        claim.raise_if_unhealthy()
        claim.stop()
        self.assertFalse(claim.is_running)

    def test_repeated_transport_failure_stops_before_lease_expiry(self) -> None:
        clock_values = iter((0.0, 21.0))
        claim = worker.ClaimHeartbeat(
            {"id": self.job_id, "_claim_token": self.token},
            interval_seconds=1,
            max_silence_seconds=20,
            heartbeat_fn=lambda _job: (_ for _ in ()).throw(OSError("offline")),
            clock=lambda: next(clock_values),
        )
        with self.assertRaises(worker.HeartbeatUnavailableError):
            claim.start()
        claim.stop()
        self.assertFalse(claim.is_running)

    def test_failure_timeline_aborts_with_ten_minute_lease_margin(self) -> None:
        now = [0.0]

        def heartbeat(_job: dict) -> None:
            if now[0] >= 10 * 60:
                raise OSError("transport unavailable")

        claim = worker.ClaimHeartbeat(
            {"id": self.job_id, "_claim_token": self.token},
            interval_seconds=5 * 60,
            max_silence_seconds=20 * 60,
            heartbeat_fn=heartbeat,
            clock=lambda: now[0],
        )
        claim.start()
        for minute in (5, 10, 15, 20):
            now[0] = minute * 60
            claim._renew()
            claim.raise_if_unhealthy()
        now[0] = 25 * 60
        claim._renew()
        with self.assertRaises(worker.HeartbeatUnavailableError):
            claim.raise_if_unhealthy()
        claim.stop()
        self.assertFalse(claim.is_running)

    def test_unexpected_heartbeat_thread_death_is_visible_to_main_thread(self) -> None:
        crashed = threading.Event()
        attempts = 0

        def heartbeat(_job: dict) -> None:
            nonlocal attempts
            attempts += 1
            if attempts > 1:
                crashed.set()
                raise SystemExit("simulated heartbeat thread crash")

        claim = worker.ClaimHeartbeat(
            {"id": self.job_id, "_claim_token": self.token},
            interval_seconds=0.01,
            max_silence_seconds=0.5,
            heartbeat_fn=heartbeat,
        )
        claim.start()
        self.assertTrue(crashed.wait(1), "heartbeat thread did not execute its crash path")
        with self.assertRaises(worker.HeartbeatUnavailableError):
            claim.raise_if_unhealthy()
        claim.stop()
        self.assertFalse(claim.is_running)

    def test_main_checkpoint_rejects_live_but_starved_heartbeat_thread(self) -> None:
        now = [0.0]
        claim = worker.ClaimHeartbeat(
            {"id": self.job_id, "_claim_token": self.token},
            interval_seconds=5 * 60,
            max_silence_seconds=20 * 60,
            heartbeat_fn=lambda _job: None,
            clock=lambda: now[0],
        )
        claim.start()
        self.assertTrue(claim.is_running)
        now[0] = 20 * 60
        with self.assertRaises(worker.HeartbeatUnavailableError):
            claim.raise_if_unhealthy()
        claim.stop()
        self.assertFalse(claim.is_running)

    def test_one_claim_cannot_start_multiple_heartbeat_threads(self) -> None:
        claim = worker.ClaimHeartbeat(
            {"id": self.job_id, "_claim_token": self.token},
            interval_seconds=0.01,
            max_silence_seconds=0.5,
            heartbeat_fn=lambda _job: None,
        )
        claim.start()
        with self.assertRaisesRegex(RuntimeError, "already started"):
            claim.start()
        claim.stop()
        claim.stop()
        self.assertFalse(claim.is_running)

    def test_heartbeat_continues_during_blocked_pdf_and_docx_exports(self) -> None:
        heartbeat_count = 0
        heartbeat_condition = threading.Condition()
        pdf_entered = threading.Event()
        pdf_release = threading.Event()
        docx_entered = threading.Event()
        docx_release = threading.Event()

        def heartbeat(_job: dict) -> None:
            nonlocal heartbeat_count
            with heartbeat_condition:
                heartbeat_count += 1
                heartbeat_condition.notify_all()

        def generate(args: list[str]) -> int:
            flag = args[1]
            if flag == "--pdf":
                pdf_entered.set()
                self.assertTrue(pdf_release.wait(2), "PDF test export was not released")
            elif flag == "--docx":
                docx_entered.set()
                self.assertTrue(docx_release.wait(2), "DOCX test export was not released")
            return 0

        job, claim, mutations, errors = self.run_generation_in_thread(heartbeat, generate)
        self.assertTrue(pdf_entered.wait(1), "PDF export did not start")
        with heartbeat_condition:
            baseline = heartbeat_count
            self.assertTrue(
                heartbeat_condition.wait_for(lambda: heartbeat_count > baseline, timeout=1),
                "heartbeat did not continue during PDF export",
            )
        pdf_release.set()

        self.assertTrue(docx_entered.wait(1), "DOCX export did not start")
        with heartbeat_condition:
            baseline = heartbeat_count
            self.assertTrue(
                heartbeat_condition.wait_for(lambda: heartbeat_count > baseline, timeout=1),
                "heartbeat did not continue during DOCX export",
            )
        docx_release.set()

        errors.thread.join(2)
        errors.stack.close()
        claim.stop()
        self.assertFalse(errors.thread.is_alive())
        self.assertEqual(errors.values, [])
        self.assertTrue(any(change.get("status") == "READY_TO_PUBLISH" for change in mutations))
        self.assertFalse(claim.is_running)
        job.pop("_heartbeat", None)

    def test_claim_loss_during_pdf_blocks_all_later_authoritative_completion(self) -> None:
        claim_valid = True
        claim_lost = threading.Event()
        pdf_entered = threading.Event()
        pdf_release = threading.Event()
        generated_flags = []

        def heartbeat(_job: dict) -> None:
            if not claim_valid:
                claim_lost.set()
                raise worker.ClaimLostError("reassigned")

        def generate(args: list[str]) -> int:
            generated_flags.append(args[1])
            if args[1] == "--pdf":
                pdf_entered.set()
                self.assertTrue(pdf_release.wait(2), "PDF test export was not released")
            return 0

        job, claim, mutations, errors = self.run_generation_in_thread(heartbeat, generate)
        self.assertTrue(pdf_entered.wait(1), "PDF export did not start")
        claim_valid = False
        self.assertTrue(claim_lost.wait(1), "heartbeat did not detect claim loss")
        pdf_release.set()
        errors.thread.join(2)
        errors.stack.close()
        claim.stop()

        self.assertFalse(errors.thread.is_alive())
        self.assertEqual(len(errors.values), 1)
        self.assertIsInstance(errors.values[0], worker.ClaimLostError)
        self.assertEqual(generated_flags, ["--pdf"])
        self.assertFalse(any(change.get("status") == "READY_TO_PUBLISH" for change in mutations))
        job.pop("_heartbeat", None)

    def test_main_stops_heartbeat_after_ready_and_before_failed_release(self) -> None:
        ready_job = self.worker_job()
        ready_heartbeat = []
        releases = []

        def successful_run(job: dict) -> None:
            ready_heartbeat.append(job["_heartbeat"])

            worker.release_job(job, status="READY_TO_PUBLISH")

        def ready_release(job: dict, **changes) -> None:
            releases.append((changes["status"], job["_heartbeat"].is_running))

        with (
            patch.object(worker, "claim_one", return_value=ready_job),
            patch.object(worker, "heartbeat_job"),
            patch.object(worker, "run", side_effect=successful_run),
            patch.object(worker, "release_job", side_effect=ready_release),
        ):
            self.assertEqual(worker.main(["--once"]), 0)
        self.assertEqual(releases, [("READY_TO_PUBLISH", True)])
        self.assertFalse(ready_heartbeat[0].is_running)

        failed_job = self.worker_job()
        failed_heartbeat = []

        def failed_run(job: dict) -> None:
            failed_heartbeat.append(job["_heartbeat"])
            raise RuntimeError("simulated generation failure")

        def failed_release(_job: dict, **changes) -> None:
            self.assertEqual(changes["status"], "FAILED")
            self.assertFalse(failed_heartbeat[0].is_running)
            raise OSError("failure transition transport unavailable")

        with (
            patch.object(worker, "claim_one", return_value=failed_job),
            patch.object(worker, "heartbeat_job"),
            patch.object(worker, "run", side_effect=failed_run),
            patch.object(worker, "release_job", side_effect=failed_release),
        ):
            self.assertEqual(worker.main(["--once"]), 1)
        self.assertFalse(failed_heartbeat[0].is_running)

    def test_claim_loss_during_publication_copy_prevents_finalization(self) -> None:
        claim_valid = True
        claim_lost = threading.Event()
        upload_entered = threading.Event()
        upload_release = threading.Event()
        errors = []
        job = {
            **self.worker_job(),
            "status": "PUBLISH_REQUESTED",
            "qa": {"ok": True},
            "candidate": {"slug": "lease-fixture"},
        }
        for kind in ("pdf", "epub", "docx", "source", "cover"):
            job["candidate"][kind] = {
                "path": f"jobs/{self.job_id}/{kind}/candidate-{kind}",
                "file_name": f"candidate-{kind}",
                "file_size": 1,
                "mime_type": "application/octet-stream",
            }

        def heartbeat(_job: dict) -> None:
            if not claim_valid:
                claim_lost.set()
                raise worker.ClaimLostError("reassigned")

        def blocked_upload(*_args, **_kwargs) -> None:
            upload_entered.set()
            self.assertTrue(upload_release.wait(2), "publication upload was not released")

        claim = worker.ClaimHeartbeat(
            job,
            interval_seconds=0.01,
            max_silence_seconds=0.5,
            heartbeat_fn=heartbeat,
        )
        job["_heartbeat"] = claim

        def target() -> None:
            try:
                worker.promote(job)
            except Exception as exc:  # noqa: BLE001 - captured for the test thread.
                errors.append(exc)

        with (
            patch.object(worker, "storage_download"),
            patch.object(worker, "storage_upload", side_effect=blocked_upload),
            patch.object(worker, "request") as mocked_request,
        ):
            claim.start()
            thread = threading.Thread(target=target, daemon=True)
            thread.start()
            self.assertTrue(upload_entered.wait(1), "publication copy did not start")
            claim_valid = False
            self.assertTrue(claim_lost.wait(1), "heartbeat did not detect publication claim loss")
            upload_release.set()
            thread.join(2)
            claim.stop()
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], worker.ClaimLostError)
            mocked_request.assert_not_called()
        self.assertFalse(claim.is_running)
        job.pop("_heartbeat", None)

    def test_no_job_starts_no_heartbeat_and_job_mode_stops_after_published(self) -> None:
        with (
            patch.object(worker, "claim_one", return_value=None),
            patch.object(worker, "ClaimHeartbeat") as heartbeat_constructor,
        ):
            self.assertEqual(worker.main(["--once"]), 0)
            heartbeat_constructor.assert_not_called()

        publish_job = {**self.worker_job(), "status": "PUBLISH_REQUESTED"}
        captured = []

        def successful_promote(job: dict) -> None:
            captured.append(job["_heartbeat"])
            job["status"] = "PUBLISHED"

        with (
            patch.object(worker, "claim_one", return_value=publish_job) as mocked_claim,
            patch.object(worker, "heartbeat_job"),
            patch.object(worker, "promote", side_effect=successful_promote),
        ):
            self.assertEqual(worker.main(["--job", self.job_id]), 0)
        mocked_claim.assert_called_once_with(self.job_id)
        self.assertEqual(publish_job["status"], "PUBLISHED")
        self.assertFalse(captured[0].is_running)

    def test_claim_token_fencing_rejects_all_old_owner_transitions(self) -> None:
        old_token = str(uuid.uuid4())
        new_token = str(uuid.uuid4())
        job = {"id": self.job_id, "_claim_token": old_token}

        def fenced_request(path: str, method: str = "GET", body=None, **_kwargs):
            self.assertEqual(method, "PATCH")
            return [{"id": self.job_id}] if new_token in path else []

        with patch.object(worker, "request", side_effect=fenced_request):
            with self.assertRaisesRegex(RuntimeError, "claim was lost"):
                worker.advance(job, "GENERATING_EPUB")
            with self.assertRaisesRegex(RuntimeError, "claim was lost"):
                worker.release_job(job, status="FAILED")
            with self.assertRaisesRegex(RuntimeError, "claim was lost"):
                worker.release_job(job, status="READY_TO_PUBLISH")

            job["_claim_token"] = new_token
            worker.release_job(job, status="READY_TO_PUBLISH")

    def worker_job(self) -> dict:
        return {
            "id": self.job_id,
            "_claim_token": self.token,
            "status": "IMPORTING",
            "stage_history": [],
        }

    def run_generation_in_thread(self, heartbeat_fn, generate_fn):
        job = {
            **self.worker_job(),
            "manuscript_path": f"jobs/{self.job_id}/manuscript.docx",
            "cover_path": None,
            "metadata": {"title": "Lease Fixture", "slug": "lease-fixture"},
            "design_source_slug": "the-last-shift",
            "book_id": 17,
        }
        claim = worker.ClaimHeartbeat(
            job,
            interval_seconds=0.01,
            max_silence_seconds=0.5,
            heartbeat_fn=heartbeat_fn,
        )
        job["_heartbeat"] = claim
        mutations = []
        errors = SimpleNamespace(values=[])
        original_workspace = worker.isolated_job_workspace

        def fake_patch(target: dict, **changes) -> None:
            mutations.append(dict(changes))
            target.update(changes)

        def target() -> None:
            try:
                worker.run(job)
            except Exception as exc:  # noqa: BLE001 - captured for the test thread.
                errors.values.append(exc)

        errors.stack = ExitStack()
        errors.stack.enter_context(patch.object(
            worker, "isolated_job_workspace", side_effect=lambda job_id: original_workspace(job_id, self.temp_path)
        ))
        errors.stack.enter_context(patch.object(worker, "storage_download"))
        errors.stack.enter_context(patch.object(worker, "authoritative_job_slug", return_value="lease-fixture"))
        errors.stack.enter_context(patch.object(worker, "patch_job", side_effect=fake_patch))
        errors.stack.enter_context(patch.object(
            worker,
            "import_docx",
            return_value=SimpleNamespace(status="imported", slug="lease-fixture", error="", warnings=[]),
        ))
        errors.stack.enter_context(patch.object(worker, "generate_book_main", side_effect=generate_fn))
        errors.stack.enter_context(patch.object(worker, "load_book", return_value=SimpleNamespace(issues=[])))
        errors.stack.enter_context(patch.object(
            worker,
            "validate_generated_outputs",
            return_value=SimpleNamespace(ok=True, errors=[], warnings=[]),
        ))
        errors.stack.enter_context(patch.object(worker, "source_archive", return_value=Path("candidate-source.zip")))
        errors.stack.enter_context(patch.object(worker, "cover_file", return_value=Path("front-cover.webp")))
        errors.stack.enter_context(patch.object(
            worker,
            "upload_candidate",
            side_effect=lambda _job, kind, file, mime: {
                "path": f"jobs/{self.job_id}/{kind}/{file.name}", "mime_type": mime,
            },
        ))
        self.addCleanup(errors.stack.close)
        self.addCleanup(claim.stop)
        claim.start()
        errors.thread = threading.Thread(target=target, daemon=True)
        errors.thread.start()

        return job, claim, mutations, errors


if __name__ == "__main__":
    unittest.main()
