import {
	createAiClient,
	createFauxProvider,
	type FauxProvider,
	type FauxProviderOptions,
	type Model,
} from "@hansjm10/volt-ai";
import { afterEach } from "vitest";
import type { ConversationEvent, ConversationOptions } from "../../src/conversation/api.ts";
import { Conversation } from "../../src/conversation/conversation.ts";
import { InMemoryConversationLog } from "../../src/conversation/in-memory-log.ts";
import type { ConversationLog, ConversationLogEntry } from "../../src/conversation/log.ts";
import type { AgentMessage, AgentTool } from "../../src/types.ts";

export const client = createAiClient();
const registered: string[] = [];
const opened: Conversation[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((conversation) => conversation.close()));
	for (const api of registered.splice(0)) client.unregisterProvider(api);
});

export function registerFauxProvider(options?: FauxProviderOptions): FauxProvider {
	const faux = createFauxProvider(options);
	client.registerProvider(faux);
	registered.push(faux.api);
	return faux;
}

export type TestOptions = Partial<Omit<ConversationOptions, "log">> & {
	readonly log?: ConversationLog;
	readonly faux?: FauxProvider;
	/** Commit the faux model before returning; default true. */
	readonly withModel?: boolean;
};

export interface TestConversation {
	readonly conversation: Conversation;
	readonly log: ConversationLog;
	readonly faux: FauxProvider;
	readonly model: Model<string>;
	readonly events: ConversationEvent[];
}

/** Open a conversation over an in-memory log with a faux provider and record every event. */
export async function openConversation(options: TestOptions = {}): Promise<TestConversation> {
	const faux = options.faux ?? registerFauxProvider();
	const log = options.log ?? new InMemoryConversationLog("conversation-test");
	const { faux: _faux, log: _log, withModel, ...rest } = options;
	const conversation = await Conversation.open({
		log,
		stream: client.streamSimple,
		resolveModel: (provider, modelId) => (provider === faux.getModel().provider ? faux.getModel(modelId) : undefined),
		...rest,
	});
	opened.push(conversation);
	const events: ConversationEvent[] = [];
	conversation.subscribe((event) => {
		events.push(event);
	});
	if (withModel !== false && conversation.model === undefined) await conversation.setModel(faux.getModel());
	return { conversation, log, faux, model: faux.getModel(), events };
}

export async function readLog(log: ConversationLog): Promise<ConversationLogEntry[]> {
	const entries: ConversationLogEntry[] = [];
	for (;;) {
		const page = await log.read(entries.length, 1_000);
		entries.push(...page.entries);
		if (page.entries.length === 0 || entries.length >= page.lastOrdinal) return entries;
	}
}

export function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export function userTexts(messages: readonly AgentMessage[]): string[] {
	return messages.filter((message) => message.role === "user").map(textOf);
}

export function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export function observe<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
	return promise.then(
		(value) => ({ status: "fulfilled", value }),
		(reason: unknown) => ({ status: "rejected", reason }),
	);
}

/** Admit a prompt and wait for the turn that delivers it. */
export async function promptAndSettle(conversation: Conversation, message: string): Promise<void> {
	const admission = await conversation.prompt({ message });
	await admission.completion;
	await conversation.waitForIdle();
}

export function lastAssistant(conversation: Conversation): AgentMessage | undefined {
	return conversation.state.context.messages.findLast((message) => message.role === "assistant");
}

export type { AgentTool };
