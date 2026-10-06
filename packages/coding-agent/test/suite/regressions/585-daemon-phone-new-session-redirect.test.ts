import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { ConversationFactory } from "../../../src/core/host/hosted-conversation.ts";
import { createIrohRemotePresetAccess } from "../../../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteActiveStreamRegistry } from "../../../src/core/remote/iroh/active-stream-registry.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../src/core/remote/iroh/authorization.ts";
import { serveIrohRemoteConnection } from "../../../src/core/remote/iroh/connection.ts";
import type { IrohRemoteHandshakeSuccess, IrohRemoteHello } from "../../../src/core/remote/iroh/handshake.ts";
import { IROH_REMOTE_ALPN } from "../../../src/core/remote/iroh/protocol.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { type IntegratedRuntimeEntry, IntegratedRuntimeRegistry } from "../../../src/daemon/integrated-runtimes.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { openTestHost } from "../../utilities/host-client.ts";
import { createIrohStreamPair } from "../../utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type IntentOutcome, type RemotePhone } from "../../utilities/remote-phone.ts";
import { testExtension } from "../../utilities.ts";

interface LifecycleEvent {
	type: string;
	sessionId: string;
	reason?: string;
}

const HANDSHAKE_RESPONSE = {
	child: "volt",
	features: ["multi_streams.v1", "conversation_streams.v1"],
} as unknown as IrohRemoteHandshakeSuccess;

function conversationHello(conversation: Record<string, unknown>): IrohRemoteHello {
	return {
		type: "volt_iroh_hello",
		protocol: IROH_REMOTE_ALPN,
		workspace: "ws",
		mode: "conversation",
		conversation,
	} as unknown as IrohRemoteHello;
}

/** A daemon serving daemon-hosted conversations to phones, over the faux provider. */
function createDaemon() {
	const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), "volt-daemon-redirect-")));
	const sessionDir = join(workspacePath, "sessions");
	const faux = createFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
	faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
	const events: LifecycleEvent[] = [];
	/** What a phone's `/handoff` command saw: the sessions its `withSession` seeded, and what `ctx.newSession()` returned. */
	const seeds: string[] = [];
	const handoffs: unknown[] = [];
	const factory: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: workspacePath,
			authStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					testExtension(
						"test-extension-1",
						(volt: ExtensionAPI) => {
							volt.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								streamSimple: faux.streamSimple,
								models: faux.models.map((model) => ({
									id: model.id,
									name: model.name,
									api: model.api,
									reasoning: model.reasoning,
									input: model.input,
									cost: model.cost,
									contextWindow: model.contextWindow,
									maxTokens: model.maxTokens,
								})),
							});
							volt.on("session_start", (event, ctx) => {
								events.push({
									type: event.type,
									sessionId: ctx.sessionManager.getSessionId(),
									reason: event.reason,
								});
							});
							volt.on("session_before_switch", (event, ctx) => {
								events.push({
									type: event.type,
									sessionId: ctx.sessionManager.getSessionId(),
									reason: event.reason,
								});
							});
							volt.on("session_shutdown", (event, ctx) => {
								events.push({
									type: event.type,
									sessionId: ctx.sessionManager.getSessionId(),
									reason: event.reason,
								});
							});
							volt.registerCommand("handoff", {
								remoteSafe: true,
								handler: async (_args, ctx) => {
									handoffs.push(
										await ctx.newSession({
											withSession: async (next) => {
												seeds.push(next.sessionManager.getSessionId());
											},
										}),
									);
								},
							});
						},
						["providers"],
					),
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const lastSessionIds = new Map<string, string>();
	const registry = new IntegratedRuntimeRegistry({
		agentDir: workspacePath,
		auditLogger: new IrohRemoteAuditLogger(),
		stateManager: new IrohRemoteHostStateManager(),
		activeStreams: new IrohRemoteActiveStreamRegistry(),
		detachedRuntimeTtlMs: () => 60_000,
		getAllowTools: () => undefined,
		getProjectTrustedForWorkspace: () => true,
		setClientLastSessionId: vi.fn(async (nodeId: string, _workspace: string, sessionId: string) => {
			lastSessionIds.set(nodeId, sessionId);
			return undefined;
		}),
		createRuntime: async (options) => {
			const target = options.conversationTarget;
			const sessionManager = await SessionManager.create(
				workspacePath,
				sessionDir,
				target?.target === "new" && target.sessionId !== undefined ? { id: target.sessionId } : {},
			);
			// As the daemon does: a host of its own that keeps the conversation open between phones.
			const runtime = await openTestHost(factory, {
				cwd: workspacePath,
				agentDir: workspacePath,
				sessionManager,
				extensionMode: "rpc",
				whenUnattached: "keep",
			});
			return { runtime, sessionSelection: { kind: "created", sessionId: runtime.conversation.id } };
		},
	});

	function authorize(nodeId: string, lastSessionId?: string): IrohRemoteClientAuthorizationSuccess {
		return {
			ok: true,
			allowTools: "read",
			client: {
				nodeId,
				label: nodeId,
				allowedWorkspaces: ["ws"],
				allowedTools: "read",
				rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
				pairedAt: 1,
				lastSeenAt: 2,
				...(lastSessionId === undefined ? {} : { lastSessionIdByWorkspace: { ws: lastSessionId } }),
			},
			paired: false,
			pairingSecretConsumed: false,
			workspace: { name: "ws", path: workspacePath },
			workspaceNames: ["ws"],
			workspaces: [{ name: "ws", status: "available" }],
		};
	}

	/** Attach a phone stream the way the daemon serves one: a client of the conversation that its moves redirect alone. */
	async function connectPhone(
		nodeId: string,
		hello: IrohRemoteHello,
	): Promise<{ entry: IntegratedRuntimeEntry; phone: RemotePhone; closed: Promise<void> }> {
		const authorization = authorize(nodeId);
		const attach = await registry.getOrCreateEntry({ hello, response: HANDSHAKE_RESPONSE }, authorization);
		await registry.commitEntry(attach.entry, attach.sessionSelection, authorization, attach.attachClaim);
		const subscriber = await registry.attachSubscriber(attach.entry, attach.attachClaim);
		attach.attachClaim.release();
		const entry = attach.entry;
		const { host, conversation } = entry.runtime;
		const redirect = registry.streamRedirect(entry, authorization);
		let movedTo: string | undefined;
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host,
			conversation,
			stream: pair.host,
			grant: authorization.client.rpcGrant,
			redaction: { workspacePath },
			redirect: {
				hostTarget: redirect.hostTarget,
				onRedirected: (sessionId) => {
					movedTo = sessionId;
				},
			},
		});
		const closed = connection.closed
			.catch(() => undefined)
			.finally(async () => {
				await registry.detachSubscriber(
					entry,
					subscriber,
					movedTo === undefined ? "transport_closed" : "conversation_moved",
					undefined,
					movedTo === undefined ? {} : { retainMs: 0 },
				);
			});
		const phone = connectRemotePhone(pair.phone);
		await phone.hello();
		await connection.ready;
		await phone.subscribe(conversation.id);
		return { entry, phone, closed };
	}

	return {
		workspacePath,
		registry,
		events,
		seeds,
		handoffs,
		lastSessionIds,
		authorize,
		connectPhone,
		async cleanup() {
			await registry.stopAll("test_cleanup");
			rmSync(workspacePath, { recursive: true, force: true });
		},
	};
}

