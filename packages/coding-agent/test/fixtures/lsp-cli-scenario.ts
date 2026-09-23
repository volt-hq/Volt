import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	type JsonObject,
	registerFauxProvider,
	type ToolResultMessage,
} from "@hansjm10/volt-ai";

export const LSP_CLI_SCENARIOS = [
	"deltas",
	"unversioned",
	"stale-only",
	"no-publication",
	"global-disabled",
	"server-disabled",
	"server-enabled",
	"swift-loose",
	"swift-swiftpm",
	"swift-build-server",
] as const;
export type LspCliScenario = (typeof LSP_CLI_SCENARIOS)[number];

interface Step {
	id: string;
	name: "write" | "edit" | "lsp";
	args: JsonObject;
	diskAfter?: string;
}

interface Evidence {
	operationId: string;
	trigger: string;
	action: string;
	outcome: string;
	reason: string;
	freshness: string;
	source: string;
	diagnosticCount: number;
	resultCount: number;
	projectContext?: string;
}
interface ToolEnd {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	isError: boolean;
	result: { content: ToolResultMessage["content"]; details: { lsp: Evidence; diagnostics?: string } };
}
interface WireEvent {
	type: string;
	id?: string;
	message?: { role: string; content: ToolResultMessage["content"]; stopReason?: string };
}
interface RequestSnapshot {
	type: "request";
	index: number;
	tools: string[];
	toolResults: ToolResultMessage<{ lsp: Evidence }>[];
	disk: string | null;
	serverStarted: boolean;
	envKeys: string[];
}
interface ServerEvent {
	type: string;
	pid?: number;
	code?: number;
	cwd?: string;
	argv?: string[];
	envKeys?: string[];
	message?: {
		method?: string;
		params?: {
			version?: number;
			diagnostics?: { message: string }[];
			textDocument?: { uri: string; version?: number; text?: string };
			contentChanges?: { text: string }[];
		};
	};
}
export interface LspCliReport {
	scenario: LspCliScenario;
	root: string;
	workspace: string;
	steps: Step[];
	events: WireEvent[];
	toolEnds: ToolEnd[];
	requests: RequestSnapshot[];
	serverEvents: ServerEvent[];
	persisted: ToolResultMessage<{ lsp: Evidence }>[];
	finalDisk: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
	cleanup: { tempRemoved: boolean; childClosed: boolean; serversExited: boolean };
}

const runner = fileURLToPath(new URL("../lsp-cli-runner.mjs", import.meta.url));
const fakeServer = fileURLToPath(new URL("./fake-lsp-server.mjs", import.meta.url));
const CHILD_DEADLINE_MS = 45_000;
const CLEANUP_DEADLINE_MS = 2_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TERMINAL_RESPONSE = "Synthetic LSP CLI scenario complete.";

function scenarioDefinition(scenario: LspCliScenario): { path: string; steps: Step[]; serverArgs: string[] } {
	const path = scenario.startsWith("swift-") ? "Sample.swift" : "sample.ts";
	const first = "const value = ERROR;\n// note: before\n";
	const unchanged = "const value = ERROR;\n// note: after\n";
	const steps: Step[] = [
		{ id: "status-before", name: "lsp", args: { action: "status", path } },
		{ id: "first", name: "write", args: { path, content: first }, diskAfter: first },
		{
			id: "unchanged",
			name: "edit",
			args: { path, edits: [{ oldText: "note: before", newText: "note: after" }] },
			diskAfter: unchanged,
		},
	];
	if (scenario === "deltas" || scenario === "unversioned") {
		const changed = "const value = 1;\n// ERROR changed\n// WARN new\n";
		const clean = "const value = 1;\n// fixed\n// quiet\n";
		const recurrence = "const value = ERROR;\n// fixed\n// quiet\n";
		steps.push(
			{ id: "explicit-unchanged", name: "lsp", args: { action: "diagnostics", path } },
			{
				id: "changed",
				name: "edit",
				args: { path, edits: [{ oldText: unchanged, newText: changed }] },
				diskAfter: changed,
			},
			{
				id: "clean",
				name: "edit",
				args: { path, edits: [{ oldText: "// ERROR changed\n// WARN new", newText: "// fixed\n// quiet" }] },
				diskAfter: clean,
			},
			{
				id: "recurrence",
				name: "edit",
				args: { path, edits: [{ oldText: "const value = 1;", newText: "const value = ERROR;" }] },
				diskAfter: recurrence,
			},
		);
	}
	if (scenario === "stale-only" || scenario === "no-publication") {
		steps.push({
			id: "timeout-again",
			name: "edit",
			args: { path, edits: [{ oldText: "note: after", newText: "note: final" }] },
			diskAfter: "const value = ERROR;\n// note: final\n",
		});
	}
	steps.push(
		{ id: "explicit", name: "lsp", args: { action: "diagnostics", path } },
		{ id: "explicit-again", name: "lsp", args: { action: "diagnostics", path } },
		{ id: "hover", name: "lsp", args: { action: "hover", path, symbol: "value", line: 1 } },
		{ id: "status-after", name: "lsp", args: { action: "status", path } },
	);
	return {
		path,
		steps,
		serverArgs:
			scenario === "unversioned"
				? ["--no-version"]
				: scenario === "stale-only"
					? ["--stale-only"]
					: scenario === "no-publication"
						? ["--no-publish"]
						: [],
	};
}

