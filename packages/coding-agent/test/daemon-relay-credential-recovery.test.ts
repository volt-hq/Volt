import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { decodeIrohRemoteTicketPayload } from "../src/core/remote/iroh/ticket.ts";
import type { IrohBiStreamLike } from "../src/core/rpc/iroh-transport.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import { createDaemonClient, type DaemonClient } from "../src/daemon/control-client.ts";
import { type ControlEvent, type ControlResponse, isControlResponse } from "../src/daemon/control-protocol.ts";
import type {
	IrohHomeRelayWatchCallback,
	IrohIncomingLike,
	IrohModuleLike,
	IrohRelayConfigLike,
} from "../src/daemon/iroh-native.ts";
import {
	createIrohDaemonService,
	type IrohDaemonServiceConfig,
	VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL,
	VOLT_PRODUCTION_RELAY_URLS,
} from "../src/daemon/iroh-service.ts";
import { runVoltDaemon } from "../src/daemon/main.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import type { IrohManagedRelayCredential } from "../src/daemon/relay-credential.ts";
import { probeDaemon } from "../src/daemon/spawn.ts";
import { createEmptyVoltdState, type VoltdStateFileV1 } from "../src/daemon/state.ts";

const HOST = "a".repeat(64);
const OLD_PHONE = "b".repeat(64);
const NEW_PHONE = "c".repeat(64);
const CLAIM = "d".repeat(24);

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function jsonResponse(body: object, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function credential(lifetimeMs = 600_000): IrohManagedRelayCredential {
	return {
		schemaVersion: 2,
		serviceUrl: VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL,
		relayUrls: [...VOLT_PRODUCTION_RELAY_URLS],
		endpointNodeId: HOST,
		endpointId: "host-endpoint-original",
		grantId: "original-grant-id",
		accessToken: "original.payload.signature",
		accessTokenExpiresAt: Date.now() + lifetimeMs,
		refreshToken: `vrr_${"r".repeat(43)}`,
	};
}

function approvedExchange(phone = NEW_PHONE, grantId = "fresh-bootstrap-grant", endpointId = "fresh-host-endpoint") {
	return jsonResponse({
		grantId,
		endpointId,
		hostNodeId: HOST,
		appEndpointId: `app-endpoint-${phone.slice(0, 8)}`,
		appNodeId: phone,
		credential: {
			accessToken: "fresh.payload.signature",
			accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
			tokenType: "Bearer",
		},
	});
}

/** In-memory native boundary; broker calls are separately intercepted by fetch. */
function fakeIroh() {
	let incoming = deferred<IrohIncomingLike | undefined>();
	let watcher: IrohHomeRelayWatchCallback | undefined;
	const reconnects: IrohRelayConfigLike[] = [];
	const removals: string[] = [];
	const boundTokens: IrohRelayConfigLike[] = [];
	let removeFailure = false;
	let binds = 0;
	const module: IrohModuleLike = {
		bindingCapabilities: () => ({ connectedHomeRelayWatch: true, reconnectRelay: true }),
		Endpoint: {
			builder: () => ({
				relayMode() {},
				secretKey() {},
				alpns() {},
				async bind() {
					binds++;
					return {
						id: () => ({ toString: () => HOST }),
						addr: () => HOST,
						secretKey: () => ({ toBytes: () => Array<number>(32).fill(7) }),
						async online() {},
						async close() {
							incoming.resolve(undefined);
						},
						acceptNext: () => incoming.promise,
						async reconnectRelay(config) {
							reconnects.push(config);
							watcher?.(null, [config.url]);
						},
						async removeRelay(url) {
							removals.push(url);
							if (removeFailure) throw new Error("injected native removal failure");
							return true;
						},
						watchHomeRelay(callback) {
							watcher = callback;
							return {
								async stop() {
									watcher = undefined;
								},
							};
						},
					};
				},
			}),
		},
		EndpointTicket: { fromAddr: () => ({ toString: () => "fake-native-ticket" }) },
		RelayMap: {
			empty: () => ({
				insert: (config) => {
					boundTokens.push(config);
				},
			}),
		},
		RelayMode: { disabled() {}, custom() {}, customFromUrls() {} },
		presetMinimal() {},
		presetN0() {},
		presetN0DisableRelay() {},
	};
	return {
		module,
		reconnects,
		removals,
		boundTokens,
		get binds() {
			return binds;
		},
		set removeFailure(value: boolean) {
			removeFailure = value;
		},
		async pair(ticket: string, phone: string): Promise<Record<string, unknown>> {
			const payload = decodeIrohRemoteTicketPayload(ticket);
			const response = deferred<Record<string, unknown>>();
			const closed = deferred<void>();
			let delivered = false;
			let opened = false;
			const stream: IrohBiStreamLike = {
				recv: {
					async read() {
						if (delivered) return undefined;
						delivered = true;
						return Array.from(
							Buffer.from(
								`${JSON.stringify({ type: "volt_iroh_hello", protocol: "volt-rpc/0", workspace: payload.workspace, workspaceDiscovery: { purpose: "list_sessions" }, secret: payload.secret, clientLabel: "Fresh phone" })}\n`,
							),
						);
					},
					async stop() {},
				},
				send: {
					async writeAll(bytes) {
						response.resolve(JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>);
					},
					async finish() {},
					async reset() {},
				},
			};
			const next = incoming;
			incoming = deferred<IrohIncomingLike | undefined>();
			next.resolve({
				async refuse() {},
				async accept() {
					return {
						async connect() {
							return {
								remoteId: () => ({ toString: () => phone }),
								setMaxConcurrentBiStreams() {},
								close() {
									closed.resolve();
								},
								closed: () => closed.promise,
								async acceptBi() {
									if (!opened) {
										opened = true;
										return stream;
									}
									await closed.promise;
									throw new Error("done");
								},
							};
						},
					};
				},
			});
			try {
				return await response.promise;
			} finally {
				closed.resolve();
			}
		},
	};
}

async function startFixture(
	options: { state?: VoltdStateFileV1; config?: IrohDaemonServiceConfig; missingNative?: boolean } = {},
) {
	const agentDir = mkdtempSync(join(tmpdir(), "volt-relay-recovery-"));
	const paths = getDaemonPaths(agentDir);
	mkdirSync(paths.daemonDir, { recursive: true });
	const state = options.state ?? createEmptyVoltdState();
	state.irohSecretKey = Array<number>(32).fill(7);
	state.settings.worktreeCleanup = { pruneOnStart: false };
	writeFileSync(paths.statePath, JSON.stringify(state));
	const native = fakeIroh();
	const daemon = runVoltDaemon({ agentDir, foreground: false }, [
		createIrohDaemonService(options.config, {
			loadIrohModule: () =>
				options.missingNative
					? { error: new Error("missing binding") }
					: {
							iroh: native.module,
							capabilities: native.module.bindingCapabilities(),
						},
		}),
	]);
	let probe = await probeDaemon(agentDir);
	for (let attempts = 0; !probe.healthy && attempts < 100; attempts++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		probe = await probeDaemon(agentDir);
	}
	expect(probe.healthy).toBe(true);
	const events: ControlEvent[] = [];
	const control = createDaemonClient({
		onEvent: (event) => {
			events.push(event);
		},
		socketPath: probe.socketPath,
		authToken: probe.authToken,
		version: "test",
		client: "tui",
		reconnect: false,
	});
	return {
		agentDir,
		native,
		control,
		events,
		readState: () => JSON.parse(readFileSync(paths.statePath, "utf8")) as VoltdStateFileV1,
		async close() {
			await control.request({ type: "shutdown" });
			await expect(daemon).resolves.toBe(0);
			await control.close();
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

async function status(control: DaemonClient): Promise<Extract<ControlResponse, { type: "status_result" }>> {
	const result = await control.request({ type: "status" });
	if (result.type !== "status_result") throw new Error("status missing");
	return result;
}

beforeEach(() => {
	vi.stubEnv("VOLT_IROH_RELAY_MODE", undefined);
	vi.stubEnv("VOLT_IROH_RELAY_URLS", undefined);
	vi.stubEnv("VOLT_IROH_RELAY_AUTH_TOKEN", undefined);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected broker request"));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("managed relay credential recovery", () => {
	it("validates credential status without requiring it for non-managed relays", () => {
		const base = { type: "status_result", id: "status", remoteTransport: { state: "ready" } };
		expect(isControlResponse(base)).toBe(true);
		for (const state of ["unpaired", "pairing", "active", "expired", "subscription_inactive", "revocation_pending"]) {
			expect(isControlResponse({ ...base, relayCredential: { state, expiresAt: 123 } })).toBe(true);
		}
		for (const relayCredential of [
			{ state: "unknown" },
			{ state: ["active"] },
			{ state: "active", expiresAt: "123" },
			{ state: "expired", expiresAt: -1 },
		]) {
			expect(isControlResponse({ ...base, relayCredential })).toBe(false);
		}
	});

	it.each(["unpaired", "active", "expired"] as const)(
		"reports %s independently of endpoint readiness",
		async (stateName) => {
			const state = createEmptyVoltdState();
			if (stateName !== "unpaired")
				state.settings.relayCredential = credential(stateName === "expired" ? -1 : 600_000);
			const fixture = await startFixture({ state });
			try {
				await expect.poll(async () => (await status(fixture.control)).remoteTransport.state).toBe("ready");
				const current = await status(fixture.control);
				expect(current.relayCredential).toEqual({
					state: stateName,
					...(state.settings.relayCredential
						? { expiresAt: state.settings.relayCredential.accessTokenExpiresAt }
						: {}),
				});
				expect(JSON.stringify(current.relayCredential)).not.toContain("Token");
				if (stateName === "expired") expect(fixture.native.boundTokens).toEqual([]);
			} finally {
				await fixture.close();
			}
		},
	);

	it.each([
		{ relayMode: "disabled" },
		{ relayUrls: ["https://self-managed.example.com"], relayAuthToken: "static-token" },
	] satisfies IrohDaemonServiceConfig[])("omits relay status for non-managed setup %j", async (config) => {
		const fixture = await startFixture({ config });
		try {
			expect((await status(fixture.control)).relayCredential).toBeUndefined();
		} finally {
			await fixture.close();
		}
	});

	it("reports persisted expiry even when the native binding is missing", async () => {
		const state = createEmptyVoltdState();
		state.settings.relayCredential = credential(-1);
		const fixture = await startFixture({ state, missingNative: true });
		try {
			expect(await status(fixture.control)).toMatchObject({
				relayCredential: { state: "expired" },
				remoteTransport: { reasonCode: "native_binding_missing" },
			});
		} finally {
			await fixture.close();
		}
	});

	it("resets an inactive subscription, retries revocation, and bootstraps a different phone without restart", async () => {
		const state = createEmptyVoltdState();
		const original = credential(-1);
		state.settings.relayCredential = original;
		state.workspaces = [{ name: "saved", path: tmpdir() }];
		state.worktrees = [
			{
				id: "saved-tree",
				workspaceName: "saved",
				path: join(tmpdir(), "saved-checkout"),
				branch: "saved-branch",
				createdAt: 1,
				sessionIds: ["saved-session"],
			},
		];
		const access = createIrohRemotePresetAccess("review");
		state.clients = [
			{
				nodeId: OLD_PHONE,
				label: "Original phone",
				allowedWorkspaces: ["*"],
				pairedAt: 1,
				lastSeenAt: 2,
				allowedTools: access.allowedTools,
				rpcGrant: access.rpcGrant,
			},
		];
		const oldClients = structuredClone(state.clients);
		let brokerAvailable = false;
		let revokeCount = 0;
		let claimBody: Record<string, unknown> | undefined;
		const revokeGate = deferred<void>();
		const exchangeGate = deferred<void>();
		vi.mocked(fetch).mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.endsWith("/tokens/refresh"))
				return jsonResponse({ error: "subscription_inactive" }, 402, { "Retry-After": "3600" });
			if (url.endsWith("/grant/revoke")) {
				revokeCount++;
				if (!brokerAvailable) {
					await revokeGate.promise;
					return new Response(null, { status: 503 });
				}
				return new Response(null, { status: 204 });
			}
			if (url.endsWith("/pairing-claims")) {
				claimBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				expect(new Headers(init?.headers).has("Authorization")).toBe(false);
				return jsonResponse({ claimId: CLAIM, expiresAt: new Date(Date.now() + 600_000).toISOString() }, 201);
			}
			if (url.endsWith("/exchange")) {
				await exchangeGate.promise;
				return approvedExchange();
			}
			throw new Error(`unexpected request ${url}`);
		});
		const fixture = await startFixture({ state });
		try {
			await expect
				.poll(async () => (await status(fixture.control)).relayCredential?.state)
				.toBe("subscription_inactive");
			expect(
				await fixture.control.request({ type: "workspace_register", name: "repo", path: fixture.agentDir }),
			).toMatchObject({ type: "ok" });
			expect(
				await fixture.control.request({ type: "lease_acquire", workspaceName: "repo", sessionId: "local-session" }),
			).toMatchObject({ type: "lease_granted" });
			const sessionDir = getDefaultSessionDir(fixture.agentDir, fixture.agentDir);
			const localSession = await SessionManager.create(fixture.agentDir, sessionDir, { id: "local-session" });
			localSession.appendSessionInfo("Preserved local session");
			await localSession.materialize();
			await localSession.closePersistence();
			const before = await status(fixture.control);
			const beforeWorktrees = fixture.readState().worktrees;
			const reset = fixture.control.request({ type: "relay_credential_revoke" });
			await expect.poll(() => revokeCount).toBe(1);
			expect((await status(fixture.control)).relayCredential).toEqual({ state: "revocation_pending" });
			expect(await fixture.control.request({ type: "relay_credential_revoke" })).toMatchObject({
				type: "error",
				message: expect.stringContaining("already in progress"),
			});
			expect(await fixture.control.request({ type: "pair_request" })).toMatchObject({
				type: "error",
				code: "relay_credential_revocation_pending",
			});
			expect(fixture.events.filter((event) => event.type === "pairing_progress")).toEqual([]);
			revokeGate.resolve();
			expect(await reset).toMatchObject({ type: "error", message: expect.stringContaining("Retry the reset") });
			expect(fixture.readState().settings.relayCredentialRevocation?.refreshToken).toBe(original.refreshToken);
			brokerAvailable = true;
			expect(await fixture.control.request({ type: "relay_credential_revoke" })).toMatchObject({ type: "ok" });
			expect((await status(fixture.control)).relayCredential).toEqual({ state: "unpaired" });
			expect(fixture.readState().clients).toEqual(oldClients);
			const after = await status(fixture.control);
			expect(after.workspaces).toEqual(before.workspaces);
			expect(after.leases).toEqual(before.leases);
			expect(fixture.readState().irohSecretKey).toEqual(state.irohSecretKey);
			expect(fixture.readState().worktrees).toEqual(beforeWorktrees);
			const savedSession = await SessionManager.findForResume(sessionDir, "local-session");
			if (savedSession === undefined) throw new Error("local session was removed");
			const reopened = await SessionManager.open(savedSession);
			expect(reopened.getSessionName()).toBe("Preserved local session");
			await reopened.closePersistence();
			const pair = await fixture.control.request({ type: "pair_request", workspaceName: "repo" });
			expect(pair.type).toBe("pair_started");
			expect((await status(fixture.control)).relayCredential?.state).toBe("pairing");
			expect(claimBody).toMatchObject({ hostNodeId: HOST, hostRefreshTokenHash: expect.any(String) });
			exchangeGate.resolve();
			await expect.poll(async () => (await status(fixture.control)).relayCredential?.state).toBe("active");
			const ticket = fixture.events.find((event) => event.type === "pairing_progress" && event.phase === "ticket");
			if (ticket?.type !== "pairing_progress" || !ticket.ticket) throw new Error("pairing ticket missing");
			expect(await fixture.native.pair(ticket.ticket, NEW_PHONE)).toMatchObject({
				success: true,
				clientNodeId: NEW_PHONE,
				hostNodeId: HOST,
			});
			const paired = await fixture.control.request({ type: "clients_list" });
			expect(paired).toMatchObject({
				type: "clients_result",
				clients: expect.arrayContaining([
					{
						clientNodeId: OLD_PHONE,
						label: "Original phone",
						pairedAtMs: 1,
						lastSeenAtMs: 2,
						allowedTools: access.allowedTools?.split(","),
						usesDefaultTools: false,
						rpcGrant: access.rpcGrant,
					},
					expect.objectContaining({ clientNodeId: NEW_PHONE }),
				]),
			});
			expect(fixture.readState().settings.relayCredential?.grantId).toBe("fresh-bootstrap-grant");
			expect(fixture.readState().settings.relayCredential?.refreshToken).not.toBe(original.refreshToken);
			expect(fixture.native.binds).toBe(1);
		} finally {
			revokeGate.resolve();
			exchangeGate.resolve();
			await fixture.close();
		}
	});

	it("starts with a pending tombstone during broker failure and allows retry then pairing", async () => {
		const state = createEmptyVoltdState();
		state.settings.relayCredentialRevocation = credential();
		let available = false;
		const exchange = deferred<Response>();
		vi.mocked(fetch).mockImplementation(async (input) => {
			if (String(input).endsWith("/grant/revoke")) return new Response(null, { status: available ? 204 : 503 });
			if (String(input).endsWith("/pairing-claims"))
				return jsonResponse({ claimId: CLAIM, expiresAt: new Date(Date.now() + 600_000).toISOString() }, 201);
			return exchange.promise;
		});
		const fixture = await startFixture({ state });
		try {
			await expect.poll(async () => (await status(fixture.control)).remoteTransport.state).toBe("ready");
			expect((await status(fixture.control)).relayCredential?.state).toBe("revocation_pending");
			expect(fixture.native.boundTokens).toEqual([]);
			expect(await fixture.control.request({ type: "pair_request" })).toMatchObject({
				type: "error",
				code: "relay_credential_revocation_pending",
			});
			available = true;
			expect(await fixture.control.request({ type: "relay_credential_revoke" })).toMatchObject({ type: "ok" });
			expect(await fixture.control.request({ type: "pair_request" })).toMatchObject({ type: "pair_started" });
			expect(fixture.native.binds).toBe(1);
		} finally {
			exchange.resolve(new Response(null, { status: 410 }));
			await fixture.close();
		}
	});

	it("fences a late refresh and cancels outstanding pairing tickets before returning reset success", async () => {
		const state = createEmptyVoltdState();
		state.settings.relayCredential = credential(-1);
		const refresh = deferred<Response>();
		const exchange = deferred<Response>();
		let refreshStarted = false;
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith("/tokens/refresh")) {
				refreshStarted = true;
				return refresh.promise;
			}
			if (url.endsWith("/pairing-claims"))
				return jsonResponse({ claimId: CLAIM, expiresAt: new Date(Date.now() + 600_000).toISOString() }, 201);
			if (url.endsWith("/exchange")) return exchange.promise;
			return new Response(null, { status: 204 });
		});
		const fixture = await startFixture({ state });
		try {
			await expect.poll(() => refreshStarted).toBe(true);
			expect(await fixture.control.request({ type: "pair_request" })).toMatchObject({ type: "pair_started" });
			expect(fixture.readState().pendingPairingTickets).toHaveLength(1);
			expect(await fixture.control.request({ type: "relay_credential_revoke" })).toMatchObject({ type: "ok" });
			expect(fixture.readState().pendingPairingTickets).toEqual([]);
			expect(fixture.events).toContainEqual(
				expect.objectContaining({
					type: "pairing_progress",
					phase: "failed",
					error: expect.stringContaining("reset cancelled"),
				}),
			);
			refresh.resolve(
				jsonResponse({
					accessToken: "late.payload.signature",
					accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
					tokenType: "Bearer",
				}),
			);
			exchange.resolve(
				approvedExchange(
					NEW_PHONE,
					state.settings.relayCredential.grantId,
					state.settings.relayCredential.endpointId,
				),
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(fixture.native.reconnects).toEqual([]);
			expect(fixture.readState().settings.relayCredential).toBeUndefined();
			expect((await status(fixture.control)).relayCredential?.state).toBe("unpaired");
		} finally {
			refresh.resolve(new Response(null, { status: 410 }));
			exchange.resolve(new Response(null, { status: 410 }));
			await fixture.close();
		}
	});

	it("clears subscription denial after a successful credential refresh", async () => {
		const state = createEmptyVoltdState();
		state.settings.relayCredential = credential(-1);
		let refreshCount = 0;
		vi.mocked(fetch).mockImplementation(async () => {
			refreshCount++;
			return refreshCount === 1
				? jsonResponse({ error: "subscription_inactive" }, 402, { "Retry-After": "1" })
				: jsonResponse({
						accessToken: "renewed.payload.signature",
						accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
						tokenType: "Bearer",
					});
		});
		const fixture = await startFixture({ state });
		try {
			await expect
				.poll(async () => (await status(fixture.control)).relayCredential?.state)
				.toBe("subscription_inactive");
			await expect
				.poll(async () => (await status(fixture.control)).relayCredential?.state, { timeout: 3000 })
				.toBe("active");
			expect(fixture.readState().settings.relayCredential?.accessToken).toBe("renewed.payload.signature");
		} finally {
			await fixture.close();
		}
	});

	it("does not publish a QR when reset supersedes broker claim creation", async () => {
		const creation = deferred<Response>();
		let creationStarted = false;
		vi.mocked(fetch).mockImplementation(async () => {
			creationStarted = true;
			return creation.promise;
		});
		const fixture = await startFixture();
		try {
			const pair = fixture.control.request({ type: "pair_request" });
			await expect.poll(() => creationStarted).toBe(true);
			expect(await fixture.control.request({ type: "relay_credential_revoke" })).toMatchObject({ type: "ok" });
			creation.resolve(
				jsonResponse({ claimId: CLAIM, expiresAt: new Date(Date.now() + 600_000).toISOString() }, 201),
			);
			expect(await pair).toMatchObject({ type: "error", code: "pair_failed" });
			expect(fixture.events.filter((event) => event.type === "pairing_progress")).toEqual([]);
			expect(fixture.readState().pendingPairingTickets).toEqual([]);
			expect(fixture.readState().settings.relayCredentialClaim).toBeUndefined();
			expect((await status(fixture.control)).relayCredential?.state).toBe("unpaired");
		} finally {
			creation.resolve(new Response(null, { status: 410 }));
			await fixture.close();
		}
	});

	it("retains a retryable tombstone when native relay removal fails", async () => {
		const state = createEmptyVoltdState();
		state.settings.relayCredential = credential();
		vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
		const fixture = await startFixture({ state });
		try {
			await expect.poll(async () => (await status(fixture.control)).remoteTransport.state).toBe("ready");
			fixture.native.removeFailure = true;
			expect(await fixture.control.request({ type: "relay_credential_revoke" })).toMatchObject({ type: "error" });
			expect((await status(fixture.control)).relayCredential?.state).toBe("revocation_pending");
			fixture.native.removeFailure = false;
			expect(await fixture.control.request({ type: "relay_credential_revoke" })).toMatchObject({ type: "ok" });
			expect((await status(fixture.control)).relayCredential?.state).toBe("unpaired");
		} finally {
			await fixture.close();
		}
	});
});
