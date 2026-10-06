/**
 * Store updates and removals: a catalog update of a tracking install moves it
 * to the catalog's reviewed pin, in `volt store update` and the TUI's
 * `/store`, which installs as the TUI (client install, then reload). The TUI
 * reviews an installed package's permissions where it was installed from;
 * declining an update's new permissions reinstalls the reviewed pin and, when
 * that pin follows a branch, reviews what it reinstalled, removing the
 * package when that is declined too.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { PackageInstallOptions } from "../src/core/package-manager.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { main } from "../src/main.ts";
import type { StoreCatalog } from "../src/store/catalog.ts";
import type { StorePackageInspection } from "../src/store/inspector.ts";
import type { ResolveStoreSourceOptions, StoreResolvedSource } from "../src/store/resolver.ts";
import { testCatalog, testCatalogEntry, testStoreSource } from "./store-catalog-fixtures.ts";
import { choose, createTuiHarness, type TuiHarness, type TuiModeFixture, waitForScreen } from "./suite/tui-harness.ts";

const trackedGitSource = "git:https://github.com/volt-hq/Volt";
const pinnedGitSource = testStoreSource();

const resolverMock = vi.hoisted(() => ({
	resolveStoreSource: vi.fn<(options: ResolveStoreSourceOptions) => Promise<StoreResolvedSource>>(),
}));

const inspectorMock = vi.hoisted(() => ({
	inspectStorePackage: vi.fn(
		async (options: { source: string }): Promise<StorePackageInspection> => ({
			source: options.source,
			// Catalog entries declare an extension: an update reads its manifest before installing it.
			volt: { manifest: { id: "rtk", displayName: "RTK Output Compression", entry: "extensions/rtk.ts" } },
			discoveredResources: {
				extensions: [],
				skills: [],
				prompts: [],
				themes: [],
			},
			dependencies: {},
			peerDependencies: {},
			optionalDependencies: {},
			scripts: {},
			warnings: [],
		}),
	),
}));

function resolveCatalogStoreSource(options: ResolveStoreSourceOptions): StoreResolvedSource {
	return {
		input: options.input,
		source: pinnedGitSource,
		kind: "catalog",
		catalogPackage: testCatalogEntry("rtk"),
		pinned: true,
		tracking: false,
		warnings: [],
	};
}

vi.mock("../src/store/resolver.ts", () => ({
	resolveStoreSource: resolverMock.resolveStoreSource,
}));

vi.mock("../src/store/inspector.ts", () => ({
	inspectStorePackage: inspectorMock.inspectStorePackage,
}));

const storeCatalog: StoreCatalog = testCatalog(testCatalogEntry("rtk"));

function createCatalogResponse(): Response {
	return Response.json(storeCatalog);
}

/**
 * The TUI over a host whose global settings are `settings`, in `cwd` when
 * given; the store catalog is served by a stubbed fetch. The host starts
 * offline, so it never installs the packages the settings configure.
 */
async function startTui(
	harnesses: TuiHarness[],
	settings: Record<string, unknown>,
	cwd?: string,
): Promise<{ harness: TuiHarness; tui: TuiModeFixture }> {
	vi.stubEnv("VOLT_OFFLINE", "1");
	const harness = await createTuiHarness({
		globalSettings: { theme: "dark", quietStartup: true, lsp: { enabled: false }, ...settings },
		...(cwd === undefined ? {} : { startup: { cwd } }),
	});
	harnesses.push(harness);
	const tui = await harness.startMode({ columns: 110, rows: 40 });
	vi.stubEnv("VOLT_OFFLINE", "");
	return { harness, tui };
}

/** Write an extension package that declares `permissions` at `directory`. */
function writeExtensionPackage(directory: string, permissions: string[]): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({
			name: "rtk",
			version: "0.2.0",
			volt: { id: "rtk", displayName: "RTK Output Compression", entry: "index.js", permissions },
		}),
	);
	writeFileSync(join(directory, "index.js"), "module.exports = function () {};");
}

describe("catalog updates of a tracking install", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-store-tracked-git-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [trackedGitSource] }, null, 2));
		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
		resolverMock.resolveStoreSource.mockImplementation(async (options) => resolveCatalogStoreSource(options));
		inspectorMock.inspectStorePackage.mockClear();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => createCatalogResponse()),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("moves a tracking install to the reviewed pin during CLI catalog updates", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const updateSpy = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue(undefined);
		const installSpy = vi
			.spyOn(DefaultPackageManager.prototype, "installAndPersist")
			.mockImplementation(async () =>
				writeExtensionPackage(join(agentDir, "git", "github.com", "volt-hq", "Volt"), []),
			);

		await main(["store", "update", "rtk", "--yes"]);

		expect(updateSpy).not.toHaveBeenCalled();
		expect(installSpy).toHaveBeenCalledWith(pinnedGitSource, { local: false, scripts: "never" });
		expect(inspectorMock.inspectStorePackage).toHaveBeenCalledWith(
			expect.objectContaining({ source: pinnedGitSource }),
		);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});
});

