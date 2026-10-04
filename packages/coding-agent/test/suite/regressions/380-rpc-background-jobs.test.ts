import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { HostFrame, LiveValue, RemoteCapability } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient, type LoopbackClient, type ProtocolClient } from "../../../src/client/protocol-client.ts";
import type { AgentSessionServices } from "../../../src/core/agent-session-services.ts";
import { createIrohRemotePresetAccess, createIrohRemoteRpcGrant } from "../../../src/core/remote/iroh/access-grant.ts";
import { serveIrohRemoteConnection } from "../../../src/core/remote/iroh/connection.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import * as nativeTools from "../../../src/core/tools/index.ts";
import { adoptTestSession, connectTestClient, type TestHost } from "../../utilities/host-client.ts";
import { createIrohStreamPair } from "../../utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "../../utilities/remote-phone.ts";
import { createHarness, type Harness } from "../harness.ts";

type JobsValue = Extract<LiveValue, { kind: "jobs" }>;

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

/** The jobs every live frame of `frames` set, in order. */
function jobsValues(frames: readonly HostFrame[]): JobsValue["jobs"][] {
	return frames.flatMap((frame) =>
		frame.type === "live"
			? frame.items.flatMap((item) => (item.type === "set" && item.value.kind === "jobs" ? [item.value.jobs] : []))
			: [],
	);
}

function liveJobs(client: ProtocolClient): JobsValue["jobs"] | undefined {
	const value = client.live.values.get("jobs");
	return value?.kind === "jobs" ? value.jobs : undefined;
}

async function startJob(harness: Harness, command = "first") {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command, background: true }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Foreground finished."),
	]);
	await harness.session.prompt(`Launch ${command}`);
	return harness.session.backgroundJobs.list().find((job) => job.label === command)!;
}

afterEach(async () => {
	for (const worker of workers.splice(0)) worker.resolve();
	for (const close of connections.splice(0)) await close();
	for (const target of hosts.splice(0)) await target.host.dispose();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	vi.restoreAllMocks();
});

