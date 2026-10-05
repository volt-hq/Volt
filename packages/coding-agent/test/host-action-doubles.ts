/**
 * Host actions for tests: a client of a live state that answers approvals,
 * and the real `host_action` path (a conversation kernel over an in-memory
 * log, its work registry, its live state, and `SessionHostActions`) with
 * such a client attached, or none at all.
 */

import { randomUUID } from "node:crypto";
import { Conversation, InMemoryConversationLog, type StreamFn, type WorkRecord } from "@hansjm10/volt-agent-core";
import type { HostResponse } from "@hansjm10/volt-protocol";
import { LiveState } from "../src/core/host/live-state.ts";
import {
	HOST_ACTION_WORK_KIND,
	type HostActionRequest,
	type HostActions,
	SessionHostActions,
} from "../src/core/session/host-actions.ts";
import { WorkRegistry } from "../src/core/work/registry.ts";

/** How the approving client answers an approval. */
export type ApprovalAnswer = Extract<HostResponse, { decision: unknown }> | { cancelled: true };

export type Approver = (request: HostActionRequest) => ApprovalAnswer | Promise<ApprovalAnswer>;

export interface Approvals {
	/** The approvals the client was asked, in order. */
	readonly requests: HostActionRequest[];
	detach(): void;
}

/**
 * Attach a client to `liveState` that accepts approvals and answers each
 * through `approve` (a throw cancels it). `onCleared` hears of each work
 * item whose live value was cleared: its executor detached.
 */
export function attachApprover(
	liveState: LiveState,
	approve: Approver,
	onCleared?: (workId: string) => void,
): Approvals {
	const clientId = `approver-${randomUUID()}`;
	const requests: HostActionRequest[] = [];
	const detach = liveState.attach(clientId, {
		acceptsHostRequest: (kind) => kind === "approval",
		apply: (update) => {
			for (const item of update.items) {
				if (item.type === "clear" && item.key.startsWith("work/")) {
					onCleared?.(item.key.slice("work/".length));
					continue;
				}
				if (item.type !== "set" || item.value.kind !== "host_request") continue;
				const { requestId, request } = item.value;
				if (request.kind !== "approval") continue;
				const { kind: _kind, ...asked } = request;
				requests.push(asked);
				void Promise.resolve()
					.then(() => approve(asked))
					.then(
						(answer) => liveState.answer(requestId, answer, clientId),
						() => liveState.answer(requestId, { cancelled: true }, clientId),
					);
			}
		},
	});
	return { requests, detach };
}

export interface TestHostActions {
	readonly actions: HostActions;
	/** The approvals the client was asked, in order. */
	readonly requests: readonly HostActionRequest[];
	/** Host action records, once each finished and its executor detached, in that order. */
	readonly finished: WorkRecord[];
	/** Every host action record, in start order. */
	records(): WorkRecord[];
	/** Called with each finished record as it is added to `finished`. */
	onFinished?: (record: WorkRecord) => void;
	/** Close the conversation: actions still open end without running. */
	close(): Promise<void>;
}

const noTurns: StreamFn = () => {
	throw new Error("No turn runs in host action tests");
};

/**
 * Host actions whose approvals `approve` answers; with `null` no attached
 * client accepts approvals, as in a conversation nobody watches.
 */
export function testHostActions(approve: Approver | null = () => ({ decision: "approved" })): TestHostActions {
	let registry: WorkRegistry | undefined;
	let conversation: Conversation | undefined;
	let approvals: Approvals | undefined;
	const ready = (async () => {
		conversation = await Conversation.open({
			log: new InMemoryConversationLog(`host-actions-${randomUUID()}`),
			stream: noTurns,
			resolveModel: () => undefined,
		});
		const opened = conversation;
		const liveState = new LiveState({ head: () => opened.state.ordinal });
		const work = new WorkRegistry({
			conversationId: () => opened.conversationId,
			work: () => opened.work,
			state: () => opened.state,
			live: () => liveState,
			turnId: () => undefined,
		});
		registry = work;
		work.register(HOST_ACTION_WORK_KIND);
		await work.reconcile();
		if (approve !== null) {
			approvals = attachApprover(liveState, approve, (workId) => {
				const record = work.get(workId);
				if (record?.outcome === undefined) return;
				doubles.finished.push(record);
				doubles.onFinished?.(record);
			});
		}
		return new SessionHostActions({ liveState, work: () => work });
	})();
	const doubles: TestHostActions = {
		actions: { run: async (request, execute, options) => (await ready).run(request, execute, options) },
		get requests() {
			return approvals?.requests ?? [];
		},
		finished: [],
		records: () => registry?.list().filter((record) => record.kind === "host_action") ?? [],
		close: async () => {
			await ready;
			await registry?.cancelAll("closed");
			await conversation?.close();
		},
	};
	return doubles;
}
