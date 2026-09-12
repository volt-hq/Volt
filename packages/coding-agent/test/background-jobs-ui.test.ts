import type { AgentToolResult, AgentToolUpdateCallback } from "@hansjm10/volt-agent-core";
import {
	createRenderFrame,
	getCapabilities,
	getKeybindings,
	setCapabilities,
	setKeybindings,
	type TUI,
	visibleWidth,
} from "@hansjm10/volt-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BackgroundJobManager,
	type BackgroundJobSnapshot,
	type BackgroundJobSummary,
} from "../src/core/background-jobs.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { initTheme, theme } from "../src/core/theme/runtime.ts";
import { backgroundJobResult, withBackgroundJobs } from "../src/core/tools/background.ts";
import * as backgroundRendering from "../src/core/tools/background-render.ts";
import { BackgroundJobView } from "../src/core/tools/background-render.ts";
import { backgroundWaitResult } from "../src/core/tools/background-wait.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createJobsTool, createJobsToolDefinition } from "../src/core/tools/jobs.ts";
import { BackgroundJobsInspector, BackgroundJobsStatus } from "../src/modes/interactive/components/background-jobs.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const previousBindings = getKeybindings();
const cleanup: (() => void | Promise<void>)[] = [];

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(async () => {
	for (const dispose of cleanup.reverse()) await dispose();
	cleanup.length = 0;
	setKeybindings(previousBindings);
	vi.useRealTimers();
});

function setup() {
	const manager = new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 });
	cleanup.push(() => manager.close());
	return manager;
}

function start(manager: BackgroundJobManager, label = "vitest --run test/background-jobs.test.ts") {
	let update!: AgentToolUpdateCallback<unknown>;
	let finish!: (result: AgentToolResult<unknown>) => void;
	const result = new Promise<AgentToolResult<unknown>>((resolve) => {
		finish = resolve;
	});
	const job = manager.start({
		toolName: "bash",
		toolCallId: label,
		label,
		execute: async (_signal, onUpdate) => {
			update = onUpdate;
			return result;
		},
	});
	cleanup.push(() => finish({ content: [] }));
	return { job, output: (text: string) => update({ content: [{ type: "text", text }] }), finish };
}

function text(component: { render: (width: number) => { lines: readonly string[] } }, width = 80): string {
	const frame = component.render(width);
	for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	return frame.lines.map(stripAnsi).join("\n");
}

function inspector(manager: BackgroundJobManager, height = 24) {
	const requestRender = vi.fn();
	const onClose = vi.fn();
	const component = new BackgroundJobsInspector(manager, { getHeight: () => height, requestRender, onClose });
	cleanup.push(() => component.dispose());
	return { component, requestRender, onClose };
}

function tool(manager: BackgroundJobManager, job: BackgroundJobSnapshot, name: "bash" | "jobs", live = true) {
	const definition =
		name === "bash"
			? withBackgroundJobs(createBashToolDefinition(process.cwd()), { manager })
			: createJobsToolDefinition({ manager });
	const component = new ToolExecutionComponent(
		name,
		job.toolCallId,
		name === "bash" ? { command: job.label, background: true } : { action: "wait", ids: [job.id] },
		{ liveProgress: live },
		definition,
		{ requestRender: () => {} } as unknown as TUI,
		process.cwd(),
	);
	cleanup.push(() => component.dispose());
	component.markExecutionStarted();
	return component;
}

