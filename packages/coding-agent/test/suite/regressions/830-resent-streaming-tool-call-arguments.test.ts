/**
 * Regression #830: when the remote redactor sent the streaming assistant
 * message in full (a replacement after redaction rewrote text the client
 * held, or the message a client joining mid-stream gets), a tool call whose
 * arguments still streamed carried the arguments parsed from its partial
 * JSON, redacted whole, so a string cut inside a root sent the start of that
 * root to the device. Such a call now carries no arguments: the items after
 * the message rebuild them from settled text.
 */

import { sep } from "node:path";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import {
	emptyLiveFold,
	foldLiveFrame,
	type LiveFoldState,
	type LiveItem,
	REMOTE_CAPABILITIES,
} from "@hansjm10/volt-protocol";
import { describe, expect, it } from "vitest";
import { remoteProfile } from "../../../src/core/protocol/profiles.ts";

const workspace = "/home/jordan/secret-project";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
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
		stopReason: "toolUse",
		timestamp: 0,
	};
}

/** A remote client: what it was sent on the wire, and its live state folded from it. */
function remoteClient() {
	const redactor = remoteProfile({
		grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
		redaction: { workspacePath: workspace, remoteWorkspacePath: "/workspace" },
	}).redactor();
	let state: LiveFoldState = emptyLiveFold(1);
	let seq = 0;
	const wire: string[] = [];
	const send = (...items: LiveItem[]): void => {
		seq += 1;
		const frame = redactor.redact({
			type: "live",
			subscriptionId: "s",
			basedOn: 1,
			seq,
			...(seq === 1 ? { reset: true } : {}),
			items,
		});
		if (frame?.type !== "live") return;
		wire.push(JSON.stringify(frame));
		state = foldLiveFrame(state, frame);
	};
	return {
		send,
		wire,
		args: (index: number): unknown => {
			const block = state.assistant?.message.content[index];
			return block?.type === "toolCall" ? block.arguments : undefined;
		},
		text: (index: number): string | undefined => {
			const block = state.assistant?.message.content[index];
			return block?.type === "text" ? block.text : undefined;
		},
	};
}

function delta(event: Extract<LiveItem, { type: "assistant_delta" }>["event"]): LiveItem {
	return { type: "assistant_delta", event };
}

describe.skipIf(sep !== "/")(
	"regression #830: a streaming message sent in full carries no partial tool arguments",
	() => {
		it("sends no arguments of a call that still streams in the message a client joins mid-stream", () => {
			const client = remoteClient();
			client.send(
				{
					type: "assistant_start",
					message: assistant([
						{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/home/jordan/secret-pr" } },
					]),
				},
				delta({ type: "toolcall_start", contentIndex: 0, id: "c1", name: "read" }),
				delta({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"path":"/home/jordan/secret-pr' }),
			);
			expect(client.wire.join("\n")).not.toContain("/home/jordan");

			client.send(delta({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: 'oject/a.ts"}' }));
			expect(client.args(0)).toEqual({ path: "/workspace/a.ts" });
			expect(client.wire.join("\n")).not.toContain("/home/jordan");
		});

		it("keeps the arguments of a call that ended in the message a client joins mid-stream", () => {
			const client = remoteClient();
			client.send(
				{
					type: "assistant_start",
					message: assistant([
						{ type: "toolCall", id: "c1", name: "read", arguments: { path: `${workspace}/a.ts` } },
						{ type: "toolCall", id: "c2", name: "read", arguments: { path: "/home/jordan/secret-pr" } },
					]),
				},
				delta({ type: "toolcall_start", contentIndex: 1, id: "c2", name: "read" }),
				delta({ type: "toolcall_delta", contentIndex: 1, argsTextDelta: '{"path":"/home/jordan/secret-pr' }),
			);
			expect(client.args(0)).toEqual({ path: "/workspace/a.ts" });
			expect(client.wire.join("\n")).not.toContain("/home/jordan");
		});

		it("sends no arguments of a call that still streams when redaction replaces the message", () => {
			const client = remoteClient();
			client.send({ type: "assistant_start", message: assistant([]) });
			client.send(delta({ type: "toolcall_start", contentIndex: 0, id: "c1", name: "read" }));
			client.send(
				delta({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"path":"/home/jordan/secret-pr' }),
			);
			client.send(delta({ type: "text_start", contentIndex: 1 }));
			client.send(delta({ type: "text_delta", contentIndex: 1, delta: "a /tmp/My " }));
			expect(client.text(1)).toBe("a /tmp/My ");

			// Redaction rewrites "/tmp/My " once the bash output path completes: the message is sent again.
			client.send(delta({ type: "text_delta", contentIndex: 1, delta: "Dir/volt-bash-x.log ok" }));
			expect(client.wire.at(-1)).toContain('"type":"assistant_start"');
			expect(client.text(1)).toBe("a [redacted bash output path] ok");

			client.send(delta({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: 'oject/a.ts"}' }));
			expect(client.args(0)).toEqual({ path: "/workspace/a.ts" });
			expect(client.wire.join("\n")).not.toContain("/home/jordan");
		});
	},
);
