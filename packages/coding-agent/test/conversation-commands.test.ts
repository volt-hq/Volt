import { describe, expect, it } from "vitest";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import {
	type ConversationCommandContext,
	type ConversationCommandRuntime,
	handleIntegratedConversationRpcCommand,
	INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES,
	LEASE_DRAINING_RETRY_AFTER_MS,
	REMOTE_TOOL_OUTPUT_MAX_SCALARS,
	TURN_INITIATING_RPC_TYPES,
} from "../src/daemon/conversation-commands.ts";

function createAuthorization(): IrohRemoteClientAuthorizationSuccess {
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
		workspace: { name: "ws", path: "/tmp/ws" },
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
});
