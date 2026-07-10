"""Validate credentials and run one-task product-auth smoke comparisons."""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from harbor.models.job.config import JobConfig

from benchmarks.harbor.scripts.analyze import load_trials, summarize
from benchmarks.harbor.scripts.runtime import (
    check_volt_package_bundle,
    minimal_child_environment,
    validate_job_name,
)
from benchmarks.harbor.scripts.validate_protocol import EXPECTED_HARBOR_VERSION

DATASET_REF = "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"
MINIMUM_OAUTH_LIFETIME_SECONDS = 60 * 60
TRACKS: dict[str, dict[str, Any]] = {
    "openai": {
        "config": "smoke-local-auth-openai.yaml",
        "model": "openai-codex/gpt-5.4",
        "agents": {
            "benchmarks.harbor.agents.volt:VoltAgent": "0.79.6",
            "benchmarks.harbor.agents.run_only_secrets:RunOnlySecretCodex": "0.144.1",
        },
        "volt_provider": "openai-codex",
        "packages": {
            "@earendil-works/volt-coding-agent": "0.79.6",
            "@openai/codex": "0.144.1",
        },
    },
    "anthropic": {
        "config": "smoke-local-auth-anthropic.yaml",
        "model": "anthropic/claude-sonnet-4-5",
        "agents": {
            "benchmarks.harbor.agents.volt:VoltAgent": "0.79.6",
            "benchmarks.harbor.agents.run_only_secrets:RunOnlySecretClaudeCode": "2.1.206",
        },
        "volt_provider": "anthropic",
        "packages": {
            "@earendil-works/volt-coding-agent": "0.79.6",
            "@anthropic-ai/claude-code": "2.1.206",
        },
    },
}


def _load_config(path: Path) -> dict[str, Any]:
    value = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected YAML object in {path}")
    return value


def validate_local_auth_config(path: Path, track_name: str) -> list[str]:
    errors: list[str] = []
    track = TRACKS[track_name]
    config = _load_config(path)
    try:
        JobConfig.model_validate(config)
    except Exception as error:
        errors.append(f"Harbor JobConfig rejected {path.name}: {error}")

    if config.get("n_attempts") != 1 or config.get("n_concurrent_trials") != 1:
        errors.append("Local-auth smoke must use one attempt and one concurrent trial")
    retry = config.get("retry")
    if not isinstance(retry, dict) or retry.get("max_retries") != 0:
        errors.append("Local-auth smoke must disable Harbor retries")
    environment = config.get("environment")
    if (
        not isinstance(environment, dict)
        or environment.get("type") != "docker"
        or environment.get("delete") is not True
    ):
        errors.append("Local-auth smoke must delete its Docker environment")

    actual_agents: dict[str, str | None] = {}
    agents = config.get("agents")
    if not isinstance(agents, list):
        agents = []
    if len(agents) != 2:
        errors.append("Local-auth smoke must contain exactly two agents")
    seen_identities: set[str] = set()
    for agent in agents:
        if not isinstance(agent, dict):
            errors.append("Agent entry is not an object")
            continue
        has_name = isinstance(agent.get("name"), str)
        has_import_path = isinstance(agent.get("import_path"), str)
        if has_name == has_import_path:
            errors.append("Each agent must set exactly one of name or import_path")
        identity = agent.get("import_path") or agent.get("name")
        if isinstance(identity, str):
            if identity in seen_identities:
                errors.append(f"Duplicate agent identity: {identity}")
            seen_identities.add(identity)
        kwargs = agent.get("kwargs")
        kwargs = kwargs if isinstance(kwargs, dict) else {}
        if isinstance(identity, str):
            version = kwargs.get("version")
            actual_agents[identity] = str(version) if version is not None else None
        if agent.get("model_name") != track["model"]:
            errors.append(f"{identity} does not use {track['model']}")
    if actual_agents != track["agents"]:
        errors.append(f"Agent/version matrix differs: {actual_agents}")

    volt = next(
        (
            agent
            for agent in agents
            if isinstance(agent, dict)
            and agent.get("import_path") == "benchmarks.harbor.agents.volt:VoltAgent"
        ),
        {},
    )
    volt_kwargs = volt.get("kwargs") if isinstance(volt, dict) else {}
    if not isinstance(volt_kwargs, dict):
        volt_kwargs = {}
    if volt_kwargs.get("custom_provider") is not False:
        errors.append("Local-auth Volt must use its built-in provider")
    if volt_kwargs.get("auth_path_env") != "VOLT_AUTH_JSON_PATH":
        errors.append("Local-auth Volt must inject VOLT_AUTH_JSON_PATH")
    if volt_kwargs.get("provider") != track["volt_provider"]:
        errors.append("Local-auth Volt provider differs from track")

    datasets = config.get("datasets")
    dataset = datasets[0] if isinstance(datasets, list) and len(datasets) == 1 else {}
    if not isinstance(dataset, dict):
        dataset = {}
    if dataset.get("ref") != DATASET_REF:
        errors.append("Local-auth dataset digest differs")
    if dataset.get("task_names") != ["terminal-bench/fix-git"]:
        errors.append("Local-auth smoke must use only terminal-bench/fix-git")
    return errors


