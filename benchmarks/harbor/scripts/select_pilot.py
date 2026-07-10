"""Build the deterministic Terminal-Bench 2.1 pilot manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import tomllib
from collections import Counter
from fractions import Fraction
from pathlib import Path
from typing import TypedDict

DATASET = "terminal-bench/terminal-bench-2-1"
DATASET_REF = "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"
SEED = "volt-tbench-2.1-pilot-v1"
SAMPLE_SIZE = 25
ALGORITHM = "hamilton-category-difficulty-sha256-v1"


class TaskMetadata(TypedDict):
    id: str
    name: str
    category: str
    difficulty: str


def load_tasks(dataset_dir: Path) -> list[TaskMetadata]:
    tasks: list[TaskMetadata] = []
    for task_path in sorted(dataset_dir.glob("*/task.toml")):
        config = tomllib.loads(task_path.read_text(encoding="utf-8"))
        task = config.get("task", {})
        metadata = config.get("metadata", {})
        task_id = task.get("name")
        category = metadata.get("category")
        difficulty = metadata.get("difficulty")
        if not all(
            isinstance(value, str) and value
            for value in (task_id, category, difficulty)
        ):
            raise ValueError(f"Incomplete selection metadata in {task_path}")
        tasks.append(
            {
                "id": task_id,
                "name": task_path.parent.name,
                "category": category,
                "difficulty": difficulty,
            }
        )
    if not tasks:
        raise ValueError(f"No task.toml files found under {dataset_dir}")
    return tasks


def allocate_hamilton(
    counts: Counter[tuple[str, str]], sample_size: int
) -> dict[tuple[str, str], int]:
    if sample_size <= 0 or sample_size > counts.total():
        raise ValueError("sample size must be between 1 and the population size")
    total = counts.total()
    exact = {key: Fraction(sample_size * count, total) for key, count in counts.items()}
    quotas = {key: int(value) for key, value in exact.items()}
    remaining = sample_size - sum(quotas.values())
    order = sorted(counts, key=lambda key: (-(exact[key] - quotas[key]), key))
    for key in order[:remaining]:
        quotas[key] += 1
    return {key: value for key, value in quotas.items() if value}


def selection_hash(task_name: str) -> str:
    return hashlib.sha256(f"{SEED}\0{task_name}".encode()).hexdigest()


def select_tasks(
    tasks: list[TaskMetadata], sample_size: int = SAMPLE_SIZE
) -> tuple[list[TaskMetadata], dict[tuple[str, str], int]]:
    counts = Counter((task["category"], task["difficulty"]) for task in tasks)
    quotas = allocate_hamilton(counts, sample_size)
    selected: list[TaskMetadata] = []
    for stratum, quota in quotas.items():
        candidates = [
            task for task in tasks if (task["category"], task["difficulty"]) == stratum
        ]
        candidates.sort(key=lambda task: (selection_hash(task["name"]), task["name"]))
        selected.extend(candidates[:quota])
    selected.sort(key=lambda task: task["name"])
    return selected, quotas


def build_manifest(tasks: list[TaskMetadata]) -> dict[str, object]:
    selected, quotas = select_tasks(tasks)
    ids = [task["id"] for task in selected]
    task_set_sha256 = hashlib.sha256(("\n".join(ids) + "\n").encode()).hexdigest()
    category_counts = Counter(task["category"] for task in selected)
    difficulty_counts = Counter(task["difficulty"] for task in selected)
    return {
        "schema_version": 1,
        "dataset": DATASET,
        "dataset_ref": DATASET_REF,
        "population_size": len(tasks),
        "sample_size": len(selected),
        "seed": SEED,
        "algorithm": ALGORITHM,
        "task_set_sha256": task_set_sha256,
        "stratum_quotas": {
            f"{category}:{difficulty}": quota
            for (category, difficulty), quota in sorted(quotas.items())
        },
        "category_counts": dict(sorted(category_counts.items())),
        "difficulty_counts": dict(sorted(difficulty_counts.items())),
        "tasks": [
            {
                **task,
                "selection_hash": selection_hash(task["name"]),
            }
            for task in selected
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset_dir", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", type=Path)
    args = parser.parse_args()

    manifest = build_manifest(load_tasks(args.dataset_dir))
    rendered = json.dumps(manifest, indent=2, sort_keys=False) + "\n"
    if args.check:
        if (
            not args.check.exists()
            or args.check.read_text(encoding="utf-8") != rendered
        ):
            print(f"Manifest differs from deterministic selection: {args.check}")
            return 1
        print(f"Manifest is reproducible: {args.check}")
        return 0
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
