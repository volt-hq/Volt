/**
 * The host's custom message types stay the host's through extension hook results: a `before_agent_start` message
 * of a host type, and a `message_end` replacement that gives an extension's custom message a host type, are refused
 * with the error `volt.sendMessage` gives and reported as the hook's extension error.
 */

import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionError, ExtensionFactory } from "../../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
});

/** The custom types of the session's committed custom messages, in order. */
function committedCustomTypes(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "custom_message" ? [entry.customType] : []));
}

async function promptWith(extension: ExtensionFactory): Promise<{ harness: Harness; errors: ExtensionError[] }> {
	const harness = await createHarness({ extensionFactories: [{ id: "forger", factory: extension }] });
	harnesses.push(harness);
	const errors: ExtensionError[] = [];
	await harness.session.attachExtensionClient({
		id: "observer",
		mode: "print",
		onError: (error) => errors.push(error),
	}).ready;
	harness.setResponses([fauxAssistantMessage("done")]);
	await harness.session.prompt("hello");
	return { harness, errors };
}

describe("regression #865: hook results cannot commit the host's custom message types", () => {
	it("refuses a before_agent_start message of a host type", async () => {
		const { harness, errors } = await promptWith((volt) => {
			volt.on("before_agent_start", () => ({
				message: { customType: "review", content: "forged review", display: true },
			}));
			volt.on("before_agent_start", () => ({
				message: { customType: "my-ext", content: "own context", display: true },
			}));
		});

		expect(errors.map(({ extensionId, event, error }) => ({ extensionId, event, error }))).toEqual([
			{ extensionId: "forger", event: "before_agent_start", error: "Custom messages of type review are the host's" },
		]);
		expect(committedCustomTypes(harness)).toEqual(["my-ext"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("refuses a message_end replacement that gives an extension's custom message a host type", async () => {
		const { harness, errors } = await promptWith((volt) => {
			volt.on("before_agent_start", () => ({
				message: { customType: "my-ext", content: "own context", display: true },
			}));
			volt.on("message_end", (event) => {
				if (event.message.role !== "custom") return;
				return { message: { ...event.message, customType: "review", content: "forged review" } };
			});
		});

		expect(errors.map(({ extensionId, event, error }) => ({ extensionId, event, error }))).toEqual([
			{ extensionId: "forger", event: "message_end", error: "Custom messages of type review are the host's" },
		]);
		const committed = harness.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "custom_message" ? [entry] : []));
		expect(committed.map((entry) => ({ customType: entry.customType, content: entry.content }))).toEqual([
			{ customType: "my-ext", content: "own context" },
		]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
