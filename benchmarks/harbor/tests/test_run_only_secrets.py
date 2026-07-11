from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import cast

from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from benchmarks.harbor.agents.run_only_secrets import (
    RunOnlySecretClaudeCode,
    RunOnlySecretOpenCode,
)
from benchmarks.harbor.agents.secret_environment import run_only_secret_environment


class FakeEnvironment:
    default_user = "agent"

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.uploads: list[tuple[str, str]] = []
        self.fail_cleanup = False
        self.raise_cleanup = False

    async def exec(
        self, command: str | None = None, **kwargs: object
    ) -> SimpleNamespace:
        if command is not None:
            kwargs["command"] = command
        self.calls.append(kwargs)
        if self.raise_cleanup and str(kwargs.get("command", "")).startswith("rm -rf"):
            raise OSError("cleanup transport failed")
        return_code = (
            1
            if self.fail_cleanup and str(kwargs.get("command", "")).startswith("rm -rf")
            else 0
        )
        return SimpleNamespace(return_code=return_code, stdout="", stderr="failed")

    async def upload_file(self, source_path: Path, target_path: str) -> None:
        self.uploads.append((target_path, source_path.read_text(encoding="utf-8")))


def environment_values(call: dict[str, object]) -> list[object]:
    environment = call.get("env")
    return list(environment.values()) if isinstance(environment, dict) else []


class RunOnlySecretTests(unittest.TestCase):
    def test_secret_is_withheld_during_install_and_removed_after_run(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            agent = RunOnlySecretClaudeCode(
                logs_dir=Path(temporary),
                model_name="anthropic/claude-sonnet-4-5",
                version="2.1.206",
                extra_env={
                    "ANTHROPIC_BASE_URL": "http://gateway.invalid",
                    "CLAUDE_CODE_OAUTH_TOKEN": "benchmark-secret",
                },
            )
            environment = FakeEnvironment()

            asyncio.run(agent.install(environment))

            self.assertTrue(environment.calls)
            for call in environment.calls:
                self.assertNotIn("benchmark-secret", environment_values(call))

            environment.calls.clear()
            asyncio.run(agent.run("Fix the task", environment, AgentContext()))

            for call in environment.calls:
                self.assertNotIn("benchmark-secret", environment_values(call))
                self.assertNotIn("benchmark-secret", str(call.get("command", "")))
            self.assertTrue(
                any(
                    "benchmark-secret" in contents
                    for _, contents in environment.uploads
                )
            )
            self.assertTrue(
                any(
                    "claude-sonnet-4-5" in environment_values(call)
                    for call in environment.calls
                )
            )
            self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", agent._extra_env)

    def test_cleanup_failure_is_reported(self) -> None:
        environment = FakeEnvironment()
        environment.fail_cleanup = True

        async def exercise() -> None:
            async with run_only_secret_environment(
                cast(BaseEnvironment, environment),
                {"OPENAI_API_KEY": "secret"},
            ):
                pass

        with self.assertRaisesRegex(RuntimeError, "Run-secret cleanup failed"):
            asyncio.run(exercise())

    def test_cleanup_exception_does_not_mask_primary_error(self) -> None:
        environment = FakeEnvironment()
        environment.raise_cleanup = True

        async def exercise() -> None:
            async with run_only_secret_environment(
                cast(BaseEnvironment, environment),
                {"OPENAI_API_KEY": "secret"},
            ):
                raise ValueError("primary failure")

        with self.assertRaisesRegex(ValueError, "primary failure") as raised:
            asyncio.run(exercise())
        self.assertTrue(
            any(
                "cleanup transport failed" in note
                for note in raised.exception.__notes__
            )
        )

    def test_opencode_config_uses_extra_env_gateway_url(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            agent = RunOnlySecretOpenCode(
                logs_dir=Path(temporary),
                model_name="openai/pilot-model",
                version="1.17.18",
                extra_env={
                    "OPENAI_API_KEY": "benchmark-secret",
                    "OPENAI_BASE_URL": "http://gateway.invalid/v1",
                },
            )
            environment = FakeEnvironment()

            asyncio.run(agent.run("Fix the task", environment, AgentContext()))

            config_command = next(
                str(call["command"])
                for call in environment.calls
                if "opencode.json" in str(call["command"])
            )
            self.assertIn("http://gateway.invalid/v1", config_command)


if __name__ == "__main__":
    unittest.main()
