/**
 * Regression #957, the TUI's side: a TUI that resumed onto a conversation
 * recreated under the same id kept drawing the deleted log. Its resume was
 * answered with the new log's snapshot, but the store reported a reset of the
 * conversation it showed, and the transcript kept every row whose entry id
 * the new log repeated (an import copies entry ids): the deleted log's text
 * under the new log's ids. A snapshot of another log is now shown afresh, as
 * a conversation the client moved to is; only a snapshot of the log the TUI
 * shows keeps its rows.
 */

import { InMemoryConversationLog } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ConnectorOpenOptions,
	ConnectorTarget,
	ConversationConnector,
	OpenedConversation,
} from "../../../src/client/conversation-connector.ts";
import type { InProcessConnector } from "../../../src/client/in-process-connector.ts";
import type {
	RpcCloseHandler,
	RpcLineHandler,
	RpcTransport,
	RpcValueHandler,
} from "../../../src/core/protocol/transport/transport.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { TuiStoreChange } from "../../../src/modes/interactive/client/tui-store.ts";
import { seedLog } from "../../utilities/seed-log.ts";
import { createTuiHarness, renderedScreen, type TuiHarness, waitForScreen } from "../tui-harness.ts";

const SETTINGS = { theme: "dark", quietStartup: true, lsp: { enabled: false }, compaction: { enabled: false } };

/** A connection that can end unannounced, as a crashed worker's does. */
class LosableTransport implements RpcTransport {
	private readonly inner: RpcTransport;
	private readonly closeHandlers = new Set<RpcCloseHandler>();

	constructor(inner: RpcTransport) {
		this.inner = inner;
		inner.onClose?.((error) => this.closed(error));
	}

	write(value: object): void | Promise<void> {
		return this.inner.write(value);
	}

	onLine(handler: RpcLineHandler): () => void {
		return this.inner.onLine(handler);
	}

	onValue(handler: RpcValueHandler): () => void {
		const onValue = this.inner.onValue;
		if (onValue === undefined) throw new Error("The connection passes no values");
		return onValue.call(this.inner, handler);
	}

	onClose(handler: RpcCloseHandler): () => void {
		this.closeHandlers.add(handler);
		return () => this.closeHandlers.delete(handler);
	}

	close(): void | Promise<void> {
		return this.inner.close();
	}

	/** End the connection for the client before the host hears of it. */
	lose(): void {
		this.closed(new Error("The connection was lost"));
	}

	private closed(error: Error | undefined): void {
		for (const handler of [...this.closeHandlers]) handler(error);
	}
}

/**
 * The harness's connector, as a connector to a host that runs elsewhere: the
 * client resumes on a connection it opens again, once `reopen` lets it.
 */
class ResumingConnector implements ConversationConnector {
	readonly reconnects = true;
	/** Opens wait for it. */
	reopen: Promise<void> = Promise.resolve();
	private readonly inner: InProcessConnector;
	private connection: LosableTransport | undefined;

	constructor(inner: InProcessConnector) {
		this.inner = inner;
	}

	async open(target: ConnectorTarget, options?: ConnectorOpenOptions): Promise<OpenedConversation> {
		await this.reopen;
		const opened = await this.inner.open(target, options);
		this.connection = new LosableTransport(opened.transport);
		return { ...opened, transport: this.connection };
	}

	/** Lose the client's connection. */
	lose(): void {
		if (this.connection === undefined) throw new Error("Nothing is served");
		this.connection.lose();
	}

	stopServing(): void {
		this.inner.stopServing();
	}

	dispose(options?: { beforeDispose?: () => void }): Promise<void> {
		return this.inner.dispose(options);
	}

	daemonWorkspaceName(): string | undefined {
		return this.inner.daemonWorkspaceName();
	}

	onThemeSnapshot(listener: (themeName: string) => void): () => void {
		return this.inner.onThemeSnapshot(listener);
	}
}

const harnesses: TuiHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	vi.restoreAllMocks();
});

async function start() {
	const harness = await createTuiHarness({
		globalSettings: SETTINGS,
		startup: {
			seed: async (writer) => {
				await writer.appendMessage({ role: "user", content: "old question", timestamp: Date.now() });
				await writer.appendMessage(fauxAssistantMessage("old answer"));
			},
		},
	});
	harnesses.push(harness);
	const connector = new ResumingConnector(harness.connector);
	const tui = await harness.startMode({ connector, columns: 100, rows: 30 });
	const resets: Array<Extract<TuiStoreChange, { type: "reset" }>> = [];
	tui.store.subscribe((change) => {
		if (change.type === "reset") resets.push(change);
	});
	await waitForScreen(tui, "old question", "old answer");
	return { harness, connector, tui, resets };
}

describe("regression #957: a TUI resumed onto a recreated log draws that log", () => {
	it("shows the recreated log afresh, though it repeats the deleted log's entry ids", async () => {
		const { harness, connector, tui, resets } = await start();
		const deleted = harness.startup;
		const generation = tui.store.client.sessionGeneration;
		const reopen = Promise.withResolvers<void>();
		connector.reopen = reopen.promise;

		// The connection is lost; meanwhile the conversation is deleted and imported again under its id.
		connector.lose();
		await vi.waitFor(() => expect(deleted.closed).toBe(true));
		const [question, answer] = deleted.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message");
		if (question === undefined || answer === undefined) throw new Error("The deleted log holds no exchange");
		const log = new InMemoryConversationLog(deleted.id);
		await seedLog(log, (seed) =>
			seed.user("new question", { id: question.id }).assistant("new answer", { id: answer.id }),
		);
		const recreated = await harness.host.open({
			kind: "adopt",
			sessionManager: await SessionManager.openInMemory(log, deleted.cwd),
		});
		if (recreated.cancelled) throw new Error("Adopting the recreated log was cancelled");
		reopen.resolve();

		// The client resumed onto the recreated log: it holds that log's exchange under the deleted one's ids.
		await vi.waitFor(() =>
			expect(
				tui.store.transcript().map((entry) => (entry.type === "message" ? entry.view?.text : undefined)),
			).toEqual(["new question", "new answer"]),
		);
		expect(tui.store.transcript().map((entry) => entry.id)).toEqual([question.id, answer.id]);
		expect(tui.store.client.sessionGeneration).not.toBe(generation);
		expect(resets.at(-1)).toEqual({ type: "reset", conversation: deleted.id, sameLog: false });
		const shown = await waitForScreen(tui, "new question", "new answer");
		expect(shown).not.toContain("old question");
		expect(shown).not.toContain("old answer");
	});

	it("keeps the rows of the log it shows when that log's snapshot arrives again", async () => {
		const { tui, resets } = await start();

		tui.store.resync();

		await vi.waitFor(() => expect(resets).toHaveLength(1));
		expect(resets[0]).toEqual({ type: "reset", conversation: tui.store.conversation, sameLog: true });
		const shown = await renderedScreen(tui);
		expect(shown).toContain("old question");
		expect(shown).toContain("old answer");
	});
});
