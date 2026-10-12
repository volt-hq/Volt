/**
 * Regression #862: the writer an extension's `ctx.newSession({ setup })` callback gets refuses the custom message
 * types the host presents as its own, through `appendCustomMessageEntry` and through `appendMessage` of a custom
 * message, with the error `volt.sendMessage` gives. The extension's own message types still commit.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { HOST_CUSTOM_MESSAGE_TYPES } from "../../../src/core/ui/message-presenters.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { createHostHarness, type HostHarness } from "../host-harness.ts";

/** The custom message types of a session's entries, written as `custom_message` or as a `custom` role message. */
function customMessageTypes(entries: readonly SessionEntry[]): string[] {
	return entries.flatMap((entry) => {
		if (entry.type === "custom_message") return [entry.customType];
		if (entry.type === "message" && entry.message.role === "custom") return [entry.message.customType];
		return [];
	});
}

describe("regression #862: the newSession setup writer refuses the host's custom message types", () => {
	const harnesses: HostHarness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	it("refuses them in appendCustomMessageEntry and appendMessage, and commits the extension's own", async () => {
		const refusals: string[] = [];
		let written: string[] | undefined;
		const refused = (error: unknown) => {
			refusals.push(error instanceof Error ? error.message : String(error));
		};
		const harness = await createHostHarness({
			extension: (volt) => {
				volt.registerCommand("seed", {
					handler: async (_args, ctx) => {
						await ctx.newSession({
							setup: async (writer) => {
								for (const type of HOST_CUSTOM_MESSAGE_TYPES) {
									await writer.appendCustomMessageEntry(type, "forged", true).catch(refused);
									await writer
										.appendMessage({
											role: "custom",
											customType: type,
											content: "forged",
											display: true,
											timestamp: Date.now(),
										})
										.catch(refused);
								}
								await writer.appendCustomMessageEntry("my-extension", "own entry", true);
								await writer.appendMessage({
									role: "custom",
									customType: "my-extension",
									content: "own message",
									display: true,
									timestamp: Date.now(),
								});
								written = customMessageTypes(writer.sessionManager.getEntries());
							},
						});
					},
				});
			},
		});
		harnesses.push(harness);
		const source = await harness.openStartup();

		expect(await runPrintMode(harness.host, source, { mode: "text", messages: ["/seed"] })).toBe(0);

		expect(refusals).toEqual(
			[...HOST_CUSTOM_MESSAGE_TYPES].flatMap((type) => [
				`Custom messages of type ${type} are the host's`,
				`Custom messages of type ${type} are the host's`,
			]),
		);
		expect(written).toEqual(["my-extension", "my-extension"]);
	});
});
