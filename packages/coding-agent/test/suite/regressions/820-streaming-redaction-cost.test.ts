/**
 * Regression #820: the remote redactor redacted a streaming block's whole text
 * again on every delta, so each remote client cost quadratic time in the
 * block's length. A delta now redacts only the text after the block's last
 * line break, and a long line is redacted again only once it has grown by an
 * eighth. What the client holds stays the whole text's redaction.
 */

import { resolve, sep } from "node:path";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import {
	emptyLiveFold,
	foldLiveFrame,
	type LiveFoldState,
	type LiveItem,
	REMOTE_CAPABILITIES,
} from "@hansjm10/volt-protocol";
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { remoteProfile } from "../../../src/core/protocol/profiles.ts";
import type * as Sanitizer from "../../../src/core/remote/iroh/sanitizer.ts";
import { createIrohRemoteProjectionSanitizer } from "../../../src/core/remote/iroh/sanitizer.ts";

/** Characters of text the remote sanitizer redacted. */
const redacted = vi.hoisted(() => ({ characters: 0 }));

vi.mock("../../../src/core/remote/iroh/sanitizer.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof Sanitizer>();
	return {
		...actual,
		createIrohRemoteProjectionSanitizer: (
			options: Sanitizer.IrohRemoteSanitizerOptions,
		): Sanitizer.IrohRemoteProjectionSanitizer => {
			const sanitizer = actual.createIrohRemoteProjectionSanitizer(options);
			return {
				...sanitizer,
				sanitizeText: (value) => {
					redacted.characters += value.length;
					return sanitizer.sanitizeText(value);
				},
			};
		},
	};
});

const workspace = resolve("/tmp/volt-820/workspace");
/** The workspace root as text spells it, with forward slashes on every platform. */
const root = workspace.split(sep).join("/");
const sanitizer = createIrohRemoteProjectionSanitizer({ workspacePath: workspace });

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

/** A remote client of one streaming message: what it was sent, folded as it folds it. */
function remoteClient() {
	const redactor = remoteProfile({
		grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
		redaction: { workspacePath: workspace, remoteWorkspacePath: "/workspace" },
	}).redactor();
	let state: LiveFoldState = emptyLiveFold(1);
	let seq = 0;
	const sent: LiveItem[] = [];
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
		state = foldLiveFrame(state, frame);
		sent.push(...frame.items);
	};
	send({ type: "assistant_start", message: assistant() });
	return {
		send,
		sent,
		text: (): string | undefined => {
			const block = state.assistant?.message.content[0];
			return block?.type === "text" ? block.text : undefined;
		},
		args: (): string | undefined => state.assistant?.argsText.get(0),
	};
}

/** `text` in deltas of `length` characters. */
function deltasOf(text: string, length: number): string[] {
	const deltas: string[] = [];
	for (let offset = 0; offset < text.length; offset += length) deltas.push(text.slice(offset, offset + length));
	return deltas;
}

describe("regression #820: remote redaction of a streaming block costs linear time", () => {
	beforeEach(() => {
		redacted.characters = 0;
	});

	it("redacts each delta of a multi-line text against its own line, not the whole text", () => {
		const text = Array.from(
			{ length: 300 },
			(_, index) => `Step ${index} edits ${root}/src/file-${index}.ts and its tests.\n`,
		).join("");
		const client = remoteClient();
		client.send({ type: "assistant_delta", event: { type: "text_start", contentIndex: 0 } });
		for (const delta of deltasOf(text, 7)) {
			client.send({ type: "assistant_delta", event: { type: "text_delta", contentIndex: 0, delta } });
		}

		// Redacting the whole text on every delta redacts hundreds of times its length.
		expect(redacted.characters).toBeLessThan(16 * text.length);
		expect(client.text()).toBe(sanitizer.sanitizeText(text));
		expect(client.text()).not.toContain(root);
	});

	it("redacts a long one-line tool call argument text again only as it grows by an eighth", () => {
		const args = JSON.stringify({ path: "big.ts", content: "const value = compute(input, other); ".repeat(600) });
		const client = remoteClient();
		client.send({
			type: "assistant_delta",
			event: { type: "toolcall_start", contentIndex: 0, id: "call-1", name: "write" },
		});
		for (const argsTextDelta of deltasOf(args, 7)) {
			client.send({ type: "assistant_delta", event: { type: "toolcall_delta", contentIndex: 0, argsTextDelta } });
		}

		expect(redacted.characters).toBeLessThan(32 * args.length);
		// The client holds all but the newest stretch of the arguments while they stream.
		const held = client.args() ?? "";
		expect(args.startsWith(held)).toBe(true);
		expect(held.length).toBeGreaterThan((args.length * 7) / 8);

		client.send({
			type: "assistant_delta",
			event: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { type: "toolCall", id: "call-1", name: "write", arguments: JSON.parse(args) },
			},
		});
		expect(client.sent.at(-1)).toMatchObject({
			type: "assistant_delta",
			event: { type: "toolcall_end", toolCall: { id: "call-1", arguments: { path: "big.ts" } } },
		});
	});

	it("leaves a client the whole text's redaction at every line break, wherever deltas split it", () => {
		// The root ends at a separator: followed by a name character, it names another directory.
		const piece = fc.constantFrom(
			`${root} `,
			`${root}\n`,
			`${root}/src/a.ts`,
			`"${root}/x y/z.md"`,
			`(${root})`,
			"/tmp/volt-820/notes.txt",
			"/Users/John",
			"Smith/x.ts",
			"~/notes",
			"file:///tmp/a",
			"https://example.com/a",
			"see",
			"a.ts",
			" ",
			" ",
			"\n",
			"\n",
			'"',
			"'",
			"`",
			"(",
			",",
			":",
		);
		fc.assert(
			fc.property(
				fc.array(piece, { minLength: 1, maxLength: 40 }),
				fc.array(fc.integer({ min: 1, max: 600 }), { maxLength: 40 }),
				(pieces, cuts) => {
					const text = `${pieces.join("")}\n`;
					const offsets = [...new Set([0, ...cuts.filter((cut) => cut < text.length), text.length])].sort(
						(left, right) => left - right,
					);
					const client = remoteClient();
					client.send({ type: "assistant_delta", event: { type: "text_start", contentIndex: 0 } });
					for (let index = 1; index < offsets.length; index++) {
						const raw = text.slice(0, offsets[index]);
						const delta = text.slice(offsets[index - 1], offsets[index]);
						client.send({ type: "assistant_delta", event: { type: "text_delta", contentIndex: 0, delta } });
						expect(client.text()).not.toContain(root);
						if (raw.endsWith("\n")) expect(client.text()).toBe(sanitizer.sanitizeText(raw));
					}
				},
			),
			{ numRuns: 200 },
		);
	});
});
