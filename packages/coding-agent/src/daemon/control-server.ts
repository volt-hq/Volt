import { chmodSync, lstatSync, rmSync, type Stats } from "node:fs";
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
	isHelloAck,
	PROTOCOL_VERSION,
	parseHelloMessage,
} from "./control-protocol.ts";

export interface ControlConnection {
	readonly connectionId: string;
	readonly client: ControlClientKind;
	readonly pid: number;
	readonly version: string;
	/** Capabilities from the control hello (empty for old clients). */
	readonly capabilities: ReadonlySet<string>;
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
	/** Optional local control-plane token published in the daemon pidfile. */
	authToken?: string;
	handlers: ControlServerHandlers;
}

export interface ControlServer {
	readonly socketPath: string;
	connections(): ControlConnection[];
	broadcast(event: ControlEvent): void;
	sendTo(connectionId: string, event: ControlEvent): boolean;
	close(): Promise<void>;
}

type ControlStatusProbe = ControlResponse & { type: "status_result" };

export type ControlSocketProbe =
	| { kind: "healthy"; status: ControlStatusProbe }
	| {
			kind: "live-rejected";
			reason: "shutting_down" | "protocol_mismatch" | "bad_relay_token" | "auth_failed" | "fatal" | "other";
			error?: string;
			version?: string;
			protocolVersion?: number;
	  }
	| { kind: "unresponsive"; error?: string }
	| { kind: "no-listener"; cause: "not-found" | "refused" | "reset" | "error"; error?: string };

let controlConnectionSequence = 0;

export async function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
	const { socketPath, version, authToken, handlers } = options;
	const connections = new Map<string, ControlConnectionImpl>();

	class ControlConnectionImpl implements ControlConnection {
		readonly connectionId: string;
		readonly client: ControlClientKind;
		readonly pid: number;
		readonly version: string;
		readonly capabilities: ReadonlySet<string>;
		private readonly socket: Socket;

		constructor(socket: Socket, hello: Extract<HelloMessage, { role: "control" }>) {
			this.connectionId = `c-${++controlConnectionSequence}`;
			this.client = hello.client;
			this.pid = hello.pid;
			this.version = hello.version;
			this.capabilities = new Set(hello.capabilities ?? []);
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
				const ack: HelloAck = {
					type: "hello_ack",
					ok: false,
					error: "shutting_down",
					version,
					protocolVersion: PROTOCOL_VERSION,
				};
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
			if (hello.role === "control" && authToken !== undefined && hello.controlToken !== authToken) {
				const ack: HelloAck = {
					type: "hello_ack",
					ok: false,
					error: "auth_failed",
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
				let admitted = false;
				try {
					admitted = handlers.relayAdmission?.admitRelay(hello, socket, remainder) ?? false;
				} catch (error) {
					// admitRelay may have partly taken ownership of the socket before
					// throwing, and the socket now carries raw relay bytes — so a
					// synchronous failure must NOT fall through to onData's generic catch,
					// which would inject a misleading fatal("frame_too_large") control
					// frame into the raw stream and destroy a socket the relay path may
					// own. Log the real reason and tear down cleanly instead.
					handlers.log?.(
						"error",
						`relay admission threw: ${error instanceof Error ? error.message : String(error)}`,
					);
					socket.destroy();
					return false;
				}
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
			try {
				// One line at a time: a relay hello hands the socket off mid-chunk and
				// any trailing bytes must stay undecoded (they are raw relay payload).
				decoder.pushEach(chunk, (message) => {
					handleMessage(message);
					return handedOffToRelay ? "stop" : "continue";
				});
			} catch {
				fatal("frame_too_large");
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
	let boundSocketStats: Stats | undefined;
	try {
		boundSocketStats = lstatSync(socketPath);
	} catch {
		// Best-effort ownership check: close() will skip unlinking when it cannot
		// prove the path still belongs to this server.
	}
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
			if (process.platform !== "win32" && boundSocketStats) {
				try {
					const currentStats = lstatSync(socketPath);
					if (
						currentStats.isSocket() &&
						currentStats.dev === boundSocketStats.dev &&
						currentStats.ino === boundSocketStats.ino
					) {
						rmSync(socketPath, { force: true });
					}
				} catch {
					// Already gone or not ours.
				}
			}
		},
	};
}

/**
 * Probe an existing socket with a status request. The result distinguishes a
 * provably dead/stale path from a live daemon that answered but rejected us;
 * callers must only unlink a socket after a no-listener result.
 */
export async function probeControlSocket(
	socketPath: string,
	options: { version: string; timeoutMs?: number; authToken?: string } = { version: "0.0.0" },
): Promise<ControlSocketProbe> {
	const timeoutMs = options.timeoutMs ?? 2000;
	return new Promise((resolve) => {
		let settled = false;
		let connected = false;
		let lastError: Error | undefined;
		const classifyNoListener = (error: Error | undefined): ControlSocketProbe => {
			const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
			if (code === "ENOENT") {
				return { kind: "no-listener", cause: "not-found", ...(error ? { error: error.message } : {}) };
			}
			if (code === "ECONNREFUSED") {
				return { kind: "no-listener", cause: "refused", ...(error ? { error: error.message } : {}) };
			}
			if (code === "ECONNRESET") {
				return { kind: "no-listener", cause: "reset", ...(error ? { error: error.message } : {}) };
			}
			return { kind: "no-listener", cause: "error", ...(error ? { error: error.message } : {}) };
		};
		const settle = (value: ControlSocketProbe) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => settle({ kind: "unresponsive" }), timeoutMs);
		const socket = createConnection(socketPath);
		const decoder = new ControlLineDecoder();
		socket.on("error", (error) => {
			lastError = error instanceof Error ? error : new Error(String(error));
			settle(connected ? { kind: "unresponsive", error: lastError.message } : classifyNoListener(lastError));
		});
		socket.on("close", () => {
			settle(
				connected
					? { kind: "unresponsive", ...(lastError ? { error: lastError.message } : {}) }
					: classifyNoListener(lastError),
			);
		});
		socket.on("connect", () => {
			connected = true;
			const hello: HelloMessage = {
				type: "hello",
				role: "control",
				protocolVersion: PROTOCOL_VERSION,
				pid: process.pid,
				version: options.version,
				client: "cli",
				...(options.authToken === undefined ? {} : { controlToken: options.authToken }),
			};
			socket.write(encodeControlLine(hello));
			socket.write(encodeControlLine({ type: "status", id: "probe" }));
		});
		socket.on("data", (chunk) => {
			let messages: unknown[];
			try {
				messages = decoder.push(chunk);
			} catch (error) {
				settle({ kind: "unresponsive", error: error instanceof Error ? error.message : String(error) });
				return;
			}
			for (const message of messages) {
				if (isControlStatusProbe(message)) {
					settle({ kind: "healthy", status: message });
					return;
				}
				if (isHelloAck(message) && !message.ok) {
					settle({
						kind: "live-rejected",
						reason: message.error ?? "other",
						...(message.error === undefined ? {} : { error: message.error }),
						...(message.version === undefined ? {} : { version: message.version }),
						...(message.protocolVersion === undefined ? {} : { protocolVersion: message.protocolVersion }),
					});
					return;
				}
				if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === "fatal") {
					const error = (message as { error?: unknown }).error;
					settle({ kind: "live-rejected", reason: "fatal", ...(typeof error === "string" ? { error } : {}) });
					return;
				}
			}
		});
	});
}

function isControlStatusProbe(value: unknown): value is ControlStatusProbe {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "status_result";
}

export { CONTROL_MAX_LINE_BYTES };
