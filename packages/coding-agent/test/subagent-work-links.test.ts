/**
 * The children a client of a conversation may observe: open conversations
 * the conversation links by its work (a subagent's child, a review's current
 * pass), directly or through its linked children's logs, within a bounded
 * depth. Nothing else links.
 */

import { tmpdir } from "node:os";
import type { WorkRecord } from "@hansjm10/volt-agent-core";
import { describe, expect, it } from "vitest";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import { remoteProfile } from "../src/core/protocol/profiles.ts";
import { createIrohRemoteRpcGrant } from "../src/core/remote/iroh/access-grant.ts";
import { linkedChildConversation } from "../src/core/work/children.ts";

interface FakeConversation {
	readonly id: string;
	closed: boolean;
	readonly records: WorkRecord[];
	readonly children: Map<string, FakeConversation>;
	readonly passes: Map<string, FakeConversation>;
}

function conversation(id: string): FakeConversation {
	return { id, closed: false, records: [], children: new Map(), passes: new Map() };
}

function asHosted(fake: FakeConversation): HostedConversation {
	return {
		id: fake.id,
		get closed() {
			return fake.closed;
		},
		work: { list: () => fake.records },
		session: {
			getSubagentToolManager: () => ({
				childConversation: (id: string) => {
					const child = fake.children.get(id);
					return child ? asHosted(child) : undefined;
				},
			}),
			reviewPasses: {
				get: (id: string) => {
					const pass = fake.passes.get(id);
					return pass ? asHosted(pass) : undefined;
				},
			},
		},
	} as unknown as HostedConversation;
}

/** `parent` started `child` as work of `kind`; the child is open in `parent`'s manager. */
function link(parent: FakeConversation, child: FakeConversation, kind: WorkRecord["kind"] = "subagent"): void {
	parent.records.push({ workId: `w-${child.id}`, kind, child: { conversation: child.id } } as WorkRecord);
	parent.children.set(child.id, child);
}

/** `parent`'s review `workId` runs in `pass` now; the pass is open among `parent`'s review passes. */
function reviewIn(parent: FakeConversation, workId: string, pass: FakeConversation): void {
	const index = parent.records.findIndex((record) => record.workId === workId);
	const record = { workId, kind: "review", child: { conversation: pass.id } } as WorkRecord;
	if (index === -1) parent.records.push(record);
	else parent.records[index] = record;
	parent.passes.set(pass.id, pass);
}

describe("subagent work links", () => {
	it("finds open children linked by subagent work, directly or through linked children", () => {
		const root = conversation("root");
		const child = conversation("child");
		const grandchild = conversation("grandchild");
		link(root, child);
		link(child, grandchild);
		expect(linkedChildConversation(asHosted(root), "child")?.id).toBe("child");
		expect(linkedChildConversation(asHosted(root), "grandchild")?.id).toBe("grandchild");
		// Links point down: a child does not reach its parent.
		expect(linkedChildConversation(asHosted(child), "root")).toBeUndefined();
	});

	it("links nothing a manager has open but no subagent work names, nothing closed, and nothing too deep", () => {
		const root = conversation("root");
		const unlinked = conversation("unlinked");
		const job = conversation("job-child");
		const closed = conversation("closed");
		root.children.set(unlinked.id, unlinked);
		link(root, job, "job");
		link(root, closed);
		closed.closed = true;
		expect(linkedChildConversation(asHosted(root), "unlinked")).toBeUndefined();
		expect(linkedChildConversation(asHosted(root), "job-child")).toBeUndefined();
		expect(linkedChildConversation(asHosted(root), "closed")).toBeUndefined();

		let tip = root;
		for (let depth = 1; depth <= 9; depth += 1) {
			const next = conversation(`depth-${depth}`);
			link(tip, next);
			tip = next;
		}
		expect(linkedChildConversation(asHosted(root), "depth-8")?.id).toBe("depth-8");
		expect(linkedChildConversation(asHosted(root), "depth-9")).toBeUndefined();
	});

	it("finds the pass a review runs in now, and no earlier pass or pass no review names", () => {
		const root = conversation("root");
		const child = conversation("child");
		link(root, child);
		const first = conversation("pass-1");
		const second = conversation("pass-2");
		reviewIn(root, "review-1", first);
		expect(linkedChildConversation(asHosted(root), "pass-1")?.id).toBe("pass-1");
		// The review moved on: its earlier pass, though still open, is not linked.
		reviewIn(root, "review-1", second);
		expect(linkedChildConversation(asHosted(root), "pass-1")).toBeUndefined();
		expect(linkedChildConversation(asHosted(root), "pass-2")?.id).toBe("pass-2");
		// A child's reviews link their passes too; a pass open but named by no review does not link.
		const nested = conversation("nested-pass");
		reviewIn(child, "review-2", nested);
		expect(linkedChildConversation(asHosted(root), "nested-pass")?.id).toBe("nested-pass");
		root.passes.set("stray", conversation("stray"));
		expect(linkedChildConversation(asHosted(root), "stray")).toBeUndefined();
		second.closed = true;
		expect(linkedChildConversation(asHosted(root), "pass-2")).toBeUndefined();
	});

	it("lets a remote profile read only the children its bound conversation links", () => {
		const profile = remoteProfile({
			grant: createIrohRemoteRpcGrant(["conversation.observe.v1"]),
			redaction: { workspacePath: tmpdir(), remoteWorkspacePath: "/workspace" },
			bound: "root",
		});
		expect(profile.conversations("root")).toBe(true);
		expect(profile.conversations("grandchild", "root")).toBe(true);
		expect(profile.conversations("grandchild", "other")).toBe(false);
		expect(profile.conversations("grandchild")).toBe(false);
		const workspace = remoteProfile({
			grant: createIrohRemoteRpcGrant(["conversation.observe.v1"]),
			redaction: { workspacePath: tmpdir(), remoteWorkspacePath: "/workspace" },
		});
		expect(workspace.conversations("grandchild", undefined)).toBe(false);
	});
});
