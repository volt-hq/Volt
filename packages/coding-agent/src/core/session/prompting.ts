/**
 * The session's prompting ({@link SessionPrompting}): `prompt`, `steer`, and
 * `followUp`, extension commands, skill and prompt template expansion, the
 * preflight before a turn (input hooks, model and auth, `before_agent_start`),
 * the `before_agent_start` system prompt override each turn's requests use,
 * and custom and extension user messages.
 */

import { readFileSync } from "node:fs";
import type {
	AdmissionGate,
	AgentMessage,
	AgentTool,
	Conversation,
	ConversationInput,
	ConversationInputAdmission,
	ConversationTurnReservation,
} from "@hansjm10/volt-agent-core";
import type { Api, ImageContent, JsonValue, Model, TextContent } from "@hansjm10/volt-ai";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import type { AgentSessionEvent, PromptOptions } from "../agent-session.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "../auth-guidance.ts";
import { cloneCanonicalData } from "../canonical-data.ts";
import { type ExtensionRunner, ExtensionUIDismissedError } from "../extensions/index.ts";
import type { CustomMessage, CustomMessageInput } from "../messages.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { expandPromptTemplate } from "../prompt-templates.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { SessionWriter } from "../session-writer.ts";
import type { SessionBackgroundContinuation } from "./background-continuation.ts";
import type { SessionBash } from "./bash.ts";
import { createLocalClientInputId, type LiveClientInput, type SessionClientInputs } from "./client-inputs.ts";
import type { SessionEvents } from "./events.ts";
import type { SessionExtensionWork } from "./extension-work.ts";
import type { SessionLifecycle } from "./lifecycle.ts";
import type { SessionToolRuntime } from "./tool-runtime.ts";

type PromptDispatchOutcome = "handled" | "queued" | "run";

export interface SessionPromptingHost {
	readonly resourceLoader: ResourceLoader;
	readonly modelRegistry: ModelRegistry;
	readonly admissionGate: AdmissionGate;
	/** Aborted when the session loses its log or is disposed; command handlers see it as `ctx.signal`. */
	readonly lifetimeSignal: AbortSignal;
	/** Resolves once, when the session loses its log. */
	readonly lost: Promise<Error>;
	conversation(): Conversation<AgentTool>;
	extensionRunner(): ExtensionRunner;
	extensionWork(): SessionExtensionWork;
	tools(): SessionToolRuntime;
	bash(): SessionBash;
	lifecycle(): SessionLifecycle;
	background(): SessionBackgroundContinuation;
	clientInputs(): SessionClientInputs;
	events(): SessionEvents;
	sessionWriter(): SessionWriter;
	isDisposed(): boolean;
	/** Rejects once the session is disposed or has lost its log. */
	assertActive(): void;
	/** A structural operation holds the conversation: compaction, tree navigation, or reload. */
	hasSessionOperationBarrier(): boolean;
	/** A turn holds the conversation, a prompt's reservation included. */
	turnActive(): boolean;
	/** The admission revision a stop advances: work admitted under an older one was aborted. */
	abortGeneration(): number;
	/** The model the active branch names. */
	model(): Model<Api> | undefined;
	/** A branch-local mutation lease, optionally layered over transport authority. */
	captureGenerationAssertion(assertExternalAuthorityCurrent?: () => void): () => void;
	/** Wait for the conversation's operations and queued input still committing. */
	waitForIdle(): Promise<void>;
	/** An `isBusy` input changed. */
	activityChanged(): void;
	/** The session's prompt, which extension user messages go through. */
	prompt(text: string, options?: PromptOptions): Promise<void>;
	emit(event: AgentSessionEvent): void;
}

export class SessionPrompting {
	private readonly host: SessionPromptingHost;
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private readonly pendingNextTurnMessages: CustomMessage[] = [];
	/** Inputs extensions sent (`sendUserMessage`) that have not settled; they start no extension work. */
	private readonly extensionInputIds = new Set<string>();
	private activeExtensionCommandHandlers = 0;
	/** Each prompt turn's `before_agent_start` system prompt override, recorded when its prompt is admitted. */
	private readonly turnSystemPromptOverrides = new Map<string, string | undefined>();

