/**
 * Test scaffolding over the conversation host API: open a conversation in a
 * `ConversationHost`, or host a session a test built itself, and attach an
 * in-place test client whose structural intents run through the host's
 * session intents.
 */

import { randomUUID } from "node:crypto";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionDiagnostic, AgentSessionServices } from "../../src/core/agent-session-services.ts";
import type { ExtensionMode, SessionIntentResult } from "../../src/core/extensions/index.ts";
import { ConversationHost, type WhenUnattached } from "../../src/core/host/conversation-host.ts";
import type {
	ConversationFactory,
	HostedConversation,
	SubagentRuntimeContext,
} from "../../src/core/host/hosted-conversation.ts";
import { executePlan } from "../../src/core/host/plan-handoff.ts";
import {
	type ForkIntentResult,
	type NewSessionIntentOptions,
	openFork,
	openImport,
	openNewSession,
	openStoredSession,
	openStoredSessionById,
	type SwitchSessionIntentOptions,
} from "../../src/core/host/session-intents.ts";
import type { HostClient, HostClientMove } from "../../src/core/host/targets.ts";
import type { PlanExecutionStrategy } from "../../src/core/planning.ts";
import type { SessionManager, SessionReference } from "../../src/core/session-manager.ts";

export interface OpenTestHostOptions {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	/** Default: "print". */
	extensionMode?: ExtensionMode;
	whenUnattached?: WhenUnattached;
	profile?: string;
	subagentContext?: SubagentRuntimeContext;
	workspaceName?: string;
	baseRef?: string;
}

export interface TestHost {
	readonly host: ConversationHost;
	readonly conversation: HostedConversation;
}

/** Open `sessionManager`'s log in a new host, as startup does. */
export async function openTestHost(factory: ConversationFactory, options: OpenTestHostOptions): Promise<TestHost> {
	const host = new ConversationHost({
		factory,
		agentDir: options.agentDir,
		extensionMode: options.extensionMode ?? "print",
		...(options.whenUnattached === undefined ? {} : { whenUnattached: options.whenUnattached }),
	});
	const opened = await host.open(
		{ kind: "adopt", sessionManager: options.sessionManager, cwd: options.cwd },
		{
			...(Object.hasOwn(options, "profile") ? { profile: options.profile } : {}),
			...(options.subagentContext === undefined ? {} : { subagentContext: options.subagentContext }),
			...(options.workspaceName === undefined ? {} : { workspaceName: options.workspaceName }),
			...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
		},
	);
	if (opened.cancelled) throw new Error("A startup open cannot be cancelled");
	return { host, conversation: opened.conversation };
}

/** Host a session a test created outside any host; later conversations open through `factory`. */
export function adoptTestSession(
	session: AgentSession,
	services: AgentSessionServices,
	factory: ConversationFactory,
	options: {
		diagnostics?: AgentSessionDiagnostic[];
		extensionMode?: ExtensionMode;
		subagentContext?: SubagentRuntimeContext;
	} = {},
): TestHost {
	const host = new ConversationHost({
		factory,
		agentDir: services.agentDir,
		extensionMode: options.extensionMode ?? "print",
	});
	const conversation = host.adoptSession(
		{ session, services, diagnostics: options.diagnostics ?? [] },
		options.subagentContext === undefined ? {} : { subagentContext: options.subagentContext },
	);
	return { host, conversation };
}

export interface TestClientOptions {
	/** Default: true. */
	anchor?: boolean;
	surface?: HostClient["surface"];
	/** The client's view of each conversation's live state. */
	live?: HostClient["live"];
	/** Observes each move once the client joined the new conversation. */
	onMoved?: (to: HostedConversation, from: HostedConversation | undefined) => Promise<void> | void;
	/** Runs once the client left a conversation, before it joins the next one. */
	prepare?: Extract<HostClientMove, { kind: "in_place" }>["prepare"];
	id?: string;
}

/** An in-place test client of a host and the session intents it runs. */
export interface TestClient {
	readonly host: ConversationHost;
	readonly client: HostClient;
	/** The conversation the client is on. */
	readonly conversation: HostedConversation;
	readonly session: AgentSession;
	readonly services: AgentSessionServices;
	readonly cwd: string;
	/**
	 * Resolves once, when the conversation the client is on loses its log.
	 */
	readonly lost: Promise<Error>;
	/** Replay the conversation's durable queued input, and that of every conversation the client moves to. */
	startRecoveredClientInputs(): Promise<void>;
	newSession(options?: NewSessionIntentOptions): Promise<SessionIntentResult>;
	switchSession(sessionRef: SessionReference, options?: SwitchSessionIntentOptions): Promise<SessionIntentResult>;
	switchSessionById(sessionId: string, options?: SwitchSessionIntentOptions): Promise<SessionIntentResult>;
	fork(entryId: string, options?: Parameters<typeof openFork>[3]): Promise<ForkIntentResult>;
	importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }>;
	executePlan(
		planId: string,
		expectedRevision: number,
		strategy: PlanExecutionStrategy,
		assertConversationGenerationCurrent?: () => void,
	): ReturnType<typeof executePlan>;
	/** Leave the conversation; an anchor closes it. */
	dispose(): Promise<void>;
}

/** Attach an in-place client to `conversation`; its surface, if any, binds the conversation's extensions. */
export async function connectTestClient(
	host: ConversationHost,
	conversation: HostedConversation,
	options: TestClientOptions = {},
): Promise<TestClient> {
	let current = conversation;
	let recovers = false;
	const lost = Promise.withResolvers<Error>();
	const observeLoss = (observed: HostedConversation): void => {
		void observed.lost.then((error) => {
			if (observed === current) lost.resolve(error);
		});
	};
	const client: HostClient = {
		id: options.id ?? randomUUID(),
		...(options.anchor === false ? {} : { anchor: true }),
		...(options.surface === undefined ? {} : { surface: options.surface }),
		...(options.live === undefined ? {} : { live: options.live }),
		get recoversInput() {
			return recovers;
		},
		move: {
			kind: "in_place",
			prepare: (to, from) => {
				current = to;
				options.prepare?.(to, from);
			},
			onMoved: async (to, from) => {
				observeLoss(to);
				await options.onMoved?.(to, from);
			},
		},
	};
	observeLoss(conversation);
	await host.attach(client, conversation);
	return {
		host,
		client,
		get conversation() {
			return current;
		},
		get session() {
			return current.session;
		},
		get services() {
			return current.services;
		},
		get cwd() {
			return current.cwd;
		},
		lost: lost.promise,
		startRecoveredClientInputs: () => {
			recovers = true;
			return current.startRecoveredClientInputs();
		},
		newSession: (newSessionOptions) => openNewSession(host, client, newSessionOptions),
		switchSession: (sessionRef, switchOptions) => openStoredSession(host, client, sessionRef, switchOptions),
		switchSessionById: (sessionId, switchOptions) => openStoredSessionById(host, client, sessionId, switchOptions),
		fork: (entryId, forkOptions) => openFork(host, client, entryId, forkOptions),
		importFromJsonl: (inputPath, cwdOverride) => openImport(host, client, inputPath, cwdOverride),
		executePlan: (planId, expectedRevision, strategy, assertConversationGenerationCurrent) =>
			executePlan(host, client, planId, expectedRevision, strategy, assertConversationGenerationCurrent),
		dispose: async () => {
			if (host.conversationOf(client)) await host.detach(client);
			else if (options.anchor !== false) await host.close(current);
		},
	};
}
