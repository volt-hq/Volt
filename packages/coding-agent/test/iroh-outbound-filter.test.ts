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
		};
		const update = {
			type: "message_update",
			stream: { epoch: 1, seq: 1 },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: hostFile },
		};
		const end = {
			type: "message_end",
			stream: { epoch: 1, seq: 1 },
			message: projectedAssistantMessage(hostFile),
		};

		expect(sanitizeIrohRemoteOutbound(start, { workspacePath })).toBe(start);
		expect(sanitizeIrohRemoteOutbound(update, { workspacePath })).toBe(update);
		expect(sanitizeIrohRemoteOutbound(end, { workspacePath })).toBe(end);
		expect(getRecord(getArray(getRecord(start.message).content)[0]).text).toBe(hostFile);
		expect(JSON.stringify([start, update, end])).toContain("secret-project");
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
