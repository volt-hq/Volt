/**
 * A session the TUI's own session change leads it to starts in its worker as
 * the in-process host started it (P7-8c): `session_start` has the change's
 * reason (`new`, `resume`, `fork`) and names the session the TUI left, while
 * startup and `-c` start with `startup`. An open that attaches to a session
 * already running in a worker starts nothing. The daemon names a previous
 * session only when it finds it stored where the TUI says, running in the
 * same workspace.
 */

import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { clientActiveBranch } from "@hansjm10/volt-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectThrough } from "../src/client/conversation-connector.ts";
import { openDaemonConversation } from "../src/client/daemon-conversation.ts";
import { ProtocolClient } from "../src/client/protocol-client.ts";
import { getDefaultSessionDir, SessionManager, type SessionReference } from "../src/core/session-manager.ts";
import type { ConversationOpenCause, ConversationOpenTarget } from "../src/daemon/control-protocol.ts";
import { probeDaemon } from "../src/daemon/spawn.ts";
import { DaemonConnector, type DaemonConnectorDaemon } from "../src/modes/interactive/daemon-connector.ts";
import { type SessionStartRecord, sessionStarts } from "./fixtures/session-start-extension.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";

const SESSION_START_EXTENSION_PATH = realpathSync.native(
	fileURLToPath(new URL("./fixtures/session-start-extension.ts", import.meta.url)),
);

const cleanups: Array<() => Promise<unknown> | unknown> = [];

beforeEach(() => {
	sessionStarts().splice(0);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
});

async function startHarness(): Promise<DaemonHarness> {
	const harness = await createDaemonHarness({ workerExtensions: [SESSION_START_EXTENSION_PATH] });
	cleanups.push(() => harness.dispose());
	vi.stubEnv("VOLT_CODING_AGENT_DIR", harness.agentDir);
	return harness;
}

/** The harness's daemon, reached as the connector reaches one: running already. */
function harnessDaemon(agentDir: string): DaemonConnectorDaemon {
	return {
		ensure: async () => ({ ...(await probeDaemon(agentDir)), spawned: false }),
		probe: (dir) => probeDaemon(dir),
		waitForExit: async () => "exited",
		isServiceProcess: async () => false,
	};
}

/** A TUI in the harness's workspace, connected to its startup conversation. */
async function startTui(
	harness: DaemonHarness,
	target: ConversationOpenTarget = { kind: "new" },
): Promise<ProtocolClient> {
	const cwd = harness.workspacePath;
	const tui = new DaemonConnector({
		agentDir: harness.agentDir,
		startup: { target, cwd },
		spawn: { env: {}, config: {}, cwd, persist: true, session: {} },
		daemon: harnessDaemon(harness.agentDir),
	});
	cleanups.push(() => tui.dispose());
	const client = await connectThrough(tui);
	cleanups.push(() => client.stop());
	return client;
}

/** Resolves once `client` shows `conversation`, which an intent moved it to, caught up with its log. */
async function shows(client: ProtocolClient, conversation: string | undefined): Promise<string> {
	if (conversation === undefined) throw new Error("The intent moved the client nowhere");
	await vi.waitFor(
		() => {
			expect(client.moving).toBeUndefined();
			expect(client.conversation).toBe(conversation);
		},
		{ timeout: 15_000 },
	);
	await client.caughtUp();
	return conversation;
}

/** What `session_start` the session `sessionId` heard. */
function startsOf(sessionId: string): Omit<SessionStartRecord, "sessionId">[] {
	return sessionStarts()
		.filter((record) => record.sessionId === sessionId)
		.map(({ sessionId: _sessionId, ...rest }) => rest);
}

/** A stored, empty session whose working directory is `cwd`, in its default session directory. */
async function storedSession(harness: DaemonHarness, cwd: string): Promise<SessionReference> {
	const manager = await SessionManager.create(cwd, getDefaultSessionDir(cwd, harness.agentDir));
	const ref = manager.getSessionRef();
	await manager.closePersistence();
	if (!ref) throw new Error("The session has no reference");
	return ref;
}

