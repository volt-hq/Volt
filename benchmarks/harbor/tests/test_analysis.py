from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from benchmarks.harbor.scripts.analyze import load_trials, render_markdown, summarize


def make_trial(
    job_dir: Path,
    *,
    identity: int,
    agent: str,
    task: str,
    reward: float,
    cost: float,
    verifier_output: str | None = None,
) -> None:
    trial_dir = job_dir / f"{task}-{agent}"
    (trial_dir / "agent").mkdir(parents=True)
    (trial_dir / "agent/trajectory.json").write_text(
        json.dumps(
            {
                "schema_version": "ATIF-v1.7",
                "session_id": str(identity),
                "agent": {"name": agent, "version": "1.0.0"},
                "steps": [
                    {"step_id": 1, "source": "user", "message": "task"},
                    {"step_id": 2, "source": "agent", "message": "done"},
                ],
            }
        ),
        encoding="utf-8",
    )
    payload = {
        "id": str(identity),
        "task_name": f"terminal-bench/{task}",
        "trial_name": f"{task}__{agent}",
        "agent_info": {
            "name": agent,
            "version": "1.0.0",
            "model_info": {"provider": "openai", "name": "pilot-model"},
        },
        "agent_result": {
            "n_input_tokens": 100,
            "n_cache_tokens": 25,
            "n_output_tokens": 10,
            "cost_usd": cost,
            "metadata": {
                "tool_calls": 2,
                "settled": True,
                "assistant_messages": 1,
                "json_protocol_version": 3,
                "invalid_json_lines": 0,
                "error_stop_reasons": [],
            },
        },
        "verifier_result": {"rewards": {"reward": reward}},
        "exception_info": None,
        "started_at": "2026-01-01T00:00:00Z",
        "finished_at": "2026-01-01T00:00:12Z",
        "agent_execution": {
            "started_at": "2026-01-01T00:00:01Z",
            "finished_at": "2026-01-01T00:00:11Z",
        },
    }
    (trial_dir / "result.json").write_text(
        json.dumps(payload),
        encoding="utf-8",
    )
    (trial_dir / "verifier").mkdir()
    if verifier_output is not None:
        (trial_dir / "verifier/test-stdout.txt").write_text(
            verifier_output,
            encoding="utf-8",
        )
    else:
        (trial_dir / "verifier/ctrf.json").write_text(
            json.dumps(
                {"results": {"tests": [{"name": "verification", "status": "passed"}]}}
            ),
            encoding="utf-8",
        )


class AnalysisTests(unittest.TestCase):
    def test_summary_calculates_efficiency_and_paired_outcomes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            job_dir = Path(temporary)
            make_trial(
                job_dir, identity=1, agent="volt", task="one", reward=1, cost=0.5
            )
            make_trial(
                job_dir, identity=2, agent="volt", task="two", reward=0, cost=0.25
            )
            make_trial(
                job_dir, identity=3, agent="codex", task="one", reward=0, cost=0.4
            )
            make_trial(
                job_dir, identity=4, agent="codex", task="two", reward=1, cost=0.6
            )

            summary = summarize(
                load_trials([job_dir]),
                expected_tasks=["one", "two"],
            )

            self.assertEqual(summary["trial_count"], 4)
            self.assertEqual(summary["warnings"], [])
            self.assertEqual(summary["agents"]["volt"]["solved"], 1)
            self.assertEqual(
                summary["agents"]["volt"]["reported_cost_per_solved_usd"], 0.75
            )
            self.assertEqual(summary["agents"]["volt"]["tokens_per_solved"], 220)
            self.assertEqual(summary["agents"]["volt"]["trajectory_coverage_trials"], 2)
            pair = summary["paired_comparisons"]["codex vs volt"]
            self.assertEqual(pair["left_only_solved"], 1)
            self.assertEqual(pair["right_only_solved"], 1)
            self.assertEqual(pair["excluded_verifier_infra_tasks"], 0)
            self.assertIn("Harbor pilot summary", render_markdown(summary))

    def test_duplicate_trial_identity_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            job_dir = Path(temporary)
            make_trial(job_dir, identity=1, agent="volt", task="one", reward=1, cost=0)
            make_trial(job_dir, identity=1, agent="codex", task="two", reward=1, cost=0)

            with self.assertRaises(ValueError):
                load_trials([job_dir])

    def test_verifier_bootstrap_failure_is_not_counted_as_agent_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            job_dir = Path(temporary)
            make_trial(
                job_dir,
                identity=1,
                agent="oracle",
                task="one",
                reward=0,
                cost=0,
                verifier_output=(
                    "curl: (6) Could not resolve host: astral.sh\n"
                    "/tests/test.sh: uvx: command not found\n"
                ),
            )

            summary = summarize(load_trials([job_dir]))

            self.assertEqual(summary["verifier_infra_invalid_tasks"], ["one"])
            self.assertEqual(
                summary["agents"]["oracle"]["verifier_infra_failures"],
                {"one": "dns_resolution"},
            )
            self.assertFalse(summary["score_valid"])
            self.assertIsNone(summary["agents"]["oracle"]["solved"])
            self.assertTrue(summary["warnings"])
            self.assertFalse(summary["trials"][0]["solved"])


if __name__ == "__main__":
    unittest.main()