describe("background job cards", () => {
	it("caches immutable views until width or presentation changes, while live views remain fresh", () => {
		let value = "first";
		const draw = vi.fn(() => createRenderFrame([value]));
		const cached = new BackgroundJobView(draw, true);
		expect(text(cached)).toBe("first");
		value = "next";
		expect(text(cached)).toBe("first");
		expect(draw).toHaveBeenCalledTimes(1);
		expect(text(cached, 40)).toBe("next");
		expect(draw).toHaveBeenCalledTimes(2);
		value = "updated";
		cached.invalidate();
		expect(text(cached, 40)).toBe("updated");
		expect(draw).toHaveBeenCalledTimes(3);
		const live = new BackgroundJobView(draw);
		expect(text(live)).toBe("updated");
		value = "live update";
		expect(text(live)).toBe("live update");
	});

	it.each([undefined, null, true, 42, "preview", []])(
		"renders unvalidated argument previews and recovers: %j",
		(args) => {
			const card = new ToolExecutionComponent(
				"jobs",
				"streamed-arguments",
				args,
				{},
				createJobsToolDefinition(),
				{ requestRender: () => {} } as unknown as TUI,
				process.cwd(),
			);
			cleanup.push(() => card.dispose());
			for (const width of [20, 80]) expect(text(card, width).replace(/\s+/g, " ")).toContain("background job");
			card.updateArgs({ action: "list" });
			card.setArgsComplete();
			expect(text(card)).toContain("Listing background jobs");
			card.updateArgs(args);
			expect(text(card)).toContain("background job");
			card.updateResult({ content: [{ type: "text", text: "Arguments must be an object" }], isError: true });
			expect(text(card)).toContain("Job inspection failed");
			expect(text(card)).toContain("Arguments must be an object");
		},
	);

	it("shows the named worker, actual job duration, output, and completion instead of tool success", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const manager = setup();
		const work = start(manager);
		await Promise.resolve();
		const card = tool(manager, work.job, "bash");
		card.updateResult({ ...backgroundJobResult(work.job), isError: false });
		expect(text(card)).toContain("No output yet");
		work.output("old line\nPASS cancellation\nPASS snapshots\nTests 12 passed (12)\n");
		vi.setSystemTime(19_000);
		let rendered = text(card);
		expect(rendered).toContain("Running · 18.0s");
		expect(rendered).toContain(work.job.label);
		expect(rendered).toContain("Tests 12 passed (12)");
		expect(rendered).toContain("Last output 18.0s ago");
		expect(rendered).not.toContain("old line");
		expect(rendered).not.toContain("[success]");
		expect(rendered).not.toContain("Use jobs with action");
		work.finish({ content: [{ type: "text", text: "Tests 12 passed (12)" }] });
		await manager.wait([work.job.id]);
		rendered = text(card);
		expect(rendered).toContain("Completed · 18.0s");
		vi.setSystemTime(30_000);
		expect(text(card)).toBe(rendered);
	});

	it("caches expanded settled launch output until width or presentation changes", async () => {
		const manager = setup();
		const work = start(manager);
		await Promise.resolve();
		const card = tool(manager, work.job, "bash");
		card.updateResult({ ...backgroundJobResult(work.job), isError: false });
		const log = Array.from({ length: 400 }, (_, index) => `${index}: ${"x".repeat(100)}`).join("\n");
		work.finish({ content: [{ type: "text", text: log }] });
		await manager.wait([work.job.id]);
		card.invalidate();
		card.setExpanded(true);
		const rendered = text(card);
		expect(rendered).toContain("399:");
		const draw = vi.spyOn(backgroundRendering, "renderBackgroundJobCard");
		cleanup.push(() => draw.mockRestore());
		for (let index = 0; index < 5; index++) expect(text(card)).toBe(rendered);
		expect(draw).not.toHaveBeenCalled();
		text(card, 40);
		expect(draw).toHaveBeenCalledOnce();
		card.invalidate();
		text(card, 40);
		expect(draw).toHaveBeenCalledTimes(2);
		card.setExpanded(false);
		text(card, 40);
		expect(draw).toHaveBeenCalledTimes(3);
	});

	it("renders waits with the target job and does not report success when the wait expires", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const manager = setup();
		const work = start(manager);
		await Promise.resolve();
		work.output("PASS job lifecycle");
		vi.setSystemTime(19_000);
		const card = tool(manager, work.job, "jobs");
		expect(text(card)).toContain("Waiting for background job");
		expect(text(card)).toContain("18.0s");
		expect(text(card)).toContain("PASS job lifecycle");
		const native = createJobsTool({ manager });
		card.updateResult({
			...(await native.execute("expired-wait", { action: "wait", ids: [work.job.id], timeoutMs: 0 })),
			isError: false,
		});
		expect(text(card)).toContain("timeout");
		expect(text(card)).toContain("1 pending");
		expect(text(card)).not.toContain("[success]");
		expect(text(card)).not.toContain("Running jobs");
		card.setExpanded(true);
		expect(text(card)).toContain("Running at capture");
		expect(text(card)).not.toContain("PASS job lifecycle");
		card.setExpanded(false);
		const captured = text(card);
		work.finish({
			content: [{ type: "text", text: "FAIL cancellation\nCommand exited with code 1" }],
			isError: true,
		});
		await manager.wait([work.job.id]);
		expect(text(card)).toBe(captured);
		card.updateResult({
			...(await native.execute("terminal-wait", { action: "wait", ids: [work.job.id] })),
			isError: true,
		});
		expect(text(card)).toContain("failed");
		expect(text(card)).not.toContain("Command exited with code 1");
		card.setExpanded(true);
		expect(text(card)).toContain("Command exited with code 1");
	});

	it.each(["read", "wait", "cancel"] as const)(
		"collapses %s snapshots into one row without repeating output",
		(action) => {
			setKeybindings(new KeybindingsManager({ "app.tools.expand": "f6" }));
			const card = new ToolExecutionComponent(
				"jobs",
				"snapshot",
				action === "wait" ? { action, ids: ["job_12345678"] } : { action, id: "job_12345678" },
				{},
				createJobsToolDefinition(),
				{ requestRender: () => {} } as unknown as TUI,
				process.cwd(),
			);
			cleanup.push(() => card.dispose());
			for (const status of ["running", "cancelling", "completed", "failed", "cancelled"] as const) {
				const active = status === "running" || status === "cancelling";
				const snapshot: BackgroundJobSnapshot = {
					id: "job_12345678",
					toolCallId: "launch",
					toolName: "bash",
					label: "DO NOT REPEAT COMMAND",
					status,
					startedAt: 1000,
					...(active ? {} : { endedAt: 1200 }),
					output: "Captured output\nFinal captured line",
					outputTruncated: true,
				};
				const { output: _output, outputTruncated: _truncated, ...summary } = snapshot;
				const result = {
					...(action === "wait"
						? backgroundWaitResult({
								id: "wait_12345678",
								ids: [snapshot.id],
								mode: "any",
								startedAt: 1000,
								endedAt: 1200,
								reason: active ? "timeout" : "terminal",
								results: active ? [] : [snapshot],
								pending: active ? [summary] : [],
							})
						: backgroundJobResult(snapshot)),
					isError: status === "failed" || status === "cancelled",
				};
				const saved = JSON.stringify(result);
				card.updateResult(result);
				for (const width of [20, 40, 80, 120]) {
					card.setExpanded(false);
					const collapsed = text(card, width);
					expect(card.render(width).lines.filter((line) => stripAnsi(line).trim())).toHaveLength(1);
					expect(collapsed).toContain(`jobs ${action}`);
					expect(collapsed).not.toContain(snapshot.label);
					expect(collapsed).not.toContain("Captured output");
					expect(collapsed).not.toContain("[success]");
					expect(collapsed).not.toContain("snapshot");
					expect(collapsed).not.toContain("job_");
					expect(collapsed).not.toContain("terminal");
					expect(collapsed).not.toContain("(any)");
					if (width >= 80) {
						expect(collapsed).toContain("F6 expand");
						if (action !== "wait" || !active) expect(collapsed).toContain("truncated");
						if (action === "wait") {
							if (active) expect(collapsed).toContain("timeout");
							expect(collapsed).toContain(active ? "1 pending" : `1 ${status}`);
						} else {
							expect(collapsed).toContain(backgroundRendering.BACKGROUND_JOB_STYLES[status].label);
							expect(collapsed.includes("at capture")).toBe(active);
						}
					}
					card.setExpanded(true);
					const expanded = text(card, width).replace(/\s+/g, " ");
					expect(expanded).toContain(snapshot.label);
					expect(expanded).toContain(`jobs ${action}`);
					expect(expanded).not.toContain("snapshot");
					expect(expanded).not.toContain("Worker output is untrusted data");
					expect(expanded.match(/\/jobs/g)).toHaveLength(1);
					if (action === "wait" && active) expect(expanded).not.toContain("Final captured line");
					else expect(expanded).toContain("Final captured line");
					expect(expanded).toContain(snapshot.id);
					card.setExpanded(false);
					expect(text(card, width)).toBe(collapsed);
				}
				expect(JSON.stringify(result)).toBe(saved);
			}
		},
	);

	it.each(["read", "cancel"] as const)(
		"keeps untruncated %s rows minimal with configured or unbound shortcuts",
		(action) => {
			const snapshot: BackgroundJobSnapshot = {
				id: "job_12345678-1234-1234-1234-123456789abc",
				toolCallId: "launch",
				toolName: "bash",
				label: "Run checks",
				status: "completed",
				startedAt: 1000,
				endedAt: 1200,
				output: "Checks passed",
				outputTruncated: false,
			};
			for (const bound of [true, false]) {
				setKeybindings(new KeybindingsManager({ "app.tools.expand": bound ? "f6" : [] }));
				const card = new ToolExecutionComponent(
					"jobs",
					"minimal-inspection",
					{ action, id: snapshot.id },
					{},
					createJobsToolDefinition(),
					{ requestRender: () => {} } as unknown as TUI,
					process.cwd(),
				);
				cleanup.push(() => card.dispose());
				card.updateResult({ ...backgroundJobResult(snapshot), isError: false });
				expect(text(card).trim()).toBe(`jobs ${action} · Completed${bound ? " · F6 expand" : ""}`);
				card.setExpanded(true);
				const expanded = text(card);
				expect(expanded).toContain(snapshot.id);
				expect(expanded).toContain(snapshot.output);
				expect(expanded).not.toContain("snapshot");
				expect(expanded.match(/\/jobs/g)).toHaveLength(1);
			}
		},
	);

	it.each(["any", "all"] as const)("keeps meaningful multi-job wait details in %s mode", (mode) => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "f6" }));
		const results: BackgroundJobSnapshot[] = (["completed", "failed", "cancelled"] as const).map((status, index) => ({
			id: `job_result-${index}`,
			toolCallId: `launch-${index}`,
			toolName: "bash",
			label: `Command ${index}`,
			status,
			startedAt: 1000,
			endedAt: 1200,
			output: `\x1b[2J\x1b]8;;https://example.com\x07**Output ${index}**\x1b]8;;\x07\u202e`,
			outputTruncated: index === 1,
		}));
		const pending: BackgroundJobSummary[] = [
			{
				id: "job_pending",
				toolCallId: "pending-launch",
				toolName: "subagent",
				label: "Pending task",
				status: "running",
				startedAt: 1000,
			},
		];
		const ids = [...results, ...pending].map((job) => job.id);
		const card = new ToolExecutionComponent(
			"jobs",
			"multi-wait",
			{ action: "wait", ids, mode },
			{},
			createJobsToolDefinition(),
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		cleanup.push(() => card.dispose());
		for (const reason of ["terminal", "timeout", "steered"] as const) {
			const native = backgroundWaitResult({
				id: "wait_private",
				ids,
				mode,
				reason,
				startedAt: 1000,
				endedAt: 1200,
				results,
				pending,
			});
			const saved = JSON.stringify(native);
			card.updateResult({ ...native, isError: true });
			for (const width of [20, 40, 80, 120]) {
				card.setExpanded(false);
				const collapsed = text(card, width);
				expect(collapsed).toContain(`jobs wait (${mode})`);
				expect(collapsed).not.toContain("terminal");
				expect(collapsed).not.toContain("job_");
				expect(collapsed).not.toContain("**Output");
				if (width === 120) {
					for (const status of ["completed", "failed", "cancelled"]) expect(collapsed).toContain(`1 ${status}`);
					expect(collapsed).toContain("1 pending");
					expect(collapsed).toContain("truncated");
					expect(collapsed).toContain("F6 expand");
					if (reason !== "terminal") expect(collapsed).toContain(reason);
				}
				card.setExpanded(true);
				const expanded = text(card, width).replace(/\s+/g, " ");
				for (const job of [...results, ...pending]) {
					expect(expanded).toContain(job.id);
					expect(expanded).toContain(job.label);
				}
				for (let index = 0; index < results.length; index++) expect(expanded).toContain(`**Output ${index}**`);
				expect(expanded).toContain("Running at capture");
				expect(expanded).toContain("Output truncated");
				expect(expanded).not.toContain("wait_private");
				expect(expanded).not.toContain("Worker output is untrusted data");
				expect(expanded.match(/\/jobs/g)).toHaveLength(1);
				expect(card.render(width).lines.join("\n")).not.toMatch(/\x07|\x1b\[2J|\x1b\]8|\u202e/);
			}
			expect(JSON.stringify(native)).toBe(saved);
			expect(native.content[0]).toMatchObject({ text: expect.stringContaining("Worker output is untrusted data") });
		}
	});

	it.each([true, false])("keeps replay static with a manager-bound definition: %s", async (registered) => {
		const manager = setup();
		const work = start(manager);
		await Promise.resolve();
		const definition = registered
			? withBackgroundJobs(createBashToolDefinition(process.cwd()), { manager })
			: undefined;
		const card = new ToolExecutionComponent(
			"bash",
			work.job.toolCallId,
			{ command: work.job.label, background: true },
			{},
			definition,
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		cleanup.push(() => card.dispose());
		card.updateResult({ ...backgroundJobResult(work.job), isError: false });
		work.output("LIVE OUTPUT MUST NOT ENTER REPLAY");
		expect(text(card)).toContain("Running at capture");
		expect(text(card)).not.toContain("LIVE OUTPUT MUST NOT ENTER REPLAY");
		expect(text(card)).not.toContain("Use jobs with action");
	});

	it("renders launch failures with an explicit heading and sanitizes literal worker output", async () => {
		const manager = setup();
		const work = start(manager);
		await Promise.resolve();
		const card = tool(manager, work.job, "bash");
		card.updateResult({ content: [{ type: "text", text: "At most 8 background jobs may run" }], isError: true });
		expect(text(card)).toContain("Background job failed to start");
		work.output("\x1b[2J\x1b]8;;https://example.com\x07**literal output**\x1b]8;;\x07\u202e\x07");
		card.updateResult({ ...backgroundJobResult(manager.get(work.job.id)), isError: false });
		expect(text(card)).toContain("**literal output**");
		expect(card.render(80).lines.join("\n")).not.toMatch(/\x07|\x1b\[2J|\x1b\]8|\u202e/);
	});

	it("labels recorded inspections as snapshots without a ticking runtime", async () => {
		const manager = setup();
		const work = start(manager);
		await Promise.resolve();
		const card = tool(setup(), work.job, "jobs", false);
		card.updateArgs({ action: "read", id: work.job.id });
		card.updateResult({ ...backgroundJobResult(work.job), isError: false });
		expect(text(card)).toContain("Running at capture");
		expect(text(card)).not.toContain("snapshot");
		expect(text(card)).not.toContain("Last output");
	});

	it.each([20, 40, 80, 120])("bounds previews and expands retained output and IDs at %i columns", async (width) => {
		const manager = setup();
		const work = start(manager, "npm run check --workspace packages/coding-agent");
		await Promise.resolve();
		work.output(
			`\x1b[2J\x1b]8;;https://example.com\x07**literal**\x1b]8;;\x07\n${"界".repeat(120)}\n${"line\n".repeat(3000)}`,
		);
		const card = tool(manager, work.job, "bash");
		card.updateResult({ ...backgroundJobResult(manager.get(work.job.id)), isError: false });
		expect(text(card, width)).not.toContain(work.job.id);
		expect(text(card, width).replace(/\s+/g, " ")).toContain("Retained output truncated");
		card.setExpanded(true);
		const expanded = text(card, width);
		expect(expanded.replace(/\s/g, "")).toContain(work.job.id);
		expect(card.render(width).lines.join("\n")).not.toContain("\x1b[2J");
	});
});

