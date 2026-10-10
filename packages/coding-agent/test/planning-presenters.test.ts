import {
	PRESENTATION_MAX_SERIALIZED_BYTES,
	PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES,
	type ToolPresentation,
	type UiNode,
} from "@hansjm10/volt-protocol";
import { type TUI, visibleWidth } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { PlanningState, PlanPhase, PlanState } from "../src/core/planning.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { createPlanningToolDefinitions, type PlanningToolController } from "../src/core/tools/planning.ts";
import { type PlanningToolName, presentPlanning } from "../src/core/tools/planning-presenters.ts";
import { BUILTIN_PRESENTERS } from "../src/core/tools/presenters.ts";
import {
	HOST_UI_POLICY,
	presentToolCall,
	serializedBytes,
	type ToolPresenter,
	type ToolPresentInput,
} from "../src/core/ui/presentation.ts";
import { PresentedToolComponent } from "../src/modes/interactive/components/presented-tool.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createPlan(phase: PlanPhase = "draft"): PlanState {
	return {
		id: "plan-rendering",
		revision: 7,
		phase,
		title: "Readable planning tools",
		summary: "Replace serialized state with semantic rendering and retain the complete expanded summary.",
		steps: [
			{
				id: "step-1",
				text: "Render the first long planning step without losing EXPANDED_STEP_TAIL",
				status: "completed",
				note: "Confirmed by a focused tool-card test EXPANDED_NOTE_TAIL",
			},
			{ id: "step-2", text: "Render the active planning step", status: "in_progress" },
			{ id: "step-3", text: "Render the final pending planning step", status: "pending" },
		],
		...(phase === "active" || phase === "completed" || phase === "handed_off"
			? {
					execution: {
						id: "execution-1",
						approvedRevision: 6,
						strategy: "retain_context" as const,
						sourceSessionId: "source",
						targetSessionId: "target",
					},
				}
			: {}),
	};
}

function createController(planning: PlanningState): PlanningToolController {
	return {
		getPlanningState: () => planning,
		updatePlan: async () => planning.plan!,
		submitPlan: async () => planning.plan!,
		updatePlanProgress: async () => planning.plan!,
		requestReplan: async () => planning,
	};
}

const EXECUTION = {
	id: "execution-1",
	approvedRevision: 6,
	strategy: "retain_context" as const,
	sourceSessionId: "source",
	targetSessionId: "target",
};

const EXECUTION_NOTE = "12 fetch tests pass; backoff capped at 8s";

/** An executing plan: three of its six leaves done, its second outcome in progress. */
function createExecutingPlan(): PlanState {
	return {
		id: "plan-execution",
		revision: 12,
		phase: "active",
		title: "Retry transient fetch errors",
		summary: "Retry idempotent requests on transient failures.",
		steps: [
			{ id: "a", text: "Parse config", status: "completed" },
			{
				id: "b",
				text: "Fetch client",
				status: "in_progress",
				substeps: [
					{ id: "b1", text: "Add retry", status: "completed" },
					{ id: "b2", text: "Retry transient errors", status: "completed", note: EXECUTION_NOTE },
					{ id: "b3", text: "Surface retry count", status: "in_progress" },
				],
			},
			{
				id: "c",
				text: "Docs",
				status: "pending",
				substeps: [
					{ id: "c1", text: "Update README", status: "pending" },
					{ id: "c2", text: "Add changelog", status: "pending" },
				],
			},
		],
		execution: EXECUTION,
	};
}

/** The executing plan's checklist as a draft without progress. */
function createDraftPlan(): PlanState {
	const { execution: _execution, ...plan } = createExecutingPlan();
	return {
		...plan,
		revision: 4,
		phase: "draft",
		steps: plan.steps.map(({ note: _note, ...step }) => ({
			...step,
			status: "pending" as const,
			...(step.substeps
				? {
						substeps: step.substeps.map(({ note: _subnote, ...substep }) => ({
							...substep,
							status: "pending" as const,
						})),
					}
				: {}),
		})),
	};
}

function progressArgs(updates: Array<Record<string, unknown>>): Record<string, unknown> {
	return { planId: "plan-execution", expectedRevision: 11, updates };
}

function done(details: unknown, args: Record<string, unknown> = {}): ToolPresentInput {
	return {
		args,
		argsComplete: true,
		state: "done",
		result: { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: false, partial: false },
		cwd: process.cwd(),
	};
}

