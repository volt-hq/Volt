import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LspClient } from "../src/core/lsp/client.ts";
import { resolveLspConfig } from "../src/core/lsp/config.ts";
import { withManagedLspObservation } from "../src/core/lsp/managed-observation.ts";
import { LspManager } from "../src/core/lsp/manager.ts";
import { lspResult } from "../src/core/lsp/outcome.ts";
import * as workspaceEdit from "../src/core/lsp/workspace-edit-applier.ts";
import { createLspTool, type LspNavigationProvider, type LspToolInput } from "../src/core/tools/lsp.ts";
import * as subprocess from "../src/utils/child-process.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-lsp-server.mjs", import.meta.url));
const roots: string[] = [];
const managers: LspManager[] = [];
const range = { start: { line: 0, character: 2 }, end: { line: 1, character: 4 } };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function fixture(args: string[] = []) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-managed-lsp-")));
	roots.push(root);
	const path = join(root, "test.foo");
	writeFileSync(path, "symbol\n  symbol\n");
	const manager = new LspManager({
		cwd: root,
		config: resolveLspConfig({
			idleShutdownMs: 0,
			servers: { fake: { command: [process.execPath, fake, ...args], fileExtensions: [".foo"], rootMarkers: [] } },
		}),
	});
	managers.push(manager);
	const tool = createLspTool(root, { provider: manager });
	const execute = (input: LspToolInput, signal?: AbortSignal) => tool.execute("test", input, signal);
	const managed = (input: LspToolInput, signal?: AbortSignal) =>
		withManagedLspObservation(() => execute(input, signal));
	return { root, path, manager, execute, managed };
}

function customProvider(documentSymbols: LspNavigationProvider["documentSymbols"]): LspNavigationProvider {
	const unavailable = async () => lspResult("unavailable", "Not implemented by fixture");
	return {
		documentSymbols,
		status: unavailable,
		definition: unavailable,
		references: unavailable,
		implementations: unavailable,
		typeDefinition: unavailable,
		hover: unavailable,
		workspaceSymbols: unavailable,
		callHierarchy: unavailable,
		fileDiagnostics: unavailable,
		rename: unavailable,
		codeFix: unavailable,
	};
}

