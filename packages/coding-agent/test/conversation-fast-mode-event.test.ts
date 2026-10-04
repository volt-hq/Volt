/**
 * Fast mode and picker state as a paired device sees them on the remote
 * profile: the branch-local `fast_mode_change` entry, the live `intents`
 * value that carries each stateful intent's state, and the state a snapshot
 * restores with the branch.
 */

import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import {
	type HostFrame,
	type IntentAvailability,
	REMOTE_CAPABILITIES,
	type RemoteGrant,
} from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationHost } from "../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import type { ProtocolConnection } from "../src/core/protocol/server/connection.ts";
import { serveIrohRemoteConnection } from "../src/core/remote/iroh/connection.ts";
import { createHostHarness } from "./suite/host-harness.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "./utilities/remote-phone.ts";

type Frame<T extends HostFrame["type"]> = Extract<HostFrame, { type: T }>;

const ALL: RemoteGrant = { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] };

describe("Fast mode and picker state on the remote profile", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(): Promise<{ host: ConversationHost; conversation: HostedConversation }> {
		const harness = await createHostHarness({ whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		return { host: harness.host, conversation: await harness.openStartup() };
	}

	async function connectPhone(host: ConversationHost, conversation: HostedConversation): Promise<RemotePhone> {
		const pair = createIrohStreamPair();
		const connection: ProtocolConnection = serveIrohRemoteConnection({
			host,
			conversation,
			stream: pair.host,
			grant: ALL,
			redaction: { workspacePath: conversation.cwd },
			redirect: {},
		});
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await phone.close();
		});
		await phone.hello();
		return phone;
	}

	/** The newest live state of intent `name` the device received from frame `from` on. */
	function intentState(phone: RemotePhone, name: string, from = 0): IntentAvailability["state"] {
		let state: IntentAvailability["state"];
		for (const frame of phone.frames.slice(from)) {
			if (frame.type !== "live") continue;
			for (const item of frame.items) {
				if (item.type !== "set" || item.value.kind !== "intents") continue;
				state = item.value.availability.find((intent) => intent.name === name)?.state;
			}
		}
		return state;
	}

	function snapshotOf(phone: RemotePhone, subscriptionId: string): Frame<"snapshot"> | undefined {
		return phone.frames.find(
			(frame): frame is Frame<"snapshot"> => frame.type === "snapshot" && frame.subscriptionId === subscriptionId,
		);
	}

	it("fans one Fast mode change to every subscribed device as its entry and the live intent state", async () => {
		const { host, conversation } = await setup();
		const first = await connectPhone(host, conversation);
		const second = await connectPhone(host, conversation);
		await first.subscribe(conversation.id);
		await second.subscribe(conversation.id);
		expect(intentState(first, "set_fast_mode")).toEqual({
			type: "boolean",
			value: false,
			label: "Fast mode disabled",
		});
		const marks = [first.frames.length, second.frames.length];

		await conversation.session.setFastModeEnabled(true);

		const ordinals: number[] = [];
		for (const [index, phone] of [first, second].entries()) {
			const from = marks[index];
			const change = await phone.waitFor(
				(frame): frame is Frame<"entry"> => frame.type === "entry" && frame.entry.type === "fast_mode_change",
				{ from },
			);
			expect(change.entry.payload).toEqual({ enabled: true });
			ordinals.push(change.entry.ordinal);
			await phone.waitFor(
				(frame): frame is Frame<"live"> =>
					frame.type === "live" && intentState(phone, "set_fast_mode", from)?.value === true,
				{ from },
			);
			expect(intentState(phone, "set_fast_mode", from)).toEqual({
				type: "boolean",
				value: true,
				label: "Fast mode enabled",
			});
		}
		// One committed change, the same position for every device.
		expect(ordinals[0]).toBe(ordinals[1]);
	});

	it("carries a picker intent's enum state with its options, and its change", async () => {
		const { host, conversation } = await setup();
		const phone = await connectPhone(host, conversation);
		await phone.subscribe(conversation.id);
		expect(intentState(phone, "set_agent_mode")).toEqual({
			type: "enum",
			value: "build",
			label: "Build",
			options: [
				{ value: "build", label: "Build" },
				{ value: "plan", label: "Plan" },
			],
		});
		const from = phone.frames.length;

		await conversation.session.setAgentMode("plan");

		await phone.waitFor(
			(frame): frame is Frame<"live"> =>
				frame.type === "live" && intentState(phone, "set_agent_mode", from)?.value === "plan",
			{ from },
		);
		expect(intentState(phone, "set_agent_mode", from)).toMatchObject({ type: "enum", value: "plan", label: "Plan" });
	});

	it("restores the branch's Fast mode state when the branch switches", async () => {
		const { host, conversation } = await setup();
		const session = conversation.session;
		await session.sessionWriter.appendMessage({ role: "user", content: "before fast", timestamp: 1 });
		const beforeFast = await session.sessionWriter.appendMessage(fauxAssistantMessage("answer before fast"));
		await session.setFastModeEnabled(true);
		const phone = await connectPhone(host, conversation);
		await phone.subscribe(conversation.id, "before");
		expect(snapshotOf(phone, "before")?.state.fastMode).toBe(true);
		const from = phone.frames.length;

		await session.navigateTree(beforeFast, { summarize: false });
		expect(session.fastModeEnabled).toBe(false);

		// The subscribed device folds the branch switch and the restored state.
		const leaf = await phone.waitFor(
			(frame): frame is Frame<"entry"> => frame.type === "entry" && frame.entry.type === "leaf",
			{ from },
		);
		expect(leaf.entry.payload).toEqual({ targetId: beforeFast });
		await phone.waitFor(
			(frame): frame is Frame<"live"> =>
				frame.type === "live" && intentState(phone, "set_fast_mode", from)?.value === false,
			{ from },
		);
		// A device that subscribes now starts from the restored state.
		await phone.subscribe(conversation.id, "after");
		expect(snapshotOf(phone, "after")?.state).toMatchObject({ leafId: beforeFast, fastMode: false });
	});
});
