/**
 * The issue orchestrator extension's wiring: `/orchestrate start` checks the
 * conversation and the workflow, asks, and runs the loop as work; the loop
 * creates the issue's worktree, runs its hook, starts the role's agent there
 * under the work, and shows it in the panel; `/orchestrate stop` cancels the
 * agent and ends the work.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import issueOrchestrator, { manifest } from "../../examples/extensions/issue-orchestrator/index.ts";
import type {
	ExecOptions,
	ExecResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionPanel,
	ExtensionSubagentResult,
	ExtensionSubagentStartOptions,
	ExtensionWorktree,
	RegisteredCommand,
	WorkRun,
	WorkRunResult,
} from "../../src/index.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const WORKFLOW = `---
tracker:
  repo: o/r
  labels: [agent-ready]
  review_author: volt-agent[bot]
workspace:
  base_ref: main
  hooks:
    after_create: npm ci --ignore-scripts
---
`;

const ISSUE = {
	number: 12,
	title: "Fix the thing",
	body: "Details",
	url: "https://github.com/o/r/issues/12",
	labels: [{ name: "agent-ready" }],
	state: "OPEN",
	createdAt: "2026-10-01T00:00:00Z",
};

/** `gh` and `bash` as the extension runs them: GitHub has one labeled issue without a pull request. */
function exec(calls: Array<{ command: string; args: string[]; cwd?: string }>) {
	return async (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
		calls.push({ command, args, ...(options?.cwd === undefined ? {} : { cwd: options.cwd }) });
		const line = args.join(" ");
		const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
		if (command === "bash") return ok("installed");
		if (line.startsWith("issue list")) return ok(JSON.stringify([ISSUE]));
		if (line.startsWith("issue view 12")) return ok(JSON.stringify(ISSUE));
		if (line.startsWith("pr list")) return ok("[]");
		return { stdout: "", stderr: `unexpected gh ${line}`, code: 1, killed: false };
	};
}

function setup(options: { confirm?: boolean } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "volt-orchestrator-extension-"));
	directories.push(cwd);
	mkdirSync(join(cwd, ".volt"));
	writeFileSync(join(cwd, ".volt", "WORKFLOW.md"), WORKFLOW);
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	const volt = {
		registerWorkKind: vi.fn(),
		registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, command);
		},
		on: vi.fn(),
		exec: exec(calls),
	} as unknown as ExtensionAPI;
	issueOrchestrator(volt);

	const notifications: string[] = [];
	const panels: Array<ExtensionPanel | undefined> = [];
	const worktrees: ExtensionWorktree[] = [];
	const creates: Array<{ name: string; branch: string; baseRef?: string; reuseBranch?: boolean }> = [];
	const started: ExtensionSubagentStartOptions[] = [];
	const cancelled: string[] = [];
	const ended = Promise.withResolvers<ExtensionSubagentResult>();
	let work: Promise<WorkRunResult> | undefined;
	const workAbort = new AbortController();
	const ctx = {
		cwd,
		invokedBy: "local",
		signal: new AbortController().signal,
		isProjectTrusted: () => true,
		ui: {
			notify: (message: string) => notifications.push(message),
			confirm: async () => options.confirm ?? true,
			setPanel: (_name: string, panel: ExtensionPanel | undefined) => panels.push(panel),
		},
		worktrees: {
			list: async () => [...worktrees],
			create: async (create: { name: string; branch: string; baseRef?: string; reuseBranch?: boolean }) => {
				creates.push(create);
				const worktree: ExtensionWorktree = {
					id: create.name,
					path: `/agent/worktrees/r/${create.name}`,
					branch: create.branch,
					...(create.baseRef === undefined ? {} : { baseRef: create.baseRef }),
					available: true,
				};
				worktrees.push(worktree);
				return worktree;
			},
		},
		subagents: {
			start: async (start: ExtensionSubagentStartOptions) => {
				started.push(start);
				return { id: "sa_1", sessionId: "child-1", ended: ended.promise };
			},
			cancel: async (id: string) => {
				cancelled.push(id);
				ended.resolve({ status: "cancelled", usage: { tokens: 3, cost: 0.25 } });
			},
		},
		startWork: async (_kind: string, _options: unknown, run: WorkRun) => {
			work = run({
				workId: "work-1",
				signal: workAbort.signal,
				progress: () => {},
				checkpoint: () => {},
				output: () => {},
			});
			return { workId: "work-1" };
		},
	} as unknown as ExtensionCommandContext;
	const command = (args: string) => {
		const registered = commands.get("orchestrate");
		if (!registered) throw new Error("/orchestrate is not registered");
		return registered.handler(args, ctx);
	};
	return { command, calls, notifications, panels, worktrees, creates, started, cancelled, work: () => work };
}

describe("issue orchestrator extension", () => {
	it("declares the exec permission it runs gh and agents with", () => {
		expect(manifest).toMatchObject({ id: "issue-orchestrator", permissions: ["exec"] });
	});

	it("starts an issue's agent in its worktree under the loop's work, and stops it", async () => {
		const { command, calls, panels, worktrees, creates, started, cancelled, work, notifications } = setup();

		await command("start");
		await vi.waitFor(() => expect(started).toHaveLength(1));
		// On the issue's branch, which a released issue still has.
		expect(creates).toEqual([{ name: "issue-12", branch: "volt/issue-12", reuseBranch: true, baseRef: "main" }]);
		expect(worktrees).toEqual([
			{
				id: "issue-12",
				path: "/agent/worktrees/r/issue-12",
				branch: "volt/issue-12",
				baseRef: "main",
				available: true,
			},
		]);
		expect(calls).toContainEqual({
			command: "bash",
			args: ["-lc", "npm ci --ignore-scripts"],
			cwd: "/agent/worktrees/r/issue-12",
		});
		expect(started[0]).toMatchObject({
			agent: "general",
			cwd: "/agent/worktrees/r/issue-12",
			parentWorkId: "work-1",
			limits: { maxDurationMs: 3_600_000 },
		});
		expect(started[0]?.task).toContain("You are working on GitHub issue o/r#12: Fix the thing");
		// Issues the agent files get the workflow's labels, so the orchestrator works them too.
		expect(started[0]?.task).toContain(
			"Label every issue you file agent-ready, agent-filed, and say in its body that you found it while working on o/r#12.",
		);
		await vi.waitFor(() =>
			expect(panels.at(-1)?.node).toMatchObject({
				type: "card",
				title: "o/r",
				sections: [{ key: "running", title: "Running" }],
				actions: [
					{ id: "open-12", intent: { type: "open_work", input: { workId: "sa_1" } } },
					{ id: "refresh" },
					{
						id: "stop",
						intent: { type: "extension.command.issue-orchestrator.orchestrate", input: { arguments: "stop" } },
					},
				],
			}),
		);

		await command("start");
		expect(notifications).toContain("The orchestrator is already running.");
		await command("stop");
		expect(await work()).toMatchObject({
			outcome: "completed",
			result: { summary: expect.stringContaining("1 runs, $0.25") },
		});
		expect(cancelled).toEqual(["sa_1"]);
		expect(panels.at(-1)).toBeUndefined();
		await command("status");
		expect(notifications.at(-1)).toBe("The orchestrator is not running.");
	});

	it("starts nothing the user declines", async () => {
		const { command, work, calls } = setup({ confirm: false });
		await command("start");
		expect(work()).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("says what is wrong with a workflow it cannot load", async () => {
		const { command, notifications, work } = setup();
		await command("start missing.md");
		expect(work()).toBeUndefined();
		expect(notifications.at(-1)).toMatch(/^Cannot read .*missing\.md/);
	});
});
