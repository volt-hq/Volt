/**
 * #464: voltd adopts the user's login-shell environment at startup so daemon-hosted
 * runtimes resolve tools the way a terminal would. Every resolver test injects a
 * fake shell script; the developer's real login shell and dotfiles never run.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import type { ControlResponse } from "../src/daemon/control-protocol.ts";
import {
	type DaemonEnvironmentResolution,
	type DaemonEnvironmentStatus,
	readSystemdUserEnvironment,
	resolveDaemonEnvironment,
} from "../src/daemon/login-environment.ts";
import { runVoltDaemon } from "../src/daemon/main.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import { type DaemonProbeResult, probeDaemon } from "../src/daemon/spawn.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "volt-login-env-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function writeShell(name: string, body: string, directory = "bin"): string {
	const binDir = join(tempDir, directory);
	mkdirSync(binDir, { recursive: true });
	const path = join(binDir, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

/** Stands in for a login shell: noisy profile, exports, then runs the real command string. */
function writeProfileShell(extraLines: string[] = []): string {
	return writeShell(
		"zsh",
		[
			'echo "Welcome back from your profile"',
			'export SAW_TERM_PROGRAM="[$TERM_PROGRAM]"',
			'export SAW_RESOLVING="[$VOLT_RESOLVING_ENVIRONMENT]"',
			"export FROM_DOTFILES=1",
			'export PATH="/opt/fake/bin:$PATH"',
			...extraLines,
			'exec /bin/sh -c "$4"',
		].join("\n"),
	);
}

