/**
 * The TUI's input (architecture rewrite §10): what the editor's text, the
 * TUI's keys, and its slash menu send, as intents and queries of the TUI's
 * protocol client. Text goes out as a prompt while the conversation is idle,
 * queued into the running turn while one runs, and queued behind any other
 * operation (a compaction) until it ends: the host keeps the queue, and the
 * client fold shows it. The model, thinking level, and agent mode change
 * through their intents; a model cycle steps through the `models` query's
 * cycle scope.
 *
 * The slash menu, the extensions' shortcuts, and their completion triggers
 * come from the conversation's `intents` catalog: the intents' slash aliases,
 * and the extension commands, prompt templates, and skills, beside the TUI's
 * own commands, which win a name they share.
 */

import type { ImageContent } from "@hansjm10/volt-ai";
import type {
	ClientState,
	IntentDescriptor,
	IntentShortcut,
	ProjectedEntry,
	RpcCatalogModel,
	WithdrawnInput,
	WorkNoticeDetails,
} from "@hansjm10/volt-protocol";
import { WORK_NOTICE_CUSTOM_TYPE } from "@hansjm10/volt-protocol";
import type { AutocompleteItem, SlashCommand } from "@hansjm10/volt-tui";
import type { TuiStore } from "./tui-store.ts";

type ThinkingLevel = ClientState["thinkingLevel"];
type QueuedEntry = Extract<ProjectedEntry, { type: "client_input_queued" }>;

const EXTENSION_COMMAND_PREFIX = "extension.command.";
const PROMPT_TEMPLATE_PREFIX = "prompt.template.";
const SKILL_PREFIX = "skill.";

/** What the TUI's input reads from the conversation's catalogs. */
export interface InputCatalog {
	/** The intents the conversation offers, as the `intents` query lists them. */
	readonly intents: readonly IntentDescriptor[];
	/** The keys the conversation's extensions bind to its intents. */
	readonly shortcuts: readonly IntentShortcut[];
	/** What starts a token the extensions' completion providers complete. */
	readonly completionTriggers: readonly string[];
	/** The conversation's working directory, where `@` completes paths; unknown until the catalog loads. */
	readonly cwd?: string;
}

export const EMPTY_INPUT_CATALOG: InputCatalog = Object.freeze({
	intents: [],
	shortcuts: [],
	completionTriggers: [],
});

/** Something the input could not offer as the catalog asks: a command a TUI command shadows. */
export interface InputDiagnostic {
	readonly type: "warning";
	readonly message: string;
}

/** How sent text was delivered. */
export type Delivery =
	/** Prompted: it runs now. */
	| "prompt"
	/** Queued into the running turn. */
	| "turn"
	/** Queued behind another operation (a compaction), delivered once it ends. */
	| "operation";

/** What the interrupt key stops now. */
export type Interruptible = "compaction" | "navigation" | "retry" | "run" | "bash";

/** A model cycle: the model it switched to, or why it did not. */
export type ModelCycle =
	| { readonly kind: "switched"; readonly model: RpcCatalogModel; readonly thinkingLevel: ThinkingLevel }
	/** Only one model to step through: `scoped` when the scope limits it. */
	| { readonly kind: "single"; readonly scoped: boolean };

/** The input queued for the next turn: the user's steering and follow-up text, and the notices of finished work. */
export interface QueueView {
	readonly steering: readonly string[];
	readonly followUp: readonly string[];
	readonly notices: readonly WorkNoticeDetails[];
}

/** The short tag a slash menu entry names its source by. */
const SOURCE_TAGS: Readonly<Record<string, string>> = {
	User: "u",
	Project: "p",
	Temporary: "t",
	Package: "package",
};

function describe(descriptor: IntentDescriptor): string | undefined {
	const tag = descriptor.sourceLabel === undefined ? undefined : SOURCE_TAGS[descriptor.sourceLabel];
	const description = descriptor.description;
	if (tag === undefined) return description;
	return description ? `[${tag}] ${description}` : `[${tag}]`;
}

/** What a slash alias's example shows after the name: the arguments it takes. */
function argumentHint(descriptor: IntentDescriptor): string | undefined {
	const slash = descriptor.slash;
	const prefix = `/${slash?.name} `;
	return slash?.example?.startsWith(prefix) ? slash.example.slice(prefix.length) : undefined;
}

