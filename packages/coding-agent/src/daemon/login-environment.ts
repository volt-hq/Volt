import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { basename } from "node:path";
import { killProcessTree } from "../utils/shell.ts";

/**
 * Daemon-hosted runtimes run inside voltd, so bash, LSP servers, MCP servers,
 * installers, and git all resolve through voltd's process environment. A login
 * service starts voltd with launchd's or systemd's minimal PATH, while an
 * on-demand daemon keeps the environment of whichever terminal started it.
 *
 * At startup voltd instead runs the user's login shell once and adopts the
 * environment it produces. The shell starts from the environment a new terminal
 * session starts from, before any profile runs:
 * - service: the login service started voltd, so the inherited environment is
 *   the session's (launchd or the systemd user manager, including
 *   `launchctl setenv`, environment.d, and imported display variables).
 * - systemd: a terminal started voltd on Linux; the systemd user manager's
 *   environment replaces the terminal's.
 * - minimal: a terminal started voltd and no session environment is
 *   available; the platform default PATH plus a small session allowlist.
 * Both start paths then converge on the environment a new terminal would have,
 * without the starting terminal's one-off exports.
 */

export const DAEMON_ENVIRONMENT_TIMEOUT_MS = 10_000;
export const SYSTEMD_ENVIRONMENT_TIMEOUT_MS = 2_000;
/** Set to 1 to keep the environment voltd was started with. */
export const DAEMON_INHERIT_ENV_VARIABLE = "VOLT_DAEMON_INHERIT_ENV";
/** Set while the login shell runs so dotfiles can skip interactive-only work. */
export const DAEMON_RESOLVING_ENV_VARIABLE = "VOLT_RESOLVING_ENVIRONMENT";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2_000;
const SUPPORTED_SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash", "ksh"]);
// Valid in POSIX shells and fish; values arrive through the environment so no quoting is needed.
const SHELL_COMMAND = '"$VOLT_ENV_NODE" -e "$VOLT_ENV_SCRIPT"';
const ENV_SCRIPT =
	"const m=process.env.VOLT_ENV_MARKER;delete process.env.VOLT_ENV_MARKER;process.stdout.write(m+JSON.stringify(process.env)+m);";
const HELPER_VARIABLES = [DAEMON_RESOLVING_ENV_VARIABLE, "VOLT_ENV_NODE", "VOLT_ENV_SCRIPT", "VOLT_ENV_MARKER"];
/** Shell bookkeeping that describes the resolving shell, not the user's environment. */
const SHELL_STATE_VARIABLES = ["PWD", "OLDPWD", "SHLVL", "_"];
/** Session variables a terminal start keeps when no session environment is available. */
const MINIMAL_BASE_VARIABLES = [
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"LANG",
	"SSH_AUTH_SOCK",
	"__CF_USER_TEXT_ENCODING",
	"DBUS_SESSION_BUS_ADDRESS",
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"XAUTHORITY",
];
const MINIMAL_BASE_PREFIXES = ["LC_", "XDG_"];
const DARWIN_DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const POSIX_DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const SYSTEMD_ENVIRONMENT_ARGS = [
	"--user",
	"--json=short",
	"get-property",
	"org.freedesktop.systemd1",
	"/org/freedesktop/systemd1",
	"org.freedesktop.systemd1.Manager",
	"Environment",
];

/** Environment the login shell started from; see the module comment. */
export type DaemonEnvironmentBase = "service" | "systemd" | "minimal";

/** How voltd resolved the environment its runtimes and tools use. Reported by `volt daemon status`. */
export interface DaemonEnvironmentStatus {
	source: "login-shell" | "inherited";
	/** Set when source is login-shell. */
	base?: DaemonEnvironmentBase;
	/** Login shell that was run, or would have been run. */
	shell?: string;
	durationMs?: number;
	/** Why the inherited environment is in use. */
	reason?: string;
}

export interface DaemonEnvironmentResolution {
	status: DaemonEnvironmentStatus;
	/** Resolution was expected to work but fell back to the inherited environment. */
	failed: boolean;
	/** Log-only shell diagnostics; never sent to clients. */
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	stderrTail?: string;
	/** Log-only: sorted names of inherited variables the resolved environment no longer has. */
	droppedVariables?: string[];
}

export interface ResolveDaemonEnvironmentOptions {
	/** Environment replaced in place on success. Defaults to process.env. */
	target?: NodeJS.ProcessEnv;
	/** Environment voltd was started with. Defaults to a snapshot of target. */
	inherited?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** The login service started voltd, so the inherited environment is the session's. */
	serviceStart?: boolean;
	/**
	 * Session environment for a terminal start on Linux. Defaults to the systemd
	 * user manager's environment; not called for service starts or other platforms.
	 */
	readSessionEnvironment?: () => Promise<Record<string, string> | undefined>;
	/** Login shell path. Defaults to the password database entry, then SHELL. */
	shell?: string;
	/** Node executable that prints the environment. Defaults to process.execPath. */
	nodePath?: string;
	timeoutMs?: number;
}

interface LoginShellRun {
	payload?: string;
	failure?: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stderrTail: string;
}

