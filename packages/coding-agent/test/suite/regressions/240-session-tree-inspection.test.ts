import { join } from "node:path";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import {
	clientActiveBranch,
	clientFold,
	HISTORY_PAGE_MAX_ENTRIES,
	IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
	type ProjectedEntry,
	type QueryResult,
	REMOTE_CAPABILITIES,
	type RemoteCapability,
	type RemoteGrant,
	type TranscriptItem,
} from "@hansjm10/volt-protocol";
import { afterEach, expect, test } from "vitest";
import type { HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import { serveIrohRemoteConnection } from "../../../src/core/remote/iroh/connection.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createIrohStreamPair } from "../../utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "../../utilities/remote-phone.ts";
import { type LogSeed, type SeedModel, seedSession } from "../../utilities/seed-log.ts";
import { createHostHarness } from "../host-harness.ts";

/** The model the saved assistant messages name. */
const TEST_MODEL: SeedModel = { api: "test-api", provider: "test-provider", id: "test-model" };

function grantOf(...capabilities: RemoteCapability[]): RemoteGrant {
	return { schemaVersion: 1, revision: 1, capabilities };
}

const ALL = grantOf(...REMOTE_CAPABILITIES);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Inspection {
	readonly conversation: HostedConversation;
	/** The conversation's workspace, as the host knows it. */
	readonly workspace: string;
	/** A paired device on the conversation's stream, after hello. */
	readonly phone: RemotePhone;
	/** Another device on the same conversation, with `grant`. */
	connect(grant: RemoteGrant): Promise<RemotePhone>;
}

/**
 * A hosted conversation over a log seeded before its session opens (a live
 * session refuses leaf moves), and a phone on its remote stream.
 */
async function inspect(seed?: (seed: LogSeed, workspace: string) => unknown): Promise<Inspection> {
	const harness = await createHostHarness({ whenUnattached: "keep" });
	cleanups.push(() => harness.cleanup());
	const workspace = harness.tempDir;
	const sessionManager = await SessionManager.create(workspace, join(workspace, "sessions"));
	if (seed) await seedSession(sessionManager, (log) => seed(log, workspace));
	const opened = await harness.host.open({ kind: "adopt", sessionManager });
	if (opened.cancelled) throw new Error("Expected the seeded conversation to open");
	const conversation = opened.conversation;
	const connect = async (grant: RemoteGrant): Promise<RemotePhone> => {
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
	return { conversation, workspace, phone: await connect(ALL), connect };
}

async function history(
	phone: RemotePhone,
	params: { before: number; limit: number; branch?: string },
): Promise<QueryResult<"history">> {
	const outcome = await phone.query("history", params);
	if (outcome.type !== "result") throw new Error(`Expected a history page: ${JSON.stringify(outcome)}`);
	return outcome.data as QueryResult<"history">;
}

/** Every projected entry of the conversation, every branch, paged back from its head `limit` at a time. */
async function wholeLog(
	phone: RemotePhone,
	conversation: HostedConversation,
	limit = HISTORY_PAGE_MAX_ENTRIES,
): Promise<{ entries: ProjectedEntry[]; pages: QueryResult<"history">[] }> {
	const pages: QueryResult<"history">[] = [];
	let before = conversation.session.sessionManager.getOrdinal() + 1;
	for (;;) {
		const page = await history(phone, { before, limit });
		pages.unshift(page);
		if (!page.earlier || page.entries.length === 0) break;
		before = page.entries[0]!.ordinal;
	}
	return { entries: pages.flatMap((page) => page.entries), pages };
}

async function content(phone: RemotePhone, params: { entryId: string; part?: number; offset?: number }) {
	const outcome = await phone.query("content", params);
	if (outcome.type !== "result") throw new Error(`Expected entry content: ${JSON.stringify(outcome)}`);
	return outcome.data as QueryResult<"content">;
}

/** The image parts of an entry, fetched part by part as a client does. */
async function imagesOf(phone: RemotePhone, entryId: string) {
	const first = await content(phone, { entryId });
	const images: Array<{ part: number; mimeType: string; data: string }> = [];
	for (let part = 0; part < first.parts; part++) {
		const answer = part === 0 ? first : await content(phone, { entryId, part });
		if (answer.content.type === "image") {
			images.push({ part, mimeType: answer.content.mimeType, data: answer.content.data });
		}
	}
	return images;
}

function viewOf(entry: ProjectedEntry | undefined): TranscriptItem | undefined {
	return entry !== undefined && "view" in entry ? entry.view : undefined;
}

/** The ids on the active branch, as the client's fold of the projected log determines it. */
function activeBranchIds(entries: readonly ProjectedEntry[]): Set<string> {
	return new Set(clientActiveBranch(clientFold(entries)).map((entry) => entry.id));
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

test("history pages the redacted branch topology of every branch without raw session entries", async () => {
	const [rootId, inactiveId, structuralId, activeId] = ["root", "inactive", "structural", "active"];
	const { conversation, workspace, phone } = await inspect((seed, cwd) =>
		seed
			.user(`inspect ${join(cwd, "secret.txt")}`, { id: rootId, timestamp: 1 })
			.assistant("old branch", { id: inactiveId, model: TEST_MODEL, timestamp: 2 })
			.leaf(rootId)
			.custom("provider-private", { providerPayload: "must-not-cross-wire" }, { id: structuralId })
			.assistant("active branch", { id: activeId, model: TEST_MODEL, timestamp: 3 }),
	);

	const { entries, pages } = await wholeLog(phone, conversation, 2);
	expect(pages.length).toBeGreaterThan(1);
	expect(pages[0]!.earlier).toBe(false);
	for (const page of pages.slice(1)) expect(page.earlier).toBe(true);
	for (const page of pages) expect(page.entries.length).toBeLessThanOrEqual(2);

	const ordinals = entries.map((entry) => entry.ordinal);
	expect(ordinals).toEqual([...ordinals].sort((left, right) => left - right));
	expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
	const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.id);
	expect(messages).toEqual([rootId, inactiveId, activeId]);
	// The extension's entry stays on the host; the tree hangs its child off the nearest projected ancestor.
	expect(entries.map((entry) => entry.id)).not.toContain(structuralId);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	expect(byId.get(inactiveId)?.parentId).toBe(rootId);
	expect(byId.get(activeId)?.parentId).toBe(rootId);
	const active = activeBranchIds(entries);
	expect(active.has(rootId)).toBe(true);
	expect(active.has(activeId)).toBe(true);
	expect(active.has(inactiveId)).toBe(false);

	const wire = JSON.stringify(pages);
	expect(wire).not.toContain("must-not-cross-wire");
	expect(wire).not.toContain(workspace);
	expect(viewOf(byId.get(rootId))?.text).toBe("inspect /workspace/secret.txt");
});

test("a history page projects transcript content only for the entries it returns", async () => {
	const { conversation, phone } = await inspect();
	const sessionManager = conversation.session.sessionManager;
	const firstId = await conversation.session.sessionWriter.appendMessage({
		role: "user",
		content: "first",
		timestamp: 1,
	});
	const offPageId = await conversation.session.sessionWriter.appendMessage({
		role: "user",
		content: "off-page",
		timestamp: 2,
	});
	const offPageEntry = sessionManager.getCommittedEntry(offPageId);
	if (offPageEntry?.type !== "message") throw new Error("Expected the off-page message entry");
	let offPageContentReads = 0;
	Object.defineProperty(offPageEntry.message, "content", {
		configurable: true,
		get: () => {
			offPageContentReads++;
			return "off-page";
		},
	});

	const page = await history(phone, { before: offPageEntry.ordinal, limit: 1 });
	expect(page.entries).toHaveLength(1);
	expect(page.entries[0]).toMatchObject({ id: firstId, view: { text: "first" } });
	expect(page.earlier).toBe(true);
	expect(offPageContentReads).toBe(0);

	// The page that holds it does read it.
	const next = await history(phone, { before: offPageEntry.ordinal + 1, limit: 1 });
	expect(next.entries[0]).toMatchObject({ id: offPageId, view: { text: "off-page" } });
	expect(offPageContentReads).toBeGreaterThan(0);
});

test("tool results resolve reused tool-call ids within each branch", async () => {
	const toolCallId = "call_1";
	const [rootId, branchAResultId, branchALaterResultId, branchBCallId, branchBResultId] = [
		"root",
		"branch-a-result",
		"branch-a-later-result",
		"branch-b-call",
		"branch-b-result",
	];
	const { conversation, phone } = await inspect((seed) => {
		const readCall = (path: string, timestamp: number, id?: string) =>
			seed.assistant("", {
				toolCalls: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path } }],
				model: TEST_MODEL,
				timestamp,
				...(id === undefined ? {} : { id }),
			});
		const readResult = (timestamp: number, id: string) => seed.toolResult(toolCallId, "ok", { timestamp, id });
		seed.user("root", { id: rootId, timestamp: 1 });
		readCall("branch-a.txt", 2);
		readResult(3, branchAResultId);
		readCall("branch-a-later.txt", 4);
		readResult(5, branchALaterResultId);
		seed.leaf(rootId);
		readCall("branch-b.txt", 6, branchBCallId);
		readResult(7, branchBResultId);
	});

	const { entries } = await wholeLog(phone, conversation);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const active = activeBranchIds(entries);
	const expected: Array<[string, string, boolean]> = [
		[branchAResultId, "branch-a.txt", false],
		[branchALaterResultId, "branch-a-later.txt", false],
		[branchBResultId, "branch-b.txt", true],
	];
	for (const [entryId, path, onActiveBranch] of expected) {
		expect(active.has(entryId)).toBe(onActiveBranch);
		// Each result presents with the call of its own branch.
		expect(viewOf(byId.get(entryId))).toMatchObject({ role: "tool", text: `read ${path} (completed)` });
	}

	// A page holding only the result still resolves its call from the log.
	const branchBResult = byId.get(branchBResultId);
	if (!branchBResult) throw new Error(`Expected entry ${branchBResultId}`);
	expect(byId.get(branchBCallId)?.ordinal).toBe(branchBResult.ordinal - 1);
	const resultPage = await history(phone, { before: branchBResult.ordinal + 1, limit: 1 });
	expect(resultPage.entries).toEqual([
		expect.objectContaining({
			id: branchBResultId,
			view: expect.objectContaining({ text: "read branch-b.txt (completed)" }),
		}),
	]);
});

