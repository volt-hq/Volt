/**
 * Regression #827: the remote redactor holds back a streaming block's last
 * token once it holds a path separator. A token the client was sent before it
 * had one (`src`) was held back again when a delta grew it into a relative
 * path (`src/a.ts`), so the settled text fell short of what the client held:
 * a text block was sent again in full, and a tool call's arguments stopped
 * streaming until its end. Text the client holds is now never held back
 * again; the rest of its token waits for the token's end.
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

function assistant(): AssistantMessage {
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
		timestamp: 0,
	};
}

/** A remote client: the items it was sent, and its live state folded from them. */
function remoteClient() {
	const redactor = remoteProfile({
		grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
		redaction: { workspacePath: workspace, remoteWorkspacePath: "/workspace" },
	}).redactor();
	let state: LiveFoldState = emptyLiveFold(1);
	let seq = 0;
	const received: LiveItem[] = [];
	const send = (...items: LiveItem[]): LiveItem[] => {
		seq += 1;
		const frame = redactor.redact({
			type: "live",
			subscriptionId: "s",
			basedOn: 1,
			seq,
			...(seq === 1 ? { reset: true } : {}),
			items,
		});
		if (frame?.type !== "live") return [];
		received.push(...frame.items);
		state = foldLiveFrame(state, frame);
		return frame.items;
	};
	send({ type: "assistant_start", message: assistant() });
	return {
		send,
		received,
		text: (index: number): string | undefined => {
			const block = state.assistant?.message.content[index];
			return block?.type === "text" ? block.text : undefined;
		},
		args: (index: number): string | undefined => state.assistant?.argsText.get(index),
		starts: (): number => received.filter((item) => item.type === "assistant_start").length,
	};
}

function textDelta(delta: string): LiveItem {
	return { type: "assistant_delta", event: { type: "text_delta", contentIndex: 0, delta } };
}

function argsDelta(argsTextDelta: string): LiveItem {
	return { type: "assistant_delta", event: { type: "toolcall_delta", contentIndex: 0, argsTextDelta } };
}

describe.skipIf(sep !== "/")("regression #827: a sent token that grows into a path is not held back again", () => {
	it("appends the rest of a relative path to text instead of sending the message again", () => {
		const client = remoteClient();
		client.send({ type: "assistant_delta", event: { type: "text_start", contentIndex: 0 } });
		client.send(textDelta("Edit src"));
		expect(client.text(0)).toBe("Edit src");

		// The rest of the token waits for its end.
		expect(client.send(textDelta("/a.ts"))).toEqual([]);
		expect(client.text(0)).toBe("Edit src");

		expect(client.send(textDelta(" next."))).toEqual([textDelta("/a.ts next.")]);
		expect(client.text(0)).toBe("Edit src/a.ts next.");
		expect(client.starts()).toBe(1);
	});

	it("keeps streaming a tool call's arguments past a relative path", () => {
		const client = remoteClient();
		client.send({
			type: "assistant_delta",
			event: { type: "toolcall_start", contentIndex: 0, id: "call-1", name: "edit" },
		});
		client.send(argsDelta('{"path":"src'));
		expect(client.send(argsDelta("/a.ts"))).toEqual([]);
		client.send(argsDelta('","x":"more"}'));
		expect(client.args(0)).toBe('{"path":"src/a.ts","x":"more"}');
	});

	it("streams many relative paths split before their separators without sending the message again", () => {
		const client = remoteClient();
		client.send({ type: "assistant_delta", event: { type: "text_start", contentIndex: 0 } });
		let streamed = "";
		for (let step = 1; step <= 200; step++) {
			for (const delta of [`Step ${step} edits \``, "src", "/file", `-${step}`, ".ts", "` and its tests.\n"]) {
				streamed += delta;
				client.send(textDelta(delta));
			}
		}
		expect(client.starts()).toBe(1);
		expect(client.text(0)).toBe(streamed);
	});

	it("still sends the message again when the token grows into a path whose redaction rewrites what the client holds", () => {
		const client = remoteClient();
		client.send({ type: "assistant_delta", event: { type: "text_start", contentIndex: 0 } });
		client.send(textDelta("see file:"));
		expect(client.text(0)).toBe("see file:");

		// No part of the host path is sent while it grows.
		expect(client.send(textDelta("///tmp/volt-bash-"))).toEqual([]);
		expect(client.send(textDelta("x.log"))).toEqual([]);

		const items = client.send(textDelta(" now"));
		expect(items[0]?.type).toBe("assistant_start");
		expect(client.text(0)).toBe("see [redacted bash output path] now");
		expect(JSON.stringify(client.received)).not.toContain("/tmp/volt-bash");
	});
});
