/**
 * The intent registry: the one place a host admits and runs an intent,
 * whatever carried it (protocol intent frames, relayed frames, TUI slash
 * commands).
 *
 * Admission order: resolve the name (built-in or the target session's
 * dynamic catalog), the profile (remote safety, then each required
 * capability), the input schema and the byte budgets it annotates, the branch
 * fence, the review-discussion boundary, and availability. Only then does the
 * definition run. An extension intent's input is checked against the schema
 * its extension registered.
 */

import {
	type BuiltinIntentName,
	DYNAMIC_INTENT_PATTERN,
	DynamicIntentInputSchema,
	INTENT_SCHEMAS,
	type IntentDescriptor,
	type IntentInput,
	type IntentOption,
} from "@hansjm10/volt-protocol";
import type { Static, TObject } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import type { RegisteredIntent } from "../../extensions/types.ts";
import { REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE } from "../../review-discussion-policy.ts";
import { formatSchemaBoundError, formatSchemaError } from "../schema-errors.ts";
import {
	completeDynamicIntentArguments,
	type DynamicIntent,
	describedInputSchema,
	dynamicIntentPromptText,
	type ExtensionIntent,
	findDynamicIntent,
	findExtensionIntent,
	listDynamicIntents,
	listExtensionIntents,
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

/** The outcome of a dynamic intent: how its prompt was taken, or that an extension intent's handler ran. */
export interface DynamicIntentOutcome {
	readonly source: DynamicIntent["source"];
	/** Prompt templates and skills sent while the agent streams are queued as steering or follow-up input. */
	readonly queuedAs?: "steer" | "followUp";
}

type AnyIntentDefinition = IntentDefinition<BuiltinIntentName, unknown>;

/** A built-in, dynamic, or extension intent a name resolved to. */
export type ResolvedIntent =
	| { readonly kind: "builtin"; readonly definition: AnyIntentDefinition }
	| { readonly kind: "dynamic"; readonly intent: DynamicIntent }
	| { readonly kind: "extension"; readonly intent: ExtensionIntent };

const DYNAMIC_INPUT_VALIDATOR = Compile(DynamicIntentInputSchema);
const DYNAMIC_INTENT_NAME = new RegExp(DYNAMIC_INTENT_PATTERN);
const EXTENSION_INTENT_PREFIX = "extension.intent.";
/** Largest input of an extension intent, in characters of JSON. */
export const EXTENSION_INTENT_INPUT_MAX_CHARS = 64 * 1024;

/** Compiled input schemas of extension intents. */
const extensionValidators = new WeakMap<RegisteredIntent, Validator>();

function extensionValidator(intent: RegisteredIntent): Validator {
	let validator = extensionValidators.get(intent);
	if (validator === undefined) {
		validator = Compile(intent.input);
		extensionValidators.set(intent, validator);
	}
	return validator;
}

/** The name of a resolved intent. */
function nameOf(resolved: ResolvedIntent): string {
	return resolved.kind === "builtin" ? resolved.definition.name : resolved.intent.name;
}

export class IntentRegistry {
	private readonly load: () => BuiltinIntentDefinitions;
	private loaded: BuiltinIntentDefinitions | undefined;
	private readonly validators = new Map<BuiltinIntentName, Validator>();

	/** `load` returns the definitions; the registry reads them on first use. */
	constructor(load: () => BuiltinIntentDefinitions) {
		this.load = load;
	}

	private get definitions(): BuiltinIntentDefinitions {
		if (this.loaded) return this.loaded;
		const definitions = this.load();
		for (const name of Object.keys(definitions) as BuiltinIntentName[]) {
			const definition: AnyIntentDefinition = definitions[name];
			if (definition.name !== name) throw new Error(`Intent ${name} is defined as ${definition.name}`);
		}
		this.loaded = definitions;
		return definitions;
	}

	/** Every built-in intent name, in definition order. */
	names(): BuiltinIntentName[] {
		return Object.keys(this.definitions) as BuiltinIntentName[];
	}

	get<N extends BuiltinIntentName>(name: N): BuiltinIntentDefinitions[N] {
		return this.definitions[name];
	}

	/** A built-in intent by name, or a dynamic or extension one from the target session's catalog. */
	resolve(name: string, target?: IntentTarget): ResolvedIntent | undefined {
		if (isBuiltinIntentName(name)) return { kind: "builtin", definition: this.definitions[name] };
		if (!target || !DYNAMIC_INTENT_NAME.test(name)) return undefined;
		if (name.startsWith(EXTENSION_INTENT_PREFIX)) {
			const intent = findExtensionIntent(target.session, name);
			return intent ? { kind: "extension", intent } : undefined;
		}
		const intent = findDynamicIntent(target.session, name);
		return intent ? { kind: "dynamic", intent } : undefined;
	}

	/** Availability for a view: the review-discussion boundary, then the definition's own. */
	availability(definition: AnyIntentDefinition, view: IntentView, input?: unknown): IntentAvailability {
		if (view.state.isReviewDiscussion && isSourceOwned(definition, input, view)) {
			return { enabled: false, reason: REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE };
		}
		return definition.available?.(view, input as never) ?? INTENT_ENABLED;
	}

	descriptor(resolved: ResolvedIntent, view: IntentView): IntentDescriptor {
		if (resolved.kind === "extension") {
			const { intent } = resolved;
			return {
				...metadataDescriptor(intent, view),
				name: intent.name,
				source: intent.source,
				sourceLabel: intent.sourceLabel,
				// The registered schema, what a client fills a form from, its descriptive text redacted.
				input: describedInputSchema(intent.registered.input),
				enabled: true,
			};
		}
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
			...(target ? listExtensionIntents(target.session) : []).map(
				(intent): ResolvedIntent => ({ kind: "extension", intent }),
			),
		];
		return resolved
			.filter((intent) => view.profile.name === "local" || metadataOf(intent).remote === "safe")
			.map((intent) => this.descriptor(intent, view));
	}

	/**
	 * Completions for one input field; fields the intent does not complete have
	 * none. Completing reads, so a remote profile needs the intent to be
	 * remote-safe but not the capabilities invoking it requires.
	 */
	async complete(ctx: IntentContext, name: string, field: string, prefix: string): Promise<IntentOption[]> {
		const resolved = this.resolve(name, ctx.target);
		if (!resolved) throw new IntentRejectedError("unknown_intent", `Unknown intent: ${name}`);
		if (ctx.profile.name === "remote" && metadataOf(resolved).remote !== "safe") {
			throw new IntentRejectedError("not_allowed", `Intent not available over remote host: ${name}`);
		}
		if (!(metadataOf(resolved).completions ?? []).includes(field)) return [];
		if (resolved.kind === "dynamic") return completeDynamicIntentArguments(resolved.intent, prefix);
		if (resolved.kind === "extension") return [];
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
		const name = nameOf(resolved);
		assertProfileAllows(metadata, ctx, name);
		const admittedInput = input ?? {};
		// An extension's schema checks the input's shape; the host bounds its size before testing it.
		if (
			resolved.kind === "extension" &&
			(JSON.stringify(admittedInput) ?? "").length > EXTENSION_INTENT_INPUT_MAX_CHARS
		) {
			throw new IntentRejectedError(
				"invalid_input",
				`Invalid ${name} input: larger than ${EXTENSION_INTENT_INPUT_MAX_CHARS} characters of JSON`,
			);
		}
		const validator =
			resolved.kind === "builtin"
				? this.validator(resolved.definition.name)
				: resolved.kind === "extension"
					? extensionValidator(resolved.intent.registered)
					: DYNAMIC_INPUT_VALIDATOR;
		const schema = (
			resolved.kind === "builtin"
				? INTENT_SCHEMAS[resolved.definition.name].input
				: resolved.kind === "extension"
					? resolved.intent.registered.input
					: DynamicIntentInputSchema
		) as TObject;
		const invalid = validator.Check(admittedInput)
			? formatSchemaBoundError(schema, admittedInput)
			: formatSchemaError(schema, validator.Errors(admittedInput));
		if (invalid !== undefined) throw new IntentRejectedError("invalid_input", `Invalid ${name} input: ${invalid}`);
		const target = ctx.target;
		if (metadata.scope === "conversation" && !target) {
			throw new IntentRejectedError("unavailable", `${name} needs a conversation`);
		}
		const expectedOrdinal = options.expectedOrdinal;
		if (metadata.fence === "branch" && target && expectedOrdinal !== undefined) {
			// Checked at admission and again wherever the intent rechecks before it
			// mutates, after its awaits: the branch may switch meanwhile.
			const assertBranch = (): void => {
				const switched = target.session.conversationGenerationRevision;
				if (switched > expectedOrdinal) {
					throw new IntentRejectedError("stale", "The branch switched after the client's position", {
						ordinal: switched,
					});
				}
			};
			assertBranch();
			const outer = ctx.assertCurrent;
			ctx = {
				...ctx,
				assertCurrent: () => {
					outer?.();
					assertBranch();
				},
			};
		}
		if (resolved.kind === "extension") {
			const session = (target as IntentTarget).session;
			const { registered } = resolved.intent;
			return {
				run: async () => {
					const before = logPosition(target);
					try {
						await session.runExtensionIntent(registered, admittedInput);
					} catch (error) {
						throw new IntentRejectedError("failed", error instanceof Error ? error.message : String(error));
					}
					return { ordinals: committedSince(target, before), outcome: { source: "extension" } };
				},
			};
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

function isSourceOwned(definition: AnyIntentDefinition, input: unknown, view: IntentView): boolean {
	const owned = definition.sourceOwned;
	if (typeof owned === "function") return input !== undefined && owned(input as never, view);
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
	// The slash text runs any extension command of that name first: a remote
	// template or skill must not reach a command that is not remote-safe.
	if (ctx.profile.name === "remote") {
		const command = session.extensionRunner.getCommand(intent.promptName);
		if (command && command.remoteSafe !== true) {
			throw new IntentRejectedError(
				"not_allowed",
				`Extension command is not available over remote host: /${intent.promptName}`,
			);
		}
	}
	const promptText = dynamicIntentPromptText(intent, input.arguments ?? "");
	let queuedAs: "steer" | "followUp" | undefined;
	if (intent.source !== "extension" && session.isStreaming) {
		if (input.streamingBehavior === undefined) {
			throw new IntentRejectedError(
				"busy",
				`${intent.name} needs streamingBehavior ('steer' or 'followUp') while the agent is streaming`,
			);
		}
		queuedAs = input.streamingBehavior;
	}
	return () =>
		new Promise((resolve, reject) => {
			let admitted = false;
			const admit = (): void => {
				if (admitted) return;
				admitted = true;
				resolve({ source: intent.source, ...(queuedAs === undefined ? {} : { queuedAs }) });
			};
			void session
				.prompt(promptText, {
					...(queuedAs === undefined ? {} : { streamingBehavior: queuedAs }),
					source: ctx.inputSource ?? "rpc",
					...(ctx.assertCurrent === undefined ? {} : { assertConversationGenerationCurrent: ctx.assertCurrent }),
					preflightResult: (result) => {
						if (result.success) admit();
					},
				})
				// A command that moved its client closed this session before its admission was reported: it ran.
				.then(admit, (error: unknown) => {
					if (!admitted) reject(error);
				});
		});
}
