import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostActionUpdate, HostInteraction } from "../../../src/core/host-interaction.ts";
import { LspClient } from "../../../src/core/lsp/client.ts";
import { resolveLspConfig } from "../../../src/core/lsp/config.ts";
import { LspManager } from "../../../src/core/lsp/manager.ts";
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
	const updates: HostActionUpdate[] = [];
	const completionStates: string[] = [];
	const requestAction = vi.fn<HostInteraction["requestAction"]>(async () => ({ decision: "approved" }));
	const installRunner = vi.fn(async () => {
		install(bin, component);
		return { exitCode: 0, output: "component installed" };
	});
	const manager = new LspManager({
		cwd: root,
		config: resolveLspConfig({ idleShutdownMs: 0 }),
		hostInteraction: {
			requestAction,
			updateAction: (update) => {
				updates.push(update);
				if (update.status === "completed")
					completionStates.push(manager.getStatus().find((entry) => entry.name === "rust")?.state ?? "unknown");
			},
		},
		installRunner,
	});
	managers.push(manager);
	return { manager, root, bin, component, path, updates, completionStates, requestAction, installRunner };
}

afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
			expect(item.updates.map((update) => update.status)).toEqual(["running", "failed"]);
			expect(item.updates.at(-1)?.exitCode).toBe(0);
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
		expect(item.updates.map((update) => update.status)).toEqual(["running", "completed"]);
		expect(item.updates.at(-1)?.message).toContain("initialize succeeded");
	});

	it("distinguishes a successful installer from a failed handshake without double-counting failures", async () => {
		const item = fixture((bin) => launcher(bin, ["--init-error"]));
		const result = await item.manager.hover(item.path, "symbol");
		expect(result.outcome).toBe("unavailable");
		expect(result.text).toContain("Install command succeeded");
		expect(result.text).toContain("initialize failed");
		expect(result.reason).not.toBe("missing-executable");
		expect(item.updates.map((update) => update.status)).toEqual(["running", "failed"]);
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
				expect(item.updates.map((update) => update.status)).toEqual([
					"running",
					failBroken ? "failed" : "completed",
				]);
				expect(new Set(item.updates.map((update) => update.id)).size).toBe(1);
				expect(item.updates.at(-1)).toMatchObject({ exitCode: 0, message: expect.stringContaining("broken") });
				if (failBroken) {
					expect(item.updates.at(-1)?.message).toContain("initialize failed");
					expect(item.updates.at(-1)?.message).toContain("/lsp restart");
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
		await expect.poll(() => item.updates.at(-1)?.status).toBe("completed");
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
	] as const)("does not restore failures when a prompt rejects on $lifecycle ($mode)", async ({ mode, lifecycle }) => {
		const item = fixture((bin) => launcher(bin));
		const promptStarted = Promise.withResolvers<void>();
		item.requestAction.mockImplementationOnce((_request, options) => {
			promptStarted.resolve();
			return new Promise((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => reject(new Error("Host action aborted")), { once: true });
			});
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

		if (lifecycle === "restart") {
			expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
			expect(item.requestAction).toHaveBeenCalledTimes(2);
			expect(item.installRunner).toHaveBeenCalledTimes(1);
			expect(item.manager.getStatus().find((entry) => entry.name === "rust")).toMatchObject({
				state: "ready",
				breaker: "closed",
			});
		}
	});

	it("still reports prompt rejections when the install attempt has not been cancelled", async () => {
		const item = fixture();
		item.requestAction.mockRejectedValueOnce(new Error("Host prompt unavailable"));
		expect(await item.manager.hover(item.path, "symbol")).toMatchObject({
			outcome: "unavailable",
			text: expect.stringContaining("LSP install prompt failed: Host prompt unavailable"),
		});
		expect(item.manager.getStatus().find((entry) => entry.name === "rust")).toMatchObject({
			state: "failed",
			lastError: expect.stringContaining("Host prompt unavailable"),
		});
		expect(item.installRunner).not.toHaveBeenCalled();
	});

	it("cancels obsolete verification on restart without poisoning the replacement", async () => {
		const item = fixture((bin) => launcher(bin, ["--hang-initialize"]));
		const start = LspClient.prototype.start;
		vi.spyOn(LspClient.prototype, "start").mockImplementationOnce(function (this: LspClient) {
			const startup = start.call(this);
			item.manager.restart();
			launcher(item.bin);
			return startup;
		});
		expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "cancelled" });
		expect(item.updates.map((update) => update.status)).toEqual(["running", "cancelled"]);
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
		expect(item.updates.at(-1)).toMatchObject({
			status: "failed",
			exitCode: 0,
			message: expect.stringContaining("EACCES"),
		});
	});

	it("reloads an explicit command in the same conversation without extensions or a daemon restart", async () => {
		const item = fixture();
		const explicit = launcher(item.component);
		const harness = await createHarness({
			settings: { lsp: { idleShutdownMs: 0 } },
			initialActiveToolNames: ["lsp"],
		});
		const updates: HostActionUpdate[] = [];
		let reloadedFaux: ReturnType<typeof registerFauxProvider> | undefined;
		// Use the real installer process boundary, but a harmless rustup fixture.
		const rustup = join(item.bin, process.platform === "win32" ? "rustup.cmd" : "rustup");
		writeFileSync(rustup, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
		chmodSync(rustup, 0o755);
		harness.session.setHostInteraction({
			requestAction: async () => ({ decision: "approved" }),
			updateAction: (update) => {
				updates.push(update);
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
			expect(updates.at(-1)?.message).toContain("Install command succeeded");
			const sessionId = harness.sessionManager.getSessionId();
			const messages = [...harness.session.messages];
			harness.settingsManager.applyOverrides({ lsp: { servers: { rust: { command: [explicit] } } } });
			await harness.session.reload();
			expect(harness.sessionManager.getSessionId()).toBe(sessionId);
			expect(harness.session.messages).toEqual(messages);
			// Reload clears runtime-only model and API registrations, including the harness's faux provider.
			reloadedFaux = registerFauxProvider();
			await harness.session.setModel(reloadedFaux.getModel());
			reloadedFaux.setResponses([
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
			reloadedFaux?.unregister();
			await harness.cleanupAsync();
		}
	});
});
