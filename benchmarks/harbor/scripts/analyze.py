"""Summarize Harbor trial results with success, efficiency, and parity checks."""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from statistics import mean
from typing import Any, Iterable

from harbor.models.trajectories import Trajectory


@dataclass(frozen=True)
class Trial:
    data: dict[str, Any]
    directory: Path | None


VERIFIER_INFRA_PATTERNS = (
    (
        "dns_resolution",
        re.compile(
            r"could not resolve host|temporary failure resolving|temporary failure in name resolution|failed to lookup address information|name or service not known",
            re.IGNORECASE,
        ),
    ),
    (
        "uv_bootstrap",
        re.compile(
            r"uvx: command not found|\.local/bin/env: no such file",
            re.IGNORECASE,
        ),
    ),
    (
        "network_connection",
        re.compile(
            r"could not connect to server|failed to connect|connection timed out|connection refused|network is unreachable",
            re.IGNORECASE,
        ),
    ),
)


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_trials(paths: Iterable[Path]) -> list[Trial]:
    trials: list[Trial] = []
    seen: dict[str, str] = {}
    for path in paths:
        candidate = path.resolve()
        values: list[tuple[dict[str, Any], Path | None, str]]
        if candidate.is_file():
            payload = _read_json(candidate)
            if isinstance(payload, dict) and "task_name" in payload:
                values = [(payload, candidate.parent, str(candidate))]
            elif isinstance(payload, dict) and isinstance(
                payload.get("trial_results"), list
            ):
                values = [
                    (item, None, f"{candidate}#{index}")
                    for index, item in enumerate(payload["trial_results"])
                    if isinstance(item, dict)
                ]
            else:
                values = [
                    (_read_json(result_path), result_path.parent, str(result_path))
                    for result_path in sorted(candidate.parent.glob("*/result.json"))
                ]
        elif candidate.is_dir():
            values = [
                (_read_json(result_path), result_path.parent, str(result_path))
                for result_path in sorted(candidate.glob("*/result.json"))
            ]
        else:
            raise FileNotFoundError(candidate)

        for payload, directory, source in values:
            if "task_name" not in payload:
                continue
            identity_value = (
                payload.get("id")
                or payload.get("trial_uri")
                or payload.get("trial_name")
            )
            if not isinstance(identity_value, str) or not identity_value:
                raise ValueError(f"Harbor trial has no stable identity: {source}")
            previous_source = seen.get(identity_value)
            if previous_source == source:
                continue
            if previous_source is not None:
                raise ValueError(
                    f"Duplicate Harbor trial identity {identity_value!r}: "
                    f"{previous_source} and {source}"
                )
            seen[identity_value] = source
            trials.append(Trial(payload, directory))
    if not trials:
        raise ValueError("No Harbor trial result files found")
    return trials


def _agent_name(trial: Trial) -> str:
    info = trial.data.get("agent_info")
    if isinstance(info, dict) and isinstance(info.get("name"), str):
        return info["name"]
    return "unknown"


def _task_name(trial: Trial) -> str:
    value = trial.data.get("task_name")
    if not isinstance(value, str):
        return "unknown"
    return value.split("/", 1)[-1]


def _reward(trial: Trial, reward_key: str) -> float | None:
    verifier = trial.data.get("verifier_result")
    rewards = verifier.get("rewards") if isinstance(verifier, dict) else None
    if not isinstance(rewards, dict):
        return None
    value = rewards.get(reward_key)
    if value is None and len(rewards) == 1:
        value = next(iter(rewards.values()))
    return float(value) if isinstance(value, (int, float)) else None


def _contexts(trial: Trial) -> list[dict[str, Any]]:
    result = trial.data.get("agent_result")
    if isinstance(result, dict):
        return [result]
    step_results = trial.data.get("step_results")
    if not isinstance(step_results, list):
        return []
    return [
        result
        for step in step_results
        if isinstance(step, dict)
        and isinstance((result := step.get("agent_result")), dict)
    ]


def _sum_optional(contexts: list[dict[str, Any]], field: str) -> int | float | None:
    values = [context.get(field) for context in contexts]
    numeric = [value for value in values if isinstance(value, (int, float))]
    if not numeric:
        return None
    return sum(numeric)


