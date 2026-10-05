import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationFactory } from "../../../src/core/host/hosted-conversation.ts";
import { registerReviewHandoffAliases, resolveCanonicalReviewSource } from "../../../src/core/review-links.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { connectTestClient, openTestHost, type TestClient } from "../../utilities/host-client.ts";
import { anchorLiveReviewRun } from "../../utilities/review-runs.ts";
import { createHarness, type Harness } from "../harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "volt-empty-handoff-"));
	const directory = join(root, "sessions");
	const managers: SessionManager[] = [];
	const harnesses: Harness[] = [];
	let client: TestClient | undefined;
	cleanups.push(async () => {
		await client?.host.dispose();
		for (const manager of managers) await manager.closePersistence();
		for (const harness of harnesses) await harness.cleanupAsync();
		rmSync(root, { recursive: true, force: true });
	});
	const factory: ConversationFactory = async ({ sessionManager, cwd, agentDir }) => {
		const h = await createHarness({ sessionManager, settings: { lsp: { enabled: false } } });
		harnesses.push(h);
		return {
			session: h.session,
			extensionsResult: h.session.resourceLoader.getExtensions(),
			diagnostics: [],
			services: {
				cwd,
				projectCwd: cwd,
				lexicalProjectCwd: cwd,
				agentDir,
				authStorage: h.authStorage,
				modelRegistry: h.session.modelRegistry,
				settingsManager: h.settingsManager,
				resourceLoader: h.session.resourceLoader,
				gitContextProvider: h.session.gitContextProvider,
				releaseGitContextProvider: () => {},
				diagnostics: [],
			},
		};
	};
	const source = await SessionManager.create(root, directory);
	managers.push(source);
	const opened = await openTestHost(factory, { sessionManager: source, cwd: root, agentDir: root });
	client = await connectTestClient(opened.host, opened.conversation);
	return { root, directory, source, client, managers };
}

/** Anchor run "run" in the open source conversation, as a review it ran does. */
async function anchor(client: TestClient): Promise<void> {
	await anchorLiveReviewRun(client.session, "run");
}

describe("#342 empty review handoffs", () => {
	it("creates a new session in another store without transferring review runs", async () => {
		const { root, source, client } = await fixture();
		const original = source.getSessionRef()!;
		const sessionDir = join(root, "other-store");
		await expect(client.newSession({ sessionDir })).resolves.toEqual({
			cancelled: false,
			sessionId: expect.any(String),
			seeded: false,
		});
		expect(client.session.sessionManager.getSessionDir()).toBe(sessionDir);
		expect(client.session.sessionRef!.storeId).not.toBe(original.storeId);
		expect(client.session.sessionId).not.toBe(original.sessionId);
	});

	it("allows empty cross-store handoffs but rejects actual review linkage", async () => {
		const { root, source, managers, client } = await fixture();
		const target = await SessionManager.create(root, join(root, "other-store"));
		managers.push(target);
		await anchor(client);
		await expect(registerReviewHandoffAliases(source, target.logWriter, [])).resolves.toBeUndefined();
		await expect(registerReviewHandoffAliases(source, target.logWriter, ["run"])).rejects.toThrow(
			"Review handoff crosses stores",
		);
		expect(await resolveCanonicalReviewSource(target, "run")).toBeUndefined();
	});

	it("retains same-store alias registration", async () => {
		const { root, directory, source, managers, client } = await fixture();
		const target = await SessionManager.create(root, directory);
		managers.push(target);
		await anchor(client);
		await registerReviewHandoffAliases(source, target.logWriter, ["run"]);
		expect(await resolveCanonicalReviewSource(target, "run")).toEqual(source.getSessionRef());
	});
});
