"""Validate that the checked-in pilot config matches its precommitted protocol."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
from collections import Counter
from pathlib import Path
from typing import Any

import yaml
from harbor.models.job.config import JobConfig

EXPECTED_HARBOR_VERSION = "0.13.2"
EXPECTED_MODEL = "openai/pilot-model"
EXPECTED_AGENTS = {
    "benchmarks.harbor.agents.volt:VoltAgent": "0.79.6",
    "benchmarks.harbor.agents.run_only_secrets:RunOnlySecretClaudeCode": "2.1.206",
    "benchmarks.harbor.agents.run_only_secrets:RunOnlySecretCodex": "0.144.1",
    "benchmarks.harbor.agents.run_only_secrets:RunOnlySecretOpenCode": "1.17.18",
}
EXPECTED_UPSTREAM_MODEL = "anthropic/claude-sonnet-4-5-20250929"


def _load_yaml(path: Path) -> dict[str, Any]:
    value = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a YAML object in {path}")
    return value


def validate_protocol(
    config_path: Path,
    manifest_path: Path,
    gateway_path: Path,
    *,
    check_runtime_version: bool = True,
) -> list[str]:
    errors: list[str] = []
    config = _load_yaml(config_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    gateway = _load_yaml(gateway_path)

    try:
        JobConfig.model_validate(config)
    except Exception as error:
        errors.append(f"Harbor JobConfig rejected pilot.yaml: {error}")

    if check_runtime_version:
        harbor_version = importlib.metadata.version("harbor")
        if harbor_version != EXPECTED_HARBOR_VERSION:
            errors.append(
                f"Harbor version is {harbor_version}; expected {EXPECTED_HARBOR_VERSION}"
            )

    if config.get("n_attempts") != 1:
        errors.append("Pilot must use exactly one attempt per agent/task")
    environment = config.get("environment")
    if (
        not isinstance(environment, dict)
        or environment.get("type") != "docker"
        or environment.get("delete") is not True
        or environment.get("extra_docker_compose")
        != ["benchmarks/harbor/gateway/harbor-gateway-network.yaml"]
    ):
        errors.append(
            "Pilot must delete Docker environments and attach the gateway network"
        )
    retry = config.get("retry")
    if not isinstance(retry, dict) or retry.get("max_retries") != 0:
        errors.append("Pilot must disable Harbor-level retries")

    agents = config.get("agents")
    if not isinstance(agents, list) or len(agents) != 4:
        errors.append("Pilot must contain exactly four agents")
        agents = []

    actual_agents: dict[str, str | None] = {}
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
        version = kwargs.get("version") if isinstance(kwargs, dict) else None
        if isinstance(identity, str):
            actual_agents[identity] = str(version) if version is not None else None
        if agent.get("model_name") != EXPECTED_MODEL:
            errors.append(f"{identity} does not use {EXPECTED_MODEL}")

    if actual_agents != EXPECTED_AGENTS:
        errors.append(f"Agent/version matrix differs: {actual_agents}")

    for identity in (
        "benchmarks.harbor.agents.volt:VoltAgent",
        "benchmarks.harbor.agents.run_only_secrets:RunOnlySecretClaudeCode",
        "benchmarks.harbor.agents.run_only_secrets:RunOnlySecretCodex",
    ):
        agent = next(
            (
                item
                for item in agents
                if isinstance(item, dict)
                and (item.get("import_path") or item.get("name")) == identity
            ),
            {},
        )
        kwargs = agent.get("kwargs") if isinstance(agent, dict) else {}
        if not isinstance(kwargs, dict) or kwargs.get("reasoning_effort") != "high":
            errors.append(f"{identity} must use high reasoning effort")

    opencode = next(
        (
            item
            for item in agents
            if isinstance(item, dict)
            and item.get("import_path")
            == "benchmarks.harbor.agents.run_only_secrets:RunOnlySecretOpenCode"
        ),
        {},
    )
    opencode_effort = (
        opencode.get("kwargs", {})
        .get("opencode_config", {})
        .get("provider", {})
        .get("openai", {})
        .get("models", {})
        .get("pilot-model", {})
        .get("options", {})
        .get("reasoningEffort")
        if isinstance(opencode, dict)
        else None
    )
    if opencode_effort != "high":
        errors.append("opencode must use high reasoning effort")

    datasets = config.get("datasets")
    dataset = datasets[0] if isinstance(datasets, list) and len(datasets) == 1 else {}
    if not isinstance(dataset, dict):
        dataset = {}
    if dataset.get("name") != manifest.get("dataset"):
        errors.append("Dataset name differs from manifest")
    if dataset.get("ref") != manifest.get("dataset_ref"):
        errors.append("Dataset digest differs from manifest")
    manifest_tasks = [
        task.get("id") for task in manifest.get("tasks", []) if isinstance(task, dict)
    ]
    if dataset.get("task_names") != manifest_tasks:
        errors.append("Pilot task list or order differs from manifest")
    if len(manifest_tasks) != 25 or len(set(manifest_tasks)) != 25:
        errors.append("Manifest must contain 25 unique tasks")

    routes = gateway.get("model_list")
    route_map: dict[str, str | None] = {}
    retry_map: dict[str, object] = {}
    route_identities: list[str] = []
    credential_sources: dict[str, object] = {}
    if isinstance(routes, list):
        for route in routes:
            if not isinstance(route, dict) or not isinstance(
                route.get("model_name"), str
            ):
                continue
            params = route.get("litellm_params")
            params = params if isinstance(params, dict) else {}
            route_identities.append(route["model_name"])
            route_map[route["model_name"]] = params.get("model")
            retry_map[route["model_name"]] = params.get("num_retries")
            credential_sources[route["model_name"]] = params.get("api_key")
    expected_routes = {
        "pilot-model": EXPECTED_UPSTREAM_MODEL,
        "openai/pilot-model": EXPECTED_UPSTREAM_MODEL,
    }
    expected_counts = {"pilot-model": 1, "openai/pilot-model": 1}
    if dict(Counter(route_identities)) != expected_counts:
        errors.append(f"Gateway must have one deployment per alias: {route_identities}")
    if route_map != expected_routes:
        errors.append(f"Gateway routes differ: {route_map}")
    if retry_map != {"pilot-model": 0, "openai/pilot-model": 0}:
        errors.append("Gateway model routes must disable retries")
    if credential_sources != {
        "pilot-model": "os.environ/UPSTREAM_ANTHROPIC_API_KEY",
        "openai/pilot-model": "os.environ/UPSTREAM_ANTHROPIC_API_KEY",
    }:
        errors.append("Gateway routes must use only the pinned upstream credential")
    router_settings = gateway.get("router_settings")
    if not isinstance(router_settings, dict) or router_settings.get("num_retries") != 0:
        errors.append("Gateway router must disable retries")

    general_settings = gateway.get("general_settings")
    if (
        not isinstance(general_settings, dict)
        or general_settings.get("master_key") != "os.environ/PILOT_GATEWAY_MASTER_KEY"
    ):
        errors.append("Gateway master key must be separate from agent worker keys")
    if (
        not isinstance(general_settings, dict)
        or general_settings.get("database_url") != "os.environ/DATABASE_URL"
    ):
        errors.append("Gateway must use a database for scoped worker keys")

    return errors


def main() -> int:
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
        "--gateway",
        type=Path,
        default=root / "benchmarks/harbor/gateway/litellm.yaml",
    )
    args = parser.parse_args()

    errors = validate_protocol(args.config, args.manifest, args.gateway)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print("Pilot protocol is valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
