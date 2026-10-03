import { randomUUID } from "node:crypto";
import type {
	AgentMessage,
	ConversationLog,
	ConversationLogEntry,
	ConversationLogEntryDraft,
	ThinkingLevel,
} from "@hansjm10/volt-agent-core";
import type {
	AssistantMessage,
	AssistantMessageDiagnostic,
	ImageContent,
	ProviderError,
	StopReason,
	ToolCall,
	Usage,
} from "@hansjm10/volt-ai";

/** The model a seeded assistant message names. A `Model` satisfies it. */
export interface SeedModel {
	readonly api: string;
	readonly provider: string;
	readonly id: string;
}

export interface SeedMessageOptions {
	/** The entry id; `seed-<ordinal>` by default. */
	readonly id?: string;
	/** The message timestamp; the entry's own time by default. */
	readonly timestamp?: number;
}

export interface SeedAssistantOptions extends SeedMessageOptions {
	readonly toolCalls?: readonly ToolCall[];
	/** `toolUse` with tool calls, otherwise `stop`. */
	readonly stopReason?: StopReason;
	readonly error?: ProviderError;
	readonly usage?: Partial<Omit<Usage, "cost">>;
	readonly diagnostics?: readonly AssistantMessageDiagnostic[];
	/** The model that answered; the latest seeded `model()` or the seed's default model. */
	readonly model?: SeedModel;
}

export interface SeedLogOptions {
	/** The model seeded assistant messages name until a `model()` entry changes it. */
	readonly model?: SeedModel;
	/** Time of the first seeded entry, in epoch milliseconds; later entries follow a second apart. One hour ago by default. */
	readonly at?: number;
}

const DEFAULT_MODEL: SeedModel = { api: "seed-api", provider: "seed", id: "seed-model" };

type EntryBody = ConversationLogEntryDraft extends infer T
	? T extends unknown
		? Omit<T, "id" | "parentId" | "timestamp">
		: never
	: never;

/**
 * A fluent builder of valid log entries, appended in one batch by
 * {@link seedLog}. Each entry extends the active branch: a conversation
 * entry becomes the leaf, `leaf()` moves it, and host entries hang off it.
 */
export class LogSeed {
	readonly drafts: ConversationLogEntryDraft[] = [];
	private readonly firstOrdinal: number;
	private readonly start: number;
	private currentModel: SeedModel;
	private leafId: string | null;
	private readonly parents = new Map<string, string | null>();
	private readonly kinds = new Map<string, string>();
	private readonly toolNames = new Map<string, string>();

	constructor(head: number, leafId: string | null, options: SeedLogOptions) {
		this.firstOrdinal = head + 1;
		this.leafId = leafId;
		this.start = options.at ?? Date.now() - 60 * 60 * 1000;
		this.currentModel = options.model ?? DEFAULT_MODEL;
	}

	/** The id of the newest seeded entry. */
	get lastId(): string {
		const last = this.drafts.at(-1);
		if (!last) throw new Error("Nothing was seeded yet");
		return last.id;
	}

	user(text: string, options: SeedMessageOptions & { readonly images?: readonly ImageContent[] } = {}): this {
		const timestamp = options.timestamp ?? this.time();
		const content = options.images?.length ? [{ type: "text" as const, text }, ...options.images] : text;
		return this.message({ role: "user", content, timestamp }, options.id);
	}

	assistant(text: string, options: SeedAssistantOptions = {}): this {
		const model = options.model ?? this.currentModel;
		const toolCalls = options.toolCalls ?? [];
		for (const call of toolCalls) this.toolNames.set(call.id, call.name);
		const message: AssistantMessage = {
			role: "assistant",
			content: [...(text === "" && toolCalls.length > 0 ? [] : [{ type: "text" as const, text }]), ...toolCalls],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				...options.usage,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: options.stopReason ?? (toolCalls.length > 0 ? "toolUse" : "stop"),
			...(options.error === undefined ? {} : { error: options.error }),
			...(options.diagnostics === undefined ? {} : { diagnostics: [...options.diagnostics] }),
			timestamp: options.timestamp ?? this.time(),
		};
		return this.message(message, options.id);
	}

	/** A tool result; its tool name defaults to the seeded call's. */
	toolResult(
		toolCallId: string,
		text: string,
		options: SeedMessageOptions & { readonly toolName?: string; readonly isError?: boolean } = {},
	): this {
		return this.message(
			{
				role: "toolResult",
				toolCallId,
				toolName: options.toolName ?? this.toolNames.get(toolCallId) ?? "tool",
				content: [{ type: "text", text }],
				isError: options.isError ?? false,
				timestamp: options.timestamp ?? this.time(),
			},
			options.id,
		);
	}

