"""Continuous-worker orchestration and Railway manifest regression checks."""

from __future__ import annotations

import ast
import json
import signal
import sys
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, call, patch


BOOK_GENERATOR = Path(__file__).resolve().parents[1]
REPO_ROOT = BOOK_GENERATOR.parents[1]
sys.path.insert(0, str(BOOK_GENERATOR))

import run_generation_worker as worker  # noqa: E402


class ContinuousWorkerTest(unittest.TestCase):
    def configuration(self, poll_seconds: float = 10.0) -> worker.WorkerLoopConfiguration:
        return worker.WorkerLoopConfiguration(poll_seconds=poll_seconds)

    def test_no_job_waits_instead_of_exiting_or_busy_looping(self) -> None:
        stop = threading.Event()
        waits = []

        def wait(seconds: float) -> bool:
            waits.append(seconds)
            stop.set()
            return True

        process = Mock(return_value=worker.ProcessOutcome.NO_JOB)
        self.assertEqual(
            worker.run_loop(self.configuration(7), stop_event=stop, process_fn=process, wait_fn=wait),
            0,
        )
        process.assert_called_once_with(None)
        self.assertEqual(waits, [7])

    def test_two_jobs_use_separate_claims_and_heartbeats_then_return_to_idle(self) -> None:
        stop = threading.Event()
        jobs = [
            {"id": str(uuid.uuid4()), "_claim_token": str(uuid.uuid4()), "status": "IMPORTING"},
            {"id": str(uuid.uuid4()), "_claim_token": str(uuid.uuid4()), "status": "IMPORTING"},
        ]

        def wait(_seconds: float) -> bool:
            stop.set()
            return True

        with (
            patch.object(worker, "claim_one", side_effect=[*jobs, None]) as claim_one,
            patch.object(worker, "heartbeat_job") as heartbeat_job,
            patch.object(worker, "run") as run_job,
        ):
            result = worker.run_loop(self.configuration(), stop_event=stop, wait_fn=wait)

        self.assertEqual(result, 0)
        self.assertEqual(claim_one.call_count, 3)
        self.assertEqual(run_job.call_args_list, [call(jobs[0]), call(jobs[1])])
        self.assertEqual(heartbeat_job.call_count, 2)
        self.assertNotEqual(jobs[0].get("_claim_token"), jobs[1].get("_claim_token"))
        self.assertNotIn("_heartbeat", jobs[0])
        self.assertNotIn("_heartbeat", jobs[1])

    def test_generation_failure_does_not_prevent_later_job(self) -> None:
        stop = threading.Event()
        first = {"id": str(uuid.uuid4()), "status": "IMPORTING"}
        second = {"id": str(uuid.uuid4()), "status": "IMPORTING"}

        def wait(_seconds: float) -> bool:
            stop.set()
            return True

        with (
            patch.object(worker, "claim_one", side_effect=[first, second, None]),
            patch.object(worker, "heartbeat_job"),
            patch.object(worker, "run", side_effect=[RuntimeError("generation failed"), None]) as run_job,
            patch.object(worker, "release_job") as release_job,
        ):
            worker.run_loop(self.configuration(), stop_event=stop, wait_fn=wait)

        self.assertEqual(run_job.call_count, 2)
        self.assertEqual(release_job.call_args.kwargs["status"], "FAILED")

    def test_claim_loss_does_not_prevent_later_job(self) -> None:
        stop = threading.Event()
        first = {"id": str(uuid.uuid4()), "status": "IMPORTING"}
        second = {"id": str(uuid.uuid4()), "status": "IMPORTING"}

        def wait(_seconds: float) -> bool:
            stop.set()
            return True

        with (
            patch.object(worker, "claim_one", side_effect=[first, second, None]),
            patch.object(worker, "heartbeat_job"),
            patch.object(worker, "run", side_effect=[worker.ClaimLostError("reclaimed"), None]) as run_job,
            patch.object(worker, "release_job", side_effect=worker.ClaimLostError("old token")),
        ):
            worker.run_loop(self.configuration(), stop_event=stop, wait_fn=wait)

        self.assertEqual(run_job.call_count, 2)

    def test_publication_job_uses_the_same_loop_and_heartbeat_lifecycle(self) -> None:
        stop = threading.Event()
        job = {"id": str(uuid.uuid4()), "status": "PUBLISH_REQUESTED"}

        def wait(_seconds: float) -> bool:
            stop.set()
            return True

        with (
            patch.object(worker, "claim_one", side_effect=[job, None]),
            patch.object(worker, "heartbeat_job") as heartbeat_job,
            patch.object(worker, "promote") as promote,
            patch.object(worker, "run") as run_job,
        ):
            worker.run_loop(self.configuration(), stop_event=stop, wait_fn=wait)

        promote.assert_called_once_with(job)
        run_job.assert_not_called()
        heartbeat_job.assert_called_once()
        self.assertNotIn("_heartbeat", job)

    def test_infrastructure_backoff_is_bounded_and_resets_after_success(self) -> None:
        stop = threading.Event()
        outcomes = iter((
            OSError("offline"),
            OSError("still offline"),
            worker.ProcessOutcome.NO_JOB,
            OSError("offline again"),
        ))
        waits = []

        def process(_target: str | None) -> worker.ProcessOutcome:
            outcome = next(outcomes)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        def wait(seconds: float) -> bool:
            waits.append(seconds)
            if len(waits) == 4:
                stop.set()
            return stop.is_set()

        worker.run_loop(self.configuration(10), stop_event=stop, process_fn=process, wait_fn=wait)
        self.assertEqual(waits, [5, 10, 10, 5])
        self.assertEqual(worker.infrastructure_backoff_seconds(100), 60)

    def test_job_transport_failure_is_infrastructure_not_book_failure(self) -> None:
        job = {"id": str(uuid.uuid4()), "_claim_token": str(uuid.uuid4()), "status": "IMPORTING"}
        with (
            patch.object(worker, "claim_one", return_value=job),
            patch.object(worker, "heartbeat_job"),
            patch.object(worker, "run", side_effect=OSError("network unavailable")),
            patch.object(worker, "release_job") as release_job,
        ):
            outcome = worker.process_one()
        self.assertIs(outcome, worker.ProcessOutcome.INFRASTRUCTURE_FAILED)
        release_job.assert_not_called()
        self.assertNotIn("_heartbeat", job)

    def test_shutdown_after_job_prevents_another_claim(self) -> None:
        stop = threading.Event()
        calls = []

        def process(target: str | None) -> worker.ProcessOutcome:
            calls.append(target)
            stop.set()
            return worker.ProcessOutcome.SUCCEEDED

        worker.run_loop(self.configuration(), stop_event=stop, process_fn=process)
        self.assertEqual(calls, [None])

    def test_keyboard_interrupt_exits_cleanly(self) -> None:
        stop = threading.Event()

        def interrupt(_target: str | None) -> worker.ProcessOutcome:
            raise KeyboardInterrupt

        self.assertEqual(
            worker.run_loop(self.configuration(), stop_event=stop, process_fn=interrupt),
            0,
        )
        self.assertTrue(stop.is_set())

    def test_unhandled_loop_programming_error_propagates(self) -> None:
        def broken(_target: str | None) -> worker.ProcessOutcome:
            raise RuntimeError("unexpected loop defect")

        with self.assertRaisesRegex(RuntimeError, "unexpected loop defect"):
            worker.run_loop(self.configuration(), process_fn=broken)

    def test_sigterm_sets_shutdown_event_and_restores_handler(self) -> None:
        stop = threading.Event()
        original = signal.getsignal(signal.SIGTERM)
        with worker.sigterm_shutdown(stop):
            handler = signal.getsignal(signal.SIGTERM)
            self.assertTrue(callable(handler))
            handler(signal.SIGTERM, None)
            self.assertTrue(stop.is_set())
        self.assertIs(signal.getsignal(signal.SIGTERM), original)

    def test_missing_required_environment_fails_startup_without_starting_loop(self) -> None:
        with (
            patch.object(worker, "URL", ""),
            patch.object(worker, "KEY", ""),
            patch.object(worker, "run_loop") as run_loop,
        ):
            self.assertEqual(worker.main(["--loop"]), 2)
        run_loop.assert_not_called()

    def test_loop_mode_checks_rpc_readiness_before_starting_runner(self) -> None:
        with (
            patch.object(worker, "URL", "https://example.invalid"),
            patch.object(worker, "KEY", "configured"),
            patch.object(worker, "verify_worker_rpc_readiness") as readiness,
            patch.object(worker, "run_loop", return_value=0) as run_loop,
        ):
            self.assertEqual(worker.main(["--loop"]), 0)
        readiness.assert_called_once_with()
        run_loop.assert_called_once()

    def test_invalid_poll_interval_has_clear_startup_error(self) -> None:
        for invalid in ("0", "-1", "not-a-number", "301", "nan", "inf"):
            with self.subTest(invalid=invalid):
                with (
                    patch.object(worker, "URL", "https://example.invalid"),
                    patch.object(worker, "KEY", "configured"),
                    patch.dict(worker.os.environ, {"GREYVEIL_WORKER_POLL_SECONDS": invalid}),
                ):
                    with self.assertRaisesRegex(worker.WorkerConfigurationError, "between 1 and 300"):
                        worker.load_loop_configuration()

    def test_poll_interval_accepts_inclusive_bounds(self) -> None:
        for valid in ("1", "300"):
            with self.subTest(valid=valid):
                with (
                    patch.object(worker, "URL", "https://example.invalid"),
                    patch.object(worker, "KEY", "configured"),
                    patch.dict(worker.os.environ, {"GREYVEIL_WORKER_POLL_SECONDS": valid}),
                ):
                    self.assertEqual(worker.load_loop_configuration().poll_seconds, float(valid))

    def test_malformed_supabase_url_fails_before_rpc_readiness(self) -> None:
        for invalid in ("not-a-url", "ftp://example.com", "https://", "https://user:pass@example.com"):
            with self.subTest(invalid=invalid):
                with (
                    patch.object(worker, "URL", invalid),
                    patch.object(worker, "KEY", "configured"),
                ):
                    with self.assertRaisesRegex(worker.WorkerConfigurationError, "valid HTTP or HTTPS origin"):
                        worker.load_loop_configuration()

    def test_rpc_readiness_is_non_mutating_and_requires_heartbeat_false(self) -> None:
        with patch.object(worker, "request", side_effect=[[], False]) as request:
            worker.verify_worker_rpc_readiness()
        claim_call, heartbeat_call = request.call_args_list
        self.assertIn("greyveil_worker_claim_generation_job", claim_call.args[0])
        self.assertIn("greyveil_worker_heartbeat_generation_job", heartbeat_call.args[0])
        self.assertEqual(claim_call.args[2]["target_job_id"], heartbeat_call.args[2]["target_job_id"])
        self.assertEqual(claim_call.args[2]["claim_token"], heartbeat_call.args[2]["claim_token"])

    def test_missing_heartbeat_rpc_fails_closed_before_loop_or_real_claim(self) -> None:
        with patch.object(worker, "request", side_effect=[[], OSError("missing RPC")]):
            with self.assertRaisesRegex(worker.WorkerConfigurationError, "worker RPCs are unavailable"):
                worker.verify_worker_rpc_readiness()

    def test_failure_message_redacts_service_key_and_claim_token(self) -> None:
        token = str(uuid.uuid4())
        with patch.object(worker, "KEY", "service-role-secret"):
            message = worker.operator_error_message(
                RuntimeError(
                    f"request failed?worker_token=eq.{token}&authorization=service-role-secret"
                ),
                {"_claim_token": token},
            )
        self.assertNotIn(token, message)
        self.assertNotIn("service-role-secret", message)
        self.assertIn("[redacted]", message)

    def test_poll_interval_defaults_to_ten_seconds(self) -> None:
        with (
            patch.object(worker, "URL", "https://example.invalid"),
            patch.object(worker, "KEY", "configured"),
            patch.dict(worker.os.environ, {}, clear=True),
        ):
            self.assertEqual(worker.load_loop_configuration().poll_seconds, 10)

    def test_once_default_and_job_modes_keep_single_attempt_contract(self) -> None:
        job_id = str(uuid.uuid4())
        with patch.object(worker, "process_one", return_value=worker.ProcessOutcome.NO_JOB) as process:
            self.assertEqual(worker.main([]), 0)
            self.assertEqual(worker.main(["--once"]), 0)
            self.assertEqual(worker.main(["--job", job_id]), 0)
        self.assertEqual(process.call_args_list, [call(None), call(None), call(job_id)])


