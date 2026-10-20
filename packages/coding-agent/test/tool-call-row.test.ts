import { join } from "node:path";
import type { JsonValue } from "@hansjm10/volt-ai";
import { type MessagePresentation, PRESENTATION_MAX_SERIALIZED_BYTES } from "@hansjm10/volt-protocol";
import { resetCapabilitiesCache, setCapabilities, setCellDimensions, type TUI, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CustomMessage } from "../src/core/messages.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { presentBackground, presentBash, presentRead, presentWrite } from "../src/core/tools/presenters.ts";
import {
	HOST_UI_POLICY,
	presentToolCall,
	type ToolPresenter,
	type ToolPresentInput,
} from "../src/core/ui/presentation.ts";
import { PresentedMessageComponent } from "../src/modes/interactive/components/presented-message.ts";
import { ToolCallRow, type ToolCallRowOptions } from "../src/modes/interactive/components/tool-call-row.ts";
import type { ToolCardWork } from "../src/modes/interactive/ui-node/tool-card.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import * as imageConvert from "../src/utils/image-convert.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Supply one complete host presentation snapshot; the helper owns no call lifecycle or clock. */
function update(
	component: ToolCallRow,
	present: ToolPresenter | undefined,
	input: Omit<ToolPresentInput, "cwd">,
): void {
	component.update({
		presentation: presentToolCall(
			present === undefined ? undefined : { present, policy: HOST_UI_POLICY },
			component.toolName,
			{ ...input, cwd: process.cwd() },
			PRESENTATION_MAX_SERIALIZED_BYTES,
		),
		state: input.state,
		isError: input.result?.isError === true,
		...(input.result === undefined ? {} : { content: input.result.content }),
	});
}