def _resolve_auth_file(explicit: Path | None, env_name: str, default: Path) -> Path:
    configured = explicit or (
        Path(os.environ[env_name]) if os.environ.get(env_name) else default
    )
    resolved = configured.expanduser().resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"{env_name} does not point to a file: {resolved}")
    return resolved


def _load_volt_credential(path: Path, provider: str) -> dict[str, Any]:
    try:
        auth = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Volt auth file is not valid JSON: {path}") from error
    credential = auth.get(provider) if isinstance(auth, dict) else None
    if not isinstance(credential, dict) or credential.get("type") != "oauth":
        raise ValueError(
            f"Volt auth file has no subscription OAuth credential for {provider!r}"
        )
    expires = credential.get("expires")
    minimum_expiry = (
        datetime.now(timezone.utc).timestamp() * 1000
        + MINIMUM_OAUTH_LIFETIME_SECONDS * 1000
    )
    if not isinstance(expires, (int, float)) or expires <= minimum_expiry:
        raise ValueError(
            f"Volt {provider!r} OAuth token expires too soon; refresh it with /login before the smoke run"
        )
    return credential


def _decode_jwt_expiry(token: str) -> float:
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("Codex access token is not a JWT")
    padding = "=" * (-len(parts[1]) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + padding))
    except (ValueError, json.JSONDecodeError) as error:
        raise ValueError("Codex access token has an invalid JWT payload") from error
    expiry = payload.get("exp") if isinstance(payload, dict) else None
    if not isinstance(expiry, (int, float)):
        raise ValueError("Codex access token has no numeric expiry")
    return float(expiry)


def _check_codex_credential(path: Path) -> str:
    try:
        contents = path.read_text(encoding="utf-8")
        auth = json.loads(contents)
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Codex auth file is not valid JSON: {path}") from error
    tokens = auth.get("tokens") if isinstance(auth, dict) else None
    access_token = tokens.get("access_token") if isinstance(tokens, dict) else None
    if not isinstance(access_token, str):
        raise ValueError("Codex auth file has no subscription access token")
    minimum_expiry = (
        datetime.now(timezone.utc).timestamp() + MINIMUM_OAUTH_LIFETIME_SECONDS
    )
    if _decode_jwt_expiry(access_token) <= minimum_expiry:
        raise ValueError(
            "Codex access token expires too soon; refresh the dedicated benchmark login"
        )
    return contents


