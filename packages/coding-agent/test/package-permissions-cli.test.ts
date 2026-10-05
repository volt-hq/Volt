/**
 * `volt install` and `volt update` review an extension package's permissions
 * (RFC §8.2): in a terminal they ask for the unacknowledged ones and record
 * the answer (declining an install removes the package); without one they
 * list them, unacknowledged.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { promptConfirm } from "../src/daemon/cli.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";

// No importOriginal: the real module imports package-manager-cli.ts, which would bind to its unmocked exports.
vi.mock("../src/daemon/cli.ts", () => ({
	daemonStop: vi.fn(),
	promptConfirm: vi.fn(),
}));

describe("package permission review", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let logs: string[];
	const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };

	function setTerminal(interactive: boolean): void {
		Object.defineProperty(process.stdin, "isTTY", { value: interactive, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: interactive, configurable: true });
	}

	function writePackage(permissions: string[]): void {
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "perm-demo",
				version: "1.0.0",
				volt: { id: "perm-demo", displayName: "Permission Demo", entry: "index.js", permissions },
			}),
		);
		writeFileSync(join(packageDir, "index.js"), "module.exports = function () {};");
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

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-package-permissions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "perm-demo");
		for (const dir of [agentDir, projectDir, packageDir]) mkdirSync(dir, { recursive: true });
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
		process.exitCode = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(process.stdin, "isTTY", { value: tty.stdin, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: tty.stdout, configurable: true });
		process.chdir(originalCwd);
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
		process.exitCode = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists the permissions without a terminal and leaves them unacknowledged", async () => {
		setTerminal(false);
		writePackage(["exec", "secrets"]);
		await handlePackageCommand(["install", packageDir, "--approve"]);
		expect(promptConfirm).not.toHaveBeenCalled();
		expect(packages()).toHaveLength(1);
		expect(acknowledged()).toEqual({});
		const output = logs.join("\n");
		expect(output).toContain("Permission Demo (perm-demo 1.0.0) asks to:");
		expect(output).toContain("secrets: read stored credentials and API keys");
		expect(output).toContain("These permissions are not acknowledged.");
	});

	it("removes the package when the user declines, and records an acknowledgment once", async () => {
		setTerminal(true);
		writePackage(["exec"]);
		vi.mocked(promptConfirm).mockResolvedValueOnce(false);
		await handlePackageCommand(["install", packageDir, "--approve"]);
		expect(process.exitCode).toBe(1);
		expect(packages()).toEqual([]);
		expect(acknowledged()).toEqual({});
		expect(logs.join("\n")).toContain("its permissions were not acknowledged");

		process.exitCode = undefined;
		vi.mocked(promptConfirm).mockResolvedValueOnce(true);
		await handlePackageCommand(["install", packageDir, "--approve"]);
		expect(packages()).toHaveLength(1);
		expect(acknowledged()["perm-demo"]).toMatchObject({
			permissions: ["exec"],
			fingerprint: expect.stringMatching(/^local:/),
		});

		await handlePackageCommand(["install", packageDir, "--approve"]);
		expect(promptConfirm).toHaveBeenCalledTimes(2);
	});

	it("removes a package whose permissions cannot be reviewed, printing the reason inert", async () => {
		setTerminal(true);
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "perm-demo",
				version: "1.0.0",
				volt: {
					id: "perm-demo",
					displayName: "Permission Demo",
					entry: "index.js",
					permissions: ["exec"],
					settings: { type: "object", properties: { "x\u001b[31mred": { type: "boolean" } } },
				},
			}),
		);
		writeFileSync(join(packageDir, "index.js"), "module.exports = function () {};");
		await handlePackageCommand(["install", packageDir, "--approve"]);
		expect(promptConfirm).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(packages()).toEqual([]);
		const output = logs.join("\n");
		expect(output).toContain("Could not review the permissions");
		expect(output).not.toContain("\u001b[31m");
	});

	it("asks again on update only for a permission the package adds", async () => {
		setTerminal(true);
		writePackage(["exec"]);
		vi.mocked(promptConfirm).mockResolvedValueOnce(true);
		await handlePackageCommand(["install", packageDir, "--approve"]);

		await handlePackageCommand(["update", "--extensions", "--approve"]);
		expect(promptConfirm).toHaveBeenCalledTimes(1);

		writePackage(["exec", "network"]);
		vi.mocked(promptConfirm).mockResolvedValueOnce(false);
		await handlePackageCommand(["update", "--extensions", "--approve"]);
		expect(promptConfirm).toHaveBeenCalledTimes(2);
		expect(logs.join("\n")).toContain("network: use the network (not enforced) (new)");
		expect(logs.join("\n")).toContain("asks for permissions you did not acknowledge");
		expect(acknowledged()["perm-demo"]?.permissions).toEqual(["exec"]);
		expect(packages()).toHaveLength(1);
	});
});
