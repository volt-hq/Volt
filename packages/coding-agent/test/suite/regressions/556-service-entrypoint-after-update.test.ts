import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, PACKAGE_NAME } from "../../../src/config.ts";
import { daemonStop, promptConfirm } from "../../../src/daemon/cli.ts";
import { isDaemonServiceInstalled, isDaemonServiceProcess } from "../../../src/daemon/service-install.ts";
import { findRunningDaemon, refreshInstalledDaemonService, startInstalledDaemon } from "../../../src/daemon/spawn.ts";
import { handlePackageCommand } from "../../../src/package-manager-cli.ts";
import { createHarness, type Harness } from "../harness.ts";

// No importOriginal here: the real module transitively imports package-manager-cli.ts,
// which would then bind to the unmocked exports while this factory is still running.
vi.mock("../../../src/daemon/cli.ts", () => ({
	daemonStop: vi.fn(),
	promptConfirm: vi.fn(),
}));

vi.mock("../../../src/daemon/spawn.ts", async (importOriginal) => ({
	...(await importOriginal<{
		findRunningDaemon: typeof findRunningDaemon;
		refreshInstalledDaemonService: typeof refreshInstalledDaemonService;
		startInstalledDaemon: typeof startInstalledDaemon;
	}>()),
	findRunningDaemon: vi.fn(),
	refreshInstalledDaemonService: vi.fn(),
	startInstalledDaemon: vi.fn(),
}));

vi.mock("../../../src/daemon/service-install.ts", async (importOriginal) => ({
	...(await importOriginal<{
		isDaemonServiceInstalled: typeof isDaemonServiceInstalled;
		isDaemonServiceProcess: typeof isDaemonServiceProcess;
	}>()),
	isDaemonServiceInstalled: vi.fn(),
	isDaemonServiceProcess: vi.fn(),
}));

const RENAMED_PACKAGE_NAME = PACKAGE_NAME === "@new-scope/volt" ? "@newer-scope/volt" : "@new-scope/volt";

let harness: Harness;
let agentDir: string;
let eventsPath: string;
let globalRoot: string;
const originalCwd = process.cwd();
const originalExecPath = process.execPath;
const originalExitCode = process.exitCode;

function recordEvent(event: string): void {
	appendFileSync(eventsPath, `${event}\n`);
}

function readEvents(): string[] {
	return existsSync(eventsPath) ? readFileSync(eventsPath, "utf-8").trim().split("\n") : [];
}

function publishRenamedRelease(): void {
	vi.stubEnv("VOLT_LATEST_VERSION_URL", "https://updates.example/latest-version");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ packageName: RENAMED_PACKAGE_NAME, version: "0.73.0" })),
	);
}

async function runSelfUpdate(
	args: string[] = ["update", "--self", "--force"],
): Promise<{ stdout: string; stderr: string }> {
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	expect(await handlePackageCommand(args)).toBe(true);
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

	agentDir = join(harness.tempDir, "agent");
	eventsPath = join(harness.tempDir, "events.log");
	const projectDir = join(harness.tempDir, "project");
	const globalPrefix = join(harness.tempDir, "global-prefix");
	globalRoot = join(globalPrefix, "lib", "node_modules");
	const selfPackageDir = join(globalRoot, PACKAGE_NAME);
	const fakeNpmPath = join(harness.tempDir, "fake-npm.cjs");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(selfPackageDir, { recursive: true });
	writeFileSync(join(selfPackageDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME }));
	// Installs and removes real package directories, so a renamed package moves the entrypoint.
	writeFileSync(
		fakeNpmPath,
		`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1],root=path.join(prefix,"lib","node_modules");
if(args.includes("root")) { console.log(root); process.exit(0); }
const command=args.includes("uninstall")?"uninstall":"install",spec=args[args.length-1];
fs.appendFileSync(${JSON.stringify(eventsPath)},command+"\\n");
const code=Number(process.env.FAKE_NPM_EXIT_CODE ?? "0");
if(code!==0) process.exit(code);
const name=spec.lastIndexOf("@")>0?spec.slice(0,spec.lastIndexOf("@")):spec;
if(command==="uninstall") fs.rmSync(path.join(root,name),{recursive:true,force:true});
else if(process.env.FAKE_NPM_SKIP_INSTALL!=="1") { fs.mkdirSync(path.join(root,name),{recursive:true}); fs.writeFileSync(path.join(root,name,"package.json"),JSON.stringify({name})); }
`,
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }),
	);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv("VOLT_PACKAGE_DIR", selfPackageDir);
	vi.stubEnv("FAKE_NPM_EXIT_CODE", "0");
	// Install-method detection reads the executable path; make this look like a global npm install.
	Object.defineProperty(process, "execPath", { value: join(selfPackageDir, "dist", "cli.js"), configurable: true });
	process.chdir(projectDir);
	process.exitCode = undefined;

	// The login service is installed, but voltd is not running.
	vi.mocked(findRunningDaemon).mockReset().mockResolvedValue(undefined);
	vi.mocked(isDaemonServiceInstalled).mockReset().mockReturnValue(true);
	vi.mocked(isDaemonServiceProcess).mockReset().mockResolvedValue(false);
	vi.mocked(promptConfirm).mockReset().mockResolvedValue(true);
	vi.mocked(daemonStop)
		.mockReset()
		.mockImplementation(async () => {
			recordEvent("stop");
			return true;
		});
	vi.mocked(startInstalledDaemon)
		.mockReset()
		.mockImplementation(async (_agentDir, _packageDir, starter) => {
			recordEvent(`start ${starter}`);
			return true;
		});
	vi.mocked(refreshInstalledDaemonService)
		.mockReset()
		.mockImplementation(async () => {
			recordEvent("refresh");
			return true;
		});
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
	process.chdir(originalCwd);
	process.exitCode = originalExitCode;
	await harness.cleanupAsync();
});

