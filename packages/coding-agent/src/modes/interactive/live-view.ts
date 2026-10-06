/**
 * The TUI's view of the live state of the conversation it shows, as its
 * client's live frames change it: extension panels and title; notices (the
 * host's own and its extensions') and editor directives; the end of the work
 * the host runs; and the dialogs, forms, and approvals the TUI answers, shown
 * one at a time in the order they were asked. A request another client
 * answered, or that ended, closes without an answer. An `editor_text` request
 * is answered at once with the editor's text. A patched panel shows as the
 * client's live fold holds it. Status items, phase, and work progress are
 * read from the store where they show.
 */

import type {
	HostRequest,
	HostRequestKind,
	HostResponse,
	LiveItem,
	LiveValue,
	UiNodeStyledText,
} from "@hansjm10/volt-protocol";
import type { UiPanel } from "./ui-node/panels.ts";

/** What the live view renders into. */
export interface LiveViewHost {
	/** Show `request` until the user answers or `signal` aborts: the answer, or undefined when it closed without one. */
	showRequest(request: HostRequest, signal: AbortSignal): Promise<HostResponse | undefined>;
	/** Answer `requestId` in the conversation the TUI shows. */
	answer(requestId: string, response: HostResponse): void;
	/** Show, update, or remove the panel under its live key. */
	setPanel(key: string, panel: UiPanel | undefined): void;
	/** Show an extension's title, or the TUI's own without one. */
	setTitle(title: string | undefined): void;
	/** Show a notice: from an extension (`source`, its id), or the host's own; `detail` such as an error's stack. */
	notify(level: "info" | "warning" | "error", message: UiNodeStyledText, source?: string, detail?: string): void;
	setEditorText(text: string): void;
	/** Paste text into the editor at the cursor. */
	insertEditorText(text: string): void;
	/** The editor's text, or undefined when the TUI shows no editor. */
	editorText(): string | undefined;
	/** The executor of work `workId` detached: the work ended, or suspended. */
	workDetached(workId: string): void;
	/** The live value under `key` as the client's live fold holds it, patches applied. */
	liveValue(key: string): LiveValue | undefined;
}

/** The host request kinds the TUI answers. */
export const TUI_HOST_REQUESTS: readonly HostRequestKind[] = [
	"select",
	"confirm",
	"input",
	"editor",
	"form",
	"dialog",
	"approval",
	"editor_text",
];

function panelOf(value: Extract<LiveValue, { kind: "ext_panel" }>): UiPanel {
	return {
		...(value.title === undefined ? {} : { title: value.title }),
		placement: value.placement,
		node: value.node,
	};
}

export class TuiLiveView {
	private readonly host: LiveViewHost;
	/** Panels shown, by live key. */
	private readonly panels = new Map<string, Extract<LiveValue, { kind: "ext_panel" }>>();
	/** Work an executor runs, by work id. */
	private readonly works = new Set<string>();
	private titled = false;
	/** Pending requests in the order they were asked; the first shows. */
	private readonly requests = new Map<string, HostRequest>();
	private showing: { readonly requestId: string; readonly controller: AbortController } | undefined;

	constructor(host: LiveViewHost) {
		this.host = host;
	}

	/** Apply a live frame: a reset replaces what the view shows. */
	apply(update: { readonly reset: boolean; readonly items: readonly LiveItem[] }): void {
		const running = update.reset ? [...this.works] : [];
		if (update.reset) this.clearAll();
		for (const item of update.items) this.applyItem(item);
		// Work the reset no longer runs detached meanwhile.
		for (const workId of running) if (!this.works.has(workId)) this.host.workDetached(workId);
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
			case "patch": {
				const value = this.host.liveValue(item.key);
				if (value !== undefined) this.set(item.key, value);
				return;
			}
			case "notice":
				this.host.notify(item.level, item.message, item.source, item.detail);
				return;
			case "directive":
				if (item.directive === "insert_editor_text") this.host.insertEditorText(item.text);
				else this.host.setEditorText(item.text);
				return;
			default:
				// Streaming items: the transcript draws them.
				return;
		}
	}

	private set(key: string, value: LiveValue): void {
		switch (value.kind) {
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
				this.works.add(value.workId);
				return;
			default:
				return;
		}
	}

	private clear(key: string): void {
		const slash = key.indexOf("/");
		const family = slash === -1 ? key : key.slice(0, slash);
		const id = key.slice(slash + 1);
		switch (family) {
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
				if (this.works.delete(id)) this.host.workDetached(id);
				return;
			default:
				return;
		}
	}

	private clearAll(): void {
		for (const key of this.panels.keys()) this.host.setPanel(key, undefined);
		this.panels.clear();
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
