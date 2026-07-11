from __future__ import annotations

import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import yaml

from benchmarks.harbor.cli import (
    _bundle_dir,
    _default_release_dir,
    _external_pilot,
    _managed_pilot,
    _prepare,
    main,
)


class OperatorCliTests(unittest.TestCase):
    def test_jobs_list_and_show_emit_machine_readable_results(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            jobs_dir = Path(temporary)
            job_dir = jobs_dir / "pilot-one"
            job_dir.mkdir()
            (job_dir / "result.json").write_text(
                json.dumps(
                    {
                        "started_at": "2026-07-10T00:00:00Z",
                        "n_total_trials": 100,
                        "stats": {"n_errored_trials": 0},
                    }
                ),
                encoding="utf-8",
            )
            (job_dir / "run-manifest.json").write_text(
                json.dumps({"status": "finished", "upstream_model": "model"}),
                encoding="utf-8",
            )
            (job_dir / "post-run-summary.json").write_text(
                json.dumps({"trial_count": 100, "score_valid": True, "warnings": []}),
                encoding="utf-8",
            )

            interrupted = jobs_dir / "interrupted"
            interrupted.mkdir()
            (interrupted / "run-manifest.json").write_text(
                json.dumps({"status": "launching"}),
                encoding="utf-8",
            )

            output = io.StringIO()
            with redirect_stdout(output):
                exit_code = main(
                    ["--json", "jobs", "list", "--jobs-dir", str(jobs_dir)]
                )
            self.assertEqual(exit_code, 0)
            listed = json.loads(output.getvalue())
            jobs_by_name = {job["name"]: job for job in listed["jobs"]}
            self.assertEqual(jobs_by_name["pilot-one"]["trials"], 100)
            self.assertEqual(jobs_by_name["interrupted"]["status"], "incomplete")

            output = io.StringIO()
            with redirect_stdout(output):
                exit_code = main(
                    [
                        "--json",
                        "jobs",
                        "show",
                        "pilot-one",
                        "--jobs-dir",
                        str(jobs_dir),
                    ]
                )
            self.assertEqual(exit_code, 0)
            shown = json.loads(output.getvalue())
            self.assertEqual(shown["run_manifest"]["status"], "finished")
            self.assertTrue(shown["summary"]["score_valid"])

    def test_external_pilot_forwards_only_required_environment(self) -> None:
        completed = subprocess.CompletedProcess([], 0)
        with (
            patch.dict(
                os.environ,
                {
                    "PATH": "path",
                    "PILOT_GATEWAY_KEY": "worker",
                    "PILOT_GATEWAY_MASTER_KEY": "master",
                    "PILOT_GATEWAY_URL": "http://volt-bench-gateway-proxy:4000",
                    "PILOT_GATEWAY_HEALTH_URL": "http://gateway.invalid",
                    "PILOT_GATEWAY_NETWORK": "gateway-network",
                    "UNRELATED_SECRET": "must-not-leak",
                },
                clear=True,
            ),
            patch(
                "benchmarks.harbor.cli.run_owned_process", return_value=completed
            ) as run,
        ):
            exit_code = _external_pilot(
                Path("."),
                jobs_dir=Path("jobs"),
                job_name="pilot-one",
                package_dir=None,
                gateway_network=None,
                max_budget_usd=25.0,
            )

        self.assertEqual(exit_code, 0)
        child_environment = run.call_args.kwargs["environment"]
        self.assertNotIn("UNRELATED_SECRET", child_environment)
        self.assertEqual(child_environment["PILOT_MAX_BUDGET_USD"], "25.0")
        self.assertEqual(child_environment["PILOT_GATEWAY_NETWORK"], "gateway-network")
        self.assertEqual(
            child_environment["PILOT_GATEWAY_HEALTH_URL"],
            "http://gateway.invalid",
        )

    def test_prepare_refuses_to_replace_an_unowned_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root = parent / "repository"
            root.mkdir()
            output = parent / "existing-output"
            output.mkdir()
            with self.assertRaisesRegex(RuntimeError, "not owned"):
                _prepare(root, output, skip_check=True)

        repository = Path(__file__).resolve().parents[3]
        self.assertFalse(_default_release_dir(repository).is_relative_to(repository))

    def test_failed_prepare_does_not_create_an_ownership_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root = parent / "repository"
            root.mkdir()
            output = parent / "new-output"
            failed = subprocess.CompletedProcess([], 1, stdout="", stderr="failed")
            with patch("benchmarks.harbor.cli._run", return_value=failed):
                with self.assertRaisesRegex(RuntimeError, "Local release failed"):
                    _prepare(root, output, skip_check=True, capture=True)
            self.assertFalse((output / ".volt-bench-owner.json").exists())

    def test_interrupted_refresh_recovers_the_previous_owned_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root = parent / "repository"
            root.mkdir()
            output = parent / "owned-output"
            backup = parent / ".owned-output.backup-interrupted"
            backup.mkdir()
            (backup / ".volt-bench-owner.json").write_text(
                json.dumps({"schema_version": 1, "path": str(output.resolve())}),
                encoding="utf-8",
            )
            sentinel = backup / "previous-bundle"
            sentinel.write_text("keep", encoding="utf-8")
            failed = subprocess.CompletedProcess([], 1, stdout="", stderr="failed")
            with patch("benchmarks.harbor.cli._run", return_value=failed):
                with self.assertRaisesRegex(RuntimeError, "Local release failed"):
                    _prepare(root, output, skip_check=True, capture=True)
            self.assertFalse(backup.exists())
            self.assertEqual(
                (output / "previous-bundle").read_text(encoding="utf-8"), "keep"
            )

    def test_failed_refresh_preserves_the_previous_owned_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root = parent / "repository"
            root.mkdir()
            output = parent / "owned-output"
            output.mkdir()
            (output / ".volt-bench-owner.json").write_text(
                json.dumps({"schema_version": 1, "path": str(output.resolve())}),
                encoding="utf-8",
            )
            sentinel = output / "previous-bundle"
            sentinel.write_text("keep", encoding="utf-8")
            failed = subprocess.CompletedProcess([], 1, stdout="", stderr="failed")
            with patch("benchmarks.harbor.cli._run", return_value=failed):
                with self.assertRaisesRegex(RuntimeError, "Local release failed"):
                    _prepare(root, output, skip_check=True, capture=True)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    def test_explicit_bundle_path_is_used_exactly(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            explicit = Path(temporary) / "bundle"
            (explicit / "tarballs").mkdir(parents=True)
            self.assertEqual(_bundle_dir(Path("."), explicit), explicit.resolve())

    def test_managed_cleanup_failure_is_not_suppressed(self) -> None:
        completed = subprocess.CompletedProcess([], 0)
        with (
            patch.dict(
                os.environ,
                {"UPSTREAM_ANTHROPIC_API_KEY": "upstream"},
                clear=True,
            ),
            patch("benchmarks.harbor.cli._run", return_value=completed),
            patch("benchmarks.harbor.cli.run_owned_process", return_value=completed),
            patch("benchmarks.harbor.cli._wait_for_gateway"),
            patch(
                "benchmarks.harbor.cli._post_json",
                return_value={"key": "worker"},
            ),
            patch("benchmarks.harbor.cli._worker_key_is_rejected", return_value=False),
            patch("benchmarks.harbor.cli._delete_worker_key"),
            patch(
                "benchmarks.harbor.cli._cleanup_managed_gateway",
                return_value=["teardown failed"],
            ) as cleanup,
        ):
            with self.assertRaisesRegex(RuntimeError, "cleanup incomplete"):
                _managed_pilot(
                    Path("."),
                    jobs_dir=Path("jobs"),
                    job_name="pilot-one",
                    package_dir=None,
                    port=4000,
                    gateway_bind="127.0.0.1",
                    container_url="http://host.docker.internal:4000",
                    max_budget_usd=25.0,
                )
        teardown_environment = cleanup.call_args.kwargs["compose_environment"]
        self.assertNotIn("upstream", teardown_environment.values())
        self.assertNotIn("worker", teardown_environment.values())

    def test_managed_cleanup_does_not_mask_primary_failure(self) -> None:
        startup_failed = subprocess.CompletedProcess([], 1)
        diagnostics = io.StringIO()
        with (
            patch.dict(
                os.environ,
                {"UPSTREAM_ANTHROPIC_API_KEY": "upstream"},
                clear=True,
            ),
            patch("benchmarks.harbor.cli._run", return_value=startup_failed),
            patch(
                "benchmarks.harbor.cli._cleanup_managed_gateway",
                return_value=["teardown failed"],
            ),
            redirect_stderr(diagnostics),
        ):
            with self.assertRaisesRegex(RuntimeError, "startup failed"):
                _managed_pilot(
                    Path("."),
                    jobs_dir=Path("jobs"),
                    job_name="pilot-one",
                    package_dir=None,
                    port=4000,
                    gateway_bind="127.0.0.1",
                    container_url="http://host.docker.internal:4000",
                    max_budget_usd=25.0,
                )
        self.assertIn("teardown failed", diagnostics.getvalue())

    def test_managed_gateway_uses_digest_pinned_ephemeral_services(self) -> None:
        root = Path(__file__).resolve().parents[3]
        config = yaml.safe_load(
            (root / "benchmarks/harbor/gateway/docker-compose.yaml").read_text(
                encoding="utf-8"
            )
        )
        services = config["services"]
        self.assertIn("@sha256:", services["database"]["image"])
        self.assertIn("@sha256:", services["gateway"]["image"])
        self.assertIn(
            "database-data:/var/lib/postgresql/data", services["database"]["volumes"]
        )
        self.assertEqual(config["volumes"], {"database-data": None})
        overlay = yaml.safe_load(
            (root / "benchmarks/harbor/gateway/harbor-gateway-network.yaml").read_text(
                encoding="utf-8"
            )
        )
        proxy = overlay["services"]["volt-bench-gateway-proxy"]
        self.assertIn("@sha256:", proxy["image"])
        self.assertNotIn("extra_hosts", overlay["services"]["main"])
        self.assertNotIn("networks", overlay["services"]["main"])


if __name__ == "__main__":
    unittest.main()
