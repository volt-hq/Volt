import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ENV_AGENT_DIR, getAgentDir } from "../config.ts";
import { getDaemonPaths } from "./paths.ts";
import { resolveDaemonCliInvocation } from "./spawn.ts";

/**
 * `volt daemon install-service` (M9): generate and register an OS login
 * service — a launchd LaunchAgent on macOS, a systemd user unit on Linux —
 * that runs `volt daemon run --foreground` so the daemon comes back after
 * logout/login without anything having to spawn it on demand.
 *
 * The service does NOT auto-restart after `volt daemon stop` (KeepAlive off /
 * Restart=no): a graceful stop stays stopped until the next login or a manual
 * `volt daemon start`. This also avoids restart loops with the daemon's
 * single-instance exit when something else already started one.
 */

export const LAUNCHD_SERVICE_LABEL = "com.github.hansjm10.voltd";
export const SYSTEMD_SERVICE_NAME = "voltd.service";

export interface DaemonServiceInvocation {
	/** Full program argv: node executable, entry, "daemon", "run", "--foreground". */
	programArguments: string[];
	agentDir: string;
	/** Captures pre-logger crashes; the daemon's own log is voltd.log. */
	serviceLogPath: string;
}

export function getDaemonServiceInvocation(agentDir: string = getAgentDir()): DaemonServiceInvocation {
	const { nodeArgs, entry } = resolveDaemonCliInvocation();
	const paths = getDaemonPaths(agentDir);
	return {
		programArguments: [process.execPath, ...nodeArgs, entry, "daemon", "run", "--foreground"],
		agentDir,
		serviceLogPath: join(paths.daemonDir, "voltd.service.log"),
	};
}

export function getLaunchdPlistPath(home: string = homedir()): string {
	return join(home, "Library", "LaunchAgents", `${LAUNCHD_SERVICE_LABEL}.plist`);
}

export function getSystemdUnitPath(home?: string): string {
	// An explicit home (tests) wins; otherwise honor XDG_CONFIG_HOME.
	const configHome =
		home !== undefined ? join(home, ".config") : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(configHome, "systemd", "user", SYSTEMD_SERVICE_NAME);
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderLaunchdPlist(invocation: DaemonServiceInvocation): string {
	const args = invocation.programArguments.map((argument) => `\t\t<string>${escapeXml(argument)}</string>`).join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCHD_SERVICE_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${args}
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<false/>
	<key>EnvironmentVariables</key>
	<dict>
		<key>${ENV_AGENT_DIR}</key>
		<string>${escapeXml(invocation.agentDir)}</string>
	</dict>
	<key>StandardOutPath</key>
	<string>${escapeXml(invocation.serviceLogPath)}</string>
	<key>StandardErrorPath</key>
	<string>${escapeXml(invocation.serviceLogPath)}</string>
	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
`;
}

/** systemd-style quoting: wrap args containing spaces/quotes in double quotes. */
function systemdQuote(argument: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(argument)) {
		return argument;
	}
	return `"${argument.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderSystemdUnit(invocation: DaemonServiceInvocation): string {
	const execStart = invocation.programArguments.map(systemdQuote).join(" ");
	return `[Unit]
Description=Volt background daemon (voltd)

[Service]
Type=simple
ExecStart=${execStart}
Environment=${ENV_AGENT_DIR}=${systemdQuote(invocation.agentDir)}
Restart=no
StandardOutput=append:${invocation.serviceLogPath}
StandardError=append:${invocation.serviceLogPath}

[Install]
WantedBy=default.target
`;
}

export type RunServiceCommand = (command: string, args: string[]) => Promise<{ code: number; output: string }>;

const defaultRunCommand: RunServiceCommand = (command, args) =>
	new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.on("error", (error) => resolve({ code: 127, output: error.message }));
		child.on("close", (code) => resolve({ code: code ?? 1, output }));
	});

export interface ServiceInstallResult {
	ok: boolean;
	definitionPath: string;
	messages: string[];
}

export interface ServiceInstallOptions {
	platform?: NodeJS.Platform;
	agentDir?: string;
	home?: string;
	runCommand?: RunServiceCommand;
}

