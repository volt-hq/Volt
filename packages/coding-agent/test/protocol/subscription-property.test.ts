/**
 * Property tests of the subscription writer (RFC §12 testing; Phase 3 plan):
 *
 * - resuming after any position a client reached, a hidden ordinal or the
 *   middle of a written batch included, ends where an uninterrupted
 *   subscription ends, which is the client fold of the projected log;
 * - a snapshot at N plus the entries after N equals the fold of every entry;
 * - an entry's frame bytes depend only on the log before it and the profile;
 * - every live frame follows the entries it builds on (invariant W), and a
 *   subscriber's live view equals the host's live state.
 *
 * Both profiles run: the local profile, and a transcript profile that hides
 * custom entries, labels, names, and client input records the way the remote
 * profile will, so positions cross hidden ordinals and parents are rewritten.
 */

import { randomUUID } from "node:crypto";
import {
	type ClientState,
	clientAdvance,
	clientFold,
	clientRestore,
	clientSnapshot,
	emptyClientState,
	emptyLiveFold,
	foldLiveCommit,
	foldLiveFrame,
	type HostFrame,
	type LiveFoldState,
	type LiveItem,
	liveCommitOf,
} from "@hansjm10/volt-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { LiveState } from "../../src/core/host/live-state.ts";
import { localProfile, type Profile } from "../../src/core/protocol/profiles.ts";
import { projectEntry, sessionProjectionSource } from "../../src/core/protocol/projection/entries.ts";
import { projectLog, Subscription } from "../../src/core/protocol/server/subscription.ts";
import { type CommittedSessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { type LogSeed, seedSession } from "../utilities/seed-log.ts";
import { builtinSessionPresenters } from "../utilities/test-presenters.ts";

const HIDDEN_BY_TRANSCRIPT: ReadonlySet<string> = new Set([
	"custom",
	"label",
	"session_info",
	"client_input_receipt",
	"client_input_queued",
	"client_input_state",
	"leaf",
	"forked_from",
	"session_start_git_context",
	"pr_review_binding",
]);

/** A transcript-fidelity profile that hides what the remote profile will hide. */
const transcriptProfile: Profile = {
	...localProfile,
	name: "remote",
	fidelity: "transcript",
	includes: (entry) => !HIDDEN_BY_TRANSCRIPT.has(entry.type),
};

const PROFILES = [
	["local", localProfile],
	["transcript", transcriptProfile],
] as const;

// ============================================================================
// Operations
// ============================================================================

type EntryOp =
	| { kind: "user"; text: string; input: boolean }
	| { kind: "assistant"; text: string; toolCall: boolean }
	| { kind: "toolResult" }
	| { kind: "model"; n: number }
	| { kind: "label"; pick: number; clear: boolean }
	| { kind: "custom" }
	| { kind: "customMessage"; display: boolean }
	| { kind: "leaf"; pick: number }
	| { kind: "name"; text: string }
	| { kind: "hidden" };

type Op =
	| { kind: "commit"; entries: EntryOp[] }
	| { kind: "status"; key: number; text: string | null }
	| { kind: "panel"; text: string; patch: boolean }
	| { kind: "assistantStream"; text: string; end: boolean }
	| { kind: "tool"; op: "start" | "update" | "end" }
	| { kind: "request" }
	| { kind: "answer" }
	| { kind: "drop"; after: number }
	| { kind: "resume" }
	| { kind: "resnapshot" }
	| { kind: "notice" };

const text = fc.string({ minLength: 1, maxLength: 12 });

const entryOp: fc.Arbitrary<EntryOp> = fc.oneof(
	fc.record({ kind: fc.constant("user" as const), text, input: fc.boolean() }),
	fc.record({ kind: fc.constant("assistant" as const), text, toolCall: fc.boolean() }),
	fc.constant({ kind: "toolResult" as const }),
	fc.record({ kind: fc.constant("model" as const), n: fc.integer({ min: 0, max: 2 }) }),
	fc.record({ kind: fc.constant("label" as const), pick: fc.nat(), clear: fc.boolean() }),
	fc.constant({ kind: "custom" as const }),
	fc.record({ kind: fc.constant("customMessage" as const), display: fc.boolean() }),
	fc.record({ kind: fc.constant("leaf" as const), pick: fc.nat() }),
	fc.record({ kind: fc.constant("name" as const), text }),
	fc.constant({ kind: "hidden" as const }),
);

const op: fc.Arbitrary<Op> = fc.oneof(
	{
		weight: 6,
		arbitrary: fc.record({
			kind: fc.constant("commit" as const),
			entries: fc.array(entryOp, { minLength: 1, maxLength: 4 }),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant("status" as const),
			key: fc.integer({ min: 0, max: 2 }),
			text: fc.option(text, { nil: null }),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({ kind: fc.constant("panel" as const), text, patch: fc.boolean() }),
	},
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("assistantStream" as const), text, end: fc.boolean() }) },
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant("tool" as const),
			op: fc.constantFrom("start" as const, "update" as const, "end" as const),
		}),
	},
	{ weight: 1, arbitrary: fc.constant({ kind: "request" as const }) },
	{ weight: 1, arbitrary: fc.constant({ kind: "answer" as const }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("drop" as const), after: fc.integer({ min: 0, max: 6 }) }) },
	{ weight: 2, arbitrary: fc.constant({ kind: "resume" as const }) },
	{ weight: 1, arbitrary: fc.constant({ kind: "resnapshot" as const }) },
	{ weight: 1, arbitrary: fc.constant({ kind: "notice" as const }) },
);