/** Positive allowlist: credentials, NODE_OPTIONS, proxies, MCP paths and daemon state are never inherited. */
function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
	return {
		PATH: dirname(process.execPath),
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
		APPDATA: join(root, "home", "appdata"),
		LOCALAPPDATA: join(root, "home", "localappdata"),
		XDG_CONFIG_HOME: join(root, "home", "config"),
		XDG_CACHE_HOME: join(root, "home", "cache"),
		XDG_DATA_HOME: join(root, "home", "data"),
		TMPDIR: join(root, "tmp"),
		TMP: join(root, "tmp"),
		TEMP: join(root, "tmp"),
		LANG: "C.UTF-8",
		TERM: "dumb",
		NO_COLOR: "1",
		VOLT_CODING_AGENT_DIR: join(root, "agent"),
		VOLT_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
		VOLT_OFFLINE: "1",
		VOLT_SKIP_VERSION_CHECK: "1",
		VOLT_TELEMETRY: "0",
		...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, PATHEXT: ".COM;.EXE;.BAT;.CMD" } : {}),
	};
}

/** Called only in the isolated child before importing production src/cli.ts. */
export function prepareLspCliChild(scenario: LspCliScenario, root: string): void {
	assert.ok(LSP_CLI_SCENARIOS.includes(scenario), `Unknown scenario: ${scenario}`);
	const definition = scenarioDefinition(scenario);
	const faux = registerFauxProvider({ api: "faux-lsp-cli", provider: "faux-lsp-cli" });
	const capture = (context: Context, index: number): void => {
		const path = join(root, "workspace", definition.path);
		const snapshot: RequestSnapshot = {
			type: "request",
			index,
			tools: context.tools?.map((tool) => tool.name) ?? [],
			toolResults: context.messages.filter(
				(message) => message.role === "toolResult",
			) as RequestSnapshot["toolResults"],
			disk: existsSync(path) ? readFileSync(path, "utf8") : null,
			serverStarted: existsSync(join(root, "server.jsonl")),
			envKeys: Object.keys(process.env),
		};
		appendFileSync(join(root, "requests.jsonl"), `${JSON.stringify(snapshot)}\n`);
	};
	faux.setResponses([
		...definition.steps.map((step, index) => (context: Context) => {
			capture(context, index);
			return fauxAssistantMessage(fauxToolCall(step.name, step.args, { id: step.id }), { stopReason: "toolUse" });
		}),
		(context: Context) => {
			capture(context, definition.steps.length);
			return fauxAssistantMessage(TERMINAL_RESPONSE);
		},
	]);
	writeFileSync(
		join(root, "agent", "models.json"),
		JSON.stringify({
			providers: {
				"faux-lsp-cli": {
					api: faux.api,
					apiKey: "synthetic-only",
					baseUrl: "http://localhost:0",
					models: faux.models,
				},
			},
		}),
	);
	process.argv = [
		process.execPath,
		fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
		"--mode",
		"json",
		"--offline",
		"--no-approve",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--tools",
		"write,edit,lsp",
		"--model",
		"faux-lsp-cli/faux-1",
		"--thinking",
		"off",
		"--session-dir",
		join(root, "sessions"),
		"--name",
		`lsp-cli-${scenario}`,
		"Run the synthetic LSP acceptance scenario and finish.",
	];
}

