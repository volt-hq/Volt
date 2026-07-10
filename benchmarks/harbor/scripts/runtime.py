"""Shared safety and artifact checks for Harbor launchers."""

from __future__ import annotations

import hashlib
import json
import re
import tarfile
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


def validate_job_name(job_name: str) -> str:
    if not JOB_NAME_PATTERN.fullmatch(job_name):
        raise ValueError(
            "Job name must contain only letters, digits, periods, underscores, and hyphens"
        )
    return job_name
