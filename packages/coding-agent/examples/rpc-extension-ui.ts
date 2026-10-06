/**
 * RPC Extension UI Example
 *
 * A line-based chat client that spawns the agent in RPC mode. Demonstrates
 * how to build a client on the RPC protocol's frames: hello, a snapshot
 * subscription, the live lane (streaming text, tools, the run phase,
 * extension status, panels, and title), prompt intents, and answering the
 * host requests extensions ask (select, confirm, input, editor, dialog, form,
 * and editor_text). Extension UI arrives as data: styled text and `UiNode`
 * trees, which this client prints as plain lines.
 *
 * Usage: npx tsx examples/rpc-extension-ui.ts
 *
 * Try the rpc-demo extension's commands: /rpc-input, /rpc-editor, /rpc-dialog,
 * /rpc-form, /rpc-prefill, /rpc-editor-text. Type /quit or press Ctrl+D to exit.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
	applyUiPatch,
	type HostRequest,
	type HostResponse,
	type LiveItem,
	type LiveValue,
	type UiNode,
	type UiNodeFormField,
	type UiNodeStyledText,
	type UiTreeItem,
} from "@hansjm10/volt-protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Output
// ============================================================================

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Styled text as plain text: this client shows tokens as plain text. */
function plain(text: UiNodeStyledText | undefined): string {
	if (text === undefined) return "";
	return typeof text === "string" ? text : text.map((span) => span.text).join("");
}

/** A `UiNode` as indented plain lines. */
function nodeLines(node: UiNode, indent = ""): string[] {
	const lines = (text: string) => text.split("\n").map((line) => `${indent}${line}`);
	switch (node.type) {
		case "text":
			return lines(plain(node.text));
		case "markdown":
			return lines(node.markdown);
		case "code":
			return [...(node.title ? lines(plain(node.title)) : []), ...lines(node.code)];
		case "terminal":
			return [
				...(node.omittedLines ? lines(`… ${node.omittedLines} earlier lines`) : []),
				...node.lines.flatMap((line) => lines(plain(line))),
			];
		case "diff":
			return node.lines.flatMap((line) =>
				lines(`${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "} ${line.text}`),
			);
		case "list":
			return node.items.flatMap((item, index) => {
				const [first = "", ...rest] = nodeLines(item);
				return [
					`${indent}${node.ordered ? `${index + 1}.` : "-"} ${first}`,
					...rest.map((line) => `${indent}  ${line}`),
				];
			});
		case "keyValue":
			return node.items.flatMap((item) => lines(`${plain(item.label)}: ${plain(item.value)}`));
		case "table":
			return [
				lines(node.columns.map((column) => plain(column.header)).join(" | ")),
				...node.rows.map((row) => lines(row.cells.map(plain).join(" | "))),
			].flat();
		case "progress":
			return node.kind === "determinate"
				? lines(`${plain(node.label)} ${node.value}/${node.max ?? 1}`.trim())
				: node.steps.flatMap((step) => lines(`[${step.status}] ${plain(step.label)}`));
		case "card":
			return [
				...lines(`${plain(node.title)}${(node.badges ?? []).map((badge) => ` [${badge.label}]`).join("")}`),
				...(node.sections ?? []).flatMap((section) => [
					...(section.title ? lines(plain(section.title)) : []),
					...section.children.flatMap((child) => nodeLines(child, `${indent}  `)),
				]),
			];
		case "tree":
			return treeLines(node.items, indent);
		default:
			return lines(`(${node.type})`);
	}
}

