/**
 * Extension work: optional read-only preparation extensions run at a turn's
 * request boundaries. Each boundary opens a scope over the batch it delivers;
 * collected text joins the request when it fits the model's headroom and its
 * authorization is still current. Work runs trusted built-in read tools
 * through the same tool-call and tool-result gates as the agent, and is
 * invalidated whenever the session's authority over it changes.
 */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
	AgentTool,
	Conversation,
	ConversationRequestBoundary,
	ConversationRequestContext,
} from "@hansjm10/volt-agent-core";
import {
	type Api,
	type Context,
	estimateToolDefinitionTokens,
	type JsonObject,
	type JsonValue,
	type Model,
	validateToolArguments,
} from "@hansjm10/volt-ai";
import type { AgentSessionTurnPolicy } from "../agent-session.ts";
import { cloneCanonicalData } from "../canonical-data.ts";
import { estimateMessagesTokens } from "../compaction/index.ts";
import type { ExtensionRunner, ToolDefinition } from "../extensions/index.ts";
import type { ExtensionWorkExecution, ExtensionWorkExecutionResult } from "../extensions/work-host.ts";
import { ExtensionWorkManager, withoutExtensionWork } from "../extensions/work-runtime.ts";
import { ExtensionSkillCatalog } from "../extensions/work-skills.ts";
import type { ExtensionWorkFailure, ExtensionWorkLimits, ExtensionWorkService } from "../extensions/work-types.ts";
import { withManagedLspObservation } from "../lsp/managed-observation.ts";
import {
	authorizeToolOperation,
	type OperationGrantProfile,
	type ToolOperationResolver,
} from "../operation-authorization.ts";
import type { AgentMode } from "../planning.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { Skill } from "../skills.ts";
import { RepositoryObservationError, withRepositoryObservation } from "../tools/repository-observation.ts";
import { extractUserMessageText } from "./session-info.ts";

/** The built-in tool each extension work service runs. */
const EXTENSION_WORK_TOOLS = {
	readText: "read",
	findPaths: "find",
	searchText: "grep",
	readSkill: "read",
	symbols: "lsp",
	definition: "lsp",
	references: "lsp",
} as const;
const EXTENSION_WORK_GRANT: OperationGrantProfile = {
	id: "extension-preparation-read",
	capabilities: new Set(["workspace.read"]),
};

export interface SessionExtensionWorkHost {
	readonly settingsManager: SettingsManager;
	/** The session's working directory. */
	readonly cwd: string;
	/** Whether the session can run extension work: open, not reloading, admitting operations, and holding its log. */
	isCurrent(): boolean;
	conversation(): Conversation<AgentTool> | undefined;
	extensionRunner(): ExtensionRunner;
	sessionId(): string;
	/** The branch generation: changes exactly when the active branch switches. */
	generation(): number;
	/** The model the active branch names. */
	model(): Model<Api> | undefined;
	/** The session's Plan/Build mode. */
	mode(): AgentMode;
	/** The loaded skills. */
	skills(): Skill[];
	/** Whether the tool is active for the session's requests. */
	isToolActive(name: string): boolean;
	tool(name: string): AgentTool | undefined;
	toolDefinition(name: string): ToolDefinition | undefined;
	/** The operation resolver of a trusted built-in tool, or undefined for any other tool. */
	trustedOperationResolver(name: string): ToolOperationResolver | undefined;
	/** The capability profile Plan mode restricts tools to, or undefined in Build mode. */
	operationGrantProfile(): OperationGrantProfile | undefined;
	/** The registered turn policies, in registration order. */
	turnPolicies(): Iterable<{ readonly policy: Readonly<AgentSessionTurnPolicy> }>;
	/** Changes whenever a registered turn policy's tool-call gate changes. */
	policyRevision(): bigint;
	/** Whether an extension sent this input itself (`sendUserMessage`). */
	isExtensionInput(clientMessageId: string): boolean;
}

export class SessionExtensionWork {
	private readonly host: SessionExtensionWorkHost;
	private readonly limits: Partial<ExtensionWorkLimits> | undefined;
	private manager!: ExtensionWorkManager;
	private skills!: ExtensionSkillCatalog;
	private key: string | undefined;
	private signal: AbortSignal | undefined;
	private abortListener: (() => void) | undefined;
	/** The implementation each trusted work tool had when it was registered; a replacement invalidates work on it. */
	private readonly implementations = new WeakMap<
		AgentTool,
		{
			execute: AgentTool["execute"];
			definitionExecute: ToolDefinition["execute"];
			parameters: AgentTool["parameters"];
		}
	>();