/** The command name an extension command's intent names: what follows its extension's id. */
function commandNameOf(intent: string): string {
	const rest = intent.slice(EXTENSION_COMMAND_PREFIX.length);
	return rest.slice(rest.indexOf(".") + 1);
}

/** Whether `details` describe a finished work item's notice. */
function isWorkNotice(details: unknown): details is WorkNoticeDetails {
	if (typeof details !== "object" || details === null) return false;
	const { workId, kind, title, outcome } = details as Record<string, unknown>;
	return (
		typeof workId === "string" &&
		typeof kind === "string" &&
		typeof title === "string" &&
		(outcome === "completed" || outcome === "failed")
	);
}

/** The entry at `ordinal`, from entries in ordinal order. */
function entryAt(entries: readonly ProjectedEntry[], ordinal: number): ProjectedEntry | undefined {
	let low = 0;
	let high = entries.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const entry = entries[middle];
		if (entry === undefined) return undefined;
		if (entry.ordinal === ordinal) return entry;
		if (entry.ordinal < ordinal) low = middle + 1;
		else high = middle - 1;
	}
	return undefined;
}

/** The input queued in `state`: inputs that wait for delivery, steering and follow-up in admission order. */
export function queuedInput(state: ClientState): QueueView {
	const steering: string[] = [];
	const followUp: string[] = [];
	const notices: WorkNoticeDetails[] = [];
	for (const input of state.queue) {
		if (input.state !== "accepted" || input.delivery === undefined) continue;
		if (input.origin !== "host") {
			(input.delivery === "steer" ? steering : followUp).push(input.message);
			continue;
		}
		// Host input: the messages its queued entry delivers, of which the work notices show.
		const entry = entryAt(state.entries, input.ordinal);
		const messages =
			entry?.type === "client_input_queued" ? (entry as QueuedEntry).payload?.queuedInput.messages : [];
		for (const message of messages ?? []) {
			if (
				message.role === "custom" &&
				message.customType === WORK_NOTICE_CUSTOM_TYPE &&
				isWorkNotice(message.details)
			) {
				notices.push(message.details);
			}
		}
	}
	return { steering, followUp, notices };
}

export class TuiInput {
	private readonly store: TuiStore;
	private loaded: InputCatalog = EMPTY_INPUT_CATALOG;
	/** Bumped by every load and clear: a load a later one superseded leaves the catalog as it is. */
	private generation = 0;

	constructor(store: TuiStore) {
		this.store = store;
	}

	/** The catalog of the conversation the store shows, once loaded. */
	get catalog(): InputCatalog {
		return this.loaded;
	}

	/**
	 * Load the catalog of the conversation the store shows. Resolves false
	 * when the client moved meanwhile, or a later load or clear superseded it.
	 */
	async load(): Promise<boolean> {
		const generation = ++this.generation;
		const conversation = this.store.conversation;
		const client = this.store.client;
		const [intents, info] = await Promise.all([client.query("intents"), client.query("conversation_info")]);
		if (generation !== this.generation || this.store.conversation !== conversation) return false;
		this.loaded = {
			intents: intents.intents,
			shortcuts: intents.shortcuts,
			completionTriggers: intents.completionTriggers,
			cwd: info.cwd,
		};
		return true;
	}

	/** Forget the catalog: the client leaves its conversation. */
	clear(): void {
		this.generation++;
		this.loaded = EMPTY_INPUT_CATALOG;
	}

	// =========================================================================
	// Text
	// =========================================================================

	/**
	 * Send text the user wrote: a prompt while the conversation is idle;
	 * queued into the running turn as steering, or as a follow-up, while one
	 * runs; queued behind another operation until it ends. Prompt templates
	 * and skills expand on the host.
	 */
	async send(text: string, options: { followUp: boolean; images?: ImageContent[] }): Promise<Delivery> {
		const client = this.store.client;
		const operation = this.store.phase?.operation ?? null;
		const images = options.images === undefined ? {} : { images: options.images };
		if (operation === null) {
			await client.prompt(text, images);
			return "prompt";
		}
		if (operation === "turn") {
			await client.prompt(text, { ...images, streamingBehavior: options.followUp ? "followUp" : "steer" });
			return "turn";
		}
		await client.intent(options.followUp ? "follow_up" : "steer", { message: text, ...images });
		return "operation";
	}

