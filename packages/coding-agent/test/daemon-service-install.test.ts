import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	type DaemonServiceInvocation,
	getDaemonServiceInvocation,
	getLaunchdPlistPath,
	getServiceNodePath,
	getSystemdUnitPath,
	installDaemonService,
	isDaemonServiceInstalled,
	isDaemonServiceProcess,
	LAUNCHD_SERVICE_LABEL,
	type RunServiceCommand,
	refreshDaemonService,
	renderLaunchdPlist,
	renderSystemdUnit,
	SYSTEMD_SERVICE_NAME,
	uninstallDaemonService,
} from "../src/daemon/service-install.ts";

function createCommandRecorder(exitCode = 0) {
	const calls: Array<{ command: string; args: string[] }> = [];
	const run: RunServiceCommand = async (command, args) => {
		calls.push({ command, args });
		return { code: exitCode, output: "" };
	};
	return { calls, run };
}

describe("daemon service install (M9)", () => {
	let home: string;
	let agentDir: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "volt-svc-home-"));
		agentDir = mkdtempSync(join(tmpdir(), "volt-svc-agent-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("renders a launchd plist that runs the daemon in the foreground with the agent dir pinned", () => {
		expect(LAUNCHD_SERVICE_LABEL).toBe("com.github.hansjm10.voltd");
		const invocation = getDaemonServiceInvocation(agentDir);
		expect(realpathSync(invocation.programArguments[0] ?? "")).toBe(realpathSync(process.execPath));
		expect(invocation.programArguments).toContain("--optimize-for-size");
		// --service tells the daemon its inherited environment is the login session's.
		expect(invocation.programArguments.slice(-4)).toEqual(["daemon", "run", "--foreground", "--service"]);

		const plist = renderLaunchdPlist(invocation);
		expect(plist).toContain(`<string>${LAUNCHD_SERVICE_LABEL}</string>`);
		for (const argument of invocation.programArguments) {
			expect(plist).toContain(`<string>${argument}</string>`);
		}
		expect(plist).toContain("<string>--service</string>");
		expect(plist).toContain(`<key>${ENV_AGENT_DIR}</key>`);
		expect(plist).toContain(`<string>${agentDir}</string>`);
		expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
		// A graceful `volt daemon stop` must stay stopped: no KeepAlive restart.
		expect(plist).toContain("<key>KeepAlive</key>\n\t<false/>");
	});

	// The service is darwin/Linux only, and Windows needs privileges to create symlinks.
	it.skipIf(process.platform === "win32")(
		"records Homebrew's opt link instead of the versioned Cellar path that brew upgrade removes",
		() => {
			const prefix = join(realpathSync(home), "homebrew");
			const installNode = (formula: string, version: string): string => {
				const node = join(prefix, "Cellar", formula, version, "bin", "node");
				mkdirSync(dirname(node), { recursive: true });
				writeFileSync(node, "");
				return node;
			};
			const linkOpt = (formula: string, version: string): void => {
				mkdirSync(join(prefix, "opt"), { recursive: true });
				symlinkSync(join("..", "Cellar", formula, version), join(prefix, "opt", formula));
			};

			const current = installNode("node", "24.1.0");
			linkOpt("node", "24.1.0");
			expect(getServiceNodePath(current)).toBe(join(prefix, "opt", "node", "bin", "node"));

			// Without an opt link there is no stable path; keep the one that runs.
			const versioned = installNode("node@22", "22.16.0_1");
			expect(getServiceNodePath(versioned)).toBe(versioned);
			// Keg-only versioned formulae have an opt link too.
			linkOpt("node@22", "22.16.0_1");
			expect(getServiceNodePath(versioned)).toBe(join(prefix, "opt", "node@22", "bin", "node"));

			// The opt link points at another version, so it would run a different Node.
			const stale = installNode("node", "23.0.0");
			expect(getServiceNodePath(stale)).toBe(stale);

			expect(getServiceNodePath("/usr/bin/node")).toBe("/usr/bin/node");
		},
	);

	it("escapes XML-special characters in launchd plist strings", () => {
		const plist = renderLaunchdPlist({
			programArguments: ["/usr/local/bin/node", '/tmp/we<ird & "dir"/cli.js', "daemon", "run", "--foreground"],
			agentDir: "/tmp/agent & dir",
			serviceLogPath: "/tmp/log",
		});
		expect(plist).toContain("<string>/tmp/we&lt;ird &amp; &quot;dir&quot;/cli.js</string>");
		expect(plist).toContain("<string>/tmp/agent &amp; dir</string>");
	});

	it("renders a systemd user unit with quoted exec args and no auto-restart", () => {
		const unit = renderSystemdUnit({
			programArguments: ["/usr/bin/node", "/opt/volt dir/cli.js", "daemon", "run", "--foreground"],
			agentDir: "/home/user/agent dir",
			serviceLogPath: "/home/user/agent/daemon/voltd.service.log",
		});
		expect(unit).toContain('ExecStart=/usr/bin/node "/opt/volt dir/cli.js" daemon run --foreground');
		expect(unit).toContain(`Environment=${ENV_AGENT_DIR}="/home/user/agent dir"`);
		expect(unit).toContain("Restart=no");
		expect(unit).toContain("WantedBy=default.target");

		const installedUnit = renderSystemdUnit(getDaemonServiceInvocation(agentDir));
		expect(installedUnit).toMatch(/^ExecStart=.* daemon run --foreground --service$/m);
	});

	it("install on macOS writes the plist and loads it via launchctl", async () => {
		const recorder = createCommandRecorder();
		const result = await installDaemonService({
			platform: "darwin",
			agentDir,
			home,
			runCommand: recorder.run,
		});
		expect(result.ok).toBe(true);
		const plistPath = getLaunchdPlistPath(home);
		expect(result.definitionPath).toBe(plistPath);
		expect(existsSync(plistPath)).toBe(true);
		expect(readFileSync(plistPath, "utf8")).toContain(LAUNCHD_SERVICE_LABEL);
		expect(recorder.calls.some((call) => call.command === "launchctl" && call.args[0] === "bootstrap")).toBe(true);

		const removal = await uninstallDaemonService({ platform: "darwin", home, runCommand: recorder.run });
		expect(removal.ok).toBe(true);
		expect(existsSync(plistPath)).toBe(false);
	});

	it("install on Linux writes the unit and enables it via systemctl --user", async () => {
		const recorder = createCommandRecorder();
		const result = await installDaemonService({
			platform: "linux",
			agentDir,
			home,
			runCommand: recorder.run,
		});
		expect(result.ok).toBe(true);
		const unitPath = getSystemdUnitPath(home);
		expect(existsSync(unitPath)).toBe(true);
		expect(
			recorder.calls.some(
				(call) =>
					call.command === "systemctl" && call.args.join(" ") === `--user enable --now ${SYSTEMD_SERVICE_NAME}`,
			),
		).toBe(true);

		const removal = await uninstallDaemonService({ platform: "linux", home, runCommand: recorder.run });
		expect(removal.ok).toBe(true);
		expect(existsSync(unitPath)).toBe(false);
	});

	it("reports failure with a manual fallback when loading fails, and rejects unsupported platforms", async () => {
		const failing = createCommandRecorder(1);
		const result = await installDaemonService({
			platform: "darwin",
			agentDir,
			home,
			runCommand: failing.run,
		});
		expect(result.ok).toBe(false);
		expect(result.messages.some((message) => message.includes("launchctl bootstrap"))).toBe(true);
		// The definition is still on disk for manual loading.
		expect(existsSync(getLaunchdPlistPath(home))).toBe(true);

		const unsupported = await installDaemonService({ platform: "win32", agentDir, home, runCommand: failing.run });
		expect(unsupported.ok).toBe(false);
	});

	it("recognizes the daemon launchd is running by its pid", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const launchctl =
			(code: number, output: string): RunServiceCommand =>
			async (command, args) => {
				calls.push({ command, args });
				return { code, output };
			};
		const running = `gui/501/${LAUNCHD_SERVICE_LABEL} = {\n\tstate = running\n\tpid = 4242\n}\n`;

		expect(await isDaemonServiceProcess(4242, { platform: "darwin", runCommand: launchctl(0, running) })).toBe(true);
		expect(calls[0]?.command).toBe("launchctl");
		expect(calls[0]?.args[0]).toBe("print");
		expect(calls[0]?.args[1]).toMatch(new RegExp(`^gui/\\d+/${LAUNCHD_SERVICE_LABEL}$`));
		// A daemon started from a terminal has a different pid than the service's.
		expect(await isDaemonServiceProcess(5151, { platform: "darwin", runCommand: launchctl(0, running) })).toBe(false);
		const notRunning = `gui/501/${LAUNCHD_SERVICE_LABEL} = {\n\tstate = not running\n}\n`;
		expect(await isDaemonServiceProcess(4242, { platform: "darwin", runCommand: launchctl(0, notRunning) })).toBe(
			false,
		);
		expect(await isDaemonServiceProcess(4242, { platform: "darwin", runCommand: launchctl(113, "") })).toBe(false);
	});

	it("recognizes the daemon systemd is running by its main pid", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const systemctl =
			(code: number, output: string): RunServiceCommand =>
			async (command, args) => {
				calls.push({ command, args });
				return { code, output };
			};

		expect(await isDaemonServiceProcess(4242, { platform: "linux", runCommand: systemctl(0, "4242\n") })).toBe(true);
		expect(calls[0]).toEqual({
			command: "systemctl",
			args: ["--user", "show", SYSTEMD_SERVICE_NAME, "--property=MainPID", "--value"],
		});
		expect(await isDaemonServiceProcess(4242, { platform: "linux", runCommand: systemctl(0, "0\n") })).toBe(false);
		expect(await isDaemonServiceProcess(4242, { platform: "linux", runCommand: systemctl(1, "4242\n") })).toBe(false);

		const unsupported = createCommandRecorder();
		expect(await isDaemonServiceProcess(4242, { platform: "win32", runCommand: unsupported.run })).toBe(false);
		expect(unsupported.calls).toEqual([]);
	});

	describe("refresh after an update", () => {
		// Differs from the agent dir the update runs with. Windows cannot create quotes or angle brackets.
		const pinnedAgentDir = () =>
			join(agentDir, process.platform === "win32" ? "pinned & dir" : 'pinned "a" \\ & <b>');

		function writeInstalledDefinition(
			definitionPath: string,
			render: (invocation: DaemonServiceInvocation) => string,
		): void {
			const invocation = getDaemonServiceInvocation(pinnedAgentDir());
			// The previous installation's entrypoint, which a package rename removed.
			invocation.programArguments = [
				process.execPath,
				"/removed/volt/dist/cli.js",
				"daemon",
				"run",
				"--foreground",
				"--service",
			];
			mkdirSync(dirname(definitionPath), { recursive: true });
			writeFileSync(definitionPath, render(invocation));
		}

		function createLaunchctl(printOutput: string, bootoutCode = 0) {
			const calls: string[][] = [];
			const run: RunServiceCommand = async (command, args) => {
				calls.push([command, ...args]);
				return args[0] === "print" ? { code: 0, output: printOutput } : { code: bootoutCode, output: "" };
			};
			return { calls, run };
		}

		it("does nothing when no service is installed", async () => {
			const recorder = createCommandRecorder();

			expect(isDaemonServiceInstalled({ platform: "linux", home })).toBe(false);
			expect((await refreshDaemonService({ platform: "linux", home, runCommand: recorder.run })).status).toBe(
				"not-installed",
			);
			expect((await refreshDaemonService({ platform: "win32", home, runCommand: recorder.run })).status).toBe(
				"not-installed",
			);
			expect(recorder.calls).toEqual([]);
		});

		it("points a systemd unit at this installation, keeping its agent dir, without starting the daemon", async () => {
			const unitPath = getSystemdUnitPath(home);
			writeInstalledDefinition(unitPath, renderSystemdUnit);
			expect(isDaemonServiceInstalled({ platform: "linux", home })).toBe(true);
			const recorder = createCommandRecorder();

			const result = await refreshDaemonService({ platform: "linux", home, runCommand: recorder.run });

			expect(result.status).toBe("updated");
			expect(readFileSync(unitPath, "utf8")).toBe(renderSystemdUnit(getDaemonServiceInvocation(pinnedAgentDir())));
			expect(recorder.calls).toEqual([{ command: "systemctl", args: ["--user", "daemon-reload"] }]);

			const again = await refreshDaemonService({ platform: "linux", home, runCommand: recorder.run });
			expect(again.status).toBe("unchanged");
			expect(recorder.calls).toHaveLength(1);
		});

		it("points a launchd plist at this installation and unloads the idle job instead of starting it", async () => {
			const plistPath = getLaunchdPlistPath(home);
			writeInstalledDefinition(plistPath, renderLaunchdPlist);
			const launchctl = createLaunchctl(`gui/501/${LAUNCHD_SERVICE_LABEL} = {\n\tstate = not running\n}\n`);

			const result = await refreshDaemonService({ platform: "darwin", home, runCommand: launchctl.run });

			expect(result.status).toBe("updated");
			expect(readFileSync(plistPath, "utf8")).toBe(renderLaunchdPlist(getDaemonServiceInvocation(pinnedAgentDir())));
			expect(launchctl.calls.map((call) => call.slice(0, 2))).toEqual([
				["launchctl", "print"],
				["launchctl", "bootout"],
			]);
			expect(result.messages.join("\n")).toContain("volt daemon install-service");
		});

		it("leaves a launchd job that is running the daemon loaded", async () => {
			writeInstalledDefinition(getLaunchdPlistPath(home), renderLaunchdPlist);
			const launchctl = createLaunchctl(
				`gui/501/${LAUNCHD_SERVICE_LABEL} = {\n\tstate = running\n\tpid = 4242\n}\n`,
			);

			const result = await refreshDaemonService({ platform: "darwin", home, runCommand: launchctl.run });

			expect(result.status).toBe("updated");
			expect(launchctl.calls.map((call) => call[1])).toEqual(["print"]);
		});

		it("reports failure when the service manager does not accept the change or the agent dir is unreadable", async () => {
			writeInstalledDefinition(getSystemdUnitPath(home), renderSystemdUnit);
			const failingSystemctl = createCommandRecorder(1);
			expect(
				(await refreshDaemonService({ platform: "linux", home, runCommand: failingSystemctl.run })).status,
			).toBe("failed");

			const plistPath = getLaunchdPlistPath(home);
			writeInstalledDefinition(plistPath, renderLaunchdPlist);
			const failingBootout = createLaunchctl(`gui/501/${LAUNCHD_SERVICE_LABEL} = {\n\tstate = not running\n}\n`, 5);
			expect((await refreshDaemonService({ platform: "darwin", home, runCommand: failingBootout.run })).status).toBe(
				"failed",
			);

			writeFileSync(plistPath, "<plist/>");
			const recorder = createCommandRecorder();
			expect((await refreshDaemonService({ platform: "darwin", home, runCommand: recorder.run })).status).toBe(
				"failed",
			);
			expect(readFileSync(plistPath, "utf8")).toBe("<plist/>");
			expect(recorder.calls).toEqual([]);
		});
	});
});