function treeLines(items: readonly UiTreeItem[], indent: string): string[] {
	return items.flatMap((item) => [
		`${indent}- ${plain(item.label)}`,
		...treeLines(item.children ?? [], `${indent}  `),
	]);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	const extensionPath = join(__dirname, "extensions/rpc-demo.ts");
	const cliPath = join(__dirname, "../dist/cli.js");

	const agent = spawn(
		"node",
		[cliPath, "--mode", "rpc", "--no-session", "--no-extensions", "--extension", extensionPath],
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

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	rl.setPrompt(`${GREEN}${BOLD}You:${RESET} `);

	/** Print a line above the prompt, keeping what the user is typing. */
	function print(line: string): void {
		readline.clearLine(process.stdout, 0);
		readline.cursorTo(process.stdout, 0);
		console.log(line);
		rl.prompt(true);
	}

	function send(frame: Record<string, unknown>): void {
		agent.stdin!.write(`${JSON.stringify(frame)}\n`);
	}

	let exiting = false;
	function exit(): void {
		if (exiting) return;
		exiting = true;
		rl.close();
		agent.kill("SIGTERM");
		process.exit(0);
	}

	// -- Questions: while one is asked, the next line the user types answers it --

	let answerLine: ((line: string) => void) | undefined;
	let questions = Promise.resolve();
	/** Host requests a question is pending for, so a request answered elsewhere stops it. */
	const pending = new Map<string, () => void>();

	function ask(prompt: string): Promise<string> {
		print(`${MAGENTA}${BOLD}${prompt}${RESET}`);
		return new Promise((resolve) => {
			answerLine = resolve;
		});
	}

	async function choose(title: string, options: string[]): Promise<number | undefined> {
		const list = options.map((option, index) => `  ${index + 1}. ${option}`).join("\n");
		const answer = await ask(`${title}\n${list}\n${DIM}Number to choose, empty to cancel${RESET}`);
		const index = Number.parseInt(answer, 10) - 1;
		return index >= 0 && index < options.length ? index : undefined;
	}

	async function askField(field: UiNodeFormField): Promise<string | boolean | number | undefined> {
		const label = `${field.label}${field.description ? ` (${plain(field.description)})` : ""}`;
		switch (field.kind) {
			case "boolean":
				return (await ask(`${label} [y/N]`)).trim().toLowerCase() === "y";
			case "enum": {
				const index = await choose(
					label,
					field.options.map((option) => option.label ?? option.value),
				);
				return index === undefined ? undefined : field.options[index]?.value;
			}
			case "integer": {
				const value = Number.parseInt(await ask(label), 10);
				return Number.isSafeInteger(value) ? value : undefined;
			}
			default:
				return (await ask(label)) || undefined;
		}
	}

	async function answerRequest(request: HostRequest): Promise<HostResponse> {
		switch (request.kind) {
			case "select": {
				const index = await choose(request.title, request.options);
				return index === undefined ? { cancelled: true } : { value: request.options[index]! };
			}
			case "confirm":
				return {
					confirmed: (await ask(`${request.title}: ${request.message} [y/N]`)).trim().toLowerCase() === "y",
				};
			case "input":
			case "editor": {
				const hint = request.kind === "input" ? request.placeholder : request.prefill;
				const value = await ask(`${request.title}${hint ? ` (${hint.replace(/\n/g, " ")})` : ""}`);
				return value ? { value } : { cancelled: true };
			}
			case "dialog": {
				for (const line of request.body.flatMap((node) => nodeLines(node, "  "))) print(line);
				const index = await choose(
					request.title,
					request.actions.map((action) => action.label),
				);
				return index === undefined ? { cancelled: true } : { value: request.actions[index]!.id };
			}
			case "form": {
				print(`${MAGENTA}${BOLD}${request.title}${RESET}`);
				const values: Record<string, string | boolean | number> = {};
				for (const field of request.fields) {
					const value = await askField(field);
					if (value !== undefined) values[field.id] = value;
				}
				return { values };
			}
			default:
				return { cancelled: true };
		}
	}

	function showHostRequest(requestId: string, request: HostRequest): void {
		// The client's editor text: what the user has typed so far, without asking.
		if (request.kind === "editor_text") {
			send({ type: "host_response", requestId, response: { value: rl.line } });
			return;
		}
		questions = questions.then(async () => {
			let answered = false;
			const stop = new Promise<HostResponse | undefined>((resolve) =>
				pending.set(requestId, () => {
					answered = true;
					resolve(undefined);
				}),
			);
			const response = await Promise.race([answerRequest(request), stop]);
			pending.delete(requestId);
			answerLine = undefined;
			// The first answer of any client wins; this one is sent only if the request is still open.
			if (!answered && response) send({ type: "host_response", requestId, response });
		});
	}

	// -- Live lane --

	const panels = new Map<string, Extract<LiveValue, { kind: "ext_panel" }>>();
	let isStreaming = false;
	let hasTextOutput = false;
	let assistantLine = "";

	function showPanel(key: string): void {
		const panel = panels.get(key);
		if (!panel) return;
		print(`${MAGENTA}${BOLD}[panel ${key.slice("ext_panel/".length)}]${RESET} ${plain(panel.title)}`);
		for (const line of nodeLines(panel.node, "  ")) print(`${DIM}${line}${RESET}`);
	}

	function handleSet(key: string, value: LiveValue): void {
		switch (value.kind) {
			case "phase":
				if (value.busy && !isStreaming) {
					isStreaming = true;
					hasTextOutput = false;
					print(`${DIM}Agent: working...${RESET}`);
				} else if (!value.busy && isStreaming) {
					isStreaming = false;
					if (assistantLine) print(assistantLine);
					assistantLine = "";
				}
				return;
			case "host_request":
				showHostRequest(value.requestId, value.request);
				return;
			case "ext_status":
				print(`${MAGENTA}[status ${key.slice("ext_status/".length)}]${RESET} ${plain(value.text)}`);
				return;
			case "ext_panel":
				panels.set(key, value);
				showPanel(key);
				return;
			case "ext_title":
				print(`${MAGENTA}[title]${RESET} ${value.title}`);
				return;
			default:
				return;
		}
	}

	function handleLiveItem(item: LiveItem): void {
		switch (item.type) {
			case "assistant_delta": {
				if (item.event.type !== "text_delta") return;
				if (!hasTextOutput) {
					hasTextOutput = true;
					print(`${BLUE}${BOLD}Agent:${RESET}`);
				}
				const parts = `${assistantLine}${item.event.delta}`.split("\n");
				assistantLine = parts.pop() ?? "";
				for (const part of parts) print(part);
				return;
			}
			case "tool":
				if (item.op === "start") print(`${DIM}[tool: ${item.toolName}]${RESET}`);
				return;
			case "notice": {
				const color = item.level === "error" ? RED : item.level === "warning" ? YELLOW : MAGENTA;
				print(`${color}${BOLD}Notification:${RESET} ${plain(item.message)}`);
				return;
			}
			case "directive":
				// A terminal theme is the TUI's to show.
				if (item.directive === "set_theme") return;
				// set_editor_text replaces the line being typed (Ctrl+E, Ctrl+U), insert_editor_text types at the cursor
				if (item.directive === "set_editor_text") {
					rl.write(null, { ctrl: true, name: "e" });
					rl.write(null, { ctrl: true, name: "u" });
				}
				rl.write(item.text.replace(/\n/g, " "));
				return;
			case "set":
				handleSet(item.key, item.value);
				return;
			case "patch": {
				const panel = panels.get(item.key);
				if (!panel) return;
				const [node] = applyUiPatch([panel.node], item.ops);
				if (node) panels.set(item.key, { ...panel, node });
				showPanel(item.key);
				return;
			}
			case "clear":
				if (item.key.startsWith("host_request/")) pending.get(item.key.slice("host_request/".length))?.();
				if (item.key.startsWith("ext_status/")) print(`${MAGENTA}[status ${item.key.slice(11)}]${RESET} (cleared)`);
				if (panels.delete(item.key)) print(`${MAGENTA}[panel ${item.key.slice(10)}]${RESET} (removed)`);
				return;
			default:
				return;
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
				return;
			case "rejected":
				print(`${RED}[rejected]${RESET} ${(frame.reason as { message: string }).message}`);
				return;
			case "fatal":
				print(`${RED}[fatal]${RESET} ${frame.code}`);
				return;
			default:
				return;
		}
	});

	// Say hello: this client answers dialogs, forms, and editor text requests.
	send({
		type: "hello",
		protocol: 1,
		client: { name: "rpc-extension-ui-example", version: "1" },
		accepts: { hostRequests: ["select", "confirm", "input", "editor", "dialog", "form", "editor_text"] },
	});

	// -- User input --

	rl.on("line", (line) => {
		if (answerLine) {
			const answer = answerLine;
			answerLine = undefined;
			answer(line.trim());
			return;
		}
		const trimmed = line.trim();
		if (trimmed === "/quit") exit();
		if (trimmed) {
			// A prompt's intent id is its durable client message id.
			send({ type: "prompt", intentId: randomUUID(), input: { message: trimmed } });
		}
		rl.prompt();
	});

	// Ctrl+C aborts a run, or exits when idle; Ctrl+D exits.
	rl.on("SIGINT", () => {
		if (!isStreaming) exit();
		send({ type: "abort", intentId: randomUUID() });
		print(`${YELLOW}[aborted]${RESET}`);
	});
	rl.on("close", exit);

	agent.on("exit", (code) => {
		exiting = true;
		rl.close();
		if (stderr) console.error(stderr);
		console.log(`Agent exited with code ${code}`);
		process.exit(code ?? 0);
	});

	console.log(`${BOLD}RPC Chat${RESET}`);
	console.log(`${DIM}Type a message and press Enter. Ctrl+C aborts a run. /quit or Ctrl+D to exit.${RESET}`);
	console.log(`${DIM}Try /rpc-input, /rpc-editor, /rpc-dialog, /rpc-form, /rpc-prefill, /rpc-editor-text${RESET}`);
	rl.prompt();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
