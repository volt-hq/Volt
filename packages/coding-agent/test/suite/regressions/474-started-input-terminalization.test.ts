import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PromptPreflightResult } from "../../../src/core/agent-session.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createSessionManagerTestOwner } from "../../session-manager-owner.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

interface Gate {
	entered: Promise<void>;
	released: Promise<void>;
	markEntered(): void;
	release(): void;
}

function createGate(): Gate {
	let markEntered!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		markEntered = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { entered, released, markEntered, release };
}

describe("#474 live pre-commit client input failures are terminal", () => {
	const harnesses: Harness[] = [];
	const managerOwner = createSessionManagerTestOwner();
	const tempDirs: string[] = [];

	beforeEach(() => managerOwner.start());

	afterEach(async () => {
		while (harnesses.length > 0)
			await harnesses
				.pop()!
				.cleanupAsync()
				.catch(() => {});
		await managerOwner.drain();
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	async function createPersistedHarness(
		extensionFactories?: ExtensionFactory[],
	): Promise<{ harness: Harness; manager: SessionManager; tempDir: string }> {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-474-"));
		tempDirs.push(tempDir);
		const manager = await SessionManager.create(tempDir, tempDir);
		const harness = await createHarness({
			sessionManager: manager,
			...(extensionFactories === undefined ? {} : { extensionFactories }),
		});
		harnesses.push(harness);
		return { harness, manager, tempDir };
	}

	it("fails a prompt whose pre-run compaction throws and admits fresh input after reopening", async () => {
		const { harness, manager, tempDir } = await createPersistedHarness();
		harness.setResponses([fauxAssistantMessage("first reply")]);
		await harness.session.prompt("Hello", { clientMessageId: "first" });

		const internals = harness.session as unknown as { _checkCompaction(): Promise<boolean> };
		internals._checkCompaction = async () => {
			throw new Error("injected compaction failure");
		};
		harness.appendResponses([fauxAssistantMessage("must remain unused")]);

		await expect(harness.session.prompt("Continue", { clientMessageId: "stuck" })).rejects.toThrow(
			"injected compaction failure",
		);
		expect(manager.getClientInput("stuck")).toMatchObject({ state: "failed", error: "injected compaction failure" });
		expect(manager.getClientInputRecoveryPlan()).toEqual({ kind: "idle", records: [] });

		// A same-ID retry replays the definitive failure instead of dispatching again.
		await expect(harness.session.prompt("Continue", { clientMessageId: "stuck" })).rejects.toThrow(
			"injected compaction failure",
		);
		expect(getUserTexts(harness)).toEqual(["Hello"]);
		expect(harness.getPendingResponseCount()).toBe(1);

		// Simulate the detached runtime stopping and a later resume.
		harnesses.splice(harnesses.indexOf(harness), 1);
		await harness.cleanupAsync();
		const reopened = await SessionManager.open(manager.getSessionRef()!, tempDir);
		expect(reopened.getClientInput("stuck")?.state).toBe("failed");
		expect(reopened.getClientInputRecoveryPlan()).toEqual({ kind: "idle", records: [] });
		const replacement = await createHarness({ sessionManager: reopened });
		harnesses.push(replacement);
		replacement.setResponses([fauxAssistantMessage("resumed reply")]);

		await expect(replacement.session.resumeRecoveredClientInputs()).resolves.toBeUndefined();
		await expect(replacement.session.prompt("Resume work", { clientMessageId: "fresh" })).resolves.toBeUndefined();
		expect(reopened.getClientInput("fresh")?.state).toBe("completed");
		expect(getUserTexts(replacement)).toEqual(["Hello", "Resume work"]);
		expect(replacement.getPendingResponseCount()).toBe(0);
	});

	it.each([
		{
			hook: "input" as const,
			message: "Prompt aborted during input preflight",
		},
		{
			hook: "before_agent_start" as const,
			message: "Prompt aborted before the agent run started",
		},
	])("fails a prompt aborted while a $hook hook runs after the dispatch boundary", async ({ hook, message }) => {
		const gate = createGate();
		const clientMessageId = `abort-during-${hook}`;
		const { harness, manager } = await createPersistedHarness([
			(volt) => {
				if (hook === "input") {
					volt.on("input", async () => {
						gate.markEntered();
						await gate.released;
						return { action: "continue" };
					});
					return;
				}
				volt.on("before_agent_start", async () => {
					gate.markEntered();
					await gate.released;
				});
			},
		]);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);

		const promptOutcome = harness.session.prompt("aborted input", { clientMessageId }).then(
			() => undefined,
			(error: unknown) => error,
		);
		await gate.entered;
		expect(manager.getClientInput(clientMessageId)?.state).toBe("started");
		const abort = harness.session.abort();
		gate.release();
		await abort;

		expect(await promptOutcome).toMatchObject({ message });
		expect(manager.getClientInput(clientMessageId)?.state).toBe("failed");
		expect(manager.getClientInputRecoveryPlan()).toEqual({ kind: "idle", records: [] });
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("rejects and fails a prompt whose run is cancelled before its user message commits", async () => {
		const gate = createGate();
		const clientMessageId = "silently-cancelled-run";
		const { harness, manager } = await createPersistedHarness();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const internals = harness.session as unknown as { _maybeAppendSubagentRecoveryNotice(): Promise<void> };
		internals._maybeAppendSubagentRecoveryNotice = async () => {
			gate.markEntered();
			await gate.released;
		};
		const preflight: PromptPreflightResult[] = [];

		const promptOutcome = harness.session
			.prompt("cancelled run", {
				clientMessageId,
				source: "rpc",
				preflightResult: (result) => preflight.push(result),
			})
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		await gate.entered;
		expect(manager.getClientInput(clientMessageId)?.state).toBe("started");
		const abort = harness.session.abort();
		gate.release();
		await abort;

		expect(await promptOutcome).toMatchObject({
			message: "Client input stopped before its canonical user message committed",
		});
		expect(preflight).toEqual([{ success: false }]);
		expect(manager.getClientInput(clientMessageId)?.state).toBe("failed");
		expect(manager.getClientInputRecoveryPlan()).toEqual({ kind: "idle", records: [] });
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