	constructor(host: SessionPromptingHost) {
		this.host = host;
	}

	/** Whether an extension command handler is running. */
	get extensionCommandRunning(): boolean {
		return this.activeExtensionCommandHandlers > 0;
	}

	/** Whether an extension sent the input (`sendUserMessage`) and it has not settled. */
	isExtensionInput(clientMessageId: string): boolean {
		return this.extensionInputIds.has(clientMessageId);
	}

	/** Forget the extension inputs that settled. */
	pruneSettledExtensionInputs(): void {
		for (const clientMessageId of this.extensionInputIds) {
			const state = this.host.conversation().state.clientInputs.inputs.get(clientMessageId)?.state;
			if (state === "completed" || state === "failed" || state === "withdrawn") {
				this.extensionInputIds.delete(clientMessageId);
			}
		}
	}

	/**
	 * The system prompt of a request: the turn's `before_agent_start` override
	 * from when its prompt was admitted, or the base prompt for its tools, then
	 * the trusted policy of the plan state the request runs in. A plan change
	 * the turn's delivery committed (a ready plan back to draft) applies from
	 * its first request.
	 */
	turnSystemPrompt(): string {
		const operationId = this.host.conversation().operation?.id;
		const override = operationId === undefined ? undefined : this.turnSystemPromptOverrides.get(operationId);
		return this.host.tools().composeSystemPrompt(override ?? this.host.tools().baseSystemPrompt);
	}

	/** No operation holds the conversation: no turn's override applies any more. */
	clearTurnSystemPrompts(): void {
		this.turnSystemPromptOverrides.clear();
	}

