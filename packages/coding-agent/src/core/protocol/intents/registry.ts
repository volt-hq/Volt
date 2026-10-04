/**
 * The intent registry: the one place a host admits and runs an intent,
 * whatever wire carried it (protocol frames, the legacy RPC commands and UI
 * actions, the Iroh remote commands, TUI slash commands).
 *
 * Admission order: resolve the name (built-in or the target session's
 * dynamic catalog), the profile (remote safety, then each required
 * capability), the input schema, the branch fence, the review-discussion
 * boundary, and availability. Only then does the definition run.
 */

import {
	type BuiltinIntentName,
	DYNAMIC_INTENT_PATTERN,
	DynamicIntentInputSchema,
	INTENT_SCHEMAS,
	type IntentDescriptor,
	type IntentInput,
} from "@hansjm10/volt-protocol";
import type { Static, TObject } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import { REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE } from "../../review-discussion-policy.ts";
import type { UiActionOptionDescriptor } from "../../rpc/types.ts";
import { formatSchemaError } from "../schema-errors.ts";
import {
	completeDynamicIntentArguments,
	type DynamicIntent,
	dynamicIntentPromptText,
	findDynamicIntent,
	listDynamicIntents,
} from "./dynamic.ts";
import { type BuiltinIntentDefinitions, type IntentOutcome, isBuiltinIntentName } from "./outcomes.ts";
import { intentStateOf } from "./state.ts";
import {
	INTENT_ENABLED,
	type IntentAvailability,
	type IntentContext,
	type IntentDefinition,
	type IntentMetadata,
	IntentRejectedError,
	type IntentTarget,
	type IntentView,
	missingCapability,
} from "./types.ts";

/** Frame fields besides `input` that admission reads. */
export interface IntentInvokeOptions {
	/** The client's position, for branch-fenced intents. */
	readonly expectedOrdinal?: number;
}

/** An accepted intent: what the `accepted` frame carries, plus the run's domain outcome. */
export interface IntentInvocation<O> {
	/** Ordinals the conversation's log advanced over while the intent ran, which include the intent's own entries. */
	readonly ordinals: number[];
	/** The conversation a structural intent moved the client to. */
	readonly conversation?: string;
	readonly result?: unknown;
	readonly outcome: O;
}

/** An admitted intent, ready to run. */
export interface PreparedIntent<O> {
	run(): Promise<IntentInvocation<O>>;
}

/** The outcome of a dynamic intent: how its prompt was taken. */
export interface DynamicIntentOutcome {
	readonly source: DynamicIntent["source"];
	/** Prompt templates and skills sent while the agent streams are queued as steering or follow-up input. */
	readonly queuedAs?: "steer" | "followUp";
}

type AnyIntentDefinition = IntentDefinition<BuiltinIntentName, unknown>;

/** A built-in or dynamic intent a name resolved to. */
export type ResolvedIntent =
	| { readonly kind: "builtin"; readonly definition: AnyIntentDefinition }
	| { readonly kind: "dynamic"; readonly intent: DynamicIntent };

const DYNAMIC_INPUT_VALIDATOR = Compile(DynamicIntentInputSchema);
const DYNAMIC_INTENT_NAME = new RegExp(DYNAMIC_INTENT_PATTERN);

interface LoadedIntents {
	readonly definitions: BuiltinIntentDefinitions;
	/** Slash aliases that invoke one built-in intent. */
	readonly slashAliases: ReadonlyMap<string, BuiltinIntentName>;
}

export class IntentRegistry {
	private readonly load: () => BuiltinIntentDefinitions;
	private loaded: LoadedIntents | undefined;
	private readonly validators = new Map<BuiltinIntentName, Validator>();

	/** `load` returns the definitions; the registry reads them on first use. */
	constructor(load: () => BuiltinIntentDefinitions) {
		this.load = load;
	}

	private get intents(): LoadedIntents {
		if (this.loaded) return this.loaded;
		const definitions = this.load();
		const slashNames = new Map<string, BuiltinIntentName[]>();
		for (const name of Object.keys(definitions) as BuiltinIntentName[]) {
			const definition: AnyIntentDefinition = definitions[name];
			if (definition.name !== name) throw new Error(`Intent ${name} is defined as ${definition.name}`);
			const alias = definition.slash?.name;
			if (alias !== undefined) slashNames.set(alias, [...(slashNames.get(alias) ?? []), name]);
		}
		// A slash name several intents share (`/review <target>`) names a command, not one intent.
		const slashAliases = new Map<string, BuiltinIntentName>();
		for (const [alias, names] of slashNames) {
			if (names.length === 1) slashAliases.set(alias, names[0]!);
		}
		this.loaded = { definitions, slashAliases };
		return this.loaded;
	}

