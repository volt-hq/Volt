import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
	CONTROL_MAX_LINE_BYTES,
	type ControlClientKind,
	type ControlEvent,
	ControlLineDecoder,
	type ControlRequest,
	type ControlResponse,
	encodeControlLine,
	type HelloAck,
	type HelloMessage,
	isControlRequest,
	PROTOCOL_VERSION,
	parseHelloMessage,
} from "./control-protocol.ts";

export interface ControlConnection {
	readonly connectionId: string;
	readonly client: ControlClientKind;
	readonly pid: number;
	readonly version: string;
	send(message: ControlResponse | ControlEvent): void;
	close(): void;
}

export interface RelayAdmission {
	/** Validate a relay hello; on success the server hands over the raw socket. */
	admitRelay(hello: Extract<HelloMessage, { role: "relay" }>, socket: Socket, bufferedRemainder: Buffer): boolean;
}

export interface ControlServerHandlers {
	/**
	 * Handle one request; respond via connection.send (possibly multiple times
	 * for provisional responses). Thrown errors become error responses.
	 */
	onRequest(connection: ControlConnection, request: ControlRequest): Promise<void> | void;
	onConnectionClosed?(connection: ControlConnection): void;
	relayAdmission?: RelayAdmission;
	/** When true, hellos are rejected with error "shutting_down". */
	isShuttingDown?(): boolean;
	log?(level: "info" | "warn" | "error", message: string): void;
}

export interface ControlServerOptions {
	socketPath: string;
	version: string;
	handlers: ControlServerHandlers;
}

export interface ControlServer {
	readonly socketPath: string;
	connections(): ControlConnection[];
	broadcast(event: ControlEvent): void;
	sendTo(connectionId: string, event: ControlEvent): boolean;
	close(): Promise<void>;
}

let controlConnectionSequence = 0;

