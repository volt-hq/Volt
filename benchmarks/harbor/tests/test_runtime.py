from __future__ import annotations

import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from benchmarks.harbor.scripts.runtime import (
    check_npm_tarball,
    minimal_child_environment,
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

    def test_minimal_environment_and_job_name_validation(self) -> None:
        child = minimal_child_environment(
            {
                "PATH": "path",
                "AWS_SECRET_ACCESS_KEY": "secret",
                "GITHUB_PAT": "also-secret",
                "CI_JOB_JWT": "also-secret",
            },
            additions={"PILOT_GATEWAY_KEY": "allowed"},
        )
        self.assertEqual(
            child,
            {"PATH": "path", "PILOT_GATEWAY_KEY": "allowed"},
        )
        self.assertEqual(validate_job_name("pilot-2026.07_10"), "pilot-2026.07_10")
        with self.assertRaises(ValueError):
            validate_job_name("../outside")


if __name__ == "__main__":
    unittest.main()
