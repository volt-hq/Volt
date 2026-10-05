import type { AgentToolResult } from "@hansjm10/volt-agent-core";
import { getKeybindings, setKeybindings, type TUI, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { type JobRuntime, type JobSummary, jobResult } from "../src/core/tools/jobs.ts";
import { BUILTIN_PRESENTERS } from "../src/core/tools/presenters.ts";
import { PresentedToolComponent } from "../src/modes/interactive/components/presented-tool.ts";
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
	const component = new PresentedToolComponent(
		"bash",
		{ command: job.label, background: true },
		() => BUILTIN_PRESENTERS,
		{ requestRender: () => {} } as unknown as TUI,
		process.cwd(),
		{ liveProgress: live, ...(live ? { work: () => jobWork(jobs, job.id) } : {}) },
	);
	cleanup.push(() => component.dispose());
	component.markExecutionStarted();
	return component;
}

describe("background job cards", () => {
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
