import { afterEach, describe, expect, it, vi } from "vitest";
import { createTuiHarness, type TuiHarness } from "./tui-harness.ts";

describe("TuiHost", () => {
	let harness: TuiHarness | undefined;

	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
	});

	it("connects the TUI's client over loopback: its prompts are interactive input, and it anchors its conversation", async () => {
		const sources: string[] = [];
		harness = await createTuiHarness({
			extension: (volt) => {
				volt.on("input", (event) => {
					sources.push(event.source);
				});
			},
		});
		const recover = vi.spyOn(harness.startup, "startRecoveredClientInputs");
		const client = await harness.connect();
		// Without the daemon, the conversation's queued input is recovered once the client is ready.
		expect(recover).toHaveBeenCalledOnce();

		await client.promptAndWait("hello");
		expect(sources).toEqual(["interactive"]);

		await harness.tuiHost.dispose();
		expect(harness.startup.closed).toBe(true);
	});

	it("keeps the model scope the TUI started with across a profile switch", async () => {
		// The host harness's faux provider and model.
		harness = await createTuiHarness({ modelScopePatterns: ["faux/faux-1"] });
		const client = await harness.connect();
		expect(harness.startup.session.scopedModels).toEqual([]);

		await client.intent("set_profile", { name: "work", create: true });

		expect(harness.startup.session.scopedModels.map((scoped) => scoped.model.id)).toEqual(["faux-1"]);
	});
});
