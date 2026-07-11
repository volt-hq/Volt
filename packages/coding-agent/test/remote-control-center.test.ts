import { visibleWidth } from "@earendil-works/volt-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import type { ControlEvent, ControlResponse } from "../src/daemon/control-protocol.ts";
import {
	type RemoteControlBackend,
	RemoteControlCenterComponent,
	type RemoteControlSnapshot,
	type RemotePairingHandle,
} from "../src/modes/interactive/components/remote-control-center.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type RemoteStatus = Extract<ControlResponse, { type: "status_result" }>;
type PairingProgress = Extract<ControlEvent, { type: "pairing_progress" }>;

function status(overrides: Partial<RemoteStatus> = {}): RemoteStatus {
	return {
		type: "status_result",
		id: "status-1",
		version: "0.80.0-test",
		protocolVersion: 1,
		pid: 42,
		startedAtMs: Date.now() - 5 * 60 * 1000,
		capabilities: ["pair_cancel"],
		leases: [
			{
				workspaceName: "volt",
				sessionId: "session-current",
				state: "tui-owned",
				relayCount: 1,
				streamCount: 1,
			},
		],
		phoneConnections: 1,
		workspaces: [{ name: "volt", path: "/tmp/volt", allowedTools: ["read", "bash"] }],
		clients: [
			{
				clientNodeId: "phone-node-1234567890",
				label: "Jordan's iPhone",
				pairedAtMs: Date.now() - 60_000,
				lastSeenAtMs: Date.now() - 5_000,
				allowedTools: ["read", "bash"],
			},
		],
		revokedClients: [],
		remotePolicy: { allowTools: null, detachedRuntimeTtlMs: 30 * 60 * 1000 },
		keepAwake: { enabled: false, state: "disabled" },
		...overrides,
	};
}

class FakeBackend implements RemoteControlBackend {
	snapshot: RemoteControlSnapshot;
	nextSnapshot: RemoteControlSnapshot | undefined;
	startCalls = 0;
	registerCalls: string[] = [];
	revokeCalls: string[] = [];
	repairApprovalCalls: string[] = [];
	pairWorkspace: string | undefined;
	pairingProgress: ((event: PairingProgress) => void) | undefined;
	closeCalls = 0;
	pairDisposeCalls = 0;

	constructor(snapshot: RemoteControlSnapshot) {
		this.snapshot = snapshot;
	}

	async load(): Promise<RemoteControlSnapshot> {
		if (this.nextSnapshot) {
			this.snapshot = this.nextSnapshot;
			this.nextSnapshot = undefined;
		}
		return this.snapshot;
	}

	async startDaemon(): Promise<void> {
		this.startCalls++;
	}

	async registerCurrentWorkspace(path: string): Promise<{ name: string; path: string }> {
		this.registerCalls.push(path);
		const workspace = { name: "volt", path };
		if (this.snapshot.kind === "online") {
			this.snapshot = {
				kind: "online",
				status: { ...this.snapshot.status, workspaces: [...this.snapshot.status.workspaces, workspace] },
			};
		}
		return workspace;
	}

	async beginPairing(
		workspaceName: string,
		onProgress: (event: PairingProgress) => void,
	): Promise<RemotePairingHandle> {
		this.pairWorkspace = workspaceName;
		this.pairingProgress = onProgress;
		return {
			requestId: "pair-1",
			dispose: () => {
				this.pairDisposeCalls++;
			},
		};
	}

	async revokeClient(clientNodeId: string): Promise<void> {
		this.revokeCalls.push(clientNodeId);
		if (this.snapshot.kind === "online") {
			this.snapshot = {
				kind: "online",
				status: { ...this.snapshot.status, clients: [] },
			};
		}
	}

	async approveClientRepair(clientNodeId: string): Promise<void> {
		this.repairApprovalCalls.push(clientNodeId);
		if (this.snapshot.kind === "online") {
			this.snapshot = {
				kind: "online",
				status: {
					...this.snapshot.status,
					revokedClients: this.snapshot.status.revokedClients?.map((client) =>
						client.clientNodeId === clientNodeId ? { ...client, rePairApprovedAtMs: Date.now() } : client,
					),
				},
			};
		}
	}

	async close(): Promise<void> {
		this.closeCalls++;
	}
}

class DeferredPairBackend extends FakeBackend {
	pairCallbacks: Array<(event: PairingProgress) => void> = [];
	pairResolvers: Array<(handle: RemotePairingHandle) => void> = [];

	override beginPairing(
		workspaceName: string,
		onProgress: (event: PairingProgress) => void,
	): Promise<RemotePairingHandle> {
		this.pairWorkspace = workspaceName;
		this.pairCallbacks.push(onProgress);
		return new Promise((resolve) => this.pairResolvers.push(resolve));
	}

	resolvePair(index: number): void {
		this.pairResolvers[index]?.({ requestId: `pair-${index}`, dispose: () => this.pairDisposeCalls++ });
	}
}

