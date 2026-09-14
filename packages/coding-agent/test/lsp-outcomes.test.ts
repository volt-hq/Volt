import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LspClient } from "../src/core/lsp/client.ts";
import { resolveLspConfig } from "../src/core/lsp/config.ts";
import { LspManager } from "../src/core/lsp/manager.ts";
import { projectSessionTranscript } from "../src/core/rpc/transcript.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createLspTool } from "../src/core/tools/lsp.ts";
import { createWriteTool } from "../src/core/tools/write.ts";
import { createHarness } from "./suite/harness.ts";

const fake = join(__dirname, "fixtures/fake-lsp-server.mjs");
const roots: string[] = [];
const owned: Array<{ dispose(): void }> = [];
function directory(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-lsp-outcomes-"));
	roots.push(root);
	return root;
}
function client(args: string[] = [], requestTimeoutMs = 500): { client: LspClient; path: string } {
	const root = directory();
	const value = new LspClient({
		serverName: "fake",
		rootDir: root,
		command: [process.execPath, fake, ...args],
		requestTimeoutMs,
	});
	owned.push(value);
	const path = join(root, "test.foo");
	writeFileSync(path, "clean\n");
	return { client: value, path };
}
function manager(root: string, args: string[] = []): LspManager {
	const value = new LspManager({
		cwd: root,
		config: resolveLspConfig({
			settleMs: 100,
			firstSettleMs: 100,
			idleShutdownMs: 0,
			servers: { fake: { command: [process.execPath, fake, ...args], fileExtensions: [".foo"], rootMarkers: [] } },
		}),
	});
	owned.push(value);
	return value;
}
afterEach(() => {
	for (const value of owned.splice(0)) value.dispose();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("diagnostic evidence", () => {
	it("never calls silence a clean check, including repeated unchanged requests", async () => {
		const { client: value, path } = client(["--no-publish"]);
		for (let index = 0; index < 2; index++)
			expect(await value.getDiagnostics(path, "clean\n", 60)).toMatchObject({
				outcome: "timeout",
				freshness: "unknown",
				source: "none",
				diagnostics: [],
			});
	});
	it("does not reuse a cached publication after document or dependency changes", async () => {
		const { client: value, path } = client(["--stale-only"]);
		expect(await value.getDiagnostics(path, "clean\n", 200)).toMatchObject({ outcome: "empty", freshness: "fresh" });
		expect(await value.getDiagnostics(path, "changed\n", 60)).toMatchObject({
			outcome: "timeout",
			freshness: "stale",
		});
		expect(await value.getDiagnostics(path, "changed\n", 60)).toMatchObject({
			outcome: "timeout",
			freshness: "stale",
		});
	});
	it("labels unversioned publications and their cache as unverified", async () => {
		const { client: value, path } = client(["--no-version"]);
		expect(await value.getDiagnostics(path, "clean\n", 100)).toMatchObject({
			outcome: "empty",
			freshness: "unverified",
			source: "push",
		});
		expect(await value.getDiagnostics(path, "clean\n", 100)).toMatchObject({
			outcome: "empty",
			freshness: "unverified",
			source: "cache",
		});
	});
	it("rejects malformed pulls rather than report clean", async () => {
		const { client: value, path } = client(["--pull", "--malformed-pull"]);
		expect(await value.getDiagnostics(path, "clean\n", 60)).toMatchObject({
			outcome: "request-failed",
			reason: "invalid-pull",
			freshness: "unknown",
		});
	});
	it("falls back to current publications after rejected pulls", async () => {
		const { client: value, path } = client(["--pull", "--rejected-pull"]);
		expect(await value.getDiagnostics(path, "ERROR\n", 200)).toMatchObject({
			outcome: "success",
			source: "push",
			freshness: "fresh",
			diagnosticCount: 1,
		});
	});
	it("does not hide pull timeouts with empty publication caches", async () => {
		const { client: value, path } = client(["--pull", "--hang-pull"], 100);
		expect(await value.getDiagnostics(path, "clean\n", 60)).toMatchObject({
			outcome: "timeout",
			reason: "request-deadline",
			freshness: "unknown",
		});
	});
	it("reports abort and server exit during publication waits", async () => {
		const { client: value, path } = client(["--no-publish"]);
		await value.start();
		const abort = new AbortController();
		const pending = value.getDiagnostics(path, "clean\n", 1000, 1000, abort.signal);
		setTimeout(() => abort.abort(), 40);
		expect(await pending).toMatchObject({ outcome: "cancelled", freshness: "unknown" });
		const exited = client(["--exit-on-change"]);
		await exited.client.getDiagnostics(exited.path, "clean\n", 200);
		expect(await exited.client.getDiagnostics(exited.path, "new\n", 200)).toMatchObject({
			outcome: "unavailable",
			reason: "server-exit",
		});
	});
});

describe("health, capabilities and lifecycle", () => {
	it("inspects unused and disabled servers without launches", async () => {
		const root = directory();
		const value = manager(root);
		const before = value.getStatus();
		expect(before.every((entry) => entry.attempts === 0 && !entry.alive)).toBe(true);
		expect((await value.status()).text).toContain("unused");
		expect(value.getStatus()).toEqual(before);
	});
	it("distinguishes unknown capabilities from advertised absence and gates absent methods", async () => {
		const { client: value } = client(["--empty-capabilities"]);
		await value.start();
		expect(value.getCapabilities()).toEqual({});
		await expect(value.sendRequest("textDocument/hover", {})).rejects.toMatchObject({
			outcome: "unsupported",
			reason: "capability-absent",
		});
		const unknown = client(["--absent-capabilities"]).client;
		await unknown.start();
		expect(unknown.getCapabilities()).toBeUndefined();
		expect(unknown.supportsMethod("textDocument/hover")).toBeUndefined();
	});
	it("bounds initialization and separates startup failure from query failure", async () => {
		const { client: value } = client(["--hang-initialize"], 100);
		await expect(value.start()).rejects.toMatchObject({ outcome: "timeout", reason: "startup-timeout" });
		const root = directory();
		const valueManager = manager(root, ["--hang"]);
		const path = join(root, "a.foo");
		writeFileSync(path, "symbol\n");
		await valueManager.documentSymbols(path);
		const abort = new AbortController();
		const query = valueManager.hover(path, "symbol", undefined, abort.signal);
		setTimeout(() => abort.abort(), 40);
		expect(await query).toMatchObject({ outcome: "cancelled" });
		expect(valueManager.getStatus().find((entry) => entry.name === "fake")).toMatchObject({
			attempts: 1,
			breaker: "closed",
		});
	});
	it("cancels only one caller of shared initialization", async () => {
		const { client: value, path } = client();
		const abort = new AbortController();
		abort.abort();
		await expect(value.openDocument(path, "clean\n", abort.signal)).rejects.toMatchObject({ outcome: "cancelled" });
		await expect(value.openDocument(path, "clean\n")).resolves.toContain("test.foo");
		expect(value.isReady).toBe(true);
	});
	it("records a single failed initialization for concurrent callers", async () => {
		const root = directory();
		const value = manager(root, ["--init-error"]);
		const path = join(root, "test.foo");
		writeFileSync(path, "symbol\n");
		const results = await Promise.all([value.hover(path, "symbol"), value.hover(path, "symbol")]);
		expect(results.every((result) => result.outcome === "unavailable")).toBe(true);
		expect(value.getStatus().find((entry) => entry.name === "fake")).toMatchObject({
			attempts: 1,
			state: "failed",
			breaker: "closed",
		});
	});
});

describe("built-in TypeScript compatibility and consent", () => {
	function builtIn(version: string, consent: "approved" | "denied" = "denied") {
		const root = directory();
		const path = join(root, "a.ts");
		writeFileSync(path, "symbol\n");
		const executable = join(root, process.platform === "win32" ? "tsc.cmd" : "tsc");
		writeFileSync(
			executable,
			process.platform === "win32"
				? `@"${process.execPath}" "${fake}" %*\r\n`
				: `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`,
		);
		chmodSync(executable, 0o755);
		vi.stubEnv("PATH", root);
		vi.stubEnv("VOLT_FAKE_TS_VERSION", version);
		const requestAction = vi.fn(async () => ({ decision: consent }));
		const installRunner = vi.fn(async () => {
			vi.stubEnv("VOLT_FAKE_TS_VERSION", "7.0.2");
			return { exitCode: 0, output: "" };
		});
		const value = new LspManager({
			cwd: root,
			config: resolveLspConfig({ idleShutdownMs: 0 }),
			hostInteraction: { requestAction },
			installRunner,
		});
		owned.push(value);
		return { value, path, requestAction, installRunner };
	}
	it("blocks TS6 before native startup, caches exact identity, and clears on restart", async () => {
		const { value, path, requestAction, installRunner } = builtIn("6.0.2");
		const first = await value.hover(path, "symbol");
		expect(first).toMatchObject({ outcome: "unavailable", reason: "incompatible-version" });
		expect(first.text).toContain("6.0.2");
		expect(first.text).toContain("TypeScript >=7");
		vi.stubEnv("VOLT_FAKE_TS_VERSION", "7.0.2");
		expect(await value.hover(path, "symbol")).toMatchObject({ reason: "incompatible-version" });
		expect(requestAction).toHaveBeenCalledTimes(1);
		expect(installRunner).not.toHaveBeenCalled();
		value.restart();
		expect(await value.hover(path, "symbol")).toMatchObject({ outcome: "success" });
	});
	it("repairs only after consent and revalidates with the pinned safe recipe", async () => {
		const { value, path, requestAction, installRunner } = builtIn("6.0.2", "approved");
		expect(await value.hover(path, "symbol")).toMatchObject({ outcome: "success" });
		expect(requestAction.mock.calls[0]).toBeDefined();
		expect(installRunner).toHaveBeenCalledWith(
			["npm", "install", "-g", "typescript@7.0.2", "--ignore-scripts", "--include=optional"],
			expect.anything(),
		);
	});
	it("never offers repair offline or when version evidence is invalid", async () => {
		const { value, path, requestAction, installRunner } = builtIn("6.0.2", "approved");
		vi.stubEnv("VOLT_OFFLINE", "1");
		expect(await value.hover(path, "symbol")).toMatchObject({ reason: "incompatible-version" });
		expect(requestAction).not.toHaveBeenCalled();
		expect(installRunner).not.toHaveBeenCalled();
		vi.stubEnv("VOLT_OFFLINE", "0");
		vi.stubEnv("VOLT_FAKE_TS_VERSION", "garbage");
		value.restart();
		expect(await value.hover(path, "symbol")).toMatchObject({ reason: "version-probe-failed" });
		expect(requestAction).not.toHaveBeenCalled();
	});
});

it("persists failed explicit calls and successful writes with bounded evidence and truthful RPC status", async () => {
	const root = directory();
	const sm = await SessionManager.create(root, join(root, "sessions"));
	const ref = sm.getSessionRef()!;
	const value = manager(root, ["--no-publish"]);
	const tools = [createLspTool(root, { provider: value }), createWriteTool(root, { diagnosticsProvider: value })];
	const harness = await createHarness({
		sessionManager: sm,
		tools,
		initialActiveToolNames: ["lsp", "write"],
		settings: { lsp: { enabled: false }, compaction: { enabled: false } },
	});
	const path = join(root, "a.foo");
	writeFileSync(path, "original\n");
	try {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("lsp", { action: "diagnostics", path }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("write", { path, content: "SECRET-SOURCE\n" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Run the fixture checks");
		expect(readFileSync(path, "utf8")).toBe("SECRET-SOURCE\n");
		await sm.flush();
	} finally {
		await harness.cleanupAsync();
	}
	const reopened = await SessionManager.open(ref);
	try {
		const messages = reopened
			.getEntries()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		expect(messages).toHaveLength(2);
		expect(messages.map((message) => message.isError)).toEqual([true, false]);
		const evidence = messages.map(
			(message) => (message.details as { lsp: { outcome: string; durationMs: number; operationId: string } }).lsp,
		);
		expect(evidence.every((operation) => operation.outcome === "timeout" && operation.durationMs >= 0)).toBe(true);
		expect(new Set(evidence.map((operation) => operation.operationId)).size).toBe(2);
		expect(JSON.stringify(evidence)).not.toContain("SECRET-SOURCE");
		expect(JSON.stringify(evidence).length).toBeLessThan(2000);
		expect(
			projectSessionTranscript(reopened)
				.items.filter((item) => item.role === "tool")
				.map((item) => item.status),
		).toEqual(["failed", "completed"]);
	} finally {
		await reopened.closePersistence();
	}
});
