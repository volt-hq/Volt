import { type ChildProcess, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LspClient } from "../src/core/lsp/client.ts";
import { resolveLspConfig } from "../src/core/lsp/config.ts";
import { LspManager } from "../src/core/lsp/manager.ts";
import { waitForLsp } from "../src/core/lsp/outcome.ts";
import * as subprocess from "../src/utils/child-process.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-lsp-server.mjs", import.meta.url));
const roots: string[] = [];
const owners: Array<{ dispose(): void }> = [];

function manager(args: string[] = [], idleShutdownMs = 0) {
	const root = mkdtempSync(join(tmpdir(), "volt-lsp-startup-"));
	roots.push(root);
	const path = join(root, "test.foo");
	writeFileSync(path, "symbol\n");
	const value = new LspManager({
		cwd: root,
		config: resolveLspConfig({
			idleShutdownMs,
			servers: { fake: { command: [process.execPath, fake, ...args], fileExtensions: [".foo"], rootMarkers: [] } },
		}),
	});
	owners.push(value);
	return { value, path };
}

function cancelAtStartup(controller: AbortController) {
	const start = LspClient.prototype.start;
	return vi.spyOn(LspClient.prototype, "start").mockImplementationOnce(function (this: LspClient) {
		const startup = start.call(this);
		// Deterministically exercise cancellation between creating the shared
		// startup promise and attaching the operation's wait.
		controller.abort();
		return startup;
	});
}

afterEach(() => {
	for (const owner of owners.splice(0)) owner.dispose();
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("startup rejection ownership", () => {
	it.each(["preaborted", "later-abort", "client-failure", "client-timeout", "client-disposed"])(
		"observes abandoned work under Node strict rejection handling: %s",
		(scenario) => {
			const result = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--unhandled-rejections=strict",
					fileURLToPath(new URL("./fixtures/lsp-startup-lifecycle.ts", import.meta.url)),
					scenario,
				],
				{ encoding: "utf8", timeout: 15000 },
			);
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("lifecycle settled without an unhandled rejection");
		},
	);

	it("keeps another waiter's success and the shared promise intact", async () => {
		let complete!: (value: string) => void;
		const startup = new Promise<string>((resolve) => {
			complete = resolve;
		});
		const controller = new AbortController();
		const cancelled = waitForLsp(startup, controller.signal);
		const active = waitForLsp(startup, new AbortController().signal);
		controller.abort();
		await expect(cancelled).rejects.toMatchObject({ outcome: "cancelled" });
		complete("ready");
		await expect(active).resolves.toBe("ready");
		await expect(startup).resolves.toBe("ready");
	});

	it("preserves the original failure for another waiter", async () => {
		let fail!: (error: Error) => void;
		const startup = new Promise<void>((_, reject) => {
			fail = reject;
		});
		const controller = new AbortController();
		controller.abort();
		await expect(waitForLsp(startup, controller.signal)).rejects.toMatchObject({ outcome: "cancelled" });
		const active = waitForLsp(startup, new AbortController().signal);
		const error = new Error("original failure");
		const rejected = expect(active).rejects.toBe(error);
		fail(error);
		await rejected;
		await expect(startup).rejects.toBe(error);
	});
});