function createComponent(backend: FakeBackend, rows = 36) {
	const requestRender = vi.fn();
	const onClose = vi.fn();
	const copied: string[] = [];
	const component = new RemoteControlCenterComponent(backend, {
		getTerminalRows: () => rows,
		getCurrentWorkspaceName: () => "volt",
		getCurrentWorkspacePath: () => "/tmp/volt",
		currentSessionId: "session-current",
		requestRender,
		copyText: async (text) => {
			copied.push(text);
		},
		onClose,
	});
	return { component, requestRender, onClose, copied };
}

async function settle(): Promise<void> {
	for (let index = 0; index < 5; index++) await Promise.resolve();
}

describe("RemoteControlCenterComponent", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders daemon, ownership, device, workspace, and headless policy status", async () => {
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 45);
		await component.start();
		const text = component.render(120).map(stripAnsi).join("\n");

		expect(text).toContain("Remote Access");
		expect(text).toContain("1 attached phone · 1 paired device");
		expect(text).toContain("Current lease: tui-owned");
		expect(text).toContain("Register current directory");
		expect(text).toContain("Tools: read, bash");
		expect(text).toContain("Detached runtime retention: 30m");
		expect(text).toContain("Jordan's iPhone");
		expect(text).toContain("/tmp/volt");
	});

	it("renders compatibility defaults for an older protocol-v1 daemon", async () => {
		const legacyStatus = status({
			capabilities: undefined,
			revokedClients: undefined,
			remotePolicy: undefined,
			clients: [
				{
					clientNodeId: "legacy-phone-node",
					label: "Legacy phone",
					pairedAtMs: Date.now() - 5_000,
				},
			],
		});
		const backend = new FakeBackend({ kind: "online", status: legacyStatus });
		const { component } = createComponent(backend, 45);
		await component.start();
		const text = component.render(100).map(stripAnsi).join("\n");
		expect(text).toContain("Detached runtime retention: not reported");
		expect(text).toContain("Tools: not reported");
		expect(text).toContain("Restart voltd to pair safely");
	});

	it("is height- and width-safe across the visual validation matrix", async () => {
		for (const [width, rows] of [
			[24, 12],
			[80, 24],
			[120, 36],
			[160, 45],
		] as const) {
			const backend = new FakeBackend({ kind: "online", status: status() });
			const { component } = createComponent(backend, rows);
			await component.start();
			const lines = component.render(width);
			expect(lines).toHaveLength(rows);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("page-scrolls through non-action status rows", async () => {
		const clients = Array.from({ length: 20 }, (_, index) => ({
			clientNodeId: `phone-${index}`,
			label: `Phone ${index}`,
			pairedAtMs: Date.now(),
			lastSeenAtMs: Date.now(),
			allowedTools: ["read"],
		}));
		const backend = new FakeBackend({ kind: "online", status: status({ clients }) });
		const { component } = createComponent(backend, 24);
		await component.start();
		component.render(80);
		for (let index = 0; index < 4; index++) component.handleInput("\x1b[6~");
		const text = component.render(80).map(stripAnsi).join("\n");
		expect(text).toContain("LEASES");
		expect(text).toContain("Current · volt/session-current");
	});

	it("starts an offline daemon and refreshes into the overview", async () => {
		const backend = new FakeBackend({ kind: "offline", state: "not-running" });
		const { component } = createComponent(backend);
		await component.start();
		expect(component.render(80).map(stripAnsi).join("\n")).toContain("Start daemon");

		backend.nextSnapshot = { kind: "online", status: status() };
		component.handleInput("\n");
		await settle();
		expect(backend.startCalls).toBe(1);
		expect(component.render(80).map(stripAnsi).join("\n")).toContain("Daemon started");
	});

	it("registers Volt's current directory when it is not available to the daemon", async () => {
		const backend = new FakeBackend({ kind: "online", status: status({ workspaces: [] }) });
		const { component } = createComponent(backend, 36);
		await component.start();
		component.render(100);
		expect(component.render(100).map(stripAnsi).join("\n")).toContain("Register current directory");

		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await settle();

		expect(backend.registerCalls).toEqual(["/tmp/volt"]);
		const text = component.render(100).map(stripAnsi).join("\n");
		expect(text).toContain("Workspace volt is available");
		expect(text).toContain("Current · volt · /tmp/volt");
		expect(text).toContain("Pair a phone");
	});

	it("pairs the current workspace, preserves ticket progress, and copies the ticket", async () => {
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component, copied } = createComponent(backend, 24);
		await component.start();
		component.render(40);
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await settle();
		expect(backend.pairWorkspace).toBe("volt");

		backend.pairingProgress?.({
			type: "pairing_progress",
			requestId: "pair-1",
			phase: "ticket",
			ticket: "volt+iroh://v1/test-pairing-ticket",
		});
		backend.pairingProgress?.({ type: "pairing_progress", requestId: "pair-1", phase: "waiting" });
		let text = component.render(40).map(stripAnsi).join("\n");
		expect(text).toContain("Scan with Volt on your phone");
		expect(text).toContain("Enlarge the terminal");

		component.handleInput("\x1b[A");
		component.handleInput("\n");
		await settle();
		expect(copied).toEqual(["volt+iroh://v1/test-pairing-ticket"]);
		text = component.render(40).map(stripAnsi).join("\n");
		expect(text).toContain("Pairing ticket copied");

		component.handleInput("\x1b");
		expect(backend.pairDisposeCalls).toBe(1);
		expect(component.render(40).map(stripAnsi).join("\n")).toContain("HEADLESS POLICY");
	});

	it("ignores progress from a cancelled stale pairing attempt", async () => {
		const backend = new DeferredPairBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 36);
		await component.start();
		component.render(100);
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.handleInput("\x1b");
		component.render(100);
		component.handleInput("\n");
		expect(backend.pairResolvers).toHaveLength(2);

		backend.resolvePair(0);
		await settle();
		backend.pairCallbacks[0]?.({
			type: "pairing_progress",
			requestId: "pair-0",
			phase: "failed",
			error: "stale failure",
		});
		expect(component.render(100).map(stripAnsi).join("\n")).not.toContain("stale failure");

		backend.resolvePair(1);
		await settle();
		backend.pairCallbacks[1]?.({
			type: "pairing_progress",
			requestId: "pair-1",
			phase: "waiting",
		});
		expect(component.render(100).map(stripAnsi).join("\n")).toContain("Scan with Volt on your phone");
	});

	it("renders a complete QR only when the viewport can contain it", async () => {
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 80);
		await component.start();
		component.render(160);
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await settle();
		backend.pairingProgress?.({
			type: "pairing_progress",
			requestId: "pair-1",
			phase: "ticket",
			ticket: "volt+iroh://v1/test-pairing-ticket",
		});
		const lines = component.render(160);
		const text = lines.map(stripAnsi).join("\n");
		expect(text).not.toContain("Enlarge the terminal");
		expect(text).toMatch(/[▀▄█]/);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(160);
	});

	it("requires confirmation before revoking a paired device", async () => {
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 36);
		await component.start();
		component.render(100);
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		expect(backend.revokeCalls).toEqual([]);
		expect(component.render(100).map(stripAnsi).join("\n")).toContain("Confirm revoke");

		component.handleInput("\n");
		await settle();
		expect(backend.revokeCalls).toEqual(["phone-node-1234567890"]);
	});

	it("requires confirmation before allowing a revoked identity to re-pair", async () => {
		const revokedNodeId = "revoked-phone-node-1234567890";
		const backend = new FakeBackend({
			kind: "online",
			status: status({
				clients: [],
				revokedClients: [
					{
						clientNodeId: revokedNodeId,
						label: "Jordan's iPhone",
						pairedAtMs: Date.now() - 60_000,
						lastSeenAtMs: Date.now() - 30_000,
						revokedAtMs: Date.now() - 5_000,
					},
				],
			}),
		});
		const { component } = createComponent(backend, 36);
		await component.start();
		component.render(100);
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");

		expect(backend.repairApprovalCalls).toEqual([]);
		expect(component.render(100).map(stripAnsi).join("\n")).toContain("Confirm allow re-pair");

		component.handleInput("\n");
		await settle();
		expect(backend.repairApprovalCalls).toEqual([revokedNodeId]);
		const text = component.render(100).map(stripAnsi).join("\n");
		expect(text).toContain("Re-pair approved. Choose Pair a phone and scan a fresh QR.");
		expect(text).toContain("Re-pair approved · scan a fresh QR");
	});

	it("strips terminal control sequences from daemon-provided labels", async () => {
		const unsafe = status({
			clients: [
				{
					clientNodeId: "unsafe-node",
					label: "\x1b]8;;https://example.invalid\x07spoofed\x1b]8;;\x07",
					pairedAtMs: Date.now(),
					lastSeenAtMs: Date.now(),
					allowedTools: ["read"],
				},
			],
		});
		const backend = new FakeBackend({ kind: "online", status: unsafe });
		const { component } = createComponent(backend, 45);
		await component.start();
		const rendered = component.render(100).join("\n");
		expect(rendered).not.toContain("example.invalid");
		expect(stripAnsi(rendered)).toContain("spoofed");
	});

	it("closes from the overview and disposes its management connection", async () => {
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component, onClose } = createComponent(backend);
		await component.start();
		component.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledOnce();
		component.dispose();
		component.dispose();
		expect(backend.closeCalls).toBe(1);
	});
});

describe("remote slash command", () => {
	it("is registered as a built-in command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "remote",
			description: "Manage daemon status, phone pairing, and remote access",
		});
	});
});
