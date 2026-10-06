/**
 * Conversations a TUI opens in daemon workers (Phase 7 slice 7): a protocol
 * client opens through a harness daemon's control socket as the TUI will
 * (`conversation_open`, then its end of the relayed stream), and its worker
 * serves it on the local profile. The worker is spawned with the TUI's
 * options, a second TUI attaches to it, moves reconnect through the daemon,
 * the working directory's workspace is found or registered (D17), a
 * `--no-session` conversation stays with its opener (D15), and settings and
 * credentials other processes write reach the worker (D12).
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { HostFrame } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ConnectorTarget,
	type ConversationConnector,
	connectThrough,
	type OpenedConversation,
} from "../src/client/conversation-connector.ts";
import {
	type ConversationOpened,
	type ConversationOpenRequest,
	DaemonConversationOpenError,
	openDaemonConversation,
	openNotices,
	WorkspaceConfirmationRequiredError,
} from "../src/client/daemon-conversation.ts";
import { ProtocolClient } from "../src/client/protocol-client.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getDefaultSessionDirPath, SessionManager } from "../src/core/session-manager.ts";
import type { DaemonClient } from "../src/daemon/control-client.ts";
import type { WorkerSpawnOptions } from "../src/daemon/control-protocol.ts";
import { WorkerOpenError } from "../src/daemon/worker-registry.ts";
import { spawnFlagRecord } from "./fixtures/spawn-flag-extension.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";

const SPAWN_FLAG_EXTENSION_PATH = realpathSync.native(
	fileURLToPath(new URL("./fixtures/spawn-flag-extension.ts", import.meta.url)),
);

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function startHarness(): Promise<DaemonHarness> {
	const harness = await createDaemonHarness();
	cleanups.push(() => harness.dispose());
	return harness;
}

function spawnOptions(cwd: string, overrides: Partial<WorkerSpawnOptions> = {}): WorkerSpawnOptions {
	return { env: {}, config: {}, cwd, persist: true, session: {}, ...overrides };
}

/** Open `request` as a TUI and connect a protocol client on its stream. */
async function openTui(
	tui: DaemonClient,
	request: ConversationOpenRequest,
): Promise<{ opened: ConversationOpened; client: ProtocolClient }> {
	const { opened, transport } = await openDaemonConversation(tui, request);
	const client = new ProtocolClient({ followMoves: "reconnect" });
	cleanups.push(() => client.stop());
	await client.connect(transport);
	return { opened, client };
}

/** The daemon connector's shape over `openDaemonConversation`: a TUI's opens, the startup one first. */
class TestDaemonConnector implements ConversationConnector {
	readonly opened: ConversationOpened[] = [];
	private readonly tui: DaemonClient;
	private readonly startup: ConversationOpenRequest["target"];
	private readonly spawn: WorkerSpawnOptions;
	private readonly clientKey: string;

	constructor(
		tui: DaemonClient,
		startup: ConversationOpenRequest["target"],
		spawn: WorkerSpawnOptions,
		clientKey: string,
	) {
		this.tui = tui;
		this.startup = startup;
		this.spawn = spawn;
		this.clientKey = clientKey;
	}

	async open(target: ConnectorTarget): Promise<OpenedConversation> {
		const { opened, transport } = await openDaemonConversation(this.tui, {
			target: target.kind === "startup" ? this.startup : { kind: "session", sessionId: target.sessionId },
			spawn: this.spawn,
			clientKey: this.clientKey,
		});
		this.opened.push(opened);
		return {
			transport,
			sessionId: opened.sessionId,
			workspaceName: opened.workspaceName,
			notices: openNotices(opened),
		};
	}

	stopServing(): void {}

	async dispose(): Promise<void> {}

	daemonWorkspaceName(): string | undefined {
		return this.opened.at(-1)?.workspaceName;
	}

	onThemeSnapshot(): () => void {
		return () => {};
	}
}

function assistantTexts(client: ProtocolClient): string[] {
	return client.state.entries.flatMap((entry) => {
		const message = entry.type === "message" ? entry.payload?.message : undefined;
		if (message?.role !== "assistant") return [];
		return [message.content.map((block) => ("text" in block ? block.text : "")).join("")];
	});
}

