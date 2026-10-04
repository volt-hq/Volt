/**
 * Conversation host harness for suite tests: a `ConversationHost` whose
 * factory creates sessions over the faux provider, with one extension that
 * records its lifecycle events.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider, type FauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type {
	ExtensionAPI,
	ExtensionFactory,
	ExtensionMode,
	ExtensionUIContext,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/core/extensions/index.ts";
import { ConversationHost, type OpenForResult, type WhenUnattached } from "../../src/core/host/conversation-host.ts";
import type { ConversationFactory, HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import type { HostClient } from "../../src/core/host/targets.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

/** A lifecycle event an extension instance saw, tagged with the session it belongs to. */
export type RecordedLifecycleEvent = (
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent
) & { sessionId: string };

/** The result of a structural intent that moved its client; throws when it was cancelled. */
export function moved(result: OpenForResult): Extract<OpenForResult, { cancelled: false }> {
	if (result.cancelled) throw new Error("Expected the client to move");
	return result;
}

export interface HostHarnessOptions {
	/** Extra extension behavior, added to the recording extension. */
	extension?: ExtensionFactory;
	whenUnattached?: WhenUnattached;
	/** The mode the host binds extensions in; "print" by default. */
	extensionMode?: ExtensionMode;
	/** Runs before the factory creates each session; throw to fail the open. */
	beforeCreate?: (sessionManager: SessionManager) => Promise<void> | void;
	responses?: string[];
}

export interface HostHarness {
	host: ConversationHost;
	factory: ConversationFactory;
	faux: FauxProvider;
	tempDir: string;
	/** Lifecycle events every extension instance saw, in order. */
	events: RecordedLifecycleEvent[];
	/** Open a new conversation stored in `<tempDir>/sessions`, as startup does. */
	openStartup(): Promise<HostedConversation>;
	/** An in-place client with a surface; `moves` records the conversations it moved to. */
	client(id: string, options?: { anchor?: boolean; ui?: ExtensionUIContext }): HostClient & { moves: string[] };
	cleanup(): Promise<void>;
}

export async function createHostHarness(options: HostHarnessOptions = {}): Promise<HostHarness> {
	const tempDir = mkdtempSync(join(tmpdir(), "volt-host-"));
	const faux = createFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
	faux.setResponses((options.responses ?? ["one", "two", "three"]).map((text) => fauxAssistantMessage(text)));
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
	const events: RecordedLifecycleEvent[] = [];

	const factory: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		await options.beforeCreate?.(sessionManager);
		const services = await createAgentSessionServices({
			cwd,
			agentDir: tempDir,
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
						const record = (event: Omit<RecordedLifecycleEvent, "sessionId">, sessionId: string): void => {
							events.push({ ...event, sessionId } as RecordedLifecycleEvent);
						};
						volt.on("session_start", (event, ctx) => record(event, ctx.sessionManager.getSessionId()));
						volt.on("session_before_switch", (event, ctx) => record(event, ctx.sessionManager.getSessionId()));
						volt.on("session_before_fork", (event, ctx) => record(event, ctx.sessionManager.getSessionId()));
						volt.on("session_shutdown", (event, ctx) => record(event, ctx.sessionManager.getSessionId()));
						options.extension?.(volt);
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
	const host = new ConversationHost({
		factory,
		agentDir: tempDir,
		extensionMode: options.extensionMode ?? "print",
		...(options.whenUnattached === undefined ? {} : { whenUnattached: options.whenUnattached }),
	});

	return {
		host,
		factory,
		faux,
		tempDir,
		events,
		async openStartup() {
			const sessionManager = await SessionManager.create(tempDir, join(tempDir, "sessions"));
			const opened = await host.open({ kind: "adopt", sessionManager });
			if (opened.cancelled) throw new Error("A startup open cannot be cancelled");
			return opened.conversation;
		},
		client(id, clientOptions = {}) {
			const moves: string[] = [];
			return {
				id,
				...(clientOptions.anchor === undefined ? {} : { anchor: clientOptions.anchor }),
				surface: clientOptions.ui === undefined ? {} : { ui: clientOptions.ui },
				move: {
					kind: "in_place",
					onMoved: (to) => {
						moves.push(to.id);
					},
				},
				moves,
			};
		},
		async cleanup() {
			await host.dispose().catch(() => undefined);
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
	};
}
