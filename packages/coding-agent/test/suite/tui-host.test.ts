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
});
