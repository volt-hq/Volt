import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { expect, test, vi } from "vitest";
import type { AgentSessionEventListener } from "../../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { createIrohRemotePresetAccess } from "../../../src/core/remote/iroh/access-grant.ts";
import { runIrohRemoteRpcMode } from "../../../src/modes/rpc/iroh-remote-rpc-mode.ts";
import {
	createTestIrohConversationOptions,
	ManualIrohRecvStream,
	ManualIrohSendStream,
	parseWrittenObjects,
} from "../../iroh-stream-doubles.ts";
import { createHarness } from "../harness.ts";

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

test("closed Iroh stream does not crash on a queued transcript write", async () => {
	const harness = await createHarness();
	const sessionListeners: AgentSessionEventListener[] = [];
	const originalSubscribe = harness.session.subscribe.bind(harness.session);
	const subscribeSpy = vi.spyOn(harness.session, "subscribe").mockImplementation((listener) => {
		sessionListeners.push(listener);
		return originalSubscribe(listener);
	});
	const recv = new ManualIrohRecvStream();
	const send = new BlockingFinishIrohSendStream();
	const runtimeHost = {
		cwd: harness.tempDir,
		dispose: vi.fn(async () => {}),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		newSession: vi.fn(async () => ({ cancelled: true })),
		runWithStableSession: vi.fn(async (operation: (session: typeof harness.session) => Promise<unknown> | unknown) =>
			operation(harness.session),
		),
		services: { agentDir: harness.tempDir },
		session: harness.session,
		setRebindSession: vi.fn(),
		switchSession: vi.fn(async () => ({ cancelled: true })),
	} as unknown as AgentSessionRuntime;
	const modePromise = runIrohRemoteRpcMode(runtimeHost, {
		...createTestIrohConversationOptions(runtimeHost),
		disposeRuntimeOnClose: false,
		rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
		stream: { recv, send },
		workspacePath: harness.tempDir,
	});

	try {
		await vi.waitFor(() => expect(sessionListeners).toHaveLength(1));
		expect(parseWrittenObjects(send)[0]).toMatchObject({
			type: "conversation_bootstrap",
			delivery: { cursor: 0 },
			conversation: { sessionId: harness.session.sessionId },
		});
		recv.pushLine(JSON.stringify({ id: "startup-ready", type: "get_state" }));
		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual(
				expect.objectContaining({
					id: "startup-ready",
					type: "response",
					command: "get_state",
					success: true,
				}),
			),
		);
		const transcriptListener = sessionListeners[0];
		if (!transcriptListener) {
			throw new Error("Expected transcript listener");
		}

		recv.end();
		await send.finishStarted;

		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "queued transcript" }],
			timestamp: Date.now(),
		};
		harness.sessionManager.appendMessage(message);
		transcriptListener({ type: "message_end", message });
		await new Promise((resolve) => setImmediate(resolve));

		expect(parseWrittenObjects(send)).not.toContainEqual(expect.objectContaining({ type: "transcript_entry" }));
		send.releaseFinish();
		await expect(modePromise).resolves.toBeUndefined();
	} finally {
		send.releaseFinish();
		await modePromise.catch(() => {});
		subscribeSpy.mockRestore();
		harness.cleanup();
	}
});
