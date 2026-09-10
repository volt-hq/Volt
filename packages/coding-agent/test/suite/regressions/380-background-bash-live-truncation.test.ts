import { rm } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { getKeybindings, setKeybindings } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_JOB_MAX_OUTPUT_BYTES } from "../../../src/core/background-jobs.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import { getBackgroundJobWait } from "../../../src/core/tools/background-wait.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import * as nativeTools from "../../../src/core/tools/index.ts";
import { DEFAULT_MAX_LINES } from "../../../src/core/tools/truncate.ts";
import { BackgroundJobsInspector } from "../../../src/modes/interactive/components/background-jobs.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const previousBindings = getKeybindings();
afterEach(() => {
	vi.restoreAllMocks();
	setKeybindings(previousBindings);
});

// PR #380, finding ee6f68d0-c3c6-42e0-9593-bcd70613ad35: Bash progress
// already contains a bounded tail, so the manager must preserve its truncation metadata.
describe("background Bash live truncation", () => {
	it.each([
		["over byte limit", "x".repeat(BACKGROUND_JOB_MAX_OUTPUT_BYTES + 1), true],
		["over line limit", "line\n".repeat(DEFAULT_MAX_LINES + 1), true],
		["at byte limit", "x".repeat(BACKGROUND_JOB_MAX_OUTPUT_BYTES), false],
		["at line limit", "line\n".repeat(DEFAULT_MAX_LINES), false],
	] as const)("reports %s in live reads, waits, and the inspector", async (_label, output, truncated) => {
		const finish = Promise.withResolvers<void>();
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from(output));
				await finish.promise;
				return { exitCode: 0 };
			},
		};
		// Keep native definitions and session policy; replace only the shell backend.
		const createDefinitions = nativeTools.createAllToolDefinitions;
		vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
			createDefinitions(cwd, { ...options, bash: { ...options?.bash, operations } }),
		);
		let harness: Harness | undefined;
		let inspector: BackgroundJobsInspector | undefined;
		try {
			harness = await createHarness({
				initialActiveToolNames: ["bash", "jobs"],
				settings: { lsp: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } },
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "controlled output", background: true }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Started independent work."),
			]);
			await harness.session.prompt("Start the background command");
			const jobs = harness.session.backgroundJobs;
			expect(jobs.list()).toHaveLength(1);
			const live = jobs.get(jobs.list()[0].id);
			expect(live).toMatchObject({ status: "running", outputTruncated: truncated });
			expect(live.output).not.toBe("");
			expect(Buffer.byteLength(live.output)).toBeLessThanOrEqual(BACKGROUND_JOB_MAX_OUTPUT_BYTES);
			expect(live.output.trimEnd().split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
			if (!truncated) expect(live.output).toBe(output);

			for (const action of ["read", "wait"] as const) {
				let deliveredText: string | undefined;
				harness.setResponses([
					fauxAssistantMessage(
						fauxToolCall(
							"jobs",
							action === "wait" ? { action, ids: [live.id], timeoutMs: 0 } : { action, id: live.id },
						),
						{ stopReason: "toolUse" },
					),
					(context) => {
						deliveredText = getMessageText(
							context.messages.findLast(
								(message) => message.role === "toolResult" && message.toolName === "jobs",
							),
						);
						return fauxAssistantMessage("The job is still running.");
					},
				]);
				await harness.session.prompt(`Inspect progress with jobs ${action}`);
				const result = harness.session.messages.findLast(
					(message) => message.role === "toolResult" && message.toolName === "jobs",
				);
				expect(result).toMatchObject({ isError: false });
				if (action === "read") {
					expect(deliveredText).toContain(live.output.trimEnd());
					expect(deliveredText?.includes("[Output truncated to the latest 50 KB or 2000 lines.]")).toBe(truncated);
					expect(result).toMatchObject({ details: { backgroundJob: live } });
				} else {
					const wait = result?.role === "toolResult" ? getBackgroundJobWait(result.details) : undefined;
					expect(wait).toMatchObject({ ids: [live.id], mode: "any", reason: "timeout", results: [] });
					expect(wait?.pending).toEqual(jobs.list());
					expect(deliveredText).toContain(`${live.id}: running (pending).`);
					expect(deliveredText).not.toContain(live.output.trimEnd());
				}
				expect(jobs.get(live.id)).toEqual(live);
			}

			initTheme("dark");
			setKeybindings(new KeybindingsManager());
			inspector = new BackgroundJobsInspector(jobs, {
				getHeight: () => 24,
				requestRender: () => {},
				onClose: () => {},
			});
			expect(inspector.render(80).lines.map(stripAnsi).join("\n").includes("Output truncated")).toBe(truncated);
			inspector.handleInput("\r");
			expect(inspector.render(80).lines.map(stripAnsi).join("\n").includes("Output truncated")).toBe(truncated);
		} finally {
			inspector?.dispose();
			finish.resolve();
			if (harness) {
				try {
					await harness.session.waitForBackgroundJobs();
					for (const job of harness.session.backgroundJobs.list()) {
						const terminal = harness.session.backgroundJobs.get(job.id);
						const fullOutputPath = terminal.output.match(/Full output: (.+)\]/)?.[1];
						if (fullOutputPath) await rm(fullOutputPath, { force: true });
					}
				} finally {
					await harness.cleanupAsync();
				}
			}
		}
	});
});
