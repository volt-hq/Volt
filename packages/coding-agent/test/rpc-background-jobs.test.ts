import type { AgentToolUpdateCallback } from "@hansjm10/volt-agent-core";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import { type HostFrame, LiveJobsValueSchema, type LiveValue, QUERY_SCHEMAS } from "@hansjm10/volt-protocol";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient } from "../src/client/protocol-client.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { BackgroundJobManager } from "../src/core/background-jobs.ts";
import { feedLiveState, type LiveFeed } from "../src/core/host/live-feed.ts";
import { LiveState } from "../src/core/host/live-state.ts";
import { remoteProfile } from "../src/core/protocol/profiles.ts";
import { projectEntry, sessionProjectionSource } from "../src/core/protocol/projection/entries.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { projectRpcBackgroundJobDetails } from "../src/core/rpc/background-jobs.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHostHarness, type HostHarness } from "./suite/host-harness.ts";
import { createLiveRecorder } from "./utilities/live-recorder.ts";

type JobsValue = Extract<LiveValue, { kind: "jobs" }>;

const managers: BackgroundJobManager[] = [];
const feeds: LiveFeed[] = [];
const harnesses: HostHarness[] = [];
const cleanup: Array<() => Promise<void> | void> = [];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/**
 * A job manager feeding a live state through the conversation live feed. The
 * session around it reads nothing else: the feed skips the values it cannot read.
 */
