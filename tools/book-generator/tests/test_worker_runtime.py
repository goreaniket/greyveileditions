"""One-shot GitHub worker runtime and dependency boundary checks."""

from __future__ import annotations

import ast
import io
import sys
import unittest
import uuid
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import call, patch


BOOK_GENERATOR = Path(__file__).resolve().parents[1]
REPO_ROOT = BOOK_GENERATOR.parents[1]
sys.path.insert(0, str(BOOK_GENERATOR))

import run_generation_worker as worker  # noqa: E402


class WorkerRuntimeTest(unittest.TestCase):
    def test_once_default_and_exact_job_modes_keep_single_attempt_contract(self) -> None:
        job_id = str(uuid.uuid4())
        with patch.object(worker, "process_one", return_value=worker.ProcessOutcome.NO_JOB) as process:
            self.assertEqual(worker.main([]), 0)
            self.assertEqual(worker.main(["--once"]), 0)
            self.assertEqual(worker.main(["--job", job_id]), 0)
        self.assertEqual(process.call_args_list, [call(None), call(None), call(job_id)])

    def test_removed_loop_mode_is_rejected_without_claiming(self) -> None:
        with (
            patch.object(worker, "process_one") as process,
            redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit) as raised,
        ):
            worker.main(["--loop"])
        self.assertEqual(raised.exception.code, 2)
        process.assert_not_called()

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

    def test_failure_message_redacts_service_key_and_claim_token(self) -> None:
        token = str(uuid.uuid4())
        with patch.object(worker, "KEY", "service-role-secret"):
            message = worker.operator_error_message(
                RuntimeError(f"request failed?worker_token=eq.{token}&authorization=service-role-secret"),
                {"_claim_token": token},
            )
        self.assertNotIn(token, message)
        self.assertNotIn("service-role-secret", message)
        self.assertIn("[redacted]", message)

    def test_every_external_runtime_import_has_a_pinned_requirement(self) -> None:
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
        self.assertFalse((REPO_ROOT / "railpack.json").exists())
        self.assertEqual((REPO_ROOT / ".python-version").read_text(encoding="utf-8").strip(), "3.12")


if __name__ == "__main__":
    unittest.main()
