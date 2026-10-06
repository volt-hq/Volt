import type { OAuthDeviceCodeInfo } from "@hansjm10/volt-ai/oauth";
import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	sanitizeText,
	Text,
	type TUI,
} from "@hansjm10/volt-tui";
import { theme } from "../../../core/theme/runtime.ts";
import { openBrowser } from "../../../utils/open-browser.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";
import { SecretInput } from "./secret-input.ts";

/**
 * A sign-in address the dialog may show and open: an http or https URL, as
 * the URL parser writes it (control characters percent-encoded); undefined
 * for anything else.
 */
export function signInUrl(url: string | undefined): string | undefined {
	if (url === undefined) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
}

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends Container implements Focusable {
	private contentContainer: Container;
	/** The input of the prompt shown now: a new one per prompt, masked for a secret. */
	private input: Input;
	private tui: TUI;
	private abortController = new AbortController();
	private inputResolver?: (value: string) => void;
	private inputRejecter?: (error: Error) => void;
	private onComplete: (success: boolean, message?: string) => void;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		providerId: string,
		onComplete: (success: boolean, message?: string) => void,
		providerNameOverride?: string,
		titleOverride?: string,
	) {
		super();
		this.tui = tui;
		this.onComplete = onComplete;

		const providerName = providerNameOverride || providerId;
		const title = sanitizeText(titleOverride ?? `Login to ${providerName}`);

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		// Dynamic content area
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		this.input = this.createInput(false);

		// Bottom border
		this.addChild(new DynamicBorder());
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/** An input for the next prompt; a secret's submitted value never shows. */
	private createInput(secret: boolean): Input {
		const input = secret ? new SecretInput() : new Input();
		input.focused = this._focused;
		input.onSubmit = () => {
			if (this.inputResolver) {
				const value = input.getValue();
				this.contentContainer.children = this.contentContainer.children.map((child) =>
					child === input ? new Text(secret ? "> (hidden)" : `> ${value}`, 0, 0) : child,
				);
				this.inputResolver(value);
				this.inputResolver = undefined;
				this.inputRejecter = undefined;
			}
		};
		input.onEscape = () => {
			this.cancel();
		};
		return input;
	}

	private cancel(): void {
		this.abortController.abort();
		if (this.inputRejecter) {
			this.inputRejecter(new Error("Login cancelled"));
			this.inputResolver = undefined;
			this.inputRejecter = undefined;
		}
		this.onComplete(false, "Login cancelled");
	}

	/**
	 * Show a sign-in address and optional instructions; the address opens in
	 * the browser unless `open` is false.
	 */
	showAuth(url: string | undefined, instructions?: string, options: { open?: boolean } = {}): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		const address = signInUrl(url);
		this.showAddress(address);

		if (instructions) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("warning", sanitizeText(instructions)), 1, 0));
		}

		// Only an http or https address opens: anything else could run a local program.
		if (address !== undefined && options.open !== false) openBrowser(address);
		this.tui.requestRender();
	}

	/** Show a sign-in address as a link, or that there is none to open. */
	private showAddress(address: string | undefined): void {
		if (address === undefined) {
			this.contentContainer.addChild(
				new Text(theme.fg("error", "The sign-in address is not an http or https URL."), 1, 0),
			);
			return;
		}
		const linkedUrl = `\x1b]8;;${address}\x07${address}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hyperlink = `\x1b]8;;${address}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));
	}

	/**
	 * Called by onDeviceCode callback - show URL and user code.
	 */
	showDeviceCode(info: Pick<OAuthDeviceCodeInfo, "userCode"> & { verificationUri: string | undefined }): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		this.showAddress(signInUrl(info.verificationUri));
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("warning", `Enter code: ${sanitizeText(info.userCode)}`), 1, 0));

		this.tui.requestRender();
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string): Promise<string> {
		this.input = this.createInput(false);
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", prompt), 1, 0));
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
	 */
	showPrompt(message: string, placeholder?: string, options?: { secret?: boolean }): Promise<string> {
		this.input = this.createInput(options?.secret === true);
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", sanitizeText(message)), 1, 0));
		if (placeholder) {
			this.contentContainer.addChild(new Text(theme.fg("dim", `e.g., ${sanitizeText(placeholder)}`), 1, 0));
		}
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(
			new Text(
				`(${keyHint("tui.select.cancel", "to cancel,")} ${keyHint("tui.select.confirm", "to submit")})`,
				1,
				0,
			),
		);

		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * Show informational text without prompting for input.
	 */
	showInfo(lines: string[]): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		for (const line of lines) {
			this.contentContainer.addChild(new Text(line, 1, 0));
		}
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to close")})`, 1, 0));
		this.tui.requestRender();
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		// Pass to input
		this.input.handleInput(data);
	}
}
