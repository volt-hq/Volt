import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostActionUpdate, HostInteraction } from "../src/core/host-interaction.ts";
import { type ResolvedLspConfig, resolveLspConfig } from "../src/core/lsp/config.ts";
import { type LspInstallRunner, LspManager } from "../src/core/lsp/manager.ts";
import { LspServerPool } from "../src/core/lsp/server-pool.ts";

const FAKE_SERVER = join(__dirname, "fixtures", "fake-lsp-server.mjs");
const roots: string[] = [];
const views: LspManager[] = [];

function tempRoot(prefix: string): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	roots.push(root);
	return root;
}

function fakeConfig(
	eventLog: string,
	options: {
		args?: string[];
		settleMs?: number;
		severity?: "error" | "warning";
		maxDiagnostics?: number;
		autoDiagnostics?: boolean;
		serverAutoDiagnostics?: boolean;
		failingBar?: boolean;
	} = {},
): ResolvedLspConfig {
	return resolveLspConfig({
		enabled: true,
		settleMs: options.settleMs ?? 3000,
		severity: options.severity,
		maxDiagnostics: options.maxDiagnostics,
		autoDiagnostics: options.autoDiagnostics,
		idleShutdownMs: 0,
		servers: {
			typescript: { enabled: false },
			python: { enabled: false },
			go: { enabled: false },
			rust: { enabled: false },
			fake: {
				command: [process.execPath, FAKE_SERVER, "--event-log", eventLog, ...(options.args ?? [])],
				fileExtensions: [".foo"],
				rootMarkers: [],
				autoDiagnostics: options.serverAutoDiagnostics,
			},
			...(options.failingBar
				? {
						broken: {
							command: [process.execPath, FAKE_SERVER, "--init-error"],
							fileExtensions: [".bar"],
							rootMarkers: [],
						},
					}
				: {}),
		},
	});
}

function startedServers(eventLog: string): number[] {
	if (!existsSync(eventLog)) return [];
	return readFileSync(eventLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; pid: number })
		.filter((event) => event.type === "started")
		.map((event) => event.pid);
}

function exitedServers(eventLog: string): number[] {
	if (!existsSync(eventLog)) return [];
	return readFileSync(eventLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; pid: number })
		.filter((event) => event.type === "exited")
		.map((event) => event.pid);
}

function fixture() {
	const root = tempRoot("volt-lsp-pool-");
	const eventLog = join(root, "events.jsonl");
	const pool = new LspServerPool();
	const config = fakeConfig(eventLog);
	const view = (viewConfig: ResolvedLspConfig = config, projectCwd = root): LspManager => {
		const manager = new LspManager({
			cwd: root,
			config: viewConfig,
			server: pool.acquire({ projectCwd, config: viewConfig }),
		});
		views.push(manager);
		return manager;
	};
	const file = (name: string, content: string): string => {
		const path = join(root, name);
		writeFileSync(path, content);
		return path;
	};
	return { root, eventLog, pool, config, view, file };
}

afterEach(async () => {
	for (const view of views.splice(0)) view.dispose();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
	);
});

