import type { AgentToolResult, AgentToolUpdateCallback } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { TUI } from "@hansjm10/volt-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { loseLog } from "../../lost-conversation-lock.ts";
import { getMessageText } from "../harness.ts";
import { createTuiHarness } from "../tui-harness.ts";

type InteractiveAccess = {
	ui: TUI;
	editor: CustomEditor;
	handleFatalRuntimeError: (prefix: string, error: unknown, options?: { unsentDraft?: string }) => Promise<void>;
};

describe("regression #536: ending a lost session while an uncooperative tool is running", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeAll(() => {
		initTheme(undefined, false);
	});

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	function requireSessionRef(session: AgentSession): SessionReference {
		const sessionRef = session.sessionRef;
		if (!sessionRef) throw new Error("expected a persisted session");
		return sessionRef;
	}

	async function readStoredMessageTexts(sessionRef: SessionReference): Promise<string[]> {
		const manager = await SessionManager.openReadOnly(sessionRef);
		try {
			return manager.getConversationState().context.messages.map(getMessageText);
		} finally {
			await manager.closePersistence();
		}
	}

	function withinTimeout<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
		});
		return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
	}

	function viewport(terminal: VirtualTerminal): string {
		return terminal.getViewport().join("\n");
	}

	/** InteractiveMode as the client of a conversation over the faux provider, without the main input loop. */
	async function startInteractiveMode(extensionFactory: ExtensionFactory) {
		const harness = await createTuiHarness({ responses: [], extension: extensionFactory });
		cleanups.push(() => harness.cleanup());
		const tui = await harness.startMode({ columns: 140, rows: 30 });
		const access = tui.mode as unknown as InteractiveAccess;
		const handleFatalRuntimeError = vi.fn(async () => {});
		access.handleFatalRuntimeError = handleFatalRuntimeError;
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		cleanups.push(() => exit.mockRestore());
		return { harness, access, terminal: tui.terminal, handleFatalRuntimeError, exit };
	}

	it.each([
		["resolve", false],
		["reject", false],
		["never", false],
		["resolve", true],
		["reject", true],
		["never", true],
	] as const)(
		"ends the session and hands back the draft when abandoned output will %s (already cancelled: %s)",
		async (lateOutcome, cancelFirst) => {
			const started = Promise.withResolvers<AbortSignal>();
			const result = Promise.withResolvers<AgentToolResult>();
			let lateUpdate: AgentToolUpdateCallback | undefined;
			const extensionFactory: ExtensionFactory = (volt) => {
				volt.registerTool({
					name: "stuck",
					label: "Stuck",
					description: "Ignores cancellation",
					parameters: Type.Object({}),
					execute: async (_id, _args, signal, onUpdate) => {
						if (!signal) throw new Error("expected a tool signal");
						lateUpdate = onUpdate;
						started.resolve(signal);
						return result.promise;
					},
				});
			};
			const { harness, access, terminal, handleFatalRuntimeError, exit } =
				await startInteractiveMode(extensionFactory);
			// Also releases the tool on a failed assertion so test teardown cannot hang.
			cleanups.push(() => result.resolve({ content: [{ type: "text", text: "cleanup" }] }));
			harness.faux.setResponses([fauxAssistantMessage(fauxToolCall("stuck", {}), { stopReason: "toolUse" })]);
			const staleSession = harness.startup.session;
			const sessionRef = requireSessionRef(staleSession);
			const prompt = Promise.allSettled([staleSession.prompt("start")]);
			const signal = await started.promise;
			const abort = cancelFirst ? staleSession.abort("keyboard_interrupt") : Promise.resolve();
			if (cancelFirst) await vi.waitFor(() => expect(signal.aborted).toBe(true));
			access.editor.setText("unsent draft");
			await loseLog(staleSession.sessionWriter);
			await withinTimeout(prompt, "aborted prompt");
			await withinTimeout(abort, "prior cancellation");
			// Disposal must not wait for the uncooperative tool before the TUI exits.
			await vi.waitFor(() => expect(handleFatalRuntimeError).toHaveBeenCalledTimes(1), { timeout: 5_000 });
			expect(handleFatalRuntimeError).toHaveBeenCalledWith(
				"Volt stopped this session because its saved state could not be confirmed",
				expect.objectContaining({ message: expect.stringContaining("/resume") }),
				{ unsentDraft: "unsent draft" },
			);
			expect(signal.aborted).toBe(true);
			expect(staleSession.isStreaming).toBe(false);
			expect(exit).not.toHaveBeenCalled();

			lateUpdate?.({ content: [{ type: "text", text: "late progress" }] });
			if (lateOutcome === "resolve") result.resolve({ content: [{ type: "text", text: "late result" }] });
			if (lateOutcome === "reject") result.reject(new Error("late rejection"));
			await new Promise((resolve) => setTimeout(resolve, 0));
			access.ui.requestRender(true);
			await terminal.waitForRender();
			expect(viewport(terminal)).not.toContain("late progress");
			expect(await readStoredMessageTexts(sessionRef)).not.toContain("late result");
		},
	);
});
