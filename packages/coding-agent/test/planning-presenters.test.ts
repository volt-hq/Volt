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

	it("keeps a draft update collapsed to its status and shows the checklist on expansion", () => {
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
		expect(collapsed).toContain("DRAFT · revision 7 · 1/3 complete");
		expect(collapsed).not.toContain("planId");
		expect(collapsed).not.toContain("EXPANDED_STEP_TAIL");
		expect(collapsed).not.toContain("Readable planning tools");

		component.setExpanded(true);
		const expanded = rendered(component, 160);
		expect(expanded).toContain("DRAFT · revision 7");
		expect(expanded).toContain("Checklist · 1/3 complete");
		expect(expanded).toContain("EXPANDED_STEP_TAIL");
		expect(expanded).toContain("Render the active planning step");
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
			expected: "update plan progress · 1 completed · 1 in progress",
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
				expect(plainTitle(presentation)).toMatch(/^(update plan|update plan progress|submit plan|request replan)/);
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

	it.each(["draft", "ready", "active", "completed"] as const)("presents a %s plan's phase and checklist", (phase) => {
		const planning: PlanningState = {
			mode: phase === "draft" || phase === "ready" ? "plan" : "build",
			plan: createPlan(phase),
		};
		const presentation = presented("update_plan_progress", done(planning));
		const label = { draft: "DRAFT", ready: "READY", active: "EXECUTING", completed: "COMPLETE" }[phase];
		const token = { draft: "muted", ready: "warning", active: "accent", completed: "success" }[phase];
		expect(presentation.summary).toEqual([
			{
				type: "text",
				key: "status",
				text: [
					{ text: label, bold: true, token },
					{ text: " · revision 7 · 1/3 complete", token: "muted" },
				],
			},
		]);
		const steps = presentation.body?.find((node) => node.type === "progress");
		expect(steps).toEqual({
			type: "progress",
			kind: "steps",
			key: "steps:id:step-1",
			steps: [
				{
					key: "id:step-1",
					label: "Render the first long planning step without losing EXPANDED_STEP_TAIL",
					status: "done",
					detail: "Confirmed by a focused tool-card test EXPANDED_NOTE_TAIL",
				},
				{ key: "id:step-2", label: "Render the active planning step", status: "active" },
				{ key: "id:step-3", label: "Render the final pending planning step", status: "pending" },
			],
		});
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
			title: "Grouped outcome",
			steps: [
				{ key: "id:b1", label: "Done part", status: "done", detail: "verified" },
				{ key: "id:b2", label: "Open part", status: "pending" },
			],
		});
		expect(texts(presentation.body)).toContain("Checklist · 2/4 complete");
	});

	it("shows a submitted plan's title collapsed and its title and summary as Markdown expanded", () => {
		const planning: PlanningState = { mode: "plan", plan: createPlan("ready") };
		const presentation = presented(
			"submit_plan",
			done(planning, { planId: "plan-rendering", expectedRevision: 7, title: "Readable planning tools" }),
		);
		expect(nodeText(presentation.summary)).toContain("Readable planning tools");
		expect(nodeText(presentation.summary)).not.toContain("complete expanded summary");
		expect(presentation.body).toContainEqual({
			type: "markdown",
			key: "plan",
			markdown:
				"### Readable planning tools\n\nReplace serialized state with semantic rendering and retain the complete expanded summary.",
		});

		const replan = presented(
			"request_replan",
			done({ mode: "plan", plan: createPlan("draft") }, { reason: "The schema changed" }),
		);
		expect(nodeText(replan.body)).toContain("Reason: The schema changed");
		expect(nodeText(replan.body)).toContain("### Readable planning tools");
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
		expect(texts(local.body)).toContain("Checklist · 0/400 complete");
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
		expect(texts(remote.body)).toContain("Checklist · 0/200 complete");
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