class RailwayManifestTest(unittest.TestCase):
    def test_every_direct_external_runtime_import_has_a_pinned_requirement(self) -> None:
        production_files = [
            BOOK_GENERATOR / "run_generation_worker.py",
            BOOK_GENERATOR / "generate_book.py",
            *sorted((BOOK_GENERATOR / "greyveil").rglob("*.py")),
        ]
        local_modules = {"generate_book", "run_generation_worker", "greyveil"}
        external_imports = set()
        for source in production_files:
            tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    roots = (alias.name.split(".", 1)[0] for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                    roots = (node.module.split(".", 1)[0],)
                else:
                    continue
                external_imports.update(
                    root for root in roots if root not in sys.stdlib_module_names and root not in local_modules
                )

        import_to_package = {
            "PIL": "Pillow",
            "docx": "python-docx",
            "pypdf": "pypdf",
            "reportlab": "reportlab",
        }
        self.assertEqual(external_imports, set(import_to_package))
        requirements = {
            line.split("==", 1)[0]: line.split("==", 1)[1]
            for line in (REPO_ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
            if line.strip()
        }
        self.assertEqual(set(requirements), set(import_to_package.values()))
        self.assertTrue(all(version for version in requirements.values()))

    def test_railway_config_uses_continuous_mode_and_no_web_health_port(self) -> None:
        config = json.loads((REPO_ROOT / "railpack.json").read_text(encoding="utf-8"))
        self.assertEqual(config["$schema"], "https://schema.railpack.com")
        self.assertEqual(
            config["deploy"]["startCommand"],
            "python tools/book-generator/run_generation_worker.py --loop",
        )
        self.assertNotIn("healthcheckPath", config["deploy"])
        for private_path in (
            ".env", "generated", "output", "tmp", "projects/**/chapters",
            "assets/documents/source", "supabase", "tests", "tools/book-generator/tests",
        ):
            self.assertIn(private_path, config["exclude"])
        self.assertFalse(any(pattern.startswith("assets/books") for pattern in config["exclude"]))
        self.assertEqual((REPO_ROOT / ".python-version").read_text(encoding="utf-8").strip(), "3.12")


if __name__ == "__main__":
    unittest.main()
