/**
 * The TUI's view of the live state of the conversation it shows: extension
 * status, panels, and title; notices and editor directives; the progress of
 * the work this host runs; and the dialogs, forms, and approvals it answers in
 * process, shown one at a time in the order they were asked. A request
 * another client answered, or that ended, closes without an answer. An
 * `editor_text` request is answered at once with the editor's text. Patches
 * change the panels and work it holds in place.
 */

import type {
	HostRequest,
	HostRequestKind,
	HostResponse,
	LiveItem,
	LiveValue,
	UiNodeStyledText,
	UiPatchOp,
} from "@hansjm10/volt-protocol";
import type { LiveClient, LiveUpdate } from "../../core/host/live-state.ts";
import { patchLiveValue } from "../../core/protocol/live-fold.ts";
import type { UiPanel } from "./ui-node/panels.ts";

type WorkValue = Extract<LiveValue, { kind: "work" }>;

/** What the live view renders into. */
export interface LiveViewHost {
	/** Show `request` until the user answers or `signal` aborts: the answer, or undefined when it closed without one. */
	showRequest(request: HostRequest, signal: AbortSignal): Promise<HostResponse | undefined>;
	/** Answer `requestId` in the conversation the TUI shows. */
	answer(requestId: string, response: HostResponse): void;
	/** Show or clear an extension's status item, keyed `<extension id>/<name>`. */
	setStatus(key: string, text: UiNodeStyledText | undefined): void;
	/** Show, update, or remove the panel under its live key. */
	setPanel(key: string, panel: UiPanel | undefined): void;
	/** Show an extension's title, or the TUI's own without one. */
	setTitle(title: string | undefined): void;
	notify(level: "info" | "warning" | "error", message: UiNodeStyledText): void;
	setEditorText(text: string): void;
	/** Paste text into the editor at the cursor. */
	insertEditorText(text: string): void;
	/** The editor's text, or undefined when the TUI shows no editor. */
	editorText(): string | undefined;
	/** Work `workId` reported progress, or, without a value, its executor detached. */
	showWork(workId: string, value: WorkValue | undefined): void;
}

const TUI_HOST_REQUESTS: ReadonlySet<HostRequestKind> = new Set([
	"select",
	"confirm",
	"input",
	"editor",
	"form",
	"dialog",
	"approval",
	"editor_text",
]);

function panelOf(value: Extract<LiveValue, { kind: "ext_panel" }>): UiPanel {
	return {
		...(value.title === undefined ? {} : { title: value.title }),
		placement: value.placement,
		node: value.node,
	};
}

export class TuiLiveView implements LiveClient {
	private readonly host: LiveViewHost;
	private readonly statuses = new Set<string>();
	/** Panels shown, by live key. */
	private readonly panels = new Map<string, Extract<LiveValue, { kind: "ext_panel" }>>();
	/** Work whose progress shows, by work id. */
	private readonly works = new Map<string, WorkValue>();
	private titled = false;
	/** Pending requests in the order they were asked; the first shows. */
	private readonly requests = new Map<string, HostRequest>();
	private showing: { readonly requestId: string; readonly controller: AbortController } | undefined;

	constructor(host: LiveViewHost) {
		this.host = host;
	}

	acceptsHostRequest(kind: HostRequestKind): boolean {
		return TUI_HOST_REQUESTS.has(kind);
	}

	apply(update: LiveUpdate): void {
		if (update.reset) this.clearAll();
		for (const item of update.items) this.applyItem(item);
		this.showNext();
	}

	private applyItem(item: LiveItem): void {
		switch (item.type) {
			case "set":
				this.set(item.key, item.value);
				return;
			case "clear":
				this.clear(item.key);
				return;
			case "patch":
				this.patch(item.key, item.ops);
				return;
			case "notice":
				this.host.notify(item.level, item.message);
				return;
			case "directive":
				if (item.directive === "insert_editor_text") this.host.insertEditorText(item.text);
				else this.host.setEditorText(item.text);
				return;
			default:
				// Streaming items: the TUI renders its session's events until it is a protocol client.
				return;
		}
	}

	private set(key: string, value: LiveValue): void {
		const id = key.slice(key.indexOf("/") + 1);
		switch (value.kind) {
			case "ext_status":
				this.statuses.add(id);
				this.host.setStatus(id, value.text);
				return;
			case "ext_panel":
				this.panels.set(key, value);
				this.host.setPanel(key, panelOf(value));
				return;
			case "ext_title":
				this.titled = true;
				this.host.setTitle(value.title);
				return;
			case "host_request":
				if (value.request.kind === "editor_text") {
					// Nothing to show: the editor's text answers it.
					const text = this.host.editorText();
					this.host.answer(value.requestId, text === undefined ? { cancelled: true } : { value: text });
					return;
				}
				this.requests.set(value.requestId, value.request);
				return;
			case "work":
				this.works.set(value.workId, value);
				this.host.showWork(value.workId, value);
				return;
			default:
				return;
		}
	}

	/** Apply a patch to the panel or work held under `key`; one that does not apply leaves it as it is. */
	private patch(key: string, ops: readonly UiPatchOp[]): void {
		const workId = key.startsWith("work/") ? key.slice("work/".length) : undefined;
		const value = workId === undefined ? this.panels.get(key) : this.works.get(workId);
		if (value === undefined) return;
		let patched: LiveValue;
		try {
			patched = patchLiveValue(value, ops);
		} catch {
			// The in-process live state applied it first; a patch that does not apply here changes nothing.
			return;
		}
		this.set(key, patched);
	}

	private clear(key: string): void {
		const slash = key.indexOf("/");
		const family = slash === -1 ? key : key.slice(0, slash);
		const id = key.slice(slash + 1);
		switch (family) {
			case "ext_status":
				this.statuses.delete(id);
				this.host.setStatus(id, undefined);
				return;
			case "ext_panel":
				if (this.panels.delete(key)) this.host.setPanel(key, undefined);
				return;
			case "ext_title":
				this.titled = false;
				this.host.setTitle(undefined);
				return;
			case "host_request":
				this.requests.delete(id);
				if (this.showing?.requestId === id) this.closeShowing();
				return;
			case "work":
				this.works.delete(id);
				this.host.showWork(id, undefined);
				return;
			default:
				return;
		}
	}

	private clearAll(): void {
		for (const key of this.statuses) this.host.setStatus(key, undefined);
		this.statuses.clear();
		for (const key of this.panels.keys()) this.host.setPanel(key, undefined);
		this.panels.clear();
		for (const workId of this.works.keys()) this.host.showWork(workId, undefined);
		this.works.clear();
		if (this.titled) {
			this.titled = false;
			this.host.setTitle(undefined);
		}
		this.requests.clear();
		this.closeShowing();
	}

	private closeShowing(): void {
		const showing = this.showing;
		this.showing = undefined;
		showing?.controller.abort();
	}

	/** Show the oldest pending request, unless one shows. */
	private showNext(): void {
		if (this.showing) return;
		const next = this.requests.entries().next();
		if (next.done) return;
		const [requestId, request] = next.value;
		const controller = new AbortController();
		this.showing = { requestId, controller };
		const settle = (response: HostResponse | undefined): void => {
			if (this.showing?.controller === controller) this.showing = undefined;
			if (!controller.signal.aborted) {
				// Answered, or closed here without an answer: the request leaves this view either way.
				this.requests.delete(requestId);
				if (response !== undefined) this.host.answer(requestId, response);
			}
			this.showNext();
		};
		void this.host.showRequest(request, controller.signal).then(settle, () => settle(undefined));
	}
}