// ============================================================================
// A client that folds the frames it receives
// ============================================================================

class TestSubscriber {
	state: ClientState = emptyClientState();
	live: LiveFoldState = emptyLiveFold();
	private seq = 0;
	/** Frames still delivered before the transport drops; undefined while connected. */
	private remaining: number | undefined;
	readonly entryBytes = new Map<number, string>();
	readonly violations: string[] = [];
	subscription: Subscription | undefined;

	readonly sink = {
		send: (frame: HostFrame): void => {
			if (this.remaining !== undefined) {
				if (this.remaining <= 0) return;
				this.remaining--;
			}
			this.apply(frame);
		},
	};

	/** Deliver `count` more frames, then lose the rest until the next resume. */
	dropAfter(count: number): void {
		this.remaining = count;
	}

	get dropped(): boolean {
		return this.remaining !== undefined;
	}

	reconnected(): void {
		this.remaining = undefined;
		this.seq = 0;
	}

	private record(ordinal: number, bytes: string): void {
		const previous = this.entryBytes.get(ordinal);
		if (previous !== undefined && previous !== bytes) this.violations.push(`entry ${ordinal} changed bytes`);
		this.entryBytes.set(ordinal, bytes);
	}

	apply(frame: HostFrame): void {
		switch (frame.type) {
			case "snapshot":
				this.state = clientRestore(frame.ordinal, frame.state);
				this.live = emptyLiveFold();
				for (const entry of frame.state.entries) this.record(entry.ordinal, JSON.stringify(entry));
				return;
			case "entry":
				this.state = clientFold([frame.entry], this.state);
				this.live = foldLiveCommit(this.live, liveCommitOf(frame.entry));
				this.record(frame.entry.ordinal, JSON.stringify(frame.entry));
				return;
			case "head":
				this.state = clientAdvance(this.state, frame.ordinal);
				return;
			case "live":
				if (this.state.ordinal < frame.basedOn) {
					this.violations.push(`live frame based on ${frame.basedOn} before position ${this.state.ordinal}`);
				}
				if (frame.reset !== true && frame.seq !== this.seq + 1)
					this.violations.push(`live seq gap at ${frame.seq}`);
				this.seq = frame.seq;
				this.live = foldLiveFrame(this.live, frame);
				return;
			default:
				return;
		}
	}
}

// ============================================================================
// The run
// ============================================================================

interface Host {
	readonly manager: SessionManager;
	readonly live: LiveState;
	readonly conversation: HostedConversation;
}

function createHost(): Host {
	const manager = SessionManager.inMemory("/tmp/volt-subscription-property");
	const live = new LiveState({ head: () => manager.getOrdinal() });
	// The live feed's commit rule: an entry that commits a streaming message or tool result ends it.
	manager.subscribeEntries((entry) => {
		if (entry.type !== "message") return;
		if (entry.message.role === "assistant") live.commit({ role: "assistant" });
		else if (entry.message.role === "toolResult") live.commit({ role: "tool", toolCallId: entry.message.toolCallId });
	});
	const conversation = {
		get id() {
			return manager.getSessionId();
		},
		session: {
			sessionManager: manager,
			presenters: builtinSessionPresenters(),
			gitContextProvider: { retainObservation: () => () => {} },
		},
		liveState: live,
		closed: false,
	} as unknown as HostedConversation;
	return { manager, live, conversation };
}