describe("#556 volt update with an installed login service", () => {
	it("points the service at the renamed package without starting voltd", async () => {
		publishRenamedRelease();

		const { stdout } = await runSelfUpdate(["update", "--self"]);

		expect(readEvents()).toEqual(["uninstall", "install", "refresh"]);
		expect(refreshInstalledDaemonService).toHaveBeenCalledWith(agentDir, join(globalRoot, RENAMED_PACKAGE_NAME));
		expect(startInstalledDaemon).not.toHaveBeenCalled();
		expect(stdout).toContain("Updated volt");
		expect(process.exitCode).toBeUndefined();
	});

	it("tells the user to reinstall the service when the renamed package is missing", async () => {
		publishRenamedRelease();
		vi.stubEnv("FAKE_NPM_SKIP_INSTALL", "1");

		const { stderr } = await runSelfUpdate(["update", "--self"]);

		expect(readEvents()).toEqual(["uninstall", "install"]);
		expect(refreshInstalledDaemonService).not.toHaveBeenCalled();
		expect(stderr).toContain("Could not find the installed volt package to update the login service from.");
		expect(stderr).toContain("Update it with `volt daemon install-service`");
		expect(process.exitCode).toBe(1);
	});

	it("tells the user to reinstall the service when the refresh fails", async () => {
		vi.mocked(refreshInstalledDaemonService).mockResolvedValue(false);

		const { stdout, stderr } = await runSelfUpdate();

		expect(refreshInstalledDaemonService).toHaveBeenCalledWith(agentDir, join(globalRoot, PACKAGE_NAME));
		expect(stdout).toContain("Updated volt");
		expect(stderr).toContain("The login service may still point at the previous installation.");
		expect(process.exitCode).toBe(1);
	});

	it("leaves the service alone when the update fails", async () => {
		vi.stubEnv("FAKE_NPM_EXIT_CODE", "217");

		await runSelfUpdate();

		expect(readEvents()).toEqual(["install"]);
		expect(refreshInstalledDaemonService).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("does nothing extra when no service is installed", async () => {
		vi.mocked(isDaemonServiceInstalled).mockReturnValue(false);

		await runSelfUpdate();

		expect(readEvents()).toEqual(["install"]);
		expect(refreshInstalledDaemonService).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("also refreshes the service when a terminal daemon was restarted", async () => {
		vi.mocked(findRunningDaemon).mockResolvedValue({ pid: 4242 });

		await runSelfUpdate();

		expect(readEvents()).toEqual(["stop", "install", "start terminal", "refresh"]);
		expect(process.exitCode).toBeUndefined();
	});

	it("relies on the service reinstall when the service was running voltd", async () => {
		vi.mocked(findRunningDaemon).mockResolvedValue({ pid: 4242 });
		vi.mocked(isDaemonServiceProcess).mockResolvedValue(true);

		await runSelfUpdate();

		expect(readEvents()).toEqual(["stop", "install", "start service"]);
		expect(refreshInstalledDaemonService).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});
});
