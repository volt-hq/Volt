import { describe, expect, it, vi } from "vitest";
import type { ControlEvent } from "../src/daemon/control-protocol.ts";
import { ViewerFeedRegistry } from "../src/daemon/viewer-feed.ts";

function createFeedSession() {
	return { abort: vi.fn(async (_source?: "remote_request") => {}) };
}

function createRegistry(delivered = true) {
	const sent: Array<{ connectionId: string; event: ControlEvent }> = [];
	const registry = new ViewerFeedRegistry({
		sendTo: (connectionId, event) => {
			sent.push({ connectionId, event });
			return delivered;
		},
	});
	return { registry, sent };
}

describe("ViewerFeedRegistry (§4.3)", () => {
	it("tracks a drain from start until it ends", () => {
		const { registry, sent } = createRegistry();
		expect(registry.has("vf-1")).toBe(false);
		registry.start("vf-1", "c-1", createFeedSession());
		expect(registry.has("vf-1")).toBe(true);
		expect(sent).toEqual([]);
	});

	it("rejects abort from a connection that is not the drain requester, and for unknown drains", async () => {
		const { registry } = createRegistry();
		const session = createFeedSession();
		registry.start("vf-1", "c-1", session);

		expect(await registry.abort("vf-1", "c-other")).toBe(false);
		expect(await registry.abort("vf-nope", "c-1")).toBe(false);
		expect(session.abort).not.toHaveBeenCalled();
	});

	it("abort stops the draining turn via the session as a remote request", async () => {
		const { registry } = createRegistry();
		const session = createFeedSession();
		registry.start("vf-1", "c-1", session);
		expect(await registry.abort("vf-1", "c-1")).toBe(true);
		expect(session.abort).toHaveBeenCalledTimes(1);
		expect(session.abort).toHaveBeenCalledWith("remote_request");
		// The drain stays tracked until it ends.
		expect(registry.has("vf-1")).toBe(true);
	});

	it("keeps the first requester when a drain id starts twice", async () => {
		const { registry } = createRegistry();
		const first = createFeedSession();
		const second = createFeedSession();
		registry.start("vf-1", "c-1", first);
		registry.start("vf-1", "c-2", second);

		expect(await registry.abort("vf-1", "c-2")).toBe(false);
		expect(await registry.abort("vf-1", "c-1")).toBe(true);
		expect(first.abort).toHaveBeenCalledTimes(1);
		expect(second.abort).not.toHaveBeenCalled();
	});

	it("end emits viewer_end to the requester once and tears the drain down", async () => {
		const { registry, sent } = createRegistry();
		const session = createFeedSession();
		registry.start("vf-1", "c-1", session);

		registry.end("vf-1", "granted");
		expect(registry.has("vf-1")).toBe(false);
		expect(sent).toEqual([
			{ connectionId: "c-1", event: { type: "viewer_end", viewerFeedId: "vf-1", reason: "granted" } },
		]);

		// A second end, an end of an unknown drain, and an abort after the end do nothing.
		registry.end("vf-1", "cancelled");
		registry.end("vf-nope", "error");
		expect(sent).toHaveLength(1);
		expect(await registry.abort("vf-1", "c-1")).toBe(false);
		expect(session.abort).not.toHaveBeenCalled();
	});

	it("carries each end reason and tears down even when the requester is gone", () => {
		const { registry, sent } = createRegistry(false);
		for (const [index, reason] of (["granted", "cancelled", "error"] as const).entries()) {
			const viewerFeedId = `vf-${index}`;
			registry.start(viewerFeedId, "c-1", createFeedSession());
			registry.end(viewerFeedId, reason);
			expect(registry.has(viewerFeedId)).toBe(false);
		}
		expect(sent.map((entry) => entry.event)).toEqual([
			{ type: "viewer_end", viewerFeedId: "vf-0", reason: "granted" },
			{ type: "viewer_end", viewerFeedId: "vf-1", reason: "cancelled" },
			{ type: "viewer_end", viewerFeedId: "vf-2", reason: "error" },
		]);
	});
});
