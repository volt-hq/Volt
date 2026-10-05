/**
 * The data `ctx.ui` API (RFC §8.3): status items, panels, and the title keyed
 * by the extension that set them, normalized before any client sees them;
 * panels patched in place; dialogs and forms as host requests; the editor
 * text asked of one client; and pasting as a directive.
 */

import type { HostRequest, HostResponse, LiveItem, UiNode } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionError, ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { ClientScope } from "../../src/core/host/client-scope.ts";
import type { LiveClient, LiveUpdate } from "../../src/core/host/live-state.ts";
import { emptyLiveFold, foldLiveItems } from "../../src/core/protocol/live-fold.ts";
import { EXTENSION_PANELS_MAX, EXTENSION_STATUS_MAX } from "../../src/core/ui/extension-ui.ts";
import { connectTestClient } from "../utilities/host-client.ts";
import { createLiveRecorder } from "../utilities/live-recorder.ts";
import { createExtensionRuntime, type ExtensionRuntime } from "./extension-runtime.ts";

const EXTENSION = "test-extension";

/** A runtime whose extension hands its `ctx.ui` out at session_start, and a client that records the live state. */
async function setup(accepts: HostRequest["kind"][] = ["dialog", "form"]) {
	let ui: ExtensionUIContext | undefined;
	const fixture = await createExtensionRuntime(
		(volt) => {
			volt.on("session_start", (_event, ctx) => {
				ui = ctx.ui;
			});
		},
		{ extensionMode: "rpc" },
	);
	const live = createLiveRecorder(accepts);
	const errors: ExtensionError[] = [];
	await connectTestClient(fixture.host, fixture.conversation, {
		id: "client",
		live,
		surface: { onError: (error) => errors.push(error) },
	});
	if (!ui) throw new Error("session_start did not run");
	return { fixture, live, ui, errors };
}

/** Answer the oldest pending request of the client once one arrives. */
async function answerNext(
	fixture: ExtensionRuntime,
	pending: () => Array<{ requestId: string; request: HostRequest }>,
	response: HostResponse,
	clientId = "client",
): Promise<HostRequest> {
	let next: { requestId: string; request: HostRequest } | undefined;
	await vi.waitFor(() => {
		next = pending()[0];
		expect(next).toBeDefined();
	});
	expect(fixture.conversation.liveState.answer(next!.requestId, response, clientId)).toBe("accepted");
	return next!.request;
}

