/**
 * The TUI's view of the live state of the conversation it shows: extension
 * status, string widgets, and title; notices and editor text; the progress
 * of the work this host runs; and the dialogs and approvals it answers in
 * process, shown one at a time in the order they were asked. A request
 * another client answered, or that ended, closes without an answer.
 */

import type { HostRequest, HostRequestKind, HostResponse, LiveItem, LiveValue } from "@hansjm10/volt-protocol";
import type { LiveClient, LiveUpdate } from "../../core/host/live-state.ts";

type WidgetPlacement = Extract<LiveValue, { kind: "ext_widget" }>["placement"];

/** What the live view renders into. */
export interface LiveViewHost {
	/** Show `request` until the user answers or `signal` aborts: the answer, or undefined when it closed without one. */
	showRequest(request: HostRequest, signal: AbortSignal): Promise<HostResponse | undefined>;
	/** Answer `requestId` in the conversation the TUI shows. */
	answer(requestId: string, response: HostResponse): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, lines: readonly string[] | undefined, placement: WidgetPlacement): void;
	/** Show an extension's title, or the TUI's own without one. */
	setTitle(title: string | undefined): void;
	notify(level: "info" | "warning" | "error", message: string): void;
	setEditorText(text: string): void;
	/** Work `workId` reported progress, or, without a value, its executor detached. */
	showWork(workId: string, value: Extract<LiveValue, { kind: "work" }> | undefined): void;
}

const TUI_HOST_REQUESTS: ReadonlySet<HostRequestKind> = new Set(["select", "confirm", "input", "editor", "approval"]);

export class TuiLiveView implements LiveClient {
	private readonly host: LiveViewHost;
	private readonly statuses = new Set<string>();
	private readonly widgets = new Set<string>();
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

	/** Whether the widget under `key` shows live lines, which an extension UI reset leaves alone. */
	ownsWidget(key: string): boolean {
		return this.widgets.has(key);
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
			case "notice":
				this.host.notify(item.level, item.message);
				return;
			case "directive":
				this.host.setEditorText(item.text);
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
			case "ext_widget":
				this.widgets.add(id);
				this.host.setWidget(id, value.lines, value.placement);
				return;
			case "ext_title":
				this.titled = true;
				this.host.setTitle(value.title);
				return;
			case "host_request":
				this.requests.set(value.requestId, value.request);
				return;
			case "work":
				this.host.showWork(value.workId, value);
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
			case "ext_status":
				this.statuses.delete(id);
				this.host.setStatus(id, undefined);
				return;
			case "ext_widget":
				this.widgets.delete(id);
				this.host.setWidget(id, undefined, "aboveEditor");
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
				this.host.showWork(id, undefined);
				return;
			default:
				return;
		}
	}

	private clearAll(): void {
		for (const key of this.statuses) this.host.setStatus(key, undefined);
		this.statuses.clear();
		for (const key of this.widgets) this.host.setWidget(key, undefined, "aboveEditor");
		this.widgets.clear();
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
