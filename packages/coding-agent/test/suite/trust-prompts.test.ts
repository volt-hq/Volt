/**
 * Project trust prompts of a conversation a client opens from another one go
 * to that client only, as host requests in the conversation it leaves: no
 * other client sees or answers them, and a client that answers no dialogs
 * leaves the factory without UI.
 */

import { join } from "node:path";
import type { HostRequest } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient, type LoopbackClient } from "../../src/client/protocol-client.ts";
import type { ProjectTrustContext } from "../../src/core/extensions/index.ts";
import { ConversationHost } from "../../src/core/host/conversation-host.ts";
import type { ConversationFactory } from "../../src/core/host/hosted-conversation.ts";
import type { HostClient } from "../../src/core/host/targets.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHostHarness } from "./host-harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Asked {
	readonly hasUI: boolean;
	readonly mode: string;
	readonly answer: string | undefined;
}

async function setup() {
	const harness = await createHostHarness();
	cleanups.push(() => harness.cleanup());
	const asked: Asked[] = [];
	// A factory that asks the trust question of every conversation a client opens.
	const factory: ConversationFactory = async (options) => {
		const trust: ProjectTrustContext | undefined = options.projectTrustContext;
		if (trust) {
			const answer = trust.hasUI
				? await trust.ui.select("Trust project folder?", ["Trust", "Do not trust"])
				: undefined;
			asked.push({ hasUI: trust.hasUI, mode: trust.mode, answer });
		}
		return harness.factory(options);
	};
	const host = new ConversationHost({ factory, agentDir: harness.tempDir, extensionMode: "rpc" });
	cleanups.push(() => host.dispose().catch(() => undefined));
	const opened = await host.open({
		kind: "adopt",
		sessionManager: await SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions")),
	});
	if (opened.cancelled) throw new Error("A startup open cannot be cancelled");
	return { host, conversation: opened.conversation, asked };
}

function selects(client: LoopbackClient): Array<{ requestId: string; request: HostRequest }> {
	return [...client.live.values.values()].flatMap((value) =>
		value.kind === "host_request" && value.request.kind === "select"
			? [{ requestId: value.requestId, request: value.request }]
			: [],
	);
}

describe("trust prompts of a conversation a client opens", () => {
	it("asks only the client that opens it, which alone may answer", async () => {
		const { host, conversation, asked } = await setup();
		const opener = await createLoopbackClient(host, conversation, { hostRequests: ["select"] });
		const other = await createLoopbackClient(host, conversation, { anchor: false, hostRequests: ["select"] });
		cleanups.push(async () => {
			await other.stop();
			await opener.stop();
		});

		const moved = opener.intent("new_session");
		let prompt: { requestId: string; request: HostRequest } | undefined;
		await vi.waitFor(() => {
			prompt = selects(opener)[0];
			expect(prompt).toBeDefined();
		});
		expect(prompt?.request).toMatchObject({ kind: "select", title: "Trust project folder?" });
		expect(selects(other)).toEqual([]);
		other.answer(prompt!.requestId, { value: "Do not trust" });
		await other.caughtUp();
		expect(asked).toEqual([]);

		opener.answer(prompt!.requestId, { value: "Trust" });
		expect((await moved).conversation).toBeDefined();
		expect(asked).toEqual([{ hasUI: true, mode: "rpc", answer: "Trust" }]);
	});

	it("never asks a remote client, which leaves the project untrusted", async () => {
		const { host, conversation, asked } = await setup();
		const shown: unknown[] = [];
		const phone: HostClient = {
			id: "phone",
			remote: true,
			live: {
				acceptsHostRequest: () => true,
				apply: (update) => shown.push(...update.items.filter((item) => item.type === "set")),
			},
			move: { kind: "in_place", onMoved: () => {} },
		};
		await host.attach(phone, conversation);
		const opened = await host.openFor(phone, { kind: "new", cwd: conversation.cwd });
		expect(opened.cancelled).toBe(false);
		// No trust context: the factory decides without asking anyone.
		expect(asked).toEqual([]);
		expect(shown.filter((item) => JSON.stringify(item).includes("host_request"))).toEqual([]);
	});

	it("leaves the factory without UI for a client that answers no dialogs", async () => {
		const { host, conversation, asked } = await setup();
		const opener = await createLoopbackClient(host, conversation);
		cleanups.push(() => opener.stop());
		expect((await opener.intent("new_session")).conversation).toBeDefined();
		expect(asked).toEqual([{ hasUI: false, mode: "rpc", answer: undefined }]);
	});
});
