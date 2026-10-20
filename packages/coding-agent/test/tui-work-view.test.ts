/**
 * The TUI's work from its client (architecture rewrite §7.3, §10): items and
 * what a client may do with them from the client fold and the live work
 * values; a conversation work opens observed read-only, its older entries
 * paged with `history` when its snapshot is bounded.
 */

import {
	type ClientState,
	type ClientWorkItem,
	clientRestore,
	emptyLiveFold,
	type LiveFoldState,
	type ProjectedEntry,
} from "@hansjm10/volt-protocol";
import { setKeybindings } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ConversationObservation, ProtocolClient } from "../src/client/protocol-client.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { ConversationWork, type WorkHolder } from "../src/modes/interactive/client/work-view.ts";
import { WorkInspector } from "../src/modes/interactive/components/work-inspector.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

function item(workId: string, overrides: Partial<ClientWorkItem> = {}): ClientWorkItem {
	return {
		workId,
		kind: "job",
		title: `Work ${workId}`,
		cancellable: true,
		delivery: "wake",
		resume: false,
		state: "running",
		startedOrdinal: 1,
		updatedOrdinal: 1,
		...overrides,
	};
}

function stateWith(work: ClientWorkItem[], entries: ProjectedEntry[] = [], earlier = false): ClientState {
	return clientRestore(100, {
		leafId: entries.at(-1)?.id ?? null,
		entries,
		earlier,
		model: null,
		thinkingLevel: "off",
		fastMode: false,
		planning: null,
		name: null,
		labels: [],
		queue: [],
		...(work.length === 0 ? {} : { work }),
	});
}

function holder(state: ClientState, live: LiveFoldState = emptyLiveFold()): WorkHolder {
	return { state, live, subscribe: () => () => undefined };
}

function message(ordinal: number, parentId: string | null, role: "user" | "assistant", text: string): ProjectedEntry {
	const timestamp = new Date(0).toISOString();
	const content =
		role === "user"
			? { role, content: text, timestamp: 0 }
			: {
					role,
					content: [{ type: "text" as const, text }],
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
					stopReason: "stop" as const,
					timestamp: 0,
				};
	return {
		ordinal,
		id: `e${ordinal}`,
		parentId,
		type: "message",
		timestamp,
		payload: { message: content },
	} as ProjectedEntry;
}

/** The text a message of {@link message} holds. */
function textOf(shown: unknown): string {
	const content = (shown as { content: string | Array<{ text: string }> }).content;
	return typeof content === "string" ? content : content.map((part) => part.text).join("");
}

/** A client whose observation of `conversation` holds `state`, closed, and whose `history` answers `older`. */
function observingClient(conversation: string, state: ClientState, older: ProjectedEntry[]) {
	const observation: ConversationObservation = {
		conversation,
		sessionGeneration: "work-observation-generation",
		received: true,
		caughtUp: true,
		state,
		live: emptyLiveFold(),
		ended: "closed",
		onChange: () => () => undefined,
		stop: vi.fn(),
	};
	const query = vi.fn(async (name: string) =>
		name === "history"
			? { entries: older, earlier: false }
			: { workId: "w1", text: "", offset: 0, nextOffset: null, totalScalars: 0, truncated: false, final: true },
	);
	const intent = vi.fn(async () => ({ type: "accepted", intentId: "i", ordinals: [], result: { conversation } }));
	const client = { observe: vi.fn(() => observation), query, intent } as unknown as ProtocolClient;
	return { client, observation, query, intent };
}

