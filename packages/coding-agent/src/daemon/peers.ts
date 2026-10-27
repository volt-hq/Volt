/**
 * Peer agents (experimental). This daemon pairs with another host as its
 * client, from a pairing ticket that host issued (`volt remote pair`), and
 * saves it as a named peer (`volt remote peer add`). A conversation worker's
 * `peer` tool then delegates a task to the peer: the daemon opens a new
 * conversation in the peer's workspace on the peer host, sends the task as its
 * first prompt, and answers with the peer agent's last reply once that
 * conversation is idle again. The peer host runs the task with its own model,
 * credentials, and tools, under the access it paired this daemon with, and
 * keeps the conversation in its own session list.
 *
 * Peers are dialed from a client-only Iroh endpoint of the daemon's own with
 * relays disabled: they reach each other over the local network only. The
 * endpoint's identity (the node ID peer hosts know this daemon by) and the
 * saved peers live in `peers.json` (0600) in the daemon directory.
 */

import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { PEER_NAME_PATTERN_SOURCE } from "@hansjm10/volt-protocol/daemon-control";
import { ProtocolClient } from "../client/protocol-client.ts";
import {
	createIrohRpcTransport,
	type IrohBiStreamLike,
	type IrohBytes,
} from "../core/protocol/transport/iroh-transport.ts";
import {
	assertIrohRemoteHandshakeHostIdentity,
	type IrohRemoteHandshakeSuccess,
	type IrohRemoteHello,
	parseIrohRemoteHandshakeResponseLine,
} from "../core/remote/iroh/handshake.ts";
import { readIrohRemoteHandshakeLine, writeIrohRemoteHello } from "../core/remote/iroh/handshake-reader.ts";
import { IROH_REMOTE_ALPN } from "../core/remote/iroh/protocol.ts";
import { assertIrohRemoteTicketNotExpired, decodeIrohRemoteTicketPayload } from "../core/remote/iroh/ticket.ts";
import type { ControlPeerStatus, ControlRequest } from "./control-protocol.ts";
import type { ControlConnection } from "./control-server.ts";
import {
	formatIrohLoadError,
	type IrohBoundEndpointLike,
	type IrohEndpointAddrLike,
	type IrohModuleLike,
	loadIrohModule,
} from "./iroh-native.ts";
import type { VoltdRuntimeServices, VoltdServiceExtension, VoltdServiceExtensionInstance } from "./main.ts";

const PEER_STORE_FILE = "peers.json";
const ALPN = Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"));
const CLOSE_REASON = Array.from(Buffer.from("done", "utf8"));
const PEER_NAME_PATTERN = new RegExp(PEER_NAME_PATTERN_SOURCE);
const PEER_CONNECT_TIMEOUT_MS = 15_000;
const PEER_HANDSHAKE_TIMEOUT_MS = 30_000;
/** How long the peer host may take to answer one intent or query of a run. */
const PEER_REQUEST_TIMEOUT_MS = 60_000;
/** The longest a run waits for the peer's conversation to go idle; past it the run stops the peer's turn and fails. */
const PEER_RUN_TIMEOUT_MS = 60 * 60_000;
/** The longest a cancelled run waits for the peer host to accept its `abort`. */
const PEER_ABORT_TIMEOUT_MS = 2_000;

/** A saved peer: a workspace on another host, and how to reach that host. */
interface PeerRecord {
	readonly name: string;
	readonly hostNodeId: string;
	/** The native endpoint ticket from the peer's pairing ticket: its node ID and direct addresses. */
	readonly irohTicket: string;
	readonly workspace: string;
	readonly addedAtMs: number;
}

interface PeerStoreFile {
	readonly version: 1;
	/** The secret key of the endpoint peers are dialed from, base64; minted when it first binds. */
	readonly secretKey?: string;
	readonly peers: readonly PeerRecord[];
}

/** A peer operation's failure, with the control error code it answers with. */
export class PeerError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "PeerError";
		this.code = code;
	}
}

/** What a run answers with: the peer conversation it opened, and the peer agent's last reply there. */
export interface PeerRunResult {
	readonly sessionId: string;
	readonly text: string;
	readonly truncated: boolean;
	readonly stopReason?: string;
}

interface PeerConnectionLike {
	openBi(): Promise<IrohBiStreamLike>;
	close(errorCode: bigint, reason: number[]): void;
}

