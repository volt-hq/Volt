/**
 * Profile redaction (Phase 3 plan, property tests): what a profile lets reach
 * a client. The local profile passes every frame through and sends payloads
 * whole; the remote profile's rules (no workspace or worktree roots, no
 * provider signatures) arrive with the remote cut-over.
 */

import type { HostFrame } from "@hansjm10/volt-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toLogEntry } from "../../src/core/conversation-log/entry-codec.ts";
import { localProfile } from "../../src/core/protocol/profiles.ts";
import { projectEntry, sessionProjectionSource } from "../../src/core/protocol/projection/entries.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { type LogSeed, seedSession } from "../utilities/seed-log.ts";

type Step =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string; tool: boolean }
	| { kind: "result"; text: string }
	| { kind: "custom"; value: string }
	| { kind: "label"; text: string };

const text = fc.string({ maxLength: 40 });
const step: fc.Arbitrary<Step> = fc.oneof(
	fc.record({ kind: fc.constant("user" as const), text }),
	fc.record({ kind: fc.constant("assistant" as const), text, tool: fc.boolean() }),
	fc.record({ kind: fc.constant("result" as const), text }),
	fc.record({ kind: fc.constant("custom" as const), value: text }),
	fc.record({ kind: fc.constant("label" as const), text: fc.string({ minLength: 1, maxLength: 10 }) }),
);

async function seed(steps: readonly Step[]): Promise<SessionManager> {
	const manager = SessionManager.inMemory("/tmp/volt-profile-redaction/workspace");
	const open: string[] = [];
	let call = 0;
	await seedSession(manager, (log: LogSeed) => {
		for (const item of steps) {
			switch (item.kind) {
				case "user":
					log.user(`${item.text} /tmp/volt-profile-redaction/workspace/file.ts`);
					break;
				case "assistant": {
					const toolCalls = item.tool
						? [
								{
									type: "toolCall" as const,
									id: `call-${call++}`,
									name: "read",
									arguments: { path: "/tmp/volt-profile-redaction/workspace/file.ts" },
									thoughtSignature: "signature",
								},
							]
						: [];
					log.assistant(item.text, { toolCalls });
					open.push(...toolCalls.map((toolCall) => toolCall.id));
					break;
				}
				case "result": {
					const id = open.shift();
					if (id) log.toolResult(id, item.text);
					break;
				}
				case "custom":
					log.custom("test.state", { value: item.value });
					break;
				case "label":
					if (log.drafts.some((draft) => draft.visibility === "public")) log.label(item.text);
					break;
			}
		}
	});
	return manager;
}

describe("profile redaction", () => {
	it("the local profile passes every frame through and sends payloads whole", async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 20 }), async (steps) => {
				const manager = await seed(steps);
				const source = sessionProjectionSource(manager);
				for (const entry of manager.committedEntriesAfter(0)) {
					const projected = projectEntry(entry, source, localProfile);
					expect(projected).toBeDefined();
					if (!projected) continue;
					const frame: HostFrame = { type: "entry", subscriptionId: "s", entry: projected };
					expect(localProfile.redact(frame)).toBe(frame);
					const log = toLogEntry(entry);
					const expected =
						entry.type === "message"
							? {
									message: entry.message,
									...(entry.clientMessageId === undefined ? {} : { clientMessageId: entry.clientMessageId }),
								}
							: log.payload;
					expect(projected.payload).toEqual(expected);
					expect(projected.parentId).toBe(entry.parentId);
				}
			}),
			{ numRuns: 50 },
		);
	});

	it.todo("the remote profile sends no workspace or worktree root and no provider signature");
});
