/**
 * What reached the TUI's terminal in process is protocol: the
 * request_user_input tool's questions are `user_input` host requests, asked of
 * every attached client that accepts them (a phone granted conversation
 * control too), and the tool is offered only while one is attached; an
 * extension's `ctx.ui.setTheme` is a `set_theme` directive local clients
 * receive and a phone never does, which the TUI applies.
 */

import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { HostFrame, HostRequestKind, LiveItem, RemoteGrant } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/index.ts";
import type { ConversationHost } from "../../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import type { ProtocolConnection } from "../../src/core/protocol/server/connection.ts";
import {
	createIrohRemoteExplicitAccess,
	createIrohRemotePresetAccess,
} from "../../src/core/remote/iroh/access-grant.ts";
import { serveIrohRemoteConnection } from "../../src/core/remote/iroh/connection.ts";
import { getCurrentThemeName } from "../../src/core/theme/runtime.ts";
import { connectTestClient } from "../utilities/host-client.ts";
import { createIrohStreamPair } from "../utilities/iroh-stream-pair.ts";
import { createLiveRecorder } from "../utilities/live-recorder.ts";
import { connectRemotePhone, type RemotePhone } from "../utilities/remote-phone.ts";
import { createExtensionRuntime } from "./extension-runtime.ts";
import { createTuiHarness, type TuiHarness } from "./tui-harness.ts";

const request = {
	questions: [
		{
			id: "scope",
			header: "Scope",
			question: "Which clients should this cover?",
			options: [
				{ label: "CLI first (Recommended)", description: "Keep the first change focused." },
				{ label: "All clients", description: "Include phone and RPC." },
			],
		},
	],
};

/** A phone stream on a conversation the TUI holds, saying hello with `accepts`. */
async function servePhone(
	host: ConversationHost,
	conversation: HostedConversation,
	tempDir: string,
	grant: RemoteGrant,
	accepts: readonly HostRequestKind[],
): Promise<{ phone: RemotePhone; connection: ProtocolConnection }> {
	const pair = createIrohStreamPair();
	const connection = serveIrohRemoteConnection({
		host,
		conversation,
		stream: pair.host,
		grant,
		redaction: { workspacePath: tempDir },
		redirect: {},
	});
	const phone = connectRemotePhone(pair.phone);
	await phone.hello(accepts);
	await connection.ready;
	await phone.subscribe(conversation.id);
	return { phone, connection };
}

function liveItems(phone: RemotePhone): LiveItem[] {
	return phone.frames.flatMap((frame) => (frame.type === "live" ? frame.items : []));
}

/** The id of the first `user_input` host request in `frame`. */
function userInputRequest(frame: HostFrame): string | undefined {
	if (frame.type !== "live") return undefined;
	for (const item of frame.items) {
		if (item.type === "set" && item.value.kind === "host_request" && item.value.request.kind === "user_input") {
			return item.value.requestId;
		}
	}
	return undefined;
}

