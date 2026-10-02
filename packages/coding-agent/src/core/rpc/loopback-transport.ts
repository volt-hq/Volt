import { serializeJsonLine } from "./jsonl.ts";
import type { RpcCloseHandler, RpcLineHandler, RpcTransport, RpcValueHandler } from "./transport.ts";

export interface LoopbackRpcTransportPair {
	client: RpcTransport;
	server: RpcTransport;
}

/**
 * Create an in-memory, full-duplex RPC transport pair.
 *
 * Frames pass between endpoints as structured values, not JSONL text: each
 * write is structured-cloned once so endpoints never observe each other's
 * later mutations, and consumers subscribed through onValue skip JSON
 * serialize/parse entirely. onLine remains supported for line-based consumers
 * by serializing lazily per delivery. Closing one endpoint's output closes the
 * peer endpoint's input.
 */
export function createLoopbackRpcTransportPair(): LoopbackRpcTransportPair {
	const client = new LoopbackRpcTransportEndpoint();
	const server = new LoopbackRpcTransportEndpoint();
	client.setPeer(server);
	server.setPeer(client);
	return { client, server };
}

function cloneLoopbackFrame(value: object): unknown {
	try {
		return structuredClone(value);
	} catch {
		// Rare non-cloneable frames (e.g. embedded functions) keep the legacy
		// JSON round-trip semantics: unsupported values are dropped, not thrown.
		return JSON.parse(JSON.stringify(value));
	}
}

class LoopbackRpcTransportEndpoint implements RpcTransport {
	private readonly valueHandlers = new Set<RpcValueHandler>();
	private readonly lineHandlers = new Set<RpcLineHandler>();
	private readonly closeHandlers = new Set<RpcCloseHandler>();
	private readonly queuedValues: unknown[] = [];
	private peer: LoopbackRpcTransportEndpoint | undefined;
	private inputClosed = false;
	private inputCloseError: Error | undefined;
	private outputClosed = false;

	setPeer(peer: LoopbackRpcTransportEndpoint): void {
		this.peer = peer;
	}

	write(value: object): void {
		if (this.outputClosed) {
			throw new Error("Loopback RPC transport output is closed");
		}
		if (!this.peer) {
			throw new Error("Loopback RPC transport peer is missing");
		}

		this.peer.receiveValue(cloneLoopbackFrame(value));
	}

	onValue(handler: RpcValueHandler): () => void {
		this.valueHandlers.add(handler);
		this.drainQueuedValues();
		return () => {
			this.valueHandlers.delete(handler);
		};
	}

	onLine(handler: RpcLineHandler): () => void {
		this.lineHandlers.add(handler);
		this.drainQueuedValues();
		return () => {
			this.lineHandlers.delete(handler);
		};
	}

	onClose(handler: RpcCloseHandler): () => void {
		if (this.inputClosed) {
			let active = true;
			queueMicrotask(() => {
				if (active) {
					handler(this.inputCloseError);
				}
			});
			return () => {
				active = false;
			};
		}

		this.closeHandlers.add(handler);
		return () => {
			this.closeHandlers.delete(handler);
		};
	}

	async waitForBackpressure(): Promise<void> {}

	async flush(): Promise<void> {}

	close(): void {
		if (this.outputClosed) {
			return;
		}
		this.outputClosed = true;
		this.peer?.endInput();
	}

	private receiveValue(value: unknown): void {
		if (this.inputClosed) {
			return;
		}
		if (this.valueHandlers.size === 0 && this.lineHandlers.size === 0) {
			this.queuedValues.push(value);
			return;
		}

		this.emitValue(value);
	}

	private endInput(error?: Error): void {
		if (this.inputClosed) {
			return;
		}
		this.inputClosed = true;
		this.inputCloseError = error;
		for (const handler of this.closeHandlers) {
			handler(error);
		}
	}

	private drainQueuedValues(): void {
		while (this.queuedValues.length > 0 && (this.valueHandlers.size > 0 || this.lineHandlers.size > 0)) {
			this.emitValue(this.queuedValues.shift());
		}
	}

	private emitValue(value: unknown): void {
		for (const handler of this.valueHandlers) {
			handler(value);
		}
		if (this.lineHandlers.size > 0) {
			const line = serializeJsonLine(value).slice(0, -1);
			for (const handler of this.lineHandlers) {
				handler(line);
			}
		}
	}
}