describe("background job list metadata", () => {
	const summary: BackgroundJobSummary = {
		id: "job_list-item",
		toolName: "bash",
		toolCallId: "list-launch",
		label: "npm run check",
		status: "completed",
		startedAt: 1000,
		endedAt: 2000,
	};
	const unsupportedDetails: unknown[] = [
		undefined,
		null,
		"extension replacement",
		42,
		true,
		[],
		{},
		{ jobs: null },
		{ jobs: "not a list" },
		{ jobs: [null] },
		{ jobs: [[]] },
		{ jobs: [summary, null] },
		{ jobs: [{}] },
		{ jobs: [{ ...summary, status: "unknown" }] },
		{ jobs: [{ ...summary, status: "constructor" }] },
		{ jobs: [{ ...summary, id: "job_\x07" }] },
		{ jobs: [{ ...summary, toolName: "other" }] },
		{ jobs: [{ ...summary, toolCallId: null }] },
		{ jobs: [{ ...summary, label: 42 }] },
		{ jobs: [{ ...summary, startedAt: "1000" }] },
		{ jobs: [{ ...summary, endedAt: null }] },
	];

	it.each(unsupportedDetails)(
		"uses literal result text for unsupported details in live and replay rows: %j",
		(details) => {
			const result = {
				content: [{ type: "text", text: "\x1b[2JExtension supplied result\x07" }],
				details,
				isError: false,
			};
			const original = JSON.stringify(result);
			for (const live of [false, true]) {
				const card = new ToolExecutionComponent(
					"jobs",
					"list",
					{ action: "list" },
					{},
					createJobsToolDefinition(),
					{ requestRender: () => {} } as unknown as TUI,
					process.cwd(),
				);
				cleanup.push(() => card.dispose());
				if (live) card.markExecutionStarted();
				card.updateResult(result);
				for (const expanded of [false, true]) {
					card.setExpanded(expanded);
					for (const width of [20, 80]) {
						const rendered = text(card, width).replace(/\s+/g, " ");
						expect(rendered).toContain("Extension supplied result");
						expect(rendered).not.toContain(summary.label);
						expect(card.render(width).lines.join("\n")).not.toMatch(/\x07|\x1b\[2J/);
					}
					card.invalidate();
					expect(text(card)).toContain("Extension supplied result");
				}
			}
			expect(JSON.stringify(result)).toBe(original);
		},
	);

	it("keeps a failed inspection visible when its metadata was replaced", () => {
		const card = new ToolExecutionComponent(
			"jobs",
			"list-error",
			{ action: "list" },
			{},
			createJobsToolDefinition(),
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		cleanup.push(() => card.dispose());
		card.updateResult({
			content: [{ type: "text", text: "Extension error text" }],
			details: "replacement",
			isError: true,
		});
		expect(text(card)).toContain("Job inspection failed");
		expect(text(card)).toContain("Extension error text");
	});

	it("preserves native empty, populated, and expanded list rendering", async () => {
		const manager = setup();
		const listing = vi.spyOn(manager, "list").mockReturnValue([]);
		cleanup.push(() => listing.mockRestore());
		const nativeTool = createJobsTool({ manager });
		const card = new ToolExecutionComponent(
			"jobs",
			"list-valid",
			{ action: "list" },
			{},
			createJobsToolDefinition(),
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		cleanup.push(() => card.dispose());
		card.updateResult({ ...(await nativeTool.execute("empty-list", { action: "list" })), isError: false });
		expect(text(card)).toContain("No background jobs");
		const statuses = ["running", "cancelling", "completed", "failed", "cancelled"] as const;
		const { endedAt, ...activeSummary } = summary;
		const jobs = statuses.map((status, index) => ({
			...activeSummary,
			id: `job_list-${index}`,
			label: `Command ${index}`,
			status,
			...(status === "running" || status === "cancelling" ? {} : { endedAt }),
		}));
		listing.mockReturnValue(jobs);
		card.updateResult({ ...(await nativeTool.execute("populated-list", { action: "list" })), isError: false });
		for (const expanded of [false, true]) {
			card.setExpanded(expanded);
			const rendered = text(card);
			expect(rendered).toContain("Background jobs");
			for (const job of jobs) {
				expect(rendered).toContain(job.label);
				if (expanded) expect(rendered).toContain(job.id);
				else expect(rendered).not.toContain(job.id);
			}
		}
	});
});

describe("transformed job results", () => {
	it.each(["running", "completed"] as const)(
		"preserves a consistently redacted %s inspection snapshot",
		async (status) => {
			vi.useFakeTimers();
			vi.setSystemTime(1000);
			const manager = setup();
			const work = start(manager, "Original job label");
			await Promise.resolve();
			work.output("token=original-secret");
			if (status === "completed") {
				work.finish({ content: [{ type: "text", text: "token=original-secret" }] });
				await manager.wait([work.job.id]);
			}
			const snapshot = { ...manager.get(work.job.id), label: "Filtered label", output: "token=[REDACTED]" };
			const result = backgroundJobResult(snapshot);
			const card = tool(manager, work.job, "jobs");
			card.updateArgs({ action: "read", id: work.job.id });
			card.updateResult({ ...result, isError: false });
			for (const expanded of [false, true]) {
				card.setExpanded(expanded);
				const captured = text(card);
				if (expanded) {
					expect(captured).toContain("token=[REDACTED]");
					expect(captured).toContain("Filtered label");
					expect(captured).toContain("jobs read");
					expect(captured.match(/\/jobs/g)).toHaveLength(1);
				} else {
					expect(captured).not.toContain("token=");
					expect(captured).not.toContain("Filtered label");
					expect(captured).not.toContain("snapshot");
				}
				expect(captured).not.toContain("original-secret");
				vi.setSystemTime(100_000);
				work.output("token=new-secret");
				card.invalidate();
				expect(text(card)).toBe(captured);
			}
		},
	);

	it.each([false, true])("preserves the collapse limit for transformed output (error: %s)", (isError) => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "f6" }));
		const card = new ToolExecutionComponent(
			"jobs",
			"long-transformed",
			{ action: "list" },
			{},
			createJobsToolDefinition(),
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		cleanup.push(() => card.dispose());
		card.updateResult({
			content: [
				{ type: "text", text: Array.from({ length: 30 }, (_, index) => `Extension line ${index}`).join("\n") },
			],
			details: { jobs: [] },
			isError,
		});
		const collapsed = text(card);
		expect(collapsed).toContain("Extension line 9");
		expect(collapsed).not.toContain("Extension line 10");
		expect(collapsed).toContain("20 more lines");
		expect(collapsed).toContain("F6 expand output");
		if (isError) expect(collapsed).toContain("Job inspection failed");
		card.setExpanded(true);
		expect(text(card)).toContain("Extension line 29");
		expect(text(card)).not.toContain("20 more lines");
		card.setExpanded(false);
		expect(text(card)).toBe(collapsed);
	});

	it.each([
		[null, true],
		["kitty", false],
	] as const)("shows image placeholders when images cannot be displayed (%s, enabled: %s)", (images, showImages) => {
		const previousCapabilities = getCapabilities();
		setCapabilities({ images, trueColor: true, hyperlinks: true });
		cleanup.push(() => setCapabilities(previousCapabilities));
		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y8fsAAAAASUVORK5CYII=",
		};
		const card = new ToolExecutionComponent(
			"jobs",
			"image-result",
			{ action: "list" },
			{ showImages },
			createJobsToolDefinition(),
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		cleanup.push(() => card.dispose());
		for (const mixed of [false, true]) {
			card.updateResult({
				content: mixed ? [{ type: "text", text: "Extension image result" }, image] : [image],
				details: { jobs: [] },
				isError: false,
			});
			for (const expanded of [false, true]) {
				card.setExpanded(expanded);
				for (const width of [20, 80]) {
					const rendered = text(card, width).replace(/\s+/g, " ");
					expect(rendered).toContain("[Image: [image/png] 1x1]");
					if (mixed) expect(rendered).toContain("Extension image result");
					expect(card.render(width).images).toHaveLength(0);
				}
			}
		}
	});

	it.each(["read", "wait", "list"] as const)(
		"preserves post-hook content and errors for %s results with native metadata",
		async (action) => {
			const manager = setup();
			const work = start(manager, "Native job label");
			await Promise.resolve();
			work.finish({ content: [{ type: "text", text: "Original worker output" }] });
			await manager.wait([work.job.id]);
			const args =
				action === "list"
					? { action }
					: action === "wait"
						? { action, ids: [work.job.id] }
						: { action, id: work.job.id };
			const native = await createJobsTool({ manager }).execute("native-result", args);
			for (const change of ["content", "error", "both"] as const) {
				const result = {
					...native,
					content:
						change === "error" ? native.content : [{ type: "text" as const, text: "Extension replacement text" }],
					isError: change !== "content",
				};
				const saved = JSON.stringify(result);
				for (const registered of [false, true]) {
					for (const live of [false, true]) {
						const card = new ToolExecutionComponent(
							"jobs",
							"transformed-result",
							args,
							{},
							registered ? createJobsToolDefinition({ manager }) : undefined,
							{ requestRender: () => {} } as unknown as TUI,
							process.cwd(),
						);
						cleanup.push(() => card.dispose());
						if (live) card.markExecutionStarted();
						card.updateResult(result);
						for (const expanded of [false, true]) {
							card.setExpanded(expanded);
							const rendered = text(card);
							if (change !== "error") {
								expect(rendered).toContain("Extension replacement text");
								expect(rendered).not.toContain("Original worker output");
								expect(rendered).not.toContain("Native job label");
							}
							if (change !== "content") expect(rendered).toContain("Job inspection failed");
							else expect(rendered).not.toContain("Job inspection failed");
							expect(rendered).not.toContain("Completed");
							card.invalidate();
							expect(text(card)).toBe(rendered);
						}
					}
				}
				expect(JSON.stringify(result)).toBe(saved);
			}
		},
	);
});

