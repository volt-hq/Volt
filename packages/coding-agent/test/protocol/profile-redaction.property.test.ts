/**
 * Profile redaction (Phase 3 plan, property tests): what a profile lets reach
 * a client. The local profile passes every frame through and sends payloads
 * whole. The remote profile sends no workspace root, worktree root, parent
 * checkout, or worktrees root, and no provider signature, in any frame:
 * entries, snapshots, live streaming split at any point, keyed values, and
 * query results. Its work entries carry no input, child locator, output
 * text, or result data (Phase 4 plan §9). Review state records (RFC §14 Q7)
 * stay on the host for both profiles: no frame carries them.
 */

import { resolve } from "node:path";
import {
	clientFold,
	clientSnapshot,
	emptyLiveFold,
	foldLiveFrame,
	type HostFrame,
	type LiveItem,
} from "@hansjm10/volt-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toLogEntry } from "../../src/core/conversation-log/entry-codec.ts";
import { localProfile, remoteProfile } from "../../src/core/protocol/profiles.ts";
import { projectEntry, sessionProjectionSource } from "../../src/core/protocol/projection/entries.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { type LogSeed, seedSession } from "../utilities/seed-log.ts";

type Step =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string; tool: boolean }
	| { kind: "result"; text: string }
	| { kind: "custom"; value: string }
	| { kind: "label"; text: string }
	| { kind: "work"; text: string; finish: boolean }
	| { kind: "review"; text: string };

const text = fc.string({ maxLength: 40 });
const step: fc.Arbitrary<Step> = fc.oneof(
	fc.record({ kind: fc.constant("user" as const), text }),
	fc.record({ kind: fc.constant("assistant" as const), text, tool: fc.boolean() }),
	fc.record({ kind: fc.constant("result" as const), text }),
	fc.record({ kind: fc.constant("custom" as const), value: text }),
	fc.record({ kind: fc.constant("label" as const), text: fc.string({ minLength: 1, maxLength: 10 }) }),
	fc.record({ kind: fc.constant("work" as const), text, finish: fc.boolean() }),
	fc.record({ kind: fc.constant("review" as const), text }),
);

/** Review state record types: host records no profile projects. */
const REVIEW_RECORD = /^review_/;

