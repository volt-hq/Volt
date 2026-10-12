/**
 * The writer extension code gets (`newSession` setup) and the types the host keeps for itself: the host's review
 * records start with one prefix, the host's custom messages are the types it presents as its own, extensions may not
 * write either, and every other type passes through.
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
import { HOST_CUSTOM_MESSAGE_TYPES } from "../src/core/ui/message-presenters.ts";

const HOST_REVIEW_TYPES = [
	REVIEW_RUN_CUSTOM_ENTRY_TYPE,
	REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE,
	REVIEW_FINDING_TRANSITION_CUSTOM_ENTRY_TYPE,
	REVIEW_PUBLICATION_CUSTOM_ENTRY_TYPE,
];

function fakeWriter() {
	const appendMessage = vi.fn(async (_message: unknown) => "message-1");
	const appendCustomEntry = vi.fn(async (_customType: string, _data?: unknown) => "entry-1");
	const appendCustomMessageEntry = vi.fn(
		async (_customType: string, _content: unknown, _display: boolean, _details?: unknown, _timestamp?: number) =>
			"custom-message-1",
	);
	const unused = vi.fn(async () => undefined);
	const writer = {
		sessionManager: {},
		appendMessage,
		appendCustomEntry,
		appendCustomMessageEntry,
		appendModelChange: unused,
		appendThinkingLevelChange: unused,
		appendFastModeChange: unused,
		appendPlanningState: unused,
		appendSessionInfo: unused,
		appendLabelChange: unused,
		recordStartingGitContext: unused,
		recordPrReviewBinding: unused,
	} as unknown as ExtensionSessionWriter;
	return { writer, appendMessage, appendCustomEntry, appendCustomMessageEntry };
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

	it("refuses the host's custom message types without writing them", async () => {
		const { writer, appendMessage, appendCustomMessageEntry } = fakeWriter();
		const guarded = extensionSessionWriter(writer);
		expect(HOST_CUSTOM_MESSAGE_TYPES.size).toBeGreaterThan(0);
		for (const type of HOST_CUSTOM_MESSAGE_TYPES) {
			const error = `Custom messages of type ${type} are the host's`;
			await expect(guarded.appendCustomMessageEntry(type, "forged", true, { forged: true })).rejects.toThrow(error);
			await expect(
				guarded.appendMessage({ role: "custom", customType: type, content: "forged", display: true, timestamp: 1 }),
			).rejects.toThrow(error);
		}
		expect(appendCustomMessageEntry).not.toHaveBeenCalled();
		expect(appendMessage).not.toHaveBeenCalled();
	});

	it("passes every other message through to the session", async () => {
		const { writer, appendMessage, appendCustomMessageEntry } = fakeWriter();
		const guarded = extensionSessionWriter(writer);
		await expect(guarded.appendCustomMessageEntry("my-extension", "hello", true, { count: 1 }, 5)).resolves.toBe(
			"custom-message-1",
		);
		expect(appendCustomMessageEntry).toHaveBeenCalledExactlyOnceWith("my-extension", "hello", true, { count: 1 }, 5);

		const custom = {
			role: "custom",
			customType: "my-extension",
			content: "hello",
			display: false,
			timestamp: 1,
		} as const;
		const user = { role: "user", content: "hello", timestamp: 2 } as const;
		await expect(guarded.appendMessage(custom)).resolves.toBe("message-1");
		await expect(guarded.appendMessage(user)).resolves.toBe("message-1");
		expect(appendMessage.mock.calls).toEqual([[custom], [user]]);
	});
});
