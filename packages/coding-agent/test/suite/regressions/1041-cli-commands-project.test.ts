import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectConfig } from "../../../src/cli/config-selector.ts";
import { showStartupSelector } from "../../../src/cli/startup-ui.ts";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import type { ExtensionDefinition } from "../../../src/core/extensions/types.ts";
import { DefaultPackageManager } from "../../../src/core/package-manager.ts";
import type { PrReviewLaunch } from "../../../src/core/pr-review-placement.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { getWorktreeCheckoutPath } from "../../../src/daemon/worktree-manager.ts";
import { handleMcpCommand } from "../../../src/mcp-cli.ts";
import { handleConfigCommand, handlePackageCommand } from "../../../src/package-manager-cli.ts";
import { handleStoreCommand } from "../../../src/store/store-cli.ts";
import { writeDaemonStateFile } from "../../utilities/iroh-host-state.ts";
import { testExtension } from "../../utilities.ts";

// The trust prompt draws a terminal UI: each test answers it.
vi.mock("../../../src/cli/startup-ui.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	showStartupSelector: vi.fn(),
}));

// So does `volt config`: tests read what it is given.
vi.mock("../../../src/cli/config-selector.ts", () => ({ selectConfig: vi.fn() }));

/**
 * #1041: `volt install|remove|update|list`, `volt config`, `volt store`, and
 * `volt mcp` took the directory they ran in as both their project and the
 * path its trust is decided for. In a pull request review checkout they read
 * the pull request's `.volt/settings.json` and `.mcp.json` whenever that
 * directory counted as trusted, and they could save a trust decision for a
 * path under the worktrees root. They now resolve their project as a
 * conversation in that directory does.
 */
