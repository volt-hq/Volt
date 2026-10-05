import { join } from "node:path";
import { resetCapabilitiesCache, setCapabilities, type TUI, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "../src/core/theme/runtime.ts";
import { presentBackground, presentBash, presentRead, presentWrite } from "../src/core/tools/presenters.ts";
import type { ToolPresenter } from "../src/core/ui/presentation.ts";
import { PresentedMessageComponent } from "../src/modes/interactive/components/presented-message.ts";
import { PresentedToolComponent } from "../src/modes/interactive/components/presented-tool.ts";
import type { ToolCardWork } from "../src/modes/interactive/ui-node/tool-card.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function row(
	toolName: string,
	args: Record<string, unknown>,
	present: ToolPresenter,
	options: ConstructorParameters<typeof PresentedToolComponent>[5] = {},
) {
	const requestRender = vi.fn();
	const component = new PresentedToolComponent(
		toolName,
		args,
		{ present, policy: { owner: "host" } },
		{ requestRender } as unknown as TUI,
		process.cwd(),
		options,
	);
	return { component, requestRender };
}

function text(component: PresentedToolComponent, width = 80): string {
	const lines = component.render(width).lines;
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	return lines.map(stripAnsi).join("\n");
}

describe("presented tool rows", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		vi.useRealTimers();
		resetCapabilitiesCache();
	});

	it("labels a growing write preview as generation until execution begins", () => {
		vi.useFakeTimers();
		const { component } = row("write", { path: "story.txt", content: "First line" }, presentWrite, {
			liveProgress: true,
		});
		try {
			component.updateArgs({ path: "story.txt", content: "First line\nSecond line" });
			vi.advanceTimersByTime(1000);
			const preview = text(component);
			expect(preview).toContain("Second line");
			expect(preview).toContain("[pending] Generating content");
			for (const phase of [
				{ status: "[pending] Waiting to run", transition: () => component.setArgsComplete() },
				{ status: "[running] Writing file", transition: () => component.markExecutionStarted() },
			]) {
				phase.transition();
				for (const width of [20, 32, 80, 140]) {
					const rendered = text(component, width).replace(/\s+/g, " ");
					if (width >= 32) expect(rendered).toContain("story.txt");
					if (width >= 80) expect(rendered).toContain(phase.status);
				}
			}
		} finally {
			component.dispose();
		}
	});

	it("shows a running call's elapsed time once, ticking until it ends", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const { component, requestRender } = row("bash", { command: "sleep 5" }, presentBash, { liveProgress: true });
		try {
			component.markExecutionStarted();
			vi.advanceTimersByTime(2_000);
			expect(text(component)).toContain("$ sleep 5 [running] (2.0s)");
			expect(requestRender).toHaveBeenCalled();
			vi.setSystemTime(6_000);
			component.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
			const rendered = text(component);
			expect(rendered).toContain("[success] (5.0s)");
			expect(rendered.match(/5\.0s/g)).toHaveLength(1);
			const renders = requestRender.mock.calls.length;
			vi.advanceTimersByTime(5_000);
			expect(requestRender).toHaveBeenCalledTimes(renders);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			component.dispose();
		}
	});

	it("does not time calls replayed from the log", () => {
		vi.useFakeTimers();
		const { component } = row("bash", { command: "ls" }, presentBash);
		component.updateResult({ content: [{ type: "text", text: "a\nb" }], isError: false });
		expect(text(component)).toContain("$ ls [success]");
		expect(text(component)).not.toContain("s)");
		expect(vi.getTimerCount()).toBe(0);
		component.dispose();
	});

	it("collapses to the summary and expands to the body", () => {
		const { component } = row("read", { path: join(process.cwd(), ".volt", "AGENTS.md") }, presentRead);
		component.updateResult({ content: [{ type: "text", text: "Hidden resource instructions" }], isError: false });
		const collapsed = text(component);
		expect(collapsed).toContain("read resource .volt/AGENTS.md");
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("Hidden resource instructions");
		component.setExpanded(true);
		expect(text(component)).toContain("Hidden resource instructions");
		component.dispose();
	});

	it("shows the result's images only while images are shown", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const { component } = row("read", { path: "pixel.png" }, presentRead);
		component.updateResult(
			{
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: PNG, mimeType: "image/png" },
				],
				isError: false,
			},
			false,
		);
		expect(component.render(80).images.length).toBe(1);
		component.setShowImages(false);
		expect(component.render(80).images.length).toBe(0);
		component.dispose();
	});

	it("shows the work its call started, live, and its output", () => {
		let work: ToolCardWork[] = [];
		const { component } = row("bash", { command: "npm test", background: true }, presentBackground(presentBash), {
			work: () => work,
		});
		const job = { id: "job_1", tool: "bash", toolCallId: "call", label: "npm test", status: "running" };
		component.updateResult({
			content: [{ type: "text", text: "Background job job_1: running (bash)." }],
			details: { job },
			isError: false,
		});
		expect(text(component)).toContain("Background job");
		work = [
			{
				workId: "job_1",
				title: "npm test",
				status: "running",
				elapsedMs: 18_000,
				text: "Tests 12 passed",
				output: "old line\nPASS one\nPASS two\nTests 12 passed\n",
			},
		];
		component.invalidate();
		let rendered = text(component);
		expect(rendered).toContain("Running · npm test · 18.0s");
		expect(rendered).toContain("Tests 12 passed");
		expect(rendered).not.toContain("old line");
		component.setExpanded(true);
		expect(text(component)).toContain("old line");
		component.setExpanded(false);
		work = [{ workId: "job_1", title: "npm test", status: "failed", elapsedMs: 20_000, output: "FAIL one" }];
		component.invalidate();
		rendered = text(component);
		expect(rendered).toContain("Failed · npm test · 20.0s");
		expect(rendered).toContain("FAIL one");
		component.dispose();
	});

	it("draws a presented custom message: its summary collapsed, its body expanded", () => {
		const message = new PresentedMessageComponent("deploy-note", {
			title: "Deploy finished",
			summary: [{ type: "text", text: "3 services" }],
			body: [{ type: "keyValue", items: [{ label: "api", value: "ok" }] }],
		});
		const collapsed = message.render(60).lines.map(stripAnsi).join("\n");
		expect(collapsed).toContain("Deploy finished");
		expect(collapsed).toContain("3 services");
		expect(collapsed).toContain("to expand");
		message.setExpanded(true);
		const expanded = message.render(60).lines.map(stripAnsi).join("\n");
		expect(expanded).toContain("api: ok");
		expect(expanded).not.toContain("3 services");
		const untitled = new PresentedMessageComponent("deploy-note", { body: [{ type: "text", text: "body" }] });
		expect(untitled.render(60).lines.map(stripAnsi).join("\n")).toContain("deploy-note");
	});
});
