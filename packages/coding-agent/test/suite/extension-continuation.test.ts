import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSettledEvent, ExtensionFactory } from "../../src/index.ts";
import { createHarness, getUserTexts, type Harness, type HarnessOptions } from "./harness.ts";

describe("host-fenced extension continuation", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	});
	async function open(factory: ExtensionFactory, options: HarnessOptions = {}): Promise<Harness> {
		const harness = await createHarness({ ...options, extensionFactories: [factory] });
		harnesses.push(harness);
		return harness;
	}

	it("continues successful settlements without a run allowance, using normal prompt hooks", async () => {
		let settled = 0;
		let prepared = 0;
		const harness = await open((volt) => {
			volt.on("before_agent_start", () => {
				prepared++;
			});
			volt.on("agent_settled", (event) => {
				expect(event.outcome).toBe("completed");
				settled++;
				if (settled < 4) return { prompt: `continue ${settled}` };
			});
		});
		harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("done")));
		await harness.session.prompt("start");
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start", "continue 1", "continue 2", "continue 3"]);
		expect(prepared).toBe(4);
		expect(settled).toBe(4);
	});

	it("does not treat handled commands as completed runs", async () => {
		const outcomes: string[] = [];
		const harness = await open((volt) => {
			volt.registerCommand("nothing", { handler: async () => {} });
			volt.on("agent_settled", (event) => {
				outcomes.push(event.outcome);
				return { prompt: "wrong" };
			});
		});
		await harness.session.prompt("/nothing");
		await harness.session.waitForIdle();
		expect(outcomes).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("revokes a delayed proposal on a late abort even after the operation signal is sealed", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		const harness = await open((volt) => {
			volt.on("agent_settled", async (event) => {
				signal = event.signal;
				entered.resolve();
				await release.promise;
				return { prompt: "must not restart" };
			});
		});
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("unused")]);
		await harness.session.prompt("start");
		await entered.promise;
		await harness.session.abort();
		expect(signal?.aborted).toBe(true);
		release.resolve();
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("new input wins while a settlement handler is awaiting", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const harness = await open((volt) => {
			volt.on("agent_settled", async () => {
				if (++calls !== 1) return;
				entered.resolve();
				await release.promise;
				return { prompt: "stale continuation" };
			});
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("start");
		await entered.promise;
		await harness.session.prompt("new input");
		release.resolve();
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start", "new input"]);
	});

	it.each(["disable", "reload", "navigate"] as const)("discards proposals across %s", async (change) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const harness = await open((volt) => {
			volt.on("agent_settled", async () => {
				entered.resolve();
				await release.promise;
				return { prompt: "stale" };
			});
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("start");
		await entered.promise;
		if (change === "disable") {
			const id = harness.session.extensionRunner.getExtensions()[0]!.id;
			harness.settingsManager.setExtensionEnabled(id, "global", false);
			await harness.session.extensionRegistry.reconcile();
		} else if (change === "reload") {
			await harness.session.reload();
		} else {
			const target = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user")!;
			await harness.session.navigateTree(target.id);
		}
		release.resolve();
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(1);
		expect(getUserTexts(harness)).not.toContain("stale");
	});

	it("disposal abandons a noncooperative settlement hook", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const harness = await open((volt) => {
			volt.on("agent_settled", async () => {
				entered.resolve();
				await release.promise;
				return { prompt: "stale" };
			});
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("start");
		await entered.promise;
		harness.session.dispose();
		await harness.session.waitForClosed();
		release.resolve();
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("does not bypass a policy stop or native Plan mode", async () => {
		const outcomes: string[] = [];
		const harness = await open((volt) => {
			volt.on("agent_settled", (event) => {
				outcomes.push(event.outcome);
				return { prompt: "wrong" };
			});
		});
		harness.session.registerTurnPolicy({
			nextAction: (context) => (context.completedTurn ? { type: "stop" } : undefined),
		});
		harness.setResponses([fauxAssistantMessage("stopped")]);
		await harness.session.prompt("start");
		await harness.session.waitForIdle();
		expect(outcomes).toEqual(["stopped"]);
		expect(getUserTexts(harness)).toEqual(["start"]);
		await harness.session.setAgentMode("plan");
		harness.appendResponses([fauxAssistantMessage("plan")]);
		await harness.session.prompt("plan only");
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start", "plan only"]);
	});

	it("waits for retry recovery, then continues exactly once", async () => {
		const outcomes: string[] = [];
		const harness = await open(
			(volt) => {
				volt.on("agent_settled", (event) => {
					outcomes.push(event.outcome);
					if (outcomes.length === 1) return { prompt: "continue" };
				});
			},
			{ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } },
		);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "overloaded", retryable: true, message: "overloaded" },
			}),
			fauxAssistantMessage("recovered"),
			fauxAssistantMessage("continued"),
		]);
		await harness.session.prompt("start");
		await harness.session.waitForIdle();
		expect(outcomes).toEqual(["completed", "completed"]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(getUserTexts(harness)).toEqual(["start", "continue"]);
	});

	it("refuses exhausted recovery", async () => {
		const outcomes: string[] = [];
		const harness = await open(
			(volt) => {
				volt.on("agent_settled", (event) => {
					outcomes.push(event.outcome);
					return { prompt: "wrong" };
				});
			},
			{ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } },
		);
		harness.setResponses(
			Array.from({ length: 2 }, () =>
				fauxAssistantMessage("", {
					stopReason: "error",
					error: { kind: "overloaded", retryable: true, message: "overloaded" },
				}),
			),
		);
		await harness.session.prompt("start");
		await harness.session.waitForIdle();
		expect(outcomes).toEqual(["failed"]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it.each([true, false])("settles after automatic compaction (success=%s)", async (success) => {
		const outcomes: string[] = [];
		let compactHook = 0;
		const harness = await open(
			(volt) => {
				volt.on("session_before_compact", () => {
					compactHook++;
				});
				volt.on("agent_settled", (event) => {
					outcomes.push(event.outcome);
					if (outcomes.length === 1) return { prompt: "continue" };
				});
			},
			{
				seed: (seed) => seed.user("earlier").assistant("answer"),
				settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1 } },
			},
		);
		await harness.session.setSessionName("continuation compaction test");
		const large = fauxAssistantMessage("large response", {
			usage: {
				...fauxAssistantMessage("").usage,
				input: harness.getModel().contextWindow,
				totalTokens: harness.getModel().contextWindow,
			},
		});
		harness.setResponses([large, fauxAssistantMessage("continued")]);
		harness.faux.setSimpleResponses(
			success
				? [fauxAssistantMessage("history summary"), fauxAssistantMessage("turn prefix summary")]
				: [
						fauxAssistantMessage("", {
							stopReason: "error",
							error: { kind: "auth", retryable: false, message: "summary unavailable" },
						}),
					],
		);
		if (success) await harness.session.prompt("start");
		else await expect(harness.session.prompt("start")).rejects.toThrow("summary unavailable");
		await harness.session.waitForIdle();
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(outcomes).toEqual(success ? ["completed", "completed"] : ["failed"]);
		expect(compactHook).toBe(1);
		expect(harness.faux.state.callCount).toBe(success ? 2 : 1);
	});

	it("reports compaction admission failure even before extension compaction hooks", async () => {
		let compactHooks = 0;
		const outcomes: string[] = [];
		const harness = await open(
			(volt) => {
				volt.on("session_before_compact", () => {
					compactHooks++;
				});
				volt.on("agent_settled", (event) => {
					outcomes.push(event.outcome);
					return { prompt: "wrong" };
				});
			},
			{
				models: [{ id: "tiny", contextWindow: 1024, maxTokens: 128 }],
				systemPrompt: "fixed instructions ".repeat(1000),
				settings: { compaction: { keepRecentTokens: 1, reserveTokens: 128 }, retry: { enabled: false } },
				seed: (seed) => seed.user("earlier").assistant("answer"),
			},
		);
		await harness.session.setSessionName("pre-hook failure");
		harness.setResponses([
			fauxAssistantMessage("done", { usage: { ...fauxAssistantMessage("").usage, input: 1024, totalTokens: 1024 } }),
		]);
		await expect(harness.session.prompt("start")).rejects.toThrow(/too small to compact/);
		await harness.session.waitForIdle();
		expect(outcomes).toEqual(["failed"]);
		expect(compactHooks).toBe(0);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.faux.state.simpleCallCount).toBe(0);
	});

	it("reports a policy stop before the first request as stopped, not successful", async () => {
		const outcomes: string[] = [];
		const harness = await open((volt) => {
			volt.on("agent_settled", (event) => {
				outcomes.push(event.outcome);
				return { prompt: "wrong" };
			});
		});
		harness.session.registerTurnPolicy({ nextAction: () => ({ type: "stop" }) });
		await harness.session.prompt("start");
		await harness.session.waitForIdle();
		expect(outcomes).toEqual(["stopped"]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("observes abort from the SDK settlement notification before invoking extension hooks", async () => {
		const outcomes: string[] = [];
		const harness = await open((volt) => {
			volt.on("agent_settled", (event) => {
				outcomes.push(event.outcome);
				return { prompt: "wrong" };
			});
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		let abort: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") abort = harness.session.abort();
		});
		await harness.session.prompt("start");
		await abort;
		await harness.session.waitForIdle();
		expect(outcomes).toEqual(["aborted"]);
		expect(getUserTexts(harness)).toEqual(["start"]);
	});

	it("selects only the first proposal while all handlers observe settlement", async () => {
		const seen: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("agent_settled", () => {
						seen.push("first");
						if (seen.length === 1) return { prompt: "first proposal" };
					});
				},
				(volt) => {
					volt.on("agent_settled", () => {
						seen.push("second");
						if (seen.length === 2) return { prompt: "second proposal" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("continued")]);
		await harness.session.prompt("start");
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start", "first proposal"]);
		expect(seen).toEqual(["first", "second", "first", "second"]);
	});

	it.each(["abort", "disable"] as const)("revokes a continuation during its receipt commit (%s)", async (stop) => {
		let proposed = false;
		const harness = await open(
			(volt) => {
				volt.on("agent_settled", () => {
					if (!proposed) {
						proposed = true;
						return { prompt: "stale receipt" };
					}
				});
			},
			{ log: "memory" },
		);
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("fresh")]);
		await harness.session.prompt("start");
		const hold = harness.log!.holdNext((batch) =>
			batch.entries.some((entry) => entry.type === "client_input_receipt"),
		);
		await hold.started;
		let stopping: Promise<void>;
		if (stop === "abort") stopping = harness.session.abort();
		else {
			const extension = harness.session.extensionRunner.getExtensions()[0]!;
			const stopped = new Promise<void>((resolve) =>
				extension.lifetime.stopSignal.addEventListener("abort", () => resolve(), { once: true }),
			);
			harness.settingsManager.setExtensionEnabled(extension.id, "global", false);
			stopping = harness.session.extensionRegistry.reconcile();
			await stopped;
		}
		hold.release();
		await stopping;
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(1);
		expect(getUserTexts(harness)).toEqual(["start"]);
		await harness.session.prompt("fresh input");
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start", "fresh input"]);
	});

	it("rechecks cancellation after continuation preflight awaits", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const harness = await open((volt) => {
			volt.on("agent_settled", () => ({ prompt: "continue" }));
			volt.on("before_agent_start", async (event) => {
				if (event.prompt === "continue") {
					entered.resolve();
					await release.promise;
				}
			});
		});
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("unused")]);
		await harness.session.prompt("start");
		await entered.promise;
		const aborted = harness.session.abort();
		release.resolve();
		await aborted;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("never continues a failed response", async () => {
		const outcomes: AgentSettledEvent["outcome"][] = [];
		const harness = await open((volt) => {
			volt.on("agent_settled", (event) => {
				outcomes.push(event.outcome);
				return { prompt: "wrong" };
			});
		});
		harness.settingsManager.setRetryEnabled(false);
		harness.setResponses([fauxAssistantMessage("failed", { stopReason: "error" })]);
		await harness.session.prompt("start");
		await harness.session.waitForIdle();
		expect(outcomes).toEqual(["failed"]);
		expect(getUserTexts(harness)).toEqual(["start"]);
	});
});
