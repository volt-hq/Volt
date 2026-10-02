import { type TUI, visibleWidth } from "@hansjm10/volt-tui";
import { describe, expect, it } from "vitest";
import { lspOperationMetadata, lspResult } from "../src/core/lsp/outcome.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";

describe("LSP tool cards", () => {
	it.each([80, 120, 160])("renders success, uncertainty, failure and idle status at %i columns", (width) => {
		initTheme("dark", true);
		for (const state of ["healthy", "degraded", "error", "idle"] as const) {
			const action = state === "idle" ? "status" : "diagnostics";
			const result = lspResult(
				state === "error" ? "unavailable" : "empty",
				state === "idle"
					? "typescript: idle"
					: state === "error"
						? "TypeScript 6.0.2 is incompatible; native LSP requires >=7."
						: "No diagnostics reported.",
				{
					source: state === "degraded" ? "push" : "none",
					freshness: state === "degraded" ? "unverified" : "unknown",
				},
			);
			const card = new ToolExecutionComponent(
				"lsp",
				state,
				{ action, path: "src/main.ts" },
				{},
				undefined,
				{ requestRender() {} } as TUI,
				"/workspace",
			);
			try {
				card.setArgsComplete();
				card.updateResult({
					content: [{ type: "text", text: result.text }],
					details: { action, lsp: lspOperationMetadata(result, "explicit", action, performance.now()) },
					isError: state === "error",
				});
				const lines = card.render(width).lines;
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				const output = lines.join("\n");
				expect(output).toContain(state === "error" ? "[failure]" : "[success]");
				if (state === "degraded") expect(output).toContain("unverified (push)");
				if (state === "idle") expect(output).toContain("typescript: idle");
			} finally {
				card.dispose();
			}
		}
	});
});
