/**
 * Which of an extension's commands paired remote devices, such as the phone
 * app, may run. `/extensions` shows it for a running extension: a switch per
 * command the extension does not mark remote-safe, read through the
 * `extension_remote_commands` query and saved through the
 * `set_extension_remote_commands` intent into the user's global settings
 * (`extensions.<id>.remoteSafeCommands`). Commands the extension marks
 * remote-safe are always allowed and listed without a switch. Saving replaces
 * the stored list with the commands switched on.
 */

import type { ExtensionRemoteCommand } from "@hansjm10/volt-protocol";
import {
	type Component,
	concatRenderFrames,
	createRenderFrame,
	type Focusable,
	Form,
	type FormField,
	type FormValues,
	type RenderFrame,
	sanitizeText,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@hansjm10/volt-tui";
import { theme } from "../../../core/theme/runtime.ts";
import { TUI_SEMANTIC_THEME } from "../ui-node/semantic-theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import type { ExtensionDetail } from "./extension-settings.ts";
import { keyHint } from "./keybinding-hints.ts";

/** Where the component reads and stores the extension's remote command access. */
export interface ExtensionRemoteCommandsSource {
	/** The extension's commands, each with who lets remote devices run it. */
	load(): Promise<readonly ExtensionRemoteCommand[]>;
	/** Replace the commands the user allows; rejects with a message to show when refused. */
	save(commands: readonly string[]): Promise<void>;
}

export interface ExtensionRemoteCommandsComponentOptions {
	readonly onClose: () => void;
	readonly requestRender: () => void;
}

type Status = { readonly text: string; readonly token: "muted" | "success" | "error" };

export class ExtensionRemoteCommandsComponent implements Component, Focusable {
	private readonly detail: Pick<ExtensionDetail, "id" | "displayName">;
	private readonly source: ExtensionRemoteCommandsSource;
	private readonly options: ExtensionRemoteCommandsComponentOptions;
	private readonly border = new DynamicBorder();
	private commands: readonly ExtensionRemoteCommand[] | undefined;
	private form: Form | undefined;
	private status: Status | undefined = { text: "Loading commands…", token: "muted" };
	private hasFocus = false;
	private saving = false;

	constructor(
		detail: Pick<ExtensionDetail, "id" | "displayName">,
		source: ExtensionRemoteCommandsSource,
		options: ExtensionRemoteCommandsComponentOptions,
	) {
		this.detail = detail;
		this.source = source;
		this.options = options;
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(focused: boolean) {
		this.hasFocus = focused;
		if (this.form) this.form.focused = focused;
	}

	/** Load the commands and show their switches. */
	async start(): Promise<void> {
		await this.reload();
	}

	private async reload(message?: Status): Promise<void> {
		try {
			this.commands = await this.source.load();
			this.status = message;
			this.buildForm();
		} catch (error) {
			this.status = { text: error instanceof Error ? error.message : String(error), token: "error" };
		}
		this.options.requestRender();
	}

	/** The commands the user decides: every one the extension does not mark remote-safe. */
	private switchable(): ExtensionRemoteCommand[] {
		return (this.commands ?? []).filter((command) => command.access !== "extension");
	}

	private buildForm(): void {
		const fields: FormField[] = this.switchable().map((command) => ({
			id: command.name,
			kind: "boolean",
			label: `/${command.name}`,
			value: command.access === "user",
			...(command.description === undefined ? {} : { description: sanitizeText(command.description) }),
		}));
		if (fields.length === 0) {
			this.form = undefined;
			return;
		}
		const props = { fields, submitLabel: "Save", cancelLabel: "Close" };
		// After a save, the same form keeps the field the user was on.
		if (this.form) {
			this.form.setProps(props);
			return;
		}
		const form = new Form(TUI_SEMANTIC_THEME, props);
		form.onSubmit = (values) => void this.save(values);
		form.onCancel = () => this.options.onClose();
		form.focused = this.hasFocus;
		this.form = form;
	}

	private async save(values: FormValues): Promise<void> {
		if (this.saving) return;
		const allowed = this.switchable()
			.map((command) => command.name)
			.filter((name) => values[name] === true);
		this.saving = true;
		this.status = { text: "Saving…", token: "muted" };
		this.options.requestRender();
		try {
			await this.source.save(allowed);
			await this.reload({
				text: allowed.length === 0 ? "Saved: no commands allowed" : `Saved: ${allowed.length} allowed`,
				token: "success",
			});
		} catch (error) {
			this.status = { text: error instanceof Error ? error.message : String(error), token: "error" };
			this.options.requestRender();
		} finally {
			this.saving = false;
		}
	}

	handleInput(data: string): void {
		if (this.form) {
			this.form.handleInput(data);
			return;
		}
		this.options.onClose();
	}

	invalidate(): void {
		this.form?.invalidate();
		this.border.invalidate();
	}

	private bodyLines(width: number): string[] {
		const wrap = (text: string): string[] => wrapTextWithAnsi(text, Math.max(1, width - 1)).map((line) => ` ${line}`);
		const lines = [
			truncateToWidth(
				` ${theme.fg("accent", theme.bold(sanitizeText(this.detail.displayName)))} ${theme.fg(
					"muted",
					`${this.detail.id} · remote commands`,
				)}`,
				width,
				"…",
			),
			...wrap(
				theme.fg(
					"muted",
					"Paired devices, such as the phone app, may run the commands you allow. They run on this host with the extension's permissions.",
				),
			),
		];
		const commands = this.commands;
		if (commands === undefined) return lines;
		const declared = commands.filter((command) => command.access === "extension");
		if (declared.length > 0) {
			const names = declared.map((command) => `/${sanitizeText(command.name)}`).join(", ");
			lines.push(...wrap(theme.fg("muted", `Always allowed by the extension: ${names}`)));
		}
		if (commands.length === 0) lines.push("", ...wrap(theme.fg("muted", "This extension registers no commands.")));
		else if (!this.form)
			lines.push("", ...wrap(theme.fg("muted", "The extension allows every command it registers.")));
		return lines;
	}

	render(width: number): RenderFrame {
		const frames: RenderFrame[] = [this.border.render(width), createRenderFrame(this.bodyLines(width))];
		if (this.form) frames.push(createRenderFrame([""]), this.form.render(width));
		if (this.status) {
			frames.push(
				createRenderFrame([
					"",
					...wrapTextWithAnsi(
						theme.fg(this.status.token, sanitizeText(this.status.text)),
						Math.max(1, width - 1),
					).map((line) => ` ${line}`),
				]),
			);
		}
		const hints = this.form
			? `${keyHint("tui.select.toggle", "allow")}  ${keyHint("tui.focus.next", "next")}  ${keyHint("tui.select.confirm", "save")}  ${keyHint("tui.select.cancel", "close")}`
			: keyHint("tui.select.cancel", "close");
		frames.push(createRenderFrame(["", truncateToWidth(` ${hints}`, width, "")]), this.border.render(width));
		return concatRenderFrames(frames);
	}
}