	/** The extension command a slash text invokes, by its slash alias in the catalog, and the argument text after it. */
	extensionCommand(text: string): { readonly intent: string; readonly arguments: string } | undefined {
		if (!text.startsWith("/")) return undefined;
		const space = text.indexOf(" ");
		const name = space === -1 ? text.slice(1) : text.slice(1, space);
		const descriptor = this.loaded.intents.find(
			(intent) => intent.name.startsWith(EXTENSION_COMMAND_PREFIX) && intent.slash?.name === name,
		);
		if (descriptor === undefined) return undefined;
		return { intent: descriptor.name, arguments: space === -1 ? "" : text.slice(space + 1) };
	}

	/** Run an extension command; it runs at once, even while a turn runs. */
	async runCommand(command: { readonly intent: string; readonly arguments: string }): Promise<void> {
		await this.store.client.intent(command.intent, command.arguments ? { arguments: command.arguments } : {});
	}

	/** Invoke the intent an extension's shortcut binds, with no input. */
	async invokeShortcut(intent: string): Promise<void> {
		await this.store.client.intent(intent);
	}

	// =========================================================================
	// Shell commands
	// =========================================================================

	/** Whether a user shell command runs: the live `bash` value shows one that has not ended. */
	bashRunning(): boolean {
		const value = this.store.value("bash");
		return value?.kind === "bash" && value.exitCode === undefined && value.cancelled !== true;
	}

	/** Run a user shell command on the host; the live `bash` value shows it until its entry commits. */
	async runBash(command: string, excludeFromContext: boolean): Promise<void> {
		await this.store.client.intent("bash", { command, ...(excludeFromContext ? { excludeFromContext: true } : {}) });
	}

	// =========================================================================
	// Stopping and the queue
	// =========================================================================

	/**
	 * What the interrupt key stops now: a compaction or a branch summary; a
	 * retry while it waits; the running turn, or running work when no shell
	 * command runs; else a shell command.
	 */
	interruptible(): Interruptible | undefined {
		const phase = this.store.phase;
		if (phase?.operation === "compaction" || phase?.compaction !== undefined) return "compaction";
		if (phase?.operation === "navigation") return "navigation";
		const retryAt = phase?.retry?.retryAt;
		if (retryAt !== undefined && retryAt > Date.now()) return "retry";
		const bash = this.bashRunning();
		// A turn comes first; a foreground shell command keeps its priority over background work.
		if (phase?.operation === "turn" || (!bash && this.workRunning())) return "run";
		return bash ? "bash" : undefined;
	}

	/** Stop `target`; stopping a run takes the queued input back first, for the editor. */
	async interrupt(target: Interruptible): Promise<readonly WithdrawnInput[]> {
		const client = this.store.client;
		switch (target) {
			case "compaction":
			case "navigation":
				await client.intent("abort", { operation: target });
				return [];
			case "retry":
				await client.intent("abort_retry");
				return [];
			case "bash":
				await client.intent("abort_bash");
				return [];
			case "run":
				return (await client.intent("abort", { withdrawQueued: true })).result?.messages ?? [];
		}
	}

	/** Take the queued input back without stopping the run. */
	async withdraw(): Promise<readonly WithdrawnInput[]> {
		return (await this.store.client.intent("withdraw_queued")).result?.messages ?? [];
	}

	/** The input queued for the next turn. */
	queue(): QueueView {
		return queuedInput(this.store.state);
	}

	/** Whether work runs: an executor holds work that does not wait for approval, which its live `work` value shows. */
	private workRunning(): boolean {
		const work = this.store.state.work;
		for (const value of this.store.live.values.values()) {
			if (value.kind === "work" && work.get(value.workId)?.state !== "awaiting_approval") return true;
		}
		return false;
	}

	// =========================================================================
	// Model, thinking level, and agent mode
	// =========================================================================

	/** The catalog model the conversation runs, if it is selectable. */
	async model(): Promise<RpcCatalogModel | undefined> {
		const current = this.store.state.model;
		if (current === null) return undefined;
		const { models } = await this.store.client.query("models");
		return models.find((model) => model.provider === current.provider && model.id === current.modelId);
	}

