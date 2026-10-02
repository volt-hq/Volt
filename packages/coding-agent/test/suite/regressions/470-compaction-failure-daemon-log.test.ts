import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { observeCompactionFailures } from "../../../src/daemon/compaction-failure-log.ts";
import { createDaemonLogger } from "../../../src/daemon/log.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

interface DaemonLogLine {
	level: string;
	subsystem: string;
	message: string;
	details: Record<string, unknown>;
}

function createLogFile(): { logPath: string; readLines(): DaemonLogLine[]; cleanup(): void } {
	const dir = mkdtempSync(join(tmpdir(), "volt-470-"));
	const logPath = join(dir, "voltd.log");
	return {
		logPath,
		readLines() {
			let text: string;
			try {
				text = readFileSync(logPath, "utf8");
			} catch {
				return [];
			}
			return text
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => {
					const match = /^\S+ (\S+) (\S+) (.*?) (\{.*\})$/.exec(line);
					if (!match) throw new Error(`Unexpected daemon log line: ${line}`);
					return {
						level: match[1],
						subsystem: match[2],
						message: match[3],
						details: JSON.parse(match[4]) as Record<string, unknown>,
					};
				});
		},
		cleanup() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function createReplaceableRuntime(initial: AgentSession) {
	const listeners = new Set<(session: AgentSession) => Promise<void> | void>();
	const runtime = {
		session: initial,
		subscribeSessionReplaced(listener: (session: AgentSession) => Promise<void> | void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		replace(next: AgentSession): void {
			runtime.session = next;
			for (const listener of listeners) void listener(next);
		},
	};
	return runtime;
}

function summaryProviderError(errorMessage: string) {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

async function createCompactableHarness(extensionFactories?: ExtensionFactory[]): Promise<Harness> {
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: false } },
		...(extensionFactories === undefined ? {} : { extensionFactories }),
	});
	harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
	await harness.session.prompt("private conversation text one");
	await harness.session.prompt("private conversation text two");
	return harness;
}

describe("#470 compaction failures are recorded in the daemon log", () => {
	const harnesses: Harness[] = [];
	const logFiles: Array<{ cleanup(): void }> = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanupAsync();
		while (logFiles.length > 0) logFiles.pop()?.cleanup();
	});

	it("logs one line with session, workspace, reason, model, and error but no conversation content", async () => {
		const harness = await createCompactableHarness();
		harnesses.push(harness);
		const logFile = createLogFile();
		logFiles.push(logFile);
		const stop = observeCompactionFailures(
			createReplaceableRuntime(harness.session),
			"volt-app",
			createDaemonLogger({ logPath: logFile.logPath }).child("compaction"),
		);

		harness.setResponses([summaryProviderError("summary provider unavailable")]);
		await expect(harness.session.compact()).rejects.toThrow("summary provider unavailable");
		stop();

		const model = harness.getModel();
		expect(logFile.readLines()).toEqual([
			{
				level: "warn",
				subsystem: "compaction",
				message: "compaction failed",
				details: {
					sessionId: harness.session.sessionId,
					workspace: "volt-app",
					reason: "manual",
					model: `${model.provider}/${model.id}`,
					error: expect.stringContaining("summary provider unavailable"),
				},
			},
		]);
		const raw = readFileSync(logFile.logPath, "utf8");
		expect(raw).not.toContain("private conversation text");
		expect(raw).not.toContain("first reply");
	});

	it("does not log successful or cancelled compactions", async () => {
		let mode: "succeed" | "wait_for_abort" = "succeed";
		const harness = await createCompactableHarness([
			(volt) => {
				volt.on("session_before_compact", async (event) => {
					if (mode === "succeed") {
						return {
							compaction: {
								summary: "extension summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					}
					return await new Promise<{ cancel: true }>((resolve) => {
						event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
					});
				});
			},
		]);
		harnesses.push(harness);
		const logFile = createLogFile();
		logFiles.push(logFile);
		const stop = observeCompactionFailures(
			createReplaceableRuntime(harness.session),
			"volt-app",
			createDaemonLogger({ logPath: logFile.logPath }).child("compaction"),
		);

		await harness.session.compact();
		harness.setResponses([fauxAssistantMessage("third reply")]);
		await harness.session.prompt("private conversation text three");
		mode = "wait_for_abort";
		const cancelled = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();
		await expect(cancelled).rejects.toThrow("Compaction cancelled");
		stop();

		expect(harness.eventsOfType("compaction_end").map((event) => event.aborted)).toEqual([false, true]);
		expect(logFile.readLines()).toEqual([]);
	});

	it("follows session replacement and stops logging after disposal", async () => {
		const first = await createHarness();
		const second = await createHarness();
		harnesses.push(first, second);
		const logFile = createLogFile();
		logFiles.push(logFile);
		const runtime = createReplaceableRuntime(first.session);
		const stop = observeCompactionFailures(
			runtime,
			"volt-app",
			createDaemonLogger({ logPath: logFile.logPath }).child("compaction"),
		);

		runtime.replace(second.session);
		await expect(first.session.compact()).rejects.toThrow("Nothing to compact");
		await expect(second.session.compact()).rejects.toThrow("Nothing to compact");
		stop();
		await expect(second.session.compact()).rejects.toThrow("Nothing to compact");

		expect(logFile.readLines().map((line) => line.details.sessionId)).toEqual([second.session.sessionId]);
	});

	it("truncates long error messages", async () => {
		const harness = await createCompactableHarness();
		harnesses.push(harness);
		const logFile = createLogFile();
		logFiles.push(logFile);
		const stop = observeCompactionFailures(
			createReplaceableRuntime(harness.session),
			"volt-app",
			createDaemonLogger({ logPath: logFile.logPath }).child("compaction"),
		);

		harness.setResponses([summaryProviderError(`upstream error ${"x".repeat(2000)}`)]);
		await expect(harness.session.compact()).rejects.toThrow("upstream error");
		stop();

		const [line] = logFile.readLines();
		const error = String(line?.details.error);
		expect(error.length).toBe(503);
		expect(error.endsWith("...")).toBe(true);
	});
});
