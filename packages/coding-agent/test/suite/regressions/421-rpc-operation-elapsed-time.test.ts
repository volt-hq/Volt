import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient, type LoopbackClient } from "../../../src/client/protocol-client.ts";
import { adoptTestSession, connectTestClient, type TestHost } from "../../utilities/host-client.ts";
import { createHarness, type Harness } from "../harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const harnesses: Harness[] = [];
const hosts: TestHost[] = [];
const clients: LoopbackClient[] = [];
const releases: Array<() => void> = [];

/** A protocol client of the conversation; the host keeps the conversation open between clients. */
async function connect(target: TestHost): Promise<LoopbackClient> {
	const client = await createLoopbackClient(target.host, target.conversation, { anchor: false });
	clients.push(client);
	return client;
}

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	vi.useRealTimers();
	for (const client of clients.splice(0)) await client.stop();
	for (const target of hosts.splice(0)) await target.host.dispose();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	vi.restoreAllMocks();
});

describe("#421 authoritative timing on reconnect", () => {
	it.each(["compaction", "retry"] as const)(
		"restores the operation's start time during %s and after continuation",
		async (kind) => {
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const recovery = deferred();
			const releaseRecovery = deferred();
			const continued = deferred();
			const releaseContinuation = deferred();
			releases.push(releaseRecovery.resolve, releaseContinuation.resolve);
			const harness = await createHarness({
				tools: [],
				settings: {
					lsp: { enabled: false },
					compaction: { enabled: kind === "compaction", keepRecentTokens: 1 },
					retry: { enabled: kind === "retry", maxRetries: 1, baseDelayMs: 60_000 },
				},
				extensionFactories: [
					(volt) => {
						volt.on("session_before_compact", async (event) => {
							recovery.resolve();
							await releaseRecovery.promise;
							return {
								compaction: {
									summary: "Continue",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			harnesses.push(harness);
			await harness.session.setSessionName("Reconnect timing regression");
			const target = adoptTestSession(
				harness.session,
				{
					cwd: harness.tempDir,
					projectCwd: harness.tempDir,
					lexicalProjectCwd: harness.tempDir,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
					resourceLoader: harness.session.resourceLoader,
					gitContextProvider: harness.session.gitContextProvider,
					releaseGitContextProvider: () => {},
					diagnostics: [],
				},
				async () => {
					throw new Error("No replacement expected");
				},
			);
			hosts.push(target);
			// The host keeps the conversation open between the reconnecting clients.
			await connectTestClient(target.host, target.conversation);
			const initial = await connect(target);
			harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") recovery.resolve();
			});
			harness.setResponses([
				() => {
					// The retry backoff is scheduled before the session observes auto_retry_start.
					if (kind === "retry") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
					return fauxAssistantMessage("", {
						stopReason: "error",
						error:
							kind === "compaction"
								? { kind: "context_overflow", retryable: false, message: "prompt is too long" }
								: { kind: "overloaded", retryable: true, message: "overloaded_error" },
					});
				},
				async () => {
					continued.resolve();
					await releaseContinuation.promise;
					return fauxAssistantMessage("recovered");
				},
			]);
			const prompt = harness.session.prompt("Keep the timer");
			await recovery.promise;
			const startedAt = harness.eventsOfType("agent_start")[0]!.startedAt;
			// The live phase carries the run's start; vi.waitFor would advance the faked retry backoff.
			await new Promise<void>((resolve) => {
				const done = () => {
					if (initial.phase?.run?.startedAt !== startedAt) return false;
					unsubscribe();
					resolve();
					return true;
				};
				const unsubscribe = initial.onChange(() => void done());
				done();
			});
			await initial.stop();
			now += 10_000;

			// A client that subscribes mid-operation reads the run's authoritative start from its live reset.
			const during = await connect(target);
			expect(during.phase).toMatchObject({ busy: true, run: { startedAt } });
			if (kind === "compaction") {
				expect(during.phase).toMatchObject({ compaction: { reason: "overflow" } });
				expect(during.phase?.retry).toBeUndefined();
			} else {
				expect(during.phase).toMatchObject({ retry: { attempt: 1, maxAttempts: 1 } });
				expect(during.phase?.compaction).toBeUndefined();
			}
			await during.stop();
			if (kind === "retry") {
				await vi.advanceTimersByTimeAsync(60_000);
				vi.useRealTimers();
			} else releaseRecovery.resolve();
			await continued.promise;

			// After the recovery the run continues under its original start.
			const after = await connect(target);
			expect(after.phase).toMatchObject({ busy: true, run: { startedAt } });
			expect(after.phase?.compaction).toBeUndefined();
			expect(harness.eventsOfType("agent_start").map((event) => event.startedAt)).toEqual([startedAt, startedAt]);
			releaseContinuation.resolve();
			await prompt;
			await vi.waitFor(() => expect(after.phase).toMatchObject({ busy: false }));
			expect(after.phase?.run).toBeUndefined();
			await after.stop();

			const settled = await connect(target);
			expect(settled.phase).toMatchObject({ busy: false });
			expect(settled.phase?.run).toBeUndefined();
		},
	);
});
