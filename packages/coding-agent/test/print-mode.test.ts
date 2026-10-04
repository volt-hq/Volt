import type { AssistantMessage, ImageContent } from "@hansjm10/volt-ai";
import type { HostFrame } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationHost } from "../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import { LiveState } from "../src/core/host/live-state.ts";
import { writeRawStdout } from "../src/core/output-guard.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

vi.mock("../src/core/output-guard.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	writeRawStdout: vi.fn(),
	flushRawStdout: vi.fn(async () => {}),
}));

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type AttachExtensionOptions = {
	commandContextActions: { waitForIdle(): Promise<void> };
};

type FakeSession = {
	sessionId: string;
	sessionManager: SessionManager;
	liveState: LiveState;
	gitContextProvider: { retainObservation(): () => void };
	waitForIdle: ReturnType<typeof vi.fn<() => Promise<void>>>;
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	attachExtensionClient: ReturnType<
		typeof vi.fn<(options: AttachExtensionOptions) => { ready: Promise<void>; detach(): void }>
	>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeHostClient = Parameters<ConversationHost["attach"]>[0];

/** A host over one fake conversation: attaching binds the client's surface, leaving closes the conversation. */
type FakeHost = {
	host: ConversationHost;
	conversation: HostedConversation;
	session: FakeSession;
	close: ReturnType<typeof vi.fn>;
	loseLog(error: Error): void;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	error?: AssistantMessage["error"];
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		...(options?.error === undefined ? {} : { error: options.error }),
		timestamp: Date.now(),
	};
}

function createHost(assistantMessage: AssistantMessage): FakeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };
	const lost = Promise.withResolvers<Error>();

	const sessionManager = SessionManager.inMemory("/tmp/volt-print-mode");
	const session: FakeSession = {
		sessionId: "print-session",
		sessionManager,
		liveState: new LiveState({ head: () => sessionManager.getOrdinal() }),
		gitContextProvider: { retainObservation: () => () => {} },
		waitForIdle: vi.fn(async () => undefined),
		state,
		extensionRunner,
		attachExtensionClient: vi.fn((_options: AttachExtensionOptions) => ({
			ready: Promise.resolve(),
			detach: () => {},
		})),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};
	const conversation = {
		id: session.sessionId,
		session,
		lost: lost.promise,
		liveState: session.liveState,
	} as unknown as HostedConversation;
	let attached: FakeHostClient | undefined;
	const close = vi.fn(async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	});
	const host = {
		attach: vi.fn(async (client: FakeHostClient) => {
			attached = client;
			await session.attachExtensionClient({ ...client.surface, id: client.id } as AttachExtensionOptions).ready;
		}),
		conversationOf: (client: FakeHostClient) => (attached?.id === client.id ? conversation : undefined),
		detach: vi.fn(async () => {
			attached = undefined;
			await close();
		}),
		close,
	} as unknown as ConversationHost;

	return { host, conversation, session, close, loseLog: (error) => lost.resolve(error) };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(writeRawStdout).mockClear();
});

/** The frames JSON mode wrote to stdout. */
function writtenFrames(): HostFrame[] {
	return vi.mocked(writeRawStdout).mock.calls.map(([line]) => JSON.parse(String(line)) as HostFrame);
}

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const fixture = createHost(createAssistantMessage({ text: "done" }));
		const { session } = fixture;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(fixture.host, fixture.conversation, {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		const bindOptions = session.attachExtensionClient.mock.calls[0]?.[0];
		await bindOptions.commandContextActions.waitForIdle();
		expect(session.waitForIdle).toHaveBeenCalledOnce();
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const fixture = createHost(createAssistantMessage({ text: "done" }));
		const { session } = fixture;

		const exitCode = await runPrintMode(fixture.host, fixture.conversation, {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
		// The conversation as one local-profile subscription: a snapshot, the live lane, and its end.
		expect(writtenFrames()).toEqual([
			{
				type: "snapshot",
				subscriptionId: "json-1",
				conversation: "print-session",
				ordinal: 0,
				state: expect.objectContaining({ entries: [], earlier: false }),
			},
			{ type: "live", subscriptionId: "json-1", basedOn: 0, seq: 1, reset: true, items: [] },
			{ type: "ended", subscriptionId: "json-1", reason: "closed" },
		]);
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const fixture = createHost(
			createAssistantMessage({
				stopReason: "error",
				error: { kind: "unknown", retryable: false, message: "provider failure" },
			}),
		);
		const { session } = fixture;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(fixture.host, fixture.conversation, {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("ends the run with an error when the runtime's session loses its log, skipping later prompts", async () => {
		const fixture = createHost(createAssistantMessage({ text: "done" }));
		const { session } = fixture;
		session.prompt.mockImplementationOnce(async () => {
			fixture.loseLog(new Error("Expected log ordinal 4, but the log head is 5"));
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(fixture.host, fixture.conversation, {
			mode: "text",
			initialMessage: "first",
			messages: ["second"],
		});

		expect(exitCode).toBe(1);
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(
			"Volt stopped session print-session because its saved state could not be confirmed: Expected log ordinal 4, but the log head is 5",
		);
		// The conversation closes, which releases the session's lock.
		expect(fixture.close).toHaveBeenCalledTimes(1);
	});
});
