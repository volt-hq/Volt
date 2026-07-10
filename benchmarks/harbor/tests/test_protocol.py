from __future__ import annotations

import unittest
from pathlib import Path

from benchmarks.harbor.scripts.run_local_auth import validate_local_auth_config
from benchmarks.harbor.scripts.validate_protocol import validate_protocol


class ProtocolTests(unittest.TestCase):
    def test_checked_protocol_is_valid(self) -> None:
        root = Path(__file__).resolve().parents[3]
        errors = validate_protocol(
            root / "benchmarks/harbor/configs/pilot.yaml",
            root / "benchmarks/harbor/manifests/terminal-bench-2.1-pilot-v1.json",
            root / "benchmarks/harbor/gateway/litellm.yaml",
        )
        self.assertEqual(errors, [])

    def test_local_auth_protocols_are_valid(self) -> None:
        root = Path(__file__).resolve().parents[3]
        for provider in ("openai", "anthropic"):
            with self.subTest(provider=provider):
                errors = validate_local_auth_config(
                    root
                    / "benchmarks/harbor/configs"
                    / f"smoke-local-auth-{provider}.yaml",
                    provider,
                )
                self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
