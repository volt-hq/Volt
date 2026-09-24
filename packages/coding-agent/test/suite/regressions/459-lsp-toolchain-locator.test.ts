import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostActionUpdate, HostInteraction } from "../../../src/core/host-interaction.ts";
import { resolveLspLaunch } from "../../../src/core/lsp/command-resolver.ts";
import { type LspSettings, resolveLspConfig } from "../../../src/core/lsp/config.ts";
import { LspManager } from "../../../src/core/lsp/manager.ts";
import { type LspLocatorHost, toolchainLocatorFor } from "../../../src/core/lsp/toolchain-locator.ts";

const fake = join(__dirname, "../../fixtures/fake-lsp-server.mjs");
const windows = process.platform === "win32";
const roots: string[] = [];
const managers: LspManager[] = [];

afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

type RunResult = ReturnType<LspLocatorHost["run"]>;

function fakeHost(
	result: RunResult | ((args: readonly string[]) => RunResult),
	links: Record<string, string> = {},
	identities: Record<string, string> = {},
): LspLocatorHost & { run: ReturnType<typeof vi.fn<LspLocatorHost["run"]>> } {
	return {
		run: vi.fn<LspLocatorHost["run"]>((_command, args) => (typeof result === "function" ? result(args) : result)),
		realpath: (path) => links[path] ?? path,
		fileIdentity: (path) => identities[path] ?? path,
	};
}

function resolveBuiltIn(
	binary: string,
	options: {
		environment: NodeJS.ProcessEnv;
		executables: string[];
		host: LspLocatorHost;
		platform?: NodeJS.Platform;
	},
) {
	const executables = new Set(options.executables);
	return resolveLspLaunch([binary], {
		projectCwd: "/project",
		platform: options.platform ?? "linux",
		environment: options.environment,
		probeExecutable: (path) => (executables.has(path) ? "executable" : "missing"),
		toolchain: { locator: toolchainLocatorFor(binary)!, root: "/project/crate", host: options.host },
	});
}

