/**
 * The TUI's live view of its client's live frames: work whose live value
 * clears, or that a reset no longer carries, detached; panels follow their
 * values and, patched, show as the client's live fold holds them; notices
 * reach the TUI with their source and detail, the host's own included; an
 * `editor_text` request is answered at once with the editor's text; a
 * provider sign-in shows beside the queue, so the prompts its login asks
 * show while it waits.
 */

import {
	emptyLiveFold,
	foldLiveFrame,
	type HostResponse,
	type LiveFoldState,
	type LiveItem,
	type LiveValue,
} from "@hansjm10/volt-protocol";
import { describe, expect, it, vi } from "vitest";
import { type LiveViewHost, TUI_HOST_REQUESTS, TuiLiveView } from "../src/modes/interactive/live-view.ts";
import type { UiPanel } from "../src/modes/interactive/ui-node/panels.ts";

function createHost(overrides: Partial<LiveViewHost> = {}): LiveViewHost {
	return {
		showRequest: async () => undefined,
		showProviderAuth: async () => undefined,
		answer: () => {},
		setPanel: () => {},
		setTitle: () => {},
		notify: () => {},
		setEditorText: () => {},
		insertEditorText: () => {},
		editorText: () => undefined,
		workDetached: () => {},
		liveValue: () => undefined,
		...overrides,
	};
}

/** A client's live fold feeding the view, as the TUI's store does: the view reads patched values from the fold. */
function followFold(createView: (liveValue: (key: string) => LiveValue | undefined) => TuiLiveView) {
	let fold: LiveFoldState = emptyLiveFold();
	const view = createView((key) => fold.values.get(key));
	return (frame: { reset: boolean; items: LiveItem[] }) => {
		fold = foldLiveFrame(fold, { basedOn: 0, ...frame });
		view.apply(frame);
	};
}

