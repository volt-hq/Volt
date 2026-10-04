/**
 * The live state on the legacy RPC wire, until RPC clients receive protocol
 * frames (stdio, JSON, and loopback in P3-5, the remote path in P3-6). An RPC
 * client's live view writes the old `extension_ui_request`,
 * `host_action_request`, and `host_action_update` events, and its
 * `extension_ui_response` and `host_action_response` messages answer the
 * conversation's host requests under the client's id. It is deleted with the
 * legacy wire.
 *
 * As before, a client shows either all extension UI (dialogs, notifications,
 * status, widgets, title, editor text) or none, and approvals separately. The
 * old wire has no reset and no dismissal: a client that attaches is sent the
 * current status, widgets, title, and pending requests it takes, and a dialog
 * another client answered stays on its screen until it answers; that answer
 * is ignored.
 */

import { randomUUID } from "node:crypto";
import type { HostRequest, HostRequestKind, HostResponse, LiveItem } from "@hansjm10/volt-protocol";
import type { LiveClient, LiveState } from "../../core/host/live-state.ts";
import type { RpcExtensionUIRequest, RpcHostActionRequest } from "./rpc-types.ts";

const DIALOG_KINDS: ReadonlySet<HostRequestKind> = new Set(["select", "confirm", "input", "editor"]);

export interface RpcLiveViewOptions {
	/** Write an event to the client. */
	output(event: object): void;
	/** Whether the client shows extension UI, dialogs included, now. */
	showsExtensionUi(): boolean;
	/** Whether the client takes host action approvals now. */
	takesApprovals(): boolean;
}

type UiRequestBody = RpcExtensionUIRequest extends infer Request
	? Request extends RpcExtensionUIRequest
		? Omit<Request, "type" | "id">
		: never
	: never;

function uiRequest(id: string, body: UiRequestBody): RpcExtensionUIRequest {
	return { type: "extension_ui_request", id, ...body };
}

function hostActionRequest(
	requestId: string,
	request: Extract<HostRequest, { kind: "approval" }>,
): RpcHostActionRequest {
	const { kind: _kind, ...fields } = request;
	return { type: "host_action_request", id: requestId, ...fields };
}

function dialogRequest(requestId: string, request: HostRequest): RpcExtensionUIRequest | undefined {
	const timeout = "timeoutMs" in request && request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {};
	switch (request.kind) {
		case "select":
			return uiRequest(requestId, { method: "select", title: request.title, options: request.options, ...timeout });
		case "confirm":
			return uiRequest(requestId, { method: "confirm", title: request.title, message: request.message, ...timeout });
		case "input":
			return uiRequest(requestId, {
				method: "input",
				title: request.title,
				...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
				...timeout,
			});
		case "editor":
			return uiRequest(requestId, {
				method: "editor",
				title: request.title,
				...(request.prefill === undefined ? {} : { prefill: request.prefill }),
			});
		default:
			return undefined;
	}
}

/** Whether `item` is about approvals: their requests and the progress of approved actions. */
function concernsApprovals(item: LiveItem): boolean {
	if (item.type === "set") {
		return (
			item.value.kind === "host_action" ||
			(item.value.kind === "host_request" && item.value.request.kind === "approval")
		);
	}
	return item.type === "clear" && (item.key.startsWith("host_action/") || item.key.startsWith("host_request/"));
}