describe("the TUI's /store", () => {
	const harnesses: TuiHarness[] = [];

	beforeEach(() => {
		resolverMock.resolveStoreSource.mockImplementation(async (options) => resolveCatalogStoreSource(options));
		inspectorMock.inspectStorePackage.mockClear();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => createCatalogResponse()),
		);
	});

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		resolverMock.resolveStoreSource.mockReset();
	});

	it("lists catalog packages at once, without asking for a search", async () => {
		const { tui } = await startTui(harnesses, {});
		void tui.submit("/store");
		await waitForScreen(tui, "Store packages", "1. rtk - RTK Output Compression", "Search", "Cancel");
	});

	it("moves a tracking install to the reviewed pin during interactive catalog updates", async () => {
		const { harness, tui } = await startTui(harnesses, { packages: [trackedGitSource] });
		const update = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue(undefined);
		const installAndPersist = vi
			.spyOn(DefaultPackageManager.prototype, "installAndPersist")
			.mockImplementation(async () =>
				writeExtensionPackage(join(harness.tempDir, "git", "github.com", "volt-hq", "Volt"), []),
			);

		void tui.submit("/store update rtk");
		await choose(tui, "Yes");
		await choose(tui, "Later");
		await waitForScreen(tui, "Run /reload to load the change.");

		expect(update).not.toHaveBeenCalled();
		expect(installAndPersist).toHaveBeenCalledWith(pinnedGitSource, { local: false, scripts: "never" });
		expect(inspectorMock.inspectStorePackage).toHaveBeenCalledWith(
			expect.objectContaining({ source: pinnedGitSource }),
		);
	});

	it("goes back to the tracked branch when an update's permissions are declined, removing it when its own are declined", async () => {
		const { harness, tui } = await startTui(harnesses, { packages: [trackedGitSource] });
		const installed = join(harness.tempDir, "git", "github.com", "volt-hq", "Volt");
		const installAndPersist = vi
			.spyOn(DefaultPackageManager.prototype, "installAndPersist")
			.mockImplementation(async (source: string, _options?: PackageInstallOptions) => {
				// Both revisions ask for more than was acknowledged: nothing ever was.
				writeExtensionPackage(installed, source === pinnedGitSource ? ["exec", "network"] : ["exec"]);
			});

		void tui.submit("/store update rtk");
		await choose(tui, "Yes");
		await waitForScreen(tui, "Extension permissions", "network: use the network");
		await choose(tui, "No");
		// The branch it tracks reinstalls at its newest revision: its permissions are reviewed in turn.
		await waitForScreen(tui, "Extension permissions", "exec: run commands", "Declining removes the package.");
		await choose(tui, "No");
		await choose(tui, "Later");
		await waitForScreen(
			tui,
			"Removed git github.com/volt-hq/Volt: the reinstalled revision's permissions were not acknowledged",
		);
		expect(installAndPersist.mock.calls.map(([source]) => source)).toEqual([pinnedGitSource, trackedGitSource]);
		expect(existsSync(join(harness.tempDir, "extension-permissions.json"))).toBe(false);
		const settings = JSON.parse(readFileSync(join(harness.tempDir, "settings.json"), "utf8"));
		expect(settings.packages).toEqual([]);
	});

	it("reviews the permissions of a package installed by a path relative to the cwd", async () => {
		const { harness, tui } = await startTui(harnesses, {});
		writeExtensionPackage(join(harness.tempDir, "packages", "rtk"), ["exec"]);
		resolverMock.resolveStoreSource.mockImplementation(async (options) => ({
			input: options.input,
			source: "./packages/rtk",
			kind: "local",
			pinned: false,
			tracking: false,
			warnings: [],
		}));

		void tui.submit("/store install ./packages/rtk");
		await choose(tui, "Yes");
		await waitForScreen(tui, "Extension permissions", "exec: run commands");
		await choose(tui, "Yes");
		await choose(tui, "Later");
		await waitForScreen(tui, "Installed");
		const acknowledged = JSON.parse(readFileSync(join(harness.tempDir, "extension-permissions.json"), "utf8"));
		expect(acknowledged.rtk).toMatchObject({ permissions: ["exec"] });
	});
});

describe("interactive store local removals", () => {
	const harnesses: TuiHarness[] = [];

	beforeEach(() => {
		resolverMock.resolveStoreSource.mockResolvedValue({
			input: "../pkg",
			source: "../pkg",
			kind: "local",
			pinned: false,
			tracking: false,
			warnings: [],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => createCatalogResponse()),
		);
	});

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		resolverMock.resolveStoreSource.mockReset();
	});

	it("uses the selected action source when removing settings-relative project packages", async () => {
		const project = join(tmpdir(), `volt-store-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(project, ".volt"), { recursive: true });
		writeFileSync(join(project, ".volt", "settings.json"), JSON.stringify({ packages: ["../pkg"] }));
		try {
			const { tui } = await startTui(harnesses, {}, project);
			const removeAndPersist = vi.spyOn(DefaultPackageManager.prototype, "removeAndPersist").mockResolvedValue(true);

			void tui.submit("/store remove ../pkg");
			await choose(tui, "Yes");
			await choose(tui, "Later");

			await vi.waitFor(() => expect(removeAndPersist).toHaveBeenCalledWith(join(project, "pkg"), { local: true }));
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	});
});
