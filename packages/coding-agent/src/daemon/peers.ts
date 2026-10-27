/**
 * Peer agents (experimental). This daemon pairs with another host as its
 * client, from a pairing ticket that host issued (`volt remote pair`), and
 * saves it as a named peer (`volt remote peer add`). A terminal
 * conversation's `peer` tool then reaches the peer host through the daemon:
 * it lists the conversations open there in every workspace the host shares,
 * reads one's recent transcript, and sends a message into one (steering it
 * while it runs, else starting a turn) or into a new conversation, optionally
 * waiting for the peer agent's reply. The peer host's agent acts on the
 * message with that conversation's own model, credentials, and tools.
 *
 * Peers are dialed from a client-only Iroh endpoint of the daemon's own with
 * relays disabled: they reach each other over the local network only. The
 * endpoint's identity (the node ID peer hosts know this daemon by) and the
 * saved peers live in `peers.json` (0600) in the daemon directory.
 */

import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { PROTOCOL_VERSION } from "@hansjm10/volt-protocol";
import { PEER_NAME_PATTERN_SOURCE } from "@hansjm10/volt-protocol/daemon-control";
import { ProtocolClient } from "../client/protocol-client.ts";
import { VERSION } from "../config.ts";
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
import type {
	ControlPeerConversation,
	ControlPeerReply,
	ControlPeerStatus,
	ControlPeerTranscriptItem,
	ControlRequest,
} from "./control-protocol.ts";
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
/** How long the peer host may take to answer one intent or query. */
const PEER_REQUEST_TIMEOUT_MS = 60_000;
/** The longest a send waits for the peer's conversation to go idle. */
const PEER_WAIT_TIMEOUT_MS = 60 * 60_000;
/** The longest a cancelled run waits for the peer host to accept its `abort`. */
const PEER_ABORT_TIMEOUT_MS = 2_000;
/** How many of each workspace's newest sessions a conversation listing looks through. */
const PEER_SESSIONS_SCANNED = 50;
/** The most code points of one transcript item a read returns. */
const PEER_TRANSCRIPT_ITEM_MAX_CODE_POINTS = 2_000;
const PEER_TRANSCRIPT_DEFAULT_LIMIT = 20;

/** A saved peer: another host, how to reach it, and the workspace new conversations open in by default. */
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

/** Who this daemon's messages say they are from. */
function senderName(): string {
	try {
		return `${userInfo().username}@${hostname()}`;
	} catch {
		return hostname();
	}
}

/** A message as the peer agent reads it: who sent it, and where its reply goes. */
function framePeerMessage(message: string, wait: boolean): string {
	const header = `[Message from ${senderName()}'s Volt agent, sent with the peer tool.${
		wait
			? " Your final reply in this turn is returned to them; answer there instead of messaging them back, which would wait on each other."
			: ""
	}]`;
	return `${header}\n\n${message}`;
}

function cutCodePoints(text: string, max: number): { readonly text: string; readonly cut: boolean } {
	const codePoints = Array.from(text);
	return codePoints.length <= max ? { text, cut: false } : { text: codePoints.slice(0, max).join(""), cut: true };
}

/** A conversation or workspace stream to a peer host, after its handshake succeeded. */
interface OpenedPeerStream {
	readonly response: IrohRemoteHandshakeSuccess;
	readonly stream: IrohBiStreamLike;
	/** Bytes the host wrote after its handshake line: the stream's first frames. */
	readonly rest: IrohBytes;
}

/** A connection to a peer host; closing it ends every stream on it. */
interface OpenedPeerConnection {
	readonly connection: PeerConnectionLike;
	close(): void;
}

/**
 * Run `query` on a workspace stream (one with no conversation): say hello,
 * wait for `welcome`, ask, and close the stream after the answer.
 */