test("transcript views flag truncation by bound, not by parsing their text", async () => {
	const { conversation, phone } = await inspect();
	const writer = conversation.session.sessionWriter;
	const literalSuffix = "complete\n[truncated]";
	const literalUserId = await writer.appendMessage({ role: "user", content: literalSuffix, timestamp: 1 });
	const literalAssistantId = await writer.appendMessage(assistantMessage(literalSuffix, 2));
	const longUserId = await writer.appendMessage({
		role: "user",
		content: "x".repeat(IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS + 1),
		timestamp: 3,
	});
	const toolCallId = "long-summary";
	await writer.appendMessage({
		...assistantMessage("", 4),
		content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "p".repeat(1_200) } }],
		stopReason: "toolUse",
	});
	const longToolSummaryId = await writer.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 5,
	});

	const { entries } = await wholeLog(phone, conversation);
	const views = new Map(entries.map((entry) => [entry.id, viewOf(entry)]));
	expect(views.get(literalUserId)).toMatchObject({ text: literalSuffix, truncated: false });
	expect(views.get(literalAssistantId)).toMatchObject({ text: literalSuffix, truncated: false });
	expect(views.get(longUserId)).toMatchObject({
		text: "x".repeat(IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS),
		truncated: true,
	});
	expect(views.get(longToolSummaryId)).toMatchObject({ role: "tool", truncated: true });
});

