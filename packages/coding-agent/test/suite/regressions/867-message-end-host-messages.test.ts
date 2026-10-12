/**
 * The host's custom messages commit as the host sent them through `message_end`: a handler can pass one through
 * unchanged, but a replacement that changes its content, details, or display is refused with the error
 * `volt.sendMessage` gives and reported as the hook's extension error.
 */

import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionError, ExtensionFactory } from "../../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
});

/** Send the host's plan execution message through a turn, with `extension` handling `message_end`. */
async function sendHostMessageWith(
	extension: ExtensionFactory,
): Promise<{ harness: Harness; errors: ExtensionError[] }> {
	const harness = await createHarness({ extensionFactories: [{ id: "editor", factory: extension }] });
	harnesses.push(harness);
	const errors: ExtensionError[] = [];
	await harness.session.attachExtensionClient({
		id: "observer",
		mode: "print",
		onError: (error) => errors.push(error),
	}).ready;
	harness.setResponses([fauxAssistantMessage("done")]);
	await harness.session.sendCustomMessage(
		{ customType: "volt-plan-execution", content: "host text", display: true },
		{ triggerTurn: true },
	);
	return { harness, errors };
}

/** The session's committed custom messages. */
function committedCustomMessages(harness: Harness) {
	return harness.sessionManager.getEntries().flatMap((entry) =>
		entry.type === "custom_message"
			? [
					{
						customType: entry.customType,
						content: entry.content,
						display: entry.display,
						details: entry.details,
					},
				]
			: [],
	);
}

describe("regression #867: message_end cannot rewrite the host's custom messages", () => {
	it("refuses a replacement that changes a host message's content and details", async () => {
		const { harness, errors } = await sendHostMessageWith((volt) => {
			volt.on("message_end", (event) => {
				if (event.message.role !== "custom") return;
				return { message: { ...event.message, content: "forged", details: { forged: true } } };
			});
		});

		expect(errors.map(({ extensionId, event, error }) => ({ extensionId, event, error }))).toEqual([
			{
				extensionId: "editor",
				event: "message_end",
				error: "Custom messages of type volt-plan-execution are the host's",
			},
		]);
		expect(committedCustomMessages(harness)).toEqual([
			{ customType: "volt-plan-execution", content: "host text", display: true, details: undefined },
		]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("refuses a replacement that changes a host message's display", async () => {
		const { harness, errors } = await sendHostMessageWith((volt) => {
			volt.on("message_end", (event) => {
				if (event.message.role !== "custom") return;
				return { message: { ...event.message, display: false } };
			});
		});

		expect(errors.map(({ event, error }) => ({ event, error }))).toEqual([
			{ event: "message_end", error: "Custom messages of type volt-plan-execution are the host's" },
		]);
		expect(committedCustomMessages(harness)).toEqual([
			{ customType: "volt-plan-execution", content: "host text", display: true, details: undefined },
		]);
	});

	it("lets a handler pass a host message through unchanged", async () => {
		const { harness, errors } = await sendHostMessageWith((volt) => {
			volt.on("message_end", (event) => ({ message: event.message }));
		});

		expect(errors).toEqual([]);
		expect(committedCustomMessages(harness)).toEqual([
			{ customType: "volt-plan-execution", content: "host text", display: true, details: undefined },
		]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