	/** A compaction keeping the branch from `firstKeptEntryId`: the latest user message by default. */
	compaction(
		options: {
			readonly id?: string;
			readonly summary?: string;
			readonly firstKeptEntryId?: string;
			readonly tokensBefore?: number;
		} = {},
	): this {
		const firstKeptEntryId = options.firstKeptEntryId ?? this.latestUserMessage() ?? this.leafId;
		if (firstKeptEntryId === null) throw new Error("A compaction needs a branch to keep");
		return this.add(
			{
				type: "compaction",
				visibility: "public",
				payload: {
					summary: options.summary ?? "Seeded compaction summary",
					firstKeptEntryId,
					tokensBefore: options.tokensBefore ?? 1_000,
				},
			},
			options.id,
		);
	}

	/** A summary of an abandoned branch, at the current leaf (after `leaf()` moved it). */
	branchSummary(summary: string, options: { readonly id?: string } = {}): this {
		return this.add(
			{ type: "branch_summary", visibility: "public", payload: { fromId: this.leafId ?? "root", summary } },
			options.id,
		);
	}

	/** Move the active branch to `targetId` (`null` for before the first entry). */
	leaf(targetId: string | null, options: { readonly id?: string } = {}): this {
		return this.add({ type: "leaf", visibility: "host", payload: { targetId } }, options.id);
	}

	/** Switch the model; later seeded assistant messages name it. */
	model(model: SeedModel, options: { readonly id?: string } = {}): this {
		this.currentModel = model;
		return this.add(
			{ type: "model_change", visibility: "public", payload: { provider: model.provider, modelId: model.id } },
			options.id,
		);
	}

	thinking(thinkingLevel: ThinkingLevel, options: { readonly id?: string } = {}): this {
		return this.add({ type: "thinking_level_change", visibility: "public", payload: { thinkingLevel } }, options.id);
	}

	/** Set, or without `label` clear, the label of a conversation entry: the newest one by default. */
	label(label: string | undefined, options: { readonly id?: string; readonly targetId?: string } = {}): this {
		const targetId = options.targetId ?? this.leafId;
		if (targetId === null) throw new Error("A label needs a conversation entry");
		return this.add(
			{ type: "label", visibility: "public", payload: { targetId, ...(label === undefined ? {} : { label }) } },
			options.id,
		);
	}

	custom(customType: string, data?: unknown, options: { readonly id?: string } = {}): this {
		return this.add(
			{ type: "custom", visibility: "public", payload: { customType, ...(data === undefined ? {} : { data }) } },
			options.id,
		);
	}

	private message(message: AgentMessage, id: string | undefined): this {
		return this.add({ type: "message", visibility: "public", payload: { message } } as EntryBody, id, message.role);
	}

	private add(body: EntryBody, id = `seed-${this.firstOrdinal + this.drafts.length}`, kind = body.type): this {
		const draft = {
			...body,
			id,
			parentId: this.leafId,
			timestamp: new Date(this.time()).toISOString(),
		} as ConversationLogEntryDraft;
		this.drafts.push(draft);
		this.parents.set(id, this.leafId);
		this.kinds.set(id, kind);
		if (body.type === "leaf") this.leafId = (body.payload as { targetId: string | null }).targetId;
		else if (body.visibility === "public") this.leafId = id;
		return this;
	}

	/** The time of the entry being added: a second after the previous one. */
	private time(): number {
		return this.start + this.drafts.length * 1_000;
	}

	private latestUserMessage(): string | undefined {
		for (let id = this.leafId; id !== null; id = this.parents.get(id) ?? null) {
			if (this.kinds.get(id) === "user") return id;
		}
		return undefined;
	}
}

export type SeedLogBuild = (seed: LogSeed) => unknown;

/**
 * Append the entries `build` describes to `log` in one batch, on its active
 * branch, and return them as committed. Valid for every log: in-memory, SQLite,
 * and a `FaultyConversationLog` over either.
 */
export async function seedLog(
	log: ConversationLog,
	build: SeedLogBuild,
	options: SeedLogOptions = {},
): Promise<ConversationLogEntry[]> {
	const head = log.head();
	const seed = new LogSeed(head, await activeLeaf(log, head), options);
	build(seed);
	if (seed.drafts.length === 0) return [];
	const result = await log.append({ expectedOrdinal: head, commitId: `seed:${randomUUID()}`, entries: seed.drafts });
	if (result.status !== "committed") throw new Error("The seeded entries were rolled back", { cause: result.error });
	return seed.drafts.map((draft, index) => ({ ...draft, ordinal: result.first + index }) as ConversationLogEntry);
}

/** The leaf of the log's existing entries: the newest leaf move or conversation entry. */
async function activeLeaf(log: ConversationLog, head: number): Promise<string | null> {
	let leafId: string | null = null;
	for (let after = 0; after < head; ) {
		const page = await log.read(after, 1_000);
		if (page.entries.length === 0) break;
		for (const entry of page.entries) {
			if (entry.type === "leaf") leafId = (entry.payload as { targetId: string | null }).targetId;
			else if (entry.visibility === "public") leafId = entry.id;
		}
		after += page.entries.length;
	}
	return leafId;
}
