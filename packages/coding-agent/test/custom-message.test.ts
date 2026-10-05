import type { JsonValue } from "@hansjm10/volt-ai";
import type { WorkNoticeDetails } from "@hansjm10/volt-protocol";
import { Container, getKeybindings, isViewportTUI, ScrollView, setKeybindings, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { SessionPresenters } from "../src/core/session/presenters.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { workNoticeOwnText } from "../src/core/ui/message-presenters.ts";
import { HOST_UI_POLICY } from "../src/core/ui/presentation.ts";
import type { PresentedMessageComponent } from "../src/modes/interactive/components/presented-message.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { builtinSessionPresenters, presentedMessage } from "./utilities/test-presenters.ts";

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

const draw = presentedMessage;

describe("custom messages in the transcript", () => {
	test("draws a message without a presenter as a quiet labeled transcript entry", () => {
		const component = draw({
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

	test.each([80, 40])("presents a compact review without overflowing %s columns", (width) => {
		const message = createReviewMessage();
		const component = draw(message);
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
		expect(text).toContain("ctrl+o to expand");
		expect(text).not.toContain("Coverage evidence");
		expect(text).not.toContain("retained-file-");
		expect(text).not.toContain("retained-hunk-");
		expect(text).not.toContain("Ask which findings to fix");
		expect(message.content).toBe(fullReport);
	});

	test.each([80, 40])("expands all public content and recollapses at %s columns", (width) => {
		const component = draw(createReviewMessage());
		const collapsed = component.render(width).lines.map(stripAnsi);

		component.setExpanded(true);
		const lines = component.render(width).lines.map(stripAnsi);
		const text = lines.join(" ").replace(/\s+/g, " ");
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(text).toContain("Full public review report");
		for (const evidence of [...retainedFiles, ...retainedHunks]) expect(text).toContain(evidence);
		expect(text).toContain("Model-reported limits: discovery: 2; verification: 1.");
		expect(text).toContain("Ask which findings to fix before editing files.");
		expect(text).not.toContain("No verified P0-P2 findings");

		component.setExpanded(false);
		expect(component.render(width).lines.map(stripAnsi)).toEqual(collapsed);
		component.invalidate();
		expect(component.render(width).lines.map(stripAnsi)).toEqual(collapsed);
	});

	test("presents a review restored from serialized metadata as the original", () => {
		const message = createReviewMessage();
		const restored = JSON.parse(JSON.stringify(message)) as CustomMessage;
		const original = draw(message);
		const reconstructed = draw(restored);
		expect(reconstructed.render(80)).toEqual(original.render(80));
		original.setExpanded(true);
		reconstructed.setExpanded(true);
		expect(reconstructed.render(80)).toEqual(original.render(80));
	});

	test("keeps a review a host message: an extension's presenter for its type is refused", () => {
		const presenters = new SessionPresenters({
			tool: () => undefined,
			message: () => ({ present: () => ({ body: [{ type: "text", text: "restyled" }] }), extensionId: "styler" }),
			ownsWork: () => false,
		});
		expect(presenters.message("review")?.policy).toEqual(HOST_UI_POLICY);
		expect(presenters.message("work_notice")?.policy).toEqual(HOST_UI_POLICY);
		expect(presenters.message("subagent_recovery")).toBeUndefined();
		expect(presenters.message("volt-plan-execution")).toBeUndefined();
		expect(presenters.message("deploy-note")?.policy).toMatchObject({ owner: "extension", extensionId: "styler" });
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
	test.each(invalidReviewMetadata)("presents a review with invalid metadata as its text: %j", (details) => {
		const component = draw({
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
		const component = draw({
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
		expect(text).not.toContain("to expand");
		component.setExpanded(true);
		expect(component.render(40).lines.map(stripAnsi)).toEqual(collapsed);
	});

	test("uses an empty string summary without showing full content by default", () => {
		const component = draw({ ...createReviewMessage(), details: { summary: "" } });
		const text = component.render(80).lines.map(stripAnsi).join("\n");
		expect(text).not.toContain("Full public review report");
		expect(text).toContain("ctrl+o to expand");
	});

	test("resolves current configured expansion keys when rebuilding", () => {
		const keybindings = new KeybindingsManager({ "app.tools.expand": ["ctrl+shift+x", "f8"] });
		setKeybindings(keybindings);
		const component = draw(createReviewMessage());
		expect(component.render(80).lines.map(stripAnsi).join("\n")).toContain("ctrl+shift+x/f8 to expand");

		keybindings.setUserBindings({ "app.tools.expand": "f6" });
		component.invalidate();
		const rebuilt = component.render(80).lines.map(stripAnsi).join("\n");
		expect(rebuilt).toContain("f6 to expand");
		expect(rebuilt).not.toContain("ctrl+o");
		expect(rebuilt).not.toContain("ctrl+shift+x");
	});

	test("presents a work notice: the line naming the work literal, the kind's own text as Markdown", () => {
		const details = {
			workId: "ext-1",
			kind: "ext:swarm-review/run",
			title: "Swarm **review**",
			outcome: "completed",
			summary: "2 findings",
		};
		const heading = "Swarm **review** (ext:swarm-review/run ext-1) completed.";
		const notice = (content: string, noticeDetails: JsonValue | undefined = details) =>
			draw({
				role: "custom",
				customType: "work_notice",
				content,
				display: true,
				...(noticeDetails === undefined ? {} : { details: noticeDetails }),
				timestamp: 0,
			});
		const text = (component: PresentedMessageComponent) => component.render(80).lines.map(stripAnsi).join("\n");

		const plain = text(notice(`${heading}\n2 findings`));
		expect(plain).toContain("Swarm **review** (ext:swarm-review/run ext-1) completed.");
		expect(plain).toContain("2 findings");
		expect(workNoticeOwnText(`${heading}\n2 findings`, details as WorkNoticeDetails)).toBeUndefined();

		const own = `${heading}\n## Findings\n- **High:** token leak`;
		expect(workNoticeOwnText(own, details as WorkNoticeDetails)).toBe("## Findings\n- **High:** token leak");
		const rendered = text(notice(own));
		// The heading names the work as data; the kind's text is Markdown.
		expect(rendered).toContain("Swarm **review** (ext:swarm-review/run ext-1) completed.");
		expect(rendered).toContain("High: token leak");
		expect(rendered).not.toContain("**High:**");
		expect(rendered).not.toContain("## Findings");

		// The kind's text loses terminal controls before it renders.
		const escaped = notice(`${heading}\nReport \x1b[31mred\x1b[0m done \x07`);
		expect(escaped.render(80).lines.join("\n")).not.toMatch(/\x1b\[31m|\x07/);
		expect(text(escaped)).toContain("Report red done");

		// A notice whose text does not start with its heading stays literal.
		expect(text(notice("**not** the heading"))).toContain("**not** the heading");
		expect(text(notice("**literal**", undefined))).toContain("**literal**");
	});

	test.each(["regular", "fullscreen"] as const)(
		"retains review metadata and global expansion through %s transcript reconstruction",
		async (tuiMode) => {
			const message = createReviewMessage();
			const sessionManager = SessionManager.inMemory();
			await sessionManager.logWriter.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			const transcript = new Container();
			const terminal = new VirtualTerminal(80, 24);
			const ui = createInteractiveTui({ tuiMode, terminal, showHardwareCursor: false, logDirectory: "/tmp" });
			ui.addChild(transcript);
			if (isViewportTUI(ui)) ui.setLayoutRoot(new ScrollView(transcript, { follow: "end", primary: true }));
			const mode = Object.assign(Object.create(InteractiveMode.prototype) as object, {
				conversation: {
					session: {
						sessionManager,
						get messages() {
							return [...sessionManager.getConversationState().context.messages];
						},
						presenters: builtinSessionPresenters(),
						settingsManager: { getCodeBlockIndent: () => "  ", isProjectTrusted: () => true },
					},
				},
				chatContainer: transcript,
				pendingTools: new Map(),
				liveBackgroundJobTools: new Map(),
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
				expect(terminal.getViewport().join("\n")).toContain("ctrl+o to expand");
				expect(terminal.getViewport().join("\n")).not.toContain("Coverage evidence");
			} finally {
				ui.stop({ preserveScreen: true });
			}
		},
	);
});