function readJsonLines<T>(path: string): T[] {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as T)
		: [];
}

function killOwnedTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				timeout: CLEANUP_DEADLINE_MS,
			});
		} else {
			process.kill(-child.pid, signal);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

/** Real CLI process, filesystem, stdio LSP, JSON projection, and SQLite persistence. */
export async function runLspCliScenario(scenario: LspCliScenario, signal?: AbortSignal): Promise<LspCliReport> {
	assert.ok(LSP_CLI_SCENARIOS.includes(scenario), `Unknown scenario: ${scenario}`);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-lsp-cli-")));
	const workspace = join(root, "workspace");
	let child: ChildProcess | undefined;
	let closed = false;
	let deadline: NodeJS.Timeout | undefined;
	let forceKill: NodeJS.Timeout | undefined;
	let abort: (() => void) | undefined;
	let report: LspCliReport | undefined;
	try {
		for (const folder of ["workspace", "agent", "home", "sessions", "tmp"]) mkdirSync(join(root, folder));
		const definition = scenarioDefinition(scenario);
		const serverName = scenario.startsWith("swift-") ? "swift" : "typescript";
		writeFileSync(
			join(root, "agent", "settings.json"),
			JSON.stringify({
				defaultProjectTrust: "never",
				enableInstallTelemetry: false,
				compaction: { enabled: false },
				retry: { enabled: false },
				lsp: {
					enabled: true,
					...(scenario === "global-disabled" || scenario === "server-enabled" ? { autoDiagnostics: false } : {}),
					settleMs: 500,
					firstSettleMs: 2000,
					idleShutdownMs: 0,
					severity: "warning",
					servers: {
						[serverName]: {
							command: [
								process.execPath,
								fakeServer,
								"--delay",
								"0",
								"--event-log",
								join(root, "server.jsonl"),
								...definition.serverArgs,
							],
							...(scenario === "server-disabled" ? { autoDiagnostics: false } : {}),
							...(scenario === "server-enabled" ? { autoDiagnostics: true } : {}),
						},
					},
				},
			}),
		);
		if (scenario === "swift-swiftpm" || scenario === "swift-build-server") {
			writeFileSync(join(workspace, "Package.swift"), "// Context marker only; this fixture never invokes Swift.\n");
		}
		if (scenario === "swift-build-server") writeFileSync(join(workspace, "buildServer.json"), "{}\n");
		child = spawn(process.execPath, [runner, "--child", scenario, root], {
			cwd: workspace,
			env: isolatedEnvironment(root),
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const ownedChild = child;
		let stdout = "";
		let stderr = "";
		let failure: Error | undefined;
		const terminate = (reason: string): void => {
			if (failure) return;
			failure = new Error(reason);
			killOwnedTree(ownedChild, "SIGTERM");
			forceKill = setTimeout(() => killOwnedTree(ownedChild, "SIGKILL"), CLEANUP_DEADLINE_MS);
		};
		ownedChild.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			const remaining = Math.max(0, MAX_OUTPUT_BYTES - stdout.length - stderr.length);
			stdout += chunk.slice(0, remaining);
			if (chunk.length > remaining) terminate("CLI output exceeded fixture limit");
		});
		ownedChild.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			const remaining = Math.max(0, MAX_OUTPUT_BYTES - stdout.length - stderr.length);
			stderr += chunk.slice(0, remaining);
			if (chunk.length > remaining) terminate("CLI output exceeded fixture limit");
		});
		const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			ownedChild.once("error", reject);
			ownedChild.once("close", (code, exitSignal) => {
				closed = true;
				resolve({ code, signal: exitSignal });
			});
		});
		deadline = setTimeout(() => terminate(`CLI exceeded ${CHILD_DEADLINE_MS}ms deadline`), CHILD_DEADLINE_MS);
		abort = () => terminate("CLI fixture cancelled");
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const exit = await completion;
		if (failure) {
			const acknowledgements = {
				modelsWritten: existsSync(join(root, "agent", "models.json")),
				providerRequests: readJsonLines<RequestSnapshot>(join(root, "requests.jsonl")).length,
				serverEvents: readJsonLines<ServerEvent>(join(root, "server.jsonl")).length,
			};
			throw new Error(
				`${failure.message}; acknowledgements ${JSON.stringify(acknowledgements)}\n${stderr}\n${stdout.slice(-4000)}`,
			);
		}
		assert.equal(exit.code, 0, `CLI failed (signal ${exit.signal}):\n${stderr}\n${stdout.slice(-4000)}`);
		const events = stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as WireEvent);
		const storePath = join(root, "sessions", "sessions.sqlite");
		assert.ok(existsSync(storePath), `CLI did not persist its session:\n${stderr}`);
		const store = new DatabaseSync(storePath, { readOnly: true });
		let persisted: LspCliReport["persisted"];
		try {
			persisted = store
				.prepare("SELECT payload_json FROM entries WHERE entry_type = 'message' ORDER BY ordinal")
				.all()
				.map((row) => JSON.parse(String(row.payload_json)) as { message: ToolResultMessage<{ lsp: Evidence }> })
				.map((entry) => entry.message)
				.filter((message) => message.role === "toolResult");
		} finally {
			store.close();
		}
		const serverEvents = readJsonLines<ServerEvent>(join(root, "server.jsonl"));
		const started = serverEvents.filter((event) => event.type === "started");
		report = {
			scenario,
			root,
			workspace,
			steps: definition.steps,
			events,
			toolEnds: events.filter((event) => event.type === "tool_execution_end") as unknown as ToolEnd[],
			requests: readJsonLines<RequestSnapshot>(join(root, "requests.jsonl")),
			serverEvents,
			persisted,
			finalDisk: readFileSync(join(workspace, definition.path), "utf8"),
			exitCode: exit.code,
			signal: exit.signal,
			stderr,
			cleanup: {
				tempRemoved: false,
				childClosed: closed,
				serversExited:
					started.length > 0 &&
					started.every((entry) =>
						serverEvents.some((event) => event.type === "exited" && event.pid === entry.pid),
					),
			},
		};
		return report;
	} finally {
		if (deadline) clearTimeout(deadline);
		if (forceKill) clearTimeout(forceKill);
		if (abort) signal?.removeEventListener("abort", abort);
		// The dedicated group also owns the fake server if startup or teardown failed.
		try {
			if (child) killOwnedTree(child, "SIGKILL");
		} finally {
			rmSync(root, { recursive: true, force: true });
			if (report) report.cleanup.tempRemoved = !existsSync(root);
		}
	}
}

