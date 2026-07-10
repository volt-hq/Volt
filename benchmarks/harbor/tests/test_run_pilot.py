from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from benchmarks.harbor.scripts.run_pilot import _check_gateway
from benchmarks.harbor.scripts.validate_protocol import EXPECTED_UPSTREAM_MODEL


class PilotLauncherTests(unittest.TestCase):
    def test_gateway_routes_and_worker_policy_are_attested(self) -> None:
        expiry = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()

        def response(url: str, _key: str) -> object:
            if url.endswith("/health/liveliness"):
                return {"status": "healthy"}
            if url.endswith("/v1/models"):
                return {
                    "data": [
                        {"id": "pilot-model"},
                        {"id": "openai/pilot-model"},
                    ]
                }
            if url.endswith("/v1/model/info"):
                return {
                    "data": [
                        {
                            "model_name": alias,
                            "litellm_params": {
                                "model": EXPECTED_UPSTREAM_MODEL,
                                "num_retries": 0,
                            },
                        }
                        for alias in ("pilot-model", "openai/pilot-model")
                    ]
                }
            if url.endswith("/key/info"):
                return {
                    "info": {
                        "models": ["pilot-model", "openai/pilot-model"],
                        "max_parallel_requests": 16,
                        "max_budget": 500.0,
                        "expires": expiry,
                        "blocked": False,
                    }
                }
            raise AssertionError(url)

        with (
            patch(
                "benchmarks.harbor.scripts.run_pilot._read_json",
                side_effect=response,
            ),
            patch(
                "benchmarks.harbor.scripts.run_pilot._container_read_json",
                side_effect=response,
            ),
        ):
            observed = _check_gateway(
                "http://gateway.invalid:4000",
                "http://gateway.invalid:4000",
                "scoped-worker-key",
                500.0,
            )

        policy = observed["worker_key_policy"]
        self.assertEqual(policy["max_budget_usd"], 500.0)
        self.assertEqual(policy["max_parallel_requests"], 16)


if __name__ == "__main__":
    unittest.main()
