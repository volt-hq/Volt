import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionTurnPolicy } from "../../src/core/agent-session.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import type {
	ExtensionWorkContext,
	ExtensionWorkReadResult,
	ExtensionWorkSnapshot,
	ExtensionWorkTaskContext,
	ExtensionWorkTaskHandle,
	RequestBoundaryEvent,
} from "../../src/core/extensions/work-types.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
const providerChecks: Array<() => void> = [];
afterEach(async () => {
	const checks = providerChecks.splice(0);
	try {
		for (const check of checks) check();
	} finally {
		for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	}
});

// Faux provider errors become assistant failures; assert outside that contained callback.
function checkedResponse(inspect: (context: Context) => void) {
	let observed: Context | undefined;
	providerChecks.push(() => {
		expect(observed).toBeDefined();
		inspect(observed!);
	});
	return (context: Context) => {
		observed = { ...context, messages: structuredClone(context.messages) };
		return fauxAssistantMessage("done");
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function setup(options: HarnessOptions = {}) {
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		...options,
	});
	harnesses.push(harness);
	harness.session.setSessionName("extension work test");
	return harness;
}

function consumer(run: (task: ExtensionWorkTaskContext) => Promise<void>, extra?: ExtensionFactory) {
	let handle: ExtensionWorkTaskHandle | undefined;
	let api: ExtensionAPI | undefined;
	const boundaries: Array<{ event: RequestBoundaryEvent; snapshot: ExtensionWorkSnapshot }> = [];
	const factory: ExtensionFactory = async (volt) => {
		api = volt;
		volt.on("request_boundary", (event, ctx) => {
			expect(ctx.work).toBeDefined();
			boundaries.push({ event, snapshot: ctx.work!.snapshot });
			if (!event.first) return;
			const admission = ctx.work!.tasks.start({ key: "prepare", label: "Prepare" }, run);
			expect(admission.status).toBe("started");
			if (admission.status === "started") handle = admission.task;
		});
		volt.registerTool({
			name: "checkpoint",
			label: "Checkpoint",
			description: "Test synchronization",
			parameters: Type.Object({}),
			execute: async () => {
				await handle?.wait();
				return { content: [{ type: "text", text: "checkpoint" }] };
			},
		});
		await extra?.(volt);
	};
	return { factory, boundaries, getHandle: () => handle!, getApi: () => api! };
}

function throughCheckpoint(harness: Harness, inspect: (context: Context) => void) {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("checkpoint", {})], { stopReason: "toolUse" }),
		checkedResponse(inspect),
	]);
}

