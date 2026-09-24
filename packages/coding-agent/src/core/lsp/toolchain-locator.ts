/**
 * Host-owned toolchain locators for built-in language servers.
 *
 * A locator asks the language's own toolchain where its server lives when the
 * unchanged built-in bare command is not usable from the inherited PATH. It
 * never scans arbitrary directories, edits settings, or modifies shell profiles.
 * Custom commands and explicit paths never reach a locator.
 */

import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import { spawnProcessSync } from "../../utils/child-process.ts";

const LOCATOR_TIMEOUT_MS = 3000;
const MAX_REASON_CHARS = 300;

export interface LspLocatorCommandOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export interface LspLocatorCommandResult {
	/** Exit status, or null when the command could not run or timed out. */
	status: number | null;
	stdout: string;
	stderr: string;
}

export type LspLocatorCommandRunner = (
	command: string,
	args: readonly string[],
	options: LspLocatorCommandOptions,
) => LspLocatorCommandResult;

/** Filesystem and process access used by locators. Injectable for deterministic cross-platform tests. */
export interface LspLocatorHost {
	run: LspLocatorCommandRunner;
	/** Canonical path, or undefined when it cannot be resolved. */
	realpath(path: string): string | undefined;
	/** Stable identity shared by hard links and symlink targets, or undefined when unavailable. */
	fileIdentity(path: string): string | undefined;
}

export interface LspLocatorContext extends LspLocatorHost {
	/** Canonical project workspace. */
	projectCwd: string;
	/** Server root; project-scoped toolchain overrides are resolved here. */
	root: string;
	platform: NodeJS.Platform;
	/** Exact environment inherited by the launched server. */
	environment: NodeJS.ProcessEnv;
	/** Executable resolved from the inherited PATH for the built-in command, if any. */
	pathExecutable?: string;
	/** Resolve another bare tool through the same inherited PATH. */
	findOnPath(name: string): string | undefined;
	/** Launchable candidate for an absolute path, honoring PATHEXT on Windows. */
	findExecutable(path: string): string | undefined;
}

export interface LspLocatedExecutable {
	status: "found";
	executable: string;
	/** Exact launch environment when the server needs its toolchain directory on PATH. */
	environment?: NodeJS.ProcessEnv;
	/** How the toolchain reported the executable. */
	detail: string;
}

export type LspLocatorResult =
	| LspLocatedExecutable
	/** The toolchain launcher exists, but the server is not installed for it. Eligible for the reviewed install. */
	| { status: "missing"; detail: string }
	/** No toolchain evidence; keep the inherited PATH result. */
	| { status: "not-applicable" };

export interface LspToolchainLocator {
	/** Built-in bare command (argv[0]) this locator serves. */
	binary: string;
	locate(context: LspLocatorContext): LspLocatorResult;
}

const NOT_APPLICABLE: LspLocatorResult = { status: "not-applicable" };

