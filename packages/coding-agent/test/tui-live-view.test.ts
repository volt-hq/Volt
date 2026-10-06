/**
 * The TUI's live view of its client's live frames: work progress shows while
 * its live value is set, and a reset of the live state ends it; panels follow
 * their values and, patched, show as the client's live fold holds them; an
 * `editor_text` request is answered at once with the editor's text.
 */

import {
	emptyLiveFold,
	foldLiveFrame,
	type HostResponse,
	type LiveFoldState,
	type LiveItem,
	type LiveValue,
} from "@hansjm10/volt-protocol";
import { describe, expect, it } from "vitest";
import { type LiveViewHost, TUI_HOST_REQUESTS, TuiLiveView } from "../src/modes/interactive/live-view.ts";
import type { UiPanel } from "../src/modes/interactive/ui-node/panels.ts";

function createHost(overrides: Partial<LiveViewHost> = {}): LiveViewHost {
	return {
		showRequest: async () => undefined,
		answer: () => {},
		setStatus: () => {},
		setPanel: () => {},
		setTitle: () => {},
		notify: () => {},
		setEditorText: () => {},
		insertEditorText: () => {},
		editorText: () => undefined,
		showWork: () => {},
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
	it("shows work progress until its value clears or the live state resets", () => {
		const shown: Array<[string, string | undefined]> = [];
		const view = new TuiLiveView(
			createHost({ showWork: (workId, value) => shown.push([workId, value?.progress?.text]) }),
		);
		const work = (workId: string, text: string) =>
			({
				type: "set",
				key: `work/${workId}`,
				value: { kind: "work", workId, progress: { text } },
			}) as const;
		view.apply({ reset: false, items: [work("a", "one"), work("b", "two")] });
		view.apply({ reset: false, items: [{ type: "clear", key: "work/a" }] });
		view.apply({ reset: true, items: [] });
		expect(shown).toEqual([
			["a", "one"],
			["b", "two"],
			["a", undefined],
			["b", undefined],
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
});
