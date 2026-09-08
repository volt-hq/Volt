import type { JsonValue } from "@hansjm10/volt-ai";
import {
	Container,
	getKeybindings,
	isViewportTUI,
	ScrollView,
	setKeybindings,
	Text,
	visibleWidth,
} from "@hansjm10/volt-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { MessageRenderer } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const reviewSummary = [
	"**Review · PR #346 · eec0db3c22ef**",
	"No verified P0-P2 findings in the selected change.",
	"",
	"Static review only. This review did not run tests or runtime checks.",
	"Model-reported limits are recorded in details.",
].join("\n");
const retainedFiles = Array.from({ length: 33 }, (_, index) => `src/retained-file-${index}.ts`);
const retainedHunks = Array.from({ length: 56 }, (_, index) => `retained-hunk-${index}`);
const fullReport = [
	"# Full public review report",
	"",
	"## Coverage evidence",
	"",
	...retainedFiles.map((file) => `- ${file}`),
	...retainedHunks.map((hunk) => `- ${hunk}`),
	"",
	"Model-reported limits: discovery: 2; verification: 1.",
	"",
	"Ask which findings to fix before editing files.",
].join("\n");

function createReviewMessage(): CustomMessage {
	return {
		role: "custom",
		customType: "review",
		content: fullReport,
		display: true,
		details: { summary: reviewSummary, target: "PR #346", completionStatus: "complete", findings: [] },
		timestamp: 0,
	};
}

const previousKeybindings = getKeybindings();
beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	setKeybindings(previousKeybindings);
});

