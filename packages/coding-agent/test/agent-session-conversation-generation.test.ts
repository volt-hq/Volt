import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type {
	ConversationProjectionSnapshotBuilder,
	ConversationProjectionSubscription,
} from "../src/core/rpc/conversation-projection-feed.ts";
import { buildRpcSessionState } from "../src/core/rpc/session-state.ts";
import type { RpcConversationTranscriptItem } from "../src/core/rpc/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function messageText(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "assistant") {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

describe("AgentSession conversation generation commits", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("rotates the projection only after branch transcript and Agent state commit together", async () => {
		const tempDir = join(
			tmpdir(),
			`volt-conversation-generation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		await runtime.session.bindExtensions({});
		let subscription: ConversationProjectionSubscription | undefined;
		cleanups.push(async () => {
			subscription?.detach();
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		const manager = runtime.session.sessionManager;
		manager.appendMessage({ role: "user", content: "first user", timestamp: 1 });
		const firstAssistantId = manager.appendMessage(fauxAssistantMessage("first assistant"));
		manager.appendMessage({ role: "user", content: "second user", timestamp: 2 });
		const oldLeafId = manager.appendMessage(fauxAssistantMessage("second assistant"));
		runtime.session.agent.state.messages = manager.buildSessionContext().messages;

		const transcriptItems = (): RpcConversationTranscriptItem[] => {
			const items: RpcConversationTranscriptItem[] = [];
			for (const entry of manager.getBranch()) {
				if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) {
					continue;
				}
				items.push({
					entryId: entry.id,
					ordinal: entry.ordinal ?? 0,
					createdAt: entry.timestamp,
					role: entry.message.role,
					text: messageText(entry.message),
					truncated: false,
					...(entry.message.role === "assistant" ? { stopReason: entry.message.stopReason } : {}),
				});
			}
			return items;
		};

		const snapshotCuts: Array<{ stateMessages: number; transcriptMessages: number }> = [];
		const buildSnapshot: ConversationProjectionSnapshotBuilder = ({ activeAssistant, branchEpoch }) => {
			const items = transcriptItems();
			const state = buildRpcSessionState(runtime.session);
			snapshotCuts.push({ stateMessages: state.messageCount, transcriptMessages: items.length });
			const head = items.at(-1);
			return {
				conversation: { workspaceName: "test", sessionId: runtime.session.sessionId },
				state,
				transcript: {
					sessionId: runtime.session.sessionId,
					items,
					hasMore: false,
					nextBeforeEntryId: null,
					projectionVersion: 3,
					branchEpoch,
					head: head ? { entryId: head.entryId, ordinal: head.ordinal } : null,
				},
				activeAssistant,
				activeWorkflows: [],
			};
		};

		const writes: object[] = [];
		subscription = runtime.conversationProjectionFeed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot,
		});
		await subscription.ready;

		const rawLeafCuts: Array<{ nextLeafId: string | null; stateMessages: number }> = [];
		const detachRawLeaf = manager.subscribeBranchChanges((change) => {
			rawLeafCuts.push({ nextLeafId: change.nextLeafId, stateMessages: runtime.session.messages.length });
		});
		const committedCuts: Array<{
			previousLeafId: string | null;
			nextLeafId: string | null;
			stateMessages: number;
			transcriptMessages: number;
		}> = [];
		const detachCommitted = runtime.session.subscribeConversationGenerationChanges((change) => {
			committedCuts.push({
				...change,
				stateMessages: runtime.session.messages.length,
				transcriptMessages: transcriptItems().length,
			});
		});

		await runtime.session.navigateTree(firstAssistantId, { summarize: false });
		await subscription.flush();
		detachRawLeaf();
		detachCommitted();

		expect(rawLeafCuts).toEqual([{ nextLeafId: firstAssistantId, stateMessages: 4 }]);
		expect(committedCuts).toEqual([
			{
				previousLeafId: oldLeafId,
				nextLeafId: firstAssistantId,
				stateMessages: 2,
				transcriptMessages: 2,
			},
		]);
		expect(snapshotCuts).toEqual([
			{ stateMessages: 4, transcriptMessages: 4 },
			{ stateMessages: 2, transcriptMessages: 2 },
		]);
		const bootstraps = writes.filter(
			(value): value is object & { type: "conversation_bootstrap" } =>
				"type" in value && value.type === "conversation_bootstrap",
		);
		expect(bootstraps).toHaveLength(2);
		expect(bootstraps[1]).toMatchObject({
			type: "conversation_bootstrap",
			reason: "session_rebind",
			state: { messageCount: 2 },
			transcript: {
				items: [
					{ entryId: expect.any(String), role: "user", text: "first user" },
					{ entryId: firstAssistantId, role: "assistant", text: "first assistant" },
				],
			},
		});
	});
});
