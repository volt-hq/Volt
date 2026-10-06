/**
 * A phone paired with a harness daemon over real (relay-disabled) Iroh: it
 * pairs through the daemon's control plane, then opens conversation streams
 * whose handshake the daemon admits and whose protocol the worker hosting the
 * conversation serves. Needs the native Iroh binding.
 */

import { Buffer } from "node:buffer";
import type { RemoteAccessPresetName } from "@hansjm10/volt-protocol";
import type { IrohBiStreamLike } from "../../src/core/protocol/transport/iroh-transport.ts";
import { readIrohJsonlLine } from "../../src/core/protocol/transport/iroh-transport.ts";
import { IROH_REMOTE_ALPN } from "../../src/core/remote/iroh/protocol.ts";
import { decodeIrohRemoteTicketPayload } from "../../src/core/remote/iroh/ticket.ts";
import { createDaemonClient } from "../../src/daemon/control-client.ts";
import type { ControlEvent } from "../../src/daemon/control-protocol.ts";
import { loadIrohModule } from "../../src/daemon/iroh-native.ts";
import { probeDaemon } from "../../src/daemon/spawn.ts";
import type { DaemonHarness } from "../suite/daemon-harness.ts";
import { connectRemotePhone, type RemotePhone } from "./remote-phone.ts";

const ALPN = Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"));
const native = loadIrohModule();

/** Whether the native Iroh binding this utility needs loads here. */
export const nativeIrohAvailable = native.iroh !== undefined;

interface PhoneConnectionLike {
	openBi(): Promise<IrohBiStreamLike>;
	closed(): Promise<string>;
	close(code: bigint, reason: number[]): void;
}

interface PhoneEndpointLike {
	connect(addr: unknown, alpn: number[]): Promise<PhoneConnectionLike>;
	close(): Promise<void>;
}

/** A conversation stream a paired phone opened, after its handshake. */
export interface PhoneConversation {
	/** The handshake response the conversation's host wrote. */
	readonly handshake: Record<string, unknown>;
	/** The protocol client on the stream, when the handshake succeeded. */
	readonly phone: RemotePhone | undefined;
	/** Close the phone's Iroh connection for this stream. */
	close(): Promise<void>;
}

export interface PairedPhone {
	readonly nodeId: string;
	/** Open a conversation stream with `conversation` as the hello's target, in the harness's workspace or `workspace`. */
	openConversation(conversation: Record<string, unknown>, workspace?: string): Promise<PhoneConversation>;
	/** Open a workspace stream for `purpose`, after its handshake. */
	openWorkspace(mode: "workspaceDiscovery" | "workspaceManagement", purpose: string): Promise<PhoneConversation>;
	close(): Promise<void>;
}

async function writeJsonLine(stream: IrohBiStreamLike, value: object): Promise<void> {
	await stream.send.writeAll(Array.from(Buffer.from(`${JSON.stringify(value)}\n`, "utf8")));
}

/** Pair a phone with the harness daemon's workspace and the given access preset. */
export async function pairPhone(
	harness: DaemonHarness,
	options: { access?: RemoteAccessPresetName; label?: string } = {},
): Promise<PairedPhone> {
	const iroh = native.iroh;
	if (!iroh) throw new Error("native iroh unavailable");
	const probe = await probeDaemon(harness.agentDir);
	const events: ControlEvent[] = [];
	const control = createDaemonClient({
		socketPath: probe.socketPath,
		client: "cli",
		version: "test",
		...(probe.authToken === undefined ? {} : { authToken: probe.authToken }),
		reconnect: false,
		onEvent: (event) => events.push(event),
	});
	const connections: PhoneConnectionLike[] = [];
	let endpoint: PhoneEndpointLike | undefined;
	try {
		await control.connect();
		const started = await control.request({
			type: "pair_request",
			workspaceName: harness.workspaceName,
			access: options.access ?? "full",
		});
		if (started.type !== "pair_started") throw new Error(`pairing did not start: ${JSON.stringify(started)}`);
		let ticket: string | undefined;
		for (let attempt = 0; ticket === undefined && attempt < 500; attempt++) {
			const progress = events.find((event) => event.type === "pairing_progress" && event.phase === "ticket");
			ticket = progress?.type === "pairing_progress" ? progress.ticket : undefined;
			if (ticket === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
		}
		if (ticket === undefined) throw new Error("no pairing ticket");
		const payload = decodeIrohRemoteTicketPayload(ticket);
		const address = (
			iroh.EndpointTicket as unknown as { fromString(value: string): { endpointAddr(): unknown } }
		).fromString(payload.irohTicket);
		const builder = iroh.Endpoint.builder();
		iroh.presetMinimal(builder);
		builder.relayMode(iroh.RelayMode.disabled());
		const bound = (await builder.bind()) as unknown as PhoneEndpointLike & { id(): { toString(): string } };
		endpoint = bound;
		const pairing = await bound.connect(address.endpointAddr(), ALPN);
		const pairingStream = await pairing.openBi();
		await writeJsonLine(pairingStream, {
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: harness.workspaceName,
			secret: payload.secret,
			clientLabel: options.label ?? "vitest-phone",
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		const paired = await readIrohJsonlLine(pairingStream.recv, Buffer.alloc(0), { maxLineBytes: 1024 * 1024 });
		if (paired.line === undefined || (JSON.parse(paired.line) as { success?: unknown }).success !== true) {
			throw new Error(`pairing failed: ${paired.line}`);
		}
		pairing.close(0n, Array.from(Buffer.from("done", "utf8")));
		await pairing.closed().catch(() => undefined);
		const nodeId = bound.id().toString();

		const open = async (hello: Record<string, unknown>): Promise<PhoneConversation> => {
			const connection = await bound.connect(address.endpointAddr(), ALPN);
			connections.push(connection);
			const stream = await connection.openBi();
			await writeJsonLine(stream, {
				type: "volt_iroh_hello",
				protocol: IROH_REMOTE_ALPN,
				workspace: harness.workspaceName,
				...hello,
			});
			const response = await readIrohJsonlLine(stream.recv, Buffer.alloc(0), { maxLineBytes: 1024 * 1024 });
			if (response.line === undefined) throw new Error("the stream ended before its handshake");
			const handshake = JSON.parse(response.line) as Record<string, unknown>;
			return {
				handshake,
				phone: handshake.success === true ? connectRemotePhone(stream, response.rest) : undefined,
				close: async () => {
					connection.close(0n, Array.from(Buffer.from("done", "utf8")));
					await connection.closed().catch(() => undefined);
				},
			};
		};

		return {
			nodeId,
			openConversation: (conversation, workspace) =>
				open({ conversation, ...(workspace === undefined ? {} : { workspace }) }),
			openWorkspace: (mode, purpose) => open({ [mode]: { purpose } }),
			close: async () => {
				for (const connection of connections) {
					try {
						connection.close(0n, Array.from(Buffer.from("done", "utf8")));
					} catch {
						// Already closed.
					}
				}
				await endpoint?.close().catch(() => undefined);
				await control.close();
			},
		};
	} catch (error) {
		await endpoint?.close().catch(() => undefined);
		await control.close();
		throw error;
	}
}
