/**
 * The TUI's live view: work progress shows while its live value is set, and
 * a reset of the live state ends it; panels follow their values and patches;
 * an `editor_text` request is answered at once with the editor's text.
 */

import type { HostResponse, LiveItem, LiveValue } from "@hansjm10/volt-protocol";
import { describe, expect, it } from "vitest";
import { type LiveViewHost, TuiLiveView } from "../src/modes/interactive/live-view.ts";
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
		...overrides,
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
		view.apply({ reset: false, basedOn: 0, items: [work("a", "one"), work("b", "two")] });
		view.apply({ reset: false, basedOn: 0, items: [{ type: "clear", key: "work/a" }] });
		view.apply({ reset: true, basedOn: 0, items: [] });
		expect(shown).toEqual([
			["a", "one"],
			["b", "two"],
			["a", undefined],
			["b", undefined],
		]);
	});

	it("shows panels as their values and patches say, and removes them on clear and reset", () => {
		const panels: Array<[string, UiPanel | undefined]> = [];
		const view = new TuiLiveView(createHost({ setPanel: (key, panel) => panels.push([key, panel]) }));
		const key = "ext_panel/ci/log";
		const panel: LiveValue = {
			kind: "ext_panel",
			extension: "ci",
			title: "CI",
			placement: "sidebar",
			node: { type: "terminal", key: "out", lines: ["one"] },
		};
		const items: LiveItem[] = [
			{ type: "set", key, value: panel },
			{ type: "patch", key, ops: [{ op: "append_lines", path: ["out"], lines: ["two"] }] },
			// A patch that does not apply leaves the panel as it is.
			{ type: "patch", key, ops: [{ op: "remove", path: ["missing"] }] },
		];
		view.apply({ reset: false, basedOn: 0, items });
		view.apply({ reset: false, basedOn: 0, items: [{ type: "clear", key }] });
		view.apply({ reset: false, basedOn: 0, items: [{ type: "set", key, value: panel }] });
		view.apply({ reset: true, basedOn: 0, items: [] });
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
		expect(view.acceptsHostRequest("editor_text")).toBe(true);
		expect(view.acceptsHostRequest("form")).toBe(true);
		expect(view.acceptsHostRequest("dialog")).toBe(true);
		const ask = (requestId: string): LiveItem => ({
			type: "set",
			key: `host_request/${requestId}`,
			value: { kind: "host_request", requestId, request: { kind: "editor_text", timeoutMs: 2000 } },
		});
		view.apply({ reset: false, basedOn: 0, items: [ask("r1")] });
		text = undefined;
		view.apply({ reset: false, basedOn: 0, items: [ask("r2")] });
		view.apply({
			reset: false,
			basedOn: 0,
			items: [{ type: "directive", directive: "insert_editor_text", text: "pasted" }],
		});
		expect(answers).toEqual([
			["r1", { value: "draft" }],
			["r2", { cancelled: true }],
		]);
		expect(shown).toEqual([]);
		expect(inserted).toEqual(["pasted"]);
	});
});
