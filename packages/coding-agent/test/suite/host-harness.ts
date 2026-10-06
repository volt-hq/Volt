/**
 * Conversation host harness for suite tests: a `ConversationHost` whose
 * factory creates sessions over the faux provider, with one extension that
 * records its lifecycle events.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider, type FauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { ExtensionPermission, ExtensionSettings } from "@hansjm10/volt-protocol";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type {
	ExtensionAPI,
	ExtensionDefinition,
	ExtensionFactory,
	ExtensionMode,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/core/extensions/index.ts";
import {
	ConversationHost,
	type OpenForResult,
	type OpenGate,
	type WhenUnattached,
} from "../../src/core/host/conversation-host.ts";
import type { ConversationFactory, HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import type { LiveClient } from "../../src/core/host/live-state.ts";
import type { HostClient } from "../../src/core/host/targets.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { type SubagentDefinition, SubagentManager } from "../../src/core/subagents/index.ts";

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
	/** Give each session a subagent manager over these definitions; children open through the same factory. */
	subagents?: readonly SubagentDefinition[];
	/** Permissions the recording extension declares besides `providers`, which it registers the faux provider with. */
	permissions?: ExtensionPermission[];
	/** The settings the recording extension declares. */
	settings?: ExtensionSettings;
	/** More extensions every session loads after the recording extension. */
	extensions?: readonly ExtensionDefinition[];
	/** The host's open gate. */
	openGate?: OpenGate;
	/** Global settings every session reads (the agent directory's `settings.json`). */
	globalSettings?: Partial<Settings>;
	/** The faux provider's models; one model that does not think by default. */
	models?: NonNullable<Parameters<typeof createFauxProvider>[0]>["models"];
	/** Skill files or directories every session loads. */
	skillPaths?: string[];
	/** Prompt template files or directories every session loads. */
	promptTemplatePaths?: string[];
	/** Theme files every session loads. */
	themePaths?: string[];
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
	client(id: string, options?: { anchor?: boolean; live?: LiveClient }): HostClient & { moves: string[] };
	cleanup(): Promise<void>;
}

export async function createHostHarness(options: HostHarnessOptions = {}): Promise<HostHarness> {
	const tempDir = mkdtempSync(join(tmpdir(), "volt-host-"));
	if (options.globalSettings !== undefined) {
		writeFileSync(join(tempDir, "settings.json"), JSON.stringify(options.globalSettings));
	}
	const faux = createFauxProvider({ models: options.models ?? [{ id: "faux-1", reasoning: false }] });
	faux.setResponses((options.responses ?? ["one", "two", "three"]).map((text) => fauxAssistantMessage(text)));
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
	const events: RecordedLifecycleEvent[] = [];

	const factory: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent, subagentContext }) => {
		await options.beforeCreate?.(sessionManager);
		const services = await createAgentSessionServices({
			cwd,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					{
						manifest: {
							id: "test-extension",
							displayName: "test-extension",
							permissions: ["providers", ...(options.permissions ?? [])],
							...(options.settings === undefined ? {} : { settings: options.settings }),
						},
						factory: (volt: ExtensionAPI) => {
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
					},
					...(options.extensions ?? []),
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				...(options.skillPaths === undefined ? {} : { additionalSkillPaths: options.skillPaths }),
				...(options.promptTemplatePaths === undefined
					? {}
					: { additionalPromptTemplatePaths: options.promptTemplatePaths }),
				...(options.themePaths === undefined ? {} : { additionalThemePaths: options.themePaths }),
			},
		});
		const definitions = options.subagents;
		let subagentToolManager: SubagentManager | undefined;
		if (definitions) {
			services.resourceLoader.getSubagents = () => ({ definitions: [...definitions], diagnostics: [] });
			subagentToolManager = new SubagentManager({
				createRuntime: factory,
				cwd,
				agentDir: tempDir,
				resourceLoader: services.resourceLoader,
				parentSessionManager: sessionManager,
				...(subagentContext === undefined ? {} : { subagentContext }),
			});
		}
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				...(subagentToolManager === undefined ? {} : { subagentToolManager }),
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
		...(options.openGate === undefined ? {} : { openGate: options.openGate }),
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
				surface: {},
				...(clientOptions.live === undefined ? {} : { live: clientOptions.live }),
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