describe("LSP toolchain locators (#459)", () => {
	describe("gopls", () => {
		it("launches gopls from GOBIN, queried outside the project with GOTOOLCHAIN=local", () => {
			const environment = { PATH: "/usr/bin" };
			const host = fakeHost({ status: 0, stdout: "/home/u/gobin\n/home/u/go\n\n", stderr: "" });
			const launch = resolveBuiltIn("gopls", {
				environment,
				executables: ["/usr/bin/go", "/home/u/gobin/gopls"],
				host,
			});
			expect(launch).toMatchObject({
				command: ["/home/u/gobin/gopls"],
				resolvedExecutable: "/home/u/gobin/gopls",
				source: "toolchain",
				bare: true,
				toolchain: { status: "found", detail: "go env GOBIN" },
			});
			expect(launch.environment).toBe(environment);
			expect(host.run).toHaveBeenCalledExactlyOnceWith("/usr/bin/go", ["env", "GOBIN", "GOPATH", "GOEXE"], {
				cwd: tmpdir(),
				env: { PATH: "/usr/bin", GOTOOLCHAIN: "local" },
			});
		});

		it("falls back to the first GOPATH entry's bin directory", () => {
			const launch = resolveBuiltIn("gopls", {
				environment: { PATH: "/usr/bin" },
				executables: ["/usr/bin/go", "/home/u/go/bin/gopls", "/other/bin/gopls"],
				host: fakeHost({ status: 0, stdout: "\n/home/u/go:/other\n\n", stderr: "" }),
			});
			expect(launch).toMatchObject({
				resolvedExecutable: "/home/u/go/bin/gopls",
				toolchain: { status: "found", detail: "go env GOPATH" },
			});
		});

		it("uses GOEXE and Windows path rules", () => {
			const launch = resolveBuiltIn("gopls", {
				platform: "win32",
				environment: { Path: "C:\\Go\\bin", PATHEXT: ".EXE" },
				executables: ["C:\\Go\\bin\\go.EXE", "C:\\Users\\u\\go\\bin\\gopls.exe"],
				host: fakeHost({ status: 0, stdout: "\r\nC:\\Users\\u\\go;D:\\other\r\n.exe\r\n", stderr: "" }),
			});
			expect(launch).toMatchObject({ resolvedExecutable: "C:\\Users\\u\\go\\bin\\gopls.exe", source: "toolchain" });
		});

		it("keeps the PATH result and ignores unusable toolchain answers", () => {
			const onPath = fakeHost({ status: 0, stdout: "/home/u/gobin\n", stderr: "" });
			expect(
				resolveBuiltIn("gopls", {
					environment: { PATH: "/usr/bin" },
					executables: ["/usr/bin/go", "/usr/bin/gopls", "/home/u/gobin/gopls"],
					host: onPath,
				}),
			).toMatchObject({ resolvedExecutable: "/usr/bin/gopls", source: "path" });
			expect(onPath.run).not.toHaveBeenCalled();

			for (const result of [
				{ status: 0, stdout: "relative/bin\n\n\n", stderr: "" },
				{ status: 1, stdout: "/home/u/gobin\n", stderr: "go: error" },
				{ status: null, stdout: "", stderr: "" },
			]) {
				const launch = resolveBuiltIn("gopls", {
					environment: { PATH: "/usr/bin" },
					executables: ["/usr/bin/go", "/home/u/gobin/gopls", join("/project", "relative/bin/gopls")],
					host: fakeHost(result),
				});
				expect(launch.resolvedExecutable).toBeUndefined();
				expect(launch.toolchain).toBeUndefined();
			}
		});
	});

	describe("rust-analyzer", () => {
		const homebrew = {
			environment: { PATH: "/opt/homebrew/bin" },
			executables: ["/opt/homebrew/bin/rustup", "/cellar/rustup/bin/rustup", "/cellar/rustup/bin/rust-analyzer"],
			links: { "/opt/homebrew/bin/rustup": "/cellar/rustup/bin/rustup" },
		};

		it("launches the rustup proxy next to rustup with its directory on the server PATH", () => {
			const host = fakeHost({ status: 0, stdout: "/toolchain/bin/rust-analyzer\n", stderr: "" }, homebrew.links);
			const launch = resolveBuiltIn("rust-analyzer", { ...homebrew, host });
			expect(launch).toMatchObject({
				resolvedExecutable: "/cellar/rustup/bin/rust-analyzer",
				source: "toolchain",
				environment: { PATH: "/cellar/rustup/bin:/opt/homebrew/bin" },
				toolchain: { status: "found", detail: "rustup proxy next to /cellar/rustup/bin/rustup" },
			});
			expect(host.run).toHaveBeenCalledExactlyOnceWith("/cellar/rustup/bin/rustup", ["which", "rust-analyzer"], {
				cwd: "/project/crate",
				env: { PATH: "/opt/homebrew/bin", RUSTUP_AUTO_INSTALL: "0" },
			});
		});

		const componentMissing: RunResult = {
			status: 1,
			stdout: "",
			stderr: "error: 'rust-analyzer' is not installed for the toolchain 'stable'\nhelp: run rustup component add",
		};

		it("targets the component install at the toolchain selected in the server root", () => {
			const host = fakeHost(
				(args) =>
					args[0] === "show"
						? {
								status: 0,
								stdout: "stable-aarch64-apple-darwin (overridden by '/project/crate/rust-toolchain.toml')\n",
								stderr: "",
							}
						: componentMissing,
				homebrew.links,
			);
			const launch = resolveBuiltIn("rust-analyzer", { ...homebrew, host });
			expect(launch.resolvedExecutable).toBeUndefined();
			expect(launch.toolchain).toMatchObject({
				status: "missing",
				installArgs: ["--toolchain", "stable-aarch64-apple-darwin"],
			});
			expect(launch.toolchain?.detail).toContain("/cellar/rustup/bin/rust-analyzer");
			expect(launch.toolchain?.detail).toContain("stable-aarch64-apple-darwin toolchain selected at /project/crate");
			expect(launch.toolchain?.detail).not.toContain("help:");
			expect(host.run).toHaveBeenLastCalledWith("/cellar/rustup/bin/rustup", ["show", "active-toolchain"], {
				cwd: "/project/crate",
				env: { PATH: "/opt/homebrew/bin", RUSTUP_AUTO_INSTALL: "0" },
			});
		});

		it.each([
			{
				case: "an uninstalled toolchain",
				show: {
					status: 1,
					stdout: "",
					stderr:
						"error: override toolchain '1.70.0-aarch64-apple-darwin' is not installed: the toolchain file specifies an uninstalled toolchain",
				},
				reason: "override toolchain '1.70.0-aarch64-apple-darwin' is not installed",
			},
			{
				case: "a custom path toolchain",
				show: {
					status: 0,
					stdout: "/opt/custom-toolchain (overridden by '/project/crate/rust-toolchain.toml')\n",
					stderr: "",
				},
				reason: "is not installed for the toolchain 'stable'",
			},
			{
				case: "an option-like toolchain name",
				show: { status: 0, stdout: "--force (default)\n", stderr: "" },
				reason: "is not installed for the toolchain 'stable'",
			},
		])("offers no component install for $case", ({ show, reason }) => {
			const launch = resolveBuiltIn("rust-analyzer", {
				...homebrew,
				host: fakeHost((args) => (args[0] === "show" ? show : componentMissing), homebrew.links),
			});
			expect(launch.resolvedExecutable).toBeUndefined();
			expect(launch.toolchain?.status).toBe("missing");
			expect(launch.toolchain?.installArgs).toBeUndefined();
			expect(launch.toolchain?.detail).toContain("cannot receive the component");
			expect(launch.toolchain?.detail).toContain(reason);
		});

		it("checks a PATH-resolved rustup proxy but not a standalone rust-analyzer", () => {
			const environment = { PATH: "/home/u/.cargo/bin" };
			const executables = ["/home/u/.cargo/bin/rust-analyzer", "/home/u/.cargo/bin/rustup"];
			const proxy = { "/home/u/.cargo/bin/rust-analyzer": "rustup", "/home/u/.cargo/bin/rustup": "rustup" };
			const missing = resolveBuiltIn("rust-analyzer", {
				environment,
				executables,
				host: fakeHost({ status: 1, stdout: "", stderr: "error: not installed" }, {}, proxy),
			});
			expect(missing).toMatchObject({ source: "path", toolchain: { status: "missing" } });
			expect(missing.resolvedExecutable).toBeUndefined();

			const installed = resolveBuiltIn("rust-analyzer", {
				environment,
				executables,
				host: fakeHost({ status: 0, stdout: "", stderr: "" }, {}, proxy),
			});
			expect(installed).toMatchObject({ resolvedExecutable: "/home/u/.cargo/bin/rust-analyzer", source: "path" });
			expect(installed.environment).toBe(environment);
			expect(installed.toolchain).toBeUndefined();

			const standalone = fakeHost({ status: 1, stdout: "", stderr: "error: not installed" });
			expect(resolveBuiltIn("rust-analyzer", { environment, executables, host: standalone })).toMatchObject({
				resolvedExecutable: "/home/u/.cargo/bin/rust-analyzer",
				source: "path",
			});
			expect(standalone.run).not.toHaveBeenCalled();
		});

		it("keeps the PATH miss when rustup cannot answer", () => {
			const launch = resolveBuiltIn("rust-analyzer", {
				...homebrew,
				host: fakeHost({ status: null, stdout: "", stderr: "" }, homebrew.links),
			});
			expect(launch.resolvedExecutable).toBeUndefined();
			expect(launch.toolchain).toBeUndefined();
		});

		it("prepends to the existing Windows Path key", () => {
			const launch = resolveBuiltIn("rust-analyzer", {
				platform: "win32",
				environment: { Path: "C:\\tools", PATHEXT: ".EXE" },
				executables: ["C:\\tools\\rustup.EXE", "C:\\rustup\\rust-analyzer.EXE"],
				host: fakeHost(
					{ status: 0, stdout: "", stderr: "" },
					{ "C:\\tools\\rustup.EXE": "C:\\rustup\\rustup.EXE" },
				),
			});
			expect(launch).toMatchObject({ resolvedExecutable: "C:\\rustup\\rust-analyzer.EXE", source: "toolchain" });
			expect(launch.environment).toEqual({ Path: "C:\\rustup;C:\\tools", PATHEXT: ".EXE" });
		});
	});

	describe("sourcekit-lsp", () => {
		it("asks xcrun only on macOS", () => {
			const executable = "/Applications/Xcode.app/usr/bin/sourcekit-lsp";
			const darwin = fakeHost({ status: 0, stdout: `${executable}\n`, stderr: "" });
			expect(
				resolveBuiltIn("sourcekit-lsp", {
					platform: "darwin",
					environment: { PATH: "/usr/bin" },
					executables: [executable],
					host: darwin,
				}),
			).toMatchObject({
				resolvedExecutable: executable,
				source: "toolchain",
				toolchain: { status: "found", detail: "xcrun --find sourcekit-lsp" },
			});
			expect(darwin.run).toHaveBeenCalledExactlyOnceWith("/usr/bin/xcrun", ["--find", "sourcekit-lsp"], {
				cwd: "/project",
				env: { PATH: "/usr/bin" },
			});

			const linux = fakeHost({ status: 0, stdout: `${executable}\n`, stderr: "" });
			expect(
				resolveBuiltIn("sourcekit-lsp", {
					environment: { PATH: "/usr/bin" },
					executables: [executable],
					host: linux,
				}).resolvedExecutable,
			).toBeUndefined();
			expect(linux.run).not.toHaveBeenCalled();
		});
	});
});