function terminalEnvironment(): NodeJS.ProcessEnv {
	return {
		HOME: tempDir,
		USER: "tester",
		LC_ALL: "C",
		PATH: "/terminal/bin:/usr/bin:/bin",
		TERM_PROGRAM: "Apple_Terminal",
		VOLT_CODING_AGENT_DIR: "/agent/dir",
		VOLT_PACKAGE_DIR: "/package/dir",
	};
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(process.platform === "win32")("resolveDaemonEnvironment", () => {
	it("adopts the login-shell environment from a clean base and keeps voltd's VOLT_* settings", async () => {
		const shell = writeProfileShell();
		const inherited = terminalEnvironment();
		const target = { ...inherited };

		const result = await resolveDaemonEnvironment({ target, inherited, platform: "darwin", shell });

		expect(result.failed).toBe(false);
		expect(result.status).toMatchObject({ source: "login-shell", base: "minimal", shell });
		expect(result.status.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.droppedVariables).toEqual(["TERM_PROGRAM"]);
		expect(target.FROM_DOTFILES).toBe("1");
		expect(target.PATH).toBe("/opt/fake/bin:/usr/bin:/bin:/usr/sbin:/sbin");
		expect(target.HOME).toBe(tempDir);
		expect(target.LC_ALL).toBe("C");
		expect(target.VOLT_CODING_AGENT_DIR).toBe("/agent/dir");
		expect(target.VOLT_PACKAGE_DIR).toBe("/package/dir");
		// The shell never saw the starting terminal's variables, and the result drops them.
		expect(target.SAW_TERM_PROGRAM).toBe("[]");
		expect(target.SAW_RESOLVING).toBe("[1]");
		expect(target.TERM_PROGRAM).toBeUndefined();
		for (const name of [
			"PWD",
			"OLDPWD",
			"SHLVL",
			"_",
			"VOLT_RESOLVING_ENVIRONMENT",
			"VOLT_ENV_NODE",
			"VOLT_ENV_SCRIPT",
			"VOLT_ENV_MARKER",
		]) {
			expect(target, name).not.toHaveProperty(name);
		}
	});

	it("uses the Linux default PATH and keeps display and XDG variables without a session environment", async () => {
		const shell = writeProfileShell();
		const inherited: NodeJS.ProcessEnv = {
			...terminalEnvironment(),
			DISPLAY: ":0",
			WAYLAND_DISPLAY: "wayland-0",
			XDG_CONFIG_HOME: "/home/tester/.config",
		};
		const target = { ...inherited };

		const result = await resolveDaemonEnvironment({
			target,
			inherited,
			platform: "linux",
			shell,
			readSessionEnvironment: async () => undefined,
		});

		expect(result.status).toMatchObject({ source: "login-shell", base: "minimal" });
		expect(target.PATH).toBe("/opt/fake/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
		expect(target).toMatchObject({
			DISPLAY: ":0",
			WAYLAND_DISPLAY: "wayland-0",
			XDG_CONFIG_HOME: "/home/tester/.config",
		});
	});

	it("seeds a service start from the full inherited session environment", async () => {
		const shell = writeProfileShell(["unset REMOVED_BY_PROFILE"]);
		const inherited: NodeJS.ProcessEnv = {
			HOME: tempDir,
			USER: "tester",
			PATH: "/session/bin:/usr/bin:/bin",
			WAYLAND_DISPLAY: "wayland-0",
			HTTPS_PROXY: "http://proxy.internal:3128",
			NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
			REMOVED_BY_PROFILE: "1",
			VOLT_CODING_AGENT_DIR: "/agent/dir",
		};
		const target = { ...inherited };

		const result = await resolveDaemonEnvironment({
			target,
			inherited,
			platform: "linux",
			serviceStart: true,
			shell,
		});

		expect(result.status).toMatchObject({ source: "login-shell", base: "service", shell });
		expect(target.PATH).toBe("/opt/fake/bin:/session/bin:/usr/bin:/bin");
		expect(target).toMatchObject({
			WAYLAND_DISPLAY: "wayland-0",
			HTTPS_PROXY: "http://proxy.internal:3128",
			NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
			FROM_DOTFILES: "1",
			VOLT_CODING_AGENT_DIR: "/agent/dir",
		});
		// The profile still decides: a variable it unsets does not come back.
		expect(target).not.toHaveProperty("REMOVED_BY_PROFILE");
		expect(result.droppedVariables).toEqual(["REMOVED_BY_PROFILE"]);
	});

	it("seeds a Linux terminal start from the systemd user manager environment", async () => {
		const shell = writeProfileShell();
		const inherited: NodeJS.ProcessEnv = { ...terminalEnvironment(), AD_HOC_TOKEN: "terminal-only" };
		const target = { ...inherited };
		const readSessionEnvironment = vi.fn(async () => ({
			HOME: tempDir,
			USER: "tester",
			PATH: "/manager/bin:/usr/bin:/bin",
			FROM_ENVIRONMENT_D: "1",
		}));

		const result = await resolveDaemonEnvironment({
			target,
			inherited,
			platform: "linux",
			shell,
			readSessionEnvironment,
		});

		expect(readSessionEnvironment).toHaveBeenCalledOnce();
		expect(result.status).toMatchObject({ source: "login-shell", base: "systemd", shell });
		expect(target.PATH).toBe("/opt/fake/bin:/manager/bin:/usr/bin:/bin");
		expect(target.FROM_ENVIRONMENT_D).toBe("1");
		expect(target.VOLT_CODING_AGENT_DIR).toBe("/agent/dir");
		expect(target.SAW_TERM_PROGRAM).toBe("[]");
		expect(target).not.toHaveProperty("TERM_PROGRAM");
		expect(target).not.toHaveProperty("AD_HOC_TOKEN");
		expect(result.droppedVariables).toEqual(["AD_HOC_TOKEN", "LC_ALL", "TERM_PROGRAM"]);
	});

	it("reads the session environment only for Linux terminal starts", async () => {
		const shell = writeProfileShell();
		const readSessionEnvironment = vi.fn(async () => ({ PATH: "/manager/bin" }));

		for (const [platform, serviceStart, base] of [
			["darwin", false, "minimal"],
			["linux", true, "service"],
		] as const) {
			const inherited = terminalEnvironment();
			const result = await resolveDaemonEnvironment({
				target: { ...inherited },
				inherited,
				platform,
				serviceStart,
				shell,
				readSessionEnvironment,
			});
			expect(result.status.base, platform).toBe(base);
		}
		expect(readSessionEnvironment).not.toHaveBeenCalled();
	});

	it("kills a hung shell tree at the timeout and keeps the inherited environment", async () => {
		const shell = writeShell(
			"bash",
			['echo $$ > "$HOME/shell.pid"', "sleep 30 &", 'echo $! > "$HOME/child.pid"', "wait"].join("\n"),
		);
		const inherited = terminalEnvironment();
		const target = { ...inherited };

		const result = await resolveDaemonEnvironment({ target, inherited, platform: "darwin", shell, timeoutMs: 2_000 });

		expect(result.failed).toBe(true);
		expect(result.status).toMatchObject({ source: "inherited", shell, reason: "timed out after 2000ms" });
		expect(target).toEqual(inherited);
		const pids = ["shell.pid", "child.pid"].map((file) =>
			Number.parseInt(readFileSync(join(tempDir, file), "utf8"), 10),
		);
		await vi.waitFor(() => {
			for (const pid of pids) expect(isAlive(pid), `pid ${pid}`).toBe(false);
		});
	});

	it("keeps the inherited environment when the shell exits without printing one", async () => {
		const shell = writeShell("zsh", ['echo "profile error: broken" >&2', "exit 3"].join("\n"));
		const inherited = terminalEnvironment();
		const target = { ...inherited };

		const result = await resolveDaemonEnvironment({ target, inherited, platform: "darwin", shell });

		expect(result).toMatchObject({
			failed: true,
			exitCode: 3,
			status: { source: "inherited", shell, reason: "no environment in shell output (exit code 3)" },
		});
		expect(result.stderrTail).toContain("profile error: broken");
		expect(target).toEqual(inherited);
	});

	it("does not run an unsupported login shell", async () => {
		const shell = writeShell("tcsh", 'touch "$HOME/ran"');
		const inherited = terminalEnvironment();
		const target = { ...inherited };

		const result = await resolveDaemonEnvironment({ target, inherited, platform: "darwin", shell });

		expect(result).toMatchObject({
			failed: true,
			status: { source: "inherited", shell, reason: "unsupported login shell tcsh" },
		});
		expect(existsSync(join(tempDir, "ran"))).toBe(false);
		expect(target).toEqual(inherited);
	});

	it("keeps the inherited environment on Windows and when opted out", async () => {
		const shell = writeProfileShell();
		const inherited = terminalEnvironment();
		const target = { ...inherited };

		const windows = await resolveDaemonEnvironment({ target, inherited, platform: "win32", shell });
		expect(windows).toMatchObject({ failed: false, status: { source: "inherited" } });
		expect(target).toEqual(inherited);

		const optedOutInherited = { ...inherited, VOLT_DAEMON_INHERIT_ENV: "1" };
		const optedOutTarget = { ...optedOutInherited };
		const optedOut = await resolveDaemonEnvironment({
			target: optedOutTarget,
			inherited: optedOutInherited,
			platform: "darwin",
			shell,
		});
		expect(optedOut).toEqual({
			failed: false,
			status: { source: "inherited", reason: "VOLT_DAEMON_INHERIT_ENV is set" },
		});
		expect(optedOutTarget).toEqual(optedOutInherited);
	});
});

describe.skipIf(process.platform === "win32")("readSystemdUserEnvironment", () => {
	const expectedArgs =
		"--user --json=short get-property org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager Environment";

	function busctlDirectory(directory: string, body: string): string {
		return dirname(writeShell("busctl", body, directory));
	}

	it("parses the manager environment, including values that contain '='", async () => {
		const bin = busctlDirectory(
			"busctl-ok",
			[
				`[ "$*" = "${expectedArgs}" ] || exit 9`,
				`printf '%s\\n' '{"type":"as","data":["PATH=/manager/bin:/usr/bin","JAVA_TOOL_OPTIONS=-Da=b","EMPTY="]}'`,
			].join("\n"),
		);

		await expect(readSystemdUserEnvironment({ PATH: bin })).resolves.toEqual({
			PATH: "/manager/bin:/usr/bin",
			JAVA_TOOL_OPTIONS: "-Da=b",
			EMPTY: "",
		});
	});

	it("returns undefined when busctl fails, prints something else, or is missing", async () => {
		const failing = busctlDirectory("busctl-exit", `echo '{"type":"as","data":[]}'\nexit 1`);
		const malformed = busctlDirectory("busctl-malformed", "echo not-json");
		const nonString = busctlDirectory("busctl-non-string", `echo '{"type":"as","data":[1]}'`);
		const missing = join(tempDir, "empty");
		mkdirSync(missing);

		for (const bin of [failing, malformed, nonString, missing]) {
			await expect(readSystemdUserEnvironment({ PATH: bin }), bin).resolves.toBeUndefined();
		}
	});
});

describe("voltd environment status", () => {
	async function waitForHealthy(agentDir: string): Promise<DaemonProbeResult> {
		let status = await probeDaemon(agentDir);
		for (let attempt = 0; !status.healthy && attempt < 50; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			status = await probeDaemon(agentDir);
		}
		expect(status.healthy).toBe(true);
		return status;
	}

	async function runAndReadStatus(
		prepareEnvironment?: () => Promise<DaemonEnvironmentResolution>,
	): Promise<DaemonEnvironmentStatus> {
		const agentDir = join(tempDir, "agent");
		const daemon = runVoltDaemon({
			agentDir,
			foreground: false,
			...(prepareEnvironment ? { prepareEnvironment } : {}),
		});
		const probe = await waitForHealthy(agentDir);
		const client = createDaemonClient({
			socketPath: probe.socketPath,
			client: "cli",
			version: "test",
			authToken: probe.authToken,
			reconnect: false,
		});
		const status = await client.request({ type: "status" });
		await client.request({ type: "shutdown" });
		await client.close();
		await expect(daemon).resolves.toBe(0);
		expect(status.type).toBe("status_result");
		return (status as Extract<ControlResponse, { type: "status_result" }>).environment;
	}

	it("reports and logs the prepared environment", async () => {
		const prepared: DaemonEnvironmentStatus = {
			source: "login-shell",
			base: "service",
			shell: "/bin/zsh",
			durationMs: 42,
		};

		await expect(
			runAndReadStatus(async () => ({ status: prepared, failed: false, droppedVariables: ["TERM_PROGRAM"] })),
		).resolves.toEqual(prepared);
		const log = readFileSync(getDaemonPaths(join(tempDir, "agent")).logPath, "utf8");
		expect(log).toContain("resolved environment from login shell /bin/zsh");
		expect(log).toContain('"base":"service"');
		expect(log).toContain('"droppedVariables":["TERM_PROGRAM"]');
	}, 30_000);

	it("reports an unresolved inherited environment without a hook", async () => {
		await expect(runAndReadStatus()).resolves.toEqual({ source: "inherited", reason: "not resolved" });
	}, 30_000);
});