describe("LspServerPool", () => {
	it("starts one server for views with the same project and server settings", async () => {
		const { eventLog, view, file } = fixture();
		const path = file("a.foo", "symbol\n");
		const first = view();
		const second = view();

		expect(await first.hover(path, "symbol")).toMatchObject({ outcome: "success" });
		expect(await second.hover(path, "symbol")).toMatchObject({ outcome: "success" });
		expect(startedServers(eventLog)).toHaveLength(1);
		expect(second.getStatus().find((entry) => entry.name === "fake")).toMatchObject({ state: "ready", alive: true });
	});

	it("shares across reporting settings but not across server identity or project", () => {
		const { root, eventLog, pool, config } = fixture();
		const lease = pool.acquire({ projectCwd: root, config });
		const reporting = pool.acquire({
			projectCwd: root,
			config: fakeConfig(eventLog, {
				settleMs: 10,
				severity: "warning",
				maxDiagnostics: 3,
				autoDiagnostics: false,
				serverAutoDiagnostics: false,
			}),
		});
		const identity = pool.acquire({ projectCwd: root, config: fakeConfig(eventLog, { args: ["--pull"] }) });
		const otherProject = pool.acquire({ projectCwd: tempRoot("volt-lsp-pool-other-"), config });
		try {
			expect(reporting.core).toBe(lease.core);
			expect(identity.core).not.toBe(lease.core);
			expect(otherProject.core).not.toBe(lease.core);
		} finally {
			for (const entry of [lease, reporting, identity, otherProject]) entry.release();
		}
	});

	it("keeps servers running until the last view is disposed", async () => {
		const { eventLog, pool, root, config, view, file } = fixture();
		const path = file("a.foo", "symbol\n");
		const first = view();
		const second = view();
		expect(await first.hover(path, "symbol")).toMatchObject({ outcome: "success" });

		first.dispose();
		expect(await second.hover(path, "symbol")).toMatchObject({ outcome: "success" });
		expect(startedServers(eventLog)).toHaveLength(1);

		second.dispose();
		await expect.poll(() => exitedServers(eventLog)).toEqual(startedServers(eventLog));
		// A new lease after the last release starts a fresh core.
		const next = pool.acquire({ projectCwd: root, config });
		expect(next.core.isDisposed).toBe(false);
		next.release();
	});

	it("reports start failures once per view while sharing the breaker", async () => {
		const { eventLog, view, file } = fixture();
		const config = fakeConfig(eventLog, { args: ["--init-error"] });
		const path = file("a.foo", "symbol\n");
		const first = view(config);
		const second = view(config);

		expect((await first.getDiagnostics(path, "symbol\n")).text).toContain("further failures for this server root");
		expect((await first.getDiagnostics(path, "symbol\n")).text).toBe("");
		expect(first.getStatus().find((entry) => entry.name === "fake")?.breaker).toBe("closed");
		// The other session has not seen this failure yet, although it opens the shared breaker.
		expect((await second.getDiagnostics(path, "symbol\n")).text).toContain("further failures for this server root");
		expect(second.getStatus().find((entry) => entry.name === "fake")?.breaker).toBe("open");
		expect(await first.getDiagnostics(path, "symbol\n")).toMatchObject({ reason: "breaker-open" });
	});

	it("keeps diagnostic delivery history per view and resets every view on restart", async () => {
		const { eventLog, view, file } = fixture();
		const content = "has ERROR\n";
		const path = file("a.foo", content);
		const first = view();
		const second = view();

		expect((await first.getDiagnostics(path, content)).text).toContain("found ERROR on line 1");
		// Another session's delivery does not suppress this session's first report.
		expect((await second.getDiagnostics(path, content)).text).toContain("found ERROR on line 1");
		expect((await second.getDiagnostics(path, content)).text).toBe("");

		expect(first.restart()).toBe(1);
		expect(second.getStatus().find((entry) => entry.name === "fake")?.alive).toBe(false);
		expect((await second.getDiagnostics(path, content)).text).toContain("found ERROR on line 1");
		expect(startedServers(eventLog)).toHaveLength(2);
	});

	it("limits newly failing cross-file reports to documents the view synced", async () => {
		const { view, file } = fixture();
		const dependent = file("dependent.foo", "watch CROSS here\n");
		const edited = file("edited.foo", "fine\n");
		const owner = view();
		const other = view();

		expect((await owner.getDiagnostics(dependent, "watch CROSS here\n")).text).toBe("");
		expect((await other.getDiagnostics(edited, "fine\n")).text).toBe("");
		writeFileSync(edited, "now has ERROR\n");
		const result = (await other.getDiagnostics(edited, "now has ERROR\n")).text;

		expect(result).toContain("found ERROR on line 1");
		expect(result).not.toContain("Newly failing");
		// The dependent file is failing; it is just not attributed to the other session's edit.
		expect((await owner.fileDiagnostics(dependent)).text).toContain("cross-file ERROR detected");
	});

	it("resets failed-start state without stopping healthy servers", async () => {
		const { eventLog, view, file } = fixture();
		const config = fakeConfig(eventLog, { failingBar: true });
		const healthy = file("a.foo", "symbol\n");
		const broken = file("b.bar", "symbol\n");
		const manager = view(config);

		expect(await manager.hover(healthy, "symbol")).toMatchObject({ outcome: "success" });
		for (let attempt = 0; attempt < 3; attempt++) await manager.hover(broken, "symbol");
		expect(manager.getStatus().find((entry) => entry.name === "broken")?.breaker).toBe("open");

		manager.resetFailures();

		expect(manager.getStatus().find((entry) => entry.name === "broken")).toMatchObject({
			breaker: "closed",
			attempts: 0,
		});
		expect(manager.getStatus().find((entry) => entry.name === "fake")).toMatchObject({ state: "ready", alive: true });
		expect(startedServers(eventLog)).toHaveLength(1);
	});
});

