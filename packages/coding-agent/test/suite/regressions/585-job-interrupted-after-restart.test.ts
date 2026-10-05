// Regression for #585 (Phase 4, RFC §7.1): a background job is work in the
// conversation's log. A job running when its runtime stops ends
// `interrupted` once the conversation opens again, whether the runtime
// closed or ended without closing, its kept result stays readable by id, and
// its replayed launch card shows the recorded outcome, not the running state
// its tool result captured.
import { type ConversationLogEntry, InMemoryConversationLog } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { WORK_NOTICE_CUSTOM_TYPE } from "@hansjm10/volt-protocol";
import type { TUI } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import * as nativeTools from "../../../src/core/tools/index.ts";
import { PresentedToolComponent } from "../../../src/modes/interactive/components/presented-tool.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const finishes: Array<() => void> = [];

afterEach(async () => {
	for (const finish of finishes.splice(0)) finish();
	for (const harness of harnesses.splice(0).reverse()) await harness.cleanupAsync();
	vi.restoreAllMocks();
});

/** A shell backend whose command runs until the runtime stops it. */
function blockingBash(): { started: Promise<void> } {
	const started = Promise.withResolvers<void>();
	const operations: BashOperations = {
		exec: async (_command, _cwd, options) => {
			const finish = Promise.withResolvers<void>();
			finishes.push(finish.resolve);
			options.signal?.addEventListener("abort", () => finish.resolve(), { once: true });
			options.onData(Buffer.from("partial output before the stop\n"));
			started.resolve();
			await finish.promise;
			if (options.signal?.aborted) throw new Error("aborted");
			return { exitCode: 0 };
		},
	};
	const original = nativeTools.createAllToolDefinitions;
	vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
		original(cwd, { ...options, bash: { ...options?.bash, operations } }),
	);
	return { started: started.promise };
}

async function open(log: InMemoryConversationLog): Promise<Harness> {
	const harness = await createHarness({
		log,
		initialActiveToolNames: ["bash", "jobs"],
		settings: { lsp: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } },
	});
	harnesses.push(harness);
	return harness;
}

/** The same conversation as a new runtime finds it: a copy of every entry of `log`. */
async function copyOf(log: InMemoryConversationLog): Promise<InMemoryConversationLog> {
	const entries: ConversationLogEntry[] = [];
	for (;;) {
		const page = await log.read(entries.length, 1_000);
		entries.push(...page.entries);
		if (page.entries.length === 0 || entries.length >= page.lastOrdinal) break;
	}
	const copy = new InMemoryConversationLog(log.conversationId);
	await copy.append({
		expectedOrdinal: 0,
		commitId: "restart-copy",
		entries: entries.map(({ ordinal: _ordinal, ...draft }) => draft),
	});
	return copy;
}

/** Start a background job through the model; resolves with its id once it runs. */
async function startJob(harness: Harness, started: Promise<void>): Promise<string> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "npm test", background: true }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Tests run in the background."),
	]);
	await harness.session.prompt("Run the tests in the background");
	await started;
	const [job] = harness.session.jobs.list();
	if (!job) throw new Error("Expected a background job");
	expect(job.status).toBe("running");
	expect(harness.session.work.busy()).toBe(true);
	return job.id;
}

describe("#585 background job interrupted after a restart", () => {
	it("interrupts a job whose runtime ended without closing when the conversation opens again", async () => {
		const { started } = blockingBash();
		const log = new InMemoryConversationLog("job-restart-crash");
		const first = await open(log);
		const jobId = await startJob(first, started);
		// The runtime ends without closing: the log keeps the job open.
		const left = await copyOf(log);
		expect(first.session.work.get(jobId)?.outcome).toBeUndefined();

		const second = await open(left);
		expect(second.session.work.get(jobId)).toMatchObject({ kind: "job", outcome: "interrupted" });
		expect(second.session.work.busy()).toBe(false);
		expect(second.session.jobs.get(jobId)).toMatchObject({ status: "interrupted", output: "" });
		// An interrupted job wakes nothing: no notice is queued and no turn runs.
		expect(second.faux.state.callCount).toBe(0);
		expect(second.session.messages.some((message) => message.role === "custom")).toBe(false);

		// The launch card, replayed from the log, shows the recorded outcome.
		initTheme("dark");
		const launch = second.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "bash",
		);
		if (launch?.role !== "toolResult") throw new Error("Expected the launch result");
		// The card presents the result as recorded; the work the call started shows its own outcome under it.
		const record = second.session.work.list().find((item) => item.toolCallId === launch.toolCallId);
		const card = new PresentedToolComponent(
			"bash",
			{ command: "npm test", background: true },
			second.session.presenters.tool("bash"),
			{ requestRender: () => {} } as unknown as TUI,
			second.tempDir,
			{
				work: () =>
					record ? [{ workId: record.workId, title: record.title, status: record.outcome ?? record.state }] : [],
			},
		);
		card.updateResult({ content: launch.content, details: launch.details, isError: false });
		const replayed = stripAnsi(card.render(100).lines.join("\n"));
		card.dispose();
		expect(replayed).toContain("Background job");
		expect(replayed).toContain("Interrupted · npm test");
		expect(replayed).not.toContain("at capture");

		// The model reads the outcome by id after the restart.
		second.setResponses([
			fauxAssistantMessage(fauxToolCall("jobs", { action: "read", id: jobId }), { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.findLast(
					(message) => message.role === "toolResult" && message.toolName === "jobs",
				);
				expect(getMessageText(result)).toContain(`Background job ${jobId}: interrupted (bash).`);
				return fauxAssistantMessage("The tests were interrupted by the restart.");
			},
		]);
		await second.session.prompt("What happened to the tests?");
		expect(second.session.getLastAssistantText()).toBe("The tests were interrupted by the restart.");
	});

	it("interrupts a job when its runtime closes, and the reopened conversation knows it", async () => {
		const { started } = blockingBash();
		const log = new InMemoryConversationLog("job-restart-close");
		const first = await open(log);
		const jobId = await startJob(first, started);
		await first.cleanupAsync();
		harnesses.splice(harnesses.indexOf(first), 1);

		const second = await open(await copyOf(log));
		const record = second.session.work.get(jobId);
		expect(record).toMatchObject({ kind: "job", outcome: "interrupted" });
		expect(second.session.jobs.get(jobId).status).toBe("interrupted");
		expect(
			second.session.messages.some(
				(message) => message.role === "custom" && message.customType === WORK_NOTICE_CUSTOM_TYPE,
			),
		).toBe(false);
		expect(second.faux.state.callCount).toBe(0);
		// The reopened conversation runs new jobs as usual.
		expect(second.session.work.running()).toEqual([]);
	});
});
