import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, PACKAGE_NAME } from "../../../src/config.ts";
import { daemonStop, promptConfirm } from "../../../src/daemon/cli.ts";
import { isDaemonServiceProcess } from "../../../src/daemon/service-install.ts";
import { findRunningDaemon, startInstalledDaemon } from "../../../src/daemon/spawn.ts";
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
		startInstalledDaemon: typeof startInstalledDaemon;
	}>()),
	findRunningDaemon: vi.fn(),
	startInstalledDaemon: vi.fn(),
}));

vi.mock("../../../src/daemon/service-install.ts", async (importOriginal) => ({
	...(await importOriginal<{ isDaemonServiceProcess: typeof isDaemonServiceProcess }>()),
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

async function runSelfUpdate(
	args: string[] = ["update", "--self", "--force"],
): Promise<{ stdout: string; stderr: string }> {
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	// --force skips the hosted version check, so no network is involved.
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
	// Installs and removes real package directories, so the restart must look up the
	// package after the update rather than reuse the directory of the running CLI.
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

	vi.mocked(findRunningDaemon).mockReset().mockResolvedValue({ pid: 4242 });
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
		.mockImplementation(async () => {
			recordEvent("start");
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

describe("#546 volt update with a running daemon", () => {
	it("stops the daemon before installing and starts the updated daemon afterwards", async () => {
		const { stdout } = await runSelfUpdate();

		expect(readEvents()).toEqual(["stop", "install", "start"]);
		expect(daemonStop).toHaveBeenCalledWith(agentDir);
		expect(isDaemonServiceProcess).toHaveBeenCalledWith(4242);
		expect(startInstalledDaemon).toHaveBeenCalledWith(agentDir, join(globalRoot, PACKAGE_NAME), "terminal");
		expect(stdout).toContain("Updated volt");
		expect(process.exitCode).toBeUndefined();
	});

	it("starts the daemon from the renamed package after the old one is removed", async () => {
		vi.stubEnv("VOLT_LATEST_VERSION_URL", "https://updates.example/latest-version");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ packageName: RENAMED_PACKAGE_NAME, version: "0.73.0" })),
		);

		const { stdout } = await runSelfUpdate(["update", "--self"]);

		expect(readEvents()).toEqual(["stop", "uninstall", "install", "start"]);
		expect(existsSync(join(globalRoot, PACKAGE_NAME))).toBe(false);
		expect(startInstalledDaemon).toHaveBeenCalledWith(agentDir, join(globalRoot, RENAMED_PACKAGE_NAME), "terminal");
		expect(stdout).toContain("Updated volt");
		expect(process.exitCode).toBeUndefined();
	});

	it("does not start the daemon from the removed package when the updated one is missing", async () => {
		vi.stubEnv("VOLT_LATEST_VERSION_URL", "https://updates.example/latest-version");
		vi.stubEnv("FAKE_NPM_SKIP_INSTALL", "1");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ packageName: RENAMED_PACKAGE_NAME, version: "0.73.0" })),
		);

		const { stderr } = await runSelfUpdate(["update", "--self"]);

		expect(readEvents()).toEqual(["stop", "uninstall", "install"]);
		expect(startInstalledDaemon).not.toHaveBeenCalled();
		expect(stderr).toContain("Could not find the installed volt package");
		expect(stderr).toContain("did not start again. Start it with `volt daemon start`");
		expect(process.exitCode).toBe(1);
	});

	it("restarts a daemon run by the login service through the service", async () => {
		vi.mocked(isDaemonServiceProcess).mockResolvedValue(true);
		vi.mocked(startInstalledDaemon).mockResolvedValue(false);

		const { stderr } = await runSelfUpdate();

		expect(startInstalledDaemon).toHaveBeenCalledWith(agentDir, join(globalRoot, PACKAGE_NAME), "service");
		expect(stderr).toContain("did not start again. Start it with `volt daemon install-service`");
		expect(process.exitCode).toBe(1);
	});

	it("leaves the installation and daemon alone when the restart is not confirmed", async () => {
		// Non-interactive runs also answer no.
		vi.mocked(promptConfirm).mockResolvedValue(false);

		const { stderr } = await runSelfUpdate();

		expect(readEvents()).toEqual([]);
		expect(daemonStop).not.toHaveBeenCalled();
		expect(startInstalledDaemon).not.toHaveBeenCalled();
		expect(stderr).toContain("voltd (pid 4242) is running");
		expect(stderr).toContain("`volt daemon stop`, then `volt update --self --force`, then `volt daemon start`");
		expect(process.exitCode).toBe(1);
	});

	it("does not suggest --force when the declined update was not forced", async () => {
		vi.mocked(promptConfirm).mockResolvedValue(false);
		vi.stubEnv("VOLT_LATEST_VERSION_URL", "https://updates.example/latest-version");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ packageName: PACKAGE_NAME, version: "999.0.0" })),
		);

		const { stderr } = await runSelfUpdate(["update", "--self"]);

		expect(readEvents()).toEqual([]);
		expect(stderr).toContain("`volt daemon stop`, then `volt update --self`, then `volt daemon start`");
		expect(stderr).not.toContain("--force");
		expect(process.exitCode).toBe(1);
	});

	it("tells the user to reinstall the service when the service daemon restart is not confirmed", async () => {
		vi.mocked(isDaemonServiceProcess).mockResolvedValue(true);
		vi.mocked(promptConfirm).mockResolvedValue(false);

		const { stderr } = await runSelfUpdate();

		expect(readEvents()).toEqual([]);
		expect(daemonStop).not.toHaveBeenCalled();
		expect(startInstalledDaemon).not.toHaveBeenCalled();
		expect(stderr).toContain(
			"`volt daemon stop`, then `volt update --self --force`, then `volt daemon install-service`",
		);
		expect(stderr).not.toContain("`volt daemon start`");
		expect(process.exitCode).toBe(1);
	});

	it("does not install when the daemon does not stop", async () => {
		vi.mocked(daemonStop).mockResolvedValue(false);

		const { stderr } = await runSelfUpdate();

		expect(readEvents()).toEqual([]);
		expect(startInstalledDaemon).not.toHaveBeenCalled();
		expect(stderr).toContain("voltd did not stop");
		expect(process.exitCode).toBe(1);
	});

	it("restarts the daemon and explains recovery when the install fails", async () => {
		vi.stubEnv("FAKE_NPM_EXIT_CODE", "217");

		const { stdout, stderr } = await runSelfUpdate();

		expect(readEvents()).toEqual(["stop", "install", "start"]);
		expect(stdout).not.toContain("Updated volt");
		expect(stderr).toContain("exited with code 217");
		expect(stderr).toContain("may be incomplete");
		expect(stderr).toContain("reinstall with: ");
		expect(stderr).toContain(`${PACKAGE_NAME}@latest`);
		expect(process.exitCode).toBe(1);
	});

	it("reports a stopped daemon that does not start again", async () => {
		vi.mocked(startInstalledDaemon).mockResolvedValue(false);

		const { stdout, stderr } = await runSelfUpdate();

		expect(readEvents()).toEqual(["stop", "install"]);
		expect(stdout).toContain("Updated volt");
		expect(stderr).toContain("did not start again. Start it with `volt daemon start`");
		expect(process.exitCode).toBe(1);
	});

	it("updates without prompting when no daemon is running", async () => {
		vi.mocked(findRunningDaemon).mockResolvedValue(undefined);

		const { stdout } = await runSelfUpdate();

		expect(readEvents()).toEqual(["install"]);
		expect(promptConfirm).not.toHaveBeenCalled();
		expect(daemonStop).not.toHaveBeenCalled();
		expect(startInstalledDaemon).not.toHaveBeenCalled();
		expect(stdout).toContain("Updated volt");
		expect(process.exitCode).toBeUndefined();
	});
});
