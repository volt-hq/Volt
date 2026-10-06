import { afterEach, describe, expect, it, vi } from "vitest";
import { loseLog } from "../../lost-conversation-lock.ts";
import { createTuiHarness, type TuiHarness } from "../tui-harness.ts";

type FatalOptions = { unsentDraft?: string };
type TestAccess = {
	editor: { setText(text: string): void };
	registerSignalHandlers(): void;
	unregisterSignalHandlers(): void;
	endLostConversation(): Promise<void>;
	handleFatalRuntimeError: (prefix: string, error: unknown, options?: FatalOptions) => Promise<void>;
};

const FATAL_PREFIX = "Volt stopped this session because its saved state could not be confirmed";
const harnesses: TuiHarness[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	vi.restoreAllMocks();
});

/** InteractiveMode as a client of a real host, with the fatal exit kept from the real process.exit. */
async function fixture() {
	const harness = await createTuiHarness({
		globalSettings: { theme: "dark", lsp: { enabled: false }, quietStartup: true, compaction: { enabled: false } },
	});
	harnesses.push(harness);
	const tui = await harness.startMode({ columns: 140, rows: 30 });
	const access = tui.mode as unknown as TestAccess;
	const handleFatalRuntimeError = vi.fn(async (_prefix: string, _error: unknown, _options?: FatalOptions) => {});
	access.handleFatalRuntimeError = handleFatalRuntimeError;
	const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
	return { harness, access, handleFatalRuntimeError, exit };
}

describe("regression #525: interactive mode ends a conversation whose session lost its log", () => {
	it("closes the conversation and exits with a fatal error suggesting /resume, handing back the draft", async () => {
		const { harness, access, handleFatalRuntimeError, exit } = await fixture();
		const close = vi.spyOn(harness.host, "close");
		access.editor.setText("unsent draft");

		// The subscription ends `lost`: the session could not confirm a commit.
		await loseLog(harness.startup.session.sessionWriter);

		await vi.waitFor(() => expect(handleFatalRuntimeError).toHaveBeenCalledTimes(1), { timeout: 5_000 });
		const [prefix, error, options] = handleFatalRuntimeError.mock.calls[0]!;
		expect(prefix).toBe(FATAL_PREFIX);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("/resume");
		expect(options).toEqual({ unsentDraft: "unsent draft" });
		// Closing the conversation releases the session's lock before the TUI exits.
		expect(close).toHaveBeenCalled();
		expect(close.mock.invocationCallOrder[0]).toBeLessThan(handleFatalRuntimeError.mock.invocationCallOrder[0]!);
		expect(harness.startup.closed).toBe(true);
		expect(exit).not.toHaveBeenCalled();

		// Ending again does nothing.
		await access.endLostConversation();
		expect(handleFatalRuntimeError).toHaveBeenCalledTimes(1);
	});

	it("crashes on a plain uncaught exception", async () => {
		const { access, exit } = await fixture();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		access.registerSignalHandlers();
		cleanups.push(() => access.unregisterSignalHandlers());
		const onUncaughtException = process.listeners("uncaughtException")[0] as (error: Error) => void;
		const crash = new Error("plain crash");

		onUncaughtException(crash);

		expect(exit).toHaveBeenCalledWith(1);
		expect(consoleError).toHaveBeenCalledWith(crash);
	});
});
