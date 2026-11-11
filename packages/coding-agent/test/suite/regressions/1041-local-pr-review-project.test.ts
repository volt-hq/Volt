import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../../../src/config.ts";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { restoreStdout } from "../../../src/core/output-guard.ts";
import type { PrReviewLaunch } from "../../../src/core/pr-review-placement.ts";
import { stopThemeWatcher } from "../../../src/core/theme/runtime.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { getWorktreeCheckoutPath } from "../../../src/daemon/worktree-manager.ts";
import { main } from "../../../src/main.ts";
import { writeDaemonStateFile } from "../../utilities/iroh-host-state.ts";
import { registerOnCreatedModelRegistries } from "../../utilities.ts";

/**
 * #1041: a print or JSON conversation started in a pull request review
 * checkout loaded its project from the checkout, under the trust saved for
 * the workspace: the pull request's extensions, settings, and context files.
 * The phone's conversations already loaded them from the workspace (#1034).
 * Every local conversation now resolves its project as the daemon's records
 * say, and one in a managed checkout the daemon does not record is not
 * trusted for what it holds.
 */
describe("#1041 an in-process conversation in a pull request review checkout loads its workspace's project", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	/** A project in `dir`: an extension registering `tool`, which needs trust, and `instructions` as its context file. */
	function writeProject(dir: string, tool: string, instructions: string): void {
		mkdirSync(join(dir, ".volt", "extensions"), { recursive: true });
		writeFileSync(
			join(dir, ".volt", "extensions", `${tool}.ts`),
			`import { Type } from "typebox";

export const manifest = { id: "${tool.replaceAll("_", "-")}", displayName: "${tool}" };
export default function (volt) {
	volt.registerTool({
		name: "${tool}",
		label: "${tool}",
		description: "${tool}",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	});
}
`,
		);
		writeFileSync(join(dir, "AGENTS.md"), `${instructions}\n`);
	}

	/**
	 * The trusted workspace `repo` and its managed checkout, a pull request
	 * review's when `review`, each holding a project of its own; the daemon's
	 * state file records the checkout when `recorded`.
	 */
	async function fixture(options: { review: boolean; recorded: boolean }) {
		const root = realpathSync.native(mkdtempSync(join(tmpdir(), "volt-1041-")));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const repo = join(root, "repo");
		const checkout = getWorktreeCheckoutPath(agentDir, repo, "head");
		writeProject(repo, "workspace_tool", "Workspace instructions.");
		writeProject(checkout, "head_tool", "Head instructions.");
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
		if (options.recorded) {
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
						...(options.review ? { prReviewLaunches: [launch] } : {}),
					},
				],
			});
		}
		new ProjectTrustStore(agentDir).set(repo, true);
		return { root, agentDir, repo, checkout };
	}

	/** Run the CLI in `cwd` to the end of one turn, and tell what its conversation loaded. */
	async function run(
		f: { root: string; agentDir: string },
		cwd: string,
		args: string[],
	): Promise<{ systemPrompt: string; tools: string[]; lspRoot: string | undefined; trusted: boolean | undefined }> {
		const faux = createFauxProvider();
		const model = faux.getModel();
		let systemPrompt = "";
		let tools: string[] = [];
		faux.setResponses([
			(context) => {
				systemPrompt = context.systemPrompt ?? "";
				tools = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage("done");
			},
		]);
		writeFileSync(
			join(f.agentDir, "models.json"),
			`${JSON.stringify({
				providers: {
					[model.provider]: {
						api: faux.api,
						apiKey: "faux-key",
						baseUrl: "http://localhost:0",
						models: faux.models,
					},
				},
			})}\n`,
		);
		// The CLI builds its own registry; stream the faux models through it.
		registerOnCreatedModelRegistries(faux);
		// The session is the CLI's own: read where its language servers run, and its trust, as it is disposed.
		let lspRoot: string | undefined;
		let trusted: boolean | undefined;
		const disposeSubagentToolManager = AgentSession.prototype.disposeSubagentToolManager;
		vi.spyOn(AgentSession.prototype, "disposeSubagentToolManager").mockImplementation(async function (
			this: AgentSession,
		) {
			lspRoot ??= this.getLspStatus().workspaceRoot;
			trusted ??= this.settingsManager.isProjectTrusted();
			await disposeSubagentToolManager.call(this);
		});
		vi.stubEnv("HOME", f.root);
		vi.stubEnv(ENV_AGENT_DIR, f.agentDir);
		vi.stubEnv(ENV_SESSION_DIR, join(f.root, "sessions"));
		vi.stubEnv("VOLT_PROFILE", "");
		vi.stubEnv("VOLT_OFFLINE", "1");
		vi.stubEnv("VOLT_SKIP_VERSION_CHECK", "1");
		const previousCwd = process.cwd();
		const previousExitCode = process.exitCode;
		const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		try {
			process.chdir(cwd);
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
			await main([
				...args,
				"--offline",
				"--no-session",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--provider",
				model.provider,
				"--model",
				model.id,
				"--api-key",
				"faux-key",
				"Review",
			]);
			expect(process.exitCode).not.toBe(1);
			expect(faux.getPendingResponseCount()).toBe(0);
		} finally {
			restoreStdout();
			stopThemeWatcher();
			process.chdir(previousCwd);
			process.exitCode = previousExitCode;
			if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
			else Reflect.deleteProperty(process.stdin, "isTTY");
		}
		return { systemPrompt, tools, lspRoot, trusted };
	}

	it.each([
		["print", ["--print"]],
		["json", ["--mode", "json"]],
	])("loads the workspace's project in %s mode, and works in the checkout", async (_mode, args) => {
		const f = await fixture({ review: true, recorded: true });
		const loaded = await run(f, f.checkout, args);

		expect(loaded.trusted).toBe(true);
		expect(loaded.tools).toContain("workspace_tool");
		expect(loaded.tools).not.toContain("head_tool");
		expect(loaded.systemPrompt).toContain("Workspace instructions.");
		expect(loaded.systemPrompt).not.toContain("Head instructions.");
		// Its language servers stay in the checkout it works in.
		expect(loaded.lspRoot).toBe(f.checkout);
	});

	it("keeps loading a checkout that held no pull request review from the checkout", async () => {
		const f = await fixture({ review: false, recorded: true });
		const loaded = await run(f, f.checkout, ["--print"]);

		expect(loaded.trusted).toBe(true);
		expect(loaded.tools).toContain("head_tool");
		expect(loaded.tools).not.toContain("workspace_tool");
		expect(loaded.systemPrompt).toContain("Head instructions.");
		expect(loaded.lspRoot).toBe(f.checkout);
	});

	it.each([
		["as saved for the repository its pointer names", []],
		["for --approve", ["--approve"]],
	])("does not trust a managed checkout the daemon's state does not record %s", async (_name, args) => {
		const f = await fixture({ review: true, recorded: false });
		const loaded = await run(f, f.checkout, ["--print", ...args]);

		expect(loaded.trusted).toBe(false);
		expect(loaded.tools).not.toContain("head_tool");
		expect(loaded.tools).not.toContain("workspace_tool");
	});
});
