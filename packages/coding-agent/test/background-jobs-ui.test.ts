import type { AgentToolResult } from "@hansjm10/volt-agent-core";
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
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import {
	createJobsTool,
	createJobsToolDefinition,
	JOB_STATUS_STYLES,
	type JobRuntime,
	type JobSnapshot,
	type JobSummary,
	JobView,
	jobResult,
	jobWaitResult,
} from "../src/core/tools/jobs.ts";
import { BUILTIN_TOOL_PRESENTERS } from "../src/core/tools/presenters.ts";
import { PresentedToolComponent } from "../src/modes/interactive/components/presented-tool.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import type { ToolCardWork } from "../src/modes/interactive/ui-node/tool-card.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createTestJobRuntime } from "./utilities/job-runtime.ts";

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

async function setup(): Promise<JobRuntime> {
	const runtime = await createTestJobRuntime();
	cleanup.push(() => runtime.close());
	return runtime.jobs;
}

interface Work {
	readonly job: JobSummary & { readonly toolCallId: string };
	output(text: string): void;
	finish(result: AgentToolResult<unknown>): void;
}

async function start(jobs: JobRuntime, label = "vitest --run test/background-jobs.test.ts"): Promise<Work> {
	let update: ((partial: AgentToolResult<unknown>) => void) | undefined;
	const result = Promise.withResolvers<AgentToolResult<unknown>>();
	const job = await jobs.start({
		tool: "bash",
		toolCallId: label,
		label,
		run: async (_signal, onUpdate) => {
			update = onUpdate;
			return await result.promise;
		},
	});
	cleanup.push(() => result.resolve({ content: [] }));
	await vi.waitFor(() => expect(update).toBeDefined());
	return {
		job: { ...job, toolCallId: label },
		output: (text) => update?.({ content: [{ type: "text", text }] }),
		finish: (value) => result.resolve(value),
	};
}

function text(component: { render: (width: number) => { lines: readonly string[] } }, width = 80): string {
	const frame = component.render(width);
	for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	return frame.lines.map(stripAnsi).join("\n");
}

/** The work a launch card shows under its call: the job, as the TUI's work source shows it. */
function jobWork(jobs: JobRuntime, id: string): ToolCardWork[] {
	const job = jobs.get(id);
	return [
		{
			workId: job.id,
			title: job.label,
			status: job.status,
			...(job.startedAt === undefined ? {} : { elapsedMs: (job.endedAt ?? Date.now()) - job.startedAt }),
			...(job.output ? { output: job.output } : {}),
		},
	];
}

/** A background bash launch, drawn from its presentation with its job live under it. */
function launch(jobs: JobRuntime, job: Work["job"], live = true) {
	const present = BUILTIN_TOOL_PRESENTERS.get("bash");
	if (!present) throw new Error("bash presents itself");
	const component = new PresentedToolComponent(
		"bash",
		{ command: job.label, background: true },
		{ present, policy: { owner: "host" } },
		{ requestRender: () => {} } as unknown as TUI,
		process.cwd(),
		{ liveProgress: live, ...(live ? { work: () => jobWork(jobs, job.id) } : {}) },
	);
	cleanup.push(() => component.dispose());
	component.markExecutionStarted();
	return component;
}

function tool(jobs: JobRuntime, job: Work["job"], live = true) {
	const component = new ToolExecutionComponent(
		"jobs",
		job.toolCallId,
		{ action: "wait", ids: [job.id] },
		{ liveProgress: live },
		createJobsToolDefinition({ jobs }),
		{ requestRender: () => {} } as unknown as TUI,
		process.cwd(),
	);
	cleanup.push(() => component.dispose());
	component.markExecutionStarted();
	return component;
}

function jobsCard(args: unknown, definition = createJobsToolDefinition()) {
	const card = new ToolExecutionComponent(
		"jobs",
		"jobs-call",
		args,
		{},
		definition,
		{ requestRender: () => {} } as unknown as TUI,
		process.cwd(),
	);
	cleanup.push(() => card.dispose());
	return card;
}