describe("background job observers and dock", () => {
	it("notifies start/output/settlement and contains observer failures", async () => {
		const manager = setup();
		const observer = vi.fn();
		const stop = manager.subscribe(observer);
		manager.subscribe(() => {
			throw new Error("broken UI");
		});
		const work = start(manager);
		expect(observer).toHaveBeenCalledTimes(1);
		await Promise.resolve();
		work.output("working");
		expect(observer).toHaveBeenCalledTimes(2);
		const timestamp = manager.get(work.job.id).lastOutputAt;
		work.output("working");
		expect(observer).toHaveBeenCalledTimes(2);
		expect(manager.get(work.job.id).lastOutputAt).toBe(timestamp);
		work.finish({ content: [{ type: "text", text: "working" }] });
		await manager.waitForIdle();
		expect(observer).toHaveBeenCalledTimes(3);
		stop();
		await manager.close();
		expect(observer).toHaveBeenCalledTimes(3);
	});

	it("shows one metadata-only row with whole seconds and switches to the current source", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		let manager = setup();
		const dock = new BackgroundJobsStatus(() => manager);
		expect(dock.render(80).lines).toEqual([]);
		const work = start(manager, "npm run check");
		await Promise.resolve();
		work.output("PASS recent test\nCommand exited with code 42");
		vi.setSystemTime(53_999);
		const get = vi.spyOn(manager, "get");
		cleanup.push(() => get.mockRestore());
		const rendered = text(dock);
		expect(dock.render(80).lines).toHaveLength(1);
		expect(rendered).toMatch(/^Jobs {2}running · npm run check · 52s\s+(?:Alt|Option)\+J$/);
		expect(dock.render(80).lines[0]).toContain(theme.fg("accent", "Jobs"));
		expect(dock.render(80).lines[0]).toContain(theme.fg("warning", "running"));
		expect(rendered).not.toContain("1 running");
		expect(rendered).not.toContain("PASS");
		expect(rendered).not.toContain("code 42");
		expect(rendered).not.toContain("Last output");
		expect(get).not.toHaveBeenCalled();
		work.output("Different raw output");
		expect(text(dock)).toBe(rendered);
		work.finish({ isError: true, content: [{ type: "text", text: "FAIL timeout" }] });
		await manager.wait([work.job.id]);
		expect(text(dock)).toContain("failed · npm run check · 52s · awaiting review");
		manager = setup();
		expect(dock.render(80).lines).toEqual([]);
	});

	it.each([
		["running", "warning"],
		["cancelling", "warning"],
		["completed", "success"],
		["failed", "error"],
		["cancelled", "muted"],
	] as const)("keeps a single %s status readable without a redundant count", (status, color) => {
		const manager = setup();
		const terminal = status !== "running" && status !== "cancelling";
		const listing = vi.spyOn(manager, "listUncollected").mockReturnValue([
			{
				id: "job_single",
				toolName: "subagent",
				toolCallId: "single",
				label: "Review job output",
				status,
				startedAt: 1000,
				...(terminal ? { endedAt: 53_999 } : {}),
			},
		]);
		cleanup.push(() => listing.mockRestore());
		const dock = new BackgroundJobsStatus(() => manager);
		for (const width of [10, 20, 40, 80, 120]) {
			const rendered = text(dock, width);
			expect(dock.render(width).lines).toHaveLength(1);
			expect(rendered).toContain(status);
			expect(rendered).not.toContain(`1 ${status}`);
			if (width >= 80) {
				expect(rendered).toContain("Review job output");
				expect(rendered.includes("awaiting review")).toBe(terminal);
				if (terminal) expect(rendered).toContain("52s");
			}
		}
		expect(dock.render(80).lines[0]).toContain(theme.fg(color, status));
		for (const width of [1, 4, 8]) {
			text(dock, width);
			expect(dock.render(width).lines).toHaveLength(1);
		}
		expect(dock.render(0).lines).toEqual([]);
	});

	it.each(["f6", "ctrl+shift+j", []] as const)(
		"right-aligns the configured shortcut or /jobs fallback: %j",
		(binding) => {
			setKeybindings(
				new KeybindingsManager({ "app.jobs.open": binding === "f6" || binding === "ctrl+shift+j" ? binding : [] }),
			);
			const manager = setup();
			start(manager, "npm run check");
			const dock = new BackgroundJobsStatus(() => manager);
			const hint = binding === "f6" ? "F6" : binding === "ctrl+shift+j" ? "Ctrl+Shift+J" : "/jobs";
			for (const width of [40, 80, 120]) {
				const rendered = text(dock, width);
				expect(dock.render(width).lines).toHaveLength(1);
				expect(visibleWidth(rendered)).toBe(width);
				expect(rendered.endsWith(`  ${hint}`)).toBe(true);
				expect(dock.render(width).lines[0]).toContain(theme.fg("dim", hint));
				expect(rendered).not.toMatch(/(?:Alt|Option)\+J/);
			}
		},
	);

	it.each(["npm run check --workspace packages/coding-agent", "界".repeat(60)])(
		"truncates long labels without wrapping or losing the state and shortcut: %s",
		(label) => {
			setKeybindings(new KeybindingsManager({ "app.jobs.open": "f6" }));
			const manager = setup();
			start(manager, label);
			const dock = new BackgroundJobsStatus(() => manager);
			for (const width of [20, 40, 80, 160]) {
				const rendered = text(dock, width);
				expect(dock.render(width).lines).toHaveLength(1);
				expect(rendered).toContain("running");
				if (width <= 40) {
					expect(rendered).toContain("…");
					expect(rendered).not.toMatch(/\d+s/);
				}
				if (width >= 40) expect(rendered.endsWith("F6")).toBe(true);
				if (width === 160) expect(rendered).toContain(label);
			}
		},
	);

	it("drops terminal duration before the command and shows awaiting review when it fits", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		setKeybindings(new KeybindingsManager({ "app.jobs.open": "f6" }));
		const manager = setup();
		const work = start(manager, "npm run check");
		await Promise.resolve();
		vi.setSystemTime(53_999);
		work.finish({ content: [{ type: "text", text: "Raw terminal output" }] });
		await manager.wait([work.job.id]);
		const dock = new BackgroundJobsStatus(() => manager);
		expect(text(dock, 36)).toMatch(/^Jobs {2}completed · npm run check\s+F6$/);
		expect(text(dock, 53)).toMatch(/^Jobs {2}completed · npm run check · awaiting review\s+F6$/);
		expect(text(dock, 80)).toContain("completed · npm run check · 52s · awaiting review");
		const settled = text(dock, 80);
		vi.setSystemTime(86_400_000);
		expect(text(dock, 80)).toBe(settled);
	});

	it("shows stable colored counts for all uncollected states without choosing a job", async () => {
		const manager = setup();
		const running = start(manager, "Active command");
		const cancelling = start(manager, "Cancelling command");
		const completed = start(manager, "Completed command");
		const failed = start(manager, "Failed command");
		const cancelled = start(manager, "Cancelled command");
		await Promise.resolve();
		manager.cancel(cancelling.job.id);
		manager.cancel(cancelled.job.id);
		completed.finish({ content: [] });
		failed.finish({ content: [], isError: true });
		cancelled.finish({ content: [] });
		await Promise.all([completed, failed, cancelled].map((work) => manager.wait([work.job.id])));
		const dock = new BackgroundJobsStatus(() => manager);
		const rendered = text(dock);
		expect(dock.render(80).lines).toHaveLength(1);
		expect(rendered).toMatch(
			/^Jobs {2}1 running · 1 cancelling · 1 failed · 1 completed · 1 cancelled\s+(?:Alt|Option)\+J$/,
		);
		expect(rendered).not.toContain("command");
		for (const [status, style] of Object.entries(backgroundRendering.BACKGROUND_JOB_STYLES)) {
			expect(dock.render(80).lines[0]).toContain(theme.fg(style.color, `1 ${status}`));
		}
		running.output("New output does not select or rotate a job");
		expect(text(dock)).toBe(rendered);
		for (const width of [10, 20, 40, 120]) {
			text(dock, width);
			expect(dock.render(width).lines).toHaveLength(1);
		}
	});

	it("hides a collected terminal result without removing it from the inspector", async () => {
		const manager = setup();
		const work = start(manager, "npm run check");
		await Promise.resolve();
		work.finish({ content: [{ type: "text", text: "Final result" }] });
		await manager.wait([work.job.id]);
		const dock = new BackgroundJobsStatus(() => manager);
		expect(text(dock)).toContain("awaiting review");
		const result = await createJobsTool({ manager }).execute("collect-result", { action: "read", id: work.job.id });
		expect(text(dock)).toContain("awaiting review");
		const snapshot = backgroundRendering.getBackgroundJobSnapshot(result.details);
		if (!snapshot) throw new Error("Expected the native inspection snapshot");
		manager.acknowledgeResult("collect-result", snapshot);
		expect(dock.render(80).lines).toEqual([]);
		const { component } = inspector(manager);
		expect(text(component)).toContain("Completed");
		expect(text(component)).toContain("npm run check");
	});
});

