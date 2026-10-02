import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { StreamFn } from "@hansjm10/volt-agent-core";
import {
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	getModels,
	type SimpleStreamOptions,
} from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPilotDirectory,
	getPilotSubscriptionKey,
	PILOT_CONDITIONS,
	parsePilotArgs,
	runPilotCase,
} from "../benchmarks/compaction-quality.ts";
import { createQualityFixtures } from "./compaction-quality/fixtures.ts";

const model = getModels("openai-codex").find((candidate) => candidate.id === "gpt-5.6-luna")!;
const directories: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function responseStream(message = fauxAssistantMessage("## Goal\nPreserve the task.")) {
	const stream = createAssistantMessageEventStream();
	if (message.stopReason === "error" || message.stopReason === "aborted")
		stream.push({ type: "error", seq: 1, reason: message.stopReason, error: message });
	else stream.push({ type: "done", seq: 1, reason: message.stopReason, message });
	return stream;
}

function captureStream(calls: Array<{ context: Context; options?: SimpleStreamOptions }>): StreamFn {
	return (_model, context, options) => {
		calls.push({ context: structuredClone(context), options });
		void options?.onPayload?.(
			{ model: _model.id, input: context.messages, reasoning: { effort: options.reasoning } },
			_model,
		);
		return responseStream();
	};
}

