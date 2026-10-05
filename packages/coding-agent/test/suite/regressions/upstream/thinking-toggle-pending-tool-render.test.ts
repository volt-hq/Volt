// Upstream Pi regression: https://github.com/earendil-works/pi/issues/4167

import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@hansjm10/volt-ai";
import { Container, Text, type TUI } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../../../src/core/agent-session.ts";
import type { SessionPresenters } from "../../../../src/core/session/presenters.ts";
import { initTheme } from "../../../../src/core/theme/runtime.ts";
import type { ToolRow } from "../../../../src/modes/interactive/components/presented-tool.ts";
import { InteractiveMode } from "../../../../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../../../../src/utils/ansi.ts";
import { builtinSessionPresenters } from "../../../utilities/test-presenters.ts";

const TOOL_CALL_ID = "tool-4167";
const TOOL_NAME = "slow_tool";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type RenderSessionContextThis = {
	pendingTools: Map<string, ToolRow>;
	liveBackgroundJobTools: Map<string, { component: ToolRow; jobId?: string }>;
	disposePendingTools(): void;
	chatContainer: Container;
	footer: { invalidate(): void };
	ui: TUI;
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
	};
	sessionManager: { getCwd(): string };
	session: { retryAttempt: number; presenters: SessionPresenters };
	toolOutputExpanded: boolean;
	isInitialized: boolean;
	updateEditorBorderColor(): void;
	getRegisteredToolDefinition(toolName: string): undefined;
	createToolRow(toolName: string, toolCallId: string, args: unknown, live: boolean): ToolRow;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
};

type CreateToolRow = RenderSessionContextThis["createToolRow"];

type RenderSessionContext = (
	this: RenderSessionContextThis,
	messages: readonly AgentMessage[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type HandleEvent = (this: RenderSessionContextThis, event: AgentSessionEvent) => Promise<void>;

function createFakeInteractiveModeThis(): RenderSessionContextThis {
	const chatContainer = new Container();
	return {
		pendingTools: new Map<string, ToolRow>(),
		liveBackgroundJobTools: new Map(),
		disposePendingTools() {
			for (const component of this.pendingTools.values()) {
				component.dispose();
			}
			this.pendingTools.clear();
		},
		chatContainer,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
		},
		sessionManager: { getCwd: () => process.cwd() },
		session: { retryAttempt: 0, presenters: builtinSessionPresenters() },
		toolOutputExpanded: false,
		isInitialized: true,
		updateEditorBorderColor: vi.fn(),
		getRegisteredToolDefinition: (_toolName: string) => undefined,
		createToolRow(...args) {
			return (InteractiveMode.prototype as unknown as { createToolRow: CreateToolRow }).createToolRow.apply(
				this,
				args,
			);
		},
		addMessageToChat(message: AgentMessage) {
			chatContainer.addChild(new Text(message.role, 0, 0));
		},
	};
}

function createAssistantToolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: TOOL_CALL_ID,
				name: TOOL_NAME,
				arguments: { delayMs: 10_000 },
			},
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createToolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).lines.join("\n"));
}

describe("InteractiveMode.renderSessionContext", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps unresolved rendered tool calls registered for live completion events", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionContext = (
			InteractiveMode.prototype as unknown as { renderSessionContext: RenderSessionContext }
		).renderSessionContext;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		renderSessionContext.call(fakeThis, [createAssistantToolCallMessage()]);

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(true);

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			result: { content: [{ type: "text", text: "FINAL_RESULT" }] },
			isError: false,
		});

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(false);
		expect(renderChat(fakeThis.chatContainer)).toContain("FINAL_RESULT");
	});

	test("does not keep completed historical tool calls registered as pending", () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionContext = (
			InteractiveMode.prototype as unknown as { renderSessionContext: RenderSessionContext }
		).renderSessionContext;

		renderSessionContext.call(fakeThis, [
			createAssistantToolCallMessage(),
			createToolResultMessage("HISTORICAL_RESULT"),
		]);

		expect(fakeThis.pendingTools.size).toBe(0);
		expect(renderChat(fakeThis.chatContainer)).toContain("HISTORICAL_RESULT");
	});
});