describe("TUI live view", () => {
	it("reports work detached when its value clears or a reset no longer carries it", () => {
		const detached: string[] = [];
		const view = new TuiLiveView(createHost({ workDetached: (workId) => detached.push(workId) }));
		const work = (workId: string, text: string) =>
			({
				type: "set",
				key: `work/${workId}`,
				value: { kind: "work", workId, progress: { text } },
			}) as const;
		view.apply({ reset: false, items: [work("a", "one"), work("b", "two"), work("c", "three")] });
		view.apply({ reset: false, items: [work("a", "one again"), { type: "clear", key: "work/a" }] });
		// A reset that still carries work keeps it running.
		view.apply({ reset: true, items: [work("c", "three")] });
		view.apply({ reset: true, items: [] });
		expect(detached).toEqual(["a", "b", "c"]);
	});

	it("shows every notice with its source and detail, the host's own included", () => {
		const notices: unknown[][] = [];
		const view = new TuiLiveView(
			createHost({ notify: (level, message, source, detail) => notices.push([level, message, source, detail]) }),
		);
		view.apply({
			reset: false,
			items: [
				{ type: "notice", level: "error", message: "Compaction cancelled", source: "host" },
				{
					type: "notice",
					level: "error",
					message: "tool_call: boom",
					source: "ci",
					detail: "Error: boom\n    at x",
				},
				{ type: "notice", level: "info", message: "hello" },
			],
		});
		expect(notices).toEqual([
			["error", "Compaction cancelled", "host", undefined],
			["error", "tool_call: boom", "ci", "Error: boom\n    at x"],
			["info", "hello", undefined, undefined],
		]);
	});

	it("shows panels as their values and patches say, and removes them on clear and reset", () => {
		const panels: Array<[string, UiPanel | undefined]> = [];
		const apply = followFold(
			(liveValue) => new TuiLiveView(createHost({ setPanel: (key, panel) => panels.push([key, panel]), liveValue })),
		);
		const key = "ext_panel/ci/log";
		const panel: LiveValue = {
			kind: "ext_panel",
			extension: "ci",
			title: "CI",
			placement: "sidebar",
			node: { type: "terminal", key: "out", lines: ["one"] },
		};
		apply({ reset: false, items: [{ type: "set", key, value: panel }] });
		apply({
			reset: false,
			items: [{ type: "patch", key, ops: [{ op: "append_lines", path: ["out"], lines: ["two"] }] }],
		});
		apply({ reset: false, items: [{ type: "clear", key }] });
		apply({ reset: false, items: [{ type: "set", key, value: panel }] });
		apply({ reset: true, items: [] });
		const node = (lines: string[]) => ({ type: "terminal", key: "out", lines });
		expect(panels).toEqual([
			[key, { title: "CI", placement: "sidebar", node: node(["one"]) }],
			[key, { title: "CI", placement: "sidebar", node: node(["one", "two"]) }],
			[key, undefined],
			[key, { title: "CI", placement: "sidebar", node: node(["one"]) }],
			[key, undefined],
		]);
	});

	it("answers editor text requests at once, without showing them", () => {
		const answers: Array<[string, HostResponse]> = [];
		const shown: string[] = [];
		const inserted: string[] = [];
		let text: string | undefined = "draft";
		const view = new TuiLiveView(
			createHost({
				showRequest: async (request) => {
					shown.push(request.kind);
					return undefined;
				},
				answer: (requestId, response) => answers.push([requestId, response]),
				editorText: () => text,
				insertEditorText: (value) => inserted.push(value),
			}),
		);
		expect(TUI_HOST_REQUESTS).toEqual(expect.arrayContaining(["editor_text", "form", "dialog"]));
		const ask = (requestId: string): LiveItem => ({
			type: "set",
			key: `host_request/${requestId}`,
			value: { kind: "host_request", requestId, request: { kind: "editor_text", timeoutMs: 2000 } },
		});
		view.apply({ reset: false, items: [ask("r1")] });
		text = undefined;
		view.apply({ reset: false, items: [ask("r2")] });
		view.apply({ reset: false, items: [{ type: "directive", directive: "insert_editor_text", text: "pasted" }] });
		expect(answers).toEqual([
			["r1", { value: "draft" }],
			["r2", { cancelled: true }],
		]);
		expect(shown).toEqual([]);
		expect(inserted).toEqual(["pasted"]);
	});

	it("shows a provider sign-in beside the queue until it is answered or ends", async () => {
		const answers: Array<[string, HostResponse]> = [];
		const shown: string[] = [];
		const signIns: Array<{ readonly provider: string; readonly signal: AbortSignal }> = [];
		const cancelled = Promise.withResolvers<HostResponse>();
		const view = new TuiLiveView(
			createHost({
				showRequest: async (request) => {
					shown.push(request.kind === "input" ? `input:${request.title}` : request.kind);
					return { value: "code" };
				},
				showProviderAuth: (request, signal) => {
					signIns.push({ provider: request.provider, signal });
					return signIns.length === 1 ? new Promise(() => {}) : cancelled.promise;
				},
				answer: (requestId, response) => answers.push([requestId, response]),
			}),
		);
		expect(TUI_HOST_REQUESTS).toContain("provider_auth");
		const ask = (requestId: string, request: Extract<LiveValue, { kind: "host_request" }>["request"]): LiveItem => ({
			type: "set",
			key: `host_request/${requestId}`,
			value: { kind: "host_request", requestId, request },
		});
		view.apply({
			reset: false,
			items: [
				ask("auth", { kind: "provider_auth", provider: "acme", flow: "browser", url: "https://acme.test/login" }),
				ask("code", { kind: "input", title: "Paste the code" }),
			],
		});
		// The login's prompt shows while its sign-in waits.
		await vi.waitFor(() => expect(answers).toEqual([["code", { value: "code" }]]));
		expect(shown).toEqual(["input:Paste the code"]);
		expect(signIns.map((signIn) => signIn.provider)).toEqual(["acme"]);

		// The host ends the sign-in: it closes without an answer.
		view.apply({ reset: false, items: [{ type: "clear", key: "host_request/auth" }] });
		expect(signIns[0]?.signal.aborted).toBe(true);

		// Cancelling a sign-in answers it.
		view.apply({
			reset: false,
			items: [ask("device", { kind: "provider_auth", provider: "acme", flow: "device", userCode: "ABCD" })],
		});
		cancelled.resolve({ cancelled: true });
		await vi.waitFor(() => expect(answers).toContainEqual(["device", { cancelled: true }]));
	});
});
