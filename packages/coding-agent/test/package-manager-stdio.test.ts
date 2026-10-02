import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreStdout, takeOverStdout } from "../src/core/output-guard.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface CapturedSpawnCall {
	command: string;
	args: string[];
	options: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		stdio?: unknown;
	};
}

interface PackageManagerWithRunCommand {
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
}

const subprocessState = vi.hoisted(() => ({
	calls: [] as CapturedSpawnCall[],
}));

vi.mock("../src/utils/child-process.ts", () => ({
	spawnProcess: vi.fn((command: string, args: string[], options: CapturedSpawnCall["options"]) => {
		subprocessState.calls.push({ command, args, options });
		const child = {
			stdout: null,
			stderr: null,
			signalCode: null,
			kill: () => true,
			on: () => child,
			once: () => child,
			removeListener: () => child,
		};
		return child;
	}),
	spawnProcessSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
	waitForChildProcess: vi.fn(async () => 0),
}));

function createPackageManager(): PackageManagerWithRunCommand {
	return new DefaultPackageManager({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		settingsManager: SettingsManager.inMemory(),
	}) as unknown as PackageManagerWithRunCommand;
}

afterEach(() => {
	restoreStdout();
	subprocessState.calls.length = 0;
	vi.restoreAllMocks();
});

describe("package manager subprocess stdio", () => {
	it("inherits stdio for mutating package commands outside stdout takeover", async () => {
		await createPackageManager().runCommand("npm", ["install", "private-package"]);

		expect(subprocessState.calls).toHaveLength(1);
		expect(subprocessState.calls[0]?.options.stdio).toBe("inherit");
	});

	it("keeps mutating package commands off stdin and stdout after stdout takeover", async () => {
		takeOverStdout();

		await createPackageManager().runCommand("npm", ["install", "private-package"]);

		expect(subprocessState.calls).toHaveLength(1);
		expect(subprocessState.calls[0]?.options.stdio).toEqual(["ignore", 2, 2]);
	});
});