export async function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
	const { socketPath, version, handlers } = options;
	const connections = new Map<string, ControlConnectionImpl>();

	class ControlConnectionImpl implements ControlConnection {
		readonly connectionId: string;
		readonly client: ControlClientKind;
		readonly pid: number;
		readonly version: string;
		private readonly socket: Socket;

		constructor(socket: Socket, hello: Extract<HelloMessage, { role: "control" }>) {
			this.connectionId = `c-${++controlConnectionSequence}`;
			this.client = hello.client;
			this.pid = hello.pid;
			this.version = hello.version;
			this.socket = socket;
		}

		send(message: ControlResponse | ControlEvent): void {
			if (!this.socket.destroyed) {
				this.socket.write(encodeControlLine(message));
			}
		}

		close(): void {
			this.socket.destroy();
		}
	}

	const server: Server = createServer((socket) => {
		const decoder = new ControlLineDecoder();
		let established: ControlConnectionImpl | undefined;
		let handedOffToRelay = false;

		const fatal = (error: string) => {
			try {
				socket.write(encodeControlLine({ type: "fatal", error }));
			} catch {
				// best-effort
			}
			socket.destroy();
		};

		const handleHello = (hello: HelloMessage | undefined): boolean => {
			if (!hello) {
				fatal("invalid_hello");
				return false;
			}
			if (handlers.isShuttingDown?.()) {
				const ack: HelloAck = { type: "hello_ack", ok: false, error: "shutting_down" };
				socket.end(encodeControlLine(ack));
				return false;
			}
			if (hello.protocolVersion !== PROTOCOL_VERSION) {
				const ack: HelloAck = {
					type: "hello_ack",
					ok: false,
					error: "protocol_mismatch",
					version,
					protocolVersion: PROTOCOL_VERSION,
				};
				socket.end(encodeControlLine(ack));
				return false;
			}
			if (hello.role === "relay") {
				const remainder = decoder.drainRemainder();
				socket.removeListener("data", onData);
				handedOffToRelay = true;
				const admitted = handlers.relayAdmission?.admitRelay(hello, socket, remainder) ?? false;
				if (!admitted) {
					const ack: HelloAck = { type: "hello_ack", ok: false, error: "bad_relay_token" };
					socket.end(encodeControlLine(ack));
				}
				return false;
			}
			established = new ControlConnectionImpl(socket, hello);
			connections.set(established.connectionId, established);
			const ack: HelloAck = {
				type: "hello_ack",
				ok: true,
				connectionId: established.connectionId,
				version,
				protocolVersion: PROTOCOL_VERSION,
			};
			socket.write(encodeControlLine(ack));
			return true;
		};

		const handleMessage = (message: unknown): void => {
			const connection = established;
			if (!connection) {
				if (!handleHello(parseHelloMessage(message))) {
					return;
				}
				return;
			}
			if (!isControlRequest(message)) {
				const id =
					typeof message === "object" && message !== null && typeof (message as { id?: unknown }).id === "string"
						? ((message as { id: string }).id ?? "")
						: "";
				connection.send({ type: "error", id, code: "invalid_request", message: "unrecognized control request" });
				return;
			}
			Promise.resolve(handlers.onRequest(connection, message)).catch((error) => {
				connection.send({
					type: "error",
					id: message.id,
					code: "internal_error",
					message: error instanceof Error ? error.message : String(error),
				});
			});
		};

		const onData = (chunk: Buffer) => {
			let messages: unknown[];
			try {
				messages = decoder.push(chunk);
			} catch {
				fatal("frame_too_large");
				return;
			}
			for (const message of messages) {
				handleMessage(message);
				if (handedOffToRelay) {
					return;
				}
			}
		};

		socket.on("data", onData);
		socket.on("error", () => {
			socket.destroy();
		});
		socket.on("close", () => {
			if (established) {
				connections.delete(established.connectionId);
				handlers.onConnectionClosed?.(established);
			}
		});
	});

	server.maxConnections = 256;

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	try {
		chmodSync(socketPath, 0o600);
	} catch {
		// The socket may live on a filesystem without chmod support; directory perms still apply.
	}

	return {
		socketPath,
		connections() {
			return Array.from(connections.values());
		},
		broadcast(event: ControlEvent) {
			for (const connection of connections.values()) {
				connection.send(event);
			}
		},
		sendTo(connectionId: string, event: ControlEvent) {
			const connection = connections.get(connectionId);
			if (!connection) {
				return false;
			}
			connection.send(event);
			return true;
		},
		async close() {
			for (const connection of connections.values()) {
				connection.close();
			}
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			if (process.platform !== "win32") {
				rmSync(socketPath, { force: true });
			}
		},
	};
}

/**
 * Probe an existing socket with a status request. Returns the status_result
 * payload, or undefined when nothing healthy answers within timeoutMs.
 */
export async function probeControlSocket(
	socketPath: string,
	options: { version: string; timeoutMs?: number } = { version: "0.0.0" },
): Promise<(ControlResponse & { type: "status_result" }) | undefined> {
	const timeoutMs = options.timeoutMs ?? 2000;
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: (ControlResponse & { type: "status_result" }) | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => settle(undefined), timeoutMs);
		const socket = createConnection(socketPath);
		const decoder = new ControlLineDecoder();
		socket.on("error", () => settle(undefined));
		socket.on("close", () => settle(undefined));
		socket.on("connect", () => {
			const hello: HelloMessage = {
				type: "hello",
				role: "control",
				protocolVersion: PROTOCOL_VERSION,
				pid: process.pid,
				version: options.version,
				client: "cli",
			};
			socket.write(encodeControlLine(hello));
			socket.write(encodeControlLine({ type: "status", id: "probe" }));
		});
		socket.on("data", (chunk) => {
			let messages: unknown[];
			try {
				messages = decoder.push(chunk);
			} catch {
				settle(undefined);
				return;
			}
			for (const message of messages) {
				if (
					typeof message === "object" &&
					message !== null &&
					(message as { type?: unknown }).type === "status_result"
				) {
					settle(message as ControlResponse & { type: "status_result" });
					return;
				}
				if (
					typeof message === "object" &&
					message !== null &&
					(message as { type?: unknown }).type === "hello_ack" &&
					(message as { ok?: unknown }).ok === false
				) {
					settle(undefined);
					return;
				}
			}
		});
	});
}

export { CONTROL_MAX_LINE_BYTES };