function writeScript(path: string, posix: string, cmd: string): string {
	const file = windows ? `${path}.cmd` : path;
	writeFileSync(file, windows ? `@echo off\r\n${cmd}` : `#!/bin/sh\n${posix}`);
	chmodSync(file, 0o755);
	return file;
}

function lspLauncher(directory: string, name: string): string {
	return writeScript(
		join(directory, name),
		`exec '${process.execPath}' '${fake}' "$@"\n`,
		`"${process.execPath}" "${fake}" %*\r\n`,
	);
}

function managerFixture(
	file: string,
	settings: LspSettings = {},
	install: (command: readonly string[]) => void = () => {},
) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-lsp-459-")));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin);
	const path = join(root, file);
	writeFileSync(path, "symbol\n");
	vi.stubEnv("PATH", bin);
	vi.stubEnv("VOLT_OFFLINE", "0");
	const updates: HostActionUpdate[] = [];
	const requestAction = vi.fn<HostInteraction["requestAction"]>(async () => ({ decision: "approved" }));
	const installRunner = vi.fn(async (command: readonly string[]) => {
		install(command);
		return { exitCode: 0, output: "installed" };
	});
	const manager = new LspManager({
		cwd: root,
		config: resolveLspConfig({ idleShutdownMs: 0, ...settings }),
		hostInteraction: { requestAction, updateAction: (update) => void updates.push(update) },
		installRunner,
	});
	managers.push(manager);
	const status = (name: string) => manager.getStatus().find((entry) => entry.name === name);
	return { manager, root, bin, path, updates, requestAction, installRunner, status };
}

