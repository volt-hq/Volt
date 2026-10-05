import { join } from "node:path";
import type { JsonValue } from "@hansjm10/volt-ai";
import type { MessagePresentation } from "@hansjm10/volt-protocol";
import { resetCapabilitiesCache, setCapabilities, setCellDimensions, type TUI, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CustomMessage } from "../src/core/messages.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { presentBackground, presentBash, presentRead, presentWrite } from "../src/core/tools/presenters.ts";
import { HOST_UI_POLICY, type PresenterSet, type ToolPresenter } from "../src/core/ui/presentation.ts";
import { PresentedMessageComponent } from "../src/modes/interactive/components/presented-message.ts";
import { PresentedToolComponent } from "../src/modes/interactive/components/presented-tool.ts";
import { STREAMING_RENDER_INTERVAL_MS } from "../src/modes/interactive/components/streaming-render-coalescer.ts";
import type { ToolCardWork } from "../src/modes/interactive/ui-node/tool-card.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import * as imageConvert from "../src/utils/image-convert.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A presenter set holding `present` for every tool, or none. */
function presenters(present: ToolPresenter | undefined): PresenterSet {
	return {
		generation: 0,
		tool: () => (present === undefined ? undefined : { present, policy: HOST_UI_POLICY }),
		message: () => undefined,
	};
}

function row(
	toolName: string,
	args: Record<string, unknown>,
	present: ToolPresenter | undefined,
	options: ConstructorParameters<typeof PresentedToolComponent>[5] = {},
) {
	const requestRender = vi.fn();
	const set = presenters(present);
	const component = new PresentedToolComponent(
		toolName,
		args,
		() => set,
		{ requestRender } as unknown as TUI,
		process.cwd(),
		options,
	);
	return { component, requestRender };
}

