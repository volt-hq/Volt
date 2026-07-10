import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import { getIrohRemoteRpcFilterResult } from "../src/core/remote/iroh/rpc-command-filter.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import type { IrohRemoteWorktreeRpcBackend } from "../src/core/remote/iroh/worktree-rpc.ts";
import { getDefaultSessionDir, type SessionEntry } from "../src/core/session-manager.ts";
import {
	type ConversationCommandContext,
	type ConversationCommandRuntime,
	handleIntegratedConversationRpcCommand,
	INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES,
	LEASE_DRAINING_RETRY_AFTER_MS,
	REMOTE_TOOL_OUTPUT_MAX_SCALARS,
	type RemoteSessionRuntimeState,
	TURN_INITIATING_RPC_TYPES,
} from "../src/daemon/conversation-commands.ts";

function createAuthorization(options: { workspacePath?: string } = {}): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "n-phone",
			label: "phone",
			allowedWorkspaces: ["ws"],
			allowedTools: "read",
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "ws", path: options.workspacePath ?? "/tmp/ws" },
		workspaceNames: ["ws"],
		workspaces: [{ name: "ws", status: "available" }],
	};
}

function createRuntime(sessionId = "s-1"): ConversationCommandRuntime {
	return {
		session: {
			sessionId,
			sessionManager: { getBranch: () => [] },
		},
		listSessions: async () => [],
	};
}

function createContext(
	options: {
		isDraining?: () => boolean;
		stateManager?: IrohRemoteHostStateManager;
		onWorkspaceUnregistered?: (workspaceName: string) => Promise<void>;
		webSearchKey?: ConversationCommandContext["webSearchKey"];
		createWorktreeBackend?: ConversationCommandContext["createWorktreeBackend"];
		listRuntimeStates?: ConversationCommandContext["listRuntimeStates"];
		agentDir?: string;
	} = {},
): ConversationCommandContext {
	return {
		stateManager: options.stateManager ?? new IrohRemoteHostStateManager(),
		sessionListCursors: new Map(),
		sessionListCursorTtlMs: 60_000,
		...(options.isDraining === undefined ? {} : { isDraining: options.isDraining }),
		...(options.onWorkspaceUnregistered === undefined
			? {}
			: { onWorkspaceUnregistered: options.onWorkspaceUnregistered }),
		...(options.webSearchKey === undefined ? {} : { webSearchKey: options.webSearchKey }),
		...(options.createWorktreeBackend === undefined ? {} : { createWorktreeBackend: options.createWorktreeBackend }),
		...(options.listRuntimeStates === undefined ? {} : { listRuntimeStates: options.listRuntimeStates }),
		...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
	};
}

function createFakeWebSearchKeyService(): {
	service: NonNullable<ConversationCommandContext["webSearchKey"]>;
	calls: Array<string | null>;
} {
	const calls: Array<string | null> = [];
	let stored: string | null = null;
	return {
		service: {
			set(apiKey: string | null) {
				calls.push(apiKey);
				stored = apiKey;
			},
			get configured() {
				return stored !== null;
			},
		},
		calls,
	};
}

