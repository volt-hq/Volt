/**
 * The user's global settings let paired remote devices invoke extension
 * commands their extensions did not mark remote-safe
 * (`extensions.<id>.remoteSafeCommands`): the device sees each listed command
 * as an intent and invokes it by intent or slash text, where the handler sees
 * `ctx.invokedBy` as `"remote"`. Commands the settings do not list stay local.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HostFrame, type IntentDescriptor, REMOTE_CAPABILITIES, type RemoteGrant } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandInvoker } from "../../src/core/extensions/index.ts";
import { serveIrohRemoteConnection } from "../../src/core/remote/iroh/connection.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createHostHarness, type HostHarness } from "../suite/host-harness.ts";
import { createIrohStreamPair } from "../utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "../utilities/remote-phone.ts";

const ALL: RemoteGrant = { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] };
const ALLOWED = "extension.command.test-extension.allowed";
const LOCAL = "extension.command.test-extension.local";

const allowing = (commands: string[]): Partial<Settings> => ({
	extensions: { "test-extension": { remoteSafeCommands: commands } },
});

describe("extensions.<id>.remoteSafeCommands", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(globalSettings: Partial<Settings>) {
		const seen: Array<{ command: string; args: string; invokedBy: CommandInvoker }> = [];
		const harness: HostHarness = await createHostHarness({
			whenUnattached: "keep",
			extensionMode: "rpc",
			globalSettings,
			extension: (volt) => {
				for (const command of ["allowed", "local"]) {
					volt.registerCommand(command, {
						description: `The ${command} command`,
						handler: async (args, ctx) => {
							seen.push({ command, args, invokedBy: ctx.invokedBy });
						},
					});
				}
			},
		});
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: ALL,
			redaction: { workspacePath: conversation.cwd },
			redirect: {},
		});
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await phone.close();
			await connection.close().catch(() => undefined);
		});
		await phone.hello();
		await phone.subscribe(conversation.id);
		return { harness, conversation, phone, seen };
	}

	async function remoteIntents(phone: RemotePhone, conversation: string): Promise<Map<string, IntentDescriptor>> {
		const result = await phone.query("intents", undefined, conversation);
		if (result.type !== "result") throw new Error(`intents query failed: ${JSON.stringify(result.reason)}`);
		const { intents } = result.data as { intents: IntentDescriptor[] };
		return new Map(intents.map((intent) => [intent.name, intent]));
	}

	it("lets a paired device invoke a listed command by intent and slash text, and no other", async () => {
		const { conversation, phone, seen } = await setup(allowing(["allowed"]));

		const intents = await remoteIntents(phone, conversation.id);
		expect(intents.get(ALLOWED)).toMatchObject({ remote: "safe", slash: { name: "allowed" } });
		expect(intents.has(LOCAL)).toBe(false);

		await expect(phone.intent(ALLOWED, { arguments: "by intent" })).resolves.toMatchObject({ type: "accepted" });
		await expect(phone.intent("prompt", { message: "/allowed by text" })).resolves.toMatchObject({
			type: "accepted",
		});
		await vi.waitFor(() => expect(seen).toHaveLength(2));
		expect(seen).toEqual(
			expect.arrayContaining([
				{ command: "allowed", args: "by intent", invokedBy: "remote" },
				{ command: "allowed", args: "by text", invokedBy: "remote" },
			]),
		);

		await expect(phone.intent(LOCAL, {})).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed" },
		});
		await expect(phone.intent("prompt", { message: "/local" })).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed" },
		});
		expect(seen).toHaveLength(2);
	});

	it("tells the device to refetch its intents when the settings change", async () => {
		const { harness, conversation, phone } = await setup({});
		expect((await remoteIntents(phone, conversation.id)).has(ALLOWED)).toBe(false);

		const from = phone.frames.length;
		writeFileSync(join(harness.tempDir, "settings.json"), JSON.stringify(allowing(["allowed"])));
		await conversation.session.settingsManager.reload();

		await phone.waitFor((frame): frame is HostFrame => frame.type === "changed" && frame.catalog === "intents", {
			from,
		});
		expect((await remoteIntents(phone, conversation.id)).get(ALLOWED)).toMatchObject({ remote: "safe" });
	});
});
