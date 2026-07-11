"""Shared safety and artifact checks for Harbor launchers."""

from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import tarfile
import time
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

JOB_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
VOLT_PACKAGE_VERSIONS = {
    "@earendil-works/volt-ai": "0.79.6",
    "@earendil-works/volt-agent-core": "0.79.6",
    "@earendil-works/volt-tui": "0.79.6",
    "@earendil-works/volt-coding-agent": "0.79.6",
}
BASE_ENV_NAMES = frozenset(
    {
        "APPDATA",
        "COMSPEC",
        "DOCKER_CERT_PATH",
        "DOCKER_CONFIG",
        "DOCKER_CONTEXT",
        "DOCKER_HOST",
        "DOCKER_TLS_VERIFY",
        "HOMEDRIVE",
        "HOMEPATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "LOCALAPPDATA",
        "LOGNAME",
        "NO_COLOR",
        "PATH",
        "PATHEXT",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "PROGRAMW6432",
        "SHELL",
        "SYSTEMROOT",
        "TEMP",
        "TERM",
        "TMP",
        "USER",
        "USERPROFILE",
        "WINDIR",
        "WSL_DISTRO_NAME",
        "WSL_INTEROP",
        "XDG_RUNTIME_DIR",
    }
)


def check_npm_tarball(path: Path, *, name: str, version: str) -> tuple[str, str]:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"npm package tarball does not exist: {resolved}")
    try:
        with tarfile.open(resolved, "r:gz") as archive:
            package_json = archive.extractfile("package/package.json")
            if package_json is None:
                raise ValueError("Tarball has no package/package.json")
            metadata = json.load(package_json)
    except (KeyError, tarfile.TarError, OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Invalid npm package tarball: {resolved}") from error
    if not isinstance(metadata, dict):
        raise ValueError(f"Invalid package metadata in {resolved}")
    if metadata.get("name") != name:
        raise ValueError(
            f"Tarball package is {metadata.get('name')!r}; expected {name}"
        )
    if metadata.get("version") != version:
        raise ValueError(
            f"Tarball version is {metadata.get('version')!r}; expected {version}"
        )
    digest = hashlib.sha256(resolved.read_bytes()).hexdigest()
    return str(resolved), digest


def check_volt_package_bundle(path: Path) -> dict[str, tuple[str, str]]:
    resolved = path.expanduser().resolve()
    if not resolved.is_dir():
        raise NotADirectoryError(f"Volt package bundle is not a directory: {resolved}")
    packages: dict[str, tuple[str, str]] = {}
    for tarball in sorted(resolved.glob("*.tgz")):
        for name, version in VOLT_PACKAGE_VERSIONS.items():
            try:
                checked = check_npm_tarball(tarball, name=name, version=version)
            except ValueError:
                continue
            if name in packages:
                raise ValueError(f"Volt package bundle contains duplicate {name}")
            packages[name] = checked
            break
    missing = sorted(set(VOLT_PACKAGE_VERSIONS) - set(packages))
    if missing:
        raise ValueError(f"Volt package bundle is missing exact tarballs: {missing}")
    return packages


def minimal_child_environment(
    environment: dict[str, str],
    *,
    additions: dict[str, str],
) -> dict[str, str]:
    result = {
        name: value
        for name, value in environment.items()
        if name.upper() in BASE_ENV_NAMES
    }
    result.update(additions)
    return result


def _compose_project_name(name: str) -> str:
    sanitized = re.sub(r"[^a-z0-9_-]", "-", name.lower())
    return sanitized if sanitized[:1].isalnum() else f"0{sanitized}"


def cleanup_harbor_trial_resources(job_dir: Path) -> list[str]:
    errors: list[str] = []
    environment = minimal_child_environment(dict(os.environ), additions={})
    projects = {
        _compose_project_name(path.name) for path in job_dir.iterdir() if path.is_dir()
    }
    resource_commands = (
        ("container", ["docker", "ps", "-aq"], ["docker", "rm", "-f"]),
        ("volume", ["docker", "volume", "ls", "-q"], ["docker", "volume", "rm", "-f"]),
        ("network", ["docker", "network", "ls", "-q"], ["docker", "network", "rm"]),
    )
    for project in sorted(projects):
        label = f"com.docker.compose.project={project}"
        for resource, list_command, remove_command in resource_commands:
            listed = subprocess.run(
                [*list_command, "--filter", f"label={label}"],
                capture_output=True,
                text=True,
                check=False,
                env=environment,
                timeout=10,
            )
            if listed.returncode != 0:
                errors.append(f"could not list {resource}s for {project}")
                continue
            identifiers = listed.stdout.split()
            if identifiers:
                removed = subprocess.run(
                    [*remove_command, *identifiers],
                    capture_output=True,
                    text=True,
                    check=False,
                    env=environment,
                    timeout=10,
                )
                if removed.returncode != 0:
                    errors.append(f"could not remove {resource}s for {project}")
            verified = subprocess.run(
                [*list_command, "--filter", f"label={label}"],
                capture_output=True,
                text=True,
                check=False,
                env=environment,
                timeout=10,
            )
            if verified.returncode != 0 or verified.stdout.split():
                errors.append(f"{resource}s remain for {project}")
    return errors


def normalize_return_code(return_code: int) -> int:
    return 128 + abs(return_code) if return_code < 0 else return_code


def _stop_process_tree(process: subprocess.Popen[bytes], signum: int) -> None:
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=False,
            capture_output=True,
            env=minimal_child_environment(dict(os.environ), additions={}),
            timeout=10,
        )
        process.wait()
        return
    try:
        os.killpg(process.pid, signum)
        process.wait(timeout=10)
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


