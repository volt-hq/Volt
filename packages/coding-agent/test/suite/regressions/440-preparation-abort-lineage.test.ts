import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import type { ExtensionWorkTaskHandle } from "../../../src/core/extensions/work-types.ts";
import { createHarness } from "../harness.ts";

describe("PR #440: preparation controls from managed task abort listeners", () => {
	it.each(["completion", "cancellation", "deadline"] as const)(
		"rejects synchronous and asynchronous requests during task %s",
		async (ending) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const installed = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let command!: ExtensionCommandContext;
			let handle: ExtensionWorkTaskHandle | undefined;
			let requests: Promise<Array<number | undefined>> | undefined;
			const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(true);
			const harness = await createHarness({
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: [
					(volt) => {
						volt.registerCommand("capture", {
							handler: async (_args, ctx) => {
								command = ctx;
							},
						});
						volt.on("request_boundary", (event, ctx) => {
							if (!event.first || !ctx.work) return;
							const admission = ctx.work.tasks.start(
								{ key: "abort-listener", label: "Abort listener", timeoutMs: 50 },
								async (task) => {
									task.signal.addEventListener(
										"abort",
										() => {
											requests = (async () => {
												const synchronous = await command.requestPreparationWait(100);
												await Promise.resolve();
												const asynchronous = await command.requestPreparationWait(200);
												return [synchronous, asynchronous];
											})();
											release.resolve();
										},
										{ once: true },
									);
									installed.resolve();
									await release.promise;
								},
							);
							if (admission.status === "started") handle = admission.task;
						});
					},
				],
			});
			try {
				harness.session.setSessionName("Preparation abort lineage regression");
				await harness.session.bindExtensions({
					mode: "tui",
					uiContext: { ...harness.session.extensionRunner.getUIContext(), confirm },
				});
				await harness.session.prompt("/capture");
				harness.setResponses([
					async () => {
						await installed.promise;
						if (ending === "completion") release.resolve();
						else if (ending === "cancellation") handle?.cancel();
						else await vi.advanceTimersByTimeAsync(50);
						await handle?.wait();
						return fauxAssistantMessage("done");
					},
				]);
				await harness.session.prompt("Run preparation");
				expect(requests).toBeDefined();
				expect(await requests).toEqual([undefined, undefined]);
				expect(confirm).not.toHaveBeenCalled();
				expect(command.getPreparationWait()).toEqual({ waitMs: 0, maxWaitMs: 1000 });
				expect(handle?.status().state).toBe(ending === "completion" ? "completed" : "cancelled");
				expect(harness.faux.state.callCount).toBe(1);
			} finally {
				release.resolve();
				vi.useRealTimers();
				await harness.cleanupAsync();
			}
		},
	);
});
