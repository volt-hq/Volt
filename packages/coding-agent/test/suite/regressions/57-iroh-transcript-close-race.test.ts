import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { type HostFrame, REMOTE_CAPABILITIES } from "@hansjm10/volt-protocol";
import { expect, test, vi } from "vitest";
import { serveIrohRemoteConnection } from "../../../src/core/remote/iroh/connection.ts";
import { ManualIrohRecvStream, ManualIrohSendStream, parseWrittenObjects } from "../../iroh-stream-doubles.ts";
import { createHostHarness } from "../host-harness.ts";

class BlockingFinishIrohSendStream extends ManualIrohSendStream {
	readonly finishStarted: Promise<void>;
	private readonly finishWait: Promise<void>;
	private markFinishStarted: () => void = () => {};
	private releaseFinishWait: () => void = () => {};

	constructor() {
		super();
		this.finishStarted = new Promise((resolve) => {
			this.markFinishStarted = resolve;
		});
		this.finishWait = new Promise((resolve) => {
			this.releaseFinishWait = resolve;
		});
	}

	override async finish(): Promise<void> {
		this.finished = true;
		this.markFinishStarted();
		await this.finishWait;
	}

	releaseFinish(): void {
		this.releaseFinishWait();
	}
}

function frames(send: ManualIrohSendStream): HostFrame[] {
	return parseWrittenObjects(send) as unknown as HostFrame[];
}

test("closed Iroh stream does not crash on a queued transcript write", async () => {
	const harness = await createHostHarness({ whenUnattached: "keep" });
	const conversation = await harness.openStartup();
	const recv = new ManualIrohRecvStream();
	const send = new BlockingFinishIrohSendStream();
	const connection = serveIrohRemoteConnection({
		host: harness.host,
		conversation,
		stream: { recv, send },
		grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
		redaction: { workspacePath: conversation.cwd },
		redirect: {},
	});

	try {
		recv.pushLine(
			JSON.stringify({
				type: "hello",
				protocol: 1,
				client: { name: "phone", version: "1" },
				accepts: { hostRequests: [] },
			}),
		);
		recv.pushLine(
			JSON.stringify({ type: "subscribe", subscriptionId: "s1", conversation: conversation.id, after: "snapshot" }),
		);
		await vi.waitFor(() =>
			expect(frames(send)).toContainEqual(
				expect.objectContaining({ type: "live", subscriptionId: "s1", reset: true }),
			),
		);
		expect(frames(send)[0]).toMatchObject({ type: "welcome", conversation: conversation.id });

		// The phone hangs up; the host's finish of its send side is still pending.
		recv.end();
		await send.finishStarted;
		const written = frames(send).length;

		// A transcript entry commits while the stream closes: nothing is written to the closed stream.
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "queued transcript" }],
			timestamp: Date.now(),
		};
		await conversation.session.sessionWriter.appendMessage(message);
		conversation.liveState.notice("info", "after close");
		await new Promise((resolve) => setImmediate(resolve));

		expect(frames(send)).toHaveLength(written);
		expect(send.writtenText()).not.toContain("queued transcript");
		send.releaseFinish();
		await expect(connection.closed).resolves.toBeUndefined();
		expect(conversation.closed).toBe(false);
	} finally {
		send.releaseFinish();
		await connection.closed.catch(() => {});
		await harness.cleanup();
	}
});
