from __future__ import annotations

import asyncio
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import cast

from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory

from benchmarks.harbor.agents.volt import VoltAgent, parse_volt_events
from benchmarks.harbor.scripts.runtime import VOLT_PACKAGE_VERSIONS


EVENTS = [
    {
        "type": "session",
        "version": 3,
        "id": "session-1",
        "timestamp": "2026-01-01T00:00:00Z",
        "cwd": "/app",
    },
    {"type": "agent_start"},
    {"type": "compaction_start", "reason": "threshold"},
    {"type": "auto_retry_start", "attempt": 1, "maxAttempts": 2, "delayMs": 10},
    {
        "type": "message_end",
        "message": {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "inspect"},
                {"type": "text", "text": "Running a command"},
                {
                    "type": "toolCall",
                    "id": "call-1",
                    "name": "bash",
                    "arguments": {"command": "pwd"},
                },
            ],
            "api": "openai-responses",
            "provider": "pilot",
            "model": "pilot-model",
            "responseModel": "claude-sonnet-4-5-20250929",
            "usage": {
                "input": 10,
                "output": 4,
                "cacheRead": 2,
                "cacheWrite": 3,
                "cost": {"total": 0.125},
            },
            "stopReason": "toolUse",
            "timestamp": 1767225601000,
        },
    },
    {
        "type": "tool_execution_end",
        "toolCallId": "call-1",
        "toolName": "bash",
        "result": {"content": [{"type": "text", "text": "/app"}]},
        "isError": False,
    },
    {"type": "agent_settled"},
]
COMPLETE_USAGE_EVENTS = [
    event for event in EVENTS if event.get("type") != "compaction_start"
]


class FakeEnvironment:
    default_user = "agent"

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.uploads: list[tuple[Path, str]] = []
        self.uploaded_text: list[str] = []

    async def exec(
        self, command: str | None = None, **kwargs: object
    ) -> SimpleNamespace:
        if command is not None:
            kwargs["command"] = command
        self.calls.append(kwargs)
        return SimpleNamespace(return_code=0, stdout="", stderr="")

    async def upload_file(self, source_path: Path, target_path: str) -> None:
        self.uploads.append((source_path, target_path))
        try:
            self.uploaded_text.append(source_path.read_text(encoding="utf-8"))
        except UnicodeDecodeError:
            pass