/** The conversation a structural intent's acceptance names. */
function targetOf(outcome: IntentOutcome): string {
	if (outcome.type !== "accepted" || outcome.conversation === undefined) {
		throw new Error(`Expected the intent to name its target: ${JSON.stringify(outcome)}`);
	}
	return outcome.conversation;
}

describe("regression #585: a phone on a daemon-hosted conversation changes sessions alone", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("answers new_session, redirects that phone to the conversation the daemon opened, and keeps a co-attached phone on the source", async () => {
		const daemon = createDaemon();
		cleanups.push(() => daemon.cleanup());
		const phoneA = await daemon.connectPhone(
			"n-phone-a",
			conversationHello({ target: "new", sessionId: "s-source" }),
		);
		const phoneB = await daemon.connectPhone(
			"n-phone-b",
			conversationHello({ target: "session", sessionId: "s-source" }),
		);
		const source = phoneA.entry;
		expect(phoneB.entry).toBe(source);
		// Each phone's stream authorizes review discussions through the conversation's entry.
		expect(source.reviewDiscussions).toBeDefined();
		daemon.events.length = 0;

		const outcome = await phoneA.phone.intent("new_session", {});
		const targetId = targetOf(outcome);
		expect(targetId).not.toBe("s-source");
		// The answer comes first; the subscription ends moved, then the stream.
		await phoneA.phone.ended;
		await phoneA.closed;
		expect(phoneA.phone.frames.indexOf(outcome)).toBeGreaterThan(0);
		expect(phoneA.phone.frames.at(-1)).toEqual({
			type: "ended",
			subscriptionId: "s1",
			reason: "moved",
			target: targetId,
		});

		// The daemon hosts the new conversation, detached, with the source's tool policy.
		const target = daemon.registry.findOwner("ws", targetId);
		expect(target).toMatchObject({ lifecycle: "active", clientNodeId: "n-phone-a" });
		expect(target?.toolPolicy).toEqual(source.toolPolicy);
		expect(target?.subscribers.size).toBe(0);
		expect(daemon.events).toEqual([{ type: "session_before_switch", sessionId: "s-source", reason: "new" }]);

		// Phone B stays on the source, which stays open for it.
		expect(phoneB.phone.frames.some((frame) => frame.type === "ended" || frame.type === "fatal")).toBe(false);
		expect(daemon.registry.findOwner("ws", "s-source")).toBe(source);
		expect(
			await phoneB.phone.intent("prompt", { message: "still on the source" }, { intentId: "phone-b-prompt" }),
		).toMatchObject({ type: "accepted" });
		await vi.waitFor(() =>
			expect(source.runtime.conversation.session.messages.some((message) => message.role === "user")).toBe(true),
		);
		await source.runtime.conversation.session.waitForIdle();
		expect(source.runtime.conversation.session.sessionId).toBe("s-source");

		// Only phone A's last session moved: `target:"last"` lands it on the new conversation.
		expect(daemon.lastSessionIds.get("n-phone-a")).toBe(targetId);
		expect(daemon.lastSessionIds.get("n-phone-b")).toBe("s-source");
		const reconnect = await daemon.registry.getOrCreateEntry(
			{ hello: conversationHello({ target: "last" }), response: HANDSHAKE_RESPONSE },
			daemon.authorize("n-phone-a", daemon.lastSessionIds.get("n-phone-a")),
		);
		expect(reconnect.created).toBe(false);
		expect(reconnect.entry).toBe(target);
		expect(reconnect.sessionSelection).toEqual({
			kind: "resumed",
			requestedSessionId: targetId,
			sessionId: targetId,
		});
		reconnect.attachClaim.release();

		// The phone's reconnect binds the new conversation's extensions.
		const moved = await daemon.connectPhone(
			"n-phone-a",
			conversationHello({ target: "session", sessionId: targetId }),
		);
		expect(moved.entry).toBe(target);
		expect(daemon.events).toContainEqual({ type: "session_start", sessionId: targetId, reason: "new" });
		expect(daemon.events.some((event) => event.type === "session_shutdown")).toBe(false);

		await Promise.all([moved.phone.close(), phoneB.phone.close()]);
		await Promise.all([moved.closed, phoneB.closed]);
	});

	it("runs the withSession of the phone's extension command once the phone reconnected to the conversation the daemon opened", async () => {
		const daemon = createDaemon();
		cleanups.push(() => daemon.cleanup());
		const source = await daemon.connectPhone("n-phone-a", conversationHello({ target: "new", sessionId: "s-seed" }));
		// A second phone keeps the source open.
		const stays = await daemon.connectPhone(
			"n-phone-b",
			conversationHello({ target: "session", sessionId: "s-seed" }),
		);

		source.phone.send({
			type: "extension.command.test-extension-1.handoff",
			intentId: "i-handoff",
			expectedOrdinal: source.phone.position(),
			input: {},
		});
		await source.phone.ended;
		await source.closed;
		const moved = source.phone.frames.at(-1);
		if (moved?.type !== "ended" || moved.reason !== "moved") throw new Error("The phone was not redirected");
		// The new conversation's extensions start when the phone comes back; the seed waits for them.
		expect(daemon.seeds).toEqual([]);

		const back = await daemon.connectPhone(
			"n-phone-a",
			conversationHello({ target: "session", sessionId: moved.target }),
		);

		await vi.waitFor(() =>
			expect(daemon.handoffs).toEqual([{ cancelled: false, sessionId: moved.target, seeded: true }]),
		);
		expect(daemon.seeds).toEqual([moved.target]);
		expect(daemon.events).toContainEqual({ type: "session_start", sessionId: moved.target, reason: "new" });

		await Promise.all([back.phone.close(), stays.phone.close()]);
		await Promise.all([back.closed, stays.closed]);
	});

	it("closes the source once idle when the phone that moved away was its last client", async () => {
		const daemon = createDaemon();
		cleanups.push(() => daemon.cleanup());
		const phone = await daemon.connectPhone("n-phone-a", conversationHello({ target: "new", sessionId: "s-alone" }));

		const targetId = targetOf(await phone.phone.intent("new_session", {}));
		await phone.closed;

		// Not after the configured detached TTL: the moved-away source closes at once.
		await vi.waitFor(() => expect(daemon.registry.findOwner("ws", "s-alone")).toBeUndefined());
		expect(daemon.events).toContainEqual({ type: "session_shutdown", sessionId: "s-alone", reason: "quit" });
		expect(daemon.registry.findOwner("ws", targetId)).toMatchObject({ lifecycle: "active" });
	});
});
