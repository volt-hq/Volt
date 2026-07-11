"""Preflight and launch the pinned 100-trial fixed-model pilot."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from benchmarks.harbor.scripts.analyze import load_trials, summarize
from benchmarks.harbor.scripts.runtime import (
    check_volt_package_bundle,
    minimal_child_environment,
    run_owned_process,
    validate_job_name,
)
from benchmarks.harbor.scripts.validate_protocol import (
    EXPECTED_HARBOR_VERSION,
    EXPECTED_UPSTREAM_MODEL,
    validate_protocol,
)

EXPECTED_RESULT_AGENTS = {"volt", "claude-code", "codex", "opencode"}
CURL_PROBE_IMAGE = (
    "curlimages/curl:8.16.0@"
    "sha256:463eaf6072688fe96ac64fa623fe73e1dbe25d8ad6c34404a669ad3ce1f104b6"
)
_WORKER_KEY_REVOKED = False
PACKAGE_PINS = {
    "@earendil-works/volt-coding-agent": "0.79.6",
    "@anthropic-ai/claude-code": "2.1.206",
    "@openai/codex": "0.144.1",
    "opencode-ai": "1.17.18",
}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _read_json(url: str, key: str) -> Any:
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def _container_read_json(url: str, key: str, network: str) -> Any:
    if any(character in key for character in ('"', "\r", "\n")):
        raise ValueError("Gateway key contains characters unsafe for curl config input")
    command = [
        "docker",
        "run",
        "--rm",
        "-i",
        "--network",
        network,
        CURL_PROBE_IMAGE,
        "-fsS",
        "--config",
        "-",
        url,
    ]
    result = subprocess.run(
        command,
        input=f'header = "Authorization: Bearer {key}"\n',
        capture_output=True,
        text=True,
        check=False,
        env=minimal_child_environment(os.environ, additions={}),
    )
    if result.returncode != 0:
        detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else ""
        raise RuntimeError(f"Container gateway probe failed: {detail}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("Container gateway probe returned invalid JSON") from error


def _post_json(url: str, key: str, payload: dict[str, object]) -> Any:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def _delete_worker_key(url: str, master_key: str, worker_key: str) -> None:
    _post_json(url, master_key, {"keys": [worker_key]})
    request = urllib.request.Request(
        url.rsplit("/", 1)[0] + "/info",
        headers={"Authorization": f"Bearer {worker_key}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10):
            pass
    except urllib.error.HTTPError as error:
        if error.code in {401, 403}:
            return
        raise RuntimeError(
            f"Worker-key rejection check returned HTTP {error.code}"
        ) from error
    raise RuntimeError("Worker key remains authorized after deletion")


def _check_gateway(
    container_url: str,
    health_url: str,
    key: str,
    gateway_network: str,
    expected_budget_usd: float,
) -> dict[str, object]:
    _read_json(f"{health_url.rstrip('/')}/health/liveliness", key)
    models = _read_json(f"{health_url.rstrip('/')}/v1/models", key)
    if not isinstance(models, dict):
        raise RuntimeError("Gateway models response is not an object")
    model_ids = {
        item.get("id") for item in models.get("data", []) if isinstance(item, dict)
    }
    required = {"pilot-model", "openai/pilot-model"}
    if not required.issubset(model_ids):
        raise RuntimeError(
            f"Gateway at {container_url} does not expose required aliases: "
            f"{sorted(required - model_ids)}"
        )

    model_info = _read_json(f"{health_url.rstrip('/')}/v1/model/info", key)
    if not isinstance(model_info, dict):
        raise RuntimeError("Gateway model-info response is not an object")
    runtime_deployments = model_info.get("data", [])
    runtime_deployments = (
        runtime_deployments if isinstance(runtime_deployments, list) else []
    )
    deployments: dict[str, set[str]] = {}
    observed: list[dict[str, object]] = []
    for deployment in runtime_deployments:
        if not isinstance(deployment, dict):
            continue
        alias = deployment.get("model_name")
        params = deployment.get("litellm_params")
        params = params if isinstance(params, dict) else {}
        upstream = params.get("model")
        if isinstance(alias, str) and isinstance(upstream, str):
            deployments.setdefault(alias, set()).add(upstream)
            if alias in required:
                observed.append(
                    {
                        "alias": alias,
                        "upstream_model": upstream,
                        "route_num_retries": params.get("num_retries"),
                    }
                )
    if (
        len(runtime_deployments) != 2
        or [item["alias"] for item in observed].count("pilot-model") != 1
        or [item["alias"] for item in observed].count("openai/pilot-model") != 1
    ):
        raise RuntimeError("Gateway must expose exactly one deployment per pilot alias")
    expected = {EXPECTED_UPSTREAM_MODEL}
    mismatched = {
        alias: sorted(deployments.get(alias, set()))
        for alias in sorted(required)
        if deployments.get(alias) != expected
    }
    if mismatched:
        raise RuntimeError(f"Gateway runtime routes differ: {mismatched}")
    if any(item["route_num_retries"] != 0 for item in observed):
        raise RuntimeError("Gateway runtime routes do not disable deployment retries")

    key_response = _read_json(f"{health_url.rstrip('/')}/key/info", key)
    if not isinstance(key_response, dict):
        raise RuntimeError("Gateway key-info response is not an object")
    key_info = key_response.get("info")
    if not isinstance(key_info, dict):
        raise RuntimeError("Gateway worker key has no database-backed key metadata")
    if set(key_info.get("models") or []) != required:
        raise RuntimeError("Gateway worker key is not restricted to the pilot aliases")
    if key_info.get("max_parallel_requests") != 16:
        raise RuntimeError("Gateway worker key must allow exactly 16 parallel requests")
    max_budget = key_info.get("max_budget")
    if not isinstance(max_budget, (int, float)) or not math.isclose(
        float(max_budget),
        expected_budget_usd,
    ):
        raise RuntimeError(
            "Gateway worker key budget differs from PILOT_MAX_BUDGET_USD"
        )
    expires = key_info.get("expires")
    if not isinstance(expires, str):
        raise RuntimeError("Gateway worker key must have a finite expiry")
    try:
        expiry = datetime.fromisoformat(expires.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeError("Gateway worker key has an invalid expiry") from error
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    remaining = (expiry - datetime.now(timezone.utc)).total_seconds()
    if remaining < 2 * 60 * 60 or remaining > 25 * 60 * 60:
        raise RuntimeError("Gateway worker key expiry must be 2-25 hours away")
    if key_info.get("blocked") is True:
        raise RuntimeError("Gateway worker key is blocked")

    container_model_info = _container_read_json(
        f"{container_url.rstrip('/')}/v1/model/info",
        key,
        gateway_network,
    )
    if not isinstance(container_model_info, dict):
        raise RuntimeError("Container gateway model-info response is not an object")
    container_observed = []
    for deployment in container_model_info.get("data", []):
        if not isinstance(deployment, dict):
            continue
        params = deployment.get("litellm_params")
        params = params if isinstance(params, dict) else {}
        container_observed.append(
            {
                "alias": deployment.get("model_name"),
                "upstream_model": params.get("model"),
                "route_num_retries": params.get("num_retries"),
            }
        )
    if sorted(container_observed, key=lambda item: str(item["alias"])) != sorted(
        observed,
        key=lambda item: str(item["alias"]),
    ):
        raise RuntimeError("Container and host gateway routes differ")
    container_key_response = _container_read_json(
        f"{container_url.rstrip('/')}/key/info",
        key,
        gateway_network,
    )
    if not isinstance(container_key_response, dict):
        raise RuntimeError("Container gateway key-info response is not an object")
    container_key_info = container_key_response.get("info")
    if not isinstance(container_key_info, dict) or any(
        container_key_info.get(field) != key_info.get(field)
        for field in (
            "models",
            "max_parallel_requests",
            "max_budget",
            "expires",
            "blocked",
        )
    ):
        raise RuntimeError("Container and host gateway worker-key policies differ")
    return {
        "routes": sorted(observed, key=lambda item: str(item["alias"])),
        "worker_key_policy": {
            "models": sorted(required),
            "max_parallel_requests": 16,
            "max_budget_usd": float(max_budget),
            "expires": expiry.isoformat(),
        },
    }


def _check_packages(*, skip_volt: bool) -> None:
    for package, version in PACKAGE_PINS.items():
        if skip_volt and package == "@earendil-works/volt-coding-agent":
            continue
        result = subprocess.run(
            ["npm", "view", f"{package}@{version}", "version"],
            capture_output=True,
            text=True,
            check=False,
            env=minimal_child_environment(os.environ, additions={}),
        )
        if result.returncode != 0 or result.stdout.strip() != version:
            detail = (
                result.stderr.strip().splitlines()[-1]
                if result.stderr.strip()
                else "not found"
            )
            raise RuntimeError(
                f"Pinned package {package}@{version} is unavailable: {detail}"
            )


def _post_validate(
    job_dir: Path,
    expected_tasks: list[str],
) -> tuple[dict[str, Any] | None, list[str]]:
    try:
        summary = summarize(
            load_trials([job_dir]),
            expected_tasks=expected_tasks,
        )
    except (OSError, ValueError) as error:
        return None, [f"Could not load trial results: {error}"]

    errors = list(summary["warnings"])
    if summary["trial_count"] != len(expected_tasks) * len(EXPECTED_RESULT_AGENTS):
        errors.append(
            f"Expected {len(expected_tasks) * len(EXPECTED_RESULT_AGENTS)} trials; "
            f"found {summary['trial_count']}"
        )
    actual_agents = set(summary["agents"])
    if actual_agents != EXPECTED_RESULT_AGENTS:
        errors.append(
            f"Result agent matrix differs; expected={sorted(EXPECTED_RESULT_AGENTS)}, "
            f"actual={sorted(actual_agents)}"
        )
    return summary, errors


def _git_value(root: Path, *args: str) -> str | None:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
        env=minimal_child_environment(os.environ, additions={}),
    )
    return result.stdout.strip() if result.returncode == 0 else None


def _load_agents(config_path: Path) -> list[dict[str, object]]:
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    agents = config.get("agents", []) if isinstance(config, dict) else []
    result: list[dict[str, object]] = []
    for agent in agents:
        if not isinstance(agent, dict):
            continue
        kwargs = agent.get("kwargs")
        kwargs = kwargs if isinstance(kwargs, dict) else {}
        result.append(
            {
                "identity": agent.get("import_path") or agent.get("name"),
                "version": kwargs.get("version"),
                "model": agent.get("model_name"),
            }
        )
    return result


def _main() -> int:
    global _WORKER_KEY_REVOKED

    root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=root / "benchmarks/harbor/configs/pilot.yaml",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=root / "benchmarks/harbor/manifests/terminal-bench-2.1-pilot-v1.json",
    )
    parser.add_argument(
        "--gateway-config",
        type=Path,
        default=root / "benchmarks/harbor/gateway/litellm.yaml",
    )
    parser.add_argument("--jobs-dir", type=Path, default=root / "jobs/volt-harbor")
    parser.add_argument("--job-name")
    parser.add_argument(
        "--volt-package-dir",
        type=Path,
        help="Directory containing all four pinned Volt npm tarballs.",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Validate checked-in files without credentials, network calls, or trials.",
    )
    args = parser.parse_args()

    errors = validate_protocol(args.config, args.manifest, args.gateway_config)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    if args.validate_only:
        print("Pilot protocol is valid; no trials launched")
        return 0

    gateway_key = os.environ.get("PILOT_GATEWAY_KEY", "").strip()
    if not gateway_key:
        raise RuntimeError("PILOT_GATEWAY_KEY is required")
    if gateway_key == "sk-local-change-me" or len(gateway_key) < 24:
        raise RuntimeError("PILOT_GATEWAY_KEY must be a non-default scoped worker key")
    gateway_master_key = os.environ.get("PILOT_GATEWAY_MASTER_KEY", "").strip()
    if not gateway_master_key:
        raise RuntimeError(
            "PILOT_GATEWAY_MASTER_KEY is required for worker-key revocation"
        )
    if gateway_master_key == gateway_key:
        raise RuntimeError("Gateway master and worker keys must differ")
    gateway_network = os.environ.get("PILOT_GATEWAY_NETWORK", "").strip()
    if not gateway_network:
        raise RuntimeError("PILOT_GATEWAY_NETWORK is required")
    container_url = os.environ.get(
        "PILOT_GATEWAY_URL", "http://volt-bench-gateway-proxy:4000"
    ).rstrip("/")
    probe_url = "http://volt-bench-gateway:4000"
    health_url = os.environ.get(
        "PILOT_GATEWAY_HEALTH_URL", "http://127.0.0.1:4000"
    ).rstrip("/")

    budget_value = os.environ.get("PILOT_MAX_BUDGET_USD", "").strip()
    try:
        expected_budget_usd = float(budget_value)
    except ValueError as error:
        raise RuntimeError("PILOT_MAX_BUDGET_USD must be numeric") from error
    if not math.isfinite(expected_budget_usd) or expected_budget_usd <= 0:
        raise RuntimeError("PILOT_MAX_BUDGET_USD must be finite and positive")
    observed_gateway = _check_gateway(
        probe_url,
        health_url,
        gateway_key,
        gateway_network,
        expected_budget_usd,
    )
    volt_package_info = (
        check_volt_package_bundle(args.volt_package_dir)
        if args.volt_package_dir
        else None
    )
    _check_packages(skip_volt=volt_package_info is not None)

    openai_base_url = f"{container_url}/v1"
    additions = {
        "PILOT_GATEWAY_KEY": gateway_key,
        "PILOT_OPENAI_BASE_URL": openai_base_url,
        "PILOT_ANTHROPIC_BASE_URL": container_url,
    }
    if args.volt_package_dir:
        additions["VOLT_HARBOR_PACKAGE_DIR"] = str(args.volt_package_dir.resolve())
    child_env = minimal_child_environment(os.environ, additions=additions)

    job_name = validate_job_name(
        args.job_name
        or datetime.now(timezone.utc).strftime("volt-fixed-model-pilot-%Y%m%dT%H%M%SZ")
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
        str(args.config.resolve()),
        "--jobs-dir",
        str(jobs_dir),
        "--job-name",
        job_name,
        "--yes",
    ]
    started_at = datetime.now(timezone.utc)
    run_manifest: dict[str, object] = {
        "schema_version": 1,
        "status": "launching",
        "started_at": started_at.isoformat(),
        "repository_commit": _git_value(root, "rev-parse", "HEAD"),
        "repository_status": (_git_value(root, "status", "--short") or "").splitlines(),
        "harbor_version": EXPECTED_HARBOR_VERSION,
        "litellm_version": "1.91.1",
        "upstream_model": EXPECTED_UPSTREAM_MODEL,
        "observed_gateway": observed_gateway,
        "gateway_container_probe_image": CURL_PROBE_IMAGE,
        "gateway_container_url": container_url,
        "gateway_probe_url": probe_url,
        "gateway_health_url": health_url,
        "gateway_network": gateway_network,
        "pilot_config_sha256": _sha256(args.config),
        "task_manifest_sha256": _sha256(args.manifest),
        "gateway_config_sha256": _sha256(args.gateway_config),
        "agents": _load_agents(args.config),
        "volt_package_source": "tarball_bundle" if volt_package_info else "registry",
        "volt_package_sha256": {
            name: digest for name, (_, digest) in (volt_package_info or {}).items()
        },
        "command": command,
        "secret_environment_variables_passed_to_harbor": ["PILOT_GATEWAY_KEY"],
    }
    manifest_path = job_dir / "run-manifest.json"
    manifest_path.write_text(
        json.dumps(run_manifest, indent=2) + "\n", encoding="utf-8"
    )

    revocation_error: str | None = None
    try:
        result = run_owned_process(
            command,
            cwd=root,
            environment=child_env,
        )
    finally:
        try:
            _delete_worker_key(
                f"{health_url.rstrip('/')}/key/delete",
                gateway_master_key,
                gateway_key,
            )
            _WORKER_KEY_REVOKED = True
        except Exception as error:
            revocation_error = f"Worker-key revocation failed: {error}"
    task_manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    expected_tasks = [
        str(task["name"])
        for task in task_manifest.get("tasks", [])
        if isinstance(task, dict) and isinstance(task.get("name"), str)
    ]
    summary, validation_errors = _post_validate(job_dir, expected_tasks)
    if revocation_error:
        validation_errors.append(revocation_error)
    if summary is not None:
        (job_dir / "post-run-summary.json").write_text(
            json.dumps(summary, indent=2) + "\n",
            encoding="utf-8",
        )
    exit_code = result.returncode or (1 if validation_errors else 0)
    finished_at = datetime.now(timezone.utc)
    run_manifest.update(
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
            "worker_key_revocation_owner": "launcher",
            "worker_key_revoked": revocation_error is None,
        }
    )
    manifest_path.write_text(
        json.dumps(run_manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Run manifest: {manifest_path}")
    return exit_code


def main() -> int:
    global _WORKER_KEY_REVOKED

    _WORKER_KEY_REVOKED = False
    active_error = False
    try:
        return _main()
    except BaseException:
        active_error = True
        raise
    finally:
        if not _WORKER_KEY_REVOKED and "--validate-only" not in sys.argv[1:]:
            gateway_key = os.environ.get("PILOT_GATEWAY_KEY", "").strip()
            master_key = os.environ.get("PILOT_GATEWAY_MASTER_KEY", "").strip()
            if gateway_key and master_key:
                health_url = os.environ.get(
                    "PILOT_GATEWAY_HEALTH_URL", "http://127.0.0.1:4000"
                ).rstrip("/")
                try:
                    _delete_worker_key(
                        f"{health_url}/key/delete",
                        master_key,
                        gateway_key,
                    )
                    _WORKER_KEY_REVOKED = True
                except Exception as error:
                    message = f"Worker-key revocation after preflight failed: {error}"
                    if active_error:
                        print(message, file=sys.stderr)
                    else:
                        raise RuntimeError(message) from error


if __name__ == "__main__":
    raise SystemExit(main())
