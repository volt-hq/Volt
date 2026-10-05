import {
	PRESENTATION_MAX_SERIALIZED_BYTES,
	PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES,
	type ToolPresentation,
	type UiNode,
	type UiNodeAction,
	type UiNodeStyledText,
	type UiTreeItem,
} from "@hansjm10/volt-protocol";
import { visibleWidth } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { SessionPresenters } from "../src/core/session/presenters.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { type JobSnapshot, type JobSummary, jobResult, jobWaitResult } from "../src/core/tools/jobs.ts";
import { presentBackground } from "../src/core/tools/presenters.ts";
import type { SubagentToolDetails } from "../src/core/tools/subagent.ts";
import { presentJobs, presentSubagent, presentSubagentRegistry } from "../src/core/tools/work-presenters.ts";
import {
	HOST_UI_POLICY,
	normalizeToolPresentation,
	presentToolCall,
	serializedBytes,
	type ToolPresenter,
	type ToolPresentInput,
} from "../src/core/ui/presentation.ts";
import { ToolCard } from "../src/modes/interactive/ui-node/tool-card.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

/** A presentation as the TUI's tool card draws it, every line within `width`. */
function drawn(presentation: ToolPresentation, expanded: boolean, width: number): string {
	const card = new ToolCard({ presentation, state: "done", expanded });
	try {
		const lines = card.render(width).lines;
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		return lines.map(stripAnsi).join("\n");
	} finally {
		card.dispose();
	}
}

function input(
	args: Record<string, unknown>,
	state: ToolPresentInput["state"],
	result?: { text?: string; details?: unknown; isError?: boolean; partial?: boolean },
): ToolPresentInput {
	return {
		args,
		argsComplete: state !== "pending",
		state,
		...(result === undefined
			? {}
			: {
					result: {
						content: result.text === undefined ? [] : [{ type: "text", text: result.text }],
						...(result.details === undefined ? {} : { details: result.details }),
						isError: result.isError ?? false,
						partial: result.partial ?? false,
					},
				}),
		cwd: process.cwd(),
	};
}

/** What a client receives: the presenter's own output, normalized, never the generic fallback. */
function present(presenter: ToolPresenter, toolName: string, call: ToolPresentInput): ToolPresentation {
	const own = normalizeToolPresentation(presenter(call), {
		policy: HOST_UI_POLICY,
		maxBytes: PRESENTATION_MAX_SERIALIZED_BYTES,
	});
	expect(
		presentToolCall(
			{ present: presenter, policy: HOST_UI_POLICY },
			toolName,
			call,
			PRESENTATION_MAX_SERIALIZED_BYTES,
		),
	).toEqual(own);
	return own;
}

function styled(text: UiNodeStyledText | undefined): string {
	if (text === undefined) return "";
	return typeof text === "string" ? text : text.map((span) => span.text).join("");
}

function treeText(items: readonly UiTreeItem[]): string[] {
	return items.flatMap((item) => [
		`${styled(item.label)} ${styled(item.description)}`,
		...treeText(item.children ?? []),
	]);
}

/** The plain text of nodes, one line per row, step, item, or line. */
function plain(nodes: readonly UiNode[] | undefined): string {
	return (nodes ?? [])
		.flatMap((node): string[] => {
			switch (node.type) {
				case "text":
					return [styled(node.text)];
				case "markdown":
					return [node.markdown];
				case "terminal":
					return node.lines.map((line) => styled(line));
				case "code":
					return [node.code];
				case "table":
					return node.rows.map((row) => row.cells.map((cell) => styled(cell)).join(" | "));
				case "keyValue":
					return node.items.map((item) => `${styled(item.label)}: ${styled(item.value)}`);
				case "progress":
					return node.kind === "steps"
						? node.steps.map((step) => `[${step.status}] ${styled(step.label)} ${styled(step.detail)}`)
						: [];
				case "card":
					return [
						`${styled(node.title)} ${(node.badges ?? []).map((badge) => badge.label).join(" ")}`,
						...(node.sections ?? []).flatMap((section) => plain(section.children).split("\n")),
						...(node.actions ?? []).map((action) => `[${action.label}]`),
					];
				case "tree":
					return treeText(node.items);
				case "actions":
					return node.actions.map((action) => `[${action.label}]`);
				case "list":
					return plain(node.items).split("\n");
				default:
					return [];
			}
		})
		.join("\n");
}

function allActions(nodes: readonly UiNode[] | undefined): UiNodeAction[] {
	return (nodes ?? []).flatMap((node) => {
		if (node.type === "actions") return node.actions;
		if (node.type === "card") {
			return [...(node.actions ?? []), ...(node.sections ?? []).flatMap((section) => allActions(section.children))];
		}
		return node.type === "list" ? allActions(node.items) : [];
	});
}

