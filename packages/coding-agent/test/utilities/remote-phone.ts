/**
 * A scripted paired device for tests: it speaks protocol 1 frames over an
 * Iroh bidirectional stream after its handshake, records every frame the host
 * writes, and sends intents at its position (the remote profile fences
 * branch intents on `expectedOrdinal`).
 */

import { randomUUID } from "node:crypto";
import type { HostFrame, HostRequestKind } from "@hansjm10/volt-protocol";
import { expect, vi } from "vitest";
import {
	createIrohRpcTransport,
	type IrohBiStreamLike,
	type IrohBytes,
} from "../../src/core/protocol/transport/iroh-transport.ts";

type Frame<T extends HostFrame["type"]> = Extract<HostFrame, { type: T }>;
export type IntentOutcome = Frame<"accepted"> | Frame<"rejected">;
export type QueryOutcome = Frame<"result"> | Frame<"query_error">;

export interface RemotePhone {
	/** Every frame the host wrote, in order. */
	readonly frames: HostFrame[];
	/** Settles once the host ended the stream. */
	readonly ended: Promise<void>;
	send(frame: object): void;
	/** Say hello, accepting `hostRequests`; resolves with `welcome`. */
	hello(hostRequests?: readonly HostRequestKind[]): Promise<Frame<"welcome">>;
	/** Subscribe from a snapshot and wait for the live lane's reset. */
	subscribe(conversation: string, subscriptionId?: string): Promise<void>;
	/** The newest ordinal the device saw. */
	position(): number;
	/** Send an intent at the device's position; resolves with its outcome. */
	intent(
		type: string,
		input?: unknown,
		options?: { intentId?: string; conversation?: string; expectedOrdinal?: number | null },
	): Promise<IntentOutcome>;
	query(query: string, params?: unknown, conversation?: string): Promise<QueryOutcome>;
	/** The first frame from `from` on that matches `predicate`. */
	waitFor<T extends HostFrame>(
		predicate: (frame: HostFrame) => frame is T,
		options?: { timeout?: number; from?: number },
	): Promise<T>;
	close(): Promise<void>;
}

/** A device on `stream`, whose handshake is done; `initialInput` holds bytes read past the handshake response. */
export function connectRemotePhone(stream: IrohBiStreamLike, initialInput?: IrohBytes): RemotePhone {
	const transport = createIrohRpcTransport({ stream, ...(initialInput === undefined ? {} : { initialInput }) });
	const frames: HostFrame[] = [];
	const ended = Promise.withResolvers<void>();
	transport.onLine((line) => {
		frames.push(JSON.parse(line) as HostFrame);
	});
	transport.onClose?.(() => ended.resolve());
	const send = (frame: object): void => {
		try {
			void Promise.resolve(transport.write(frame)).catch(() => undefined);
		} catch {
			// The stream closed; the test reads what arrived.
		}
	};
	const waitFor = async <T extends HostFrame>(
		predicate: (frame: HostFrame) => frame is T,
		options: { timeout?: number; from?: number } = {},
	): Promise<T> => {
		let found: T | undefined;
		await vi.waitFor(
			() => {
				found = frames.slice(options.from ?? 0).find(predicate);
				expect(found).toBeDefined();
			},
			{ timeout: options.timeout ?? 10_000 },
		);
		return found!;
	};
	const position = (): number => {
		let ordinal = 0;
		for (const frame of frames) {
			if (frame.type === "snapshot") ordinal = frame.ordinal;
			else if (frame.type === "entry") ordinal = Math.max(ordinal, frame.entry.ordinal);
			else if (frame.type === "head") ordinal = Math.max(ordinal, frame.ordinal);
		}
		return ordinal;
	};
	return {
		frames,
		ended: ended.promise,
		send,
		async hello(hostRequests = []) {
			send({ type: "hello", protocol: 1, client: { name: "phone", version: "1" }, accepts: { hostRequests } });
			return waitFor((frame): frame is Frame<"welcome"> => frame.type === "welcome");
		},
		async subscribe(conversation, subscriptionId = "s1") {
			const from = frames.length;
			send({ type: "subscribe", subscriptionId, conversation, after: "snapshot" });
			await waitFor(
				(frame): frame is HostFrame =>
					(frame.type === "live" && frame.subscriptionId === subscriptionId && frame.reset === true) ||
					(frame.type === "ended" && frame.subscriptionId === subscriptionId),
				{ from },
			);
		},
		position,
		async intent(type, input, options = {}) {
			const intentId = options.intentId ?? `i-${randomUUID()}`;
			const expectedOrdinal = options.expectedOrdinal === undefined ? position() : options.expectedOrdinal;
			send({
				type,
				intentId,
				...(options.conversation === undefined ? {} : { conversation: options.conversation }),
				...(expectedOrdinal === null ? {} : { expectedOrdinal }),
				...(input === undefined ? {} : { input }),
			});
			return waitFor(
				(frame): frame is IntentOutcome =>
					(frame.type === "accepted" || frame.type === "rejected") && frame.intentId === intentId,
			);
		},
		async query(query, params, conversation) {
			const queryId = `q-${randomUUID()}`;
			send({
				type: "query",
				queryId,
				query,
				...(conversation === undefined ? {} : { conversation }),
				...(params === undefined ? {} : { params }),
			});
			return waitFor(
				(frame): frame is QueryOutcome =>
					(frame.type === "result" || frame.type === "query_error") && frame.queryId === queryId,
			);
		},
		waitFor,
		async close() {
			await Promise.resolve(transport.close()).catch(() => undefined);
		},
	};
}
