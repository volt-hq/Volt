from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from harbor.models.agent.context import AgentContext

from benchmarks.harbor.agents.run_only_secrets import (
    RunOnlySecretClaudeCode,
    RunOnlySecretOpenCode,
)


class FakeEnvironment:
    default_user = "agent"

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def exec(self, **kwargs: object) -> SimpleNamespace:
        self.calls.append(kwargs)
        return SimpleNamespace(return_code=0, stdout="", stderr="")


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

            self.assertTrue(
                any(
                    "benchmark-secret" in environment_values(call)
                    for call in environment.calls
                )
            )
            self.assertTrue(
                any(
                    "claude-sonnet-4-5" in environment_values(call)
                    for call in environment.calls
                )
            )
            self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", agent._extra_env)

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
