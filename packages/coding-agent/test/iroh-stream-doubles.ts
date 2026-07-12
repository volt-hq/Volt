/**
 * Shared manual Iroh stream doubles and session/boot helpers for Iroh remote RPC tests.
 *
 * These implement the simple blocking-read semantics used by the notification and
 * model RPC suites. Other Iroh suites (transport, core, handshake) keep their own
 * doubles on purpose: they exercise different transport semantics (read-size
 * tracking, deferred/failing writes, non-blocking handshake reads) that would
 * change test behavior if folded into one implementation.
 */

import { Buffer } from "node:buffer";
import type { AgentMessage } from "@earendil-works/volt-agent-core";
import type { Api, Model } from "@earendil-works/volt-ai";
import { expect, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import type { IrohBytes, IrohRecvStreamLike, IrohSendStreamLike } from "../src/core/rpc/index.ts";
import { runIrohRemoteRpcMode } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";

type QueuedIrohRead = { type: "data"; bytes: IrohBytes } | { type: "end" };

export class ManualIrohRecvStream implements IrohRecvStreamLike {
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

export class ManualIrohSendStream implements IrohSendStreamLike {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWrittenObjects(send: ManualIrohSendStream): Array<Record<string, unknown>> {
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

export function createTestSession(sessionId: string, leafId: string | null) {
	const session = {
		leafId,
		autoCompactionEnabled: false,
		bindExtensions: vi.fn(async () => {}),
		followUpMode: "all" as const,
		isCompacting: false,
		isStreaming: false,
		messages: [] as AgentMessage[],
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
			getBranch: vi.fn((): object[] => []),
			getLeafId: (): string | null => session.leafId,
			getSessionId: (): string => sessionId,
		},
		settingsManager: {},
		steeringMode: "all" as const,
		subscribe: vi.fn((_handler: (event: AgentSessionEvent) => void) => () => {}),
		thinkingLevel: "off" as const,
		waitForIdle: vi.fn(async () => {}),
		agent: {
			subscribe: vi.fn((_handler: () => Promise<void> | void) => () => {}),
			waitForIdle: vi.fn(async () => {}),
		},
	};
	return session;
}

export async function startIrohRpcMode(
	runtimeHost: AgentSessionRuntime,
	startupSession: Pick<ReturnType<typeof createTestSession>, "bindExtensions">,
	options: Partial<Parameters<typeof runIrohRemoteRpcMode>[1]> = {},
) {
	const recv = new ManualIrohRecvStream();
	const send = new ManualIrohSendStream();
	const modePromise = runIrohRemoteRpcMode(runtimeHost, {
		...options,
		rpcGrant: options.rpcGrant ?? createIrohRemotePresetAccess("full").rpcGrant,
		disposeRuntimeOnClose: false,
		stream: { recv, send },
		workspacePath: "/workspace",
	});
	await vi.waitFor(() => expect(startupSession.bindExtensions).toHaveBeenCalledOnce());
	return { modePromise, recv, send };
}

export function createTestModel(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...overrides,
	} as Model<Api>;
}
