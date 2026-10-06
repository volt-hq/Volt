import { chmodSync, lstatSync, rmSync, type Stats } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
	admitControlRequest,
	CONTROL_MAX_LINE_BYTES,
	type ControlClientKind,
	type ControlEvent,
	ControlLineDecoder,
	type ControlRequest,
	type ControlResponse,
	ControlValidators,
	createDaemonProof,
	createHelloChallenge,
	createHelloProof,
	daemonProofMatches,
	encodeControlLine,
	type HelloAck,
	type HelloBinding,
	type HelloMessage,
	type HelloProof,
	helloProofMatches,
	isRequestAllowedFor,
	PROTOCOL_VERSION,
} from "./control-protocol.ts";

export interface ControlConnection {
	readonly connectionId: string;
	/** A TUI or CLI control client, or a conversation worker the daemon spawned. */
	readonly client: ControlClientKind | "worker";
	/** The worker a worker connection was admitted for. */
	readonly workerId?: string;
	readonly pid: number;
	readonly version: string;
	/** Capabilities from the control hello (empty for old clients). */
	readonly capabilities: ReadonlySet<string>;
	send(message: ControlResponse | ControlEvent): void;
	close(): void;
}

export interface RelayAdmission {
	/**
	 * Validate a relay hello by its proof of the offer's token on this
	 * connection (`binding`); on success the relay takes the raw socket and
	 * writes the ack, with its own proof.
	 */
	admitRelay(
		hello: Extract<HelloMessage, { role: "relay" }>,
		binding: HelloBinding,
		socket: Socket,
		bufferedRemainder: Buffer,
	): boolean;
}

export interface WorkerAdmission {
	/**
	 * Admit a worker hello on `connection`: it must prove the unused token its
	 * spawn issued, on this connection (`binding`). One worker per connection;
	 * a refused hello closes it. Returns the daemon's proof of the token for
	 * the ack, or undefined when the hello is refused.
	 */
	admitWorker(
		hello: Extract<HelloMessage, { role: "worker" }>,
		binding: HelloBinding,
		connection: ControlConnection,
	): string | undefined;
}

export interface ControlServerHandlers {
	/**
	 * Handle one request; respond via connection.send (possibly multiple times
	 * for provisional responses). Thrown errors become error responses.
	 */
	onRequest(connection: ControlConnection, request: ControlRequest): Promise<void> | void;
	onConnectionClosed?(connection: ControlConnection): void;
	relayAdmission?: RelayAdmission;
	workerAdmission?: WorkerAdmission;
	/** When true, hellos are rejected with error "shutting_down". */
	isShuttingDown?(): boolean;
	log?(level: "info" | "warn" | "error", message: string): void;
}

export interface ControlServerOptions {
	socketPath: string;
	version: string;
	/**
	 * Optional local control-plane token published in the daemon pidfile. A
	 * control hello proves it holds the token without sending it, and the
	 * daemon's ack proves the same back: a client trusts no other endpoint.
	 */
	authToken?: string;
	handlers: ControlServerHandlers;
}

export interface ControlServer {
	readonly socketPath: string;
	connections(): ControlConnection[];
	/** Send `event` to every control client; workers only get the events addressed to them. */
	broadcast(event: ControlEvent): void;
	sendTo(connectionId: string, event: ControlEvent): boolean;
	/**
	 * Atomically stop admitting control requests and drain every request admitted
	 * before that cut. Established sockets stay open for shutdown events, and new
	 * hellos are rejected as shutting down until close() retires the listener.
	 */
	quiesce(): Promise<void>;
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

const connectionResources = new WeakMap<ControlConnection, { closed: boolean; releases: Set<() => void> }>();

/** Transfer a synchronous resource release to this exact connection, including late completions. */
export function retainControlConnectionResource(connection: ControlConnection, release: () => void): void {
	const resources = connectionResources.get(connection);
	if (!resources || resources.closed) {
		release();
		throw new Error("Control connection closed before resource publication");
	}
	resources.releases.add(release);
}

let controlConnectionSequence = 0;

export async function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
	const { socketPath, version, authToken, handlers } = options;
	const connections = new Map<string, ControlConnectionImpl>();
	const pendingSockets = new Set<Socket>();
	const admittedRequests = new Set<Promise<void>>();
	let acceptingRequests = true;
	let requestDrainPromise: Promise<void> | undefined;
	let closing = false;
	let closePromise: Promise<void> | undefined;

