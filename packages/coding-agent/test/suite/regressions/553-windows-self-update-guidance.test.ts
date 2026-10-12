import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, PACKAGE_NAME } from "../../../src/config.ts";
import { handlePackageCommand } from "../../../src/package-manager-cli.ts";
import { spawnProcess } from "../../../src/utils/child-process.ts";
import { createHarness, type Harness } from "../harness.ts";

// #553: on Windows, `volt update` rejected every install that was not npm or pnpm before
// reaching the method-specific instruction and the executable location.

vi.mock("../../../src/utils/child-process.ts", async (importOriginal) => ({
	...(await importOriginal<{ spawnProcess: typeof spawnProcess }>()),
	// The update must never run; fail instead of reaching a real package manager.
	spawnProcess: vi.fn(() => {
		throw new Error("spawnProcess must not run");
	}),
}));

let harness: Harness;
const originalCwd = process.cwd();
const originalExecPath = process.execPath;
const originalArgv1 = process.argv[1];
const originalExitCode = process.exitCode;

/** Install-method detection reads the executable path; the location report reads argv[1]. */
function setEntrypoint(entrypoint: string): void {
	Object.defineProperty(process, "execPath", { value: entrypoint, configurable: true });
	process.argv[1] = entrypoint;
}

async function runWindowsSelfUpdate(): Promise<{ stdout: string; stderr: string }> {
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	try {
		// --force skips the hosted version check, so no network is involved.
		expect(await handlePackageCommand(["update", "--self", "--force"])).toBe(true);
	} finally {
		if (platform) Object.defineProperty(process, "platform", platform);
	}
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

	const agentDir = join(harness.tempDir, "agent");
	const projectDir = join(harness.tempDir, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	process.chdir(projectDir);
	process.exitCode = undefined;
	vi.mocked(spawnProcess).mockClear();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
	process.argv[1] = originalArgv1;
	process.chdir(originalCwd);
	process.exitCode = originalExitCode;
	await harness.cleanupAsync();
});

describe("#553 volt update on Windows for installs it cannot self-update", () => {
	it("prints the update instruction and the executable location for a linked source checkout", async () => {
		const checkoutDir = join(harness.tempDir, "volt", "packages", "coding-agent");
		const entrypoint = join(checkoutDir, "dist", "cli.js");
		mkdirSync(dirname(entrypoint), { recursive: true });
		writeFileSync(join(checkoutDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME }));
		vi.stubEnv("VOLT_PACKAGE_DIR", checkoutDir);
		setEntrypoint(entrypoint);

		const { stderr } = await runWindowsSelfUpdate();

		expect(stderr).toContain("error: volt cannot self-update this installation.");
		expect(stderr).toContain(
			`Update ${PACKAGE_NAME}@latest using the package manager, wrapper, or source checkout that provides this installation.`,
		);
		expect(stderr).toContain(`Location of volt executable: ${entrypoint}`);
		expect(stderr).not.toContain("only supported for npm and pnpm");
		expect(spawnProcess).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("names the command to run for a global bun install", async () => {
		const home = join(harness.tempDir, "home");
		const packageDir = join(home, ".bun", "install", "global", "node_modules", PACKAGE_NAME);
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME }));
		// bun's global root is under the home directory: HOME on POSIX, USERPROFILE on Windows.
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("VOLT_PACKAGE_DIR", packageDir);
		setEntrypoint(join(packageDir, "dist", "cli.js"));

		const { stdout, stderr } = await runWindowsSelfUpdate();

		expect(stderr).toContain("volt self-update on Windows is only supported for npm and pnpm installs.");
		expect(stderr).toContain(
			`Update this bun install yourself with: bun install -g --ignore-scripts --minimum-release-age=0 ${PACKAGE_NAME}@latest`,
		);
		expect(stdout).not.toContain("Updating volt");
		expect(spawnProcess).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});
});