	private get definitions(): BuiltinIntentDefinitions {
		return this.intents.definitions;
	}

	/** The slash aliases that invoke one built-in intent, with that intent's description. */
	slashCommands(): { name: string; description: string }[] {
		const { definitions, slashAliases } = this.intents;
		return [...slashAliases].map(([name, intent]) => {
			const definition: AnyIntentDefinition = definitions[intent];
			return {
				name,
				description: typeof definition.description === "string" ? definition.description : definition.label,
			};
		});
	}

	/** Every built-in intent name, in definition order. */
	names(): BuiltinIntentName[] {
		return Object.keys(this.definitions) as BuiltinIntentName[];
	}

	get<N extends BuiltinIntentName>(name: N): BuiltinIntentDefinitions[N] {
		return this.definitions[name];
	}

	/** A built-in intent by name, or a dynamic one from the target session's catalog. */
	resolve(name: string, target?: IntentTarget): ResolvedIntent | undefined {
		if (isBuiltinIntentName(name)) return { kind: "builtin", definition: this.definitions[name] };
		const intent = target && DYNAMIC_INTENT_NAME.test(name) ? findDynamicIntent(target.session, name) : undefined;
		return intent ? { kind: "dynamic", intent } : undefined;
	}

	/** The built-in intent a slash alias (`/clear`, `/name`, ...) invokes. */
	resolveSlash(alias: string): BuiltinIntentName | undefined {
		return this.intents.slashAliases.get(alias.startsWith("/") ? alias.slice(1) : alias);
	}

	/** Availability for a view: the review-discussion boundary, then the definition's own. */
	availability(definition: AnyIntentDefinition, view: IntentView, input?: unknown): IntentAvailability {
		if (view.state.isReviewDiscussion && isSourceOwned(definition, input)) {
			return { enabled: false, reason: REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE };
		}
		return definition.available?.(view, input as never) ?? INTENT_ENABLED;
	}

	descriptor(resolved: ResolvedIntent, view: IntentView): IntentDescriptor {
		if (resolved.kind === "dynamic") {
			const { intent } = resolved;
			return {
				...metadataDescriptor(intent, view),
				name: intent.name,
				source: intent.source,
				...(intent.sourceLabel === undefined ? {} : { sourceLabel: intent.sourceLabel }),
				input: DynamicIntentInputSchema as unknown as Record<string, unknown>,
				enabled: true,
			};
		}
		const { definition } = resolved;
		const availability = this.availability(definition, view);
		const state = definition.state?.(view);
		const schemas = INTENT_SCHEMAS[definition.name];
		return {
			...metadataDescriptor(definition, view),
			name: definition.name,
			source: "builtin",
			sourceLabel: "Built in",
			input: schemas.input as unknown as Record<string, unknown>,
			...("output" in schemas ? { output: schemas.output as unknown as Record<string, unknown> } : {}),
			enabled: availability.enabled,
			...(availability.enabled ? {} : { reason: availability.reason }),
			...(state === undefined ? {} : { state }),
		};
	}

	/**
	 * The descriptors a client sees: built-in intents, then the target
	 * session's dynamic intents. A remote profile sees only remote-safe ones.
	 */
	descriptors(view: IntentView, target?: IntentTarget): IntentDescriptor[] {
		const resolved: ResolvedIntent[] = [
			...this.names().map((name): ResolvedIntent => ({ kind: "builtin", definition: this.definitions[name] })),
			...(target ? listDynamicIntents(target.session) : []).map(
				(intent): ResolvedIntent => ({ kind: "dynamic", intent }),
			),
		];
		return resolved
			.filter((intent) => view.profile.name === "local" || metadataOf(intent).remote === "safe")
			.map((intent) => this.descriptor(intent, view));
	}

	/** Completions for one input field; fields the intent does not complete have none. */
	async complete(
		ctx: IntentContext,
		name: string,
		field: string,
		prefix: string,
	): Promise<UiActionOptionDescriptor[]> {
		const resolved = this.resolve(name, ctx.target);
		if (!resolved) throw new IntentRejectedError("unknown_intent", `Unknown intent: ${name}`);
		assertProfileAllows(metadataOf(resolved), ctx, name);
		if (!(metadataOf(resolved).completions ?? []).includes(field)) return [];
		if (resolved.kind === "dynamic") return completeDynamicIntentArguments(resolved.intent, prefix);
		return (await resolved.definition.complete?.(ctx, field, prefix)) ?? [];
	}