describe("shared install prompts and breaker", () => {
	const fake = FAKE_SERVER;

	function launcher(directory: string): void {
		const path = join(directory, process.platform === "win32" ? "rust-analyzer.cmd" : "rust-analyzer");
		writeFileSync(
			path,
			process.platform === "win32"
				? `@"${process.execPath}" "${fake}" %*\r\n`
				: `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`,
		);
		chmodSync(path, 0o755);
	}

	function host(decision: "approved" | "denied" | "unavailable") {
		const updates: HostActionUpdate[] = [];
		const requestAction = vi.fn<HostInteraction["requestAction"]>(async () => ({ decision }));
		const interaction: HostInteraction = {
			requestAction,
			updateAction: (update) => {
				updates.push(update);
			},
		};
		return { interaction, requestAction, updates };
	}

	function rustFixture() {
		const root = tempRoot("volt-lsp-pool-install-");
		const bin = join(root, "bin");
		mkdirSync(bin);
		const path = join(root, "main.rs");
		writeFileSync(path, "symbol\n");
		vi.stubEnv("PATH", bin);
		vi.stubEnv("VOLT_OFFLINE", "0");
		const installRunner = vi.fn<LspInstallRunner>(async () => {
			launcher(bin);
			return { exitCode: 0, output: "component installed" };
		});
		const pool = new LspServerPool();
		const config = resolveLspConfig({ idleShutdownMs: 0 });
		const view = (interaction: HostInteraction): LspManager => {
			const manager = new LspManager({
				cwd: root,
				config,
				hostInteraction: interaction,
				server: pool.acquire({ projectCwd: root, config, installRunner }),
			});
			views.push(manager);
			return manager;
		};
		const rust = (manager: LspManager) => manager.getStatus().find((entry) => entry.name === "rust");
		return { path, installRunner, view, rust };
	}

	it("does not use up the install offer when a host cannot prompt", async () => {
		const { path, installRunner, view } = rustFixture();
		const subagent = host("unavailable");
		const parent = host("approved");
		const child = view(subagent.interaction);
		const main = view(parent.interaction);

		expect(await child.hover(path, "symbol")).toMatchObject({ outcome: "unavailable" });
		expect(subagent.requestAction).toHaveBeenCalledTimes(1);
		expect(installRunner).not.toHaveBeenCalled();

		expect(await main.hover(path, "symbol")).toMatchObject({ outcome: "success" });
		expect(parent.requestAction).toHaveBeenCalledTimes(1);
		expect(installRunner).toHaveBeenCalledTimes(1);
		expect(parent.updates.map((update) => update.status)).toEqual(["running", "completed"]);
		expect(subagent.updates).toEqual([]);
		expect(await child.hover(path, "symbol")).toMatchObject({ outcome: "success" });
	});

	it("offers the install once to a prompt-capable view after other views opened the breaker", async () => {
		const { path, installRunner, view, rust } = rustFixture();
		const subagent = host("unavailable");
		const child = view(subagent.interaction);
		for (let attempt = 0; attempt < 3; attempt++) await child.hover(path, "symbol");
		expect(rust(child)?.breaker).toBe("open");

		const parent = host("approved");
		const main = view(parent.interaction);
		expect(await main.hover(path, "symbol")).toMatchObject({ outcome: "success" });
		expect(parent.requestAction).toHaveBeenCalledTimes(1);
		expect(installRunner).toHaveBeenCalledTimes(1);
		expect(rust(main)).toMatchObject({ state: "ready", breaker: "closed" });
	});

	it("does not repeat a declined install offer past the breaker", async () => {
		const { path, installRunner, view } = rustFixture();
		const child = view(host("unavailable").interaction);
		for (let attempt = 0; attempt < 3; attempt++) await child.hover(path, "symbol");

		const parent = host("denied");
		const main = view(parent.interaction);
		expect(await main.hover(path, "symbol")).toMatchObject({ outcome: "unavailable" });
		expect(await main.hover(path, "symbol")).toMatchObject({ reason: "breaker-open" });
		expect(parent.requestAction).toHaveBeenCalledTimes(1);
		expect(installRunner).not.toHaveBeenCalled();
	});

	it("stops only the disposed view's wait on a shared install", async () => {
		const { path, installRunner, view, rust } = rustFixture();
		const gate = Promise.withResolvers<void>();
		const install = installRunner.getMockImplementation()!;
		installRunner.mockImplementation(async (command, options) => {
			await gate.promise;
			return install(command, options);
		});
		const initiator = host("approved");
		const joiner = host("approved");
		const first = view(initiator.interaction);
		const second = view(joiner.interaction);

		const initiating = first.hover(path, "symbol");
		await expect.poll(() => installRunner.mock.calls.length).toBe(1);
		const joining = second.hover(path, "symbol");
		// The second view resolved the missing launcher and joined the pending install.
		await expect.poll(() => rust(first)?.attempts).toBe(2);
		second.dispose();
		expect(await joining).toMatchObject({ outcome: "cancelled" });

		gate.resolve();
		expect(await initiating).toMatchObject({ outcome: "success" });
		expect(joiner.requestAction).not.toHaveBeenCalled();
		expect(joiner.updates).toEqual([]);
		expect(initiator.updates.map((update) => update.status)).toEqual(["running", "completed"]);
	});
});
