/**
 * The protocol's session surface (architecture rewrite Phase 6, slice 1):
 * tree navigation and labels, reload, JSONL import and export, the queue's
 * withdrawal, scoped aborts, session deletion and renaming, session listing
 * scopes, conversation info, resources, tools, the catalog fields, live
 * presence, work times, the stopping intents' lane bypass, the input source,
 * and the abort handler of a client's command. Local clients use all of it; a
 * remote profile is refused every local-only addition.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import {
	HOST_NOTICE_SOURCE,
	type HostFrame,
	type LiveItem,
	REMOTE_CAPABILITIES,
	type RemoteGrant,
} from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createLoopbackClient,
	type LoopbackClient,
	ProtocolClient,
	type ProtocolClientOptions,
	ProtocolRejectedError,
} from "../../src/client/protocol-client.ts";
import type { ExtensionAPI, InputSource } from "../../src/core/extensions/index.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { localProfile } from "../../src/core/protocol/profiles.ts";
import { serveConnection } from "../../src/core/protocol/server/connection.ts";
import { createIrohRpcTransport } from "../../src/core/protocol/transport/iroh-transport.ts";
import { createLoopbackRpcTransportPair } from "../../src/core/protocol/transport/loopback-transport.ts";
import { serveIrohRemoteConnection } from "../../src/core/remote/iroh/connection.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "../suite/host-harness.ts";
import { createIrohStreamPair } from "../utilities/iroh-stream-pair.ts";

const EXTENSION = "test-extension";

/** A turn response that streams nothing until the run is aborted. */
function heldResponse(started?: () => void) {
	return (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
		new Promise<AssistantMessage>((_resolve, reject) => {
			started?.();
			const signal = options?.signal;
			if (signal?.aborted) reject(new Error("aborted"));
			signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
}

/** A stored session of `cwd` in the harness's session directory, with one message and a name. */
async function storedSession(harness: HostHarness, cwd: string, name: string): Promise<string> {
	mkdirSync(cwd, { recursive: true });
	const manager = await SessionManager.create(cwd, join(harness.tempDir, "sessions"));
	try {
		await manager.logWriter.appendMessage({ role: "user", content: `about ${name}`, timestamp: Date.now() });
		await manager.logWriter.appendSessionInfo(name);
		return manager.getSessionId();
	} finally {
		await manager.closePersistence();
	}
}

async function rejection(promise: Promise<unknown>): Promise<ProtocolRejectedError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ProtocolRejectedError) return error;
		throw error;
	}
	throw new Error("Expected the intent to be rejected");
}

