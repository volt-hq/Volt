import { type TUI, visibleWidth } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { BackgroundJobManager, type BackgroundJobSnapshot } from "../src/core/background-jobs.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { backgroundJobResult, withBackgroundJobs } from "../src/core/tools/background.ts";
import { createSubagentToolDefinition, type SubagentToolDetails } from "../src/core/tools/subagent.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const job: BackgroundJobSnapshot = {
	id: "job_12345678-1234-1234-1234-123456789abc",
	toolName: "subagent",
	toolCallId: "background-subagent-call",
	label: "Inspect the auth flow",
	status: "running",
	startedAt: 1,
	output: "",
	outputTruncated: false,
};

function createComponent() {
	const manager = new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 });
	const definition = withBackgroundJobs(
		createSubagentToolDefinition({
			manager: {
				getDefinition: () => {
					throw new Error("Render-only test must not resolve an agent");
				},
				startByName: async () => {
					throw new Error("Render-only test must not start an agent");
				},
			},
		}),
		{ manager },
	);
	return new ToolExecutionComponent(
		"subagent",
		job.toolCallId,
		{ agent: "scout", task: job.label, background: true },
		{},
		definition,
		{ requestRender: () => {} } as unknown as TUI,
		process.cwd(),
	);
}

describe("background subagent tool rows", () => {
	beforeAll(() => initTheme("dark"));

	it.each([120, 32])("shows a native job acknowledgement without child metadata at width %i", (width) => {
		const component = createComponent();
		try {
			component.markExecutionStarted();
			expect(component.render(width).lines).toEqual([]);
			component.updateResult({ ...backgroundJobResult(job), isError: false });

			for (const expanded of [false, true]) {
				component.setExpanded(expanded);
				const lines = component.render(width).lines;
				const rendered = lines.map(stripAnsi).join("\n");
				expect(rendered).toContain("Background job");
				if (expanded) expect(rendered.replace(/\s/g, "")).toContain(job.id);
				else expect(rendered).not.toContain(job.id);
				expect(rendered.replace(/\s+/g, " ")).toContain("Inspect the auth flow");
				expect(rendered).not.toContain("Use jobs with action");
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		} finally {
			component.dispose();
		}
	});

	it("keeps a background spawn confirmation preflight hidden", () => {
		const component = createComponent();
		try {
			component.markExecutionStarted();
			component.updateResult({
				content: [{ type: "text", text: "No subagents started. Confirm the exact request." }],
				details: {
					mode: "list",
					status: "completed",
					summary: { total: 0, completed: 0, failed: 0, aborted: 0, running: 0 },
				} satisfies SubagentToolDetails,
				isError: false,
			});
			for (const width of [120, 32]) expect(component.render(width).lines).toEqual([]);
		} finally {
			component.dispose();
		}
	});

	it.each([
		null,
		[],
		{},
		{ ...job, id: "" },
		{ ...job, id: "job_" },
		{ ...job, toolName: "bash" },
		{ ...job, toolCallId: "another-call" },
		{ ...job, status: "unknown" },
	])("does not reveal a spawn row for invalid background metadata %j", (backgroundJob) => {
		const component = createComponent();
		try {
			component.updateResult({
				content: [{ type: "text", text: "Not an acknowledged job" }],
				details: { backgroundJob },
				isError: false,
			});
			expect(component.render(120).lines).toEqual([]);
		} finally {
			component.dispose();
		}
	});
});
