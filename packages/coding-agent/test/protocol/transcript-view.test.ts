import type { AssistantMessage, ToolResultMessage, UserMessage } from "@hansjm10/volt-ai";
import type { RemoteGrant, TranscriptItem } from "@hansjm10/volt-protocol";
import { describe, expect, test } from "vitest";
import type { BashExecutionMessage } from "../../src/core/messages.ts";
import { localProfile, type Profile, remoteProfile } from "../../src/core/protocol/profiles.ts";
import { sessionProjectionSource } from "../../src/core/protocol/projection/entries.ts";
import { projectTranscriptItem } from "../../src/core/protocol/projection/transcript.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { seedSession } from "../utilities/seed-log.ts";

const emptyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const OBSERVE_GRANT: RemoteGrant = { schemaVersion: 1, revision: 1, capabilities: ["conversation.observe.v1"] };

function assistant(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: emptyUsage,
		stopReason: "stop",
		timestamp,
	};
}

function user(text: string, timestamp: number): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

/** The transcript views of the active branch's entries `profile` includes, in order. */
function transcript(session: SessionManager, profile: Profile = localProfile): TranscriptItem[] {
	const source = sessionProjectionSource(session);
	return session.getBranch().flatMap((branchEntry) => {
		const entry = session.getCommittedEntry(branchEntry.id);
		if (!entry || !profile.includes(entry)) return [];
		const item = projectTranscriptItem(entry, source, profile);
		return item ? [item] : [];
	});
}