	/** @throws TypeError when `limits` loosens a host ceiling */
	constructor(host: SessionExtensionWorkHost, limits: Partial<ExtensionWorkLimits> | undefined) {
		this.host = host;
		this.limits = limits;
		this.open();
	}

	/** A fresh manager and skill catalog. */
	private open(): void {
		this.skills = new ExtensionSkillCatalog();
		const manager = new ExtensionWorkManager({
			limits: this.limits,
			isCurrent: () => this.manager === manager && this.host.isCurrent(),
			execute: (request) => this.execute(request),
			onBoundary: (event) => this.host.extensionRunner().emitRequestBoundary(event),
			onOperation: (event) => {
				if (this.manager === manager) this.host.extensionRunner().emitExtensionOperation(event);
			},
		});
		this.manager = manager;
	}

	/** The manager extensions bind their work to. */
	get workManager(): ExtensionWorkManager {
		return this.manager;
	}

	/** Close the manager and start a fresh one (runtime reload). */
	async reopen(): Promise<void> {
		await this.manager.close();
		this.open();
	}

	close(): Promise<void> {
		return this.manager.close();
	}

	drain(): Promise<void> {
		return this.manager.drain();
	}

	/** Revoke the current scope: its collected work no longer joins any request. */
	invalidate(): void {
		this.key = undefined;
		if (this.abortListener) this.signal?.removeEventListener("abort", this.abortListener);
		this.signal = undefined;
		this.abortListener = undefined;
		this.host.conversation()?.invalidateRequestBoundary();
		this.manager.invalidate();
	}

	/** Record the implementation of each trusted work tool, so work on a replaced tool is invalidated. */
	retainImplementations(
		tools: ReadonlyMap<string, AgentTool>,
		trustedDefinition: (name: string) => ToolDefinition | undefined,
	): void {
		for (const name of Object.values(EXTENSION_WORK_TOOLS)) {
			const tool = tools.get(name);
			const definition = trustedDefinition(name);
			if (tool && definition) {
				this.implementations.set(tool, {
					execute: tool.execute,
					definitionExecute: definition.execute,
					parameters: tool.parameters,
				});
			}
		}
	}

	/**
	 * The policy's request-boundary hook: open the batch's scope and collect
	 * the work that fits the request, or nothing.
	 */
	async collect(
		boundary: ConversationRequestBoundary,
		context: Context,
		signal?: AbortSignal,
	): Promise<ConversationRequestContext | undefined> {
		if (!this.host.isCurrent() || signal?.aborted) return undefined;
		const batch = boundary.batch;
		if (!batch || (!boundary.newInput && this.key !== batch.id)) return undefined;
		// Input an extension sent itself does not start extension work.
		if (
			batch.deliveries.every(
				(delivery) =>
					delivery.clientMessageId !== undefined && this.host.isExtensionInput(delivery.clientMessageId),
			)
		) {
			return undefined;
		}
		this.key = batch.id;
		if (this.signal !== signal) {
			if (this.abortListener) this.signal?.removeEventListener("abort", this.abortListener);
			this.signal = signal;
			this.abortListener = () => this.invalidate();
			signal?.addEventListener("abort", this.abortListener, { once: true });
		}
		const manager = this.manager;
		const model = this.host.model();
		const catalog = this.skills.snapshot(this.host.skills());
		manager.boundary({
			key: batch.id,
			attemptId: boundary.attemptId,
			cause: boundary.cause,
			allowNewWork: boundary.requestAuthority !== "final_response",
			snapshot: {
				branchId: `${this.host.sessionId()}:${this.host.generation()}`,
				revision: boundary.basisOrdinal,
				cwd: this.host.cwd,
				mode: this.host.mode(),
				...catalog,
				...(model ? { model: { provider: model.provider, id: model.id } } : {}),
				inputs: batch.deliveries.flatMap((delivery) =>
					delivery.messages.map((message) => ({
						text: extractUserMessageText(message.content),
						kind: delivery.kind,
					})),
				),
				services: (Object.keys(EXTENSION_WORK_TOOLS) as ExtensionWorkService[]).filter((service) => {
					const name = EXTENSION_WORK_TOOLS[service];
					return (
						(service === "readSkill" ? catalog.skills.length > 0 : this.host.isToolActive(name)) &&
						this.host.trustedOperationResolver(name) !== undefined
					);
				}),
			},
		});
		if (!model || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
			// Unknown headroom still consumes this scope's one preparation allowance.
			await manager.collect(boundary.basisOrdinal, () => false, 0);
			return undefined;
		}
		const reserve = this.host.settingsManager.getCompactionSettings(model).reserveTokens;
		const mandatory =
			estimateMessagesTokens(context.messages) +
			estimateToolDefinitionTokens(context.tools) +
			Math.ceil((context.systemPrompt?.length ?? 0) / 4);
		// One byte per remaining token is deliberately conservative for optional text.
		const maxBytes = Math.max(0, Math.floor(model.contextWindow - reserve - mandatory - 32));
		const runner = this.host.extensionRunner();
		const policyRevision = this.host.policyRevision();
		const extensionPoliciesCurrent = runner.captureToolPolicyGuard();
		// Earlier validations must not survive a policy change while later sources await.
		const policiesCurrent = () =>
			runner === this.host.extensionRunner() &&
			policyRevision === this.host.policyRevision() &&
			extensionPoliciesCurrent();
		const collection = await manager.collect(boundary.basisOrdinal, policiesCurrent, maxBytes);
		if (!collection) return undefined;
		const isCurrent = () =>
			!signal?.aborted &&
			this.host.isCurrent() &&
			this.key === batch.id &&
			this.manager === manager &&
			collection.authorization.isCurrent();
		if (!isCurrent()) {
			collection.authorization.settle(false);
			return undefined;
		}
		return {
			messages: [{ role: "user", content: collection.text, timestamp: Date.now() }],
			authorization: { isCurrent, settle: collection.authorization.settle },
		};
	}

