import { Container, getKeybindings, Loader, Spacer, Text, type TUI } from "@hansjm10/volt-tui";
import { theme } from "../../../core/theme/runtime.ts";
import type { DaemonLeaseWait } from "../daemon-attach.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

/**
 * The wait for the daemon's current turn in a session this TUI is opening:
 * the interrupt key stops that turn, and the clear or exit key cancels
 * opening the session, which the daemon keeps.
 */
export class DaemonLeaseWaitComponent extends Container {
	private readonly loader: Loader;
	private readonly wait: DaemonLeaseWait;
	private stopping = false;

	constructor(tui: TUI, sessionId: string, wait: DaemonLeaseWait) {
		super();
		this.wait = wait;
		const borderColor = (text: string) => theme.fg("border", text);
		this.addChild(new DynamicBorder(borderColor));
		this.loader = new Loader(
			tui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Waiting for the remote turn in session ${sessionId} to finish before opening it here...`,
		);
		this.addChild(this.loader);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`${keyHint("app.interrupt", "stop that turn")}${theme.fg("muted", " · ")}${keyHint("app.clear", "cancel")}`,
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(borderColor));
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "app.interrupt")) {
			if (this.stopping) return;
			this.stopping = true;
			this.loader.setMessage("Stopping the remote turn...");
			this.wait.abortRemoteTurn();
		} else if (keybindings.matches(data, "app.clear") || keybindings.matches(data, "app.exit")) {
			this.wait.cancel();
		}
	}

	dispose(): void {
		this.loader.stop();
	}
}
