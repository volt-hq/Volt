import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createJevContextPreparation } from "../../../examples/extensions/jev-context-preparation.ts";
import type { ExtensionWorkTaskHandle } from "../../../src/core/extensions/work-types.ts";
import { loadSkillsFromDir } from "../../../src/core/skills.ts";
import { createHarness, getMessageText } from "../harness.ts";

describe("PR #440: alternate skill preparation crossing the first-request cutoff", () => {
	it.each(["validation", "projection", "cancellation"] as const)(
		"preserves fallback when the alternate read settles during %s",
		async (stage) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
			const fallbackRead = Promise.withResolvers<void>();
			const releaseEvaluation = Promise.withResolvers<void>();
			const alternateRead = Promise.withResolvers<void>();
			const alternateFinished = Promise.withResolvers<void>();
			const releaseAlternate = Promise.withResolvers<void>();
			const validation = Promise.withResolvers<void>();
			const releaseValidation = Promise.withResolvers<void>();
			let handle: ExtensionWorkTaskHandle | undefined;
			let taskReads = 0;
			const fetch = vi.fn<typeof globalThis.fetch>(async () => {
				await releaseEvaluation.promise;
				return Response.json({ answers: { skill: { type: "choice", choice: "skill-2" } } });
			});
			const harness = await createHarness({
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionWorkLimits: { firstRequestWaitMs: 800 },
				extensionFactories: [
					(volt) => {
						createJevContextPreparation({ enabled: true, fetch })(volt);
						volt.on("request_boundary", (event, ctx) => {
							if (!event.first || !ctx.work) return;
							const existing = ctx.work.tasks.start(
								{ key: "prepare-context", label: "Existing preparation" },
								async () => {},
							);
							if (existing.status === "already_running") handle = existing.task;
						});
					},
					(volt) => {
						volt.on("extension_operation", (event) => {
							if (event.ownerKind !== "task") return;
							if (++taskReads === 1) fallbackRead.resolve();
							else alternateFinished.resolve();
						});
						volt.on("tool_call", async (event) => {
							if (event.toolName !== "read" || event.origin?.kind !== "extension") return;
							if (event.origin.ownerKind === "task" && String(event.input.path).includes("beta")) {
								alternateRead.resolve();
								await releaseAlternate.promise;
							} else if (event.origin.ownerKind === "validation" && stage === "validation") {
								validation.resolve();
								await releaseValidation.promise;
							}
						});
						volt.registerTool({
							name: "checkpoint",
							label: "Checkpoint",
							description: "Wait for skill preparation to settle",
							parameters: Type.Object({}),
							execute: async () => {
								if (stage === "cancellation") handle?.cancel();
								releaseAlternate.resolve();
								await handle?.wait();
								return { content: [{ type: "text", text: "done" }] };
							},
						});
					},
				],
			});
			try {
				harness.session.setSessionName("Jev alternate skill cutoff regression");
				harness.authStorage.set("vercel-ai-gateway", { type: "api_key", key: "synthetic-key" });
				const root = join(harness.tempDir, "skills");
				for (const name of ["alpha", "beta"]) {
					const directory = join(root, name);
					await mkdir(directory, { recursive: true });
					await writeFile(
						join(directory, "SKILL.md"),
						`---\nname: ${name}\ndescription: Specialized workflow\n---\nBODY_${name}\n`,
					);
				}
				const skills = loadSkillsFromDir({ dir: root, source: "user" });
				harness.session.resourceLoader.getSkills = () => skills;
				const projections: string[] = [];
				harness.setResponses(
					[0, 1].map((index) => async (context, options, _state, model) => {
						await options?.onPayload?.({ messages: context.messages }, model);
						projections.push(context.messages.map(getMessageText).join("\n"));
						return index === 0
							? fauxAssistantMessage([fauxToolCall("checkpoint", {})], { stopReason: "toolUse" })
							: fauxAssistantMessage("done");
					}),
				);
				const running = harness.session.prompt("Use alpha");
				await fallbackRead.promise;
				await vi.advanceTimersByTimeAsync(790);
				releaseEvaluation.resolve();
				await alternateRead.promise;
				expect(harness.faux.state.callCount).toBe(0);
				await vi.advanceTimersByTimeAsync(10);
				if (stage === "validation") {
					await validation.promise;
					releaseAlternate.resolve();
					await alternateFinished.promise;
					await vi.advanceTimersByTimeAsync(0);
					expect(handle?.status().state).toBe("running");
					expect(harness.faux.state.callCount).toBe(0);
					releaseValidation.resolve();
				}
				await running;
				expect(projections).toHaveLength(2);
				expect(projections[0]).toContain("BODY_alpha");
				expect(projections[0]).not.toContain("BODY_beta");
				if (stage === "cancellation") {
					expect(projections[1]).not.toContain("BODY_beta");
					expect(handle?.status().state).toBe("cancelled");
				} else {
					expect(projections[1]).toContain("BODY_beta");
					expect(projections[1]).not.toContain("BODY_alpha");
					expect(handle?.status().state).toBe("completed");
				}
				expect(performance.now()).toBe(800);
				expect(fetch).toHaveBeenCalledOnce();
				expect(taskReads).toBe(2);
				expect(harness.faux.state.callCount).toBe(2);
			} finally {
				releaseEvaluation.resolve();
				releaseAlternate.resolve();
				releaseValidation.resolve();
				vi.useRealTimers();
				await harness.cleanupAsync();
			}
		},
	);
});