	const drainAdmittedRequests = (): Promise<void> => {
		acceptingRequests = false;
		requestDrainPromise ??= (async () => {
			while (admittedRequests.size > 0) {
				await Promise.all(Array.from(admittedRequests));
			}
		})();
		return requestDrainPromise;
	};

	class ControlConnectionImpl implements ControlConnection {
		readonly connectionId: string;
		readonly client: ControlClientKind | "worker";
		readonly workerId: string | undefined;
		readonly pid: number;
		readonly version: string;
		readonly capabilities: ReadonlySet<string>;
		private readonly socket: Socket;

		constructor(socket: Socket, hello: Extract<HelloMessage, { role: "control" | "worker" }>) {
			this.connectionId = `c-${++controlConnectionSequence}`;
			this.client = hello.role === "worker" ? "worker" : hello.client;
			this.workerId = hello.role === "worker" ? hello.workerId : undefined;
			this.pid = hello.pid;
			this.version = hello.version;
			this.capabilities = new Set(hello.role === "control" ? (hello.capabilities ?? []) : []);
			this.socket = socket;
			connectionResources.set(this, { closed: false, releases: new Set() });
		}

		send(message: ControlResponse | ControlEvent): void {
			if (this.socket.destroyed) return;
			let line = encodeControlLine(message);
			// A line the peer cannot read would end its connection: a response says it is too large instead.
			if (line.byteLength - 1 > CONTROL_MAX_LINE_BYTES) {
				if (!("id" in message)) return;
				line = encodeControlLine({
					type: "error",
					id: message.id,
					code: "too_large",
					message: "The response exceeds the control line limit",
				});
			}
			this.socket.write(line);
		}

		close(): void {
			this.socket.destroy();
		}
	}