	private async execute(request: ExtensionWorkExecution): Promise<ExtensionWorkExecutionResult> {
		const name = EXTENSION_WORK_TOOLS[request.service];
		const resourceId =
			request.service === "readSkill" && typeof request.input.resourceId === "string"
				? request.input.resourceId
				: undefined;
		const catalog = this.skills;
		const resource = resourceId ? catalog.resolve(resourceId, this.host.skills()) : undefined;
		if (request.service === "readSkill" && !resource) return { status: "denied", reason: "invalid_skill_resource" };
		const tool = this.host.tool(name);
		const definition = this.host.toolDefinition(name);
		const runner = this.host.extensionRunner();
		const implementation = tool && this.implementations.get(tool);
		const generation = this.host.generation();
		const policyRevision = this.host.policyRevision();
		const extensionPoliciesCurrent = runner.captureToolPolicyGuard();
		const policies = Array.from(this.host.turnPolicies(), ({ policy }) => ({
			policy,
			callback: policy.beforeToolCall,
		}));
		const key = this.key;
		if (
			!tool ||
			!definition ||
			!implementation ||
			(!resource && !this.host.isToolActive(name)) ||
			!this.host.trustedOperationResolver(name)
		) {
			return { status: "unavailable", reason: "inactive_or_untrusted_tool" };
		}
		const check = (input: JsonObject): ExtensionWorkExecutionResult | undefined => {
			if (request.signal.aborted) return { status: "cancelled", reason: "cancelled" };
			if (
				!this.host.isCurrent() ||
				key === undefined ||
				key !== this.key ||
				generation !== this.host.generation() ||
				runner !== this.host.extensionRunner() ||
				policyRevision !== this.host.policyRevision() ||
				!extensionPoliciesCurrent() ||
				this.host.tool(name) !== tool ||
				this.host.toolDefinition(name) !== definition ||
				tool.execute !== implementation.execute ||
				definition.execute !== implementation.definitionExecute ||
				tool.parameters !== implementation.parameters
			) {
				return { status: "invalidated", reason: "authority_changed" };
			}
			if (resource && (catalog !== this.skills || catalog.resolve(resourceId!, this.host.skills()) !== resource))
				return { status: "invalidated", reason: "skill_resource_changed" };
			if (resource && input.path !== resource.identity.path)
				return { status: "denied", reason: "skill_target_changed" };
			if (name === "lsp" && input.action !== request.service)
				return { status: "denied", reason: "semantic_action_changed" };
			const resolver = this.host.trustedOperationResolver(name);
			const profile = this.host.operationGrantProfile();
			if (
				(!resource && !this.host.isToolActive(name)) ||
				!authorizeToolOperation(resolver, input, EXTENSION_WORK_GRANT).allowed ||
				(profile && !authorizeToolOperation(resolver, input, profile).allowed)
			) {
				return { status: "denied", reason: "read_grant_denied" };
			}
			return undefined;
		};
		const toolCallId = `extension-operation:${randomUUID()}`;
		const validate = (input: JsonObject): JsonObject =>
			cloneCanonicalData(
				validateToolArguments(tool, { type: "toolCall", name, id: toolCallId, arguments: input }) as JsonObject,
				"Managed repository arguments",
			);
		let input: JsonObject;
		try {
			input = validate(
				resource
					? {
							path: resource.identity.path,
							...(request.input.offset === undefined ? {} : { offset: request.input.offset }),
							...(request.input.limit === undefined ? {} : { limit: request.input.limit }),
						}
					: request.input,
			);
		} catch {
			return { status: "failed", reason: "invalid_arguments" };
		}
		let failure = check(input);
		if (failure) return failure;
		const event = { type: "tool_call" as const, toolName: name, toolCallId, input };
		try {
			const decision = await withoutExtensionWork(() =>
				runner.emitToolCall(event, {
					signal: request.signal,
					origin: request.origin,
					strict: true,
				}),
			);
			failure = check(input);
			if (failure) return failure;
			if (decision?.block) return { status: "denied", reason: "extension_gate" };
			input = validate(event.input);
			failure = check(input);
			if (failure) return failure;
			for (const { policy, callback } of policies) {
				const result = await withoutExtensionWork(() =>
					callback?.call(policy, { ...event, input }, request.signal),
				);
				failure = check(input);
				if (failure) return failure;
				if (result?.block) return { status: "denied", reason: "host_gate" };
				input = validate(input);
			}
			failure = check(input);
			if (failure) return failure;
			let producerFailure: ExtensionWorkFailure | undefined;
			const execute = async (): Promise<Awaited<ReturnType<AgentTool["execute"]>>> => {
				try {
					return await tool.execute(toolCallId, input, request.signal);
				} catch (error) {
					if (error instanceof RepositoryObservationError)
						producerFailure = { status: error.status, reason: error.reason };
					return {
						content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
						isError: true,
					};
				}
			};
			const captured =
				name === "lsp"
					? await withManagedLspObservation(execute)
					: await withRepositoryObservation(execute, resource?.identity);
			failure = check(input);
			if (failure) return failure;
			const original = cloneCanonicalData(
				{
					content: captured.result.content,
					...(captured.result.details === undefined ? {} : { details: captured.result.details as JsonValue }),
					isError: captured.result.isError === true,
				},
				"Managed repository result",
			);
			const resultEvent = {
				type: "tool_result" as const,
				toolName: name,
				toolCallId,
				input,
				...structuredClone(original),
			};
			const patch = await withoutExtensionWork(() =>
				runner.emitToolResult(resultEvent, {
					signal: request.signal,
					origin: request.origin,
					strict: true,
				}),
			);
			failure = check(input);
			if (failure) return failure;
			// Runner returns the complete reduced projection, including detail removal.
			const reduced =
				patch === undefined
					? original
					: {
							content: patch.content ?? original.content,
							...(patch.details === undefined ? {} : { details: patch.details }),
							isError: patch.isError ?? original.isError,
						};
			if (!isDeepStrictEqual(original, reduced)) return { status: "unavailable", reason: "transformed_result" };
			if (original.isError) {
				const outcome = "outcome" in captured ? captured.outcome : undefined;
				if (outcome)
					return {
						status:
							outcome === "unavailable" || outcome === "unsupported" || outcome === "cancelled"
								? outcome
								: outcome === "timeout"
									? "deadline_exceeded"
									: "failed",
						reason: `lsp_${outcome.replaceAll("-", "_")}`,
					};
				return producerFailure ?? { status: "failed", reason: "tool_failed" };
			}
			if (!captured.observation) return { status: "unsupported", reason: "no_structured_observation" };
			return { status: "ok", observation: captured.observation, implementation: tool };
		} catch {
			return request.signal.aborted
				? { status: "cancelled", reason: "cancelled" }
				: { status: "failed", reason: "operation_failed" };
		}
	}
}
