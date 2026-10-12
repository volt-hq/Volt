/**
 * Regression #823: when the remote redactor sent the streaming assistant
 * message in full (a replacement after redaction rewrote text the client
 * held, or the message a client joining mid-stream gets), it redacted each
 * block's raw text whole, so a block ending in the start of a workspace root
 * sent that start to the device. A block whose end the client was not sent
 * now holds back what its next delta may complete, as its deltas do.
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
		stopReason: "stop",
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
		text: (index: number): string | undefined => {
			const block = state.assistant?.message.content[index];
			return block?.type === "text" ? block.text : undefined;
		},
	};
}

function textDelta(contentIndex: number, delta: string): LiveItem {
	return { type: "assistant_delta", event: { type: "text_delta", contentIndex, delta } };
}

describe.skipIf(sep !== "/")("regression #823: a streaming message sent in full holds back the start of a root", () => {
	it("holds back the start of a root at the end of the text when redaction replaces what the client holds", () => {
		const client = remoteClient();
		client.send({ type: "assistant_start", message: assistant([]) });
		client.send({ type: "assistant_delta", event: { type: "text_start", contentIndex: 0 } });
		client.send(textDelta(0, "a /tmp/My "));
		expect(client.text(0)).toBe("a /tmp/My ");

		// Redaction rewrites "/tmp/My " once the bash output path completes: the message is sent again.
		client.send(textDelta(0, "Dir/volt-bash-x.log /home/jordan/sec"));
		expect(client.wire.at(-1)).toContain('"type":"assistant_start"');
		expect(client.text(0)).toBe("a [redacted bash output path] ");

		client.send(textDelta(0, "ret-project/src/x.ts now"));
		expect(client.text(0)).toBe("a [redacted bash output path] /workspace/src/x.ts now");
		expect(client.wire.join("\n")).not.toContain("/home/jordan");
	});

	it("holds back the start of a root at the end of the message a client joins mid-stream", () => {
		const client = remoteClient();
		client.send({ type: "assistant_start", message: assistant([{ type: "text", text: "see /home/jordan/sec" }]) });
		expect(client.text(0)).toBe("see ");

		client.send(textDelta(0, "ret-project/a.ts ok"));
		expect(client.text(0)).toBe("see /workspace/a.ts ok");
		expect(client.wire.join("\n")).not.toContain("/home/jordan");
	});

	it("sends again in full the text of a block whose end the client holds", () => {
		const client = remoteClient();
		client.send({ type: "assistant_start", message: assistant([]) });
		client.send({ type: "assistant_delta", event: { type: "text_start", contentIndex: 0 } });
		client.send(textDelta(0, "Edited src/a.ts"));
		client.send({
			type: "assistant_delta",
			event: { type: "text_end", contentIndex: 0, content: "Edited src/a.ts" },
		});
		client.send({ type: "assistant_delta", event: { type: "text_start", contentIndex: 1 } });
		client.send(textDelta(1, "a /tmp/My "));
		client.send(textDelta(1, "Dir/volt-bash-x.log /home/jordan/sec"));

		// The replacement keeps the ended block whole and holds back the streaming one.
		expect(client.wire.at(-1)).toContain('"type":"assistant_start"');
		expect(client.text(0)).toBe("Edited src/a.ts");
		expect(client.text(1)).toBe("a [redacted bash output path] ");
		expect(client.wire.join("\n")).not.toContain("/home/jordan");
	});
});
