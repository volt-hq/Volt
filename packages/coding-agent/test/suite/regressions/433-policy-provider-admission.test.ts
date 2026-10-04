import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionTurnPolicy } from "../../../src/core/agent-session.ts";
import type {
	ExtensionOperationOrigin,
	ExtensionServicesReadResult,
	ExtensionServicesStatus,
	ExtensionServicesTaskHandle,
} from "../../../src/core/extensions/services-types.ts";
import type {
	ExtensionAPI,
	ExtensionHandler,
	PolicyRegistration,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "../../../src/core/extensions/types.ts";
import { createHarness, getMessageText } from "../harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

type Change = "unchanged" | "update" | "restore" | "invalidate" | "remove" | "register";
function changeRegistration<T>(
	action: Change,
	registration: PolicyRegistration<T>,
	original: T,
	denied: T,
	restrict: () => void,
	register: () => void,
) {
	switch (action) {
		case "unchanged":
			return;
		case "update":
			registration.update(denied);
			return;
		case "restore":
			registration.update(denied);
			registration.update(original);
			return;
		case "invalidate":
			restrict();
			registration.invalidate();
			return;
		case "remove":
			registration();
			return;
		case "register":
			register();
			return;
	}
}

describe("#433 provider handoff diagnostics", () => {
	it.each(["policy", "scope"] as const)(
		"cannot undo admission when synchronous provider code changes %s",
		async (change) => {
			let api!: ExtensionAPI;
			let policy!: PolicyRegistration<AgentSessionTurnPolicy>;
			let contextText = "";
			const statuses: ExtensionServicesStatus["contributions"][] = [];
			let boundaries = 0;
			const harness = await createHarness({
				settings: { compaction: { enabled: false } },
				extensionServicesLimits: { firstRequestWaitMs: 100 },
				extensionFactories: [
					(volt) => {
						api = volt;
						volt.on("request_boundary", (_event, ctx) => {
							boundaries++;
							ctx.services!.context.requestWait(100);
							ctx.services!.tasks.start({ key: "prepare", label: "Prepare" }, async (task) => {
								task.context.put({ key: "suggestion", text: "prepared suggestion" });
							});
						});
					},
				],
			});
			try {
				await harness.session.setSessionName("handoff diagnostics");
				policy = harness.session.registerTurnPolicy({ beforeToolCall: () => undefined });
				const stream = harness.control.getStreamFn();
				harness.control.setStreamFn((model, context, options) => {
					contextText = context.messages.map(getMessageText).join("\n");
					statuses.push(api.getServicesStatus().contributions);
					if (change === "policy") policy.invalidate();
					else harness.session.setActiveToolsByName([]);
					statuses.push(api.getServicesStatus().contributions);
					return stream(model, context, options);
				});
				harness.setResponses([fauxAssistantMessage("done")]);
				await harness.session.prompt("mandatory request");
				expect(contextText).toContain("prepared suggestion");
				expect(contextText).toContain("mandatory request");
				expect(statuses).toEqual(Array(2).fill([{ key: "suggestion", status: "admitted" }]));
				expect(api.getServicesStatus().contributions).toEqual([{ key: "suggestion", status: "admitted" }]);
				expect(boundaries).toBe(1);
				expect(harness.faux.state.callCount).toBe(1);
				expect(JSON.stringify(harness.session.messages)).not.toContain("prepared suggestion");
			} finally {
				await harness.cleanupAsync();
			}
		},
	);
});

const operationCases = (["host", "tool_call", "tool_result"] as const).flatMap((layer) =>
	(["unchanged", "update", "restore", "invalidate"] as const).map((action) => ({ layer, action })),
);
describe("#433 managed task result exposure", () => {
	it.each(operationCases)("$layer $action during a result reducer await", async ({ layer, action }) => {
		const entered = deferred();
		const release = deferred();
		let change = () => {};
		let restricted = false;
		let result: ExtensionServicesReadResult | undefined;
		let handle: ExtensionServicesTaskHandle | undefined;
		let operations = 0;
		const harness = await createHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [
				(volt) => {
					if (layer === "tool_call") {
						const original: ExtensionHandler<ToolCallEvent, ToolCallEventResult> = () =>
							restricted ? { block: true } : undefined;
						const denied: typeof original = () => ({ block: true });
						const registration = volt.on("tool_call", original);
						change = () =>
							changeRegistration(
								action,
								registration,
								original,
								denied,
								() => {
									restricted = true;
								},
								() => {},
							);
					} else if (layer === "tool_result") {
						const original: ExtensionHandler<ToolResultEvent, ToolResultEventResult> = () =>
							restricted ? { content: [] } : undefined;
						const denied: typeof original = () => ({ content: [] });
						const registration = volt.on("tool_result", original);
						change = () =>
							changeRegistration(
								action,
								registration,
								original,
								denied,
								() => {
									restricted = true;
								},
								() => {},
							);
					}
					volt.on("request_boundary", (_event, ctx) => {
						const admission = ctx.services!.tasks.start({ key: "read", label: "Read" }, async (task) => {
							result = await task.repository.readText({ path: "source.txt" });
						});
						if (admission.status === "started") handle = admission.task;
					});
				},
				(volt) => {
					volt.on("tool_result", async (event) => {
						if (event.origin?.kind !== "extension") return;
						entered.resolve();
						await release.promise;
					});
					volt.on("extension_operation", () => {
						operations++;
					});
				},
			],
		});
		try {
			await harness.session.setSessionName("task result fence");
			if (layer === "host") {
				const original: AgentSessionTurnPolicy = {
					beforeToolCall: () => (restricted ? { block: true } : undefined),
				};
				const denied: AgentSessionTurnPolicy = { beforeToolCall: () => ({ block: true }) };
				const registration = harness.session.registerTurnPolicy(original);
				change = () =>
					changeRegistration(
						action,
						registration,
						original,
						denied,
						() => {
							restricted = true;
						},
						() => {},
					);
			}
			await writeFile(join(harness.tempDir, "source.txt"), "private observation");
			// Settling the turn invalidates its work scope, so the request holds the turn open
			// until the task settles instead of racing the read against a first-request wait.
			harness.setResponses([
				async () => {
					await handle!.wait();
					return fauxAssistantMessage("done");
				},
			]);
			const run = harness.session.prompt("inspect");
			await entered.promise;
			change();
			release.resolve();
			await run;
			if (action === "unchanged") expect(result).toMatchObject({ status: "ok", text: "private observation" });
			else {
				expect(result).toEqual({ status: "invalidated", reason: "authority_changed" });
				expect(result).not.toHaveProperty("text");
				expect(result).not.toHaveProperty("evidence");
			}
			expect(operations).toBe(1);
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			release.resolve();
			await harness.cleanupAsync();
		}
	});
});