	/** A prompt, admitted as prompt work: see {@link AgentSession.prompt}. */
	async promptAdmitted(text: string, options?: PromptOptions): Promise<void> {
		if (this.host.isDisposed()) {
			throw new Error("Cannot prompt a disposed session");
		}
		this.host.assertActive();
		if (this.host.hasSessionOperationBarrier()) {
			throw new Error("Cannot prompt while a session mutation is active");
		}
		const assertConversationGenerationCurrent = this.host.captureGenerationAssertion(
			options?.assertConversationGenerationCurrent,
		);
		assertConversationGenerationCurrent();
		const clientInputs = this.host.clientInputs();
		clientInputs.assertRecoveredOrdering(options?.clientMessageId);
		const wasRunning = this.host.turnActive();
		// Claim the idle conversation for this prompt's turn while it is prepared;
		// input queued meanwhile waits for it.
		let reservation: ConversationTurnReservation | undefined;
		if (!wasRunning && this.host.admissionGate.isOpen && this.host.conversation().queue.prompt.length === 0) {
			reservation = this.host.conversation().reserve();
		}
		const clientMessageId = options?.clientMessageId;
		let admission: Awaited<ReturnType<SessionClientInputs["admit"]>> | undefined;
		try {
			admission =
				clientMessageId === undefined
					? undefined
					: await clientInputs.admit(
							clientInputs.conversationInput(
								"prompt",
								clientMessageId,
								text,
								options?.images,
								options?.streamingBehavior,
							),
						);
		} catch (error) {
			reservation?.cancel();
			throw error;
		}
		try {
			assertConversationGenerationCurrent();
		} catch (error) {
			reservation?.cancel();
			if (admission?.kind === "start" && clientMessageId !== undefined) {
				await clientInputs.fail(clientMessageId, error instanceof Error ? error : new Error(String(error)));
			}
			throw error;
		}
		const shouldQueue = wasRunning || !this.host.admissionGate.isOpen;
		const allowQueue = wasRunning && this.host.admissionGate.isOpen;
		const abortGeneration = this.host.abortGeneration();
		if (admission?.kind === "completed") {
			reservation?.cancel();
			options?.preflightResult?.({ success: true, outcome: "completed" });
			return;
		}
		if (admission?.kind === "live") {
			reservation?.cancel();
			return clientInputs.observeLivePrompt(admission.live, options?.preflightResult);
		}

		const live = admission?.live;
		if (live) {
			const originalPreflightResult = options?.preflightResult;
			void live.accepted.promise.then(
				(outcome) => originalPreflightResult?.({ success: true, outcome }),
				() => originalPreflightResult?.({ success: false }),
			);
		}
		const settlementRevision = this.host.events().settlementRevision;
		let outcome: PromptDispatchOutcome;
		try {
			outcome = await this.prompt(
				text,
				options,
				shouldQueue,
				allowQueue,
				abortGeneration,
				live,
				reservation,
				assertConversationGenerationCurrent,
			);
		} catch (error) {
			const normalized = clientInputs.inputError(error);
			// This process observed the failure before the canonical user append.
			// Leaving `started` would misreport it as a lost owner and fence every
			// later input after a reload.
			if (live && clientMessageId !== undefined) {
				await clientInputs.fail(clientMessageId, normalized);
			}
			throw normalized;
		}
		// A handled command or input hook already ran its side effects. If its
		// terminal write fails, `started` remains the truthful ambiguous outcome.
		if (outcome === "handled") {
			if (live && clientMessageId !== undefined) {
				try {
					this.host.assertActive();
					await this.host.conversation().settleClientInput(clientMessageId, { state: "completed" });
				} catch (error) {
					// The input stays `started`: a retry reports the ambiguous outcome instead of joining this one.
					const settled = clientInputs.live.get(clientMessageId);
					if (settled) {
						clientInputs.live.delete(clientMessageId);
						const settleError = clientInputs.inputError(error);
						settled.accepted.reject(settleError);
						settled.done.reject(settleError);
					}
					throw error;
				}
				clientInputs.complete(clientMessageId, "completed");
			} else if (!live && !this.host.isDisposed()) {
				// Local/prompt-backed UI actions have no durable client identity, but
				// their completed handler is still an authoritative admission boundary.
				options?.preflightResult?.({ success: true, outcome: "admitted" });
			}
			// A handler-owned prompt runs no turn to publish settlement, unless the
			// handler already completed a custom turn and published it itself.
			if (this.host.events().settlementRevision === settlementRevision) this.host.events().emitHandledSettlement();
		}
	}

	private async prompt(
		text: string,
		options: PromptOptions | undefined,
		shouldQueue: boolean,
		allowQueue: boolean,
		abortGeneration: number,
		live: LiveClientInput | undefined,
		initialReservation: ConversationTurnReservation | undefined,
		assertConversationGenerationCurrent: () => void,
	): Promise<PromptDispatchOutcome> {
		const clientInputs = this.host.clientInputs();
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		// Identified inputs report admission through their live record.
		const preflightResult = live ? undefined : options?.preflightResult;
		const identifiedClientMessageId = live ? options?.clientMessageId : undefined;
		let reservation = initialReservation;
		const releaseReservation = (): void => {
			reservation?.cancel();
			reservation = undefined;
		};
		let input: ConversationInput;
		let attachments: AgentMessage[];
		let extensionInputId: string | undefined;
		let systemPromptOverride: string | undefined;

		try {
			assertConversationGenerationCurrent();
			if (this.host.isDisposed() || abortGeneration !== this.host.abortGeneration()) {
				throw new Error("Prompt aborted before preflight started");
			}

			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via volt.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this.tryExecuteExtensionCommand(text, async () => {
					releaseReservation();
					await clientInputs.markStarted(identifiedClientMessageId, abortGeneration);
					if (this.host.isDisposed() || abortGeneration !== this.host.abortGeneration()) {
						throw new Error("Prompt aborted before preflight started");
					}
				});
				if (handled) {
					// Extension command executed, no prompt to send
					releaseReservation();
					return "handled";
				}
				assertConversationGenerationCurrent();
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this.host.extensionRunner().hasHandlers("input")) {
				// Input hooks are arbitrary side-effect boundaries. Persist ambiguity
				// before entering them. A later durable queued payload safely returns
				// this receipt to recoverable `accepted`; a crash in between never
				// re-executes an uncertain hook.
				await clientInputs.markStarted(identifiedClientMessageId, abortGeneration);
				const inputResult = await this.host
					.extensionRunner()
					.emitInput(
						currentText,
						currentImages,
						options?.source ?? "interactive",
						shouldQueue ? options?.streamingBehavior : undefined,
					);
				assertConversationGenerationCurrent();
				if (this.host.isDisposed() || abortGeneration !== this.host.abortGeneration()) {
					throw new Error("Prompt aborted during input preflight");
				}
				if (inputResult.action === "handled") {
					releaseReservation();
					return "handled";
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this.expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.host.resourceLoader.getPrompts().prompts]);
			}
			input = {
				...clientInputs.conversationInput(
					"prompt",
					options?.clientMessageId ?? createLocalClientInputId(),
					text,
					options?.images,
					options?.streamingBehavior,
				),
				prepared: { message: expandedText, ...(currentImages === undefined ? {} : { images: currentImages }) },
			};
			if (options?.source === "extension") {
				extensionInputId = input.clientMessageId!;
				this.extensionInputIds.add(extensionInputId);
			}

