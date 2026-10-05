/**
 * The children a client of a conversation may observe: open conversations
 * the conversation links by `subagent` work in its log, directly or through
 * its linked children's logs, within a bounded depth. Nothing else links.
 */

import { tmpdir } from "node:os";
import type { WorkRecord } from "@hansjm10/volt-agent-core";
import { describe, expect, it } from "vitest";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import { remoteProfile } from "../src/core/protocol/profiles.ts";
import { createIrohRemoteRpcGrant } from "../src/core/remote/iroh/access-grant.ts";
import { linkedSubagentConversation } from "../src/core/subagents/work.ts";

interface FakeConversation {
	readonly id: string;
	closed: boolean;
	readonly records: WorkRecord[];
	readonly children: Map<string, FakeConversation>;
}

function conversation(id: string): FakeConversation {
	return { id, closed: false, records: [], children: new Map() };
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
		},
	} as unknown as HostedConversation;
}

/** `parent` started `child` as work of `kind`; the child is open in `parent`'s manager. */
function link(parent: FakeConversation, child: FakeConversation, kind: WorkRecord["kind"] = "subagent"): void {
	parent.records.push({ workId: `w-${child.id}`, kind, child: { conversation: child.id } } as WorkRecord);
	parent.children.set(child.id, child);
}

describe("subagent work links", () => {
	it("finds open children linked by subagent work, directly or through linked children", () => {
		const root = conversation("root");
		const child = conversation("child");
		const grandchild = conversation("grandchild");
		link(root, child);
		link(child, grandchild);
		expect(linkedSubagentConversation(asHosted(root), "child")?.id).toBe("child");
		expect(linkedSubagentConversation(asHosted(root), "grandchild")?.id).toBe("grandchild");
		// Links point down: a child does not reach its parent.
		expect(linkedSubagentConversation(asHosted(child), "root")).toBeUndefined();
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
		expect(linkedSubagentConversation(asHosted(root), "unlinked")).toBeUndefined();
		expect(linkedSubagentConversation(asHosted(root), "job-child")).toBeUndefined();
		expect(linkedSubagentConversation(asHosted(root), "closed")).toBeUndefined();

		let tip = root;
		for (let depth = 1; depth <= 9; depth += 1) {
			const next = conversation(`depth-${depth}`);
			link(tip, next);
			tip = next;
		}
		expect(linkedSubagentConversation(asHosted(root), "depth-8")?.id).toBe("depth-8");
		expect(linkedSubagentConversation(asHosted(root), "depth-9")).toBeUndefined();
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
