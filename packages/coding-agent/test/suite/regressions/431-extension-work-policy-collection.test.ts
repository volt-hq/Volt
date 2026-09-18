import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionTurnPolicy } from "../../../src/core/agent-session.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import type { ExtensionWorkTaskHandle } from "../../../src/core/extensions/work-types.ts";
import { createHarness, getMessageText } from "../harness.ts";

describe("managed context collection policy fence (#431)", () => {
	it.each(["unchanged", "tool_call", "tool_result", "host_callback"] as const)(
		"checks %s policies after an earlier source has validated",
		async (kind) => {
			let api!: ExtensionAPI;
			let handle: ExtensionWorkTaskHandle | undefined;
			let providerContext: Context | undefined;
			let releaseB!: () => void;
			const pendingB = new Promise<void>((resolve) => {
				releaseB = resolve;
			});
			const validations: string[] = [];
			const validationResults: string[] = [];
			let bPending = false;
			let changed = false;
			const policy: AgentSessionTurnPolicy = { beforeToolCall: () => undefined };
			const harness = await createHarness({
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: [
					(volt) => {
						api = volt;
						volt.on("request_boundary", (event, ctx) => {
							if (!event.first) return;
							const admission = ctx.work!.tasks.start({ key: "prepare", label: "Prepare" }, async (task) => {
								for (const key of ["a", "b", "c"]) {
									const read = await task.repository.readText({ path: `${key}.txt` });
									if (read.status !== "ok") throw new Error(read.status);
									expect(
										task.context.put({
											key,
											text: read.text,
											dependency: "sources",
											evidenceIds: [read.evidence.id],
										}),
									).toEqual({ status: "accepted" });
								}
							});
							expect(admission.status).toBe("started");
							if (admission.status === "started") handle = admission.task;
						});
						volt.registerTool({
							name: "checkpoint",
							label: "Checkpoint",
							description: "Test synchronization",
							parameters: Type.Object({}),
							execute: async () => {
								expect((await handle!.wait()).state).toBe("completed");
								// Exercise ordering, not the collection's wall-clock budget.
								vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
								return { content: [{ type: "text", text: "checkpoint" }] };
							},
						});
					},
					(volt) => {
						volt.on("tool_call", async (event) => {
							if (
								event.toolName !== "read" ||
								event.origin?.kind !== "extension" ||
								event.origin.ownerKind !== "validation"
							)
								return;
							validations.push(String(event.input.path));
							if (event.input.path === "b.txt") {
								bPending = true;
								await pendingB;
								bPending = false;
							}
							if (event.input.path !== "c.txt") return;
							// Two workers: C can start only after A validates while B is held.
							expect(bPending).toBe(true);
							expect(validationResults).toEqual(["ok"]);
							if (kind === "tool_call")
								api.on("tool_call", (call) =>
									call.toolName === "read" && call.input.path === "a.txt" ? { block: true } : undefined,
								);
							if (kind === "tool_result")
								api.on("tool_result", (result) =>
									result.toolName === "read" && result.input.path === "a.txt"
										? { content: [{ type: "text", text: "redacted" }] }
										: undefined,
								);
							if (kind === "host_callback")
								policy.beforeToolCall = (call) =>
									call.toolName === "read" && call.input.path === "a.txt" ? { block: true } : undefined;
							changed = kind !== "unchanged";
							releaseB();
						});
						volt.on("tool_result", () => undefined);
						volt.on("extension_operation", (event) => {
							if (event.ownerKind === "validation") validationResults.push(event.status);
						});
					},
				],
			});
			try {
				harness.session.setSessionName("collection policy fence");
				harness.session.registerTurnPolicy(policy);
				for (const key of ["a", "b", "c"])
					await writeFile(join(harness.tempDir, `${key}.txt`), `prepared source ${key}`);
				harness.setResponses([
					fauxAssistantMessage([fauxToolCall("checkpoint", {})], { stopReason: "toolUse" }),
					(context) => {
						providerContext = { ...context, messages: structuredClone(context.messages) };
						return fauxAssistantMessage("done");
					},
				]);
				await harness.session.prompt("inspect sources");
				expect(validations).toEqual(["a.txt", "b.txt", "c.txt"]);
				expect(changed).toBe(kind !== "unchanged");
				// Faux-provider callback failures are contained; assert after the request.
				expect(providerContext).toBeDefined();
				const text = providerContext!.messages.map(getMessageText).join("\n");
				expect(text).toContain("inspect sources");
				for (const key of ["a", "b", "c"]) {
					if (kind === "unchanged") expect(text).toContain(`prepared source ${key}`);
					else expect(text).not.toContain(`prepared source ${key}`);
				}
				if (kind !== "unchanged") expect(text).not.toContain("Extension context");
				expect(api.getWorkStatus().contributions).toEqual(
					["a", "b", "c"].map((key) =>
						kind === "unchanged"
							? { key, status: "admitted" }
							: { key, status: "omitted", reason: "authority_changed" },
					),
				);
				expect(harness.faux.state.callCount).toBe(2);
				expect(JSON.stringify(harness.session.messages)).not.toContain("prepared source");
			} finally {
				releaseB();
				vi.useRealTimers();
				await harness.cleanupAsync();
			}
		},
	);
});
