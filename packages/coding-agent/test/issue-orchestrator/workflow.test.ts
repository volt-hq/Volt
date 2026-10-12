import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_PROMPTS,
	loadWorkflow,
	parseWorkflow,
	renderTemplate,
	splitRolePrompts,
	WorkflowError,
} from "../../examples/extensions/issue-orchestrator/workflow.ts";

function codeOf(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		return error instanceof WorkflowError ? error.code : `not a WorkflowError: ${String(error)}`;
	}
	return undefined;
}

describe("issue orchestrator workflow", () => {
	it("applies defaults, and requires the labels that gate which issues are worked", () => {
		const config = parseWorkflow("---\ntracker:\n  labels: [agent-ready]\n---\n");
		expect(config).toMatchObject({
			tracker: {
				labels: ["agent-ready"],
				excludeLabels: ["agent-needs-human", "agent-approved"],
				filedLabel: "agent-filed",
			},
			ghCommand: ["gh"],
			polling: { intervalMs: 60_000 },
			workspace: { hookTimeoutMs: 600_000 },
			agent: { maxConcurrent: 2, maxAttempts: 3, maxRetryBackoffMs: 300_000 },
			review: { maxRounds: 3 },
			merge: { mode: "handoff", method: "squash", requireChecks: true, readyLabel: "agent-approved" },
			handoffLabel: "agent-needs-human",
		});
		expect(config.roles.implement).toEqual({
			agent: "general",
			limits: { maxDurationMs: 3_600_000 },
			prompt: DEFAULT_PROMPTS.implement,
		});
		expect(codeOf(() => parseWorkflow("---\ntracker: {}\n---\n"))).toBe("invalid_workflow_config");
		expect(codeOf(() => parseWorkflow("no front matter at all"))).toBe("invalid_workflow_config");
	});

	it("reads every setting, and the role prompts from the body's sections", () => {
		const config = parseWorkflow(`---
tracker:
  repo: volt-hq/Volt
  labels: [agent-ready, roadmap]
  exclude_labels: blocked
  review_author: volt-agent[bot]
  filed_label: found-by-agent
github:
  command: [volt-agent, gh]
polling:
  interval_ms: 30000
workspace:
  base_ref: main
  hooks:
    after_create: npm ci --ignore-scripts
    timeout_ms: 900000
agent:
  max_concurrent: 4
  max_attempts: 2
roles:
  review:
    agent: reviewer
    max_turns: 40
    max_cost_usd: 2.5
    max_concurrent: 1
review:
  max_rounds: 5
merge:
  mode: auto
  method: rebase
  require_checks: false
handoff_label: needs-human
---
Notes for humans are ignored.

## review
Review {{ pr.url }} carefully.

## unknown
Ignored too.
`);
		expect(config).toMatchObject({
			tracker: {
				repo: "volt-hq/Volt",
				labels: ["agent-ready", "roadmap"],
				excludeLabels: ["blocked", "needs-human", "agent-approved"],
				reviewAuthor: "volt-agent[bot]",
				filedLabel: "found-by-agent",
			},
			ghCommand: ["volt-agent", "gh"],
			polling: { intervalMs: 30_000 },
			workspace: { baseRef: "main", afterCreate: "npm ci --ignore-scripts", hookTimeoutMs: 900_000 },
			agent: { maxConcurrent: 4, maxAttempts: 2 },
			review: { maxRounds: 5 },
			merge: { mode: "auto", method: "rebase", requireChecks: false },
			handoffLabel: "needs-human",
		});
		expect(config.roles.review).toEqual({
			agent: "reviewer",
			limits: { maxTurns: 40, maxTotalCostUsd: 2.5, maxDurationMs: 3_600_000 },
			maxConcurrent: 1,
			prompt: "Review {{ pr.url }} carefully.",
		});
		expect(config.roles.fix.prompt).toBe(DEFAULT_PROMPTS.fix);
	});

	it("names what is wrong with a setting", () => {
		const invalid = (frontMatter: string) => {
			try {
				parseWorkflow(`---\ntracker:\n  labels: [agent-ready]\n${frontMatter}\n---\n`);
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
			return "accepted";
		};
		expect(invalid("merge:\n  mode: always")).toBe("workflow.merge.mode must be one of handoff, auto");
		expect(invalid("agent:\n  max_concurrent: 0")).toBe(
			"workflow.agent.max_concurrent must be a number of at least 1",
		);
		expect(invalid("polling:\n  interval_ms: 1000")).toBe(
			"workflow.polling.interval_ms must be a number of at least 5000",
		);
		expect(invalid("roles: []")).toBe("workflow.roles must be a map");
		expect(codeOf(() => parseWorkflow("---\ntracker:\n  kind: jira\n  labels: [a]\n---\n"))).toBe(
			"invalid_workflow_config",
		);
		expect(codeOf(() => parseWorkflow("---\n- a list\n---\n"))).toBe("workflow_front_matter_not_a_map");
		expect(codeOf(() => parseWorkflow("---\ntracker: [unclosed\n---\n"))).toBe("workflow_parse_error");
	});

	it("loads a workflow file, and says when it is missing", async () => {
		const directory = mkdtempSync(join(tmpdir(), "volt-orchestrator-workflow-"));
		try {
			const path = join(directory, "WORKFLOW.md");
			writeFileSync(path, "---\ntracker:\n  labels: [agent-ready]\n---\n");
			expect((await loadWorkflow(path)).config.tracker.labels).toEqual(["agent-ready"]);
			await expect(loadWorkflow(join(directory, "missing.md"))).rejects.toMatchObject({
				code: "missing_workflow_file",
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("splits role sections from the body", () => {
		expect(splitRolePrompts("## Implement\nDo it.\n## fix\n\n## review \nLook.\n## update\nMerge main.\n")).toEqual({
			implement: "Do it.",
			review: "Look.",
			update: "Merge main.",
		});
	});

	it("renders templates strictly", () => {
		const variables = { issue: { number: 12, labels: ["a", "b"], body: null }, repo: "volt-hq/Volt" };
		expect(renderTemplate("#{{issue.number}} {{ repo }} [{{ issue.labels }}] <{{ issue.body }}>", variables)).toBe(
			"#12 volt-hq/Volt [a, b] <>",
		);
		expect(codeOf(() => renderTemplate("{{ issue.missing }}", variables))).toBe("template_render_error");
		expect(codeOf(() => renderTemplate("{{ issue }}", variables))).toBe("template_render_error");
		expect(codeOf(() => renderTemplate("{{ issue.number | upcase }}", variables))).toBe("template_render_error");
		expect(codeOf(() => renderTemplate("{{ issue.body.text }}", variables))).toBe("template_render_error");
	});
});
