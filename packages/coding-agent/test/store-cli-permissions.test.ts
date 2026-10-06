/**
 * `volt store install` and `volt store update` review an extension package's
 * permissions as `volt install` does (RFC §8.2). Without a terminal, an update
 * to a catalog package's new pin reads the new pin's manifest before
 * installing it, and keeps the installed pin when the new one declares
 * permissions the installed one does not.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionPermission } from "@hansjm10/volt-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { promptConfirm } from "../src/daemon/cli.ts";
import type { StorePackageInspection } from "../src/store/inspector.ts";
import { handleStoreCommand } from "../src/store/store-cli.ts";
import {
	NEXT_TEST_STORE_COMMIT,
	TEST_STORE_COMMIT,
	testCatalog,
	testCatalogEntry,
	testStoreSource,
} from "./store-catalog-fixtures.ts";

// No importOriginal: the real module imports package-manager-cli.ts, which would bind to its unmocked exports.
vi.mock("../src/daemon/cli.ts", () => ({
	daemonStop: vi.fn(),
	promptConfirm: vi.fn(),
}));

// Inspection would clone the catalog's git pins: it reports the manifest each test gives it.
const inspectorMock = vi.hoisted(() => ({
	inspectStorePackage: vi.fn(),
}));

vi.mock("../src/store/inspector.ts", () => ({
	inspectStorePackage: inspectorMock.inspectStorePackage,
}));

function inspection(source: string, permissions?: ExtensionPermission[]): StorePackageInspection {
	return {
		source,
		packageName: "volt-rtk-extension",
		packageVersion: "0.2.0",
		volt:
			permissions === undefined
				? {}
				: { manifest: { id: "rtk", displayName: "RTK Output Compression", entry: "index.js", permissions } },
		discoveredResources: { extensions: ["."], skills: [], prompts: [], themes: [] },
		dependencies: {},
		peerDependencies: {},
		optionalDependencies: {},
		scripts: {},
		warnings: [],
	};
}

describe("store CLI permission review", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let logs: string[];
	const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };

	function setTerminal(interactive: boolean): void {
		Object.defineProperty(process.stdin, "isTTY", { value: interactive, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: interactive, configurable: true });
	}

	/** A package root declaring the rtk extension with `permissions`, under `parent` (the temporary directory). */
	function writePackage(name: string, permissions: ExtensionPermission[], parent = tempDir): string {
		const root = join(parent, name);
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "volt-rtk-extension",
				version: "0.2.0",
				volt: { id: "rtk", displayName: "RTK Output Compression", entry: "index.js", permissions },
			}),
		);
		writeFileSync(join(root, "index.js"), "module.exports = function () {};");
		return root;
	}

	function packages(): unknown[] {
		const path = join(agentDir, "settings.json");
		return existsSync(path)
			? ((JSON.parse(readFileSync(path, "utf-8")) as { packages?: unknown[] }).packages ?? [])
			: [];
	}

	function acknowledged(): Record<string, { permissions: string[]; fingerprint: string }> {
		const path = join(agentDir, "extension-permissions.json");
		return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
	}

	/** The catalog pins rtk to `commit`; the installed pin is the first commit, at `installedRoot`. */
	function catalogUpdate(commit: string, installedRoot: string, updatedRoot?: string) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(testCatalog(testCatalogEntry("rtk", {}, commit)))),
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [testStoreSource()] }, null, 2));
		vi.spyOn(DefaultPackageManager.prototype, "getInstalledPath").mockImplementation((source) =>
			source === testStoreSource() ? installedRoot : source === testStoreSource(commit) ? updatedRoot : undefined,
		);
		return vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue(undefined);
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-store-permissions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		for (const dir of [agentDir, projectDir]) mkdirSync(dir, { recursive: true });
		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
		logs = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		});
		vi.mocked(promptConfirm).mockReset();
		inspectorMock.inspectStorePackage.mockReset();
		process.exitCode = undefined;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		Object.defineProperty(process.stdin, "isTTY", { value: tty.stdin, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: tty.stdout, configurable: true });
		process.chdir(originalCwd);
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
		process.exitCode = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("asks after an install in a terminal, removing the package when declined", async () => {
		setTerminal(true);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(testCatalog())),
		);
		const root = writePackage("rtk", ["exec"]);
		inspectorMock.inspectStorePackage.mockImplementation(async ({ source }) => inspection(source, ["exec"]));

		vi.mocked(promptConfirm).mockResolvedValueOnce(false);
		await handleStoreCommand(["store", "install", root, "--yes"]);
		expect(process.exitCode).toBe(1);
		expect(packages()).toEqual([]);
		expect(acknowledged()).toEqual({});
		expect(logs.join("\n")).toContain("RTK Output Compression (rtk 0.2.0) asks to:");
		expect(logs.join("\n")).toContain("its permissions were not acknowledged");

		process.exitCode = undefined;
		vi.mocked(promptConfirm).mockResolvedValueOnce(true);
		await handleStoreCommand(["store", "install", root, "--yes"]);
		expect(process.exitCode).toBeUndefined();
		expect(packages()).toHaveLength(1);
		expect(acknowledged().rtk).toMatchObject({
			permissions: ["exec"],
			fingerprint: expect.stringMatching(/^local:/),
		});
		expect(promptConfirm).toHaveBeenCalledTimes(2);
	});

	it("reviews a package installed by a path relative to the working directory", async () => {
		setTerminal(true);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(testCatalog())),
		);
		writePackage("rtk", ["exec"], projectDir);
		inspectorMock.inspectStorePackage.mockImplementation(async ({ source }) => inspection(source, ["exec"]));
		vi.mocked(promptConfirm).mockResolvedValueOnce(false);

		await handleStoreCommand(["store", "install", "./rtk", "--yes"]);

		expect(promptConfirm).toHaveBeenCalledOnce();
		expect(process.exitCode).toBe(1);
		expect(packages()).toEqual([]);
		expect(logs.join("\n")).toContain("its permissions were not acknowledged");
	});

	it("lists the permissions after an install without a terminal and leaves them unacknowledged", async () => {
		setTerminal(false);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(testCatalog())),
		);
		const root = writePackage("rtk", ["exec", "secrets"]);
		inspectorMock.inspectStorePackage.mockImplementation(async ({ source }) =>
			inspection(source, ["exec", "secrets"]),
		);

		await handleStoreCommand(["store", "install", root, "--yes"]);
		expect(promptConfirm).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
		expect(packages()).toHaveLength(1);
		expect(acknowledged()).toEqual({});
		const output = logs.join("\n");
		expect(output).toContain("secrets: read stored credentials and API keys");
		expect(output).toContain(`Run "volt store install ${root}" in a terminal to review them.`);
	});

	it("keeps the installed pin when an update without a terminal adds a permission", async () => {
		setTerminal(false);
		const install = catalogUpdate(NEXT_TEST_STORE_COMMIT, writePackage("installed", ["exec"]));
		inspectorMock.inspectStorePackage.mockImplementation(async ({ source }) =>
			inspection(source, ["exec", "network"]),
		);

		await handleStoreCommand(["store", "update", "rtk", "--yes"]);

		expect(inspectorMock.inspectStorePackage).toHaveBeenCalledWith(
			expect.objectContaining({ source: testStoreSource(NEXT_TEST_STORE_COMMIT) }),
		);
		expect(install).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(packages()).toEqual([testStoreSource()]);
		expect(logs.join("\n")).toContain(
			`Kept git github.com/volt-hq/Volt @ ${TEST_STORE_COMMIT.slice(0, 12)}: the new pin adds permissions (network)`,
		);
	});

	it("keeps the installed pin when an update without a terminal cannot read the new pin's manifest", async () => {
		setTerminal(false);
		const install = catalogUpdate(NEXT_TEST_STORE_COMMIT, writePackage("installed", []));
		inspectorMock.inspectStorePackage.mockImplementation(async ({ source }) => inspection(source));

		await handleStoreCommand(["store", "update", "rtk", "--yes"]);

		expect(install).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toContain("its extension manifest at the new pin could not be read");
	});

	it("moves to a new pin without a terminal when it adds no permission, carrying the acknowledgment", async () => {
		setTerminal(false);
		writeFileSync(
			join(agentDir, "extension-permissions.json"),
			JSON.stringify({
				rtk: {
					fingerprint: `git:github.com/volt-hq/Volt@${TEST_STORE_COMMIT}`,
					permissions: ["exec"],
					version: "0.2.0",
					acknowledgedAt: "2026-10-05T00:00:00.000Z",
				},
			}),
		);
		const install = catalogUpdate(
			NEXT_TEST_STORE_COMMIT,
			writePackage("installed", ["exec"]),
			writePackage("updated", ["exec"]),
		);
		inspectorMock.inspectStorePackage.mockImplementation(async ({ source }) => inspection(source, ["exec"]));

		await handleStoreCommand(["store", "update", "rtk", "--yes"]);

		expect(install).toHaveBeenCalledExactlyOnceWith(testStoreSource(NEXT_TEST_STORE_COMMIT), {
			local: false,
			scripts: "never",
		});
		expect(process.exitCode).toBeUndefined();
		expect(promptConfirm).not.toHaveBeenCalled();
		expect(acknowledged().rtk).toMatchObject({
			permissions: ["exec"],
			fingerprint: `git:github.com/volt-hq/Volt@${NEXT_TEST_STORE_COMMIT}`,
		});
	});

	it("asks for an update's new permissions in a terminal and goes back to the installed pin when declined", async () => {
		setTerminal(true);
		const install = catalogUpdate(
			NEXT_TEST_STORE_COMMIT,
			writePackage("installed", ["exec"]),
			writePackage("updated", ["exec", "network"]),
		);
		inspectorMock.inspectStorePackage.mockImplementation(async ({ source }) =>
			inspection(source, ["exec", "network"]),
		);
		vi.mocked(promptConfirm).mockResolvedValueOnce(false);

		await handleStoreCommand(["store", "update", "rtk", "--yes"]);

		expect(promptConfirm).toHaveBeenCalledOnce();
		expect(install.mock.calls).toEqual([
			[testStoreSource(NEXT_TEST_STORE_COMMIT), { local: false, scripts: "never" }],
			[testStoreSource(), { local: false, scripts: "never" }],
		]);
		expect(process.exitCode).toBe(1);
		expect(acknowledged()).toEqual({});
		const output = logs.join("\n");
		expect(output).toContain("network: use the network (not enforced)");
		expect(output).toContain("the update's permissions were not acknowledged");
	});

	it("reviews the revision a declined update reinstalls when the installed source has no commit pin", async () => {
		setTerminal(true);
		const unpinned = "git:https://github.com/volt-hq/Volt";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(testCatalog(testCatalogEntry("rtk", {}, NEXT_TEST_STORE_COMMIT)))),
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [unpinned] }, null, 2));
		const roots = new Map([
			[unpinned, writePackage("installed", ["exec"])],
			[testStoreSource(NEXT_TEST_STORE_COMMIT), writePackage("updated", ["exec", "network"])],
		]);
		vi.spyOn(DefaultPackageManager.prototype, "getInstalledPath").mockImplementation((source) => roots.get(source));
		const install = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue(undefined);
		inspectorMock.inspectStorePackage.mockImplementation(async ({ source }) =>
			inspection(source, ["exec", "network"]),
		);
		vi.mocked(promptConfirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

		await handleStoreCommand(["store", "update", "rtk", "--yes"]);

		expect(install.mock.calls.map(([source]) => source)).toEqual([testStoreSource(NEXT_TEST_STORE_COMMIT), unpinned]);
		// Asked for the new pin, declined, then asked for the head the unpinned source went back to.
		expect(promptConfirm).toHaveBeenCalledTimes(2);
		expect(acknowledged().rtk).toMatchObject({ permissions: ["exec"] });
		expect(process.exitCode).toBe(1);
	});

	it("removes the package when the revision a declined update reinstalls is declined too", async () => {
		setTerminal(true);
		const unpinned = "git:https://github.com/volt-hq/Volt";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(testCatalog(testCatalogEntry("rtk", {}, NEXT_TEST_STORE_COMMIT)))),
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [unpinned] }, null, 2));
		const roots = new Map([
			[unpinned, writePackage("installed", ["exec"])],
			[testStoreSource(NEXT_TEST_STORE_COMMIT), writePackage("updated", ["exec", "network"])],
		]);
		vi.spyOn(DefaultPackageManager.prototype, "getInstalledPath").mockImplementation((source) => roots.get(source));
		vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue(undefined);
		const remove = vi.spyOn(DefaultPackageManager.prototype, "removeAndPersist").mockResolvedValue(true);
		inspectorMock.inspectStorePackage.mockImplementation(async ({ source }) =>
			inspection(source, ["exec", "network"]),
		);
		vi.mocked(promptConfirm).mockResolvedValue(false);

		await handleStoreCommand(["store", "update", "rtk", "--yes"]);

		expect(promptConfirm).toHaveBeenCalledTimes(2);
		expect(remove).toHaveBeenCalledExactlyOnceWith(testStoreSource(NEXT_TEST_STORE_COMMIT), { local: false });
		expect(acknowledged()).toEqual({});
		expect(process.exitCode).toBe(1);
		const output = logs.join("\n");
		expect(output).toContain(
			"Removed git github.com/volt-hq/Volt: the reinstalled revision's permissions were not acknowledged",
		);
		expect(output).not.toContain("Kept git github.com/volt-hq/Volt");
	});

	it("removes a package it installed but cannot find to review", async () => {
		setTerminal(true);
		const install = catalogUpdate(TEST_STORE_COMMIT, writePackage("installed", ["exec"]));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }, null, 2));
		vi.spyOn(DefaultPackageManager.prototype, "getInstalledPath").mockReturnValue(undefined);
		const remove = vi.spyOn(DefaultPackageManager.prototype, "removeAndPersist").mockResolvedValue(true);
		inspectorMock.inspectStorePackage.mockImplementation(async ({ source }) => inspection(source, ["exec"]));

		await handleStoreCommand(["store", "install", "rtk", "--yes"]);

		expect(install).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledExactlyOnceWith(testStoreSource(), { local: false });
		expect(promptConfirm).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toContain("Could not find the installed package to review its permissions");
	});

	it("removes the package when the declined update cannot go back to the installed pin", async () => {
		setTerminal(true);
		const install = catalogUpdate(
			NEXT_TEST_STORE_COMMIT,
			writePackage("installed", ["exec"]),
			writePackage("updated", ["exec", "network"]),
		);
		install
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("git fetch failed: \u001b[31mred\u001b[0m"));
		const remove = vi.spyOn(DefaultPackageManager.prototype, "removeAndPersist").mockResolvedValue(true);
		inspectorMock.inspectStorePackage.mockImplementation(async ({ source }) =>
			inspection(source, ["exec", "network"]),
		);
		vi.mocked(promptConfirm).mockResolvedValueOnce(false);

		await handleStoreCommand(["store", "update", "rtk", "--yes"]);

		expect(install).toHaveBeenCalledTimes(2);
		expect(remove).toHaveBeenCalledExactlyOnceWith(testStoreSource(NEXT_TEST_STORE_COMMIT), { local: false });
		expect(process.exitCode).toBe(1);
		const output = logs.join("\n");
		expect(output).toContain(`Could not reinstall git github.com/volt-hq/Volt @ ${TEST_STORE_COMMIT.slice(0, 12)}`);
		expect(output).toContain("Removed git github.com/volt-hq/Volt");
		expect(output).not.toContain("\u001b[31m");
	});
});
