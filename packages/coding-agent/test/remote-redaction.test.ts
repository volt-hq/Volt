/**
 * Path redaction on the remote profile: the field-aware sanitizer
 * (src/core/remote/iroh/sanitizer.ts) and the per-connection redactor that
 * runs it on every frame a paired device receives
 * (src/core/protocol/remote-redaction.ts). Host paths become the remote
 * workspace path, host-local locators and provider signatures stay on the
 * host, and identifiers the client sent or must match are never rewritten.
 */

import { resolve, sep } from "node:path";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import { type HostFrame, REMOTE_CAPABILITIES } from "@hansjm10/volt-protocol";
import { describe, expect, it } from "vitest";
import { remoteProfile } from "../src/core/protocol/profiles.ts";
import { createIrohRemoteProjectionSanitizer } from "../src/core/remote/iroh/sanitizer.ts";

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

/** A remote connection's redactor for `workspace`, as `serveIrohRemoteConnection` creates it. */
function redactorFor(workspace: string) {
	return remoteProfile({
		grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
		redaction: { workspacePath: workspace, remoteWorkspacePath: "/workspace" },
	}).redactor();
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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

describe("remote path sanitizer", () => {
	it("keeps the full field-aware rule set", () => {
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

		// An id is opaque unless it names a root.
		expect(sanitized.id).toBe("opaque:/workspace/notes.md");
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

		// The sanitizer keeps signatures opaque; the redactor drops them from every frame.
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
			id: "opaque:/workspace/notes.md",
			name: "read /workspace/notes.md",
			arguments: { path: "/workspace/notes.md" },
			thoughtSignature: opaque,
		});
		expect(content[3]).toEqual({ type: "image", mimeType: "image/png", data: opaque });
		expect(sanitizer.sanitizeText(`open ${hostFile}`)).toBe("open /workspace/notes.md");
	});
});