async function queryWorkspaceStream(opened: OpenedPeerStream, query: string, params: unknown): Promise<unknown> {
	const transport = createIrohRpcTransport({ stream: opened.stream, initialInput: opened.rest });
	const queryId = randomUUID();
	const answer = Promise.withResolvers<unknown>();
	const timer = setTimeout(
		() => answer.reject(new Error(`The peer host did not answer ${query} in time`)),
		PEER_REQUEST_TIMEOUT_MS,
	);
	const write = (frame: object): void => {
		try {
			void Promise.resolve(transport.write(frame)).catch((error: unknown) => answer.reject(error));
		} catch (error) {
			answer.reject(error);
		}
	};
	transport.onLine((line) => {
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			answer.reject(new Error("The peer host sent a malformed frame"));
			return;
		}
		if (!isRecord(frame)) return;
		if (frame.type === "welcome") {
			write({ type: "query", queryId, query, params });
		} else if (frame.type === "result" && frame.queryId === queryId) {
			answer.resolve(frame.data);
		} else if (frame.type === "query_error" && frame.queryId === queryId) {
			const reason = isRecord(frame.reason) ? frame.reason : {};
			answer.reject(new Error(`${query} failed: ${String(reason.message ?? reason.code ?? "unknown")}`));
		} else if (frame.type === "fatal") {
			answer.reject(new Error(`The peer host ended the stream: ${String(frame.code ?? "fatal")}`));
		}
	});
	transport.onClose?.((error) => answer.reject(error ?? new Error("The peer host closed the stream")));
	write({
		type: "hello",
		protocol: PROTOCOL_VERSION,
		client: { name: "volt-peer", version: VERSION },
		accepts: { hostRequests: [] },
	});
	try {
		return await answer.promise;
	} finally {
		clearTimeout(timer);
		await Promise.resolve(transport.close()).catch(() => undefined);
	}
}

/** The open conversations among a `sessions` query answer, without subagents' own sessions. */
function openConversations(workspace: string, data: unknown): ControlPeerConversation[] {
	if (!isRecord(data) || !Array.isArray(data.sessions)) return [];
	const conversations: ControlPeerConversation[] = [];
	for (const session of data.sessions) {
		if (!isRecord(session) || typeof session.sessionId !== "string") continue;
		if (session.runtimeState !== "attached" && session.runtimeState !== "detached") continue;
		if (session.origin === "subagent") continue;
		const changeContext = isRecord(session.changeContext) ? session.changeContext : undefined;
		conversations.push({
			workspace,
			sessionId: session.sessionId,
			...(typeof session.sessionName === "string" ? { name: session.sessionName } : {}),
			firstMessage: typeof session.firstMessage === "string" ? session.firstMessage : "",
			modifiedAt: typeof session.modifiedAt === "string" ? session.modifiedAt : "",
			runtimeState: session.runtimeState,
			...(typeof changeContext?.branch === "string" ? { branch: changeContext.branch } : {}),
			...(typeof session.workingDirectory === "string" ? { workingDirectory: session.workingDirectory } : {}),
		});
	}
	return conversations;
}

/** The newest assistant reply after `ordinal`. */
function replyAfter(client: ProtocolClient, ordinal: number): ControlPeerReply {
	const entries = client.state.entries;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry === undefined || entry.ordinal <= ordinal) break;
		if (entry.type !== "message" || entry.view?.role !== "assistant") continue;
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

/**
 * Wait until the peer's conversation is idle. When `signal` aborts or the
 * wait fails, a conversation the run created (`ownsTurn`) has its turn
 * stopped; another conversation keeps running, and only the wait ends.
 */
