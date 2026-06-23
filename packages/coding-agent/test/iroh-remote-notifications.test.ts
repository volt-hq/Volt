import { Buffer } from "node:buffer";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { REVIEW_UNCOMMITTED_ACTION_ID } from "../src/core/host-actions.ts";
import type { IrohBytes, IrohRecvStreamLike, IrohSendStreamLike } from "../src/core/rpc/index.ts";

const reviewMocks = vi.hoisted(() => ({
	runReviewWorkflow: vi.fn(async (options: { newSession: (options?: unknown) => Promise<{ cancelled: boolean }> }) => {
		const newSessionResult = await options.newSession({});
		return {
			status: "completed" as const,
			resolution: {
				description: "uncommitted changes",
				diffCommand: "git diff HEAD",
				diff: "diff",
				truncated: false,
			},
			findingsCount: 1,
			sessionSwitchCancelled: newSessionResult.cancelled,
		};
	}),
}));

vi.mock("../src/core/review.ts", () => ({
	REMOTE_REVIEW_TOOL_NAMES: ["read", "grep", "find", "ls"],
	runReviewWorkflow: reviewMocks.runReviewWorkflow,
}));

import { runIrohRemoteRpcMode } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";

type QueuedIrohRead = { type: "data"; bytes: IrohBytes } | { type: "end" };

class ManualIrohRecvStream implements IrohRecvStreamLike {
	private readonly queue: QueuedIrohRead[] = [];
	private readonly readers: Array<(value: IrohBytes | undefined) => void> = [];

	read(_sizeLimit: number): Promise<IrohBytes | undefined> {
		const queued = this.queue.shift();
		if (queued) {
			return Promise.resolve(queued.type === "data" ? queued.bytes : undefined);
		}
		return new Promise((resolve) => {
			this.readers.push(resolve);
		});
	}

	pushLine(line: string): void {
		this.enqueue({ type: "data", bytes: Buffer.from(`${line}\n`, "utf8") });
	}

	end(): void {
		this.enqueue({ type: "end" });
	}

	stop(_errorCode: bigint): void {
		this.end();
	}

	private enqueue(queued: QueuedIrohRead): void {
		const reader = this.readers.shift();
		if (!reader) {
			this.queue.push(queued);
			return;
		}
		reader(queued.type === "data" ? queued.bytes : undefined);
	}
}

class ManualIrohSendStream implements IrohSendStreamLike {
	readonly writes: Array<Array<number>> = [];
	finished = false;

	async writeAll(bytes: Array<number>): Promise<void> {
		this.writes.push(bytes);
	}

	async finish(): Promise<void> {
		this.finished = true;
	}

	writtenText(): string {
		return this.writes.map((bytes) => Buffer.from(bytes).toString("utf8")).join("");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWrittenObjects(send: ManualIrohSendStream): Array<Record<string, unknown>> {
	return send
		.writtenText()
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const parsed = JSON.parse(line) as unknown;
			if (!isRecord(parsed)) {
				throw new Error("Expected JSON object");
			}
			return parsed;
		});
}

function getNotifications(send: ManualIrohSendStream): Array<Record<string, unknown>> {
	return parseWrittenObjects(send).filter((record) => record.type === "notification_request");
}

function createTestSession(sessionId: string, leafId: string | null) {
	const session = {
		leafId,
		autoCompactionEnabled: false,
		bindExtensions: vi.fn(async () => {}),
		followUpMode: "all" as const,
		isCompacting: false,
		isStreaming: false,
		messages: [],
		model: undefined,
		modelRegistry: { authStorage: {} },
		pendingMessageCount: 0,
		prompt: vi.fn(
			async (_message: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void> => {
				options?.preflightResult?.(true);
			},
		),
		sessionFile: `/sessions/${sessionId}.jsonl`,
		sessionId,
		sessionManager: {
			getLeafId: (): string | null => session.leafId,
		},
		settingsManager: {},
		steeringMode: "all" as const,
		subscribe: vi.fn((_handler: (event: object) => void) => () => {}),
		thinkingLevel: "off" as const,
		waitForIdle: vi.fn(async () => {}),
		agent: {
			subscribe: vi.fn((_handler: () => Promise<void> | void) => () => {}),
			waitForIdle: vi.fn(async () => {}),
		},
	};
	return session;
}

async function startIrohRpcMode(
	runtimeHost: AgentSessionRuntime,
	startupSession: ReturnType<typeof createTestSession>,
) {
	const recv = new ManualIrohRecvStream();
	const send = new ManualIrohSendStream();
	const modePromise = runIrohRemoteRpcMode(runtimeHost, {
		disposeRuntimeOnClose: false,
		stream: { recv, send },
		workspacePath: "/workspace",
	});
	await vi.waitFor(() => expect(startupSession.bindExtensions).toHaveBeenCalledOnce());
	return { modePromise, recv, send };
}

afterEach(() => {
	reviewMocks.runReviewWorkflow.mockClear();
});

describe("Iroh remote notification requests", () => {
	test("emits one conversation completion notification after prompt completion", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (_message: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void> => {
				options?.preflightResult?.(true);
				session.leafId = "conversation-run";
			},
		);
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session);

		recv.pushLine(JSON.stringify({ id: "prompt-1", type: "prompt", message: "hello" }));

		await vi.waitFor(() =>
			expect(getNotifications(send)).toEqual([
				{
					type: "notification_request",
					eventId: "conversation:session-one:conversation-run:completed",
					kind: "conversation_completed",
					title: "Volt finished",
					body: "Your conversation is ready.",
					sessionId: "session-one",
				},
			]),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("emits one review completion notification after a remote review action completes", async () => {
		let currentSession = createTestSession("initial-session", "initial-run");
		const runtimeHost = {
			get session() {
				return currentSession;
			},
			cwd: "/workspace",
			services: { agentDir: "/agent" },
			newSession: vi.fn(async () => {
				currentSession = createTestSession("review-session", "review-run");
				return { cancelled: false };
			}),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const startupSession = currentSession;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, startupSession);

		recv.pushLine(JSON.stringify({ id: "review-1", type: "invoke_ui_action", action: REVIEW_UNCOMMITTED_ACTION_ID }));

		await vi.waitFor(() =>
			expect(getNotifications(send)).toEqual([
				{
					type: "notification_request",
					eventId: "review:review-session:review-run:completed",
					kind: "review_completed",
					title: "Review complete",
					body: "Open Volt to see the findings.",
					sessionId: "review-session",
				},
			]),
		);
		expect(reviewMocks.runReviewWorkflow).toHaveBeenCalledOnce();

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});
});
