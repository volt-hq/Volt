import { concatRenderFrames, createRenderFrame, type RenderFrame } from "@hansjm10/volt-tui";
/**
 * RPC Extension UI Example (TUI)
 *
 * A lightweight TUI chat client that spawns the agent in RPC mode.
 * Demonstrates how to build a custom UI on the RPC protocol's frames:
 * hello, a snapshot subscription, the live lane (streaming text, tools, the
 * run phase, extension status and widgets), prompt intents, and answering the
 * host requests extensions ask (select, confirm, input, editor).
 *
 * Usage: npx tsx examples/rpc-extension-ui.ts
 *
 * Slash commands:
 *   /select  - demo select dialog
 *   /confirm - demo confirm dialog
 *   /input   - demo input dialog
 *   /editor  - demo editor dialog
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
	type Component,
	Container,
	Input,
	matchesKey,
	ProcessTerminal,
	SelectList,
	type TUI,
	TuiMainScreen,
} from "@hansjm10/volt-tui";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// ANSI helpers
// ============================================================================

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// ============================================================================
// Host requests and live items (subset of @hansjm10/volt-protocol)
// ============================================================================

type HostRequest =
	| { kind: "select"; title: string; options: string[] }
	| { kind: "confirm"; title: string; message: string }
	| { kind: "input"; title: string; placeholder?: string }
	| { kind: "editor"; title: string; prefill?: string };

interface LiveItem {
	type: string;
	key?: string;
	value?: Record<string, unknown> & { kind: string };
	event?: { type: string; delta?: string };
	op?: string;
	toolName?: string;
	level?: string;
	message?: string;
	directive?: string;
	text?: string;
}

// ============================================================================
// Output log: accumulates styled lines, renders the tail that fits
// ============================================================================

class OutputLog implements Component {
	private lines: string[] = [];
	private maxLines = 1000;
	private visibleLines = 0;

	setVisibleLines(n: number): void {
		this.visibleLines = n;
	}

	append(line: string): void {
		this.lines.push(line);
		if (this.lines.length > this.maxLines) {
			this.lines = this.lines.slice(-this.maxLines);
		}
	}

	appendRaw(text: string): void {
		if (this.lines.length === 0) {
			this.lines.push(text);
		} else {
			this.lines[this.lines.length - 1] += text;
		}
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		if (this.lines.length === 0) return createRenderFrame([""]);
		const n = this.visibleLines > 0 ? this.visibleLines : this.lines.length;
		return createRenderFrame(this.lines.slice(-n).map((l) => l.slice(0, width)));
	}
}

// ============================================================================
// Loading indicator: "Agent: Working." -> ".." -> "..." -> "."
// ============================================================================

class LoadingIndicator implements Component {
	private dots = 1;
	private intervalId: NodeJS.Timeout | null = null;
	private tui: TUI | null = null;

	start(tui: TUI): void {
		this.tui = tui;
		this.dots = 1;
		this.intervalId = setInterval(() => {
			this.dots = (this.dots % 3) + 1;
			this.tui?.requestRender();
		}, 400);
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	invalidate(): void {}

	render(_width: number): RenderFrame {
		return createRenderFrame([`${BLUE}${BOLD}Agent:${RESET} ${DIM}Working${".".repeat(this.dots)}${RESET}`]);
	}
}

// ============================================================================
// Prompt input: label + single-line input
// ============================================================================

class PromptInput implements Component {
	readonly input: Input;
	onCtrlD?: () => void;

	constructor() {
		this.input = new Input();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+d")) {
			this.onCtrlD?.();
			return;
		}
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): RenderFrame {
		return concatRenderFrames([createRenderFrame([`${GREEN}${BOLD}You:${RESET}`]), this.input.render(width)]);
	}
}

// ============================================================================
// Dialog components: replace the prompt input during interactive requests
// ============================================================================

class SelectDialog implements Component {
	private list: SelectList;
	private title: string;
	onSelect?: (value: string) => void;
	onCancel?: () => void;

	constructor(title: string, options: string[]) {
		this.title = title;
		const items = options.map((o) => ({ value: o, label: o }));
		this.list = new SelectList(items, Math.min(items.length, 8), {
			selectedPrefix: (t) => `${MAGENTA}${t}${RESET}`,
			selectedText: (t) => `${MAGENTA}${t}${RESET}`,
			description: (t) => `${DIM}${t}${RESET}`,
			scrollInfo: (t) => `${DIM}${t}${RESET}`,
			noMatch: (t) => `${YELLOW}${t}${RESET}`,
		});
		this.list.onSelect = (item) => this.onSelect?.(item.value);
		this.list.onCancel = () => this.onCancel?.();
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): RenderFrame {
		return concatRenderFrames([
			createRenderFrame([`${MAGENTA}${BOLD}${this.title}${RESET}`]),
			this.list.render(width),
			createRenderFrame([`${DIM}Up/Down, Enter to select, Esc to cancel${RESET}`]),
		]);
	}
}

class InputDialog implements Component {
	private dialogInput: Input;
	private title: string;
	onCtrlD?: () => void;

	constructor(title: string, prefill?: string) {
		this.title = title;
		this.dialogInput = new Input();
		if (prefill) this.dialogInput.setValue(prefill);
	}

	set onSubmit(fn: ((value: string) => void) | undefined) {
		this.dialogInput.onSubmit = fn;
	}

	set onEscape(fn: (() => void) | undefined) {
		this.dialogInput.onEscape = fn;
	}

	get inputComponent(): Input {
		return this.dialogInput;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+d")) {
			this.onCtrlD?.();
			return;
		}
		this.dialogInput.handleInput(data);
	}

	invalidate(): void {
		this.dialogInput.invalidate();
	}

	render(width: number): RenderFrame {
		return concatRenderFrames([
			createRenderFrame([`${MAGENTA}${BOLD}${this.title}${RESET}`]),
			this.dialogInput.render(width),
			createRenderFrame([`${DIM}Enter to submit, Esc to cancel${RESET}`]),
		]);
	}
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	const extensionPath = join(__dirname, "extensions/rpc-demo.ts");
	const cliPath = join(__dirname, "../dist/cli.js");

	const agent = spawn(
		"node",
		[cliPath, "--mode", "rpc", "--no-session", "--no-extension", "--extension", extensionPath],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);

	let stderr = "";
	agent.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString();
	});

	await new Promise((resolve) => setTimeout(resolve, 500));
	if (agent.exitCode !== null) {
		console.error(`Agent exited immediately. Stderr:\n${stderr}`);
		process.exit(1);
	}

	// -- TUI setup --

	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal);

	const outputLog = new OutputLog();
	const loadingIndicator = new LoadingIndicator();
	const promptInput = new PromptInput();

	const root = new Container();
	root.addChild(outputLog);
	root.addChild(promptInput);

	tui.addChild(root);
	tui.setFocus(promptInput.input);

	// -- Agent communication --

	function send(obj: Record<string, unknown>): void {
		agent.stdin!.write(`${JSON.stringify(obj)}\n`);
	}

	let isStreaming = false;
	let hasTextOutput = false;

	function exit(): void {
		tui.stop();
		agent.kill("SIGTERM");
		process.exit(0);
	}

	// -- Bottom area management --
	// The bottom of the screen is either the prompt input or a dialog.
	// These helpers swap between them.

	let activeDialog: Component | null = null;

	function setBottomComponent(component: Component): void {
		root.clear();
		root.addChild(outputLog);
		if (isStreaming) root.addChild(loadingIndicator);
		root.addChild(component);
		tui.setFocus(component);
		tui.requestRender();
	}

	function showPrompt(): void {
		activeDialog = null;
		setBottomComponent(promptInput);
		tui.setFocus(promptInput.input);
	}

	function showDialog(dialog: Component): void {
		activeDialog = dialog;
		setBottomComponent(dialog);
	}

	function showLoading(): void {
		if (!isStreaming) {
			isStreaming = true;
			hasTextOutput = false;
			root.clear();
			root.addChild(outputLog);
			root.addChild(loadingIndicator);
			root.addChild(activeDialog ?? promptInput);
			if (!activeDialog) tui.setFocus(promptInput.input);
			loadingIndicator.start(tui);
			tui.requestRender();
		}
	}

	function hideLoading(): void {
		loadingIndicator.stop();
		root.clear();
		root.addChild(outputLog);
		root.addChild(activeDialog ?? promptInput);
		if (!activeDialog) tui.setFocus(promptInput.input);
		tui.requestRender();
	}

	// -- Extension UI dialog handling --

	function showSelectDialog(title: string, options: string[], onDone: (value: string | undefined) => void): void {
		const dialog = new SelectDialog(title, options);
		dialog.onSelect = (value) => {
			showPrompt();
			onDone(value);
		};
		dialog.onCancel = () => {
			showPrompt();
			onDone(undefined);
		};
		showDialog(dialog);
	}

	function showInputDialog(title: string, prefill?: string, onDone?: (value: string | undefined) => void): void {
		const dialog = new InputDialog(title, prefill);
		dialog.onSubmit = (value) => {
			showPrompt();
			onDone?.(value.trim() || undefined);
		};
		dialog.onEscape = () => {
			showPrompt();
			onDone?.(undefined);
		};
		dialog.onCtrlD = exit;
		showDialog(dialog);
		tui.setFocus(dialog.inputComponent);
	}

	/** Answer a host request; the first answer of any client wins. */
	function answer(requestId: string, response: Record<string, unknown>): void {
		send({ type: "host_response", requestId, response });
	}

	function showHostRequest(requestId: string, request: HostRequest): void {
		switch (request.kind) {
			case "select":
				showSelectDialog(request.title, request.options, (value) => {
					answer(requestId, value !== undefined ? { value } : { cancelled: true });
				});
				break;
			case "confirm":
				showSelectDialog(`${request.title}: ${request.message}`, ["Yes", "No"], (value) => {
					answer(requestId, { confirmed: value === "Yes" });
				});
				break;
			case "input": {
				const title = request.placeholder ? `${request.title} (${request.placeholder})` : request.title;
				showInputDialog(title, undefined, (value) => {
					answer(requestId, value !== undefined ? { value } : { cancelled: true });
				});
				break;
			}
			case "editor":
				showInputDialog(request.title, request.prefill?.replace(/\n/g, " "), (value) => {
					answer(requestId, value !== undefined ? { value } : { cancelled: true });
				});
				break;
		}
	}

	/** One live item: streaming text and tools, the run phase, extension UI, notices. */
	function handleLiveItem(item: LiveItem): void {
		if (item.type === "assistant_delta" && item.event?.type === "text_delta") {
			if (!hasTextOutput) {
				hasTextOutput = true;
				outputLog.append("");
				outputLog.append(`${BLUE}${BOLD}Agent:${RESET}`);
			}
			const parts = (item.event.delta ?? "").split("\n");
			for (let i = 0; i < parts.length; i++) {
				if (i > 0) outputLog.append("");
				if (parts[i]) outputLog.appendRaw(parts[i]);
			}
			return;
		}
		if (item.type === "tool" && item.op === "start") {
			outputLog.append(`${DIM}[tool: ${item.toolName}]${RESET}`);
			return;
		}
		if (item.type === "notice") {
			const color = item.level === "error" ? RED : item.level === "warning" ? YELLOW : MAGENTA;
			outputLog.append(`${color}${BOLD}Notification:${RESET} ${item.message}`);
			return;
		}
		if (item.type === "directive" && item.directive === "set_editor_text") {
			promptInput.input.setValue(item.text ?? "");
			return;
		}
		if (item.type === "clear" && item.key?.startsWith("ext_status/")) {
			outputLog.append(
				`${MAGENTA}${BOLD}Notification:${RESET} ${DIM}[status: ${item.key.slice(11)}]${RESET} (cleared)`,
			);
			return;
		}
		if (item.type !== "set" || !item.key || !item.value) return;
		const value = item.value;
		switch (value.kind) {
			case "phase":
				if (value.busy === true) showLoading();
				else if (isStreaming) {
					isStreaming = false;
					hideLoading();
					outputLog.append("");
				}
				return;
			case "host_request":
				showHostRequest(value.requestId as string, value.request as HostRequest);
				return;
			case "ext_status":
				outputLog.append(
					`${MAGENTA}${BOLD}Notification:${RESET} ${DIM}[status: ${item.key.slice(11)}]${RESET} ${value.text}`,
				);
				return;
			case "ext_widget":
				outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} ${DIM}[widget: ${item.key.slice(11)}]${RESET}`);
				for (const line of value.lines as string[]) outputLog.append(`  ${DIM}${line}${RESET}`);
				return;
			default:
				return;
		}
	}

	// -- Slash commands (local, not sent to agent) --

	function handleSlashCommand(cmd: string): boolean {
		switch (cmd) {
			case "/select":
				showSelectDialog("Pick a color", ["Red", "Green", "Blue", "Yellow"], (value) => {
					if (value) {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} You picked: ${value}`);
					} else {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Selection cancelled`);
					}
					tui.requestRender();
				});
				return true;

			case "/confirm":
				showSelectDialog("Are you sure?", ["Yes", "No"], (value) => {
					const confirmed = value === "Yes";
					outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Confirmed: ${confirmed}`);
					tui.requestRender();
				});
				return true;

			case "/input":
				showInputDialog("Enter your name", undefined, (value) => {
					if (value) {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} You entered: ${value}`);
					} else {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Input cancelled`);
					}
					tui.requestRender();
				});
				return true;

			case "/editor":
				showInputDialog("Edit text", "Hello, world!", (value) => {
					if (value) {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Submitted: ${value}`);
					} else {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Editor cancelled`);
					}
					tui.requestRender();
				});
				return true;

			default:
				return false;
		}
	}

	// -- Process agent stdout: protocol frames --

	const stdoutRl = readline.createInterface({ input: agent.stdout!, terminal: false });

	stdoutRl.on("line", (line) => {
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(line);
		} catch {
			return;
		}

		switch (frame.type) {
			case "welcome":
				// Subscribe to the conversation the host attached this client to.
				send({ type: "subscribe", subscriptionId: "main", conversation: frame.conversation, after: "snapshot" });
				return;
			case "live":
				for (const item of frame.items as LiveItem[]) handleLiveItem(item);
				tui.requestRender();
				return;
			case "rejected":
				outputLog.append(`${RED}[rejected]${RESET} ${(frame.reason as { message: string }).message}`);
				tui.requestRender();
				return;
			case "fatal":
				outputLog.append(`${RED}[fatal]${RESET} ${frame.code}`);
				tui.requestRender();
				return;
			default:
				return;
		}
	});

	// Say hello: this client answers dialogs.
	send({
		type: "hello",
		protocol: 1,
		client: { name: "rpc-extension-ui-example", version: "1" },
		accepts: { hostRequests: ["select", "confirm", "input", "editor"] },
	});

	// -- User input --

	promptInput.input.onSubmit = (value) => {
		const trimmed = value.trim();
		if (!trimmed) return;

		promptInput.input.setValue("");

		if (handleSlashCommand(trimmed)) {
			outputLog.append(`${GREEN}${BOLD}You:${RESET} ${trimmed}`);
			tui.requestRender();
			return;
		}

		outputLog.append(`${GREEN}${BOLD}You:${RESET} ${trimmed}`);
		// A prompt's intent id is its durable client message id.
		send({ type: "prompt", intentId: randomUUID(), input: { message: trimmed } });
		tui.requestRender();
	};

	promptInput.onCtrlD = exit;

	promptInput.input.onEscape = () => {
		if (isStreaming) {
			send({ type: "abort", intentId: randomUUID() });
			outputLog.append(`${YELLOW}[aborted]${RESET}`);
			tui.requestRender();
		} else {
			exit();
		}
	};

	// -- Agent exit --

	agent.on("exit", (code) => {
		tui.stop();
		if (stderr) console.error(stderr);
		console.log(`Agent exited with code ${code}`);
		process.exit(code ?? 0);
	});

	// -- Start --

	outputLog.append(`${BOLD}RPC Chat${RESET}`);
	outputLog.append(`${DIM}Type a message and press Enter. Esc to abort or exit. Ctrl+D to quit.${RESET}`);
	outputLog.append(`${DIM}Slash commands: /select /confirm /input /editor${RESET}`);
	outputLog.append("");

	tui.start();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