	/** Admit and run a built-in intent with typed input. */
	async invoke<N extends BuiltinIntentName>(
		ctx: IntentContext,
		name: N,
		input: IntentInput<N>,
		options: IntentInvokeOptions = {},
	): Promise<IntentInvocation<IntentOutcome<N>>> {
		return this.prepare(ctx, name, input, options).run();
	}

	/** Admit and run any intent by name with unchecked input (a wire frame). */
	async invokeFrame(
		ctx: IntentContext,
		name: string,
		input: unknown,
		options: IntentInvokeOptions = {},
	): Promise<IntentInvocation<unknown>> {
		return this.prepareFrame(ctx, name, input, options).run();
	}

	/**
	 * Admit a built-in intent now, throwing {@link IntentRejectedError} when the
	 * host refuses it, and return its run. Callers that answer the client
	 * before the run settles (input intents) admit synchronously this way.
	 */
	prepare<N extends BuiltinIntentName>(
		ctx: IntentContext,
		name: N,
		input: IntentInput<N>,
		options: IntentInvokeOptions = {},
	): PreparedIntent<IntentOutcome<N>> {
		return this.admit(ctx, { kind: "builtin", definition: this.definitions[name] }, input, options) as PreparedIntent<
			IntentOutcome<N>
		>;
	}

	/** {@link prepare} for any intent by name with unchecked input. */
	prepareFrame(
		ctx: IntentContext,
		name: string,
		input: unknown,
		options: IntentInvokeOptions = {},
	): PreparedIntent<unknown> {
		const resolved = this.resolve(name, ctx.target);
		if (!resolved) throw new IntentRejectedError("unknown_intent", `Unknown intent: ${name}`);
		return this.admit(ctx, resolved, input, options);
	}

	private admit(
		ctx: IntentContext,
		resolved: ResolvedIntent,
		input: unknown,
		options: IntentInvokeOptions,
	): PreparedIntent<unknown> {
		const metadata = metadataOf(resolved);
		const name = resolved.kind === "builtin" ? resolved.definition.name : resolved.intent.name;
		assertProfileAllows(metadata, ctx, name);
		const admittedInput = input ?? {};
		const validator =
			resolved.kind === "builtin" ? this.validator(resolved.definition.name) : DYNAMIC_INPUT_VALIDATOR;
		if (!validator.Check(admittedInput)) {
			const schema = (
				resolved.kind === "builtin" ? INTENT_SCHEMAS[resolved.definition.name].input : DynamicIntentInputSchema
			) as TObject;
			throw new IntentRejectedError(
				"invalid_input",
				`Invalid ${name} input: ${formatSchemaError(schema, validator.Errors(admittedInput))}`,
			);
		}
		const target = ctx.target;
		if (metadata.scope === "conversation" && !target) {
			throw new IntentRejectedError("unavailable", `${name} needs a conversation`);
		}
		if (metadata.fence === "branch" && target && options.expectedOrdinal !== undefined) {
			const switched = target.session.conversationGenerationRevision;
			if (switched > options.expectedOrdinal) {
				throw new IntentRejectedError("stale", "The branch switched after the client's position", {
					ordinal: switched,
				});
			}
		}
		if (resolved.kind === "dynamic") {
			const run = admitDynamicIntent(ctx, resolved.intent, admittedInput as Static<typeof DynamicIntentInputSchema>);
			return {
				run: async () => {
					const before = logPosition(target);
					const outcome = await run();
					return { ordinals: committedSince(target, before), outcome };
				},
			};
		}
		const definition = resolved.definition;
		const view: IntentView = {
			state: intentStateOf(target?.session),
			services: ctx.services,
			profile: ctx.profile,
			...(target === undefined ? {} : { target }),
		};
		const availability = this.availability(definition, view, admittedInput);
		if (!availability.enabled) {
			throw new IntentRejectedError(availability.code ?? "unavailable", availability.reason);
		}
		return {
			run: async () => {
				const before = logPosition(target);
				const outcome = await definition.run(ctx, admittedInput as never);
				const acceptance = definition.accept?.(outcome) ?? {};
				return {
					ordinals: acceptance.conversation === undefined ? committedSince(target, before) : [],
					...(acceptance.conversation === undefined ? {} : { conversation: acceptance.conversation }),
					...(acceptance.result === undefined ? {} : { result: acceptance.result }),
					outcome,
				};
			},
		};
	}

