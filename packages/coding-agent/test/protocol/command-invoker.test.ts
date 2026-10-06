/**
 * Who invokes an extension command (`ctx.invokedBy`): a local client (the
 * TUI, stdio RPC, the SDK) is `"local"`; a paired remote device is
 * `"remote"`, whether it invokes the command as an intent or as slash text.
 * The interactive host binds extensions as an RPC host (`ctx.mode` "rpc").
 */

import { REMOTE_CAPABILITIES, type RemoteGrant } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient } from "../../src/client/protocol-client.ts";
import type { CommandInvoker, ExtensionMode } from "../../src/core/extensions/index.ts";
import { serveIrohRemoteConnection } from "../../src/core/remote/iroh/connection.ts";
import { createHostHarness } from "../suite/host-harness.ts";
import { createIrohStreamPair } from "../utilities/iroh-stream-pair.ts";
import { connectRemotePhone } from "../utilities/remote-phone.ts";

const ALL: RemoteGrant = { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] };
const COMMAND = "extension.command.test-extension.who";

describe("ctx.invokedBy", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("is local for a loopback client and remote for a paired device, by intent and by slash text", async () => {
		const seen: Array<{ args: string; invokedBy: CommandInvoker; mode: ExtensionMode; hasUI: boolean }> = [];
		const harness = await createHostHarness({
			whenUnattached: "keep",
			extensionMode: "rpc",
			extension: (volt) => {
				volt.registerCommand("who", {
					description: "Record who invoked the command",
					remoteSafe: true,
					handler: async (args, ctx) => {
						seen.push({ args, invokedBy: ctx.invokedBy, mode: ctx.mode, hasUI: ctx.hasUI });
					},
				});
			},
		});
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const local = await createLoopbackClient(harness.host, conversation, { anchor: false });
		cleanups.push(() => local.stop());

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

		await local.intent(COMMAND, { arguments: "local intent" });
		await expect(phone.intent(COMMAND, { arguments: "remote intent" })).resolves.toMatchObject({ type: "accepted" });
		await local.prompt("/who local text");
		await expect(phone.intent("prompt", { message: "/who remote text" })).resolves.toMatchObject({
			type: "accepted",
		});
		await vi.waitFor(() => expect(seen).toHaveLength(4));

		const byArgs = new Map(seen.map((call) => [call.args, call]));
		expect(byArgs.get("local intent")).toEqual({
			args: "local intent",
			invokedBy: "local",
			mode: "rpc",
			hasUI: true,
		});
		expect(byArgs.get("remote intent")?.invokedBy).toBe("remote");
		expect(byArgs.get("local text")?.invokedBy).toBe("local");
		expect(byArgs.get("remote text")?.invokedBy).toBe("remote");
	});

	it("is local for a command the host runs outside any client", async () => {
		let invokedBy: CommandInvoker | undefined;
		const harness = await createHostHarness({
			extension: (volt) => {
				volt.registerCommand("who", {
					description: "Record who invoked the command",
					handler: async (_args, ctx) => {
						invokedBy = ctx.invokedBy;
					},
				});
			},
		});
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		await harness.host.attach(harness.client("sdk", { anchor: true }), conversation);

		await conversation.session.prompt("/who");
		expect(invokedBy).toBe("local");
	});
});