describe("background jobs inspector", () => {
	it.each([20, 40, 80, 120])("keeps controls and bounded output at %i columns", async (width) => {
		const manager = setup();
		const work = start(manager, "界".repeat(150));
		await Promise.resolve();
		work.output(`\x1b[2J**literal output**\x07\n${"line\n".repeat(3000)}`);
		const { component } = inspector(manager);
		expect(text(component, width)).toContain("Background jobs");
		expect(component.render(width).lines.length).toBeLessThanOrEqual(24);
		component.handleInput("\r");
		expect(text(component, width)).not.toContain("\x07");
		expect(component.render(width).lines.length).toBeLessThanOrEqual(24);
		expect(text(component, width).replace(/\s+/g, " ")).toContain("back");
	});

	it("follows new output, pauses scrolling, and resumes with the configured key", async () => {
		const manager = setup();
		const work = start(manager);
		await Promise.resolve();
		work.output(Array.from({ length: 50 }, (_, i) => `output ${i}`).join("\n"));
		const { component } = inspector(manager);
		text(component);
		component.handleInput("\r");
		expect(text(component)).toContain("output 49");
		component.handleInput("\x1b[5~");
		expect(text(component)).toContain("Scroll paused");
		expect(text(component)).not.toContain("output 49");
		work.output(Array.from({ length: 60 }, (_, i) => `output ${i}`).join("\n"));
		expect(text(component)).not.toContain("output 59");
		setKeybindings(new KeybindingsManager({ "app.jobs.follow": "f6" }));
		expect(text(component)).toContain("F6 follow latest");
		component.handleInput("\x1b[17~");
		expect(text(component)).toContain("Following latest");
		expect(text(component)).toContain("output 59");
	});

	it("keeps a bounded paused reading snapshot when live retention rolls over", async () => {
		const manager = setup();
		const work = start(manager);
		await Promise.resolve();
		const output = (count: number) =>
			Array.from({ length: count }, (_, index) => `output ${String(index).padStart(4, "0")}`).join("\n");
		work.output(output(2000));
		const { component } = inspector(manager);
		text(component);
		component.handleInput("\r");
		text(component);
		component.handleInput("\x1b[H");
		for (let index = 0; index < 30; index++) component.handleInput("\x1b[B");
		expect(text(component)).toContain("output 0030");
		work.output(output(2010));
		expect(manager.get(work.job.id).outputTruncated).toBe(true);
		expect(text(component)).toContain("output 0030");
		expect(text(component)).toContain("snapshot; newer output available");
		work.output(output(5000));
		expect(manager.get(work.job.id).output).not.toContain("output 0030");
		expect(text(component)).toContain("output 0030");
		component.handleInput("\x1b[F");
		expect(text(component)).toContain("output 4999");
		expect(text(component)).toContain("Following latest");
	});

	it("reserves readable output rows for long labels and truncated output at 20x24", async () => {
		const manager = setup();
		const work = start(manager, "界".repeat(150));
		await Promise.resolve();
		work.output(`${"earlier\n".repeat(3000)}VISIBLE LATEST\n`);
		const { component } = inspector(manager);
		text(component, 20);
		component.handleInput("\r");
		const rendered = text(component, 20);
		expect(rendered).toContain("VISIBLE LATEST");
		expect(rendered).toContain("back");
		expect(component.render(20).lines.length).toBeLessThanOrEqual(24);
	});

	it("keeps the selected job stable and confirms cancellation of only that job", async () => {
		const manager = setup();
		const first = start(manager, "First job");
		await Promise.resolve();
		const { component, onClose } = inspector(manager);
		text(component);
		const second = start(manager, "Second job");
		await Promise.resolve();
		text(component);
		component.handleInput("\x0b");
		expect(text(component)).toContain("Cancel this job?");
		expect(text(component)).toContain("First job");
		expect(text(component)).toContain(first.job.id);
		component.handleInput("\x1b");
		expect(manager.get(first.job.id).status).toBe("running");
		component.handleInput("\x0b");
		component.handleInput("\r");
		expect(manager.get(first.job.id).status).toBe("cancelling");
		expect(manager.get(second.job.id).status).toBe("running");
		expect(text(component)).toContain("waiting for the worker to stop");
		first.finish({ content: [] });
		await manager.wait([first.job.id]);
		expect(text(component)).toContain("Cancelled");
		expect(text(component)).not.toContain("waiting for the worker to stop");
		component.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledOnce();
		expect(manager.get(second.job.id).status).toBe("running");
	});

	it("shows an empty state after revocation and releases timers and subscriptions", async () => {
		vi.useFakeTimers();
		let allowed = true;
		const manager = new BackgroundJobManager({ isToolAllowed: () => allowed, getGeneration: () => 0 });
		cleanup.push(() => manager.close());
		const work = start(manager);
		await Promise.resolve();
		const { component, requestRender } = inspector(manager);
		text(component);
		allowed = false;
		manager.cancelInaccessible();
		expect(text(component)).toContain("No background jobs");
		component.dispose();
		requestRender.mockClear();
		work.finish({ content: [] });
		await manager.waitForIdle();
		await vi.advanceTimersByTimeAsync(1000);
		expect(requestRender).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
