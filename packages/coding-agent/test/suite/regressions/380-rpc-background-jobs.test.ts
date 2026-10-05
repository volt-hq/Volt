import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { HostFrame, RemoteCapability } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient, type LoopbackClient } from "../../../src/client/protocol-client.ts";
import type { AgentSessionServices } from "../../../src/core/agent-session-services.ts";
import { createIrohRemotePresetAccess, createIrohRemoteRpcGrant } from "../../../src/core/remote/iroh/access-grant.ts";
import { serveIrohRemoteConnection } from "../../../src/core/remote/iroh/connection.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import * as nativeTools from "../../../src/core/tools/index.ts";
import { adoptTestSession, connectTestClient, type TestHost } from "../../utilities/host-client.ts";
import { createIrohStreamPair } from "../../utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "../../utilities/remote-phone.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Background jobs are work items on the wire (PR #380, Phase 4): clients see
 * them in their fold and the live `work/<id>` value, read output with
 * `work_output`, and cancel with `cancel_work`.
 */

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const harnesses: Harness[] = [];
const hosts: TestHost[] = [];
const workers: Array<ReturnType<typeof deferred>> = [];
const connections: Array<() => Promise<void>> = [];

function services(harness: Harness): AgentSessionServices {
	return {
		cwd: harness.tempDir,
		projectCwd: harness.tempDir,
		lexicalProjectCwd: harness.tempDir,
		agentDir: harness.tempDir,
		authStorage: harness.authStorage,
		settingsManager: harness.settingsManager,
		modelRegistry: harness.session.modelRegistry,
		resourceLoader: harness.session.resourceLoader,
		gitContextProvider: harness.session.gitContextProvider,
		releaseGitContextProvider: () => {},
		diagnostics: [],
	};
}

async function setup() {
	const executions = new Map<string, { signal?: AbortSignal; output(text: string): void; finish(): void }>();
	const operations: BashOperations = {
		exec: async (command, _cwd, options) => {
			const finish = deferred();
			workers.push(finish);
			executions.set(command, {
				signal: options.signal,
				output: (text) => options.onData(Buffer.from(text)),
				finish: finish.resolve,
			});
			options.onData(Buffer.from(`output for ${command}\n`));
			await finish.promise;
			if (options.signal?.aborted) throw new Error("worker cancelled");
			return { exitCode: 0 };
		},
	};
	const original = nativeTools.createAllToolDefinitions;
	vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
		original(cwd, { ...options, bash: { ...options?.bash, operations } }),
	);
	const options = {
		initialActiveToolNames: ["bash", "jobs"],
		settings: { lsp: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } },
	};
	const harness = await createHarness(options);
	harnesses.push(harness);
	await harness.session.setSessionName("RPC Jobs test");
	const target = adoptTestSession(harness.session, services(harness), async ({ sessionManager }) => {
		const next = await createHarness({ ...options, sessionManager });
		harnesses.push(next);
		return {
			session: next.session,
			services: services(next),
			diagnostics: [],
			extensionsResult: next.session.resourceLoader.getExtensions(),
		};
	});
	hosts.push(target);
	// The conversation stays open while clients reconnect to it.
	await connectTestClient(target.host, target.conversation);
	return { harness, target, executions };
}

/** A local protocol client that records every frame; the host keeps the conversation open after it stops. */
async function connect(target: TestHost): Promise<{ client: LoopbackClient; frames: HostFrame[] }> {
	const frames: HostFrame[] = [];
	const client = await createLoopbackClient(target.host, target.conversation, {
		anchor: false,
		onFrame: (frame) => frames.push(frame),
	});
	connections.push(() => client.stop());
	return { client, frames };
}

/** A paired device on the remote profile, subscribed to the conversation. */
async function connectPhone(target: TestHost, capabilities?: readonly RemoteCapability[]): Promise<RemotePhone> {
	const pair = createIrohStreamPair();
	const conversation = target.conversation;
	const connection = serveIrohRemoteConnection({
		host: target.host,
		conversation,
		stream: pair.host,
		grant:
			capabilities === undefined
				? createIrohRemotePresetAccess("coding").rpcGrant
				: createIrohRemoteRpcGrant(capabilities),
		redaction: { workspacePath: conversation.cwd },
	});
	const phone = connectRemotePhone(pair.phone);
	connections.push(async () => {
		await phone.close();
		await connection.close().catch(() => undefined);
	});
	await phone.hello();
	await phone.subscribe(conversation.id);
	return phone;
}

