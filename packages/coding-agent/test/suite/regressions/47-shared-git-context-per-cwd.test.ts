import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { GitContextProviderPool } from "../../../src/core/git-context-provider-pool.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const sessions: AgentSession[] = [];
const roots: string[] = [];

function createRepository(): string {
	const repository = realpathSync(mkdtempSync(join(tmpdir(), "volt-47-git-")));
	roots.push(repository);
	execFileSync("git", ["init", "--initial-branch=main"], { cwd: repository, stdio: "ignore" });
	return repository;
}

/** Build a session the way the CLI runtime factory does, optionally sharing a pool. */
async function createSession(cwd: string, gitContextProviderPool?: GitContextProviderPool): Promise<AgentSession> {
	const harness = await createHarness();
	harnesses.push(harness);
	const services = await createAgentSessionServices({
		cwd,
		agentDir: harness.tempDir,
		authStorage: harness.authStorage,
		...(gitContextProviderPool === undefined ? {} : { gitContextProviderPool }),
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(cwd),
		model: harness.getModel(),
		noTools: "all",
	});
	sessions.push(session);
	return session;
}

async function closeSession(session: AgentSession): Promise<void> {
	sessions.splice(sessions.indexOf(session), 1);
	session.dispose();
	await session.waitForClosed();
}

afterEach(async () => {
	for (const session of sessions.splice(0).reverse()) {
		session.dispose();
		await session.waitForClosed();
	}
	for (const harness of harnesses.splice(0).reverse()) harness.cleanup();
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
	);
});

describe("Regression #47: one Git context tracker per cwd within a delegation tree", () => {
	it("shares the provider between a session and its subagent and releases it with the last one", async () => {
		const repository = createRepository();
		const pool = new GitContextProviderPool();
		const parent = await createSession(repository, pool);
		const subagent = await createSession(repository, pool);
		const provider = parent.gitContextProvider;
		expect(subagent.gitContextProvider).toBe(provider);

		await closeSession(parent);
		expect(provider.isDisposed).toBe(false);
		writeFileSync(join(repository, "subagent-change.txt"), "changed\n");
		// refresh() may join a scan that started before the write, so poll for a later scan.
		await expect
			.poll(async () => {
				const observation = await subagent.gitContextProvider.refresh();
				return observation.status === "definitive" ? observation.gitContext?.status.untracked : undefined;
			})
			.toBe(1);

		await closeSession(subagent);
		expect(provider.isDisposed).toBe(true);
	});

	it("keeps a private provider per session without a pool", async () => {
		const repository = createRepository();
		const first = await createSession(repository);
		const second = await createSession(repository);
		expect(second.gitContextProvider).not.toBe(first.gitContextProvider);

		await closeSession(first);
		expect(first.gitContextProvider.isDisposed).toBe(true);
		expect(second.gitContextProvider.isDisposed).toBe(false);
	});
});