function subscribe(host: Host, subscriber: TestSubscriber, profile: Profile, after: number | "snapshot"): void {
	subscriber.subscription?.dispose();
	subscriber.reconnected();
	const subscription = new Subscription({
		subscriptionId: randomUUID(),
		liveClientId: randomUUID(),
		conversation: host.conversation,
		profile,
		sink: subscriber.sink,
		live: true,
		accepts: () => true,
	});
	subscriber.subscription = subscription;
	subscription.start(after);
}

interface RunState {
	toolCall: number;
	openToolCalls: string[];
	streamingTool: string | undefined;
	requests: AbortController[];
	hiddenWritten: boolean;
}

async function commit(host: Host, ops: readonly EntryOp[], run: RunState): Promise<void> {
	const publicIds = host.manager.getEntries().map((entry) => entry.id);
	await seedSession(host.manager, (seed: LogSeed) => {
		for (const entryOp of ops) {
			switch (entryOp.kind) {
				case "user":
					if (entryOp.input) {
						const clientMessageId = randomUUID();
						seed.clientInput(clientMessageId, "prompt", { message: entryOp.text }, { states: ["started"] });
						seed.user(entryOp.text, { clientMessageId });
					} else {
						seed.user(entryOp.text);
					}
					break;
				case "assistant": {
					const toolCalls = entryOp.toolCall
						? [
								{
									type: "toolCall" as const,
									id: `call-${run.toolCall++}`,
									name: "read",
									arguments: { path: "a.txt" },
								},
							]
						: [];
					seed.assistant(entryOp.text, { toolCalls });
					run.openToolCalls.push(...toolCalls.map((call) => call.id));
					break;
				}
				case "toolResult": {
					const call = run.openToolCalls.shift();
					if (call) seed.toolResult(call, "ok");
					break;
				}
				case "model":
					seed.model({ api: "seed-api", provider: "seed", id: `model-${entryOp.n}` });
					break;
				case "label": {
					const target = publicIds[entryOp.pick % Math.max(1, publicIds.length)];
					if (target) seed.label(entryOp.clear ? undefined : "mark", { targetId: target });
					break;
				}
				case "custom":
					seed.custom("test.state", { n: 1 });
					break;
				case "customMessage":
					seed.customMessage("test.note", "note", entryOp.display);
					break;
				case "leaf": {
					const target = publicIds[entryOp.pick % Math.max(1, publicIds.length)];
					if (target) seed.leaf(target);
					break;
				}
				case "name":
					seed.sessionName(entryOp.text);
					break;
				case "hidden":
					// A log holds one starting Git context: the local profile's only hidden entry type.
					if (!run.hiddenWritten) seed.hostRecord("session_start_git_context", { gitContext: null });
					run.hiddenWritten = true;
					break;
			}
		}
	});
}

function liveAction(host: Host, action: Op, run: RunState): void {
	switch (action.kind) {
		case "status":
			if (action.text === null) host.live.clear(`ext_status/ci/s${action.key}`);
			else host.live.set(`ext_status/ci/s${action.key}`, { kind: "ext_status", extension: "ci", text: action.text });
			return;
		case "panel": {
			// A patch changes the panel in place: a resubscribing client's reset carries the patched panel.
			const key = "ext_panel/ci/log";
			if (action.patch && host.live.get(key)) {
				host.live.patch(key, [{ op: "append_lines", path: ["out"], lines: [action.text] }]);
			} else {
				host.live.set(key, {
					kind: "ext_panel",
					extension: "ci",
					placement: "belowEditor",
					node: { type: "terminal", key: "out", lines: [action.text] },
				});
			}
			return;
		}
		case "assistantStream": {
			const items: LiveItem[] = [];
			if (!host.live.snapshot().assistant) {
				items.push({
					type: "assistant_start",
					message: {
						role: "assistant",
						content: [],
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
						stopReason: "stop",
						timestamp: 0,
					},
				});
				items.push({ type: "assistant_delta", event: { type: "text_start", contentIndex: 0 } });
			}
			items.push({ type: "assistant_delta", event: { type: "text_delta", contentIndex: 0, delta: action.text } });
			if (action.end) items.push({ type: "assistant_end" });
			host.live.stream(items);
			return;
		}
		case "tool": {
			const id = run.openToolCalls[0] ?? "call-none";
			if (action.op === "start") run.streamingTool = id;
			host.live.stream([
				{
					type: "tool",
					op: action.op,
					toolCallId: id,
					toolName: "read",
					...(action.op === "start" ? { args: { path: "a.txt" } } : {}),
					...(action.op === "update"
						? { partial: { content: [{ type: "text" as const, text: "partial" }] } }
						: {}),
					...(action.op === "end" ? { isError: false } : {}),
				},
			]);
			return;
		}
		case "request": {
			const controller = new AbortController();
			run.requests.push(controller);
			void host.live.request(
				{ kind: "confirm", title: "Proceed?", message: "Continue?" },
				{ signal: controller.signal, unattended: true },
			);
			return;
		}
		case "answer":
			run.requests.shift()?.abort();
			return;
		case "notice":
			host.live.notice("info", "hello");
			return;
		default:
			return;
	}
}