/** The presentation `presentToolCall` sends for a planning tool: its presenter's own, normalized. */
function presented(name: PlanningToolName, input: ToolPresentInput, maxBytes = PRESENTATION_MAX_SERIALIZED_BYTES) {
	const presentation = presentToolCall(
		{ present: presentPlanning(name), policy: HOST_UI_POLICY },
		name,
		input,
		maxBytes,
	);
	// The generic presentation's title is the bare tool name.
	expect(presentation.title).not.toBe(name);
	return presentation;
}

function nodeText(nodes: readonly UiNode[] | undefined): string {
	return JSON.stringify(nodes ?? []);
}

/** The plain text of the text nodes among `nodes`. */
function texts(nodes: readonly UiNode[] | undefined): string[] {
	return (nodes ?? []).flatMap((node) =>
		node.type === "text"
			? [typeof node.text === "string" ? node.text : node.text.map((span) => span.text).join("")]
			: [],
	);
}

function plainTitle(presentation: ToolPresentation): string {
	return typeof presentation.title === "string"
		? presentation.title
		: presentation.title.map((span) => span.text).join("");
}

function row(name: string, args: Record<string, unknown>) {
	return new PresentedToolComponent(
		name,
		args,
		() => BUILTIN_PRESENTERS,
		{ requestRender: () => undefined } as unknown as TUI,
		process.cwd(),
	);
}

function rendered(component: PresentedToolComponent, width = 120): string {
	const lines = component.render(width).lines;
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	return lines.map(stripAnsi).join("\n");
}

