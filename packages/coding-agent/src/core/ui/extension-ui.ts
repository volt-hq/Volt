/**
 * Extension UI as data (RFC §8.3): what `ctx.ui` declares becomes live-lane
 * values and host requests every client renders, normalized on the host
 * before any client sees it (normalize.ts).
 *
 * - Status items are `ext_status/<extension id>/<key>`: styled text of at
 *   most {@link EXTENSION_STATUS_MAX_SERIALIZED_BYTES}; an extension sets at
 *   most {@link EXTENSION_STATUS_MAX} of them.
 * - Panels are `ext_panel/<extension id>/<name>`: one node of at most
 *   `PANEL_MAX_SERIALIZED_BYTES` whose actions and forms may send only the
 *   extension's own intents and commands, and `open_work`/`cancel_work` for
 *   its own work; an extension shows at most {@link EXTENSION_PANELS_MAX}. A
 *   changed panel whose title and placement stay is sent as a patch of its
 *   node when that is smaller.
 * - The title is `ext_title`, naming the extension that set it.
 * - Dialogs and forms are host requests: a dialog's body binds actions as a
 *   panel does; a form's fields are checked as a form node's are.
 */

import {
	diffUiTree,
	EXTENSION_STATUS_MAX_SERIALIZED_BYTES,
	EXTENSION_TITLE_MAX_CHARS,
	type HostRequest,
	type LiveValue,
	PANEL_MAX_SERIALIZED_BYTES,
	type UiNodeIntent,
	type UiNodeStyledText,
} from "@hansjm10/volt-protocol";
import type {
	ExtensionDialog,
	ExtensionForm,
	ExtensionPanel,
	ExtensionPanelPlacement,
	StyledText,
} from "../extensions/types.ts";
import { extensionLiveKey, hostRequestTimeout, isExtensionLiveName, type LiveState } from "../host/live-state.ts";
import { stripTerminalControls } from "./ansi-tokens.ts";
import {
	normalizeStyledText,
	normalizeUiNode,
	normalizeUiNodes,
	type UiActionPolicy,
	UiNormalizeError,
} from "./normalize.ts";

/** Most status items one extension sets. */
export const EXTENSION_STATUS_MAX = 32;
/** Most panels one extension shows. */
export const EXTENSION_PANELS_MAX = 16;
/** Largest notification, as serialized JSON in UTF-8 bytes. */
export const NOTICE_MAX_SERIALIZED_BYTES = 16 * 1024;
/** Longest plain notification text kept, in characters; longer text is cut. */
const NOTICE_MAX_CHARS = 8 * 1024;
/** Largest panel or dialog title, as serialized JSON in UTF-8 bytes. */
const TITLE_MAX_SERIALIZED_BYTES = 1024;
/** Longest dialog or form title, in characters. */
const REQUEST_TITLE_MAX_CHARS = 256;
/** Most actions one dialog has. */
export const DIALOG_ACTIONS_MAX = 8;
/** How long `getEditorText` waits for the client's answer. */
export const EDITOR_TEXT_TIMEOUT_MS = 2_000;

