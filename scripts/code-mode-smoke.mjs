#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PROVIDER = "volt-code-mode-smoke";
const MODEL = "smoke-model";
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Model-free smoke test of code mode in an installed Volt: runs `command ...args` in print mode against a local mock
 * OpenAI-compatible provider whose first response calls `run_code` with a TypeScript script that reads a file, and
 * whose second response, sent only when the tool result holds the script's status line and computed value, is a
 * unique token the run must print. It exercises TypeScript stripping, the code mode worker, the WebAssembly engine,
 * and a nested tool call as the install form ships them. Print mode runs in process, so no daemon starts.
 *
 * @param {string} command The Volt executable, or Node.js for a JavaScript entry point.
 * @param {string[]} [args] Arguments before Volt's own, such as the path of the JavaScript entry point.
 * @param {{ timeoutMs?: number, env?: Record<string, string> }} [options]
 */
export async function smokeCodeMode(command, args = [], options = {}) {
	const nonce = randomBytes(6).toString("hex");
	const probe = `probe-${nonce}`;
	const expected = `${[...probe].reverse().join("")}:${probe.length}`;
	const token = `CODE_MODE_SMOKE_OK_${nonce}`;
	const script = [
		'const text: string = await tools.read({ path: "probe.txt" });',
		"const probe = text.trim();",
		'return `${[...probe].reverse().join("")}:${probe.length}`;',
	].join("\n");

	const root = mkdtempSync(join(tmpdir(), "volt-code-mode-smoke-"));
	const agentDirectory = join(root, "agent");
	const workDirectory = join(root, "work");
	mkdirSync(agentDirectory);
	mkdirSync(workDirectory);
	writeFileSync(join(workDirectory, "probe.txt"), `${probe}\n`);

	let requests = 0;
	let failure;
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
				response.writeHead(404).end();
				return;
			}
			let payload;
			try {
				payload = JSON.parse(body);
			} catch {
				failure ??= "a provider request is not JSON";
				response.writeHead(400).end();
				return;
			}
			const messages = Array.isArray(payload.messages) ? payload.messages : [];
			const tools = Array.isArray(payload.tools) ? payload.tools : [];
			// Requests without tools, such as the session title, are not the conversation's turn.
			if (tools.length === 0) {
				streamResponse(response, { role: "assistant", content: "Code mode smoke" }, "stop");
				return;
			}
			requests += 1;
			const toolResult = messages.findLast((message) => message?.role === "tool");
			if (!toolResult) {
				if (!tools.some((tool) => tool?.function?.name === "run_code")) {
					failure ??= "the provider request does not offer run_code";
				}
				streamResponse(response, {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							index: 0,
							id: "call_code_mode_smoke",
							type: "function",
							function: { name: "run_code", arguments: JSON.stringify({ code: script, description: "smoke" }) },
						},
					],
				}, "tool_calls");
				return;
			}
			const text = contentText(toolResult.content);
			if (!/^Script completed in \S+ \(1 tool call\)\n/.test(text) || !text.includes(`Return value: ${expected}`)) {
				failure ??= `run_code returned an unexpected result:\n${text}`;
				streamResponse(response, { role: "assistant", content: "code mode smoke failed" }, "stop");
				return;
			}
			streamResponse(response, { role: "assistant", content: token }, "stop");
		});
	});

	try {
		const port = await listen(server);
		writeFileSync(
			join(agentDirectory, "models.json"),
			`${JSON.stringify(
				{
					providers: {
						[PROVIDER]: {
							baseUrl: `http://127.0.0.1:${port}/v1`,
							api: "openai-completions",
							apiKey: "volt-code-mode-smoke",
							compat: {
								supportsStore: false,
								supportsDeveloperRole: false,
								supportsReasoningEffort: false,
								supportsUsageInStreaming: false,
								supportsStrictMode: false,
							},
							models: [
								{
									id: MODEL,
									name: "Code mode smoke",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 128000,
									maxTokens: 4096,
								},
							],
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		// The run sees only this test's agent directory, whatever the caller's Volt environment holds.
		const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("VOLT_")));
		const result = await runProcess(
			command,
			[
				...args,
				"--offline",
				"--provider",
				PROVIDER,
				"--model",
				MODEL,
				"--tools",
				"read,run_code",
				"-p",
				"smoke",
			],
			{
				cwd: workDirectory,
				env: { ...env, ...options.env, VOLT_CODING_AGENT_DIR: agentDirectory, VOLT_OFFLINE: "1" },
				timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			},
		);
		const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
		if (failure) throw new Error(`Code mode smoke failed: ${failure}\n${output}`);
		if (result.code !== 0) throw new Error(`Code mode smoke exited with code ${result.code}\n${output}`);
		if (requests !== 2) throw new Error(`Code mode smoke made ${requests} provider requests, expected 2\n${output}`);
		if (!result.stdout.includes(token)) throw new Error(`Code mode smoke did not print its token\n${output}`);
	} finally {
		server.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function streamResponse(response, delta, finishReason) {
	const chunk = (choice) =>
		`data: ${JSON.stringify({
			id: "chatcmpl-code-mode-smoke",
			object: "chat.completion.chunk",
			created: 0,
			model: MODEL,
			choices: [choice],
		})}\n\n`;
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	response.write(chunk({ index: 0, delta, finish_reason: null }));
	response.write(chunk({ index: 0, delta: {}, finish_reason: finishReason }));
	response.end("data: [DONE]\n\n");
}

function listen(server) {
	return new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolveListen(server.address().port);
		});
	});
}

function runProcess(command, args, options) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Code mode smoke timed out after ${options.timeoutMs} ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, options.timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolveRun({ code, stdout, stderr });
		});
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	const [command, ...args] = process.argv.slice(2);
	if (!command) {
		console.error("Usage: node scripts/code-mode-smoke.mjs <volt executable or node> [entry point]");
		process.exitCode = 2;
	} else {
		smokeCodeMode(command, args).then(
			() => console.log("Code mode smoke passed"),
			(error) => {
				console.error(error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
			},
		);
	}
}