async function seed(steps: readonly Step[], cwd = (path: string) => path): Promise<SessionManager> {
	const manager = SessionManager.inMemory(cwd("/tmp/volt-profile-redaction/workspace"));
	const open: string[] = [];
	let call = 0;
	let works = 0;
	let reviews = 0;
	await seedSession(manager, (log: LogSeed) => {
		for (const item of steps) {
			switch (item.kind) {
				case "review": {
					// A review run and every review record, with paths in the discussion context.
					const runId = `run-${reviews++}`;
					const path = `${cwd("/tmp/volt-profile-redaction/workspace")}/file.ts`;
					const contextSnapshot = {
						finding: { title: `${item.text} ${path}`, path },
						target: { description: path },
					};
					const other = { sessionId: "other-session", sessionGeneration: "other-generation" };
					if (log.drafts.length === 0) {
						log.hostRecord("review_discussion_link", {
							discussionId: `link-${runId}`,
							runId: "source-run",
							findingId: "finding",
							source: other,
							contextSnapshot,
						});
					}
					log.hostRecord("work_started", {
						workId: runId,
						kind: "review",
						title: `Review ${item.text}`.slice(0, 200),
						input: { action: "review.uncommitted", target: path },
						cancellable: true,
						delivery: "none",
						resume: false,
						state: "running",
					});
					log.hostRecord("review_general", { runId, general: other });
					log.hostRecord("review_alias", { runId: `alias-${runId}`, source: other });
					log.hostRecord("review_discussion", {
						discussionId: `discussion-${runId}`,
						runId,
						findingId: "finding",
						contextSnapshot,
						child: { sessionId: `child-${runId}`, sessionGeneration: "child-generation" },
						requestId: `request-${runId}`,
						kickoffClientMessageId: `kickoff-${runId}`,
					});
					log.hostRecord("review_discussion_reset", {
						discussionId: `discussion-${runId}`,
						child: { sessionId: `next-${runId}`, sessionGeneration: "next-generation" },
						requestId: `reset-${runId}`,
						kickoffClientMessageId: `reset-kickoff-${runId}`,
					});
					break;
				}
				case "work": {
					// Work whose input, child locator, progress, output, and data name the workspace.
					const workId = `work-${works++}`;
					const path = `${cwd("/tmp/volt-profile-redaction/workspace")}/file.ts`;
					const text = `${item.text} ${path}`;
					log.hostRecord("work_started", {
						workId,
						kind: "job",
						title: `Work ${item.text} ${path}`.slice(0, 200),
						input: { command: text },
						cancellable: true,
						delivery: "none",
						resume: false,
						state: "running",
						child: {
							conversation: "child-session",
							ref: {
								sessionDirectory: `${cwd("/tmp/volt-profile-redaction/workspace")}/sessions`,
								storeId: "store",
								sessionId: "child-session",
								sessionGeneration: "generation",
							},
						},
					});
					log.hostRecord("work_checkpoint", { workId, progress: { text } });
					if (item.finish) {
						log.hostRecord("work_finished", {
							workId,
							outcome: "completed",
							result: { summary: text, output: { text, truncated: false }, data: { path } },
						});
					}
					break;
				}
				case "user":
					log.user(`${item.text} ${cwd("/tmp/volt-profile-redaction/workspace")}/file.ts`);
					break;
				case "assistant": {
					const toolCalls = item.tool
						? [
								{
									type: "toolCall" as const,
									id: `call-${call++}`,
									name: "read",
									arguments: { path: `${cwd("/tmp/volt-profile-redaction/workspace")}/file.ts` },
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
					// Review records are host state: even the local profile never sends them.
					expect(projected === undefined).toBe(REVIEW_RECORD.test(entry.type));
					if (!projected) continue;
					const frame: HostFrame = { type: "entry", subscriptionId: "s", entry: projected };
					expect(localProfile.redactor().redact(frame)).toBe(frame);
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

	it("the remote profile sends no workspace or worktree root and no provider signature", async () => {
		// Host-native roots: on Windows, drive-letter paths with backslashes.
		const worktree = resolve("/tmp/volt-profile-redaction/worktrees/ws/feature");
		const checkout = resolve("/tmp/volt-profile-redaction/workspace");
		const worktreesRoot = resolve("/tmp/volt-profile-redaction/worktrees");
		const roots = [worktree, checkout, worktreesRoot];
		const pathIn = fc
			.constantFrom(...roots)
			.chain((root) => fc.constantFrom("", "/", "/src/a.ts", "/x y/z.md").map((suffix) => `${root}${suffix}`));
		const prose = fc.oneof(
			text,
			pathIn,
			fc.tuple(text, pathIn, text).map(([before, path, after]) => `${before} ${path} ${after}`),
			fc.tuple(text, pathIn).map(([before, path]) => `${before}"${path}"`),
		);
		const remoteStep: fc.Arbitrary<Step> = fc.oneof(
			fc.record({ kind: fc.constant("user" as const), text: prose }),
			fc.record({ kind: fc.constant("assistant" as const), text: prose, tool: fc.boolean() }),
			fc.record({ kind: fc.constant("result" as const), text: prose }),
			fc.record({ kind: fc.constant("custom" as const), value: prose }),
			fc.record({ kind: fc.constant("label" as const), text: fc.string({ minLength: 1, maxLength: 10 }) }),
			fc.record({ kind: fc.constant("work" as const), text: prose, finish: fc.boolean() }),
			fc.record({ kind: fc.constant("review" as const), text: prose }),
		);
		const leaks = (frame: HostFrame | undefined): string[] => {
			const wire = JSON.stringify(frame ?? null);
			return [
				...roots.filter((root) => wire.includes(JSON.stringify(root).slice(1, -1))),
				...(/Signature"|signatureDelta/.test(wire) ? ["signature"] : []),
			];
		};
		await fc.assert(
			fc.asyncProperty(
				fc.array(remoteStep, { minLength: 1, maxLength: 16 }),
				prose,
				fc.array(fc.integer({ min: 0, max: 60 }), { maxLength: 6 }),
				async (steps, streamed, cuts) => {
					const manager = await seed(steps, (path) =>
						path.replaceAll("/tmp/volt-profile-redaction/workspace", worktree),
					);
					const source = sessionProjectionSource(manager);
					const profile = remoteProfile({
						grant: { schemaVersion: 1, revision: 1, capabilities: ["conversation.observe.v1"] },
						redaction: {
							workspacePath: worktree,
							remoteWorkspacePath: "/workspace",
							additionalRedactedPaths: [checkout, worktreesRoot],
						},
						bound: "conversation",
					});
					const redactor = profile.redactor();
					const projected = manager
						.committedEntriesAfter(0)
						.flatMap((entry) => projectEntry(entry, source, profile) ?? []);
					expect(projected.filter((entry) => REVIEW_RECORD.test(entry.type))).toEqual([]);
					for (const entry of projected) {
						expect(leaks(redactor.redact({ type: "entry", subscriptionId: "s", entry }))).toEqual([]);
						// Work reaches the device without its input, child locator, output text, or data.
						if (entry.type === "work_started") {
							expect(entry.payload?.input).toBeNull();
							if (entry.payload?.kind === "job") {
								expect(entry.payload.child).toEqual({ conversation: "child-session" });
							}
						}
						if (entry.type === "work_finished") {
							expect(entry.payload?.result?.output?.text).toBe("");
							expect(entry.payload?.result?.data).toBeUndefined();
						}
					}
					const snapshot: HostFrame = {
						type: "snapshot",
						subscriptionId: "s",
						conversation: "conversation",
						ordinal: manager.getOrdinal(),
						state: clientSnapshot(clientFold(projected)),
					};
					expect(leaks(redactor.redact(snapshot))).toEqual([]);

					// The streaming message, split into deltas at arbitrary points.
					const message = {
						role: "assistant" as const,
						content: [{ type: "text" as const, text: "", textSignature: "provider-signature" }],
						api: "seed-api",
						provider: "seed",
						model: "seed-model",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop" as const,
						timestamp: 0,
					};
					const items: LiveItem[] = [
						{ type: "assistant_start", message },
						{ type: "assistant_delta", event: { type: "text_start", contentIndex: 0 } },
					];
					let offset = 0;
					for (const cut of [...cuts].sort((left, right) => left - right)) {
						if (cut <= offset || cut >= streamed.length) continue;
						items.push({
							type: "assistant_delta",
							event: { type: "text_delta", contentIndex: 0, delta: streamed.slice(offset, cut) },
						});
						offset = cut;
					}
					items.push({
						type: "assistant_delta",
						event: { type: "text_delta", contentIndex: 0, delta: streamed.slice(offset) },
					});
					items.push({ type: "assistant_delta", event: { type: "text_end", contentIndex: 0, content: streamed } });
					items.push({ type: "notice", level: "info", message: streamed });
					items.push({
						type: "set",
						key: "ext_status/x/s",
						value: { kind: "ext_status", extension: "x", text: streamed },
					});
					// A panel and its patches: what each patch leaves the client holding is redacted as a whole value.
					const panel = "ext_panel/x/log";
					items.push({
						type: "set",
						key: panel,
						value: {
							kind: "ext_panel",
							extension: "x",
							placement: "sidebar",
							node: { type: "terminal", key: "out", lines: ["start"] },
						},
					});
					items.push({
						type: "patch",
						key: panel,
						ops: [{ op: "append_lines", path: ["out"], lines: [streamed] }],
					});
					items.push({
						type: "patch",
						key: panel,
						ops: [{ op: "replace", path: ["out"], node: { type: "code", key: "out", code: streamed } }],
					});
					let clientLive = emptyLiveFold();
					let held = "";
					for (const [index, item] of items.entries()) {
						const frame = redactor.redact({
							type: "live",
							subscriptionId: "s",
							basedOn: manager.getOrdinal(),
							seq: index + 1,
							...(index === 0 ? { reset: true } : {}),
							items: [item],
						});
						expect(leaks(frame)).toEqual([]);
						if (frame?.type === "live") clientLive = foldLiveFrame(clientLive, frame);
						// The client's patched panel never spells a root either.
						const shown = JSON.stringify(clientLive.values.get(panel) ?? null);
						expect(roots.filter((root) => shown.includes(JSON.stringify(root).slice(1, -1)))).toEqual([]);
						for (const sent of frame?.type === "live" ? frame.items : []) {
							if (sent.type === "assistant_start") held = "";
							if (sent.type === "assistant_delta" && sent.event.type === "text_delta") held += sent.event.delta;
							// What the client holds at any point never spells a root.
							expect(roots.filter((root) => held.includes(root))).toEqual([]);
						}
					}
					const result: HostFrame = { type: "result", queryId: "q", data: { text: streamed, nested: [streamed] } };
					expect(leaks(redactor.redact(result))).toEqual([]);
				},
			),
			{ numRuns: 60 },
		);
	});
});
