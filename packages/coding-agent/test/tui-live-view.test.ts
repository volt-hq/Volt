/**
 * The TUI's live view: work progress shows while its live value is set, and
 * a reset of the live state ends it.
 */

import { describe, expect, it } from "vitest";
import { TuiLiveView } from "../src/modes/interactive/live-view.ts";

describe("TUI live view", () => {
	it("shows work progress until its value clears or the live state resets", () => {
		const shown: Array<[string, string | undefined]> = [];
		const view = new TuiLiveView({
			showRequest: async () => undefined,
			answer: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setTitle: () => {},
			notify: () => {},
			setEditorText: () => {},
			showWork: (workId, value) => shown.push([workId, value?.progress?.text]),
		});
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
});
