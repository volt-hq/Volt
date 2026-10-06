import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient } from "../../../src/client/protocol-client.ts";
import type { SessionIntentResult } from "../../../src/core/extensions/index.ts";
import { ClientScope } from "../../../src/core/host/client-scope.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { userMessagesForForking } from "../../utilities/session-reads.ts";
import { createHostHarness } from "../host-harness.ts";

describe("regression #585: extension session control returns the id of the session the client moved to", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup() {
		let cancel = false;
		const results: SessionIntentResult[] = [];
		const seededIn: string[] = [];
		const refs = new Map<string, SessionReference>();
		/** Per session_start: the session, and whether its log already held the entry `setup` wrote. */
		const starts: Array<{ sessionId: string; reason: string; setupWritten: boolean }> = [];
		const harness = await createHostHarness({
			extension: (volt) => {
				volt.on("session_start", (event, ctx) => {
					const sessionId = ctx.sessionManager.getSessionId();
					const ref = ctx.sessionManager.getSessionRef();
					if (ref) refs.set(sessionId, ref);
					starts.push({
						sessionId,
						reason: event.reason,
						setupWritten: ctx.sessionManager
							.getEntries()
							.some((entry) => entry.type === "custom" && entry.customType === "intent-setup"),
					});
				});
				volt.on("session_before_switch", () => (cancel ? { cancel: true } : undefined));
				volt.on("session_before_fork", () => (cancel ? { cancel: true } : undefined));
				volt.registerCommand("intent-new", {
					handler: async (_args, ctx) => {
						const from = ctx.sessionManager.getSessionId();
						results.push(
							await ctx.newSession({
								setup: async (writer) => {
									await writer.appendCustomEntry("intent-setup", { from });
								},
								withSession: async (next) => {
									seededIn.push(next.sessionManager.getSessionId());
								},
							}),
						);
					},
				});
				volt.registerCommand("intent-fork", {
					handler: async (args, ctx) => {
						results.push(await ctx.fork(args.trim()));
					},
				});
				volt.registerCommand("intent-switch", {
					handler: async (args, ctx) => {
						const ref = refs.get(args.trim());
						if (!ref) throw new Error(`No reference for ${args.trim()}`);
						results.push(await ctx.switchSession(ref));
					},
				});
			},
		});
		const source = await harness.openStartup();
		await source.session.prompt("first prompt");
		cleanups.push(() => harness.cleanup());
		return {
			harness,
			source,
			results,
			seededIn,
			starts,
			cancelNext: (value: boolean) => {
				cancel = value;
			},
		};
	}

	it("returns the new, resumed, and forked session's id from ctx.newSession, ctx.switchSession, and ctx.fork", async () => {
		const { harness, source, results, seededIn, starts } = await setup();
		const first = source.id;
		const forkFrom = userMessagesForForking(source.session)[0]!.entryId;

		// Print mode runs each command for its one client, which moves with each intent.
		const exitCode = await runPrintMode(harness.host, source, {
			mode: "text",
			messages: ["/intent-new", `/intent-switch ${first}`, `/intent-switch ${first}`, `/intent-fork ${forkFrom}`],
		});

		expect(exitCode).toBe(0);
		const opened = starts.filter((start) => start.reason !== "startup");
		expect(opened.map((start) => start.reason)).toEqual(["new", "resume", "fork"]);
		const [second, resumed, third] = opened;
		expect(resumed!.sessionId).toBe(first);
		expect(new Set([first, second!.sessionId, third!.sessionId]).size).toBe(3);
		expect(results).toEqual([
			{ cancelled: false, sessionId: second!.sessionId, seeded: true },
			{ cancelled: false, sessionId: first, seeded: false },
			// A switch to the session the client is on changes nothing and names it.
			{ cancelled: false, sessionId: first, seeded: false },
			{ cancelled: false, sessionId: third!.sessionId, seeded: false },
		]);
		expect(seededIn).toEqual([second!.sessionId]);
		// The writer `setup` received wrote the new session's log before its session_start.
		expect(second!.setupWritten).toBe(true);
	});

	it("returns only cancelled: true when an extension cancels, and the client stays on its session", async () => {
		const { harness, source, results, seededIn, starts, cancelNext } = await setup();
		const first = source.id;
		const forkFrom = userMessagesForForking(source.session)[0]!.entryId;
		cancelNext(true);

		await runPrintMode(harness.host, source, {
			mode: "text",
			messages: ["/intent-new", `/intent-fork ${forkFrom}`, `/intent-switch ${first}`],
		});

		// The switch targets the current session: a no-op that no extension sees.
		expect(results).toEqual([
			{ cancelled: true },
			{ cancelled: true },
			{ cancelled: false, sessionId: first, seeded: false },
		]);
		expect(seededIn).toEqual([]);
		expect(starts.map((start) => start.sessionId)).toEqual([first]);
	});

	it("lets an extension command that a protocol client's prompt runs change sessions", async () => {
		const { harness, source, results, seededIn, starts } = await setup();
		const client = await createLoopbackClient(harness.host, source);
		cleanups.push(() => client.stop());
		const sourceRef = source.session.sessionRef!;

		// The prompt's durable input is the command's: it settles as the command leaves the session.
		await client.prompt("/intent-new");
		await vi.waitFor(() => expect(results).toHaveLength(1));

		const [result] = results;
		if (!result || result.cancelled) throw new Error("Expected the command to move the client");
		expect(result.seeded).toBe(true);
		expect(seededIn).toEqual([result.sessionId]);
		expect(starts.map((start) => start.reason)).toEqual(["startup", "new"]);
		// The client follows its move: its subscription on the source ends moved, and it subscribes to the target.
		await vi.waitFor(() => expect(client.conversation).toBe(result.sessionId));
		await client.caughtUp();
		await vi.waitFor(() => expect(source.closed).toBe(true));
		const stored = await SessionManager.openReadOnly(sourceRef);
		try {
			// Nothing the source recorded is left with an unknown outcome, the command's input included.
			const inputs = [...stored.getConversationState().clientInputs.inputs.values()];
			expect(inputs.map((input) => input.state)).toEqual(["completed", "completed"]);
		} finally {
			await stored.closePersistence();
		}
	});

	it("answers the intent of an extension command that moved its client once the command ran", async () => {
		const { harness, source, results } = await setup();
		const client = await createLoopbackClient(harness.host, source);
		cleanups.push(() => client.stop());

		// The command closes the session it ran in as its client moves; its intent still answers.
		const accepted = await client.intent("extension.command.test-extension.intent-new", {});

		expect(accepted).toMatchObject({ type: "accepted" });
		expect(results).toEqual([{ cancelled: false, sessionId: expect.any(String), seeded: true }]);
		expect(source.closed).toBe(true);
	});

	it("reports cancelled when no attached client handles session changes", async () => {
		const { harness, source } = await setup();
		const session = source.session;
		await session.attachExtensionClient({ id: "bare", mode: "print" }).ready;
		const context = () => session.extensionRunner.createCommandContext();

		await expect(ClientScope.run("bare", () => context().newSession())).resolves.toEqual({ cancelled: true });
		await expect(ClientScope.run("bare", () => context().fork("missing"))).resolves.toEqual({ cancelled: true });
		await expect(context().switchSession(session.sessionRef!)).resolves.toEqual({ cancelled: true });
		// A client that has left gets nothing either.
		await expect(ClientScope.run("gone", () => context().newSession())).resolves.toEqual({ cancelled: true });
		expect(harness.host.list()).toEqual([source]);
	});
});