function setup() {
	let generation = 0;
	const manager = new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => generation });
	managers.push(manager);
	const live = new LiveState();
	const session = {
		backgroundJobs: manager,
		liveState: live,
		settingsManager: {},
		sessionManager: { subscribeEntries: () => () => {} },
		subscribe: () => () => {},
		subscribeActivity: () => () => {},
	};
	const feed = feedLiveState(session as unknown as AgentSession);
	feeds.push(feed);
	return {
		manager,
		live,
		feed,
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

/** The jobs values a recorder was delivered, in order. */
function jobsSets(recorder: ReturnType<typeof createLiveRecorder>): JobsValue[] {
	return recorder.items().flatMap((item) => (item.type === "set" && item.value.kind === "jobs" ? [item.value] : []));
}

afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
	for (const feed of feeds.splice(0)) feed.close();
	vi.useRealTimers();
	for (const manager of managers.splice(0)) await manager.close();
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

describe("background jobs on the protocol", () => {
	it("rejects malformed job ids and unknown fields as invalid input, answering the intent or query that sent them", async () => {
		const harness = await createHostHarness();
		harnesses.push(harness);
		const client = await createLoopbackClient(harness.host, await harness.openStartup());
		cleanup.push(() => client.stop());
		const invalid: Array<Record<string, unknown>> = [
			{},
			{ jobId: "" },
			{ jobId: " padded " },
			{ jobId: 42 },
			{ jobId: "job_123", path: "/tmp/log" },
		];
		for (const input of invalid) {
			await expect(client.intent("cancel_job" as string, input)).rejects.toMatchObject({
				reason: { code: "invalid_input" },
			});
			await expect(client.query("job_output", input as { jobId: string })).rejects.toMatchObject({
				code: "invalid_input",
			});
		}
		// A well-formed id of no job of the conversation is a failure, not invalid input.
		await expect(client.intent("cancel_job", { jobId: "job_123" })).rejects.toMatchObject({
			reason: { code: "failed", message: expect.stringContaining("inaccessible") },
		});
		await expect(client.query("job_output", { jobId: "job_123" })).rejects.toMatchObject({
			code: "failed",
			message: expect.stringContaining("inaccessible"),
		});
	});

	it.each(["bash", "subagent"] as const)(
		"coalesces %s progress into metadata-only jobs values without consuming model results",
		async (toolName) => {
			vi.useFakeTimers();
			const { manager, live, feed } = setup();
			const recorder = createLiveRecorder();
			live.attach("observer", recorder);
			const delivered = jobsSets(recorder).length;
			const worker = startJob(manager, toolName);
			await Promise.resolve();
			for (let index = 0; index < 100; index++) worker.output(`progress ${index}`);
			expect(jobsSets(recorder)).toHaveLength(delivered);
			await vi.advanceTimersByTimeAsync(100);
			expect(jobsSets(recorder)).toHaveLength(delivered + 1);
			const value = jobsSets(recorder).at(-1)!;
			expect(Compile(LiveJobsValueSchema).Errors(value)).toEqual([]);
			expect(value.jobs).toHaveLength(1);
			expect(value.jobs[0]).not.toHaveProperty("output");
			worker.finish();
			await manager.waitForIdle();
			await vi.advanceTimersByTimeAsync(100);
			expect(jobsSets(recorder).at(-1)?.jobs[0]?.status).toBe("completed");
			expect(manager.listUncollected()).toHaveLength(1);
			// A closed feed publishes nothing more.
			feed.close();
			const after = jobsSets(recorder).length;
			startJob(manager, toolName);
			await vi.advanceTimersByTimeAsync(100);
			expect(jobsSets(recorder)).toHaveLength(after);
		},
	);

	it("publishes the current branch's jobs when a pending change is delivered", async () => {
		vi.useFakeTimers();
		const { manager, live, rebase } = setup();
		const recorder = createLiveRecorder();
		live.attach("observer", recorder);
		startJob(manager);
		rebase();
		await vi.advanceTimersByTimeAsync(100);
		expect(live.get("jobs")).toEqual({ kind: "jobs", jobs: [] });
		expect(jobsSets(recorder).every((value) => value.jobs.length === 0)).toBe(true);
	});

	it("shows terminal jobs to a client that attaches later and keeps output out of the live value", async () => {
		vi.useFakeTimers();
		const { manager, live } = setup();
		const worker = startJob(manager);
		worker.finish();
		await manager.waitForIdle();
		await vi.advanceTimersByTimeAsync(100);
		const recorder = createLiveRecorder();
		live.attach("late", recorder);
		expect(recorder.updates[0]?.reset).toBe(true);
		expect(jobsSets(recorder)).toEqual([
			{ kind: "jobs", jobs: [expect.objectContaining({ id: worker.job.id, status: "completed" })] },
		]);
		const jobs = jobsSets(recorder)[0]!.jobs;
		expect(Compile(LiveJobsValueSchema).Check({ kind: "jobs", jobs: [{ ...jobs[0], output: "private" }] })).toBe(
			false,
		);
		expect(Compile(QUERY_SCHEMAS.job_output.result).Check({ job: { ...jobs[0], output: "private" } })).toBe(true);
	});

	it("keeps live job labels within their schema bound after remote path expansion", () => {
		const job = {
			id: "job_123",
			toolName: "bash" as const,
			label: "/r ".repeat(66).trim(),
			status: "running" as const,
			startedAt: 1,
			outputTruncated: false,
		};
		const redactor = remoteProfile({
			grant: createIrohRemotePresetAccess("coding").rpcGrant,
			redaction: { workspacePath: "/r" },
		}).redactor();
		const frame: HostFrame = {
			type: "live",
			subscriptionId: "s1",
			basedOn: 0,
			seq: 1,
			reset: true,
			items: [{ type: "set", key: "jobs", value: { kind: "jobs", jobs: [job] } }],
		};
		const redacted = redactor.redact(frame);
		if (redacted?.type !== "live") throw new Error("Expected a live frame");
		const item = redacted.items[0];
		if (item?.type !== "set") throw new Error("Expected a set item");
		expect(Compile(LiveJobsValueSchema).Errors(item.value)).toEqual([]);
		expect(item.value).toMatchObject({ jobs: [{ label: "/workspace ".repeat(66).trim().slice(0, 200) }] });
		expect(job.label).toBe("/r ".repeat(66).trim());
	});

	it("projects historical job identity and notices for a remote client without exposing output", async () => {
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
		const manager = SessionManager.inMemory("/repo");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "do work", background: true } }],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};
		await manager.logWriter.appendMessage(assistant);
		const resultId = await manager.logWriter.appendMessage({
			role: "toolResult",
			toolCallId: "call",
			toolName: "bash",
			content: [{ type: "text", text: "Started job" }],
			details: { backgroundJob },
			isError: false,
			timestamp: 1,
		});
		const noticeId = await manager.logWriter.appendCustomMessageEntry(
			"background_job_notification",
			"Job job_123 completed",
			true,
		);
		const profile = remoteProfile({
			grant: createIrohRemotePresetAccess("coding").rpcGrant,
			redaction: { workspacePath: "/repo" },
		});
		const redactor = profile.redactor();
		const project = (id: string) => {
			const entry = manager.getCommittedEntry(id);
			if (!entry) throw new Error(`No entry ${id}`);
			const projected = projectEntry(entry, sessionProjectionSource(manager), profile);
			if (!projected) throw new Error(`The remote profile hides ${id}`);
			const redacted = redactor.redact({ type: "entry", subscriptionId: "s1", entry: projected });
			if (redacted?.type !== "entry") throw new Error("Expected an entry frame");
			const projectedEntry = redacted.entry;
			// Message-like entries reach a transcript client as their view only.
			expect(projectedEntry).not.toHaveProperty("payload");
			return { entry: projectedEntry, view: "view" in projectedEntry ? projectedEntry.view : undefined };
		};

		const result = project(resultId);
		expect(result.view).toMatchObject({
			args: { background: true },
			details: { backgroundJob: { id: "job_123", label: "/workspace/test" } },
			summary: "Background job job_123: running (snapshot)",
		});
		expect(JSON.stringify(result.entry)).not.toContain("private result");
		expect(
			projectRpcBackgroundJobDetails({ backgroundJob: { ...backgroundJob, output: undefined } }),
		).toBeUndefined();
		expect(project(noticeId).view).toMatchObject({ role: "system", text: "Job job_123 completed" });

		const read = redactor.redact({
			type: "result",
			queryId: "q-1",
			data: { job: { ...backgroundJob, output: '/repo/test\n"escaped"\n界' } },
		});
		expect(read).toMatchObject({
			data: { job: { label: "/workspace/test", output: '/workspace/test\n"escaped"\n界' } },
		});
	});
});
