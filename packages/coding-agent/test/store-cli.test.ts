import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { main } from "../src/main.ts";
import type { StorePackageInspection } from "../src/store/inspector.ts";
import { NEXT_TEST_STORE_COMMIT, testCatalog, testCatalogEntry, testStoreSource } from "./store-catalog-fixtures.ts";

// Catalog packages are git pins on github.com; inspection would clone them, so it reads no files here.
const inspectorMock = vi.hoisted(() => ({
	inspectStorePackage: vi.fn(
		async (options: { source: string }): Promise<StorePackageInspection> => ({
			source: options.source,
			packageName: "volt-rtk-extension",
			packageVersion: "0.2.0",
			volt: { manifest: { id: "rtk", displayName: "RTK Output Compression", entry: "extensions/rtk.ts" } },
			discoveredResources: { extensions: ["."], skills: [], prompts: [], themes: [] },
			dependencies: {},
			peerDependencies: {},
			optionalDependencies: {},
			scripts: {},
			warnings: [],
		}),
	),
}));

vi.mock("../src/store/inspector.ts", () => ({
	inspectStorePackage: inspectorMock.inspectStorePackage,
}));

function catalogResponse(commit?: string): Response {
	return Response.json(testCatalog(testCatalogEntry("rtk", {}, commit)));
}

