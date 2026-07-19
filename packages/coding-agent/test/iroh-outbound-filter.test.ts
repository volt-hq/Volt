import { resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createIrohRemoteOutboundFilteredRpcTransport,
	createIrohRemoteProjectionSanitizer,
	sanitizeIrohRemoteOutbound,
	sanitizeIrohRemoteOutboundJsonLine,
} from "../src/core/remote/iroh/outbound-filter.ts";

const workspacePath = resolve("/Users/jordan/secret-project");
const hostFile = `${workspacePath}${sep}notes.md`;

function getRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Expected a record");
	}
	return value as Record<string, unknown>;
}

function getArray(value: unknown): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error("Expected an array");
	}
	return value;
}

function projectedAssistantMessage(text: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("Iroh shared projection sanitizer", () => {
	it("preserves the full field-aware outbound rule set", () => {
		const opaque = `opaque:${hostFile}`;
		const sanitizer = createIrohRemoteProjectionSanitizer({ workspacePath });
		const sanitized = getRecord(
			sanitizer.sanitizeValue({
				id: opaque,
				errorMessage: `failed at ${hostFile}`,
				diagnostics: [
					{
						error: { message: `failed at ${hostFile}`, stack: `stack ${hostFile}` },
						details: { path: hostFile, note: `read ${hostFile}` },
					},
				],
				arguments: {
					[hostFile]: "first",
					"/workspace/notes.md": "second",
					fullOutputPath: hostFile,
					sessionFile: hostFile,
					path: hostFile,
				},
				content: [
					{ type: "text", text: `answer ${hostFile}`, textSignature: opaque },
					{ type: "thinking", thinking: `plan ${hostFile}`, thinkingSignature: opaque },
					{
						type: "toolCall",
						id: opaque,
						name: `read ${hostFile}`,
						arguments: { path: hostFile, fullOutputPath: hostFile },
						thoughtSignature: opaque,
					},
					{ type: "image", mimeType: "image/png", data: opaque },
				],
			}),
		);

		expect(sanitized.id).toBe(opaque);
		expect(sanitized.errorMessage).toBe("failed at /workspace/notes.md");
		const diagnostic = getRecord(getArray(sanitized.diagnostics)[0]);
		expect(getRecord(diagnostic.error)).toEqual({
			message: "failed at /workspace/notes.md",
			stack: "stack /workspace/notes.md",
		});
		expect(getRecord(diagnostic.details)).toEqual({
			path: "/workspace/notes.md",
			note: "read /workspace/notes.md",
		});

		const args = getRecord(sanitized.arguments);
		expect(args).toEqual({
			"/workspace/notes.md": "first",
			"/workspace/notes.md (2)": "second",
			path: "/workspace/notes.md",
		});
		expect(args).not.toHaveProperty("fullOutputPath");
		expect(args).not.toHaveProperty("sessionFile");

		const content = getArray(sanitized.content).map(getRecord);
		expect(content[0]).toEqual({
			type: "text",
			text: "answer /workspace/notes.md",
			textSignature: opaque,
		});
		expect(content[1]).toEqual({
			type: "thinking",
			thinking: "plan /workspace/notes.md",
			thinkingSignature: opaque,
		});
		expect(content[2]).toEqual({
			type: "toolCall",
			id: opaque,
			name: "read /workspace/notes.md",
			arguments: { path: "/workspace/notes.md" },
			thoughtSignature: opaque,
		});
		expect(content[3]).toEqual({ type: "image", mimeType: "image/png", data: opaque });
		expect(sanitizer.sanitizeText(`open ${hostFile}`)).toBe("open /workspace/notes.md");
	});
});

describe("Iroh outbound projector-frame classification", () => {
	it("leaves top-level projected assistant frames wire-final", () => {
		const start = {
			type: "message_start",
			stream: { epoch: 1, seq: 0 },
			message: projectedAssistantMessage(hostFile),
			delivery: { subscriptionId: "subscription-1", cursor: 1 },
		};
		const update = {
			type: "message_update",
			stream: { epoch: 1, seq: 1 },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: hostFile },
			delivery: { subscriptionId: "subscription-1", cursor: 2 },
		};
		const end = {
			type: "message_end",
			stream: { epoch: 1, seq: 1 },
			message: projectedAssistantMessage(hostFile),
			delivery: { subscriptionId: "subscription-1", cursor: 3 },
		};

		expect(sanitizeIrohRemoteOutbound(start, { workspacePath })).toBe(start);
		expect(sanitizeIrohRemoteOutbound(update, { workspacePath })).toBe(update);
		expect(sanitizeIrohRemoteOutbound(end, { workspacePath })).toBe(end);
		expect(getRecord(getArray(getRecord(start.message).content)[0]).text).toBe(hostFile);
		expect(JSON.stringify([start, update, end])).toContain("secret-project");
	});

	it("does not treat malformed delivery metadata as a wire-final projected frame", () => {
		const frame = {
			type: "message_update",
			stream: { epoch: 1, seq: 1 },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: hostFile },
			delivery: { subscriptionId: "subscription-1", cursor: 2, hostPath: hostFile },
		};

		const sanitized = getRecord(sanitizeIrohRemoteOutbound(frame, { workspacePath }));
		expect(sanitized).not.toBe(frame);
		expect(sanitized).toMatchObject({
			assistantMessageEvent: { delta: "/workspace/notes.md" },
			delivery: { hostPath: "/workspace/notes.md" },
		});
	});

	it("allowlists and recursively sanitizes ordered conversation bootstraps", () => {
		const bootstrap = {
			type: "conversation_bootstrap",
			delivery: { subscriptionId: "subscription-1", cursor: 47, hostPath: hostFile },
			conversation: {
				workspaceName: "scratch",
				sessionId: "session-1",
				diagnosticPath: hostFile,
			},
			state: {
				sessionId: "session-1",
				cwd: workspacePath,
				sessionFile: `${workspacePath}${sep}.volt${sep}sessions${sep}session-1.jsonl`,
				activeTools: [
					{
						toolCallId: "tool-1",
						toolName: "read",
						status: "started",
						args: { path: hostFile, fullOutputPath: hostFile },
						details: { signatureDelta: "private-state-signature", path: hostFile },
					},
				],
			},
			transcript: {
				workspaceName: "scratch",
				sessionId: "session-1",
				items: [
					{
						entryId: "entry-1",
						ordinal: 1,
						createdAt: "2026-07-17T00:00:00.000Z",
						role: "assistant",
						text: `answer ${hostFile}`,
						truncated: false,
						path: hostFile,
						parts: [
							{
								type: "thinking",
								text: `plan ${hostFile}`,
								thinkingSignature: "private-transcript-signature",
							},
						],
					},
				],
				hasMore: false,
				nextBeforeEntryId: null,
				projectionVersion: 3,
				branchEpoch: "branch-1",
				head: { entryId: "entry-1", ordinal: 1 },
			},
			activeAssistant: {
				stream: { epoch: 3, seq: 128 },
				message: {
					...projectedAssistantMessage(hostFile),
					content: [
						{ type: "text", text: `answer ${hostFile}`, textSignature: "private-text-signature" },
						{
							type: "thinking",
							thinking: `plan ${hostFile}`,
							thinkingSignature: "private-thinking-signature",
						},
						{
							type: "toolCall",
							id: "tool-1",
							name: "read",
							arguments: { path: hostFile, fullOutputPath: hostFile },
							thoughtSignature: "private-tool-signature",
						},
					],
				},
				toolState: [{ contentIndex: 2, argsText: JSON.stringify({ path: hostFile }) }],
			},
			activeWorkflows: [
				{
					workflowEvent: {
						type: "workflow_start",
						workflowId: "workflow-1",
						path: hostFile,
						thoughtSignature: "private-workflow-signature",
					},
					activeTools: [
						{
							type: "tool_execution_start",
							toolCallId: "workflow-tool-1",
							args: { path: hostFile, sessionFile: hostFile },
						},
					],
				},
			],
			reason: "resync",
			requestId: "resync-request-1",
			unexpectedHostPath: hostFile,
		};

		const sanitized = getRecord(sanitizeIrohRemoteOutbound(bootstrap, { workspacePath }));
		expect(Object.keys(sanitized)).toEqual([
			"type",
			"delivery",
			"conversation",
			"state",
			"transcript",
			"activeAssistant",
			"activeWorkflows",
			"reason",
			"requestId",
		]);
		expect(sanitized.delivery).toEqual({ subscriptionId: "subscription-1", cursor: 47 });
		expect(sanitized.reason).toBe("resync");
		expect(sanitized.requestId).toBe("resync-request-1");
		expect(sanitized).not.toHaveProperty("unexpectedHostPath");

		const state = getRecord(sanitized.state);
		expect(state.cwd).toBe("/workspace");
		expect(state).not.toHaveProperty("sessionFile");
		const activeTool = getRecord(getArray(state.activeTools)[0]);
		expect(activeTool.args).toEqual({ path: "/workspace/notes.md" });
		expect(getRecord(activeTool.details)).toEqual({ path: "/workspace/notes.md" });

		const transcript = getRecord(sanitized.transcript);
		const transcriptItem = getRecord(getArray(transcript.items)[0]);
		expect(transcriptItem).toMatchObject({
			text: "answer /workspace/notes.md",
			path: "/workspace/notes.md",
		});
		expect(getRecord(getArray(transcriptItem.parts)[0])).toEqual({
			type: "thinking",
			text: "plan /workspace/notes.md",
		});

		const activeAssistant = getRecord(sanitized.activeAssistant);
		const activeMessage = getRecord(activeAssistant.message);
		const activeContent = getArray(activeMessage.content).map(getRecord);
		expect(activeContent[0]).toEqual({ type: "text", text: "answer /workspace/notes.md" });
		expect(activeContent[1]).toEqual({ type: "thinking", thinking: "plan /workspace/notes.md" });
		expect(activeContent[2]).toEqual({
			type: "toolCall",
			id: "tool-1",
			name: "read",
			arguments: { path: "/workspace/notes.md" },
		});
		expect(getRecord(getArray(activeAssistant.toolState)[0]).argsText).toContain("/workspace/notes.md");

		const workflow = getRecord(getArray(sanitized.activeWorkflows)[0]);
		expect(getRecord(workflow.workflowEvent)).toMatchObject({ path: "/workspace/notes.md" });
		expect(getRecord(getRecord(getArray(workflow.activeTools)[0]).args)).toEqual({ path: "/workspace/notes.md" });

		const wire = JSON.stringify(sanitized);
		expect(wire).not.toContain("secret-project");
		expect(wire).not.toContain("private-");
	});

	it("still sanitizes non-assistant and non-projected message frames", () => {
		const userFrame = {
			type: "message_start",
			stream: { epoch: 1, seq: 0 },
			message: { role: "user", content: hostFile },
		};
		const toolResultFrame = {
			type: "message_end",
			stream: { epoch: 1, seq: 1 },
			message: {
				role: "toolResult",
				content: [{ type: "text", text: hostFile }],
			},
		};
		const legacyAssistantFrame = {
			type: "message_start",
			message: projectedAssistantMessage(hostFile),
		};
		const assistantFrameWithUnexpectedField = {
			type: "message_start",
			stream: { epoch: 1, seq: 0 },
			message: projectedAssistantMessage(hostFile),
			unexpected: hostFile,
		};

		expect(sanitizeIrohRemoteOutbound(userFrame, { workspacePath })).toMatchObject({
			message: { role: "user", content: "/workspace/notes.md" },
		});
		expect(sanitizeIrohRemoteOutbound(toolResultFrame, { workspacePath })).toMatchObject({
			message: { content: [{ type: "text", text: "/workspace/notes.md" }] },
		});
		expect(sanitizeIrohRemoteOutbound(legacyAssistantFrame, { workspacePath })).toMatchObject({
			message: { content: [{ type: "text", text: "/workspace/notes.md" }] },
		});
		expect(sanitizeIrohRemoteOutbound(assistantFrameWithUnexpectedField, { workspacePath })).toMatchObject({
			message: { content: [{ type: "text", text: "/workspace/notes.md" }] },
			unexpected: "/workspace/notes.md",
		});
	});

	it("sanitizes subagent wrapper fields while preserving only its projected assistant event", () => {
		const nestedEvent = {
			type: "message_update",
			stream: { epoch: 2, seq: 3 },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: hostFile },
		};
		const wrapper = {
			type: "subagent_event",
			subagentId: `child ${hostFile}`,
			summary: `working in ${hostFile}`,
			event: nestedEvent,
		};

		const sanitized = getRecord(sanitizeIrohRemoteOutbound(wrapper, { workspacePath }));
		expect(sanitized).toMatchObject({
			type: "subagent_event",
			subagentId: "child /workspace/notes.md",
			summary: "working in /workspace/notes.md",
		});
		expect(sanitized.event).toBe(nestedEvent);
		expect(JSON.stringify(sanitized.event)).toContain("secret-project");

		const nonAssistantWrapper = {
			...wrapper,
			event: {
				type: "message_end",
				stream: { epoch: 2, seq: 3 },
				message: { role: "toolResult", content: [{ type: "text", text: hostFile }] },
			},
		};
		expect(sanitizeIrohRemoteOutbound(nonAssistantWrapper, { workspacePath })).toMatchObject({
			event: { message: { content: [{ text: "/workspace/notes.md" }] } },
		});
	});

	it("preserves decoration and JSONL behavior under the same classification", () => {
		const decorate = vi.fn((value: object) => ({ ...value, decoratedPath: hostFile }));
		const frame = {
			type: "subagent_event",
			subagentId: "child",
			event: {
				type: "message_start",
				stream: { epoch: 1, seq: 0 },
				message: projectedAssistantMessage(hostFile),
			},
		};
		const sanitized = getRecord(sanitizeIrohRemoteOutbound(frame, { workspacePath, decorate }));
		expect(decorate).toHaveBeenCalledWith(frame);
		expect(sanitized.decoratedPath).toBe("/workspace/notes.md");
		expect(sanitized.event).toBe(frame.event);

		const line = `${JSON.stringify(frame)}\n`;
		const sanitizedLine = sanitizeIrohRemoteOutboundJsonLine(line, { workspacePath });
		expect(sanitizedLine.endsWith("\n")).toBe(true);
		const parsed = getRecord(JSON.parse(sanitizedLine));
		expect(parsed.subagentId).toBe("child");
		expect(JSON.stringify(parsed.event)).toContain("secret-project");
	});

	it("passes projected event subtrees by identity through the filtered transport", () => {
		const writes: object[] = [];
		const nestedEvent = {
			type: "message_update",
			stream: { epoch: 1, seq: 1 },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: hostFile },
		};
		const transport = createIrohRemoteOutboundFilteredRpcTransport({
			workspacePath,
			transport: {
				write: (value) => {
					writes.push(value);
				},
				onLine: () => () => {},
				close: () => {},
			},
		});

		void transport.write({
			type: "subagent_event",
			subagentId: `child ${hostFile}`,
			event: nestedEvent,
		});
		expect(getRecord(writes[0]).event).toBe(nestedEvent);
		expect(getRecord(writes[0]).subagentId).toBe("child /workspace/notes.md");
	});
});
