import { describe, expect, test } from "vitest";
import {
	isCoalescableAssistantUpdate,
	StreamingRenderCoalescer,
	type StreamingRenderScheduler,
} from "../src/modes/interactive/components/streaming-render-coalescer.ts";

class VirtualScheduler implements StreamingRenderScheduler {
	private now = 0;
	private nextId = 1;
	private readonly tasks = new Map<number, { at: number; callback: () => void }>();

	setTimeout(callback: () => void, delayMs: number): unknown {
		const id = this.nextId++;
		this.tasks.set(id, { at: this.now + delayMs, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.tasks.delete(handle as number);
	}

	advanceBy(delayMs: number): void {
		const target = this.now + delayMs;
		while (true) {
			const due = [...this.tasks.entries()]
				.filter(([, task]) => task.at <= target)
				.sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
			if (!due) break;
			const [id, task] = due;
			this.tasks.delete(id);
			this.now = task.at;
			task.callback();
		}
		this.now = target;
	}
}

describe("StreamingRenderCoalescer", () => {
	test("commits the leading update and only the latest trailing update in each interval", () => {
		const scheduler = new VirtualScheduler();
		const commits: string[] = [];
		const coalescer = new StreamingRenderCoalescer((value: string) => commits.push(value), 80, scheduler);

		coalescer.update("first");
		coalescer.update("stale");
		coalescer.update("latest");
		expect(commits).toEqual(["first"]);

		scheduler.advanceBy(80);
		expect(commits).toEqual(["first", "latest"]);

		coalescer.update("next window");
		scheduler.advanceBy(80);
		expect(commits).toEqual(["first", "latest", "next window"]);
	});

	test("semantic boundaries bypass the cooldown and discard stale pending snapshots", () => {
		const scheduler = new VirtualScheduler();
		const commits: string[] = [];
		const coalescer = new StreamingRenderCoalescer((value: string) => commits.push(value), 80, scheduler);

		coalescer.update("leading text");
		coalescer.update("pending text");
		coalescer.commitNow("tool boundary");
		scheduler.advanceBy(160);

		expect(commits).toEqual(["leading text", "tool boundary"]);
	});

	test("finish commits the authoritative final value and prevents late rendering", () => {
		const scheduler = new VirtualScheduler();
		const commits: string[] = [];
		const coalescer = new StreamingRenderCoalescer((value: string) => commits.push(value), 80, scheduler);

		coalescer.update("partial");
		coalescer.update("pending");
		coalescer.finish("final");
		coalescer.update("too late");
		scheduler.advanceBy(160);

		expect(commits).toEqual(["partial", "final"]);
	});

	test("recognizes only Markdown-producing delta events as coalescable", () => {
		expect(isCoalescableAssistantUpdate("text_delta")).toBe(true);
		expect(isCoalescableAssistantUpdate("thinking_delta")).toBe(true);
		expect(isCoalescableAssistantUpdate("text_end")).toBe(false);
		expect(isCoalescableAssistantUpdate("toolcall_delta")).toBe(false);
		expect(isCoalescableAssistantUpdate(undefined)).toBe(false);
	});
});
