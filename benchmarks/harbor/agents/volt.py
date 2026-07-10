"""Repository-owned Harbor adapter for the Volt coding agent."""

from __future__ import annotations

import json
import re
import shlex
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from harbor.models.trial.paths import EnvironmentPaths
from harbor.utils.trajectory_utils import format_trajectory_json

from benchmarks.harbor.scripts.runtime import check_volt_package_bundle


def _timestamp(timestamp_ms: object) -> str | None:
    if not isinstance(timestamp_ms, (int, float)):
        return None
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).isoformat()


def _content_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return "" if content is None else json.dumps(content, sort_keys=True)

    texts: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text" and isinstance(part.get("text"), str):
            texts.append(part["text"])
    return "\n".join(texts)


def _observation_text(result: object) -> str:
    if isinstance(result, dict):
        text = _content_text(result.get("content"))
        if text:
            return text
    if isinstance(result, str):
        return result
    return json.dumps(result, sort_keys=True, default=str)


def parse_volt_events(
    events: Iterable[dict[str, Any]],
    *,
    instruction: str,
    agent_version: str,
    model_name: str | None,
    reasoning_effort: str,
) -> tuple[Trajectory, dict[str, Any]]:
    """Convert Volt JSON events into an ATIF trajectory and aggregate metrics."""

    materialized = list(events)
    session = next(
        (event for event in materialized if event.get("type") == "session"), {}
    )
    session_id = session.get("id") if isinstance(session.get("id"), str) else None
    session_timestamp = (
        session.get("timestamp") if isinstance(session.get("timestamp"), str) else None
    )

    steps: list[Step] = [
        Step(
            step_id=1,
            timestamp=session_timestamp,
            source="user",
            message=instruction,
        )
    ]
    call_steps: dict[str, Step] = {}
    total_input = 0
    total_output = 0
    total_cache_read = 0
    total_cache_write = 0
    total_cost = 0.0
    assistant_messages = 0
    usage_messages = 0
    tool_calls_count = 0
    tool_errors = 0
    compactions = 0
    auto_retries = 0
    agent_runs = 0
    settled = False
    stop_reasons: list[str] = []
    response_models: set[str] = set()

    for event in materialized:
        event_type = event.get("type")
        if event_type == "agent_start":
            agent_runs += 1
        elif event_type == "agent_settled":
            settled = True
        elif event_type == "compaction_start":
            compactions += 1
        elif event_type == "auto_retry_start":
            auto_retries += 1
        elif event_type == "tool_execution_end":
            call_id = event.get("toolCallId")
            if not isinstance(call_id, str) or call_id not in call_steps:
                continue
            is_error = bool(event.get("isError"))
            if is_error:
                tool_errors += 1
            result = ObservationResult(
                source_call_id=call_id,
                content=_observation_text(event.get("result")),
                extra={"is_error": is_error},
            )
            step = call_steps[call_id]
            if step.observation is None:
                step.observation = Observation(results=[])
            step.observation.results.append(result)
        elif event_type == "message_end":
            message = event.get("message")
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue

            assistant_messages += 1
            content = message.get("content")
            content_parts = content if isinstance(content, list) else []
            text_parts: list[str] = []
            reasoning_parts: list[str] = []
            calls: list[ToolCall] = []
            for part in content_parts:
                if not isinstance(part, dict):
                    continue
                part_type = part.get("type")
                if part_type == "text" and isinstance(part.get("text"), str):
                    text_parts.append(part["text"])
                elif part_type == "thinking" and isinstance(part.get("thinking"), str):
                    reasoning_parts.append(part["thinking"])
                elif part_type == "toolCall":
                    call_id = part.get("id")
                    name = part.get("name")
                    arguments = part.get("arguments")
                    if not isinstance(call_id, str) or not isinstance(name, str):
                        continue
                    call = ToolCall(
                        tool_call_id=call_id,
                        function_name=name,
                        arguments=arguments if isinstance(arguments, dict) else {},
                    )
                    calls.append(call)
                    tool_calls_count += 1

            usage = message.get("usage")
            metrics = None
            if isinstance(usage, dict):
                input_tokens = int(usage.get("input") or 0)
                output_tokens = int(usage.get("output") or 0)
                cache_read = int(usage.get("cacheRead") or 0)
                cache_write = int(usage.get("cacheWrite") or 0)
                cost = usage.get("cost")
                cost_total = (
                    float(cost.get("total") or 0) if isinstance(cost, dict) else 0.0
                )
                prompt_tokens = input_tokens + cache_read + cache_write
                metrics = Metrics(
                    prompt_tokens=prompt_tokens,
                    completion_tokens=output_tokens,
                    cached_tokens=cache_read,
                    cost_usd=cost_total,
                    extra={"cache_write_tokens": cache_write},
                )
                total_input += prompt_tokens
                total_output += output_tokens
                total_cache_read += cache_read
                total_cache_write += cache_write
                total_cost += cost_total
                usage_messages += 1

            stop_reason = message.get("stopReason")
            if isinstance(stop_reason, str):
                stop_reasons.append(stop_reason)
            response_model = message.get("responseModel") or message.get("model")
            if isinstance(response_model, str):
                response_models.add(response_model)

            step = Step(
                step_id=len(steps) + 1,
                timestamp=_timestamp(message.get("timestamp")),
                source="agent",
                model_name=message.get("model")
                if isinstance(message.get("model"), str)
                else model_name,
                reasoning_effort=reasoning_effort,
                message="\n".join(text_parts),
                reasoning_content="\n\n".join(reasoning_parts) or None,
                tool_calls=calls or None,
                metrics=metrics,
                llm_call_count=1,
                extra={
                    "api": message.get("api"),
                    "provider": message.get("provider"),
                    "response_model": message.get("responseModel"),
                    "stop_reason": stop_reason,
                    "error_message": message.get("errorMessage"),
                },
            )
            steps.append(step)
            for call in calls:
                call_steps[call.tool_call_id] = step

    usage_complete = compactions == 0
    error_stop_reasons = sorted(
        {reason for reason in stop_reasons if reason in {"error", "aborted"}}
    )
    summary: dict[str, Any] = {
        "event_count": len(materialized),
        "assistant_messages": assistant_messages,
        "usage_messages": usage_messages,
        "tool_calls": tool_calls_count,
        "tool_errors": tool_errors,
        "compactions": compactions,
        "auto_retries": auto_retries,
        "agent_runs": agent_runs,
        "settled": settled,
        "input_tokens": total_input,
        "output_tokens": total_output,
        "cache_read_tokens": total_cache_read,
        "cache_write_tokens": total_cache_write,
        "cost_usd": total_cost if usage_messages else None,
        "usage_complete": usage_complete,
        "error_stop_reasons": error_stop_reasons,
        "stop_reasons": stop_reasons,
        "response_models": sorted(response_models),
        "json_protocol_version": session.get("version"),
    }

    trajectory = Trajectory(
        session_id=session_id,
        trajectory_id=session_id,
        agent=Agent(
            name="volt",
            version=agent_version,
            model_name=model_name,
            extra={"reasoning_effort": reasoning_effort},
        ),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=total_input
            if usage_messages and usage_complete
            else None,
            total_completion_tokens=total_output
            if usage_messages and usage_complete
            else None,
            total_cached_tokens=total_cache_read
            if usage_messages and usage_complete
            else None,
            total_cost_usd=total_cost if usage_messages and usage_complete else None,
            total_steps=len(steps),
            extra={
                "cache_write_tokens": total_cache_write,
                "tool_calls": tool_calls_count,
                "tool_errors": tool_errors,
                "compactions": compactions,
                "auto_retries": auto_retries,
                "agent_runs": agent_runs,
                "settled": settled,
                "usage_complete": usage_complete,
                "reported_prompt_tokens_lower_bound": total_input,
                "reported_completion_tokens_lower_bound": total_output,
                "reported_cost_usd_lower_bound": total_cost if usage_messages else None,
            },
        ),
        extra={
            "source_format": "volt-json-v3",
            "json_protocol_version": session.get("version"),
            "cwd": session.get("cwd"),
        },
    )
    return trajectory, summary


