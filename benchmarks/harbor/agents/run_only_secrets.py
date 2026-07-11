"""Harbor installed-agent wrappers that withhold model secrets during install."""

from __future__ import annotations

from typing import Any, ClassVar

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.agents.installed.codex import Codex
from harbor.agents.installed.opencode import OpenCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from benchmarks.harbor.agents.secret_environment import run_only_secret_environment


class _RunOnlySecrets:
    SECRET_NAMES: ClassVar[frozenset[str]]
    _run_only_secrets: dict[str, str]
    _extra_env: dict[str, str]

    def _separate_run_only_secrets(
        self,
        extra_env: dict[str, str] | None,
    ) -> dict[str, str]:
        values = dict(extra_env) if extra_env else {}
        self._run_only_secrets = {
            name: values.pop(name) for name in self.SECRET_NAMES if name in values
        }
        return values

    async def _run_with_secrets(
        self,
        run: Any,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._extra_env.update(self._run_only_secrets)
        try:
            async with run_only_secret_environment(
                environment,
                self._run_only_secrets,
            ) as secure_environment:
                await run(instruction, secure_environment, context)
        finally:
            for name in self._run_only_secrets:
                self._extra_env.pop(name, None)


class RunOnlySecretClaudeCode(_RunOnlySecrets, ClaudeCode):
    """Claude Code with API/OAuth credentials added only for the agent run."""

    SECRET_NAMES = frozenset(
        {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"}
    )

    def __init__(
        self,
        *args: Any,
        extra_env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> None:
        safe_env = self._separate_run_only_secrets(extra_env)
        super().__init__(*args, extra_env=safe_env, **kwargs)

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        routing_env: dict[str, str] = {}
        if self._get_env("ANTHROPIC_BASE_URL") and self.model_name:
            model_id = self.model_name.split("/", 1)[-1]
            routing_env = {
                "ANTHROPIC_DEFAULT_SONNET_MODEL": model_id,
                "ANTHROPIC_DEFAULT_OPUS_MODEL": model_id,
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": model_id,
                "CLAUDE_CODE_SUBAGENT_MODEL": model_id,
            }
            self._extra_env.update(routing_env)
        try:
            await self._run_with_secrets(
                super().run,
                instruction,
                environment,
                context,
            )
        finally:
            for name in routing_env:
                self._extra_env.pop(name, None)


class RunOnlySecretCodex(_RunOnlySecrets, Codex):
    """Codex with API/auth-file values added only for the agent run."""

    SECRET_NAMES = frozenset({"OPENAI_API_KEY", "CODEX_AUTH_JSON_PATH"})

    def __init__(
        self,
        *args: Any,
        extra_env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> None:
        safe_env = self._separate_run_only_secrets(extra_env)
        super().__init__(*args, extra_env=safe_env, **kwargs)

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        primary_error: BaseException | None = None
        try:
            await self._run_with_secrets(
                super().run,
                instruction,
                environment,
                context,
            )
        except BaseException as error:
            primary_error = error
            raise
        finally:
            try:
                await self.exec_as_agent(
                    environment,
                    command="rm -rf /tmp/codex-secrets /tmp/codex-home",
                )
            except BaseException as cleanup_error:
                if primary_error is None:
                    raise
                primary_error.add_note(f"Codex cleanup failed: {cleanup_error}")


class RunOnlySecretOpenCode(_RunOnlySecrets, OpenCode):
    """OpenCode with provider credentials added only for the agent run."""

    SECRET_NAMES = frozenset({"OPENAI_API_KEY"})

    def __init__(
        self,
        *args: Any,
        extra_env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> None:
        safe_env = self._separate_run_only_secrets(extra_env)
        super().__init__(*args, extra_env=safe_env, **kwargs)

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        base_url = self._get_env("OPENAI_BASE_URL")
        if base_url:
            provider = self._opencode_config.setdefault("provider", {})
            openai = provider.setdefault("openai", {})
            options = openai.setdefault("options", {})
            options["baseURL"] = base_url
        await self._run_with_secrets(
            super().run,
            instruction,
            environment,
            context,
        )