describe("compaction quality runner (offline injected streams only)", () => {
	it.each(
		createQualityFixtures().flatMap((fixture) =>
			PILOT_CONDITIONS.map((condition) => ({ fixture, condition, name: `${fixture.id}/${condition}` })),
		),
	)("runs $name with the original model and a validated retained boundary", async ({ fixture, condition }) => {
		const calls: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
		const result = await runPilotCase(fixture, condition, 1, {
			model,
			thinking: "low",
			streamFn: captureStream(calls),
		});
		expect(result.status).toBe("completed");
		expect(result.failure).toBeUndefined();
		expect(result.requests.length).toBeGreaterThan(0);
		expect(result.compactionCount).toBe(condition === "full" ? 0 : 1);
		expect(result.requests.every((request) => request.providerInvoked)).toBe(true);
		expect(result.requests.at(-1)).toMatchObject({
			stage: "continuation",
			reasoning: "low",
			requestedMaxTokens: 4096,
		});
		expect(result.continuation).toContain("Preserve the task");
		expect(result.score.complete).toBe(false);
		expect(result.score.assessments).toEqual([]);
		if (condition === "full") {
			expect(result.requests).toHaveLength(1);
			expect(result.summary).toBeUndefined();
			expect(result.actualSummaryStrategies).toEqual([]);
		} else {
			expect(result.summary).toContain("Preserve the task");
			expect(result.actualSummaryStrategies).toEqual(expect.arrayContaining([condition]));
		}
		for (const call of calls) {
			expect(call.options).toMatchObject({
				transport: "sse",
				cacheRetention: "short",
				inferenceSpeed: "standard",
				maxRetries: 0,
			});
			expect(call.context.tools ?? []).toEqual([]);
		}
	});

	it("does not send grader answers or persist credential-bearing options", async () => {
		const fixture = createQualityFixtures()[0];
		fixture.criteria[0].requirement = "GRADER_ONLY_ANSWER";
		const calls: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
		const result = await runPilotCase(fixture, "native", 1, {
			model,
			thinking: "low",
			streamFn: captureStream(calls),
			getApiKey: async () => "PRIVATE_OAUTH_ACCESS",
		});
		expect(result.status).toBe("completed");
		expect(calls.every((call) => call.options?.apiKey === "PRIVATE_OAUTH_ACCESS")).toBe(true);
		expect(JSON.stringify(calls.map((call) => call.context))).not.toContain("GRADER_ONLY_ANSWER");
		expect(JSON.stringify(result)).not.toContain("PRIVATE_OAUTH_ACCESS");
		expect(result.requests.every((request) => request.payloadJson)).toBe(true);
	});

	it("rebuilds native continuation from the summary and retained suffix, not discarded source", async () => {
		const fixture = createQualityFixtures()[0];
		const calls: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
		const result = await runPilotCase(fixture, "native", 1, {
			model,
			thinking: "low",
			streamFn: captureStream(calls),
		});
		expect(JSON.stringify(calls[0].context)).toContain("worker thread");
		expect(JSON.stringify(calls.at(-1)?.context)).not.toContain("worker thread");
		expect(calls.at(-1)?.context.messages).toHaveLength(3);
		expect(calls.at(-1)?.context.messages.at(-1)?.content).toBe(fixture.input.continuationPrompt);
		expect(result.requests.map((request) => request.stage)).toEqual(["summary", "continuation"]);
	});

	it("records actual fallback after a native provider overflow instead of mislabeling it native", async () => {
		let requests = 0;
		const result = await runPilotCase(createQualityFixtures()[0], "native", 1, {
			model,
			thinking: "low",
			streamFn: () => {
				requests++;
				return requests === 1
					? responseStream(
							fauxAssistantMessage("", {
								stopReason: "error",
								errorMessage: "Your input exceeds the context window of this model",
							}),
						)
					: responseStream();
			},
		});
		expect(result.status).toBe("completed");
		expect(result.actualSummaryStrategies).toEqual(["native", "chunked"]);
		expect(result.requests[0]).toMatchObject({ stopReason: "error", failure: "provider-error" });
		expect(result.requests[0].text).toBeUndefined();
	});

	it.each(["full", "native", "chunked-helper"] as const)(
		"records a failed %s attempt without leaking raw provider errors",
		async (condition) => {
			const result = await runPilotCase(createQualityFixtures()[0], condition, 1, {
				model,
				thinking: "low",
				streamFn: () =>
					responseStream(
						fauxAssistantMessage("PRIVATE_ERROR_CONTENT", {
							stopReason: "error",
							errorMessage: "PRIVATE_ACCESS_TOKEN",
						}),
					),
			});
			expect(result.status).toBe("failed");
			expect(result.requests).toHaveLength(1);
			expect(result.requests[0].failure).toBe("provider-error");
			expect(result.score.complete).toBe(false);
			expect(JSON.stringify(result)).not.toContain("PRIVATE_");
		},
	);

	it.each(
		[
			{ name: "aborted", message: fauxAssistantMessage("", { stopReason: "aborted" }), failure: "cancelled" },
			{ name: "empty", message: fauxAssistantMessage(""), failure: "empty" },
			{ name: "truncated", message: fauxAssistantMessage("partial", { stopReason: "length" }), failure: "length" },
			{ name: "overlong", message: fauxAssistantMessage("x".repeat(16_385)), failure: "length" },
			{
				name: "tool-calling",
				message: fauxAssistantMessage([fauxToolCall("bash", { command: "must-not-execute" })], {
					stopReason: "toolUse",
				}),
				failure: "tool-call",
			},
		].flatMap((item) => PILOT_CONDITIONS.map((condition) => ({ ...item, condition }))),
	)("rejects $name output in $condition without reporting completion", async ({ message, failure, condition }) => {
		const result = await runPilotCase(createQualityFixtures()[0], condition, 1, {
			model,
			thinking: "low",
			streamFn: () => responseStream(message),
		});
		expect(result.status).toBe("failed");
		expect(result.failure).toBe(failure);
		expect(result.requests[0].failure).toBe(failure);
		expect(result.continuation).toBeUndefined();
	});

	it("does not dispatch an already-cancelled case", async () => {
		const controller = new AbortController();
		controller.abort();
		const streamFn = vi.fn(() => responseStream());
		const result = await runPilotCase(createQualityFixtures()[0], "full", 1, {
			model,
			thinking: "low",
			streamFn,
			signal: controller.signal,
		});
		expect(result.failure).toBe("cancelled");
		expect(result.requests).toEqual([]);
		expect(streamFn).not.toHaveBeenCalled();
	});

	it.each(["provider", "credential"] as const)(
		"bounds an uncooperative %s and settles request accounting",
		async (stage) => {
			vi.useFakeTimers();
			const streamFn = vi.fn(() => createAssistantMessageEventStream());
			const promise = runPilotCase(createQualityFixtures()[0], "full", 1, {
				model,
				thinking: "low",
				streamFn,
				caseTimeoutMs: 10,
				...(stage === "credential" ? { getApiKey: () => new Promise<string>(() => {}) } : {}),
			});
			await vi.advanceTimersByTimeAsync(11);
			const result = await promise;
			expect(result.failure).toBe("timeout");
			expect(result.requests[0].failure).toBe("timeout");
			if (stage === "credential") expect(streamFn).not.toHaveBeenCalled();
			const snapshot = structuredClone(result);
			await vi.advanceTimersByTimeAsync(100);
			expect(result).toEqual(snapshot);
		},
	);

	it.each(["completed", "timeout"] as const)("ignores late payload callbacks after %s", async (terminal) => {
		vi.useFakeTimers();
		let onPayload: SimpleStreamOptions["onPayload"];
		const promise = runPilotCase(createQualityFixtures()[0], "full", 1, {
			model,
			thinking: "low",
			caseTimeoutMs: 10,
			streamFn: (_model, _context, options) => {
				onPayload = options?.onPayload;
				return terminal === "completed" ? responseStream() : createAssistantMessageEventStream();
			},
		});
		if (terminal === "timeout") await vi.advanceTimersByTimeAsync(11);
		const result = await promise;
		const snapshot = structuredClone(result);
		expect(onPayload).toBeTypeOf("function");
		await onPayload!({ input: "LATE_PAYLOAD" }, model);
		expect(result).toEqual(snapshot);
	});

	it("does not invoke a provider when subscription credentials expire", async () => {
		const streamFn = vi.fn(() => responseStream());
		const result = await runPilotCase(createQualityFixtures()[0], "full", 1, {
			model,
			thinking: "low",
			streamFn,
			getApiKey: async () =>
				getPilotSubscriptionKey({
					get: () => ({ type: "oauth", access: "private", refresh: "private-refresh", expires: 0 }),
				}),
		});
		expect(result.failure).toBe("auth-expired");
		expect(result.requests[0].providerInvoked).toBe(false);
		expect(streamFn).not.toHaveBeenCalled();
	});

	it("rejects a source window that cannot fit the full-context control", async () => {
		const streamFn = vi.fn(() => responseStream());
		const result = await runPilotCase(createQualityFixtures()[0], "full", 1, {
			model: { ...model, contextWindow: 100 },
			thinking: "low",
			streamFn,
		});
		expect(result.status).toBe("failed");
		expect(result.failure).toBe("context-unavailable");
		expect(streamFn).not.toHaveBeenCalled();
	});
});

