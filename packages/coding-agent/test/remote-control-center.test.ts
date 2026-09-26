import { Buffer } from "node:buffer";
import {
	type CellDimensions,
	getCapabilities,
	getCellDimensions,
	setCapabilities,
	setCellDimensions,
	type TerminalCapabilities,
	visibleWidth,
} from "@hansjm10/volt-tui";
import png from "@jimp/js-png";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IrohRemoteAccessPresetName } from "../src/core/remote/iroh/access-grant.ts";
import { DEFAULT_IROH_REMOTE_ALLOW_TOOLS, IROH_REMOTE_ALPN } from "../src/core/remote/iroh/protocol.ts";
import {
	createIrohRemoteTicketQrCode,
	formatIrohRemoteTicketQrCode,
	IROH_REMOTE_QR_QUIET_ZONE_MODULES,
} from "../src/core/remote/iroh/qr.ts";
import { encodeIrohRemoteTicketPayload } from "../src/core/remote/iroh/ticket.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { initTheme, theme } from "../src/core/theme/runtime.ts";
import {
	CONTROL_PAIR_CANCEL_CAPABILITY,
	CONTROL_RPC_GRANTS_CAPABILITY,
	type ControlEvent,
	type ControlRelayCredentialStatus,
	type ControlResponse,
} from "../src/daemon/control-protocol.ts";
import {
	type RemoteControlBackend,
	RemoteControlCenterComponent,
	RemoteControlRequestError,
	type RemoteControlSnapshot,
	type RemotePairingHandle,
} from "../src/modes/interactive/components/remote-control-center.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type RemoteStatus = Extract<ControlResponse, { type: "status_result" }>;
type PairingProgress = Extract<ControlEvent, { type: "pairing_progress" }>;

const PAIRING_HOST_NODE_ID = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join("");

function verificationTicket(): string {
	return encodeIrohRemoteTicketPayload({
		alpn: IROH_REMOTE_ALPN,
		expiresAt: 1_800_000_000_000,
		irohTicket: "endpoint-ticket",
		nodeId: PAIRING_HOST_NODE_ID,
		relayMode: "production",
		relayUrls: ["https://relay-b.example/", "https://relay-a.example:8443"],
		relayAuthToken: "relay-auth-must-not-render",
		secret: "pairing-secret-must-not-render",
		workspace: "volt",
	});
}

function managedRelayTicket(): string {
	return encodeIrohRemoteTicketPayload({
		alpn: IROH_REMOTE_ALPN,
		expiresAt: 1_800_000_000_000,
		irohTicket: "a".repeat(150),
		nodeId: PAIRING_HOST_NODE_ID,
		relayMode: "production",
		relayUrls: ["https://relay.example/"],
		relayCredentialClaim: { claimId: "a".repeat(24), serviceUrl: "https://broker.example/" },
		secret: "s".repeat(43),
		workspace: "volt",
	});
}

