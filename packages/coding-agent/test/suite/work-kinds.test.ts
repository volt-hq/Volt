/**
 * Extension work kinds in a session (RFC §7.2): an extension registers a kind
 * and starts its work from a command; a `message` result rides the next turn
 * without waking the conversation; only the owning extension starts its
 * kinds; an extension whose id another owns registers none; and a reload
 * removes the kinds, interrupting their work and leaving a captured context
 * stale.
 */

import { type Context, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionCommandContext,
	ExtensionError,
	ExtensionFactory,
	WorkRunContext,
	WorkRunResult,
} from "../../src/core/extensions/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { createHostHarness, type HostHarness } from "./host-harness.ts";

const harnesses: Harness[] = [];
const hostHarnesses: HostHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const harness of hostHarnesses.splice(0)) await harness.cleanup();
});

/** A run that holds until its signal aborts or it is released. */
function held(): { run: (ctx: WorkRunContext) => Promise<WorkRunResult>; release(): void } {
	const release = Promise.withResolvers<WorkRunResult>();
	return {
		run: async (ctx) => {
			ctx.signal.addEventListener("abort", () => release.resolve({ outcome: "cancelled" }), { once: true });
			return await release.promise;
		},
		release: () => release.resolve({ outcome: "completed" }),
	};
}