class VoltAgent(BaseInstalledAgent):
    """Install a pinned Volt release and run it in JSON mode inside Harbor."""

    SUPPORTS_ATIF = True
    _OUTPUT_FILENAME = "volt.jsonl"
    _STDERR_FILENAME = "volt.stderr"
    _NVM_VERSION = "0.40.3"

    @staticmethod
    def name() -> str:
        return "volt"

    def __init__(
        self,
        *args: Any,
        node_version: str = "22.22.0",
        package_name: str = "@earendil-works/volt-coding-agent",
        provider: str = "pilot",
        reasoning_effort: str = "high",
        custom_provider: bool = True,
        auth_path_env: str | None = None,
        package_dir_env: str = "VOLT_PACKAGE_DIR",
        base_url_env: str = "OPENAI_BASE_URL",
        api_key_env: str = "OPENAI_API_KEY",
        api: str = "openai-responses",
        input_cost_per_million: float = 3.0,
        output_cost_per_million: float = 15.0,
        cache_read_cost_per_million: float = 0.3,
        cache_write_cost_per_million: float = 3.75,
        **kwargs: Any,
    ) -> None:
        extra_env = kwargs.get("extra_env")
        self._run_only_api_key: str | None = None
        if isinstance(extra_env, dict):
            safe_extra_env = dict(extra_env)
            self._run_only_api_key = safe_extra_env.pop(api_key_env, None)
            kwargs["extra_env"] = safe_extra_env
        super().__init__(*args, **kwargs)
        if not self._version:
            raise ValueError("VoltAgent requires an exact package version")
        self._node_version = node_version
        self._package_name = package_name
        self._provider = provider
        self._reasoning_effort = reasoning_effort
        self._custom_provider = custom_provider
        self._auth_path_env = auth_path_env
        self._package_dir_env = package_dir_env
        self._base_url_env = base_url_env
        self._api_key_env = api_key_env
        self._api = api
        self._input_cost = input_cost_per_million
        self._output_cost = output_cost_per_million
        self._cache_read_cost = cache_read_cost_per_million
        self._cache_write_cost = cache_write_cost_per_million
        self._instruction: str | None = None

    def get_version_command(self) -> str | None:
        return '. "$HOME/.nvm/nvm.sh"; volt --version'

    def parse_version(self, stdout: str) -> str:
        match = re.search(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", stdout)
        return match.group(0) if match else stdout.strip().splitlines()[-1].strip()

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "if command -v apt-get >/dev/null 2>&1; then "
                "apt-get update && apt-get install -y bash ca-certificates curl git xz-utils; "
                "elif command -v apk >/dev/null 2>&1; then "
                "apk add --no-cache bash ca-certificates curl git xz; "
                "elif command -v yum >/dev/null 2>&1; then "
                "yum install -y bash ca-certificates curl git xz; "
                "else echo 'Unsupported package manager' >&2; exit 1; fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        package_dir_value = self._get_env(self._package_dir_env)
        package_bundle = (
            check_volt_package_bundle(Path(package_dir_value))
            if package_dir_value
            else None
        )
        package_spec = shlex.quote(f"{self._package_name}@{self._version}")
        install_package_command = f"npm install -g --ignore-scripts {package_spec}; "
        if package_bundle:
            await self.exec_as_agent(
                environment,
                command="mkdir -p /tmp/volt-packages",
            )
            remote_packages: dict[str, str] = {}
            for index, (name, (package_path, _)) in enumerate(
                sorted(package_bundle.items())
            ):
                remote_path = f"/tmp/volt-packages/{index}.tgz"
                await environment.upload_file(Path(package_path), remote_path)
                remote_packages[name] = f"file:{remote_path}"
            bundle_config = shlex.quote(
                json.dumps(
                    {
                        "private": True,
                        "dependencies": remote_packages,
                        "overrides": remote_packages,
                    },
                    sort_keys=True,
                )
            )
            install_package_command = (
                'mkdir -p /tmp/volt-packages "$HOME/.volt-install"; '
                f"printf '%s' {bundle_config} > \"$HOME/.volt-install/package.json\"; "
                'npm install --prefix "$HOME/.volt-install" --omit=dev --ignore-scripts; '
                'ln -sf "$HOME/.volt-install/node_modules/.bin/volt" "$NVM_BIN/volt"; '
                "rm -rf /tmp/volt-packages; "
            )
        node_version = shlex.quote(self._node_version)
        nvm_url = shlex.quote(
            f"https://raw.githubusercontent.com/nvm-sh/nvm/v{self._NVM_VERSION}/install.sh"
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'export NVM_DIR="$HOME/.nvm" PROFILE=/dev/null; '
                f"curl -fsSL {nvm_url} | bash; "
                '. "$NVM_DIR/nvm.sh"; '
                f"nvm install {node_version}; nvm use {node_version}; "
                f"{install_package_command}"
                "node --version; npm --version; volt --version"
            ),
        )

    def _model_id(self) -> str:
        if not self.model_name:
            raise ValueError("Model name is required")
        return self.model_name.split("/", 1)[-1]

    def _models_config(self, base_url: str) -> str:
        return json.dumps(
            {
                "providers": {
                    self._provider: {
                        "baseUrl": base_url,
                        "api": self._api,
                        "apiKey": f"${self._api_key_env}",
                        "authHeader": True,
                        "models": [
                            {
                                "id": self._model_id(),
                                "name": self.model_name,
                                "reasoning": True,
                                "input": ["text"],
                                "contextWindow": 200000,
                                "maxTokens": 64000,
                                "cost": {
                                    "input": self._input_cost,
                                    "output": self._output_cost,
                                    "cacheRead": self._cache_read_cost,
                                    "cacheWrite": self._cache_write_cost,
                                },
                            }
                        ],
                    }
                }
            },
            sort_keys=True,
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._instruction = instruction
        base_url = self._get_env(self._base_url_env)
        api_key = self._run_only_api_key or self._get_env(self._api_key_env)
        if self._custom_provider and not base_url:
            raise ValueError(f"Missing {self._base_url_env}")
        if self._custom_provider and not api_key:
            raise ValueError(f"Missing {self._api_key_env}")

        auth_path = None
        if self._auth_path_env:
            configured_auth_path = self._get_env(self._auth_path_env)
            if not configured_auth_path:
                raise ValueError(f"Missing {self._auth_path_env}")
            auth_path = Path(configured_auth_path).expanduser().resolve()
            if not auth_path.is_file():
                raise ValueError(f"{self._auth_path_env} is not a file: {auth_path}")

        agent_dir = EnvironmentPaths.agent_dir.as_posix()
        volt_home = "/tmp/volt-coding-agent"
        output_path = f"{agent_dir}/{self._OUTPUT_FILENAME}"
        stderr_path = f"{agent_dir}/{self._STDERR_FILENAME}"
        escaped_instruction = shlex.quote(instruction)
        env = {
            "VOLT_CODING_AGENT_DIR": volt_home,
            "CI": "1",
            "NO_COLOR": "1",
        }
        run_env = dict(env)
        if self._custom_provider and api_key:
            run_env[self._api_key_env] = api_key

        await self.exec_as_agent(
            environment,
            command=f"rm -rf {shlex.quote(volt_home)}; mkdir -p {shlex.quote(volt_home)} {shlex.quote(agent_dir)}",
            env=env,
        )
        try:
            if auth_path:
                remote_auth_path = f"{volt_home}/auth.json"
                await environment.upload_file(auth_path, remote_auth_path)
                owner_command = f"chmod 600 {shlex.quote(remote_auth_path)}"
                if environment.default_user is not None:
                    owner_command += (
                        f" && chown {shlex.quote(str(environment.default_user))} "
                        f"{shlex.quote(remote_auth_path)}"
                    )
                await self.exec_as_root(environment, command=owner_command)

            config_command = ""
            if self._custom_provider:
                assert base_url is not None
                config = shlex.quote(self._models_config(base_url))
                config_command = f"printf '%s' {config} > {shlex.quote(volt_home + '/models.json')}; "

            await self.exec_as_agent(
                environment,
                command=(
                    "set -euo pipefail; "
                    f"{config_command}"
                    "if git -C /app rev-parse --is-inside-work-tree >/dev/null 2>&1; then "
                    f"git -C /app rev-parse HEAD > {shlex.quote(agent_dir + '/workspace-base.txt')}; "
                    f"git -C /app status --porcelain=v1 > {shlex.quote(agent_dir + '/workspace-before.txt')}; "
                    "else "
                    f"(find /app -xdev -type f -printf '%P\\t%s\\t%T@\\n' 2>/dev/null || find /app -xdev -type f -print) | LC_ALL=C sort > {shlex.quote(agent_dir + '/workspace-before.txt')}; "
                    "fi; "
                    "set +e; "
                    '. "$HOME/.nvm/nvm.sh"; '
                    "volt --mode json --no-session --name harbor-eval "
                    f"--provider {shlex.quote(self._provider)} "
                    f"--model {shlex.quote(self._model_id())} "
                    f"--thinking {shlex.quote(self._reasoning_effort)} "
                    f"{escaped_instruction} > {shlex.quote(output_path)} 2> {shlex.quote(stderr_path)}; "
                    "status=$?; "
                    "if git -C /app rev-parse --is-inside-work-tree >/dev/null 2>&1; then "
                    f"git -C /app diff --binary --no-ext-diff > {shlex.quote(agent_dir + '/final.patch')}; "
                    f"git -C /app status --porcelain=v1 > {shlex.quote(agent_dir + '/workspace-after.txt')}; "
                    "else "
                    f": > {shlex.quote(agent_dir + '/final.patch')}; "
                    f"(find /app -xdev -type f -printf '%P\\t%s\\t%T@\\n' 2>/dev/null || find /app -xdev -type f -print) | LC_ALL=C sort > {shlex.quote(agent_dir + '/workspace-after.txt')}; "
                    "fi; "
                    'if [ "$status" -ne 0 ]; then exit "$status"; fi; '
                    f'if grep -Eq \'"stopReason":"(error|aborted)"\' {shlex.quote(output_path)}; then exit 1; fi; '
                    f'grep -q \'"type":"agent_settled"\' {shlex.quote(output_path)}'
                ),
                env=run_env,
            )
        finally:
            await self.exec_as_agent(
                environment,
                command=f"rm -rf {shlex.quote(volt_home)}",
                env=env,
            )

    def populate_context_post_run(self, context: AgentContext) -> None:
        output_path = self.logs_dir / self._OUTPUT_FILENAME
        if not output_path.exists() or self._instruction is None:
            return

        events: list[dict[str, Any]] = []
        invalid_lines = 0
        for line in output_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                invalid_lines += 1
                continue
            if isinstance(event, dict):
                events.append(event)
            else:
                invalid_lines += 1

        trajectory, summary = parse_volt_events(
            events,
            instruction=self._instruction,
            agent_version=self._version or "unknown",
            model_name=self.model_name,
            reasoning_effort=self._reasoning_effort,
        )
        summary["invalid_json_lines"] = invalid_lines
        summary["adapter"] = "benchmarks.harbor.agents.volt:VoltAgent"
        summary["configured_provider"] = self._provider
        summary["configured_api"] = self._api if self._custom_provider else None
        summary["endpoint"] = (
            self._get_env(self._base_url_env) if self._custom_provider else None
        )
        summary["auth_mode"] = "auth_file" if self._auth_path_env else "environment"

        has_complete_usage = bool(
            summary["usage_messages"] and summary["usage_complete"]
        )
        context.n_input_tokens = summary["input_tokens"] if has_complete_usage else None
        context.n_cache_tokens = (
            summary["cache_read_tokens"] if has_complete_usage else None
        )
        context.n_output_tokens = (
            summary["output_tokens"] if has_complete_usage else None
        )
        context.cost_usd = summary["cost_usd"] if has_complete_usage else None
        context.metadata = summary

        trajectory_path = self.logs_dir / "trajectory.json"
        trajectory_path.write_text(
            format_trajectory_json(trajectory.to_json_dict()),
            encoding="utf-8",
        )
