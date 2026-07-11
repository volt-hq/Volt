from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from benchmarks.harbor.scripts.runtime import (
    check_npm_tarball,
    cleanup_harbor_trial_resources,
    defer_termination_signals,
    minimal_child_environment,
    normalize_return_code,
    run_owned_process,
    validate_job_name,
)


class RuntimeTests(unittest.TestCase):
    def test_tarball_identity_and_digest_are_verified(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "volt.tgz"
            payload = json.dumps(
                {
                    "name": "@earendil-works/volt-coding-agent",
                    "version": "0.79.6",
                }
            ).encode()
            info = tarfile.TarInfo("package/package.json")
            info.size = len(payload)
            with tarfile.open(path, "w:gz") as archive:
                archive.addfile(info, io.BytesIO(payload))

            resolved, digest = check_npm_tarball(
                path,
                name="@earendil-works/volt-coding-agent",
                version="0.79.6",
            )

            self.assertEqual(resolved, str(path.resolve()))
            self.assertEqual(digest, hashlib.sha256(path.read_bytes()).hexdigest())

    def test_trial_cleanup_uses_exact_compose_project_labels(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            job_dir = Path(temporary)
            (job_dir / "fix-git__Ab.C").mkdir()
            empty = SimpleNamespace(returncode=0, stdout="", stderr="")
            with patch(
                "benchmarks.harbor.scripts.runtime.subprocess.run",
                return_value=empty,
            ) as run:
                errors = cleanup_harbor_trial_resources(job_dir)
        self.assertEqual(errors, [])
        filters = [
            call.args[0][-1]
            for call in run.call_args_list
            if "--filter" in call.args[0]
        ]
        self.assertEqual(
            filters,
            ["label=com.docker.compose.project=fix-git__ab-c"] * 6,
        )

    def test_pending_termination_prevents_child_launch(self) -> None:
        with defer_termination_signals() as pending_signals:
            pending_signals.append(15)
            with patch("benchmarks.harbor.scripts.runtime.subprocess.Popen") as popen:
                result = run_owned_process(
                    [sys.executable, "-c", "pass"],
                    cwd=Path.cwd(),
                    environment=dict(os.environ),
                    pending_signals=pending_signals,
                )
        self.assertEqual(result.returncode, 143)
        popen.assert_not_called()

    def test_owned_process_and_signal_status_normalization(self) -> None:
        result = run_owned_process(
            [sys.executable, "-c", "raise SystemExit(3)"],
            cwd=Path.cwd(),
            environment=dict(os.environ),
        )
        self.assertEqual(result.returncode, 3)
        self.assertEqual(normalize_return_code(-15), 143)

    def test_minimal_environment_and_job_name_validation(self) -> None:
        child = minimal_child_environment(
            {
                "PATH": "path",
                "ProgramFiles": "program-files",
                "ProgramW6432": "program-w6432",
                "AWS_SECRET_ACCESS_KEY": "secret",
                "GITHUB_PAT": "also-secret",
                "CI_JOB_JWT": "also-secret",
            },
            additions={"PILOT_GATEWAY_KEY": "allowed"},
        )
        self.assertEqual(
            child,
            {
                "PATH": "path",
                "ProgramFiles": "program-files",
                "ProgramW6432": "program-w6432",
                "PILOT_GATEWAY_KEY": "allowed",
            },
        )
        self.assertEqual(validate_job_name("pilot-2026.07_10"), "pilot-2026.07_10")
        with self.assertRaises(ValueError):
            validate_job_name("../outside")


if __name__ == "__main__":
    unittest.main()
