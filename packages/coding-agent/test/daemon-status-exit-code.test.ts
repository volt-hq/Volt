/**
 * `volt daemon status` reports the daemon: it exits 0 when remote access is
 * ready, and also when the build has no phone transport at all (a standalone
 * binary, an `--omit=optional` install, a platform without the binding), since
 * that daemon still serves its local clients and workers. `volt remote status`
 * reports remote access and exits nonzero whenever it is not ready. Every other
 * transport or relay problem fails both.
 */

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { DaemonClient, DaemonClientOptions, DistributiveOmit } from "../src/daemon/control-client.ts";
import {
	type ControlRelayCredentialStatus,
	type ControlRequest,
	type ControlResponse,
	REMOTE_TRANSPORT_REASON_MESSAGES,
	type RemoteTransportHealth,
	STANDALONE_REMOTE_TRANSPORT_MESSAGE,
} from "../src/daemon/control-protocol.ts";
import type * as Spawn from "../src/daemon/spawn.ts";

const mockDaemon = vi.hoisted(() => ({
	remoteTransport: { state: "ready" } as RemoteTransportHealth,
	relayCredential: undefined as ControlRelayCredentialStatus | undefined,
}));

vi.mock("../src/daemon/spawn.ts", async (importOriginal) => {
	const running = {
		healthy: true,
		state: "running",
		socketPath: "/tmp/voltd-status-exit.sock",
		authToken: "test-token",
		pid: 42,
	};
	return {
		...(await importOriginal<typeof Spawn>()),
		ensureDaemonRunning: vi.fn(async () => running),
		probeDaemon: vi.fn(async () => running),
	};
});

vi.mock("../src/daemon/control-client.ts", () => ({
	createDaemonClient: (_options: DaemonClientOptions): DaemonClient => ({
		connectionState: "connected",
		serverInfo: undefined,
		goneReason: undefined,
		async connect() {},
		async request(request: DistributiveOmit<ControlRequest, "id">): Promise<ControlResponse> {
			if (request.type !== "status") throw new Error(`unexpected request ${request.type}`);
			return {
				type: "status_result",
				id: "status-1",
				version: "test",
				protocolVersion: 1,
				pid: 42,
				startedAtMs: Date.now(),
				environment: { source: "inherited", reason: "not resolved" },
				leases: [],
				phoneConnections: 0,
				workspaces: [],
				clients: [],
				remoteTransport: mockDaemon.remoteTransport,
				...(mockDaemon.relayCredential === undefined ? {} : { relayCredential: mockDaemon.relayCredential }),
				keepAwake: { enabled: false, state: "disabled" },
				workers: [],
			};
		},
		async waitForResponse() {
			throw new Error("not used");
		},
		async openRelay() {
			throw new Error("not used");
		},
		async close() {},
	}),
}));

import { handleDaemonCommand } from "../src/daemon/cli.ts";
import { handleRemoteControlCommand } from "../src/daemon/remote-cli.ts";

interface StatusCase {
	name: string;
	remoteTransport: RemoteTransportHealth;
	relayCredential?: ControlRelayCredentialStatus;
	daemonExitCode: number;
	remoteExitCode: number;
}

const BINDING_MISSING: RemoteTransportHealth = {
	state: "unavailable",
	reasonCode: "native_binding_missing",
	message: REMOTE_TRANSPORT_REASON_MESSAGES.native_binding_missing,
	wrapperVersion: "1.1.1-volt.2",
};

const CASES: StatusCase[] = [
	{ name: "ready", remoteTransport: { state: "ready" }, daemonExitCode: 0, remoteExitCode: 0 },
	{
		name: "ready with active relay access",
		remoteTransport: { state: "ready" },
		relayCredential: { state: "active" },
		daemonExitCode: 0,
		remoteExitCode: 0,
	},
	{
		name: "no binding in an npm install",
		remoteTransport: BINDING_MISSING,
		daemonExitCode: 0,
		remoteExitCode: 1,
	},
	{
		name: "no binding in a standalone binary",
		remoteTransport: {
			state: "unavailable",
			reasonCode: "native_binding_missing",
			message: STANDALONE_REMOTE_TRANSPORT_MESSAGE,
		},
		daemonExitCode: 0,
		remoteExitCode: 1,
	},
	{
		name: "no binding and expired persisted relay access",
		remoteTransport: BINDING_MISSING,
		relayCredential: { state: "expired" },
		daemonExitCode: 0,
		remoteExitCode: 1,
	},
	{
		name: "no phone transport extension",
		remoteTransport: { state: "unavailable", reasonCode: "extension_missing" },
		daemonExitCode: 1,
		remoteExitCode: 1,
	},
	{
		name: "endpoint start failed",
		remoteTransport: { state: "unavailable", reasonCode: "endpoint_start_failed" },
		daemonExitCode: 1,
		remoteExitCode: 1,
	},
	{
		name: "storage full, unavailable",
		remoteTransport: { state: "unavailable", reasonCode: "host_storage_full" },
		daemonExitCode: 1,
		remoteExitCode: 1,
	},
	{
		name: "storage full, degraded",
		remoteTransport: { state: "degraded", reasonCode: "host_storage_full" },
		daemonExitCode: 1,
		remoteExitCode: 1,
	},
	{ name: "starting", remoteTransport: { state: "starting" }, daemonExitCode: 1, remoteExitCode: 1 },
	...(["expired", "subscription_inactive", "revocation_pending"] as const).map((state) => ({
		name: `ready with ${state} relay access`,
		remoteTransport: { state: "ready" } satisfies RemoteTransportHealth,
		relayCredential: { state },
		daemonExitCode: 1,
		remoteExitCode: 1,
	})),
];

describe("status exit codes", () => {
	let originalExitCode: typeof process.exitCode;
	let logSpy: MockInstance<typeof console.log>;
	let errorSpy: MockInstance<typeof console.error>;

	beforeEach(() => {
		originalExitCode = process.exitCode;
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		process.exitCode = originalExitCode;
		mockDaemon.remoteTransport = { state: "ready" };
		mockDaemon.relayCredential = undefined;
	});

	async function exitCodeOf(run: () => Promise<boolean>): Promise<number> {
		process.exitCode = undefined;
		await expect(run()).resolves.toBe(true);
		return Number(process.exitCode ?? 0);
	}

	it.each(CASES)("$name: daemon status exits $daemonExitCode, remote status $remoteExitCode", async (testCase) => {
		mockDaemon.remoteTransport = testCase.remoteTransport;
		mockDaemon.relayCredential = testCase.relayCredential;
		for (const json of [false, true]) {
			const flags = json ? ["--json"] : [];
			expect(
				await exitCodeOf(() => handleDaemonCommand(["daemon", "status", ...flags], { agentDir: "/unused" })),
				`daemon status ${flags.join(" ")}`,
			).toBe(testCase.daemonExitCode);
			expect(
				await exitCodeOf(() => handleRemoteControlCommand(["remote", "status", ...flags])),
				`remote status ${flags.join(" ")}`,
			).toBe(testCase.remoteExitCode);
		}
	});

	it("still shows a no-binding daemon's transport as unavailable", async () => {
		mockDaemon.remoteTransport = BINDING_MISSING;
		await handleDaemonCommand(["daemon", "status"], { agentDir: "/unused" });
		const shown = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
		expect(shown).toContain("remote transport: unavailable · wrapper 1.1.1-volt.2 · native_binding_missing");
		expect(shown).toContain(REMOTE_TRANSPORT_REASON_MESSAGES.native_binding_missing);
	});
});
