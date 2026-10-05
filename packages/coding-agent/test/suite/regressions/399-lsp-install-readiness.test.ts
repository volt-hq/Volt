import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { HostResponse } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LspClient } from "../../../src/core/lsp/client.ts";
import { resolveLspConfig } from "../../../src/core/lsp/config.ts";
import { LspManager } from "../../../src/core/lsp/manager.ts";
import { type Approver, testHostActions } from "../../host-action-doubles.ts";
import { createHarness } from "../harness.ts";

const fake = join(__dirname, "../../fixtures/fake-lsp-server.mjs");
const roots: string[] = [];
const managers: LspManager[] = [];

function launcher(directory: string, args: string[] = []): string {
	const path = join(directory, process.platform === "win32" ? "rust-analyzer.cmd" : "rust-analyzer");
	writeFileSync(
		path,
		process.platform === "win32"
			? `@"${process.execPath}" "${fake}" ${args.join(" ")} %*\r\n`
			: `#!/bin/sh\nexec '${process.execPath}' '${fake}' ${args.join(" ")} "$@"\n`,
	);
	chmodSync(path, 0o755);
	return path;
}

function fixture(install: (bin: string, component: string) => void = () => {}) {
	const root = mkdtempSync(join(tmpdir(), "volt-lsp-install-"));
	roots.push(root);
	const bin = join(root, "bin");
	const component = join(root, "component");
	mkdirSync(bin);
	mkdirSync(component);
	const path = join(root, "main.rs");
	writeFileSync(path, "symbol\n");
	vi.stubEnv("PATH", bin);
	vi.stubEnv("VOLT_OFFLINE", "0");
	const completionStates: string[] = [];
	const requestAction = vi.fn<Approver>(async () => ({ decision: "approved" }));
	const host = testHostActions(requestAction);
	const installRunner = vi.fn(async () => {
		install(bin, component);
		return { exitCode: 0, output: "component installed" };
	});
	const manager = new LspManager({
		cwd: root,
		config: resolveLspConfig({ idleShutdownMs: 0 }),
		hostActions: host.actions,
		installRunner,
	});
	host.onFinished = (record) => {
		if (record.outcome === "completed")
			completionStates.push(manager.getStatus().find((entry) => entry.name === "rust")?.state ?? "unknown");
	};
	managers.push(manager);
	return { manager, root, bin, component, path, host, completionStates, requestAction, installRunner };
}

/** Each install action that finished: the state it last ran in, and its outcome. */
function ran(item: ReturnType<typeof fixture>): string[][] {
	return item.host.finished.map((record) => [record.state, record.outcome ?? "open"]);
}

/** Whether the one install action ran (it reported progress), then ended cancelled, however the cancel reached it. */
function cancelledAfterRunning(item: ReturnType<typeof fixture>): boolean {
	const [record, ...rest] = item.host.finished;
	return rest.length === 0 && record?.outcome === "cancelled" && record.progress !== undefined;
}

/** The last finished install action's report: its summary, or its error. */
function report(item: ReturnType<typeof fixture>): string | undefined {
	const record = item.host.finished.at(-1);
	return record?.error ?? record?.result?.summary;
}

afterEach(async () => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	// dispose() kills launched servers without waiting; on Windows the exiting
	// process still holds its cwd, so give the rmdir time to succeed. Only the
	// async rm retries EBUSY on a directory; rmSync throws it immediately.
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
	);
});

