/**
 * The user's global settings let paired remote devices invoke extension
 * commands their extensions did not mark remote-safe
 * (`extensions.<id>.remoteSafeCommands`): the device sees each listed command
 * as an intent and invokes it by intent or slash text, where the handler sees
 * `ctx.invokedBy` as `"remote"`. Commands the settings do not list stay local.
 * Only a local client reads and changes the list (`extension_remote_commands`,
 * `set_extension_remote_commands`); a paired device can do neither.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HostFrame, type IntentDescriptor, REMOTE_CAPABILITIES, type RemoteGrant } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient } from "../../src/client/protocol-client.ts";
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
				for (const command of ["allowed", "local", "declared"]) {
					volt.registerCommand(command, {
						description: `The ${command} command`,
						...(command === "declared" ? { remoteSafe: true } : {}),
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

	it("lets a local client read and replace the list, which the device then follows", async () => {
		const { harness, conversation, phone } = await setup(allowing(["local"]));
		const local = await createLoopbackClient(harness.host, conversation, { anchor: false });
		cleanups.push(() => local.stop());

		const listed = await local.query("extension_remote_commands", { id: "test-extension" });
		expect(listed.commands).toEqual([
			{ name: "allowed", description: "The allowed command", access: "local" },
			{ name: "local", description: "The local command", access: "user" },
			{ name: "declared", description: "The declared command", access: "extension" },
		]);

		const from = phone.frames.length;
		await local.intent("set_extension_remote_commands", { id: "test-extension", commands: ["allowed"] });
		expect(JSON.parse(readFileSync(join(harness.tempDir, "settings.json"), "utf-8")).extensions).toEqual(
			allowing(["allowed"]).extensions,
		);
		await phone.waitFor((frame): frame is HostFrame => frame.type === "changed" && frame.catalog === "intents", {
			from,
		});
		const intents = await remoteIntents(phone, conversation.id);
		expect(intents.has(ALLOWED)).toBe(true);
		expect(intents.has(LOCAL)).toBe(false);

		await local.intent("set_extension_remote_commands", { id: "test-extension", commands: [] });
		expect(JSON.parse(readFileSync(join(harness.tempDir, "settings.json"), "utf-8")).extensions).toEqual({});
		await expect(
			local.intent("set_extension_remote_commands", { id: "missing", commands: ["allowed"] }),
		).rejects.toThrow(/No extension "missing"/);
	});

	it("neither shows nor changes the list for a paired device", async () => {
		const { harness, conversation, phone } = await setup({});

		await expect(
			phone.query("extension_remote_commands", { id: "test-extension" }, conversation.id),
		).resolves.toMatchObject({ type: "query_error", reason: { code: "not_allowed" } });
		await expect(
			phone.intent("set_extension_remote_commands", { id: "test-extension", commands: ["allowed", "local"] }),
		).resolves.toMatchObject({ type: "rejected", reason: { code: "not_allowed" } });
		expect(conversation.session.settingsManager.getExtensionRemoteSafeCommands("test-extension")).toEqual([]);
		expect(JSON.parse(readFileSync(join(harness.tempDir, "settings.json"), "utf-8")).extensions).toBeUndefined();
	});
});
