import { readFileSync, rmSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBashTool } from "../../../src/core/tools/bash.ts";
import { DEFAULT_MAX_LINES } from "../../../src/core/tools/truncate.ts";
import { createHarness, getMessageText } from "../harness.ts";

describe("regression #536: cooperative cancellation retains tool output", () => {
	const cleanups: Array<() => void | Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it.each(["caller", "stall"] as const)(
		"persists bash output and the original %s cancellation reason",
		async (cause) => {
			const started = Promise.withResolvers<void>();
			const aborted = Promise.withResolvers<void>();
			const finishCleanup = Promise.withResolvers<void>();
			const output = "initial output\n".repeat(DEFAULT_MAX_LINES + 1);
			const bash = createBashTool(process.cwd(), {
				operations: {
					exec: async (_command, _cwd, { onData, signal }) => {
						signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
						onData(Buffer.from(output));
						started.resolve();
						await aborted.promise;
						await finishCleanup.promise;
						onData(Buffer.from("final cleanup output\n"));
						throw new Error("aborted");
					},
				},
			});
			const harness = await createHarness({ tools: [bash] });
			cleanups.push(() => harness.cleanupAsync());
			cleanups.push(() => finishCleanup.resolve());
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("bash", { command: "controlled command", stallTimeout: cause === "stall" ? 0.01 : 0 }),
					{ stopReason: "toolUse" },
				),
			]);
			const prompt = harness.session.prompt("run the controlled command");
			await started.promise;
			if (cause === "stall") await aborted.promise;
			const cancellation = harness.session.abort("keyboard_interrupt");
			await aborted.promise;
			const settled = vi.fn();
			void cancellation.then(settled);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(settled).not.toHaveBeenCalled();
			finishCleanup.resolve();
			await Promise.all([prompt, cancellation]);

			const result = harness.sessionManager
				.buildSessionContext()
				.messages.find((message) => message.role === "toolResult");
			expect(result).toMatchObject({ isError: true, toolName: "bash" });
			const text = getMessageText(result);
			expect(text).toContain("final cleanup output");
			expect(text).toContain(cause === "stall" ? "killed as hung" : "Command aborted");
			if (cause === "stall") expect(text).not.toContain("Command aborted");
			const outputPath = /Full output: ([^\]\r\n]+)/.exec(text)?.[1];
			expect(outputPath).toBeDefined();
			if (!outputPath) throw new Error("expected full output path");
			cleanups.push(() => rmSync(outputPath, { force: true }));
			expect(readFileSync(outputPath, "utf8")).toBe(`${output}final cleanup output\n`);
			expect(
				harness
					.eventsOfType("tool_execution_update")
					.some((event) => getMessageText(event.partialResult).includes("final cleanup output")),
			).toBe(true);
		},
	);
});