export const defaultLspLocatorHost: LspLocatorHost = {
	run(command, args, options) {
		const result = spawnProcessSync(command, [...args], {
			cwd: options.cwd,
			env: options.env,
			encoding: "utf-8",
			timeout: LOCATOR_TIMEOUT_MS,
			maxBuffer: 64 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	},
	realpath(path) {
		try {
			return realpathSync(path);
		} catch {
			return undefined;
		}
	},
	fileIdentity(path) {
		try {
			const stat = statSync(path, { bigint: true });
			return `${stat.dev}:${stat.ino}`;
		} catch {
			return undefined;
		}
	},
};

function pathApiFor(platform: NodeJS.Platform): typeof posix {
	return platform === "win32" ? win32 : posix;
}

function prependPath(environment: NodeJS.ProcessEnv, directory: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
	const key =
		platform === "win32"
			? (Object.keys(environment).find((name) => name.toUpperCase() === "PATH") ?? "Path")
			: "PATH";
	const current = environment[key];
	return { ...environment, [key]: current ? `${directory}${platform === "win32" ? ";" : ":"}${current}` : directory };
}

/** macOS only: the selected developer toolchain's SourceKit-LSP. */
const swiftLocator: LspToolchainLocator = {
	binary: "sourcekit-lsp",
	locate(context) {
		if (context.pathExecutable || context.platform !== "darwin") return NOT_APPLICABLE;
		const result = context.run("/usr/bin/xcrun", ["--find", "sourcekit-lsp"], {
			cwd: context.projectCwd,
			env: context.environment,
		});
		const executable = result.stdout.trim();
		return result.status === 0 && executable
			? { status: "found", executable, detail: "xcrun --find sourcekit-lsp" }
			: NOT_APPLICABLE;
	},
};

/**
 * `go install` writes to GOBIN, else the first GOPATH entry's bin directory,
 * which Go never adds to PATH. GOBIN/GOPATH come from the user's environment
 * and go env file, not the project, so the query runs outside the project with
 * GOTOOLCHAIN=local: a project go.mod must not trigger a toolchain download.
 */
const goLocator: LspToolchainLocator = {
	binary: "gopls",
	locate(context) {
		if (context.pathExecutable) return NOT_APPLICABLE;
		const go = context.findOnPath("go");
		if (!go) return NOT_APPLICABLE;
		const result = context.run(go, ["env", "GOBIN", "GOPATH", "GOEXE"], {
			cwd: tmpdir(),
			env: { ...context.environment, GOTOOLCHAIN: "local" },
		});
		if (result.status !== 0) return NOT_APPLICABLE;
		const [gobin = "", gopath = "", goexe = ""] = result.stdout.split(/\r?\n/).map((line) => line.trim());
		const pathApi = pathApiFor(context.platform);
		const firstGopath = gopath.split(pathApi.delimiter).find((entry) => entry !== "");
		const directory = gobin || (firstGopath ? pathApi.join(firstGopath, "bin") : undefined);
		if (!directory || !pathApi.isAbsolute(directory)) return NOT_APPLICABLE;
		const executable = context.findExecutable(pathApi.join(directory, `gopls${goexe}`));
		return executable
			? { status: "found", executable, detail: `go env ${gobin ? "GOBIN" : "GOPATH"}` }
			: NOT_APPLICABLE;
	},
};

/**
 * rust-analyzer must run through the rustup proxy with the proxy directory on
 * its PATH; the toolchain binary from `rustup which` cannot find cargo/rustc
 * when the proxies are not on the inherited PATH (Homebrew rustup). Proxies
 * exist even when the component is not installed, so the component is checked
 * with `rustup which` in the server root, which honors rust-toolchain.toml.
 */
const rustLocator: LspToolchainLocator = {
	binary: "rust-analyzer",
	locate(context) {
		const pathApi = pathApiFor(context.platform);
		let rustup: string | undefined;
		let proxy: string | undefined;
		if (context.pathExecutable) {
			// Only a rustup proxy (a hard link or symlink to rustup) can lack its component.
			rustup = context.findExecutable(pathApi.join(pathApi.dirname(context.pathExecutable), "rustup"));
			const identity = rustup ? context.fileIdentity(rustup) : undefined;
			if (identity && identity === context.fileIdentity(context.pathExecutable)) proxy = context.pathExecutable;
		} else {
			const onPath = context.findOnPath("rustup");
			rustup = onPath ? context.realpath(onPath) : undefined;
			proxy = rustup ? context.findExecutable(pathApi.join(pathApi.dirname(rustup), "rust-analyzer")) : undefined;
		}
		if (!rustup || !proxy) return NOT_APPLICABLE;
		const check = context.run(rustup, ["which", "rust-analyzer"], {
			cwd: context.root,
			env: { ...context.environment, RUSTUP_AUTO_INSTALL: "0" },
		});
		if (check.status === null) return NOT_APPLICABLE;
		if (check.status !== 0) {
			const reason = check.stderr.trim().split(/\r?\n/, 1)[0]?.slice(0, MAX_REASON_CHARS);
			return {
				status: "missing",
				detail: `rust-analyzer rustup proxy ${proxy} is present, but the component is not installed for the toolchain selected at ${context.root}${reason ? ` (${reason})` : ""}`,
			};
		}
		if (context.pathExecutable) return NOT_APPLICABLE;
		return {
			status: "found",
			executable: proxy,
			environment: prependPath(context.environment, pathApi.dirname(proxy), context.platform),
			detail: `rustup proxy next to ${rustup}`,
		};
	},
};

const TOOLCHAIN_LOCATORS: Record<string, LspToolchainLocator> = Object.fromEntries(
	[swiftLocator, goLocator, rustLocator].map((locator) => [locator.binary, locator]),
);

/** Locator for an unchanged built-in bare command, or undefined when its toolchain has none. */
export function toolchainLocatorFor(binary: string): LspToolchainLocator | undefined {
	return TOOLCHAIN_LOCATORS[binary];
}
