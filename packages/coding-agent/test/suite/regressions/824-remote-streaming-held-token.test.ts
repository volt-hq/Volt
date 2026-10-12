/**
 * Regression for volt-hq/Volt#824: a paired device kept streaming text it
 * already held part of. When a delta ended inside a token the redactor holds
 * back as a possible path (a JSON escape such as `\n`, a `/`), the settled
 * text was shorter than what the client held: tool call arguments froze until
 * `toolcall_end`, and text was sent again whole with the unfinished token.
 */

import { resolve, sep } from "node:path";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import {
	emptyLiveFold,
	foldLiveFrame,
	type HostFrame,
	type LiveFoldState,
	type LiveItem,
	REMOTE_CAPABILITIES,
} from "@hansjm10/volt-protocol";
import { describe, expect, it } from "vitest";
import { remoteProfile } from "../../../src/core/protocol/profiles.ts";

const workspacePath = resolve("/Users/jordan/secret-project");

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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

/** A paired device: the host's live frames through its redactor, folded as the device folds them. */
function pairedDevice() {
	const redactor = remoteProfile({
		grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
		redaction: { workspacePath, remoteWorkspacePath: "/workspace" },
	}).redactor();
	let seq = 0;
	let state: LiveFoldState = emptyLiveFold(1);
	const received: LiveItem[][] = [];
	return {
		send(items: LiveItem[]): void {
			seq += 1;
			const frame = redactor.redact({
				type: "live",
				subscriptionId: "s1",
				basedOn: 1,
				seq,
				...(seq === 1 ? { reset: true } : {}),
				items,
			} as HostFrame);
			if (frame?.type !== "live") return;
			received.push(frame.items);
			state = foldLiveFrame(state, frame);
		},
		get state(): LiveFoldState {
			return state;
		},
		received,
	};
}

describe("#824 remote streaming past a held-back token", () => {
	it("keeps streaming tool call arguments past a JSON escape that ends a delta", () => {
		const device = pairedDevice();
		device.send([
			{ type: "assistant_start", message: assistantMessage() },
			{ type: "assistant_delta", event: { type: "toolcall_start", contentIndex: 0, id: "call-1", name: "write" } },
		]);
		const args = (): string | undefined => device.state.assistant?.argsText.get(0);
		const delta = (argsTextDelta: string): void =>
			device.send([{ type: "assistant_delta", event: { type: "toolcall_delta", contentIndex: 0, argsTextDelta } }]);

		delta('{"path": "a.ts", "content": "const a = 1;');
		expect(args()).toBe('{"path": "a.ts", "content": "const a = 1;');
		delta("\\n");
		expect(args()).toBe('{"path": "a.ts", "content": "const a = 1;');
		delta("const b = 2;");
		expect(args()).toBe('{"path": "a.ts", "content": "const a = 1;\\nconst b = 2;');
		delta('\\n", "mode": "x"}');
		expect(args()).toBe('{"path": "a.ts", "content": "const a = 1;\\nconst b = 2;\\n", "mode": "x"}');
	});

	it.skipIf(sep !== "/")("streams a path in tool call arguments once its token ends, redacted", () => {
		const device = pairedDevice();
		device.send([
			{ type: "assistant_start", message: assistantMessage() },
			{ type: "assistant_delta", event: { type: "toolcall_start", contentIndex: 0, id: "call-1", name: "read" } },
		]);
		const args = (): string | undefined => device.state.assistant?.argsText.get(0);
		const delta = (argsTextDelta: string): void =>
			device.send([{ type: "assistant_delta", event: { type: "toolcall_delta", contentIndex: 0, argsTextDelta } }]);
		const hostFile = `${workspacePath}/notes.md`;

		delta('{"note": "x');
		expect(args()).toBe('{"note": "x');
		// The start of the workspace root, which only the next delta completes.
		delta(`=${hostFile.slice(0, 12)}`);
		expect(args()).toBe('{"note": "x');
		delta(`${hostFile.slice(12)}", "limit": 5}`);
		expect(args()).toBe('{"note": "x=/workspace/notes.md", "limit": 5}');
	});

	it.skipIf(sep !== "/")(
		"holds back the rest of a text token the client holds part of instead of sending the message again",
		() => {
			const device = pairedDevice();
			device.send([
				{ type: "assistant_start", message: assistantMessage() },
				{ type: "assistant_delta", event: { type: "text_start", contentIndex: 0 } },
			]);
			const text = (): string | undefined => {
				const block = device.state.assistant?.message.content[0];
				return block?.type === "text" ? block.text : undefined;
			};
			const delta = (value: string): void =>
				device.send([{ type: "assistant_delta", event: { type: "text_delta", contentIndex: 0, delta: value } }]);

			delta("Open x");
			expect(text()).toBe("Open x");
			// The start of the workspace root, which only the next delta completes.
			delta(`=${workspacePath.slice(0, 12)}`);
			expect(text()).toBe("Open x");
			delta(`${workspacePath.slice(12)}/notes.md now`);
			expect(text()).toBe("Open x=/workspace/notes.md now");
			const restarts = device.received.flat().filter((item) => item.type === "assistant_start");
			expect(restarts).toHaveLength(1);
		},
	);
});