def _metadata_totals(contexts: list[dict[str, Any]]) -> dict[str, int]:
    result: dict[str, int] = defaultdict(int)
    fields = (
        "tool_calls",
        "tool_errors",
        "compactions",
        "auto_retries",
        "agent_runs",
        "cache_write_tokens",
        "invalid_json_lines",
        "assistant_messages",
        "usage_messages",
    )
    for context in contexts:
        metadata = context.get("metadata")
        if not isinstance(metadata, dict):
            continue
        for field in fields:
            value = metadata.get(field)
            if isinstance(value, int):
                result[field] += value
    return dict(result)


def _all_settled(contexts: list[dict[str, Any]]) -> bool | None:
    values: list[bool] = []
    for context in contexts:
        metadata = context.get("metadata")
        if isinstance(metadata, dict) and isinstance(metadata.get("settled"), bool):
            values.append(metadata["settled"])
    return all(values) if values else None


def _verifier_infra_error(trial: Trial) -> str | None:
    if trial.directory is None:
        return None
    ctrf_path = trial.directory / "verifier/ctrf.json"
    if ctrf_path.is_file():
        try:
            ctrf = _read_json(ctrf_path)
        except (OSError, json.JSONDecodeError):
            ctrf = None
        results = ctrf.get("results") if isinstance(ctrf, dict) else None
        tests = results.get("tests") if isinstance(results, dict) else None
        if (
            isinstance(tests, list)
            and tests
            and all(
                isinstance(test, dict)
                and isinstance(test.get("name"), str)
                and isinstance(test.get("status"), str)
                for test in tests
            )
        ):
            return None

    output_path = trial.directory / "verifier/test-stdout.txt"
    if output_path.is_file():
        output = output_path.read_text(encoding="utf-8", errors="replace")
        for label, pattern in VERIFIER_INFRA_PATTERNS:
            if pattern.search(output):
                return label
    return "missing_or_invalid_ctrf"


def _trajectory_valid(path: Path | None) -> bool | None:
    if path is None or not path.is_file():
        return None
    try:
        trajectory = Trajectory.model_validate(_read_json(path))
    except (OSError, ValueError):
        return False
    return any(step.source == "agent" for step in trajectory.steps)


def _duration_seconds(timing: object) -> float | None:
    if not isinstance(timing, dict):
        return None
    started = timing.get("started_at")
    finished = timing.get("finished_at")
    if not isinstance(started, str) or not isinstance(finished, str):
        return None
    try:
        return (
            datetime.fromisoformat(finished.replace("Z", "+00:00"))
            - datetime.fromisoformat(started.replace("Z", "+00:00"))
        ).total_seconds()
    except ValueError:
        return None


def _wilson(successes: int, total: int) -> list[float] | None:
    if total == 0:
        return None
    z = 1.959963984540054
    proportion = successes / total
    denominator = 1 + z * z / total
    center = (proportion + z * z / (2 * total)) / denominator
    margin = (
        z
        * math.sqrt(proportion * (1 - proportion) / total + z * z / (4 * total * total))
        / denominator
    )
    return [max(0.0, center - margin), min(1.0, center + margin)]


def _trial_record(trial: Trial, reward_key: str, threshold: float) -> dict[str, Any]:
    contexts = _contexts(trial)
    reward = _reward(trial, reward_key)
    exception = trial.data.get("exception_info")
    exception_type = (
        exception.get("exception_type") if isinstance(exception, dict) else None
    )
    input_tokens = _sum_optional(contexts, "n_input_tokens")
    cache_tokens = _sum_optional(contexts, "n_cache_tokens")
    output_tokens = _sum_optional(contexts, "n_output_tokens")
    cost = _sum_optional(contexts, "cost_usd")
    metadata = _metadata_totals(contexts)
    metadata_objects = [
        context["metadata"]
        for context in contexts
        if isinstance(context.get("metadata"), dict)
    ]
    protocol_versions = sorted(
        {
            value
            for item in metadata_objects
            if isinstance((value := item.get("json_protocol_version")), int)
        }
    )
    error_stop_reasons = sorted(
        {
            str(reason)
            for item in metadata_objects
            if isinstance(item.get("error_stop_reasons"), list)
            for reason in item["error_stop_reasons"]
        }
    )
    trajectory = trial.directory / "agent/trajectory.json" if trial.directory else None
    info = trial.data.get("agent_info")
    info = info if isinstance(info, dict) else {}
    model_info = info.get("model_info")
    model_info = model_info if isinstance(model_info, dict) else {}
    verifier_infra_error = _verifier_infra_error(trial)
    return {
        "trial_name": trial.data.get("trial_name"),
        "task": _task_name(trial),
        "agent": _agent_name(trial),
        "agent_version": info.get("version"),
        "model": model_info.get("name"),
        "model_provider": model_info.get("provider"),
        "reward": reward,
        "solved": exception_type is None
        and verifier_infra_error is None
        and reward is not None
        and reward > threshold,
        "exception": exception_type,
        "verifier_infra_error": verifier_infra_error,
        "input_tokens": input_tokens,
        "cache_tokens": cache_tokens,
        "output_tokens": output_tokens,
        "reported_cost_usd": cost,
        "agent_seconds": _duration_seconds(trial.data.get("agent_execution")),
        "wall_seconds": _duration_seconds(
            {
                "started_at": trial.data.get("started_at"),
                "finished_at": trial.data.get("finished_at"),
            }
        ),
        "trajectory_present": trajectory.is_file() if trajectory else None,
        "trajectory_valid": _trajectory_valid(trajectory),
        "settled": _all_settled(contexts),
        "json_protocol_versions": protocol_versions,
        "error_stop_reasons": error_stop_reasons,
        **metadata,
    }