	/**
	 * Step the conversation's model through its cycle scope, with the scope's
	 * thinking level for the model when it names one, and keep the choice as
	 * the default for new conversations, as picking a model does.
	 */
	async cycleModel(direction: "forward" | "backward"): Promise<ModelCycle> {
		const client = this.store.client;
		const { models, cycleScope } = await client.query("models");
		if (cycleScope.length <= 1) return { kind: "single", scoped: cycleScope.length < models.length };
		const current = this.store.state.model;
		const index = Math.max(
			0,
			cycleScope.findIndex((scoped) => scoped.provider === current?.provider && scoped.modelId === current.modelId),
		);
		const count = cycleScope.length;
		const next = cycleScope[direction === "forward" ? (index + 1) % count : (index - 1 + count) % count];
		const model = models.find((candidate) => candidate.provider === next?.provider && candidate.id === next.modelId);
		if (next === undefined || model === undefined) throw new Error("The model to cycle to is not available");
		const selection = { provider: next.provider, modelId: next.modelId };
		const selected = await client.intent("set_model", selection);
		const leveled =
			next.thinkingLevel === undefined
				? undefined
				: await client.intent("set_thinking_level", { level: next.thinkingLevel });
		// The level the model runs with, as the host clamped it.
		await this.applied([...selected.ordinals, ...(leveled?.ordinals ?? [])]);
		const thinkingLevel = this.store.state.thinkingLevel;
		await client.intent("set_default_model", selection);
		if (model.reasoning || thinkingLevel !== "off") {
			await client.intent("set_default_thinking_level", { level: thinkingLevel });
		}
		return { kind: "switched", model, thinkingLevel };
	}

	/**
	 * Step the thinking level to the next one the model offers, and keep it as
	 * the default; undefined when the model does not think.
	 */
	async cycleThinkingLevel(): Promise<ThinkingLevel | undefined> {
		const model = await this.model();
		if (!model?.reasoning) return undefined;
		const levels = model.availableThinkingLevels;
		const next = levels[(levels.indexOf(this.store.state.thinkingLevel) + 1) % levels.length];
		if (next === undefined) return undefined;
		const client = this.store.client;
		await client.intent("set_thinking_level", { level: next });
		await client.intent("set_default_thinking_level", { level: next });
		return next;
	}

	/**
	 * Switch the conversation to `model`, and keep it, with the thinking level
	 * it runs with, as the default for new conversations; resolves that level.
	 */
	async selectModel(model: RpcCatalogModel): Promise<ThinkingLevel> {
		const client = this.store.client;
		const selection = { provider: model.provider, modelId: model.id };
		await this.applied((await client.intent("set_model", selection)).ordinals);
		const thinkingLevel = this.store.state.thinkingLevel;
		await client.intent("set_default_model", selection);
		if (model.reasoning || thinkingLevel !== "off") {
			await client.intent("set_default_thinking_level", { level: thinkingLevel });
		}
		return thinkingLevel;
	}