describe("the session surface on the local profile", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(
		options: HostHarnessOptions = {},
	): Promise<{ harness: HostHarness; conversation: HostedConversation }> {
		const harness = await createHostHarness(options);
		cleanups.push(() => harness.cleanup());
		return { harness, conversation: await harness.openStartup() };
	}

	async function connect(
		harness: HostHarness,
		conversation: HostedConversation,
		options: Parameters<typeof createLoopbackClient>[2] = {},
	): Promise<{ client: LoopbackClient; frames: HostFrame[] }> {
		const frames: HostFrame[] = [];
		const client = await createLoopbackClient(harness.host, conversation, options);
		client.onFrame((frame) => frames.push(frame));
		cleanups.push(() => client.stop());
		return { client, frames };
	}

	function liveItems(frames: readonly HostFrame[]): LiveItem[] {
		return frames.flatMap((frame) => (frame.type === "live" ? frame.items : []));
	}

	it("navigates the tree to a user message, handing back its text, and labels entries", async () => {
		const { harness, conversation } = await setup();
		const { client } = await connect(harness, conversation);
		await client.promptAndWait("first question");
		await client.promptAndWait("second question");
		const users = client.state.entries.filter((entry) => entry.type === "message" && entry.view?.role === "user");
		const first = users[0]!;

		const navigated = await client.intent(
			"navigate_tree",
			{ entryId: first.id },
			{ expectedOrdinal: client.state.ordinal },
		);
		expect(navigated.result).toEqual({ cancelled: false, editorText: "first question" });
		await vi.waitFor(() => expect(client.state.leafId).toBe(first.parentId));

		const assistant = client.state.entries.find(
			(entry) => entry.type === "message" && entry.view?.role === "assistant",
		)!;
		await client.intent("set_label", { entryId: assistant.id, label: "checkpoint" });
		await vi.waitFor(() => expect(client.state.labels.get(assistant.id)?.label).toBe("checkpoint"));
		await client.intent("set_label", { entryId: assistant.id, label: null });
		await vi.waitFor(() => expect(client.state.labels.has(assistant.id)).toBe(false));
		expect(await rejection(client.intent("set_label", { entryId: "no-such-entry", label: "x" }))).toMatchObject({
			reason: { code: "invalid_input" },
		});
	});

	it("exports the branch as JSONL and imports it as a new conversation, asking for a cwd when its own is gone", async () => {
		const { harness, conversation } = await setup();
		const { client } = await connect(harness, conversation);
		await client.promptAndWait("exported question");
		const exportPath = join(harness.tempDir, "exports", "session.jsonl");
		const exported = await client.intent("export_jsonl", { outputPath: exportPath });
		expect(exported.result).toEqual({ path: exportPath });
		expect(existsSync(exportPath)).toBe(true);

		expect(
			await rejection(client.intent("import_session", { path: join(harness.tempDir, "missing.jsonl") })),
		).toMatchObject({ reason: { code: "invalid_input" } });

		// A file whose cwd is gone: rejected unavailable, then imported with an override.
		const lines = readFileSync(exportPath, "utf8").split("\n");
		const header = JSON.parse(lines[0]!) as { cwd: string };
		header.cwd = join(harness.tempDir, "gone");
		const movedPath = join(harness.tempDir, "exports", "moved.jsonl");
		writeFileSync(movedPath, [JSON.stringify(header), ...lines.slice(1)].join("\n"));
		expect(
			await rejection(
				client.intent("import_session", { path: movedPath }, { expectedOrdinal: client.state.ordinal }),
			),
		).toMatchObject({ reason: { code: "unavailable" } });

		const override = join(harness.tempDir, "override");
		mkdirSync(override);
		const imported = await client.intent(
			"import_session",
			{ path: movedPath, cwdOverride: override },
			{ expectedOrdinal: client.state.ordinal },
		);
		expect(imported.conversation).toBeDefined();
		expect(imported.conversation).not.toBe(conversation.id);
		await vi.waitFor(() => expect(client.conversation).toBe(imported.conversation));
		await client.caughtUp();
		await vi.waitFor(() =>
			expect(
				client.state.entries.some((entry) => entry.type === "message" && entry.view?.text === "exported question"),
			).toBe(true),
		);
		expect(await client.query("conversation_info")).toMatchObject({ id: imported.conversation, cwd: override });
	});

	it("withdraws queued input, and aborts with the queue taken back instead of delivered", async () => {
		const { harness, conversation } = await setup();
		const started = Promise.withResolvers<void>();
		harness.faux.setResponses([heldResponse(() => started.resolve()), heldResponse()]);
		const { client } = await connect(harness, conversation);
		await client.prompt("long run");
		await started.promise;
		await client.intent("follow_up", { message: "queued one" });
		await vi.waitFor(() => expect(client.state.queue.map((input) => input.message)).toEqual(["queued one"]));

		const withdrawn = await client.intent("withdraw_queued");
		expect(withdrawn.result).toEqual({ messages: [{ text: "queued one" }] });
		await vi.waitFor(() => expect(client.state.queue).toEqual([]));
		expect(conversation.session.isBusy).toBe(true);

		await client.intent("follow_up", { message: "queued two" });
		await vi.waitFor(() => expect(client.state.queue).toHaveLength(1));
		const aborted = await client.intent("abort", { withdrawQueued: true }, { expectedOrdinal: client.state.ordinal });
		expect(aborted.result).toEqual({ messages: [{ text: "queued two" }] });
		await client.waitForIdle(10_000);
		expect(client.state.entries.some((entry) => entry.type === "message" && entry.view?.text === "queued two")).toBe(
			false,
		);
	});

	it("stops a compaction with abort{operation} while the compact intent holds the lane, with a host notice", async () => {
		const { harness, conversation } = await setup({ responses: ["one", "two"] });
		const { client, frames } = await connect(harness, conversation);
		await client.promptAndWait("first");
		await client.promptAndWait("second");
		// The summary streams like a turn (the native strategy): it waits until the compaction stops.
		const summarizing = Promise.withResolvers<void>();
		harness.faux.setResponses([heldResponse(() => summarizing.resolve())]);

		const compacting = client.intent("compact", {}, { expectedOrdinal: client.state.ordinal });
		void compacting.catch(() => undefined);
		await summarizing.promise;
		// The stop runs beside the lane the compaction holds; without the bypass it would wait for it.
		await client.intent("abort", { operation: "compaction" }, { expectedOrdinal: client.state.ordinal });
		await expect(compacting).rejects.toBeInstanceOf(ProtocolRejectedError);
		await vi.waitFor(() =>
			expect(liveItems(frames)).toContainEqual({
				type: "notice",
				level: "error",
				message: "Compaction cancelled",
				source: HOST_NOTICE_SOURCE,
			}),
		);
	});

	it("deletes a stored session of the workspace, refusing open ones and other workspaces'", async () => {
		const { harness, conversation } = await setup();
		const { client } = await connect(harness, conversation);
		await client.promptAndWait("to be deleted");
		const deletedId = conversation.id;
		const moved = await client.intent("new_session", {}, { expectedOrdinal: client.state.ordinal });
		await vi.waitFor(() => expect(client.conversation).toBe(moved.conversation));
		await client.caughtUp();

		expect(await rejection(client.intent("delete_session", { sessionId: moved.conversation! }))).toMatchObject({
			reason: { code: "unavailable" },
		});
		const elsewhere = join(harness.tempDir, "elsewhere");
		const otherId = await storedSession(harness, elsewhere, "other workspace");
		expect(await rejection(client.intent("delete_session", { sessionId: otherId }))).toMatchObject({
			reason: { code: "invalid_input" },
		});

		const listed = await client.query("sessions");
		expect(listed.sessions.map((session) => session.sessionId)).toContain(deletedId);
		const deleted = await client.intent("delete_session", { sessionId: deletedId });
		expect(deleted.result).toEqual({ trashed: expect.any(Boolean) });
		const after = await client.query("sessions");
		expect(after.sessions.map((session) => session.sessionId)).not.toContain(deletedId);
		const all = await client.query("sessions", { scope: "all" });
		expect(all.sessions.map((session) => session.sessionId)).toContain(otherId);
		expect(all.sessions.find((session) => session.sessionId === otherId)).toMatchObject({
			cwd: elsewhere,
			sessionName: "other workspace",
		});
	});

	it("lists sessions by scope and search, with each one's cwd and parent, and renames another session", async () => {
		const { harness, conversation } = await setup();
		const { client } = await connect(harness, conversation);
		await client.promptAndWait("searchable needle");
		const parentId = conversation.id;
		const otherId = await storedSession(harness, join(harness.tempDir, "elsewhere"), "faraway");

		const workspace = await client.query("sessions");
		expect(workspace.sessions.map((session) => session.sessionId)).toEqual([parentId]);
		expect(workspace.sessions[0]).toMatchObject({ cwd: conversation.cwd, current: true });
		const all = await client.query("sessions", { scope: "all" });
		expect(all.sessions.map((session) => session.sessionId).sort()).toEqual([parentId, otherId].sort());
		const searched = await client.query("sessions", { search: "needle" });
		expect(searched.sessions.map((session) => session.sessionId)).toEqual([parentId]);

		await client.intent("set_session_name", { name: "renamed far", sessionId: otherId });
		const renamed = await client.query("sessions", { scope: "all" });
		expect(renamed.sessions.find((session) => session.sessionId === otherId)?.sessionName).toBe("renamed far");

		const child = await client.intent(
			"new_session",
			{ parentSessionId: parentId },
			{ expectedOrdinal: client.state.ordinal },
		);
		await vi.waitFor(() => expect(client.conversation).toBe(child.conversation));
		expect(await client.query("conversation_info")).toMatchObject({
			id: child.conversation,
			parentSessionId: parentId,
		});
	});

	it("starts a new session in another directory, validating it, and switches to a session whose cwd is gone with an override", async () => {
		const { harness, conversation } = await setup();
		const { client } = await connect(harness, conversation);
		const worktree = join(harness.tempDir, "worktree");
		mkdirSync(worktree);
		expect(
			await rejection(
				client.intent(
					"new_session",
					{ cwd: join(harness.tempDir, "missing") },
					{ expectedOrdinal: client.state.ordinal },
				),
			),
		).toMatchObject({ reason: { code: "invalid_input" } });
		expect(
			await rejection(
				client.intent("new_session", { cwd: worktree, baseRef: "--output=/tmp/x" }, { expectedOrdinal: 0 }),
			),
		).toMatchObject({ reason: { code: "invalid_input" } });

		const moved = await client.intent(
			"new_session",
			{ cwd: worktree, workspaceName: "volt", baseRef: "origin/main" },
			{ expectedOrdinal: client.state.ordinal },
		);
		await vi.waitFor(() => expect(client.conversation).toBe(moved.conversation));
		expect(await client.query("conversation_info")).toMatchObject({ id: moved.conversation, cwd: worktree });

		const gone = join(harness.tempDir, "gone");
		const storedId = await storedSession(harness, gone, "stranded");
		rmSync(gone, { recursive: true, force: true });

		expect(
			await rejection(
				client.intent("switch_session", { sessionId: storedId }, { expectedOrdinal: client.state.ordinal }),
			),
		).toMatchObject({ reason: { code: "unavailable" } });
		const switched = await client.intent(
			"switch_session",
			{ sessionId: storedId, cwdOverride: worktree },
			{ expectedOrdinal: client.state.ordinal },
		);
		expect(switched.conversation).toBe(storedId);
		await vi.waitFor(() => expect(client.conversation).toBe(storedId));
		expect(await client.query("conversation_info")).toMatchObject({ id: storedId, cwd: worktree });
	});

	it("reloads while idle, refreshing the catalogs, and refuses a reload while busy", async () => {
		const { harness, conversation } = await setup();
		const started = Promise.withResolvers<void>();
		const { client, frames } = await connect(harness, conversation);
		await client.intent("reload");
		await vi.waitFor(() =>
			expect(frames.filter((frame) => frame.type === "changed").map((frame) => frame.catalog)).toEqual(
				expect.arrayContaining(["intents", "extensions", "resources"]),
			),
		);

		harness.faux.setResponses([heldResponse(() => started.resolve())]);
		await client.prompt("busy");
		await started.promise;
		expect(await rejection(client.intent("reload"))).toMatchObject({ reason: { code: "unavailable" } });
		await client.intent("abort", {}, { expectedOrdinal: client.state.ordinal });
	});

	it("tells where the log lives, what the conversation loaded, and its tools", async () => {
		const { harness, conversation } = await setup();
		const { client } = await connect(harness, conversation);
		const info = await client.query("conversation_info");
		expect(info).toEqual({
			id: conversation.id,
			cwd: conversation.cwd,
			// A project without trust-requiring resources is trusted.
			projectTrusted: true,
			sessionDir: join(harness.tempDir, "sessions"),
			sessionFile: join(harness.tempDir, "sessions", "sessions.sqlite"),
			persisted: true,
			defaultSessionDir: false,
		});

		const resources = await client.query("resources");
		expect(resources.extensions.map((extension) => extension.id)).toContain(EXTENSION);
		expect(resources.skills).toEqual([]);
		expect(resources.notices).toEqual([]);

		const tools = await client.query("tools");
		const read = tools.tools.find((tool) => tool.name === "read");
		expect(read).toMatchObject({ source: "builtin", active: true });
		expect(tools.tools.every((tool) => typeof tool.description === "string")).toBe(true);
	});

	it("lists extension shortcuts and completion triggers with the intents, and models with their auth and scope", async () => {
		const { harness, conversation } = await setup({
			extension: (volt: ExtensionAPI) => {
				volt.registerIntent("ship", { label: "Ship", handler: () => {} });
				volt.registerShortcut("ctrl+shift+s", { intent: "ship", description: "Ship it" });
				volt.registerCompletionProvider("tickets", { trigger: "#", complete: () => [] });
			},
		});
		const { client } = await connect(harness, conversation);
		const catalog = await client.query("intents");
		expect(catalog.shortcuts).toEqual([
			{ key: "ctrl+shift+s", intent: `extension.intent.${EXTENSION}.ship`, description: "Ship it" },
		]);
		expect(catalog.completionTriggers).toEqual(["#"]);

		const model = harness.faux.getModel();
		conversation.session.setScopedModels([{ model, thinkingLevel: "high" }]);
		const models = await client.query("models");
		expect(models.models.find((entry) => entry.id === model.id)).toMatchObject({ auth: "api_key" });
		expect(models.cycleScope).toEqual([{ provider: model.provider, modelId: model.id, thinkingLevel: "high" }]);

		const extensions = await client.query("extensions");
		expect(extensions.extensions.find((extension) => extension.id === EXTENSION)?.fingerprint).toEqual(
			expect.any(String),
		);
	});

	it("records when work started and finished, and whether its kind opens it", async () => {
		const { harness, conversation } = await setup();
		const { client } = await connect(harness, conversation);
		conversation.work.register({
			kind: "ext:test/run",
			delivery: "none",
			cancellable: true,
			maxActive: 4,
			title: () => "Test work",
			open: async () => ({ cancelled: true }),
		});
		const release = Promise.withResolvers<void>();
		const record = await conversation.work.start("ext:test/run", {}, async () => {
			await release.promise;
			return { outcome: "completed" };
		});
		await vi.waitFor(() => expect(client.state.work.get(record.workId)).toBeDefined());
		const started = client.state.work.get(record.workId)!;
		expect(started).toMatchObject({ opens: true, startedAt: expect.any(String) });
		expect(started.finishedAt).toBeUndefined();
		release.resolve();
		await vi.waitFor(() => expect(client.state.work.get(record.workId)?.outcome).toBe("completed"));
		expect(client.state.work.get(record.workId)?.finishedAt).toEqual(expect.any(String));
	});

	it("raises the input event with the connection's input source", async () => {
		const sources: InputSource[] = [];
		const { harness, conversation } = await setup({
			extension: (volt: ExtensionAPI) => {
				volt.on("input", (event) => {
					sources.push(event.source);
				});
			},
		});
		const pair = createLoopbackRpcTransportPair();
		const connection = serveConnection(pair.server, localProfile, {
			host: harness.host,
			conversation,
			anchor: false,
			inputSource: "interactive",
		});
		const client = new ProtocolClient();
		cleanups.push(async () => {
			await client.stop();
			await connection.closed.catch(() => undefined);
		});
		await client.connect(pair.client);
		await connection.ready;
		await client.promptAndWait("from the terminal");
		const { client: rpc } = await connect(harness, conversation, { anchor: false });
		await rpc.promptAndWait("from rpc");
		expect(sources).toEqual(["interactive", "rpc"]);
	});

	it("returns the queue to the editor of the client whose command called ctx.abort(), before its draft", async () => {
		const { harness, conversation } = await setup({
			extension: (volt: ExtensionAPI) => {
				volt.registerCommand("stop", {
					description: "Stop the run",
					handler: async (_args, ctx) => {
						ctx.abort();
					},
				});
			},
		});
		const started = Promise.withResolvers<void>();
		harness.faux.setResponses([heldResponse(() => started.resolve())]);
		const answerDraft: ProtocolClientOptions["onFrame"] = (frame, self) => {
			if (frame.type !== "live") return;
			for (const item of frame.items) {
				if (
					item.type === "set" &&
					item.value.kind === "host_request" &&
					item.value.request.kind === "editor_text"
				) {
					self.answer(item.value.requestId, { value: "my draft" });
				}
			}
		};
		const { client, frames } = await connect(harness, conversation, {
			hostRequests: ["editor_text"],
			onFrame: answerDraft,
		});
		const { frames: otherFrames } = await connect(harness, conversation, { anchor: false });
		await client.prompt("long run");
		await started.promise;
		await client.intent("follow_up", { message: "queued input" });
		await vi.waitFor(() => expect(client.state.queue).toHaveLength(1));

		await client.intent(`extension.command.${EXTENSION}.stop`, {});
		await vi.waitFor(() =>
			expect(liveItems(frames)).toContainEqual({
				type: "directive",
				directive: "set_editor_text",
				text: "queued input\n\nmy draft",
			}),
		);
		await client.waitForIdle(10_000);
		expect(liveItems(otherFrames).some((item) => item.type === "directive")).toBe(false);
		expect(client.state.queue).toEqual([]);
	});

	it("pastes the queue at the cursor when the client reports no draft", async () => {
		const { harness, conversation } = await setup({
			extension: (volt: ExtensionAPI) => {
				volt.registerCommand("stop", {
					description: "Stop the run",
					handler: async (_args, ctx) => {
						ctx.abort();
					},
				});
			},
		});
		const started = Promise.withResolvers<void>();
		harness.faux.setResponses([heldResponse(() => started.resolve())]);
		const declineDraft: ProtocolClientOptions["onFrame"] = (frame, self) => {
			if (frame.type !== "live") return;
			for (const item of frame.items) {
				if (
					item.type === "set" &&
					item.value.kind === "host_request" &&
					item.value.request.kind === "editor_text"
				) {
					self.answer(item.value.requestId, { cancelled: true });
				}
			}
		};
		const { client, frames } = await connect(harness, conversation, {
			hostRequests: ["editor_text"],
			onFrame: declineDraft,
		});
		await client.prompt("long run");
		await started.promise;
		await client.intent("follow_up", { message: "queued input" });
		await vi.waitFor(() => expect(client.state.queue).toHaveLength(1));
		await client.intent(`extension.command.${EXTENSION}.stop`, {});
		await vi.waitFor(() =>
			expect(liveItems(frames)).toContainEqual({
				type: "directive",
				directive: "insert_editor_text",
				text: "queued input",
			}),
		);
		expect(liveItems(frames).some((item) => item.type === "directive" && item.directive === "set_editor_text")).toBe(
			false,
		);
	});

	it("leaves the queue in place when a client without an editor runs a command that calls ctx.abort()", async () => {
		const { harness, conversation } = await setup({
			extension: (volt: ExtensionAPI) => {
				volt.registerCommand("stop", {
					description: "Stop the run",
					handler: async (_args, ctx) => {
						ctx.abort();
					},
				});
			},
		});
		const started = Promise.withResolvers<void>();
		harness.faux.setResponses([heldResponse(() => started.resolve())]);
		const { client, frames } = await connect(harness, conversation);
		await client.prompt("long run");
		await started.promise;
		await client.intent("follow_up", { message: "kept input" });
		await vi.waitFor(() => expect(client.state.queue).toHaveLength(1));

		await client.intent(`extension.command.${EXTENSION}.stop`, {});
		await vi.waitFor(() => expect(client.phase?.busy).toBe(false));
		expect(client.state.queue.map((input) => input.message)).toEqual(["kept input"]);
		expect(liveItems(frames).some((item) => item.type === "directive")).toBe(false);
	});

	it("counts the paired devices attached to the conversation in its live presence", async () => {
		const { harness, conversation } = await setup({ whenUnattached: "keep" });
		const { client } = await connect(harness, conversation);
		const pair = createIrohStreamPair();
		const phone = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
			redaction: { workspacePath: conversation.cwd },
			redirect: {},
		});
		const transport = createIrohRpcTransport({ stream: pair.phone });
		transport.onLine(() => {});
		cleanups.push(async () => {
			await phone.close().catch(() => undefined);
			await Promise.resolve(transport.close()).catch(() => undefined);
		});
		transport.write({
			type: "hello",
			protocol: 1,
			client: { name: "phone", version: "1" },
			accepts: { hostRequests: [] },
		});
		await phone.ready;
		await vi.waitFor(() => expect(client.live.values.get("presence")).toEqual({ kind: "presence", remote: 1 }));
		await phone.close();
		await vi.waitFor(() => expect(client.live.values.get("presence")).toEqual({ kind: "presence", remote: 0 }));
	});
});

