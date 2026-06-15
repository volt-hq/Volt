import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoreCatalog } from "../src/store/catalog.ts";
import { inspectStorePackage } from "../src/store/inspector.ts";
import { resolveStoreSource } from "../src/store/resolver.ts";

interface CapturedSpawnOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	stdio?: unknown;
}

interface CapturedSpawnCall {
	command: string;
	args: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

const subprocessState = vi.hoisted(() => ({
	calls: [] as CapturedSpawnCall[],
}));

const osState = vi.hoisted(() => ({
	tempDir:
		process.env.TMPDIR ??
		process.env.TEMP ??
		process.env.TMP ??
		(process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp"),
}));

vi.mock("node:os", () => ({
	tmpdir: () => osState.tempDir,
}));

vi.mock("../src/utils/child-process.ts", () => {
	class FakeReadable {
		private dataListeners: Array<(chunk: Buffer) => void> = [];

		on(event: string, listener: (chunk: Buffer) => void): this {
			if (event === "data") {
				this.dataListeners.push(listener);
			}
			return this;
		}

		emitData(data: string): void {
			if (!data) return;
			const chunk = Buffer.from(data);
			for (const listener of this.dataListeners) {
				listener(chunk);
			}
		}
	}

	class FakeChildProcess {
		stdout = new FakeReadable();
		stderr = new FakeReadable();
		signalCode: NodeJS.Signals | null = null;
		private stdoutText: string;

		constructor(stdoutText: string) {
			this.stdoutText = stdoutText;
		}

		once(event: string, listener: (...args: unknown[]) => void): this {
			if (event === "close") {
				queueMicrotask(() => {
					this.stdout.emitData(this.stdoutText);
					listener(0, null);
				});
			}
			return this;
		}

		kill(): boolean {
			return true;
		}
	}

	function getStdout(args: string[]): string {
		if (args[0] === "ls-remote") {
			return "0123456789abcdef0123456789abcdef01234567\tHEAD";
		}
		if (args.includes("view")) {
			return JSON.stringify({ name: "env-probe", version: "1.0.0" });
		}
		return "";
	}

	return {
		spawnProcess: vi.fn((command: string, args: string[], options: CapturedSpawnOptions) => {
			subprocessState.calls.push({ command, args, cwd: options.cwd, env: options.env });
			return new FakeChildProcess(getStdout(args));
		}),
	};
});

const originalEnv = { ...process.env };
const catalog: StoreCatalog = { schemaVersion: 1, packages: [] };

afterEach(() => {
	process.env = { ...originalEnv };
	subprocessState.calls.length = 0;
});

function clearProcessEnv(): void {
	process.env = {};
}

function expectRecoveredPath(env: NodeJS.ProcessEnv | undefined): void {
	const expectedPath = originalEnv.PATH ?? originalEnv.Path;
	expect(expectedPath).toBeTruthy();
	expect(env?.PATH ?? env?.Path).toBe(expectedPath);
}

describe("store subprocess environment", () => {
	it("preserves the recovered environment for npm package inspection", async () => {
		clearProcessEnv();

		await inspectStorePackage({ source: "npm:env-probe@1.0.0", cwd: ".", npmCommand: ["npm"] });

		const npmCall = subprocessState.calls.find((call) => call.command === "npm" && call.args[0] === "view");
		expect(npmCall).toBeDefined();
		expectRecoveredPath(npmCall?.env);
	});

	it("preserves the recovered environment for git package inspection", async () => {
		clearProcessEnv();

		await inspectStorePackage({ source: "git:https://github.com/user/repo@main", cwd: "." });

		const cloneCall = subprocessState.calls.find((call) => call.command === "git" && call.args[0] === "clone");
		expect(cloneCall).toBeDefined();
		expect(cloneCall?.env?.GIT_TERMINAL_PROMPT).toBe("0");
		expectRecoveredPath(cloneCall?.env);
	});

	it("preserves the recovered environment when resolving git HEAD", async () => {
		clearProcessEnv();

		await resolveStoreSource({ input: "https://github.com/user/repo", catalog });

		const lsRemoteCall = subprocessState.calls.find((call) => call.command === "git" && call.args[0] === "ls-remote");
		expect(lsRemoteCall).toBeDefined();
		expect(lsRemoteCall?.env?.GIT_TERMINAL_PROMPT).toBe("0");
		expectRecoveredPath(lsRemoteCall?.env);
	});
});