function nodesOfType<T extends UiNode["type"]>(
	nodes: readonly UiNode[] | undefined,
	type: T,
): Extract<UiNode, { type: T }>[] {
	return (nodes ?? []).flatMap((node): Extract<UiNode, { type: T }>[] => {
		if (node.type === type) return [node as Extract<UiNode, { type: T }>];
		if (node.type === "card") return (node.sections ?? []).flatMap((section) => nodesOfType(section.children, type));
		return node.type === "list" ? nodesOfType(node.items, type) : [];
	});
}

// ============================================================================
// subagent
// ============================================================================

function usage(): NonNullable<SubagentToolDetails["usage"]> {
	return {
		turns: 1,
		messages: { user: 1, assistant: 1, toolCalls: 0, toolResults: 0, total: 2 },
		tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
		cost: 0,
	};
}

function output(text: string): NonNullable<NonNullable<SubagentToolDetails["tasks"]>[number]["output"]> {
	return { text, bytes: Buffer.byteLength(text, "utf8"), truncated: false, maxBytes: 50 * 1024 };
}

const subagent = (call: ToolPresentInput) => present(presentSubagent, "subagent", call);

describe("subagent presenter", () => {
	const single = { agent: "scout", task: "Inspect the auth flow" };

	it("shows a single result as a timed step, its output only expanded, and opens the child", () => {
		const presented = subagent(
			input(single, "done", {
				text: "final answer",
				details: {
					mode: "single",
					status: "completed",
					subagentId: "sa_1",
					sessionId: "session_1",
					agent: { name: "scout", source: "user" },
					durationMs: 32_100,
					usage: usage(),
					output: output("final answer"),
				} satisfies SubagentToolDetails,
			}),
		);
		expect(presented.hidden).toBeUndefined();
		expect(styled(presented.title)).toBe("Subagent  1 done");
		const summary = plain(presented.summary);
		expect(summary).toContain("[done] scout · Inspect the auth flow");
		expect(summary).toContain("done · 0 tool calls · 32.1s · 30 tokens");
		expect(summary).not.toContain("final answer");
		const body = plain(presented.body);
		expect(body).toContain("final answer");
		expect(body).toContain("Inspect the auth flow");
		expect(allActions(presented.body)).toEqual([
			{ id: "open:sa_1", label: "Open", intent: { type: "open_work", input: { workId: "sa_1" } } },
		]);
		expect(presented.showsDuration).toBeUndefined();
	});

	it("is hidden until a child is created, so a confirmation preflight never shows", () => {
		for (const state of ["pending", "running"] as const) {
			expect(subagent(input(single, state)).hidden).toBe(true);
		}
		const preflight = subagent(
			input(single, "done", {
				text: "A registry preflight was completed. No subagents were started.",
				details: {
					mode: "list",
					status: "completed",
					summary: { total: 3, completed: 0, failed: 0, cancelled: 0, running: 3 },
				} satisfies SubagentToolDetails,
			}),
		);
		expect(preflight.hidden).toBe(true);
		expect(preflight.summary).toBeUndefined();
		expect(preflight.body).toBeUndefined();
		const created = subagent(
			input(single, "running", {
				details: { mode: "single", status: "running", subagentId: "sa_1", agent: { name: "scout" } },
				partial: true,
			}),
		);
		expect(created.hidden).toBeUndefined();
		expect(plain(created.summary)).toContain("[active] scout · Inspect the auth flow");
	});

	it("never shows the confirmation token", () => {
		const call = { ...single, confirm: "tok_private-confirmation" };
		for (const presented of [
			subagent(input(call, "pending")),
			subagent(
				input(call, "done", {
					text: "done",
					details: { mode: "single", status: "completed", subagentId: "sa_1", agent: { name: "scout" } },
				}),
			),
		]) {
			expect(JSON.stringify(presented)).not.toContain("tok_private");
		}
	});

	it("shows registry list, follow, and resume calls without a created child", () => {
		const listing = subagent(input({ list: true }, "running"));
		expect(listing.hidden).toBeUndefined();
		expect(styled(listing.title)).toBe("Subagent registry  querying…");
		const listed = subagent(
			input({ list: true }, "done", {
				text: "2 subagent runs recorded in this session",
				details: {
					mode: "list",
					status: "completed",
					summary: { total: 2, completed: 1, failed: 0, cancelled: 0, running: 1, returned: 2 },
				} satisfies SubagentToolDetails,
			}),
		);
		expect(styled(listed.title)).toBe("Subagent registry  1/2 completed, 1 running");
		expect(plain(listed.body)).toContain("2 subagent runs recorded");
		for (const args of [{ follow: "sa_existing" }, { resume: "sa_existing" }]) {
			expect(subagent(input(args, "running")).hidden).toBeUndefined();
		}
		const followed = subagent(
			input({ follow: "sa_existing" }, "done", {
				text: "shared result",
				details: {
					mode: "follow",
					status: "completed",
					subagentId: "sa_existing",
					agent: { name: "researcher", source: "built-in" },
				} satisfies SubagentToolDetails,
			}),
		);
		expect(plain(followed.summary)).toContain("researcher");
		expect(plain(followed.body)).toContain("shared result");
		expect(allActions(followed.body).map((action) => action.intent)).toEqual([
			{ type: "open_work", input: { workId: "sa_existing" } },
		]);
	});

	it("shows failures that happen before any child is created", () => {
		const presented = subagent(
			input(single, "done", {
				text: 'Cannot delegate to "scout": the delegation tree already started 100 subagents',
				isError: true,
			}),
		);
		expect(presented.hidden).toBeUndefined();
		expect(styled(presented.title)).toBe("Subagent  1 failed");
		expect(plain(presented.summary)).toContain("[failed] scout · Inspect the auth flow");
		expect(plain(presented.summary)).toContain("failed · Cannot delegate");
	});

	it("shows an unstructured failure after a running child as failed, not running", () => {
		const presented = subagent(
			input({ agent: "missing", task: "Inspect the auth flow" }, "done", {
				text: "Unknown subagent: missing",
				isError: true,
			}),
		);
		expect(styled(presented.title)).toBe("Subagent  1 failed");
		expect(plain(presented.summary)).toContain("[failed] missing · Inspect the auth flow");
		expect(plain(presented.summary)).toContain("failed · Unknown subagent: missing");
		expect(JSON.stringify(presented)).not.toContain("running");
	});

	it("keeps parallel children in order, with outputs only expanded", () => {
		const presented = subagent(
			input(
				{
					tasks: [
						{ agent: "alpha", task: "First task" },
						{ agent: "beta", task: "Second task" },
					],
				},
				"done",
				{
					text: "combined",
					details: {
						mode: "parallel",
						status: "partial",
						summary: { total: 2, completed: 1, failed: 1, cancelled: 0, maxTasks: 8, maxConcurrency: 4 },
						tasks: [
							{
								index: 0,
								subagentId: "sa_alpha",
								sessionId: "session_alpha",
								agent: { name: "alpha", source: "user" },
								status: "completed",
								usage: usage(),
								output: output("alpha output"),
							},
							{
								index: 1,
								subagentId: "sa_beta",
								sessionId: "session_beta",
								agent: { name: "beta", source: "project" },
								status: "failed",
								output: output("beta failed"),
								error: { message: "beta failed" },
							},
						],
					} satisfies SubagentToolDetails,
				},
			),
		);
		expect(styled(presented.title)).toBe("Subagents · parallel  1 done · 1 failed");
		const summary = plain(presented.summary);
		expect(summary.indexOf("alpha · First task")).toBeLessThan(summary.indexOf("beta · Second task"));
		expect(summary).not.toContain("alpha output");
		expect(JSON.stringify(presented.summary).match(/beta failed/g)).toHaveLength(1);
		const body = plain(presented.body);
		expect(body).toContain("alpha output");
		// The failure shows once: as the error, not again as its output.
		expect(JSON.stringify(presented.body).match(/beta failed/g)).toHaveLength(1);
		expect(nodesOfType(presented.body, "card").map((card) => card.key)).toEqual(["sa_alpha", "sa_beta"]);
		expect(allActions(presented.body).map((action) => action.id)).toEqual(["open:sa_alpha", "open:sa_beta"]);
	});

	it("times running children from their start, and finished ones from start to end", () => {
		const startedAt = 1_700_000_000_000;
		const presented = subagent(
			input(
				{
					tasks: [
						{ agent: "alpha", task: "First task" },
						{ agent: "beta", task: "Second task" },
						{ agent: "gamma", task: "Third task" },
					],
				},
				"running",
				{
					text: "Subagent parallel: 1/3 completed, 2 running",
					partial: true,
					details: {
						mode: "parallel",
						status: "running",
						summary: { total: 3, completed: 1, failed: 0, cancelled: 0, running: 2 },
						startedAt,
						tasks: [
							{
								index: 0,
								subagentId: "sa_alpha",
								agent: { name: "alpha" },
								status: "running",
								startedAt,
								toolCalls: 3,
								currentActivity: "read src/auth.ts",
							},
							{ index: 1, subagentId: "sa_beta", agent: { name: "beta" }, status: "running" },
							{
								index: 2,
								subagentId: "sa_gamma",
								agent: { name: "gamma" },
								status: "completed",
								startedAt,
								durationMs: 4_500,
							},
						],
					} satisfies SubagentToolDetails,
				},
			),
		);
		expect(styled(presented.title)).toBe("Subagents · parallel  2 running · 1 done");
		const [steps] = nodesOfType(presented.summary, "progress");
		if (steps?.kind !== "steps") throw new Error("Expected steps");
		expect(steps.steps.map((step) => [step.status, step.startedAt, step.endedAt])).toEqual([
			["active", startedAt, undefined],
			["active", undefined, undefined],
			["done", startedAt, startedAt + 4_500],
		]);
		expect(styled(steps.steps[0]?.detail)).toBe("running · 3 tool calls · read src/auth.ts");
		// A presenter is pure: no step carries the time it was presented at.
		expect(JSON.stringify(steps)).not.toMatch(/\d+\.\ds/);
	});

	it("caps the roster, keeping children that are not done", () => {
		const count = 40;
		const presented = subagent(
			input(
				{ tasks: Array.from({ length: count }, (_v, i) => ({ agent: `agent-${i}`, task: `task ${i}` })) },
				"running",
				{
					partial: true,
					details: {
						mode: "parallel",
						status: "running",
						summary: { total: count, completed: 30, failed: 0, cancelled: 0, running: 10 },
						tasks: Array.from({ length: count }, (_v, index) => ({
							index,
							subagentId: `sa_${index}`,
							agent: { name: `agent-${index}`, source: "user" as const },
							status: index < 30 ? ("completed" as const) : ("running" as const),
						})),
					} satisfies SubagentToolDetails,
				},
			),
		);
		const summary = plain(presented.summary);
		expect(summary).toContain("…and 24 more agents");
		for (let index = 30; index < 40; index++) expect(summary).toContain(`agent-${index} `);
		expect(summary).toContain("agent-0 ");
		expect(summary).not.toContain("agent-10 ");
		expect(styled(presented.title)).toContain("10 running · 30 done");
		expect(nodesOfType(presented.body, "card")).toHaveLength(16);
	});

	it("bounds the nested delegation tree", () => {
		const children = Array.from({ length: 16 }, (_v, i) => ({
			subagentId: `sa_child-${i}`,
			agent: { name: `child-${i}` },
			status: "running" as const,
			task: `child task ${i}`,
			children: Array.from({ length: 16 }, (_w, j) => ({
				subagentId: `sa_grandchild-${i}-${j}`,
				agent: { name: `grandchild-${i}-${j}` },
				status: "running" as const,
			})),
		}));
		const presented = subagent(
			input({ agent: "coordinator", task: "big tree" }, "running", {
				partial: true,
				details: {
					mode: "single",
					status: "running",
					subagentId: "sa_root",
					agent: { name: "coordinator", source: "user" },
					children,
				} satisfies SubagentToolDetails,
			}),
		);
		const [tree] = nodesOfType(presented.body, "tree");
		const lines = treeText(tree?.items ?? []);
		expect(lines.length).toBeLessThan(45);
		expect(lines.at(-1)).toContain("…");
		expect(lines[0]).toContain("child-0 · child task 0");
	});

	it("shows chain steps with their tasks and outputs", () => {
		const presented = subagent(
			input(
				{
					chain: [
						{ agent: "first", task: "Collect facts" },
						{ agent: "second", task: "Use {previous} to decide" },
					],
				},
				"done",
				{
					text: "second output",
					details: {
						mode: "chain",
						status: "completed",
						summary: { total: 2, completed: 2, failed: 0, cancelled: 0 },
						steps: [
							{
								index: 0,
								subagentId: "sa_first",
								agent: { name: "first", source: "user" },
								status: "completed",
								usage: usage(),
								output: output("first output"),
							},
							{
								index: 1,
								subagentId: "sa_second",
								agent: { name: "second", source: "user" },
								status: "completed",
								usage: usage(),
								output: output("second output"),
							},
						],
					} satisfies SubagentToolDetails,
				},
			),
		);
		expect(styled(presented.title)).toBe("Subagents · chain  2 done");
		expect(plain(presented.summary)).toContain("first · Collect facts");
		expect(plain(presented.summary)).toContain("second · Use {previous} to decide");
		const body = plain(presented.body);
		expect(body).toContain("first output");
		expect(body).toContain("second output");
	});

	it("draws in the TUI's tool card at any width", () => {
		const presented = subagent(
			input(
				{
					tasks: [
						{ agent: "alpha", task: "First task ".repeat(20) },
						{ agent: "beta", task: "Second" },
					],
				},
				"done",
				{
					text: "combined",
					details: {
						mode: "parallel",
						status: "completed",
						tasks: [
							{
								index: 0,
								subagentId: "sa_alpha",
								agent: { name: "alpha" },
								status: "completed",
								usage: usage(),
								output: output("**alpha** output"),
								children: [{ subagentId: "sa_nested", agent: { name: "nested" }, status: "completed" }],
							},
							{
								index: 1,
								subagentId: "sa_beta",
								agent: { name: "beta" },
								status: "failed",
								error: { message: "boom" },
							},
						],
					} satisfies SubagentToolDetails,
				},
			),
		);
		for (const width of [24, 80, 140]) {
			expect(drawn(presented, false, width)).toContain("alpha");
			expect(drawn(presented, true, width)).toContain("output");
		}
		expect(drawn(presented, true, 140)).toContain("nested");
	});

	it("fits large batches with long outputs within the local bound", () => {
		const tasks = Array.from({ length: 100 }, (_v, index) => ({
			index,
			subagentId: `sa_${index}`,
			agent: { name: `agent-${index}` },
			status: index % 3 === 0 ? ("running" as const) : ("completed" as const),
			startedAt: 1_700_000_000_000,
			durationMs: 1_234,
			output: { text: "x\n".repeat(25_000), bytes: 50_000, truncated: true, omittedBytes: 10, maxBytes: 50_000 },
			children: Array.from({ length: 16 }, (_c, c) => ({
				subagentId: `sa_c${c}`,
				agent: { name: `c${c}` },
				status: "running" as const,
				task: "t ".repeat(500),
			})),
		}));
		const raw = presentSubagent(
			input({ tasks: tasks.map((task) => ({ agent: task.agent.name, task: "do ".repeat(2_000) })) }, "done", {
				text: "done",
				details: { mode: "parallel", status: "partial", tasks } satisfies SubagentToolDetails,
			}),
		);
		expect(serializedBytes(raw)).toBeLessThan(PRESENTATION_MAX_SERIALIZED_BYTES);
		subagent(
			input({ tasks: tasks.map((task) => ({ agent: task.agent.name, task: "do ".repeat(2_000) })) }, "done", {
				text: "done",
				details: { mode: "parallel", status: "partial", tasks } satisfies SubagentToolDetails,
			}),
		);
	});

	it("fits a typical batch within the remote bound", () => {
		const tasks = Array.from({ length: 4 }, (_v, index) => ({
			index,
			subagentId: `sa_${index}`,
			agent: { name: `agent-${index}` },
			status: "completed" as const,
			usage: usage(),
			output: output("A finding.\n".repeat(400)),
		}));
		const raw = presentSubagent(
			input({ tasks: tasks.map((task) => ({ agent: task.agent.name, task: "Review one module" })) }, "done", {
				text: "done",
				details: { mode: "parallel", status: "completed", tasks } satisfies SubagentToolDetails,
			}),
		);
		expect(() =>
			normalizeToolPresentation(raw, { policy: HOST_UI_POLICY, maxBytes: PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES }),
		).not.toThrow();
	});

	it("reads streamed arguments and malformed details defensively", () => {
		for (const args of [{}, { tasks: "not a list" }, { chain: [null, 42] }, { agent: 7, task: ["x"] }]) {
			for (const state of ["pending", "running", "done"] as const) {
				subagent(input(args, state));
				subagent(input(args, state, { details: { mode: "parallel", status: "running", tasks: [null, 1, "x"] } }));
				subagent(input(args, state, { details: { mode: "single", status: "bogus", subagentId: 4, agent: 7 } }));
			}
		}
	});

	it("presents the registry tool's calls without hiding them", () => {
		const presented = present(presentSubagentRegistry, "subagent_registry", input({ list: true }, "pending"));
		expect(presented.hidden).toBeUndefined();
		expect(styled(presented.title)).toBe("Subagent registry  querying…");
		const resumed = present(
			presentSubagentRegistry,
			"subagent_registry",
			input({ resume: "sa_paused" }, "done", {
				text: "resumed result",
				details: { mode: "resume", status: "completed", subagentId: "sa_paused", agent: { name: "worker" } },
			}),
		);
		expect(plain(resumed.summary)).toContain("[done] worker");
	});
});

