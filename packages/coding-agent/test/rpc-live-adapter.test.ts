import { describe, expect, it } from "vitest";
import { LiveState } from "../src/core/host/live-state.ts";
import {
	answerExtensionUiResponse,
	answerHostActionResponse,
	createRpcLiveView,
	pendingHostActionRequests,
} from "../src/modes/rpc/rpc-live-adapter.ts";

function attachRpcView(live: LiveState, options: { extensionUi?: boolean; approvals?: boolean } = {}) {
	const events: Array<Record<string, unknown>> = [];
	const view = createRpcLiveView({
		output: (event) => events.push(event as Record<string, unknown>),
		showsExtensionUi: () => options.extensionUi ?? true,
		takesApprovals: () => options.approvals ?? false,
	});
	const detach = live.attach("rpc", view);
	return { events, detach };
}

describe("the live state on the legacy RPC wire", () => {
	it("writes the old extension_ui_request, host_action_request, and host_action_update events", () => {
		const live = new LiveState();
		live.set("ext_status/build", { kind: "ext_status", text: "building" });
		const { events } = attachRpcView(live, { approvals: true });
		live.set("ext_widget/w", { kind: "ext_widget", lines: ["a"], placement: "belowEditor" });
		live.set("ext_title", { kind: "ext_title", title: "volt" });
		live.notice("warning", "careful");
		live.setEditorText("draft");
		live.clear("ext_status/build");
		live.clear("ext_widget/w");
		live.clear("ext_title");
		void live.request({ kind: "select", title: "Pick", options: ["a", "b"], timeoutMs: 500 }, { id: "s" });
		void live.request({ kind: "confirm", title: "Sure?", message: "Really?" }, { id: "c" });
		void live.request({ kind: "input", title: "Name", placeholder: "you" }, { id: "i" });
		void live.request({ kind: "editor", title: "Edit", prefill: "text" }, { id: "e" });
		void live.hostInteraction.requestAction({
			id: "h",
			action: "lsp.install_server",
			title: "Install?",
			blocking: true,
		});
		live.hostInteraction.updateAction?.({ id: "h", action: "lsp.install_server", status: "completed", exitCode: 0 });

		// Fire-and-forget requests carry a fresh id each; dialogs and approvals carry the request's.
		const fireAndForget = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
		const withoutIds = events.map(({ id, ...event }) =>
			typeof event.method === "string" && fireAndForget.has(event.method) ? event : { id, ...event },
		);
		expect(withoutIds).toEqual([
			{ type: "extension_ui_request", method: "setStatus", statusKey: "build", statusText: "building" },
			{
				type: "extension_ui_request",
				method: "setWidget",
				widgetKey: "w",
				widgetLines: ["a"],
				widgetPlacement: "belowEditor",
			},
			{ type: "extension_ui_request", method: "setTitle", title: "volt" },
			{ type: "extension_ui_request", method: "notify", message: "careful", notifyType: "warning" },
			{ type: "extension_ui_request", method: "set_editor_text", text: "draft" },
			{ type: "extension_ui_request", method: "setStatus", statusKey: "build" },
			{ type: "extension_ui_request", method: "setWidget", widgetKey: "w" },
			{ id: "s", type: "extension_ui_request", method: "select", title: "Pick", options: ["a", "b"], timeout: 500 },
			{ id: "c", type: "extension_ui_request", method: "confirm", title: "Sure?", message: "Really?" },
			{ id: "i", type: "extension_ui_request", method: "input", title: "Name", placeholder: "you" },
			{ id: "e", type: "extension_ui_request", method: "editor", title: "Edit", prefill: "text" },
			{ id: "h", type: "host_action_request", action: "lsp.install_server", title: "Install?", blocking: true },
			{ id: "h", type: "host_action_update", action: "lsp.install_server", status: "completed", exitCode: 0 },
		]);
		live.close();
	});

	it("shows a client that shows no extension UI nothing of it, and approvals only when it takes them", () => {
		const live = new LiveState();
		const { events } = attachRpcView(live, { extensionUi: false, approvals: false });
		live.set("ext_status/build", { kind: "ext_status", text: "building" });
		live.notice("info", "hello");
		void live.request({ kind: "confirm", title: "Sure?", message: "Really?" }, { unattended: true });
		void live.hostInteraction.requestAction({ id: "h", action: "x", title: "Approve?" });
		expect(events).toEqual([]);
		expect(pendingHostActionRequests(live)).toEqual([]);
		live.close();
	});

	it("answers dialogs and approvals from the old responses, bound to the request and the client", async () => {
		const live = new LiveState();
		attachRpcView(live, { approvals: true });
		const select = live.request({ kind: "select", title: "Pick", options: ["a", "b"] }, { id: "s" });
		const confirm = live.request({ kind: "confirm", title: "Sure?", message: "Really?" }, { id: "c" });
		const input = live.request({ kind: "input", title: "Name" }, { id: "i" });
		const approval = live.hostInteraction.requestAction({ id: "h", action: "x", title: "Approve?" });
		expect(pendingHostActionRequests(live)).toEqual([
			{ type: "host_action_request", id: "h", action: "x", title: "Approve?" },
		]);

		// A dialog answer cannot answer an approval, nor an approval answer a dialog.
		answerExtensionUiResponse(live, "rpc", { type: "extension_ui_response", id: "h", confirmed: true });
		answerHostActionResponse(live, "rpc", { type: "host_action_response", id: "c", decision: "approved" });
		// Another client's answer, an unknown id, and a malformed decision change nothing.
		answerExtensionUiResponse(live, "stranger", { type: "extension_ui_response", id: "c", confirmed: true });
		answerExtensionUiResponse(live, "rpc", { type: "extension_ui_response", id: "missing", confirmed: true });
		answerHostActionResponse(live, "rpc", { type: "host_action_response", id: "h", decision: "maybe" });
		expect(live.pendingRequests().map((pending) => pending.requestId)).toEqual(["s", "c", "i", "h"]);

		// An answer the dialog cannot take cancels it, as it always resolved to the default.
		answerExtensionUiResponse(live, "rpc", { type: "extension_ui_response", id: "s", value: "z" });
		answerExtensionUiResponse(live, "rpc", { type: "extension_ui_response", id: "c", value: "yes" });
		answerExtensionUiResponse(live, "rpc", { type: "extension_ui_response", id: "i", value: "volt" });
		answerHostActionResponse(live, "rpc", {
			type: "host_action_response",
			id: "h",
			decision: "denied",
			message: "no",
		});
		await expect(select).resolves.toMatchObject({ response: { cancelled: true } });
		await expect(confirm).resolves.toMatchObject({ response: { cancelled: true } });
		await expect(input).resolves.toMatchObject({ response: { value: "volt" } });
		await expect(approval).resolves.toEqual({ decision: "denied", message: "no" });
	});
});
