"""Run-only secret injection that keeps values out of Docker command arguments."""

from __future__ import annotations

import shlex
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator, cast

from harbor.environments.base import BaseEnvironment


def _require_success(result: object, operation: str) -> None:
    return_code = getattr(result, "return_code", None)
    if return_code != 0:
        stderr = str(getattr(result, "stderr", "")).strip()
        suffix = f": {stderr}" if stderr else ""
        raise RuntimeError(f"{operation} failed with exit code {return_code}{suffix}")


class _SecretFileEnvironment:
    def __init__(
        self,
        environment: BaseEnvironment,
        *,
        secret_names: frozenset[str],
        remote_path: str,
    ) -> None:
        self._environment = environment
        self._secret_names = secret_names
        self._source_command = f"set -a; . {shlex.quote(remote_path)}; set +a; "

    def __getattr__(self, name: str) -> object:
        return getattr(self._environment, name)

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> object:
        safe_env = {
            name: value
            for name, value in (env or {}).items()
            if name not in self._secret_names
        }
        return await self._environment.exec(
            self._source_command + command,
            cwd=cwd,
            env=safe_env,
            timeout_sec=timeout_sec,
            user=user,
        )


@asynccontextmanager
async def run_only_secret_environment(
    environment: BaseEnvironment,
    secrets: dict[str, str],
) -> AsyncIterator[BaseEnvironment]:
    values = {name: value for name, value in secrets.items() if value}
    if not values:
        yield environment
        return

    with tempfile.TemporaryDirectory(prefix="volt-harbor-run-secrets-") as temporary:
        local_path = Path(temporary) / "env"
        local_path.write_text(
            "".join(
                f"export {name}={shlex.quote(value)}\n"
                for name, value in sorted(values.items())
            ),
            encoding="utf-8",
        )
        local_path.chmod(0o600)
        remote_dir = (
            f"/tmp/volt-harbor-run-secrets-{Path(temporary).name.rsplit('-', 1)[-1]}"
        )
        remote_path = f"{remote_dir}/env"
        primary_error: BaseException | None = None
        try:
            setup_result = await environment.exec(
                f"mkdir -m 700 {shlex.quote(remote_dir)}",
                user="root",
            )
            _require_success(setup_result, "Run-secret directory creation")
            await environment.upload_file(local_path, remote_path)
            owner_command = (
                f"chmod 700 {shlex.quote(remote_dir)}"
                f" && chmod 600 {shlex.quote(remote_path)}"
            )
            if environment.default_user is not None:
                owner = shlex.quote(str(environment.default_user))
                owner_command = (
                    f"chown {owner} {shlex.quote(remote_dir)} "
                    f"{shlex.quote(remote_path)} && {owner_command}"
                )
            permission_result = await environment.exec(owner_command, user="root")
            _require_success(permission_result, "Run-secret permission setup")
            wrapped = _SecretFileEnvironment(
                environment,
                secret_names=frozenset(values),
                remote_path=remote_path,
            )
            yield cast(BaseEnvironment, wrapped)
        except BaseException as error:
            primary_error = error
            raise
        finally:
            try:
                cleanup_result = await environment.exec(
                    f"rm -rf {shlex.quote(remote_dir)}",
                    user="root",
                )
                _require_success(cleanup_result, "Run-secret cleanup")
            except BaseException as cleanup_error:
                if primary_error is None:
                    raise
                primary_error.add_note(f"Run-secret cleanup failed: {cleanup_error}")