interface Message {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

/** Deterministic duplex fixture: requests stay pending until the test replies. */
function transport() {
	const events = new EventEmitter();
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const messages: Message[] = [];
	const waiters: Array<{ predicate: (message: Message) => boolean; resolve: (message: Message) => void }> = [];
	stdin.on("data", (data: Buffer) => {
		const message = JSON.parse(data.toString().split("\r\n\r\n")[1]) as Message;
		messages.push(message);
		for (const waiter of [...waiters]) {
			if (waiter.predicate(message)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(message);
			}
		}
	});
	Object.assign(events, {
		stdin,
		stdout,
		stderr,
		pid: undefined,
		exitCode: null,
		signalCode: null,
		kill: () => {
			stderr.end();
			events.emit("exit", 0, null);
			events.emit("close", 0, null);
			return true;
		},
	});
	vi.spyOn(subprocess, "spawnProcess").mockReturnValue(events as unknown as ChildProcess);
	const send = (message: Message) => {
		const body = JSON.stringify({ jsonrpc: "2.0", ...message });
		stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	};
	const wait = (predicate: (message: Message) => boolean): Promise<Message> => {
		const existing = messages.find(predicate);
		return existing ? Promise.resolve(existing) : new Promise((resolve) => waiters.push({ predicate, resolve }));
	};
	const initialize = async (capabilities: Record<string, unknown> = {}) => {
		const request = await wait((message) => message.method === "initialize");
		send({
			id: request.id,
			result: { capabilities: { definitionProvider: true, documentSymbolProvider: true, ...capabilities } },
		});
	};
	return { send, wait, initialize, messages };
}

afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("private native LSP observations", () => {
	it("retains definitions, references, hierarchical and workspace symbols without changing foreground output", async () => {
		const { root, path, managed, execute } = fixture();
		const aliasDirectory = join(root, "alias");
		// Junctions exercise canonicalization without requiring Windows symlink privileges.
		symlinkSync(root, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
		const alias = join(aliasDirectory, "test.foo");
		const symbols = await managed({ action: "symbols", path: alias });
		expect(symbols.outcome).toBe("success");
		expect(symbols.observation).toEqual({
			kind: "symbols",
			coverage: "unknown",
			truncated: false,
			symbols: [
				{ path, name: "FakeClass", kind: 5, startLine: 1, startColumn: 7, endLine: 1, endColumn: 16 },
				{ path, name: "fakeMethod", kind: 6, startLine: 2, startColumn: 3, endLine: 2, endColumn: 13 },
			],
		});
		const foreground = await execute({ action: "symbols", path: alias });
		expect(symbols.result.content).toEqual(foreground.content);
		expect(Object.keys(symbols.result.details ?? {})).toEqual(["action", "lsp"]);
		const definition = await managed({ action: "definition", path, symbol: "symbol" });
		expect(definition.observation).toEqual({
			kind: "locations",
			coverage: "unknown",
			truncated: false,
			locations: [{ path, startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 }],
		});
		const references = await managed({ action: "references", path, symbol: "symbol" });
		expect(references.observation).toMatchObject({
			kind: "locations",
			locations: [
				{ path, startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 },
				{ path, startLine: 2, startColumn: 3, endLine: 2, endColumn: 8 },
			],
		});
		const workspace = await managed({ action: "symbols", path, symbol: "symbol" });
		expect(workspace.observation).toMatchObject({
			kind: "symbols",
			coverage: "unknown",
			symbols: [{ path, name: "symbol", kind: 13, startLine: 1, startColumn: 1, endLine: 1, endColumn: 7 }],
		});
	});

	it("bounds decoded symbols and locations by native counts and serialized bytes/lines", async () => {
		const { path, managed } = fixture();
		const uri = pathToFileURL(path).toString();
		const symbols = Array.from({ length: 300 }, (_, index) => ({
			name: `symbol${index}`,
			kind: 13,
			range,
			selectionRange: range,
		}));
		vi.spyOn(LspClient.prototype, "sendRequest").mockResolvedValue([{ ...symbols[0], children: symbols.slice(1) }]);
		const document = await managed({ action: "symbols", path });
		expect(document.observation).toMatchObject({ truncated: true });
		if (document.observation?.kind !== "symbols") throw new Error("Missing symbols");
		expect(document.observation.symbols).toHaveLength(200);
		vi.mocked(LspClient.prototype.sendRequest).mockResolvedValue(
			symbols.map((symbol) => ({ ...symbol, location: { uri, range } })),
		);
		const workspace = await managed({ action: "symbols", path, symbol: "symbol" });
		if (workspace.observation?.kind !== "symbols") throw new Error("Missing symbols");
		expect(workspace.observation.symbols).toHaveLength(50);
		expect(workspace.observation.truncated).toBe(true);
		vi.mocked(LspClient.prototype.sendRequest).mockResolvedValue(Array.from({ length: 70 }, () => ({ uri, range })));
		const references = await managed({ action: "references", path, symbol: "symbol" });
		if (references.observation?.kind !== "locations") throw new Error("Missing locations");
		expect(references.observation.locations).toHaveLength(50);
		expect(references.observation.truncated).toBe(true);
		vi.mocked(LspClient.prototype.sendRequest).mockResolvedValue(
			symbols.map((symbol) => ({ ...symbol, name: "界\n".repeat(5000) })),
		);
		const bytes = await managed({ action: "symbols", path });
		expect(bytes.observation).toMatchObject({ truncated: true });
		for (const observation of [
			document.observation,
			workspace.observation,
			references.observation,
			bytes.observation,
		]) {
			const json = JSON.stringify(observation, null, 2);
			expect(Buffer.byteLength(json)).toBeLessThanOrEqual(50 * 1024);
			expect(json.split("\n").length).toBeLessThanOrEqual(2000);
		}
	});

	it("bounds traversal of deeply nested document symbols", async () => {
		const { path, managed } = fixture();
		type Symbol = { name: string; kind: number; selectionRange: typeof range; children: Symbol[] };
		const symbol: Symbol = { name: "root", kind: 5, selectionRange: range, children: [] };
		let parent = symbol;
		for (let index = 0; index < 10000; index++) {
			const child: Symbol = { name: `child${index}`, kind: 6, selectionRange: range, children: [] };
			parent.children.push(child);
			parent = child;
		}
		vi.spyOn(LspClient.prototype, "sendRequest").mockResolvedValue([symbol]);
		const result = await managed({ action: "symbols", path });
		expect(result.outcome).toBe("success");
		if (result.observation?.kind !== "symbols") throw new Error("Missing symbols");
		expect(result.observation.symbols).toHaveLength(200);
		expect(result.observation.truncated).toBe(true);
	});

	it("canonicalizes external symbol/location targets and marks unusable targets as partial", async () => {
		const { root, path, managed } = fixture();
		const external = realpathSync(mkdtempSync(join(tmpdir(), "volt-managed-target-")));
		roots.push(external);
		const target = join(external, "target.foo");
		writeFileSync(target, "symbol\n");
		const aliasDirectory = join(root, "external");
		symlinkSync(external, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
		const alias = join(aliasDirectory, "target.foo");
		vi.spyOn(LspClient.prototype, "sendRequest").mockResolvedValue([
			{ uri: pathToFileURL(alias).toString(), range },
			{ uri: "untitled:missing", range },
		]);
		const result = await managed({ action: "definition", path, symbol: "symbol" });
		expect(result.observation).toEqual({
			kind: "locations",
			coverage: "unknown",
			truncated: true,
			locations: [{ path: target, startLine: 1, startColumn: 3, endLine: 2, endColumn: 5 }],
		});
		vi.mocked(LspClient.prototype.sendRequest).mockResolvedValue([
			{ name: "symbol", kind: 13, location: { uri: pathToFileURL(alias).toString(), range } },
		]);
		expect((await managed({ action: "symbols", path })).observation).toMatchObject({ symbols: [{ path: target }] });
	});

	it("captures empty, disabled, unsupported, invalid and failed outcomes without parsing provider prose", async () => {
		const { root, path, managed } = fixture(["--empty-capabilities"]);
		expect(await managed({ action: "symbols", path })).toMatchObject({
			outcome: "unsupported",
			observation: undefined,
		});
		expect(
			await withManagedLspObservation(() => createLspTool(root).execute("disabled", { action: "symbols", path })),
		).toMatchObject({ outcome: "unavailable", observation: undefined });
		expect(await managed({ action: "definition", path })).toMatchObject({
			outcome: "invalid-input",
			observation: undefined,
		});
		const custom = createLspTool(root, {
			provider: customProvider(async () => lspResult("success", "FakeClass (class):1")),
		});
		expect(
			await withManagedLspObservation(() => custom.execute("custom", { action: "symbols", path })),
		).toMatchObject({ outcome: "success", observation: undefined });
		const failing = createLspTool(root, {
			provider: customProvider(async () => {
				throw new Error("secret error prose");
			}),
		});
		const failed = await withManagedLspObservation(() => failing.execute("failed", { action: "symbols", path }));
		expect(failed.outcome).toBe("request-failed");
		expect(failed.observation).toBeUndefined();
		expect(JSON.stringify({ outcome: failed.outcome, observation: failed.observation })).not.toContain("secret");
		vi.spyOn(LspClient.prototype, "sendRequest").mockResolvedValue([]);
		expect(await managed({ action: "symbols", path })).toMatchObject({
			outcome: "empty",
			observation: { kind: "symbols", symbols: [], truncated: false },
		});
	});

	it("isolates concurrent operation contexts and does not expose mutation actions", async () => {
		const { path, managed } = fixture();
		const [symbols, references] = await Promise.all([
			managed({ action: "symbols", path }),
			managed({ action: "references", path, symbol: "symbol" }),
		]);
		expect(symbols.observation?.kind).toBe("symbols");
		expect(references.observation?.kind).toBe("locations");
		expect(await managed({ action: "rename", path, symbol: "symbol", newName: "changed" })).toMatchObject({
			outcome: "invalid-input",
		});
		expect(readFileSync(path, "utf8")).toBe("symbol\n  symbol\n");
	});
});

describe("managed lifecycle and read-only policy", () => {
	it("does not offer or join installs and leaves foreground consent/breakers untouched", async () => {
		const { root, path } = fixture();
		const python = join(root, "test.py");
		writeFileSync(python, readFileSync(path));
		vi.stubEnv("PATH", root);
		vi.stubEnv("VOLT_OFFLINE", "0");
		const consent = deferred<{ decision: "denied" }>();
		const prompted = deferred<void>();
		const requestAction = vi.fn(() => {
			prompted.resolve();
			return consent.promise;
		});
		const installRunner = vi.fn(async () => ({ exitCode: 0, output: "" }));
		const manager = new LspManager({
			cwd: root,
			config: resolveLspConfig({ idleShutdownMs: 0 }),
			hostInteraction: { requestAction },
			installRunner,
		});
		managers.push(manager);
		const tool = createLspTool(root, { provider: manager });
		const invoke = () => tool.execute("install", { action: "symbols", path: python });
		for (let index = 0; index < 4; index++) {
			expect((await withManagedLspObservation(invoke)).outcome).toBe("unavailable");
		}
		expect(requestAction).not.toHaveBeenCalled();
		expect(installRunner).not.toHaveBeenCalled();
		const foreground = invoke();
		await prompted.promise;
		expect((await withManagedLspObservation(invoke)).outcome).toBe("unavailable");
		expect(requestAction).toHaveBeenCalledTimes(1);
		consent.resolve({ decision: "denied" });
		await foreground;
		expect(installRunner).not.toHaveBeenCalled();
	});

	it("retains shared read-only startup ownership after the managed waiter cancels", async () => {
		const wire = transport();
		const { path, managed, execute, manager } = fixture();
		const controller = new AbortController();
		const pending = managed({ action: "symbols", path }, controller.signal);
		await wire.wait((message) => message.method === "initialize");
		const foreground = execute({ action: "symbols", path });
		controller.abort();
		expect((await pending).outcome).toBe("cancelled");
		wire.send({ id: "startup-write", method: "workspace/applyEdit", params: { edit: { changes: {} } } });
		expect((await wire.wait((message) => message.id === "startup-write")).result).toMatchObject({ applied: false });
		await wire.initialize();
		const query = await wire.wait((message) => message.method === "textDocument/documentSymbol");
		wire.send({ id: query.id, result: [] });
		expect((await foreground).isError).toBe(false);
		expect(manager.getStatus().find((status) => status.name === "fake")?.attempts).toBe(1);
	});

	it("drains cancelled requests, rejects server writes until settlement, then preserves foreground writes", async () => {
		const wire = transport();
		const { path, managed, execute } = fixture();
		const controller = new AbortController();
		const pending = managed({ action: "definition", path, symbol: "symbol" }, controller.signal);
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await wire.initialize();
		const query = await wire.wait((message) => message.method === "textDocument/definition");
		controller.abort();
		await wire.wait((message) => message.method === "$/cancelRequest");
		const edit = {
			changes: {
				[pathToFileURL(path).toString()]: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "changed" },
				],
			},
		};
		wire.send({ id: "managed-write", method: "workspace/applyEdit", params: { edit } });
		expect((await wire.wait((message) => message.id === "managed-write")).result).toMatchObject({ applied: false });
		expect(settled).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("symbol\n  symbol\n");
		wire.send({ id: query.id, result: [] });
		expect(await pending).toMatchObject({ outcome: "cancelled", observation: undefined });
		const foreground = execute({ action: "definition", path, symbol: "symbol" });
		const next = await wire.wait(
			(message) => message.method === "textDocument/definition" && message.id !== query.id,
		);
		wire.send({ id: "foreground-write", method: "workspace/applyEdit", params: { edit } });
		expect((await wire.wait((message) => message.id === "foreground-write")).result).toMatchObject({ applied: true });
		wire.send({ id: next.id, result: [] });
		await foreground;
		expect(readFileSync(path, "utf8")).toBe("changed\n  symbol\n");
	});

	it("keeps server writes denied after a managed request times out without acknowledging cancellation", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const wire = transport();
		const { path, managed } = fixture();
		const controller = new AbortController();
		const pending = managed({ action: "definition", path, symbol: "symbol" }, controller.signal);
		await wire.initialize();
		await wire.wait((message) => message.method === "textDocument/definition");
		controller.abort();
		await vi.advanceTimersByTimeAsync(30000);
		expect((await pending).outcome).toBe("cancelled");
		wire.send({ id: "late-write", method: "workspace/applyEdit", params: { edit: { changes: {} } } });
		expect((await wire.wait((message) => message.id === "late-write")).result).toMatchObject({ applied: false });
	});

	it.each(["success", "error"])(
		"restores foreground writes only after both timed-out reads receive terminal replies (%s last)",
		async (lastReply) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const wire = transport();
			const { path, managed, execute } = fixture();
			const first = managed({ action: "definition", path, symbol: "symbol" });
			await wire.initialize();
			const firstQuery = await wire.wait((message) => message.method === "textDocument/definition");
			const second = managed({ action: "symbols", path });
			const secondQuery = await wire.wait((message) => message.method === "textDocument/documentSymbol");
			await vi.advanceTimersByTimeAsync(30000);
			expect((await first).outcome).toBe("timeout");
			expect((await second).outcome).toBe("timeout");
			const edit = {
				changes: {
					[pathToFileURL(path).toString()]: [
						{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "changed" },
					],
				},
			};
			wire.send({ id: "before-replies", method: "workspace/applyEdit", params: { edit } });
			expect((await wire.wait((message) => message.id === "before-replies")).result).toMatchObject({
				applied: false,
			});
			wire.send({ id: firstQuery.id, result: [] });
			wire.send({ id: firstQuery.id, result: [] });
			wire.send({ id: "unknown-query", result: [] });
			wire.send({ id: secondQuery.id }); // Not a terminal response without result/error.
			wire.send({ id: "after-first-reply", method: "workspace/applyEdit", params: { edit } });
			expect((await wire.wait((message) => message.id === "after-first-reply")).result).toMatchObject({
				applied: false,
			});
			expect(readFileSync(path, "utf8")).toBe("symbol\n  symbol\n");
			wire.send({
				id: secondQuery.id,
				...(lastReply === "success" ? { result: [] } : { error: { code: -32800, message: "Request cancelled" } }),
			});
			const foreground = execute({ action: "definition", path, symbol: "symbol" });
			const query = await wire.wait(
				(message) => message.method === "textDocument/definition" && message.id !== firstQuery.id,
			);
			wire.send({ id: "after-all-replies", method: "workspace/applyEdit", params: { edit } });
			expect((await wire.wait((message) => message.id === "after-all-replies")).result).toMatchObject({
				applied: true,
			});
			wire.send({ id: query.id, result: [] });
			expect((await foreground).isError).toBe(false);
			expect(readFileSync(path, "utf8")).toBe("changed\n  symbol\n");
		},
	);

