import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import { BACKGROUND_JOB_MAX_OUTPUT_BYTES } from "../../../src/core/background-jobs.ts";
import { createHarness, getMessageText } from "../harness.ts";

// PR #380, finding e213d190-0dfb-490e-878e-0f62135d570b: bounding Bash's
// formatted final result discarded the long output line before its footer.
describe("background Bash long-line snapshots", () => {
	it.each([
		["ASCII", "x", 0],
		["ASCII", "x", 7],
		["UTF-8", "😀", 0],
		["UTF-8", "😀", 7],
	] as const)("retains %s (%s) output and footer after exit code %i", async (_encoding, character, exitCode) => {
		const harness = await createHarness({
			initialActiveToolNames: ["bash", "jobs"],
			settings: { lsp: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } },
		});
		let fullOutputPath: string | undefined;
		try {
			const output = `${character.repeat(60 * 1024)}END_MARKER`;
			await writeFile(join(harness.tempDir, "output.txt"), output);
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("bash", { command: `cat output.txt; exit ${exitCode}`, background: true }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Started independent work."),
			]);
			await harness.session.prompt("Start the background command");
			await harness.session.waitForBackgroundJobs();
			const jobs = harness.session.backgroundJobs.list();
			expect(jobs).toHaveLength(1);
			const terminal = harness.session.backgroundJobs.get(jobs[0].id);
			fullOutputPath = terminal.output.match(/Full output: (.+)\]/)?.[1];
			expect(terminal.status).toBe(exitCode === 0 ? "completed" : "failed");
			expect(terminal.outputTruncated).toBe(true);
			expect(terminal.output).toContain(`${character}END_MARKER\n\n[Showing last`);
			expect(terminal.output).not.toContain("�");
			expect(Buffer.byteLength(terminal.output)).toBeLessThanOrEqual(BACKGROUND_JOB_MAX_OUTPUT_BYTES);
			expect(Buffer.byteLength(terminal.output)).toBeGreaterThan(BACKGROUND_JOB_MAX_OUTPUT_BYTES - 4);
			if (exitCode !== 0) expect(terminal.output).toMatch(/Command exited with code 7$/);
			expect(fullOutputPath).toBeDefined();
			expect(await readFile(fullOutputPath!, "utf-8")).toBe(output);

			for (const action of ["read", "wait"] as const) {
				let deliveredText: string | undefined;
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("jobs", { action, id: terminal.id }), { stopReason: "toolUse" }),
					(context) => {
						deliveredText = getMessageText(
							context.messages.findLast(
								(message) => message.role === "toolResult" && message.toolName === "jobs",
							),
						);
						return fauxAssistantMessage("Collected the result.");
					},
				]);
				await harness.session.prompt(`Collect the result with jobs ${action}`);
				expect(deliveredText).toContain(terminal.output);
				expect(
					harness.session.messages.findLast(
						(message) => message.role === "toolResult" && message.toolName === "jobs",
					),
				).toMatchObject({ isError: exitCode !== 0, details: { backgroundJob: terminal } });
				expect(harness.session.backgroundJobs.get(terminal.id)).toEqual(terminal);
			}
		} finally {
			await harness.cleanupAsync();
			if (fullOutputPath) await rm(fullOutputPath, { force: true });
		}
	});
});