describe("manager-owned startup lifecycle", () => {
	it("does not launch for already-cancelled automatic diagnostics", async () => {
		const { value, path } = manager(["--init-error"]);
		const controller = new AbortController();
		controller.abort();
		expect(await value.getDiagnostics(path, "symbol\n", controller.signal)).toMatchObject({
			outcome: "cancelled",
			reason: "aborted",
			coldStartMs: 0,
		});
		expect(value.getStatus().find((entry) => entry.name === "fake")).toMatchObject({
			state: "unused",
			attempts: 0,
		});
	});

	it("records startup failures and opens the breaker even when every caller cancels", async () => {
		const { value, path } = manager(["--init-error"]);
		for (let attempt = 1; attempt <= 3; attempt++) {
			const controller = new AbortController();
			const spy = cancelAtStartup(controller);
			expect(await value.getDiagnostics(path, "symbol\n", controller.signal)).toMatchObject({
				outcome: "cancelled",
			});
			await expect
				.poll(() => {
					const status = value.getStatus().find((entry) => entry.name === "fake");
					return { state: status?.state, alive: status?.alive };
				})
				.toEqual({ state: attempt === 3 ? "blocked" : "failed", alive: false });
			expect(value.getStatus().find((entry) => entry.name === "fake")).toMatchObject({
				attempts: attempt,
				startupStderr: expect.stringContaining("fake-lsp-server ready"),
				lastError: expect.stringContaining("initialize failed"),
			});
			spy.mockRestore();
		}
		expect(await value.getDiagnostics(path, "symbol\n")).toMatchObject({ reason: "breaker-open" });
		expect(value.getStatus().find((entry) => entry.name === "fake")?.attempts).toBe(3);
	});

	it("lets another caller finish shared initialization after one caller cancels", async () => {
		const { value, path } = manager();
		const controller = new AbortController();
		cancelAtStartup(controller);
		const [cancelled, active] = await Promise.all([
			value.getDiagnostics(path, "symbol\n", controller.signal),
			value.hover(path, "symbol"),
		]);
		expect(cancelled).toMatchObject({ outcome: "cancelled" });
		expect(active).toMatchObject({ outcome: "success" });
		expect(value.getStatus().find((entry) => entry.name === "fake")).toMatchObject({ attempts: 1, state: "ready" });
	});

	it("counts concurrent failed startup waiters only once", async () => {
		const { value, path } = manager(["--init-error"]);
		for (let attempt = 1; attempt <= 3; attempt++) {
			const results = await Promise.all([value.hover(path, "symbol"), value.hover(path, "symbol")]);
			expect(results.every((result) => result.outcome === "unavailable")).toBe(true);
			expect(value.getStatus().find((entry) => entry.name === "fake")).toMatchObject({
				attempts: attempt,
				breaker: attempt === 3 ? "open" : "closed",
			});
		}
	});

	it("retains completed startup evidence after the only waiter cancels", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		const { value, path } = manager([], 100);
		const controller = new AbortController();
		cancelAtStartup(controller);
		expect(await value.getDiagnostics(path, "symbol\n", controller.signal)).toMatchObject({ outcome: "cancelled" });
		await expect
			.poll(() => value.getStatus().find((entry) => entry.name === "fake")?.serverInfo)
			.toEqual({
				name: "fake-lsp",
				version: "1.0",
			});
		// Evict without another operation: evidence must come from the startup owner,
		// not a later successful waiter or the live client's status projection.
		await vi.advanceTimersByTimeAsync(1000);
		expect(value.getStatus().find((entry) => entry.name === "fake")).toMatchObject({
			state: "idle",
			attempts: 1,
			serverInfo: { name: "fake-lsp", version: "1.0" },
			capabilities: expect.arrayContaining(["hoverProvider"]),
		});
	});

	it("does not idle-evict a startup after its waiter cancels", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		const { value, path } = manager(["--hang-initialize"], 100);
		const controller = new AbortController();
		cancelAtStartup(controller);
		expect(await value.getDiagnostics(path, "symbol\n", controller.signal)).toMatchObject({ outcome: "cancelled" });
		await vi.advanceTimersByTimeAsync(1000);
		expect(value.getStatus().find((entry) => entry.name === "fake")).toMatchObject({
			state: "starting",
			alive: true,
			attempts: 1,
		});
	});

	it("joins a terminated client's pending startup while its stderr drains", async () => {
		const events = new EventEmitter();
		const stderr = new PassThrough();
		let exitCode: number | null = null;
		Object.assign(events, {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr,
			pid: undefined,
			kill: () => true,
		});
		Object.defineProperties(events, {
			exitCode: { get: () => exitCode },
			signalCode: { get: () => null },
		});
		const child = events as unknown as ChildProcess;
		const spawn = vi.spyOn(subprocess, "spawnProcess").mockReturnValue(child);
		const { value, path } = manager();
		const controller = new AbortController();
		cancelAtStartup(controller);
		expect(await value.getDiagnostics(path, "symbol\n", controller.signal)).toMatchObject({ outcome: "cancelled" });
		exitCode = 2;
		events.emit("exit", 2, null);

		const second = new AbortController();
		// Reach document inspection after acquiring the client, then cancel this
		// waiter too. Startup still owns the not-yet-drained terminal evidence.
		vi.spyOn(LspClient.prototype, "getOpenDocumentPaths").mockImplementationOnce(() => {
			second.abort();
			return [];
		});
		expect(await value.getDiagnostics(path, "symbol\n", second.signal)).toMatchObject({ outcome: "cancelled" });
		expect(value.getStatus().find((entry) => entry.name === "fake")?.attempts).toBe(1);
		expect(spawn).toHaveBeenCalledTimes(1);
		stderr.end("late startup detail\n");
		events.emit("close", 2, null);
		await expect
			.poll(() => value.getStatus().find((entry) => entry.name === "fake")?.lastError)
			.toContain("late startup detail");
		expect(value.getStatus().find((entry) => entry.name === "fake")).toMatchObject({
			state: "failed",
			attempts: 1,
			breaker: "closed",
		});
	});

	it("ignores old startup settlement after restart replaces the client", async () => {
		const { value, path } = manager();
		const controller = new AbortController();
		cancelAtStartup(controller);
		expect(await value.getDiagnostics(path, "symbol\n", controller.signal)).toMatchObject({ outcome: "cancelled" });
		expect(value.restart()).toBe(1);
		expect(await value.hover(path, "symbol")).toMatchObject({ outcome: "success" });
		expect(value.getStatus().find((entry) => entry.name === "fake")).toMatchObject({
			state: "ready",
			attempts: 1,
			breaker: "closed",
			serverInfo: { name: "fake-lsp", version: "1.0" },
		});
	});

	it("does not repopulate startup evidence or failures after disposal", async () => {
		const { value, path } = manager(["--hang-initialize"]);
		const controller = new AbortController();
		const start = LspClient.prototype.start;
		let startup!: Promise<void>;
		vi.spyOn(LspClient.prototype, "start").mockImplementationOnce(function (this: LspClient) {
			startup = start.call(this);
			controller.abort();
			return startup;
		});
		expect(await value.getDiagnostics(path, "symbol\n", controller.signal)).toMatchObject({ outcome: "cancelled" });
		value.dispose();
		await expect(startup).rejects.toMatchObject({ outcome: "unavailable" });
		expect(value.getStatus().find((entry) => entry.name === "fake")).toMatchObject({ state: "unused", attempts: 0 });
		expect(value.getStatus().find((entry) => entry.name === "fake")?.startupStderr).toBeUndefined();
	});
});