function findLoginShell(inherited: NodeJS.ProcessEnv): string | undefined {
	try {
		const shell = userInfo().shell;
		if (shell) {
			return shell;
		}
	} catch {
		// No password database entry for this uid; fall back to SHELL.
	}
	return inherited.SHELL || undefined;
}

function parseSystemdEnvironment(stdout: string): Record<string, string> | undefined {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || !("type" in value) || !("data" in value)) {
		return undefined;
	}
	if (value.type !== "as" || !Array.isArray(value.data)) {
		return undefined;
	}
	const environment: Record<string, string> = {};
	for (const entry of value.data as unknown[]) {
		if (typeof entry !== "string") {
			return undefined;
		}
		const separator = entry.indexOf("=");
		if (separator <= 0) {
			return undefined;
		}
		environment[entry.slice(0, separator)] = entry.slice(separator + 1);
	}
	return environment;
}

/**
 * The systemd user manager's environment: what it hands the services it starts,
 * including environment.d, `systemctl --user set-environment`, and variables the
 * desktop session imported. Undefined when busctl or the user bus is unavailable.
 */
export function readSystemdUserEnvironment(
	env: NodeJS.ProcessEnv,
	timeoutMs = SYSTEMD_ENVIRONMENT_TIMEOUT_MS,
): Promise<Record<string, string> | undefined> {
	return new Promise((resolve) => {
		try {
			execFile(
				"busctl",
				SYSTEMD_ENVIRONMENT_ARGS,
				{ env, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT_BYTES },
				(error, stdout) => resolve(error ? undefined : parseSystemdEnvironment(stdout)),
			);
		} catch {
			resolve(undefined);
		}
	});
}