describe("managed extension work through AgentSession", () => {
	it("uses active native reads and ready-only source evidence without canonical or tool-event pollution", async () => {
		let result: ExtensionWorkReadResult | undefined;
		const origins: string[] = [];
		const extension = consumer(
			async (task) => {
				result = await task.repository.readText({ path: "source.txt" });
				if (result.status === "ok")
					expect(
						task.context.put({
							key: "source",
							text: result.text,
							dependency: "sources",
							evidenceIds: [result.evidence.id],
						}),
					).toEqual({ status: "accepted" });
			},
			(volt) => {
				volt.on("tool_call", (event, ctx) => {
					if (event.toolName === "read") {
						origins.push(event.origin?.kind ?? "missing");
						expect(ctx.work).toBeUndefined();
						expect(ctx.signal).toBeDefined();
					}
				});
				volt.on("tool_result", (event, ctx) => {
					if (event.toolName === "read") expect(ctx.work).toBeUndefined();
				});
			},
		);
		const harness = await setup({ extensionFactories: [extension.factory] });
		await writeFile(join(harness.tempDir, "source.txt"), "prepared source\n");
		throughCheckpoint(harness, (context) => {
			expect(context.messages.map(getMessageText).join("\n")).toContain("prepared source");
			expect(context.messages.at(-1) && getMessageText(context.messages.at(-1))).toContain("untrusted");
		});
		await harness.session.prompt("inspect source");
		expect(result?.status).toBe("ok");
		expect(origins).toEqual(["extension", "extension"]);
		expect(extension.boundaries.map(({ event }) => event.cause)).toEqual(["input", "tools"]);
		expect(new Set(extension.boundaries.map(({ snapshot }) => snapshot.scopeId)).size).toBe(1);
		expect(JSON.stringify(harness.session.messages)).not.toContain("prepared source");
		expect(harness.eventsOfType("tool_execution_start").map((event) => event.toolName)).toEqual(["checkpoint"]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("leaves disabled consumers inactive and excludes extension-triggered turns", async () => {
		let boundaryCalls = 0;
		const harness = await setup({
			extensionFactories: [
				(volt) => {
					volt.on("request_boundary", () => {
						boundaryCalls++;
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("auxiliary")]);
		await harness.session.prompt("ordinary");
		await harness.session.sendUserMessage("extension input");
		expect(boundaryCalls).toBe(1);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
		const baseline = await setup();
		baseline.setResponses([
			checkedResponse((context) => {
				expect(context.messages.map(getMessageText)).toEqual(["ordinary"]);
			}),
		]);
		await baseline.session.prompt("ordinary");
		expect(baseline.faux.state.callCount).toBe(1);
	});

	it.each(["inactive", "override"] as const)(
		"rejects %s reads rather than invoking a hidden native factory",
		async (kind) => {
			let result: ExtensionWorkReadResult | undefined;
			let executed = 0;
			const extension = consumer(
				async (task) => {
					result = await task.repository.readText({ path: "source.txt" });
				},
				(volt) => {
					if (kind === "override")
						volt.registerTool({
							name: "read",
							label: "Replacement",
							description: "Replacement",
							parameters: Type.Object({ path: Type.String() }),
							execute: async () => {
								executed++;
								return { content: [{ type: "text", text: "private" }] };
							},
						});
				},
			);
			const harness = await setup({
				extensionFactories: [extension.factory],
				...(kind === "inactive" ? { initialActiveToolNames: [] } : {}),
			});
			throughCheckpoint(harness, () => {});
			await harness.session.prompt("inspect");
			expect(result).toMatchObject({ status: "unavailable", reason: "inactive_or_untrusted_tool" });
			expect(executed).toBe(0);
		},
	);

	it("returns typed unsupported outcomes for binary reads without source data", async () => {
		let result: ExtensionWorkReadResult | undefined;
		const extension = consumer(async (task) => {
			result = await task.repository.readText({ path: "source.bin" });
		});
		const harness = await setup({ extensionFactories: [extension.factory] });
		await writeFile(join(harness.tempDir, "source.bin"), Buffer.from([0, 1, 2]));
		throughCheckpoint(harness, () => {});
		await harness.session.prompt("inspect");
		expect(result).toEqual({ status: "unsupported", reason: "non_text_input" });
	});

	it.each(["redact", "details", "throw"] as const)(
		"withholds structured data after a %s result reducer",
		async (kind) => {
			let result: ExtensionWorkReadResult | undefined;
			const extension = consumer(
				async (task) => {
					result = await task.repository.readText({ path: "source.txt" });
				},
				(volt) => {
					volt.on("tool_result", (event) => {
						if (event.toolName !== "read") return;
						if (kind === "throw") throw new Error("sensitive error must not be an operation reason");
						if (kind === "details") return { details: { redacted: true } };
						return { content: [{ type: "text", text: "redacted" }] };
					});
				},
			);
			const harness = await setup({ extensionFactories: [extension.factory] });
			await writeFile(join(harness.tempDir, "source.txt"), "sensitive source");
			throughCheckpoint(harness, (context) => {
				expect(JSON.stringify(context)).not.toContain("sensitive source");
			});
			await harness.session.prompt("inspect");
			expect(result?.status).toBe(kind === "throw" ? "failed" : "unavailable");
			expect(result).not.toHaveProperty("text");
		},
	);

	it("revalidates arguments after call gates and honors host before-tool restrictions", async () => {
		const results: ExtensionWorkReadResult[] = [];
		let hostCalls = 0;
		const extension = consumer(
			async (task) => {
				results.push(await task.repository.readText({ path: "source.txt" }));
				results.push(await task.repository.readText({ path: "blocked.txt" }));
			},
			(volt) => {
				volt.on("tool_call", (event) => {
					if (event.toolName === "read" && event.input.path === "source.txt") event.input.limit = "not-a-number";
				});
			},
		);
		const harness = await setup({ extensionFactories: [extension.factory] });
		harness.session.registerTurnPolicy({
			beforeToolCall: (event, signal) => {
				if (event.toolName !== "read") return;
				hostCalls++;
				expect(signal.aborted).toBe(false);
				return { block: true };
			},
		});
		throughCheckpoint(harness, () => {});
		await harness.session.prompt("inspect");
		expect(results.map((result) => result.status)).toEqual(["failed", "denied"]);
		expect(hostCalls).toBe(1);
	});

	it.each(["before", "during"] as const)("honors host policy mutation %s a managed operation", async (timing) => {
		let result: ExtensionWorkReadResult | undefined;
		const extension = consumer(async (task) => {
			result = await task.repository.readText({ path: "source.txt" });
		});
		const harness = await setup({ extensionFactories: [extension.factory] });
		await writeFile(join(harness.tempDir, "source.txt"), "must not publish");
		const policy: AgentSessionTurnPolicy = {
			beforeToolCall: async (event) => {
				if (timing !== "during" || event.toolName !== "read") return;
				await Promise.resolve();
				policy.beforeToolCall = () => ({ block: true });
			},
		};
		harness.session.registerTurnPolicy(policy);
		if (timing === "before")
			policy.beforeToolCall = (event) => (event.toolName === "read" ? { block: true } : undefined);
		throughCheckpoint(harness, () => {});
		await harness.session.prompt("inspect");
		expect(result).toMatchObject(
			timing === "before"
				? { status: "denied", reason: "host_gate" }
				: { status: "invalidated", reason: "authority_changed" },
		);
		expect(result).not.toHaveProperty("text");
	});

	it.each(["tool_call", "tool_result"] as const)(
		"fences policies registered after earlier extensions were visited in %s",
		async (kind) => {
			let result: ExtensionWorkReadResult | undefined;
			const extension = consumer(async (task) => {
				result = await task.repository.readText({ path: "source.txt" });
			});
			const register = async (event: { toolName: string }) => {
				if (event.toolName !== "read") return;
				await Promise.resolve();
				if (kind === "tool_call") extension.getApi().on("tool_call", () => ({ block: true }));
				else extension.getApi().on("tool_result", () => ({ content: [] }));
			};
			const harness = await setup({
				extensionFactories: [
					extension.factory,
					(volt) => {
						if (kind === "tool_call") volt.on("tool_call", register);
						else volt.on("tool_result", register);
					},
				],
			});
			await writeFile(join(harness.tempDir, "source.txt"), "must not escape");
			throughCheckpoint(harness, () => {});
			await harness.session.prompt("inspect");
			expect(result).toEqual({ status: "invalidated", reason: "authority_changed" });
		},
	);

	it("rejects self-joins from asynchronous managed policy callbacks and drains", async () => {
		let joinError: unknown;
		const extension = consumer(async (task) => {
			await task.repository.readText({ path: "source.txt" });
		});
		const harness = await setup({ extensionFactories: [extension.factory] });
		await writeFile(join(harness.tempDir, "source.txt"), "source");
		harness.session.registerTurnPolicy({
			beforeToolCall: async (event) => {
				if (event.toolName !== "read") return;
				await Promise.resolve();
				try {
					await extension.getHandle().wait();
				} catch (error) {
					joinError = error;
				}
			},
		});
		throughCheckpoint(harness, () => {});
		await harness.session.prompt("inspect");
		expect(joinError).toBeInstanceOf(Error);
		expect((joinError as Error).message).toContain("cannot join managed tasks");
		expect(extension.getHandle().status().state).toBe("completed");
		harness.session.dispose();
		await harness.session.waitForClosed();
	});

	it("does not publish a result when a gate replaces the active implementation", async () => {
		let result: ExtensionWorkReadResult | undefined;
		let replacementCalls = 0;
		const extension = consumer(
			async (task) => {
				result = await task.repository.readText({ path: "source.txt" });
			},
			(volt) => {
				volt.on("tool_call", (event) => {
					if (event.toolName !== "read") return;
					volt.registerTool({
						name: "read",
						label: "Replacement",
						description: "replacement",
						parameters: Type.Object({ path: Type.String() }),
						execute: async () => {
							replacementCalls++;
							return { content: [] };
						},
					});
				});
			},
		);
		const harness = await setup({ extensionFactories: [extension.factory] });
		throughCheckpoint(harness, () => {});
		await harness.session.prompt("inspect");
		expect(result?.status).toMatch(/invalidated|cancelled/);
		expect(replacementCalls).toBe(0);
	});

	it("omits evidence after an out-of-band source edit", async () => {
		let sourcePath = "";
		const extension = consumer(async (task) => {
			const read = await task.repository.readText({ path: "source.txt" });
			expect(read.status).toBe("ok");
			if (read.status === "ok")
				task.context.put({
					key: "source",
					text: read.text,
					dependency: "sources",
					evidenceIds: [read.evidence.id],
				});
			await writeFile(sourcePath, "changed after observation");
		});
		const harness = await setup({ extensionFactories: [extension.factory] });
		sourcePath = join(harness.tempDir, "source.txt");
		await writeFile(sourcePath, "old observation");
		throughCheckpoint(harness, (context) => {
			expect(JSON.stringify(context.messages)).not.toContain("old observation");
		});
		await harness.session.prompt("inspect");
		expect(extension.getApi().getWorkStatus().contributions).toContainEqual({
			key: "source",
			status: "omitted",
			reason: "source_unverified",
		});
	});

	it("does not award Plan research credit for a managed read", async () => {
		let readStatus: string | undefined;
		let decision: { block?: boolean; reason?: string } | undefined;
		const extension = consumer(async (task) => {
			readStatus = (await task.repository.readText({ path: "source.txt" })).status;
		});
		const harness = await setup({ extensionFactories: [extension.factory] });
		await writeFile(join(harness.tempDir, "source.txt"), "research");
		await harness.session.setAgentMode("plan");
		harness.setResponses([
			async () => {
				await extension.getHandle().wait();
				decision = await harness.control.evaluateToolCall({
					type: "tool_call",
					toolCallId: "submit",
					toolName: "submit_plan",
					input: {},
				});
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("research");
		expect(readStatus).toBe("ok");
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("at least one successful read");
	});

	it("rejects post-await recursive work from host policy lineage", async () => {
		let retained: ExtensionWorkContext | undefined;
		let recursiveStatus = "";
		const extension = consumer(
			async (task) => {
				await task.repository.readText({ path: "source.txt" });
			},
			(volt) => {
				volt.on("request_boundary", (_event, ctx) => {
					retained = ctx.work;
				});
			},
		);
		const harness = await setup({ extensionFactories: [extension.factory] });
		await writeFile(join(harness.tempDir, "source.txt"), "source");
		harness.session.registerTurnPolicy({
			beforeToolCall: async (event) => {
				if (event.toolName !== "read") return;
				await Promise.resolve();
				recursiveStatus = retained!.tasks.start({ key: "recursive", label: "recursive" }, async () => {}).status;
			},
		});
		throughCheckpoint(harness, () => {});
		await harness.session.prompt("inspect");
		expect(recursiveStatus).toBe("denied");
	});

	it("keeps scopes across retries but fences late callbacks at foreground settlement without waking", async () => {
		const release = deferred();
		const started = deferred();
		let lateStatus = "";
		const extension = consumer(async (task) => {
			started.resolve();
			await release.promise;
			lateStatus = task.context.put({ key: "late", text: "must not appear" }).status;
		});
		const harness = await setup({
			extensionFactories: [extension.factory],
			settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		harness.setResponses([
			async () => {
				await started.promise;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect");
		expect(extension.boundaries.map(({ event }) => event.cause)).toEqual(["input", "retry"]);
		expect(new Set(extension.boundaries.map(({ snapshot }) => snapshot.scopeId)).size).toBe(1);
		const messages = structuredClone(harness.session.messages);
		release.resolve();
		await extension.getHandle().wait();
		expect(lateStatus).toBe("invalidated");
		expect(harness.session.messages).toEqual(messages);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("revokes on steer acceptance, not follow-up admission, and reports each committed batch", async () => {
		const entered = deferred();
		const releaseProvider = deferred();
		const releaseTask = deferred();
		const signals: AbortSignal[] = [];
		const extension = consumer(async (task) => {
			signals.push(task.signal);
			await releaseTask.promise;
		});
		const harness = await setup({ extensionFactories: [extension.factory] });
		harness.setResponses([
			async () => {
				entered.resolve();
				await releaseProvider.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("steered"),
			fauxAssistantMessage("followed"),
		]);
		const run = harness.session.prompt("same");
		await entered.promise;
		await harness.session.followUp("same");
		expect(signals[0]?.aborted).toBe(false);
		await harness.session.steer("same");
		expect(signals[0]?.aborted).toBe(true);
		releaseTask.resolve();
		releaseProvider.resolve();
		await run;
		expect(extension.boundaries.map(({ snapshot }) => snapshot.inputs.map((input) => input.kind))).toEqual([
			["prompt"],
			["steer"],
			["followUp"],
		]);
	});

	it("drains host-owned policy work before disposal completes without joining arbitrary callbacks", async () => {
		const entered = deferred();
		const release = deferred();
		const extension = consumer(async (task) => {
			await task.repository.readText({ path: "source.txt" });
		});
		const harness = await setup({ extensionFactories: [extension.factory] });
		harness.session.registerTurnPolicy({
			beforeToolCall: async (event) => {
				if (event.toolName !== "read") return;
				entered.resolve();
				await release.promise;
			},
		});
		harness.setResponses([
			async () => {
				await entered.promise;
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("inspect");
		harness.session.dispose();
		let closed = false;
		const close = harness.session.waitForClosed().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		release.resolve();
		await close;
		expect(closed).toBe(true);
	});
});