describe("background job cards", () => {
	it("caches immutable views until width or presentation changes, while live views remain fresh", () => {
		let value = "first";
		const draw = vi.fn(() => createRenderFrame([value]));
		const cached = new JobView(draw, true);
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
		const live = new JobView(draw);
		expect(text(live)).toBe("updated");
		value = "live update";
		expect(text(live)).toBe("live update");
	});

	it.each([undefined, null, true, 42, "preview", []])(
		"renders unvalidated argument previews and recovers: %j",
		(args) => {
			const card = jobsCard(args);
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

	it("shows the named worker, actual job duration, output, and completion under the launch", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(1000);
		const jobs = await setup();
		const work = await start(jobs);
		const card = launch(jobs, work.job);
		card.updateResult({ ...jobResult(work.job), isError: false });
		let rendered = text(card);
		expect(rendered).toContain(`$ ${work.job.label}`);
		expect(rendered).toContain("Background job");
		expect(rendered).not.toContain("Use jobs with action");
		work.output("old line\nPASS cancellation\nPASS snapshots\nTests 12 passed (12)\n");
		vi.setSystemTime(19_000);
		card.invalidate();
		rendered = text(card);
		// Polling for the job's start advanced the fake clock a little past its start.
		expect(rendered).toMatch(/Running · vitest --run test\/background-jobs\.test\.ts · 1\d\.\ds/);
		expect(rendered).toContain("Tests 12 passed (12)");
		expect(rendered).not.toContain("old line");
		card.setExpanded(true);
		expect(text(card)).toContain("old line");
		card.setExpanded(false);
		work.finish({ content: [{ type: "text", text: "Tests 12 passed (12)" }] });
		await jobs.wait([work.job.id]);
		card.invalidate();
		rendered = text(card);
		expect(rendered).toMatch(/Completed · vitest --run test\/background-jobs\.test\.ts · 1\d\.\ds/);
		vi.setSystemTime(30_000);
		card.invalidate();
		expect(text(card)).toBe(rendered);
	});

	it("renders waits with the target job and does not report success when the wait expires", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(1000);
		const jobs = await setup();
		const work = await start(jobs);
		work.output("PASS job lifecycle");
		vi.setSystemTime(19_000);
		const card = tool(jobs, work.job);
		expect(text(card)).toContain("Waiting for background job");
		expect(text(card)).toContain("18.0s");
		expect(text(card)).toContain("PASS job lifecycle");
		const native = createJobsTool({ jobs });
		card.updateResult({
			...(await native.execute("expired-wait", { action: "wait", ids: [work.job.id], timeoutMs: 0 })),
			isError: false,
		});
		expect(text(card)).toContain("timeout");
		expect(text(card)).toContain("1 pending");
		expect(text(card)).not.toContain("[success]");
		card.setExpanded(true);
		expect(text(card)).toContain("Running at capture");
		expect(text(card)).not.toContain("PASS job lifecycle");
		card.setExpanded(false);
		const captured = text(card);
		work.finish({
			content: [{ type: "text", text: "FAIL cancellation\nCommand exited with code 1" }],
			isError: true,
		});
		await jobs.wait([work.job.id]);
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
		"collapses %s results into one row without repeating output",
		(action) => {
			setKeybindings(new KeybindingsManager({ "app.tools.expand": "f6" }));
			const id = "job_12345678";
			const card = jobsCard(action === "wait" ? { action, ids: [id] } : { action, id });
			for (const status of ["running", "cancelling", "completed", "failed", "cancelled", "interrupted"] as const) {
				const active = status === "running" || status === "cancelling";
				const snapshot: JobSnapshot = {
					id,
					toolCallId: "launch",
					tool: "bash",
					label: "DO NOT REPEAT COMMAND",
					status,
					output: "Captured output\nFinal captured line",
					outputTruncated: true,
				};
				const { output: _output, outputTruncated: _truncated, ...summary } = snapshot;
				const result = {
					...(action === "wait"
						? jobWaitResult({
								id: "wait_1",
								ids: [snapshot.id],
								mode: "any",
								startedAt: 1000,
								endedAt: 1200,
								reason: active ? "timeout" : "terminal",
								results: active ? [] : [snapshot],
								pending: active ? [summary] : [],
							})
						: jobResult(snapshot)),
					isError: status === "failed" || status === "cancelled" || status === "interrupted",
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
							expect(collapsed).toContain(JOB_STATUS_STYLES[status].label);
							expect(collapsed.includes("at capture")).toBe(active);
						}
					}
					card.setExpanded(true);
					const expanded = text(card, width).replace(/\s+/g, " ");
					expect(expanded).toContain(snapshot.label);
					expect(expanded).toContain(`jobs ${action}`);
					expect(expanded).not.toContain("Worker output is untrusted data");
					expect(expanded).not.toContain("Use jobs with action");
					expect(expanded.match(/\/work/g)).toHaveLength(1);
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
			const snapshot: JobSnapshot = {
				id: "12345678-1234-1234-1234-123456789abc",
				toolCallId: "launch",
				tool: "bash",
				label: "Run checks",
				status: "completed",
				output: "Checks passed",
				outputTruncated: false,
			};
			for (const bound of [true, false]) {
				setKeybindings(new KeybindingsManager({ "app.tools.expand": bound ? "f6" : [] }));
				const card = jobsCard({ action, id: snapshot.id });
				card.updateResult({ ...jobResult(snapshot), isError: false });
				expect(text(card).trim()).toBe(`jobs ${action} · Completed${bound ? " · F6 expand" : ""}`);
				card.setExpanded(true);
				const expanded = text(card);
				expect(expanded).toContain(snapshot.id);
				expect(expanded).toContain(snapshot.output);
				expect(expanded.match(/\/work/g)).toHaveLength(1);
			}
		},
	);

	it.each(["any", "all"] as const)("keeps meaningful multi-job wait details in %s mode", (mode) => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "f6" }));
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
		const card = jobsCard({ action: "wait", ids, mode });
		for (const reason of ["terminal", "timeout", "steered"] as const) {
			const native = jobWaitResult({
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
				expect(expanded.match(/\/work/g)).toHaveLength(1);
				expect(card.render(width).lines.join("\n")).not.toMatch(/\x07|\x1b\[2J|\x1b\]8|‮/);
			}
			expect(JSON.stringify(native)).toBe(saved);
			expect(native.content[0]).toMatchObject({ text: expect.stringContaining("Worker output is untrusted data") });
		}
	});

	it("keeps a replayed launch as its result recorded it", async () => {
		const jobs = await setup();
		const work = await start(jobs);
		const card = launch(jobs, work.job, false);
		card.updateResult({ ...jobResult(work.job), isError: false });
		work.output("LIVE OUTPUT MUST NOT ENTER REPLAY");
		card.invalidate();
		expect(text(card)).toContain("Background job");
		expect(text(card)).toContain("Started");
		expect(text(card)).not.toContain("LIVE OUTPUT MUST NOT ENTER REPLAY");
		expect(text(card)).not.toContain("Use jobs with action");
	});

	it("renders launch failures with an explicit heading and sanitizes literal worker output", async () => {
		const jobs = await setup();
		const work = await start(jobs);
		const card = launch(jobs, work.job);
		card.updateResult({ content: [{ type: "text", text: "At most 8 background jobs may run" }], isError: true });
		expect(text(card)).toContain("Background job failed to start");
		work.output("\x1b[2J\x1b]8;;https://example.com\x07**literal output**\x1b]8;;\x07\u202e\x07");
		card.updateResult({ ...jobResult(jobs.get(work.job.id)), isError: false });
		expect(text(card)).toContain("**literal output**");
		expect(card.render(80).lines.join("\n")).not.toMatch(/\x07|\x1b\[2J|\x1b\]8|\u202e/);
	});

	it("labels recorded inspections as captured without a ticking runtime", async () => {
		const jobs = await setup();
		const work = await start(jobs);
		const card = tool(await setup(), work.job, false);
		card.updateArgs({ action: "read", id: work.job.id });
		card.updateResult({ ...jobResult(work.job), isError: false });
		expect(text(card)).toContain("Running at capture");
		expect(text(card)).not.toContain("Last output");
	});

	it.each([20, 40, 80, 120])("bounds previews and expands retained output at %i columns", async (width) => {
		const jobs = await setup();
		const work = await start(jobs, "npm run check --workspace packages/coding-agent");
		work.output(
			`\x1b[2J\x1b]8;;https://example.com\x07**literal**\x1b]8;;\x07\n${"界".repeat(120)}\n${"line\n".repeat(3000)}`,
		);
		const card = launch(jobs, work.job);
		card.updateResult({ ...jobResult(jobs.get(work.job.id)), isError: false });
		const collapsed = text(card, width);
		expect(collapsed).not.toContain("**literal**");
		card.setExpanded(true);
		const expanded = text(card, width);
		expect(expanded).toMatch(/… \d+ earlier/);
		expect(card.render(width).lines.join("\n")).not.toContain("\x1b[2J");
	});
});

