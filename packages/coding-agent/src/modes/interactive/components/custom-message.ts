import type { JsonValue, TextContent } from "@hansjm10/volt-ai";
import type { Component } from "@hansjm10/volt-tui";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@hansjm10/volt-tui";
import { BACKGROUND_JOB_NOTIFICATION_TYPE } from "../../../core/background-jobs.ts";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../../../core/theme/runtime.ts";
import { renderBackgroundJobNotification } from "./background-job-notification.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<JsonValue>;
	private customRenderer?: MessageRenderer;
	private defaultContainer: Container;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;

	constructor(
		message: CustomMessage<JsonValue>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;

		this.addChild(new Spacer(1));

		this.defaultContainer = new Container();

		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		// Remove previous content component
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.defaultContainer);

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(this.message, { expanded: this._expanded }, theme);
				if (component) {
					// Custom renderer provides its own styled component
					this.customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		this.addChild(this.defaultContainer);
		this.defaultContainer.clear();

		const details = this.message.details;
		if (this.message.customType === BACKGROUND_JOB_NOTIFICATION_TYPE) {
			const notification = renderBackgroundJobNotification(details, this._expanded, theme);
			if (notification) {
				this.defaultContainer.addChild(notification);
				return;
			}
		}
		const reviewSummary =
			this.message.customType === "review" &&
			typeof details === "object" &&
			details !== null &&
			!Array.isArray(details) &&
			typeof details.summary === "string"
				? details.summary
				: undefined;

		// Generic messages keep their compact label and unboxed prose.
		if (reviewSummary === undefined) {
			const label = theme.bg(
				"customMessageBg",
				theme.fg("customMessageLabel", theme.bold(` ${this.message.customType} `)),
			);
			this.defaultContainer.addChild(new Text(label, 1, 0));
		}

		// Extract text content
		let text: string;
		if (typeof this.message.content === "string") {
			text = this.message.content;
		} else {
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}

		this.defaultContainer.addChild(
			new Markdown(reviewSummary !== undefined && !this._expanded ? reviewSummary : text, 1, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);

		if (reviewSummary !== undefined) {
			const expandKey = keyDisplayText("app.tools.expand");
			if (expandKey) {
				this.defaultContainer.addChild(new Spacer(1));
				this.defaultContainer.addChild(
					new Text(
						theme.fg("dim", `${expandKey} to ${this._expanded ? "collapse" : "expand"} review details`),
						1,
						0,
					),
				);
			}
		}
	}
}
