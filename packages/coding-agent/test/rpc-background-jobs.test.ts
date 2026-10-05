import type { AgentToolResult } from "@hansjm10/volt-agent-core";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import { type LiveItem, WORK_NOTICE_CUSTOM_TYPE } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createLoopbackClient } from "../src/client/protocol-client.ts";
import { remoteProfile } from "../src/core/protocol/profiles.ts";
import { projectEntry, sessionProjectionSource } from "../src/core/protocol/projection/entries.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { JobSummary } from "../src/core/tools/jobs.ts";
import { createHostHarness, type HostHarness } from "./suite/host-harness.ts";
import { createTestJobRuntime, type TestJobRuntime } from "./utilities/job-runtime.ts";

const harnesses: HostHarness[] = [];
const runtimes: TestJobRuntime[] = [];
const cleanup: Array<() => Promise<void> | void> = [];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
	for (const runtime of runtimes.splice(0)) await runtime.close();
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

describe("background jobs on the protocol", () => {
	it("serves jobs only as work items: the job intent and query are gone", async () => {
		const harness = await createHostHarness();
		harnesses.push(harness);
		const client = await createLoopbackClient(harness.host, await harness.openStartup());
		cleanup.push(() => client.stop());
		await expect(client.intent("cancel_job" as string, { jobId: "job_123" })).rejects.toMatchObject({
			reason: { code: "unknown_intent" },
		});
		await expect(client.query("job_output" as "work_output", { workId: "job_123" })).rejects.toMatchObject({
			code: "unknown_query",
		});
		// A well-formed id of no work of the conversation is refused as input.
		await expect(client.query("work_output", { workId: "job_123" })).rejects.toMatchObject({
			code: "invalid_input",
		});
	});

	it.each(["bash", "subagent"] as const)(
		"shows a running %s job as a live work value without its output",
		async (tool) => {
			const runtime = await createTestJobRuntime();
			runtimes.push(runtime);
			const items: LiveItem[] = [];
			runtime.live.attach("observer", {
				acceptsHostRequest: () => false,
				apply: (update) => {
					items.push(...update.items);
				},
			});
			const finish = deferred();
			let update!: (partial: AgentToolResult<unknown>) => void;
			const job: JobSummary = await runtime.jobs.start({
				tool,
				toolCallId: "call",
				label: "worker",
				run: async (_signal, callback) => {
					update = callback;
					await finish.promise;
					return { content: [{ type: "text", text: "terminal output" }] };
				},
			});
			await expect.poll(() => update).toBeDefined();
			for (let index = 0; index < 100; index++) update({ content: [{ type: "text", text: `progress ${index}` }] });
			expect(runtime.jobs.get(job.id).output).toBe("progress 99");
			expect(items.filter((item) => item.type === "set" && item.key === `work/${job.id}`)).toHaveLength(1);
			finish.resolve();
			await runtime.work.waitForIdle();
			expect(items.at(-1)).toEqual({ type: "clear", key: `work/${job.id}` });
			expect(JSON.stringify(items)).not.toContain("progress");
			expect(JSON.stringify(items)).not.toContain("terminal output");
			expect(runtime.work.output(job.id)).toEqual({ text: "terminal output", truncated: false, final: true });
		},
	);

	it("projects historical job identity and notices for a remote client without exposing output", async () => {
		const job: JobSummary = {
			id: "0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d",
			tool: "bash",
			toolCallId: "call",
			label: "/repo/test",
			status: "running",
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
			content: [{ type: "text", text: "Started job: private result" }],
			details: { job },
			isError: false,
			timestamp: 1,
		});
		const noticeId = await manager.logWriter.appendCustomMessageEntry(
			WORK_NOTICE_CUSTOM_TYPE,
			`/repo/test (job ${job.id}) completed.`,
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
			details: { job: { workId: job.id, status: "running" } },
			summary: `Background job ${job.id}: running (snapshot)`,
		});
		expect(JSON.stringify(result.view?.details)).not.toContain("/repo/test");
		expect(project(noticeId).view).toMatchObject({
			role: "system",
			text: `/workspace/test (job ${job.id}) completed.`,
		});
	});
});