	/**
	 * Set the thinking level, and keep the level the model runs with, as the
	 * host clamped it, as the default; resolves that level.
	 */
	async selectThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
		const client = this.store.client;
		const model = await this.model();
		await this.applied((await client.intent("set_thinking_level", { level })).ordinals);
		const effective = this.store.state.thinkingLevel;
		if (model?.reasoning || effective !== "off") {
			await client.intent("set_default_thinking_level", { level: effective });
		}
		return effective;
	}

	/** Switch between Build and Plan mode; resolves the mode switched to. */
	async toggleAgentMode(): Promise<"build" | "plan"> {
		const mode = this.store.state.planning?.mode === "plan" ? "build" : "plan";
		await this.store.client.intent("set_agent_mode", { mode });
		return mode;
	}

	/** Resolves once the store applied the entries at `ordinals`, or shows another conversation. */
	private applied(ordinals: readonly number[]): Promise<void> {
		const target = Math.max(0, ...ordinals);
		const conversation = this.store.conversation;
		const done = (): boolean => this.store.state.ordinal >= target || this.store.conversation !== conversation;
		if (done()) return Promise.resolve();
		return new Promise((resolve) => {
			const unsubscribe = this.store.subscribe(() => {
				if (!done()) return;
				unsubscribe();
				resolve();
			});
		});
	}

	// =========================================================================
	// Slash menu
	// =========================================================================

	/** The slash names that invoke one built-in intent each; a name several share (`/review`) names a TUI command. */
	private intentAliases(): IntentDescriptor[] {
		const builtIn = this.loaded.intents.filter((intent) => intent.source === "builtin" && intent.slash !== undefined);
		const counts = new Map<string | undefined, number>();
		for (const intent of builtIn) counts.set(intent.slash?.name, (counts.get(intent.slash?.name) ?? 0) + 1);
		return builtIn.filter((intent) => counts.get(intent.slash?.name) === 1);
	}

	/** The slash names the TUI's own commands (`local`) and the built-in intents take. */
	private takenNames(local: ReadonlySet<string>): Set<string> {
		const taken = new Set(local);
		for (const intent of this.loaded.intents) {
			if (intent.source === "builtin" && intent.slash !== undefined) taken.add(intent.slash.name);
		}
		return taken;
	}

	/**
	 * The slash commands the catalog adds to the TUI's own (`local`, which win
	 * a name they share): the intents' slash aliases, then the extension
	 * commands with the argument completions they offer, prompt templates,
	 * and, with `skills`, skills, none of which takes a built-in name.
	 */
	slashCommands(local: ReadonlySet<string>, options: { readonly skills: boolean }): SlashCommand[] {
		const commands: SlashCommand[] = [];
		const add = (descriptor: IntentDescriptor, getArgumentCompletions?: SlashCommand["getArgumentCompletions"]) => {
			const name = descriptor.slash?.name;
			if (name === undefined) return;
			const hint = argumentHint(descriptor);
			const description = describe(descriptor);
			commands.push({
				name,
				...(description === undefined ? {} : { description }),
				...(hint === undefined ? {} : { argumentHint: hint }),
				...(getArgumentCompletions === undefined ? {} : { getArgumentCompletions }),
			});
		};
		for (const alias of this.intentAliases()) {
			if (alias.slash !== undefined && !local.has(alias.slash.name)) add(alias);
		}
		const taken = this.takenNames(local);
		for (const intent of this.loaded.intents) {
			if (intent.slash === undefined || taken.has(intent.slash.name)) continue;
			if (intent.name.startsWith(EXTENSION_COMMAND_PREFIX)) {
				add(
					intent,
					intent.completions?.includes("arguments") === true
						? (prefix) => this.completeArguments(intent.name, prefix)
						: undefined,
				);
			} else if (
				intent.name.startsWith(PROMPT_TEMPLATE_PREFIX) ||
				(options.skills && intent.name.startsWith(SKILL_PREFIX))
			) {
				add(intent);
			}
		}
		return commands;
	}

	/** The extension commands whose slash names the TUI's own commands (`local`) or the built-in intents take. */
	commandConflicts(local: ReadonlySet<string>): InputDiagnostic[] {
		const taken = this.takenNames(local);
		const diagnostics: InputDiagnostic[] = [];
		for (const intent of this.loaded.intents) {
			const slashName = intent.slash?.name;
			if (!intent.name.startsWith(EXTENSION_COMMAND_PREFIX) || slashName === undefined) continue;
			const name = commandNameOf(intent.name);
			if (taken.has(slashName)) {
				diagnostics.push({
					type: "warning",
					message: `Extension command '/${slashName}' conflicts with built-in interactive command. Skipping in autocomplete.`,
				});
			} else if (taken.has(name)) {
				diagnostics.push({
					type: "warning",
					message: `Extension command '/${name}' conflicts with built-in interactive command. Available as '/${slashName}'.`,
				});
			}
		}
		return diagnostics;
	}

	/** An extension command's argument completions, from the `intent_completions` query. */
	private async completeArguments(intent: string, prefix: string): Promise<AutocompleteItem[] | null> {
		try {
			const { completions } = await this.store.client.query("intent_completions", {
				intent,
				field: "arguments",
				prefix,
			});
			if (completions.length === 0) return null;
			return completions.map((completion) => ({
				value: completion.value,
				label: completion.label ?? completion.value,
				...(completion.description === undefined ? {} : { description: completion.description }),
			}));
		} catch {
			return null;
		}
	}
}