			// Queue only behind an active turn. During preflight or abort, reject
			// promptly so an accepted message cannot be stranded.
			if (shouldQueue) {
				assertConversationGenerationCurrent();
				if (allowQueue && !this.host.turnActive()) {
					throw new Error(
						"Agent finished processing while queued prompt preflight was running. Resubmit the prompt.",
					);
				}
				if (!allowQueue || !options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				clientInputs.assertQueueCapacity();
				if (options.streamingBehavior === "steer") this.host.extensionWork().invalidate();
				const admission = await clientInputs.trackQueueAdmission(this.host.conversation().prompt(input));
				if (admission.ordinals.length > 0) clientInputs.reportQueuedOutcome(admission);
				if (identifiedClientMessageId !== undefined) {
					clientInputs.complete(identifiedClientMessageId, "admitted");
				}
				preflightResult?.({ success: true, outcome: "admitted" });
				releaseReservation();
				return "queued";
			}

			// Flush any pending bash messages before the new prompt
			assertConversationGenerationCurrent();
			await this.host.bash().flushPending();

			// Validate model
			const model = this.host.model();
			if (!model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			if (!this.host.modelRegistry.hasConfiguredAuth(model)) {
				const isOAuth = this.host.modelRegistry.isUsingOAuth(model);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}

			// Deterministic model/auth preflight is complete. Everything below can
			// invoke side-effect-capable before_agent_start and message hooks.
			// Persist the ambiguous dispatch boundary before any of them so a crash
			// never replays extension or provider side effects.
			await clientInputs.markStarted(identifiedClientMessageId, abortGeneration);

			// Snapshot pending "nextTurn" context. It is consumed only after preflight
			// is accepted so aborting an extension hook cannot lose queued context.
			const pendingNextTurnMessages = [...this.pendingNextTurnMessages];
			attachments = [...pendingNextTurnMessages];

			// Emit before_agent_start extension event
			const tools = this.host.tools();
			const result = await this.host
				.extensionRunner()
				.emitBeforeAgentStart(expandedText, currentImages, tools.baseSystemPrompt, tools.baseSystemPromptOptions);
			assertConversationGenerationCurrent();
			if (this.host.isDisposed() || abortGeneration !== this.host.abortGeneration()) {
				throw new Error("Prompt aborted before the agent run started");
			}

			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					attachments.push(
						cloneCanonicalData(
							{
								role: "custom",
								customType: msg.customType,
								content: msg.content,
								display: msg.display,
								...(msg.details === undefined ? {} : { details: msg.details }),
								timestamp: Date.now(),
							} satisfies CustomMessage,
							`Extension before_agent_start message ${msg.customType}`,
						),
					);
				}
			}
			// Apply the per-turn extension prompt before appending trusted planning instructions.
			systemPromptOverride = result?.systemPrompt;
			tools.applyTrustedPlanningInstructions(systemPromptOverride);