function customMessage(customType: string, content: string, details?: JsonValue): CustomMessage<JsonValue> {
	return {
		role: "custom",
		customType,
		content,
		display: true,
		...(details === undefined ? {} : { details }),
		timestamp: 0,
	};
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
		const message = new PresentedMessageComponent(customMessage("deploy-note", "deployed"), () => ({
			title: "Deploy finished",
			summary: [{ type: "text", text: "3 services" }],
			body: [{ type: "keyValue", items: [{ label: "api", value: "ok" }] }],
		}));
		const collapsed = message.render(60).lines.map(stripAnsi).join("\n");
		expect(collapsed).toContain("Deploy finished");
		expect(collapsed).toContain("3 services");
		expect(collapsed).toContain("to expand");
		message.setExpanded(true);
		const expanded = message.render(60).lines.map(stripAnsi).join("\n");
		expect(expanded).toContain("api: ok");
		expect(expanded).not.toContain("3 services");
		const untitled = new PresentedMessageComponent(customMessage("deploy-note", "deployed"), () => ({
			body: [{ type: "text", text: "body" }],
		}));
		expect(untitled.render(60).lines.map(stripAnsi).join("\n")).toContain("deploy-note");
	});

	it("draws a custom message without a presentation as its label and Markdown text", () => {
		const message = new PresentedMessageComponent(customMessage("note", "**Bold** text"), () => undefined);
		const rendered = message.render(60).lines.map(stripAnsi).join("\n");
		expect(rendered).toContain("note");
		expect(rendered).toContain("Bold text");
		expect(rendered).not.toContain("**Bold**");
	});

	it("presents again with the presenters there are now: a disabled extension's presenter no longer draws", () => {
		let enabled = true;
		const extension: ToolPresenter = () => ({
			title: "deploy (extension)",
			summary: [{ type: "text", text: "ext" }],
		});
		const set: PresenterSet = {
			generation: 0,
			tool: () => (enabled ? { present: extension, policy: HOST_UI_POLICY } : undefined),
			message: () => undefined,
		};
		const component = new PresentedToolComponent(
			"deploy",
			{ target: "prod" },
			() => set,
			{ requestRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "shipped" }], isError: false });
		expect(text(component)).toContain("deploy (extension)");
		enabled = false;
		// Re-renders keep the presentation; refreshing presents it again.
		expect(text(component)).toContain("deploy (extension)");
		component.refreshPresentation();
		const generic = text(component);
		expect(generic).not.toContain("deploy (extension)");
		expect(generic).toContain("shipped");
		component.dispose();

		let presentation: MessagePresentation | undefined = { body: [{ type: "text", text: "styled by ext" }] };
		const message = new PresentedMessageComponent(customMessage("deploy-note", "plain text"), () => presentation);
		expect(message.render(60).lines.map(stripAnsi).join("\n")).toContain("styled by ext");
		presentation = undefined;
		message.refreshPresentation();
		const plain = message.render(60).lines.map(stripAnsi).join("\n");
		expect(plain).toContain("plain text");
		expect(plain).not.toContain("styled by ext");
	});

	it("does not list again the work its presentation shows with an action", () => {
		const present: ToolPresenter = () => ({
			title: "Subagents",
			summary: [
				{
					type: "card",
					key: "child",
					title: "worker",
					actions: [{ id: "open", label: "Open", intent: { type: "open_work", input: { workId: "sa_1" } } }],
				},
			],
		});
		const work: ToolCardWork[] = [
			{ workId: "sa_1", title: "child task", status: "running" },
			{ workId: "job_2", title: "other job", status: "running" },
		];
		const { component } = row("subagent", {}, present, { work: () => work });
		component.updateResult({ content: [], isError: false });
		const rendered = text(component);
		expect(rendered).not.toContain("child task");
		expect(rendered).toContain("Running · other job");
		component.dispose();
	});

	it("shows how long each timed step ran, and how long an active one runs so far", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const present: ToolPresenter = () => ({
			title: "steps",
			summary: [
				{
					type: "progress",
					kind: "steps",
					steps: [
						{ label: "first", status: "done", startedAt: 1_000, endedAt: 3_500 },
						{ label: "second", status: "active", detail: "busy", startedAt: 8_000 },
						{ label: "third", status: "pending" },
					],
				},
			],
		});
		const { component } = row("steps", {}, present);
		component.updateResult({ content: [], isError: false }, true);
		let rendered = text(component);
		expect(rendered).toContain("first  2.5s");
		expect(rendered).toContain("second  busy · 2.0s");
		vi.setSystemTime(13_000);
		rendered = text(component);
		expect(rendered).toContain("second  busy · 5.0s");
		component.dispose();
	});

	it("hides a call whose presentation is hidden", () => {
		const { component } = row("quiet", {}, () => ({ title: "quiet", hidden: true }));
		expect(component.render(120).lines).toEqual([]);
		component.updateResult({ content: [], isError: false });
		expect(component.render(120).lines).toEqual([]);
		component.dispose();
	});

	it("presents a call without a presenter generically: its output collapsed to ten lines", () => {
		const { component } = row("custom_tool", {}, undefined);
		component.updateResult({
			content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join("\n") }],
			isError: false,
		});
		const collapsed = text(component, 120);
		expect(collapsed).toContain("line-10");
		expect(collapsed).not.toContain("line-11");
		expect(collapsed).toContain("to expand");
		component.setExpanded(true);
		const expanded = text(component, 120);
		expect(expanded).toContain("line-11");
		expect(expanded).toContain("line-30");

		const short = row("custom_tool", {}, undefined).component;
		short.updateResult({ content: [{ type: "text", text: "short-1\nshort-2" }], isError: false });
		expect(text(short, 120)).toContain("short-2");
		expect(text(short, 120)).not.toContain("to expand");
		component.dispose();
		short.dispose();
	});

	it("hides a sub-second duration once the call ended", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const { component } = row("bash", { command: "true" }, presentBash, { liveProgress: true });
		component.markExecutionStarted();
		vi.setSystemTime(1_400);
		component.updateResult({ content: [], isError: false });
		expect(text(component)).toContain("$ true [success]");
		expect(text(component)).not.toContain("0.4s");
		component.dispose();
	});

	it("presents streaming arguments at most once per interval and the latest at completion", () => {
		vi.useFakeTimers();
		const seen: unknown[] = [];
		const present: ToolPresenter = (input) => {
			seen.push(input.args);
			return { title: "preview" };
		};
		const { component } = row("preview", {}, present);
		try {
			for (let index = 0; index < 1000; index++) component.updateArgs({ text: String(index) });
			expect(seen).toEqual([{}, { text: "0" }]);
			vi.advanceTimersByTime(STREAMING_RENDER_INTERVAL_MS);
			expect(seen.at(-1)).toEqual({ text: "999" });
			component.updateArgs({ text: "final" });
			component.setArgsComplete();
			expect(seen.at(-1)).toEqual({ text: "final" });
			const count = seen.length;
			vi.advanceTimersByTime(STREAMING_RENDER_INTERVAL_MS * 2);
			expect(seen).toHaveLength(count);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			component.dispose();
		}
	});

	it("drops a queued presentation on disposal and shows a failure at once", () => {
		vi.useFakeTimers();
		const present = vi.fn<ToolPresenter>(() => ({ title: "preview" }));
		const { component } = row("preview", {}, present);
		component.updateArgs({ step: 1 });
		component.updateArgs({ step: 2 });
		component.updateResult({ content: [{ type: "text", text: "Stopped" }], isError: true });
		expect(text(component)).toContain("[failure]");
		component.dispose();
		const count = present.mock.calls.length;
		vi.advanceTimersByTime(STREAMING_RENDER_INTERVAL_MS * 2);
		expect(present).toHaveBeenCalledTimes(count);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("converts a non-PNG result image before Sixel shows it", async () => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const { component, requestRender } = row("custom_tool", {}, undefined);
			component.updateResult({
				content: [
					{ type: "image", mimeType: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" },
				],
				isError: false,
			});
			expect(component.render(120).lines.join("\n")).not.toContain("\x1bP0;1;0q");
			requestRender.mockClear();
			await vi.waitFor(() => expect(component.render(120).lines.join("\n")).toContain("\x1bP0;1;0q"));
			expect(requestRender).toHaveBeenCalled();
			component.dispose();
		} finally {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("does not apply or render-request a conversion after disposal", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const conversion = Promise.withResolvers<{ data: string; mimeType: string } | null>();
		vi.spyOn(imageConvert, "convertToPng").mockReturnValue(conversion.promise);
		try {
			const { component, requestRender } = row("custom_tool", {}, undefined);
			component.updateResult({
				content: [{ type: "image", mimeType: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP8=" }],
				isError: false,
			});
			requestRender.mockClear();
			component.dispose();
			conversion.resolve({ data: PNG, mimeType: "image/png" });
			await conversion.promise;
			await Promise.resolve();
			expect(requestRender).not.toHaveBeenCalled();
			expect(component.render(80).lines).toEqual([]);
		} finally {
			vi.restoreAllMocks();
		}
	});
});