describe("#433 host policy ownership", () => {
	it("snapshots callbacks at registration and update instead of following caller mutation", async () => {
		let executions = 0;
		const probe: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Turn policy probe",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "probed" }] };
			},
		};
		const harness = await createHarness({ tools: [probe] });
		// One foreground turn whose model calls the probe; resolves whether the turn policy let it run.
		const probeRuns = async (): Promise<boolean> => {
			const before = executions;
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("probe");
			expect(harness.getPendingResponseCount()).toBe(0);
			const ran = executions > before;
			expect(harness.eventsOfType("tool_execution_end").at(-1)?.isError).toBe(!ran);
			return ran;
		};
		try {
			const policy: AgentSessionTurnPolicy = { beforeToolCall: () => undefined };
			const registration = harness.session.registerTurnPolicy(policy);
			policy.beforeToolCall = () => ({ block: true });
			expect(await probeRuns()).toBe(true);
			registration.update(policy);
			policy.beforeToolCall = () => undefined;
			expect(await probeRuns()).toBe(false);
			registration();
			registration();
			expect(await probeRuns()).toBe(true);
			expect(() => registration.update(policy)).toThrow("removed");
			expect(() => registration.invalidate()).toThrow("removed");
		} finally {
			await harness.cleanupAsync();
		}
	});
});

const cases = (["host", "tool_call", "tool_result"] as const).flatMap((layer) =>
	(["unchanged", "update", "restore", "invalidate", "remove", "register"] as const).map((action) => ({
		layer,
		action,
	})),
);