			this.pendingNextTurnMessages.splice(0, pendingNextTurnMessages.length);
			// Turn-start seam: every fresh-input turn surfaces recovered subagent
			// results first, behind the admission and generation fences.
			await this.host.lifecycle().maybeAppendSubagentRecoveryNotice();
			assertConversationGenerationCurrent();
			if (this.host.isDisposed() || abortGeneration !== this.host.abortGeneration()) {
				throw new Error("Prompt aborted before the agent run started");
			}
		} catch (error) {
			releaseReservation();
			if (extensionInputId !== undefined) this.extensionInputIds.delete(extensionInputId);
			preflightResult?.({ success: false });
			assertConversationGenerationCurrent();
			throw error;
		}

		this.host.background().explicitRunStarted();
		// The turn's requests use the before_agent_start override as admitted.
		if (reservation) this.turnSystemPromptOverrides.set(reservation.id, systemPromptOverride);
		const clientMessageId = input.clientMessageId!;
		const tracked = live ?? clientInputs.createLive("prompt", input, true);
		if (!live) clientInputs.live.set(clientMessageId, tracked);
		let admitted: ConversationInputAdmission;
		try {
			admitted = await this.host
				.conversation()
				.prompt({ ...input, attachments }, reservation === undefined ? {} : { reservation });
		} catch (error) {
			if (reservation) this.turnSystemPromptOverrides.delete(reservation.id);
			if (!live && clientInputs.live.get(clientMessageId) === tracked) {
				clientInputs.live.delete(clientMessageId);
			}
			preflightResult?.({ success: false });
			throw clientInputs.inputError(error);
		}
		// The prompt's turn runs under its reservation, or under the lease the conversation took for it.
		tracked.operationId = reservation?.id ?? this.host.conversation().operation?.id;
		if (!live) {
			// Identified inputs acknowledge through their canonical user commit.
			// Unidentified local/UI-action prompts still need a bounded admission
			// signal so their caller need not hold lifecycle ownership for the full
			// provider turn.
			preflightResult?.({ success: true, outcome: "admitted" });
		}
		void admitted.completion.then(
			(completion) => {
				if (completion.state === "completed") {
					clientInputs.complete(clientMessageId, "admitted");
					return;
				}
				// A local prompt its turn stopped before delivering (an abort, a stop policy) ends quietly.
				if (completion.state === "withdrawn" && tracked.local) {
					clientInputs.complete(clientMessageId, "admitted");
					return;
				}
				// A hook that failed the turn reports its own error.
				const fatalError =
					tracked.operationId === undefined ? undefined : this.host.events().turnFatalError(tracked.operationId);
				const error =
					fatalError ??
					new Error(
						completion.state === "failed"
							? completion.error
							: "client_input_failed: queued input was cleared before canonical consumption",
					);
				tracked.accepted.reject(error);
				tracked.done.reject(error);
				if (clientInputs.live.get(clientMessageId) === tracked) clientInputs.live.delete(clientMessageId);
			},
			(error: unknown) => {
				if (tracked.local && this.host.isDisposed()) {
					tracked.accepted.resolve("admitted");
					tracked.done.resolve();
					return;
				}
				const ended = error instanceof Error ? error : new Error(String(error));
				tracked.accepted.reject(ended);
				tracked.done.reject(ended);
			},
		);
		try {
			await tracked.done.promise;
		} finally {
			if (clientInputs.live.get(clientMessageId) === tracked) clientInputs.live.delete(clientMessageId);
		}
		const fatalError =
			tracked.operationId === undefined ? undefined : this.host.events().turnFatalError(tracked.operationId);
		// Settlement events (agent_settled) are published before the prompt resolves.
		await this.host.conversation().waitForIdle();
		if (fatalError) throw fatalError;
		return "run";
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async tryExecuteExtensionCommand(text: string, onWillExecute?: () => Promise<void>): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this.host.extensionRunner().getCommand(commandName);
		if (!command) return false;
		// A command handler is an arbitrary side-effect boundary with no canonical
		// user append. Persist `started` first so a crash can only replay an
		// explicit ambiguous outcome, never execute the handler twice.
		await onWillExecute?.();

		// Command transactions must not wait on themselves or each other.
		// waitForIdle still waits for active runs and non-command prompt work.
		const ctx = this.host
			.extensionRunner()
			.createCommandContext(() => this.host.waitForIdle(), this.host.lifetimeSignal);

		const releaseActivity = this.host.conversation().beginActivity("extension_command");
		this.activeExtensionCommandHandlers++;
		try {
			const handler = Promise.resolve(command.handler(args, ctx));
			// After the session lost its log nothing the handler does can be saved. Stop awaiting
			// it (its ctx.signal is aborted) so a handler that never settles cannot keep the
			// ending runtime alive.
			const abandoned = await Promise.race([handler.then(() => false), this.host.lost.then(() => true)]);
			if (abandoned) {
				void handler.catch(() => undefined);
				return true;
			}
			return true;
		} catch (err) {
			// Volt tore the handler's custom UI down (session replacement, reload, or the session ending).
			if (err instanceof ExtensionUIDismissedError) return true;
			// Emit error via extension runner
			this.host.extensionRunner().emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		} finally {
			this.activeExtensionCommandHandlers--;
			releaseActivity();
			this.host.activityChanged();
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.host.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this.host.extensionRunner().emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/** Queue durable steering or follow-up input; it is acknowledged once its queue intent commits. */
	async queueInput(
		command: "steer" | "follow_up",
		text: string,
		images: ImageContent[] | undefined,
		clientMessageId: string | undefined,
	): Promise<void> {
		this.host.assertActive();
		if (this.host.hasSessionOperationBarrier()) {
			throw new Error("Cannot queue input while a session mutation is active");
		}
		const clientInputs = this.host.clientInputs();
		clientInputs.assertRecoveredOrdering(clientMessageId);
		const input = clientInputs.conversationInput(
			command,
			clientMessageId ?? createLocalClientInputId(),
			text,
			images,
		);
		if (clientMessageId !== undefined && (await clientInputs.existing(command, input)) !== undefined) return;
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this.throwIfExtensionCommand(text);
		}
		clientInputs.assertQueueCapacity();

		// Expand skill commands and prompt templates
		let expandedText = this.expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.host.resourceLoader.getPrompts().prompts]);
		const prepared: ConversationInput = {
			...input,
			prepared: { message: expandedText, ...(images === undefined ? {} : { images }) },
		};
		let admission: ConversationInputAdmission;
		try {
			if (command === "steer") {
				this.host.extensionWork().invalidate();
				admission = await clientInputs.trackQueueAdmission(this.host.conversation().steer(prepared));
			} else {
				admission = await clientInputs.trackQueueAdmission(this.host.conversation().followUp(prepared));
			}
		} catch (error) {
			throw clientInputs.inputError(error);
		}
		// A concurrent duplicate joins the first admission, which reports the outcome.
		if (admission.ordinals.length > 0) clientInputs.reportQueuedOutcome(admission);
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this.host.extensionRunner().getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message: see {@link AgentSession.sendCustomMessage}.
	 * `allowDuringPromptTransaction` lets it start a turn while a prompt is
	 * being prepared; `appendDuringReservedTurn` commits it ahead of the turn
	 * being prepared.
	 */
	async sendCustomMessage<T>(
		message: CustomMessageInput<T>,
		options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined,
		allowDuringPromptTransaction: boolean,
		appendDuringReservedTurn = false,
	): Promise<void> {
		this.host.assertActive();
		if (this.host.hasSessionOperationBarrier()) {
			throw new Error("Cannot append a custom message while a session mutation is active");
		}
		const ownedInput = cloneCanonicalData(message, "Custom message input");
		const appMessage = cloneCanonicalData(
			{
				role: "custom" as const,
				customType: ownedInput.customType,
				content: ownedInput.content,
				display: ownedInput.display,
				...(ownedInput.details === undefined ? {} : { details: ownedInput.details as JsonValue }),
				timestamp: Date.now(),
			} satisfies CustomMessage,
			`Custom message ${ownedInput.customType}`,
		);
		const conversation = this.host.conversation();
		const clientInputs = this.host.clientInputs();
		if (options?.deliverAs === "nextTurn") {
			this.pendingNextTurnMessages.push(appMessage);
		} else if (this.host.turnActive() && !appendDuringReservedTurn) {
			if (options?.deliverAs !== "followUp") this.host.extensionWork().invalidate();
			await clientInputs.trackQueueAdmission(
				conversation.queueMessages(options?.deliverAs === "followUp" ? "followUp" : "steer", [appMessage]),
			);
		} else if (options?.triggerTurn) {
			if (
				(conversation.operation !== undefined || this.activeExtensionCommandHandlers > 0) &&
				!allowDuringPromptTransaction
			) {
				throw new Error("Agent is already processing a prompt transaction");
			}
			if (!this.host.model()) throw new Error(formatNoModelSelectedMessage());
			this.host.admissionGate.assertOpen();
			const abortGeneration = this.host.abortGeneration();
			// Claim the idle conversation now, so a caller waiting for idle joins the turn this message starts.
			const reservation =
				conversation.operation === undefined && this.host.admissionGate.isOpen ? conversation.reserve() : undefined;
			let admission: ConversationInputAdmission;
			try {
				await this.host.lifecycle().maybeAppendSubagentRecoveryNotice();
				if (this.host.isDisposed() || abortGeneration !== this.host.abortGeneration()) return;
				this.host.assertActive();
				this.host.background().explicitRunStarted();
				// Queued while the claim is held, the message waits for the turn that takes the claim over.
				admission = await conversation.queueMessages("steer", [appMessage]);
			} finally {
				// Released while the message is pending, the claim passes to the turn that delivers it.
				reservation?.cancel();
			}
			const tracked = clientInputs.createLive(
				"steer",
				{ clientMessageId: admission.clientMessageId, message: "" },
				true,
			);
			tracked.operationId = conversation.operation?.id;
			clientInputs.live.set(admission.clientMessageId, tracked);
			if (tracked.operationId === undefined) {
				// No turn could start (admission was suspended meanwhile): nothing will deliver the message.
				await clientInputs.fail(admission.clientMessageId, new Error("The turn for the message could not start"));
			}
			void admission.completion.then(
				(completion) => {
					if (completion.state === "completed") tracked.done.resolve();
					else {
						const fatalError =
							tracked.operationId === undefined
								? undefined
								: this.host.events().turnFatalError(tracked.operationId);
						tracked.done.reject(
							fatalError ?? new Error(completion.state === "failed" ? completion.error : "Withdrawn"),
						);
					}
				},
				(error: unknown) => {
					if (this.host.isDisposed()) tracked.done.resolve();
					else tracked.done.reject(error instanceof Error ? error : new Error(String(error)));
				},
			);
			try {
				await tracked.done.promise;
			} finally {
				if (clientInputs.live.get(admission.clientMessageId) === tracked) {
					clientInputs.live.delete(admission.clientMessageId);
				}
			}
			await conversation.waitForIdle();
		} else {
			await this.host
				.sessionWriter()
				.appendCustomMessageEntry(
					appMessage.customType,
					appMessage.content,
					appMessage.display,
					appMessage.details,
				);
			this.host.emit({ type: "message_start", message: appMessage });
			this.host.emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message: see {@link AgentSession.sendUserMessage}. It goes
	 * through the session's prompt without command handling or template
	 * expansion.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		this.host.assertActive();
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.host.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}
}
