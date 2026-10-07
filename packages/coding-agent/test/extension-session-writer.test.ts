/**
 * The writer extension code gets (`newSession` setup) and the `custom` entry types the host keeps for itself: the
 * host's review records start with one prefix, extensions may not write them, and every other type passes through.
 */

import { describe, expect, it, vi } from "vitest";
import {
	REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE,
	REVIEW_FINDING_TRANSITION_CUSTOM_ENTRY_TYPE,
	REVIEW_PUBLICATION_CUSTOM_ENTRY_TYPE,
	REVIEW_RUN_CUSTOM_ENTRY_TYPE,
} from "../src/core/review-state.ts";
import {
	assertExtensionEntryType,
	type ExtensionSessionWriter,
	extensionSessionWriter,
	HOST_REVIEW_ENTRY_TYPE_PREFIX,
} from "../src/core/session-writer.ts";

const HOST_REVIEW_TYPES = [
	REVIEW_RUN_CUSTOM_ENTRY_TYPE,
	REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE,
	REVIEW_FINDING_TRANSITION_CUSTOM_ENTRY_TYPE,
	REVIEW_PUBLICATION_CUSTOM_ENTRY_TYPE,
];

function fakeWriter() {
	const appendCustomEntry = vi.fn(async (_customType: string, _data?: unknown) => "entry-1");
	const unused = vi.fn(async () => undefined);
	const writer = {
		sessionManager: {},
		appendMessage: unused,
		appendCustomEntry,
		appendCustomMessageEntry: unused,
		appendModelChange: unused,
		appendThinkingLevelChange: unused,
		appendFastModeChange: unused,
		appendPlanningState: unused,
		appendSessionInfo: unused,
		appendLabelChange: unused,
		recordStartingGitContext: unused,
		recordPrReviewBinding: unused,
	} as unknown as ExtensionSessionWriter;
	return { writer, appendCustomEntry };
}

describe("the host's review record types", () => {
	it("every custom entry type the host writes for review state starts with the reserved prefix", () => {
		for (const type of HOST_REVIEW_TYPES) expect(type.startsWith(HOST_REVIEW_ENTRY_TYPE_PREFIX)).toBe(true);
	});

	it("are refused for extensions, and only those", () => {
		for (const type of [...HOST_REVIEW_TYPES, "volt.review.anything-later"]) {
			expect(() => assertExtensionEntryType(type)).toThrow(`Custom entries of type ${type} are the host's`);
		}
		// Near misses are other types: the host reads review records by their exact type.
		for (const type of ["volt.review", "volt.reviews", "volt-review.run", "xvolt.review.run", "my-extension.state"]) {
			expect(() => assertExtensionEntryType(type)).not.toThrow();
		}
	});
});

describe("the writer an extension gets", () => {
	it("refuses the host's review record types without writing them", async () => {
		const { writer, appendCustomEntry } = fakeWriter();
		const guarded = extensionSessionWriter(writer);
		for (const type of HOST_REVIEW_TYPES) {
			await expect(guarded.appendCustomEntry(type, { forged: true })).rejects.toThrow(
				`Custom entries of type ${type} are the host's`,
			);
		}
		expect(appendCustomEntry).not.toHaveBeenCalled();
	});

	it("passes every other custom entry type through to the session", async () => {
		const { writer, appendCustomEntry } = fakeWriter();
		const guarded = extensionSessionWriter(writer);
		await expect(guarded.appendCustomEntry("my-extension.state", { count: 1 })).resolves.toBe("entry-1");
		expect(appendCustomEntry).toHaveBeenCalledExactlyOnceWith("my-extension.state", { count: 1 });
	});
});