export async function installDaemonService(options: ServiceInstallOptions = {}): Promise<ServiceInstallResult> {
	const platform = options.platform ?? process.platform;
	const agentDir = options.agentDir ?? getAgentDir();
	const runCommand = options.runCommand ?? defaultRunCommand;
	const invocation = getDaemonServiceInvocation(agentDir);
	mkdirSync(dirname(invocation.serviceLogPath), { recursive: true, mode: 0o700 });

	if (platform === "darwin") {
		const plistPath = getLaunchdPlistPath(options.home);
		mkdirSync(dirname(plistPath), { recursive: true });
		writeFileSync(plistPath, renderLaunchdPlist(invocation), { mode: 0o644 });
		const messages = [`Wrote ${plistPath}`];
		const uid = typeof process.getuid === "function" ? process.getuid() : 501;
		// Re-bootstrapping an already-loaded label fails; boot it out first.
		await runCommand("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_SERVICE_LABEL}`]);
		const bootstrap = await runCommand("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
		if (bootstrap.code === 0) {
			messages.push("Loaded launchd service (starts at login).");
			return { ok: true, definitionPath: plistPath, messages };
		}
		const legacyLoad = await runCommand("launchctl", ["load", "-w", plistPath]);
		if (legacyLoad.code === 0) {
			messages.push("Loaded launchd service (starts at login).");
			return { ok: true, definitionPath: plistPath, messages };
		}
		messages.push(
			`launchctl load failed (${bootstrap.output.trim() || legacyLoad.output.trim() || "unknown error"}); ` +
				`load manually with: launchctl bootstrap gui/${uid} ${plistPath}`,
		);
		return { ok: false, definitionPath: plistPath, messages };
	}

	if (platform === "linux") {
		const unitPath = getSystemdUnitPath(options.home);
		mkdirSync(dirname(unitPath), { recursive: true });
		writeFileSync(unitPath, renderSystemdUnit(invocation), { mode: 0o644 });
		const messages = [`Wrote ${unitPath}`];
		const reload = await runCommand("systemctl", ["--user", "daemon-reload"]);
		const enable = await runCommand("systemctl", ["--user", "enable", "--now", SYSTEMD_SERVICE_NAME]);
		if (reload.code === 0 && enable.code === 0) {
			messages.push("Enabled systemd user service (starts at login).");
			messages.push("For boot-without-login, also run: loginctl enable-linger");
			return { ok: true, definitionPath: unitPath, messages };
		}
		messages.push(
			`systemctl failed (${(reload.output + enable.output).trim() || "unknown error"}); ` +
				`enable manually with: systemctl --user enable --now ${SYSTEMD_SERVICE_NAME}`,
		);
		return { ok: false, definitionPath: unitPath, messages };
	}

	return {
		ok: false,
		definitionPath: "",
		messages: [`volt daemon install-service is not supported on ${platform}.`],
	};
}

export async function uninstallDaemonService(options: ServiceInstallOptions = {}): Promise<ServiceInstallResult> {
	const platform = options.platform ?? process.platform;
	const runCommand = options.runCommand ?? defaultRunCommand;

	if (platform === "darwin") {
		const plistPath = getLaunchdPlistPath(options.home);
		const messages: string[] = [];
		const uid = typeof process.getuid === "function" ? process.getuid() : 501;
		const bootout = await runCommand("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_SERVICE_LABEL}`]);
		if (bootout.code !== 0) {
			await runCommand("launchctl", ["unload", plistPath]);
		}
		if (existsSync(plistPath)) {
			rmSync(plistPath, { force: true });
			messages.push(`Removed ${plistPath}`);
		} else {
			messages.push("No launchd service was installed.");
		}
		return { ok: true, definitionPath: plistPath, messages };
	}

	if (platform === "linux") {
		const unitPath = getSystemdUnitPath(options.home);
		const messages: string[] = [];
		await runCommand("systemctl", ["--user", "disable", "--now", SYSTEMD_SERVICE_NAME]);
		if (existsSync(unitPath)) {
			rmSync(unitPath, { force: true });
			messages.push(`Removed ${unitPath}`);
		} else {
			messages.push("No systemd user service was installed.");
		}
		await runCommand("systemctl", ["--user", "daemon-reload"]);
		return { ok: true, definitionPath: unitPath, messages };
	}

	return {
		ok: false,
		definitionPath: "",
		messages: [`volt daemon uninstall-service is not supported on ${platform}.`],
	};
}