describe("protocol transcript view", () => {
	test("projects UI-ready transcript views with presented tool calls and no image data", async () => {
		const session = SessionManager.inMemory("/Users/jordan/project");
		await seedSession(session, (seed) =>
			seed.clientInput(
				"client-message-1",
				"prompt",
				{ message: "hello", images: [{ type: "image", data: "image-bytes", mimeType: "image/png" }] },
				{ states: ["started"] },
			),
		);
		const firstUserEntryId = await session.logWriter.appendMessage({
			role: "user",
			clientMessageId: "client-message-1",
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", data: "image-bytes", mimeType: "image/png" },
			],
			timestamp: 10,
		});
		await session.logWriter.appendMessage(
			assistant(
				[
					{ type: "thinking", thinking: "hidden thought" },
					{ type: "text", text: "I can help." },
					{
						type: "toolCall",
						id: "read-call",
						name: "read",
						arguments: { path: "/Users/jordan/project/src/secret.ts" },
					},
				],
				20,
			),
		);
		const readResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "read-call",
			toolName: "read",
			content: [{ type: "text", text: "secret file contents".repeat(100) }],
			isError: false,
			timestamp: 30,
		};
		await session.logWriter.appendMessage(readResult);
		await session.logWriter.appendCompaction("summary ".repeat(500), firstUserEntryId, 1234);
		await session.logWriter.appendMessage(
			assistant(
				[
					{ type: "text", text: "I will edit it." },
					{
						type: "toolCall",
						id: "edit-call",
						name: "edit",
						arguments: { path: "src/secret.ts" },
					},
				],
				40,
			),
		);
		const editResult: ToolResultMessage<{ diff: string; patch: string }> = {
			role: "toolResult",
			toolCallId: "edit-call",
			toolName: "edit",
			content: [{ type: "text", text: "Successfully replaced 1 block in src/secret.ts." }],
			details: { diff: `diff ${"x".repeat(5000)}`, patch: `patch ${"y".repeat(5000)}` },
			isError: false,
			timestamp: 50,
		};
		await session.logWriter.appendMessage(editResult);
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command: "cat /Users/jordan/project/src/secret.ts",
			output: "PRIVATE KEY",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 60,
		};
		await session.logWriter.appendMessage(bashMessage);

		const items = transcript(session);

		expect(items).toEqual([
			{ role: "user", text: "hello", truncated: false, imageCount: 1, clientMessageId: "client-message-1" },
			{
				role: "assistant",
				text: "I can help.",
				truncated: false,
				parts: [
					{ type: "thinking", text: "hidden thought" },
					{ type: "text", text: "I can help.", truncated: false },
				],
				stopReason: "stop",
			},
			{
				role: "tool",
				text: "read /Users/jordan/project/src/secret.ts (completed)",
				truncated: false,
				toolCallId: "read-call",
				toolName: "read",
				status: "completed",
				presentation: expect.objectContaining({ title: expect.any(Array) }),
			},
			{ role: "system", text: "summary ".repeat(500), truncated: false },
			{
				role: "assistant",
				text: "I will edit it.",
				truncated: false,
				parts: [{ type: "text", text: "I will edit it.", truncated: false }],
				stopReason: "stop",
			},
			{
				role: "tool",
				text: "edit src/secret.ts (completed)",
				truncated: false,
				toolCallId: "edit-call",
				toolName: "edit",
				status: "completed",
				presentation: expect.objectContaining({ title: expect.any(Array) }),
			},
			{
				role: "tool",
				text: "$ cat /Users/jordan/project/src/secret.ts (completed)",
				truncated: false,
				toolName: "bash",
				status: "completed",
				presentation: expect.objectContaining({ title: expect.any(Array) }),
			},
		]);
		expect(JSON.stringify(items)).not.toContain("image-bytes");
		// Tool items present as their tools do.
		expect(JSON.stringify(items[2]?.presentation)).toContain("read");
		expect(JSON.stringify(items[2]?.presentation)).toContain("secret file contents");
		expect(items[5]?.presentation).toMatchObject({ summary: [{ type: "text", key: "counts" }, { type: "diff" }] });
		expect(JSON.stringify(items[6]?.presentation)).toContain("$ ");

		// Tool items carry no per-tool fields: clients render the presentation.
		const toolFields = new Set([
			"role",
			"text",
			"truncated",
			"toolCallId",
			"toolName",
			"status",
			"imageCount",
			"presentation",
		]);
		for (const item of items.filter((each) => each.role === "tool")) {
			expect(Object.keys(item).filter((key) => !toolFields.has(key))).toEqual([]);
		}
		const remote = transcript(
			session,
			remoteProfile({ grant: OBSERVE_GRANT, redaction: { workspacePath: "/Users/jordan/project" } }),
		);
		expect(remote[5]).toMatchObject({ role: "tool", toolName: "edit" });
		expect(remote[2]?.text).not.toContain("/Users/jordan");
		// Presentations present the redacted entry: no host path reaches the remote profile.
		expect(JSON.stringify(remote.map((item) => item.presentation))).not.toContain("/Users/jordan");
	});

	test("preserves assistant Markdown text parts verbatim across multiple text content parts", async () => {
		const session = SessionManager.inMemory("/workspace");
		await session.logWriter.appendMessage(
			assistant(
				[
					{ type: "text", text: "Here is a plan:\n- Step one" },
					{ type: "text", text: "- Step two\n```swift\n\tlet value = 1\n```" },
				],
				20,
			),
		);

		const items = transcript(session);

		expect(items).toEqual([
			{
				role: "assistant",
				text: "Here is a plan:\n- Step one- Step two\n```swift\n\tlet value = 1\n```",
				truncated: false,
				parts: [
					{ type: "text", text: "Here is a plan:\n- Step one", truncated: false },
					{ type: "text", text: "- Step two\n```swift\n\tlet value = 1\n```", truncated: false },
				],
				stopReason: "stop",
			},
		]);
		expect(JSON.stringify(items)).not.toContain("Here is a plan: - Step one - Step two");
	});

	test("projects bounded subagent args and details for rich remote transcript rendering", async () => {
		const session = SessionManager.inMemory("/workspace");
		await session.logWriter.appendMessage(
			assistant(
				[
					{ type: "text", text: "Delegating." },
					{
						type: "toolCall",
						id: "subagent-call",
						name: "subagent",
						arguments: {
							agent: "general",
							task: "Review the implementation",
							confirm: "confirmation-token",
						},
					},
				],
				20,
			),
		);
		const subagentResult: ToolResultMessage<{
			mode: string;
			status: string;
			subagentId: string;
			sessionId: string;
			agent: { name: string; source: string };
			summary: { total: number; completed: number; failed: number; cancelled: number; running: number };
			childSessions: Array<{
				index: number;
				subagentId: string;
				sessionId: string;
				agent: { name: string; source: string };
				status: string;
			}>;
			output: { text: string; bytes: number; truncated: boolean; maxBytes: number };
		}> = {
			role: "toolResult",
			toolCallId: "subagent-call",
			toolName: "subagent",
			content: [{ type: "text", text: "model-visible child output" }],
			details: {
				mode: "single",
				status: "completed",
				subagentId: "sa_child",
				sessionId: "child-session",
				agent: { name: "general", source: "built-in" },
				summary: { total: 1, completed: 1, failed: 0, cancelled: 0, running: 0 },
				childSessions: [
					{
						index: 0,
						subagentId: "sa_child",
						sessionId: "child-session",
						agent: { name: "general", source: "built-in" },
						status: "completed",
					},
				],
				output: {
					text: `Child answer ${"x".repeat(1_500)}`,
					bytes: 1_513,
					truncated: false,
					maxBytes: 50_000,
				},
			},
			isError: false,
			timestamp: 30,
		};
		await session.logWriter.appendMessage(subagentResult);

		const items = transcript(session);
		const toolItem = items.find((item) => item.role === "tool");

		expect(toolItem).toMatchObject({
			role: "tool",
			toolCallId: "subagent-call",
			toolName: "subagent",
			status: "completed",
		});
		// The child presents as a card that opens its work.
		const presented = JSON.stringify(toolItem?.presentation);
		expect(presented).toContain("general");
		expect(presented).toContain("Review the implementation");
		expect(presented).toContain("Child answer");
		expect(presented).toContain('"open_work"');
		expect(presented).toContain('"workId":"sa_child"');
		// The consumed one-time confirm token is never presented.
		expect(JSON.stringify(items)).not.toContain("confirmation-token");
	});

	test("projects standard subagent registry pagination arguments and summary", async () => {
		const session = SessionManager.inMemory("/workspace");
		await session.logWriter.appendMessage(
			assistant(
				[
					{
						type: "toolCall",
						id: "subagent-list-call",
						name: "subagent_registry",
						arguments: { list: true, cursor: 50 },
					},
				],
				20,
			),
		);
		await session.logWriter.appendMessage({
			role: "toolResult",
			toolCallId: "subagent-list-call",
			toolName: "subagent_registry",
			content: [{ type: "text", text: "page output" }],
			details: {
				mode: "list",
				status: "completed",
				summary: {
					total: 120,
					completed: 100,
					failed: 10,
					cancelled: 5,
					running: 5,
					returned: 50,
					nextCursor: 20,
				},
			},
			isError: false,
			timestamp: 30,
		} as Parameters<typeof session.logWriter.appendMessage>[0]);

		const toolItem = transcript(session).find((item) => item.role === "tool");
		expect(toolItem).toMatchObject({ toolName: "subagent_registry", status: "completed" });
		expect(toolItem?.text).toContain("Subagent registry");
		expect(JSON.stringify(toolItem?.presentation)).toContain("page output");
	});

	test("projects standard subagent registry follow arguments", async () => {
		const session = SessionManager.inMemory("/workspace");
		await session.logWriter.appendMessage(
			assistant(
				[
					{
						type: "toolCall",
						id: "subagent-follow-call",
						name: "subagent_registry",
						arguments: { follow: "sa_existing" },
					},
				],
				20,
			),
		);
		await session.logWriter.appendMessage({
			role: "toolResult",
			toolCallId: "subagent-follow-call",
			toolName: "subagent_registry",
			content: [{ type: "text", text: "existing result" }],
			details: {
				mode: "follow",
				status: "completed",
				subagentId: "sa_existing",
				agent: { name: "researcher", source: "built-in" },
			},
			isError: false,
			timestamp: 30,
		} as Parameters<typeof session.logWriter.appendMessage>[0]);

		const toolItem = transcript(session).find((item) => item.role === "tool");
		expect(toolItem).toMatchObject({ toolName: "subagent_registry", status: "completed" });
		// A followed run presents as its child.
		const presented = JSON.stringify(toolItem?.presentation);
		expect(presented).toContain("researcher");
		expect(presented).toContain('"workId":"sa_existing"');
	});

	test("projects nested subagent delegation trees with live fields and a bounded depth", async () => {
		const session = SessionManager.inMemory("/workspace");
		await session.logWriter.appendMessage(
			assistant(
				[
					{
						type: "toolCall",
						id: "subagent-call",
						name: "subagent",
						arguments: { tasks: [{ agent: "researcher", task: "dig" }] },
					},
				],
				20,
			),
		);
		const makeNode = (depth: number): Record<string, unknown> => ({
			subagentId: `sa_depth_${depth}`,
			agent: { name: `agent-${depth}` },
			status: "running",
			task: `level ${depth} task`,
			...(depth < 7 ? { children: [makeNode(depth + 1)] } : {}),
		});
		await session.logWriter.appendMessage({
			role: "toolResult",
			toolCallId: "subagent-call",
			toolName: "subagent",
			content: [{ type: "text", text: "partial" }],
			details: {
				mode: "parallel",
				status: "running",
				tasks: [
					{
						index: 0,
						subagentId: "sa_task",
						sessionId: "session_task",
						agent: { name: "researcher", source: "built-in" },
						status: "running",
						task: "dig",
						startedAt: 1_000,
						durationMs: 2_500,
						toolCalls: 4,
						tokens: 1_234,
						currentActivity: "read docs/spec.md",
						children: [makeNode(2)],
					},
				],
			},
			isError: false,
			timestamp: 30,
		} as Parameters<typeof session.logWriter.appendMessage>[0]);

		const items = transcript(session);
		const toolItem = items.find((item) => item.role === "tool");
		if (!toolItem) {
			throw new Error("expected subagent tool item");
		}
		// The running child is a timed step, and its card names what it does and the delegation under it.
		expect(toolItem.presentation).toMatchObject({
			summary: expect.arrayContaining([
				expect.objectContaining({
					type: "progress",
					kind: "steps",
					steps: [expect.objectContaining({ status: "active", startedAt: 1_000, endedAt: 3_500 })],
				}),
			]),
		});
		const presented = JSON.stringify(toolItem.presentation);
		expect(presented).toContain("read docs/spec.md");
		for (const depth of [2, 3, 4, 5]) expect(presented).toContain(`agent-${depth}`);
		// The nested tree is bounded in depth.
		expect(presented).not.toContain("agent-7");
	});

	test("projects displayed review seed messages so remote clients can continue from findings", async () => {
		const privateMarker = "private-github-discussion-marker";
		const session = SessionManager.inMemory("/workspace");
		await session.logWriter.appendCustomMessageEntry(
			"review",
			"Automated review result\n\nFindings:\n1. Fix the bug",
			true,
			{
				findings: [{ title: "Fix the bug" }],
				privateAnalysis: privateMarker,
			},
		);
		await session.logWriter.appendCustomMessageEntry("review", "Hidden review context", false);
		await session.logWriter.appendCustomMessageEntry("extension.note", "Displayed extension note", true);

		const review = {
			role: "assistant",
			text: "Automated review result\n\nFindings:\n1. Fix the bug",
			truncated: false,
			// The host presents its own review messages, on every profile.
			presentation: {
				body: [{ type: "markdown", key: "text", markdown: "Automated review result\n\nFindings:\n1. Fix the bug" }],
			},
		};
		const remote = transcript(
			session,
			remoteProfile({ grant: OBSERVE_GRANT, redaction: { workspacePath: "/workspace" } }),
		);
		expect(remote).toEqual([review]);

		// The local profile also shows other displayed custom messages, as system items.
		const local = transcript(session);
		expect(local).toEqual([review, { role: "system", text: "Displayed extension note", truncated: false }]);

		for (const items of [remote, local]) {
			expect(JSON.stringify(items)).not.toContain(privateMarker);
			expect(JSON.stringify(items)).not.toContain("Hidden review context");
		}
	});

	test("advertises imageCount on user items and keeps image-only user messages", async () => {
		const session = SessionManager.inMemory("/workspace");
		await session.logWriter.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "look at this" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
				{ type: "image", data: "d29ybGQ=", mimeType: "image/png" },
			],
			timestamp: 10,
		});
		await session.logWriter.appendMessage({
			role: "user",
			content: [{ type: "image", data: "b25seQ==", mimeType: "image/jpeg" }],
			timestamp: 20,
		});
		await session.logWriter.appendMessage(user("plain", 30));

		const items = transcript(session);

		expect(items).toEqual([
			{ role: "user", text: "look at this", truncated: false, imageCount: 2 },
			{ role: "user", text: "", truncated: false, imageCount: 1 },
			{ role: "user", text: "plain", truncated: false },
		]);
		expect(JSON.stringify(items)).not.toContain("aGVsbG8=");
	});

	test("advertises imageCount on tool items with image results and keeps projections text-only", async () => {
		const session = SessionManager.inMemory("/workspace");
		await session.logWriter.appendMessage(
			assistant(
				[
					{
						type: "toolCall",
						id: "read-image-call",
						name: "read",
						arguments: { path: "logo.png" },
					},
				],
				10,
			),
		);
		const imageReadResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "read-image-call",
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 20,
		};
		await session.logWriter.appendMessage(imageReadResult);
		const textReadResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "read-image-call",
			toolName: "read",
			content: [{ type: "text", text: "plain text" }],
			isError: false,
			timestamp: 30,
		};
		await session.logWriter.appendMessage(textReadResult);

		const items = transcript(session);
		const toolItems = items.filter((item) => item.role === "tool");

		expect(toolItems[0]).toMatchObject({ role: "tool", toolName: "read", imageCount: 1 });
		expect(JSON.stringify(toolItems[0]?.presentation)).toContain("Read image file [image/png]");
		expect(toolItems[1]).toMatchObject({ role: "tool", toolName: "read" });
		expect(JSON.stringify(toolItems[1]?.presentation)).toContain("plain text");
		expect(toolItems[1]).not.toHaveProperty("imageCount");
		expect(JSON.stringify(items)).not.toContain("aW1hZ2U=");
	});
});