describe("remote frame redactor", () => {
	it("redacts host paths and drops signatures and host-local locators from live frames", () => {
		const redactor = redactorFor(workspacePath);
		const frame = redactor.redact({
			type: "live",
			subscriptionId: "s1",
			basedOn: 4,
			seq: 1,
			reset: true,
			items: [
				{
					type: "assistant_start",
					message: assistantMessage([
						{ type: "text", text: `answer ${hostFile}`, textSignature: "private-text-signature" },
						{ type: "thinking", thinking: `plan ${hostFile}`, thinkingSignature: "private-thinking-signature" },
						{
							type: "toolCall",
							id: "tool-1",
							name: "read",
							arguments: { path: hostFile },
							thoughtSignature: "private-tool-signature",
						},
					]),
				},
				{
					type: "tool",
					op: "start",
					toolCallId: "tool-2",
					toolName: "bash",
					args: { path: hostFile, fullOutputPath: hostFile, sessionFile: hostFile },
				},
			],
		});

		expect(frame).toMatchObject({
			type: "live",
			subscriptionId: "s1",
			items: [
				{
					type: "assistant_start",
					message: {
						content: [
							{ type: "text", text: "answer /workspace/notes.md" },
							{ type: "thinking", thinking: "plan /workspace/notes.md" },
							{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/workspace/notes.md" } },
						],
					},
				},
				{ type: "tool", toolCallId: "tool-2", args: { path: "/workspace/notes.md" } },
			],
		});
		const wire = JSON.stringify(frame);
		expect(wire).not.toContain("secret-project");
		expect(wire).not.toContain("private-");
		expect(wire).not.toContain("fullOutputPath");
		expect(wire).not.toContain("sessionFile");
	});

	it("never rewrites identifiers the client sent, and rewrites host ones only when they name a root", () => {
		const redactor = redactorFor(workspacePath);
		// An identifier the client chose reaches it as sent.
		expect(
			redactor.redact({
				type: "rejected",
				intentId: hostFile,
				reason: { code: "failed", message: `failed at ${hostFile}` },
			}),
		).toEqual({
			type: "rejected",
			intentId: hostFile,
			reason: { code: "failed", message: "failed at /workspace/notes.md" },
		});
		expect(
			redactor.redact({
				type: "live",
				subscriptionId: "s1",
				basedOn: 0,
				seq: 1,
				items: [{ type: "set", key: `ext_status/${hostFile}`, value: { kind: "ext_status", text: hostFile } }],
			}),
		).toMatchObject({
			items: [
				{
					type: "set",
					key: "ext_status//workspace/notes.md",
					value: { kind: "ext_status", text: "/workspace/notes.md" },
				},
			],
		});
		// The same key clears what it set.
		expect(
			redactor.redact({
				type: "live",
				subscriptionId: "s1",
				basedOn: 0,
				seq: 2,
				items: [{ type: "clear", key: `ext_status/${hostFile}` }],
			}),
		).toMatchObject({ items: [{ type: "clear", key: "ext_status//workspace/notes.md" }] });
		// A key without a root is opaque.
		expect(
			redactor.redact({
				type: "live",
				subscriptionId: "s1",
				basedOn: 0,
				seq: 3,
				items: [{ type: "set", key: "ext_status/~lint", value: { kind: "ext_status", text: "ok" } }],
			}),
		).toMatchObject({ items: [{ type: "set", key: "ext_status/~lint" }] });
	});

	it("bounds background job labels that path replacement lengthened", () => {
		// A short host root grows when it becomes the remote workspace path.
		const shortRoot = resolve("/w");
		const redactor = redactorFor(shortRoot);
		const label = `${"x".repeat(190)} ${shortRoot}${sep}a`;
		expect(label.length).toBeLessThanOrEqual(200);
		const frame: HostFrame = {
			type: "live",
			subscriptionId: "s1",
			basedOn: 0,
			seq: 1,
			items: [
				{
					type: "set",
					key: "jobs",
					value: {
						kind: "jobs",
						jobs: [
							{
								id: "job-1",
								toolName: "bash",
								label,
								status: "running",
								startedAt: 1,
								outputTruncated: false,
							},
						],
					},
				},
			],
		};
		const redacted = redactor.redact(frame);
		if (redacted?.type !== "live") throw new Error("Expected a live frame");
		const item = redacted.items[0];
		if (item?.type !== "set" || item.value.kind !== "jobs") throw new Error("Expected a jobs value");
		const redactedLabel = item.value.jobs[0]?.label ?? "";
		expect(redactedLabel).toBe(`${"x".repeat(190)} /workspace/a`.slice(0, 200));

		// The same job in `job_output`'s result and `cancel_job`'s acceptance.
		const job = { id: "job-1", toolName: "bash" as const, label, status: "running" as const, startedAt: 1 };
		const result = redactor.redact({
			type: "result",
			queryId: "q1",
			data: { job: { ...job, outputTruncated: false, output: "" } },
		});
		const accepted = redactor.redact({
			type: "accepted",
			intentId: "i1",
			ordinals: [],
			result: { job: { ...job, outputTruncated: false } },
		});
		expect(result).toMatchObject({ data: { job: { label: redactedLabel } } });
		expect(accepted).toMatchObject({ result: { job: { label: redactedLabel } } });
	});

	it.skipIf(sep !== "/")("never streams the start of a root, even one with spaces and parentheses in it", () => {
		for (const [root, deltas] of [
			[
				"/Users/alice/Dropbox (Personal)/client-app",
				["Open ", "/Users/alice/Dropbox", " (", "Personal)/client-app/src/main.ts", " now"],
			],
			["/Users/alice/My Projects/app", ["see ", "/Users/alice/My", " Projects", "/app/src/x.ts", " ok"]],
		] as const) {
			const redactor = redactorFor(root);
			const sent: string[] = [];
			const send = (seq: number, items: unknown[], reset = false): void => {
				const frame = redactor.redact({
					type: "live",
					subscriptionId: "s1",
					basedOn: 5,
					seq,
					...(reset ? { reset: true } : {}),
					items,
				} as HostFrame);
				if (frame) sent.push(JSON.stringify(frame));
			};
			send(1, [{ type: "assistant_start", message: assistantMessage([]) }], true);
			send(2, [{ type: "assistant_delta", event: { type: "text_start", contentIndex: 0 } }]);
			for (const [index, delta] of deltas.entries()) {
				send(index + 3, [{ type: "assistant_delta", event: { type: "text_delta", contentIndex: 0, delta } }]);
			}
			const wire = sent.join("\n");
			expect(wire, root).not.toContain("/Users/alice");
			expect(wire, root).toContain("/workspace/");
		}
	});

	it("rewrites identifiers that name a root, at any depth", () => {
		const redactor = redactorFor(workspacePath);
		const sent = JSON.stringify(
			redactor.redact({
				type: "live",
				subscriptionId: "s1",
				basedOn: 1,
				seq: 1,
				items: [
					{
						type: "set",
						key: `ext_status/${workspacePath}/lint`,
						value: { kind: "ext_status", text: "checking" },
					},
					{
						type: "tool",
						op: "update",
						toolCallId: "t1",
						toolName: "ext_tool",
						partial: {
							content: [],
							details: {
								key: `${workspacePath}/cache.db`,
								requestId: `${workspacePath}/req`,
								id: `${workspacePath}/id`,
							},
						},
					},
				],
			} as unknown as HostFrame),
		);
		expect(sent).not.toContain(workspacePath);
		expect(sent).toContain('"toolCallId":"t1"');
	});

	it("drops the start of a root a host-cut job label ends in", () => {
		const root = resolve("/home/alice-secret-user/work/client-project");
		const redactor = redactorFor(root);
		const label = `${`${"echo x && ".repeat(17)}cat ${root}${sep}src${sep}index.ts`.slice(0, 199)}…`;
		const sent = JSON.stringify(
			redactor.redact({
				type: "live",
				subscriptionId: "s1",
				basedOn: 1,
				seq: 1,
				items: [
					{
						type: "set",
						key: "jobs",
						value: {
							kind: "jobs",
							jobs: [
								{
									id: "job_1",
									toolName: "bash",
									label,
									status: "running",
									startedAt: 0,
									outputTruncated: false,
								},
							],
						},
					},
				],
			} as unknown as HostFrame),
		);
		expect(sent).not.toContain("alice-secret-user");
		expect(sent).toContain("cat …");
	});
});
