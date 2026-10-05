/**
 * Work in hosted conversations (RFC §7): the host reconciles the work a
 * previous runtime left before `session_start`, delivery wakes an idle
 * conversation, closing interrupts running work and leaves resumable work
 * suspended, the work intents and `work_output` on the local and remote
 * profiles, the remote projection of work entries, the write authority over
 * work entries, and quiet notices across a restart.
 */

import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
	CONTENT_TEXT_MAX_SCALARS,
	type HostFrame,
	type ProjectedEntry,
	type QueryResult,
	REMOTE_CAPABILITIES,
	type RemoteGrant,
	WORK_CHECKPOINT_MAX_SERIALIZED_BYTES,
	WORK_NOTICE_CUSTOM_TYPE,
	WORK_OUTPUT_MAX_UTF8_BYTES,
	WORK_TEXT_MAX_CHARS,
	WORK_TITLE_MAX_CHARS,
} from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient, ProtocolQueryError, ProtocolRejectedError } from "../../src/client/protocol-client.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { localProfile } from "../../src/core/protocol/profiles.ts";
import { sessionProjectionSource } from "../../src/core/protocol/projection/entries.ts";
import { projectTranscriptItem } from "../../src/core/protocol/projection/transcript.ts";
import { serveIrohRemoteConnection } from "../../src/core/remote/iroh/connection.ts";
import {
	assertCurrentSessionSnapshot,
	type CommittedSessionEntry,
	CURRENT_SESSION_SNAPSHOT_VERSION,
	CURRENT_SESSION_VERSION,
	loadEntriesFromFile,
	SessionManager,
} from "../../src/core/session-manager.ts";
import type { WorkExecution, WorkExecutor, WorkKindDefinition } from "../../src/core/work/registry.ts";
import { closeLocalSessionManager } from "../../src/daemon/session-worktree.ts";
import { createIrohStreamPair } from "../utilities/iroh-stream-pair.ts";
import { connectRemotePhone } from "../utilities/remote-phone.ts";
import { seedSession } from "../utilities/seed-log.ts";
import { createHostHarness, type HostHarness } from "./host-harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function harnessFor(responses: string[] = []): Promise<HostHarness> {
	const harness = await createHostHarness({ whenUnattached: "keep", responses });
	cleanups.push(() => harness.cleanup());
	return harness;
}

function kind(overrides: Partial<WorkKindDefinition> = {}): WorkKindDefinition {
	return {
		kind: "ext:test/run",
		delivery: "none",
		cancellable: true,
		maxActive: 4,
		title: () => "Test work",
		...overrides,
	};
}

/** An executor that runs until it is released or aborted. */
function held(): { execute: WorkExecutor; release(execution?: WorkExecution): void } {
	const release = Promise.withResolvers<WorkExecution>();
	return {
		execute: async (ctx) => {
			ctx.signal.addEventListener("abort", () => release.resolve({ outcome: "cancelled" }), { once: true });
			return await release.promise;
		},
		release: (execution = { outcome: "completed" }) => release.resolve(execution),
	};
}

function workTypes(conversation: HostedConversation): string[] {
	return conversation.session.sessionManager
		.committedEntriesAfter(0)
		.filter((entry) => entry.type.startsWith("work_"))
		.map((entry) => entry.type);
}

