from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import cast
from unittest.mock import patch

from benchmarks.harbor.scripts.run_pilot import (
    PACKAGE_PINS,
    _check_gateway,
    _check_packages,
    _container_read_json,
    main,
)
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
                side_effect=lambda url, key, _network: response(url, key),
            ),
        ):
            observed = _check_gateway(
                "http://gateway.invalid:4000",
                "http://gateway.invalid:4000",
                "scoped-worker-key",
                "gateway-network",
                500.0,
            )

        policy = observed["worker_key_policy"]
        self.assertEqual(policy["max_budget_usd"], 500.0)
        self.assertEqual(policy["max_parallel_requests"], 16)

    def test_package_checks_do_not_receive_host_secrets(self) -> None:
        def npm_view(command: list[str], **kwargs: object) -> SimpleNamespace:
            package_spec = command[2]
            version = package_spec.rsplit("@", 1)[-1]
            environment = cast(dict[str, str], kwargs["env"])
            self.assertNotIn("UNRELATED_SECRET", environment)
            return SimpleNamespace(returncode=0, stdout=f"{version}\n", stderr="")

        with (
            patch.dict(
                os.environ,
                {"PATH": "path", "UNRELATED_SECRET": "must-not-leak"},
                clear=True,
            ),
            patch(
                "benchmarks.harbor.scripts.run_pilot.subprocess.run",
                side_effect=npm_view,
            ) as run,
        ):
            _check_packages(skip_volt=False)

        self.assertEqual(run.call_count, len(PACKAGE_PINS))

    def test_container_probe_keeps_worker_key_out_of_process_arguments(self) -> None:
        completed = SimpleNamespace(returncode=0, stdout='{"data": []}', stderr="")
        with (
            patch.dict(
                os.environ,
                {"PATH": "path", "UNRELATED_SECRET": "must-not-leak"},
                clear=True,
            ),
            patch(
                "benchmarks.harbor.scripts.run_pilot.subprocess.run",
                return_value=completed,
            ) as run,
        ):
            _container_read_json(
                "http://volt-bench-gateway:4000/v1/models",
                "scoped-worker-key",
                "gateway-network",
            )

        command = run.call_args.args[0]
        self.assertNotIn("scoped-worker-key", command)
        self.assertIn("gateway-network", command)
        self.assertNotIn("host.docker.internal:host-gateway", command)
        self.assertIn("scoped-worker-key", run.call_args.kwargs["input"])
        self.assertNotIn("UNRELATED_SECRET", run.call_args.kwargs["env"])

    def test_preflight_failure_still_revokes_worker_key(self) -> None:
        with (
            patch.dict(
                os.environ,
                {
                    "PILOT_GATEWAY_KEY": "worker",
                    "PILOT_GATEWAY_MASTER_KEY": "master",
                    "PILOT_GATEWAY_HEALTH_URL": "http://gateway.invalid",
                },
                clear=True,
            ),
            patch(
                "benchmarks.harbor.scripts.run_pilot._main",
                side_effect=RuntimeError("preflight"),
            ),
            patch("benchmarks.harbor.scripts.run_pilot._delete_worker_key") as delete,
            patch("sys.argv", ["run_pilot.py"]),
        ):
            with self.assertRaisesRegex(RuntimeError, "preflight"):
                main()

        delete.assert_called_once_with(
            "http://gateway.invalid/key/delete",
            "master",
            "worker",
        )


if __name__ == "__main__":
    unittest.main()
