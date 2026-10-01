import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, PACKAGE_NAME } from "../../../src/config.ts";
import { isDaemonServiceInstalled } from "../../../src/daemon/service-install.ts";
import { findRunningDaemon } from "../../../src/daemon/spawn.ts";
import { main } from "../../../src/main.ts";
import { handlePackageCommand } from "../../../src/package-manager-cli.ts";
import { NativeAddonRestoreError, quarantineNativeAddons } from "../../../src/utils/self-update-native-quarantine.ts";
import { createHarness, type Harness } from "../harness.ts";

// #555: processes that #546's daemon stop does not reach (a voltd for another agent
// directory, open sessions) can hold the installation's native addons open.

vi.mock("../../../src/daemon/spawn.ts", async (importOriginal) => ({
	...(await importOriginal<{ findRunningDaemon: typeof findRunningDaemon }>()),
	findRunningDaemon: vi.fn(),
}));

vi.mock("../../../src/daemon/service-install.ts", async (importOriginal) => ({
	...(await importOriginal<{ isDaemonServiceInstalled: typeof isDaemonServiceInstalled }>()),
	// Keep the user's real login service out of these updates.
	isDaemonServiceInstalled: vi.fn(),
}));

vi.mock("../../../src/utils/self-update-native-quarantine.ts", async (importOriginal) => {
	const actual = await importOriginal<{ quarantineNativeAddons: typeof quarantineNativeAddons }>();
	return { ...actual, quarantineNativeAddons: vi.fn(actual.quarantineNativeAddons) };
});

const ADDONS = {
	workspaceFs: join("native", "workspace-fs", "prebuilds", "linux-x64-gnu", "workspace-fs.node"),
	iroh: join("node_modules", "@hansjm10", "volt-iroh-linux-x64-gnu", "iroh.linux-x64-gnu.node"),
} as const;

interface NpmSnapshot {
	quarantineExists: boolean;
	addons: Record<string, { identity: string; content: string }>;
}

let harness: Harness;
let eventsPath: string;
let snapshotPath: string;
let globalRoot: string;
let selfPackageDir: string;
let heldDescriptors: number[];
const originalCwd = process.cwd();
const originalExecPath = process.execPath;
const originalExitCode = process.exitCode;

function readEvents(): string[] {
	return existsSync(eventsPath) ? readFileSync(eventsPath, "utf-8").trim().split("\n") : [];
}

function readNpmSnapshot(): NpmSnapshot {
	return JSON.parse(readFileSync(snapshotPath, "utf-8")) as NpmSnapshot;
}

/** Stands in for another volt process that has loaded the addon. */
function hold(path: string): number {
	const fd = openSync(path, "r");
	heldDescriptors.push(fd);
	return fd;
}

async function runSelfUpdate(): Promise<{ stdout: string; stderr: string }> {
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	// --force skips the hosted version check, so no network is involved.
	expect(await handlePackageCommand(["update", "--self", "--force"])).toBe(true);
	return {
		stdout: logSpy.mock.calls.map(([message]) => String(message)).join("\n"),
		stderr: errorSpy.mock.calls.map(([message]) => String(message)).join("\n"),
	};
}

beforeEach(async () => {
	harness = await createHarness({ tools: [], settings: { lsp: { enabled: false } } });
	// Only the isolated directory is needed; the update runs outside the session.
	harness.session.dispose();
	await harness.session.waitForClosed();

	heldDescriptors = [];
	const agentDir = join(harness.tempDir, "agent");
	const projectDir = join(harness.tempDir, "project");
	const globalPrefix = join(harness.tempDir, "global-prefix");
	const fakeNpmPath = join(harness.tempDir, "fake-npm.cjs");
	eventsPath = join(harness.tempDir, "events.log");
	snapshotPath = join(harness.tempDir, "npm-snapshot.json");
	globalRoot = join(globalPrefix, "lib", "node_modules");
	selfPackageDir = join(globalRoot, PACKAGE_NAME);
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(selfPackageDir, { recursive: true });
	writeFileSync(join(selfPackageDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME }));
	for (const [name, relativePath] of Object.entries(ADDONS)) {
		mkdirSync(dirname(join(selfPackageDir, relativePath)), { recursive: true });
		writeFileSync(join(selfPackageDir, relativePath), `addon:${name}`);
	}
	// Records the native addons npm is about to delete, then replaces the package like npm does.
	writeFileSync(
		fakeNpmPath,
		`const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), prefix = args[args.indexOf("--prefix") + 1], root = path.join(prefix, "lib", "node_modules");
if (args.includes("root")) { console.log(root); process.exit(0); }
fs.appendFileSync(${JSON.stringify(eventsPath)}, "install\\n");
const pkg = path.join(root, ${JSON.stringify(PACKAGE_NAME)}), addons = {};
const walk = (dir) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(entryPath);
		else if (entry.name.endsWith(".node")) addons[path.relative(pkg, entryPath)] = { identity: fs.statSync(entryPath, { bigint: true }).ino.toString(), content: fs.readFileSync(entryPath, "utf8") };
	}
};
walk(pkg);
fs.writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify({ quarantineExists: fs.existsSync(path.join(root, ".volt-native-quarantine")), addons }));
fs.rmSync(pkg, { recursive: true });
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: ${JSON.stringify(PACKAGE_NAME)} }));
`,
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }),
	);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv("VOLT_PACKAGE_DIR", selfPackageDir);
	// Install-method detection reads the executable path; make this look like a global npm install.
	Object.defineProperty(process, "execPath", { value: join(selfPackageDir, "dist", "cli.js"), configurable: true });
	process.chdir(projectDir);
	process.exitCode = undefined;

	vi.mocked(findRunningDaemon).mockReset().mockResolvedValue(undefined);
	vi.mocked(isDaemonServiceInstalled).mockReset().mockReturnValue(false);
	vi.mocked(quarantineNativeAddons).mockClear();
});

