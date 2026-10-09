/**
 * The volt CLI's connector (Phase 7 slice 8): the TUI's conversations run in
 * the daemon's workers. Through a harness daemon, the connector opens the
 * TUI's startup conversation in a worker, resumes it on a new worker after
 * the one hosting it exited, finds a stored conversation a move leads to in
 * another session directory, asks before registering a sensitive directory
 * (D17), and reconnects after the daemon announced its shutdown only once it
 * is back (D16). Against a daemon of another version (D7), it restarts an
 * idle one in place, once, and refuses a busy one with guidance.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ConversationUnavailableError,
	connectThrough,
	type ReconnectAttempt,
} from "../src/client/conversation-connector.ts";
import type { ProtocolClient } from "../src/client/protocol-client.ts";
import { VERSION } from "../src/config.ts";
import { getDefaultSessionDirPath, SessionManager } from "../src/core/session-manager.ts";
import type { ControlRequest, ConversationOpenTarget, WorkerSpawnOptions } from "../src/daemon/control-protocol.ts";
import { startControlServer } from "../src/daemon/control-server.ts";
import { probeDaemon } from "../src/daemon/spawn.ts";
import { DaemonConnector, type DaemonConnectorDaemon } from "../src/modes/interactive/daemon-connector.ts";
import { createTestSocketEndpoint } from "./socket-test-helpers.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";

const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
});

async function startHarness(): Promise<DaemonHarness> {
	const harness = await createDaemonHarness();
	cleanups.push(() => harness.dispose());
	// Moves look for stored conversations under the agent directory's sessions.
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

function spawnOptions(cwd: string): WorkerSpawnOptions {
	return { env: {}, config: {}, cwd, persist: true, session: {} };
}

function connector(
	harness: DaemonHarness,
	cwd: string,
	target: ConversationOpenTarget = { kind: "new" },
): DaemonConnector {
	const created = new DaemonConnector({
		agentDir: harness.agentDir,
		startup: { target, cwd },
		spawn: spawnOptions(cwd),
		daemon: harnessDaemon(harness.agentDir),
	});
	cleanups.push(() => created.dispose());
	return created;
}

async function connect(
	connected: DaemonConnector,
	options: Parameters<typeof connectThrough>[1] = {},
): Promise<ProtocolClient> {
	const client = await connectThrough(connected, options);
	cleanups.push(() => client.stop());
	return client;
}

function messageTexts(client: ProtocolClient, role: "user" | "assistant"): string[] {
	return client.state.entries.flatMap((entry) => {
		const message = entry.type === "message" ? entry.payload?.message : undefined;
		if (message?.role !== role) return [];
		const content = message.content;
		return [
			typeof content === "string" ? content : content.map((block) => ("text" in block ? block.text : "")).join(""),
		];
	});
}

describe("the daemon connector", () => {
	it("opens the TUI's conversation in a worker, and resumes it on a new worker after the old one exited", async () => {
		const harness = await startHarness();
		harness.faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		const attempts: ReconnectAttempt[] = [];
		const reconnected = vi.fn();
		const tui = connector(harness, harness.workspacePath);
		const client = await connect(tui, {
			onReconnecting: (attempt) => attempts.push(attempt),
			onReconnected: reconnected,
		});
		expect(tui.daemonWorkspaceName()).toBe("ws");
		await client.promptAndWait("first");
		const [before] = (await harness.status()).workers;
		if (before === undefined) throw new Error("No worker hosts the conversation");
		expect(before).toMatchObject({ origin: "tui", sessionIds: [client.conversation], clients: { local: 1 } });

		// The worker exits; the TUI keeps its transcript and holds what the user sends.
		await harness.workers.retireWorker(before.workerId, "retention");
		await vi.waitFor(() => expect(attempts.length).toBeGreaterThan(0), { timeout: 10_000 });
		expect(messageTexts(client, "assistant")).toEqual(["first reply"]);
		await client.prompt("sent while it restarted");
		await client.waitForIdle(30_000);

		expect(reconnected).toHaveBeenCalledOnce();
		expect(attempts[0]?.reason).toBe("lost");
		expect(messageTexts(client, "user")).toEqual(["first", "sent while it restarted"]);
		expect(messageTexts(client, "assistant")).toEqual(["first reply", "second reply"]);
		const after = (await harness.status()).workers;
		expect(after).toEqual([
			expect.objectContaining({ sessionIds: [client.conversation], clients: { local: 1, remote: 0 } }),
		]);
		expect(after[0]?.workerId).not.toBe(before.workerId);
	}, 60_000);

	it("opens a stored conversation a move leads to where it is stored, another project's session directory", async () => {
		const harness = await startHarness();
		const other = join(harness.workspacePath, "other");
		mkdirSync(other);
		const stored = await SessionManager.create(other, getDefaultSessionDirPath(harness.agentDir));
		const storedId = stored.getSessionId();
		await stored.logWriter.appendMessage({ role: "user", content: "stored elsewhere", timestamp: 1 });
		await stored.closePersistence();

		const tui = connector(harness, harness.workspacePath);
		const client = await connect(tui);
		const accepted = await client.intent("switch_session", { sessionId: storedId });
		expect(accepted.conversation).toBe(storedId);
		await vi.waitFor(
			() => {
				expect(client.moving).toBeUndefined();
				expect(client.conversation).toBe(storedId);
			},
			{ timeout: 15_000 },
		);
		await client.caughtUp();
		expect(messageTexts(client, "user")).toEqual(["stored elsewhere"]);
		expect((await harness.status()).workers.flatMap((worker) => worker.sessionIds)).toContain(storedId);
	}, 60_000);

	it("asks before registering a sensitive directory, and opens nothing without an answer (D17)", async () => {
		const harness = await startHarness();
		// The harness's root holds its agent directory.
		const root = realpathSync.native(dirname(harness.agentDir));
		const unanswered = connector(harness, root);
		const declined = vi.fn(async () => undefined);
		await expect(connectThrough(unanswered, { askWorkspaceRegistration: declined })).rejects.toBeInstanceOf(
			ConversationUnavailableError,
		);
		expect(declined).toHaveBeenCalledWith(root);
		expect((await harness.status()).workspaces.some((workspace) => workspace.path === root)).toBe(false);

		const asked = vi.fn(async () => "local" as const);
		const local = connector(harness, root);
		await connect(local, { askWorkspaceRegistration: asked });
		expect(asked).toHaveBeenCalledWith(root);
		expect((await harness.status()).workspaces).toContainEqual(
			expect.objectContaining({ path: root, localOnly: true }),
		);
	}, 60_000);

	it("waits for the daemon after its announced shutdown instead of quitting (D16)", async () => {
		const harness = await startHarness();
		const attempts: ReconnectAttempt[] = [];
		const shutdownRequested = vi.fn();
		const tui = connector(harness, harness.workspacePath);
		const client = await connect(tui, {
			onReconnecting: (attempt) => attempts.push(attempt),
			onShutdownRequested: shutdownRequested,
		});
		expect(await harness.shutdown()).toBe(0);
		await vi.waitFor(() => expect(attempts[0]).toMatchObject({ attempt: 1, reason: "shutdown" }), {
			timeout: 15_000,
		});
		expect(await tui.hostRestarting()).toBe(true);
		expect(shutdownRequested).not.toHaveBeenCalled();
		expect(client.disconnected).toBe(true);
	}, 60_000);
});

describe("the daemon connector's trust and workspace bounds", () => {
	it("passes --approve only to a worker of its startup conversation's project", async () => {
		const harness = await startHarness();
		const other = join(harness.workspacePath, "other");
		mkdirSync(other);
		const stored = await SessionManager.create(other, getDefaultSessionDirPath(harness.agentDir));
		const storedId = stored.getSessionId();
		await stored.logWriter.appendMessage({ role: "user", content: "in another project", timestamp: 1 });
		await stored.closePersistence();
		const tui = new DaemonConnector({
			agentDir: harness.agentDir,
			startup: { target: { kind: "new" }, cwd: harness.workspacePath },
			spawn: { ...spawnOptions(harness.workspacePath), config: { trust: true } },
			daemon: harnessDaemon(harness.agentDir),
		});
		cleanups.push(() => tui.dispose());
		const client = await connect(tui);
		const startupId = client.conversation ?? "";
		await client.intent("switch_session", { sessionId: storedId });
		await vi.waitFor(() => expect(client.conversation === storedId && client.moving === undefined).toBe(true), {
			timeout: 15_000,
		});
		const configOf = async (sessionId: string) => {
			const spec = await harness.workers.open(
				{ workspaceName: "ws", workspaceGeneration: harness.generation(), sessionId },
				{
					compatibility: { origin: "tui", config: {} },
					client: "probe",
					prepare: () => Promise.reject(new Error("The worker is live")),
					attach: (worker) => worker.spec,
				},
			);
			return spec.origin === "tui" ? spec.config : undefined;
		};
		expect(await configOf(startupId)).toEqual({ trust: true });
		expect(await configOf(storedId)).toEqual({});
	}, 60_000);

	it("does not reopen a conversation whose workspace was unregistered while it was away", async () => {
		const harness = await startHarness();
		const stopped = vi.fn();
		const tui = connector(harness, harness.workspacePath);
		await connect(tui, { onStopped: stopped });
		const [worker] = (await harness.status()).workers;
		if (worker === undefined) throw new Error("No worker hosts the conversation");
		expect(await harness.control.request({ type: "workspace_unregister", name: "ws" })).toMatchObject({ type: "ok" });
		await harness.workers.retireWorker(worker.workerId, "authority");
		await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce(), { timeout: 15_000 });
		expect(stopped.mock.calls[0]?.[0]).toBeInstanceOf(ConversationUnavailableError);
		expect(String(stopped.mock.calls[0]?.[0])).toContain("The workspace ws was unregistered");
		expect((await harness.status()).workspaces.some((workspace) => workspace.name === "ws")).toBe(false);
	}, 60_000);
});

describe("the daemon connector against a daemon of another version (D7)", () => {
	/** A control endpoint that says it runs volt 0.0.0-other, with `workers` workers. */
	async function otherVersion(workers: number): Promise<{ socketPath: string; requests: ControlRequest[] }> {
		const endpoint = createTestSocketEndpoint("volt-connector-skew");
		cleanups.push(endpoint.cleanup);
		const requests: ControlRequest[] = [];
		const server = await startControlServer({
			socketPath: endpoint.socketPath,
			version: "0.0.0-other",
			handlers: {
				onRequest: (connection, request) => {
					requests.push(request);
					if (request.type === "status") {
						connection.send({
							type: "status_result",
							id: request.id,
							version: "0.0.0-other",
							protocolVersion: 5,
							pid: 4242,
							startedAtMs: 1,
							environment: { source: "inherited", reason: "test" },
							phoneConnections: 0,
							remoteTransport: { state: "unavailable" },
							workspaces: [],
							clients: [],
							keepAwake: { enabled: false, state: "disabled" },
							workers: Array.from({ length: workers }, (_, index) => ({
								workerId: `w-${index}`,
								pid: 100 + index,
								state: "live" as const,
								origin: "tui" as const,
								workspaceName: "ws",
								sessionIds: [],
								clients: { local: 1, remote: 0 },
							})),
						});
						return;
					}
					connection.send({ type: "ok", id: request.id });
				},
			},
		});
		cleanups.push(() => server.close());
		return { socketPath: endpoint.socketPath, requests };
	}

	function skewedConnector(socketPath: string, underService = false): DaemonConnector {
		const ensured = { healthy: true, state: "healthy" as const, socketPath, spawned: false, version: "0.0.0-other" };
		const created = new DaemonConnector({
			agentDir: dirname(socketPath),
			startup: { target: { kind: "new" }, cwd: process.cwd() },
			spawn: spawnOptions(process.cwd()),
			daemon: {
				ensure: async () => ensured,
				probe: async () => ensured,
				waitForExit: async () => "exited",
				isServiceProcess: async () => underService,
			},
		});
		cleanups.push(() => created.dispose());
		return created;
	}

	it("refuses a busy daemon of another version with restart guidance, and leaves it running", async () => {
		const daemon = await otherVersion(2);
		const tui = skewedConnector(daemon.socketPath);
		const refused = tui.open({ kind: "startup" });
		await expect(refused).rejects.toBeInstanceOf(ConversationUnavailableError);
		await expect(refused).rejects.toThrow(
			`The Volt daemon runs 0.0.0-other with 2 running conversations; this terminal runs ${VERSION}. Run \`volt daemon restart\``,
		);
		expect(daemon.requests.map((request) => request.type)).toEqual(["status"]);
	});

	it("never replaces a daemon the login service runs", async () => {
		const daemon = await otherVersion(0);
		const tui = skewedConnector(daemon.socketPath, true);
		await expect(tui.open({ kind: "startup" })).rejects.toThrow(
			"Run `volt daemon install-service` from this installation",
		);
		expect(daemon.requests.map((request) => request.type)).toEqual(["status"]);
	});

	it("restarts an idle daemon of another version in place, once, then refuses when it still differs", async () => {
		const daemon = await otherVersion(0);
		const tui = skewedConnector(daemon.socketPath);
		await expect(tui.open({ kind: "startup" })).rejects.toThrow(
			`The Volt daemon runs 0.0.0-other; this terminal runs ${VERSION}.`,
		);
		expect(daemon.requests.map((request) => request.type)).toEqual(["status", "shutdown"]);
	});
});
