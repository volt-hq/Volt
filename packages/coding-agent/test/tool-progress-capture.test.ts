import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import { ToolProgressDiagnostics } from "../src/core/tool-progress-diagnostics.ts";

function gate() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("asynchronous bounded capture", () => {
	it("keeps one immutable active snapshot and coalesces pending requests to the latest snapshot", async () => {
		const firstGate = gate();
		const secondGate = gate();
		const content: string[] = [];
		const writer = vi.fn(async (_path: string, snapshot: string) => {
			content.push(snapshot);
			await (content.length === 1 ? firstGate.promise : secondGate.promise);
		});
		const collector = new ToolProgressDiagnostics("unused", () => "session", writer);
		collector.observe({ type: "agent_start" });
		const first = collector.capture();
		await Promise.resolve();
		collector.observe({ type: "turn_start" });
		const pending = collector.capture();
		for (let index = 0; index < 1000; index++) {
			collector.observe({ type: "turn_start" });
			expect(collector.capture()).toBe(pending);
		}
		expect(writer).toHaveBeenCalledTimes(1);
		expect(JSON.parse(content[0]!).eventCount).toBe(1);
		firstGate.resolve();
		await first;
		await Promise.resolve();
		expect(writer).toHaveBeenCalledTimes(2);
		expect(JSON.parse(content[1]!).eventCount).toBe(1002);
		collector.observe({ type: "message_start", message: fauxAssistantMessage("later state") });
		secondGate.resolve();
		await pending;
		await collector.waitForCapture();
		expect(content[1]).not.toContain("later state");
	});

	it("drains the active and latest queued capture on disposal without reading disposed state", async () => {
		const hold = gate();
		const content: string[] = [];
		const writer = vi.fn(async (_path: string, snapshot: string) => {
			content.push(snapshot);
			await hold.promise;
		});
		const collector = new ToolProgressDiagnostics("unused", () => "session", writer);
		const active = collector.capture();
		collector.observe({ type: "agent_start" });
		const pending = collector.capture("safeguard");
		await Promise.resolve();
		collector.dispose();
		await expect(collector.capture()).rejects.toThrow("after session disposal");
		hold.resolve();
		await active;
		await collector.waitForCapture();
		await pending;
		expect(writer).toHaveBeenCalledTimes(2);
		expect(JSON.parse(content[1]!)).toMatchObject({ reason: "safeguard", eventCount: 1 });
	});

	it("runs a newer queued snapshot after a failed write without unhandled failures", async () => {
		const hold = gate();
		const writer = vi.fn(async () => {});
		writer.mockImplementationOnce(async () => {
			await hold.promise;
			throw new Error("disk full");
		});
		const collector = new ToolProgressDiagnostics("unused", () => "session", writer);
		const first = collector.capture();
		const next = collector.capture();
		hold.resolve();
		await expect(first).rejects.toThrow("disk full");
		await expect(next).resolves.toContain("tool-progress-latest.json");
		await collector.waitForCapture();
		expect(writer).toHaveBeenCalledTimes(2);
	});
});
