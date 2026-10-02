import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IROH_REMOTE_ALPN } from "../../../src/core/remote/iroh/protocol.ts";
import { decodeIrohRemoteTicketPayload } from "../../../src/core/remote/iroh/ticket.ts";
import type { IrohBiStreamLike } from "../../../src/core/rpc/iroh-transport.ts";
import { createDaemonClient, type DaemonClient } from "../../../src/daemon/control-client.ts";
import type { ControlEvent } from "../../../src/daemon/control-protocol.ts";
import { loadIrohModule } from "../../../src/daemon/iroh-native.ts";
import { createIrohDaemonService } from "../../../src/daemon/iroh-service.ts";
import { runVoltDaemon } from "../../../src/daemon/main.ts";
import { probeDaemon } from "../../../src/daemon/spawn.ts";
import { readLineFromIroh } from "../../../src/daemon/workspace-streams.ts";

const native = loadIrohModule();
const runNative = native.iroh !== undefined || process.env.VOLT_TEST_REQUIRE_NATIVE_IROH === "1";
const ALPN = Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"));
const HANDSHAKE_TIMEOUT_MS = 1_000;

interface PhoneConnection {
	openBi(): Promise<IrohBiStreamLike>;
	closed(): Promise<string>;
	close(code: bigint, reason: number[]): void;
}

interface PhoneEndpoint {
	connect(addr: unknown, alpn: number[]): Promise<PhoneConnection>;
	close(): Promise<void>;
}

async function writeLine(stream: IrohBiStreamLike, text: string): Promise<void> {
	await stream.send.writeAll(Array.from(Buffer.from(text, "utf8")));
}

async function readJsonLine(stream: IrohBiStreamLike, rest: Buffer = Buffer.alloc(0)) {
	const result = await readLineFromIroh(stream.recv, rest, { maxLineBytes: 1024 * 1024 });
	if (result.line === undefined) throw new Error("stream ended before a line was received");
	return { value: JSON.parse(result.line) as Record<string, unknown>, rest: result.rest };
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

describe.runIf(runNative)("#461 single-stream connection accept deadline", () => {
	let agentDir: string;
	let daemon: Promise<number>;
	let control: DaemonClient;
	let phone: PhoneEndpoint;
	let endpointAddr: unknown;
	let pairingSecret: string;
	const events: ControlEvent[] = [];

	beforeAll(async () => {
		vi.stubEnv("VOLT_IROH_RELAY_MODE", undefined);
		vi.stubEnv("VOLT_IROH_RELAY_URLS", undefined);
		vi.stubEnv("VOLT_IROH_RELAY_AUTH_TOKEN", undefined);
		const iroh = native.iroh;
		if (!iroh) throw new Error("native iroh unavailable");
		agentDir = mkdtempSync(join(tmpdir(), "voltd-461-"));
		const workspaceDir = join(agentDir, "ws");
		mkdirSync(workspaceDir, { recursive: true });
		daemon = runVoltDaemon({ agentDir, foreground: false, extensionDisposeTimeoutMs: 50 }, [
			createIrohDaemonService({ relayMode: "disabled" }, { handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS }),
		]);
		let status = await probeDaemon(agentDir);
		for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			status = await probeDaemon(agentDir);
		}
		expect(status.healthy).toBe(true);
		control = createDaemonClient({
			socketPath: status.socketPath,
			client: "cli",
			version: "test",
			authToken: status.authToken,
			reconnect: false,
			onEvent: (event) => events.push(event),
		});
		expect((await control.request({ type: "workspace_register", name: "ws", path: workspaceDir })).type).toBe("ok");
		expect((await control.request({ type: "pair_request", workspaceName: "ws" })).type).toBe("pair_started");
		const findTicket = () =>
			events.find(
				(event): event is ControlEvent & { type: "pairing_progress" } =>
					event.type === "pairing_progress" && event.phase === "ticket",
			);
		for (let attempt = 0; findTicket() === undefined && attempt < 150; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const ticketEvent = findTicket();
		expect(ticketEvent?.ticket).toBeDefined();
		const payload = decodeIrohRemoteTicketPayload(ticketEvent?.ticket ?? "");
		pairingSecret = payload.secret ?? "";
		endpointAddr = (iroh.EndpointTicket as unknown as { fromString(value: string): { endpointAddr(): unknown } })
			.fromString(payload.irohTicket)
			.endpointAddr();
		const builder = iroh.Endpoint.builder();
		iroh.presetMinimal(builder);
		builder.relayMode(iroh.RelayMode.disabled());
		phone = (await builder.bind()) as unknown as PhoneEndpoint;
	}, 30_000);

	afterAll(async () => {
		await phone?.close().catch(() => {});
		await control?.request({ type: "shutdown" }).catch(() => {});
		await control?.close();
		await daemon;
		rmSync(agentDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	}, 30_000);

	it("serves an authenticated stream that stays busy past the handshake deadline", async () => {
		const connection = await phone.connect(endpointAddr, ALPN);
		const stream = await connection.openBi();
		await writeLine(
			stream,
			`${JSON.stringify({
				type: "volt_iroh_hello",
				protocol: IROH_REMOTE_ALPN,
				workspace: "ws",
				secret: pairingSecret,
				clientLabel: "regression-phone",
				workspaceDiscovery: { purpose: "list_sessions" },
			})}\n`,
		);
		const handshake = await readJsonLine(stream);
		expect(handshake.value.success).toBe(true);

		// The phone opens no second stream while its only request is slow.
		await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_TIMEOUT_MS * 2));

		await writeLine(stream, `${JSON.stringify({ id: "ls-after-deadline", type: "list_sessions" })}\n`);
		const response = await withDeadline(readJsonLine(stream, handshake.rest), 5_000, "list_sessions response");
		expect(response.value).toMatchObject({ id: "ls-after-deadline", command: "list_sessions", success: true });
		connection.close(0n, Array.from(Buffer.from("done", "utf8")));
	}, 20_000);

	it("still closes a connection whose first stream never completes a handshake", async () => {
		const connection = await phone.connect(endpointAddr, ALPN);
		const stream = await connection.openBi();
		// A partial line makes the stream visible to the host without a hello.
		await writeLine(stream, "{");
		const closeReason = await withDeadline(connection.closed(), HANDSHAKE_TIMEOUT_MS * 5, "host close");
		expect(closeReason).toContain("handshake_timeout");
	}, 20_000);
});