describe("extension work kinds", () => {
	it("runs an extension's work, whose message notice rides the next turn without waking the conversation", async () => {
		const owner: ExtensionFactory = (volt) => {
			volt.registerWorkKind("sweep", { delivery: "message" });
			volt.registerCommand("sweep", {
				handler: async (_args, ctx) => {
					await ctx.startWork("sweep", { title: "Sweep the repo", input: { depth: 2 } }, async (work) => {
						work.checkpoint({ text: "Scanning", steps: [{ key: "scan", label: "Scan", status: "active" }] });
						work.output("swept 2 files\n");
						return {
							outcome: "completed",
							result: { summary: "2 stale files" },
							notice: "Sweep report: 2 stale files",
						};
					});
				},
			});
		};
		const harness = await createHarness({ extensionFactories: [owner] });
		harnesses.push(harness);
		await harness.session.prompt("/sweep");
		await harness.session.work.waitForIdle();
		const [record] = harness.session.work.list();
		expect(record).toMatchObject({
			kind: "ext:inline-1/sweep",
			title: "Sweep the repo",
			input: { depth: 2 },
			delivery: "message",
			outcome: "completed",
			result: { summary: "2 stale files", output: { text: "swept 2 files\n", truncated: false } },
		});
		// The notice waits for a turn: none started.
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);

		const requests: string[][] = [];
		harness.setResponses([
			(context: Context) => {
				requests.push(context.messages.map((message) => getMessageText(message)));
				return fauxAssistantMessage("noted");
			},
		]);
		await harness.session.prompt("what did the sweep find?");
		await harness.session.waitForIdle();
		expect(requests).toEqual([
			[
				`Sweep the repo (ext:inline-1/sweep ${record?.workId}) completed.\nSweep report: 2 stale files`,
				"what did the sweep find?",
			],
		]);
	});

	it("starts only the owning extension's kinds, and registers none for an extension whose id another owns", async () => {
		const outcomes: string[] = [];
		const attempt = (ctx: ExtensionCommandContext, kind: string) =>
			ctx
				.startWork(kind, { title: "Attempt" }, async () => ({ outcome: "completed" }))
				.then(
					({ workId }) => `started ${workId}`,
					(error: unknown) => (error instanceof Error ? error.message : String(error)),
				);
		const owner: ExtensionFactory = (volt) => {
			volt.registerWorkKind("sweep");
		};
		const intruder: ExtensionFactory = (volt) => {
			volt.registerCommand("steal", {
				handler: async (args, ctx) => {
					outcomes.push(await attempt(ctx, args));
				},
			});
		};
		const twin: ExtensionFactory = (volt) => {
			volt.registerWorkKind("audit");
			volt.registerCommand("audit", {
				handler: async (_args, ctx) => {
					outcomes.push(await attempt(ctx, "audit"));
				},
			});
		};
		const harness = await createHarness({
			extensionFactories: [
				{ factory: owner, path: "/repo/.volt/extensions/sweeper/index.ts" },
				{ factory: intruder, path: "/repo/.volt/extensions/intruder.ts" },
				{ factory: twin, path: "/home/me/.volt/agent/extensions/sweeper.ts" },
			],
		});
		harnesses.push(harness);
		const errors: ExtensionError[] = [];
		await harness.session.attachExtensionClient({
			id: "observer",
			mode: "print",
			onError: (error) => errors.push(error),
		}).ready;
		expect(errors).toEqual([
			{
				extensionPath: "/home/me/.volt/agent/extensions/sweeper.ts",
				event: "register_work_kind",
				error: expect.stringContaining("ext:sweeper/audit is not registered"),
			},
		]);
		await harness.session.prompt("/steal sweep");
		await harness.session.prompt("/steal ext:sweeper/sweep");
		await harness.session.prompt("/audit");
		expect(outcomes).toEqual([
			expect.stringContaining('Unknown work kind "sweep"'),
			expect.stringContaining('Unknown work kind "ext:sweeper/sweep"'),
			expect.stringContaining('Unknown work kind "audit"'),
		]);
		expect(harness.session.work.list()).toEqual([]);
	});

	it("reload removes the kinds: running work blocks it, work started as it runs is interrupted, and old contexts go stale", async () => {
		let captured: ExtensionCommandContext | undefined;
		let late: (() => void) | undefined;
		const harness = await createHostHarness({
			whenUnattached: "keep",
			extension: (volt) => {
				volt.registerWorkKind("sweep");
				volt.registerCommand("capture", {
					handler: async (_args, ctx) => {
						captured = ctx;
					},
				});
				volt.on("session_shutdown", async (event, ctx) => {
					if (event.reason !== "reload") return;
					await ctx.startWork("sweep", { title: "Started as the extensions reload" }, async (work) => {
						late = () => {
							work.output("late");
							work.progress({ text: "late" });
							work.checkpoint({ text: "late" });
						};
						// Ignores its signal: only removing the kind ends it.
						return await new Promise<WorkRunResult>(() => undefined);
					});
				});
			},
		});
		hostHarnesses.push(harness);
		const conversation = await harness.openStartup();
		await harness.host.attach(harness.client("tui"), conversation);
		const { session } = conversation;
		await session.prompt("/capture");
		const first = captured;
		if (!first) throw new Error("Expected the command's context");

		const running = held();
		await first.startWork("sweep", { title: "Held" }, running.run);
		await expect(session.reload()).rejects.toThrow(/Cannot reload while active session work/);
		running.release();
		await session.work.waitForIdle();

		await session.reload();
		const interrupted = session.work.list().find((record) => record.title === "Started as the extensions reload");
		expect(interrupted).toMatchObject({ kind: "ext:inline-1/sweep", outcome: "interrupted" });
		expect(session.work.running()).toEqual([]);
		const entries = session.sessionManager.committedEntriesAfter(0).length;
		late?.();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(session.sessionManager.committedEntriesAfter(0)).toHaveLength(entries);
		expect(() => first.startWork("sweep", { title: "Stale" }, running.run)).toThrow(/stale/);

		// The reloaded extension registers the kind again.
		await session.prompt("/capture");
		const second = captured;
		if (!second || second === first) throw new Error("Expected the reloaded command's context");
		const { workId } = await second.startWork("sweep", { title: "After reload" }, async () => ({
			outcome: "completed",
		}));
		await vi.waitFor(() => expect(session.work.get(workId)?.outcome).toBe("completed"));
	});
});
