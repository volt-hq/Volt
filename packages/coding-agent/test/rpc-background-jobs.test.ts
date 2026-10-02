import type { AgentToolUpdateCallback } from "@hansjm10/volt-agent-core";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundJobManager } from "../src/core/background-jobs.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import { sanitizeIrohRemoteOutbound } from "../src/core/remote/iroh/outbound-filter.ts";
import { getIrohRemoteRpcFilterResult } from "../src/core/remote/iroh/rpc-command-filter.ts";
import {
	listRpcBackgroundJobs,
	projectRpcBackgroundJobDetails,
	subscribeRpcSessionEvents,
} from "../src/core/rpc/background-jobs.ts";
import {
	ConversationProjectionFeed,
	type ConversationProjectionSnapshotBuilder,
} from "../src/core/rpc/conversation-projection-feed.ts";
import { RPC_COMMAND_SCHEMAS } from "../src/core/rpc/schema/commands.ts";
import { RpcBackgroundJobsChangedEventSchema } from "../src/core/rpc/schema/events.ts";
import { RPC_RESPONSE_SCHEMAS } from "../src/core/rpc/schema/responses.ts";
import { projectSessionTranscript } from "../src/core/rpc/transcript.ts";
import type { RpcSessionState } from "../src/core/rpc/types.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { projectRemoteTranscriptEntry } from "../src/daemon/conversation-commands.ts";
import { validateRpcCommandPayload } from "../src/modes/rpc/rpc-command-validation.ts";

const managers: BackgroundJobManager[] = [];
const feeds: ConversationProjectionFeed[] = [];
const cleanup: Array<() => void> = [];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function setup() {
	let generation = 0;
	const manager = new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => generation });
	managers.push(manager);
	const source = { backgroundJobs: manager, subscribe: () => () => {} };
	const state: RpcSessionState = {
		thinkingLevel: "off",
		availableThinkingLevels: ["off"],
		fastModeEnabled: false,
		planning: { mode: "build", plan: null },
		gitContext: null,
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "session",
		autoCompactionEnabled: false,
		messageCount: 0,
		pendingMessageCount: 0,
		steeringQueue: [],
		followUpQueue: [],
		backgroundJobs: [],
	};
	const buildSnapshot: ConversationProjectionSnapshotBuilder = ({ activeAssistant, branchEpoch }) => ({
		conversation: { workspaceName: "workspace", sessionId: "session" },
		state: { ...state, backgroundJobs: listRpcBackgroundJobs(manager) },
		transcript: {
			sessionId: "session",
			items: [],
			hasMore: false,
			nextBeforeEntryId: null,
			projectionVersion: 3,
			branchEpoch,
			head: null,
		},
		activeAssistant,
		activeWorkflows: [],
	});
	return {
		manager,
		source,
		buildSnapshot,
		rebase: () => {
			generation++;
			manager.cancelInaccessible();
		},
	};
}

function startJob(manager: BackgroundJobManager, toolName: "bash" | "subagent" = "bash") {
	const finish = deferred();
	cleanup.push(finish.resolve);
	let update!: AgentToolUpdateCallback<unknown>;
	const job = manager.start({
		toolName,
		toolCallId: "call",
		label: "worker",
		execute: async (_signal, callback) => {
			update = callback;
			await finish.promise;
			return { content: [{ type: "text", text: "terminal output" }] };
		},
	});
	return { job, finish: finish.resolve, output: (text: string) => update({ content: [{ type: "text", text }] }) };
}

afterEach(async () => {
	for (const fn of cleanup.splice(0)) fn();
	for (const feed of feeds.splice(0)) feed.dispose();
	vi.useRealTimers();
	for (const manager of managers.splice(0)) await manager.close();
});