/** Resolves once `client` shows `conversation` on a connection of its own, caught up with its log. */
async function shows(client: ProtocolClient, conversation: string | undefined): Promise<void> {
	if (conversation === undefined) throw new Error("The intent moved the client nowhere");
	// The client reconnects through the daemon: an open, a relay, and the worker's serving.
	await vi.waitFor(
		() => {
			expect(client.moving).toBeUndefined();
			expect(client.conversation).toBe(conversation);
		},
		{ timeout: 15_000 },
	);
	await client.caughtUp();
}

/** The `changed` catalogs `client` was told to refetch, from now on. */
function changedCatalogs(client: ProtocolClient): string[] {
	const catalogs: string[] = [];
	client.onFrame((frame: HostFrame) => {
		if (frame.type === "changed") catalogs.push(frame.catalog);
	});
	return catalogs;
}

describe("conversations TUIs open in workers", () => {
	it("serves a TUI's new conversation from the worker its open spawned, on the local profile", async () => {
		const harness = await startHarness();
		harness.faux.setResponses([fauxAssistantMessage("hello from the TUI's worker")]);
		const tui = await harness.connect("tui");
		const { opened, client } = await openTui(tui, {
			target: { kind: "new" },
			spawn: spawnOptions(harness.workspacePath),
			clientKey: "tui-1",
		});
		expect(opened).toMatchObject({ selection: "created", workspaceName: "ws", spawned: true, ignoredOptions: [] });
		expect(client.conversation).toBe(opened.sessionId);

		await client.promptAndWait("hi");
		expect(assistantTexts(client)).toEqual(["hello from the TUI's worker"]);
		// The worker wrote the stored log the daemon created.
		const stored = await SessionManager.findForResume(
			getDefaultSessionDirPath(harness.workspacePath, harness.agentDir),
			opened.sessionId,
		);
		expect(stored?.sessionId).toBe(opened.sessionId);
		expect((await harness.status()).workers).toEqual([
			expect.objectContaining({
				origin: "tui",
				state: "live",
				workspaceName: "ws",
				sessionIds: [opened.sessionId],
				clients: { local: 1, remote: 0 },
			}),
		]);
		expect(harness.audit()).toContainEqual(
			expect.objectContaining({
				type: "relay_opened",
				success: true,
				details: expect.objectContaining({ client: "tui", sessionId: opened.sessionId }),
			}),
		);

		// The TUI left: the worker stays, detached.
		await client.stop();
		await expect.poll(async () => (await harness.status()).workers[0]?.clients.local, { timeout: 10_000 }).toBe(0);
		expect((await harness.status()).workers).toHaveLength(1);
	}, 60_000);

	it("tells its TUI the host shut down when the daemon stops", async () => {
		const harness = await startHarness();
		const tui = await harness.connect("tui");
		const { client } = await openTui(tui, {
			target: { kind: "new" },
			spawn: spawnOptions(harness.workspacePath),
			clientKey: "tui-1",
		});
		const frames: HostFrame[] = [];
		client.onFrame((frame) => frames.push(frame));
		expect(await harness.shutdown()).toBe(0);
		// The client stops at the subscription's end, before the connection's `fatal{host_shutdown}`.
		await vi.waitFor(
			() => expect(frames).toContainEqual(expect.objectContaining({ type: "ended", reason: "shutdown" })),
			{ timeout: 10_000 },
		);
	}, 60_000);

	it("attaches a second TUI to the live worker: its session-level options apply, and the spawn-only ones it kept are named", async () => {
		const harness = await startHarness();
		const first = await harness.connect("tui");
		const opener = await openTui(first, {
			target: { kind: "new" },
			spawn: spawnOptions(harness.workspacePath, { config: { tools: ["read", "bash"] } }),
			clientKey: "tui-1",
		});
		expect(opener.client.state.planning?.mode ?? "build").toBe("build");

		const second = await harness.connect("tui");
		const attached = await openTui(second, {
			target: { kind: "session", sessionId: opener.opened.sessionId },
			spawn: spawnOptions(harness.workspacePath, {
				config: { tools: ["read"], trust: true },
				session: { plan: true },
			}),
			clientKey: "tui-2",
		});
		expect(attached.opened).toMatchObject({
			sessionId: opener.opened.sessionId,
			selection: "resumed",
			spawned: false,
			ignoredOptions: ["trust", "tools"],
		});
		expect(openNotices(attached.opened)).toEqual([
			"The conversation was already running; it keeps its own --approve/--no-approve, --tools.",
		]);
		// The second TUI's plan mode applied once it attached; the first TUI sees it too.
		await vi.waitFor(() => expect(attached.client.state.planning?.mode).toBe("plan"), { timeout: 10_000 });
		await vi.waitFor(() => expect(opener.client.state.planning?.mode).toBe("plan"), { timeout: 10_000 });
		const [worker] = (await harness.status()).workers;
		expect(worker).toMatchObject({ sessionIds: [opener.opened.sessionId], clients: { local: 2, remote: 0 } });
	}, 60_000);

	it("lets only a TUI open a conversation, with absolute paths", async () => {
		const harness = await startHarness();
		const request = { target: { kind: "new" as const }, spawn: spawnOptions(harness.workspacePath), clientKey: "c" };
		expect(await harness.control.request({ type: "conversation_open", ...request })).toMatchObject({
			type: "error",
			code: "forbidden",
		});
		const tui = await harness.connect("tui");
		await expect(
			openDaemonConversation(tui, {
				...request,
				spawn: spawnOptions(harness.workspacePath, { config: { extensions: ["./relative.ts"] } }),
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
		await expect(openDaemonConversation(tui, { ...request, spawn: spawnOptions("relative/cwd") })).rejects.toThrow(
			DaemonConversationOpenError,
		);
		expect((await harness.status()).workers).toEqual([]);
	}, 60_000);

	it("finds the workspace of the working directory, and registers one no workspace contains (D17)", async () => {
		const harness = await startHarness();
		const tui = await harness.connect("tui");
		const nested = join(harness.workspacePath, "packages", "app");
		mkdirSync(nested, { recursive: true });
		const inside = await openDaemonConversation(tui, {
			target: { kind: "new" },
			spawn: spawnOptions(nested),
			clientKey: "tui-1",
		});
		cleanups.push(() => inside.transport.close() as Promise<void>);
		expect(inside.opened.workspaceName).toBe("ws");

		const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "volt-tui-open-")));
		cleanups.push(async () => rmSync(outside, { recursive: true, force: true }));
		const registered = await openDaemonConversation(tui, {
			target: { kind: "new" },
			spawn: spawnOptions(outside),
			clientKey: "tui-1",
		});
		cleanups.push(() => registered.transport.close() as Promise<void>);
		expect(registered.opened.workspaceName).toBe(basename(outside));
		const again = await openDaemonConversation(tui, {
			target: { kind: "new" },
			spawn: spawnOptions(outside),
			clientKey: "tui-1",
		});
		cleanups.push(() => again.transport.close() as Promise<void>);
		expect(again.opened.workspaceName).toBe(basename(outside));
		expect((await harness.status()).workspaces).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: basename(outside), path: outside })]),
		);
		expect(
			harness
				.audit()
				.filter((event) => event.type === "workspace_registered" && event.details?.source === "tui_open"),
		).toEqual([expect.objectContaining({ workspace: basename(outside), success: true })]);
	}, 60_000);

	it("follows a structural move by reconnecting through the daemon: the target runs in a worker of its own (D1)", async () => {
		const harness = await startHarness();
		harness.faux.setResponses([fauxAssistantMessage("first reply")]);
		const tui = await harness.connect("tui");
		const spawn = spawnOptions(harness.workspacePath);
		const connector = new TestDaemonConnector(tui, { kind: "new" }, spawn, "tui-1");
		const client = await connectThrough(connector);
		cleanups.push(() => client.stop());
		await client.promptAndWait("first question");
		const source = client.conversation;

		const target = (await client.intent("new_session", {})).conversation;
		await shows(client, target);
		expect(connector.opened.map((opened) => [opened.sessionId, opened.spawned])).toEqual([
			[source, true],
			[target, true],
		]);
		const workers = (await harness.status()).workers;
		expect(workers.map((worker) => [worker.sessionIds, worker.clients.local]).sort()).toEqual(
			[
				[[source], 0],
				[[target], 1],
			].sort(),
		);

		// Workers TUIs opened with the same options share a compatibility key; a phone's differs.
		const keys = await Promise.all(
			[source, target].map((sessionId) =>
				harness.workers.open(
					{ workspaceName: "ws", workspaceGeneration: harness.generation(), sessionId: sessionId ?? "" },
					{
						origin: "tui",
						client: "tui-1",
						prepare: () => Promise.reject(new Error("The worker is live")),
						attach: (worker) => worker.compatibilityKey,
					},
				),
			),
		);
		expect(keys[0]).toBe(keys[1]);
		const phone = await harness.openWorker(await harness.createSession());
		expect(phone.worker.compatibilityKey).not.toBe(keys[0]);
	}, 60_000);

	it("keeps a --no-session conversation in its worker's memory, for its opener only, and retires the worker once it left (D15)", async () => {
		const harness = await startHarness();
		harness.faux.setResponses([fauxAssistantMessage("remembered nowhere")]);
		const tui = await harness.connect("tui");
		const connector = new TestDaemonConnector(
			tui,
			{ kind: "new" },
			spawnOptions(harness.workspacePath, { persist: false }),
			"tui-1",
		);
		const client = await connectThrough(connector);
		cleanups.push(() => client.stop());
		await client.promptAndWait("hi");
		const startup = client.conversation ?? "";
		expect(
			await SessionManager.findForResume(getDefaultSessionDirPath(harness.workspacePath, harness.agentDir), startup),
		).toBeUndefined();

		// Another TUI, or a phone, never reaches it.
		const other = await harness.connect("tui");
		await expect(
			openDaemonConversation(other, {
				target: { kind: "session", sessionId: startup },
				spawn: spawnOptions(harness.workspacePath),
				clientKey: "tui-2",
			}),
		).rejects.toMatchObject({ code: "conversation_in_use" });
		await expect(
			harness.workers.open(
				{ workspaceName: "ws", workspaceGeneration: harness.generation(), sessionId: startup },
				{ origin: "phone", prepare: () => Promise.reject(new Error("unused")), attach: () => undefined },
			),
		).rejects.toBeInstanceOf(WorkerOpenError);

		// A move of an in-memory conversation stays in its worker: the target exists nowhere else.
		const target = (await client.intent("new_session", {})).conversation;
		await shows(client, target);
		expect((await harness.status()).workers).toEqual([
			expect.objectContaining({ sessionIds: [startup, target], clients: { local: 1, remote: 0 } }),
		]);

		await client.stop();
		await expect.poll(async () => (await harness.status()).workers, { timeout: 30_000 }).toEqual([]);
	}, 60_000);

	it("builds the conversation from the TUI's spawn options: -e extensions, registerFlag values, and its trust", async () => {
		const harness = await startHarness();
		const project = join(harness.workspacePath, "trusted");
		mkdirSync(join(project, ".volt"), { recursive: true });
		writeFileSync(join(project, ".volt", "settings.json"), `${JSON.stringify({ images: { blockImages: true } })}\n`);
		const tui = await harness.connect("tui");
		const trusted = await openTui(tui, {
			target: { kind: "new" },
			spawn: spawnOptions(project, {
				config: {
					trust: true,
					extensions: [SPAWN_FLAG_EXTENSION_PATH],
					flags: { "spawn-flag": "from the TUI" },
				},
			}),
			clientKey: "tui-1",
		});
		await vi.waitFor(() => expect(spawnFlagRecord().get(trusted.opened.sessionId)).toBe("from the TUI"), {
			timeout: 10_000,
		});
		expect(await trusted.client.query("settings")).toMatchObject({ blockImages: true });

		// Without the TUI's trust, the project's settings are not read (nothing saved trusts it).
		const untrusted = await openTui(tui, {
			target: { kind: "new" },
			spawn: spawnOptions(project, { config: { trust: false } }),
			clientKey: "tui-1",
		});
		expect(await untrusted.client.query("settings")).toMatchObject({ blockImages: false });
		expect(spawnFlagRecord().has(untrusted.opened.sessionId)).toBe(false);
	}, 60_000);

	it("reloads the settings and credentials other processes write (D12)", async () => {
		// Anthropic's models are available only once a login reaches auth.json.
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
		const harness = await startHarness();
		const tui = await harness.connect("tui");
		const { client } = await openTui(tui, {
			target: { kind: "new" },
			spawn: spawnOptions(harness.workspacePath),
			clientKey: "tui-1",
		});
		const catalogs = changedCatalogs(client);
		expect(await client.query("settings")).toMatchObject({ blockImages: false });

		const settingsPath = join(harness.agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		writeFileSync(settingsPath, `${JSON.stringify({ ...settings, images: { blockImages: true } })}\n`);
		await vi.waitFor(() => expect(catalogs).toContain("settings"), { timeout: 10_000 });
		expect(await client.query("settings")).toMatchObject({ blockImages: true });

		// A login in another process.
		AuthStorage.create(join(harness.agentDir, "auth.json")).set("anthropic", { type: "api_key", key: "sk-test" });
		await vi.waitFor(() => expect(catalogs).toContain("models"), { timeout: 10_000 });
		// The reloaded catalog keeps the extension's provider: the conversation still runs.
		harness.faux.setResponses([fauxAssistantMessage("after the login")]);
		await client.promptAndWait("still there?");
		expect(assistantTexts(client)).toContain("after the login");
	}, 60_000);

	it("does not reload settings a project wrote once it holds what needs trust it was never given", async () => {
		const harness = await startHarness();
		const project = join(harness.workspacePath, "plain");
		mkdirSync(project);
		const tui = await harness.connect("tui");
		// Nothing in the project needs trust as it opens: its settings would be read.
		const { client } = await openTui(tui, {
			target: { kind: "new" },
			spawn: spawnOptions(project),
			clientKey: "tui-1",
		});
		const catalogs = changedCatalogs(client);
		mkdirSync(join(project, ".volt"));
		writeFileSync(join(project, ".volt", "settings.json"), `${JSON.stringify({ images: { blockImages: true } })}\n`);
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(catalogs).not.toContain("settings");
		expect(await client.query("settings")).toMatchObject({ blockImages: false });
	}, 60_000);

	it("asks before registering a home directory, or one containing the agent directory, and registers it shared or local (D17)", async () => {
		const harness = await startHarness();
		const tui = await harness.connect("tui");
		// The TUI's home directory: a fresh one, so nothing of the host's is registered.
		const home = realpathSync.native(mkdtempSync(join(tmpdir(), "volt-tui-home-")));
		cleanups.push(async () => rmSync(home, { recursive: true, force: true }));
		const request = (cwd: string): ConversationOpenRequest => ({
			target: { kind: "new" },
			spawn: spawnOptions(cwd, { env: { HOME: home } }),
			clientKey: "tui-1",
		});
		const workspaceOf = async (path: string) =>
			(await harness.status()).workspaces.find((workspace) => workspace.path === path);

		const refused = openDaemonConversation(tui, request(home));
		await expect(refused).rejects.toBeInstanceOf(WorkspaceConfirmationRequiredError);
		await expect(refused).rejects.toMatchObject({ directory: home, reason: "home" });
		expect(await workspaceOf(home)).toBeUndefined();
		expect((await harness.status()).workers).toEqual([]);

		// A project in the home directory is not sensitive: it registers as before.
		const project = join(home, "project");
		mkdirSync(project);
		const opened = await openDaemonConversation(tui, request(project));
		cleanups.push(() => opened.transport.close() as Promise<void>);
		expect(await workspaceOf(project)).toEqual({ name: "project", path: project });

		// Asked, the user shares the home directory.
		const shared = await openDaemonConversation(tui, { ...request(home), workspaceRegistration: "shared" });
		cleanups.push(() => shared.transport.close() as Promise<void>);
		expect(await workspaceOf(home)).toEqual({ name: basename(home), path: home });

		// The harness's root holds its agent directory: registered local to this host when the user keeps it.
		const root = realpathSync.native(join(harness.agentDir, ".."));
		await expect(openDaemonConversation(tui, request(root))).rejects.toMatchObject({
			directory: root,
			reason: "contains_agent_dir",
		});
		const local = await openDaemonConversation(tui, { ...request(root), workspaceRegistration: "local" });
		cleanups.push(() => local.transport.close() as Promise<void>);
		expect(local.opened.localOnly).toBe(true);
		expect(await workspaceOf(root)).toEqual({ name: local.opened.workspaceName, path: root, localOnly: true });
		expect(
			harness
				.audit()
				.filter((event) => event.type === "workspace_registered" && event.details?.source === "tui_open"),
		).toEqual([
			expect.objectContaining({ details: expect.objectContaining({ path: project, visibility: "shared" }) }),
			expect.objectContaining({ details: expect.objectContaining({ path: home, visibility: "shared" }) }),
			expect.objectContaining({ details: expect.objectContaining({ path: root, visibility: "local" }) }),
		]);
	}, 60_000);
});
