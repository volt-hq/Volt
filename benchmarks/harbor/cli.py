"""Operator CLI for repository-owned Harbor benchmarks."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import math
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from benchmarks.harbor.scripts.runtime import (
    check_volt_package_bundle,
    defer_termination_signals,
    minimal_child_environment,
    run_owned_process,
    validate_job_name,
)
from benchmarks.harbor.scripts.validate_protocol import (
    EXPECTED_HARBOR_VERSION,
    validate_protocol,
)

GATEWAY_MODELS = ["pilot-model", "openai/pilot-model"]
DEFAULT_GATEWAY_PORT = 4000


def repository_root() -> Path:
    candidates = [Path.cwd(), Path(__file__).resolve().parents[2]]
    for candidate in candidates:
        for parent in (candidate, *candidate.parents):
            if (parent / "benchmarks/harbor/pyproject.toml").is_file() and (
                parent / "package.json"
            ).is_file():
                return parent
    raise RuntimeError("Run volt-bench from a Volt repository checkout")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _post_json(url: str, key: str, payload: dict[str, object]) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        value = json.load(response)
    if not isinstance(value, dict):
        raise RuntimeError(f"Expected an object from {url}")
    return value


def _worker_key_is_rejected(url: str, worker_key: str) -> bool:
    request = urllib.request.Request(
        f"{url.rstrip('/')}/key/info",
        headers={"Authorization": f"Bearer {worker_key}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10):
            return False
    except urllib.error.HTTPError as error:
        if error.code in {401, 403}:
            return True
        raise RuntimeError(
            f"Worker-key rejection check returned HTTP {error.code}"
        ) from error


def _delete_worker_key(url: str, master_key: str, worker_key: str) -> None:
    _post_json(
        f"{url.rstrip('/')}/key/delete",
        master_key,
        {"keys": [worker_key]},
    )
    if not _worker_key_is_rejected(url, worker_key):
        raise RuntimeError("Worker key remains authorized after deletion")


def _wait_for_gateway(url: str, key: str, timeout_seconds: int = 180) -> None:
    deadline = time.monotonic() + timeout_seconds
    last_error = "not ready"
    while time.monotonic() < deadline:
        request = urllib.request.Request(
            f"{url.rstrip('/')}/health/liveliness",
            headers={"Authorization": f"Bearer {key}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError) as error:
            last_error = str(error)
        time.sleep(2)
    raise RuntimeError(f"Managed gateway did not become ready: {last_error}")


def _run(
    command: list[str],
    *,
    root: Path,
    environment: dict[str, str] | None = None,
    capture: bool = False,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=root,
        env=environment,
        text=True,
        capture_output=capture,
        check=False,
        timeout=timeout,
    )


def _cleanup_managed_gateway(
    root: Path,
    *,
    compose: list[str],
    compose_environment: dict[str, str],
    project_name: str,
) -> list[str]:
    errors: list[str] = []
    compose_error = ""
    for attempt in range(3):
        try:
            teardown = _run(
                [*compose, "down", "--volumes", "--remove-orphans"],
                root=root,
                environment=compose_environment,
                capture=True,
                timeout=30,
            )
            if teardown.returncode == 0:
                compose_error = ""
                break
            compose_error = f"Compose teardown exited {teardown.returncode}"
        except (OSError, subprocess.TimeoutExpired) as error:
            compose_error = f"Compose teardown failed: {error}"
        if attempt < 2:
            time.sleep(1)
    if compose_error:
        errors.append(compose_error)

    docker_environment = minimal_child_environment(os.environ, additions={})
    resource_commands = (
        (["docker", "ps", "-aq"], ["docker", "rm", "-f"]),
        (["docker", "volume", "ls", "-q"], ["docker", "volume", "rm", "-f"]),
        (["docker", "network", "ls", "-q"], ["docker", "network", "rm"]),
    )
    project_filter = f"label=com.docker.compose.project={project_name}"
    for list_command, remove_command in resource_commands:
        resource_error = ""
        for attempt in range(3):
            try:
                listed = _run(
                    [*list_command, "--filter", project_filter],
                    root=root,
                    environment=docker_environment,
                    capture=True,
                    timeout=10,
                )
                identifiers = listed.stdout.split() if listed.returncode == 0 else []
                if identifiers:
                    _run(
                        [*remove_command, *identifiers],
                        root=root,
                        environment=docker_environment,
                        capture=True,
                        timeout=10,
                    )
                remaining = _run(
                    [*list_command, "--filter", project_filter],
                    root=root,
                    environment=docker_environment,
                    capture=True,
                    timeout=10,
                )
                if remaining.returncode == 0 and not remaining.stdout.split():
                    resource_error = ""
                    break
                resource_error = f"Resources remain for {project_filter}"
            except (OSError, subprocess.TimeoutExpired) as error:
                resource_error = f"Docker cleanup failed for {project_filter}: {error}"
            if attempt < 2:
                time.sleep(1)
        if resource_error:
            errors.append(resource_error)
    return errors


def _default_release_dir(_root: Path) -> Path:
    configured = os.environ.get("VOLT_BENCH_CACHE_DIR", "").strip()
    if configured:
        cache_root = Path(configured).expanduser()
    elif os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        cache_root = Path(os.environ["LOCALAPPDATA"])
    elif os.environ.get("XDG_CACHE_HOME"):
        cache_root = Path(os.environ["XDG_CACHE_HOME"])
    else:
        cache_root = Path.home() / ".cache"
    return (cache_root / "volt-bench/volt-release").resolve()


def _default_jobs_dir(root: Path) -> Path:
    return root / "jobs/volt-harbor"


def _bundle_dir(root: Path, explicit: Path | None) -> Path:
    if explicit:
        return explicit.expanduser().resolve()
    return _default_release_dir(root) / "tarballs"


def _recover_interrupted_prepare(output: Path) -> None:
    backups = list(output.parent.glob(f".{output.name}.backup-*"))
    if output.exists():
        if not backups:
            return
        owner = _read_json(output / ".volt-bench-owner.json")
        if owner.get("schema_version") != 1 or owner.get("path") != str(output):
            raise RuntimeError(f"Cannot reconcile release backups for {output}")
        check_volt_package_bundle(output / "tarballs")
        for backup in backups:
            backup_owner = _read_json(backup / ".volt-bench-owner.json")
            if (
                backup.is_symlink()
                or not backup.is_dir()
                or backup_owner.get("schema_version") != 1
                or backup_owner.get("path") != str(output)
            ):
                raise RuntimeError(f"Cannot reconcile release backup {backup}")
            shutil.rmtree(backup)
        return
    if not backups:
        return
    recoverable: list[Path] = []
    for backup in backups:
        if backup.is_symlink() or not backup.is_dir():
            continue
        owner = _read_json(backup / ".volt-bench-owner.json")
        if owner.get("schema_version") == 1 and owner.get("path") == str(output):
            recoverable.append(backup)
    if len(backups) != 1 or len(recoverable) != 1:
        raise RuntimeError(
            f"Cannot safely recover interrupted release backups for {output}"
        )
    recoverable[0].rename(output)


def _prepare(
    root: Path,
    output: Path,
    *,
    skip_check: bool,
    capture: bool = False,
) -> dict[str, object]:
    output = output.resolve()
    try:
        output.relative_to(root.resolve())
    except ValueError:
        pass
    else:
        raise RuntimeError("The local release output must be outside the repository")
    if output.is_symlink():
        raise RuntimeError(f"Refusing to use a symlink release output: {output}")
    _recover_interrupted_prepare(output)
    owner_path = output / ".volt-bench-owner.json"
    owner = _read_json(owner_path)
    owned = owner.get("schema_version") == 1 and owner.get("path") == str(output)
    if output.exists() and not owned:
        raise RuntimeError(
            f"Refusing to replace an output not owned by volt-bench: {output}"
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    nonce = secrets.token_hex(6)
    staging = output.parent / f".{output.name}.staging-{nonce}"
    backup = output.parent / f".{output.name}.backup-{nonce}"
    command = [
        "npm",
        "run",
        "release:local",
        "--",
        "--out",
        str(staging),
        "--skip-install",
        "--skip-bun-install",
    ]
    if skip_check:
        command.append("--skip-check")
    child_env = minimal_child_environment(os.environ, additions={})
    primary_error: BaseException | None = None
    try:
        result = _run(command, root=root, environment=child_env, capture=capture)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip().splitlines()
            suffix = f": {detail[-1]}" if detail else ""
            raise RuntimeError(
                f"Local release failed with exit code {result.returncode}{suffix}"
            )
        check_volt_package_bundle(staging / "tarballs")
        staging_owner = staging / ".volt-bench-owner.json"
        staging_owner.write_text(
            json.dumps({"schema_version": 1, "path": str(output)}) + "\n",
            encoding="utf-8",
        )
        staging_owner.chmod(0o600)
        if output.exists():
            output.rename(backup)
        try:
            staging.rename(output)
        except BaseException:
            if backup.exists() and not output.exists():
                backup.rename(output)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    except BaseException as error:
        primary_error = error
        raise
    finally:
        if staging.exists():
            try:
                shutil.rmtree(staging)
            except BaseException as cleanup_error:
                if primary_error is None:
                    raise
                primary_error.add_note(
                    f"Release staging cleanup failed: {cleanup_error}"
                )

    package_info = check_volt_package_bundle(output / "tarballs")
    return {
        "output": str(output),
        "tarballs": str(output / "tarballs"),
        "packages": {
            name: {"path": path, "sha256": digest}
            for name, (path, digest) in package_info.items()
        },
    }


def _doctor(root: Path, gateway: str, package_dir: Path) -> list[dict[str, object]]:
    checks: list[dict[str, object]] = []

    def add(name: str, ok: bool, detail: str, *, required: bool = True) -> None:
        checks.append({"name": name, "ok": ok, "detail": detail, "required": required})

    uv_path = shutil.which("uv")
    docker_path = shutil.which("docker")
    docker_environment = minimal_child_environment(os.environ, additions={})
    add("uv", uv_path is not None, uv_path or "not found")
    add("docker", docker_path is not None, docker_path or "not found")
    if docker_path:
        docker_info = _run(
            [docker_path, "info", "--format", "{{.ServerVersion}}"],
            root=root,
            environment=docker_environment,
            capture=True,
        )
        add(
            "docker-server",
            docker_info.returncode == 0,
            docker_info.stdout.strip()
            if docker_info.returncode == 0
            else "not reachable",
        )
        compose = _run(
            [docker_path, "compose", "version"],
            root=root,
            environment=docker_environment,
            capture=True,
        )
        add(
            "docker-compose",
            compose.returncode == 0,
            compose.stdout.strip() if compose.returncode == 0 else "not available",
        )
    else:
        add("docker-server", False, "not reachable")
        add("docker-compose", False, "not available")

    try:
        harbor_version = importlib.metadata.version("harbor")
    except importlib.metadata.PackageNotFoundError:
        harbor_version = "not installed"
    add(
        "harbor",
        harbor_version == EXPECTED_HARBOR_VERSION,
        f"{harbor_version}; expected {EXPECTED_HARBOR_VERSION}",
    )

    config_root = root / "benchmarks/harbor"
    protocol_errors = validate_protocol(
        config_root / "configs/pilot.yaml",
        config_root / "manifests/terminal-bench-2.1-pilot-v1.json",
        config_root / "gateway/litellm.yaml",
    )
    add(
        "protocol",
        not protocol_errors,
        "valid" if not protocol_errors else "; ".join(protocol_errors),
    )

    try:
        check_volt_package_bundle(package_dir)
        bundle_detail = str(package_dir)
        bundle_ok = True
    except (OSError, ValueError) as error:
        bundle_detail = str(error)
        bundle_ok = False
    add("volt-package-bundle", bundle_ok, bundle_detail, required=False)

    budget = os.environ.get("PILOT_MAX_BUDGET_USD", "").strip()
    try:
        budget_value = float(budget)
        budget_ok = math.isfinite(budget_value) and budget_value > 0
    except ValueError:
        budget_ok = False
    add("pilot-budget", budget_ok, "configured" if budget_ok else "missing or invalid")

    if gateway == "managed":
        upstream = os.environ.get("UPSTREAM_ANTHROPIC_API_KEY", "").strip()
        add(
            "upstream-anthropic-key",
            bool(upstream),
            "configured" if upstream else "missing",
        )
    else:
        for name in (
            "PILOT_GATEWAY_KEY",
            "PILOT_GATEWAY_MASTER_KEY",
            "PILOT_GATEWAY_NETWORK",
        ):
            configured = bool(os.environ.get(name, "").strip())
            add(name.lower(), configured, "configured" if configured else "missing")
        network = os.environ.get("PILOT_GATEWAY_NETWORK", "").strip()
        if docker_path and network:
            inspected = _run(
                [docker_path, "network", "inspect", network],
                root=root,
                environment=docker_environment,
                capture=True,
            )
            add(
                "gateway-network",
                inspected.returncode == 0,
                network if inspected.returncode == 0 else "not found",
            )
    return checks


def _pilot_command(
    root: Path,
    *,
    jobs_dir: Path,
    job_name: str,
    package_dir: Path | None,
) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "benchmarks.harbor.scripts.run_pilot",
        "--jobs-dir",
        str(jobs_dir),
        "--job-name",
        job_name,
    ]
    if package_dir:
        command.extend(["--volt-package-dir", str(package_dir)])
    return command


def _external_pilot(
    root: Path,
    *,
    jobs_dir: Path,
    job_name: str,
    package_dir: Path | None,
    gateway_network: str | None,
    max_budget_usd: float,
) -> int:
    gateway_key = os.environ.get("PILOT_GATEWAY_KEY", "").strip()
    master_key = os.environ.get("PILOT_GATEWAY_MASTER_KEY", "").strip()
    network = (gateway_network or os.environ.get("PILOT_GATEWAY_NETWORK", "")).strip()
    missing = [
        name
        for name, value in (
            ("PILOT_GATEWAY_KEY", gateway_key),
            ("PILOT_GATEWAY_MASTER_KEY", master_key),
            ("PILOT_GATEWAY_NETWORK", network),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(f"External gateway variables are missing: {missing}")
    container_url = os.environ.get(
        "PILOT_GATEWAY_URL", "http://volt-bench-gateway-proxy:4000"
    ).rstrip("/")
    health_url = os.environ.get(
        "PILOT_GATEWAY_HEALTH_URL", "http://127.0.0.1:4000"
    ).rstrip("/")
    child_env = minimal_child_environment(
        os.environ,
        additions={
            "PILOT_GATEWAY_KEY": gateway_key,
            "PILOT_GATEWAY_MASTER_KEY": master_key,
            "PILOT_GATEWAY_URL": container_url,
            "PILOT_GATEWAY_HEALTH_URL": health_url,
            "PILOT_GATEWAY_NETWORK": network,
            "PILOT_MAX_BUDGET_USD": str(max_budget_usd),
        },
    )
    result = run_owned_process(
        _pilot_command(
            root,
            jobs_dir=jobs_dir,
            job_name=job_name,
            package_dir=package_dir,
        ),
        cwd=root,
        environment=child_env,
    )
    if result.returncode != 0:
        try:
            if not _worker_key_is_rejected(health_url, gateway_key):
                _delete_worker_key(health_url, master_key, gateway_key)
        except Exception as error:
            print(f"External worker-key cleanup failed: {error}", file=sys.stderr)
    return result.returncode


def _managed_pilot_inner(
    root: Path,
    *,
    jobs_dir: Path,
    job_name: str,
    package_dir: Path | None,
    port: int,
    gateway_bind: str,
    container_url: str,
    max_budget_usd: float,
    pending_signals: list[int],
) -> int:
    upstream_key = os.environ.get("UPSTREAM_ANTHROPIC_API_KEY", "").strip()
    if not upstream_key:
        raise RuntimeError("UPSTREAM_ANTHROPIC_API_KEY is required")
    if not math.isfinite(max_budget_usd) or max_budget_usd <= 0:
        raise RuntimeError("The pilot budget must be finite and positive")
    if not 1 <= port <= 65535:
        raise RuntimeError("Gateway port must be between 1 and 65535")
    if not gateway_bind or ":" in gateway_bind:
        raise RuntimeError("Gateway bind must be an IPv4 address or hostname")

    master_key = f"sk-{secrets.token_urlsafe(32)}"
    salt_key = secrets.token_urlsafe(32)
    database_password = secrets.token_urlsafe(32)
    project_name = f"volt-bench-{secrets.token_hex(6)}"
    gateway_network = f"{project_name}-gateway"
    compose_path = root / "benchmarks/harbor/gateway/docker-compose.yaml"
    health_host = "127.0.0.1" if gateway_bind == "0.0.0.0" else gateway_bind
    health_url = f"http://{health_host}:{port}"
    container_url = container_url.rstrip("/")
    print(f"Managed gateway project: {project_name}", flush=True)
    compose_env = minimal_child_environment(
        os.environ,
        additions={
            "UPSTREAM_ANTHROPIC_API_KEY": upstream_key,
            "PILOT_GATEWAY_MASTER_KEY": master_key,
            "LITELLM_SALT_KEY": salt_key,
            "VOLT_BENCH_POSTGRES_PASSWORD": database_password,
            "VOLT_BENCH_GATEWAY_BIND": gateway_bind,
            "VOLT_BENCH_GATEWAY_PORT": str(port),
            "VOLT_BENCH_GATEWAY_NETWORK": gateway_network,
        },
    )
    teardown_env = minimal_child_environment(
        os.environ,
        additions={
            "UPSTREAM_ANTHROPIC_API_KEY": "unused-during-teardown",
            "PILOT_GATEWAY_MASTER_KEY": "sk-unused-during-teardown",
            "LITELLM_SALT_KEY": "unused-during-teardown",
            "VOLT_BENCH_POSTGRES_PASSWORD": "unused-during-teardown",
            "VOLT_BENCH_GATEWAY_BIND": gateway_bind,
            "VOLT_BENCH_GATEWAY_PORT": str(port),
            "VOLT_BENCH_GATEWAY_NETWORK": gateway_network,
        },
    )
    compose = ["docker", "compose", "-p", project_name, "-f", str(compose_path)]
    worker_key: str | None = None
    result_code = 1
    primary_error: BaseException | None = None
    cleanup_errors: list[str] = []
    try:
        up = _run([*compose, "up", "-d", "--wait"], root=root, environment=compose_env)
        if up.returncode != 0:
            raise RuntimeError(
                f"Managed gateway startup failed with exit code {up.returncode}"
            )
        _wait_for_gateway(health_url, master_key)
        response = _post_json(
            f"{health_url}/key/generate",
            master_key,
            {
                "models": GATEWAY_MODELS,
                "duration": "24h",
                "max_budget": max_budget_usd,
                "max_parallel_requests": 16,
            },
        )
        generated_key = response.get("key")
        if not isinstance(generated_key, str) or not generated_key:
            raise RuntimeError("Managed gateway did not return a worker key")
        worker_key = generated_key
        child_env = minimal_child_environment(
            os.environ,
            additions={
                "PILOT_GATEWAY_KEY": worker_key,
                "PILOT_GATEWAY_MASTER_KEY": master_key,
                "PILOT_GATEWAY_URL": container_url,
                "PILOT_GATEWAY_HEALTH_URL": health_url,
                "PILOT_GATEWAY_NETWORK": gateway_network,
                "PILOT_MAX_BUDGET_USD": str(max_budget_usd),
            },
        )
        result = run_owned_process(
            _pilot_command(
                root,
                jobs_dir=jobs_dir,
                job_name=job_name,
                package_dir=package_dir,
            ),
            cwd=root,
            environment=child_env,
            pending_signals=pending_signals,
        )
        result_code = result.returncode
    except BaseException as error:
        primary_error = error
    finally:
        if worker_key:
            try:
                if not _worker_key_is_rejected(health_url, worker_key):
                    _delete_worker_key(health_url, master_key, worker_key)
                manifest_path = jobs_dir / job_name / "run-manifest.json"
                if manifest_path.is_file():
                    manifest = _read_json(manifest_path)
                    if manifest.get("worker_key_revoked") is not True:
                        manifest["worker_key_revocation_owner"] = (
                            "managed-parent-fallback"
                        )
                    manifest["worker_key_revoked"] = True
                    manifest_path.write_text(
                        json.dumps(manifest, indent=2) + "\n",
                        encoding="utf-8",
                    )
            except Exception as error:
                cleanup_errors.append(f"worker-key deletion failed: {error}")
        cleanup_errors.extend(
            _cleanup_managed_gateway(
                root,
                compose=compose,
                compose_environment=teardown_env,
                project_name=project_name,
            )
        )

    if pending_signals and primary_error is None:
        result_code = 128 + pending_signals[-1]
    if primary_error:
        if cleanup_errors:
            print(
                f"Managed gateway cleanup diagnostics: {'; '.join(cleanup_errors)}",
                file=sys.stderr,
            )
        raise primary_error
    if result_code != 0:
        if cleanup_errors:
            print(
                f"Managed gateway cleanup diagnostics: {'; '.join(cleanup_errors)}",
                file=sys.stderr,
            )
        return result_code
    if cleanup_errors:
        raise RuntimeError(
            f"Managed gateway cleanup incomplete: {'; '.join(cleanup_errors)}. "
            f"Inspect resources with label com.docker.compose.project={project_name}"
        )
    return result_code


def _managed_pilot(
    root: Path,
    *,
    jobs_dir: Path,
    job_name: str,
    package_dir: Path | None,
    port: int,
    gateway_bind: str,
    container_url: str,
    max_budget_usd: float,
) -> int:
    with defer_termination_signals() as pending_signals:
        return _managed_pilot_inner(
            root,
            jobs_dir=jobs_dir,
            job_name=job_name,
            package_dir=package_dir,
            port=port,
            gateway_bind=gateway_bind,
            container_url=container_url,
            max_budget_usd=max_budget_usd,
            pending_signals=pending_signals,
        )


def _job_records(jobs_dir: Path) -> list[dict[str, Any]]:
    if not jobs_dir.is_dir():
        return []
    records: list[dict[str, Any]] = []
    for job_dir in jobs_dir.iterdir():
        if not job_dir.is_dir():
            continue
        result_path = job_dir / "result.json"
        manifest_path = job_dir / "run-manifest.json"
        if not result_path.is_file() and not manifest_path.is_file():
            continue
        result = _read_json(result_path)
        manifest = _read_json(manifest_path)
        summary = _read_json(job_dir / "post-run-summary.json")
        raw_stats = result.get("stats")
        stats: dict[str, Any] = raw_stats if isinstance(raw_stats, dict) else {}
        records.append(
            {
                "name": job_dir.name,
                "status": (
                    "incomplete"
                    if manifest.get("status") == "launching" and not result
                    else manifest.get("status") or ("finished" if result else "unknown")
                ),
                "started_at": manifest.get("started_at") or result.get("started_at"),
                "trials": summary.get("trial_count")
                or result.get("n_total_trials")
                or 0,
                "errors": stats.get("n_errored_trials") or 0,
                "score_valid": summary.get("score_valid"),
                "path": str(job_dir.resolve()),
                "modified": job_dir.stat().st_mtime,
            }
        )
    return sorted(records, key=lambda record: float(record["modified"]), reverse=True)


def _resolve_job(jobs_dir: Path, name: str) -> Path:
    validate_job_name(name)
    job_dir = (jobs_dir / name).resolve()
    if job_dir.parent != jobs_dir.resolve() or not (
        (job_dir / "result.json").is_file() or (job_dir / "run-manifest.json").is_file()
    ):
        raise FileNotFoundError(f"Harbor job does not exist: {job_dir}")
    return job_dir


def _job_details(job_dir: Path) -> dict[str, object]:
    return {
        "name": job_dir.name,
        "path": str(job_dir.resolve()),
        "result": _read_json(job_dir / "result.json"),
        "run_manifest": _read_json(job_dir / "run-manifest.json"),
        "summary": _read_json(job_dir / "post-run-summary.json"),
        "analysis": _read_json(job_dir / "analysis/summary.json"),
    }


def _analyze_job(root: Path, job_dir: Path, *, strict: bool) -> int:
    command = [
        sys.executable,
        "-m",
        "benchmarks.harbor.scripts.analyze",
        str(job_dir),
    ]
    manifest = _read_json(job_dir / "run-manifest.json")
    if "upstream_model" in manifest:
        command.extend(
            [
                "--manifest",
                str(
                    root
                    / "benchmarks/harbor/manifests/terminal-bench-2.1-pilot-v1.json"
                ),
            ]
        )
    if strict:
        command.append("--strict")
    result = _run(
        command,
        root=root,
        environment=minimal_child_environment(os.environ, additions={}),
    )
    return result.returncode


def _print_jobs(records: list[dict[str, Any]]) -> None:
    if not records:
        print("No Harbor jobs found")
        return
    columns = ("name", "status", "trials", "errors", "started_at")
    widths = {
        column: max(
            len(column), *(len(str(record.get(column, ""))) for record in records)
        )
        for column in columns
    }
    print("  ".join(column.ljust(widths[column]) for column in columns))
    print("  ".join("-" * widths[column] for column in columns))
    for record in records:
        print(
            "  ".join(
                str(record.get(column, "")).ljust(widths[column]) for column in columns
            )
        )


def _print_doctor(checks: list[dict[str, object]]) -> None:
    for check in checks:
        state = "ok" if check["ok"] else "WARN" if not check["required"] else "FAIL"
        print(f"[{state:4}] {check['name']}: {check['detail']}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="volt-bench", description=__doc__)
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable output for doctor, prepare, and jobs",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    doctor = subparsers.add_parser("doctor", help="Check local benchmark prerequisites")
    doctor.add_argument("--gateway", choices=("managed", "external"), default="managed")
    doctor.add_argument("--volt-package-dir", type=Path)

    prepare = subparsers.add_parser(
        "prepare", help="Build the pinned four-package Volt bundle"
    )
    prepare.add_argument("--output", type=Path)
    prepare.add_argument("--skip-check", action="store_true")

    run = subparsers.add_parser("run", help="Run a benchmark profile")
    run_subparsers = run.add_subparsers(dest="profile", required=True)
    pilot = run_subparsers.add_parser("pilot", help="Run the 25-task x 4-agent pilot")
    pilot.add_argument("--gateway", choices=("managed", "external"), default="managed")
    pilot.add_argument("--job-name")
    pilot.add_argument("--jobs-dir", type=Path)
    pilot.add_argument("--volt-package-dir", type=Path)
    pilot.add_argument("--use-registry", action="store_true")
    pilot.add_argument("--skip-build-check", action="store_true")
    pilot.add_argument("--gateway-port", type=int, default=DEFAULT_GATEWAY_PORT)
    pilot.add_argument("--gateway-bind")
    pilot.add_argument("--container-gateway-url")
    pilot.add_argument("--gateway-network")
    pilot.add_argument("--max-budget-usd", type=float)

    jobs = subparsers.add_parser("jobs", help="List and inspect local jobs")
    jobs_subparsers = jobs.add_subparsers(dest="jobs_command", required=True)
    jobs_list = jobs_subparsers.add_parser("list", help="List local Harbor jobs")
    jobs_list.add_argument("--jobs-dir", type=Path)
    jobs_show = jobs_subparsers.add_parser("show", help="Show one local Harbor job")
    jobs_show.add_argument("job")
    jobs_show.add_argument("--jobs-dir", type=Path)

    analyze = subparsers.add_parser("analyze", help="Analyze one local Harbor job")
    analyze.add_argument("job")
    analyze.add_argument("--jobs-dir", type=Path)
    analyze.add_argument("--strict", action="store_true")

    view = subparsers.add_parser("view", help="Open Harbor's local job viewer")
    view.add_argument("job", nargs="?")
    view.add_argument("--jobs-dir", type=Path)
    view.add_argument("--host", default="127.0.0.1")
    view.add_argument("--port", default="8080-8089")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    root = repository_root()
    try:
        if args.command == "doctor":
            package_dir = _bundle_dir(root, args.volt_package_dir)
            checks = _doctor(root, args.gateway, package_dir)
            if args.json:
                print(json.dumps({"checks": checks}, indent=2))
            else:
                _print_doctor(checks)
            return (
                1 if any(not item["ok"] and item["required"] for item in checks) else 0
            )

        if args.command == "prepare":
            output = (args.output or _default_release_dir(root)).expanduser().resolve()
            prepared = _prepare(
                root,
                output,
                skip_check=args.skip_check,
                capture=args.json,
            )
            if args.json:
                print(json.dumps(prepared, indent=2))
            else:
                print(f"Volt package bundle: {prepared['tarballs']}")
            return 0

        if args.command == "run" and args.profile == "pilot":
            jobs_dir = (args.jobs_dir or _default_jobs_dir(root)).expanduser().resolve()
            job_name = validate_job_name(
                args.job_name
                or datetime.now(timezone.utc).strftime(
                    "volt-fixed-model-pilot-%Y%m%dT%H%M%SZ"
                )
            )
            if args.use_registry and args.volt_package_dir:
                raise RuntimeError(
                    "--use-registry and --volt-package-dir are mutually exclusive"
                )
            package_dir: Path | None = None
            if not args.use_registry:
                package_dir = _bundle_dir(root, args.volt_package_dir)
                try:
                    check_volt_package_bundle(package_dir)
                except (OSError, ValueError) as error:
                    if args.volt_package_dir:
                        raise RuntimeError(
                            f"Explicit Volt package bundle is invalid: {error}"
                        ) from error
                    release_dir = _default_release_dir(root)
                    _prepare(root, release_dir, skip_check=args.skip_build_check)
                    package_dir = release_dir / "tarballs"
            budget = args.max_budget_usd
            if budget is None:
                raw_budget = os.environ.get("PILOT_MAX_BUDGET_USD", "")
                try:
                    budget = float(raw_budget)
                except ValueError as error:
                    raise RuntimeError(
                        "Set --max-budget-usd or PILOT_MAX_BUDGET_USD"
                    ) from error
            if args.gateway == "managed":
                run_exit_code = _managed_pilot(
                    root,
                    jobs_dir=jobs_dir,
                    job_name=job_name,
                    package_dir=package_dir,
                    port=args.gateway_port,
                    gateway_bind=args.gateway_bind or "127.0.0.1",
                    container_url=(
                        args.container_gateway_url
                        or "http://volt-bench-gateway-proxy:4000"
                    ),
                    max_budget_usd=budget,
                )
            else:
                run_exit_code = _external_pilot(
                    root,
                    jobs_dir=jobs_dir,
                    job_name=job_name,
                    package_dir=package_dir,
                    gateway_network=args.gateway_network,
                    max_budget_usd=budget,
                )
            job_dir = jobs_dir / job_name
            analysis_exit_code = (
                _analyze_job(root, job_dir, strict=True)
                if (job_dir / "result.json").is_file()
                else 0
            )
            return run_exit_code or analysis_exit_code

        if args.command == "jobs":
            jobs_dir = (args.jobs_dir or _default_jobs_dir(root)).expanduser().resolve()
            if args.jobs_command == "list":
                records = _job_records(jobs_dir)
                if args.json:
                    print(json.dumps({"jobs": records}, indent=2))
                else:
                    _print_jobs(records)
                return 0
            job_dir = _resolve_job(jobs_dir, args.job)
            details = _job_details(job_dir)
            if args.json:
                print(json.dumps(details, indent=2))
            else:
                manifest = details["run_manifest"]
                summary = details["summary"]
                print(f"Job: {details['name']}")
                print(f"Path: {details['path']}")
                if isinstance(manifest, dict):
                    print(f"Status: {manifest.get('status', 'unknown')}")
                    print(
                        f"Model: {manifest.get('upstream_model') or manifest.get('model') or 'unknown'}"
                    )
                if isinstance(summary, dict):
                    print(f"Trials: {summary.get('trial_count', 'unknown')}")
                    print(f"Score valid: {summary.get('score_valid', 'unknown')}")
                    print(f"Warnings: {len(summary.get('warnings') or [])}")
                print(f"Analyze: volt-bench analyze {details['name']} --strict")
                print(f"View: volt-bench view {details['name']}")
            return 0

        if args.command == "analyze":
            jobs_dir = (args.jobs_dir or _default_jobs_dir(root)).expanduser().resolve()
            job_dir = _resolve_job(jobs_dir, args.job)
            return _analyze_job(root, job_dir, strict=args.strict)

        if args.command == "view":
            jobs_dir = (args.jobs_dir or _default_jobs_dir(root)).expanduser().resolve()
            folder = _resolve_job(jobs_dir, args.job) if args.job else jobs_dir
            result = _run(
                [
                    "harbor",
                    "view",
                    str(folder),
                    "--jobs",
                    "--host",
                    args.host,
                    "--port",
                    args.port,
                ],
                root=root,
                environment=minimal_child_environment(os.environ, additions={}),
            )
            return result.returncode
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        if args.json:
            print(json.dumps({"error": str(error)}))
        else:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    parser.error("Unsupported command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
