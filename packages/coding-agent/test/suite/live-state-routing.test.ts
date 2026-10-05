/**
 * The extensions' UI calls write the conversation's live state, which every
 * attached client sees; theme calls go to the client with themes.
 */

import type { HostRequestKind } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/index.ts";
import type { ExtensionClientThemes } from "../../src/core/session/extension-binding.ts";
import { connectTestClient } from "../utilities/host-client.ts";
import { createLiveRecorder, type LiveRecorder, SESSION_FED_LIVE_KEYS } from "../utilities/live-recorder.ts";
import { createExtensionRuntime, type ExtensionRuntime } from "./extension-runtime.ts";

const DIALOGS: HostRequestKind[] = ["select", "confirm", "input", "editor"];

function createThemes(): ExtensionClientThemes {
	return {
		getAllThemes: vi.fn(() => [{ name: "light", path: undefined }]),
		setTheme: vi.fn(() => ({ success: true })),
	};
}

/** Answer the client's oldest pending request once one arrives. */
async function answerNext(
	fixture: ExtensionRuntime,
	recorder: LiveRecorder,
	clientId: string,
	answer: Parameters<ExtensionRuntime["conversation"]["liveState"]["answer"]>[1],
): Promise<string> {
	let requestId: string | undefined;
	await vi.waitFor(() => {
		requestId = recorder.pending()[0]?.requestId;
		expect(requestId).toBeDefined();
	});
	expect(fixture.conversation.liveState.answer(requestId as string, answer, clientId)).toBe("accepted");
	return requestId as string;
}