function row(
	toolName: string,
	present: ToolPresenter | undefined,
	input: Omit<ToolPresentInput, "cwd">,
	options: ToolCallRowOptions = {},
) {
	const requestRender = vi.fn();
	const component = new ToolCallRow(toolName, { requestRender } as unknown as TUI, options);
	update(component, present, input);
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

function text(component: ToolCallRow, width = 80): string {
	const lines = component.render(width).lines;
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	return lines.map(stripAnsi).join("\n");
}

beforeAll(() => initTheme("dark"));
afterEach(() => {
	vi.useRealTimers();
	resetCapabilitiesCache();
});

describe("host-presented tool rows", () => {
	it("labels a growing write preview as generation until execution begins", () => {
		const args = { path: "story.txt", content: "First line\nSecond line" };
		const { component } = row("write", presentWrite, { args, argsComplete: false, state: "pending" });
		try {
			const preview = text(component);
			expect(preview).toContain("2 lines");
			expect(preview).toContain("○ write story.txt Generating content");
			for (const phase of [
				{ status: "○ write story.txt Waiting to run", state: "pending" },
				{ status: "● write story.txt Writing file", state: "running" },
			] as const) {
				update(component, presentWrite, { args, argsComplete: true, state: phase.state });
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

	it("collapses to the summary and expands to the body", () => {
		const { component } = row("read", presentRead, {
			args: { path: join(process.cwd(), ".volt", "AGENTS.md") },
			argsComplete: true,
			state: "done",
			result: { content: [{ type: "text", text: "Hidden resource instructions" }], isError: false, partial: false },
		});
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
		const { component } = row("read", presentRead, {
			args: { path: "pixel.png" },
			argsComplete: true,
			state: "done",
			result: {
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: PNG, mimeType: "image/png" },
				],
				isError: false,
				partial: false,
			},
		});
		expect(component.render(80).images.length).toBe(1);
		component.setShowImages(false);
		expect(component.render(80).images.length).toBe(0);
		component.dispose();
	});

	it("shows the work its call started, live, and its output", () => {
		let work: ToolCardWork[] = [];
		const { component } = row(
			"bash",
			presentBackground(presentBash),
			{
				args: { command: "npm test", background: true },
				argsComplete: true,
				state: "done",
				result: {
					content: [{ type: "text", text: "Background job job_1: running (bash)." }],
					details: {
						job: { id: "job_1", tool: "bash", toolCallId: "call", label: "npm test", status: "running" },
					},
					isError: false,
					partial: false,
				},
			},
			{ work: () => work },
		);
		expect(text(component)).toContain("$ npm test");
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
		const { component } = row(
			"subagent",
			present,
			{ args: {}, argsComplete: true, state: "done" },
			{ work: () => work },
		);
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
		const { component } = row("steps", present, { args: {}, argsComplete: true, state: "running" });
		let rendered = text(component);
		expect(rendered).toContain("first  2.5s");
		expect(rendered).toContain("second  busy · 2.0s");
		vi.setSystemTime(13_000);
		rendered = text(component);
		expect(rendered).toContain("second  busy · 5.0s");
		component.dispose();
	});

	it("hides a call whose presentation is hidden", () => {
		const present = () => ({ title: "quiet", hidden: true });
		const { component } = row("quiet", present, { args: {}, argsComplete: false, state: "pending" });
		expect(component.render(120).lines).toEqual([]);
		update(component, present, { args: {}, argsComplete: true, state: "done" });
		expect(component.render(120).lines).toEqual([]);
		component.dispose();
	});

	it("presents a call without a presenter generically: its output collapsed to ten lines", () => {
		const { component } = row("custom_tool", undefined, {
			args: {},
			argsComplete: true,
			state: "done",
			result: {
				content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join("\n") }],
				isError: false,
				partial: false,
			},
		});
		const collapsed = text(component, 120);
		expect(collapsed).toContain("line-10");
		expect(collapsed).not.toContain("line-11");
		expect(collapsed).toContain("to expand");
		component.setExpanded(true);
		const expanded = text(component, 120);
		expect(expanded).toContain("line-11");
		expect(expanded).toContain("line-30");

		const short = row("custom_tool", undefined, {
			args: {},
			argsComplete: true,
			state: "done",
			result: { content: [{ type: "text", text: "short-1\nshort-2" }], isError: false, partial: false },
		}).component;
		expect(text(short, 120)).toContain("short-2");
		expect(text(short, 120)).not.toContain("to expand");
		component.dispose();
		short.dispose();
	});

	it("hides a sub-second host duration once the call ended", () => {
		const { component } = row("bash", presentBash, {
			args: { command: "true" },
			argsComplete: true,
			state: "done",
			result: { content: [], isError: false, partial: false },
		});
		component.update({ presentation: component.presentation, state: "done", durationMs: 400 });
		expect(text(component)).toContain("✓ $ true");
		expect(text(component)).not.toContain("0.4s");
		component.dispose();
	});

	it("shows a host-presented failure immediately", () => {
		const { component } = row("preview", undefined, { args: {}, argsComplete: true, state: "running" });
		update(component, undefined, {
			args: {},
			argsComplete: true,
			state: "done",
			result: { content: [{ type: "text", text: "Stopped" }], isError: true, partial: false },
		});
		expect(text(component)).toContain("✗ preview");
		expect(text(component)).toContain("Stopped");
		component.dispose();
	});

	it("converts a non-PNG result image before Sixel shows it", async () => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		const { component, requestRender } = row("custom_tool", undefined, {
			args: {},
			argsComplete: true,
			state: "done",
			result: {
				content: [
					{ type: "image", mimeType: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" },
				],
				isError: false,
				partial: false,
			},
		});
		try {
			expect(component.render(120).lines.join("\n")).not.toContain("\x1bP0;1;0q");
			requestRender.mockClear();
			await vi.waitFor(() => expect(component.render(120).lines.join("\n")).toContain("\x1bP0;1;0q"));
			expect(requestRender).toHaveBeenCalled();
		} finally {
			component.dispose();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("does not apply or render-request a conversion after disposal", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const conversion = Promise.withResolvers<{ data: string; mimeType: string } | null>();
		vi.spyOn(imageConvert, "convertToPng").mockReturnValue(conversion.promise);
		try {
			const { component, requestRender } = row("custom_tool", undefined, {
				args: {},
				argsComplete: true,
				state: "done",
				result: {
					content: [{ type: "image", mimeType: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP8=" }],
					isError: false,
					partial: false,
				},
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

describe("host-presented custom messages", () => {
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
		message.dispose();
		untitled.dispose();
	});

	it("draws a custom message without a presentation as its label and Markdown text", () => {
		const message = new PresentedMessageComponent(customMessage("note", "**Bold** text"), () => undefined);
		const rendered = message.render(60).lines.map(stripAnsi).join("\n");
		expect(rendered).toContain("note");
		expect(rendered).toContain("Bold text");
		expect(rendered).not.toContain("**Bold**");
		message.dispose();
	});

	it("refreshes a custom message whose host projection no longer has a presentation", () => {
		let presentation: MessagePresentation | undefined = { body: [{ type: "text", text: "styled by ext" }] };
		const message = new PresentedMessageComponent(customMessage("deploy-note", "plain text"), () => presentation);
		expect(message.render(60).lines.map(stripAnsi).join("\n")).toContain("styled by ext");
		presentation = undefined;
		message.refreshPresentation();
		const plain = message.render(60).lines.map(stripAnsi).join("\n");
		expect(plain).toContain("plain text");
		expect(plain).not.toContain("styled by ext");
		message.dispose();
	});
});
