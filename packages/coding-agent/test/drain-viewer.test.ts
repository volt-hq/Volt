/**
 * TUI drain-viewer seams (§6.3): pending acquire enters a read-only overlay
 * that renders viewer events through the real message components, submit is
 * blocked (typed text stays in the editor un-submitted), esc aborts the remote
 * turn, and the warm grant reloads the session and dismisses the overlay.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { getMarkdownTheme, initTheme } from "../src/core/theme/runtime.ts";
import type { AcquireOutcome } from "../src/modes/interactive/daemon-attach.ts";
import { DrainViewerComponent } from "../src/modes/interactive/drain-viewer.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const proto = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

function createContext() {
	const context = {
		drainViewer: undefined as DrainViewerComponent | undefined,
		drainViewerFeedId: undefined as string | undefined,
		ui: { requestRender: vi.fn() },
		chatContainer: { addChild: vi.fn() },
		settingsManager: { getShowImages: () => false, getImageWidthCells: () => 40 },
		sessionManager: { getCwd: () => "/tmp" },
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		getRegisteredToolDefinition: () => undefined,
		daemonAttach: {
			viewerSubscribe: vi.fn(async () => {}),
			viewerAbort: vi.fn(async () => {}),
			relayCount: () => 0,
		},
		session: { reload: vi.fn(async () => {}), isStreaming: false },
		renderCurrentSessionState: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		lastQuitWarningAt: 0,
		enterDrainViewer: proto.enterDrainViewer,
		finishDrainViewerGrant: proto.finishDrainViewerGrant,
		// finishDrainViewerGrant reloads the session through this; the mock session
		// has no sessionFile, so it takes the settings-reload fallback (session.reload).
		absorbRemoteSessionChangesFromDisk: proto.absorbRemoteSessionChangesFromDisk,
		exitDrainViewer: proto.exitDrainViewer,
		isDrainViewerActive: proto.isDrainViewerActive,
		confirmQuitWithAttachedPhone: proto.confirmQuitWithAttachedPhone,
	};
	return context;
}

function deferredGrant() {
	let resolve: (value: { handoff: "cold" | "warm" | "none" }) => void = () => {};
	let reject: (error: Error) => void = () => {};
	const promise = new Promise<{ handoff: "cold" | "warm" | "none" }>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeAll(() => {
	initTheme();
});

describe("drain viewer (§6.3)", () => {
	it("renders viewer events read-only and takes over warm on grant", async () => {
		const context = createContext();
		const grant = deferredGrant();
		const pending: AcquireOutcome = { kind: "pending", viewerFeedId: "vf-1", granted: grant.promise };

		proto.enterDrainViewer.call(context, pending);
		expect(context.drainViewerFeedId).toBe("vf-1");
		expect(proto.isDrainViewerActive.call(context)).toBe(true);
		expect(context.daemonAttach.viewerSubscribe).toHaveBeenCalledWith("vf-1");
		expect(context.chatContainer.addChild).toHaveBeenCalledTimes(1);

		const viewer = context.drainViewer as DrainViewerComponent;
		expect(viewer).toBeInstanceOf(DrainViewerComponent);

		// Assistant streaming renders through the real message component.
		viewer.handleViewerEvent({
			type: "message_start",
			message: { role: "assistant", content: [{ type: "text", text: "remote says hi" }] },
		});
		viewer.handleViewerEvent({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "remote says hi from the phone" }] },
		});
		const rendered = stripAnsi(viewer.render(80).join("\n"));
		expect(rendered).toContain("remote says hi from the phone");
		expect(rendered).toContain("finishing remote turn");

		// Warm grant: reload from file, re-render, overlay dismissed.
		grant.resolve({ handoff: "warm" });
		await vi.waitFor(() => {
			expect(context.session.reload).toHaveBeenCalledTimes(1);
			expect(context.renderCurrentSessionState).toHaveBeenCalledTimes(1);
		});
		expect(proto.isDrainViewerActive.call(context)).toBe(false);
		expect(context.drainViewerFeedId).toBeUndefined();
	});

	it("shows only the spinner after a truncated feed", () => {
		const context = createContext();
		const grant = deferredGrant();
		proto.enterDrainViewer.call(context, { kind: "pending", viewerFeedId: "vf-2", granted: grant.promise });
		const viewer = context.drainViewer as DrainViewerComponent;
		viewer.handleViewerEvent({
			type: "message_start",
			message: { role: "assistant", content: [{ type: "text", text: "will be dropped" }] },
		});
		viewer.handleViewerEvent({ kind: "truncated" });
		viewer.handleViewerEvent({
			type: "message_start",
			message: { role: "assistant", content: [{ type: "text", text: "ignored after truncation" }] },
		});
		const rendered = stripAnsi(viewer.render(80).join("\n"));
		expect(rendered).not.toContain("will be dropped");
		expect(rendered).not.toContain("ignored after truncation");
		expect(rendered).toContain("finishing remote turn");
		grant.reject(new Error("test over"));
	});

	it("drain failure exits the overlay with a warning instead of taking over", async () => {
		const context = createContext();
		const grant = deferredGrant();
		proto.enterDrainViewer.call(context, { kind: "pending", viewerFeedId: "vf-3", granted: grant.promise });
		grant.reject(new Error("drain_failed"));
		await vi.waitFor(() => {
			expect(context.showWarning).toHaveBeenCalledTimes(1);
		});
		expect(proto.isDrainViewerActive.call(context)).toBe(false);
		expect(context.session.reload).not.toHaveBeenCalled();
	});

	it("quit warns once when a phone is attached mid-turn, then confirms (§6.2)", () => {
		const context = createContext();
		context.session.isStreaming = true;
		context.daemonAttach.relayCount = () => 1;

		expect(proto.confirmQuitWithAttachedPhone.call(context)).toBe(false);
		expect(context.showWarning).toHaveBeenCalledTimes(1);
		// A second quit within the confirmation window proceeds.
		expect(proto.confirmQuitWithAttachedPhone.call(context)).toBe(true);

		// No phone attached or no streaming turn: no warning at all.
		const calm = createContext();
		calm.session.isStreaming = false;
		expect(proto.confirmQuitWithAttachedPhone.call(calm)).toBe(true);
		expect(calm.showWarning).not.toHaveBeenCalled();
	});
});
