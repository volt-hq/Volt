import type { HostFrame, LiveItem } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { createLoopbackClient } from "../src/client/protocol-client.ts";
import { createHostHarness, type HostHarness } from "./suite/host-harness.ts";

type AssistantDelta = Extract<LiveItem, { type: "assistant_delta" }>;

const harnesses: HostHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

describe("assistant formatting on the protocol wire", () => {
	test("streams and commits raw assistant Markdown text for final surfaces", async () => {
		const formattedText = ["Here is a plan:", "- Step one", "- Step two", "```swift", "\tlet value = 1", "```"].join(
			"\n",
		);
		const harness = await createHostHarness({ responses: [formattedText] });
		harnesses.push(harness);
		const conversation = await harness.openStartup();
		const frames: HostFrame[] = [];
		const client = await createLoopbackClient(harness.host, conversation, { onFrame: (frame) => frames.push(frame) });
		try {
			await client.prompt("formatting");
			await client.waitForIdle(10_000);

			const deltas = frames.flatMap((frame) =>
				frame.type === "live"
					? frame.items.filter((item): item is AssistantDelta => item.type === "assistant_delta")
					: [],
			);
			const textDeltas = deltas.flatMap((item) => (item.event.type === "text_delta" ? [item.event.delta] : []));
			expect(textDeltas.join("")).toBe(formattedText);

			const textEnd = deltas.find((item) => item.event.type === "text_end");
			if (textEnd?.event.type !== "text_end") throw new Error("Expected a text_end delta");
			expect(textEnd.event.content).toBe(formattedText);
			// Deltas are slim: no accumulated message or partial rides along.
			expect("message" in textEnd.event).toBe(false);
			expect("partial" in textEnd.event).toBe(false);

			// The committed entry carries the raw Markdown, as does a history page.
			const assistant = client.state.entries.find(
				(entry) => entry.type === "message" && entry.view?.role === "assistant",
			);
			expect(assistant?.type === "message" ? assistant.view?.text : undefined).toBe(formattedText);
			const page = await client.query("history", { before: client.state.ordinal + 1, limit: 10 });
			const paged = page.entries.find((entry) => entry.type === "message" && entry.view?.role === "assistant");
			expect(paged?.type === "message" ? paged.view?.text : undefined).toBe(formattedText);
		} finally {
			await client.stop();
		}
	});
});
