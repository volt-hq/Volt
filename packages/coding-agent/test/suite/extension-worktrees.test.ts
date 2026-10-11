/**
 * Extension worktrees (`ctx.worktrees`): in a conversation the daemon hosts,
 * an extension lists the managed worktrees of the conversation's workspace
 * and, with the `exec` permission, creates one through the daemon. Elsewhere
 * both reject.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "../../src/core/extensions/index.ts";
import type { ControlWorktreeStatus } from "../../src/daemon/control-protocol.ts";
import type { SessionWorktreeCreateOptions, SessionWorktreeDaemon } from "../../src/daemon/session-worktree.ts";
import type { CreateTestExtensionsResultInput } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const issue12: ControlWorktreeStatus = {
	id: "issue-12",
	workspaceName: "volt",
	path: "/agent/worktrees/volt/issue-12",
	branch: "volt/issue-12",
	baseRef: "main",
	createdAt: 1,
	sessionIds: [],
	available: true,
	dirty: false,
};

/** A daemon route that keeps the worktrees it created, beside an archived one. */
function fakeDaemon(): SessionWorktreeDaemon & { created: SessionWorktreeCreateOptions[] } {
	const created: SessionWorktreeCreateOptions[] = [];
	const archived: ControlWorktreeStatus = {
		id: "issue-3",
		workspaceName: "volt",
		path: "/agent/worktrees/volt/issue-3",
		branch: "volt/issue-3",
		createdAt: 0,
		sessionIds: ["s-1"],
		available: false,
	};
	return {
		created,
		restore: vi.fn(),
		create: async (options) => {
			created.push(options);
			return issue12;
		},
		list: async () => [archived, issue12],
	};
}

/** A harness whose extension keeps its `/capture` command's context. */
async function setup(
	options: {
		worktreeDaemon?: SessionWorktreeDaemon;
		permissions?: CreateTestExtensionsResultInput["permissions"];
	} = {},
): Promise<ExtensionCommandContext> {
	let captured: ExtensionCommandContext | undefined;
	const harness = await createHarness({
		...(options.worktreeDaemon === undefined ? {} : { worktreeDaemon: options.worktreeDaemon }),
		extensionFactories: [
			{
				id: "orchestrator",
				permissions: options.permissions ?? ["exec"],
				factory: (volt) => {
					volt.registerCommand("capture", {
						handler: async (_args, ctx) => {
							captured = ctx;
						},
					});
				},
			},
		],
	});
	harnesses.push(harness);
	await harness.session.prompt("/capture");
	if (!captured) throw new Error("/capture did not run");
	return captured;
}

describe("extension worktrees", () => {
	it("lists and creates the workspace's managed worktrees through the daemon", async () => {
		const daemon = fakeDaemon();
		const ctx = await setup({ worktreeDaemon: daemon });

		expect(await ctx.worktrees.list()).toEqual([
			{ id: "issue-3", path: "/agent/worktrees/volt/issue-3", branch: "volt/issue-3", available: false },
			{
				id: "issue-12",
				path: "/agent/worktrees/volt/issue-12",
				branch: "volt/issue-12",
				baseRef: "main",
				available: true,
				dirty: false,
			},
		]);
		expect(await ctx.worktrees.create({ name: "issue-12", baseRef: "main" })).toMatchObject({
			id: "issue-12",
			path: "/agent/worktrees/volt/issue-12",
		});
		expect(daemon.created).toEqual([{ name: "issue-12", baseRef: "main" }]);
	});

	it("needs the exec permission to create one, and checks what it asks for", async () => {
		const daemon = fakeDaemon();
		const withoutExec = await setup({ worktreeDaemon: daemon, permissions: [] });
		await expect(withoutExec.worktrees.create({ name: "issue-12" })).rejects.toThrow(
			'Extension "orchestrator" needs the "exec" permission to use ctx.worktrees.create',
		);
		// Listing needs no permission.
		expect(await withoutExec.worktrees.list()).toHaveLength(2);

		const ctx = await setup({ worktreeDaemon: daemon });
		await expect(ctx.worktrees.create({ name: " " })).rejects.toThrow(
			"ctx.worktrees.create: name must be a non-empty string",
		);
		expect(daemon.created).toEqual([]);
	});

	it("rejects outside a conversation the daemon hosts", async () => {
		const ctx = await setup();
		const unavailable = "Managed worktrees are available only in conversations the daemon hosts";
		await expect(ctx.worktrees.list()).rejects.toThrow(unavailable);
		await expect(ctx.worktrees.create({ name: "issue-12" })).rejects.toThrow(unavailable);
	});
});
