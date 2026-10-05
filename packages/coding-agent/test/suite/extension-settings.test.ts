/**
 * Extension settings in a host (RFC §8.2): the `extension_settings` query and
 * the `set_extension_settings` intent (local and remote with
 * `host.manage.v1`, project writes only for trusted projects), and
 * `settings_changed` reaching the extension in every open conversation,
 * including for `volt.updateSettings`.
 */

import type { ExtensionSettings } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsChangedEvent } from "../../src/core/extensions/types.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import {
	type IntentContext,
	type IntentProfile,
	intentRegistry,
	LOCAL_INTENT_PROFILE,
} from "../../src/core/protocol/intents/index.ts";
import { queryRegistry } from "../../src/core/protocol/queries/index.ts";
import { createIrohRemoteRpcGrant } from "../../src/core/remote/iroh/access-grant.ts";
import { createHostHarness, type HostHarness } from "./host-harness.ts";

const ID = "test-extension";

const SETTINGS: ExtensionSettings = {
	type: "object",
	properties: {
		organization: { type: "string", minLength: 1 },
		mode: { type: "string", enum: ["fast", "careful"], default: "fast" },
		maxLoops: { type: "integer", minimum: 1, maximum: 10, default: 3 },
	},
};

describe("extension settings in a host", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	interface Opened {
		readonly conversation: HostedConversation;
		readonly changes: SettingsChangedEvent[];
		context(profile?: IntentProfile): IntentContext;
	}

	async function setup(onLoad?: (settings: unknown) => void): Promise<{
		harness: HostHarness;
		open(clientId: string): Promise<Opened>;
		updates: Array<(values: SettingsChangedEvent["settings"]) => Promise<void>>;
	}> {
		const changesBySession = new Map<string, SettingsChangedEvent[]>();
		const changesFor = (sessionId: string): SettingsChangedEvent[] => {
			let changes = changesBySession.get(sessionId);
			if (!changes) {
				changes = [];
				changesBySession.set(sessionId, changes);
			}
			return changes;
		};
		const updates: Array<(values: SettingsChangedEvent["settings"]) => Promise<void>> = [];
		const harness = await createHostHarness({
			whenUnattached: "keep",
			settings: SETTINGS,
			extension: (volt) => {
				onLoad?.(volt.settings);
				updates.push((values) => volt.updateSettings(values));
				volt.on("settings_changed", (event, ctx) => {
					changesFor(ctx.sessionManager.getSessionId()).push(event);
				});
			},
		});
		cleanups.push(() => harness.cleanup());
		return {
			harness,
			updates,
			async open(clientId) {
				const conversation = await harness.openStartup();
				const client = harness.client(clientId);
				await harness.host.attach(client, conversation);
				return {
					conversation,
					changes: changesFor(conversation.id),
					context: (profile = LOCAL_INTENT_PROFILE) => ({
						target: { session: conversation.session, conversation, host: harness.host, client },
						services: {},
						profile,
					}),
				};
			},
		};
	}

	const remote = (capabilities: Parameters<typeof createIrohRemoteRpcGrant>[0]): IntentProfile => ({
		name: "remote",
		grant: createIrohRemoteRpcGrant(capabilities),
	});

	it("serves the form, stores values by scope, and tells the extension what changed", async () => {
		const loaded: unknown[] = [];
		const { open } = await setup((settings) => loaded.push(settings));
		const { context, changes, conversation } = await open("tui");
		expect(loaded).toEqual([{ mode: "fast", maxLoops: 3 }]);

		expect(await queryRegistry.run(context(), "extension_settings", { id: ID })).toEqual({
			form: [
				{ id: "organization", label: "organization", kind: "string", minLength: 1 },
				{
					id: "mode",
					label: "mode",
					kind: "enum",
					options: [{ value: "fast" }, { value: "careful" }],
					value: "fast",
				},
				{ id: "maxLoops", label: "maxLoops", kind: "integer", value: 3, min: 1, max: 10 },
			],
			values: { global: {}, project: {} },
			projectTrusted: true,
		});

		await intentRegistry.invoke(context(), "set_extension_settings", {
			id: ID,
			scope: "global",
			values: { organization: "acme", maxLoops: 5 },
		});
		await vi.waitFor(() => expect(changes).toHaveLength(1));
		expect(changes[0]).toEqual({
			type: "settings_changed",
			settings: { mode: "fast", maxLoops: 5, organization: "acme" },
			previous: { mode: "fast", maxLoops: 3 },
			scope: "global",
		});

		await intentRegistry.invoke(context(), "set_extension_settings", {
			id: ID,
			scope: "project",
			values: { mode: "careful" },
		});
		await vi.waitFor(() => expect(changes).toHaveLength(2));
		expect(changes[1]).toMatchObject({ settings: { mode: "careful" }, scope: "project" });
		expect(await queryRegistry.run(context(), "extension_settings", { id: ID })).toMatchObject({
			values: { global: { organization: "acme", maxLoops: 5 }, project: { mode: "careful" } },
		});

		await expect(
			intentRegistry.invoke(context(), "set_extension_settings", {
				id: ID,
				scope: "global",
				values: { maxLoops: 99 },
			}),
		).rejects.toMatchObject({ code: "invalid_input", message: 'Invalid settings: "maxLoops" must be at most 10' });
		await expect(
			intentRegistry.invoke(context(), "set_extension_settings", { id: "missing", scope: "global", values: {} }),
		).rejects.toMatchObject({ code: "invalid_input", message: 'No extension "missing" in this conversation' });
		await expect(queryRegistry.run(context(), "extension_settings", { id: "missing" })).rejects.toMatchObject({
			code: "invalid_input",
		});

		conversation.session.settingsManager.setProjectTrusted(false);
		await expect(
			intentRegistry.invoke(context(), "set_extension_settings", { id: ID, scope: "project", values: {} }),
		).rejects.toMatchObject({ code: "not_allowed" });
		expect(await queryRegistry.run(context(), "extension_settings", { id: ID })).toMatchObject({
			values: { global: { organization: "acme", maxLoops: 5 } },
			projectTrusted: false,
		});
		// Distrusting the project drops its values from what the extension sees.
		await vi.waitFor(() => expect(changes).toHaveLength(3));
		expect(changes[2]).toMatchObject({ settings: { mode: "fast" }, scope: "project" });
	});

	it("needs host.manage.v1 from a remote client", async () => {
		const { open } = await setup();
		const { context } = await open("phone");
		const observe = remote(["conversation.observe.v1", "conversation.control.v1"]);
		await expect(queryRegistry.run(context(observe), "extension_settings", { id: ID })).rejects.toMatchObject({
			code: "not_allowed",
			requiredCapability: "host.manage.v1",
		});
		await expect(
			intentRegistry.invoke(context(observe), "set_extension_settings", {
				id: ID,
				scope: "global",
				values: { organization: "acme" },
			}),
		).rejects.toMatchObject({ code: "not_allowed" });

		const manage = remote(["host.manage.v1"]);
		await intentRegistry.invoke(context(manage), "set_extension_settings", {
			id: ID,
			scope: "global",
			values: { organization: "phone" },
		});
		expect(await queryRegistry.run(context(manage), "extension_settings", { id: ID })).toMatchObject({
			values: { global: { organization: "phone" } },
		});
	});

	it("reaches the extensions of every open conversation, for intents and volt.updateSettings", async () => {
		const { open, updates } = await setup();
		const first = await open("first");
		const second = await open("second");
		expect(first.conversation.session.settingsManager).not.toBe(second.conversation.session.settingsManager);

		await intentRegistry.invoke(first.context(), "set_extension_settings", {
			id: ID,
			scope: "global",
			values: { organization: "acme" },
		});
		await vi.waitFor(() => expect(second.changes).toHaveLength(1));
		expect(second.changes[0]).toMatchObject({ settings: { organization: "acme" }, scope: "global" });
		expect(first.changes).toHaveLength(1);

		await updates[1]!({ mode: "careful" });
		await vi.waitFor(() => expect(first.changes).toHaveLength(2));
		expect(first.changes[1]).toMatchObject({
			settings: { organization: "acme", mode: "careful" },
			previous: { organization: "acme", mode: "fast" },
		});
		await vi.waitFor(() => expect(second.changes).toHaveLength(2));
	});
});