def _sum_records(records: list[dict[str, Any]], field: str) -> int | float:
    return sum(
        value
        for record in records
        if isinstance((value := record.get(field)), (int, float))
    )


def _coverage(records: list[dict[str, Any]], field: str) -> int:
    return sum(isinstance(record.get(field), (int, float)) for record in records)


def summarize(
    trials: list[Trial],
    *,
    reward_key: str = "reward",
    solved_threshold: float = 0.0,
    expected_tasks: list[str] | None = None,
) -> dict[str, Any]:
    records = [_trial_record(trial, reward_key, solved_threshold) for trial in trials]
    infra_invalid_tasks = sorted(
        {str(record["task"]) for record in records if record["verifier_infra_error"]}
    )
    score_valid = not infra_invalid_tasks
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        grouped[str(record["agent"])].append(record)

    agents: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    for agent, agent_records in sorted(grouped.items()):
        total = len(agent_records)
        solved = sum(bool(record["solved"]) for record in agent_records)
        scored = [
            record["reward"] for record in agent_records if record["reward"] is not None
        ]
        cost_coverage = _coverage(agent_records, "reported_cost_usd")
        token_coverage = sum(
            record.get("input_tokens") is not None
            and record.get("output_tokens") is not None
            for record in agent_records
        )
        total_cost = _sum_records(agent_records, "reported_cost_usd")
        total_tokens = _sum_records(agent_records, "input_tokens") + _sum_records(
            agent_records, "output_tokens"
        )
        versions = sorted(
            {
                str(record["agent_version"])
                for record in agent_records
                if record["agent_version"]
            }
        )
        models = sorted(
            {
                f"{record['model_provider']}/{record['model']}"
                if record.get("model_provider")
                else str(record["model"])
                for record in agent_records
                if record.get("model")
            }
        )
        task_counts = Counter(str(record["task"]) for record in agent_records)
        duplicate_tasks = sorted(
            task for task, count in task_counts.items() if count > 1
        )
        if duplicate_tasks:
            warnings.append(f"{agent} has duplicate task attempts: {duplicate_tasks}")
        if expected_tasks is not None:
            missing = sorted(set(expected_tasks) - set(task_counts))
            extra = sorted(set(task_counts) - set(expected_tasks))
            if missing or extra:
                warnings.append(
                    f"{agent} task mismatch; missing={missing}, extra={extra}"
                )
        verifier_infra_failures = {
            str(record["task"]): str(record["verifier_infra_error"])
            for record in agent_records
            if record["verifier_infra_error"]
        }
        if verifier_infra_failures:
            warnings.append(
                f"{agent} has verifier infrastructure failures: "
                f"{verifier_infra_failures}"
            )
        exception_count = sum(bool(record["exception"]) for record in agent_records)
        if exception_count:
            warnings.append(f"{agent} has {exception_count} trial exceptions")
        if len(scored) != total:
            warnings.append(f"{agent} has {total - len(scored)} trials without rewards")
        trajectory_coverage = sum(
            record["trajectory_present"] is True for record in agent_records
        )
        settled_trials = sum(record["settled"] is True for record in agent_records)
        if agent == "volt" and trajectory_coverage != total:
            warnings.append(
                f"volt is missing trajectories for {total - trajectory_coverage} trials"
            )
        invalid_trajectories = sum(
            record["trajectory_valid"] is not True for record in agent_records
        )
        if agent == "volt" and invalid_trajectories:
            warnings.append(f"volt has {invalid_trajectories} invalid trajectories")
        if agent == "volt" and settled_trials != total:
            warnings.append(f"volt has {total - settled_trials} unsettled trials")
        if agent == "volt":
            invalid_lines = _sum_records(agent_records, "invalid_json_lines")
            if invalid_lines:
                warnings.append(f"volt has {invalid_lines} invalid JSON event lines")
            empty_assistant_trials = sum(
                not isinstance(record.get("assistant_messages"), int)
                or record["assistant_messages"] <= 0
                for record in agent_records
            )
            if empty_assistant_trials:
                warnings.append(
                    f"volt has {empty_assistant_trials} trials without assistant events"
                )
            invalid_protocol_trials = sum(
                record["json_protocol_versions"] != [3] for record in agent_records
            )
            if invalid_protocol_trials:
                warnings.append(
                    f"volt has {invalid_protocol_trials} trials without JSON protocol v3"
                )
            terminal_error_trials = sum(
                bool(record["error_stop_reasons"]) for record in agent_records
            )
            if terminal_error_trials:
                warnings.append(
                    f"volt has {terminal_error_trials} terminal error/aborted trials"
                )
        agents[agent] = {
            "score_valid": score_valid,
            "trials": total,
            "scored_trials": len(scored) if score_valid else 0,
            "solved": solved if score_valid else None,
            "pass_rate": solved / total if total and score_valid else None,
            "pass_rate_wilson_95": _wilson(solved, total) if score_valid else None,
            "mean_reward": mean(scored) if scored and score_valid else None,
            "raw_solved": solved,
            "raw_mean_reward": mean(scored) if scored else None,
            "exceptions": dict(
                sorted(
                    Counter(
                        str(record["exception"])
                        for record in agent_records
                        if record["exception"]
                    ).items()
                )
            ),
            "verifier_infra_failures": verifier_infra_failures,
            "versions": versions,
            "models": models,
            "reported_cost_coverage_trials": cost_coverage,
            "reported_cost_usd": total_cost if cost_coverage else None,
            "reported_cost_per_solved_usd": (
                total_cost / solved
                if score_valid and solved and cost_coverage == total
                else None
            ),
            "token_coverage_trials": token_coverage,
            "input_tokens": _sum_records(agent_records, "input_tokens")
            if token_coverage
            else None,
            "cache_tokens": _sum_records(agent_records, "cache_tokens")
            if token_coverage
            else None,
            "output_tokens": _sum_records(agent_records, "output_tokens")
            if token_coverage
            else None,
            "tokens_per_solved": total_tokens / solved
            if score_valid and solved and token_coverage == total
            else None,
            "agent_seconds": _sum_records(agent_records, "agent_seconds"),
            "mean_agent_seconds": (
                mean(
                    float(record["agent_seconds"])
                    for record in agent_records
                    if record["agent_seconds"] is not None
                )
                if _coverage(agent_records, "agent_seconds")
                else None
            ),
            "tool_calls": _sum_records(agent_records, "tool_calls"),
            "tool_errors": _sum_records(agent_records, "tool_errors"),
            "compactions": _sum_records(agent_records, "compactions"),
            "native_retries": _sum_records(agent_records, "auto_retries"),
            "trajectory_coverage_trials": trajectory_coverage,
            "settled_trials": settled_trials,
        }

    agent_names = sorted(grouped)
    comparisons: dict[str, dict[str, int | float]] = {}
    for index, left in enumerate(agent_names):
        for right in agent_names[index + 1 :]:
            left_by_task = {str(record["task"]): record for record in grouped[left]}
            right_by_task = {str(record["task"]): record for record in grouped[right]}
            all_common = sorted(set(left_by_task) & set(right_by_task))
            excluded_infra = [
                task
                for task in all_common
                if left_by_task[task]["verifier_infra_error"]
                or right_by_task[task]["verifier_infra_error"]
            ]
            common = [task for task in all_common if task not in excluded_infra]
            both = sum(
                bool(left_by_task[task]["solved"])
                and bool(right_by_task[task]["solved"])
                for task in common
            )
            left_only = sum(
                bool(left_by_task[task]["solved"])
                and not bool(right_by_task[task]["solved"])
                for task in common
            )
            right_only = sum(
                not bool(left_by_task[task]["solved"])
                and bool(right_by_task[task]["solved"])
                for task in common
            )
            comparisons[f"{left} vs {right}"] = {
                "score_valid": score_valid,
                "paired_tasks": len(common),
                "excluded_verifier_infra_tasks": len(excluded_infra),
                "both_solved": both,
                "left_only_solved": left_only,
                "right_only_solved": right_only,
                "neither_solved": len(common) - both - left_only - right_only,
                "paired_pass_rate_delta": (left_only - right_only) / len(common)
                if common
                else 0.0,
            }

    task_sets = {
        agent: set(str(record["task"]) for record in values)
        for agent, values in grouped.items()
    }
    if task_sets and len({frozenset(tasks) for tasks in task_sets.values()}) != 1:
        warnings.append("Agents do not share an identical task set")

    return {
        "schema_version": 1,
        "reward_key": reward_key,
        "solved_threshold": solved_threshold,
        "trial_count": len(records),
        "agent_count": len(grouped),
        "score_valid": score_valid,
        "verifier_infra_invalid_tasks": infra_invalid_tasks,
        "warnings": warnings,
        "agents": agents,
        "paired_comparisons": comparisons,
        "trials": sorted(
            records, key=lambda record: (str(record["agent"]), str(record["task"]))
        ),
    }