def _check_packages(packages: dict[str, str], *, skip_volt: bool) -> None:
    for package, version in packages.items():
        if skip_volt and package == "@earendil-works/volt-coding-agent":
            continue
        result = subprocess.run(
            ["npm", "view", f"{package}@{version}", "version"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0 or result.stdout.strip() != version:
            raise RuntimeError(f"Pinned package is unavailable: {package}@{version}")


def main() -> int:
    root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=sorted(TRACKS), required=True)
    parser.add_argument("--volt-auth", type=Path)
    parser.add_argument("--codex-auth", type=Path)
    parser.add_argument(
        "--volt-package-dir",
        type=Path,
        help="Directory containing all four pinned Volt npm tarballs.",
    )
    parser.add_argument("--jobs-dir", type=Path, default=root / "jobs/volt-harbor")
    parser.add_argument("--job-name")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument(
        "--acknowledge-credential-risk",
        action="store_true",
        help="Confirm this trusted-task run exposes a benchmark credential in a container.",
    )
    args = parser.parse_args()

    track = TRACKS[args.provider]
    config_path = root / "benchmarks/harbor/configs" / str(track["config"])
    errors = validate_local_auth_config(config_path, args.provider)
    if errors:
        raise ValueError("; ".join(errors))
    if args.validate_only:
        print(f"{args.provider} local-auth config is valid; no credentials read")
        return 0
    if not args.acknowledge_credential_risk:
        raise ValueError(
            "Local-auth runs expose benchmark credentials to the task container; "
            "use a dedicated login and pass --acknowledge-credential-risk"
        )

    volt_auth = _resolve_auth_file(
        args.volt_auth,
        "VOLT_AUTH_JSON_PATH",
        Path.home() / ".volt/agent/auth.json",
    )
    volt_provider = str(track["volt_provider"])
    volt_credential = _load_volt_credential(volt_auth, volt_provider)

    additions: dict[str, str] = {}
    codex_auth_contents: str | None = None
    if args.provider == "openai":
        codex_auth = _resolve_auth_file(
            args.codex_auth,
            "CODEX_AUTH_JSON_PATH",
            Path.home() / ".codex/auth.json",
        )
        codex_auth_contents = _check_codex_credential(codex_auth)
        competitor_auth = "codex_auth_json"
    else:
        oauth_token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "").strip()
        if not oauth_token:
            raise ValueError(
                "CLAUDE_CODE_OAUTH_TOKEN is required; run `claude setup-token` and export it"
            )
        additions["CLAUDE_CODE_OAUTH_TOKEN"] = oauth_token
        competitor_auth = "claude_setup_token"

    volt_package_info = (
        check_volt_package_bundle(args.volt_package_dir)
        if args.volt_package_dir
        else None
    )
    _check_packages(track["packages"], skip_volt=volt_package_info is not None)
    if args.volt_package_dir:
        additions["VOLT_HARBOR_PACKAGE_DIR"] = str(args.volt_package_dir.resolve())
    child_env = minimal_child_environment(os.environ, additions=additions)
    job_name = validate_job_name(
        args.job_name
        or datetime.now(timezone.utc).strftime(
            f"local-auth-{args.provider}-%Y%m%dT%H%M%SZ"
        )
    )
    jobs_dir = args.jobs_dir.resolve()
    job_dir = jobs_dir / job_name
    if job_dir.exists():
        raise FileExistsError(f"Job directory already exists: {job_dir}")
    job_dir.mkdir(parents=True)

    command = [
        "harbor",
        "run",
        "--config",
        str(config_path),
        "--jobs-dir",
        str(jobs_dir),
        "--job-name",
        job_name,
        "--yes",
    ]
    started_at = datetime.now(timezone.utc)
    manifest: dict[str, object] = {
        "schema_version": 1,
        "track": f"product-auth-{args.provider}",
        "status": "launching",
        "started_at": started_at.isoformat(),
        "harbor_version": EXPECTED_HARBOR_VERSION,
        "model": track["model"],
        "agents": track["agents"],
        "volt_credential_type": volt_credential["type"],
        "volt_auth_snapshot_scope": [volt_provider],
        "competitor_auth": competitor_auth,
        "credential_file_cleanup_enforced": True,
        "volt_package_source": "tarball_bundle" if volt_package_info else "registry",
        "volt_package_sha256": {
            name: digest for name, (_, digest) in (volt_package_info or {}).items()
        },
        "command": command,
    }
    manifest_path = job_dir / "run-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    with tempfile.TemporaryDirectory(prefix="volt-harbor-auth-") as temporary:
        auth_snapshot_dir = Path(temporary)
        auth_snapshot = auth_snapshot_dir / "auth.json"
        auth_snapshot.write_text(
            json.dumps({volt_provider: volt_credential}),
            encoding="utf-8",
        )
        auth_snapshot.chmod(0o600)
        child_env["VOLT_AUTH_JSON_PATH"] = str(auth_snapshot)
        if codex_auth_contents is not None:
            codex_snapshot = auth_snapshot_dir / "codex-auth.json"
            codex_snapshot.write_text(codex_auth_contents, encoding="utf-8")
            codex_snapshot.chmod(0o600)
            child_env["CODEX_AUTH_JSON_PATH"] = str(codex_snapshot)
        result = subprocess.run(command, cwd=root, env=child_env, check=False)
    validation_errors: list[str] = []
    summary: dict[str, Any] | None = None
    try:
        summary = summarize(load_trials([job_dir]), expected_tasks=["fix-git"])
    except (OSError, ValueError) as error:
        validation_errors.append(f"Could not load trial results: {error}")
    if summary is not None:
        validation_errors.extend(summary["warnings"])
        expected_result_agents = {
            "volt",
            "codex" if args.provider == "openai" else "claude-code",
        }
        if summary["trial_count"] != 2:
            validation_errors.append(
                f"Expected 2 local-auth trials; found {summary['trial_count']}"
            )
        if set(summary["agents"]) != expected_result_agents:
            validation_errors.append(
                "Local-auth result agent matrix differs; "
                f"expected={sorted(expected_result_agents)}, "
                f"actual={sorted(summary['agents'])}"
            )
        (job_dir / "post-run-summary.json").write_text(
            json.dumps(summary, indent=2) + "\n",
            encoding="utf-8",
        )
    exit_code = result.returncode or (1 if validation_errors else 0)
    finished_at = datetime.now(timezone.utc)
    manifest.update(
        {
            "status": (
                "failed"
                if result.returncode != 0
                else "invalid"
                if validation_errors
                else "finished"
            ),
            "finished_at": finished_at.isoformat(),
            "wall_time_seconds": (finished_at - started_at).total_seconds(),
            "harbor_exit_code": result.returncode,
            "exit_code": exit_code,
            "post_run_validation_errors": validation_errors,
        }
    )
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Run manifest: {manifest_path}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