describe("Jobs RPC contract and projection", () => {
	it("validates strict commands and preserves correlated errors for invalid job IDs", () => {
		for (const type of ["read_job", "cancel_job"] as const) {
			expect(Compile(RPC_COMMAND_SCHEMAS[type]).Check({ type, jobId: "job_123" })).toBe(true);
			for (const jobId of [undefined, "", " padded ", "界".repeat(100), 42]) {
				expect(validateRpcCommandPayload({ id: "request", type, jobId })).toBeDefined();
			}
			expect(validateRpcCommandPayload({ type, jobId: "job_123", path: "/tmp/log" })).toBeDefined();
		}
		expect(validateRpcCommandPayload({ type: "list_jobs" })).toBeUndefined();
		expect(validateRpcCommandPayload({ type: "list_jobs", jobId: "job_123" })).toBeDefined();
	});

	it.each(["bash", "subagent"] as const)(
		"coalesces %s progress without copying output or consuming model results",
		async (toolName) => {
			vi.useFakeTimers();
			const { manager, source } = setup();
			const listener = vi.fn();
			const unsubscribe = subscribeRpcSessionEvents(source, listener);
			cleanup.push(unsubscribe);
			const worker = startJob(manager, toolName);
			await Promise.resolve();
			for (let index = 0; index < 100; index++) worker.output(`progress ${index}`);
			expect(listener).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(100);
			expect(listener).toHaveBeenCalledTimes(1);
			const event = listener.mock.calls[0][0];
			expect(Compile(RpcBackgroundJobsChangedEventSchema).Errors(event)).toEqual([]);
			expect(event.jobs).toHaveLength(1);
			expect(event.jobs[0]).not.toHaveProperty("output");
			worker.finish();
			await manager.waitForIdle();
			await vi.advanceTimersByTimeAsync(100);
			expect(listener.mock.calls[1][0].jobs[0].status).toBe("completed");
			expect(manager.listUncollected()).toHaveLength(1);
			unsubscribe();
			manager.setSteeringPending(true);
			await vi.advanceTimersByTimeAsync(100);
			expect(listener).toHaveBeenCalledTimes(2);
		},
	);

	it("captures the current branch when a pending progress notification is delivered", async () => {
		vi.useFakeTimers();
		const { manager, source, rebase } = setup();
		const listener = vi.fn();
		cleanup.push(subscribeRpcSessionEvents(source, listener));
		startJob(manager);
		rebase();
		await vi.advanceTimersByTimeAsync(100);
		expect(listener).toHaveBeenCalledWith({ type: "background_jobs_changed", jobs: [] });
	});

	it.each(["list_jobs", "read_job", "cancel_job"])(
		"drops buffered %s results when the branch changes",
		async (command) => {
			const { source, buildSnapshot } = setup();
			const feed = new ConversationProjectionFeed({
				subscribe: (listener) => subscribeRpcSessionEvents(source, listener),
			});
			feeds.push(feed);
			const gate = deferred();
			cleanup.push(gate.resolve);
			const writes: object[] = [];
			const subscription = feed.attach({
				buildSnapshot,
				write: (value) => {
					writes.push(value);
					return writes.length === 1 ? gate.promise : undefined;
				},
			});
			const buffered = subscription.enqueueControl({
				id: "stale",
				type: "response",
				command,
				success: true,
				data: { branchEpoch: subscription.branchEpoch, output: "old branch output" },
			});
			feed.rotateForBranchRebase();
			gate.resolve();
			await buffered;
			await subscription.flush();
			expect(writes).not.toContainEqual(expect.objectContaining({ id: "stale" }));
			expect(writes.at(-1)).toMatchObject({
				type: "conversation_bootstrap",
				reason: "branch_rebase",
				state: { backgroundJobs: [] },
			});
		},
	);

	it("restores terminal jobs in checkpoints and rejects output-bearing change events", async () => {
		const { manager, source, buildSnapshot } = setup();
		const feed = new ConversationProjectionFeed({
			subscribe: (listener) => subscribeRpcSessionEvents(source, listener),
		});
		feeds.push(feed);
		const writes: object[] = [];
		const subscription = feed.attach({
			buildSnapshot,
			write: (value) => {
				writes.push(value);
			},
		});
		await subscription.ready;
		const worker = startJob(manager);
		worker.finish();
		await manager.waitForIdle();
		subscription.requestCheckpoint({ requestId: "recover", lastAppliedCursor: 0, reason: "cursor_gap" });
		await subscription.flush();
		expect(writes.at(-1)).toMatchObject({
			reason: "resync",
			state: { backgroundJobs: [{ id: worker.job.id, status: "completed" }] },
		});
		const jobs = listRpcBackgroundJobs(manager);
		expect(
			Compile(RpcBackgroundJobsChangedEventSchema).Check({
				type: "background_jobs_changed",
				jobs: [{ ...jobs[0], output: "must stay private" }],
			}),
		).toBe(false);
		expect(
			Compile(RPC_RESPONSE_SCHEMAS.list_jobs).Check({
				type: "response",
				command: "list_jobs",
				success: true,
				data: { sessionId: "session", jobs },
			}),
		).toBe(true);
	});

	it("uses observation for reads and control for cancellation", () => {
		const observe = {
			...createIrohRemotePresetAccess("coding").rpcGrant,
			capabilities: ["conversation.observe.v1" as const],
		};
		for (const type of ["list_jobs", "read_job"])
			expect(getIrohRemoteRpcFilterResult(JSON.stringify({ type, jobId: "job" }), observe).allowed).toBe(true);
		expect(getIrohRemoteRpcFilterResult(JSON.stringify({ type: "cancel_job", jobId: "job" }), observe)).toMatchObject(
			{ allowed: false, response: { error: { requiredCapability: "conversation.control.v1" } } },
		);
	});

	it("keeps metadata within its schema bounds after remote path expansion", () => {
		const job = {
			id: "job_123",
			toolName: "bash",
			label: "/r ".repeat(66).trim(),
			status: "running",
			startedAt: 1,
			outputTruncated: false,
		};
		const event = { type: "background_jobs_changed", jobs: [job] };
		const sanitized = sanitizeIrohRemoteOutbound(event, { workspacePath: "/r" });
		expect(Compile(RpcBackgroundJobsChangedEventSchema).Errors(sanitized)).toEqual([]);
		expect(sanitized).toMatchObject({ jobs: [{ label: "/workspace ".repeat(66).trim().slice(0, 200) }] });
		expect(job.label).toBe("/r ".repeat(66).trim());
		const response = sanitizeIrohRemoteOutbound(
			{ type: "response", command: "list_jobs", success: true, data: { sessionId: "session", jobs: [job] } },
			{ workspacePath: "/r" },
		);
		expect(Compile(RPC_RESPONSE_SCHEMAS.list_jobs).Errors(response)).toEqual([]);
	});

	it("projects historical job identity and notices without exposing output in metadata", () => {
		const access = createIrohRemotePresetAccess("coding");
		const authorization: IrohRemoteClientAuthorizationSuccess = {
			ok: true,
			allowTools: access.allowedTools,
			paired: false,
			pairingSecretConsumed: false,
			client: {
				nodeId: "phone",
				label: "Phone",
				allowedWorkspaces: [],
				allowedTools: access.allowedTools,
				rpcGrant: access.rpcGrant,
				pairedAt: 1,
				lastSeenAt: 1,
			},
			workspace: { name: "workspace", path: "/repo" },
			workspaceNames: ["workspace"],
			workspaces: [{ name: "workspace", status: "available" }],
		};
		const backgroundJob = {
			id: "job_123",
			toolName: "bash" as const,
			toolCallId: "call",
			label: "/repo/test",
			status: "running" as const,
			startedAt: 1,
			output: "private result",
			outputTruncated: false,
		};
		const details = { backgroundJob };
		const entry: SessionEntry = {
			type: "message",
			id: "entry",
			parentId: null,
			ordinal: 1,
			timestamp: "2026-09-10T00:00:00.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "bash",
				content: [{ type: "text", text: "Started job" }],
				details,
				isError: false,
				timestamp: 1,
			},
		};
		const toolCall = {
			assistantEntryId: "assistant",
			contentIndex: 0,
			providerCallId: "call",
			name: "bash",
			arguments: { command: "do work", background: true },
		};
		const projected = projectRemoteTranscriptEntry(entry, authorization, toolCall);
		expect(projected).toMatchObject({
			args: { background: true },
			details: { backgroundJob: { id: "job_123", label: "/workspace/test" } },
			summary: "Background job job_123: running (snapshot)",
		});
		expect(projected?.details?.backgroundJob).not.toHaveProperty("output");
		expect(
			projectRpcBackgroundJobDetails({ backgroundJob: { ...backgroundJob, output: undefined } }),
		).toBeUndefined();
		const manager = SessionManager.inMemory();
		manager.appendCustomMessageEntry("background_job_notification", "Job job_123 completed", true);
		expect(projectSessionTranscript(manager).items).toEqual([
			expect.objectContaining({ role: "system", text: "Job job_123 completed" }),
		]);
		expect(projectRemoteTranscriptEntry(manager.getBranch()[0], authorization, undefined)).toMatchObject({
			role: "system",
			text: "Job job_123 completed",
		});
		const read = {
			type: "response",
			command: "read_job",
			success: true,
			data: { sessionId: "session", job: { ...backgroundJob, output: '/repo/test\n"escaped"\n界' } },
		};
		expect(sanitizeIrohRemoteOutbound(read, { workspacePath: "/repo" })).toMatchObject({
			data: { job: { output: '/workspace/test\n"escaped"\n界' } },
		});
	});
});