describe("the extensions' UI through the live state", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("writes UI calls to the live state and sends theme calls to the client with themes", async () => {
		let ui: ExtensionUIContext | undefined;
		const fixture = await createExtensionRuntime(
			(volt) => {
				volt.on("session_start", (_event, ctx) => {
					ui = ctx.ui;
				});
			},
			{ extensionMode: "tui" },
		);
		cleanups.push(() => fixture.dispose());
		const live = createLiveRecorder(DIALOGS);
		const themes = createThemes();
		await connectTestClient(fixture.host, fixture.conversation, { id: "tui", live, surface: { themes } });
		if (!ui) throw new Error("session_start did not run");

		ui.setStatus("build", "building");
		ui.setPanel("lines", { placement: "belowEditor", node: { type: "text", text: "one\ntwo" } });
		ui.setTitle("volt: building");
		ui.notify("careful", "warning");
		ui.setEditorText("draft");
		ui.setStatus("build", undefined);
		ui.setPanel("lines", undefined);
		ui.pasteToEditor("pasted\u001b[201~\r");

		const extension = "test-extension";
		expect(live.uiItems()).toEqual([
			{
				type: "set",
				key: `ext_status/${extension}/build`,
				value: { kind: "ext_status", extension, text: "building" },
			},
			{
				type: "set",
				key: `ext_panel/${extension}/lines`,
				value: { kind: "ext_panel", extension, placement: "belowEditor", node: { type: "text", text: "one\ntwo" } },
			},
			{ type: "set", key: "ext_title", value: { kind: "ext_title", extension, title: "volt: building" } },
			{ type: "notice", level: "warning", message: "careful", source: extension },
			{ type: "directive", directive: "set_editor_text", text: "draft" },
			{ type: "clear", key: `ext_status/${extension}/build` },
			{ type: "clear", key: `ext_panel/${extension}/lines` },
			// Pasted text never carries terminal controls into the editor.
			{ type: "directive", directive: "insert_editor_text", text: "pasted" },
		]);
		expect(ui.getAllThemes()).toEqual([{ name: "light", path: undefined }]);
		expect(ui.setTheme("light")).toEqual({ success: true });
		expect(themes.setTheme).toHaveBeenCalledWith("light");
		expect(() => ui?.setStatus("", "empty key")).toThrow(TypeError);
	});

	it("asks dialogs through the live state and resolves them with the client's answer or the default", async () => {
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
		const live = createLiveRecorder(DIALOGS);
		await connectTestClient(fixture.host, fixture.conversation, { id: "client", live, surface: {} });
		if (!ui) throw new Error("session_start did not run");

		const selected = ui.select("Pick", ["keep", "delete"], { timeout: 1500.5 });
		const selectId = await answerNext(fixture, live, "client", { value: "delete" });
		await expect(selected).resolves.toBe("delete");
		expect(live.items()).toContainEqual({
			type: "set",
			key: `host_request/${selectId}`,
			value: {
				kind: "host_request",
				requestId: selectId,
				request: { kind: "select", title: "Pick", options: ["keep", "delete"], timeoutMs: 1501 },
			},
		});

		const confirmed = ui.confirm("Proceed?", "Continue?");
		await answerNext(fixture, live, "client", { confirmed: true });
		await expect(confirmed).resolves.toBe(true);

		const input = ui.input("Name", "placeholder");
		await answerNext(fixture, live, "client", { value: "volt" });
		await expect(input).resolves.toBe("volt");

		const edited = ui.editor("Edit", "prefill");
		await answerNext(fixture, live, "client", { cancelled: true });
		await expect(edited).resolves.toBeUndefined();

		const refused = ui.confirm("Proceed?", "Continue?");
		await answerNext(fixture, live, "client", { cancelled: true });
		await expect(refused).resolves.toBe(false);

		// The caller's signal ends the dialog; nothing to choose from asks nothing.
		const controller = new AbortController();
		const aborted = ui.select("Pick", ["a"], { signal: controller.signal });
		await vi.waitFor(() => expect(live.pending()).toHaveLength(1));
		controller.abort();
		await expect(aborted).resolves.toBeUndefined();
		expect(live.pending()).toEqual([]);
		await expect(ui.select("Pick", [])).resolves.toBeUndefined();
		expect(fixture.conversation.liveState.pendingRequests()).toEqual([]);
	});

	it("resolves dialogs to their defaults while no attached client takes them", async () => {
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
		const observer = createLiveRecorder();
		await connectTestClient(fixture.host, fixture.conversation, { id: "observer", live: observer, surface: {} });
		if (!ui) throw new Error("session_start did not run");

		await expect(ui.confirm("Proceed?", "Continue?")).resolves.toBe(false);
		await expect(ui.select("Pick", ["a"])).resolves.toBeUndefined();
		await expect(ui.input("Name")).resolves.toBeUndefined();
		await expect(ui.editor("Edit")).resolves.toBeUndefined();
		expect(observer.uiItems()).toEqual([]);
	});

	it("ends the extensions' dialogs and clears their declarations when they reload", async () => {
		const asked: Array<Promise<string | undefined>> = [];
		const starts: string[] = [];
		const fixture = await createExtensionRuntime(
			(volt) => {
				volt.on("session_start", (event, ctx) => {
					starts.push(event.reason);
					ctx.ui.setStatus("ext", `ready:${event.reason}`);
					ctx.ui.setTitle(`title:${event.reason}`);
					if (event.reason !== "reload") asked.push(ctx.ui.select("Pick", ["a", "b"]));
				});
			},
			{ extensionMode: "rpc" },
		);
		cleanups.push(() => fixture.dispose());
		const live = createLiveRecorder(DIALOGS);
		const client = await connectTestClient(fixture.host, fixture.conversation, { id: "client", live, surface: {} });
		await vi.waitFor(() => expect(live.pending()).toHaveLength(1));
		// An approval is the host's, not the extensions': it survives the reload.
		const approval = fixture.conversation.liveState.request(
			{ kind: "approval", action: "test.action", title: "Approve?" },
			{ id: "approval", unattended: true },
		);

		await client.session.reload();
		await expect(asked[0]).resolves.toBeUndefined();
		expect(starts).toEqual(["startup", "reload"]);
		expect(live.statuses()).toEqual([
			["test-extension/ext", "ready:startup"],
			["test-extension/ext", undefined],
			["test-extension/ext", "ready:reload"],
		]);
		expect(
			fixture.conversation.liveState
				.entries()
				.map(([key]) => key)
				.filter((key) => !SESSION_FED_LIVE_KEYS.has(key)),
		).toEqual(["host_request/approval", "ext_status/test-extension/ext", "ext_title"]);
		fixture.conversation.liveState.close();
		await expect(approval).resolves.toEqual({ status: "cancelled", reason: "closed" });
	});

	it("ends pending dialogs when the conversation closes", async () => {
		let pending: Promise<boolean> | undefined;
		const fixture = await createExtensionRuntime(
			(volt) => {
				volt.on("session_start", (_event, ctx) => {
					pending = ctx.ui.confirm("Proceed?", "Continue?");
				});
			},
			{ extensionMode: "rpc" },
		);
		cleanups.push(() => fixture.dispose());
		const live = createLiveRecorder(DIALOGS);
		const client = await connectTestClient(fixture.host, fixture.conversation, { id: "client", live, surface: {} });
		await vi.waitFor(() => expect(live.pending()).toHaveLength(1));
		await client.dispose();
		await expect(pending).resolves.toBe(false);
		expect(live.updates.at(-1)).toEqual({ reset: true, basedOn: expect.any(Number), items: [] });
	});
});