/** Whether a live frame of `frames` set or cleared `work/<id>`. */
function liveWorkItems(frames: readonly HostFrame[], workId: string) {
	return frames.flatMap((frame) =>
		frame.type === "live"
			? frame.items.filter((item) => (item.type === "set" || item.type === "clear") && item.key === `work/${workId}`)
			: [],
	);
}

async function startJob(harness: Harness, command = "first") {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command, background: true }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Foreground finished."),
		// The job's completion notice wakes the idle conversation.
		fauxAssistantMessage("Noticed the job."),
	]);
	await harness.session.prompt(`Launch ${command}`);
	return harness.session.jobs.list().find((job) => job.label === command)!;
}

afterEach(async () => {
	for (const worker of workers.splice(0)) worker.resolve();
	for (const close of connections.splice(0)) await close();
	for (const target of hosts.splice(0)) await target.host.dispose();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	vi.restoreAllMocks();
});

describe("background jobs over protocol frames", () => {
	it("shows a job as a work item and reads its output without consuming it or running inference", async () => {
		const { harness, target, executions } = await setup();
		const { client, frames } = await connect(target);
		const job = await startJob(harness);
		await vi.waitFor(() =>
			expect(client.state.work.get(job.id)).toMatchObject({ kind: "job", state: "running", cancellable: true }),
		);
		expect(client.live.values.get(`work/${job.id}`)).toMatchObject({ kind: "work", workId: job.id });
		await client.waitForIdle();
		expect(client.phase).toMatchObject({ busy: false });
		const read = await client.query("work_output", { workId: job.id });
		expect(read).toMatchObject({ final: false });
		expect(read.text).toContain("output for first");
		executions.get("first")!.output("\u001b[31mnew output\u001b[0m\r\n\u0000");
		await vi.waitFor(async () =>
			expect((await client.query("work_output", { workId: job.id })).text).toContain("new output\n"),
		);
		expect((await client.query("work_output", { workId: job.id })).text).not.toContain("\u001b");
		// Reading output runs no inference.
		expect(harness.faux.state.callCount).toBe(2);
		executions.get("first")!.finish();
		await harness.session.work.waitForIdle();
		await vi.waitFor(() => expect(client.state.work.get(job.id)).toMatchObject({ outcome: "completed" }));
		const completed = await client.query("work_output", { workId: job.id });
		expect(completed).toMatchObject({ final: true });
		expect(completed.text).toContain("new output");
		expect(await client.query("work_output", { workId: job.id })).toEqual(completed);
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(3);
		await vi.waitFor(() => expect(client.live.values.has(`work/${job.id}`)).toBe(false));
		// The live value carries no output text, and is cleared once the job finished.
		expect(liveWorkItems(frames, job.id).at(-1)).toMatchObject({ type: "clear" });
		expect(JSON.stringify(liveWorkItems(frames, job.id))).not.toContain("output for first");
	});

	it("cancels only one job and reports cancelling until cleanup finishes", async () => {
		const { harness, target, executions } = await setup();
		const { client } = await connect(target);
		const first = await startJob(harness);
		const second = await startJob(harness, "second");
		await client.intent("cancel_work", { workId: first.id });
		expect(executions.get("first")!.signal?.aborted).toBe(true);
		expect(executions.get("second")!.signal?.aborted).toBe(false);
		await vi.waitFor(() => expect(client.state.work.get(first.id)).toMatchObject({ state: "cancelling" }));
		expect(client.state.work.get(first.id)?.outcome).toBeUndefined();
		executions.get("first")!.finish();
		await vi.waitFor(() => expect(client.state.work.get(first.id)).toMatchObject({ outcome: "cancelled" }));
		expect(client.state.work.get(second.id)).toMatchObject({ state: "running" });
		await expect(client.intent("cancel_work", { workId: first.id })).rejects.toMatchObject({
			reason: { code: "unavailable" },
		});
	});

	it("keeps the abort intent enabled while only jobs remain, and abort cancels them", async () => {
		const { harness, target, executions } = await setup();
		const { client } = await connect(target);
		await startJob(harness);
		await client.waitForIdle();
		const { intents } = await client.query("intents");
		expect(intents.find((intent) => intent.name === "abort")?.enabled).toBe(true);
		const abort = client.intent("abort", {});
		await vi.waitFor(() => expect(executions.get("first")!.signal?.aborted).toBe(true));
		executions.get("first")!.finish();
		await expect(abort).resolves.toMatchObject({ type: "accepted" });
		expect(harness.session.hasRunningWork).toBe(false);
		expect(harness.session.jobs.list()).toMatchObject([{ status: "cancelled" }]);
	});

	it.each(["jobs", "bash"])(
		"cancels a job when the %s tool grant is removed, keeping its output readable",
		async (removed) => {
			const { harness, target, executions } = await setup();
			const { client } = await connect(target);
			const job = await startJob(harness);
			await vi.waitFor(() => expect(client.state.work.get(job.id)).toBeDefined());
			harness.session.setActiveToolsByName(["bash", "jobs"].filter((name) => name !== removed));
			await vi.waitFor(() => expect(executions.get("first")!.signal?.aborted).toBe(true));
			executions.get("first")!.finish();
			await vi.waitFor(() => expect(client.state.work.get(job.id)).toMatchObject({ outcome: "cancelled" }));
			expect((await client.query("work_output", { workId: job.id })).final).toBe(true);
		},
	);

	it("serves jobs to every subscriber, reads with observation, and cancels only with control", async () => {
		const { harness, target, executions } = await setup();
		const job = await startJob(harness);
		const { client: first } = await connect(target);
		const observer = await connectPhone(target, ["conversation.observe.v1"]);
		const controller = await connectPhone(target);
		// Each subscriber's live reset carries the running job.
		expect(first.live.values.get(`work/${job.id}`)).toMatchObject({ kind: "work" });
		for (const phone of [observer, controller]) {
			expect(liveWorkItems(phone.frames, job.id).at(-1)).toMatchObject({ type: "set" });
			expect(await phone.query("work_output", { workId: job.id })).toMatchObject({
				type: "result",
				data: { workId: job.id, final: false },
			});
		}
		expect(await observer.intent("cancel_work", { workId: job.id })).toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed", requiredCapability: "conversation.control.v1" },
		});
		expect(executions.get("first")!.signal?.aborted).toBe(false);

		// The job outlives the client that saw it start.
		await first.stop();
		expect(harness.session.hasRunningWork).toBe(true);
		executions.get("first")!.finish();
		await harness.session.work.waitForIdle();
		for (const phone of [observer, controller]) {
			await vi.waitFor(() => expect(liveWorkItems(phone.frames, job.id).at(-1)).toMatchObject({ type: "clear" }));
		}
		await harness.session.waitForIdle();
		const { client: third } = await connect(target);
		expect(third.state.work.get(job.id)).toMatchObject({ kind: "job", outcome: "completed" });
	});

	it("bounds multibyte output reads without putting the output into the live state", async () => {
		const { harness, target, executions } = await setup();
		const job = await startJob(harness);
		const phone = await connectPhone(target);
		executions.get("first")!.output("界".repeat(25_000));
		// Native Bash coalesces progress before it reaches the job.
		await vi.waitFor(() => expect(harness.session.jobs.get(job.id).outputTruncated).toBe(true));
		const read = await phone.query("work_output", { workId: job.id });
		if (read.type !== "result") throw new Error(`Expected a result, got ${JSON.stringify(read)}`);
		const output = read.data as { text: string; truncated: boolean; nextOffset: number | null };
		expect(output.truncated).toBe(true);
		expect(Buffer.byteLength(output.text, "utf8")).toBeLessThanOrEqual(50 * 1024);
		expect(output.text).not.toContain("�");
		expect(JSON.stringify(liveWorkItems(phone.frames, job.id))).not.toContain("界");
	});

	it("leaves the jobs behind when the client moves to a new session", async () => {
		const { harness, target, executions } = await setup();
		const { client } = await connect(target);
		const job = await startJob(harness);
		executions.get("first")!.finish();
		await harness.session.work.waitForIdle();
		await harness.session.waitForIdle();
		const moved = await client.intent("new_session", {});
		expect(moved.conversation).toBeDefined();
		await vi.waitFor(() => expect(client.conversation).toBe(moved.conversation));
		await client.caughtUp();
		expect(client.state.work.size).toBe(0);
		await expect(client.query("work_output", { workId: job.id })).rejects.toThrow("Unknown work");
	});
});
