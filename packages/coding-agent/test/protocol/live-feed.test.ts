/**
 * The live feed: what a conversation's session sets in its live state, and
 * the streaming state the committed entries end.
 */

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@hansjm10/volt-ai";
import type { LiveItem } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { feedLiveState } from "../../src/core/host/live-feed.ts";
import type { LiveUpdate } from "../../src/core/host/live-state.ts";
import { intentRegistry, intentStateOf, LOCAL_INTENT_PROFILE } from "../../src/core/protocol/intents/index.ts";
import { liveIntentAvailability } from "../../src/core/protocol/intents/state.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

describe("live feed", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanupAsync();
	});

	async function feedHarness(...options: Parameters<typeof createHarness>) {
		const harness = await createHarness(...options);
		harnesses.push(harness);
		const updates: LiveUpdate[] = [];
		const feed = feedLiveState(harness.session);
		harness.session.liveState.attach("observer", {
			acceptsHostRequest: () => true,
			apply: (update) => updates.push(update),
		});
		return { harness, feed, updates, items: (): LiveItem[] => updates.flatMap((update) => update.items) };
	}

	it("sets the phase, usage, Git, prompt-cache, intents, and jobs values from the start", async () => {
		const { harness } = await feedHarness();
		const keys = harness.session.liveState.entries().map(([key]) => key);
		expect(keys).toEqual(expect.arrayContaining(["phase", "intents", "usage", "jobs", "git", "prompt_cache"]));
		expect(harness.session.liveState.get("phase")).toEqual({ kind: "phase", busy: false, operation: null });
	});

	it("streams a turn's assistant message and tool, then drops them as their entries commit", async () => {
		const { harness, items } = await feedHarness({ initialActiveToolNames: ["ls"] });
		harness.setResponses([
			fauxAssistantMessage([fauxText("Listing"), fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("list");
		await harness.session.waitForIdle();

		const types = items().map((item) => (item.type === "set" ? `set:${item.key}` : item.type));
		expect(types).toContain("assistant_start");
		expect(types).toContain("assistant_delta");
		expect(items()).toContainEqual(expect.objectContaining({ type: "tool", op: "start", toolName: "ls" }));
		expect(items()).toContainEqual(expect.objectContaining({ type: "tool", op: "end", toolName: "ls" }));
		const phases = items().flatMap((item) =>
			item.type === "set" && item.value.kind === "phase" ? [item.value.busy] : [],
		);
		expect(phases).toContain(true);
		expect(phases.at(-1)).toBe(false);
		// Every streamed message and tool committed: nothing streams any more.
		const snapshot = harness.session.liveState.snapshot();
		expect(snapshot.assistant).toBeUndefined();
		expect(snapshot.tools.size).toBe(0);
		const usage = harness.session.liveState.get("usage");
		expect(usage?.kind === "usage" && usage.tokens).toEqual(harness.session.getSessionStats().tokens);
	});

	it("carries the stateful intents' availability and state as the registry computes them", async () => {
		const { harness } = await feedHarness();
		const view = { state: intentStateOf(harness.session), services: {}, profile: LOCAL_INTENT_PROFILE };
		const expected = intentRegistry
			.names()
			.map((name) => intentRegistry.get(name))
			.filter((definition) => definition.state !== undefined)
			.map((definition) => {
				const availability = intentRegistry.availability(definition, view);
				return {
					name: definition.name,
					enabled: availability.enabled,
					...(availability.enabled ? {} : { reason: availability.reason }),
					state: definition.state?.(view),
				};
			});
		expect(liveIntentAvailability(harness.session)).toEqual(expect.arrayContaining(expected));
		expect(liveIntentAvailability(harness.session)).toHaveLength(expected.length);
		expect(harness.session.liveState.get("intents")).toEqual({
			kind: "intents",
			availability: liveIntentAvailability(harness.session),
		});
	});

	it("shows a review workflow until it ends", async () => {
		const { harness, feed, items } = await feedHarness();
		const base = {
			workflowId: "w1",
			kind: "review" as const,
			action: "review.uncommitted",
			title: "Review",
			startedAt: 1,
		};
		feed.workflowEvent({ type: "workflow_start", ...base, message: "starting", status: "running" });
		feed.workflowEvent({
			type: "tool_execution_start",
			workflowId: "w1",
			workflowKind: "review",
			workflowAction: "review.uncommitted",
			toolCallId: "t1",
			toolName: "read",
		});
		expect(harness.session.liveState.get("workflow/w1")).toMatchObject({
			kind: "workflow",
			event: { type: "workflow_start" },
			activeTools: [{ toolCallId: "t1" }],
		});
		feed.workflowEvent({ type: "workflow_end", ...base, message: "done", status: "completed", endedAt: 2 });
		expect(harness.session.liveState.get("workflow/w1")).toBeUndefined();
		expect(
			items()
				.filter((item) => item.type === "set" && item.key === "workflow/w1")
				.at(-1),
		).toMatchObject({
			value: { event: { type: "workflow_end", status: "completed" } },
		});
		feed.close();
	});

	it("streams an MCP server call's progress as a tool item that ends with the call", async () => {
		const { harness, feed, items } = await feedHarness();
		const emit = (event: AgentSessionEvent): void =>
			(harness.session as unknown as { _events: { emit(event: AgentSessionEvent): void } })._events.emit(event);
		const call = {
			id: "c1",
			timestamp: new Date(0).toISOString(),
			server: "docs",
			tool: "search",
			risk: "read" as const,
		};
		emit({ type: "mcp_call_start", call: { ...call, status: "started" } });
		emit({
			type: "mcp_call_update",
			call: { id: "c1", server: "docs", tool: "search" },
			progress: { progress: 1, total: 3, message: "page 1" },
		});
		expect(harness.session.liveState.snapshot().tools.get("mcp_call:c1")).toMatchObject({
			toolName: "mcp",
			args: { server: "docs", tool: "search" },
			partial: { content: [{ type: "text", text: "page 1" }], details: { progress: 1, total: 3 } },
		});
		emit({ type: "mcp_call_end", call: { ...call, status: "failed", durationMs: 5 } });
		expect(
			items()
				.filter((item) => item.type === "tool")
				.map((item) => item.type === "tool" && item.op),
		).toEqual(["start", "update", "end"]);
		expect(items().at(-1)).toMatchObject({ type: "tool", op: "end", isError: true });
		// Nothing commits a nested call: it leaves the streaming state when it ends.
		expect(harness.session.liveState.snapshot().tools.has("mcp_call:c1")).toBe(false);
		feed.close();
	});
});