describe("compaction quality pilot admission", () => {
	it("uses only an unexpired OAuth snapshot without refresh capability", () => {
		const credential = {
			type: "oauth" as const,
			access: "private-access",
			refresh: "private-refresh",
			expires: Date.now() + 60_000,
		};
		const get = vi.fn(() => credential);
		expect(getPilotSubscriptionKey({ get })).toBe("private-access");
		expect(get).toHaveBeenCalledWith("openai-codex");
		expect(() => getPilotSubscriptionKey({ get: () => ({ type: "api_key", key: "not-allowed" }) })).toThrow(
			"auth-unavailable",
		);
		expect(() => getPilotSubscriptionKey({ get: () => undefined })).toThrow("auth-unavailable");
		for (const expires of [0, NaN, Infinity]) {
			expect(() => getPilotSubscriptionKey({ get: () => ({ ...credential, expires }) })).toThrow("auth-expired");
		}
	});

	it("requires an explicit subscription model and low thinking", () => {
		const result = parsePilotArgs(["--model", "openai-codex/gpt-5.6-luna", "--thinking", "low"]);
		expect(result).toMatchObject({ modelId: "gpt-5.6-luna", thinking: "low", trials: 1 });
		expect(() => parsePilotArgs(["--model", "openai/gpt-5.6-luna", "--thinking", "low"])).toThrow("openai-codex");
		expect(() => parsePilotArgs(["--model", "openai-codex/gpt-5.6-sol", "--thinking", "low"])).toThrow(
			"gpt-5.6-luna",
		);
	});

	it.each(
		[
			[],
			["--model"],
			["--model", "openai-codex/gpt-5.6-luna"],
			["--model", "openai-codex/gpt-5.6-luna", "--thinking", "high"],
			["--model", "openai-codex/gpt-5.6-luna", "--thinking", "low", "--trials", "0"],
			["--model", "openai-codex/gpt-5.6-luna", "--thinking", "low", "--trials", "11"],
			["--model", "openai-codex/gpt-5.6-luna", "--thinking", "low", "--trials", "1.5"],
			["--model", "openai-codex/gpt-5.6-luna", "--thinking", "low", "--thinking", "low"],
			["--model", "openai-codex/gpt-5.6-luna", "--thinking", "low", "--api-key", "not-allowed"],
		].map((args) => ({ args })),
	)("rejects invalid arguments $args", ({ args }) => expect(() => parsePilotArgs(args)).toThrow());

	it("launches the source runtime offline without reading auth or creating run artifacts", async () => {
		const root = await mkdtemp(join(tmpdir(), "volt-pilot-launcher-test-"));
		directories.push(root);
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				fileURLToPath(new URL("../../../scripts/run-compaction-quality.mjs", import.meta.url)),
				"--model",
				"openai-codex/gpt-5.6-luna",
				"--thinking",
				"low",
				"--dry-run",
				"--out",
				join(root, "artifacts"),
				"--auth-file",
				join(root, "auth", "missing.json"),
			],
			{ cwd: root, timeout: 25_000 },
		);
		expect(JSON.parse(stdout.trim())).toEqual({
			runtime: "source",
			model: "openai-codex/gpt-5.6-luna",
			thinking: "low",
			providerEffort: "low",
			plannedCases: 36,
			networkRequests: 0,
		});
		expect(await readdir(root)).toEqual([]);
	});

	it.each(["finished", "timeout"] as const)(
		"supervises a worker with a stalled HTTP error body through %s",
		async (terminal) => {
			const root = await mkdtemp(join(tmpdir(), "volt-pilot-supervisor-test-"));
			directories.push(root);
			const worker = join(root, "worker.mjs");
			await writeFile(
				worker,
				`import { createServer } from "node:http";
import { waitForPilotOwner } from ${JSON.stringify(new URL("../../../scripts/run-compaction-quality.mjs", import.meta.url).href)};
await waitForPilotOwner();
const server = createServer((_request, response) => { response.writeHead(429); response.write("stalled error body"); });
server.listen(0, "127.0.0.1", async () => {
  const response = await fetch("http://127.0.0.1:" + server.address().port);
  void response.text();
  ${terminal === "finished" ? 'process.send({ type: "pilot-finished", exitCode: 0 });' : ""}
});\n`,
			);
			const driver = join(root, "driver.mjs");
			await writeFile(
				driver,
				`import { supervisePilot } from ${JSON.stringify(new URL("../../../scripts/run-compaction-quality.mjs", import.meta.url).href)};\nprocess.exitCode = await supervisePilot(process.argv[2], [], { timeoutMs: 3000, graceMs: 20 });\n`,
			);
			const operation = promisify(execFile)(process.execPath, [driver, worker], { timeout: 15_000 });
			if (terminal === "finished") await expect(operation).resolves.toMatchObject({ stderr: "" });
			else await expect(operation).rejects.toMatchObject({ code: 124 });
		},
	);

	it("does not admit startup after cancellation while the worker is loading", async () => {
		const root = await mkdtemp(join(tmpdir(), "volt-pilot-startup-test-"));
		directories.push(root);
		const launcherUrl = new URL("../../../scripts/run-compaction-quality.mjs", import.meta.url).href;
		const worker = join(root, "worker.mjs");
		await writeFile(
			worker,
			`import { waitForPilotOwner } from ${JSON.stringify(launcherUrl)};\nimport { writeFileSync } from "node:fs";\nawait new Promise(resolve => setTimeout(resolve, 100));\nawait waitForPilotOwner();\nwriteFileSync(${JSON.stringify(join(root, "admitted"))}, "unexpected");\n`,
		);
		const driver = join(root, "driver.mjs");
		await writeFile(
			driver,
			`import { supervisePilot } from ${JSON.stringify(launcherUrl)};\nprocess.exitCode = await supervisePilot(process.argv[2], [], { timeoutMs: 1, graceMs: 2000 });\n`,
		);
		await expect(promisify(execFile)(process.execPath, [driver, worker], { timeout: 15_000 })).rejects.toMatchObject({
			code: 124,
		});
		expect(await readdir(root)).not.toContain("admitted");
	});

	it("terminates a worker when its IPC owner disconnects", async () => {
		const root = await mkdtemp(join(tmpdir(), "volt-pilot-owner-test-"));
		directories.push(root);
		const launcherUrl = new URL("../../../scripts/run-compaction-quality.mjs", import.meta.url).href;
		const worker = join(root, "worker.mjs");
		await writeFile(
			worker,
			`import { waitForPilotOwner } from ${JSON.stringify(launcherUrl)};\nawait waitForPilotOwner();\nsetInterval(() => {}, 1000);\nprocess.send({ type: "active" });\n`,
		);
		const owner = join(root, "owner.mjs");
		await writeFile(
			owner,
			`import { fork } from "node:child_process";\nconst child = fork(process.argv[2], [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });\nchild.on("message", message => { if (message.type === "pilot-ready") child.send({ type: "pilot-start" }); else if (message.type === "active") child.disconnect(); });\nchild.on("exit", code => { process.exitCode = code === 130 ? 0 : 1; });\n`,
		);
		await expect(promisify(execFile)(process.execPath, [owner, worker], { timeout: 15_000 })).resolves.toMatchObject({
			stderr: "",
		});
	});

	it("creates only a fresh external directory and preserves existing artifacts", async () => {
		const root = await mkdtemp(join(tmpdir(), "volt-pilot-test-"));
		directories.push(root);
		const repo = join(root, "repo");
		await mkdir(repo);
		await expect(createPilotDirectory(join(repo, "artifacts"), repo)).rejects.toThrow("outside the repository");
		const out = join(root, "artifacts");
		await createPilotDirectory(out, repo);
		await writeFile(join(out, "existing.json"), "keep");
		await expect(createPilotDirectory(out, repo)).rejects.toThrow();
		expect(await readFile(join(out, "existing.json"), "utf8")).toBe("keep");
	});

	it("rejects a symlinked parent that points into the repository", async () => {
		const root = await mkdtemp(join(tmpdir(), "volt-pilot-test-"));
		directories.push(root);
		const repo = join(root, "repo");
		await mkdir(repo);
		const alias = join(root, "alias");
		await symlink(repo, alias, process.platform === "win32" ? "junction" : "dir");
		await expect(createPilotDirectory(join(alias, "artifacts"), repo)).rejects.toThrow("outside the repository");
	});
});