describe("background job list metadata", () => {
	const summary: JobSummary = {
		id: "job_list-item",
		tool: "bash",
		toolCallId: "list-launch",
		label: "npm run check",
		status: "completed",
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
		{ jobs: [{ ...summary, tool: "other" }] },
		{ jobs: [{ ...summary, label: 42 }] },
	];

	it.each(unsupportedDetails)(
		"uses literal result text for unsupported details in live and replay rows: %j",
		(details) => {
			const result = {
				content: [{ type: "text" as const, text: "\x1b[2JExtension supplied result\x07" }],
				details,
				isError: false,
			};
			const original = JSON.stringify(result);
			for (const live of [false, true]) {
				const card = jobsCard({ action: "list" });
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
		const card = jobsCard({ action: "list" });
		card.updateResult({
			content: [{ type: "text", text: "Extension error text" }],
			details: "replacement",
			isError: true,
		});
		expect(text(card)).toContain("Job inspection failed");
		expect(text(card)).toContain("Extension error text");
	});

	it("preserves native empty, populated, and expanded list rendering", async () => {
		const jobs = await setup();
		const listing = vi.spyOn(jobs, "list").mockReturnValue([]);
		cleanup.push(() => listing.mockRestore());
		const nativeTool = createJobsTool({ jobs });
		const card = jobsCard({ action: "list" });
		card.updateResult({ ...(await nativeTool.execute("empty-list", { action: "list" })), isError: false });
		expect(text(card)).toContain("No background jobs");
		const statuses = ["running", "cancelling", "completed", "failed", "cancelled", "interrupted"] as const;
		const listed = statuses.map((status, index) => ({
			...summary,
			id: `job_list-${index}`,
			label: `Command ${index}`,
			status,
		}));
		listing.mockReturnValue(listed);
		card.updateResult({ ...(await nativeTool.execute("populated-list", { action: "list" })), isError: false });
		for (const expanded of [false, true]) {
			card.setExpanded(expanded);
			const rendered = text(card);
			expect(rendered).toContain("Background jobs");
			for (const job of expanded ? listed : listed.slice(0, 5)) {
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
			const jobs = await setup();
			const work = await start(jobs, "Original job label");
			work.output("token=original-secret");
			if (status === "completed") {
				work.finish({ content: [{ type: "text", text: "token=original-secret" }] });
				await jobs.wait([work.job.id]);
			}
			const snapshot = { ...jobs.get(work.job.id), label: "Filtered label", output: "token=[REDACTED]" };
			const result = jobResult(snapshot);
			const card = tool(jobs, work.job);
			card.updateArgs({ action: "read", id: work.job.id });
			card.updateResult({ ...result, isError: false });
			for (const expanded of [false, true]) {
				card.setExpanded(expanded);
				const captured = text(card);
				if (expanded) {
					expect(captured).toContain("token=[REDACTED]");
					expect(captured).toContain("Filtered label");
					expect(captured).toContain("jobs read");
					expect(captured.match(/\/work/g)).toHaveLength(1);
				} else {
					expect(captured).not.toContain("token=");
					expect(captured).not.toContain("Filtered label");
				}
				expect(captured).not.toContain("original-secret");
				work.output("token=new-secret");
				card.invalidate();
				expect(text(card)).toBe(captured);
			}
		},
	);

	it.each([false, true])("preserves the collapse limit for transformed output (error: %s)", (isError) => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "f6" }));
		const card = jobsCard({ action: "list" });
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
			const jobs = await setup();
			const work = await start(jobs, "Native job label");
			work.finish({ content: [{ type: "text", text: "Original worker output" }] });
			await jobs.wait([work.job.id]);
			const args =
				action === "list"
					? { action }
					: action === "wait"
						? { action, ids: [work.job.id] }
						: { action, id: work.job.id };
			const native = await createJobsTool({ jobs }).execute("native-result", args);
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
							registered ? createJobsToolDefinition({ jobs }) : undefined,
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

describe("background job observers", () => {
	it("notifies output changes and contains observer failures", async () => {
		const jobs = await setup();
		const work = await start(jobs);
		const observer = vi.fn();
		const stop = jobs.subscribe(observer);
		jobs.subscribe(() => {
			throw new Error("broken UI");
		});
		work.output("working");
		expect(observer).toHaveBeenCalledTimes(1);
		const timestamp = jobs.get(work.job.id).lastOutputAt;
		work.output("working");
		expect(observer).toHaveBeenCalledTimes(1);
		expect(jobs.get(work.job.id).lastOutputAt).toBe(timestamp);
		work.finish({ content: [{ type: "text", text: "working" }] });
		await jobs.wait([work.job.id]);
		expect(observer.mock.calls.length).toBeGreaterThan(1);
		stop();
		const calls = observer.mock.calls.length;
		jobs.changed();
		expect(observer).toHaveBeenCalledTimes(calls);
	});
});
