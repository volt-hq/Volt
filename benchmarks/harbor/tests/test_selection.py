from __future__ import annotations

import hashlib
import json
import unittest
from collections import Counter
from pathlib import Path

from benchmarks.harbor.scripts.select_pilot import (
    ALGORITHM,
    DATASET_REF,
    SAMPLE_SIZE,
    allocate_hamilton,
)


class SelectionTests(unittest.TestCase):
    def test_hamilton_allocation_is_deterministic(self) -> None:
        counts = Counter({("a", "medium"): 7, ("b", "hard"): 2, ("c", "easy"): 1})
        self.assertEqual(
            allocate_hamilton(counts, 5),
            {("a", "medium"): 4, ("b", "hard"): 1},
        )

    def test_checked_manifest_is_complete_and_self_consistent(self) -> None:
        root = Path(__file__).resolve().parents[3]
        path = root / "benchmarks/harbor/manifests/terminal-bench-2.1-pilot-v1.json"
        manifest = json.loads(path.read_text(encoding="utf-8"))
        tasks = manifest["tasks"]
        ids = [task["id"] for task in tasks]

        self.assertEqual(manifest["algorithm"], ALGORITHM)
        self.assertEqual(manifest["dataset_ref"], DATASET_REF)
        self.assertEqual(manifest["sample_size"], SAMPLE_SIZE)
        self.assertEqual(len(tasks), SAMPLE_SIZE)
        self.assertEqual(len(set(ids)), SAMPLE_SIZE)
        self.assertEqual(
            manifest["task_set_sha256"],
            hashlib.sha256(("\n".join(ids) + "\n").encode()).hexdigest(),
        )
        self.assertEqual(sum(manifest["stratum_quotas"].values()), SAMPLE_SIZE)
        self.assertEqual(sum(manifest["difficulty_counts"].values()), SAMPLE_SIZE)


if __name__ == "__main__":
    unittest.main()