afterEach(async () => {
	// Windows cannot remove directories that contain open files.
	for (const fd of heldDescriptors) closeSync(fd);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
	process.chdir(originalCwd);
	process.exitCode = originalExitCode;
	await harness.cleanupAsync();
});

describe("#555 volt update while other processes hold native addons", () => {
	it("moves held addons out of the package before npm deletes it", async () => {
		const held = Object.entries(ADDONS).map(([name, relativePath]) => {
			const fd = hold(join(selfPackageDir, relativePath));
			return { name, relativePath, fd, identity: fstatSync(fd, { bigint: true }).ino.toString() };
		});

		const { stdout } = await runSelfUpdate();

		expect(readEvents()).toEqual(["install"]);
		const snapshot = readNpmSnapshot();
		expect(Object.keys(snapshot.addons).sort()).toEqual(Object.values(ADDONS).sort());
		for (const { name, relativePath, fd, identity } of held) {
			// npm deletes complete copies, never the files other processes have open.
			expect(snapshot.addons[relativePath].content).toBe(`addon:${name}`);
			expect(snapshot.addons[relativePath].identity).not.toBe(identity);
			expect(readFileSync(fd, "utf8")).toBe(`addon:${name}`);
		}
		expect(stdout).toContain("Updated volt");
		expect(process.exitCode).toBeUndefined();
	});

	it("removes the quarantine after the update when no process holds the addons", async () => {
		const { stdout } = await runSelfUpdate();

		expect(readNpmSnapshot().quarantineExists).toBe(true);
		expect(existsSync(join(globalRoot, ".volt-native-quarantine"))).toBe(false);
		expect(stdout).toContain("Updated volt");
		expect(process.exitCode).toBeUndefined();
	});

	it("does not run npm when the addons cannot be moved aside", async () => {
		vi.mocked(quarantineNativeAddons).mockImplementationOnce(() => {
			throw new Error(
				`Could not move native addon ${join(selfPackageDir, ADDONS.iroh)} aside: EXDEV: cross-device link not permitted`,
			);
		});

		const { stdout, stderr } = await runSelfUpdate();

		expect(readEvents()).toEqual([]);
		expect(stdout).not.toContain("Updated volt");
		expect(stderr).toContain("EXDEV: cross-device link not permitted");
		expect(stderr).toContain("Nothing was installed");
		expect(stderr).toContain("Close every volt process, including voltd");
		expect(stderr).toContain(`install -g --ignore-scripts --min-release-age=0 ${PACKAGE_NAME}@latest`);
		expect(stderr).not.toContain("may be incomplete");
		for (const [name, relativePath] of Object.entries(ADDONS)) {
			expect(readFileSync(join(selfPackageDir, relativePath), "utf8")).toBe(`addon:${name}`);
		}
		expect(process.exitCode).toBe(1);
	});

	it("keeps an addon that could not be restored and reports the installation as changed", async () => {
		const addonPath = join(selfPackageDir, ADDONS.iroh);
		const quarantineRunDir = join(globalRoot, ".volt-native-quarantine", "failed-run");
		const quarantinePath = join(quarantineRunDir, ADDONS.iroh);
		vi.mocked(quarantineNativeAddons).mockImplementationOnce(() => {
			// Where a failed copy back and a failed restore leave the addon.
			mkdirSync(dirname(quarantinePath), { recursive: true });
			renameSync(addonPath, quarantinePath);
			throw new NativeAddonRestoreError(
				`Could not copy native addon ${addonPath} back (ENOSPC: no space left on device, copyfile), and could not restore it from ${quarantinePath}: EPERM: operation not permitted, rename`,
				{ addonPath, quarantinePath, quarantineRunDir },
				{ cause: new Error("ENOSPC: no space left on device, copyfile") },
			);
		});

		const { stdout, stderr } = await runSelfUpdate();

		expect(readEvents()).toEqual([]);
		expect(stdout).not.toContain("Updated volt");
		expect(readFileSync(quarantinePath, "utf8")).toBe("addon:iroh");
		expect(stderr).toContain("missing or incomplete native addon");
		expect(stderr).toContain(`Copy ${quarantinePath} to ${addonPath} and delete ${quarantineRunDir}`);
		expect(stderr).not.toContain("unchanged");
		expect(process.exitCode).toBe(1);
	});

	it("removes a finished quarantine when volt starts", async () => {
		quarantineNativeAddons(selfPackageDir);
		expect(existsSync(join(globalRoot, ".volt-native-quarantine"))).toBe(true);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});

		await expect(main(["--version"])).rejects.toThrow("process.exit");

		expect(existsSync(join(globalRoot, ".volt-native-quarantine"))).toBe(false);
	});
});