const PLACEMENTS: ReadonlySet<string> = new Set(["aboveEditor", "belowEditor", "sidebar"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One line of plain text: controls stripped, whitespace runs as one space, at most `max` characters. */
function plainLine(text: unknown, max: number, what: string): string {
	if (typeof text !== "string") throw new TypeError(`${what} must be a string`);
	const line = stripTerminalControls(text).replace(/\s+/g, " ").trim();
	const scalars = [...line];
	return scalars.length <= max ? line : `${scalars.slice(0, max - 1).join("")}…`;
}

/** What an extension's UI data reaches: the conversation's live state, and who owns which work. */
export interface ExtensionUiHost {
	live(): LiveState;
	/** Whether work `workId` belongs to the extension with manifest id `extensionId`. */
	ownsWork(extensionId: string, workId: string): boolean;
	/** An action or form the extension may not bind was left out of its UI. */
	droppedIntent(extensionId: string, intent: UiNodeIntent): void;
}

/** The action policy of the extension `extensionId`; a context no extension owns binds nothing. */
function policyOf(host: ExtensionUiHost, extensionId: string | undefined): UiActionPolicy {
	return {
		owner: "extension",
		extensionId: extensionId ?? "",
		ownsWork: (workId) => extensionId !== undefined && host.ownsWork(extensionId, workId),
	};
}

/** How many values the extension holds under `kind`, and whether `key` is one of them. */
function heldBy(live: LiveState, kind: "ext_status" | "ext_panel", extensionId: string, key: string) {
	const prefix = `${kind}/${extensionId}/`;
	let count = 0;
	for (const [held] of live.entries()) if (held.startsWith(prefix)) count++;
	return { count, has: live.get(key) !== undefined };
}

function checkName(what: string, name: unknown): asserts name is string {
	if (typeof name !== "string" || !isExtensionLiveName(name)) {
		throw new TypeError(`Invalid ${what} name ${JSON.stringify(name)}: use 1 to 128 characters without controls`);
	}
}

/** Set or clear the extension's status item `key`. */
export function setExtensionStatus(
	host: ExtensionUiHost,
	extensionId: string,
	key: string,
	text: StyledText | undefined,
): void {
	checkName("status", key);
	const liveKey = extensionLiveKey("ext_status", extensionId, key);
	if (text === undefined) {
		host.live().clear(liveKey);
		return;
	}
	const normalized = normalizeStyledText(text, { maxBytes: EXTENSION_STATUS_MAX_SERIALIZED_BYTES });
	const held = heldBy(host.live(), "ext_status", extensionId, liveKey);
	if (!held.has && held.count >= EXTENSION_STATUS_MAX) {
		throw new UiNormalizeError(`An extension sets at most ${EXTENSION_STATUS_MAX} status items`);
	}
	host.live().set(liveKey, { kind: "ext_status", extension: extensionId, text: normalized });
}

/**
 * Show, replace, or remove the extension's panel `name`. A replaced panel
 * whose title and placement stay is patched when the patch is smaller; a
 * panel whose whole node the action policy removed is removed.
 */
export function setExtensionPanel(
	host: ExtensionUiHost,
	extensionId: string,
	name: string,
	panel: ExtensionPanel | undefined,
): void {
	checkName("panel", name);
	const liveKey = extensionLiveKey("ext_panel", extensionId, name);
	if (panel === undefined) {
		host.live().clear(liveKey);
		return;
	}
	if (!isRecord(panel)) throw new TypeError(`Panel ${name} must be an object with a node`);
	const placement: unknown = panel.placement ?? "aboveEditor";
	if (typeof placement !== "string" || !PLACEMENTS.has(placement)) {
		throw new TypeError(`Panel ${name}: placement must be "aboveEditor", "belowEditor", or "sidebar"`);
	}
	const title =
		panel.title === undefined
			? undefined
			: normalizeStyledText(panel.title, { maxBytes: TITLE_MAX_SERIALIZED_BYTES });
	const node = normalizeUiNode(panel.node, {
		policy: policyOf(host, extensionId),
		maxBytes: PANEL_MAX_SERIALIZED_BYTES,
		onDroppedIntent: (intent) => host.droppedIntent(extensionId, intent),
	});
	if (node === undefined) {
		host.live().clear(liveKey);
		return;
	}
	const held = heldBy(host.live(), "ext_panel", extensionId, liveKey);
	if (!held.has && held.count >= EXTENSION_PANELS_MAX) {
		throw new UiNormalizeError(`An extension shows at most ${EXTENSION_PANELS_MAX} panels`);
	}
	const value: LiveValue = {
		kind: "ext_panel",
		extension: extensionId,
		...(title === undefined ? {} : { title }),
		placement: placement as ExtensionPanelPlacement,
		node,
	};
	const previous = host.live().get(liveKey);
	if (
		previous?.kind === "ext_panel" &&
		previous.placement === value.placement &&
		JSON.stringify(previous.title) === JSON.stringify(title)
	) {
		const ops = diffUiTree([previous.node], [node]);
		if (ops.length === 0) return;
		if (JSON.stringify(ops).length < JSON.stringify(value).length) {
			host.live().patch(liveKey, ops);
			return;
		}
	}
	host.live().set(liveKey, value);
}

/** Set the conversation's window title for the extension. */
export function setExtensionTitle(host: ExtensionUiHost, extensionId: string, title: string): void {
	host.live().set("ext_title", {
		kind: "ext_title",
		extension: extensionId,
		title: plainLine(title, EXTENSION_TITLE_MAX_CHARS, "A title"),
	});
}

/** A notification as a notice carries it: ANSI styling as tokens, long plain text cut. */
export function notificationText(message: StyledText): UiNodeStyledText {
	const text =
		typeof message === "string" && message.length > NOTICE_MAX_CHARS
			? `${message.slice(0, NOTICE_MAX_CHARS)}…`
			: message;
	return normalizeStyledText(text, { maxBytes: NOTICE_MAX_SERIALIZED_BYTES });
}

/** The host request a dialog asks: its body bound by the action policy of `extensionId`. */
export function dialogRequest(
	host: ExtensionUiHost,
	extensionId: string | undefined,
	dialog: ExtensionDialog,
	timeout: number | undefined,
): HostRequest {
	if (!isRecord(dialog)) throw new TypeError("A dialog needs a title and actions");
	const actions: unknown = dialog.actions;
	if (!Array.isArray(actions) || actions.length === 0 || actions.length > DIALOG_ACTIONS_MAX) {
		throw new TypeError(`A dialog needs 1 to ${DIALOG_ACTIONS_MAX} actions`);
	}
	const ids = new Set<string>();
	const kept = actions.map((action: unknown) => {
		if (!isRecord(action) || typeof action.id !== "string") throw new TypeError("A dialog action needs an id");
		if (ids.has(action.id)) throw new TypeError(`Duplicate dialog action id ${JSON.stringify(action.id)}`);
		ids.add(action.id);
		return {
			id: action.id,
			label: plainLine(action.label, REQUEST_TITLE_MAX_CHARS, "A dialog action label"),
			...(action.token === undefined ? {} : { token: action.token }),
			...(action.destructive === undefined ? {} : { destructive: action.destructive }),
		};
	});
	const body = normalizeUiNodes(dialog.body ?? [], {
		policy: policyOf(host, extensionId),
		maxBytes: PANEL_MAX_SERIALIZED_BYTES,
		...(extensionId === undefined
			? {}
			: { onDroppedIntent: (intent: UiNodeIntent) => host.droppedIntent(extensionId, intent) }),
	});
	return {
		kind: "dialog",
		title: plainLine(dialog.title, REQUEST_TITLE_MAX_CHARS, "A dialog title"),
		body,
		actions: kept as Extract<HostRequest, { kind: "dialog" }>["actions"],
		...hostRequestTimeout(timeout),
	};
}

/** The host request a form asks: its fields checked and converted as a form node's are. */
export function formRequest(form: ExtensionForm, timeout: number | undefined): HostRequest {
	if (!isRecord(form)) throw new TypeError("A form needs a title and fields");
	const node = normalizeUiNode(
		// The submit intent only carries the fields through normalization; the answer is the host response.
		{ type: "form", fields: form.fields, submit: { type: "host.form" } },
		{ policy: { owner: "host" }, maxBytes: PANEL_MAX_SERIALIZED_BYTES },
	);
	if (node?.type !== "form" || node.fields.length === 0) throw new TypeError("A form needs at least one field");
	return {
		kind: "form",
		title: plainLine(form.title, REQUEST_TITLE_MAX_CHARS, "A form title"),
		fields: node.fields,
		...hostRequestTimeout(timeout),
	};
}