test("inactive-branch text and images remain recoverable through the content query", async () => {
	// The session selects its model after the seeded root; both branches hang off that selection. A live
	// session refuses direct leaf moves, so the session navigates back to the branch point.
	const { conversation, phone } = await inspect((seed) => seed.user("root", { timestamp: 1 }));
	const session = conversation.session;
	const branchPointId = session.sessionManager.getLeafId();
	if (branchPointId === null) throw new Error("Expected the model selection entry");
	const inactiveId = await session.sessionWriter.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: `${"x".repeat(IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS)}END` },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		],
		timestamp: 2,
	});
	const inactiveToolCallId = "inactive-image-call";
	await session.sessionWriter.appendMessage({
		...assistantMessage("", 3),
		content: [{ type: "toolCall", id: inactiveToolCallId, name: "read", arguments: { path: "inactive.png" } }],
	});
	const inactiveToolId = await session.sessionWriter.appendMessage({
		role: "toolResult",
		toolCallId: inactiveToolCallId,
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "dG9vbA==", mimeType: "image/png" },
		],
		isError: false,
		timestamp: 4,
	});
	await session.navigateTree(branchPointId, { summarize: false });
	const activeImageId = await session.sessionWriter.appendMessage({
		role: "user",
		content: [{ type: "image", data: "YWN0aXZl", mimeType: "image/jpeg" }],
		timestamp: 5,
	});
	await session.sessionWriter.appendMessage(assistantMessage("active branch", 6));

	const { entries } = await wholeLog(phone, conversation);
	const active = activeBranchIds(entries);
	expect(active.has(inactiveId)).toBe(false);
	expect(viewOf(entries.find((entry) => entry.id === inactiveId))).toMatchObject({
		truncated: true,
		imageCount: 1,
	});

	const firstText = await content(phone, { entryId: inactiveId });
	expect(firstText).toMatchObject({
		entryId: inactiveId,
		part: 0,
		parts: 2,
		content: {
			type: "text",
			text: "x".repeat(IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS),
			offset: 0,
			nextOffset: IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
			totalScalars: IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS + 3,
		},
	});
	if (firstText.content.type !== "text" || firstText.content.nextOffset === null) {
		throw new Error("Expected a continued text part");
	}
	expect(await content(phone, { entryId: inactiveId, offset: firstText.content.nextOffset })).toMatchObject({
		content: { type: "text", text: "END", nextOffset: null },
	});

	const expectedImages = new Map([
		[inactiveId, { part: 1, data: "aW1hZ2U=", mimeType: "image/png", activeBranch: false }],
		[inactiveToolId, { part: 1, data: "dG9vbA==", mimeType: "image/png", activeBranch: false }],
		[activeImageId, { part: 0, data: "YWN0aXZl", mimeType: "image/jpeg", activeBranch: true }],
	]);
	expect(
		entries.flatMap((entry) => {
			const imageCount = viewOf(entry)?.imageCount;
			return imageCount === undefined ? [] : [{ entryId: entry.id, imageCount, activeBranch: active.has(entry.id) }];
		}),
	).toEqual(
		[...expectedImages].map(([entryId, image]) => ({ entryId, imageCount: 1, activeBranch: image.activeBranch })),
	);
	for (const [entryId, image] of expectedImages) {
		expect(await imagesOf(phone, entryId)).toEqual([
			{ part: image.part, mimeType: image.mimeType, data: image.data },
		]);
	}
});

test("session inspection queries need the observe capability", async () => {
	const { conversation, phone, connect } = await inspect((seed) => seed.user("root", { id: "root", timestamp: 1 }));
	const before = conversation.session.sessionManager.getOrdinal() + 1;

	const observer = await connect(grantOf("conversation.observe.v1"));
	expect(await observer.query("history", { before, limit: 10 })).toMatchObject({ type: "result" });
	expect(await observer.query("content", { entryId: "root" })).toMatchObject({ type: "result" });

	const blind = await connect(grantOf("conversation.control.v1", "host.manage.v1"));
	for (const [query, params] of [
		["history", { before, limit: 10 }],
		["content", { entryId: "root" }],
	] as const) {
		expect(await blind.query(query, params)).toMatchObject({
			type: "query_error",
			reason: { code: "not_allowed", requiredCapability: "conversation.observe.v1" },
		});
	}
	expect(phone.frames.some((frame) => frame.type === "fatal")).toBe(false);
});