describe("planning tool presenters", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps a draft update that added nothing to its title and shows the checklist on expansion", () => {
		const planning: PlanningState = { mode: "plan", plan: createPlan() };
		const component = row("update_plan", {
			title: planning.plan!.title,
			steps: planning.plan!.steps.map((step) => ({ id: step.id, text: step.text })),
		});
		component.updateResult({
			content: [{ type: "text", text: JSON.stringify({ mode: planning.mode, planId: planning.plan!.id }) }],
			details: planning,
			isError: false,
		});

		const collapsed = rendered(component);
		expect(collapsed).toContain("✓ update plan · 3 steps");
		expect(collapsed).not.toContain("new");
		expect(collapsed).not.toContain("revision");
		expect(collapsed).not.toContain("DRAFT");
		expect(collapsed).not.toContain("planId");
		expect(collapsed).not.toContain("EXPANDED_STEP_TAIL");
		expect(collapsed).not.toContain("Readable planning tools");

		component.setExpanded(true);
		const expanded = rendered(component, 160);
		expect(expanded).not.toContain("revision");
		expect(expanded).toContain("Checklist · 1/3 complete");
		expect(expanded).toContain("EXPANDED_STEP_TAIL");
		expect(expanded).toContain("2 Render the active planning step");
		expect(expanded).not.toContain("complete expanded summary");
		expect(expanded).not.toContain("planId");
		rendered(component, 80);
	});

	it.each([
		{
			name: "update_plan" as const,
			args: {
				title: "Improve the viewer",
				steps: [
					{ text: "Implement wrapping", substeps: [{ text: "Render groups" }, { text: "Render leaves" }] },
					{ text: "Verify" },
				],
			},
			expected: "update plan · 2 outcomes · 3 tasks",
		},
		{
			name: "submit_plan" as const,
			args: { planId: "plan-rendering", expectedRevision: 7, title: "Improve the viewer", summary: "Ready" },
			expected: "submit plan · Improve the viewer",
		},
		{
			name: "update_plan_progress" as const,
			args: {
				planId: "plan-rendering",
				expectedRevision: 7,
				updates: [
					{ id: "step-1", status: "completed" },
					{ id: "step-2", status: "in_progress" },
				],
			},
			expected: "plan progress · 1 done · 1 started",
		},
		{
			name: "request_replan" as const,
			args: { planId: "plan-rendering", expectedRevision: 7, reason: "The implementation\nevidence changed" },
			expected: "request replan · The implementation evidence changed",
		},
	])("titles a $name call from its arguments", ({ name, args, expected }) => {
		const presentation = presented(name, { args, argsComplete: true, state: "pending", cwd: process.cwd() });
		expect(plainTitle(presentation)).toBe(expected);
		expect(presentation.summary).toBeUndefined();
		expect(presentation.body).toBeUndefined();
		expect(rendered(row(name, args))).toContain(`○ ${expected}`);
	});

	it("titles streaming arguments that are incomplete or of the wrong type", () => {
		for (const args of [{}, { steps: null }, { steps: [null, { substeps: "x" }] }, { updates: [7, { status: 1 }] }]) {
			for (const name of ["update_plan", "update_plan_progress", "submit_plan", "request_replan"] as const) {
				const presentation = presented(name, { args, argsComplete: false, state: "pending", cwd: process.cwd() });
				expect(plainTitle(presentation)).toMatch(/^(update plan|plan progress|submit plan|request replan)/);
			}
		}
	});

	it("shows planning errors readably, never as fallback JSON", () => {
		const presentation = presented("update_plan", {
			args: { steps: [] },
			argsComplete: true,
			state: "done",
			result: {
				content: [{ type: "text", text: "Plan changed; apply the latest planning state and retry" }],
				isError: true,
				partial: false,
			},
			cwd: process.cwd(),
		});
		expect(nodeText(presentation.summary)).toContain("Plan changed; apply the latest planning state and retry");
		expect(nodeText(presentation.summary)).toContain('"token":"error"');
		expect(presentation.body).toBeUndefined();

		const empty = presented("submit_plan", {
			args: {},
			argsComplete: true,
			state: "done",
			result: { content: [], isError: true, partial: false },
			cwd: process.cwd(),
		});
		expect(nodeText(empty.summary)).toContain("Planning tool failed");

		const component = row("update_plan", { steps: [] });
		component.updateResult({
			content: [{ type: "text", text: "Plan changed; apply the latest planning state and retry" }],
			isError: true,
		});
		const text = rendered(component);
		expect(text).toContain("✗ update plan");
		expect(text).toContain("Plan changed; apply the latest planning state and retry");
		expect(text).not.toContain("planId");
	});

	it("numbers the checklist's steps and shows their notes", () => {
		const presentation = presented("update_plan", done({ mode: "plan", plan: createPlan() }));
		const steps = presentation.body?.find((node) => node.type === "progress");
		expect(steps).toEqual({
			type: "progress",
			kind: "steps",
			key: "steps:id:step-1",
			steps: [
				{
					key: "id:step-1",
					label: "1 Render the first long planning step without losing EXPANDED_STEP_TAIL",
					status: "done",
					detail: "Confirmed by a focused tool-card test EXPANDED_NOTE_TAIL",
				},
				{ key: "id:step-2", label: "2 Render the active planning step", status: "active" },
				{ key: "id:step-3", label: "3 Render the final pending planning step", status: "pending" },
			],
		});
		expect(nodeText(presentation.body)).not.toContain("revision");
	});

	it("heads a checklist without progress with its size", () => {
		const plan: PlanState = {
			...createPlan(),
			steps: createPlan().steps.map(({ note: _note, ...step }) => ({ ...step, status: "pending" as const })),
		};
		const presentation = presented("update_plan", done({ mode: "plan", plan }));
		expect(texts(presentation.body)).toContain("Checklist · 3 steps");
	});

	it("groups outcomes with substeps under their own titles, in order", () => {
		const plan: PlanState = {
			id: "plan-grouped",
			revision: 2,
			phase: "draft",
			steps: [
				{ id: "a", text: "First outcome", status: "completed" },
				{
					id: "b",
					text: "Grouped outcome",
					status: "in_progress",
					substeps: [
						{ id: "b1", text: "Done part", status: "completed", note: "verified" },
						{ id: "b2", text: "Open part", status: "pending" },
					],
				},
				{ id: "c", text: "Last outcome", status: "pending" },
			],
		};
		const presentation = presented("update_plan", done({ mode: "plan", plan }));
		const progress = (presentation.body ?? []).filter((node) => node.type === "progress");
		expect(progress.map((node) => node.key)).toEqual(["steps:id:a", "outcome:id:b", "steps:id:c"]);
		expect(progress[1]).toMatchObject({
			title: "2 Grouped outcome",
			steps: [
				{ key: "id:b1", label: "2.1 Done part", status: "done", detail: "verified" },
				{ key: "id:b2", label: "2.2 Open part", status: "pending" },
			],
		});
		expect(texts(presentation.body)).toContain("Checklist · 2/4 complete");
	});

	it("shows a submitted plan's status and synopsis collapsed and its title and summary as Markdown expanded", () => {
		const plan: PlanState = {
			...createPlan("ready"),
			summary:
				"Replace serialized state with semantic rendering and retain the complete expanded summary.\n\nSECOND_PARAGRAPH",
		};
		const presentation = presented(
			"submit_plan",
			done(
				{ mode: "plan", plan },
				{ planId: "plan-rendering", expectedRevision: 7, title: "Readable planning tools" },
			),
		);
		expect(plainTitle(presentation)).toBe("submit plan · Readable planning tools");
		expect(presentation.summary).toEqual([
			{
				type: "text",
				key: "status",
				text: [
					{ text: "READY", bold: true, token: "warning" },
					{ text: " · submitted for approval · 3 steps", token: "muted" },
				],
			},
			{
				type: "text",
				key: "synopsis",
				text: "Replace serialized state with semantic rendering and retain the complete expanded summary.",
			},
		]);
		expect(nodeText(presentation.body)).toContain("SECOND_PARAGRAPH");
		expect(texts(presentation.body)).toContain("Checklist · 1/3 complete");
	});

	it("titles a replan with its return to a draft and shows its reason", () => {
		const reason = "The schema changed, so the approved migration order no longer holds. ".repeat(3).trim();
		const replan = presented("request_replan", done({ mode: "plan", plan: createPlan("draft") }, { reason }));
		expect(replan.title).toEqual([
			{ text: "request replan", bold: true },
			{ text: " · ", token: "muted" },
			{ text: "back to draft", token: "warning" },
			{ text: " · 1/3 done", token: "muted" },
		]);
		expect(replan.summary).toEqual([{ type: "text", key: "reason", text: reason }]);
		expect(replan.body).toContainEqual({
			type: "markdown",
			key: "plan",
			markdown:
				"### Readable planning tools\n\nReplace serialized state with semantic rendering and retain the complete expanded summary.",
		});
		expect(texts(replan.body)).toContain("Checklist · 1/3 complete");
	});

	it("shows a draft's title and summary as Markdown only for a submitted or replanned plan", () => {
		const planning: PlanningState = { mode: "plan", plan: createPlan("ready") };
		const presentation = presented("submit_plan", done(planning, { title: "Readable planning tools" }));
		expect(presentation.body).toContainEqual({
			type: "markdown",
			key: "plan",
			markdown:
				"### Readable planning tools\n\nReplace serialized state with semantic rendering and retain the complete expanded summary.",
		});

		const draft = presented("update_plan", done({ mode: "plan", plan: createPlan() }));
		expect(nodeText(draft.body)).not.toContain("complete expanded summary");
	});

	it("shows no plan, and planning details it cannot read, as no active plan", () => {
		for (const details of [{ mode: "plan", plan: null }, { mode: "plan", plan: { id: 3 } }, "garbage", undefined]) {
			const presentation = presented("update_plan", done(details));
			expect(presentation.summary).toEqual([
				{ type: "text", key: "status", text: "No active plan", token: "muted" },
			]);
			expect(presentation.body).toBeUndefined();
		}
	});

	it("bounds a large plan's checklist within the remote bound and counts what it leaves out", () => {
		// Within the 128 KB planning state bound: 200 outcomes of two substeps each.
		const plan: PlanState = {
			id: "plan-large",
			revision: 1,
			phase: "draft",
			title: "T".repeat(300),
			summary: "S".repeat(4_000),
			steps: Array.from({ length: 200 }, (_, index) => ({
				id: `outcome-${index}`,
				text: `Outcome ${index} ${"o".repeat(100)}`,
				status: "pending" as const,
				substeps: Array.from({ length: 2 }, (_, subindex) => ({
					id: `substep-${index}-${subindex}`,
					text: `Substep ${subindex} ${"s".repeat(100)}`,
					status: "pending" as const,
				})),
			})),
		};
		expect(JSON.stringify(plan).length).toBeLessThan(128 * 1024);
		const planning: PlanningState = { mode: "plan", plan };
		const input = done(planning, { title: plan.title, summary: plan.summary });
		const local = presented("submit_plan", input);
		const remote = presented("submit_plan", input, PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES);
		expect(serializedBytes(local)).toBeLessThanOrEqual(PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES);
		expect(remote).toEqual(local);
		const more = local.body?.at(-1);
		expect(more).toMatchObject({ type: "text", key: "more", token: "muted" });
		expect(nodeText([more as UiNode])).toMatch(/… \d+ more items/);
		expect(texts(local.body)).toContain("Checklist · 200 outcomes · 400 tasks");
		expect(nodeText(local.summary)).toContain("DRAFT");
	});

	it("bounds a checklist by its encoded size, so a plan in a non-Latin script fits the remote bound too", () => {
		const plan: PlanState = {
			id: "plan-wide",
			revision: 1,
			phase: "draft",
			title: "計画",
			summary: "概要",
			steps: Array.from({ length: 200 }, (_, index) => ({
				id: `outcome-${index}`,
				text: `成果 ${index} ${"語".repeat(100)}`,
				status: "pending" as const,
			})),
		};
		const input = done({ mode: "plan", plan } satisfies PlanningState, { title: plan.title, summary: plan.summary });
		const remote = presented("submit_plan", input, PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES);
		expect(serializedBytes(remote)).toBeLessThanOrEqual(PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES);
		expect(texts(remote.body)).toContain("Checklist · 200 steps");
	});

	it("names a single progress update in its title and shows its note, never the phase or revision", () => {
		const planning: PlanningState = { mode: "build", plan: createExecutingPlan() };
		const args = progressArgs([{ id: " b2 ", status: "completed", note: EXECUTION_NOTE }]);
		const presentation = presented("update_plan_progress", done(planning, args));
		expect(presentation.title).toEqual([
			{ text: "plan progress", bold: true },
			{ text: " · ", token: "muted" },
			{ text: "done", token: "success" },
			{ text: " 2.2", token: "muted" },
			{ text: " Retry transient errors" },
			{ text: " · ", token: "muted" },
			{ text: "3/6", token: "muted" },
		]);
		expect(presentation.summary).toEqual([{ type: "text", key: "note", text: EXECUTION_NOTE, token: "muted" }]);
		// Expanded: the note, then the checklist with only the outcome the update touched open.
		expect(presentation.body).toEqual([
			{ type: "text", key: "note", text: EXECUTION_NOTE, token: "muted" },
			{
				type: "text",
				key: "checklist",
				text: [
					{ text: "Checklist", bold: true },
					{ text: " · 3/6 complete", token: "muted" },
				],
			},
			{
				type: "progress",
				kind: "steps",
				key: "steps:id:a",
				steps: [{ key: "id:a", label: "1 Parse config", status: "done" }],
			},
			{
				type: "progress",
				kind: "steps",
				key: "outcome:id:b",
				title: "2 Fetch client",
				steps: [
					{ key: "id:b1", label: "2.1 Add retry", status: "done" },
					{
						key: "id:b2",
						label: "2.2 Retry transient errors",
						status: "done",
						detail: EXECUTION_NOTE,
					},
					{ key: "id:b3", label: "2.3 Surface retry count", status: "active" },
				],
			},
			{
				type: "progress",
				kind: "steps",
				key: "steps:id:c",
				steps: [{ key: "id:c", label: "3 Docs", status: "pending", detail: "0/2 tasks" }],
			},
		]);

		const component = row("update_plan_progress", args);
		component.updateResult({ content: [{ type: "text", text: "{}" }], details: planning, isError: false });
		const collapsed = rendered(component, 80);
		expect(collapsed).toContain("✓ plan progress · done 2.2 Retry transient errors · 3/6");
		expect(collapsed).toContain("backoff capped at 8s");
		expect(collapsed).not.toMatch(/EXECUTING|revision|Checklist/);
	});

	it("keeps a routine progress update without a note to its title", () => {
		const planning: PlanningState = { mode: "build", plan: createExecutingPlan() };
		const presentation = presented(
			"update_plan_progress",
			done(planning, progressArgs([{ id: "b3", status: "in_progress" }])),
		);
		expect(plainTitle(presentation)).toBe("plan progress · started 2.3 Surface retry count · 3/6");
		expect(presentation.summary).toBeUndefined();
		expect(texts(presentation.body)).toContain("Checklist · 3/6 complete");
	});

	it("calls a progress update that returns an item to pending a reopening", () => {
		const plan = createExecutingPlan();
		const reopened: PlanState = {
			...plan,
			steps: plan.steps.map((step) => (step.id === "a" ? { ...step, status: "pending" as const } : step)),
		};
		const presentation = presented(
			"update_plan_progress",
			done({ mode: "build", plan: reopened }, progressArgs([{ id: "a", status: "pending" }])),
		);
		expect(presentation.title).toContainEqual({ text: "reopened", token: "warning" });
		expect(plainTitle(presentation)).toBe("plan progress · reopened 1 Parse config · 2/6");
	});

	it("lists several progress updates, finished work first, and calls out an outcome they complete", () => {
		const plan = createExecutingPlan();
		const moved: PlanState = {
			...plan,
			steps: [
				plan.steps[0]!,
				{
					...plan.steps[1]!,
					status: "completed",
					substeps: plan.steps[1]!.substeps!.map((substep) => ({ ...substep, status: "completed" as const })),
				},
				{
					...plan.steps[2]!,
					status: "in_progress",
					substeps: [{ ...plan.steps[2]!.substeps![0]!, status: "in_progress" }, plan.steps[2]!.substeps![1]!],
				},
			],
		};
		const args = progressArgs([
			{ id: "c1", status: "in_progress" },
			{ id: "b2", status: "completed", note: EXECUTION_NOTE },
			{ id: "b3", status: "completed" },
		]);
		const presentation = presented("update_plan_progress", done({ mode: "build", plan: moved }, args));
		expect(plainTitle(presentation)).toBe("plan progress · 2 done · 1 started · 4/6");
		expect(presentation.summary).toEqual([
			{
				type: "progress",
				kind: "steps",
				key: "changes",
				steps: [
					{
						key: "id:b2",
						label: "2.2 Fetch client › Retry transient errors",
						status: "done",
						detail: EXECUTION_NOTE,
					},
					{ key: "id:b3", label: "2.3 Fetch client › Surface retry count", status: "done" },
					{ key: "id:c1", label: "3.1 Docs › Update README", status: "active" },
				],
			},
			{
				type: "text",
				key: "milestone:id:b",
				text: [
					{ text: "Outcome 2 complete", bold: true, token: "success" },
					{ text: " · Fetch client", token: "muted" },
				],
			},
		]);
		// Both touched outcomes open in the expanded checklist; the untouched one stays one step.
		const groups = (presentation.body ?? []).filter((node) => node.type === "progress").map((node) => node.key);
		expect(groups).toEqual(["changes", "steps:id:a", "outcome:id:b", "outcome:id:c"]);
	});

	it("marks the progress update that completes the plan", () => {
		const plan = createExecutingPlan();
		const complete: PlanState = {
			...plan,
			phase: "completed",
			steps: plan.steps.map((step) => ({
				...step,
				status: "completed" as const,
				...(step.substeps
					? { substeps: step.substeps.map((substep) => ({ ...substep, status: "completed" as const })) }
					: {}),
			})),
		};
		const presentation = presented(
			"update_plan_progress",
			done({ mode: "build", plan: complete }, progressArgs([{ id: "c2", status: "completed" }])),
		);
		expect(presentation.title).toContainEqual({ text: "COMPLETE 6/6", bold: true, token: "success" });
		expect(plainTitle(presentation)).toBe("plan progress · done 3.2 Add changelog · COMPLETE 6/6");
		expect(texts(presentation.summary)).toEqual(["Outcome 3 complete · Docs"]);
	});

	it("bounds a progress update of a large plan within the remote bound and counts what it leaves out", () => {
		const plan: PlanState = {
			id: "plan-large",
			revision: 40,
			phase: "completed",
			execution: EXECUTION,
			steps: Array.from({ length: 200 }, (_, index) => ({
				id: `outcome-${index}`,
				text: `Outcome ${index} ${"o".repeat(100)}`,
				status: "completed" as const,
				substeps: Array.from({ length: 2 }, (_, subindex) => ({
					id: `substep-${index}-${subindex}`,
					text: `Substep ${subindex} ${"s".repeat(100)}`,
					status: "completed" as const,
				})),
			})),
		};
		expect(JSON.stringify(plan).length).toBeLessThan(128 * 1024);
		const updates = plan.steps.flatMap((step) =>
			(step.substeps ?? []).map((substep) => ({ id: substep.id, status: "completed" })),
		);
		const input = done({ mode: "build", plan } satisfies PlanningState, progressArgs(updates));
		const local = presented("update_plan_progress", input);
		const remote = presented("update_plan_progress", input, PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES);
		expect(serializedBytes(local)).toBeLessThanOrEqual(PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES);
		expect(remote).toEqual(local);
		expect(plainTitle(local)).toBe("plan progress · 400 done · COMPLETE 400/400");
		const listed = local.summary?.find((node) => node.type === "progress");
		expect(listed?.type === "progress" && listed.kind === "steps" ? listed.steps.length : 0).toBeLessThanOrEqual(8);
		expect(texts(local.summary).some((text) => /^… \d+ more updates$/.test(text))).toBe(true);
		expect(texts(local.summary)).toContain("… 192 more outcomes complete");
		expect(nodeText(local.body)).toMatch(/… \d+ more items/);
	});

	it("titles a new draft with its size and lists its title and outcomes", () => {
		const plan: PlanState = { ...createDraftPlan(), revision: 1 };
		const presentation = presented("update_plan", done({ mode: "plan", plan }, { steps: [] }));
		expect(plainTitle(presentation)).toBe("update plan · new draft · 3 outcomes · 6 tasks");
		expect(presentation.summary).toEqual([
			{ type: "text", key: "plan-title", text: [{ text: "Retry transient fetch errors", bold: true }] },
			{
				type: "progress",
				kind: "steps",
				key: "outcomes",
				steps: [
					{ key: "id:a", label: "1 Parse config", status: "pending" },
					{ key: "id:b", label: "2 Fetch client", status: "pending", detail: "0/3 tasks" },
					{ key: "id:c", label: "3 Docs", status: "pending", detail: "0/2 tasks" },
				],
			},
		]);
		// Expanded, the outcomes show once, in the checklist.
		const keys = (presentation.body ?? []).map((node) => node.key);
		expect(keys).toEqual(["plan-title", "checklist", "steps:id:a", "outcome:id:b", "outcome:id:c"]);
	});

	it("counts and lists the items a draft update added", () => {
		const draft = createDraftPlan();
		const plan: PlanState = {
			...draft,
			steps: [
				draft.steps[0]!,
				{ id: "fresh", text: "Handle rate limits", status: "pending" },
				{
					...draft.steps[2]!,
					substeps: [draft.steps[2]!.substeps![0]!, { id: "c3", text: "Document the flag", status: "pending" }],
				},
			],
		};
		const args = {
			planId: plan.id,
			expectedRevision: 3,
			steps: [
				{ id: " a ", text: "Parse config" },
				// An id the plan did not keep is a new item too.
				{ id: "gone", text: "Handle rate limits" },
				{ id: "c", text: "Docs", substeps: [{ id: "c1", text: "Update README" }, { text: "Document the flag" }] },
			],
		};
		const presentation = presented("update_plan", done({ mode: "plan", plan }, args));
		expect(plainTitle(presentation)).toBe("update plan · 3 outcomes · 4 tasks · 2 new");
		expect(presentation.summary).toEqual([
			{
				type: "progress",
				kind: "steps",
				key: "added",
				steps: [
					{ key: "id:fresh", label: "2 Handle rate limits", status: "pending" },
					{ key: "id:c3", label: "3.2 Docs › Document the flag", status: "pending" },
				],
			},
		]);
	});

	it("still serializes the canonical planning state for the model", async () => {
		const planning: PlanningState = { mode: "plan", plan: createPlan() };
		const definition = createPlanningToolDefinitions(createController(planning))[0];
		const result = await definition.execute(
			"plan-tool-payload",
			{ title: "Readable planning tools", steps: [{ text: "Render semantic cards" }] },
			undefined,
			undefined,
			{} as never,
		);
		const content = result.content[0];
		expect(content?.type).toBe("text");
		if (content?.type !== "text") throw new Error("Expected text planning result");
		expect(JSON.parse(content.text)).toMatchObject({
			mode: "plan",
			planId: "plan-rendering",
			revision: 7,
			phase: "draft",
		});
	});

	it("is the presenter the planning tool definitions carry", () => {
		const planning: PlanningState = { mode: "plan", plan: createPlan() };
		const definitions = createPlanningToolDefinitions(createController(planning));
		for (const definition of definitions) {
			expect(definition.present).toBeDefined();
			const input = done(planning);
			const present = definition.present as ToolPresenter | undefined;
			expect(present?.(input)).toEqual(BUILTIN_PRESENTERS.tool(definition.name)?.present(input));
		}
	});
});
