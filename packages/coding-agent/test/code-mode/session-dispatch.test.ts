import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@hansjm10/volt-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { computeCodeModeBindings } from "../../src/core/code-mode/bindings.ts";
import { codeModeDispatchHostOf, createCodeModeCallHandler } from "../../src/core/code-mode/dispatch.ts";
import { CodeModeImageStore } from "../../src/core/code-mode/images.ts";
import { CodeModeCallError } from "../../src/core/code-mode/runtime.ts";
import type { AgentMode } from "../../src/core/planning.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import type { SessionToolRuntime } from "../../src/core/session/tool-runtime.ts";
import type { SessionTurnPolicy } from "../../src/core/session/turn-policy.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { testExtension } from "../utilities.ts";

interface SeenEvent {
	type: "tool_call" | "tool_result";
	toolName: string;
	toolCallId: string;
	origin: unknown;
}

type SessionInternals = {
	_tools: SessionToolRuntime;
	_turnPolicy: SessionTurnPolicy;
	_planning: { hasResearch(): boolean };
};

describe("code mode call dispatch in a session", () => {
	let tempDir: string;
	let agentDir: string;
	const sessions: AgentSession[] = [];
	let seen: SeenEvent[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-code-mode-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(tempDir, "notes.txt"), "first\nsecond");
		seen = [];
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			session.dispose();
			await session.waitForClosed();
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** A session with an extension that records tool hooks and blocks bash commands that mention "forbidden". */
	async function createSession(agentMode: AgentMode): Promise<AgentSession> {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-api-key");
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				testExtension("recorder", (volt) => {
					volt.on("tool_call", (event) => {
						seen.push({
							type: "tool_call",
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							origin: event.origin,
						});
						const command = (event.input as { command?: unknown }).command;
						if (event.toolName === "bash" && typeof command === "string" && command.includes("forbidden")) {
							return { block: true, reason: "forbidden command" };
						}
						return undefined;
					});
					volt.on("tool_result", (event) => {
						seen.push({
							type: "tool_result",
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							origin: event.origin,
						});
						return undefined;
					});
				}),
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			authStorage,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
			agentMode,
		});
		sessions.push(session);
		return session;
	}

	/** Calls a tool binding the way a script running in `session` would, from the code-mode call `run-1`. */
	function scriptCalls(session: AgentSession) {
		const internals = session as unknown as SessionInternals;
		const handle = createCodeModeCallHandler({
			host: codeModeDispatchHostOf(internals._tools, internals._turnPolicy, tempDir),
			bindings: computeCodeModeBindings(internals._tools.codeModeBindingSources()),
			parentToolCallId: "run-1",
		});
		let seq = 0;
		return (toolName: string, args: Record<string, unknown>) =>
			handle({
				seq: ++seq,
				binding: JSON.stringify([toolName]),
				args,
				signal: new AbortController().signal,
				images: new CodeModeImageStore().stage(),
				maxValueBytes: 1024 * 1024,
			});
	}

	async function rejection(promise: Promise<unknown>): Promise<CodeModeCallError> {
		try {
			await promise;
		} catch (error) {
			if (error instanceof CodeModeCallError) return error;
			throw error;
		}
		throw new Error("expected the call to reject");
	}

	it("passes a nested call through the session's hooks with its call ID and code mode origin", async () => {
		const call = scriptCalls(await createSession("build"));
		expect(await call("read", { path: "notes.txt" })).toBe("first\nsecond");
		const origin = { kind: "code_mode", parentToolCallId: "run-1", seq: 1 };
		expect(seen).toStrictEqual([
			{ type: "tool_call", toolName: "read", toolCallId: "run-1:cm:1", origin },
			{ type: "tool_result", toolName: "read", toolCallId: "run-1:cm:1", origin },
		]);
	});

	it("rejects a nested call an extension hook blocks, without running it", async () => {
		const call = scriptCalls(await createSession("build"));
		const blocked = await rejection(call("bash", { command: "echo forbidden" }));
		expect(blocked).toMatchObject({ kind: "blocked", message: "forbidden command" });
		expect(seen.map((event) => event.type)).toStrictEqual(["tool_call"]);
	});

	it("rejects background jobs and kills a silent nested command instead of moving it to the background", async () => {
		const call = scriptCalls(await createSession("build"));
		expect(await rejection(call("bash", { command: "echo hi", background: true }))).toMatchObject({
			kind: "invalid_arguments",
			message: "Scripts cannot start background jobs",
		});
		// With jobs active, a model-issued call would move this command to a job after a second of silence.
		const silent = await rejection(call("bash", { command: "sleep 5", stallTimeout: 1 }));
		expect(silent.kind).toBe("failed");
		expect(silent.message).toMatch(/killed as hung/);
	}, 20_000);

	it("authorizes each nested call under Plan mode and counts nested reads as research", async () => {
		const session = await createSession("plan");
		const internals = session as unknown as SessionInternals;
		const call = scriptCalls(session);
		const rename = await rejection(
			call("lsp", { action: "rename", path: "notes.txt", symbol: "first", newName: "x" }),
		);
		expect(rename.kind).toBe("blocked");
		expect(rename.message).toMatch(/research capability profile blocked lsp/);
		expect(internals._planning.hasResearch()).toBe(false);
		expect(await call("read", { path: "notes.txt" })).toBe("first\nsecond");
		expect(internals._planning.hasResearch()).toBe(true);
	});
});