	private validator(name: BuiltinIntentName): Validator {
		let validator = this.validators.get(name);
		if (validator === undefined) {
			validator = Compile(INTENT_SCHEMAS[name].input);
			this.validators.set(name, validator);
		}
		return validator;
	}
}

function metadataOf(resolved: ResolvedIntent): IntentMetadata {
	return resolved.kind === "builtin" ? resolved.definition : resolved.intent;
}

function isSourceOwned(definition: AnyIntentDefinition, input: unknown): boolean {
	const owned = definition.sourceOwned;
	if (typeof owned === "function") return input !== undefined && owned(input as never);
	return owned === true;
}

/** Remote safety first, then each required capability in order; local profiles may invoke everything. */
function assertProfileAllows(metadata: IntentMetadata, ctx: IntentContext, name: string): void {
	if (ctx.profile.name === "local") return;
	if (metadata.remote !== "safe") {
		throw new IntentRejectedError("not_allowed", `Intent not available over remote host: ${name}`);
	}
	const missing = missingCapability(ctx.profile.grant, metadata.requires);
	if (missing !== undefined) {
		throw new IntentRejectedError("not_allowed", `Remote capability required: ${missing}`, {
			requiredCapability: missing,
		});
	}
}

function metadataDescriptor(
	metadata: IntentMetadata,
	view: IntentView,
): Omit<IntentDescriptor, "name" | "source" | "input" | "enabled"> {
	const description = typeof metadata.description === "function" ? metadata.description(view) : metadata.description;
	return {
		label: metadata.label,
		...(description === undefined ? {} : { description }),
		category: metadata.category,
		scope: metadata.scope,
		fence: metadata.fence,
		remote: metadata.remote,
		requires: [...metadata.requires],
		whileBusy: metadata.whileBusy,
		...(metadata.confirm === undefined ? {} : { confirm: { ...metadata.confirm } }),
		...(metadata.presentation === undefined ? {} : { presentation: { ...metadata.presentation } }),
		...(metadata.slash === undefined ? {} : { slash: { ...metadata.slash } }),
		...(metadata.completions === undefined ? {} : { completions: [...metadata.completions] }),
	};
}

/** The target log's position; a session without a readable log position reports no ordinals. */
function logPosition(target: IntentTarget | undefined): number | undefined {
	return target?.session.sessionManager?.getOrdinal?.();
}

function committedSince(target: IntentTarget | undefined, before: number | undefined): number[] {
	const after = logPosition(target);
	if (before === undefined || after === undefined) return [];
	const ordinals: number[] = [];
	for (let ordinal = before + 1; ordinal <= after; ordinal++) ordinals.push(ordinal);
	return ordinals;
}

/**
 * Admit a dynamic intent: its slash text is sent as a prompt. Prompt
 * templates and skills sent while the agent streams must say how to queue.
 * The intent is accepted once the prompt passes admission; a failure after
 * that belongs to the run, not to the intent.
 */
function admitDynamicIntent(
	ctx: IntentContext,
	intent: DynamicIntent,
	input: Static<typeof DynamicIntentInputSchema>,
): () => Promise<DynamicIntentOutcome> {
	const session = (ctx.target as IntentTarget).session;
	const promptText = dynamicIntentPromptText(intent, input.arguments ?? "");
	let queuedAs: "steer" | "followUp" | undefined;
	if (intent.source !== "extension" && session.isStreaming) {
		if (input.streamingBehavior === undefined) {
			throw new IntentRejectedError(
				"busy",
				"UI action requires streamingBehavior ('steer' or 'followUp') while the agent is streaming",
			);
		}
		queuedAs = input.streamingBehavior;
	}
	return () =>
		new Promise((resolve, reject) => {
			let admitted = false;
			void session
				.prompt(promptText, {
					...(queuedAs === undefined ? {} : { streamingBehavior: queuedAs }),
					source: "rpc",
					...(ctx.assertCurrent === undefined ? {} : { assertConversationGenerationCurrent: ctx.assertCurrent }),
					preflightResult: (result) => {
						if (!result.success || admitted) return;
						admitted = true;
						resolve({ source: intent.source, ...(queuedAs === undefined ? {} : { queuedAs }) });
					},
				})
				.catch((error: unknown) => {
					if (!admitted) reject(error);
				});
		});
}