describe("session_start of a session a TUI's session change leads it to", () => {
	it("reports new, resume, and fork with the session the TUI left, and startup at startup", async () => {
		const harness = await startHarness();
		harness.faux.setResponses([fauxAssistantMessage("first reply")]);
		const client = await startTui(harness);
		const startup = client.conversation;
		if (startup === undefined) throw new Error("The TUI shows no conversation");
		await vi.waitFor(() => expect(startsOf(startup)).toEqual([{ reason: "startup" }]));
		await client.promptAndWait("first question");

		const clone = await shows(client, (await client.intent("clone", {})).conversation);
		await vi.waitFor(() => expect(startsOf(clone)).toEqual([{ reason: "fork", previousSessionId: startup }]));

		const created = await shows(client, (await client.intent("new_session", {})).conversation);
		await vi.waitFor(() => expect(startsOf(created)).toEqual([{ reason: "new", previousSessionId: clone }]));

		const stored = await storedSession(harness, harness.workspacePath);
		const resumed = await shows(
			client,
			(await client.intent("switch_session", { sessionId: stored.sessionId })).conversation,
		);
		await vi.waitFor(() => expect(startsOf(resumed)).toEqual([{ reason: "resume", previousSessionId: created }]));

		// The clone still runs in its worker: the TUI attaches to it, and it starts nothing new.
		await shows(client, (await client.intent("switch_session", { sessionId: clone })).conversation);
		const question = clientActiveBranch(client.state).find(
			(entry) => entry.type === "message" && entry.payload?.message.role === "user",
		)?.id;
		if (question === undefined) throw new Error("The clone holds no user message");
		const fork = await shows(client, (await client.intent("fork", { entryId: question })).conversation);
		await vi.waitFor(() => expect(startsOf(fork)).toEqual([{ reason: "fork", previousSessionId: clone }]));
		expect(startsOf(clone)).toEqual([{ reason: "fork", previousSessionId: startup }]);
	}, 120_000);

	it("starts a conversation `-c` opens with startup", async () => {
		const harness = await startHarness();
		const stored = await storedSession(harness, harness.workspacePath);
		const client = await startTui(harness, { kind: "session", sessionId: stored.sessionId });
		expect(client.conversation).toBe(stored.sessionId);
		await vi.waitFor(() => expect(startsOf(stored.sessionId)).toEqual([{ reason: "startup" }]));
	}, 60_000);

	it("names a previous session only when it is stored where the TUI says, in the same workspace", async () => {
		const harness = await startHarness();
		const otherPath = join(harness.workspacePath, "..", "other");
		const innerPath = join(harness.workspacePath, "inner");
		const storeless = join(harness.workspacePath, "..", "no-store");
		for (const path of [otherPath, innerPath, storeless]) mkdirSync(path, { recursive: true });
		for (const [name, path] of [
			["other", otherPath],
			["inner", innerPath],
		]) {
			const registered = await harness.control.request({ type: "workspace_register", name, path });
			expect(registered.type).toBe("ok");
		}
		const elsewhere = await storedSession(harness, otherPath);
		const nested = await storedSession(harness, innerPath);
		const sibling = await storedSession(harness, harness.workspacePath);
		const tui = await harness.connect("tui");
		const cwd = harness.workspacePath;
		/** Open a stored session of the workspace for `cause` (given its id), and attach: what its session_start reported. */
		const openFor = async (
			cause: (targetId: string) => ConversationOpenCause,
		): Promise<Omit<SessionStartRecord, "sessionId">[]> => {
			const target = await storedSession(harness, cwd);
			const { transport } = await openDaemonConversation(tui, {
				target: { kind: "session", sessionId: target.sessionId },
				spawn: { env: {}, config: {}, cwd, persist: true, session: {} },
				clientKey: "tui-cause",
				cause: cause(target.sessionId),
			});
			const client = new ProtocolClient();
			cleanups.push(() => client.stop());
			await client.connect(transport);
			await vi.waitFor(() => expect(startsOf(target.sessionId)).toHaveLength(1));
			return startsOf(target.sessionId);
		};

		expect(
			await openFor(() => ({
				reason: "resume",
				previous: { sessionId: sibling.sessionId, sessionDir: sibling.sessionDirectory },
			})),
		).toEqual([{ reason: "resume", previousSessionId: sibling.sessionId }]);
		// The opener's default session directory holds it too.
		expect(await openFor(() => ({ reason: "new", previous: { sessionId: sibling.sessionId } }))).toEqual([
			{ reason: "new", previousSessionId: sibling.sessionId },
		]);
		// Another workspace's session is never named, wherever the TUI says it is stored: one beside it, or nested in it.
		for (const ref of [elsewhere, nested]) {
			expect(
				await openFor(() => ({
					reason: "resume",
					previous: { sessionId: ref.sessionId, sessionDir: ref.sessionDirectory },
				})),
			).toEqual([{ reason: "resume" }]);
		}
		// Nor is one the session directory named does not hold, a relative one, or the conversation itself.
		expect(
			await openFor(() => ({
				reason: "fork",
				previous: { sessionId: sibling.sessionId, sessionDir: elsewhere.sessionDirectory },
			})),
		).toEqual([{ reason: "fork" }]);
		expect(
			await openFor(() => ({ reason: "fork", previous: { sessionId: sibling.sessionId, sessionDir: "sessions" } })),
		).toEqual([{ reason: "fork" }]);
		expect(await openFor((targetId) => ({ reason: "new", previous: { sessionId: targetId } }))).toEqual([
			{ reason: "new" },
		]);
		// A directory without a store gets none.
		expect(
			await openFor(() => ({ reason: "resume", previous: { sessionId: sibling.sessionId, sessionDir: storeless } })),
		).toEqual([{ reason: "resume" }]);
		expect(readdirSync(storeless)).toEqual([]);
	}, 120_000);
});
