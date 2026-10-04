import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectedEntry } from "@hansjm10/volt-protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type RpcProcessClient, spawnRpcClient } from "../src/client/protocol-client.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The texts of the transcript views of `role` the client holds. */
function texts(entries: readonly ProjectedEntry[], role: "user" | "assistant" | "tool"): string[] {
	return entries.flatMap((entry) => (entry.type === "message" && entry.view?.role === role ? [entry.view.text] : []));
}

/**
 * RPC mode over stdio against a real provider: protocol frames end to end.
 */
describe.skipIf(!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_OAUTH_TOKEN)("RPC mode", () => {
	let client: RpcProcessClient | undefined;
	let sessionDir: string;

	beforeEach(() => {
		sessionDir = join(tmpdir(), `volt-rpc-test-${Date.now()}`);
	});

	afterEach(async () => {
		await client?.stop();
		client = undefined;
		if (sessionDir && existsSync(sessionDir)) {
			rmSync(sessionDir, { recursive: true });
		}
	});

	async function start(): Promise<RpcProcessClient> {
		client = await spawnRpcClient({
			cliPath: join(__dirname, "..", "dist", "cli.js"),
			cwd: join(__dirname, ".."),
			env: { VOLT_CODING_AGENT_DIR: sessionDir },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
		return client;
	}

	async function readPersistedEntries(): Promise<SessionEntry[]> {
		const sessionsPath = join(sessionDir, "sessions");
		expect(existsSync(sessionsPath)).toBe(true);
		const sessionDirs = readdirSync(sessionsPath);
		expect(sessionDirs.length).toBeGreaterThan(0);
		const cwdSessionDir = join(sessionsPath, sessionDirs[0]);
		const sessions = await SessionManager.list(join(__dirname, ".."), cwdSessionDir);
		expect(sessions).toHaveLength(1);
		return (await SessionManager.open(sessions[0]!.ref)).getEntries();
	}

	test("subscribes from a snapshot and serves the model and the live phase", async () => {
		const rpc = await start();
		expect(rpc.state.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(rpc.phase?.busy).toBe(false);
		expect(rpc.state.entries.filter((entry) => entry.type === "message")).toHaveLength(0);
	}, 30000);

	test("should save messages to session file", async () => {
		const rpc = await start();
		await rpc.promptAndWait("Reply with just the word 'hello'");
		expect(texts(rpc.state.entries, "user")).toEqual(["Reply with just the word 'hello'"]);
		expect(texts(rpc.state.entries, "assistant").length).toBeGreaterThanOrEqual(1);

		const entries = await readPersistedEntries();
		const roles = entries.flatMap((entry) => (entry.type === "message" ? [entry.message.role] : []));
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
	}, 90000);

	test("should handle manual compaction", async () => {
		const rpc = await start();
		await rpc.promptAndWait("Say hello");
		const accepted = await rpc.intent("compact", {});
		expect(accepted.result).toMatchObject({ summary: expect.any(String) });
		await rpc.waitForIdle();
		expect(rpc.state.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
		const entries = await readPersistedEntries();
		expect(entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
	}, 120000);

	test("should execute bash command and add its output to the context", async () => {
		const rpc = await start();
		const uniqueValue = `unique-${Date.now()}`;
		const accepted = await rpc.intent("bash", { command: `echo ${uniqueValue}` });
		expect(accepted.result).toMatchObject({ exitCode: 0, cancelled: false });
		expect(accepted.result?.output.trim()).toBe(uniqueValue);

		await rpc.promptAndWait(
			"What was the exact output of the echo command I just ran? Reply with just the value, nothing else.",
		);
		expect(texts(rpc.state.entries, "assistant").at(-1)).toContain(uniqueValue);
	}, 90000);

	test("should set the thinking level", async () => {
		const rpc = await start();
		await rpc.intent("set_thinking_level", { level: "high" });
		await rpc.waitForIdle();
		expect(rpc.state.thinkingLevel).toBe("high");
	}, 30000);

	test("should list models", async () => {
		const rpc = await start();
		const { models } = await rpc.query("models");
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.provider).toBeDefined();
			expect(model.id).toBeDefined();
		}
	}, 30000);

	test("should report usage in the live state", async () => {
		const rpc = await start();
		await rpc.promptAndWait("Hello");
		const usage = rpc.live.values.get("usage");
		expect(usage?.kind === "usage" && usage.tokens.total).toBeGreaterThan(0);
	}, 90000);

	test("should move to a new session", async () => {
		const rpc = await start();
		await rpc.promptAndWait("Hello");
		const first = rpc.conversation;
		const accepted = await rpc.intent("new_session", {});
		expect(accepted.conversation).toBeDefined();
		await expect.poll(() => rpc.conversation).toBe(accepted.conversation);
		await rpc.caughtUp();
		expect(rpc.conversation).not.toBe(first);
		expect(rpc.state.entries.filter((entry) => entry.type === "message")).toHaveLength(0);
	}, 90000);

	test("should export to HTML", async () => {
		const rpc = await start();
		await rpc.promptAndWait("Hello");
		const accepted = await rpc.intent("export_html", {});
		expect(accepted.result?.path.endsWith(".html")).toBe(true);
		expect(existsSync(accepted.result!.path)).toBe(true);
	}, 90000);

	test("should set the session name", async () => {
		const rpc = await start();
		expect(rpc.state.name).toBeNull();
		await rpc.promptAndWait("Reply with just 'ok'");
		await rpc.intent("set_session_name", { name: "my-test-session" });
		await expect.poll(() => rpc.state.name).toBe("my-test-session");
		const entries = await readPersistedEntries();
		const names = entries.flatMap((entry) => (entry.type === "session_info" ? [entry.name] : []));
		expect(names).toEqual(["my-test-session"]);
	}, 60000);
});
