import type { AssistantMessage, Model, PromptCacheMetadata, Usage } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import {
	applyPromptCacheRefresh,
	promptCacheStatusEquals,
	resolvePromptCacheStatus,
} from "../src/core/prompt-cache-status.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const ANTHROPIC_CACHE: PromptCacheMetadata = {
	modes: ["explicit"],
	retention: { short: { ttlSeconds: 300 }, long: { ttlSeconds: 3600 } },
	refreshesOnHit: true,
};

function createModel(id: string, promptCache: PromptCacheMetadata | null = ANTHROPIC_CACHE): Model<string> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...(promptCache ? { promptCache } : {}),
	};
}

function usage(prompt: number): Usage {
	return {
		input: prompt,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: prompt + 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

let nextId = 0;

function assistantEntry(options: { model: string; timestamp: number; promptTokens?: number }): SessionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: options.model,
		usage: usage(options.promptTokens ?? 1000),
		stopReason: "stop",
		timestamp: options.timestamp,
	};
	return { type: "message", id: `entry-${nextId++}`, parentId: null, timestamp: "", message };
}

function compactionEntry(): SessionEntry {
	return {
		type: "compaction",
		id: `entry-${nextId++}`,
		parentId: null,
		timestamp: "",
		summary: "summary",
		firstKeptEntryId: "entry-0",
		tokensBefore: 100_000,
	};
}

describe("resolvePromptCacheStatus", () => {
	it("anchors the documented window to the latest request with the current model", () => {
		const status = resolvePromptCacheStatus({
			model: createModel("claude"),
			branch: [
				assistantEntry({ model: "claude", timestamp: 1_000 }),
				assistantEntry({ model: "claude", timestamp: 5_000 }),
			],
			cacheRetention: "short",
		});

		expect(status).toEqual({ kind: "retained", lastRequestAt: 5_000, expiresAt: 305_000 });
	});

	it("uses the long retention window when requested and supported", () => {
		const status = resolvePromptCacheStatus({
			model: createModel("claude"),
			branch: [assistantEntry({ model: "claude", timestamp: 5_000 })],
			cacheRetention: "long",
		});

		expect(status).toEqual({ kind: "retained", lastRequestAt: 5_000, expiresAt: 3_605_000 });
	});

	it("omits expiry when the provider publishes no retention window", () => {
		const status = resolvePromptCacheStatus({
			model: createModel("gpt", { modes: ["implicit"], retention: { short: {} } }),
			branch: [assistantEntry({ model: "gpt", timestamp: 5_000 })],
			cacheRetention: "short",
		});

		expect(status).toEqual({ kind: "retained", lastRequestAt: 5_000 });
	});

	it("skips requests without evidence that the provider processed the prompt", () => {
		const status = resolvePromptCacheStatus({
			model: createModel("claude"),
			branch: [
				assistantEntry({ model: "claude", timestamp: 1_000 }),
				assistantEntry({ model: "claude", timestamp: 9_000, promptTokens: 0 }),
			],
			cacheRetention: "short",
		});

		expect(status).toEqual({ kind: "retained", lastRequestAt: 1_000, expiresAt: 301_000 });
	});

	it("reuses an earlier request with the current model after switching back", () => {
		const status = resolvePromptCacheStatus({
			model: createModel("claude"),
			branch: [
				assistantEntry({ model: "claude", timestamp: 1_000 }),
				assistantEntry({ model: "other", timestamp: 2_000 }),
			],
			cacheRetention: "short",
		});

		expect(status).toEqual({ kind: "retained", lastRequestAt: 1_000, expiresAt: 301_000 });
	});

	it("reports a model change when no prior request used the current model", () => {
		const status = resolvePromptCacheStatus({
			model: createModel("claude"),
			branch: [assistantEntry({ model: "other", timestamp: 1_000 })],
			cacheRetention: "short",
		});

		expect(status).toEqual({ kind: "model_changed" });
	});

	it("ignores requests before the latest compaction", () => {
		const branch = [assistantEntry({ model: "claude", timestamp: 1_000 }), compactionEntry()];
		expect(
			resolvePromptCacheStatus({ model: createModel("claude"), branch, cacheRetention: "short" }),
		).toBeUndefined();

		branch.push(assistantEntry({ model: "claude", timestamp: 7_000 }));
		expect(resolvePromptCacheStatus({ model: createModel("claude"), branch, cacheRetention: "short" })).toEqual({
			kind: "retained",
			lastRequestAt: 7_000,
			expiresAt: 307_000,
		});
	});

	it("does not apply without a caching model, retention, or prior request", () => {
		const branch = [assistantEntry({ model: "claude", timestamp: 1_000 })];
		expect(resolvePromptCacheStatus({ model: undefined, branch })).toBeUndefined();
		expect(resolvePromptCacheStatus({ model: createModel("claude", null), branch })).toBeUndefined();
		expect(
			resolvePromptCacheStatus({ model: createModel("claude"), branch, cacheRetention: "none" }),
		).toBeUndefined();
		expect(
			resolvePromptCacheStatus({ model: createModel("claude"), branch: [], cacheRetention: "short" }),
		).toBeUndefined();
	});
});

describe("promptCacheStatusEquals", () => {
	it("compares kind and timestamps", () => {
		const retained = { kind: "retained", lastRequestAt: 1, expiresAt: 2 } as const;
		expect(promptCacheStatusEquals(retained, { ...retained })).toBe(true);
		expect(promptCacheStatusEquals(retained, { ...retained, expiresAt: 3 })).toBe(false);
		expect(promptCacheStatusEquals({ kind: "model_changed" }, { kind: "model_changed" })).toBe(true);
		expect(promptCacheStatusEquals(retained, { kind: "model_changed" })).toBe(false);
		expect(promptCacheStatusEquals(undefined, undefined)).toBe(true);
		expect(promptCacheStatusEquals(undefined, retained)).toBe(false);
		expect(promptCacheStatusEquals(retained, { ...retained, keepAliveUntil: 5 })).toBe(false);
	});
});

describe("applyPromptCacheRefresh", () => {
	const retained = { kind: "retained", lastRequestAt: 1_000, expiresAt: 301_000 } as const;

	it("moves the window to a later renewal of the same request", () => {
		expect(applyPromptCacheRefresh(retained, { basisRequestAt: 1_000, at: 241_000, source: "refresh" })).toEqual({
			kind: "retained",
			lastRequestAt: 241_000,
			expiresAt: 541_000,
		});
	});

	it("ignores renewals of another request and earlier renewals", () => {
		expect(applyPromptCacheRefresh(retained, { basisRequestAt: 500, at: 241_000, source: "refresh" })).toBe(retained);
		expect(applyPromptCacheRefresh(retained, { basisRequestAt: 1_000, at: 1_000, source: "request" })).toBe(retained);
		expect(
			applyPromptCacheRefresh({ kind: "model_changed" }, { basisRequestAt: 1_000, at: 2_000, source: "refresh" }),
		).toEqual({
			kind: "model_changed",
		});
		expect(applyPromptCacheRefresh(retained, undefined)).toBe(retained);
	});

	it("keeps a status without a published window open-ended", () => {
		expect(
			applyPromptCacheRefresh(
				{ kind: "retained", lastRequestAt: 1_000 },
				{ basisRequestAt: 1_000, at: 5_000, source: "refresh" },
			),
		).toEqual({ kind: "retained", lastRequestAt: 5_000 });
	});
});
