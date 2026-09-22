import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSettledEvent, ExtensionError, ExtensionFactory } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const releases: Array<() => void> = [];

function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}

async function setup(extension: ExtensionFactory) {
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		extensionFactories: [extension],
	});
	harnesses.push(harness);
	return harness;
}

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
});

describe("agent_settled extension event", () => {
	it.each(["prompt", "custom"])("awaits handlers before completion and the next %s", async (kind) => {
		const entered = barrier();
		const release = barrier();
		const order: string[] = [];
		const busyAtPublicSettlement: boolean[] = [];
		let calls = 0;
		let hasWork = true;
		const harness = await setup((volt) => {
			volt.on("agent_settled", async (event: AgentSettledEvent, ctx) => {
				order.push(`extension:${event.type}`);
				hasWork = ctx.work !== undefined;
				if (++calls === 1) {
					entered.resolve();
					await release.promise;
					volt.appendEntry("settled-test", { complete: true });
				}
			});
		});
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") {
				order.push("public:agent_settled");
				busyAtPublicSettlement.push(harness.session.isBusy);
			}
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		let promptDone = false;
		let idleDone = false;
		const first = harness.session.prompt("first").then(() => {
			promptDone = true;
		});
		await entered.promise;
		const idle = harness.session.waitForIdle().then(() => {
			idleDone = true;
		});
		const second =
			kind === "prompt"
				? harness.session.prompt("second")
				: harness.session.sendCustomMessage(
						{ customType: "next", content: "second", display: false },
						{ triggerTurn: true },
					);
		await Promise.resolve();
		expect(promptDone).toBe(false);
		expect(idleDone).toBe(false);
		expect(harness.session.isBusy).toBe(true);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toEqual([]);
		release.resolve();
		await Promise.all([first, second, idle]);
		expect(hasWork).toBe(false);
		expect(busyAtPublicSettlement).toEqual([false, false]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(order).toEqual([
			"extension:agent_settled",
			"public:agent_settled",
			"extension:agent_settled",
			"public:agent_settled",
		]);
		const entries = harness.sessionManager.getEntries();
		const auditIndex = entries.findIndex((entry) => entry.type === "custom" && entry.customType === "settled-test");
		const secondIndex = entries.findLastIndex((entry) =>
			kind === "prompt"
				? entry.type === "message" && entry.message.role === "user"
				: entry.type === "custom_message",
		);
		expect(auditIndex).toBeGreaterThanOrEqual(0);
		expect(secondIndex).toBeGreaterThan(auditIndex);
	});

	it("contains handler errors and continues subsequent handlers", async () => {
		const errors: ExtensionError[] = [];
		let finished = false;
		const harness = await setup((volt) => {
			volt.on("agent_settled", async () => {
				throw new Error("settlement fixture failure");
			});
			volt.on("agent_settled", () => {
				finished = true;
			});
		});
		harness.session.extensionRunner.onError((error) => {
			errors.push(error);
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("test");
		await harness.session.waitForIdle();
		expect(finished).toBe(true);
		expect(errors).toContainEqual(
			expect.objectContaining({ event: "agent_settled", error: "settlement fixture failure" }),
		);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it.each(["input", "command"])("settles locally handled %s without inference", async (kind) => {
		let count = 0;
		const harness = await setup((volt) => {
			volt.on("input", () => ({ action: "handled" }));
			volt.registerCommand("handled", { handler: async () => {} });
			volt.on("agent_settled", () => {
				count++;
			});
		});
		await harness.session.prompt(kind === "command" ? "/handled" : "handled");
		expect(count).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("settles only after an agent_end handler's queued continuation", async () => {
		const order: string[] = [];
		const harness = await setup((volt) => {
			volt.on("agent_end", () => {
				order.push("end");
				if (order.length === 1) volt.sendUserMessage("follow up", { deliverAs: "followUp" });
			});
			volt.on("agent_settled", () => {
				order.push("settled");
			});
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("test");
		expect(order).toEqual(["end", "end", "settled"]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("settles after compaction recovery and its continuation", async () => {
		const order: string[] = [];
		const harness = await setup((volt) => {
			volt.on("agent_end", () => {
				order.push("end");
			});
			volt.on("session_before_compact", (event) => ({
				compaction: {
					summary: "Compacted fixture context",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			}));
			volt.on("session_compact", () => {
				order.push("compacted");
			});
			volt.on("agent_settled", () => {
				order.push("settled");
			});
		});
		harness.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1 } });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("recover from overflow");
		expect(order).toEqual(["end", "compacted", "end", "settled"]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("holds branch navigation and reload until settlement handlers finish", async () => {
		const entered = barrier();
		const release = barrier();
		const harness = await setup((volt) => {
			volt.on("agent_settled", async () => {
				entered.resolve();
				await release.promise;
			});
		});
		harness.sessionManager.appendCustomEntry("anchor", {});
		const anchor = harness.sessionManager.getLeafId()!;
		harness.setResponses([fauxAssistantMessage("done")]);
		const prompt = harness.session.prompt("test");
		await entered.promise;
		await expect(harness.session.navigateTree(anchor)).rejects.toThrow("Cannot navigate");
		await expect(harness.session.reload()).rejects.toThrow("Cannot reload");
		await expect(harness.session.compact()).rejects.toThrow("Cannot compact");
		release.resolve();
		await prompt;
		await expect(harness.session.navigateTree(anchor)).resolves.toMatchObject({ cancelled: false });
	});
});
