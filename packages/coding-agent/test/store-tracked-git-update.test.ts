import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ConfiguredPackage, PackageInstallOptions, PackageUpdateOptions } from "../src/core/package-manager.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { main } from "../src/main.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import type { StoreCatalog } from "../src/store/catalog.ts";
import type { StorePackageInspection } from "../src/store/inspector.ts";
import type { ResolveStoreSourceOptions, StoreResolvedSource } from "../src/store/resolver.ts";
import { testCatalog, testCatalogEntry, testStoreSource } from "./store-catalog-fixtures.ts";

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

interface InteractiveSettingsManager {
	isProjectTrusted(): boolean;
	flush(): Promise<void>;
	getNpmCommand(): string[] | undefined;
}

interface FakeStorePackageManager {
	getPackageIdentity(source: string, scope?: "user" | "project"): string;
	listConfiguredPackages(): ConfiguredPackage[];
	update(source?: string, options?: PackageUpdateOptions): Promise<void>;
	installAndPersist(source: string, options?: PackageInstallOptions): Promise<void>;
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
}

interface InteractiveStoreMode {
	tuiHost: {
		conversation: {
			session: {
				settingsManager: InteractiveSettingsManager;
				sessionManager: { getCwd(): string };
			};
		};
	};
	loadStoreCatalog(required: boolean): Promise<StoreCatalog | undefined>;
	getStorePackageManager(): FakeStorePackageManager;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
	showStoreText(text: string): void;
	showExtensionConfirm(title: string, message: string): Promise<boolean>;
	reportStoreSettingsErrors(
		packageManager: FakeStorePackageManager,
		source: string,
		scope: "user" | "project",
	): boolean;
	offerStoreReload(message: string): Promise<void>;
}

const storeCatalog: StoreCatalog = testCatalog(testCatalogEntry("rtk"));

function createCatalogResponse(): Response {
	return Response.json(storeCatalog);
}

function getFakePackageIdentity(source: string, scope?: "user" | "project"): string {
	if (source === trackedGitSource || source === pinnedGitSource) {
		return "git:github.com/volt-hq/Volt";
	}
	if (source === "/repo/project/pkg") {
		return "local:/repo/project/pkg";
	}
	if (source === "../pkg" && scope === "project") {
		return "local:/repo/project/pkg";
	}
	if (source === "../pkg") {
		return "local:/repo/pkg";
	}
	return source;
}

function createInteractiveMode(packageManager: FakeStorePackageManager): InteractiveStoreMode {
	const settingsManager: InteractiveSettingsManager = {
		isProjectTrusted: () => true,
		flush: vi.fn(async () => {}),
		getNpmCommand: () => undefined,
	};
	const sessionManager = {
		getCwd: () => "/repo/project",
	};
	return Object.assign(Object.create(InteractiveMode.prototype) as InteractiveStoreMode, {
		tuiHost: {
			conversation: {
				session: {
					settingsManager,
					sessionManager,
				},
			},
		},
		loadStoreCatalog: vi.fn(async () => storeCatalog),
		getStorePackageManager: vi.fn(() => packageManager),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		showStoreText: vi.fn(),
		showExtensionConfirm: vi.fn(async () => true),
		reportStoreSettingsErrors: vi.fn(() => false),
		offerStoreReload: vi.fn(async () => {}),
	});
}

function getInteractiveStoreUpdateFlow(): (
	this: InteractiveStoreMode,
	input?: string,
	catalog?: StoreCatalog,
) => Promise<void> {
	return Reflect.get(InteractiveMode.prototype, "showStoreUpdateFlow") as (
		this: InteractiveStoreMode,
		input?: string,
		catalog?: StoreCatalog,
	) => Promise<void>;
}

function getInteractiveStoreRemoveFlow(): (
	this: InteractiveStoreMode,
	input: string,
	local?: boolean,
	catalog?: StoreCatalog,
) => Promise<void> {
	return Reflect.get(InteractiveMode.prototype, "showStoreRemoveFlow") as (
		this: InteractiveStoreMode,
		input: string,
		local?: boolean,
		catalog?: StoreCatalog,
	) => Promise<void>;
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
		const installSpy = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue(undefined);

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

	it("moves a tracking install to the reviewed pin during interactive catalog updates", async () => {
		const update = vi
			.fn<(source?: string, options?: PackageUpdateOptions) => Promise<void>>()
			.mockResolvedValue(undefined);
		const installAndPersist = vi
			.fn<(source: string, options?: PackageInstallOptions) => Promise<void>>()
			.mockResolvedValue(undefined);
		const packageManager: FakeStorePackageManager = {
			getPackageIdentity: getFakePackageIdentity,
			listConfiguredPackages: () => [
				{ source: trackedGitSource, actionSource: trackedGitSource, scope: "user", filtered: false },
			],
			update,
			installAndPersist,
			removeAndPersist: vi.fn(async () => true),
		};
		const mode = createInteractiveMode(packageManager);

		await getInteractiveStoreUpdateFlow().call(mode, "rtk", storeCatalog);

		expect(update).not.toHaveBeenCalled();
		expect(installAndPersist).toHaveBeenCalledWith(pinnedGitSource, { local: false, scripts: "never" });
		expect(inspectorMock.inspectStorePackage).toHaveBeenCalledWith(
			expect.objectContaining({ source: pinnedGitSource }),
		);
	});
});

describe("interactive store local removals", () => {
	beforeEach(() => {
		resolverMock.resolveStoreSource.mockResolvedValue({
			input: "../pkg",
			source: "../pkg",
			kind: "local",
			pinned: false,
			tracking: false,
			warnings: [],
		});
	});

	afterEach(() => {
		resolverMock.resolveStoreSource.mockReset();
	});

	it("uses the selected action source when removing settings-relative project packages", async () => {
		const removeAndPersist = vi
			.fn<(source: string, options?: { local?: boolean }) => Promise<boolean>>()
			.mockResolvedValue(true);
		const packageManager: FakeStorePackageManager = {
			getPackageIdentity: getFakePackageIdentity,
			listConfiguredPackages: () => [
				{ source: "../pkg", actionSource: "/repo/project/pkg", scope: "project", filtered: false },
			],
			update: vi.fn(async () => {}),
			installAndPersist: vi.fn(async () => {}),
			removeAndPersist,
		};
		const mode = createInteractiveMode(packageManager);

		await getInteractiveStoreRemoveFlow().call(mode, "../pkg", undefined, storeCatalog);

		expect(removeAndPersist).toHaveBeenCalledWith("/repo/project/pkg", { local: true });
	});
});
