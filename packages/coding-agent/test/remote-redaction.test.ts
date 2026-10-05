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
import { type HostFrame, type LiveItem, REMOTE_CAPABILITIES } from "@hansjm10/volt-protocol";
import { describe, expect, it } from "vitest";
import { emptyLiveFold, foldLiveFrame } from "../src/core/protocol/live-fold.ts";
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
				items: [
					{
						type: "set",
						key: `ext_status/ci/${hostFile}`,
						value: { kind: "ext_status", extension: "ci", text: hostFile },
					},
				],
			}),
		).toMatchObject({
			items: [
				{
					type: "set",
					key: "ext_status/ci//workspace/notes.md",
					value: { kind: "ext_status", extension: "ci", text: "/workspace/notes.md" },
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
				items: [{ type: "clear", key: `ext_status/ci/${hostFile}` }],
			}),
		).toMatchObject({ items: [{ type: "clear", key: "ext_status/ci//workspace/notes.md" }] });
		// A key without a root is opaque.
		expect(
			redactor.redact({
				type: "live",
				subscriptionId: "s1",
				basedOn: 0,
				seq: 3,
				items: [
					{ type: "set", key: "ext_status/ci/~lint", value: { kind: "ext_status", extension: "ci", text: "ok" } },
				],
			}),
		).toMatchObject({ items: [{ type: "set", key: "ext_status/ci/~lint" }] });
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
						key: `ext_status/ci/${workspacePath}/lint`,
						value: { kind: "ext_status", extension: "ci", text: "checking" },
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
});

describe("remote redaction of patched panels", () => {
	const key = "ext_panel/ci/log";
	const panel = (lines: string[]) => ({
		kind: "ext_panel" as const,
		extension: "ci",
		placement: "sidebar" as const,
		node: { type: "terminal" as const, key: "out", lines },
	});
	const live = (seq: number, items: LiveItem[], reset = false): HostFrame => ({
		type: "live",
		subscriptionId: "s1",
		basedOn: 1,
		seq,
		...(reset ? { reset: true } : {}),
		items,
	});
	const append = (lines: string[]): LiveItem => ({
		type: "patch",
		key,
		ops: [{ op: "append_lines", path: ["out"], lines }],
	});

	it("sends a patch as the patch between the redacted values, so patched lines are redacted as set ones are", () => {
		const redactor = redactorFor(workspacePath);
		const sent: HostFrame[] = [];
		const send = (frame: HostFrame): void => {
			const redacted = redactor.redact(frame);
			if (redacted) sent.push(redacted);
		};
		send(live(1, [{ type: "set", key, value: panel([`open ${hostFile}`]) }], true));
		send(live(2, [append([`saved ${hostFile}`])]));
		send(live(3, [append(["done"])]));
		const wire = JSON.stringify(sent);
		expect(wire).not.toContain(workspacePath);
		const items = sent.flatMap((frame) => (frame.type === "live" ? frame.items : []));
		expect(items.map((item) => item.type)).toEqual(["set", "patch", "patch"]);
		expect(items[1]).toEqual(append(["saved /workspace/notes.md"]));
		let fold = emptyLiveFold();
		for (const frame of sent) if (frame.type === "live") fold = foldLiveFrame(fold, frame);
		expect(fold.values.get(key)).toEqual(panel(["open /workspace/notes.md", "saved /workspace/notes.md", "done"]));
	});

	it("starts a later patch from what the client holds when the frame could not carry one", () => {
		const redactor = remoteProfile({
			grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
			redaction: { workspacePath, remoteWorkspacePath: "/workspace" },
			limits: { frameBytes: 2_000 },
		}).redactor();
		const sent: HostFrame[] = [];
		const send = (frame: HostFrame): void => {
			const redacted = redactor.redact(frame);
			if (redacted) sent.push(redacted);
		};
		const holds = (): unknown => {
			let fold = emptyLiveFold();
			for (const frame of sent) if (frame.type === "live") fold = foldLiveFrame(fold, frame);
			return fold.values.get(key);
		};
		send(live(1, [{ type: "set", key, value: panel(["start"]) }], true));
		// Too large for the frame: left out, and the small patch of the same panel after it with it.
		send(live(2, [append(["x".repeat(3_000)]), append(["small"])]));
		expect(holds()).toEqual(panel(["start"]));
		// The next change is sent from what the client holds.
		send(live(3, [{ type: "patch", key, ops: [{ op: "replace", path: ["out"], node: panel(["end"]).node }] }]));
		expect(holds()).toEqual(panel(["end"]));
		const last = sent.at(-1);
		expect(last?.type === "live" && last.items.map((item) => item.type)).toEqual(["patch"]);
	});

	it("never replays a value from before its patches on a reset", () => {
		const redactor = redactorFor(workspacePath);
		redactor.redact(live(1, [{ type: "set", key, value: panel(["one"]) }], true));
		redactor.redact(live(2, [append(["two"])]));
		const reset = redactor.redact(live(1, [{ type: "set", key, value: panel(["one", "two"]) }], true));
		expect(reset?.type === "live" && reset.items).toEqual([{ type: "set", key, value: panel(["one", "two"]) }]);
	});
});