describe("background subagent calls", () => {
	const background = presentBackground(presentSubagent);
	const job: JobSummary & { toolCallId: string } = {
		id: "12345678-1234-1234-1234-123456789abc",
		tool: "subagent",
		toolCallId: "background-subagent-call",
		label: "Inspect the auth flow",
		status: "running",
	};
	const args = { agent: "scout", task: job.label, background: true };

	it("shows the job a background spawn started", () => {
		const presented = present(background, "subagent", input(args, "done", { ...jobResult(job), text: "" }));
		expect(presented.hidden).toBeUndefined();
		expect(plain(presented.summary)).toContain("Background job");
		expect(plain(presented.summary)).toContain(job.id);
	});

	it("keeps a background spawn's confirmation preflight hidden", () => {
		const presented = present(
			background,
			"subagent",
			input(args, "done", {
				text: "No subagents started. Confirm the exact request.",
				details: {
					mode: "list",
					status: "completed",
					summary: { total: 0, completed: 0, failed: 0, cancelled: 0, running: 0 },
				} satisfies SubagentToolDetails,
			}),
		);
		expect(presented.hidden).toBe(true);
	});

	it.each([null, [], {}, { ...job, id: "" }, { ...job, id: "not a work id" }, { ...job, status: "unknown" }])(
		"does not reveal a spawn for invalid job metadata %j",
		(invalid) => {
			const presented = present(
				background,
				"subagent",
				input(args, "done", { text: "Not an acknowledged job", details: { job: invalid } }),
			);
			expect(presented.hidden).toBe(true);
		},
	);
});