describe("background jobs over protocol frames", () => {
	it("shows live job metadata and reads live output after foreground settlement without consuming results or running inference", async () => {
		const { harness, target, executions } = await setup();
		const { client, frames } = await connect(target);
		const job = await startJob(harness);
		await vi.waitFor(() =>
			expect(liveJobs(client)).toEqual([expect.objectContaining({ id: job.id, status: "running" })]),
		);
		await client.waitForIdle();
		expect(client.phase).toMatchObject({ busy: false });
		const read = await client.query("job_output", { jobId: job.id });
		expect(read.job.output).toContain("output for first");
		executions.get("first")!.output("\u001b[31mnew output\u001b[0m\r\n\u0000");
		await vi.waitFor(async () =>
			expect((await client.query("job_output", { jobId: job.id })).job.output).toContain("new output\n"),
		);
		expect((await client.query("job_output", { jobId: job.id })).job.output).not.toContain("\u001b");
		executions.get("first")!.finish();
		await harness.session.waitForBackgroundJobs();
		const completed = await client.query("job_output", { jobId: job.id });
		expect(completed.job.status).toBe("completed");
		expect(await client.query("job_output", { jobId: job.id })).toEqual(completed);
		// Reading a job neither collects its result nor runs inference.
		expect(harness.session.backgroundJobs.listUncollected()).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
		await vi.waitFor(() => expect(liveJobs(client)).toEqual([expect.objectContaining({ status: "completed" })]));
		// The live value is metadata only: output stays behind job_output.
		for (const jobs of jobsValues(frames)) for (const value of jobs) expect(value).not.toHaveProperty("output");
	});

	it("cancels only one job and reports cancelling until cleanup finishes", async () => {
		const { harness, target, executions } = await setup();
		const { client } = await connect(target);
		const first = await startJob(harness);
		const second = await startJob(harness, "second");
		const cancelled = await client.intent("cancel_job", { jobId: first.id });
		expect(cancelled.result?.job.status).toBe("cancelling");
		expect(executions.get("first")!.signal?.aborted).toBe(true);
		expect(executions.get("second")!.signal?.aborted).toBe(false);
		expect((await client.query("job_output", { jobId: first.id })).job.status).toBe("cancelling");
		executions.get("first")!.finish();
		await vi.waitFor(async () =>
			expect((await client.query("job_output", { jobId: first.id })).job.status).toBe("cancelled"),
		);
		expect((await client.query("job_output", { jobId: second.id })).job.status).toBe("running");
		expect((await client.intent("cancel_job", { jobId: first.id })).result?.job.status).toBe("cancelled");
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
		await harness.session.waitForBackgroundJobs();
		expect(harness.session.hasBackgroundJobs).toBe(false);
	});

	it.each(["jobs", "bash"])("hides and rejects jobs when the %s tool grant is removed", async (removed) => {
		const { harness, target, executions } = await setup();
		const { client } = await connect(target);
		const job = await startJob(harness);
		await vi.waitFor(() => expect(liveJobs(client)).toHaveLength(1));
		harness.session.setActiveToolsByName(["bash", "jobs"].filter((name) => name !== removed));
		await vi.waitFor(() => expect(liveJobs(client)).toEqual([]));
		await expect(client.query("job_output", { jobId: job.id })).rejects.toThrow("inaccessible");
		await expect(client.intent("cancel_job", { jobId: job.id })).rejects.toThrow("inaccessible");
		expect(executions.get("first")!.signal?.aborted).toBe(true);
	});

	it("serves retained jobs to every subscriber, reads with observation, and cancels only with control at the device's position", async () => {
		const { harness, target, executions } = await setup();
		const job = await startJob(harness);
		const { client: first } = await connect(target);
		const observer = await connectPhone(target, ["conversation.observe.v1"]);
		const controller = await connectPhone(target);
		// Each subscriber's live reset carries the retained job.
		expect(liveJobs(first)).toEqual([expect.objectContaining({ id: job.id, status: "running" })]);
		for (const phone of [observer, controller]) {
			expect(jobsValues(phone.frames).at(-1)).toEqual([expect.objectContaining({ id: job.id, status: "running" })]);
			expect(await phone.query("job_output", { jobId: job.id })).toMatchObject({
				type: "result",
				data: { job: { id: job.id, status: "running" } },
			});
		}
		expect(await observer.intent("cancel_job", { jobId: job.id })).toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed", requiredCapability: "conversation.control.v1" },
		});
		// A device cancels at the position it saw: a branch-fenced intent without one is refused.
		expect(await controller.intent("cancel_job", { jobId: job.id }, { expectedOrdinal: null })).toMatchObject({
			type: "rejected",
			reason: { code: "invalid_input" },
		});
		expect(executions.get("first")!.signal?.aborted).toBe(false);

		// The job outlives the client that saw it start.
		await first.stop();
		expect(harness.session.hasBackgroundJobs).toBe(true);
		executions.get("first")!.finish();
		await harness.session.waitForBackgroundJobs();
		for (const phone of [observer, controller]) {
			await vi.waitFor(() =>
				expect(jobsValues(phone.frames).at(-1)).toEqual([
					expect.objectContaining({ id: job.id, status: "completed" }),
				]),
			);
			for (const jobs of jobsValues(phone.frames))
				for (const value of jobs) expect(value).not.toHaveProperty("output");
		}
		const { client: third } = await connect(target);
		expect(liveJobs(third)).toEqual([expect.objectContaining({ id: job.id, status: "completed" })]);
	});

	it("bounds multibyte output reads without putting the output into the live state", async () => {
		const { harness, target, executions } = await setup();
		const job = await startJob(harness);
		const phone = await connectPhone(target);
		executions.get("first")!.output("界".repeat(25_000));
		// Native Bash coalesces progress before it reaches the job manager.
		await vi.waitFor(() => expect(harness.session.backgroundJobs.get(job.id).outputTruncated).toBe(true));
		const read = await phone.query("job_output", { jobId: job.id });
		if (read.type !== "result") throw new Error(`Expected a result, got ${JSON.stringify(read)}`);
		const snapshot = (read.data as { job: { output: string; outputTruncated: boolean } }).job;
		expect(snapshot.outputTruncated).toBe(true);
		expect(Buffer.byteLength(snapshot.output, "utf8")).toBeLessThanOrEqual(50 * 1024);
		expect(snapshot.output).not.toContain("�");
		await vi.waitFor(() =>
			expect(jobsValues(phone.frames).at(-1)).toEqual([expect.objectContaining({ outputTruncated: true })]),
		);
		for (const jobs of jobsValues(phone.frames)) for (const value of jobs) expect(value).not.toHaveProperty("output");
	});

	it("clears job handles when the client moves to a new session rather than reconstructing them from history", async () => {
		const { harness, target, executions } = await setup();
		const { client } = await connect(target);
		const job = await startJob(harness);
		executions.get("first")!.finish();
		await harness.session.waitForBackgroundJobs();
		const moved = await client.intent("new_session", {});
		expect(moved.conversation).toBeDefined();
		await vi.waitFor(() => expect(client.conversation).toBe(moved.conversation));
		await client.caughtUp();
		expect(liveJobs(client)).toEqual([]);
		await expect(client.query("job_output", { jobId: job.id })).rejects.toThrow("inaccessible");
	});
});