describe("terminal hooks as protocol", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("asks a phone granted conversation control that accepts user_input, and offers the tool only while one is attached", async () => {
		const fixture = await createExtensionRuntime(() => {}, { extensionMode: "rpc" });
		cleanups.push(() => fixture.dispose());
		// A local client that answers dialogs but not the tool's questions.
		const local = createLiveRecorder(["confirm"]);
		const runtime = await connectTestClient(fixture.host, fixture.conversation, {
			id: "rpc",
			live: local,
			surface: {},
		});
		const session = runtime.session;
		expect(session.getActiveToolNames()).not.toContain("request_user_input");

		// A phone without conversation control is never asked, whatever it accepts.
		const observer = await servePhone(
			runtime.host,
			runtime.conversation,
			fixture.tempDir,
			createIrohRemoteExplicitAccess([], ["conversation.observe.v1"]).rpcGrant,
			["user_input"],
		);
		cleanups.push(() => observer.connection.close());
		expect(session.getActiveToolNames()).not.toContain("request_user_input");

		const { phone, connection } = await servePhone(
			runtime.host,
			runtime.conversation,
			fixture.tempDir,
			createIrohRemotePresetAccess("full").rpcGrant,
			["user_input"],
		);
		cleanups.push(() => connection.close());
		expect(session.getActiveToolNames()).toContain("request_user_input");

		const tool = session.getToolDefinition("request_user_input");
		if (!tool) throw new Error("request_user_input is not offered");
		const running = tool.execute("q1", request, undefined, undefined, session.extensionRunner.createContext());
		const frame = await phone.waitFor(
			(candidate): candidate is HostFrame => userInputRequest(candidate) !== undefined,
		);
		const requestId = userInputRequest(frame) as string;
		phone.send({
			type: "host_response",
			requestId,
			response: { status: "answered", answers: { scope: { answers: ["All clients", "Phones too"] } } },
		});
		await expect(running).resolves.toMatchObject({
			details: { status: "answered", answers: { scope: { answers: ["All clients", "Phones too"] } } },
		});
		// Neither the local client that does not accept it nor the observing phone saw the question.
		expect(local.items().some((item) => item.type === "set" && item.key === `host_request/${requestId}`)).toBe(false);
		expect(observer.phone.frames.some((candidate) => userInputRequest(candidate) !== undefined)).toBe(false);

		await connection.close();
		await vi.waitFor(() => expect(session.getActiveToolNames()).not.toContain("request_user_input"));
	});

	it("sends an extension's theme to local clients only, and only one the host knows", async () => {
		let ui: ExtensionUIContext | undefined;
		const fixture = await createExtensionRuntime(
			(volt) => {
				volt.on("session_start", (_event, ctx) => {
					ui = ctx.ui;
				});
			},
			{ extensionMode: "rpc" },
		);
		cleanups.push(() => fixture.dispose());
		const local = createLiveRecorder([]);
		const runtime = await connectTestClient(fixture.host, fixture.conversation, {
			id: "rpc",
			live: local,
			surface: {},
		});
		const { phone, connection } = await servePhone(
			runtime.host,
			runtime.conversation,
			fixture.tempDir,
			createIrohRemotePresetAccess("full").rpcGrant,
			[],
		);
		cleanups.push(() => connection.close());
		if (!ui) throw new Error("session_start did not run");

		expect(ui.setTheme("no-such-theme")).toEqual({ success: false, error: "Theme not found: no-such-theme" });
		expect(ui.setTheme("light")).toEqual({ success: true });
		ui.notify("after the theme", "info");
		expect(local.uiItems()).toContainEqual({ type: "directive", directive: "set_theme", name: "light" });
		// The notice after it arrives; the theme never does.
		await vi.waitFor(() =>
			expect(liveItems(phone).some((item) => item.type === "notice" && item.message === "after the theme")).toBe(
				true,
			),
		);
		expect(liveItems(phone).some((item) => item.type === "directive")).toBe(false);
	});
});

describe("the TUI as a client of the terminal hooks", () => {
	const harnesses: TuiHarness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	it("applies the theme an extension sets, from session_start or a command", async () => {
		const harness = await createTuiHarness({
			globalSettings: { theme: "dark", lsp: { enabled: false }, quietStartup: true },
			extension: (volt) => {
				volt.on("session_start", (_event, ctx) => {
					ctx.ui.setTheme("light");
				});
				volt.registerCommand("dark", {
					description: "Switch to the dark theme",
					handler: async (_args, ctx) => {
						ctx.ui.setTheme("dark");
					},
				});
			},
		});
		harnesses.push(harness);
		const tui = await harness.startMode();
		expect(getCurrentThemeName()).toBe("light");
		await tui.submit("/dark");
		await vi.waitFor(() => expect(getCurrentThemeName()).toBe("dark"));
	});

	it("answers a faux request_user_input call in its question dialog", async () => {
		const harness = await createTuiHarness({
			globalSettings: { theme: "dark", lsp: { enabled: false }, quietStartup: true },
		});
		harnesses.push(harness);
		const tui = await harness.startMode();
		const session = harness.startup.session;
		expect(session.getActiveToolNames()).toContain("request_user_input");
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("request_user_input", request), { stopReason: "toolUse" }),
			fauxAssistantMessage("Proceeding with CLI first."),
		]);
		const running = session.prompt("Implement the question tool");
		await vi.waitFor(() => expect(tui.screen()).toContain("Which clients should this cover?"));
		tui.terminal.sendInput("\r");
		await running;
		const result = session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "request_user_input",
		);
		expect(result).toMatchObject({
			details: { status: "answered", answers: { scope: { answers: ["CLI first (Recommended)"] } } },
		});
	});
});
