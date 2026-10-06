/**
 * TUI host harness for suite tests: the TUI's host (`TuiHost`) over a
 * conversation host on the faux provider (host-harness.ts), with daemon leases
 * over a link the test scripts or a real one, the TUI's client over a loopback
 * connection, and InteractiveMode rendering into a virtual terminal as that
 * client, its store following it.
 */

import { duplexPair } from "node:stream";
import type { HostRequestKind } from "@hansjm10/volt-protocol";
import { setKeybindings, type TUI, type TuiMode } from "@hansjm10/volt-tui";
import { expect, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { LoopbackClient } from "../../src/client/protocol-client.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { readIrohJsonlLine } from "../../src/core/protocol/transport/iroh-transport.ts";
import { createIrohRemotePresetAccess } from "../../src/core/remote/iroh/access-grant.ts";
import { createIrohRemoteHandshakeSuccess } from "../../src/core/remote/iroh/handshake.ts";
import { IROH_REMOTE_ALPN } from "../../src/core/remote/iroh/protocol.ts";
import { SessionManager, type SessionReference } from "../../src/core/session-manager.ts";
import { stopThemeWatcher } from "../../src/core/theme/runtime.ts";
import type { RelayPreamble } from "../../src/daemon/control-protocol.ts";
import type { TuiStore } from "../../src/modes/interactive/client/tui-store.ts";
import {
	type AcquireOutcome,
	createDisabledDaemonLink,
	DaemonLeases,
	type DaemonLink,
	type DaemonRelayOffer,
	type OpenedRelay,
} from "../../src/modes/interactive/host/daemon-link.ts";
import { adaptRelaySocketToIrohStream } from "../../src/modes/interactive/host/relay-serving.ts";
import { type TuiConnectOptions, TuiHost } from "../../src/modes/interactive/host/tui-host.ts";
import { createInteractiveTui, InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { TUI_HOST_REQUESTS } from "../../src/modes/interactive/live-view.ts";
import { connectRemotePhone, type RemotePhone } from "../utilities/remote-phone.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "./host-harness.ts";

export interface TuiHarnessOptions extends Omit<HostHarnessOptions, "openGate" | "extensionMode"> {
	/** The link the TUI host's daemon leases serve through; without one, the TUI runs without the daemon. */
	link?: DaemonLink;
	/** The startup conversation's id and cwd: a new id in the harness's temp dir by default. */
	startup?: { id?: string; cwd?: string };
	/** The model scope patterns the TUI started with (`--models`). */
	modelScopePatterns?: readonly string[];
}

/** InteractiveMode over the TUI host, rendering into a virtual terminal. */
export interface TuiModeFixture {
	readonly mode: InteractiveMode;
	readonly terminal: VirtualTerminal;
	/** What the mode's client holds of the conversation it shows. */
	readonly store: TuiStore;
	readonly ui: TUI;
	/** Resume `ref` as `/resume` does: where the client went, unless it stayed. */
	resume(ref: SessionReference): Promise<{ cancelled: true } | { cancelled: false; sessionId: string }>;
	/** Connect the mode's client and show its conversation, when it started without. */
	connect(): Promise<void>;
	/** Run `text` as the editor submits it: a command, or text to send. */
	submit(text: string): Promise<void>;
	/** The terminal's visible rows, joined. */
	screen(): string;
}

export interface TuiHarness extends HostHarness {
	readonly tuiHost: TuiHost;
	/** The conversation the TUI opens on. */
	readonly startup: HostedConversation;
	/** The session directory the startup conversation is stored in. */
	readonly sessionDir: string;
	/** Connect the TUI's client over loopback, answering every host request kind the TUI answers by default. */
	connect(options?: TuiConnectOptions): Promise<LoopbackClient>;
	/**
	 * InteractiveMode over the TUI host, its client connected and its
	 * conversation shown; with `connect: false`, its UI runs and the fixture's
	 * `connect` connects it.
	 */
	startMode(options?: {
		tuiMode?: TuiMode;
		columns?: number;
		rows?: number;
		connect?: boolean;
	}): Promise<TuiModeFixture>;
	/** Store a session in the startup conversation's session directory, for a resume. */
	storeSession(name?: string): Promise<SessionReference>;
}

interface ModeAccess {
	renderer: ReturnType<typeof createInteractiveTui>;
	defaultEditor: { onSubmit?: (text: string) => Promise<void> | void };
	ui: TUI;
	editor: unknown;
	conversationView: unknown;
	isInitialized: boolean;
	store: TuiStore;
	renderWidgets(): void;
	setupKeyHandlers(): void;
	setupPlanPaneInputRouting(): void;
	setupEditorSubmitHandler(): void;
	activateView(view: unknown, focus: unknown, forceRender?: boolean): void;
	connect(): Promise<void>;
	handleResumeSession(sessionId: string): Promise<{ moved: false } | { moved: true; conversation: string }>;
}

export async function createTuiHarness(options: TuiHarnessOptions = {}): Promise<TuiHarness> {
	const { link, startup: startupOptions, modelScopePatterns, ...hostOptions } = options;
	const leases = link === undefined ? undefined : new DaemonLeases({ link, createLink: () => link });
	const harness = await createHostHarness({
		...hostOptions,
		extensionMode: "tui",
		...(leases === undefined ? {} : { openGate: leases.openGate }),
	});
	const cleanups: Array<() => Promise<void> | void> = [];
	try {
		const sessionDir = `${harness.tempDir}/sessions`;
		const sessionManager = await SessionManager.create(startupOptions?.cwd ?? harness.tempDir, sessionDir, {
			...(startupOptions?.id === undefined ? {} : { id: startupOptions.id }),
		});
		const opened = await harness.host.open({ kind: "adopt", sessionManager });
		if (opened.cancelled) throw new Error("A startup open cannot be cancelled");
		const startup = opened.conversation;
		const tuiHost = TuiHost.start({
			host: harness.host,
			conversation: startup,
			...(leases === undefined ? {} : { daemon: leases }),
			...(modelScopePatterns === undefined ? {} : { modelScopePatterns }),
		});
		return {
			...harness,
			tuiHost,
			startup,
			sessionDir,
			async connect(connectOptions = {}) {
				const client = await tuiHost.connect({ hostRequests: TUI_HOST_REQUESTS, ...connectOptions });
				cleanups.push(() => client.stop());
				return client;
			},
			async startMode(modeOptions = {}) {
				const tuiMode = modeOptions.tuiMode ?? "regular";
				vi.stubEnv("VOLT_CODING_AGENT_DIR", harness.tempDir);
				const mode = new InteractiveMode(tuiHost, { tuiMode });
				const access = mode as unknown as ModeAccess;
				const terminal = new VirtualTerminal(modeOptions.columns ?? 100, modeOptions.rows ?? 30);
				access.renderer = createInteractiveTui({
					tuiMode,
					showHardwareCursor: false,
					logDirectory: harness.tempDir,
					terminal,
				});
				cleanups.push(() => {
					mode.stop("resume-hint");
					stopThemeWatcher();
					setKeybindings(new KeybindingsManager());
					vi.unstubAllEnvs();
				});
				access.renderWidgets();
				access.setupKeyHandlers();
				access.setupPlanPaneInputRouting();
				access.setupEditorSubmitHandler();
				access.activateView(access.conversationView, access.editor, false);
				access.isInitialized = true;
				access.ui.start();
				const connect = async (): Promise<void> => {
					await access.connect();
					await terminal.waitForRender();
				};
				if (modeOptions.connect !== false) await connect();
				return {
					mode,
					terminal,
					store: access.store,
					ui: access.ui,
					resume: async (ref) => {
						const outcome = await access.handleResumeSession(ref.sessionId);
						return outcome.moved ? { cancelled: false, sessionId: outcome.conversation } : { cancelled: true };
					},
					connect,
					submit: async (text) => {
						await access.defaultEditor.onSubmit?.(text);
					},
					screen: () => terminal.getViewport().join("\n"),
				};
			},
			async storeSession(name = "stored") {
				const manager = await SessionManager.create(startup.cwd, sessionDir);
				await manager.logWriter.appendSessionInfo(name);
				const ref = manager.getSessionRef();
				if (!ref) throw new Error("The session is not stored");
				await manager.closePersistence();
				return ref;
			},
			async cleanup() {
				for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
				await tuiHost.dispose().catch(() => undefined);
				await harness.cleanup();
			},
		};
	} catch (error) {
		await harness.cleanup();
		throw error;
	}
}

/** The terminal's visible rows once it rendered what the TUI shows now. */
export async function renderedScreen(tui: TuiModeFixture): Promise<string> {
	tui.ui.requestRender();
	await tui.terminal.waitForRender();
	return tui.screen();
}

/** Wait until the terminal shows every text; resolves its visible rows. */
export async function waitForScreen(tui: TuiModeFixture, ...texts: string[]): Promise<string> {
	let shown = "";
	await vi.waitFor(
		async () => {
			shown = await renderedScreen(tui);
			for (const text of texts) expect(shown).toContain(text);
		},
		{ timeout: 5_000 },
	);
	return shown;
}

/** Pick `option` in the selector the TUI shows: move its highlight (`→`) there, then press Enter. */
export async function choose(tui: TuiModeFixture, option: string): Promise<void> {
	await waitForScreen(tui, option);
	for (let moves = 0; ; moves++) {
		const highlighted = (await renderedScreen(tui)).split("\n").find((line) => line.includes("→"));
		if (highlighted?.includes(option)) break;
		if (moves > 50) throw new Error(`The selector never highlighted ${option}`);
		tui.terminal.sendInput("\x1b[B");
	}
	tui.terminal.sendInput("\r");
}

/** A phone's stream as the daemon relays it to the TUI: the TUI's end, and the phone's. */
export interface RelayedStream {
	readonly opened: OpenedRelay;
	/** The phone's end of the relay, after the daemon's handshake. */
	readonly phoneEnd: ReturnType<typeof adaptRelaySocketToIrohStream>;
	/** Settles once the TUI marked the relay finished. */
	readonly finished: Promise<void>;
}

/**
 * A daemon link a test scripts: lease calls are recorded into `steps`
 * (`acquire:<session>`, `release:<session>:<reason>`, `abort:<viewer feed>`),
 * each session's lease outcome is `outcomes`' (granted by default), relay
 * offers reach the TUI through `offerRelay`, and relayed intents the daemon
 * backs answer from `relayed`.
 */
export interface ScriptedDaemonLink extends DaemonLink {
	readonly steps: string[];
	readonly outcomes: Map<string, () => AcquireOutcome>;
	/** The relayed frames the daemon answered, in order. */
	readonly relayed: unknown[];
	/** Offer the TUI a phone's relay with `preamble`; resolves once the TUI took it, or undefined when it let it expire. */
	offerRelay(
		offer: Partial<DaemonRelayOffer> & { sessionId: string },
		preamble: RelayPreamble,
	): Promise<RelayedStream | undefined>;
	/** Reconnect: the daemon reacquires the session leased last with `outcome`. */
	reacquire(sessionId: string, outcome: AcquireOutcome): void;
}

export function createScriptedDaemonLink(): ScriptedDaemonLink {
	const steps: string[] = [];
	const outcomes = new Map<string, () => AcquireOutcome>();
	const relayed: unknown[] = [];
	let relays = 0;
	let offerHandler: ((offer: DaemonRelayOffer, openRelay: () => Promise<OpenedRelay>) => void) | undefined;
	let reacquiredHandler: ((sessionId: string, outcome: AcquireOutcome) => void) | undefined;
	const setRelays = (count: number): void => {
		relays = count;
	};
	return {
		...createDisabledDaemonLink(),
		steps,
		outcomes,
		relayed,
		connectionState: () => "connected",
		workspaceName: () => "ws",
		acquire: vi.fn(async (sessionId: string): Promise<AcquireOutcome> => {
			steps.push(`acquire:${sessionId}`);
			return outcomes.get(sessionId)?.() ?? { kind: "granted", handoff: "none" };
		}),
		release: vi.fn(async (sessionId: string, reason?: string) => {
			steps.push(`release:${sessionId}:${reason}`);
		}),
		viewerAbort: vi.fn(async (viewerFeedId: string) => {
			steps.push(`abort:${viewerFeedId}`);
		}),
		async forwardRelayRpc(_clientNodeId, _sessionId, frame) {
			relayed.push(frame);
			return frame.type === "query"
				? { type: "query_error", queryId: frame.queryId, reason: { code: "unavailable", message: "scripted" } }
				: { type: "accepted", intentId: frame.intentId, ordinals: [] };
		},
		onRelayOffer(handler) {
			offerHandler = handler;
		},
		onReacquired(handler) {
			reacquiredHandler = handler;
		},
		relayCount: () => relays,
		async offerRelay(offer, preamble) {
			const handler = offerHandler;
			if (!handler) throw new Error("The TUI serves no relays");
			const taken = Promise.withResolvers<RelayedStream | undefined>();
			const finished = Promise.withResolvers<void>();
			let opened = false;
			handler(
				{
					relayId: "rl-1",
					relayToken: "token-1",
					workspaceName: "ws",
					clientNodeId: preamble.authorization.clientNodeId,
					connectionId: preamble.connectionId,
					streamId: preamble.streamId,
					...offer,
				},
				async () => {
					opened = true;
					const [tuiEnd, phoneEnd] = duplexPair();
					setRelays(relays + 1);
					let done = false;
					const relay: OpenedRelay = {
						preamble,
						stream: tuiEnd,
						finished: () => {
							if (done) return;
							done = true;
							setRelays(Math.max(0, relays - 1));
							finished.resolve();
						},
					};
					taken.resolve({
						opened: relay,
						phoneEnd: adaptRelaySocketToIrohStream(phoneEnd),
						finished: finished.promise,
					});
					return relay;
				},
			);
			// An offer the TUI lets expire is never redeemed.
			setTimeout(() => {
				if (!opened) taken.resolve(undefined);
			}, 1000).unref();
			return taken.promise;
		},
		reacquire(sessionId, outcome) {
			reacquiredHandler?.(sessionId, outcome);
		},
	};
}

/** A relay preamble for a phone paired with full access, reaching `sessionId` in workspace `ws` at `workspacePath`. */
export function relayPreamble(
	sessionId: string,
	workspacePath: string,
	options: { clientNodeId?: string; streamId?: string } = {},
): RelayPreamble {
	const clientNodeId = options.clientNodeId ?? "n-phone";
	const streamId = options.streamId ?? "st-1";
	return {
		type: "relay_preamble",
		relayId: "rl-1",
		handshake: {
			hello: {
				type: "volt_iroh_hello",
				protocol: IROH_REMOTE_ALPN,
				workspace: "ws",
				mode: "conversation",
				conversation: { target: "session", sessionId },
			},
			response: createIrohRemoteHandshakeSuccess({
				workspace: "ws",
				clientNodeId,
				child: "volt",
				features: ["multi_streams.v1", "conversation_streams.v1"],
			}),
			initialInput: [],
		},
		authorization: {
			clientNodeId,
			workspaceName: "ws",
			workspacePath,
			workspaceNames: ["ws"],
			workspaces: [{ name: "ws", status: "available" }],
			allowedTools: "",
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
		},
		hostNodeId: "n-daemon-host",
		relayMode: "development",
		connectionId: `conn-${clientNodeId}`,
		streamId,
		resolvedTarget: {
			sessionId,
			selection: "resumed",
			requestedSessionId: sessionId,
			workspaceName: "ws",
			workspacePath,
		},
	};
}

/** Read the TUI's handshake response on a relayed phone's end, then speak protocol 1 frames subscribed to `sessionId`. */
export async function connectRelayedPhone(
	relayed: RelayedStream,
	sessionId: string,
	hostRequests: readonly HostRequestKind[] = [],
): Promise<RemotePhone> {
	const handshake = await readIrohJsonlLine(relayed.phoneEnd.recv);
	if (handshake.line === undefined) throw new Error("The relay ended before the handshake response");
	const response = JSON.parse(handshake.line) as Record<string, unknown>;
	expect(response).toMatchObject({ success: true, sessionId, hostNodeId: "n-daemon-host" });
	const phone = connectRemotePhone(relayed.phoneEnd, handshake.rest);
	await phone.hello(hostRequests);
	await phone.subscribe(sessionId);
	return phone;
}