async function untilIdle(client: ProtocolClient, signal: AbortSignal, ownsTurn: boolean): Promise<void> {
	const idle = client.waitForIdle(PEER_WAIT_TIMEOUT_MS);
	void idle.catch(() => undefined);
	const aborted = Promise.withResolvers<"aborted">();
	const onAbort = () => aborted.resolve("aborted");
	if (signal.aborted) onAbort();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const outcome = await Promise.race([idle.then(() => "idle" as const), aborted.promise]);
		if (outcome === "aborted") {
			if (ownsTurn) await stopPeerTurn(client);
			throw new PeerError("cancelled", "The peer run was cancelled");
		}
	} catch (error) {
		if (error instanceof PeerError) throw error;
		if (ownsTurn) await stopPeerTurn(client);
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

/**
 * The daemon's one stream to a conversation on a peer host, shared by every
 * run that reads or messages it: the host replaces a client's stream to a
 * conversation when the same client opens another, so runs never open their
 * own. It closes once the last run lets go.
 */
interface PeerConversationLink {
	readonly client: ProtocolClient;
	readonly workspace: string;
	readonly sessionId: string;
	/** The open created the conversation. */
	readonly created: boolean;
	users: number;
	/** The stream ended, or the link let go of it: the next run opens another. */
	gone: boolean;
	dispose(): void;
}

interface PeerRun {
	readonly connectionId: string;
	readonly controller: AbortController;
}

type SendRequest = Extract<ControlRequest, { type: "worker_peer_send" }>;

class PeerDaemonService implements VoltdServiceExtensionInstance {
	private readonly log: ReturnType<VoltdRuntimeServices["logger"]["child"]>;
	private readonly store: PeerStore;
	private readonly runs = new Map<string, PeerRun>();
	private readonly links = new Map<string, Promise<PeerConversationLink>>();
	private iroh: IrohModuleLike | undefined;
	private endpoint: Promise<PeerEndpointLike> | undefined;
	private closed = false;

	constructor(services: VoltdRuntimeServices) {
		this.log = services.logger.child("peers");
		this.store = new PeerStore(join(services.paths.daemonDir, PEER_STORE_FILE));
	}

	async handleRequest(connection: ControlConnection, request: ControlRequest): Promise<boolean> {
		try {
			switch (request.type) {
				case "peers_list":
				case "worker_peers_list": {
					const { peers } = await this.store.read();
					connection.send({ type: "peers_result", id: request.id, peers: peers.map(toStatus) });
					return true;
				}
				case "peer_add": {
					const peer = await this.add(request.name, request.ticket);
					connection.send({ type: "peer_result", id: request.id, peer: toStatus(peer) });
					return true;
				}
				case "peer_remove":
					await this.remove(request.name);
					connection.send({ type: "ok", id: request.id });
					return true;
				case "worker_peer_conversations": {
					const conversations = await this.conversations(request.peer);
					connection.send({ type: "peer_conversations_result", id: request.id, conversations });
					return true;
				}
				case "worker_peer_read": {
					const read = await this.read(request.peer, request.workspace, request.sessionId, request.limit);
					connection.send({ type: "peer_transcript_result", id: request.id, ...read });
					return true;
				}
				case "worker_peer_send":
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
		} catch (error) {
			this.fail(connection, request.id, error);
			return true;
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
		for (const link of this.links.values())
			void link.then(
				(opened) => opened.dispose(),
				() => undefined,
			);
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

	private async connect(address: IrohEndpointAddrLike): Promise<OpenedPeerConnection> {
		if (this.closed) throw new PeerError("shutting_down", "The daemon is shutting down");
		const endpoint = await this.bindEndpoint();
		let connection: PeerConnectionLike;
		try {
			connection = await connectWithTimeout(endpoint, address);
		} catch (error) {
			throw new PeerError("peer_unreachable", `Could not reach the peer host: ${errorMessage(error)}`);
		}
		return {
			connection,
			close: () => {
				try {
					connection.close(0n, CLOSE_REASON);
				} catch {
					// Already closed.
				}
			},
		};
	}

	/** Open a stream on `connection`, write `hello`, and read a successful handshake from the host `hostNodeId`. */
	private async handshake(
		connection: PeerConnectionLike,
		hostNodeId: string,
		hello: IrohRemoteHello,
	): Promise<OpenedPeerStream> {
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
			return { response, stream, rest: read.rest };
		} catch (error) {
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

	private async peer(name: string): Promise<PeerRecord> {
		const { peers } = await this.store.read();
		const peer = peers.find((saved) => saved.name === name);
		if (peer) return peer;
		const known = peers.length === 0 ? "none are paired" : `paired: ${peers.map((saved) => saved.name).join(", ")}`;
		throw new PeerError("peer_unknown", `No peer named ${name} (${known})`);
	}

	/** Pair with the host that issued `ticket` and save it as the peer `name`. */
	private async add(name: string, ticket: string): Promise<PeerRecord> {
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
		const opened = await this.connect(address);
		let workspace: string;
		try {
			const paired = await this.handshake(opened.connection, hostNodeId, {
				...this.hello(payload.workspace),
				secret: payload.secret,
				mode: "workspaceDiscovery",
				workspaceDiscovery: { purpose: "list_sessions" },
			});
			workspace = paired.response.workspace;
		} finally {
			opened.close();
		}
		const peer: PeerRecord = { name, hostNodeId, irohTicket: payload.irohTicket, workspace, addedAtMs: Date.now() };
		await this.store.mutate((current) => {
			if (current.peers.some((saved) => saved.name === name)) {
				throw new PeerError("peer_exists", `A peer named ${name} exists; remove it first`);
			}
			return { next: { ...current, peers: [...current.peers, peer] }, result: undefined };
		});
		this.log("info", "peer added", { name, hostNodeId, workspace });
		return peer;
	}

	private async remove(name: string): Promise<void> {
		await this.store.mutate((current) => {
			if (!current.peers.some((peer) => peer.name === name)) {
				throw new PeerError("not_found", `No peer named ${name}`);
			}
			return {
				next: { ...current, peers: current.peers.filter((peer) => peer.name !== name) },
				result: undefined,
			};
		});
		this.log("info", "peer removed", { name });
	}

	/** The conversations open on the host of peer `name`, in every workspace it shares, newest first. */
	private async conversations(name: string): Promise<ControlPeerConversation[]> {
		const peer = await this.peer(name);
		const opened = await this.connect(this.endpointAddress(peer.irohTicket));
		const discover = (workspace: string) =>
			this.handshake(opened.connection, peer.hostNodeId, {
				...this.hello(workspace),
				mode: "workspaceDiscovery",
				workspaceDiscovery: { purpose: "list_sessions" },
			});
		try {
			const first = await discover(peer.workspace);
			const workspaces = first.response.remoteHost?.workspaceNames ?? [first.response.workspace];
			const conversations: ControlPeerConversation[] = [];
			for (const workspace of workspaces) {
				const stream = workspace === first.response.workspace ? first : await discover(workspace);
				const data = await queryWorkspaceStream(stream, "sessions", { limit: PEER_SESSIONS_SCANNED });
				conversations.push(...openConversations(workspace, data));
			}
			return conversations.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
		} finally {
			opened.close();
		}
	}

	/** The link to `target` on the host of `peer`: the open one, else a new stream; `release` it once done. */
	private async attach(
		peer: PeerRecord,
		workspace: string,
		target: { readonly sessionId: string; readonly create: boolean },
	): Promise<PeerConversationLink> {
		const key = `${peer.hostNodeId}\u0000${workspace}\u0000${target.sessionId}`;
		for (;;) {
			let pending = this.links.get(key);
			if (pending === undefined) {
				pending = this.openLink(key, peer, workspace, target);
				this.links.set(key, pending);
				const opening = pending;
				opening.catch(() => {
					if (this.links.get(key) === opening) this.links.delete(key);
				});
			}
			const link = await pending;
			if (link.gone) {
				if (this.links.get(key) === pending) this.links.delete(key);
				continue;
			}
			link.users++;
			return link;
		}
	}

	private release(link: PeerConversationLink): void {
		link.users--;
		if (link.users <= 0) link.dispose();
	}

	private async openLink(
		key: string,
		peer: PeerRecord,
		workspace: string,
		target: { readonly sessionId: string; readonly create: boolean },
	): Promise<PeerConversationLink> {
		const opened = await this.connect(this.endpointAddress(peer.irohTicket));
		const client = new ProtocolClient({ name: "volt-peer", requestTimeoutMs: PEER_REQUEST_TIMEOUT_MS });
		try {
			const stream = await this.handshake(opened.connection, peer.hostNodeId, {
				...this.hello(workspace),
				mode: "conversation",
				conversation: target.create
					? { target: "new", sessionId: target.sessionId }
					: { target: "session", sessionId: target.sessionId },
			});
			await client.connect(createIrohRpcTransport({ stream: stream.stream, initialInput: stream.rest }));
			const pending = this.links.get(key);
			const link: PeerConversationLink = {
				client,
				workspace,
				sessionId: stream.response.sessionId ?? target.sessionId,
				created: stream.response.conversation?.selection === "created",
				users: 0,
				gone: false,
				dispose: () => {
					if (link.gone) return;
					link.gone = true;
					if (this.links.get(key) === pending) this.links.delete(key);
					void client.stop().catch(() => undefined);
					opened.close();
				},
			};
			// A client that failed (the stream ended) cannot be used again.
			client.onChange((change) => {
				if (change === undefined) link.dispose();
			});
			return link;
		} catch (error) {
			await client.stop().catch(() => undefined);
			opened.close();
			throw error instanceof PeerError ? error : new PeerError("peer_failed", errorMessage(error));
		}
	}

	private async read(
		name: string,
		workspace: string | undefined,
		sessionId: string,
		limit = PEER_TRANSCRIPT_DEFAULT_LIMIT,
	): Promise<{ workspace: string; sessionId: string; busy: boolean; items: ControlPeerTranscriptItem[] }> {
		const peer = await this.peer(name);
		const link = await this.attach(peer, workspace ?? peer.workspace, { sessionId, create: false });
		try {
			const items: ControlPeerTranscriptItem[] = [];
			for (const entry of link.client.state.entries) {
				const view = "view" in entry ? entry.view : undefined;
				if (view === undefined) continue;
				const cut = cutCodePoints(view.text, PEER_TRANSCRIPT_ITEM_MAX_CODE_POINTS);
				items.push({
					role: view.role,
					text: cut.text,
					truncated: view.truncated || cut.cut,
					...(view.toolName === undefined ? {} : { toolName: view.toolName }),
				});
			}
			return {
				workspace: link.workspace,
				sessionId: link.sessionId,
				busy: !link.client.isIdle(),
				items: items.slice(-limit),
			};
		} finally {
			this.release(link);
		}
	}

	private async run(connection: ControlConnection, request: SendRequest): Promise<void> {
		if (this.runs.has(request.runId)) {
			throw new PeerError("run_exists", `A peer run ${request.runId} is running`);
		}
		const controller = new AbortController();
		this.runs.set(request.runId, { connectionId: connection.connectionId, controller });
		try {
			const result = await this.send(request, controller.signal);
			connection.send({ type: "peer_send_result", id: request.id, ...result });
		} finally {
			this.runs.delete(request.runId);
		}
	}

	/** Send a message to a conversation of the peer (a new one without `sessionId`), waiting for its reply with `wait`. */
	private async send(
		request: SendRequest,
		signal: AbortSignal,
	): Promise<{ workspace: string; sessionId: string; created: boolean; reply?: ControlPeerReply }> {
		const peer = await this.peer(request.peer);
		const create = request.sessionId === undefined;
		const link = await this.attach(peer, request.workspace ?? peer.workspace, {
			sessionId: request.sessionId ?? randomUUID(),
			create,
		});
		try {
			if (signal.aborted) throw new PeerError("cancelled", "The peer run was cancelled");
			const client = link.client;
			const before = client.state.ordinal;
			// The remote profile fences input to the client's position; while a turn runs, the input steers or follows it.
			await client.intent(
				"prompt",
				{
					message: framePeerMessage(request.message, request.wait),
					streamingBehavior: request.delivery ?? "steer",
				},
				{ intentId: randomUUID(), expectedOrdinal: client.state.ordinal },
			);
			this.log("info", "peer message sent", {
				peer: peer.name,
				workspace: link.workspace,
				sessionId: link.sessionId,
				wait: request.wait,
			});
			const created = create && link.created;
			const sent = { workspace: link.workspace, sessionId: link.sessionId, created };
			if (!request.wait) return sent;
			await untilIdle(client, signal, created);
			return { ...sent, reply: replyAfter(client, before) };
		} catch (error) {
			throw error instanceof PeerError ? error : new PeerError("peer_failed", errorMessage(error));
		} finally {
			this.release(link);
		}
	}
}

/** The daemon's peer agents (experimental): saved peers, and what workers read and send through them. */
export function createPeerDaemonService(): VoltdServiceExtension {
	return (services) => new PeerDaemonService(services);
}