	it("bounds managed request admission across pending requests and unacknowledged timeouts", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const wire = transport();
		const { path, managed } = fixture();
		const pending = [managed({ action: "definition", path, symbol: "symbol" })];
		await wire.initialize();
		await wire.wait((message) => message.method === "textDocument/definition");
		for (let index = 1; index < 64; index++) {
			pending.push(managed({ action: "definition", path, symbol: "symbol" }));
		}
		await wire.wait(
			(message) =>
				message.method === "textDocument/definition" &&
				wire.messages.filter((entry) => entry.method === "textDocument/definition").length === 64,
		);
		const requests = wire.messages.filter((message) => message.method === "textDocument/definition");
		expect(await managed({ action: "definition", path, symbol: "symbol" })).toMatchObject({
			outcome: "unavailable",
			result: { isError: true, details: { lsp: { reason: "managed-request-limit" } } },
		});
		await vi.advanceTimersByTimeAsync(30000);
		for (const result of await Promise.all(pending)) expect(result.outcome).toBe("timeout");
		for (let index = 0; index < 4; index++) {
			expect((await managed({ action: "definition", path, symbol: "symbol" })).outcome).toBe("unavailable");
		}
		expect(wire.messages.filter((message) => message.method === "textDocument/definition")).toHaveLength(64);
		wire.send({ id: requests[0].id, result: [] });
		const resumed = managed({ action: "definition", path, symbol: "symbol" });
		const query = await wire.wait(
			(message) => message.method === "textDocument/definition" && !requests.includes(message),
		);
		wire.send({ id: query.id, result: [] });
		expect((await resumed).outcome).toBe("empty");
		wire.send({ id: "still-unresolved", method: "workspace/applyEdit", params: { edit: { changes: {} } } });
		expect((await wire.wait((message) => message.id === "still-unresolved")).result).toMatchObject({
			applied: false,
		});
	});

	it("revokes timed-out transport writes on replacement without poisoning the new client", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const wire = transport();
		const { path, managed, execute, manager } = fixture();
		const applier = vi.spyOn(workspaceEdit, "applyWorkspaceEdit");
		const pending = managed({ action: "definition", path, symbol: "symbol" });
		await wire.initialize();
		await wire.wait((message) => message.method === "textDocument/definition");
		await vi.advanceTimersByTimeAsync(30000);
		expect((await pending).outcome).toBe("timeout");
		expect(manager.restart()).toBe(1);
		wire.send({ id: "revoked-write", method: "workspace/applyEdit", params: { edit: { changes: {} } } });
		expect(applier).not.toHaveBeenCalled();
		const replacement = transport();
		const foreground = execute({ action: "definition", path, symbol: "symbol" });
		await replacement.initialize();
		const query = await replacement.wait((message) => message.method === "textDocument/definition");
		replacement.send({ id: "new-client-write", method: "workspace/applyEdit", params: { edit: { changes: {} } } });
		expect((await replacement.wait((message) => message.id === "new-client-write")).result).toMatchObject({
			applied: true,
		});
		expect(applier).toHaveBeenCalledTimes(1);
		replacement.send({ id: query.id, result: [] });
		expect((await foreground).isError).toBe(false);
	});

	it("reports a rejected command edit as edit-failed even when executeCommand succeeds", async () => {
		const wire = transport();
		const applier = vi.spyOn(workspaceEdit, "applyWorkspaceEdit");
		const { path, managed, execute } = fixture();
		const pendingRead = managed({ action: "definition", path, symbol: "symbol" });
		await wire.initialize({ codeActionProvider: true, executeCommandProvider: { commands: ["fake.fix"] } });
		const readQuery = await wire.wait((message) => message.method === "textDocument/definition");
		wire.send({
			method: "textDocument/publishDiagnostics",
			params: {
				uri: pathToFileURL(path).toString(),
				version: 1,
				diagnostics: [{ range, message: "Needs command fix", severity: 1 }],
			},
		});
		const fix = execute({ action: "fix", path });
		const actionQuery = await wire.wait((message) => message.method === "textDocument/codeAction");
		wire.send({ id: actionQuery.id, result: [{ title: "Fix with command", command: "fake.fix" }] });
		const command = await wire.wait((message) => message.method === "workspace/executeCommand");
		wire.send({
			id: "command-edit",
			method: "workspace/applyEdit",
			params: {
				edit: {
					changes: {
						[pathToFileURL(path).toString()]: [
							{
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
								newText: "changed",
							},
						],
					},
				},
			},
		});
		expect((await wire.wait((message) => message.id === "command-edit")).result).toMatchObject({ applied: false });
		wire.send({ id: command.id, result: null });
		const result = await fix;
		expect(applier).not.toHaveBeenCalled();
		expect(readFileSync(path, "utf8")).toBe("symbol\n  symbol\n");
		expect(result).toMatchObject({
			isError: true,
			details: { lsp: { outcome: "edit-failed", reason: "workspace-edit-rejected" } },
		});
		wire.send({ id: readQuery.id, result: [] });
		expect((await pendingRead).outcome).toBe("empty");
	});

	it("awaits owned document refresh after cancellation before returning the outcome", async () => {
		const { path, managed } = fixture();
		const refreshStarted = deferred<void>();
		const refresh = deferred<string[]>();
		vi.spyOn(LspClient.prototype, "refreshStaleDocuments").mockImplementationOnce(() => {
			refreshStarted.resolve();
			return refresh.promise;
		});
		const controller = new AbortController();
		const pending = managed({ action: "symbols", path }, controller.signal);
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await refreshStarted.promise;
		controller.abort();
		await Promise.resolve();
		expect(settled).toBe(false);
		refresh.resolve([]);
		expect(await pending).toMatchObject({ outcome: "cancelled", observation: undefined });
	});
});