/** A bound endpoint that dials: the part of the native endpoint a peer client uses beyond the daemon's typings. */
interface PeerEndpointLike extends IrohBoundEndpointLike {
	connect(addr: IrohEndpointAddrLike, alpn: number[]): Promise<PeerConnectionLike>;
}

interface PeerEndpointTicketsLike {
	fromString(ticket: string): { endpointAddr(): IrohEndpointAddrLike };
}

function canDial(endpoint: IrohBoundEndpointLike): endpoint is PeerEndpointLike {
	return "connect" in endpoint && typeof endpoint.connect === "function";
}

function readsTickets(tickets: unknown): tickets is PeerEndpointTicketsLike {
	return (
		(typeof tickets === "object" || typeof tickets === "function") &&
		tickets !== null &&
		"fromString" in tickets &&
		typeof tickets.fromString === "function"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePeerRecord(value: unknown): PeerRecord {
	if (
		!isRecord(value) ||
		typeof value.name !== "string" ||
		!PEER_NAME_PATTERN.test(value.name) ||
		typeof value.hostNodeId !== "string" ||
		typeof value.irohTicket !== "string" ||
		typeof value.workspace !== "string" ||
		typeof value.addedAtMs !== "number"
	) {
		throw new Error("invalid peer record");
	}
	return {
		name: value.name,
		hostNodeId: value.hostNodeId,
		irohTicket: value.irohTicket,
		workspace: value.workspace,
		addedAtMs: value.addedAtMs,
	};
}

function parsePeerStoreFile(value: unknown): PeerStoreFile {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.peers)) {
		throw new Error("unsupported peer store");
	}
	if (value.secretKey !== undefined && typeof value.secretKey !== "string") {
		throw new Error("invalid peer identity");
	}
	return {
		version: 1,
		...(value.secretKey === undefined ? {} : { secretKey: value.secretKey }),
		peers: value.peers.map(parsePeerRecord),
	};
}

/** `peers.json`: read once, then changed one mutation at a time and replaced atomically. */
class PeerStore {
	private readonly path: string;
	private current: PeerStoreFile | undefined;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.path = path;
	}

	async read(): Promise<PeerStoreFile> {
		await this.tail.catch(() => undefined);
		return this.load();
	}

	/** Apply `update` to the current file and persist what it returns, after the mutations before it. */
	mutate<T>(update: (current: PeerStoreFile) => { readonly next: PeerStoreFile; readonly result: T }): Promise<T> {
		const run = this.tail
			.catch(() => undefined)
			.then(async () => {
				const { next, result } = update(await this.load());
				if (next !== this.current) {
					await this.write(next);
					this.current = next;
				}
				return result;
			});
		this.tail = run;
		return run;
	}

	private async load(): Promise<PeerStoreFile> {
		if (this.current !== undefined) return this.current;
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				this.current = { version: 1, peers: [] };
				return this.current;
			}
			throw error;
		}
		try {
			this.current = parsePeerStoreFile(JSON.parse(text));
		} catch (error) {
			throw new PeerError("peer_store_invalid", `Cannot read ${this.path}: ${errorMessage(error)}`);
		}
		return this.current;
	}

	private async write(file: PeerStoreFile): Promise<void> {
		const tempPath = join(
			dirname(this.path),
			`.${PEER_STORE_FILE}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`,
		);
		try {
			await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			await rename(tempPath, this.path);
		} catch (error) {
			await rm(tempPath, { force: true });
			throw error;
		}
		// Best effort: Windows ignores POSIX mode bits.
		await chmod(this.path, 0o600).catch(() => undefined);
	}
}

function toStatus(peer: PeerRecord): ControlPeerStatus {
	return { name: peer.name, hostNodeId: peer.hostNodeId, workspace: peer.workspace, addedAtMs: peer.addedAtMs };
}

/** A conversation or discovery stream to a peer host, after its handshake succeeded. */
interface OpenedPeerStream {
	readonly response: IrohRemoteHandshakeSuccess;
	readonly stream: IrohBiStreamLike;
	/** Bytes the host wrote after its handshake line: the stream's first frames. */
	readonly rest: IrohBytes;
	close(): void;
}

/** The last assistant reply among `entries`, newest first. */
function lastReply(client: ProtocolClient): Omit<PeerRunResult, "sessionId"> {
	const entries = client.state.entries;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.view?.role !== "assistant") continue;
		return {
			text: entry.view.text,
			truncated: entry.view.truncated,
			...(entry.view.stopReason === undefined ? {} : { stopReason: entry.view.stopReason }),
		};
	}
	return { text: "", truncated: false };
}