function status(overrides: Partial<RemoteStatus> = {}): RemoteStatus {
	return {
		type: "status_result",
		id: "status-1",
		version: "0.80.0-test",
		protocolVersion: 1,
		pid: 42,
		startedAtMs: Date.now() - 5 * 60 * 1000,
		environment: { source: "inherited", reason: "not resolved" },
		capabilities: [CONTROL_PAIR_CANCEL_CAPABILITY, CONTROL_RPC_GRANTS_CAPABILITY],
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
		remoteTransport: { state: "ready", wrapperVersion: "1.1.1-volt.2" },
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
	regenerateCalls = 0;
	recoverCalls: string[] = [];
	registerCalls: string[] = [];
	registerError: Error | undefined;
	registerName = "volt";
	revokeCalls: string[] = [];
	resetCalls = 0;
	resetError: Error | undefined;
	resetPending: Promise<void> | undefined;
	repairApprovalCalls: string[] = [];
	checkCalls = 0;
	checkError: Error | undefined;
	/** Relay access reported after a successful check; unchanged when undefined. */
	checkResult: ControlRelayCredentialStatus | undefined;
	pairWorkspace: string | undefined;
	pairAccess: IrohRemoteAccessPresetName | undefined;
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

	async regenerateState(): Promise<{ backupPath: string; preservedIdentity: boolean }> {
		this.regenerateCalls++;
		return { backupPath: "/tmp/state.json.invalid-1", preservedIdentity: true };
	}

	async findRecoveryBackup(): Promise<{ path: string; preservedIdentity: boolean } | undefined> {
		return undefined;
	}

	async recoverStateBackup(path: string): Promise<{ preservedIdentity: boolean }> {
		this.recoverCalls.push(path);
		return { preservedIdentity: true };
	}

	async registerCurrentWorkspace(path: string): Promise<{ name: string; path: string }> {
		this.registerCalls.push(path);
		if (this.registerError) throw this.registerError;
		const workspace = { name: this.registerName, path };
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
		access: IrohRemoteAccessPresetName,
		onProgress: (event: PairingProgress) => void,
	): Promise<RemotePairingHandle> {
		this.pairWorkspace = workspaceName;
		this.pairAccess = access;
		this.pairingProgress = onProgress;
		return {
			requestId: "pair-1",
			dispose: () => {
				this.pairDisposeCalls++;
			},
		};
	}

	async resetRelayCredential(): Promise<void> {
		this.resetCalls++;
		await this.resetPending;
		if (this.resetError) throw this.resetError;
		if (this.snapshot.kind === "online") {
			this.snapshot = {
				kind: "online",
				status: { ...this.snapshot.status, relayCredential: { state: "unpaired" } },
			};
		}
	}

	async checkRelayAccess(): Promise<void> {
		this.checkCalls++;
		if (this.checkError) throw this.checkError;
		if (this.checkResult && this.snapshot.kind === "online") {
			this.snapshot = {
				kind: "online",
				status: { ...this.snapshot.status, relayCredential: this.checkResult },
			};
		}
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

class EndpointUnavailableBackend extends FakeBackend {
	override async beginPairing(): Promise<RemotePairingHandle> {
		throw new RemoteControlRequestError("iroh_unavailable", "Iroh endpoint did not become ready within 15s");
	}

	override async findRecoveryBackup(): Promise<{ path: string; preservedIdentity: boolean }> {
		return { path: "/tmp/state.json.corrupt-1", preservedIdentity: true };
	}

	override async recoverStateBackup(path: string): Promise<{ preservedIdentity: boolean }> {
		this.recoverCalls.push(path);
		this.nextSnapshot = { kind: "online", status: status() };
		return { preservedIdentity: true };
	}
}

class DeferredPairBackend extends FakeBackend {
	pairCallbacks: Array<(event: PairingProgress) => void> = [];
	pairResolvers: Array<(handle: RemotePairingHandle) => void> = [];

	override beginPairing(
		workspaceName: string,
		access: IrohRemoteAccessPresetName,
		onProgress: (event: PairingProgress) => void,
	): Promise<RemotePairingHandle> {
		this.pairWorkspace = workspaceName;
		this.pairAccess = access;
		this.pairCallbacks.push(onProgress);
		return new Promise((resolve) => this.pairResolvers.push(resolve));
	}

	resolvePair(index: number): void {
		this.pairResolvers[index]?.({ requestId: `pair-${index}`, dispose: () => this.pairDisposeCalls++ });
	}
}

function createComponent(backend: FakeBackend, rows = 36, currentPath = "/tmp/volt") {
	const requestRender = vi.fn();
	const onClose = vi.fn();
	const copied: string[] = [];
	const component = new RemoteControlCenterComponent(backend, {
		getTerminalRows: () => rows,
		getCurrentWorkspaceName: () => "volt",
		getCurrentWorkspacePath: () => currentPath,
		currentSessionId: "session-current",
		requestRender,
		copyText: async (text) => {
			copied.push(text);
		},
		onClose,
	});
	return {
		component,
		requestRender,
		onClose,
		copied,
		setRows: (value: number) => {
			rows = value;
		},
	};
}

async function settle(): Promise<void> {
	for (let index = 0; index < 5; index++) await Promise.resolve();
}

/** Theme tone of the first rendered line containing `text`. */
function toneOf(component: RemoteControlCenterComponent, text: string, width = 120): string | undefined {
	const line = component.render(width).lines.find((candidate) => stripAnsi(candidate).includes(text));
	if (line === undefined) return undefined;
	return (["success", "warning", "error"] as const).find((tone) =>
		line.startsWith(theme.fg(tone, "\0").split("\0")[0]!),
	);
}

function selectAction(component: RemoteControlCenterComponent, label: string, width = 120): void {
	for (let attempt = 0; attempt < 30; attempt++) {
		const text = component.render(width).lines.map(stripAnsi).join("\n");
		if (text.includes(`› ${label}`)) {
			component.handleInput("\n");
			return;
		}
		component.handleInput("\x1b[B");
	}
	throw new Error(`Action not reachable: ${label}`);
}

async function showPairingQr(
	component: RemoteControlCenterComponent,
	backend: FakeBackend,
	ticket: string,
	width: number,
): Promise<void> {
	await component.start();
	selectAction(component, "Pair a phone", width);
	selectAction(component, "Coding", width);
	await settle();
	backend.pairingProgress?.({ type: "pairing_progress", requestId: "pair-1", phase: "ticket", ticket });
	component.render(width);
	component.handleInput("\x1b[A");
	component.handleInput("\x1b[A");
	selectAction(component, "Show pairing QR", width);
}

/** Decode the PNG payload carried by a Kitty graphics placement. */
function decodeKittyPng(sequence: string): { data: Buffer; width: number; height: number } {
	const base64 = sequence
		.split("\x1b\\")
		.filter((chunk) => chunk.startsWith("\x1b_G"))
		.map((chunk) => chunk.slice(chunk.indexOf(";") + 1))
		.join("");
	return png().decode(Buffer.from(base64, "base64"));
}

describe("RemoteControlCenterComponent", () => {
	let terminalCapabilities: TerminalCapabilities;
	let cellDimensions: CellDimensions;

	beforeAll(() => {
		initTheme(undefined, false);
	});

	beforeEach(() => {
		terminalCapabilities = getCapabilities();
		cellDimensions = getCellDimensions();
		// Text-QR expectations must not depend on the graphics protocol of the terminal running the tests.
		setCapabilities({ ...terminalCapabilities, images: null });
	});

	afterEach(() => {
		setCapabilities(terminalCapabilities);
		setCellDimensions(cellDimensions);
	});

	it("renders daemon, ownership, device, workspace, and headless policy status", async () => {
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 45);
		await component.start();
		const text = component.render(120).lines.map(stripAnsi).join("\n");

		expect(text).toContain("Remote Access");
		expect(text).toContain("Phone transport: ready · wrapper 1.1.1-volt.2");
		expect(text).toContain("1 attached phone · 1 paired device");
		expect(text).toContain("Current lease: tui-owned");
		expect(text).toContain("Register current directory");
		expect(text).toContain("Tools: read, bash");
		expect(text).toContain("Detached runtime retention: 30m");
		expect(text).toContain("Jordan's iPhone");
		expect(text).toContain("/tmp/volt");
	});

	it("allows pairing retries while storage-full degradation is recoverable", async () => {
		const backend = new FakeBackend({
			kind: "online",
			status: status({
				remoteTransport: {
					state: "degraded",
					reasonCode: "host_storage_full",
					message: "Computer storage is full. Free space on the computer, then retry.",
					wrapperVersion: "1.1.1-volt.2",
				},
			}),
		});
		const { component } = createComponent(backend, 45);
		await component.start();
		let text = component.render(120).lines.map(stripAnsi).join("\n");

		expect(text).toContain("Phone transport: degraded · wrapper 1.1.1-volt.2 · host_storage_full");
		expect(text).toContain("Computer storage is full");
		expect(text).toContain("Pair a phone");
		expect(text).not.toContain("Pairing is disabled until phone transport is ready");

		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.handleInput("\n");
		await settle();

		expect(backend.pairWorkspace).toBe("volt");
		expect(backend.pairAccess).toBe("coding");
		text = component.render(120).lines.map(stripAnsi).join("\n");
		expect(text).toContain("PAIR PHONE · volt · Coding");
	});

	it("blocks pairing when storage-full degradation is unavailable", async () => {
		const backend = new FakeBackend({
			kind: "online",
			status: status({
				remoteTransport: {
					state: "unavailable",
					reasonCode: "host_storage_full",
					message: "Computer storage is full. Free space on the computer, then retry.",
				},
			}),
		});
		const { component } = createComponent(backend, 45);
		await component.start();
		const text = component.render(120).lines.map(stripAnsi).join("\n");

		expect(text).toContain("Pairing is disabled until phone transport is ready");
		expect(text).not.toContain("Pair a phone");
	});

	it.each([
		["unpaired", "Not set up", true],
		["pairing", "Pairing in progress", false],
		["active", "Active", true],
		["expired", "Access expired", true],
		["subscription_inactive", "Volt Pro subscription inactive", false],
		["revocation_pending", "Credential reset pending", false],
	] as const)("explains %s relay access separately from endpoint readiness", async (state, label, canPair) => {
		const backend = new FakeBackend({ kind: "online", status: status({ relayCredential: { state } }) });
		const { component } = createComponent(backend, 45);
		await component.start();
		const text = component.render(120).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Daemon endpoint: ready");
		expect(text).toContain(`Relay access: ${label}`);
		expect(text).not.toContain("Phone transport: ready");
		expect(text.includes("  Pair a phone\n")).toBe(canPair);
		expect(text.includes("credentials and pair again…") || text.includes("credential reset and pair again…")).toBe(
			state !== "unpaired",
		);
		if (state === "subscription_inactive") {
			expect(text).toContain("Renew the existing subscription");
			expect(text).not.toContain("Restart voltd");
		}
	});

	it("defaults reset confirmation to Cancel and leaves credentials untouched", async () => {
		const backend = new FakeBackend({ kind: "online", status: status({ relayCredential: { state: "active" } }) });
		const { component } = createComponent(backend, 24);
		await component.start();
		selectAction(component, "Reset credentials and pair again…", 80);
		let text = component.render(80).lines.map(stripAnsi).join("\n");
		expect(text).toContain("RESET RELAY CREDENTIALS");
		expect(text).toContain("all its phones");
		expect(text).toContain("workspaces, worktrees, and conversations");
		expect(text).toContain("direct connections are NOT revoked");
		expect(text).toContain("› Cancel");
		expect(backend.resetCalls).toBe(0);
		component.handleInput("\n");
		await settle();
		text = component.render(80).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Relay access: Active");
		expect(backend.resetCalls).toBe(0);
	});

	it("resets once after confirmation and guides a fresh pairing without restarting or revoking devices", async () => {
		const backend = new FakeBackend({
			kind: "online",
			status: status({ relayCredential: { state: "subscription_inactive" } }),
		});
		const { component } = createComponent(backend, 36);
		await component.start();
		selectAction(component, "Reset credentials and pair again…");
		selectAction(component, "Reset credentials and pair again");
		component.handleInput("\n");
		await settle();
		expect(backend.resetCalls).toBe(1);
		expect(backend.startCalls).toBe(0);
		expect(backend.revokeCalls).toEqual([]);
		let text = component.render(120).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Relay credentials reset. Choose access for the new phone.");
		expect(text).toContain("PAIR A PHONE · ACCESS");
		expect(backend.pairWorkspace).toBeUndefined();
		component.handleInput("\n");
		await settle();
		expect(backend.pairWorkspace).toBe("volt");
		expect(backend.pairAccess).toBe("coding");
		backend.pairingProgress?.({
			type: "pairing_progress",
			requestId: "pair-1",
			phase: "ticket",
			ticket: verificationTicket(),
		});
		text = component.render(120).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Ticket ready");
		expect(text).toContain("Copy pairing ticket");
	});

	it("offers a confirmed retry after an offline reset failure without starting pairing", async () => {
		const backend = new FakeBackend({
			kind: "online",
			status: status({ relayCredential: { state: "revocation_pending" } }),
		});
		backend.resetError = new Error("Broker unavailable. Retry when online.");
		const { component } = createComponent(backend, 36);
		await component.start();
		selectAction(component, "Retry credential reset and pair again…");
		selectAction(component, "Retry reset and pair again");
		await settle();
		const text = component.render(120).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Reset failed: Broker unavailable. Retry when online.");
		expect(text).toContain("› Cancel");
		expect(backend.pairWorkspace).toBeUndefined();
		backend.resetError = undefined;
		selectAction(component, "Retry reset and pair again");
		await settle();
		expect(backend.resetCalls).toBe(2);
		expect(component.render(120).lines.map(stripAnsi).join("\n")).toContain("PAIR A PHONE · ACCESS");
	});

	it("reloads pending revocation status when escaping a failed reset", async () => {
		const backend = new FakeBackend({ kind: "online", status: status({ relayCredential: { state: "active" } }) });
		backend.resetError = new Error("Offline");
		const { component } = createComponent(backend, 36);
		await component.start();
		selectAction(component, "Reset credentials and pair again…");
		selectAction(component, "Reset credentials and pair again");
		await settle();
		backend.nextSnapshot = { kind: "online", status: status({ relayCredential: { state: "revocation_pending" } }) };
		component.handleInput("\x1b");
		await settle();
		const text = component.render(120).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Relay access: Credential reset pending");
		expect(text).toContain("Retry credential reset and pair again…");
		expect(text).not.toContain("  Pair a phone\n");
	});

	it("does not open pairing after the reset screen is disposed", async () => {
		const backend = new FakeBackend({ kind: "online", status: status({ relayCredential: { state: "expired" } }) });
		let finish: (() => void) | undefined;
		backend.resetPending = new Promise((resolve) => {
			finish = resolve;
		});
		const { component, requestRender } = createComponent(backend);
		await component.start();
		selectAction(component, "Reset credentials and pair again…");
		selectAction(component, "Reset credentials and pair again");
		component.dispose();
		const renders = requestRender.mock.calls.length;
		finish?.();
		await settle();
		expect(requestRender).toHaveBeenCalledTimes(renders);
		expect(backend.pairWorkspace).toBeUndefined();
	});

	it("retains workspace registration guidance after reset when no workspaces exist", async () => {
		const backend = new FakeBackend({
			kind: "online",
			status: status({ workspaces: [], relayCredential: { state: "expired" } }),
		});
		const { component } = createComponent(backend);
		await component.start();
		selectAction(component, "Reset credentials and pair again…");
		selectAction(component, "Reset credentials and pair again");
		await settle();
		const text = component.render(120).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Relay credentials reset. Register a workspace");
		expect(text).toContain("› Register current directory");
		expect(backend.pairWorkspace).toBeUndefined();
	});

	it("keeps credential status and reset confirmation within small viewports", async () => {
		for (const [width, rows] of [
			[24, 12],
			[80, 24],
			[120, 36],
		] as const) {
			const backend = new FakeBackend({
				kind: "online",
				status: status({ relayCredential: { state: "subscription_inactive" } }),
			});
			const { component } = createComponent(backend, rows);
			await component.start();
			selectAction(component, "Reset credentials and pair again…");
			const lines = component.render(width).lines;
			expect(lines).toHaveLength(rows);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	describe("relay access check", () => {
		it("uses distinct theme colors for notice tones", () => {
			const prefixes = (["success", "warning", "error"] as const).map((tone) => theme.fg(tone, "\0").split("\0")[0]);
			expect(new Set(prefixes).size).toBe(3);
		});

		it.each([
			["unpaired", false],
			["pairing", false],
			["active", false],
			["expired", true],
			["subscription_inactive", true],
			["revocation_pending", false],
		] as const)("offers the check and next automatic check for %s: %s", async (state, offered) => {
			const backend = new FakeBackend({
				kind: "online",
				status: status({ relayCredential: { state, nextRefreshAt: Date.now() + 14_500 } }),
			});
			const { component } = createComponent(backend, 45);
			await component.start();
			const text = component.render(120).lines.map(stripAnsi).join("\n");
			expect(text.includes("  Check relay access now")).toBe(offered);
			expect(text.includes("Next automatic check in 14s")).toBe(offered);
			if (offered) expect(text.replace(/\s+/g, " ")).toContain("choose Check relay access now");
		});

		it("shows a check in progress when no automatic check is scheduled", async () => {
			const backend = new FakeBackend({
				kind: "online",
				status: status({ relayCredential: { state: "subscription_inactive" } }),
			});
			const { component } = createComponent(backend, 45);
			await component.start();
			const text = component.render(120).lines.map(stripAnsi).join("\n");
			expect(text).toContain("Checking relay access now");
			expect(text).toContain("Renew the existing subscription");
		});

		it("restores relay access after renewal without resetting or pairing", async () => {
			const backend = new FakeBackend({
				kind: "online",
				status: status({
					relayCredential: { state: "subscription_inactive", nextRefreshAt: Date.now() + 3_600_000 },
				}),
			});
			backend.checkResult = { state: "active", expiresAt: Date.now() + 600_000 };
			const { component } = createComponent(backend, 45);
			await component.start();
			selectAction(component, "Check relay access now");
			await settle();
			expect(backend.checkCalls).toBe(1);
			expect(backend.resetCalls).toBe(0);
			expect(backend.pairWorkspace).toBeUndefined();
			const text = component.render(120).lines.map(stripAnsi).join("\n");
			expect(text).toContain("Relay access restored. Paired phones can reconnect.");
			expect(text).toContain("Relay access: Active");
			expect(text).not.toContain("Check relay access now");
			expect(toneOf(component, "Relay access restored.")).toBe("success");
		});

		it.each([
			{
				state: "subscription_inactive",
				notice: "Volt Pro is still inactive. If you just renewed, Apple can take a few minutes to confirm",
			},
			{ state: "expired", notice: "Relay access is still expired. Volt keeps retrying automatically." },
		] as const)("warns when relay access is still $state after a check", async ({ state, notice }) => {
			const backend = new FakeBackend({
				kind: "online",
				status: status({ relayCredential: { state, nextRefreshAt: Date.now() + 15_000 } }),
			});
			const { component } = createComponent(backend, 45);
			await component.start();
			selectAction(component, "Check relay access now");
			await settle();
			expect(backend.checkCalls).toBe(1);
			const text = component.render(120).lines.map(stripAnsi).join("\n");
			expect(text).toContain(notice);
			expect(toneOf(component, notice.slice(0, 30))).toBe("warning");
			// Selection stays on the action so the user can check again.
			expect(text).toContain("› Check relay access now");
		});

		it("reports a failed check as an error and keeps the action available", async () => {
			const backend = new FakeBackend({
				kind: "online",
				status: status({ relayCredential: { state: "subscription_inactive", nextRefreshAt: Date.now() + 15_000 } }),
			});
			backend.checkError = new RemoteControlRequestError(
				"relay_credential_check_failed",
				"relay credential refresh failed with status 503",
			);
			const { component } = createComponent(backend, 45);
			await component.start();
			selectAction(component, "Check relay access now");
			await settle();
			const text = component.render(120).lines.map(stripAnsi).join("\n");
			expect(text).toContain("Relay access check failed: relay credential refresh failed with status 503");
			expect(toneOf(component, "Relay access check failed")).toBe("error");
			expect(text).toContain("› Check relay access now");
		});

		it("ignores a check result after the screen is disposed", async () => {
			const backend = new FakeBackend({
				kind: "online",
				status: status({ relayCredential: { state: "expired" } }),
			});
			const { component, requestRender } = createComponent(backend);
			await component.start();
			selectAction(component, "Check relay access now");
			component.dispose();
			const renders = requestRender.mock.calls.length;
			await settle();
			expect(requestRender).toHaveBeenCalledTimes(renders);
		});

		it("keeps relay access recovery rows within small viewports", async () => {
			for (const [width, rows] of [
				[24, 12],
				[80, 24],
				[120, 36],
			] as const) {
				const backend = new FakeBackend({
					kind: "online",
					status: status({
						relayCredential: { state: "subscription_inactive", nextRefreshAt: Date.now() + 300_000 },
					}),
				});
				const { component } = createComponent(backend, rows);
				await component.start();
				selectAction(component, "Check relay access now", width);
				await settle();
				const lines = component.render(width).lines;
				expect(lines).toHaveLength(rows);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		});
	});

	it("labels default-tracking and deny-all device grants", async () => {
		const backend = new FakeBackend({
			kind: "online",
			status: status({
				clients: [
					{
						clientNodeId: "tracking-node-1234567890",
						label: "Tracking phone",
						pairedAtMs: Date.now() - 60_000,
						lastSeenAtMs: Date.now() - 5_000,
						allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(","),
						usesDefaultTools: true,
					},
					{
						clientNodeId: "denyall-node-1234567890",
						label: "Chat phone",
						pairedAtMs: Date.now() - 60_000,
						lastSeenAtMs: Date.now() - 5_000,
						allowedTools: [],
					},
				],
			}),
		});
		const { component } = createComponent(backend, 45);
		await component.start();
		const text = component.render(200).lines.map(stripAnsi).join("\n");

		expect(text).toContain(`Tools: ${DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(",").join(", ")} (default)`);
		expect(text).toContain("Tools: none");
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
		const text = component.render(100).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Detached runtime retention: not reported");
		expect(text).toContain("Tools: not reported");
		expect(text).toContain("Restart voltd to pair with explicit access grants");
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
			const lines = component.render(width).lines;
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
		component.render(80).lines;
		for (let index = 0; index < 4; index++) component.handleInput("\x1b[6~");
		const text = component.render(80).lines.map(stripAnsi).join("\n");
		expect(text).toContain("LEASES");
		expect(text).toContain("Current · volt/session-current");
	});

	it("starts an offline daemon and refreshes into the overview", async () => {
		const backend = new FakeBackend({ kind: "offline", state: "not-running" });
		const { component } = createComponent(backend);
		await component.start();
		expect(component.render(80).lines.map(stripAnsi).join("\n")).toContain("Start daemon");

		backend.nextSnapshot = { kind: "online", status: status() };
		component.handleInput("\n");
		await settle();
		expect(backend.startCalls).toBe(1);
		expect(component.render(80).lines.map(stripAnsi).join("\n")).toContain("Daemon started");
	});

	it("requires confirmation before backing up and regenerating invalid daemon state", async () => {
		const invalidSnapshot: RemoteControlSnapshot = {
			kind: "offline",
			state: "not-running",
			error: "Daemon state file /tmp/state.json is invalid or incompatible",
			invalidState: {
				path: "/tmp/state.json",
				error: "Daemon state file /tmp/state.json is invalid or incompatible",
			},
		};
		const backend = new FakeBackend(invalidSnapshot);
		const { component } = createComponent(backend);
		await component.start();
		let text = component.render(100).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Regenerate daemon state…");
		expect(text).toContain("preserves validated settings/identity when possible");

		component.handleInput("\n");
		expect(backend.regenerateCalls).toBe(0);
		text = component.render(100).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Confirm regenerate state");
		expect(text).toContain("timestamped backup");

		backend.nextSnapshot = { kind: "online", status: status() };
		component.handleInput("\n");
		await settle();
		expect(backend.regenerateCalls).toBe(1);
		expect(backend.startCalls).toBe(1);
		text = component.render(100).lines.map(stripAnsi).join("\n");
		expect(text).toContain(
			"Daemon state regenerated; backup saved to /tmp/state.json.invalid-1 · Iroh identity preserved",
		);
	});

	it("registers Volt's current directory when it is not available to the daemon", async () => {
		const backend = new FakeBackend({ kind: "online", status: status({ workspaces: [] }) });
		const { component } = createComponent(backend, 36);
		await component.start();
		component.render(100).lines;
		expect(component.render(100).lines.map(stripAnsi).join("\n")).toContain("Register current directory");

		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await settle();

		expect(backend.registerCalls).toEqual(["/tmp/volt"]);
		const text = component.render(100).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Registered directory: /tmp/volt (workspace volt).");
		expect(text).toContain("Current conversation unchanged.");
		expect(text).toContain("Current · volt · /tmp/volt");
		expect(text).toContain("Pair a phone");
	});

	it("does not register a directory when opening or refreshing the overview", async () => {
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 36, "/tmp/volt/child");
		await component.start();
		selectAction(component, "Refresh status");
		await settle();
		expect(backend.registerCalls).toEqual([]);
	});

	it("lists the registered child while preserving the active parent workspace and lease", async () => {
		const originalStatus = status();
		const backend = new FakeBackend({ kind: "online", status: originalStatus });
		backend.registerName = "child";
		const { component } = createComponent(backend, 50, "/tmp/volt/child");
		await component.start();
		selectAction(component, "Register current directory");
		await settle();
		const text = component.render(120).lines.map(stripAnsi).join("\n");
		expect(backend.registerCalls).toEqual(["/tmp/volt/child"]);
		expect(text).toContain("Registered directory: /tmp/volt/child (workspace child).");
		expect(text).toContain("Current conversation unchanged.");
		expect(text).toContain("Current · volt · /tmp/volt");
		expect(text).toContain("child · /tmp/volt/child");
		expect(text).not.toContain("Current · child");
		expect(text).toContain("Current · volt/session-current · tui-owned");
		if (backend.snapshot.kind === "online") expect(backend.snapshot.status.leases).toEqual(originalStatus.leases);
	});

	it.each([false, true])("shows registration errors even if the daemon goes offline: %s", async (offline) => {
		const backend = new FakeBackend({ kind: "online", status: status() });
		backend.registerError = new Error(
			"Use parent workspace volt; managed worktrees cannot be registered separately.",
		);
		const { component } = createComponent(backend, 24, "/tmp/worktree");
		await component.start();
		if (offline) backend.nextSnapshot = { kind: "offline", state: "not-running" };
		selectAction(component, "Register current directory", 80);
		await settle();
		const lines = component.render(80).lines;
		const text = lines.map(stripAnsi).join("\n");
		expect(text).toContain("Workspace registration failed:");
		if (!offline) expect(toneOf(component, "Workspace registration failed:", 80)).toBe("error");
		expect(text).toContain("Use parent workspace volt;");
		expect(text).toContain("cannot be registered separately.");
		expect(text).not.toContain("Registered directory:");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	it("pairs the current workspace, preserves ticket progress, and copies the ticket", async () => {
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component, copied } = createComponent(backend, 24);
		await component.start();
		component.render(40).lines;
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		let text = component.render(80).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Choose what this phone may do");
		expect(text).toContain("Everything: API keys, log upload, host control, worktrees, and workspaces");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await settle();
		expect(backend.pairWorkspace).toBe("volt");
		expect(backend.pairAccess).toBe("full");

		backend.pairingProgress?.({
			type: "pairing_progress",
			requestId: "pair-1",
			phase: "ticket",
			ticket: "volt+iroh://v1/test-pairing-ticket",
		});
		backend.pairingProgress?.({ type: "pairing_progress", requestId: "pair-1", phase: "waiting" });
		text = component.render(40).lines.map(stripAnsi).join("\n");
		expect(text).toContain("PAIR PHONE · volt · Full access");
		expect(text).toContain("Scan with Volt, then compare");
		expect(text).toContain("Show pairing QR");

		component.handleInput("\x1b[A");
		component.handleInput("\n");
		await settle();
		expect(copied).toEqual(["volt+iroh://v1/test-pairing-ticket"]);
		text = component.render(40).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Pairing ticket copied");

		component.handleInput("\x1b");
		expect(backend.pairDisposeCalls).toBe(1);
		expect(component.render(40).lines.map(stripAnsi).join("\n")).toContain("HEADLESS POLICY");
	});

	it("shows full safe pairing verification details at the narrow review size", async () => {
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 24);
		await component.start();
		component.render(80).lines;
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.handleInput("\n");
		await settle();
		backend.pairingProgress?.({
			type: "pairing_progress",
			requestId: "pair-1",
			phase: "ticket",
			ticket: verificationTicket(),
		});
		backend.pairingProgress?.({ type: "pairing_progress", requestId: "pair-1", phase: "waiting" });

		const lines = component.render(80).lines;
		const text = lines.map(stripAnsi).join("\n");
		expect(lines).toHaveLength(24);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		expect(text).toContain("630DCD29-66C43366-91125448-BBB25B4F");
		expect(text).toContain(PAIRING_HOST_NODE_ID);
		expect(text).toContain("Workspace\n  volt");
		expect(text).toContain("Relay mode\n  production");
		expect(text).toContain("https://relay-a.example:8443");
		expect(text).toContain("https://relay-b.example");
		expect(text).toContain("https://relay-a.example:8443\n  https://relay-b.example");
		expect(text).toContain("2027-01-15T08:00:00.000Z");
		expect(text).toContain("Copy pairing ticket");
		expect(text).not.toContain("pairing-secret-must-not-render");
		expect(text).not.toContain("relay-auth-must-not-render");
	});

	it("keeps the selected access preset when a workspace choice is required", async () => {
		const backend = new FakeBackend({
			kind: "online",
			status: status({
				workspaces: [
					{ name: "alpha", path: "/tmp/alpha" },
					{ name: "beta", path: "/tmp/beta" },
				],
			}),
		});
		const { component } = createComponent(backend, 24);
		await component.start();
		component.render(80).lines;
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.render(80).lines;
		component.handleInput("\x1b[B");
		component.handleInput("\n");

		let text = component.render(80).lines.map(stripAnsi).join("\n");
		expect(text).toContain("PAIR A PHONE · Review");
		expect(text).toContain("Choose the phone's initial workspace");

		component.handleInput("\x1b");
		text = component.render(80).lines.map(stripAnsi).join("\n");
		expect(text).toContain("PAIR A PHONE · ACCESS");

		component.handleInput("\n");
		component.handleInput("\n");
		await settle();
		expect(backend.pairWorkspace).toBe("alpha");
		expect(backend.pairAccess).toBe("review");
	});

	it("offers confirmed state recovery after endpoint readiness times out", async () => {
		const backend = new EndpointUnavailableBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 36);
		await component.start();
		component.render(100).lines;
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.handleInput("\n");
		await settle();

		let text = component.render(100).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Iroh endpoint did not become ready within 15s");
		expect(text).toContain("Recover previous daemon state…");

		component.handleInput("\n");
		expect(backend.recoverCalls).toEqual([]);
		text = component.render(100).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Confirm recover and restart");
		expect(text).toContain("Legacy access records are dropped");

		component.handleInput("\n");
		await settle();
		expect(backend.recoverCalls).toEqual(["/tmp/state.json.corrupt-1"]);
		text = component.render(100).lines.map(stripAnsi).join("\n");
		expect(text).toContain("Recovered daemon state and preserved the Iroh identity");
	});

	it("ignores progress from a cancelled stale pairing attempt", async () => {
		const backend = new DeferredPairBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 36);
		await component.start();
		component.render(100).lines;
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.handleInput("\n");
		component.handleInput("\x1b");
		component.render(100).lines;
		component.handleInput("\n");
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
		expect(component.render(100).lines.map(stripAnsi).join("\n")).not.toContain("stale failure");

		backend.resolvePair(1);
		await settle();
		backend.pairCallbacks[1]?.({
			type: "pairing_progress",
			requestId: "pair-1",
			phase: "waiting",
		});
		expect(component.render(100).lines.map(stripAnsi).join("\n")).toContain("Scan with Volt, then compare");
	});

	it("renders a complete QR only when the viewport can contain it", async () => {
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 50);
		await component.start();
		component.render(160).lines;
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.handleInput("\n");
		await settle();
		backend.pairingProgress?.({
			type: "pairing_progress",
			requestId: "pair-1",
			phase: "ticket",
			ticket: verificationTicket(),
		});
		let lines = component.render(160).lines;
		expect(lines.map(stripAnsi).join("\n")).toContain("Show pairing QR");
		component.handleInput("\x1b[A");
		component.handleInput("\x1b[A");
		component.handleInput("\n");
		lines = component.render(160).lines;
		const text = lines.map(stripAnsi).join("\n");
		expect(text).not.toContain("Enlarge the terminal");
		expect(text).toMatch(/[▀▄█]/);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(160);

		backend.pairingProgress?.({
			type: "pairing_progress",
			requestId: "pair-1",
			phase: "completed",
			clientNodeId: "paired-phone",
		});
		const completed = component.render(160).lines.map(stripAnsi).join("\n");
		expect(completed).toContain("Pairing complete");
		expect(completed).toContain("Paired paired-phone");
		expect(completed).not.toMatch(/[▀▄█]/);
	});

	it("renders the pairing QR as an inline image in a standard Windows Terminal viewport", async () => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 24);
		try {
			await component.start();
			component.render(80).lines;
			component.handleInput("\x1b[B");
			component.handleInput("\x1b[B");
			component.handleInput("\n");
			component.handleInput("\n");
			await settle();
			backend.pairingProgress?.({
				type: "pairing_progress",
				requestId: "pair-1",
				phase: "ticket",
				ticket: verificationTicket(),
			});
			backend.pairingProgress?.({ type: "pairing_progress", requestId: "pair-1", phase: "waiting" });

			let frame = component.render(80);
			expect(frame.lines.some((line) => stripAnsi(line).includes("Show pairing QR"))).toBe(true);
			component.handleInput("\x1b[A");
			component.handleInput("\x1b[A");
			component.handleInput("\n");
			frame = component.render(80);

			expect(frame.lines).toHaveLength(24);
			expect(frame.images).toHaveLength(1);
			expect(frame.images[0]).toMatchObject({ protocol: "sixel", top: 1 });
			expect(frame.images[0]!.columns).toBeLessThanOrEqual(80);
			expect(frame.images[0]!.rows).toBeLessThanOrEqual(19);
			expect(frame.lines.some((line) => stripAnsi(line).includes("Show verification details"))).toBe(true);
			expect(frame.lines.some((line) => stripAnsi(line).includes("QR needs"))).toBe(false);
		} finally {
			component.dispose();
		}
	});

	it("caps inline pairing QR modules at 4 px in a large Sixel terminal", async () => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		const ticket = managedRelayTicket();
		const sidePx = (createIrohRemoteTicketQrCode(ticket).size + IROH_REMOTE_QR_QUIET_ZONE_MODULES * 2) * 4;
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 80);
		try {
			await showPairingQr(component, backend, ticket, 300);

			const frame = component.render(300);
			expect(frame.lines).toHaveLength(80);
			expect(frame.images).toHaveLength(1);
			expect(frame.images[0]).toMatchObject({
				protocol: "sixel",
				top: 1,
				columns: Math.ceil(sidePx / 9),
				rows: Math.ceil(sidePx / 18),
			});
			const text = frame.lines.map(stripAnsi).join("\n");
			for (const label of ["PAIR QR · volt", "Show verification details", "Copy pairing ticket", "Cancel pairing"]) {
				expect(text).toContain(label);
			}
		} finally {
			component.dispose();
		}
	});

	it("sends a pixel-exact pairing QR image that fills whole cells", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		const ticket = managedRelayTicket();
		const qrCode = createIrohRemoteTicketQrCode(ticket);
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 24);
		try {
			await showPairingQr(component, backend, ticket, 80);

			const placement = component.render(80).images[0]!;
			expect(placement).toMatchObject({ protocol: "kitty", top: 1 });
			const image = decodeKittyPng(placement.sequence);
			// A canvas that exactly fills its cells is displayed 1:1 instead of being resampled.
			expect(image.width).toBe(placement.columns * 9);
			expect(image.height).toBe(placement.rows * 18);

			const isDark = (x: number, y: number): boolean => image.data[(y * image.width + x) * 4] === 0;
			let [left, top, right, bottom] = [image.width, image.height, -1, -1];
			for (let y = 0; y < image.height; y++) {
				for (let x = 0; x < image.width; x++) {
					if (!isDark(x, y)) continue;
					[left, top, right, bottom] = [
						Math.min(left, x),
						Math.min(top, y),
						Math.max(right, x),
						Math.max(bottom, y),
					];
				}
			}
			const modulePixels = (right - left + 1) / qrCode.size;
			// 19 image rows of 18 px bound the square at 80x24; modules use the largest whole size that fits.
			expect(modulePixels).toBe(Math.floor((19 * 18) / (qrCode.size + IROH_REMOTE_QR_QUIET_ZONE_MODULES * 2)));
			expect(bottom - top + 1).toBe(qrCode.size * modulePixels);
			expect(Math.min(left, top, image.width - 1 - right, image.height - 1 - bottom)).toBeGreaterThanOrEqual(
				IROH_REMOTE_QR_QUIET_ZONE_MODULES * modulePixels,
			);
			let mismatchedPixels = 0;
			for (let y = top; y <= bottom; y++) {
				for (let x = left; x <= right; x++) {
					const module =
						qrCode.modules[Math.floor((y - top) / modulePixels)]![Math.floor((x - left) / modulePixels)];
					if (isDark(x, y) !== module) mismatchedPixels++;
				}
			}
			expect(mismatchedPixels).toBe(0);
		} finally {
			component.dispose();
		}
	});

	it("falls back to text QR guidance when the terminal cannot draw the pairing image", async () => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		// A single 1100 px cell already exceeds the Sixel raster budget, so the image render fails.
		setCellDimensions({ widthPx: 1100, heightPx: 1100 });
		const ticket = managedRelayTicket();
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 24);
		try {
			await showPairingQr(component, backend, ticket, 80);

			const frame = component.render(80);
			const text = frame.lines.map(stripAnsi).join("\n");
			expect(frame.images).toHaveLength(0);
			expect(text).not.toContain("PAIR QR");
			expect(text).toContain("available: 80 × 24.");
			expect(text).toContain("Show verification details");
			expect(text).toContain("Copy pairing ticket");
		} finally {
			component.dispose();
		}
	});

	it("fits a complete managed-relay QR and all actions in a 252x53 terminal", async () => {
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component, copied } = createComponent(backend, 53);
		await component.start();
		selectAction(component, "Pair a phone", 252);
		selectAction(component, "Coding", 252);
		await settle();
		const ticket = managedRelayTicket();
		backend.pairingProgress?.({ type: "pairing_progress", requestId: "pair-1", phase: "ticket", ticket });
		component.render(252);
		component.handleInput("\x1b[A");
		component.handleInput("\x1b[A");
		selectAction(component, "Show pairing QR", 252);

		const lines = component.render(252).lines.map(stripAnsi);
		const qrLines = formatIrohRemoteTicketQrCode(ticket).trimEnd().split("\n");
		expect(lines).toHaveLength(53);
		expect(lines.slice(1, 1 + qrLines.length)).toEqual(qrLines);
		expect(lines.join("\n")).toContain("PAIR QR · volt");
		for (const label of ["Show verification details", "Copy pairing ticket", "Cancel pairing"]) {
			expect(lines.join("\n")).toContain(label);
		}
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(252);

		selectAction(component, "Show verification details", 252);
		expect(component.render(252).lines.map(stripAnsi).join("\n")).toContain(PAIRING_HOST_NODE_ID);
		selectAction(component, "Show pairing QR", 252);
		selectAction(component, "Copy pairing ticket", 252);
		await settle();
		expect(copied).toEqual([ticket]);
		selectAction(component, "Cancel pairing", 252);
		expect(backend.pairDisposeCalls).toBe(1);
		expect(component.render(252).lines.map(stripAnsi).join("\n")).toContain("Remote Access");
	});

	it.each(["width", "height"] as const)(
		"hides the entire QR below its minimum %s and restores it after resize",
		async (dimension) => {
			const ticket = managedRelayTicket();
			const qrLines = formatIrohRemoteTicketQrCode(ticket).trimEnd().split("\n");
			const requiredWidth = Math.max(...qrLines.map(visibleWidth));
			const requiredHeight = qrLines.length + 5;
			let width = dimension === "width" ? requiredWidth - 1 : requiredWidth;
			const height = dimension === "height" ? requiredHeight - 1 : requiredHeight;
			const backend = new FakeBackend({ kind: "online", status: status() });
			const { component, setRows } = createComponent(backend, height);
			await component.start();
			selectAction(component, "Pair a phone", width);
			selectAction(component, "Coding", width);
			await settle();
			backend.pairingProgress?.({ type: "pairing_progress", requestId: "pair-1", phase: "ticket", ticket });
			const warning = `QR needs ${requiredWidth} columns × ${requiredHeight} rows; available: ${width} × ${height}.`;
			let text = component.render(width).lines.map(stripAnsi).join("\n");
			expect(text).toContain(warning);
			expect(text).not.toContain("Show pairing QR");
			expect(text).not.toMatch(/[▀▄█]/);
			expect(text).not.toContain(ticket);

			width = requiredWidth;
			setRows(requiredHeight);
			component.render(width);
			component.handleInput("\x1b[A");
			component.handleInput("\x1b[A");
			selectAction(component, "Show pairing QR", width);
			let lines = component.render(width).lines.map(stripAnsi);
			expect(lines).toHaveLength(requiredHeight);
			expect(lines.slice(1, 1 + qrLines.length)).toEqual(qrLines);
			component.handleInput("\x1b[6~");
			expect(component.render(width).lines.map(stripAnsi)).toEqual(lines);

			width = dimension === "width" ? requiredWidth - 1 : requiredWidth;
			setRows(height);
			text = component.render(width).lines.map(stripAnsi).join("\n");
			expect(text).toContain(warning);
			expect(text).not.toMatch(/[▀▄█]/);
			expect(text).toContain("Copy pairing ticket");
			expect(text).toContain("Show verification details");
			expect(text).not.toContain(ticket);

			width = requiredWidth;
			setRows(requiredHeight);
			lines = component.render(width).lines.map(stripAnsi);
			expect(lines.slice(1, 1 + qrLines.length)).toEqual(qrLines);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			component.handleInput("\x1b");
			expect(backend.pairDisposeCalls).toBe(1);
		},
	);

	it("requires confirmation before revoking a paired device", async () => {
		const backend = new FakeBackend({ kind: "online", status: status() });
		const { component } = createComponent(backend, 36);
		await component.start();
		component.render(100).lines;
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		expect(backend.revokeCalls).toEqual([]);
		expect(component.render(100).lines.map(stripAnsi).join("\n")).toContain("Confirm revoke");

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
		component.render(100).lines;
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");

		expect(backend.repairApprovalCalls).toEqual([]);
		expect(component.render(100).lines.map(stripAnsi).join("\n")).toContain("Confirm allow re-pair");

		component.handleInput("\n");
		await settle();
		expect(backend.repairApprovalCalls).toEqual([revokedNodeId]);
		const text = component.render(100).lines.map(stripAnsi).join("\n");
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
		const rendered = component.render(100).lines.join("\n");
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
