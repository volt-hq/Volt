/**
 * Form and dialog host requests in the TUI (RFC §8.3): a form request shows
 * its fields as the `form` node does and answers with the values; a dialog
 * shows its title and body as `UiNode` data and answers with the id of the
 * action chosen. Cancel dismisses either, and a timeout counts down in the
 * title.
 */

import type { HostRequest } from "@hansjm10/volt-protocol";
import {
	ActionBar,
	type Component,
	Container,
	type Focusable,
	Form,
	type FormValues,
	prefixRenderFrame,
	Spacer,
	Text,
	type TUI,
} from "@hansjm10/volt-tui";
import { theme } from "../../../core/theme/runtime.ts";
import type { UiIntentSink } from "../ui-node/intents.ts";
import { createUiNodeView, formField } from "../ui-node/registry.ts";
import { TUI_SEMANTIC_THEME } from "../ui-node/semantic-theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

type FormRequest = Extract<HostRequest, { kind: "form" }>;
type DialogRequest = Extract<HostRequest, { kind: "dialog" }>;

export interface HostRequestDialogOptions {
	tui?: TUI;
	/** Milliseconds until the request is dismissed. */
	timeout?: number;
}

/** A bordered request: its title (with the countdown), its content, and the hint line. */
abstract class HostRequestDialog extends Container implements Focusable {
	private readonly titleText: Text;
	private readonly countdown: CountdownTimer | undefined;
	private hasFocus = false;

	constructor(
		title: string,
		content: readonly Component[],
		hint: string,
		onCancel: () => void,
		opts: HostRequestDialogOptions,
	) {
		super();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.titleText = new Text(theme.fg("accent", title), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));
		// The content is indented as the title is.
		for (const component of content) {
			this.addChild({
				invalidate: () => component.invalidate(),
				render: (width) => prefixRenderFrame(component.render(Math.max(1, width - 2)), " "),
			});
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(hint, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		if (opts.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(seconds) => this.titleText.setText(theme.fg("accent", `${title} (${seconds}s)`)),
				onCancel,
			);
		}
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(focused: boolean) {
		this.hasFocus = focused;
		this.focusContent(focused);
	}

	protected abstract focusContent(focused: boolean): void;

	dispose(): void {
		this.countdown?.dispose();
	}
}

/** A form request: submitting answers with the values of the fields that have one. */
export class HostFormDialogComponent extends HostRequestDialog {
	private readonly form: Form;

	constructor(
		request: FormRequest,
		onSubmit: (values: Record<string, string | boolean | number>) => void,
		onCancel: () => void,
		opts: HostRequestDialogOptions = {},
	) {
		const form = new Form(TUI_SEMANTIC_THEME, { fields: request.fields.map(formField) });
		super(
			request.title,
			[form],
			`${keyHint("tui.focus.next", "next field")}  ${keyHint("tui.select.cancel", "cancel")}`,
			onCancel,
			opts,
		);
		this.form = form;
		form.onSubmit = (values: FormValues) => {
			const answered: Record<string, string | boolean | number> = {};
			for (const [id, value] of Object.entries(values)) if (value !== undefined) answered[id] = value;
			onSubmit(answered);
		};
		form.onCancel = onCancel;
	}

	protected focusContent(focused: boolean): void {
		this.form.focused = focused;
	}

	handleInput(data: string): void {
		this.form.handleInput(data);
	}
}

/** A dialog request: its body as `UiNode` data, and the actions that answer it. */
export class HostDialogComponent extends HostRequestDialog {
	private readonly actions: ActionBar;
	private readonly disposeBody: () => void;

	constructor(
		request: DialogRequest,
		onAction: (actionId: string) => void,
		onCancel: () => void,
		opts: HostRequestDialogOptions & { intents?: UiIntentSink } = {},
	) {
		const body = createUiNodeView(opts.intents === undefined ? {} : { intents: opts.intents });
		body.update(request.body);
		const actions = new ActionBar(TUI_SEMANTIC_THEME, {
			actions: request.actions.map((action) => ({
				id: action.id,
				label: action.label,
				token: action.token ?? (action.destructive ? "error" : undefined),
			})),
		});
		const bodyView: Component = {
			invalidate: () => body.invalidate(),
			render: (width) => body.render(width),
		};
		super(
			request.title,
			request.body.length === 0 ? [actions] : [bodyView, new Spacer(1), actions],
			`${keyHint("tui.select.confirm", "choose")}  ${keyHint("tui.select.cancel", "cancel")}`,
			onCancel,
			opts,
		);
		this.actions = actions;
		actions.onAction = onAction;
		actions.onCancel = onCancel;
		this.disposeBody = () => body.dispose();
	}

	protected focusContent(focused: boolean): void {
		this.actions.focused = focused;
	}

	handleInput(data: string): void {
		this.actions.handleInput(data);
	}

	override dispose(): void {
		super.dispose();
		this.disposeBody();
	}
}
