/**
 * TUI harness for suite tests: the TUI's connector (`InProcessConnector`) over
 * a conversation host on the faux provider (host-harness.ts), the TUI's client
 * connected through it (following its moves by reconnecting), InteractiveMode
 * rendering into a virtual terminal as that client, its store following it,
 * and phones the daemon relays into the host, served as a worker serves them.
 */

import { duplexPair } from "node:stream";
import type { HostRequestKind } from "@hansjm10/volt-protocol";
import { setKeybindings, type TUI, type TuiMode } from "@hansjm10/volt-tui";
import { expect, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { type ConnectThroughOptions, connectThrough } from "../../src/client/conversation-connector.ts";
import { InProcessConnector } from "../../src/client/in-process-connector.ts";
import type { ProtocolClient } from "../../src/client/protocol-client.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { DecidedProjectTrust } from "../../src/core/project-trust.ts";
import { readIrohJsonlLine } from "../../src/core/protocol/transport/iroh-transport.ts";
import { createIrohRemotePresetAccess } from "../../src/core/remote/iroh/access-grant.ts";
import { createIrohRemoteHandshakeSuccess } from "../../src/core/remote/iroh/handshake.ts";
import { IROH_REMOTE_ALPN } from "../../src/core/remote/iroh/protocol.ts";
import { SessionManager, type SessionReference } from "../../src/core/session-manager.ts";
import type { LogWriter } from "../../src/core/session-writer.ts";
import { stopThemeWatcher } from "../../src/core/theme/runtime.ts";
import type { PhoneRelayPreamble } from "../../src/daemon/control-protocol.ts";
import { adaptRelaySocketToIrohStream } from "../../src/daemon/relay-stream.ts";
import { servePhoneRelay } from "../../src/daemon/worker/serve-phone.ts";
import type { TuiStore } from "../../src/modes/interactive/client/tui-store.ts";
import { createInteractiveTui, InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { TUI_HOST_REQUESTS } from "../../src/modes/interactive/live-view.ts";
import { connectRemotePhone, type RemotePhone } from "../utilities/remote-phone.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "./host-harness.ts";

export interface TuiHarnessOptions extends Omit<HostHarnessOptions, "extensionMode"> {
	/**
	 * The startup conversation's id and cwd (a new id in the harness's temp dir
	 * by default), and what its log holds before it opens.
	 */
	startup?: { id?: string; cwd?: string; seed?: (writer: LogWriter) => Promise<void> };
	/** The model scope patterns the TUI started with (`--models`). */
	modelScopePatterns?: readonly string[];
}

/** InteractiveMode over the TUI's connector, rendering into a virtual terminal. */
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
	/** The TUI's connector. */
	readonly connector: InProcessConnector;
	/** The conversation the TUI opens on. */
	readonly startup: HostedConversation;
	/** The session directory the startup conversation is stored in. */
	readonly sessionDir: string;
	/**
	 * Connect a client through the TUI's connector, as the TUI does, answering
	 * every host request kind the TUI answers by default. Resolves once the
	 * host serves the client: after the conversation's recovered input, which
	 * comes before the client's first query.
	 */
	connect(options?: ConnectThroughOptions): Promise<ProtocolClient>;
	/**
	 * InteractiveMode over the TUI's connector, its client connected and its
	 * conversation shown; with `connect: false`, its UI runs and the fixture's
	 * `connect` connects it.
	 */
	startMode(options?: {
		tuiMode?: TuiMode;
		columns?: number;
		rows?: number;
		connect?: boolean;
		/** The project trust the TUI decided at startup, as the volt CLI passes it (its host runs elsewhere). */
		projectTrust?: DecidedProjectTrust;
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
	const { startup: startupOptions, modelScopePatterns, ...hostOptions } = options;
	const harness = await createHostHarness({ ...hostOptions, extensionMode: "rpc" });
	const cleanups: Array<() => Promise<void> | void> = [];
	try {
		const sessionDir = `${harness.tempDir}/sessions`;
		const sessionManager = await SessionManager.create(startupOptions?.cwd ?? harness.tempDir, sessionDir, {
			...(startupOptions?.id === undefined ? {} : { id: startupOptions.id }),
		});
		await startupOptions?.seed?.(sessionManager.logWriter);
		const opened = await harness.host.open({ kind: "adopt", sessionManager });
		if (opened.cancelled) throw new Error("A startup open cannot be cancelled");
		const startup = opened.conversation;
		const connectorOptions = {
			host: harness.host,
			conversation: startup,
			...(modelScopePatterns === undefined ? {} : { modelScopePatterns }),
		};
		const connector = InProcessConnector.start(connectorOptions);
		return {
			...harness,
			connector,
			startup,
			sessionDir,
			async connect(connectOptions = {}) {
				const client = await connectThrough(connector, { hostRequests: TUI_HOST_REQUESTS, ...connectOptions });
				cleanups.push(() => client.stop());
				await client.query("conversation_info");
				return client;
			},
			async startMode(modeOptions = {}) {
				const tuiMode = modeOptions.tuiMode ?? "regular";
				vi.stubEnv("VOLT_CODING_AGENT_DIR", harness.tempDir);
				const settings = startup.session.settingsManager;
				const profile = settings.getActiveProfile();
				const mode = new InteractiveMode(connector, {
					tuiMode,
					// Where the startup conversation runs, as the volt CLI tells the TUI before its client connects.
					settingsScope: {
						cwd: startup.cwd,
						projectTrusted: settings.isProjectTrusted(),
						...(profile === undefined ? {} : { profile }),
					},
					...(modeOptions.projectTrust === undefined ? {} : { projectTrust: modeOptions.projectTrust }),
				});
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
				await connector.dispose().catch(() => undefined);
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

/** A phone's stream as the daemon relays it into the host. */
export interface RelayedStream {
	/** The phone's end of the relay, after the daemon's handshake. */
	readonly phoneEnd: ReturnType<typeof adaptRelaySocketToIrohStream>;
	/** Settles once the host finished serving the relay. */
	readonly finished: Promise<void>;
}

/**
 * Serve a phone the daemon relays into the harness host's `conversation` (the
 * one the TUI shows by default) as a conversation worker serves it: on the
 * remote profile with the daemon's preamble, following its structural intents
 * by redirect. Its daemon-backed intents and queries land in `relayed`.
 */
export function relayPhone(
	harness: TuiHarness,
	preamble: PhoneRelayPreamble,
	options: { conversation?: HostedConversation; relayed?: unknown[] } = {},
): RelayedStream {
	const [hostEnd, phoneEnd] = duplexPair();
	const finished = Promise.withResolvers<void>();
	void servePhoneRelay({
		host: harness.host,
		conversation: options.conversation ?? harness.connector.conversation,
		relay: { preamble, stream: hostEnd, finished: () => finished.resolve() },
		agentDir: harness.tempDir,
		daemon: {
			async forward(frame) {
				options.relayed?.push(frame);
				return frame.type === "query"
					? { type: "query_error", queryId: frame.queryId, reason: { code: "unavailable", message: "scripted" } }
					: { type: "accepted", intentId: frame.intentId, ordinals: [] };
			},
			async deliverNotification() {
				return "sent";
			},
		},
	}).catch(() => finished.resolve());
	return { phoneEnd: adaptRelaySocketToIrohStream(phoneEnd), finished: finished.promise };
}

/** A relay preamble for a phone paired with full access, reaching `sessionId` in workspace `ws` at `workspacePath`. */
export function relayPreamble(
	sessionId: string,
	workspacePath: string,
	options: { clientNodeId?: string; streamId?: string } = {},
): PhoneRelayPreamble {
	const clientNodeId = options.clientNodeId ?? "n-phone";
	const streamId = options.streamId ?? "st-1";
	return {
		type: "relay_preamble",
		kind: "phone",
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