// ============================================================================
// jobs
// ============================================================================

const jobs = (call: ToolPresentInput) => present(presentJobs, "jobs", call);

function snapshotOf(status: JobSnapshot["status"]): JobSnapshot {
	return {
		id: "job_12345678",
		toolCallId: "launch",
		tool: "bash",
		label: "npm run check",
		status,
		output: "Captured output\nFinal captured line",
		outputTruncated: true,
	};
}

describe("jobs presenter", () => {
	it.each([{}, { action: 42 }, { action: "read" }, { action: "wait", ids: "x" }, { action: "wait", ids: [1, "a"] }])(
		"presents streamed or invalid arguments: %j",
		(args) => {
			for (const state of ["pending", "running"] as const) {
				const presented = jobs(input(args, state));
				expect(styled(presented.title)).toMatch(/^jobs/);
				expect(presented.showsDuration).toBe(true);
			}
		},
	);

	it("names the action and its jobs in the title, and what it waits for while it runs", () => {
		expect(styled(jobs(input({ action: "list" }, "running")).title)).toBe("jobs list");
		expect(styled(jobs(input({ action: "read", id: "job_1" }, "running")).title)).toBe("jobs read job_1");
		expect(styled(jobs(input({ action: "cancel", id: "job_1" }, "running")).title)).toBe("jobs cancel job_1");
		expect(styled(jobs(input({ action: "wait", ids: ["job_1"] }, "running")).title)).toBe("jobs wait job_1");
		const many = jobs(input({ action: "wait", ids: ["a", "b", "c"], mode: "all" }, "running"));
		expect(styled(many.title)).toBe("jobs wait (all) · 3 jobs");
		expect(many.activity).toBe("Waiting for 3 background jobs");
		expect(jobs(input({ action: "list" }, "pending")).activity).toBe("Generating arguments");
	});

	it.each(["read", "cancel"] as const)("shows a %s result as the job's row and, expanded, its output", (action) => {
		for (const status of ["running", "cancelling", "completed", "failed", "cancelled", "interrupted"] as const) {
			const snapshot = snapshotOf(status);
			const result = jobResult(snapshot);
			const saved = JSON.stringify(result);
			const presented = jobs(
				input({ action, id: snapshot.id }, "done", {
					text: (result.content[0] as { text: string }).text,
					details: result.details,
					isError: result.isError === true,
				}),
			);
			const active = status === "running" || status === "cancelling";
			const [table] = nodesOfType(presented.summary, "table");
			expect(plain(table ? [table] : [])).toContain(`${active ? " at capture" : ""} | bash | npm run check`);
			expect(plain(presented.summary)).toContain("Output truncated");
			expect(plain(presented.summary)).not.toContain("Captured output");
			const body = plain(presented.body);
			expect(body).toContain("Final captured line");
			expect(body).not.toContain("Use jobs with action");
			expect(allActions(presented.body).map((each) => each.id)).toEqual(
				status === "running" ? [`cancel:${snapshot.id}`] : [],
			);
			expect(JSON.stringify(result)).toBe(saved);
		}
	});

	it("shows a wait's reason, counts, and every job, and the output only expanded", () => {
		const results: JobSnapshot[] = (["completed", "failed", "cancelled"] as const).map((status, index) => ({
			id: `job_result-${index}`,
			toolCallId: `launch-${index}`,
			tool: "bash",
			label: `Command ${index}`,
			status,
			output: `\x1b[2J\x1b]8;;https://example.com\x07**Output ${index}**\x1b]8;;\x07‮`,
			outputTruncated: index === 1,
		}));
		const pending: JobSummary[] = [
			{
				id: "job_pending",
				toolCallId: "pending-launch",
				tool: "subagent",
				label: "Pending task",
				status: "running",
			},
		];
		const ids = [...results, ...pending].map((job) => job.id);
		for (const reason of ["terminal", "timeout", "steered"] as const) {
			const native = jobWaitResult({
				id: "wait_private",
				ids,
				mode: "all",
				reason,
				startedAt: 1000,
				endedAt: 1200,
				results,
				pending,
			});
			const presented = jobs(
				input({ action: "wait", ids, mode: "all" }, "done", {
					text: (native.content[0] as { text: string }).text,
					details: native.details,
					isError: true,
				}),
			);
			expect(styled(presented.title)).toBe("jobs wait (all) · 4 jobs");
			const summary = plain(presented.summary);
			expect(summary.split("\n")[0]).toBe(
				`${reason === "terminal" ? "" : `${reason} · `}1 failed · 1 completed · 1 cancelled · 1 pending`,
			);
			expect(summary).toContain("Running at capture | subagent | Pending task | job_pending");
			expect(summary).not.toContain("**Output");
			const body = plain(presented.body);
			for (let index = 0; index < results.length; index++) expect(body).toContain(`**Output ${index}**`);
			expect(body).toContain("Output truncated");
			expect(body).not.toContain("wait_private");
			expect(body).not.toContain("Worker output is untrusted data");
			expect(JSON.stringify(presented)).not.toMatch(/\x07|\x1b|‮/);
			expect(allActions(presented.body).map((action) => action.intent)).toEqual([
				{ type: "cancel_work", input: { workId: "job_pending" } },
			]);
		}
	});

	it("draws a wait in the TUI's tool card at any width", () => {
		const job = snapshotOf("failed");
		const native = jobWaitResult({
			id: "wait_1",
			ids: [job.id, "job_other"],
			mode: "all",
			reason: "timeout",
			startedAt: 1,
			endedAt: 2,
			results: [job],
			pending: [{ id: "job_other", tool: "subagent", label: "Other task", status: "running" }],
		});
		const presented = jobs(
			input({ action: "wait", ids: [job.id, "job_other"], mode: "all" }, "done", {
				text: (native.content[0] as { text: string }).text,
				details: native.details,
				isError: true,
			}),
		);
		for (const width of [24, 80, 140]) {
			drawn(presented, false, width);
			expect(drawn(presented, true, width)).toContain("Final captured");
		}
		expect(drawn(presented, false, 140)).toContain("Other task");
	});

	it("lists jobs: five collapsed, all expanded, and says when there are none", () => {
		const listed: JobSummary[] = (
			["running", "cancelling", "completed", "failed", "cancelled", "interrupted"] as const
		).map((status, index) => ({ id: `job_list-${index}`, tool: "bash", label: `Command ${index}`, status }));
		const text = listed
			.map((job) => `${job.id}: ${job.status} (${job.tool}) ${JSON.stringify(job.label)}`)
			.join("\n");
		const presented = jobs(input({ action: "list" }, "done", { text, details: { jobs: listed } }));
		const summary = plain(presented.summary);
		for (const job of listed.slice(0, 5)) expect(summary).toContain(job.label);
		expect(summary).not.toContain("Command 5");
		expect(summary).toContain("… 1 more job");
		const body = plain(presented.body);
		for (const job of listed) expect(body).toContain(job.label);
		expect(allActions(presented.body).map((action) => action.id)).toEqual(["cancel:job_list-0"]);
		const empty = jobs(
			input({ action: "list" }, "done", {
				text: "No background jobs in this conversation.",
				details: { jobs: [] },
			}),
		);
		expect(plain(empty.summary)).toBe("No background jobs in this conversation.");
	});

	const summary: JobSummary = {
		id: "job_list-item",
		tool: "bash",
		toolCallId: "list-launch",
		label: "npm run check",
		status: "completed",
	};
	it.each([
		undefined,
		null,
		"extension replacement",
		42,
		[],
		{},
		{ jobs: null },
		{ jobs: [null] },
		{ jobs: [summary, null] },
		{ jobs: [{ ...summary, status: "constructor" }] },
		{ jobs: [{ ...summary, id: "job_\x07" }] },
		{ jobs: [{ ...summary, tool: "other" }] },
		{ jobs: [{ ...summary, label: 42 }] },
	])("shows the literal result text for unsupported details: %j", (details) => {
		const presented = jobs(
			input({ action: "list" }, "done", { text: "\x1b[2JExtension supplied result\x07", details }),
		);
		expect(plain(presented.summary)).toBe("Extension supplied result");
		expect(JSON.stringify(presented)).not.toContain(summary.label);
		expect(nodesOfType(presented.summary, "table")).toEqual([]);
	});

	it("shows a failed inspection whose metadata was replaced", () => {
		const presented = jobs(
			input({ action: "list" }, "done", { text: "Extension error text", details: "replacement", isError: true }),
		);
		expect(plain(presented.summary)).toBe("Job inspection failed\nExtension error text");
	});

	it.each(["read", "wait", "list"] as const)(
		"shows a hook's replacement content or error for a %s result as literal text",
		(action) => {
			const job = snapshotOf("completed");
			const native =
				action === "list"
					? {
							content: [{ type: "text" as const, text: `${job.id}: completed (bash) "npm run check"` }],
							details: { jobs: [job] },
						}
					: action === "wait"
						? jobWaitResult({
								id: "wait_1",
								ids: [job.id],
								mode: "any",
								reason: "terminal",
								startedAt: 1,
								endedAt: 2,
								results: [job],
								pending: [],
							})
						: jobResult(job);
			const args =
				action === "list" ? { action } : action === "wait" ? { action, ids: [job.id] } : { action, id: job.id };
			for (const change of ["content", "error", "both"] as const) {
				const presented = jobs(
					input(args, "done", {
						text:
							change === "error" ? (native.content[0] as { text: string }).text : "Extension replacement text",
						details: native.details,
						isError: change !== "content",
					}),
				);
				const shown = `${plain(presented.summary)}\n${plain(presented.body)}`;
				if (change !== "error") expect(shown).toContain("Extension replacement text");
				expect(shown.includes("Job inspection failed")).toBe(change !== "content");
				expect(nodesOfType(presented.summary, "table")).toEqual([]);
			}
		},
	);

	it("keeps transformed output to ten lines collapsed", () => {
		for (const isError of [false, true]) {
			const presented = jobs(
				input({ action: "list" }, "done", {
					text: Array.from({ length: 30 }, (_v, index) => `Extension line ${index}`).join("\n"),
					details: { jobs: [] },
					isError,
				}),
			);
			const summary = plain(presented.summary);
			expect(summary).toContain("Extension line 9");
			expect(summary).not.toContain("Extension line 10");
			expect(summary).toContain("… 20 more lines");
			expect(plain(presented.body)).toContain("Extension line 29");
		}
	});

	it("shows a consistently redacted snapshot as the result recorded it", () => {
		const snapshot = { ...snapshotOf("running"), label: "Filtered label", output: "token=[REDACTED]" };
		const result = jobResult(snapshot);
		const presented = jobs(
			input({ action: "read", id: snapshot.id }, "done", {
				text: (result.content[0] as { text: string }).text,
				details: result.details,
			}),
		);
		expect(plain(presented.summary)).toContain("Running at capture | bash | Filtered label");
		expect(plain(presented.body)).toContain("token=[REDACTED]");
	});
});

