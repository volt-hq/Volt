import { describe, expect, it, vi } from "vitest";
import {
	ConversationProjectionFeed,
	type ConversationProjectionSnapshotBuilder,
	type ConversationProjectionSource,
} from "../src/core/rpc/conversation-projection-feed.ts";

class TestSource implements ConversationProjectionSource {
	private readonly listeners = new Set<(event: object) => void>();

	subscribe(listener: (event: object) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: object): void {
		for (const listener of this.listeners) listener(event);
	}
}

const buildSnapshot: ConversationProjectionSnapshotBuilder = ({ activeAssistant, branchEpoch }) => ({
	conversation: { workspaceName: "workspace", sessionId: "session-1" },
	state: {
		thinkingLevel: "high",
		availableThinkingLevels: ["off", "high"],
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "session-1",
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
		steeringQueue: [],
		followUpQueue: [],
	},
	transcript: {
		sessionId: "session-1",
		items: [],
		hasMore: false,
		nextBeforeEntryId: null,
		projectionVersion: 3,
		branchEpoch,
		head: null,
	},
	activeAssistant,
	activeWorkflows: [],
});

describe("ordered Fast mode action-state events", () => {
	it("fans one cursor-bearing settled event to every attached client", async () => {
		const source = new TestSource();
		let nextId = 0;
		const feed = new ConversationProjectionFeed(source, { createId: () => `event-${++nextId}` });
		const firstWrites: object[] = [];
		const secondWrites: object[] = [];
		const first = feed.attach({
			write: (value) => {
				firstWrites.push(value);
			},
			buildSnapshot,
		});
		const second = feed.attach({
			write: (value) => {
				secondWrites.push(value);
			},
			buildSnapshot,
		});
		await Promise.all([first.ready, second.ready]);

		source.emit({
			type: "ui_action_state_changed",
			action: "thinking.fast_mode",
			state: { type: "boolean", value: true, label: "Fast: thinking off" },
		});
		await Promise.all([first.flush(), second.flush()]);

		expect(firstWrites.slice(1)).toEqual([
			{
				type: "ui_action_state_changed",
				action: "thinking.fast_mode",
				state: { type: "boolean", value: true, label: "Fast: thinking off" },
				delivery: { subscriptionId: first.subscriptionId, cursor: 1 },
			},
		]);
		expect(secondWrites.slice(1)).toEqual([
			expect.objectContaining({
				type: "ui_action_state_changed",
				delivery: { subscriptionId: second.subscriptionId, cursor: 1 },
			}),
		]);
		feed.dispose();
	});

	it("accepts bounded generic picker state on the ordered feed", async () => {
		const source = new TestSource();
		const writes: object[] = [];
		const feed = new ConversationProjectionFeed(source);
		const subscription = feed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot,
		});
		await subscription.ready;

		source.emit({
			type: "ui_action_state_changed",
			action: "model.reasoning_effort",
			state: {
				type: "enum",
				value: "high",
				options: [
					{ value: "low", label: "Low" },
					{ value: "high", label: "High" },
				],
			},
		});
		await subscription.flush();

		expect(writes.at(-1)).toMatchObject({
			type: "ui_action_state_changed",
			action: "model.reasoning_effort",
			state: { type: "enum", value: "high" },
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 1 },
		});
		feed.dispose();
	});

	it("fails closed on an oversized action-state source event", async () => {
		const source = new TestSource();
		const failed = vi.fn();
		const feed = new ConversationProjectionFeed(source);
		const subscription = feed.attach({ write: () => {}, buildSnapshot, onError: failed });
		await subscription.ready;

		source.emit({
			type: "ui_action_state_changed",
			action: "thinking.fast_mode",
			state: { type: "boolean", value: true, label: "x".repeat(100_000) },
		});

		expect(failed).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("action-state") }),
		);
		expect(() => feed.attach({ write: () => {}, buildSnapshot })).toThrow(/generation is poisoned/);
		feed.dispose();
	});
});
