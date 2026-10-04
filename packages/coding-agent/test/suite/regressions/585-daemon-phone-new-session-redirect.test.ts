import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createIrohRemotePresetAccess } from "../../../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteActiveStreamRegistry } from "../../../src/core/remote/iroh/active-stream-registry.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../src/core/remote/iroh/authorization.ts";
import type { IrohRemoteHandshakeSuccess, IrohRemoteHello } from "../../../src/core/remote/iroh/handshake.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { IntegratedRuntimeRegistry } from "../../../src/daemon/integrated-runtimes.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { runIrohRemoteRpcMode } from "../../../src/modes/rpc/iroh-remote-rpc-mode.ts";
import {
	createTestIrohConversationOptions,
	ManualIrohRecvStream,
	ManualIrohSendStream,
	parseWrittenObjects,
	withCurrentConversationAuthority,
} from "../../iroh-stream-doubles.ts";

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
		protocol: "volt-rpc/0",
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
	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: workspacePath,
			authStorage,
			resourceLoaderOptions: {
				extensionFactories: [
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
					},
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
			const runtime = await createAgentSessionRuntime(factory, {
				cwd: workspacePath,
				agentDir: workspacePath,
				sessionManager,
			});
			return { runtime, sessionSelection: { kind: "created", sessionId: runtime.session.sessionId } };
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

	/** Attach a phone stream the way the daemon serves one: on a view that redirects it alone. */
	async function connectPhone(nodeId: string, hello: IrohRemoteHello) {
		const authorization = authorize(nodeId);
		const attach = await registry.getOrCreateEntry({ hello, response: HANDSHAKE_RESPONSE }, authorization);
		await registry.commitEntry(attach.entry, attach.sessionSelection, authorization, attach.attachClaim);
		const subscriber = await registry.attachSubscriber(attach.entry, attach.attachClaim);
		attach.attachClaim.release();
		const entry = attach.entry;
		const view = registry.attachStreamView(entry, authorization);
		let movedTo: string | undefined;
		view.onClientDetached((detachment) => {
			if (detachment.kind === "redirected") movedTo = detachment.sessionId;
		});
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		const ready = Promise.withResolvers<void>();
		const closed = runIrohRemoteRpcMode(view, {
			...createTestIrohConversationOptions(view),
			rpcGrant: authorization.client.rpcGrant,
			stream: { recv, send },
			disposeRuntimeOnClose: false,
			workspaceName: "ws",
			workspacePath,
			detachedTerminal: (detachment) =>
				detachment.kind === "redirected"
					? {
							type: "remote_terminal",
							reason: "conversation_moved",
							workspace: "ws",
							sessionId: entry.sessionId,
							targetSessionId: detachment.sessionId,
						}
					: undefined,
			onReady: ready.resolve,
		}).finally(async () => {
			await view.dispose();
			await registry.detachSubscriber(
				entry,
				subscriber,
				movedTo === undefined ? "transport_closed" : "conversation_moved",
				undefined,
				movedTo === undefined ? {} : { retainMs: 0 },
			);
		});
		await Promise.race([ready.promise, closed]);
		return { entry, view, recv, send, closed };
	}

	return {
		workspacePath,
		registry,
		events,
		lastSessionIds,
		authorize,
		connectPhone,
		async cleanup() {
			await registry.stopAll("test_cleanup");
			rmSync(workspacePath, { recursive: true, force: true });
		},
	};
}

function newSessionRequest(send: ManualIrohSendStream): string {
	return JSON.stringify(withCurrentConversationAuthority(send, { id: "n1", type: "new_session" }));
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
		// Each stream's view authorizes review discussions through the conversation's runtime.
		expect(phoneA.view.reviewDiscussions).toBeDefined();
		expect(phoneA.view.reviewDiscussions).toBe(source.runtime.reviewDiscussions);
		daemon.events.length = 0;

		phoneA.recv.pushLine(newSessionRequest(phoneA.send));
		await phoneA.closed;

		const frames = parseWrittenObjects(phoneA.send);
		const response = frames.find((frame) => frame.type === "response" && frame.command === "new_session");
		expect(response).toMatchObject({ id: "n1", success: true, data: { cancelled: false } });
		const targetId = (response?.data as { sessionId: string }).sessionId;
		expect(targetId).not.toBe("s-source");
		// The response comes first; the redirect ends the stream.
		expect(frames.at(-1)).toEqual({
			type: "remote_terminal",
			reason: "conversation_moved",
			workspace: "ws",
			sessionId: "s-source",
			targetSessionId: targetId,
		});
		expect(phoneA.send.finished).toBe(true);

		// The daemon hosts the new conversation, detached, with the source's tool policy.
		const target = daemon.registry.findOwner("ws", targetId);
		expect(target).toMatchObject({ lifecycle: "active", clientNodeId: "n-phone-a" });
		expect(target?.toolPolicy).toEqual(source.toolPolicy);
		expect(target?.subscribers.size).toBe(0);
		expect(daemon.events).toEqual([{ type: "session_before_switch", sessionId: "s-source", reason: "new" }]);

		// Phone B stays on the source, which stays open for it.
		expect(phoneB.send.finished).toBe(false);
		expect(daemon.registry.findOwner("ws", "s-source")).toBe(source);
		phoneB.recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(phoneB.send, {
					id: "p1",
					type: "prompt",
					message: "still on the source",
					clientMessageId: "phone-b-prompt",
				}),
			),
		);
		await vi.waitFor(() =>
			expect(parseWrittenObjects(phoneB.send)).toContainEqual(
				expect.objectContaining({ id: "p1", command: "prompt", success: true }),
			),
		);
		await source.runtime.session.waitForIdle();
		expect(source.runtime.session.sessionId).toBe("s-source");
		expect(source.runtime.session.messages.some((message) => message.role === "user")).toBe(true);

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

		moved.recv.end();
		phoneB.recv.end();
		await Promise.all([moved.closed, phoneB.closed]);
	});

	it("closes the source once idle when the phone that moved away was its last client", async () => {
		const daemon = createDaemon();
		cleanups.push(() => daemon.cleanup());
		const phone = await daemon.connectPhone("n-phone-a", conversationHello({ target: "new", sessionId: "s-alone" }));

		phone.recv.pushLine(newSessionRequest(phone.send));
		await phone.closed;

		const response = parseWrittenObjects(phone.send).find((frame) => frame.command === "new_session");
		const targetId = (response?.data as { sessionId: string }).sessionId;
		// Not after the configured detached TTL: the moved-away source closes at once.
		await vi.waitFor(() => expect(daemon.registry.findOwner("ws", "s-alone")).toBeUndefined());
		expect(daemon.events).toContainEqual({ type: "session_shutdown", sessionId: "s-alone", reason: "quit" });
		expect(daemon.registry.findOwner("ws", targetId)).toMatchObject({ lifecycle: "active" });
	});
});
