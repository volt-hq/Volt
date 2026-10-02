import { createRenderFrame, type RenderFrame } from "../render-frame.ts";
import {
	type SemanticTheme,
	type SemanticToken,
	type StyledText,
	truncateStyledText,
	wrapStyledText,
} from "../styled-text.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface Notification {
	id: string;
	message: StyledText;
	level?: NotificationLevel;
	title?: StyledText;
	/** Dismiss automatically after this many milliseconds. */
	durationMs?: number;
}

export interface NotificationStackProps {
	notifications?: readonly Notification[];
	/** Maximum notifications shown, newest last. Defaults to 3. */
	maxVisible?: number;
}

export interface NotificationStackOptions {
	/** Called when a timed notification is dismissed, so the host can render again. */
	requestRender?: () => void;
}

const LEVEL_STYLES: Record<NotificationLevel, { icon: string; token: SemanticToken }> = {
	info: { icon: "i", token: "info" },
	success: { icon: "✓", token: "success" },
	warning: { icon: "!", token: "warning" },
	error: { icon: "✗", token: "error" },
};

interface ActiveNotification {
	notification: Notification;
	timer: NodeJS.Timeout | undefined;
}

/**
 * Stack of notifications, newest last. Use it declaratively through `setProps` or imperatively with `push`
 * and `dismiss`. Timed notifications dismiss themselves; a dismissed id is not shown again while the props
 * still contain it.
 */
export class NotificationStack implements Component {
	onDismiss?: (id: string) => void;
	private readonly theme: SemanticTheme;
	private readonly requestRender: (() => void) | undefined;
	private props: NotificationStackProps;
	private active: ActiveNotification[] = [];
	private readonly dismissed = new Set<string>();

	constructor(theme: SemanticTheme, props: NotificationStackProps = {}, options: NotificationStackOptions = {}) {
		this.theme = theme;
		this.props = props;
		this.requestRender = options.requestRender;
		for (const notification of props.notifications ?? []) this.push(notification);
	}

	/** Sync the shown set with `props.notifications`: add new ids, update changed ones, remove missing ones. */
	setProps(props: NotificationStackProps): void {
		this.props = props;
		const notifications = props.notifications ?? [];
		const ids = new Set(notifications.map((notification) => notification.id));
		for (const id of [...this.dismissed]) if (!ids.has(id)) this.dismissed.delete(id);
		for (const entry of [...this.active]) {
			if (!ids.has(entry.notification.id)) this.remove(entry.notification.id);
		}
		for (const notification of notifications) {
			if (this.dismissed.has(notification.id)) continue;
			const existing = this.active.find((entry) => entry.notification.id === notification.id);
			if (existing?.notification !== notification) this.push(notification);
		}
	}

	/** Show a notification, replacing one with the same id. */
	push(notification: Notification): void {
		this.dismissed.delete(notification.id);
		const entry: ActiveNotification = { notification, timer: undefined };
		if (notification.durationMs !== undefined) {
			entry.timer = setTimeout(() => this.dismiss(notification.id), Math.max(0, notification.durationMs));
			entry.timer.unref();
		}
		const index = this.active.findIndex((candidate) => candidate.notification.id === notification.id);
		if (index === -1) {
			this.active.push(entry);
			return;
		}
		clearTimeout(this.active[index]!.timer);
		this.active[index] = entry;
	}

	/** Dismiss a notification. Returns false when it is not shown. */
	dismiss(id: string): boolean {
		if (!this.remove(id)) return false;
		this.dismissed.add(id);
		this.onDismiss?.(id);
		this.requestRender?.();
		return true;
	}

	/** Ids of the shown notifications, oldest first. */
	getIds(): string[] {
		return this.active.map((entry) => entry.notification.id);
	}

	/** Cancel timers and remove every notification. */
	dispose(): void {
		for (const entry of this.active) clearTimeout(entry.timer);
		this.active = [];
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		const maxVisible = Math.max(1, this.props.maxVisible ?? 3);
		const shown = this.active.slice(-maxVisible);
		const lines: string[] = [];
		const hidden = this.active.length - shown.length;
		if (hidden > 0) lines.push(this.theme.muted(truncateToWidth(`+${hidden} more`, width, "")));
		for (const { notification } of shown) {
			const { icon, token } = LEVEL_STYLES[notification.level ?? "info"];
			const prefix = `${this.theme.bold(this.theme[token](icon))} `;
			const bodyWidth = Math.max(1, width - 2);
			if (notification.title !== undefined) {
				lines.push(
					truncateToWidth(
						prefix + this.theme.bold(truncateStyledText(notification.title, bodyWidth, this.theme, token)),
						width,
						"",
					),
				);
			}
			const body = wrapStyledText(notification.message, bodyWidth, this.theme);
			for (const [index, line] of body.entries()) {
				const lead = index === 0 && notification.title === undefined ? prefix : "  ";
				lines.push(truncateToWidth(lead + line, width, ""));
			}
		}
		return createRenderFrame(lines);
	}

	private remove(id: string): boolean {
		const index = this.active.findIndex((entry) => entry.notification.id === id);
		if (index === -1) return false;
		clearTimeout(this.active[index]!.timer);
		this.active.splice(index, 1);
		return true;
	}
}
