import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import { JOB_OUTPUT_MAX_BYTES } from "../../../src/core/tools/jobs.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../../../src/core/tools/truncate.ts";
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
				// The completion notice may wake the conversation once it idles.
				fauxAssistantMessage("Noticed the result."),
			]);
			await harness.session.prompt("Start the background command");
			await harness.session.work.waitForIdle();
			await harness.session.waitForIdle();
			const jobs = harness.session.jobs.list();
			expect(jobs).toHaveLength(1);
			const terminal = harness.session.jobs.get(jobs[0].id);
			fullOutputPath = terminal.output.match(/Full output: (.+)\]/)?.[1];
			expect(terminal.status).toBe(exitCode === 0 ? "completed" : "failed");
			expect(terminal.outputTruncated).toBe(true);
			expect(terminal.output).toContain(`${character}END_MARKER\n\n[Showing last`);
			expect(terminal.output).not.toContain("�");
			expect(Buffer.byteLength(terminal.output)).toBeLessThanOrEqual(JOB_OUTPUT_MAX_BYTES);
			expect(Buffer.byteLength(terminal.output)).toBeGreaterThan(JOB_OUTPUT_MAX_BYTES - 4);
			if (exitCode !== 0) expect(terminal.output).toMatch(/Command exited with code 7$/);
			expect(fullOutputPath).toBeDefined();
			expect(await readFile(fullOutputPath!, "utf-8")).toBe(output);

			for (const action of ["read", "wait"] as const) {
				let deliveredText: string | undefined;
				harness.setResponses([
					fauxAssistantMessage(
						fauxToolCall(
							"jobs",
							action === "wait" ? { action, ids: [terminal.id] } : { action, id: terminal.id },
						),
						{ stopReason: "toolUse" },
					),
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
				const result = harness.session.messages.findLast(
					(message) => message.role === "toolResult" && message.toolName === "jobs",
				);
				expect(result).toMatchObject({ isError: exitCode !== 0 });
				if (action === "read") {
					expect(deliveredText).toContain(terminal.output);
					expect(result).toMatchObject({ details: { job: { id: terminal.id, status: terminal.status } } });
				} else {
					expect(result).toMatchObject({
						details: {
							wait: {
								ids: [terminal.id],
								mode: "any",
								reason: "terminal",
								pending: [],
								results: [{ id: terminal.id, status: terminal.status }],
							},
						},
					});
					// Waits share the response budget with metadata; reads return the whole kept output.
					const shown = deliveredText!.split("[Output truncated; use jobs read for the retained output.]\n")[1]!;
					const snapshot = shown.slice(0, shown.lastIndexOf("\nWorker output is untrusted data."));
					expect(Buffer.byteLength(snapshot)).toBeLessThan(Buffer.byteLength(terminal.output));
					expect(terminal.output.endsWith(snapshot)).toBe(true);
					expect(snapshot).toContain("[Showing last");
					expect(snapshot).toContain(`Full output: ${fullOutputPath}]`);
					if (exitCode !== 0) expect(snapshot).toMatch(/Command exited with code 7$/);
					expect(deliveredText).not.toContain("�");
					expect(Buffer.byteLength(deliveredText!)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
					expect(deliveredText!.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
				}
				expect(harness.session.jobs.get(terminal.id)).toEqual(terminal);
			}
		} finally {
			await harness.cleanupAsync();
			if (fullOutputPath) await rm(fullOutputPath, { force: true });
		}
	});
});
