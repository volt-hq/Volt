import type { Duplex } from "node:stream";

export class StreamClosedError extends Error {
	readonly code = "ERR_STREAM_CLOSED_DURING_WRITE";

	constructor(message = "stream closed during write") {
		super(message);
		this.name = "StreamClosedError";
	}
}

interface PendingWrite {
	resolve(): void;
	reject(error: Error): void;
}

/**
 * A single write-side event gate for a Duplex. Writes waiting on backpressure
 * settle on drain, error, or close, so callers cannot hang forever on a closed
 * socket.
 */
export class DuplexWriteGate {
	private readonly socket: Duplex;
	private readonly pendingWrites: PendingWrite[] = [];
	private terminalError: Error | undefined;
	private disposed = false;
	private resolveClosed: () => void = () => {};
	readonly closed: Promise<void>;

	constructor(socket: Duplex) {
		this.socket = socket;
		this.closed = new Promise<void>((resolve) => {
			this.resolveClosed = resolve;
		});
		socket.on("drain", this.onDrain);
		socket.on("error", this.onError);
		socket.on("close", this.onClose);
	}

	get failure(): Error | undefined {
		return this.terminalError;
	}

	write(chunk: Buffer): Promise<void> {
		if (this.terminalError) {
			return Promise.reject(this.terminalError);
		}
		if (this.disposed || this.socket.destroyed || this.socket.writableEnded) {
			return Promise.reject(new StreamClosedError());
		}
		try {
			if (this.socket.write(chunk)) {
				return Promise.resolve();
			}
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			this.setTerminal(writeError);
			return Promise.reject(writeError);
		}
		return new Promise<void>((resolve, reject) => {
			this.pendingWrites.push({ resolve, reject });
		});
	}

	end(): Promise<void> {
		if (this.socket.destroyed || this.socket.writableEnded) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const settle = (error?: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				this.socket.off("finish", onFinish);
				this.socket.off("close", onClose);
				this.socket.off("error", onError);
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			};
			const onFinish = () => settle();
			const onClose = () => settle();
			const onError = (error: Error) => settle(error);
			this.socket.once("finish", onFinish);
			this.socket.once("close", onClose);
			this.socket.once("error", onError);
			try {
				this.socket.end();
			} catch (error) {
				settle(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.socket.off("drain", this.onDrain);
		this.socket.off("error", this.onError);
		this.socket.off("close", this.onClose);
		this.rejectPending(this.terminalError ?? new StreamClosedError());
	}

	private readonly onDrain = () => {
		const writes = this.pendingWrites.splice(0);
		for (const write of writes) {
			write.resolve();
		}
	};

	private readonly onError = (error: Error) => {
		this.setTerminal(error);
	};

	private readonly onClose = () => {
		this.setTerminal(this.terminalError ?? new StreamClosedError());
		this.resolveClosed();
	};

	private setTerminal(error: Error): void {
		if (!this.terminalError) {
			this.terminalError = error;
		}
		this.rejectPending(this.terminalError);
	}

	private rejectPending(error: Error): void {
		const writes = this.pendingWrites.splice(0);
		for (const write of writes) {
			write.reject(error);
		}
	}
}