// "collection": the change lands while later sources still await validation.
// "final validation": it lands in the last source's result hook, after every source was re-read;
// the conversation checks authorization after the request boundary without yielding.
describe.each(["collection", "final validation"] as const)("#433 policy authorization during %s", (phase) => {
	it.each(cases)("$layer $action", async ({ layer, action }) => {
		const entered = deferred();
		const release = deferred();
		const releaseB = deferred();
		let api!: ExtensionAPI;
		let handle: ExtensionServicesTaskHandle | undefined;
		let providerContext: Context | undefined;
		let change = () => {};
		let restricted = false;
		let validationsCompleted = 0;
		let paused = false;
		let boundaries = 0;
		const validations: string[] = [];
		const pause = async () => {
			paused = true;
			entered.resolve();
			await release.promise;
		};
		const harness = await createHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [
				(volt) => {
					api = volt;
					if (layer === "tool_call") {
						const original: ExtensionHandler<ToolCallEvent, ToolCallEventResult> = (event) =>
							restricted && event.toolName === "read" && event.input.path === "a.txt"
								? { block: true }
								: undefined;
						const denied: typeof original = (event) => (event.toolName === "read" ? { block: true } : undefined);
						const registration = volt.on("tool_call", original);
						change = () =>
							changeRegistration(
								action,
								registration,
								original,
								denied,
								() => {
									restricted = true;
								},
								() => {
									volt.on("tool_call", denied);
								},
							);
					} else if (layer === "tool_result") {
						const original: ExtensionHandler<ToolResultEvent, ToolResultEventResult> = (event) =>
							restricted && event.toolName === "read" && event.input.path === "a.txt"
								? { content: [] }
								: undefined;
						const denied: typeof original = (event) => (event.toolName === "read" ? { content: [] } : undefined);
						const registration = volt.on("tool_result", original);
						change = () =>
							changeRegistration(
								action,
								registration,
								original,
								denied,
								() => {
									restricted = true;
								},
								() => {
									volt.on("tool_result", denied);
								},
							);
					}
					volt.on("request_boundary", (event, ctx) => {
						boundaries++;
						if (!event.first) return;
						const admission = ctx.services!.tasks.start({ key: "prepare", label: "Prepare" }, async (task) => {
							for (const key of ["a", "b", "c"]) {
								const read = await task.repository.readText({ path: `${key}.txt` });
								if (read.status !== "ok") throw new Error(read.status);
								task.context.put({
									key,
									text: read.text,
									dependency: "sources",
									evidenceIds: [read.evidence.id],
								});
							}
						});
						if (admission.status === "started") handle = admission.task;
					});
					volt.registerTool({
						name: "checkpoint",
						label: "Checkpoint",
						description: "Test synchronization",
						parameters: Type.Object({}),
						execute: async () => {
							expect((await handle!.wait()).state).toBe("completed");
							vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
							return { content: [{ type: "text", text: "checkpoint" }] };
						},
					});
				},
				(volt) => {
					const isValidation = (origin: ExtensionOperationOrigin | undefined) =>
						origin?.kind === "extension" && origin.ownerKind === "validation";
					volt.on("tool_call", async (event) => {
						if (event.toolName !== "read" || !isValidation(event.origin)) return;
						validations.push(String(event.input.path));
						if (phase !== "collection") return;
						if (event.input.path === "b.txt") await releaseB.promise;
						if (event.input.path === "c.txt") {
							expect(validationsCompleted).toBe(1);
							await pause();
							releaseB.resolve();
						}
					});
					volt.on("tool_result", async (event) => {
						if (
							phase !== "final validation" ||
							event.toolName !== "read" ||
							!isValidation(event.origin) ||
							event.input.path !== "c.txt"
						)
							return;
						expect(validations).toEqual(["a.txt", "b.txt", "c.txt"]);
						await pause();
					});
					volt.on("extension_operation", (event) => {
						if (event.ownerKind === "validation") validationsCompleted++;
					});
				},
			],
		});
		try {
			await harness.session.setSessionName("versioned policy admission");
			if (layer === "host") {
				const original: AgentSessionTurnPolicy = {
					beforeToolCall: (event) =>
						restricted && event.toolName === "read" && event.input.path === "a.txt" ? { block: true } : undefined,
				};
				const denied: AgentSessionTurnPolicy = {
					beforeToolCall: (event) => (event.toolName === "read" ? { block: true } : undefined),
				};
				const registration = harness.session.registerTurnPolicy(original);
				change = () =>
					changeRegistration(
						action,
						registration,
						original,
						denied,
						() => {
							restricted = true;
						},
						() => {
							harness.session.registerTurnPolicy(denied);
						},
					);
			}
			for (const key of ["a", "b", "c"])
				await writeFile(join(harness.tempDir, `${key}.txt`), `prepared source ${key}`);
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("checkpoint", {})], { stopReason: "toolUse" }),
				(context) => {
					providerContext = { ...context, messages: structuredClone(context.messages) };
					return fauxAssistantMessage("done");
				},
			]);
			const run = harness.session.prompt("mandatory request");
			await entered.promise;
			change();
			release.resolve();
			await run;
			expect(paused).toBe(true);
			expect(validations).toEqual(["a.txt", "b.txt", "c.txt"]);
			expect(boundaries).toBe(2);
			expect(harness.faux.state.callCount).toBe(2);
			expect(providerContext).toBeDefined();
			const text = providerContext!.messages.map(getMessageText).join("\n");
			expect(text).toContain("mandatory request");
			for (const key of ["a", "b", "c"]) {
				if (action === "unchanged") expect(text).toContain(`prepared source ${key}`);
				else expect(text).not.toContain(`prepared source ${key}`);
			}
			expect(api.getServicesStatus().contributions).toEqual(
				["a", "b", "c"].map((key) =>
					action === "unchanged"
						? { key, status: "admitted" }
						: { key, status: "omitted", reason: "authority_changed" },
				),
			);
			expect(JSON.stringify(harness.session.messages)).not.toContain("prepared source");
		} finally {
			release.resolve();
			releaseB.resolve();
			vi.useRealTimers();
			await harness.cleanupAsync();
		}
	});
});
