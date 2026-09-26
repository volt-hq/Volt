import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { LspServerPool } from "../../../src/core/lsp/server-pool.ts";
import type { Settings } from "../../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const FAKE_SERVER = join(__dirname, "../../fixtures/fake-lsp-server.mjs");
const harnesses: Harness[] = [];
const roots: string[] = [];

function serverEvents(eventLog: string, type: "started" | "exited"): number[] {
	if (!existsSync(eventLog)) return [];
	return readFileSync(eventLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; pid: number })
		.filter((event) => event.type === type)
		.map((event) => event.pid);
}

function lspSettings(eventLog: string, broken = false): Partial<Settings> {
	return {
		lsp: {
			enabled: true,
			settleMs: 3000,
			idleShutdownMs: 0,
			servers: {
				typescript: { enabled: false },
				python: { enabled: false },
				go: { enabled: false },
				rust: { enabled: false },
				fake: {
					command: [process.execPath, FAKE_SERVER, "--event-log", eventLog],
					fileExtensions: [".foo"],
					rootMarkers: [],
				},
				...(broken
					? {
							broken: {
								command: [process.execPath, FAKE_SERVER, "--init-error"],
								fileExtensions: [".bar"],
								rootMarkers: [],
							},
						}
					: {}),
			},
		},
	};
}

async function writeWithDiagnostics(harness: Harness, path: string): Promise<string> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path, content: "has ERROR\n" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt(`Write ${path}`);
	const result = harness.session.messages.findLast(
		(message) => message.role === "toolResult" && message.toolName === "write",
	);
	if (result?.role !== "toolResult") throw new Error("write tool did not run");
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

afterEach(async () => {
	for (const harness of harnesses.splice(0).reverse()) harness.cleanup();
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
	);
});

describe("Regression #47: one language server set per project within a delegation tree", () => {
	it("shares servers between a session and its subagent and keeps them across reload", async () => {
		const project = realpathSync(mkdtempSync(join(tmpdir(), "volt-47-")));
		roots.push(project);
		const eventLog = join(project, "events.jsonl");
		const lspServerPool = new LspServerPool();
		const options = { settings: lspSettings(eventLog), projectCwd: project, lspServerPool };
		const parent = await createHarness(options);
		harnesses.push(parent);
		const subagent = await createHarness(options);
		harnesses.push(subagent);

		expect(await writeWithDiagnostics(parent, join(project, "parent.foo"))).toContain("found ERROR on line 1");
		expect(await writeWithDiagnostics(subagent, join(project, "subagent.foo"))).toContain("found ERROR on line 1");
		const started = serverEvents(eventLog, "started");
		expect(started).toHaveLength(1);

		// Reload with unchanged server settings keeps the shared server process: the
		// reloaded session's new LSP view sees the same live server.
		await parent.session.reload();
		expect(parent.session.getLspStatus().servers.find((entry) => entry.name === "fake")).toMatchObject({
			alive: true,
			state: "ready",
		});
		expect(await writeWithDiagnostics(subagent, join(project, "after-reload.foo"))).toContain(
			"found ERROR on line 1",
		);
		expect(serverEvents(eventLog, "started")).toEqual(started);
		expect(serverEvents(eventLog, "exited")).toEqual([]);

		// The server outlives the subagent and stops with the last session using it.
		harnesses.splice(harnesses.indexOf(subagent), 1);
		subagent.cleanup();
		expect(parent.session.getLspStatus().servers.find((entry) => entry.name === "fake")?.alive).toBe(true);
		harnesses.splice(harnesses.indexOf(parent), 1);
		parent.cleanup();
		await expect.poll(() => serverEvents(eventLog, "exited")).toEqual(started);
	});

	it("keeps a lone session's healthy servers across reload and clears failed starts", async () => {
		const project = realpathSync(mkdtempSync(join(tmpdir(), "volt-47-")));
		roots.push(project);
		const eventLog = join(project, "events.jsonl");
		const session = await createHarness({
			settings: lspSettings(eventLog, true),
			projectCwd: project,
			lspServerPool: new LspServerPool(),
		});
		harnesses.push(session);
		const status = (name: string) => session.session.getLspStatus().servers.find((entry) => entry.name === name);

		expect(await writeWithDiagnostics(session, join(project, "a.foo"))).toContain("found ERROR on line 1");
		for (const name of ["one", "two", "three"]) await writeWithDiagnostics(session, join(project, `${name}.bar`));
		expect(status("broken")?.breaker).toBe("open");

		await session.session.reload();

		expect(status("fake")?.alive).toBe(true);
		expect(status("broken")?.breaker).toBe("closed");
		expect(serverEvents(eventLog, "started")).toHaveLength(1);
		expect(serverEvents(eventLog, "exited")).toEqual([]);
	});
});