describe("the extensions' data UI", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("keys status items and panels by extension, normalizes them, and patches a changed panel", async () => {
		const { fixture, live, ui } = await setup();
		cleanups.push(() => fixture.dispose());

		ui.setStatus("build", "\u001b[32mpassing\u001b[0m");
		const log = (lines: string[]): UiNode => ({
			type: "card",
			key: "ci",
			title: "CI",
			sections: [{ key: "log", children: [{ type: "terminal", key: "out", lines }] }],
		});
		ui.setPanel("ci", { title: "Checks", placement: "sidebar", node: log(["one"]) });
		ui.setPanel("ci", { title: "Checks", placement: "sidebar", node: log(["one", "two"]) });
		// A new title is a new value, not a patch.
		ui.setPanel("ci", { title: "Checks (2)", placement: "sidebar", node: log(["one", "two"]) });
		ui.setTitle("volt:\n building");

		const items = live.uiItems();
		expect(items[0]).toEqual({
			type: "set",
			key: `ext_status/${EXTENSION}/build`,
			value: { kind: "ext_status", extension: EXTENSION, text: [{ text: "passing", token: "success" }] },
		});
		expect(items.map((item) => item.type)).toEqual(["set", "set", "patch", "set", "set"]);
		expect(items[2]).toMatchObject({ type: "patch", key: `ext_panel/${EXTENSION}/ci` });
		expect(items[4]).toEqual({
			type: "set",
			key: "ext_title",
			value: { kind: "ext_title", extension: EXTENSION, title: "volt: building" },
		});
		// A client that folds what it received holds what the host holds.
		const fold = foldLiveItems(emptyLiveFold(), items);
		expect(fold.values.get(`ext_panel/${EXTENSION}/ci`)).toEqual(
			fixture.conversation.liveState.get(`ext_panel/${EXTENSION}/ci`),
		);
		expect(fixture.conversation.liveState.get(`ext_panel/${EXTENSION}/ci`)).toMatchObject({
			title: "Checks (2)",
			node: log(["one", "two"]),
		});

		ui.setPanel("ci", undefined);
		ui.setStatus("build", undefined);
		expect(live.uiItems().slice(-2)).toEqual([
			{ type: "clear", key: `ext_panel/${EXTENSION}/ci` },
			{ type: "clear", key: `ext_status/${EXTENSION}/build` },
		]);
	});

	it("binds a panel's actions only to the extension's own intents, commands, and work", async () => {
		const { fixture, live, ui, errors } = await setup();
		cleanups.push(() => fixture.dispose());

		ui.setPanel("actions", {
			node: {
				type: "actions",
				actions: [
					{ id: "own", label: "Own", intent: { type: `extension.intent.${EXTENSION}.go` } },
					{ id: "other", label: "Other", intent: { type: "extension.intent.other.go" } },
					{ id: "builtin", label: "Clear", intent: { type: "new_session" } },
					{ id: "work", label: "Cancel", intent: { type: "cancel_work", input: { workId: "not-mine" } } },
				],
			},
		});
		expect(live.uiItems()).toEqual([
			{
				type: "set",
				key: `ext_panel/${EXTENSION}/actions`,
				value: {
					kind: "ext_panel",
					extension: EXTENSION,
					placement: "aboveEditor",
					node: {
						type: "actions",
						actions: [{ id: "own", label: "Own", intent: { type: `extension.intent.${EXTENSION}.go` } }],
					},
				},
			},
		]);
		expect(errors.map((error) => [error.extensionId, error.event])).toEqual([
			[EXTENSION, "ui"],
			[EXTENSION, "ui"],
			[EXTENSION, "ui"],
		]);

		// A panel the policy empties is removed.
		ui.setPanel("actions", {
			node: { type: "actions", actions: [{ id: "x", label: "X", intent: { type: "new_session" } }] },
		});
		expect(live.uiItems().at(-1)).toEqual({ type: "clear", key: `ext_panel/${EXTENSION}/actions` });
	});

	it("bounds status items and panels in size and number", async () => {
		const { fixture, ui } = await setup();
		cleanups.push(() => fixture.dispose());

		expect(() => ui.setStatus("big", "x".repeat(2_000))).toThrow(/bound/);
		expect(() => ui.setStatus("", "empty")).toThrow(TypeError);
		expect(() => ui.setPanel("big", { node: { type: "text", text: "x".repeat(40_000) } })).toThrow(/bound/);
		expect(() => ui.setPanel("bad", { placement: "footer" as "sidebar", node: { type: "text", text: "x" } })).toThrow(
			TypeError,
		);
		for (let index = 0; index < EXTENSION_STATUS_MAX; index++) ui.setStatus(`s${index}`, "ok");
		expect(() => ui.setStatus("one-more", "ok")).toThrow(/at most/);
		ui.setStatus("s0", "replaced");
		for (let index = 0; index < EXTENSION_PANELS_MAX; index++) {
			ui.setPanel(`p${index}`, { node: { type: "text", text: "ok" } });
		}
		expect(() => ui.setPanel("one-more", { node: { type: "text", text: "ok" } })).toThrow(/at most/);
		// What was refused never reached the live state.
		const keys = fixture.conversation.liveState.entries().map(([key]) => key);
		expect(keys.filter((key) => key.startsWith(`ext_status/${EXTENSION}/`))).toHaveLength(EXTENSION_STATUS_MAX);
		expect(keys.filter((key) => key.startsWith(`ext_panel/${EXTENSION}/`))).toHaveLength(EXTENSION_PANELS_MAX);
	});

	it("keeps status items, panels, and the title to an extension's own context", async () => {
		const { fixture, ui } = await setup();
		cleanups.push(() => fixture.dispose());
		const unowned = fixture.conversation.session.extensionRunner.getUIContext();
		expect(() => unowned.setStatus("x", "y")).toThrow(/extension's own context/);
		expect(() => unowned.setPanel("x", { node: { type: "text", text: "y" } })).toThrow(/extension's own context/);
		expect(() => unowned.setTitle("x")).toThrow(/extension's own context/);
		expect(ui).not.toBe(unowned);
	});

	it("asks dialogs and forms as host requests and resolves them with the answer", async () => {
		const { fixture, live, ui } = await setup();
		cleanups.push(() => fixture.dispose());

		const chosen = ui.dialog(
			{
				title: "Deploy?",
				body: [{ type: "text", text: "\u001b[31mproduction\u001b[0m" }],
				actions: [
					{ id: "go", label: "Deploy", destructive: true },
					{ id: "stop", label: "Cancel" },
				],
			},
			{ timeout: 5000 },
		);
		const dialog = await answerNext(fixture, live.pending, { value: "go" });
		await expect(chosen).resolves.toBe("go");
		expect(dialog).toEqual({
			kind: "dialog",
			title: "Deploy?",
			body: [{ type: "text", text: [{ text: "production", token: "error" }] }],
			actions: [
				{ id: "go", label: "Deploy", destructive: true },
				{ id: "stop", label: "Cancel" },
			],
			timeoutMs: 5000,
		});

		const values = ui.form({
			title: "Release",
			fields: [
				{ kind: "string", id: "tag", label: "Tag", required: true, pattern: "v[0-9]+" },
				{ kind: "boolean", id: "notes", label: "Notes" },
			],
		});
		const form = await answerNext(fixture, live.pending, { values: { tag: "v2", notes: true } });
		await expect(values).resolves.toEqual({ tag: "v2", notes: true });
		expect(form).toMatchObject({ kind: "form", title: "Release" });

		// An answer of the wrong shape is refused; a cancellation resolves to undefined.
		const cancelled = ui.dialog({ title: "Again?", actions: [{ id: "yes", label: "Yes" }] });
		await vi.waitFor(() => expect(live.pending()).toHaveLength(1));
		const [pending] = live.pending();
		expect(fixture.conversation.liveState.answer(pending!.requestId, { value: "no" }, "client")).toBe("invalid");
		expect(fixture.conversation.liveState.answer(pending!.requestId, { cancelled: true }, "client")).toBe("accepted");
		await expect(cancelled).resolves.toBeUndefined();

		await expect(ui.dialog({ title: "None", actions: [] })).rejects.toThrow(/1 to 8 actions/);
		await expect(
			ui.form({ title: "Bad", fields: [{ kind: "string", id: "x", label: "X", pattern: "(a+)+" }] }),
		).rejects.toThrow(/not safe/);
	});

	it("asks the editor text of the invoking client only, or of the anchor, and gives up after 2 seconds", async () => {
		const fixture = await createExtensionRuntime(() => {}, { extensionMode: "rpc" });
		cleanups.push(() => fixture.dispose());
		const asked: Record<string, string[]> = { anchor: [], other: [] };
		const editorView = (id: string, text: string | undefined): LiveClient => ({
			acceptsHostRequest: (kind) => kind === "editor_text",
			apply: (update: LiveUpdate) => {
				for (const item of update.items) {
					if (item.type !== "set" || item.value.kind !== "host_request") continue;
					const { requestId } = item.value;
					asked[id]!.push(requestId);
					if (text !== undefined) {
						queueMicrotask(() => fixture.conversation.liveState.answer(requestId, { value: text }, id));
					}
				}
			},
		});
		await connectTestClient(fixture.host, fixture.conversation, {
			id: "anchor",
			live: editorView("anchor", "draft"),
			surface: {},
		});
		await connectTestClient(fixture.host, fixture.conversation, {
			id: "other",
			anchor: false,
			live: editorView("other", "other draft"),
			surface: {},
		});
		const ui = fixture.conversation.session.extensionRunner.getUIContext("test-extension");

		await expect(ui.getEditorText()).resolves.toBe("draft");
		await expect(ClientScope.run("other", () => ui.getEditorText())).resolves.toBe("other draft");
		expect(asked.anchor).toHaveLength(1);
		expect(asked.other).toHaveLength(1);
		// A client that has left gets no request, and nothing falls through to the anchor.
		await expect(ClientScope.run("gone", () => ui.getEditorText())).resolves.toBeUndefined();
		expect(asked.anchor).toHaveLength(1);

		vi.useFakeTimers();
		try {
			const silent = await connectTestClient(fixture.host, fixture.conversation, {
				id: "silent",
				anchor: false,
				live: editorView("silent", undefined),
				surface: {},
			});
			const text = ClientScope.run("silent", () => ui.getEditorText());
			await vi.advanceTimersByTimeAsync(2_000);
			await expect(text).resolves.toBeUndefined();
			await silent.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("pastes into the clients' editors without terminal controls", async () => {
		const { fixture, live, ui } = await setup();
		cleanups.push(() => fixture.dispose());
		ui.pasteToEditor("line\u001b[201~\r\u0003");
		expect(live.uiItems()).toEqual([
			{ type: "directive", directive: "insert_editor_text", text: "line" },
		] satisfies LiveItem[]);
	});
});
