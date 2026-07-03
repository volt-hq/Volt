import { describe, expect, it } from "vitest";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import {
	type ConversationCommandContext,
	type ConversationCommandRuntime,
	handleIntegratedConversationRpcCommand,
	INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES,
	LEASE_DRAINING_RETRY_AFTER_MS,
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

	it("runs the host cleanup hook after a successful workspace unregister only", async () => {
		const stateManager = new IrohRemoteHostStateManager();
		await stateManager.upsertWorkspace({ name: "other", path: "/tmp/other" });
		const cleanedUp: string[] = [];
		const context = createContext({
			stateManager,
			onWorkspaceUnregistered: async (workspaceName) => {
				cleanedUp.push(workspaceName);
			},
		});

		const missing = (await handleIntegratedConversationRpcCommand(
			{ id: "8", type: "unregister_workspace", name: "missing" },
			createAuthorization(),
			context,
			createRuntime(),
		)) as Record<string, unknown>;
		expect(missing).toMatchObject({ success: false });
		expect(cleanedUp).toEqual([]);

		const removed = (await handleIntegratedConversationRpcCommand(
			{ id: "9", type: "unregister_workspace", name: "other" },
			createAuthorization(),
			context,
			createRuntime(),
		)) as Record<string, unknown>;
		expect(removed).toMatchObject({ success: true });
		expect(cleanedUp).toEqual(["other"]);
	});
});
