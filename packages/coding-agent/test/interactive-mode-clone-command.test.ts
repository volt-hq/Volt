import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SessionIntents from "../src/core/host/session-intents.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const fork = vi.hoisted(() => vi.fn(async () => ({ cancelled: false })));
vi.mock("../src/core/host/session-intents.ts", async (importOriginal) => ({
	...(await importOriginal<typeof SessionIntents>()),
	openFork: fork,
}));

type CloneCommandContext = {
	sessionManager: { getLeafId: () => string | null };
	host: object;
	hostClient: object;
	showMovedConversation: () => Promise<void>;
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
};

type InteractiveModePrototype = {
	handleCloneCommand(this: CloneCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /clone", () => {
	beforeEach(() => {
		fork.mockClear();
	});

	it("clones the current leaf into a new session", async () => {
		const showMovedConversation = vi.fn(async () => {});
		const setText = vi.fn();
		const showStatus = vi.fn();
		const showError = vi.fn();
		const requestRender = vi.fn();

		const context: CloneCommandContext = {
			sessionManager: { getLeafId: () => "leaf-123" },
			host: {},
			hostClient: {},
			showMovedConversation,
			editor: { setText },
			showStatus,
			showError,
			ui: { requestRender },
		};

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(fork).toHaveBeenCalledWith(context.host, context.hostClient, "leaf-123", { position: "at" });
		expect(showMovedConversation).toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("");
		expect(showStatus).toHaveBeenCalledWith("Cloned to new session");
		expect(showError).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("shows a status message when there is nothing to clone", async () => {
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: CloneCommandContext = {
			sessionManager: { getLeafId: () => null },
			host: {},
			hostClient: {},
			showMovedConversation: vi.fn(async () => {}),
			editor: { setText: vi.fn() },
			showStatus,
			showError,
			ui: { requestRender: vi.fn() },
		};

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(fork).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Nothing to clone yet");
		expect(showError).not.toHaveBeenCalled();
	});
});