describe("#1041 package, config, store, and MCP commands in a managed checkout use its conversation's project", () => {
	interface Fixture {
		root: string;
		agentDir: string;
		/** The registered workspace, holding the `workspace` project. */
		repo: string;
		/** Its managed checkout, holding the `head` project. */
		checkout: string;
	}

	const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
	const cleanups: Array<() => void> = [];
	let originalCwd: string;
	let stdout: string[];
	let stderr: string[];

	beforeEach(() => {
		originalCwd = process.cwd();
		stdout = [];
		stderr = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			stdout.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			stderr.push(args.map(String).join(" "));
		});
		vi.spyOn(process, "exit").mockImplementation((() => undefined) as unknown as typeof process.exit);
		vi.mocked(showStartupSelector).mockReset();
		vi.mocked(selectConfig).mockReset();
		process.exitCode = undefined;
	});

	afterEach(() => {
		process.chdir(originalCwd);
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		Object.defineProperty(process.stdin, "isTTY", { value: tty.stdin, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: tty.stdout, configurable: true });
		process.exitCode = undefined;
	});

	/** A project in `dir` whose settings list the package `npm:@<name>/pkg` and whose MCP config defines `<name>-server`. */
	function writeProject(dir: string, name: string): void {
		mkdirSync(join(dir, ".volt"), { recursive: true });
		writeFileSync(join(dir, ".volt", "settings.json"), JSON.stringify({ packages: [`npm:@${name}/pkg`] }));
		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({ servers: { [`${name}-server`]: { command: process.execPath, args: ["--version"] } } }),
		);
	}

	/**
	 * A workspace and its managed checkout, each holding a project of its own
	 * unless `bare`. The daemon's state file records the checkout, as a pull
	 * request review's or an ordinary one, unless it is `unrecorded`.
	 */
	async function fixture(
		kind: "review" | "ordinary" | "unrecorded",
		options: { bare?: boolean } = {},
	): Promise<Fixture> {
		const root = realpathSync.native(mkdtempSync(join(tmpdir(), "volt-1041-commands-")));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const agentDir = join(root, "agent");
		const repo = join(root, "repo");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(repo, { recursive: true });
		const checkout = getWorktreeCheckoutPath(agentDir, repo, "head");
		mkdirSync(checkout, { recursive: true });
		if (!options.bare) {
			writeProject(repo, "workspace");
			writeProject(checkout, "head");
		}
		// As `git worktree add` leaves it: the checkout points at the repository it was created from.
		writeFileSync(join(checkout, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "head")}\n`);
		const launch: PrReviewLaunch = {
			sessionId: "review-session",
			requestFingerprint: "a".repeat(64),
			disposition: "created",
			sessionGeneration: "generation-1",
			storeId: "store-1",
			placement: {
				workspaceName: "ws",
				workspaceGeneration: 1,
				worktreeId: "head",
				cwd: checkout,
				sourceCwd: repo,
				commonDirectory: join(repo, ".git"),
				pullRequest: {
					provider: "github",
					url: "https://github.com/owner/repo/pull/7",
					number: 7,
					title: "Fork change",
					repository: "owner/repo",
					headRefName: "topic",
					headRefOid: "b".repeat(40),
				},
				repositoryId: "github:github.com/owner/repo",
				headRepositoryId: "github:github.com/contributor/repo",
				remote: "origin",
			},
		};
		if (kind !== "unrecorded") {
			await writeDaemonStateFile(agentDir, {
				workspaces: [{ name: "ws", path: repo }],
				worktrees: [
					{
						id: "head",
						workspaceName: "ws",
						path: checkout,
						branch: "volt/head",
						createdAt: 1,
						sessionIds: [],
						...(kind === "review" ? { prReviewLaunches: [launch] } : {}),
					},
				],
			});
		}
		vi.stubEnv("HOME", root);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("VOLT_PROFILE", "");
		// No command here may reach a registry.
		vi.stubEnv("VOLT_OFFLINE", "1");
		return { root, agentDir, repo, checkout };
	}

	/** Run `volt <args>` in `cwd` with the command's handler, and return what it printed. */
	async function volt(cwd: string, args: string[], extensionFactories?: ExtensionDefinition[]): Promise<string> {
		stdout = [];
		stderr = [];
		process.chdir(cwd);
		const runtimeOptions = { extensionFactories, profile: undefined };
		if (args[0] === "config") {
			// It ends by exiting the process.
			await handleConfigCommand(args, runtimeOptions);
			expect(process.exit).toHaveBeenCalledWith(0);
		} else {
			const handle =
				args[0] === "store" ? handleStoreCommand : args[0] === "mcp" ? handleMcpCommand : handlePackageCommand;
			expect(await handle(args, runtimeOptions)).toBe(true);
		}
		return stdout.join("\n");
	}

	/** The MCP servers `volt mcp list` shows in `cwd`. */
	async function mcpServers(cwd: string, flags: string[] = []): Promise<string[]> {
		const listed = JSON.parse(await volt(cwd, ["mcp", "list", "--json", ...flags])) as {
			servers: Array<{ id: string }>;
		};
		return listed.servers.map((server) => server.id);
	}

	/** The project packages each update a command runs would touch: no update installs anything here. */
	function recordUpdates(): string[][] {
		const updates: string[][] = [];
		vi.spyOn(DefaultPackageManager.prototype, "update").mockImplementation(async function (
			this: DefaultPackageManager,
		) {
			updates.push(
				this.listConfiguredPackages()
					.filter((pkg) => pkg.scope === "project")
					.map((pkg) => pkg.source),
			);
		});
		return updates;
	}

	function setTerminal(interactive: boolean): void {
		Object.defineProperty(process.stdin, "isTTY", { value: interactive, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: interactive, configurable: true });
	}

	/** Answer the trust prompt with its option `answer`, or the one `answer` names a path for; returns the prompts shown. */
	function answerTrustPrompt(answer: string): string[] {
		const prompts: string[] = [];
		setTerminal(true);
		vi.mocked(showStartupSelector).mockImplementation(async (_settings, title, options) => {
			prompts.push(title);
			const chosen =
				options.find((option) => option.label === answer) ??
				options.find((option) => option.label.startsWith(`${answer} (`));
			return chosen?.value;
		});
		return prompts;
	}

	/** The decisions saved in trust.json, by path. */
	function savedTrust(f: Fixture): Record<string, boolean> {
		const path = join(f.agentDir, "trust.json");
		return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
	}

	function trustByDefault(f: Fixture): void {
		writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	}

	/** How a directory comes to count as trusted, each returning the command's flags. */
	const trusted: Array<[string, (f: Fixture) => string[]]> = [
		[
			"its workspace's saved trust",
			(f) => {
				new ProjectTrustStore(f.agentDir).set(f.repo, true);
				return [];
			},
		],
		["--approve", () => ["--approve"]],
		[
			'defaultProjectTrust "always"',
			(f) => {
				trustByDefault(f);
				return [];
			},
		],
		[
			"trust saved for a folder above the checkout",
			(f) => {
				new ProjectTrustStore(f.agentDir).set(f.root, true);
				return [];
			},
		],
	];

	describe("in a pull request review checkout", () => {
		it.each(trusted)("lists the workspace's packages and MCP servers under %s", async (_name, trust) => {
			const f = await fixture("review");
			const flags = trust(f);

			const packages = await volt(f.checkout, ["list", ...flags]);
			expect(packages).toContain("npm:@workspace/pkg");
			expect(packages).not.toContain("npm:@head/pkg");
			expect(await mcpServers(f.checkout, flags)).toEqual(["workspace-server"]);
			expect(savedTrust(f)).not.toHaveProperty([f.checkout]);
		});

		it.each([
			["volt update", ["update", "--extensions"]],
			["volt update --approve", ["update", "--extensions", "--approve"]],
			["volt store update", ["store", "update", "--yes"]],
		])("updates the workspace's project packages with %s", async (_name, args) => {
			const f = await fixture("review");
			new ProjectTrustStore(f.agentDir).set(f.repo, true);
			const updates = recordUpdates();

			await volt(f.checkout, args);

			expect(updates).toEqual([["npm:@workspace/pkg"]]);
		});

		it("configures the workspace's project", async () => {
			const f = await fixture("review");
			new ProjectTrustStore(f.agentDir).set(f.repo, true);

			await volt(f.checkout, ["config", "--approve"]);

			expect(selectConfig).toHaveBeenCalledOnce();
			const [shown] = vi.mocked(selectConfig).mock.calls[0];
			expect(shown.cwd).toBe(f.repo);
			expect(shown.settingsManager.getProjectSettings().packages).toEqual(["npm:@workspace/pkg"]);
		});

		it("writes project package and MCP config to the workspace's project", async () => {
			const f = await fixture("review");
			new ProjectTrustStore(f.agentDir).set(f.repo, true);
			const local = join(f.root, "local-package");
			mkdirSync(local);
			const headSettings = readFileSync(join(f.checkout, ".volt", "settings.json"), "utf-8");

			await volt(f.checkout, ["install", "-l", local]);
			expect(process.exitCode).toBeUndefined();
			const settings = JSON.parse(readFileSync(join(f.repo, ".volt", "settings.json"), "utf-8")) as {
				packages: string[];
			};
			expect(settings.packages).toHaveLength(2);
			expect(realpathSync(join(f.repo, ".volt", settings.packages[1]))).toBe(local);
			expect(readFileSync(join(f.checkout, ".volt", "settings.json"), "utf-8")).toBe(headSettings);

			await volt(f.checkout, ["mcp", "disable", "workspace-server"]);
			expect(process.exitCode).toBeUndefined();
			expect(JSON.parse(readFileSync(join(f.repo, ".volt", "mcp.json"), "utf-8"))).toMatchObject({
				servers: { "workspace-server": { enabled: false } },
			});
			expect(existsSync(join(f.checkout, ".volt", "mcp.json"))).toBe(false);
		});

		it("asks and saves trust for the workspace's repository, never the checkout", async () => {
			const f = await fixture("review");
			const prompts = answerTrustPrompt("Trust");

			const packages = await volt(f.checkout, ["list"]);

			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain(f.repo);
			expect(prompts[0]).not.toContain(f.checkout);
			expect(packages).toContain("npm:@workspace/pkg");
			expect(savedTrust(f)).toEqual({ [f.repo]: true });
		});
	});

	describe("in an ordinary managed worktree", () => {
		it("reads the checkout's own config when its workspace is trusted, whatever is saved for the checkout", async () => {
			const f = await fixture("ordinary");
			const store = new ProjectTrustStore(f.agentDir);
			store.set(f.repo, true);
			store.set(f.checkout, false);
			const updates = recordUpdates();

			const packages = await volt(f.checkout, ["list"]);
			expect(packages).toContain("npm:@head/pkg");
			expect(packages).not.toContain("npm:@workspace/pkg");
			expect(await mcpServers(f.checkout)).toEqual(["head-server"]);
			await volt(f.checkout, ["update", "--extensions"]);
			await volt(f.checkout, ["store", "update", "--yes"]);
			expect(updates).toEqual([["npm:@head/pkg"], ["npm:@head/pkg"]]);
		});

		it("is untrusted when its workspace is not trusted, whatever is saved for the checkout", async () => {
			const f = await fixture("ordinary");
			new ProjectTrustStore(f.agentDir).set(f.checkout, true);
			const updates = recordUpdates();

			expect(await volt(f.checkout, ["list"])).toContain("No packages installed.");
			expect(await mcpServers(f.checkout)).toEqual([]);
			await volt(f.checkout, ["update", "--extensions"]);
			await volt(f.checkout, ["store", "update", "--yes"]);
			expect(updates).toEqual([[], []]);

			// A decision for the workspace is the one that counts.
			new ProjectTrustStore(f.agentDir).set(f.repo, false);
			trustByDefault(f);
			expect(await volt(f.checkout, ["list"])).toContain("No packages installed.");
			expect(await mcpServers(f.checkout)).toEqual([]);
		});

		it("trusts its checkout for one command with --approve", async () => {
			const f = await fixture("ordinary");

			expect(await volt(f.checkout, ["list", "--approve"])).toContain("npm:@head/pkg");
			expect(await mcpServers(f.checkout, ["--approve"])).toEqual(["head-server"]);
			expect(savedTrust(f)).toEqual({});
		});

		it.each([
			["Trust", (f: Fixture) => ({ [f.repo]: true })],
			["Trust parent folder", (f: Fixture) => ({ [dirname(f.repo)]: true })],
			["Do not trust", (f: Fixture) => ({ [f.repo]: false })],
		])("saves the answer %s to the trust prompt for the workspace's repository", async (answer, saved) => {
			const f = await fixture("ordinary");
			const prompts = answerTrustPrompt(answer);

			const packages = await volt(f.checkout, ["list"]);

			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain(f.repo);
			expect(prompts[0]).not.toContain(f.checkout);
			expect(savedTrust(f)).toEqual(saved(f));
			if (answer === "Do not trust") expect(packages).toContain("No packages installed.");
			else expect(packages).toContain("npm:@head/pkg");
		});

		it("asks project_trust extensions about the workspace's repository, and remembers their answer for it", async () => {
			const f = await fixture("ordinary");
			const asked: string[] = [];

			const packages = await volt(
				f.checkout,
				["list"],
				[
					testExtension("trusting", (volt) => {
						volt.on("project_trust", (event) => {
							asked.push(event.cwd);
							return { trusted: "yes", remember: true };
						});
					}),
				],
			);

			expect(asked).toEqual([f.repo]);
			expect(packages).toContain("npm:@head/pkg");
			expect(savedTrust(f)).toEqual({ [f.repo]: true });
		});
	});

	describe("in a managed checkout the daemon's state does not record", () => {
		it.each(trusted.slice(1))("does not trust what the checkout holds under %s", async (_name, trust) => {
			const f = await fixture("unrecorded");
			const flags = trust(f);
			const before = savedTrust(f);
			const updates = recordUpdates();

			expect(await volt(f.checkout, ["list", ...flags])).toContain("No packages installed.");
			expect(await mcpServers(f.checkout, flags)).toEqual([]);
			await volt(f.checkout, ["update", "--extensions", ...flags]);
			await volt(f.checkout, ["store", "update", "--yes", ...flags]);
			expect(updates).toEqual([[], []]);
			await volt(f.checkout, ["config", ...flags]);
			const [shown] = vi.mocked(selectConfig).mock.calls[0];
			expect(shown.cwd).toBe(f.checkout);
			expect(shown.settingsManager.isProjectTrusted()).toBe(false);
			expect(savedTrust(f)).toEqual(before);
		});

		it("asks nobody and saves no trust for it", async () => {
			const f = await fixture("unrecorded");
			const prompts = answerTrustPrompt("Trust");
			const asked: string[] = [];

			const packages = await volt(
				f.checkout,
				["list"],
				[
					testExtension("trusting", (volt) => {
						volt.on("project_trust", (event) => {
							asked.push(event.cwd);
							return { trusted: "yes", remember: true };
						});
					}),
				],
			);

			expect(packages).toContain("No packages installed.");
			expect(prompts).toEqual([]);
			expect(asked).toEqual([]);
			expect(savedTrust(f)).toEqual({});
		});

		it("is trusted while nothing in it needs trust, unless --no-approve", async () => {
			const f = await fixture("unrecorded", { bare: true });
			const local = join(f.root, "local-package");
			mkdirSync(local);

			await volt(f.checkout, ["install", "-l", local, "--no-approve"]);
			expect(process.exitCode).toBe(1);
			expect(stderr.join("\n")).toContain("Project is not trusted.");
			expect(existsSync(join(f.checkout, ".volt", "settings.json"))).toBe(false);

			process.exitCode = undefined;
			await volt(f.checkout, ["install", "-l", local]);
			expect(process.exitCode).toBeUndefined();
			expect(existsSync(join(f.checkout, ".volt", "settings.json"))).toBe(true);
			expect(savedTrust(f)).toEqual({});
		});
	});
});