/** The host's live state as a client that accepts every request kind holds it. */
function hostView(host: Host): { values: unknown; assistant: unknown; tools: unknown } {
	const snapshot = host.live.snapshot();
	return { values: [...snapshot.values], assistant: snapshot.assistant?.message, tools: [...snapshot.tools] };
}

function clientView(live: LiveFoldState): { values: unknown; assistant: unknown; tools: unknown } {
	return { values: [...live.values], assistant: live.assistant?.message, tools: [...live.tools] };
}

function comparable(state: ClientState): unknown {
	return { ordinal: state.ordinal, snapshot: clientSnapshot(state) };
}

describe.each(PROFILES)("subscription writer on the %s profile", (_name, profile) => {
	it("resumes, snapshots, and live views end where the uninterrupted subscription ends", async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 40 }), async (ops) => {
				const host = createHost();
				const run: RunState = {
					toolCall: 0,
					openToolCalls: [],
					streamingTool: undefined,
					requests: [],
					hiddenWritten: false,
				};
				const steady = new TestSubscriber();
				const resuming = new TestSubscriber();
				const snapshotting = new TestSubscriber();
				subscribe(host, steady, profile, 0);
				subscribe(host, resuming, profile, 0);
				subscribe(host, snapshotting, profile, "snapshot");
				for (const action of ops) {
					switch (action.kind) {
						case "commit":
							await commit(host, action.entries, run);
							break;
						case "drop":
							if (!resuming.dropped) resuming.dropAfter(action.after);
							break;
						case "resume":
							// Resume after whatever position the client reached, hidden or mid-batch.
							subscribe(host, resuming, profile, resuming.state.ordinal);
							break;
						case "resnapshot":
							subscribe(host, snapshotting, profile, "snapshot");
							break;
						default:
							liveAction(host, action, run);
					}
				}
				subscribe(host, resuming, profile, resuming.state.ordinal);
				for (const controller of run.requests) controller.abort();

				const expected = clientFold(projectLog(host.conversation, profile, 0, host.manager.getOrdinal()));
				const final = clientAdvance(expected, host.manager.getOrdinal());
				for (const subscriber of [steady, resuming, snapshotting]) {
					expect(subscriber.violations).toEqual([]);
					expect(comparable(subscriber.state)).toEqual(comparable(final));
					expect(clientView(subscriber.live)).toEqual(hostView(host));
				}
				// The bytes of every entry frame are those of the entry projected from the log alone.
				const source = sessionProjectionSource(host.manager);
				for (const entry of host.manager.committedEntriesAfter(0) as CommittedSessionEntry[]) {
					const projected = projectEntry(entry, source, profile);
					for (const subscriber of [steady, resuming, snapshotting]) {
						const bytes = subscriber.entryBytes.get(entry.ordinal);
						if (bytes !== undefined) expect(bytes).toBe(JSON.stringify(projected));
					}
				}
				for (const subscriber of [steady, resuming, snapshotting]) subscriber.subscription?.dispose();
			}),
			{ numRuns: 60 },
		);
	});

	it("restores a snapshot at any ordinal and folds the entries after it to the fold of every entry", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.array(entryOp, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 10 }),
				fc.nat(),
				async (batches, cut) => {
					const host = createHost();
					const run: RunState = {
						toolCall: 0,
						openToolCalls: [],
						streamingTool: undefined,
						requests: [],
						hiddenWritten: false,
					};
					for (const batch of batches) await commit(host, batch, run);
					const head = host.manager.getOrdinal();
					const at = cut % (head + 1);
					const before = projectLog(host.conversation, profile, 0, at);
					const after = projectLog(host.conversation, profile, at, head);
					const restored = clientFold(
						after,
						clientRestore(at, clientSnapshot(clientAdvance(clientFold(before), at))),
					);
					expect(comparable(clientAdvance(restored, head))).toEqual(
						comparable(clientAdvance(clientFold([...before, ...after]), head)),
					);
				},
			),
			{ numRuns: 60 },
		);
	});
});