	const server: Server = createServer((socket) => {
		if (closing) {
			// server.close() can race a connection event that was already queued.
			// Such a socket never enters a handshake or escapes control-server ownership.
			socket.destroy();
			return;
		}
		pendingSockets.add(socket);
		// Every proof on this connection covers this challenge and the daemon's socket path: a proof made for
		// another connection, or for whatever else holds a socket name a client dialed, is refused here.
		const binding: HelloBinding = { challenge: createHelloChallenge(), socketPath };
		socket.write(encodeControlLine({ type: "hello_challenge", nonce: binding.challenge }));
		const decoder = new ControlLineDecoder();
		let established: ControlConnectionImpl | undefined;
		let handedOffToRelay = false;
		/** A hello was refused: nothing more is read from the socket. */
		let refused = false;

		const fatal = (error: string) => {
			try {
				socket.write(encodeControlLine({ type: "fatal", error }));
			} catch {
				// best-effort
			}
			socket.destroy();
		};

		const handleHello = (hello: unknown): boolean => {
			if (!ControlValidators.hello.Check(hello)) {
				fatal("invalid_hello");
				return false;
			}
			// A control hello that proved the pidfile token gets the daemon's proof on every answer, refusals
			// included, so its client can tell this daemon from whatever else holds the socket's name.
			const daemonProof =
				hello.role === "control" &&
				authToken !== undefined &&
				hello.controlProof !== undefined &&
				helloProofMatches("control", authToken, binding, hello.controlProof)
					? createDaemonProof("control", authToken, binding, hello.controlProof)
					: undefined;
			const refuse = (error: "shutting_down" | "protocol_mismatch" | "auth_failed"): false => {
				const ack: HelloAck = {
					type: "hello_ack",
					ok: false,
					error,
					version,
					protocolVersion: PROTOCOL_VERSION,
					...(daemonProof === undefined ? {} : { daemonProof }),
				};
				socket.end(encodeControlLine(ack));
				return false;
			};
			if (!acceptingRequests || handlers.isShuttingDown?.()) return refuse("shutting_down");
			if (hello.protocolVersion !== PROTOCOL_VERSION) return refuse("protocol_mismatch");
			if (hello.role === "control" && authToken !== undefined && daemonProof === undefined) {
				return refuse("auth_failed");
			}
			if (hello.role === "relay") {
				const remainder = decoder.drainRemainder();
				socket.removeListener("data", onData);
				handedOffToRelay = true;
				let admitted = false;
				try {
					admitted = handlers.relayAdmission?.admitRelay(hello, binding, socket, remainder) ?? false;
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
				if (admitted) {
					// The relay lifecycle is now the socket's exact owner. It must not
					// be destroyed by control-server shutdown independently.
					pendingSockets.delete(socket);
				}
				if (!admitted) {
					const ack: HelloAck = { type: "hello_ack", ok: false, error: "bad_relay_token" };
					socket.end(encodeControlLine(ack));
				}
				return false;
			}
			const connection = new ControlConnectionImpl(socket, hello);
			const workerProof =
				hello.role === "worker" ? handlers.workerAdmission?.admitWorker(hello, binding, connection) : undefined;
			if (hello.role === "worker" && workerProof === undefined) return refuse("auth_failed");
			established = connection;
			pendingSockets.delete(socket);
			connections.set(established.connectionId, established);
			const ackProof = workerProof ?? daemonProof;
			const ack: HelloAck = {
				type: "hello_ack",
				ok: true,
				connectionId: established.connectionId,
				version,
				protocolVersion: PROTOCOL_VERSION,
				...(ackProof === undefined ? {} : { daemonProof: ackProof }),
			};
			socket.write(encodeControlLine(ack));
			return true;
		};

		const handleMessage = (message: unknown): void => {
			const connection = established;
			if (!connection) {
				// One hello per connection: a refused one ends it.
				if (!refused && !handleHello(message) && !handedOffToRelay) refused = true;
				return;
			}
			if (!admitControlRequest(message)) {
				const id =
					typeof message === "object" && message !== null && typeof (message as { id?: unknown }).id === "string"
						? ((message as { id: string }).id ?? "")
						: "";
				connection.send({ type: "error", id, code: "invalid_request", message: "unrecognized control request" });
				return;
			}
			// A worker sends worker requests only, and nothing else may.
			if (!isRequestAllowedFor(connection.client, message.type)) {
				connection.send({
					type: "error",
					id: message.id,
					code: "forbidden",
					message: `${message.type} is not available on this connection`,
				});
				return;
			}
			if (!acceptingRequests || handlers.isShuttingDown?.()) {
				connection.send({
					type: "error",
					id: message.id,
					code: "shutting_down",
					message: "daemon is shutting down",
				});
				return;
			}

			// Register the request before invoking its handler. A shutdown request can
			// synchronously close admission from inside onRequest, so registering after
			// invocation would let the durable shutdown cut overtake its own handler.
			let settleRequest: () => void = () => {};
			const admittedRequest = new Promise<void>((resolve) => {
				settleRequest = resolve;
			});
			admittedRequests.add(admittedRequest);
			void admittedRequest.then(() => admittedRequests.delete(admittedRequest));
			const rejectRequest = (error: unknown): void => {
				connection.send({
					type: "error",
					id: message.id,
					code: "internal_error",
					message: error instanceof Error ? error.message : String(error),
				});
			};
			try {
				void Promise.resolve(handlers.onRequest(connection, message)).then(settleRequest, (error) => {
					rejectRequest(error);
					settleRequest();
				});
			} catch (error) {
				rejectRequest(error);
				settleRequest();
			}
		};

		const onData = (chunk: Buffer) => {
			try {
				// One line at a time: a relay hello hands the socket off mid-chunk and
				// any trailing bytes must stay undecoded (they are raw relay payload).
				decoder.pushEach(chunk, (message) => {
					handleMessage(message);
					return handedOffToRelay || refused ? "stop" : "continue";
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
			pendingSockets.delete(socket);
			if (established) {
				connections.delete(established.connectionId);
				const resources = connectionResources.get(established)!;
				resources.closed = true;
				for (const release of resources.releases) release();
				resources.releases.clear();
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
				if (connection.client !== "worker") connection.send(event);
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
		quiesce() {
			return drainAdmittedRequests();
		},
		async close() {
			closePromise ??= (() => {
				const requestDrain = drainAdmittedRequests();
				closing = true;
				for (const socket of pendingSockets) {
					socket.destroy();
				}
				const serverClosed = new Promise<void>((resolve) => {
					server.close(() => resolve());
				});
				return (async () => {
					// Leave established sockets alive until admitted handlers settle so their
					// terminal responses (including shutdown's ok) can still be delivered.
					await requestDrain;
					for (const connection of connections.values()) {
						connection.close();
					}
					await serverClosed;
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
				})();
			})();
			await closePromise;
		},
	};
}

/**
 * Probe an existing socket with a status request. The result distinguishes a
 * provably dead/stale path from a live daemon that answered but rejected us;
 * callers must only unlink a socket after a no-listener result. With
 * `authToken`, only an endpoint that proves it holds the token reads as
 * healthy or as refusing; any other answer is unresponsive.
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
		const token = options.authToken;
		/** The connection's binding and the hello's proof, once the daemon's challenge arrived. */
		let greeted: { readonly binding: HelloBinding; readonly proof: HelloProof | undefined } | undefined;
		/** Whether an answer comes from the daemon the token names; without a token there is nothing to prove. */
		const proven = (daemonProof: string | undefined): boolean =>
			token === undefined ||
			(greeted?.proof !== undefined &&
				daemonProofMatches("control", token, greeted.binding, greeted.proof, daemonProof));
		/** An endpoint that cannot prove the token (a stale name someone else took) is never healthy, nor its refusals believed. */
		const unproven: ControlSocketProbe = {
			kind: "unresponsive",
			error: "the endpoint did not prove it holds the daemon's token",
		};
		let acked = false;
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
				// The daemon speaks first: its challenge, which the hello's proof covers.
				if (greeted === undefined) {
					if (!ControlValidators.helloChallenge.Check(message)) {
						settle(token === undefined ? { kind: "unresponsive", error: "no daemon greeting" } : unproven);
						return;
					}
					const binding: HelloBinding = { challenge: message.nonce, socketPath };
					greeted = {
						binding,
						proof: token === undefined ? undefined : createHelloProof("control", token, binding),
					};
					const hello: HelloMessage = {
						type: "hello",
						role: "control",
						protocolVersion: PROTOCOL_VERSION,
						pid: process.pid,
						version: options.version,
						client: "cli",
						...(greeted.proof === undefined ? {} : { controlProof: greeted.proof }),
					};
					socket.write(encodeControlLine(hello));
					socket.write(encodeControlLine({ type: "status", id: "probe" }));
					continue;
				}
				if (ControlValidators.helloAck.Check(message)) {
					if (!proven(message.daemonProof)) {
						settle(unproven);
						return;
					}
					if (message.ok) {
						acked = true;
						continue;
					}
					const error = message.error;
					settle({
						kind: "live-rejected",
						reason:
							error !== undefined && KNOWN_HELLO_REJECTIONS.has(error) ? (error as HelloRejection) : "other",
						...(error === undefined ? {} : { error }),
						...(message.version === undefined ? {} : { version: message.version }),
						...(message.protocolVersion === undefined ? {} : { protocolVersion: message.protocolVersion }),
					});
					return;
				}
				if (isControlStatusProbe(message)) {
					settle(acked ? { kind: "healthy", status: message } : unproven);
					return;
				}
				if (ControlValidators.fatal.Check(message)) {
					settle(
						token === undefined ? { kind: "live-rejected", reason: "fatal", error: message.error } : unproven,
					);
					return;
				}
			}
		});
	});
}

type HelloRejection = Extract<ControlSocketProbe, { kind: "live-rejected" }>["reason"];

/** Ack error codes this version knows; a code from another protocol version reads as "other". */
const KNOWN_HELLO_REJECTIONS: ReadonlySet<string> = new Set<HelloRejection>([
	"shutting_down",
	"protocol_mismatch",
	"bad_relay_token",
	"auth_failed",
]);

function isControlStatusProbe(value: unknown): value is ControlStatusProbe {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "status_result";
}

export { CONTROL_MAX_LINE_BYTES };