describe("work in hosted conversations", () => {
	it("settles the previous runtime's open work when the host opens the conversation, before session_start", async () => {
		const harness = await harnessFor();
		const manager = await SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions"));
		const started = {
			kind: "job",
			title: "npm test",
			input: { command: "npm test" },
			cancellable: true,
			delivery: "wake",
			resume: false,
			state: "running",
		};
		await seedSession(manager, (log) => {
			log.user("hello").assistant("hi");
			log.hostRecord("work_started", { ...started, workId: "job-1" });
			log.hostRecord("work_started", {
				...started,
				workId: "child-1",
				kind: "subagent",
				delivery: "none",
				resume: true,
			});
		});
		const opened = await harness.host.open({ kind: "adopt", sessionManager: manager });
		if (opened.cancelled) throw new Error("Expected the conversation to open");
		const conversation = opened.conversation;
		// Reconciled during the open: no client attached and no session_start fired yet.
		expect(harness.events.filter((event) => event.sessionId === conversation.id)).toEqual([]);
		expect(conversation.work.get("job-1")).toMatchObject({ outcome: "interrupted" });
		expect(conversation.work.get("child-1")?.outcome).toBeUndefined();
		expect(conversation.work.running()).toEqual([]);
		await harness.host.attach(harness.client("tui"), conversation);
		expect(harness.events.filter((event) => event.sessionId === conversation.id).map((event) => event.type)).toEqual([
			"session_start",
		]);
		// The suspended child is cancelled without an executor.
		await conversation.work.cancel("child-1");
		expect(conversation.work.get("child-1")).toMatchObject({ outcome: "cancelled" });
	});

	it("queues a wake notice that starts a turn on the idle conversation", async () => {
		const harness = await harnessFor(["noticed"]);
		const conversation = await harness.openStartup();
		await harness.host.attach(harness.client("tui"), conversation);
		conversation.work.register(kind({ kind: "ext:test/wake", delivery: "wake", title: () => "echo done" }));
		const record = await conversation.work.start("ext:test/wake", { command: "echo done" }, async (ctx) => {
			ctx.output("done\n");
			return { outcome: "completed", result: { summary: "echoed" } };
		});
		await conversation.work.waitForIdle();
		await vi.waitFor(() => expect(conversation.session.messages.at(-1)?.role).toBe("assistant"));
		await conversation.session.waitForIdle();
		const notice = conversation.session.messages.find(
			(message) => message.role === "custom" && message.customType === WORK_NOTICE_CUSTOM_TYPE,
		);
		expect(notice).toMatchObject({ details: { workId: record.workId, outcome: "completed", summary: "echoed" } });
		expect(conversation.work.output(record.workId)).toEqual({ text: "done\n", truncated: false, final: true });
	});

	it("closing interrupts running work and leaves resumable work for an explicit resume after reopening", async () => {
		const harness = await harnessFor();
		const first = await harness.openStartup();
		const resumable = kind({ kind: "subagent", resume: () => async () => ({ outcome: "completed" }) });
		first.work.register(kind());
		first.work.register(resumable);
		const job = await first.work.start("ext:test/run", null, held().execute);
		const child = await first.work.start("subagent", null, held().execute);
		const ref = first.session.sessionRef;
		if (!ref) throw new Error("Expected a stored session");
		await harness.host.close(first);
		const reopened = await harness.host.open({ kind: "session", ref });
		if (reopened.cancelled) throw new Error("Expected the conversation to reopen");
		const second = reopened.conversation;
		expect(second.work.get(job.workId)).toMatchObject({ outcome: "interrupted" });
		expect(second.work.get(child.workId)?.outcome).toBeUndefined();
		second.work.register(resumable);
		const client = await createLoopbackClient(harness.host, second);
		cleanups.push(() => client.stop());
		await client.intent("resume_work", { workId: child.workId });
		await second.work.waitForIdle();
		expect(second.work.get(child.workId)).toMatchObject({ outcome: "completed" });
		await expect(client.intent("resume_work", { workId: child.workId })).rejects.toMatchObject({
			reason: { code: "unavailable" },
		});
	});

	it("serves the work intents and work_output on the local profile", async () => {
		const harness = await harnessFor();
		const conversation = await harness.openStartup();
		conversation.work.register(kind());
		conversation.work.register(kind({ kind: "ext:test/fixed", cancellable: false }));
		conversation.work.register(
			kind({ kind: "ext:test/open", open: async () => ({ conversation: "child-conversation", moved: false }) }),
		);
		const client = await createLoopbackClient(harness.host, conversation);
		cleanups.push(() => client.stop());

		const running = held();
		let output: ((text: string) => void) | undefined;
		const record = await conversation.work.start("ext:test/run", null, async (ctx) => {
			output = ctx.output;
			return await running.execute(ctx);
		});
		await vi.waitFor(() => expect(output).toBeDefined());
		output?.(`${"a".repeat(CONTENT_TEXT_MAX_SCALARS)}\u001b[31mtail\r\n`);
		const first = await client.query("work_output", { workId: record.workId });
		expect(first).toMatchObject({ offset: 0, nextOffset: CONTENT_TEXT_MAX_SCALARS, final: false });
		const rest = await client.query("work_output", { workId: record.workId, offset: CONTENT_TEXT_MAX_SCALARS });
		expect(rest).toMatchObject({ text: "tail\n", nextOffset: null, truncated: false });
		await expect(client.query("work_output", { workId: "missing" })).rejects.toBeInstanceOf(ProtocolQueryError);

		const fixed = held();
		const pinned = await conversation.work.start("ext:test/fixed", null, fixed.execute);
		const rejection = async (promise: Promise<unknown>) => {
			const error = await promise.then(
				() => undefined,
				(reason: unknown) => reason,
			);
			if (!(error instanceof ProtocolRejectedError)) throw new Error("Expected a rejected intent");
			return error.reason.code;
		};
		expect(await rejection(client.intent("cancel_work", { workId: pinned.workId }))).toBe("not_allowed");
		expect(await rejection(client.intent("cancel_work", { workId: "missing" }))).toBe("invalid_input");
		expect(await rejection(client.intent("resume_work", { workId: record.workId }))).toBe("conflict");
		expect(await rejection(client.intent("open_work", { workId: record.workId }))).toBe("unavailable");

		await client.intent("cancel_work", { workId: record.workId });
		await vi.waitFor(() => expect(conversation.work.get(record.workId)?.outcome).toBe("cancelled"));
		expect(await rejection(client.intent("cancel_work", { workId: record.workId }))).toBe("unavailable");

		const openable = await conversation.work.start("ext:test/open", null, async () => ({ outcome: "completed" }));
		const opened = await client.intent("open_work", { workId: openable.workId });
		expect(opened.result).toEqual({ conversation: "child-conversation" });
		fixed.release();
		await conversation.work.waitForIdle();
		expect(workTypes(conversation)).toContain("work_checkpoint");
	});

	it("shows a paired device work without input, locators, or output, and redacts the output it reads", async () => {
		const harness = await harnessFor();
		const workspace = harness.tempDir;
		const conversation = await harness.openStartup();
		conversation.work.register(kind());
		conversation.work.register(kind({ kind: "ext:test/fixed", cancellable: false }));
		const connect = async (grant: RemoteGrant) => {
			const pair = createIrohStreamPair();
			const connection = serveIrohRemoteConnection({
				host: harness.host,
				conversation,
				stream: pair.host,
				grant,
				redaction: { workspacePath: workspace },
				redirect: {},
			});
			const phone = connectRemotePhone(pair.phone);
			cleanups.push(async () => {
				await connection.close().catch(() => undefined);
				await phone.close();
			});
			await phone.hello();
			return phone;
		};
		const phone = await connect({ schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] });
		await phone.subscribe(conversation.id);

		const record = await conversation.work.start(
			"ext:test/run",
			{ command: `cat ${workspace}/secret.txt` },
			async (ctx) => {
				ctx.output(`read ${workspace}/secret.txt\n`);
				return {
					outcome: "completed",
					result: { summary: `checked ${workspace}`, data: { path: `${workspace}/data` } },
				};
			},
			{
				child: {
					conversation: "child-session",
					ref: {
						sessionDirectory: join(workspace, "sessions"),
						storeId: "store",
						sessionId: "child-session",
						sessionGeneration: "g1",
					},
				},
			},
		);
		await conversation.work.waitForIdle();
		const pinned = await conversation.work.start("ext:test/fixed", null, held().execute);
		const entryOf = (type: string, workId: string) =>
			phone.waitFor(
				(frame): frame is Extract<HostFrame, { type: "entry" }> =>
					frame.type === "entry" &&
					frame.entry.type === type &&
					(frame.entry.payload as { workId?: string } | undefined)?.workId === workId,
			);
		const started = (await entryOf("work_started", record.workId)).entry as ProjectedEntry & { type: "work_started" };
		expect(started.payload).toMatchObject({ input: null, child: { conversation: "child-session" } });
		expect(started.payload?.child).toEqual({ conversation: "child-session" });
		const finished = (await entryOf("work_finished", record.workId)).entry as ProjectedEntry & {
			type: "work_finished";
		};
		expect(finished.payload?.result).toEqual({
			summary: expect.stringContaining("checked"),
			output: { text: "", truncated: false },
		});
		await entryOf("work_started", pinned.workId);
		await phone.waitFor(
			(frame): frame is Extract<HostFrame, { type: "live" }> =>
				frame.type === "live" &&
				frame.items.some((item) => item.type === "set" && item.key === `work/${pinned.workId}`),
		);
		expect(JSON.stringify(phone.frames)).not.toContain(workspace);

		// A device that subscribes later folds the same item from its snapshot.
		const later = await connect({ schemaVersion: 1, revision: 1, capabilities: ["conversation.observe.v1"] });
		await later.subscribe(conversation.id);
		const snapshot = later.frames.find(
			(frame): frame is Extract<HostFrame, { type: "snapshot" }> => frame.type === "snapshot",
		);
		const item = snapshot?.state.work?.find((work) => work.workId === record.workId);
		expect(item).toMatchObject({ outcome: "completed", result: { output: { truncated: false } } });
		expect(item?.child).toEqual({ conversation: "child-session" });
		expect(JSON.stringify(later.frames)).not.toContain(workspace);

		const read = await phone.query("work_output", { workId: record.workId });
		expect(read.type).toBe("result");
		expect(JSON.stringify(read)).not.toContain(workspace);
		expect(JSON.stringify(read)).toContain("secret.txt");
		expect((await later.query("work_output", { workId: record.workId })).type).toBe("result");

		const refused = await phone.intent("cancel_work", { workId: pinned.workId });
		expect(refused).toMatchObject({ type: "rejected", reason: { code: "not_allowed" } });
		const subagent = await phone.intent("start_subagent", { agent: "explore", prompt: "look" });
		expect(subagent).toMatchObject({ type: "rejected", reason: { code: "not_allowed" } });
		const denied = await later.intent("cancel_work", { workId: record.workId });
		expect(denied).toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed", requiredCapability: "conversation.control.v1" },
		});
		await conversation.work.cancelAll("closed");
	});

	it("refuses a paired device the output of work whose extension kind the host no longer knows", async () => {
		const harness = await harnessFor();
		const conversation = await harness.openStartup();
		const remove = conversation.work.register(kind({ requires: ["conversation.observe.v1"] }));
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
			redaction: { workspacePath: harness.tempDir },
			redirect: {},
		});
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await phone.close();
		});
		await phone.hello();
		await phone.subscribe(conversation.id);
		const record = await conversation.work.start("ext:test/run", null, async (ctx) => {
			ctx.output("kept\n");
			return { outcome: "completed" };
		});
		await conversation.work.waitForIdle();
		expect((await phone.query("work_output", { workId: record.workId })).type).toBe("result");
		await remove();
		expect(await phone.query("work_output", { workId: record.workId })).toMatchObject({
			type: "query_error",
			reason: { code: "not_allowed" },
		});
		// The local profile still reads it.
		expect(conversation.work.output(record.workId)).toMatchObject({ text: "kept\n", final: true });
	});

	it("shows a paired device no part of a root that a host cut or the output bound left", async () => {
		const harness = await harnessFor();
		const workspace = harness.tempDir;
		const conversation = await harness.openStartup();
		const name = basename(workspace);
		// The title's cut falls one character into the workspace's unique name.
		const lead = "x".repeat(WORK_TITLE_MAX_CHARS - workspace.length + name.length - 3);
		conversation.work.register(kind({ title: () => `${lead} ${workspace}/file.ts` }));
		// Output whose kept tail starts inside a line, and so inside a root.
		let lines = Array.from({ length: 2_000 }, (_, index) => `${workspace}/file-${index}.ts`).join("\n");
		while (lines[lines.length - WORK_OUTPUT_MAX_UTF8_BYTES - 1] === "\n") lines += "e";
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
			redaction: { workspacePath: workspace },
			redirect: {},
		});
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await phone.close();
		});
		await phone.hello();
		await phone.subscribe(conversation.id);
		const record = await conversation.work.start("ext:test/run", null, async (ctx) => {
			ctx.output(lines);
			return {
				outcome: "failed",
				error: `${"y".repeat(WORK_TEXT_MAX_CHARS - workspace.length + 3)} ${workspace}`,
			};
		});
		await conversation.work.waitForIdle();
		expect(record.title.endsWith("…")).toBe(true);
		expect(conversation.work.get(record.workId)?.result?.output?.truncated).toBe(true);
		await phone.waitFor(
			(frame): frame is Extract<HostFrame, { type: "entry" }> =>
				frame.type === "entry" && frame.entry.type === "work_finished",
		);
		expect(record.title.endsWith(`${workspace.slice(0, -name.length + 1)}…`)).toBe(true);
		const wire = JSON.stringify(phone.frames);
		expect(wire).not.toContain(workspace.slice(0, -name.length + 1));
		const read = await phone.query("work_output", { workId: record.workId });
		if (read.type !== "result") throw new Error("Expected the output");
		const output = read.data as { text: string; truncated: boolean };
		expect(output.truncated).toBe(true);
		// The tail starts at a line, so no part of a root the cut left reaches the device.
		expect(output.text.startsWith("/workspace/file-")).toBe(true);
		const local = conversation.work.output(record.workId)?.text ?? "";
		expect(local.startsWith(workspace)).toBe(false);
	});

	it("shows a paired device work progress without a root a cut left, bounded again after redaction", async () => {
		const harness = await harnessFor();
		const workspace = harness.tempDir;
		const conversation = await harness.openStartup();
		const name = basename(workspace);
		conversation.work.register(kind());
		// Progress text and a step label a host cut one character into the workspace's unique name.
		const cutText = (lead: string) => {
			const text = `${lead} ${workspace}/file.ts`;
			const end = lead.length + 1 + workspace.length - name.length + 1;
			return `${text.slice(0, end)}…`;
		};
		const text = cutText("p".repeat(40));
		const label = cutText("s".repeat(20));
		// Detail within the checkpoint bound on the host, past it once its paths are rewritten longer.
		const items = Array.from({ length: 12 }, (_, index) => ({
			key: `path-${index}`,
			label: `Path ${index}`,
			value: `${workspace}/a/${index}`,
		}));
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
			redaction: { workspacePath: workspace, remoteWorkspacePath: `/${"w".repeat(1_000)}` },
			redirect: {},
		});
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await phone.close();
		});
		await phone.hello();
		await phone.subscribe(conversation.id);
		const running = held();
		const record = await conversation.work.start("ext:test/run", null, async (ctx) => {
			ctx.checkpoint(
				{ text, steps: [{ key: "step", label, status: "active" }] },
				{ type: "keyValue", key: "paths", items },
			);
			return await running.execute(ctx);
		});
		const checkpoint = await phone.waitFor(
			(frame): frame is Extract<HostFrame, { type: "entry" }> =>
				frame.type === "entry" && frame.entry.type === "work_checkpoint",
		);
		const live = await phone.waitFor(
			(frame): frame is Extract<HostFrame, { type: "live" }> =>
				frame.type === "live" &&
				frame.items.some((item) => item.type === "set" && item.value.kind === "work" && item.value.progress),
		);
		running.release();
		await conversation.work.waitForIdle();
		// The host kept the detail: it fit the bound before redaction.
		expect(conversation.work.get(record.workId)?.detail).toBeDefined();
		const payload = checkpoint.entry.payload as { progress?: { text?: string; steps?: Array<{ label: string }> } };
		expect(payload.progress?.text).toBe(`${"p".repeat(40)} …`);
		expect(payload.progress?.steps?.[0]?.label).toBe(`${"s".repeat(20)} …`);
		// Redaction lengthened the detail past the checkpoint bound: the device gets the progress without it.
		expect(payload).not.toHaveProperty("detail");
		expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(WORK_CHECKPOINT_MAX_SERIALIZED_BYTES);
		const value = live.items.flatMap((item) =>
			item.type === "set" && item.value.kind === "work" ? [item.value] : [],
		)[0];
		expect(value?.progress?.text).toBe(`${"p".repeat(40)} …`);
		expect(value).not.toHaveProperty("detail");
		expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(WORK_CHECKPOINT_MAX_SERIALIZED_BYTES);
		expect(JSON.stringify(phone.frames)).not.toContain(workspace.slice(0, -name.length + 1));
	});

	it("shows a paired device a work notice rebuilt from its details, without the notice's own text or a root a cut left", async () => {
		const harness = await harnessFor(["noticed"]);
		const workspace = harness.tempDir;
		const name = basename(workspace);
		const prefix = workspace.slice(0, -name.length + 1);
		// A notice delivered before this runtime, whose kind gave it its own text.
		const manager = await SessionManager.create(workspace, join(workspace, "sessions"));
		await seedSession(manager, (log) => {
			log.user("hello").assistant("hi");
			log.customMessage(WORK_NOTICE_CUSTOM_TYPE, `Wrote ${workspace}/out.txt`, true, {
				details: { workId: "w1", kind: "ext:test/custom", title: "Report", outcome: "completed" },
			});
		});
		const opened = await harness.host.open({ kind: "adopt", sessionManager: manager });
		if (opened.cancelled) throw new Error("Expected the conversation to open");
		const conversation = opened.conversation;
		await harness.host.attach(harness.client("tui"), conversation);
		// Text whose cut to `max` falls one character into the workspace's unique name.
		const cutInRoot = (max: number) => `${"x".repeat(max - workspace.length + name.length - 3)} ${workspace}/file.ts`;
		conversation.work.register(
			kind({ kind: "ext:test/wake", delivery: "wake", title: () => cutInRoot(WORK_TITLE_MAX_CHARS) }),
		);
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
			redaction: { workspacePath: workspace },
			redirect: {},
		});
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await phone.close();
		});
		await phone.hello();
		await phone.subscribe(conversation.id);

		const record = await conversation.work.start("ext:test/wake", null, async () => ({
			outcome: "completed",
			result: { summary: cutInRoot(WORK_TEXT_MAX_CHARS) },
		}));
		await conversation.work.waitForIdle();
		await vi.waitFor(() => expect(conversation.session.messages.at(-1)?.role).toBe("assistant"));
		await conversation.session.waitForIdle();
		const notices = conversation.session.sessionManager
			.committedEntriesAfter(0)
			.filter((entry) => entry.type === "custom_message" && entry.customType === WORK_NOTICE_CUSTOM_TYPE);
		expect(notices).toHaveLength(2);
		const [seeded, delivered] = notices as [CommittedSessionEntry, CommittedSessionEntry];
		// The model's notice holds the title and summary as the host cut them.
		expect(record.title.endsWith(`${prefix}…`)).toBe(true);
		expect(delivered.type === "custom_message" && delivered.content).toBe(
			`${record.title} (ext:test/wake ${record.workId}) completed.\n${cutInRoot(WORK_TEXT_MAX_CHARS).slice(0, WORK_TEXT_MAX_CHARS - 1)}…`,
		);
		// A local client is sent the notice's own text.
		const source = sessionProjectionSource(conversation.session.sessionManager);
		expect(projectTranscriptItem(seeded, source, localProfile)?.text).toBe(`Wrote ${workspace}/out.txt`);

		const lead = (max: number) => "x".repeat(max - workspace.length + name.length - 3);
		const expected = new Map([
			[seeded.id, "Report (ext:test/custom w1) completed."],
			[
				delivered.id,
				`${lead(WORK_TITLE_MAX_CHARS)} … (ext:test/wake ${record.workId}) completed.\n${lead(WORK_TEXT_MAX_CHARS)} …`,
			],
		]);
		await phone.waitFor(
			(frame): frame is Extract<HostFrame, { type: "entry" }> =>
				frame.type === "entry" && frame.entry.id === delivered.id,
		);
		const views = phone.frames.flatMap((frame) =>
			frame.type === "snapshot"
				? frame.state.entries
				: frame.type === "entry" && frame.entry.type === "custom_message"
					? [frame.entry]
					: [],
		);
		for (const [id, text] of expected) {
			const projected = views.find((entry) => entry.id === id);
			expect(projected && "view" in projected ? projected.view : undefined).toEqual({
				role: "system",
				text,
				truncated: false,
			});
			const read = await phone.query("content", { entryId: id });
			if (read.type !== "result") throw new Error("Expected the notice's content");
			expect((read.data as QueryResult<"content">).content).toMatchObject({ type: "text", text });
		}
		const wire = JSON.stringify(phone.frames);
		expect(wire).not.toContain(JSON.stringify(prefix).slice(1, -1));
		expect(wire).not.toContain("out.txt");
	});

	it("never carries work entries into a fork, a clone, or an import", async () => {
		const harness = await harnessFor(["reply"]);
		const conversation = await harness.openStartup();
		conversation.work.register(kind());
		await conversation.session.prompt("hello");
		await conversation.work.start("ext:test/run", null, async () => ({ outcome: "completed" }));
		await conversation.work.waitForIdle();
		const source = conversation.session.sessionManager;
		expect(workTypes(conversation)).toEqual(["work_started", "work_finished"]);
		const leafId = source.getLeafId();
		if (!leafId) throw new Error("Expected a branch");
		const branched = await SessionManager.createBranched(source, leafId);
		cleanups.push(() => closeLocalSessionManager(branched));
		expect(branched.committedEntriesAfter(0).filter((entry) => entry.type.startsWith("work_"))).toEqual([]);

		// A snapshot file that holds a work entry is not a valid import.
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			snapshotVersion: CURRENT_SESSION_SNAPSHOT_VERSION,
			id: "imported",
			timestamp: new Date().toISOString(),
			cwd: harness.tempDir,
		};
		const work = source.committedEntriesAfter(0).find((entry) => entry.type === "work_started");
		const path = join(harness.tempDir, "with-work.jsonl");
		writeFileSync(path, `${[header, work].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		expect(() => assertCurrentSessionSnapshot(loadEntriesFromFile(path))).toThrow(
			/unsupported host-only entry: work_started/,
		);
	});

	it("keeps a quiet notice queued across a restart without replaying it or fencing fresh input", async () => {
		const harness = await harnessFor(["answer"]);
		const manager = await SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions"));
		const notice = {
			role: "custom" as const,
			customType: WORK_NOTICE_CUSTOM_TYPE,
			content: "Sweep (ext:test/run w1) completed.",
			display: true,
			details: { workId: "w1", kind: "ext:test/run", title: "Sweep", outcome: "completed" },
			timestamp: Date.now(),
		};
		await seedSession(manager, (log) => {
			log.user("hello").assistant("hi");
			log.clientInput("host-notice-1", "steer", { message: "" }, { origin: "host" });
			log.hostRecord("client_input_queued", {
				receiptId: log.lastId,
				clientMessageId: "host-notice-1",
				queuedInput: { delivery: "steer", message: "", images: [], messages: [notice], wake: false },
			});
		});
		const opened = await harness.host.open({ kind: "adopt", sessionManager: manager });
		if (opened.cancelled) throw new Error("Expected the conversation to open");
		const conversation = opened.conversation;
		await harness.host.attach(harness.client("tui"), conversation);
		await conversation.startRecoveredClientInputs();
		expect(harness.faux.state.callCount).toBe(0);
		expect(() => conversation.assertCanLeave()).not.toThrow();
		await conversation.session.prompt("next");
		await conversation.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(1);
		// The quiet notice rode the turn the prompt made.
		expect(
			conversation.session.messages.some(
				(message) => message.role === "custom" && message.customType === WORK_NOTICE_CUSTOM_TYPE,
			),
		).toBe(true);
	});
});