class VoltAgentTests(unittest.TestCase):
    def test_json_events_convert_to_valid_atif(self) -> None:
        trajectory, summary = parse_volt_events(
            EVENTS,
            instruction="Fix the task",
            agent_version="0.79.6",
            model_name="openai/pilot-model",
            reasoning_effort="high",
        )

        validated = Trajectory.model_validate(trajectory.model_dump())
        self.assertEqual(validated.session_id, "session-1")
        self.assertEqual(len(validated.steps), 2)
        self.assertEqual(validated.steps[1].tool_calls[0].function_name, "bash")
        self.assertEqual(validated.steps[1].observation.results[0].content, "/app")
        self.assertIsNone(validated.final_metrics.total_prompt_tokens)
        self.assertIsNone(validated.final_metrics.total_completion_tokens)
        self.assertEqual(summary["cache_write_tokens"], 3)
        self.assertEqual(summary["compactions"], 1)
        self.assertEqual(summary["auto_retries"], 1)
        self.assertFalse(summary["usage_complete"])
        self.assertTrue(summary["settled"])

    def test_run_uses_fresh_state_and_populates_context(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            logs_dir = Path(temporary)
            output = logs_dir / "volt.jsonl"
            output.write_text(
                "\n".join(json.dumps(event) for event in COMPLETE_USAGE_EVENTS) + "\n",
                encoding="utf-8",
            )
            agent = VoltAgent(
                logs_dir=logs_dir,
                model_name="openai/pilot-model",
                version="0.79.6",
                extra_env={
                    "OPENAI_API_KEY": "test-key",
                    "OPENAI_BASE_URL": "http://gateway.invalid/v1",
                },
            )
            environment = FakeEnvironment()
            context = AgentContext()

            asyncio.run(agent.run("Fix the task", environment, context))
            agent.populate_context_post_run(context)

            self.assertTrue(environment.calls)
            run_call = next(
                call
                for call in environment.calls
                if "volt --mode json" in cast(str, call["command"])
            )
            run_env = cast(dict[str, str], run_call["env"])
            self.assertEqual(run_env["VOLT_CODING_AGENT_DIR"], "/tmp/volt-coding-agent")
            for call in environment.calls:
                self.assertNotIn(
                    "test-key", cast(dict[str, str], call.get("env") or {}).values()
                )
                self.assertNotIn("test-key", str(call.get("command", "")))
            self.assertTrue(
                any("test-key" in contents for contents in environment.uploaded_text)
            )
            self.assertEqual(context.n_input_tokens, 15)
            self.assertEqual(context.n_cache_tokens, 2)
            self.assertEqual(context.n_output_tokens, 4)
            self.assertEqual(context.cost_usd, 0.125)
            metadata = cast(dict[str, object], context.metadata)
            self.assertTrue(metadata["settled"])
            run_command = cast(str, run_call["command"])
            self.assertIn("--name harbor-eval", run_command)
            self.assertIn("stopReason", run_command)
            self.assertTrue((logs_dir / "trajectory.json").is_file())

    def test_install_accepts_verified_local_package_bundle_without_secret(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            package_dir = Path(temporary) / "tarballs"
            package_dir.mkdir()
            for index, (name, version) in enumerate(VOLT_PACKAGE_VERSIONS.items()):
                payload = json.dumps({"name": name, "version": version}).encode()
                info = tarfile.TarInfo("package/package.json")
                info.size = len(payload)
                with tarfile.open(package_dir / f"{index}.tgz", "w:gz") as archive:
                    archive.addfile(info, io.BytesIO(payload))
            agent = VoltAgent(
                logs_dir=Path(temporary),
                model_name="openai/pilot-model",
                version="0.79.6",
                extra_env={
                    "OPENAI_API_KEY": "test-key",
                    "VOLT_HARBOR_PACKAGE_DIR": str(package_dir),
                },
            )
            environment = FakeEnvironment()

            asyncio.run(agent.install(environment))

            self.assertEqual(len(environment.uploads), 4)
            install_command = cast(str, environment.calls[-1]["command"])
            self.assertIn('npm install --prefix "$HOME/.volt-install"', install_command)
            for call in environment.calls:
                call_env = cast(dict[str, str], call.get("env") or {})
                self.assertNotIn("test-key", call_env.values())

    def test_local_auth_file_is_uploaded_outside_captured_logs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            logs_dir = Path(temporary)
            auth_path = logs_dir / "source-auth.json"
            auth_path.write_text(
                json.dumps(
                    {
                        "openai-codex": {
                            "type": "oauth",
                            "access": "secret",
                            "refresh": "secret",
                            "expires": 4102444800000,
                        }
                    }
                ),
                encoding="utf-8",
            )
            (logs_dir / "volt.jsonl").write_text(
                "\n".join(json.dumps(event) for event in EVENTS) + "\n",
                encoding="utf-8",
            )
            agent = VoltAgent(
                logs_dir=logs_dir,
                model_name="openai-codex/gpt-5.4",
                version="0.79.6",
                provider="openai-codex",
                custom_provider=False,
                auth_path_env="VOLT_AUTH_JSON_PATH",
                extra_env={"VOLT_AUTH_JSON_PATH": str(auth_path)},
            )
            environment = FakeEnvironment()

            asyncio.run(agent.run("Fix the task", environment, AgentContext()))

            self.assertEqual(
                environment.uploads,
                [(auth_path.resolve(), "/tmp/volt-coding-agent/auth.json")],
            )
            run_command = next(
                cast(str, call["command"])
                for call in environment.calls
                if "volt --mode json" in cast(str, call["command"])
            )
            cleanup_command = cast(str, environment.calls[-1]["command"])
            self.assertIn("rm -rf /tmp/volt-coding-agent", cleanup_command)
            self.assertNotIn("secret", run_command)


if __name__ == "__main__":
    unittest.main()