export function toolResultText(result: { content: ToolResultMessage["content"] }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Shared assertions: the standalone command is an acceptance check, not just an event dump. */
export function assertLspCliScenario(report: LspCliReport): void {
	const { scenario, steps, requests, toolEnds, persisted, serverEvents } = report;
	const result = (id: string): ToolEnd => {
		const found = toolEnds.find((event) => event.toolCallId === id);
		assert.ok(found, `Missing tool_execution_end for ${id}`);
		return found;
	};
	const text = (id: string): string => toolResultText(result(id).result);
	const evidence = (id: string): Evidence => result(id).result.details.lsp;
	assert.equal(report.exitCode, 0);
	assert.equal(report.signal, null);
	assert.deepEqual(report.cleanup, { tempRemoved: true, childClosed: true, serversExited: true });
	assert.equal(existsSync(report.root), false);
	assert.equal(report.events[0].type, "session");
	assert.equal(report.events.filter((event) => event.type === "agent_settled").length, 1);
	assert.ok(
		report.events.some(
			(event) =>
				event.type === "message_end" &&
				event.message?.role === "assistant" &&
				event.message.stopReason === "stop" &&
				toolResultText(event.message) === TERMINAL_RESPONSE,
		),
	);
	assert.deepEqual(
		toolEnds.map((event) => event.toolCallId),
		steps.map((step) => step.id),
	);
	assert.equal(requests.length, steps.length + 1);
	assert.equal(persisted.length, steps.length);
	assert.equal(requests[0].disk, null);
	assert.equal(requests[1].serverStarted, false, "status must not start a language server");
	// CoreFoundation may add its text-encoding marker after launch on macOS.
	// libuv copies its required Windows variables into every custom child environment (src/win/process.c).
	const allowedEnvironment = new Set([
		...Object.keys(isolatedEnvironment(report.root)),
		"VOLT_CODING_AGENT",
		"__CF_USER_TEXT_ENCODING",
		...(process.platform === "win32"
			? ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME", "WINDIR"]
			: []),
	]);
	for (const request of requests) {
		assert.deepEqual([...request.tools].sort(), ["edit", "lsp", "write"]);
		assert.deepEqual(
			request.envKeys.filter((key) => !allowedEnvironment.has(key)),
			[],
			"child inherited unrelated environment",
		);
	}
	for (const [index, step] of steps.entries()) {
		const actual = result(step.id);
		const metadata = evidence(step.id);
		assert.ok(metadata.operationId, `${step.id} has structured LSP evidence`);
		assert.equal(metadata.trigger, step.name === "lsp" ? "explicit" : step.name);
		assert.equal(metadata.action, step.name === "lsp" ? step.args.action : "diagnostics");
		const next = requests[index + 1].toolResults.find((message) => message.toolCallId === step.id);
		assert.ok(next, `${step.id} reaches the next model request`);
		assert.deepEqual(next.content, actual.result.content, `${step.id} model-visible content`);
		assert.equal(next.isError, actual.isError, `${step.id} model-visible isError`);
		const stored = persisted.find((message) => message.toolCallId === step.id);
		assert.ok(stored, `${step.id} persists`);
		assert.deepEqual(stored.content, actual.result.content);
		assert.deepEqual(stored.details?.lsp, metadata, `${step.id} persisted evidence survives text suppression`);
		assert.equal(stored.isError, actual.isError);
		if (step.diskAfter !== undefined) {
			assert.equal(requests[index + 1].disk, step.diskAfter, `${step.id} changed the actual disk`);
			assert.equal(actual.isError, false, `${step.id} successful mutation is not an LSP failure`);
		}
	}
	assert.equal(new Set(toolEnds.map((event) => event.result.details.lsp.operationId)).size, steps.length);
	assert.equal(report.finalDisk, steps.filter((step) => step.diskAfter !== undefined).at(-1)?.diskAfter);
	const started = serverEvents.filter((event) => event.type === "started");
	assert.equal(started.length, 1, "one runtime-owned server");
	assert.equal(started[0].cwd, report.workspace);
	assert.equal(started[0].argv?.includes("--event-log"), true);
	assert.deepEqual(
		started[0].envKeys?.filter((key) => !allowedEnvironment.has(key)),
		[],
	);
	assert.ok(serverEvents.some((event) => event.type === "received" && event.message?.method === "initialize"));
	assert.ok(
		serverEvents.some((event) => event.type === "received" && event.message?.method === "textDocument/didOpen"),
	);
	assert.ok(serverEvents.some((event) => event.type === "received" && event.message?.method === "textDocument/hover"));
	assert.equal(result("hover").isError, false);
	assert.match(text("hover"), /fake hover text/);
	assert.equal(evidence("hover").outcome, "success");
	assert.match(text("status-after"), /ready/);

	if (scenario === "global-disabled" || scenario === "server-disabled") {
		for (const id of ["first", "unchanged"]) {
			assert.equal(evidence(id).outcome, "skipped");
			assert.equal(evidence(id).reason, "auto-diagnostics-disabled");
			assert.equal(evidence(id).freshness, "unknown");
			assert.equal(evidence(id).source, "none");
			assert.equal(evidence(id).diagnosticCount, 0);
			assert.equal(result(id).result.details.diagnostics, undefined);
			assert.doesNotMatch(text(id), /Diagnostics:|auto-diagnostics-disabled|found ERROR/);
		}
		assert.equal(requests[3].serverStarted, false, "disabled automatic checks must not launch the server");
	}
	if (scenario === "stale-only" || scenario === "no-publication") {
		for (const id of ["unchanged", "timeout-again", "explicit", "explicit-again"]) {
			assert.equal(evidence(id).outcome, "timeout");
			assert.equal(evidence(id).reason, "no-current-publication");
			assert.ok(["unknown", "stale"].includes(evidence(id).freshness));
			assert.equal(evidence(id).diagnosticCount, 0);
			assert.doesNotMatch(text(id), /stale result from previous version|No diagnostics in|no longer reported/i);
		}
		assert.equal(result("explicit").isError, true);
		assert.equal(result("explicit-again").isError, true);
		assert.equal(
			result("timeout-again").result.details.diagnostics,
			undefined,
			"repeated timeout text is suppressed, evidence is not",
		);
		const publications = serverEvents.filter(
			(event) => event.type === "sent" && event.message?.method === "textDocument/publishDiagnostics",
		);
		if (scenario === "stale-only") {
			assert.equal(evidence("first").freshness, "fresh");
			const changes = serverEvents.filter(
				(event) => event.type === "received" && event.message?.method === "textDocument/didChange",
			);
			assert.equal(changes.length, 2);
			for (const change of changes)
				assert.ok(
					publications.some(
						(event) =>
							event.message?.params?.version === (change.message?.params?.textDocument?.version ?? 0) - 1 &&
							event.message?.params?.diagnostics?.[0]?.message === "stale result from previous version",
					),
					"server acknowledged old-version publication",
				);
		} else {
			assert.equal(publications.length, 0);
			assert.equal(evidence("first").outcome, "timeout");
		}
		return;
	}

	for (const id of ["explicit", "explicit-again"]) {
		assert.equal(result(id).isError, false);
		assert.equal(evidence(id).outcome, "success");
		assert.equal(evidence(id).diagnosticCount, 1);
		assert.match(text(id), /found ERROR on line 1/);
	}
	if (scenario === "deltas" || scenario === "unversioned" || scenario === "server-enabled") {
		const freshness = scenario === "unversioned" ? "unverified" : "fresh";
		assert.equal(evidence("first").freshness, freshness);
		assert.equal(evidence("unchanged").freshness, freshness);
		assert.equal(evidence("unchanged").diagnosticCount, 1);
		assert.equal(evidence("unchanged").resultCount, evidence("first").resultCount);
		assert.equal(evidence("unchanged").outcome, "success");
		assert.match(text("first"), /found ERROR on line 1/);
		assert.equal(result("unchanged").result.details.diagnostics, undefined);
		assert.doesNotMatch(text("unchanged"), /found ERROR|Diagnostics:/);
		assert.match(
			text("first"),
			scenario === "unversioned"
				? /(?:unverified[^\n]*\nsample\.ts|sample\.ts[^\n]*unverified)/i
				: /(?:fresh[^\n]*\nsample\.ts|sample\.ts[^\n]*fresh)/i,
		);
	}
	if (scenario === "deltas" || scenario === "unversioned") {
		assert.match(text("explicit-unchanged"), /found ERROR on line 1/);
		assert.equal(evidence("changed").diagnosticCount, 2);
		assert.match(text("changed"), /found ERROR on line 2/);
		assert.match(text("changed"), /found WARN on line 3/);
		assert.doesNotMatch(text("changed"), /found ERROR on line 1/);
		assert.equal(evidence("clean").diagnosticCount, 0);
		assert.equal(evidence("clean").outcome, "empty");
		if (scenario === "deltas") assert.match(text("clean"), /no longer reported/i);
		else assert.doesNotMatch(text("clean"), /no longer reported/i);
		assert.equal(evidence("recurrence").diagnosticCount, 1);
		assert.match(text("recurrence"), /found ERROR on line 1/);
	}
	if (scenario.startsWith("swift-")) {
		const expected =
			scenario === "swift-build-server"
				? "build-server-detected"
				: scenario === "swift-swiftpm"
					? "swiftpm-detected"
					: "not-detected";
		for (const id of ["first", "unchanged", "explicit", "hover", "status-after"])
			assert.equal(evidence(id).projectContext, expected, `${id} carries Swift coverage context`);
		assert.match(text("status-after"), new RegExp(expected));
		if (scenario === "swift-loose") assert.match(text("first"), /limited|context|build.server/i);
	}
}
