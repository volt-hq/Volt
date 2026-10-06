import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionImportFileNotFoundError } from "../src/core/host/conversation-host.ts";
import { openImport } from "../src/core/host/session-intents.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// The TUI imports through the host's import intent for its client.
vi.mock("../src/core/host/session-intents.ts", () => ({
	openFork: vi.fn(async () => ({ cancelled: true })),
	openImport: vi.fn(async () => ({ cancelled: true })),
	openNewSession: vi.fn(async () => ({ cancelled: true })),
	openStoredSession: vi.fn(async () => ({ cancelled: true })),
	openStoredSessionById: vi.fn(async () => ({ cancelled: true })),
}));

afterEach(() => {
	vi.clearAllMocks();
});

type PathCommand = "/export" | "/import";

type InteractiveModePrototype = {
	getPathCommandArgument(this: unknown, text: string, command: PathCommand): string | undefined;
	handleImportCommand(this: ImportCommandContext, text: string): Promise<void>;
};

type ImportCommandContext = {
	loadingAnimation?: { stop: () => void };
	statusContainer: { clear: () => void };
	host: object;
	hostClient: object;
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	showExtensionConfirm: (title: string, message: string) => Promise<boolean>;
	handleRuntimeSessionChange: () => Promise<void>;
	showMovedConversation: () => Promise<void>;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	promptForMissingSessionCwd: (error: unknown) => Promise<string | undefined>;
	getPathCommandArgument: (text: string, command: PathCommand) => string | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
const host = { name: "host" };
const client = { name: "client" };

describe("InteractiveMode /import parsing", () => {
	it("strips quotes from /import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument('/import "path/to/session.jsonl"', "/import")).toBe(
			"path/to/session.jsonl",
		);
		expect(
			interactiveModePrototype.getPathCommandArgument('/import "path with spaces/session.jsonl"', "/import"),
		).toBe("path with spaces/session.jsonl");
	});

	it("preserves apostrophes in unquoted /import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/import john's/session.jsonl", "/import")).toBe(
			"john's/session.jsonl",
		);
	});

	it("enforces command token boundaries", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/important /tmp/session.jsonl", "/import")).toBe(
			undefined,
		);
		expect(interactiveModePrototype.getPathCommandArgument("/exporter out.html", "/export")).toBe(undefined);
		expect(interactiveModePrototype.getPathCommandArgument("/import /tmp/session.jsonl", "/import")).toBe(
			"/tmp/session.jsonl",
		);
	});

	it("passes the unquoted path to the import intent for the TUI's client", async () => {
		vi.mocked(openImport).mockResolvedValueOnce({ cancelled: false, sessionId: "imported-session", seeded: false });
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			host,
			hostClient: client,
			showError,
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			showMovedConversation: vi.fn(async () => {}),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, '/import "path/to/session.jsonl"');

		expect(showExtensionConfirm).toHaveBeenCalledWith(
			"Import session",
			"Replace current session with path/to/session.jsonl?",
		);
		expect(openImport).toHaveBeenCalledWith(host, client, "path/to/session.jsonl");
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session imported from: path/to/session.jsonl");
	});

	it("passes an unquoted apostrophe path to the import intent unchanged", async () => {
		vi.mocked(openImport).mockResolvedValueOnce({ cancelled: false, sessionId: "imported-session", seeded: false });
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			host,
			hostClient: client,
			showError,
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			showMovedConversation: vi.fn(async () => {}),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/import john's/session.jsonl");

		expect(openImport).toHaveBeenCalledWith(host, client, "john's/session.jsonl");
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session imported from: john's/session.jsonl");
	});

	it("shows a non-fatal error when /import path does not exist", async () => {
		vi.mocked(openImport).mockRejectedValueOnce(new SessionImportFileNotFoundError("/tmp/missing-session.jsonl"));
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();
		const handleFatalRuntimeError = vi.fn(async () => {
			throw new Error("unexpected fatal error");
		});

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			host,
			hostClient: client,
			showError,
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			showMovedConversation: vi.fn(async () => {}),
			handleFatalRuntimeError,
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/import /tmp/missing-session.jsonl");

		expect(showError).toHaveBeenCalledWith("Failed to import session: File not found: /tmp/missing-session.jsonl");
		expect(showStatus).not.toHaveBeenCalled();
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
	});
});