/** Ask the peer host to stop the conversation's turn, without waiting long for it to accept. */
async function stopPeerTurn(client: ProtocolClient): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			client.intent("abort", {}, { expectedOrdinal: client.state.ordinal }).catch(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, PEER_ABORT_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Wait until the peer's conversation is idle; stop its turn when `signal` aborts or the wait times out. */
async function untilIdle(client: ProtocolClient, signal: AbortSignal): Promise<void> {
	const idle = client.waitForIdle(PEER_RUN_TIMEOUT_MS);
	void idle.catch(() => undefined);
	const aborted = Promise.withResolvers<"aborted">();
	const onAbort = () => aborted.resolve("aborted");
	if (signal.aborted) onAbort();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const outcome = await Promise.race([idle.then(() => "idle" as const), aborted.promise]);
		if (outcome === "aborted") {
			await stopPeerTurn(client);
			throw new PeerError("cancelled", "The peer run was cancelled");
		}
	} catch (error) {
		if (error instanceof PeerError) throw error;
		await stopPeerTurn(client);
		throw new PeerError("peer_failed", errorMessage(error));
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Dial `address`, closing a connection that arrives after the timeout. */
async function connectWithTimeout(
	endpoint: PeerEndpointLike,
	address: IrohEndpointAddrLike,
): Promise<PeerConnectionLike> {
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const connecting = endpoint.connect(address, ALPN);
	try {
		return await Promise.race([
			connecting,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					timedOut = true;
					reject(new Error(`no answer within ${PEER_CONNECT_TIMEOUT_MS / 1000} s`));
				}, PEER_CONNECT_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
		if (timedOut) {
			void connecting.then(
				(late) => late.close(0n, CLOSE_REASON),
				() => undefined,
			);
		}
	}
}

interface PeerRun {
	readonly connectionId: string;
	readonly controller: AbortController;
}

class PeerDaemonService implements VoltdServiceExtensionInstance {
	private readonly log: ReturnType<VoltdRuntimeServices["logger"]["child"]>;
	private readonly store: PeerStore;
	private readonly runs = new Map<string, PeerRun>();
	private iroh: IrohModuleLike | undefined;
	private endpoint: Promise<PeerEndpointLike> | undefined;
	private closed = false;

	constructor(services: VoltdRuntimeServices) {
		this.log = services.logger.child("peers");
		this.store = new PeerStore(join(services.paths.daemonDir, PEER_STORE_FILE));
	}

	async handleRequest(connection: ControlConnection, request: ControlRequest): Promise<boolean> {
		switch (request.type) {
			case "peers_list":
			case "worker_peers_list":
				try {
					const { peers } = await this.store.read();
					connection.send({ type: "peers_result", id: request.id, peers: peers.map(toStatus) });
				} catch (error) {
					this.fail(connection, request.id, error);
				}
				return true;
			case "peer_add":
				try {
					const peer = await this.add(request.name, request.ticket);
					connection.send({ type: "peer_result", id: request.id, peer: toStatus(peer) });
				} catch (error) {
					this.fail(connection, request.id, error);
				}
				return true;
			case "peer_remove":
				try {
					await this.remove(request.name);
					connection.send({ type: "ok", id: request.id });
				} catch (error) {
					this.fail(connection, request.id, error);
				}
				return true;
			case "worker_peer_run":
				await this.run(connection, request);
				return true;
			case "worker_peer_cancel": {
				const run = this.runs.get(request.runId);
				if (run?.connectionId === connection.connectionId) run.controller.abort();
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			default:
				return false;
		}
	}

	onConnectionClosed(connection: ControlConnection): void {
		for (const run of this.runs.values()) {
			if (run.connectionId === connection.connectionId) run.controller.abort();
		}
	}

	async quiesce(): Promise<void> {
		this.closed = true;
		for (const run of this.runs.values()) run.controller.abort();
	}

	async dispose(): Promise<void> {
		const endpoint = this.endpoint;
		this.endpoint = undefined;
		await endpoint?.then((bound) => bound.close()).catch(() => undefined);
	}

	private fail(connection: ControlConnection, id: string, error: unknown): void {
		const code = error instanceof PeerError ? error.code : "peer_failed";
		connection.send({ type: "error", id, code, message: errorMessage(error) });
	}

	private requireIroh(): IrohModuleLike {
		if (this.iroh) return this.iroh;
		const loaded = loadIrohModule();
		if (!loaded.iroh) throw new PeerError("iroh_unavailable", formatIrohLoadError(loaded.error));
		this.iroh = loaded.iroh;
		return loaded.iroh;
	}

	private endpointAddress(irohTicket: string): IrohEndpointAddrLike {
		const tickets: unknown = this.requireIroh().EndpointTicket;
		if (!readsTickets(tickets)) {
			throw new PeerError("iroh_unavailable", "The installed Iroh binding cannot read endpoint tickets");
		}
		try {
			return tickets.fromString(irohTicket).endpointAddr();
		} catch (error) {
			throw new PeerError("invalid_ticket", `The ticket's endpoint is unreadable: ${errorMessage(error)}`);
		}
	}

	/** The endpoint peers are dialed from, bound on first use with the saved identity (minted then saved the first time). */
	private bindEndpoint(): Promise<PeerEndpointLike> {
		if (this.endpoint) return this.endpoint;
		const binding = (async () => {
			const iroh = this.requireIroh();
			const { secretKey } = await this.store.read();
			const builder = iroh.Endpoint.builder();
			iroh.presetMinimal(builder);
			builder.relayMode(iroh.RelayMode.disabled());
			if (secretKey !== undefined) builder.secretKey(Array.from(Buffer.from(secretKey, "base64")));
			const endpoint = await builder.bind();
			if (!canDial(endpoint)) {
				await endpoint.close().catch(() => undefined);
				throw new PeerError("iroh_unavailable", "The installed Iroh binding cannot dial peers");
			}
			if (secretKey === undefined) {
				const minted = Buffer.from(endpoint.secretKey().toBytes()).toString("base64");
				await this.store.mutate((current) => ({
					next: current.secretKey === undefined ? { ...current, secretKey: minted } : current,
					result: undefined,
				}));
			}
			this.log("info", "peer endpoint bound", { nodeId: endpoint.id().toString() });
			return endpoint;
		})();
		this.endpoint = binding;
		binding.catch(() => {
			if (this.endpoint === binding) this.endpoint = undefined;
		});
		return binding;
	}

	/** Dial the host at `address`, write `hello`, and read a successful handshake from the host `hostNodeId`. */
	private async open(
		address: IrohEndpointAddrLike,
		hostNodeId: string,
		hello: IrohRemoteHello,
	): Promise<OpenedPeerStream> {
		const endpoint = await this.bindEndpoint();
		let connection: PeerConnectionLike;
		try {
			connection = await connectWithTimeout(endpoint, address);
		} catch (error) {
			throw new PeerError("peer_unreachable", `Could not reach the peer host: ${errorMessage(error)}`);
		}
		const close = () => {
			try {
				connection.close(0n, CLOSE_REASON);
			} catch {
				// Already closed.
			}
		};
		try {
			const stream = await connection.openBi();
			await writeIrohRemoteHello(stream.send, hello);
			const read = await readIrohRemoteHandshakeLine(stream.recv, { timeoutMs: PEER_HANDSHAKE_TIMEOUT_MS });
			if (read.line === undefined) {
				throw new PeerError("peer_handshake_failed", "The peer host closed the stream before its handshake");
			}
			const response = parseIrohRemoteHandshakeResponseLine(read.line);
			assertIrohRemoteHandshakeHostIdentity(response, hostNodeId);
			if (!response.success) {
				throw new PeerError(response.outcome ?? "peer_refused", `The peer host refused: ${response.error}`);
			}
			return { response, stream, rest: read.rest, close };
		} catch (error) {
			close();
			throw error instanceof PeerError ? error : new PeerError("peer_handshake_failed", errorMessage(error));
		}
	}

	private hello(workspace: string): Pick<IrohRemoteHello, "type" | "protocol" | "workspace" | "clientLabel"> {
		return {
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace,
			clientLabel: `peer:${hostname()}`,
		};
	}

	/** Pair with the host that issued `ticket` and save it as the peer `name`. */
	private async add(name: string, ticket: string): Promise<PeerRecord> {
		if (this.closed) throw new PeerError("shutting_down", "The daemon is shutting down");
		let payload: ReturnType<typeof decodeIrohRemoteTicketPayload>;
		try {
			payload = decodeIrohRemoteTicketPayload(ticket);
		} catch (error) {
			throw new PeerError("invalid_ticket", `Not a Volt pairing ticket: ${errorMessage(error)}`);
		}
		try {
			assertIrohRemoteTicketNotExpired(payload);
		} catch (error) {
			throw new PeerError("ticket_expired", errorMessage(error));
		}
		if (payload.secret === undefined) {
			throw new PeerError(
				"invalid_ticket",
				"Not a pairing ticket: create one on the peer host with `volt remote pair`",
			);
		}
		if ((await this.store.read()).peers.some((peer) => peer.name === name)) {
			throw new PeerError("peer_exists", `A peer named ${name} exists; remove it first`);
		}
		const address = this.endpointAddress(payload.irohTicket);
		const hostNodeId = payload.nodeId ?? address.id().toString();
		const opened = await this.open(address, hostNodeId, {
			...this.hello(payload.workspace),
			secret: payload.secret,
			mode: "workspaceDiscovery",
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		opened.close();
		const peer: PeerRecord = {
			name,
			hostNodeId,
			irohTicket: payload.irohTicket,
			workspace: opened.response.workspace,
			addedAtMs: Date.now(),
		};
		await this.store.mutate((current) => {
			if (current.peers.some((saved) => saved.name === name)) {
				throw new PeerError("peer_exists", `A peer named ${name} exists; remove it first`);
			}
			return { next: { ...current, peers: [...current.peers, peer] }, result: undefined };
		});
		this.log("info", "peer added", { name, hostNodeId, workspace: peer.workspace });
		return peer;
	}

	private async remove(name: string): Promise<void> {
		await this.store.mutate((current) => {
			if (!current.peers.some((peer) => peer.name === name)) {
				throw new PeerError("not_found", `No peer named ${name}`);
			}
			return { next: { ...current, peers: current.peers.filter((peer) => peer.name !== name) }, result: undefined };
		});
		this.log("info", "peer removed", { name });
	}

	private async run(
		connection: ControlConnection,
		request: Extract<ControlRequest, { type: "worker_peer_run" }>,
	): Promise<void> {
		if (this.runs.has(request.runId)) {
			this.fail(connection, request.id, new PeerError("run_exists", `A peer run ${request.runId} is running`));
			return;
		}
		const controller = new AbortController();
		this.runs.set(request.runId, { connectionId: connection.connectionId, controller });
		try {
			const result = await this.delegate(request.peer, request.task, controller.signal);
			connection.send({ type: "peer_run_result", id: request.id, ...result });
		} catch (error) {
			this.fail(connection, request.id, error);
		} finally {
			this.runs.delete(request.runId);
		}
	}

	/** Run `task` in a new conversation in the workspace of peer `name`, and answer with its last reply. */
	private async delegate(name: string, task: string, signal: AbortSignal): Promise<PeerRunResult> {
		if (this.closed) throw new PeerError("shutting_down", "The daemon is shutting down");
		const { peers } = await this.store.read();
		const peer = peers.find((saved) => saved.name === name);
		if (!peer) {
			const known =
				peers.length === 0 ? "none are paired" : `paired: ${peers.map((saved) => saved.name).join(", ")}`;
			throw new PeerError("peer_unknown", `No peer named ${name} (${known})`);
		}
		const sessionId = randomUUID();
		const opened = await this.open(this.endpointAddress(peer.irohTicket), peer.hostNodeId, {
			...this.hello(peer.workspace),
			mode: "conversation",
			conversation: { target: "new", sessionId },
		});
		const client = new ProtocolClient({ name: "volt-peer", requestTimeoutMs: PEER_REQUEST_TIMEOUT_MS });
		try {
			if (signal.aborted) throw new PeerError("cancelled", "The peer run was cancelled");
			await client.connect(createIrohRpcTransport({ stream: opened.stream, initialInput: opened.rest }));
			// The remote profile fences input to the client's position in the conversation.
			await client.intent(
				"prompt",
				{ message: task },
				{ intentId: randomUUID(), expectedOrdinal: client.state.ordinal },
			);
			this.log("info", "peer run started", { peer: name, sessionId });
			await untilIdle(client, signal);
			return { sessionId: opened.response.sessionId ?? sessionId, ...lastReply(client) };
		} catch (error) {
			throw error instanceof PeerError ? error : new PeerError("peer_failed", errorMessage(error));
		} finally {
			await client.stop().catch(() => undefined);
			opened.close();
		}
	}
}

/** The daemon's peer agents (experimental): saved peers, and the runs workers delegate to them. */
export function createPeerDaemonService(): VoltdServiceExtension {
	return (services) => new PeerDaemonService(services);
}