describe("the TUI's work from its client", () => {
	it("derives what a client may do with each item from its fold and live values", () => {
		const running = item("running");
		const suspended = item("suspended", { kind: "subagent", resume: true, cancellable: false, opens: true });
		const finished = item("finished", {
			outcome: "completed",
			finishedOrdinal: 5,
			child: { conversation: "child-conversation" },
			opens: true,
		});
		const state = stateWith([running, suspended, finished]);
		const live = {
			...emptyLiveFold(),
			values: new Map([["work/running", { kind: "work" as const, workId: "running" }]]),
		};
		const own = new ConversationWork({ client: () => ({}) as ProtocolClient, holder: holder(state, live) });
		const views = new Map(own.items().map((view) => [view.item.workId, view]));
		expect(views.get("running")).toMatchObject({
			suspended: false,
			live: { workId: "running" },
			actions: { cancel: true, resume: false, open: false },
		});
		// Open work of a resumable kind without a live value is suspended: no executor runs it.
		expect(views.get("suspended")).toMatchObject({
			suspended: true,
			actions: { cancel: false, resume: true, open: true },
		});
		expect(views.get("finished")).toMatchObject({ actions: { cancel: false, resume: false, open: true } });
		expect(own.items().map((view) => view.item.workId)).toEqual(["suspended", "running", "finished"]);

		// Another conversation's work is read-only: only the conversations it links open.
		const observed = new ConversationWork({
			client: () => ({}) as ProtocolClient,
			holder: holder(state, live),
			conversation: "observed",
		});
		expect(observed.items().map((view) => [view.item.workId, view.actions])).toEqual([
			["suspended", { cancel: false, resume: false, open: false }],
			["running", { cancel: false, resume: false, open: false }],
			["finished", { cancel: false, resume: false, open: true }],
		]);
	});

	it("opens a linked conversation observed, and pages its older entries when its snapshot is bounded", async () => {
		const tail = [
			message(50, "e49", "user", "the newest question"),
			message(51, "e50", "assistant", "the newest answer"),
		];
		const older = [
			message(48, null, "user", "an older question"),
			message(49, "e48", "assistant", "an older answer"),
		];
		const { client, query, intent, observation } = observingClient("child", stateWith([], tail, true), older);
		const own = new ConversationWork({
			client: () => client,
			holder: holder(stateWith([item("w1", { kind: "subagent", opens: true })])),
		});

		const opened = await own.open("w1");
		if (opened.kind !== "view") throw new Error("Expected a read-only view");
		expect(intent).toHaveBeenCalledWith("open_work", { workId: "w1" });
		expect(opened.conversation.live).toBe(false);
		expect(opened.conversation.earlier).toBe(true);
		expect(opened.conversation.messages()).toHaveLength(2);

		await opened.conversation.loadEarlier?.();
		expect(query).toHaveBeenCalledWith(
			"history",
			{ before: 50, limit: 200, branch: "e50" },
			{ conversation: "child" },
		);
		expect(opened.conversation.earlier).toBe(false);
		expect(opened.conversation.messages()).toHaveLength(4);
		opened.conversation.dispose();
		expect(observation.stop).toHaveBeenCalledOnce();
	});

	it("pages only the log it observes, never an old log's pages under a log recreated with its id", async () => {
		const oldTail = [message(50, "e49", "user", "old question"), message(51, "e50", "assistant", "old answer")];
		const oldPage = [
			message(48, null, "user", "old earlier question"),
			message(49, "e48", "assistant", "old earlier answer"),
		];
		let state = stateWith([], oldTail, true);
		let generation = "old-log";
		const listeners = new Set<() => void>();
		const observation: ConversationObservation = {
			conversation: "child",
			get sessionGeneration() {
				return generation;
			},
			received: true,
			caughtUp: true,
			get state() {
				return state;
			},
			live: emptyLiveFold(),
			ended: undefined,
			onChange: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			stop: vi.fn(),
		};
		// The host answers the observation's resubscription with a snapshot of a log recreated under the same id.
		const recreate = (log: string, tail: ProjectedEntry[]): void => {
			generation = log;
			state = stateWith([], tail, true);
			for (const listener of [...listeners]) listener();
		};
		const answers: Array<(page: unknown) => void> = [];
		const query = vi.fn(() => new Promise<unknown>((resolve) => answers.push(resolve)));
		const intent = vi.fn(async () => ({
			type: "accepted",
			intentId: "i",
			ordinals: [],
			result: { conversation: "child" },
		}));
		const client = { observe: vi.fn(() => observation), query, intent } as unknown as ProtocolClient;
		const own = new ConversationWork({
			client: () => client,
			holder: holder(stateWith([item("w1", { kind: "subagent", opens: true })])),
		});
		const opened = await own.open("w1");
		if (opened.kind !== "view") throw new Error("Expected a read-only view");
		const conversation = opened.conversation;
		const shown = () => conversation.messages().map(textOf);

		const oldLoad = conversation.loadEarlier?.();
		answers.shift()?.({ entries: oldPage, earlier: false });
		await oldLoad;
		expect(shown()).toEqual(["old earlier question", "old earlier answer", "old question", "old answer"]);
		expect(conversation.earlier).toBe(false);

		// The recreated log reuses the old log's entry ids for other entries: none of the old pages show or anchor a page.
		recreate("new-log", [message(20, "e19", "user", "new question"), message(21, "e20", "assistant", "new answer")]);
		expect(shown()).toEqual(["new question", "new answer"]);
		expect(conversation.earlier).toBe(true);
		const newLoad = conversation.loadEarlier?.();
		expect(query).toHaveBeenLastCalledWith("history", expect.objectContaining({ before: 20, branch: "e20" }), {
			conversation: "child",
		});

		// A page asked of one log and answered after another arrived is dropped.
		recreate("third-log", [message(30, "e29", "user", "third question")]);
		answers.shift()?.({ entries: [message(19, null, "user", "new earlier question")], earlier: false });
		await newLoad;
		expect(shown()).toEqual(["third question"]);
		expect(conversation.earlier).toBe(true);
		conversation.dispose();
	});

	it("loads a conversation's older entries in the inspector as it scrolls up from the top", async () => {
		const tail = [
			message(50, "e49", "user", "the newest question"),
			message(51, "e50", "assistant", "the newest answer"),
		];
		const older = [
			message(48, null, "user", "an older question"),
			message(49, "e48", "assistant", "an older answer"),
		];
		const { client, query } = observingClient("child", stateWith([], tail, true), older);
		const own = new ConversationWork({
			client: () => client,
			holder: holder(stateWith([item("w1", { kind: "subagent", opens: true })])),
		});
		const inspector = new WorkInspector(own, { getHeight: () => 30, requestRender: () => {}, onClose: () => {} });
		const shown = () => stripAnsi(inspector.render(100).lines.join("\n"));
		try {
			inspector.handleInput("\r");
			inspector.handleInput("\r");
			await vi.waitFor(() => expect(shown()).toContain("the newest answer"));
			expect(shown()).toContain("Earlier entries");
			expect(shown()).not.toContain("an older question");

			inspector.handleInput("\x1b[A");
			await vi.waitFor(() => expect(shown()).toContain("an older question"));
			expect(query.mock.calls.filter(([name]) => name === "history")).toHaveLength(1);
			expect(shown()).not.toContain("Earlier entries");
		} finally {
			inspector.dispose();
		}
	});
});