function isMinimalBaseVariable(name: string): boolean {
	return MINIMAL_BASE_VARIABLES.includes(name) || MINIMAL_BASE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function createShellBase(
	inherited: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	serviceStart: boolean,
	sessionEnvironment: Record<string, string> | undefined,
): { base: DaemonEnvironmentBase; environment: NodeJS.ProcessEnv } {
	const defaultPath = platform === "darwin" ? DARWIN_DEFAULT_PATH : POSIX_DEFAULT_PATH;
	if (serviceStart || sessionEnvironment) {
		const environment: NodeJS.ProcessEnv = { ...(serviceStart ? inherited : sessionEnvironment) };
		environment.PATH ||= defaultPath;
		return { base: serviceStart ? "service" : "systemd", environment };
	}
	const environment: NodeJS.ProcessEnv = { PATH: defaultPath };
	for (const [name, value] of Object.entries(inherited)) {
		if (value !== undefined && isMinimalBaseVariable(name)) {
			environment[name] = value;
		}
	}
	return { base: "minimal", environment };
}

function createShellEnvironment(
	base: NodeJS.ProcessEnv,
	shell: string,
	home: string,
	nodePath: string,
	marker: string,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { ...base };
	environment.HOME ??= home;
	environment.SHELL ??= shell;
	environment[DAEMON_RESOLVING_ENV_VARIABLE] = "1";
	environment.VOLT_ENV_NODE = nodePath;
	environment.VOLT_ENV_SCRIPT = ENV_SCRIPT;
	environment.VOLT_ENV_MARKER = marker;
	return environment;
}

function extractPayload(stdout: string, marker: string): string | undefined {
	const start = stdout.indexOf(marker);
	if (start < 0) {
		return undefined;
	}
	const end = stdout.indexOf(marker, start + marker.length);
	return end < 0 ? undefined : stdout.slice(start + marker.length, end);
}

function runLoginShell(
	shell: string,
	environment: NodeJS.ProcessEnv,
	cwd: string,
	marker: string,
	timeoutMs: number,
): Promise<LoginShellRun> {
	return new Promise((resolve) => {
		let stdout = "";
		let stdoutBytes = 0;
		let stderrTail = "";
		let exitCode: number | null = null;
		let signal: NodeJS.Signals | null = null;
		let exited = false;
		let settled = false;
		let child: ChildProcess | undefined;
		let timer: NodeJS.Timeout | undefined;

		const finish = (outcome: { payload?: string; failure?: string }): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			// Background jobs started by dotfiles may still hold the pipes open.
			child?.stdout?.destroy();
			child?.stderr?.destroy();
			resolve({ ...outcome, exitCode, signal, stderrTail });
		};
		const killAndFail = (failure: string): void => {
			if (child?.pid !== undefined) {
				killProcessTree(child.pid);
			}
			finish({ failure });
		};
		// The shell has exited and the payload is complete; late output from
		// logout scripts or background jobs does not matter.
		const finishIfComplete = (): void => {
			const payload = exited ? extractPayload(stdout, marker) : undefined;
			if (payload !== undefined) {
				finish({ payload });
			}
		};

		try {
			// Detached: a new session without a controlling terminal, so an
			// interactive shell cannot take over the terminal voltd was started from.
			child = spawn(shell, ["-i", "-l", "-c", SHELL_COMMAND], {
				cwd,
				env: environment,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			finish({ failure: `failed to start ${shell}: ${error instanceof Error ? error.message : String(error)}` });
			return;
		}
		timer = setTimeout(() => killAndFail(`timed out after ${timeoutMs}ms`), timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdoutBytes += Buffer.byteLength(chunk);
			if (stdoutBytes > MAX_OUTPUT_BYTES) {
				killAndFail(`shell output exceeded ${MAX_OUTPUT_BYTES / 1024 / 1024} MiB`);
				return;
			}
			stdout += chunk;
			finishIfComplete();
		});
		child.stderr?.on("data", (chunk: string) => {
			stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
		});
		child.once("error", (error) => {
			finish({ failure: `failed to start ${shell}: ${error.message}` });
		});
		child.once("exit", (code, exitSignal) => {
			exited = true;
			exitCode = code;
			signal = exitSignal;
			finishIfComplete();
		});
		child.once("close", () => {
			const payload = extractPayload(stdout, marker);
			const status = signal === null ? `exit code ${exitCode}` : `signal ${signal}`;
			finish(payload === undefined ? { failure: `no environment in shell output (${status})` } : { payload });
		});
	});
}

function parseEnvironment(payload: string): Record<string, string> | undefined {
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const environment: Record<string, string> = {};
	for (const [name, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			return undefined;
		}
		environment[name] = entry;
	}
	return environment;
}

function composeEnvironment(resolved: Record<string, string>, inherited: NodeJS.ProcessEnv): Record<string, string> {
	const environment = { ...resolved };
	// voltd's own configuration (agent dir, package dir, diagnostics flags) wins.
	for (const [name, value] of Object.entries(inherited)) {
		if (value !== undefined && name.startsWith("VOLT_")) {
			environment[name] = value;
		}
	}
	for (const name of [...SHELL_STATE_VARIABLES, ...HELPER_VARIABLES]) {
		delete environment[name];
	}
	return environment;
}

function replaceEnvironment(target: NodeJS.ProcessEnv, next: Record<string, string>): void {
	for (const name of Object.keys(target)) {
		if (!Object.hasOwn(next, name)) {
			delete target[name];
		}
	}
	Object.assign(target, next);
}

/**
 * Replace the target environment with the user's login-shell environment.
 * Never throws: every failure leaves the target unchanged and reports why.
 */
export async function resolveDaemonEnvironment(
	options: ResolveDaemonEnvironmentOptions = {},
): Promise<DaemonEnvironmentResolution> {
	const target = options.target ?? process.env;
	const inherited = options.inherited ?? { ...target };
	const platform = options.platform ?? process.platform;
	if (/^(1|true|yes)$/i.test(inherited[DAEMON_INHERIT_ENV_VARIABLE] ?? "")) {
		return { status: { source: "inherited", reason: `${DAEMON_INHERIT_ENV_VARIABLE} is set` }, failed: false };
	}
	if (platform === "win32") {
		return {
			status: { source: "inherited", reason: "login shell resolution is not supported on Windows" },
			failed: false,
		};
	}
	const shell = options.shell ?? findLoginShell(inherited);
	if (!shell) {
		return { status: { source: "inherited", reason: "no login shell found" }, failed: true };
	}
	const shellName = basename(shell);
	if (!SUPPORTED_SHELLS.has(shellName)) {
		return { status: { source: "inherited", shell, reason: `unsupported login shell ${shellName}` }, failed: true };
	}

	const startedAt = performance.now();
	const serviceStart = options.serviceStart ?? false;
	const readSessionEnvironment = options.readSessionEnvironment ?? (() => readSystemdUserEnvironment(inherited));
	const sessionEnvironment = !serviceStart && platform === "linux" ? await readSessionEnvironment() : undefined;
	const shellBase = createShellBase(inherited, platform, serviceStart, sessionEnvironment);
	const marker = `__VOLT_ENV_${randomUUID()}__`;
	const home = inherited.HOME || homedir();
	const environment = createShellEnvironment(
		shellBase.environment,
		shell,
		home,
		options.nodePath ?? process.execPath,
		marker,
	);
	const run = await runLoginShell(
		shell,
		environment,
		home,
		marker,
		options.timeoutMs ?? DAEMON_ENVIRONMENT_TIMEOUT_MS,
	);
	const durationMs = Math.round(performance.now() - startedAt);
	const diagnostics = {
		exitCode: run.exitCode,
		signal: run.signal,
		...(run.stderrTail ? { stderrTail: run.stderrTail } : {}),
	};
	const resolved = run.payload === undefined ? undefined : parseEnvironment(run.payload);
	if (!resolved) {
		const reason = run.failure ?? "shell printed an invalid environment";
		return { status: { source: "inherited", shell, durationMs, reason }, failed: true, ...diagnostics };
	}
	const next = composeEnvironment(resolved, inherited);
	const droppedVariables = Object.keys(inherited)
		.filter(
			(name) => inherited[name] !== undefined && !Object.hasOwn(next, name) && !SHELL_STATE_VARIABLES.includes(name),
		)
		.sort();
	replaceEnvironment(target, next);
	return {
		status: { source: "login-shell", base: shellBase.base, shell, durationMs },
		failed: false,
		...diagnostics,
		droppedVariables,
	};
}