describe("LSP install readiness (#399)", () => {
	it.each(["explicit", "automatic"])(
		"distinguishes an installed component from an unresolved launcher (%s)",
		async (mode) => {
			const item = fixture((_bin, component) => launcher(component));
			const result =
				mode === "explicit"
					? await item.manager.hover(item.path, "symbol")
					: await item.manager.getDiagnostics(item.path, "symbol\n");
			expect(result.outcome).toBe("unavailable");
			expect(result.text).toContain("Install command succeeded");
			expect(result.text).toContain("inherited PATH");
			expect(result.text).toContain("lsp.servers.rust.command");
			expect(result.text).toContain("/reload");
			expect(result.text).toContain("/lsp restart");
			expect(ran(item)).toEqual([["running", "failed"]]);
			expect(item.manager.getStatus().find((entry) => entry.name === "rust")).toMatchObject({
				state: "failed",
				breaker: "closed",
				lastError: expect.stringContaining("Install command succeeded"),
			});
			await item.manager.hover(item.path, "symbol");
			await item.manager.hover(item.path, "symbol");
			expect(item.requestAction).toHaveBeenCalledTimes(1);
			expect(item.installRunner).toHaveBeenCalledTimes(1);
			expect(item.manager.getStatus().find((entry) => entry.name === "rust")?.breaker).toBe("open");

			const installed = launcher(item.component);
			copyFileSync(installed, join(item.bin, process.platform === "win32" ? "rust-analyzer.cmd" : "rust-analyzer"));
			item.manager.restart();
			expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
			expect(item.installRunner).toHaveBeenCalledTimes(1);
		},
	);

	it("reports readiness only after successful initialization", async () => {
		const item = fixture((bin) => launcher(bin));
		expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
		expect(item.completionStates).toEqual(["ready"]);
		expect(ran(item)).toEqual([["running", "completed"]]);
		expect(report(item)).toContain("initialize succeeded");
	});

	it("distinguishes a successful installer from a failed handshake without double-counting failures", async () => {
		const item = fixture((bin) => launcher(bin, ["--init-error"]));
		const result = await item.manager.hover(item.path, "symbol");
		expect(result.outcome).toBe("unavailable");
		expect(result.text).toContain("Install command succeeded");
		expect(result.text).toContain("initialize failed");
		expect(result.reason).not.toBe("missing-executable");
		expect(ran(item)).toEqual([["running", "failed"]]);
		await item.manager.hover(item.path, "symbol");
		expect(item.manager.getStatus().find((entry) => entry.name === "rust")?.breaker).toBe("closed");
		await item.manager.hover(item.path, "symbol");
		expect(item.manager.getStatus().find((entry) => entry.name === "rust")?.breaker).toBe("open");
	});

	it.each([
		{ firstRoot: "healthy", failBroken: true },
		{ firstRoot: "broken", failBroken: true },
		{ firstRoot: "healthy", failBroken: false },
	])(
		"reports one install outcome with $firstRoot finishing first (failure=$failBroken)",
		async ({ firstRoot, failBroken }) => {
			const installGate = Promise.withResolvers<void>();
			const delayedRootGate = Promise.withResolvers<void>();
			const firstRootSettled = Promise.withResolvers<void>();
			const item = fixture((bin) => {
				const executable = launcher(bin);
				if (!failBroken) return;
				writeFileSync(
					executable,
					process.platform === "win32"
						? `@if /I "%CD%"=="${join(item.root, "broken")}" (\r\n@"${process.execPath}" "${fake}" --init-error\r\n) else (\r\n@"${process.execPath}" "${fake}"\r\n)\r\n`
						: `#!/bin/sh\ncase "$PWD" in */broken) set -- --init-error ;; esac\nexec '${process.execPath}' '${fake}' "$@"\n`,
				);
			});
			const paths = ["broken", "healthy"].map((name) => {
				const root = join(item.root, name);
				mkdirSync(root);
				writeFileSync(join(root, "Cargo.toml"), "");
				const path = join(root, "main.rs");
				writeFileSync(path, "symbol\n");
				return path;
			});
			const install = item.installRunner.getMockImplementation()!;
			item.installRunner.mockImplementation(async () => {
				await installGate.promise;
				return install();
			});
			const start = LspClient.prototype.start;
			vi.spyOn(LspClient.prototype, "start").mockImplementation(async function (this: LspClient) {
				const finishesFirst = this.rootDir.endsWith(firstRoot);
				if (!finishesFirst) await delayedRootGate.promise;
				try {
					await start.call(this);
				} finally {
					if (finishesFirst) firstRootSettled.resolve();
				}
			});
			const pending = Promise.all(paths.map((path) => item.manager.hover(path, "symbol")));
			try {
				// Both operations must join the install before its executable becomes available.
				await expect
					.poll(
						() => item.manager.getStatus().filter((entry) => entry.name === "rust" && entry.attempts > 0).length,
					)
					.toBe(2);
				installGate.resolve();
				await firstRootSettled.promise;
				delayedRootGate.resolve();
				const results = await pending;
				expect(results.map((result) => result.outcome)).toEqual([
					failBroken ? "unavailable" : "success",
					"success",
				]);
				expect(item.installRunner).toHaveBeenCalledTimes(1);
				expect(item.requestAction).toHaveBeenCalledTimes(1);
				// One action for both roots, reporting the outcome of each.
				expect(ran(item)).toEqual([["running", failBroken ? "failed" : "completed"]]);
				expect(report(item)).toContain("broken");
				if (failBroken) {
					expect(report(item)).toContain("initialize failed");
					expect(report(item)).toContain("/lsp restart");
				}
				expect(item.manager.getStatus().find((entry) => entry.root.endsWith("broken"))).toMatchObject({
					state: failBroken ? "failed" : "ready",
					breaker: "closed",
				});
				expect(item.manager.getStatus().find((entry) => entry.root.endsWith("healthy"))).toMatchObject({
					state: "ready",
					breaker: "closed",
				});
			} finally {
				installGate.resolve();
				delayedRootGate.resolve();
				await pending;
			}
		},
	);

	it("finishes verification even after the installing caller cancels", async () => {
		const item = fixture((bin) => launcher(bin));
		const controller = new AbortController();
		item.installRunner.mockImplementationOnce(async () => {
			launcher(item.bin);
			controller.abort();
			return { exitCode: 0, output: "installed" };
		});
		expect(await item.manager.hover(item.path, "symbol", undefined, controller.signal)).toMatchObject({
			outcome: "cancelled",
		});
		await expect.poll(() => item.host.finished.at(-1)?.outcome).toBe("completed");
		expect(item.manager.getStatus().find((entry) => entry.name === "rust")).toMatchObject({
			alive: true,
			serverInfo: { name: "fake-lsp" },
			breaker: "closed",
		});
		expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
	});

	it.each([
		{ mode: "explicit", lifecycle: "restart" },
		{ mode: "automatic", lifecycle: "restart" },
		{ mode: "explicit", lifecycle: "dispose" },
		{ mode: "automatic", lifecycle: "dispose" },
	] as const)(
		"does not restore failures when a pending approval ends on $lifecycle ($mode)",
		async ({ mode, lifecycle }) => {
			const item = fixture((bin) => launcher(bin));
			const promptStarted = Promise.withResolvers<void>();
			item.requestAction.mockImplementationOnce(() => {
				promptStarted.resolve();
				// Never answered: the restart or dispose withdraws it.
				return new Promise<HostResponse & { decision: "approved" }>(() => {});
			});
			const pending =
				mode === "explicit"
					? item.manager.hover(item.path, "symbol")
					: item.manager.getDiagnostics(item.path, "symbol\n");
			await promptStarted.promise;
			item.manager[lifecycle]();
			expect(await pending).toMatchObject({ outcome: "cancelled", reason: "aborted" });
			const status = item.manager.getStatus().find((entry) => entry.name === "rust");
			expect(status).toMatchObject({ state: "unused", attempts: 0, breaker: "closed" });
			expect(status?.lastError).toBeUndefined();
			expect(item.requestAction).toHaveBeenCalledTimes(1);
			expect(item.installRunner).not.toHaveBeenCalled();
			await vi.waitFor(() => expect(item.host.records()[0]).toMatchObject({ outcome: "cancelled" }));
			expect(item.host.records()[0]?.progress).toBeUndefined();

			if (lifecycle === "restart") {
				expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
				expect(item.requestAction).toHaveBeenCalledTimes(2);
				expect(item.installRunner).toHaveBeenCalledTimes(1);
				expect(item.manager.getStatus().find((entry) => entry.name === "rust")).toMatchObject({
					state: "ready",
					breaker: "closed",
				});
			}
		},
	);

	it.each([
		{ lifecycle: "restart", timing: "installer-result" },
		{ lifecycle: "dispose", timing: "installer-result" },
		{ lifecycle: "restart", timing: "installer-running" },
		{ lifecycle: "dispose", timing: "installer-running" },
	] as const)("finalizes a successful install cancelled by $lifecycle at $timing", async ({ lifecycle, timing }) => {
		const item = fixture();
		const installStarted = Promise.withResolvers<void>();
		const installResult = Promise.withResolvers<{ exitCode: number; output: string }>();
		item.installRunner.mockImplementationOnce(() => {
			installStarted.resolve();
			return installResult.promise;
		});
		const start = vi.spyOn(LspClient.prototype, "start");
		const pending = item.manager.hover(item.path, "symbol");
		await installStarted.promise;
		launcher(item.bin);
		if (timing === "installer-running") {
			// Cancelled while the installer runs; it ignores the abort and succeeds anyway.
			item.manager[lifecycle]();
			installResult.resolve({ exitCode: 0, output: "installed" });
		} else {
			// Cancelled after the installer succeeded, before the action read its result.
			installResult.resolve({ exitCode: 0, output: "installed" });
			item.manager[lifecycle]();
		}
		expect(await pending).toMatchObject({ outcome: "cancelled", reason: "aborted" });
		await vi.waitFor(() => expect(cancelledAfterRunning(item)).toBe(true));
		expect(item.host.finished[0]).toMatchObject({ kind: "host_action", input: { action: "lsp.install_server" } });
		expect(start).not.toHaveBeenCalled();
		const status = item.manager.getStatus().find((entry) => entry.name === "rust");
		expect(status).toMatchObject({ state: "unused", attempts: 0, breaker: "closed" });
		expect(status?.lastError).toBeUndefined();
		if (lifecycle === "restart") {
			expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
			expect(item.installRunner).toHaveBeenCalledTimes(1);
		}
	});

	it("still reports a host action that fails to ask when the install attempt has not been cancelled", async () => {
		const item = fixture();
		const manager = new LspManager({
			cwd: item.root,
			config: resolveLspConfig({ idleShutdownMs: 0 }),
			hostActions: {
				run: async () => {
					throw new Error("Host prompt unavailable");
				},
			},
			installRunner: item.installRunner,
		});
		managers.push(manager);
		expect(await manager.hover(item.path, "symbol")).toMatchObject({
			outcome: "unavailable",
			text: expect.stringContaining("LSP install prompt failed: Host prompt unavailable"),
		});
		expect(manager.getStatus().find((entry) => entry.name === "rust")).toMatchObject({
			state: "failed",
			lastError: expect.stringContaining("Host prompt unavailable"),
		});
		expect(item.installRunner).not.toHaveBeenCalled();
	});

	it("cancels obsolete verification on restart without poisoning the replacement", async () => {
		const item = fixture((bin) => launcher(bin, ["--hang-initialize"]));
		// Leave the obsolete launcher untouched: rewriting it here races teardown of
		// the just-killed Windows process tree, and a failed write would surface only
		// as the expected cancellation, leaving the replacement to hang.
		const replacement = join(item.root, "replacement");
		mkdirSync(replacement);
		launcher(replacement);
		const start = LspClient.prototype.start;
		vi.spyOn(LspClient.prototype, "start").mockImplementationOnce(function (this: LspClient) {
			const startup = start.call(this);
			item.manager.restart();
			vi.stubEnv("PATH", replacement);
			return startup;
		});
		expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "cancelled" });
		await vi.waitFor(() => expect(cancelledAfterRunning(item)).toBe(true));
		expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
		expect(item.manager.getStatus().find((entry) => entry.name === "rust")).toMatchObject({
			state: "ready",
			breaker: "closed",
		});
	});

	it.skipIf(process.platform === "win32")("reports an installed but non-executable launcher", async () => {
		const item = fixture((bin) => chmodSync(launcher(bin), 0o644));
		expect(await item.manager.hover(item.path, "symbol")).toMatchObject({
			outcome: "unavailable",
			reason: "unusable-executable",
		});
		await vi.waitFor(() => expect(ran(item)).toEqual([["running", "failed"]]));
		expect(report(item)).toContain("EACCES");
	});

	it("reloads an explicit command in the same conversation without extensions or a daemon restart", async () => {
		const item = fixture();
		const explicit = launcher(item.component);
		const harness = await createHarness({
			settings: { lsp: { idleShutdownMs: 0 } },
			initialActiveToolNames: ["lsp"],
		});
		// Use the real installer process boundary, but a harmless rustup fixture.
		const rustup = join(item.bin, process.platform === "win32" ? "rustup.cmd" : "rustup");
		writeFileSync(rustup, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
		chmodSync(rustup, 0o755);
		// A client of the conversation approves the install it is asked.
		const { liveState } = harness.session;
		liveState.attach("approver", {
			acceptsHostRequest: (kind) => kind === "approval",
			apply: (update) => {
				for (const entry of update.items) {
					if (entry.type !== "set" || entry.value.kind !== "host_request") continue;
					const { requestId } = entry.value;
					queueMicrotask(() => liveState.answer(requestId, { decision: "approved" }, "approver"));
				}
			},
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("lsp", { action: "hover", path: item.path, symbol: "symbol" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("not ready"),
			]);
			await harness.session.prompt("Inspect the Rust symbol");
			const install = harness.session.work.list().filter((record) => record.kind === "host_action");
			expect(install).toEqual([
				expect.objectContaining({
					state: "running",
					outcome: "failed",
					error: expect.stringContaining("Install command succeeded"),
				}),
			]);
			const sessionId = harness.sessionManager.getSessionId();
			const messages = [...harness.session.messages];
			harness.settingsManager.applyOverrides({ lsp: { servers: { rust: { command: [explicit] } } } });
			await harness.session.reload();
			expect(harness.sessionManager.getSessionId()).toBe(sessionId);
			expect(harness.session.messages).toEqual(messages);
			// Reload clears runtime-only model and API registrations, including the harness's faux provider.
			// The log still names the harness model, so register its provider again.
			harness.session.modelRegistry.client.registerProvider(harness.faux);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("lsp", { action: "hover", path: item.path, symbol: "symbol" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("ready"),
			]);
			await harness.session.prompt("Retry the Rust symbol");
			const results = harness.session.messages.filter((message) => message.role === "toolResult");
			expect(
				results.map((message) => message.isError),
				JSON.stringify(results.at(-1)),
			).toEqual([true, false]);
			expect(
				harness.session.getLspStatus().servers.find((entry) => entry.name === "rust" && entry.state === "ready")
					?.resolvedExecutable,
			).toBe(explicit);
		} finally {
			await harness.cleanupAsync();
		}
	});
});