describe("presenting an extension's tool of a built-in name", () => {
	it("binds only the extension's own work: forged job details name no work it may cancel", () => {
		const job: JobSummary = { id: "victim-work-1", tool: "bash", label: "Deploy", status: "running" };
		const result = jobResult(job);
		const call = input({ action: "read", id: job.id }, "done", {
			text: (result.content[0] as { text: string }).text,
			details: result.details,
		});
		const actions = (presenters: SessionPresenters) =>
			JSON.stringify(presentToolCall(presenters.tool("jobs"), "jobs", call, PRESENTATION_MAX_SERIALIZED_BYTES));
		// The built-in jobs tool's call cancels the job it read.
		const builtin = new SessionPresenters({ tool: () => undefined, message: () => undefined, ownsWork: () => false });
		expect(actions(builtin)).toContain('"cancel_work"');
		// An extension's override without a presenter presents as the built-in, under the extension's policy.
		const override = new SessionPresenters({
			tool: (name) => (name === "jobs" ? { extensionId: "forger" } : undefined),
			message: () => undefined,
			ownsWork: () => false,
		});
		expect(override.tool("jobs")?.policy).toMatchObject({ owner: "extension", extensionId: "forger" });
		expect(actions(override)).not.toContain('"cancel_work"');
		expect(actions(override)).toContain("Running at capture");
	});
});