def render_markdown(summary: dict[str, Any]) -> str:
    lines = [
        "# Harbor pilot summary",
        "",
        f"Trials: {summary['trial_count']}  ",
        f"Agents: {summary['agent_count']}",
        "",
        "| Agent | Solved | Pass rate (95% Wilson CI) | Reported cost | Cost/solve | Mean agent time | Trajectories |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for agent, stats in summary["agents"].items():
        interval = stats["pass_rate_wilson_95"]
        ci = (
            f"{stats['pass_rate']:.1%} ({interval[0]:.1%}–{interval[1]:.1%})"
            if interval
            else "invalid"
            if not stats["score_valid"]
            else "n/a"
        )
        cost = stats["reported_cost_usd"]
        cost_per_solved = stats["reported_cost_per_solved_usd"]
        mean_seconds = stats["mean_agent_seconds"]
        solved_display = (
            f"{stats['solved']}/{stats['trials']}"
            if stats["score_valid"]
            else "invalid"
        )
        lines.append(
            f"| {agent} | {solved_display} | {ci} | "
            f"{f'${cost:.2f}' if cost is not None else 'n/a'} | "
            f"{f'${cost_per_solved:.2f}' if cost_per_solved is not None else 'n/a'} | "
            f"{f'{mean_seconds:.1f}s' if mean_seconds is not None else 'n/a'} | "
            f"{stats['trajectory_coverage_trials']}/{stats['trials']} |"
        )

    lines.extend(["", "## Paired outcomes", ""])
    for pair, values in summary["paired_comparisons"].items():
        validity = "valid" if values["score_valid"] else "invalid run; diagnostic only"
        lines.append(
            f"- **{pair}:** {validity}; "
            f"{values['paired_tasks']} infrastructure-clean tasks "
            f"({values['excluded_verifier_infra_tasks']} verifier-infra exclusions); "
            f"left-only {values['left_only_solved']}, right-only {values['right_only_solved']}, "
            f"both {values['both_solved']}, neither {values['neither_solved']}"
        )
    if summary["warnings"]:
        lines.extend(["", "## Protocol warnings", ""])
        lines.extend(f"- {warning}" for warning in summary["warnings"])
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "paths",
        nargs="+",
        type=Path,
        help="Harbor job directories or result.json files",
    )
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--reward-key", default="reward")
    parser.add_argument("--solved-threshold", type=float, default=0.0)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    expected_tasks = None
    if args.manifest:
        manifest = _read_json(args.manifest)
        expected_tasks = [
            task["name"]
            for task in manifest.get("tasks", [])
            if isinstance(task, dict) and isinstance(task.get("name"), str)
        ]
    summary = summarize(
        load_trials(args.paths),
        reward_key=args.reward_key,
        solved_threshold=args.solved_threshold,
        expected_tasks=expected_tasks,
    )
    output_dir = (
        args.output_dir
        or (args.paths[0] if args.paths[0].is_dir() else args.paths[0].parent)
        / "analysis"
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    (output_dir / "summary.md").write_text(render_markdown(summary), encoding="utf-8")
    print(f"Analysis written to {output_dir}")
    return 1 if args.strict and summary["warnings"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
