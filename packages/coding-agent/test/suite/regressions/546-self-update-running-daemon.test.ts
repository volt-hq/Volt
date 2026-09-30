import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, PACKAGE_NAME } from "../../../src/config.ts";
import { daemonStop, promptConfirm } from "../../../src/daemon/cli.ts";
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

let harness: Harness;
let agentDir: string;
let eventsPath: string;
const originalCwd = process.cwd();
const originalExecPath = process.execPath;
const originalExitCode = process.exitCode;

function recordEvent(event: string): void {
	appendFileSync(eventsPath, `${event}\n`);
}

function readEvents(): string[] {
	return existsSync(eventsPath) ? readFileSync(eventsPath, "utf-8").trim().split("\n") : [];
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

	agentDir = join(harness.tempDir, "agent");
	eventsPath = join(harness.tempDir, "events.log");
	const projectDir = join(harness.tempDir, "project");
	const globalPrefix = join(harness.tempDir, "global-prefix");
	const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@hansjm10", "volt-coding-agent");
	const fakeNpmPath = join(harness.tempDir, "fake-npm.cjs");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(selfPackageDir, { recursive: true });
	writeFileSync(
		fakeNpmPath,
		`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) { console.log(path.join(prefix,"lib","node_modules")); process.exit(0); }
fs.appendFileSync(${JSON.stringify(eventsPath)},"install\\n");
process.exit(Number(process.env.FAKE_NPM_EXIT_CODE ?? "0"));
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
		expect(startInstalledDaemon).toHaveBeenCalledWith(agentDir);
		expect(stdout).toContain("Updated volt");
		expect(process.exitCode).toBeUndefined();
	});

	it("leaves the installation and daemon alone when the restart is not confirmed", async () => {
		// Non-interactive runs also answer no.
		vi.mocked(promptConfirm).mockResolvedValue(false);

		const { stderr } = await runSelfUpdate();

		expect(readEvents()).toEqual([]);
		expect(daemonStop).not.toHaveBeenCalled();
		expect(startInstalledDaemon).not.toHaveBeenCalled();
		expect(stderr).toContain("voltd (pid 4242) is running");
		expect(stderr).toContain("`volt daemon stop`, then `volt update --self`, then `volt daemon start`");
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