describe("LSP toolchain locator integration (#459)", () => {
	function goFixture(settings: LspSettings = {}) {
		let gobin = "";
		const item = managerFixture("main.go", settings, () => lspLauncher(gobin, "gopls"));
		gobin = join(item.root, "gobin");
		mkdirSync(gobin);
		const invoked = join(item.root, "go-invoked");
		writeScript(
			join(item.bin, "go"),
			`[ "$GOTOOLCHAIN" = local ] || exit 3\n: > '${invoked}'\nprintf '%s\\n' '${gobin}' '${join(item.root, "gopath")}' ''\n`,
			`if not "%GOTOOLCHAIN%"=="local" exit /b 3\r\ntype nul > "${invoked}"\r\necho ${gobin}\r\necho ${join(item.root, "gopath")}\r\necho .cmd\r\n`,
		);
		return { ...item, gobin, invoked };
	}

	it("starts an installed gopls outside PATH without offering an install", async () => {
		const item = goFixture();
		const gopls = lspLauncher(item.gobin, "gopls");
		expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
		expect(item.requestAction).not.toHaveBeenCalled();
		expect(item.status("go")).toMatchObject({ state: "ready", resolvedExecutable: gopls, launchSource: "toolchain" });
	});

	it("verifies an install into GOBIN and does not reinstall after restart", async () => {
		const item = goFixture();
		expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
		expect(item.requestAction).toHaveBeenCalledTimes(1);
		expect(item.updates.map((update) => update.status)).toEqual(["running", "completed"]);
		item.manager.restart();
		expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
		expect(item.requestAction).toHaveBeenCalledTimes(1);
		expect(item.installRunner).toHaveBeenCalledTimes(1);
	});

	it("never locates a customized command", async () => {
		const item = goFixture({ servers: { go: { command: ["gopls", "-remote=auto"] } } });
		lspLauncher(item.gobin, "gopls");
		expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "unavailable" });
		expect(existsSync(item.invoked)).toBe(false);
		expect(item.requestAction).not.toHaveBeenCalled();
	});

	// rustup proxies are hard links or symlinks to rustup that dispatch on their invoked name.
	// The fake selects a toolchain from a `rust-toolchain` file in its working directory
	// (default `stable`) and records installed components as files named after the toolchain.
	function rustFixture(layout: "homebrew" | "rustup-init") {
		let components = "";
		const item = managerFixture("main.rs", {}, (command) => {
			const index = command.indexOf("--toolchain");
			writeFileSync(join(components, index === -1 ? "stable" : command[index + 1]), "");
		});
		components = join(item.root, "components");
		mkdirSync(components);
		const proxyDirectory = layout === "homebrew" ? join(item.root, "cellar") : item.bin;
		mkdirSync(proxyDirectory, { recursive: true });
		const rustup = writeScript(
			join(proxyDirectory, "rustup"),
			[
				"tc=stable",
				"[ -f rust-toolchain ] && read -r tc < rust-toolchain",
				`if [ "\${0##*/}" = rust-analyzer ]; then`,
				`  [ -f '${components}/'"$tc" ] || { echo "error: 'rust-analyzer' is not installed" >&2; exit 1; }`,
				`  case ":$PATH:" in *":${proxyDirectory}:"*) ;; *) echo "cargo is not on PATH" >&2; exit 7 ;; esac`,
				`  exec '${process.execPath}' '${fake}' "$@"`,
				"fi",
				`[ "$RUSTUP_AUTO_INSTALL" = 0 ] || exit 3`,
				`[ "$tc" = uninstalled ] && { echo "error: override toolchain 'uninstalled' is not installed" >&2; exit 1; }`,
				`case "$1" in`,
				`  which) [ -f '${components}/'"$tc" ] || { echo "error: 'rust-analyzer' is not installed for the toolchain '$tc'" >&2; exit 1; }`,
				`    echo '${join(item.root, "toolchain", "rust-analyzer")}' ;;`,
				`  show) echo "$tc (overridden by '$PWD/rust-toolchain')" ;;`,
				"  *) exit 3 ;;",
				"esac",
				"",
			].join("\n"),
			"exit /b 1\r\n",
		);
		const proxy = join(proxyDirectory, "rust-analyzer");
		linkSync(rustup, proxy);
		if (layout === "homebrew") symlinkSync(rustup, join(item.bin, "rustup"));
		/** A nested crate whose root selects `toolchain`, unlike the project workspace. */
		const crate = (toolchain: string) => {
			const directory = join(item.root, "crate");
			mkdirSync(directory);
			writeFileSync(join(directory, "Cargo.toml"), "");
			writeFileSync(join(directory, "rust-toolchain"), `${toolchain}\n`);
			const path = join(directory, "main.rs");
			writeFileSync(path, "symbol\n");
			return path;
		};
		return { ...item, components, proxy, crate };
	}

	it.skipIf(windows)("launches an installed Homebrew rustup proxy with cargo on its PATH", async () => {
		const item = rustFixture("homebrew");
		writeFileSync(join(item.components, "stable"), "");
		expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
		expect(item.requestAction).not.toHaveBeenCalled();
		expect(item.status("rust")).toMatchObject({
			state: "ready",
			resolvedExecutable: item.proxy,
			launchSource: "toolchain",
		});
	});

	it.skipIf(windows).each(["homebrew", "rustup-init"] as const)(
		"offers the component install for a %s proxy and reuses it after restart",
		async (layout) => {
			const item = rustFixture(layout);
			expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
			expect(item.requestAction).toHaveBeenCalledTimes(1);
			expect(item.requestAction.mock.calls[0][0].commandPreview).toBe(
				"rustup component add rust-analyzer --toolchain stable",
			);
			expect(item.updates.map((update) => update.status)).toEqual(["running", "completed"]);
			item.manager.restart();
			expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
			expect(item.requestAction).toHaveBeenCalledTimes(1);
			expect(item.status("rust")?.resolvedExecutable).toBe(item.proxy);
		},
	);

	it.skipIf(windows)("explains a declined component install", async () => {
		const item = rustFixture("rustup-init");
		item.requestAction.mockResolvedValueOnce({ decision: "denied" });
		const result = await item.manager.hover(item.path, "symbol");
		expect(result.outcome).toBe("unavailable");
		expect(result.text).toContain(`rust-analyzer rustup proxy ${item.proxy} is present`);
		expect(result.text).toContain(`not installed for the stable toolchain selected at ${item.root}`);
		expect(result.text).toContain("Install with: rustup component add rust-analyzer --toolchain stable");
		expect(item.installRunner).not.toHaveBeenCalled();
	});

	it.skipIf(windows)("installs the component for the server root's toolchain, not the workspace's", async () => {
		const item = rustFixture("homebrew");
		writeFileSync(join(item.components, "stable"), "");
		const path = item.crate("pinned");
		expect(await item.manager.hover(path, "symbol")).toMatchObject({ outcome: "success" });
		expect(item.requestAction).toHaveBeenCalledTimes(1);
		expect(item.requestAction.mock.calls[0][0].commandPreview).toBe(
			"rustup component add rust-analyzer --toolchain pinned",
		);
		expect(item.installRunner).toHaveBeenCalledExactlyOnceWith(
			["rustup", "component", "add", "rust-analyzer", "--toolchain", "pinned"],
			expect.anything(),
		);
		expect(item.updates.map((update) => update.status)).toEqual(["running", "completed"]);
		// The workspace's own toolchain already had the component; no second prompt.
		expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
		expect(item.requestAction).toHaveBeenCalledTimes(1);
	});

	it.skipIf(windows)("offers no component install when the root's toolchain is not installed", async () => {
		const item = rustFixture("homebrew");
		const result = await item.manager.hover(item.crate("uninstalled"), "symbol");
		expect(result.outcome).toBe("unavailable");
		expect(result.text).toContain("cannot receive the component");
		expect(result.text).toContain("override toolchain 'uninstalled' is not installed");
		expect(result.text).not.toContain("Install with: rustup component add");
		expect(item.requestAction).not.toHaveBeenCalled();
		expect(item.installRunner).not.toHaveBeenCalled();
	});

	it.skipIf(windows)("does not check a standalone rust-analyzer next to rustup", async () => {
		const item = managerFixture("main.rs");
		writeScript(join(item.bin, "rustup"), "exit 1\n", "exit /b 1\r\n");
		lspLauncher(item.bin, "rust-analyzer");
		expect(await item.manager.hover(item.path, "symbol")).toMatchObject({ outcome: "success" });
		expect(item.requestAction).not.toHaveBeenCalled();
		expect(item.status("rust")).toMatchObject({ state: "ready", launchSource: "path" });
	});
});
