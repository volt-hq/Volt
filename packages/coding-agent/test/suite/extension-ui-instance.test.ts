/**
 * A stopped extension instance's `ctx.ui` stays stopped (RFC §8.2): once the
 * same extension is enabled again, the new instance's `ctx.ui` shows its UI
 * while the old instance's answers as a stopped one does, whatever runs
 * under its id now.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Extension } from "../../src/core/extensions/types.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { type IntentContext, intentRegistry, LOCAL_INTENT_PROFILE } from "../../src/core/protocol/intents/index.ts";
import { createHostHarness } from "./host-harness.ts";

describe("an extension instance's ctx.ui", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(): Promise<{ conversation: HostedConversation; context: () => IntentContext }> {
		const harness = await createHostHarness({
			whenUnattached: "keep",
			extensionMode: "rpc",
			extensions: [
				{
					manifest: { id: "toggled", displayName: "Toggled" },
					factory: (volt) => {
						volt.on("session_start", (_event, ctx) => ctx.ui.setStatus("state", "on"));
					},
				},
			],
		});
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const client = harness.client("local");
		await harness.host.attach(client, conversation);
		return {
			conversation,
			context: () => ({
				target: { session: conversation.session, conversation, host: harness.host, client },
				services: {},
				profile: LOCAL_INTENT_PROFILE,
			}),
		};
	}

	it("stays stopped once its extension runs again as a new instance", async () => {
		const { conversation, context } = await setup();
		const session = conversation.session;
		const runner = session.extensionRunner;
		const first = runner.getExtension("toggled") as Extension;
		expect(first).toBeDefined();

		const setEnabled = (enabled: boolean) =>
			intentRegistry.invoke(context(), "set_extension_enabled", { id: "toggled", enabled, scope: "global" });
		await setEnabled(false);
		await session.extensionRegistry.settled();
		await setEnabled(true);
		const second = runner.getExtension("toggled") as Extension;
		expect(second).toBeDefined();
		expect(second).not.toBe(first);

		// The old instance's UI shows nothing and asks nothing.
		const stale = runner.getUIContext("toggled", first);
		stale.setStatus("stale", "from the old instance");
		expect(conversation.liveState.get("ext_status/toggled/stale")).toBeUndefined();
		await expect(stale.confirm("Still there?", "The old instance asks")).resolves.toBe(false);
		// The new instance's UI shows.
		runner.getUIContext("toggled", second).setStatus("fresh", "from the new instance");
		expect(conversation.liveState.get("ext_status/toggled/fresh")).toBeDefined();
	});
});