describe("the session surface on the remote profile", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	const ALL: RemoteGrant = { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] };

	async function phoneOn(harness: HostHarness, conversation: HostedConversation) {
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: ALL,
			redaction: { workspacePath: conversation.cwd },
			redirect: {},
		});
		const transport = createIrohRpcTransport({ stream: pair.phone });
		const frames: HostFrame[] = [];
		transport.onLine((line) => {
			frames.push(JSON.parse(line) as HostFrame);
		});
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await Promise.resolve(transport.close()).catch(() => undefined);
		});
		const send = (frame: object): void => void transport.write(frame);
		send({ type: "hello", protocol: 1, client: { name: "phone", version: "1" }, accepts: { hostRequests: [] } });
		await vi.waitFor(() => expect(frames[0]).toMatchObject({ type: "welcome", profile: "remote" }));
		send({ type: "subscribe", subscriptionId: "s1", conversation: conversation.id, after: "snapshot" });
		await vi.waitFor(() => expect(frames.some((frame) => frame.type === "live" && frame.reset === true)).toBe(true));
		const position = (): number => {
			let ordinal = 0;
			for (const frame of frames) {
				if (frame.type === "snapshot") ordinal = frame.ordinal;
				else if (frame.type === "entry" || frame.type === "head") {
					ordinal = frame.type === "entry" ? frame.entry.ordinal : frame.ordinal;
				}
			}
			return ordinal;
		};
		const answer = async (id: string): Promise<HostFrame> => {
			await vi.waitFor(() =>
				expect(
					frames.some(
						(frame) =>
							((frame.type === "accepted" || frame.type === "rejected") && frame.intentId === id) ||
							((frame.type === "result" || frame.type === "query_error") && frame.queryId === id),
					),
				).toBe(true),
			);
			return frames.find(
				(frame) =>
					((frame.type === "accepted" || frame.type === "rejected") && frame.intentId === id) ||
					((frame.type === "result" || frame.type === "query_error") && frame.queryId === id),
			)!;
		};
		return { frames, send, position, answer };
	}

	it("refuses every local-only intent, field, and query, and strips local-only result fields", async () => {
		const harness = await createHostHarness({ whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const device = await phoneOn(harness, conversation);
		// A reload changes catalogs a phone reads, but not the resources only local clients read.
		await conversation.session.reload();
		await vi.waitFor(() =>
			expect(device.frames.some((frame) => frame.type === "changed" && frame.catalog === "extensions")).toBe(true),
		);
		expect(device.frames.some((frame) => frame.type === "changed" && frame.catalog === "resources")).toBe(false);

		const refused: Array<[string, object, boolean]> = [
			["withdraw_queued", {}, false],
			["navigate_tree", { entryId: "e1" }, true],
			["set_label", { entryId: "e1", label: "x" }, false],
			["reload", {}, false],
			["import_session", { path: "/tmp/x.jsonl" }, true],
			["export_jsonl", {}, false],
			["delete_session", { sessionId: conversation.id }, false],
			["abort", { withdrawQueued: true }, true],
			["new_session", { cwd: conversation.cwd }, true],
			["switch_session", { sessionId: conversation.id, cwdOverride: conversation.cwd }, true],
		];
		for (const [index, [type, input, fenced]] of refused.entries()) {
			const intentId = `r-${index}`;
			device.send({ type, intentId, input, ...(fenced ? { expectedOrdinal: device.position() } : {}) });
			expect(await device.answer(intentId), type).toMatchObject({
				type: "rejected",
				reason: { code: "not_allowed" },
			});
		}
		device.send({
			type: "abort",
			intentId: "stop",
			expectedOrdinal: device.position(),
			input: { operation: "compaction" },
		});
		expect(await device.answer("stop")).toMatchObject({ type: "accepted" });

		for (const [index, query] of ["conversation_info", "resources", "tools"].entries()) {
			device.send({ type: "query", queryId: `q-${index}`, query });
			expect(await device.answer(`q-${index}`), query).toMatchObject({
				type: "query_error",
				reason: { code: "not_allowed" },
			});
		}
		device.send({ type: "query", queryId: "scope", query: "sessions", params: { scope: "all" } });
		expect(await device.answer("scope")).toMatchObject({ type: "query_error", reason: { code: "not_allowed" } });

		device.send({ type: "query", queryId: "list", query: "sessions" });
		const listed = await device.answer("list");
		if (listed.type !== "result") throw new Error("Expected the sessions result");
		const sessions = (listed.data as { sessions: Array<Record<string, unknown>> }).sessions;
		expect(sessions.length).toBeGreaterThan(0);
		for (const session of sessions) {
			expect(session).not.toHaveProperty("cwd");
			expect(session).not.toHaveProperty("parentSessionId");
		}
		device.send({ type: "query", queryId: "ext", query: "extensions" });
		const extensions = await device.answer("ext");
		if (extensions.type !== "result") throw new Error("Expected the extensions result");
		for (const extension of (extensions.data as { extensions: Array<Record<string, unknown>> }).extensions) {
			expect(extension).not.toHaveProperty("fingerprint");
		}
		expect(JSON.stringify(device.frames)).not.toContain(harness.tempDir);
		// Who else is attached is for local clients only.
		expect(
			device.frames.some(
				(frame) => frame.type === "live" && frame.items.some((item) => "key" in item && item.key === "presence"),
			),
		).toBe(false);
		expect(conversation.liveState.get("presence")).toEqual({ kind: "presence", remote: 1 });
	});

	it("lists only remote-safe intents' shortcuts and remote completion triggers", async () => {
		const harness = await createHostHarness({
			whenUnattached: "keep",
			extension: (volt: ExtensionAPI) => {
				volt.registerIntent("ship", { label: "Ship", handler: () => {} });
				volt.registerShortcut("ctrl+shift+s", { intent: "ship" });
				volt.registerCompletionProvider("local-only", { trigger: "#", complete: () => [] });
				volt.registerCompletionProvider("shared", { trigger: "@@", remote: true, complete: () => [] });
			},
		});
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const device = await phoneOn(harness, conversation);
		device.send({ type: "query", queryId: "intents", query: "intents" });
		const answered = await device.answer("intents");
		if (answered.type !== "result") throw new Error("Expected the intents result");
		const catalog = answered.data as { shortcuts: unknown[]; completionTriggers: string[] };
		// Extension intents are not remote-safe: no shortcut invokes one remotely.
		expect(catalog.shortcuts).toEqual([]);
		expect(catalog.completionTriggers).toEqual(["@@"]);
	});
});