describe("handleIntegratedConversationRpcCommand", () => {
	it("rejects the unsupported command set", async () => {
		for (const type of INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES) {
			const response = (await handleIntegratedConversationRpcCommand(
				{ id: "1", type },
				createAuthorization(),
				createContext(),
				createRuntime(),
			)) as Record<string, unknown>;
			expect(response).toMatchObject({
				id: "1",
				type: "response",
				command: type,
				success: false,
				error: "unsupported_remote_command",
			});
		}
	});

	it("does not intercept abort — the rpc mode stops the turn with the stream open", async () => {
		const response = await handleIntegratedConversationRpcCommand(
			{ id: "1", type: "abort" },
			createAuthorization(),
			createContext({ isDraining: () => true }),
			createRuntime(),
		);
		expect(response).toBeUndefined();
	});

	it("rejects turn-initiating commands while the lease is draining", async () => {
		for (const type of TURN_INITIATING_RPC_TYPES) {
			const response = (await handleIntegratedConversationRpcCommand(
				{ id: "42", type, message: "hi" },
				createAuthorization(),
				createContext({ isDraining: () => true }),
				createRuntime(),
			)) as Record<string, unknown>;
			expect(response).toEqual({
				id: "42",
				type: "response",
				command: type,
				success: false,
				error: {
					code: "lease_draining",
					message: "Handing off to the desktop TUI; retry shortly.",
					retryAfterMs: LEASE_DRAINING_RETRY_AFTER_MS,
				},
			});
		}
	});

	it("lets read-only commands through while draining", async () => {
		const transcript = (await handleIntegratedConversationRpcCommand(
			{ id: "2", type: "get_transcript" },
			createAuthorization(),
			createContext({ isDraining: () => true }),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(transcript).toMatchObject({ command: "get_transcript", success: true });

		// get_state is handled by the rpc mode itself: pass-through.
		const state = await handleIntegratedConversationRpcCommand(
			{ id: "3", type: "get_state" },
			createAuthorization(),
			createContext({ isDraining: () => true }),
			createRuntime(),
		);
		expect(state).toBeUndefined();
	});

	it("does not reject prompts when the lease is not draining", async () => {
		const response = await handleIntegratedConversationRpcCommand(
			{ id: "4", type: "prompt", message: "hi" },
			createAuthorization(),
			createContext({ isDraining: () => false }),
			createRuntime(),
		);
		expect(response).toBeUndefined();
	});

	it("rejects commands scoped to the wrong workspace or session", async () => {
		const wrongWorkspace = (await handleIntegratedConversationRpcCommand(
			{ id: "5", type: "get_transcript", workspaceName: "other" },
			createAuthorization(),
			createContext(),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(wrongWorkspace).toMatchObject({ success: false, error: "session_mismatch" });

		const wrongSession = (await handleIntegratedConversationRpcCommand(
			{ id: "6", type: "get_transcript", sessionId: "other" },
			createAuthorization(),
			createContext(),
			createRuntime("s-1"),
		)) as Record<string, unknown>;
		expect(wrongSession).toMatchObject({ success: false, error: "session_mismatch" });
	});

	it("projects sanitized, truncated tool output onto transcript tool items", async () => {
		const branch = [
			{
				type: "message",
				id: "e-call",
				timestamp: "2026-07-06T00:00:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "/tmp/ws/README.md" } }],
				},
			},
			{
				type: "message",
				id: "e-result",
				timestamp: "2026-07-06T00:00:01.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tc-1",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: `README at /tmp/ws/README.md\n${"x".repeat(9_000)}` }],
				},
			},
		] as unknown as SessionEntry[];
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-1", sessionManager: { getBranch: () => branch } },
			listSessions: async () => [],
		};

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "11", type: "get_transcript" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as { success: boolean; data: { items: Array<Record<string, unknown>> } };
		expect(response.success).toBe(true);
		const tool = response.data.items.find((item) => item.role === "tool");
		expect(tool).toBeDefined();
		const output = tool?.output as string;
		expect(output).toContain("README at /workspace/README.md");
		expect(output).not.toContain("/tmp/ws");
		expect(Array.from(output)).toHaveLength(REMOTE_TOOL_OUTPUT_MAX_SCALARS);
		expect(tool?.outputTruncated).toBe(true);
	});

	it("advertises imageCount on tool transcript items with image results", async () => {
		const branch = [
			{
				type: "message",
				id: "e-call",
				timestamp: "2026-07-06T00:00:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "logo.png" } }],
				},
			},
			{
				type: "message",
				id: "e-image-result",
				timestamp: "2026-07-06T00:00:01.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tc-1",
					toolName: "read",
					isError: false,
					content: [
						{ type: "text", text: "Read image file [image/png]" },
						{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
					],
				},
			},
			{
				type: "message",
				id: "e-text-result",
				timestamp: "2026-07-06T00:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tc-1",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "plain text" }],
				},
			},
		] as unknown as SessionEntry[];
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-1", sessionManager: { getBranch: () => branch } },
			listSessions: async () => [],
		};

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "21", type: "get_transcript" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as { success: boolean; data: { items: Array<Record<string, unknown>> } };
		expect(response.success).toBe(true);
		const toolItems = response.data.items.filter((item) => item.role === "tool");
		expect(toolItems[0]).toEqual(
			expect.objectContaining({ entryId: "e-image-result", role: "tool", toolName: "read", imageCount: 1 }),
		);
		expect(toolItems[1]).not.toHaveProperty("imageCount");
		// The transcript page itself stays text-only; images are fetched per entry.
		expect(JSON.stringify(response)).not.toContain("aW1hZ2U=");
	});

	it("serves get_message_images for a tool result entry", async () => {
		const branch = [
			{
				type: "message",
				id: "e-image-result",
				timestamp: "2026-07-06T00:00:00.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tc-1",
					toolName: "read",
					isError: false,
					content: [
						{ type: "text", text: "Read image file [image/png]" },
						{ type: "image", data: "dG9vbA==", mimeType: "image/png" },
					],
				},
			},
		] as unknown as SessionEntry[];
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-1", sessionManager: { getBranch: () => branch } },
			listSessions: async () => [],
		};

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "22", type: "get_message_images", entryId: "e-image-result" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as { success: boolean; data: Record<string, unknown> };
		expect(response.success).toBe(true);
		expect(response.data).toMatchObject({
			entryId: "e-image-result",
			totalImages: 1,
			images: [{ type: "image", data: "dG9vbA==", mimeType: "image/png", index: 0 }],
			nextImageIndex: null,
		});
	});

	it("advertises imageCount on user transcript items and keeps image-only user messages", async () => {
		const branch = [
			{
				type: "message",
				id: "e-images",
				timestamp: "2026-07-06T00:00:00.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "see screenshots" },
						{ type: "image", data: "Zmlyc3Q=", mimeType: "image/jpeg" },
						{ type: "image", data: "c2Vjb25k", mimeType: "image/png" },
					],
				},
			},
			{
				type: "message",
				id: "e-image-only",
				timestamp: "2026-07-06T00:00:01.000Z",
				message: {
					role: "user",
					content: [{ type: "image", data: "b25seQ==", mimeType: "image/jpeg" }],
				},
			},
		] as unknown as SessionEntry[];
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-1", sessionManager: { getBranch: () => branch } },
			listSessions: async () => [],
		};

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "20", type: "get_transcript" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as { success: boolean; data: { items: Array<Record<string, unknown>> } };
		expect(response.success).toBe(true);
		expect(response.data.items).toEqual([
			expect.objectContaining({ entryId: "e-images", role: "user", text: "see screenshots", imageCount: 2 }),
			expect.objectContaining({ entryId: "e-image-only", role: "user", text: "", imageCount: 1 }),
		]);
		// The transcript page itself stays text-only; images are fetched per entry.
		expect(JSON.stringify(response)).not.toContain("Zmlyc3Q=");
	});

	it("serves get_message_images for a user entry with workspace and session identity", async () => {
		const branch = [
			{
				type: "message",
				id: "e-images",
				timestamp: "2026-07-06T00:00:00.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "see screenshots" },
						{ type: "image", data: "Zmlyc3Q=", mimeType: "image/jpeg" },
						{ type: "image", data: "c2Vjb25k", mimeType: "image/png" },
					],
				},
			},
		] as unknown as SessionEntry[];
		const runtime: ConversationCommandRuntime = {
			session: { sessionId: "s-1", sessionManager: { getBranch: () => branch } },
			listSessions: async () => [],
		};

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "21", type: "get_message_images", entryId: "e-images" },
			createAuthorization(),
			createContext(),
			runtime,
		)) as Record<string, unknown>;
		expect(response).toMatchObject({
			id: "21",
			command: "get_message_images",
			success: true,
			data: {
				workspaceName: "ws",
				sessionId: "s-1",
				entryId: "e-images",
				totalImages: 2,
				images: [
					{ type: "image", data: "Zmlyc3Q=", mimeType: "image/jpeg", index: 0 },
					{ type: "image", data: "c2Vjb25k", mimeType: "image/png", index: 1 },
				],
				nextImageIndex: null,
			},
		});

		const paged = (await handleIntegratedConversationRpcCommand(
			{ id: "22", type: "get_message_images", entryId: "e-images", startImageIndex: 1 },
			createAuthorization(),
			createContext(),
			runtime,
		)) as { data: { images: Array<{ index: number }> } };
		expect(paged.data.images.map((image) => image.index)).toEqual([1]);
	});

	it("rejects get_message_images for unknown entries and invalid arguments", async () => {
		const unknownEntry = (await handleIntegratedConversationRpcCommand(
			{ id: "23", type: "get_message_images", entryId: "missing" },
			createAuthorization(),
			createContext(),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(unknownEntry).toMatchObject({ success: false, error: "unknown_entry" });

		const missingEntryId = (await handleIntegratedConversationRpcCommand(
			{ id: "24", type: "get_message_images" },
			createAuthorization(),
			createContext(),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(missingEntryId).toMatchObject({ success: false, error: "invalid_cursor" });

		const badIndex = (await handleIntegratedConversationRpcCommand(
			{ id: "25", type: "get_message_images", entryId: "e-1", startImageIndex: -2 },
			createAuthorization(),
			createContext(),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(badIndex).toMatchObject({ success: false, error: "invalid_request" });
	});

	it("joins worktree bindings onto list_sessions summaries (worktrees.v1)", async () => {
		const stateManager = new IrohRemoteHostStateManager();
		await stateManager.upsertWorkspace({ name: "ws", path: "/tmp/ws" });
		await stateManager.upsertWorktree({
			id: "fix-login",
			workspaceName: "ws",
			path: "/tmp/agent/worktrees/--ws--/fix-login",
			sourceRootRelativePath: "Volt",
			branch: "volt/fix-login",
			createdAt: 1,
			sessionIds: [],
		});
		await stateManager.bindWorktreeSession("ws", "fix-login", "s-worktree");
		const runtime = createRuntime("s-worktree");
		runtime.listSessions = async () => [
			{
				sessionId: "s-worktree",
				sessionName: "worktree session",
				firstMessage: "hi",
				createdAt: new Date(1).toISOString(),
				modifiedAt: new Date(2).toISOString(),
				messageCount: 1,
				cwd: "/tmp/agent/worktrees/--ws--/fix-login/packages/coding-agent",
			},
			{
				sessionId: "s-plain",
				sessionName: "plain session",
				firstMessage: "hi",
				createdAt: new Date(1).toISOString(),
				modifiedAt: new Date(1).toISOString(),
				messageCount: 1,
			},
		];

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "7", type: "list_sessions" },
			createAuthorization(),
			createContext({ stateManager }),
			runtime,
		)) as { success: boolean; data: { sessions: Array<Record<string, unknown>> } };
		expect(response.success).toBe(true);
		const bySession = new Map(response.data.sessions.map((session) => [session.sessionId, session]));
		expect(bySession.get("s-worktree")?.worktreeId).toBe("fix-login");
		expect(bySession.get("s-worktree")?.workingDirectory).toBe("Volt/packages/coding-agent");
		expect(bySession.get("s-plain")).not.toHaveProperty("worktreeId");
		// Ids only — no checkout path may reach the wire.
		expect(JSON.stringify(response)).not.toContain("/tmp/agent/worktrees");
	});

	it("includes parent workspace sessions when the active runtime cwd is a subfolder", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-conversation-list-"));
		try {
			const workspacePath = join(tempDir, "repo");
			const subfolderPath = join(workspacePath, "packages", "app");
			const agentDir = join(tempDir, "agent");
			mkdirSync(subfolderPath, { recursive: true });
			const sessionDir = getDefaultSessionDir(workspacePath, agentDir);
			writeFileSync(
				join(sessionDir, "root-session.jsonl"),
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: "s-root",
					timestamp: new Date(1).toISOString(),
					cwd: workspacePath,
				})}\n`,
			);
			const runtime = createRuntime("s-subfolder");
			runtime.listSessions = async () => [
				{
					sessionId: "s-subfolder",
					sessionName: "subfolder session",
					firstMessage: "hi",
					createdAt: new Date(2).toISOString(),
					modifiedAt: new Date(3).toISOString(),
					messageCount: 1,
					cwd: subfolderPath,
				},
			];

			const response = (await handleIntegratedConversationRpcCommand(
				{ id: "7", type: "list_sessions" },
				createAuthorization({ workspacePath }),
				createContext({ agentDir }),
				runtime,
			)) as { success: boolean; data: { sessions: Array<Record<string, unknown>> } };

			expect(response.success).toBe(true);
			const bySessionId = new Map(response.data.sessions.map((session) => [session.sessionId, session]));
			expect(bySessionId.get("s-root")).toBeDefined();
			expect(bySessionId.get("s-subfolder")?.workingDirectory).toBe("packages/app");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("adds optional daemon runtime ownership to list_sessions entries", async () => {
		const runtime = createRuntime();
		runtime.listSessions = async () =>
			["s-tui", "s-active", "s-detached", "s-draining", "s-saved"].map((sessionId, index) => ({
				sessionId,
				sessionName: sessionId,
				firstMessage: "hi",
				createdAt: new Date(index + 1).toISOString(),
				modifiedAt: new Date(index + 1).toISOString(),
				messageCount: 1,
			}));
		const runtimeStates = new Map<string, RemoteSessionRuntimeState>([
			["s-tui", "tui-owned"],
			["s-active", "daemon-active"],
			["s-detached", "daemon-detached"],
			["s-draining", "daemon-draining"],
		]);
		const listRuntimeStates = vi.fn(async () => runtimeStates);

		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "runtime-states", type: "list_sessions" },
			createAuthorization(),
			createContext({ listRuntimeStates }),
			runtime,
		)) as { success: boolean; data: { sessions: Array<Record<string, unknown>> } };

		expect(response.success).toBe(true);
		expect(listRuntimeStates).toHaveBeenCalledOnce();
		expect(listRuntimeStates).toHaveBeenCalledWith("ws");
		const bySessionId = new Map(response.data.sessions.map((session) => [session.sessionId, session]));
		expect(bySessionId.get("s-tui")?.runtimeState).toBe("tui-owned");
		expect(bySessionId.get("s-active")?.runtimeState).toBe("daemon-active");
		expect(bySessionId.get("s-detached")?.runtimeState).toBe("daemon-detached");
		expect(bySessionId.get("s-draining")?.runtimeState).toBe("daemon-draining");
		expect(bySessionId.get("s-saved")).not.toHaveProperty("runtimeState");
	});

	it("serves list_sessions with the current session summary", async () => {
		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "7", type: "list_sessions" },
			createAuthorization(),
			createContext(),
			createRuntime(),
		)) as { success: boolean; data: { sessions: unknown[] } };
		expect(response.success).toBe(true);
		expect(response.data.sessions).toEqual([]);
	});

	it("only unregisters the stream-bound workspace and runs the cleanup hook", async () => {
		const stateManager = new IrohRemoteHostStateManager();
		await stateManager.upsertWorkspace({ name: "ws", path: "/tmp/ws" });
		await stateManager.upsertWorkspace({ name: "other", path: "/tmp/other" });
		const cleanedUp: string[] = [];
		const context = createContext({
			stateManager,
			onWorkspaceUnregistered: async (workspaceName) => {
				cleanedUp.push(workspaceName);
			},
		});

		// A client bound to "ws" may not unregister an unrelated workspace by name.
		const otherWorkspace = (await handleIntegratedConversationRpcCommand(
			{ id: "8", type: "unregister_workspace", workspaceName: "other" },
			createAuthorization(),
			context,
			createRuntime(),
		)) as Record<string, unknown>;
		expect(otherWorkspace).toMatchObject({ success: false, error: "session_mismatch" });
		expect(cleanedUp).toEqual([]);

		// The legacy/undocumented `name` field is not honored; only `workspaceName` is.
		const legacyField = (await handleIntegratedConversationRpcCommand(
			{ id: "9", type: "unregister_workspace", name: "ws" },
			createAuthorization(),
			context,
			createRuntime(),
		)) as Record<string, unknown>;
		expect(legacyField).toMatchObject({ success: false, error: "session_mismatch" });
		expect(cleanedUp).toEqual([]);

		// Unregistering the bound workspace succeeds and fires the cleanup hook for it.
		const removed = (await handleIntegratedConversationRpcCommand(
			{ id: "10", type: "unregister_workspace", workspaceName: "ws" },
			createAuthorization(),
			context,
			createRuntime(),
		)) as Record<string, unknown>;
		expect(removed).toMatchObject({ success: true });
		expect(cleanedUp).toEqual(["ws"]);
	});

	it("stores a trimmed web-search key and reports configured without echoing the key", async () => {
		const { service, calls } = createFakeWebSearchKeyService();
		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "30", type: "set_web_search_key", apiKey: "  brave-key-123  " },
			createAuthorization(),
			createContext({ webSearchKey: service }),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(response).toEqual({
			id: "30",
			type: "response",
			command: "set_web_search_key",
			success: true,
			data: { webSearch: { configured: true } },
		});
		expect(calls).toEqual(["brave-key-123"]);
		expect(JSON.stringify(response)).not.toContain("brave-key-123");
	});

	it("clears the web-search key when apiKey is null, omitted, or blank", async () => {
		for (const command of [
			{ id: "31", type: "set_web_search_key", apiKey: null },
			{ id: "32", type: "set_web_search_key" },
			{ id: "33", type: "set_web_search_key", apiKey: "   " },
		]) {
			const { service, calls } = createFakeWebSearchKeyService();
			const response = (await handleIntegratedConversationRpcCommand(
				command,
				createAuthorization(),
				createContext({ webSearchKey: service }),
				createRuntime(),
			)) as Record<string, unknown>;
			expect(response).toEqual({
				id: command.id,
				type: "response",
				command: "set_web_search_key",
				success: true,
				data: { webSearch: { configured: false } },
			});
			expect(calls).toEqual([null]);
		}
	});

	it("rejects set_web_search_key when apiKey is not a string or null", async () => {
		const { service, calls } = createFakeWebSearchKeyService();
		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "34", type: "set_web_search_key", apiKey: 42 },
			createAuthorization(),
			createContext({ webSearchKey: service }),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(response).toMatchObject({
			id: "34",
			command: "set_web_search_key",
			success: false,
			error: "set_web_search_key requires apiKey to be a string or null",
		});
		expect(calls).toEqual([]);
	});

	it("reports web-search key status from the service via get_web_search_status", async () => {
		const { service } = createFakeWebSearchKeyService();
		const unconfigured = (await handleIntegratedConversationRpcCommand(
			{ id: "35", type: "get_web_search_status" },
			createAuthorization(),
			createContext({ webSearchKey: service }),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(unconfigured).toEqual({
			id: "35",
			type: "response",
			command: "get_web_search_status",
			success: true,
			data: { webSearch: { configured: false } },
		});

		service.set("brave-key");
		const configured = (await handleIntegratedConversationRpcCommand(
			{ id: "36", type: "get_web_search_status" },
			createAuthorization(),
			createContext({ webSearchKey: service }),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(configured).toMatchObject({ success: true, data: { webSearch: { configured: true } } });
	});

	it("rejects web-search key commands when no service is available", async () => {
		for (const type of ["set_web_search_key", "get_web_search_status"]) {
			const response = (await handleIntegratedConversationRpcCommand(
				{ id: "37", type },
				createAuthorization(),
				createContext(),
				createRuntime(),
			)) as Record<string, unknown>;
			expect(response).toMatchObject({
				id: "37",
				command: type,
				success: false,
				error: "unsupported_remote_command",
			});
		}
	});
});

describe("worktree RPCs on conversation streams (worktrees.v1)", () => {
	const HOST_CHECKOUT_PATH = "/tmp/agent/worktrees/--ws--/fix-login";

	function createWorktreeBackend(): {
		backend: IrohRemoteWorktreeRpcBackend;
		createdFor: string[];
	} {
		const createdFor: string[] = [];
		const record = {
			id: "fix-login",
			workspaceName: "ws",
			path: HOST_CHECKOUT_PATH,
			branch: "volt/fix-login",
			baseRef: "main",
			createdAt: 1,
			sessionIds: [],
		};
		return {
			createdFor,
			backend: {
				createWorktree: vi.fn(async () => ({ ok: true as const, worktree: record })),
				listWorktrees: vi.fn(async () => ({
					ok: true as const,
					worktrees: [{ ...record, available: true, dirty: false, aheadBehind: { ahead: 1, behind: 0 } }],
				})),
				removeWorktree: vi.fn(async () => ({ ok: true as const, stoppedRuntimeCount: 0, closedStreamCount: 0 })),
			},
		};
	}

	function createWorktreeContext(backend?: IrohRemoteWorktreeRpcBackend): ConversationCommandContext {
		return createContext(backend === undefined ? {} : { createWorktreeBackend: () => backend });
	}

	it("create_worktree succeeds scoped to the stream workspace with no paths on the wire", async () => {
		const { backend } = createWorktreeBackend();
		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "1", type: "create_worktree", workspaceName: "ws", worktreeName: "fix-login" },
			createAuthorization(),
			createWorktreeContext(backend),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(response).toMatchObject({
			id: "1",
			type: "response",
			command: "create_worktree",
			success: true,
			data: { worktree: { id: "fix-login", branch: "volt/fix-login" } },
		});
		expect(backend.createWorktree).toHaveBeenCalledWith("ws", { id: "fix-login" });
		expect(JSON.stringify(response)).not.toContain(HOST_CHECKOUT_PATH);
	});

	it("list_worktrees returns summaries with aheadBehind and no paths", async () => {
		const { backend } = createWorktreeBackend();
		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "2", type: "list_worktrees", workspaceName: "ws" },
			createAuthorization(),
			createWorktreeContext(backend),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(response).toMatchObject({
			success: true,
			data: {
				worktrees: [{ id: "fix-login", available: true, dirty: false, aheadBehind: { ahead: 1, behind: 0 } }],
			},
		});
		expect(JSON.stringify(response)).not.toContain(HOST_CHECKOUT_PATH);
	});

	it("rejects cross-workspace requests with session_mismatch", async () => {
		const { backend } = createWorktreeBackend();
		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "3", type: "create_worktree", workspaceName: "other" },
			createAuthorization(),
			createWorktreeContext(backend),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(response).toMatchObject({ success: false, error: "session_mismatch" });
		expect(backend.createWorktree).not.toHaveBeenCalled();
	});

	it("fails with unsupported_remote_command when no daemon backend exists", async () => {
		const response = (await handleIntegratedConversationRpcCommand(
			{ id: "4", type: "list_worktrees", workspaceName: "ws" },
			createAuthorization(),
			createWorktreeContext(),
			createRuntime(),
		)) as Record<string, unknown>;
		expect(response).toMatchObject({ success: false, error: "unsupported_remote_command" });
	});

	it("keeps remove_worktree off conversation streams", async () => {
		// The inbound passthrough filter admits create/list but not remove.
		const allowed = getIrohRemoteRpcFilterResult(
			JSON.stringify({ id: "5", type: "create_worktree", workspaceName: "ws" }),
		);
		expect(allowed).toMatchObject({ allowed: true });
		const listAllowed = getIrohRemoteRpcFilterResult(
			JSON.stringify({ id: "5", type: "list_worktrees", workspaceName: "ws" }),
		);
		expect(listAllowed).toMatchObject({ allowed: true });
		const removed = getIrohRemoteRpcFilterResult(
			JSON.stringify({ id: "5", type: "remove_worktree", workspaceName: "ws", worktreeId: "fix-login" }),
		);
		expect(removed).toMatchObject({ allowed: false });

		// Even if a remove reached the host handler, it is not dispatched there.
		const { backend } = createWorktreeBackend();
		const response = await handleIntegratedConversationRpcCommand(
			{ id: "6", type: "remove_worktree", workspaceName: "ws", worktreeId: "fix-login" },
			createAuthorization(),
			createWorktreeContext(backend),
			createRuntime(),
		);
		expect(response).toBeUndefined();
		expect(backend.removeWorktree).not.toHaveBeenCalled();
	});
});