describe("CustomMessageComponent", () => {
	test("renders default extension messages as a quiet labeled transcript entry", () => {
		const component = new CustomMessageComponent({
			role: "custom",
			customType: "session",
			content: "Context compacted",
			display: true,
			timestamp: 0,
		});

		const lines = component.render(40).lines.map(stripAnsi);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("session");
		expect(lines[2]).toContain("Context compacted");
	});

	test.each([80, 40])("renders a compact review without overflowing %s columns", (width) => {
		const message = createReviewMessage();
		const component = new CustomMessageComponent(message);
		const frame = component.render(width);
		const lines = frame.lines.map(stripAnsi);
		const text = lines.join(" ").replace(/\s+/g, " ");

		if (width === 80) expect(lines.length).toBeLessThanOrEqual(10);
		expect(frame.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(frame.images).toEqual([]);
		expect(text).toContain("Review · PR #346 · eec0db3c22ef");
		expect(text).toContain("No verified P0-P2 findings in the selected change.");
		expect(text).toContain("Static review only. This review did not run tests or runtime checks.");
		expect(text).toContain("Model-reported limits are recorded in details.");
		expect(text).toContain("Ctrl+O to expand review details");
		expect(text).not.toContain("Coverage evidence");
		expect(text).not.toContain("retained-file-");
		expect(text).not.toContain("retained-hunk-");
		expect(text).not.toContain("Ask which findings to fix");
		expect(message.content).toBe(fullReport);
	});

	test.each([80, 40])("expands all public content and recollapses at %s columns", (width) => {
		const component = new CustomMessageComponent(createReviewMessage());
		const collapsed = component.render(width).lines.map(stripAnsi);

		component.setExpanded(true);
		const lines = component.render(width).lines.map(stripAnsi);
		const text = lines.join(" ").replace(/\s+/g, " ");
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(text).toContain("Full public review report");
		for (const evidence of [...retainedFiles, ...retainedHunks]) expect(text).toContain(evidence);
		expect(text).toContain("Model-reported limits: discovery: 2; verification: 1.");
		expect(text).toContain("Ask which findings to fix before editing files.");
		expect(text).toContain("Ctrl+O to collapse review details");
		expect(text).not.toContain("No verified P0-P2 findings");

		component.setExpanded(false);
		expect(component.render(width).lines.map(stripAnsi)).toEqual(collapsed);
		component.invalidate();
		expect(component.render(width).lines.map(stripAnsi)).toEqual(collapsed);
	});

	test("reconstructs compact rendering from serialized message metadata", () => {
		const message = createReviewMessage();
		const restored = JSON.parse(JSON.stringify(message)) as CustomMessage;
		const original = new CustomMessageComponent(message);
		const reconstructed = new CustomMessageComponent(restored);
		expect(reconstructed.render(80)).toEqual(original.render(80));
		original.setExpanded(true);
		reconstructed.setExpanded(true);
		expect(reconstructed.render(80)).toEqual(original.render(80));
	});

	test("preserves extension renderer precedence and forwards expansion state", () => {
		const renderer = vi.fn<MessageRenderer>(
			(_message, { expanded }) => new Text(expanded ? "Extension details" : "Extension summary", 1, 0),
		);
		const message = createReviewMessage();
		const component = new CustomMessageComponent(message, renderer);
		expect(component.render(80).lines.map(stripAnsi).join("\n")).toContain("Extension summary");
		expect(component.render(80).lines.map(stripAnsi).join("\n")).not.toContain("Review · PR");
		expect(renderer.mock.calls[0]?.[0]).toBe(message);
		expect(renderer.mock.calls[0]?.[1]).toEqual({ expanded: false });
		component.setExpanded(true);
		const expanded = component.render(80).lines.map(stripAnsi).join("\n");
		expect(expanded).toContain("Extension details");
		expect(expanded).not.toContain("Full public review report");
		expect(expanded).not.toContain("collapse review details");
		expect(renderer.mock.calls.at(-1)?.[1]).toEqual({ expanded: true });
	});

	test.each(["declines", "throws"])("uses the built-in fallback when an extension renderer %s", (outcome) => {
		const renderer: MessageRenderer = () => {
			if (outcome === "throws") throw new Error("Extension rendering failed");
			return undefined;
		};
		const component = new CustomMessageComponent(createReviewMessage(), renderer);
		expect(component.render(80).lines.map(stripAnsi).join("\n")).toContain("Review · PR #346");
		component.setExpanded(true);
		expect(component.render(80).lines.map(stripAnsi).join("\n")).toContain("Full public review report");
		component.setExpanded(false);
		expect(component.render(80).lines.map(stripAnsi).join("\n")).not.toContain("Full public review report");
	});

	const invalidReviewMetadata: (JsonValue | undefined)[] = [
		undefined,
		null,
		"not metadata",
		false,
		[],
		{},
		{ summary: 42 },
		{ summary: null },
		{ summary: [] },
	];
	test.each(invalidReviewMetadata)("keeps generic review rendering for invalid metadata: %j", (details) => {
		const component = new CustomMessageComponent({
			...createReviewMessage(),
			content: "Ordinary review content",
			details,
		});
		const collapsed = component.render(40).lines.map(stripAnsi);
		expect(collapsed).toHaveLength(3);
		expect(collapsed[1]).toContain("review");
		expect(collapsed[2]).toContain("Ordinary review content");
		component.setExpanded(true);
		expect(component.render(40).lines.map(stripAnsi)).toEqual(collapsed);
	});

	test("does not use summary metadata for other custom message types", () => {
		const component = new CustomMessageComponent({
			...createReviewMessage(),
			customType: "session",
			content: [
				{ type: "text", text: "First text part" },
				{ type: "image", mimeType: "image/png", data: "AAAA" },
				{ type: "text", text: "Second text part" },
			],
		});
		const collapsed = component.render(40).lines.map(stripAnsi);
		const text = collapsed.join("\n");
		expect(text).toContain("session");
		expect(text).toContain("First text part");
		expect(text).toContain("Second text part");
		expect(text).not.toContain("Review · PR");
		expect(text).not.toContain("review details");
		component.setExpanded(true);
		expect(component.render(40).lines.map(stripAnsi)).toEqual(collapsed);
	});

	test("uses an empty string summary without showing full content by default", () => {
		const component = new CustomMessageComponent({ ...createReviewMessage(), details: { summary: "" } });
		const text = component.render(80).lines.map(stripAnsi).join("\n");
		expect(text).not.toContain("Full public review report");
		expect(text).toContain("Ctrl+O to expand review details");
	});

	test("resolves current configured expansion keys when rebuilding", () => {
		const keybindings = new KeybindingsManager({ "app.tools.expand": ["ctrl+shift+x", "f8"] });
		setKeybindings(keybindings);
		const component = new CustomMessageComponent(createReviewMessage());
		expect(component.render(80).lines.map(stripAnsi).join("\n")).toContain(
			"Ctrl+Shift+X/F8 to expand review details",
		);

		keybindings.setUserBindings({ "app.tools.expand": "f6" });
		component.invalidate();
		const rebuilt = component.render(80).lines.map(stripAnsi).join("\n");
		expect(rebuilt).toContain("F6 to expand review details");
		expect(rebuilt).not.toContain("Ctrl+O");
		expect(rebuilt).not.toContain("Ctrl+Shift+X");
		component.setExpanded(true);
		expect(component.render(80).lines.map(stripAnsi).join("\n")).toContain("F6 to collapse review details");

		keybindings.setUserBindings({ "app.tools.expand": [] });
		component.setExpanded(false);
		const unbound = component.render(80).lines.map(stripAnsi).join("\n");
		expect(unbound).toContain("Review · PR #346");
		expect(unbound).not.toContain("to expand review details");
	});

	test.each(["regular", "fullscreen"] as const)(
		"retains review metadata and global expansion through %s transcript reconstruction",
		async (tuiMode) => {
			const message = createReviewMessage();
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
			const transcript = new Container();
			const terminal = new VirtualTerminal(80, 24);
			const ui = createInteractiveTui({ tuiMode, terminal, showHardwareCursor: false, logDirectory: "/tmp" });
			ui.addChild(transcript);
			if (isViewportTUI(ui)) ui.setLayoutRoot(new ScrollView(transcript, { follow: "end", primary: true }));
			const mode = Object.assign(Object.create(InteractiveMode.prototype) as object, {
				runtimeHost: {
					session: {
						sessionManager,
						extensionRunner: { getMessageRenderer: () => undefined },
						settingsManager: { getCodeBlockIndent: () => "  ", isProjectTrusted: () => true },
					},
				},
				chatContainer: transcript,
				pendingTools: new Map(),
				toolOutputExpanded: false,
				footer: { invalidate: () => undefined },
				updateEditorBorderColor: () => undefined,
				ui,
			}) as unknown as InteractiveMode;
			const setToolsExpanded = Reflect.get(InteractiveMode.prototype, "setToolsExpanded") as (
				this: InteractiveMode,
				expanded: boolean,
			) => void;
			mode.renderInitialMessages();
			ui.start();
			try {
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("Review · PR #346");
				expect(terminal.getViewport().join("\n")).not.toContain("Coverage evidence");
				const collapsed = ui.render(80).lines.map(stripAnsi);
				expect(collapsed.length).toBeLessThanOrEqual(10);

				setToolsExpanded.call(mode, true);
				const expanded = ui.render(80).lines.map(stripAnsi);
				expect(expanded.join("\n")).toContain(retainedHunks.at(-1));
				transcript.clear();
				mode.renderInitialMessages();
				expect(ui.render(80).lines.map(stripAnsi)).toEqual(expanded);

				setToolsExpanded.call(mode, false);
				transcript.clear();
				mode.renderInitialMessages();
				expect(ui.render(80).lines.map(stripAnsi)).toEqual(collapsed);
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("Ctrl+O to expand review details");
				expect(terminal.getViewport().join("\n")).not.toContain("Coverage evidence");
			} finally {
				ui.stop({ preserveScreen: true });
			}
		},
	);
});
