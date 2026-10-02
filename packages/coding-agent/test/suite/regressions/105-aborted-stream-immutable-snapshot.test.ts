import type { AssistantMessage } from "@hansjm10/volt-ai";
import { describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

type ToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];
type PendingTool = Pick<ToolExecutionComponent, "updateResult">;

type HandleEventThis = {
	isInitialized: boolean;
	init(): Promise<void>;
	footer: { invalidate(): void };
	streamingComponent: { updateContent(message: AssistantMessage): void } | undefined;
	streamingMessage: AssistantMessage | undefined;
	streamingRenderCoalescer: { finish(message: AssistantMessage): void } | undefined;
	session: { retryAttempt: number };
	pendingTools: Map<string, PendingTool>;
	disposePendingTools(): void;
	ui: { requestRender(): void };
};

type HandleEvent = (this: HandleEventThis, event: AgentSessionEvent) => Promise<void>;

function createAbortedAssistantMessage(): AssistantMessage {
	const toolCall = { type: "toolCall" as const, id: "tool-105", name: "slow_tool", arguments: {} };
	const message: AssistantMessage = {
		role: "assistant",
		content: [toolCall],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		errorMessage: "Request was aborted",
		timestamp: 0,
	};
	Object.freeze(toolCall.arguments);
	Object.freeze(toolCall);
	Object.freeze(message.content);
	Object.freeze(message.usage.cost);
	Object.freeze(message.usage);
	return Object.freeze(message);
}

describe("InteractiveMode aborted stream snapshots (#105)", () => {
	test("renders a retry message without mutating a frozen terminal snapshot", async () => {
		const message = createAbortedAssistantMessage();
		const finish = vi.fn<(message: AssistantMessage) => void>();
		const updateResult = vi.fn<(result: ToolResult) => void>();
		const pendingTools = new Map<string, PendingTool>([["tool-105", { updateResult }]]);
		const context: HandleEventThis = {
			isInitialized: true,
			init: async () => undefined,
			footer: { invalidate: vi.fn() },
			streamingComponent: { updateContent: vi.fn() },
			streamingMessage: undefined,
			streamingRenderCoalescer: { finish },
			session: { retryAttempt: 2 },
			pendingTools,
			disposePendingTools() {
				this.pendingTools.clear();
			},
			ui: { requestRender: vi.fn() },
		};
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(context, { type: "message_end", message });

		const displayedMessage = finish.mock.calls[0]?.[0];
		expect(displayedMessage).toEqual(expect.objectContaining({ errorMessage: "Aborted after 2 retry attempts" }));
		expect(displayedMessage).not.toBe(message);
		expect(message.errorMessage).toBe("Request was aborted");
		expect(updateResult).toHaveBeenCalledWith({
			content: [{ type: "text", text: "Aborted after 2 retry attempts" }],
			isError: true,
		});
		expect(pendingTools.size).toBe(0);
	});
});