describe("store CLI", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-store-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
		inspectorMock.inspectStorePackage.mockClear();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => catalogResponse()),
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

	it("searches the catalog without starting normal app mode", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["store", "search", "RTK"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("rtk - RTK Output Compression");
			expect(stdout).toContain("Token optimized shell output");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("installs a catalog package at its reviewed pin with --yes", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const installSpy = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue(undefined);

		await expect(main(["store", "install", "rtk", "--yes"])).resolves.toBeUndefined();

		expect(inspectorMock.inspectStorePackage).toHaveBeenCalledWith(
			expect.objectContaining({ source: testStoreSource() }),
		);
		expect(installSpy).toHaveBeenCalledWith(testStoreSource(), { local: false, scripts: "never" });
		const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(stdout).toContain("Store install plan");
		expect(stdout).toContain("Permissions: exec");
		expect(stdout).toContain("Reviewed: 0123456789ab by hansjm10 on 2026-10-05");
		expect(stdout).toContain("Script policy: never");
		expect(stdout).toContain("Installed rtk - RTK Output Compression");
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it.each([
		["--ref", "main"],
		["--track", undefined],
	])("refuses %s for a catalog package", async (option, value) => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const installSpy = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue(undefined);

		await main(["store", "install", "rtk", option, ...(value ? [value] : []), "--yes"]);

		expect(installSpy).not.toHaveBeenCalled();
		expect(inspectorMock.inspectStorePackage).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			`${option} does not apply to catalog package rtk: it installs at its reviewed commit`,
		);
		expect(process.exitCode).toBe(1);
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("removes an installed catalog package by catalog ID", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [testStoreSource()] }, null, 2));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(main(["store", "remove", "rtk", "--yes"])).resolves.toBeUndefined();

		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as { packages?: string[] };
		expect(settings.packages ?? []).toHaveLength(0);
		const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(stdout).toContain("Removed");
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("removes a project-local package by its settings-relative source", async () => {
		const projectPackageDir = join(projectDir, "pkg");
		mkdirSync(join(projectPackageDir, "extensions"), { recursive: true });
		writeFileSync(
			join(projectPackageDir, "package.json"),
			JSON.stringify(
				{
					name: "settings-relative-rtk",
					version: "0.1.0",
					description: "Settings-relative RTK extension",
					volt: { id: "rtk", displayName: "RTK", entry: "extensions/rtk.ts" },
				},
				null,
				2,
			),
		);
		writeFileSync(join(projectPackageDir, "extensions", "rtk.ts"), "export default function rtk() {}\n");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await main(["store", "install", "./pkg", "--local", "--approve", "--yes"]);

			const settingsPath = join(projectDir, CONFIG_DIR_NAME, "settings.json");
			const installedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
				packages?: Array<string | { source: string; scripts?: string }>;
			};
			expect(installedSettings.packages).toEqual([
				{ source: relative(join(projectDir, CONFIG_DIR_NAME), projectPackageDir), scripts: "never" },
			]);

			await expect(main(["store", "remove", "../pkg", "--local", "--approve", "--yes"])).resolves.toBeUndefined();

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
			expect(settings.packages ?? []).toHaveLength(0);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Removed");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("updates all installed packages with --yes and keeps lifecycle scripts disabled", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const updateSpy = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue(undefined);

		try {
			await expect(main(["store", "update", "--yes"])).resolves.toBeUndefined();

			expect(updateSpy).toHaveBeenCalledWith(undefined, { scripts: "never" });
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Updated packages");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			updateSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("reconciles a catalog package already at its reviewed pin without duplicating the settings entry", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [testStoreSource()] }, null, 2));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const updateSpy = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue(undefined);
		const installSpy = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue(undefined);

		await expect(main(["store", "update", "rtk", "--yes"])).resolves.toBeUndefined();

		expect(updateSpy).toHaveBeenCalledWith(testStoreSource(), { local: false, scripts: "never" });
		expect(installSpy).not.toHaveBeenCalled();
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as { packages?: string[] };
		expect(settings.packages).toEqual([testStoreSource()]);
		expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("Updated");
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("moves an installed catalog package to the catalog's new reviewed pin", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [testStoreSource()] }, null, 2));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => catalogResponse(NEXT_TEST_STORE_COMMIT)),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const updateSpy = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue(undefined);
		const installSpy = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue(undefined);

		await expect(main(["store", "update", "rtk", "--yes"])).resolves.toBeUndefined();

		expect(updateSpy).not.toHaveBeenCalled();
		expect(installSpy).toHaveBeenCalledWith(testStoreSource(NEXT_TEST_STORE_COMMIT), {
			local: false,
			scripts: "never",
		});
		const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(stdout).toContain("Reviewed: 89abcdef0123 by hansjm10 on 2026-10-05");
		expect(stdout).toContain("to rtk - RTK Output Compression");
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("updates the project catalog package with --local when the package is installed in both scopes", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [testStoreSource()] }, null, 2));
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ packages: [testStoreSource()] }, null, 2),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const updateSpy = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue(undefined);

		await expect(main(["store", "update", "rtk", "--local", "--approve", "--yes"])).resolves.toBeUndefined();

		expect(updateSpy).toHaveBeenCalledOnce();
		expect(updateSpy).toHaveBeenCalledWith(testStoreSource(), { local: true, scripts: "never" });
		expect(logSpy).toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("searches without resolving configured packages during project trust bootstrap", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:@scope/missing@1.0.0"] }, null, 2),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const resolveSpy = vi.spyOn(DefaultPackageManager.prototype, "resolve").mockResolvedValue({
			extensions: [],
			skills: [],
			prompts: [],
			themes: [],
		});

		try {
			await expect(main(["store", "search", "RTK"])).resolves.toBeUndefined();

			expect(resolveSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			resolveSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("refuses non-interactive installs without --yes before resolving configured packages", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:@scope/missing@1.0.0"] }, null, 2),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const resolveSpy = vi.spyOn(DefaultPackageManager.prototype, "resolve").mockResolvedValue({
			extensions: [],
			skills: [],
			prompts: [],
			themes: [],
		});

		try {
			await expect(main(["store", "install", "rtk"])).resolves.toBeUndefined();

			expect(resolveSpy).not.toHaveBeenCalled();
			expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				"Non-interactive install requires --yes.",
			);
			expect(process.exitCode).toBe(1);
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"))).toEqual({
				packages: ["npm:@scope/missing@1.0.0"],
			});
		} finally {
			resolveSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});
});