@contextmanager
def defer_termination_signals() -> Iterator[list[int]]:
    pending: list[int] = []

    def defer(signum: int, _frame: object) -> None:
        pending.append(signum)

    previous = {
        signal.SIGINT: signal.getsignal(signal.SIGINT),
        signal.SIGTERM: signal.getsignal(signal.SIGTERM),
    }
    for signum in previous:
        signal.signal(signum, defer)
    try:
        yield pending
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def run_owned_process(
    command: Sequence[str],
    *,
    cwd: Path,
    environment: dict[str, str],
    pending_signals: list[int] | None = None,
) -> subprocess.CompletedProcess[bytes]:
    terminated_by: int | None = None
    process: subprocess.Popen[bytes] | None = None
    windows_tree_kill: subprocess.Popen[bytes] | None = None

    def terminate(signum: int, _frame: object) -> None:
        nonlocal terminated_by, windows_tree_kill
        terminated_by = signum
        if pending_signals is not None:
            pending_signals.append(signum)
        if process is None:
            return
        try:
            if sys.platform == "win32" and windows_tree_kill is None:
                windows_tree_kill = subprocess.Popen(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    env=minimal_child_environment(dict(os.environ), additions={}),
                )
            elif sys.platform != "win32":
                os.killpg(process.pid, signum)
        except (OSError, ProcessLookupError):
            pass

    previous_handlers = {
        signal.SIGINT: signal.getsignal(signal.SIGINT),
        signal.SIGTERM: signal.getsignal(signal.SIGTERM),
    }
    for signum in previous_handlers:
        signal.signal(signum, terminate)
    try:
        if pending_signals:
            return subprocess.CompletedProcess(list(command), 128 + pending_signals[-1])
        creation_flags = (
            subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
        )
        process = subprocess.Popen(
            list(command),
            cwd=cwd,
            env=environment,
            start_new_session=sys.platform != "win32",
            creationflags=creation_flags,
        )
        if pending_signals:
            terminate(pending_signals[-1], None)
        termination_deadline: float | None = None
        tree_stopped = False
        while True:
            if terminated_by is not None and termination_deadline is None:
                if sys.platform == "win32":
                    if windows_tree_kill is not None:
                        try:
                            windows_tree_kill.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            windows_tree_kill.kill()
                            windows_tree_kill.wait()
                    _stop_process_tree(process, terminated_by)
                    tree_stopped = True
                termination_deadline = time.monotonic() + 10
            try:
                return_code = process.wait(timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                if (
                    termination_deadline is not None
                    and time.monotonic() >= termination_deadline
                ):
                    _stop_process_tree(process, terminated_by or signal.SIGTERM)
                    return_code = process.wait()
                    break
        if terminated_by is not None and not tree_stopped:
            _stop_process_tree(process, terminated_by)
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
    if terminated_by is not None:
        return_code = 128 + terminated_by
    return subprocess.CompletedProcess(
        list(command), normalize_return_code(return_code)
    )


def validate_job_name(job_name: str) -> str:
    if not JOB_NAME_PATTERN.fullmatch(job_name):
        raise ValueError(
            "Job name must contain only letters, digits, periods, underscores, and hyphens"
        )
    return job_name