/** The old event for one live item, if the old wire has one. */
function legacyEvent(item: LiveItem): object | undefined {
	switch (item.type) {
		case "set": {
			const value = item.value;
			const id = item.key.slice(item.key.indexOf("/") + 1);
			switch (value.kind) {
				case "ext_status":
					return uiRequest(randomUUID(), { method: "setStatus", statusKey: id, statusText: value.text });
				case "ext_widget":
					return uiRequest(randomUUID(), {
						method: "setWidget",
						widgetKey: id,
						widgetLines: value.lines,
						widgetPlacement: value.placement,
					});
				case "ext_title":
					return uiRequest(randomUUID(), { method: "setTitle", title: value.title });
				case "host_request":
					return value.request.kind === "approval"
						? hostActionRequest(value.requestId, value.request)
						: dialogRequest(value.requestId, value.request);
				case "host_action":
					return {
						type: "host_action_update",
						id,
						action: value.action,
						status: value.status,
						...(value.message === undefined ? {} : { message: value.message }),
						...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
					};
				default:
					return undefined;
			}
		}
		case "clear":
			if (item.key.startsWith("ext_status/")) {
				return uiRequest(randomUUID(), { method: "setStatus", statusKey: item.key.slice("ext_status/".length) });
			}
			if (item.key.startsWith("ext_widget/")) {
				return uiRequest(randomUUID(), { method: "setWidget", widgetKey: item.key.slice("ext_widget/".length) });
			}
			return undefined;
		case "notice":
			return uiRequest(randomUUID(), { method: "notify", message: item.message, notifyType: item.level });
		case "directive":
			return uiRequest(randomUUID(), { method: "set_editor_text", text: item.text });
		default:
			return undefined;
	}
}

/** An RPC client's live view: the live state as old events. */
export function createRpcLiveView(options: RpcLiveViewOptions): LiveClient {
	return {
		acceptsHostRequest: (kind) =>
			DIALOG_KINDS.has(kind) ? options.showsExtensionUi() : kind === "approval" && options.takesApprovals(),
		apply: (update) => {
			for (const item of update.items) {
				// The live state gates host requests by kind; the rest of the extension UI follows the dialogs.
				if (!concernsApprovals(item) && !options.showsExtensionUi()) continue;
				const event = legacyEvent(item);
				if (event) options.output(event);
			}
		},
	};
}

/** The answer an old `extension_ui_response` gives `request`: a mismatched shape cancels, as it always did. */
function dialogAnswer(request: HostRequest, response: Record<string, unknown>): HostResponse {
	if (response.cancelled === true) return { cancelled: true };
	if (request.kind === "confirm") {
		return typeof response.confirmed === "boolean" ? { confirmed: response.confirmed } : { cancelled: true };
	}
	return typeof response.value === "string" ? { value: response.value } : { cancelled: true };
}

/**
 * Answer the conversation's dialog `response.id` from an old
 * `extension_ui_response`. An answer the dialog cannot take, such as a choice
 * that is not one of its options, cancels it.
 */
export function answerExtensionUiResponse(
	liveState: LiveState,
	clientId: string,
	response: Record<string, unknown>,
): void {
	if (typeof response.id !== "string") return;
	const pending = liveState.pendingRequest(response.id);
	if (!pending || !DIALOG_KINDS.has(pending.request.kind)) return;
	const result = liveState.answer(response.id, dialogAnswer(pending.request, response), clientId);
	if (result === "invalid") liveState.answer(response.id, { cancelled: true }, clientId);
}

/** Answer the conversation's approval `response.id` from an old `host_action_response`. */
export function answerHostActionResponse(
	liveState: LiveState,
	clientId: string,
	response: Record<string, unknown>,
): void {
	const decision = response.decision;
	if (typeof response.id !== "string") return;
	if (decision !== "approved" && decision !== "denied" && decision !== "dismissed") return;
	if (liveState.pendingRequest(response.id)?.request.kind !== "approval") return;
	liveState.answer(
		response.id,
		{ decision, ...(typeof response.message === "string" ? { message: response.message } : {}) },
		clientId,
	);
}

/** The conversation's pending approvals as old `host_action_request` events. */
export function pendingHostActionRequests(liveState: LiveState): RpcHostActionRequest[] {
	return liveState
		.pendingRequests()
		.flatMap(({ requestId, request }) =>
			request.kind === "approval" ? [hostActionRequest(requestId, request)] : [],
		);
}
