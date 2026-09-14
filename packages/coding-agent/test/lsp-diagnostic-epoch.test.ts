import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LspClient, type LspDiagnostic } from "../src/core/lsp/client.ts";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";

interface Message {
	id?: number;
	method: string;
	params?: { textDocument?: { uri: string } };
}

const roots: string[] = [];
const clients: LspClient[] = [];
const diagnostic: LspDiagnostic = {
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
	severity: 1,
	message: "Current dependency error",
};

async function fixture(pull = false, requestTimeoutMs = 100) {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const root = mkdtempSync(join(tmpdir(), "volt-lsp-epoch-"));
	roots.push(root);
	const a = join(root, "a.foo");
	const b = join(root, "b.foo");
	writeFileSync(a, "source\n");
	writeFileSync(b, "dependency\n");
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const events = new EventEmitter();
	const messages: Message[] = [];
	const sent = new EventEmitter();
	const child = Object.assign(events, {
		stdin,
		stdout,
		stderr,
		exitCode: null as number | null,
		signalCode: null,
		kill: (): boolean => {
			child.exitCode = 0;
			stderr.end();
			events.emit("exit", 0);
			events.emit("close", 0);
			return true;
		},
	});
	function send(message: object): void {
		const body = JSON.stringify({ jsonrpc: "2.0", ...message });
		stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}
	stdin.on("data", (chunk: Buffer) => {
		const message = JSON.parse(chunk.toString().split("\r\n\r\n")[1]) as Message;
		messages.push(message);
		sent.emit("message");
		if (message.method === "initialize") {
			send({ id: message.id, result: { capabilities: pull ? { diagnosticProvider: {} } : {} } });
		}
	});
	function waitForMessage(method: string, index = 0): Promise<Message> {
		return new Promise((resolve) => {
			const check = (): void => {
				const message = messages.filter((entry) => entry.method === method)[index];
				if (!message) return;
				sent.removeListener("message", check);
				resolve(message);
			};
			sent.on("message", check);
			check();
		});
	}
	const client = new LspClient({
		serverName: "fixture",
		rootDir: root,
		command: ["fixture"],
		requestTimeoutMs,
		serverSpawner: () => child as unknown as ChildProcess,
	});
	clients.push(client);
	await client.start();
	return {
		client,
		a,
		b,
		send,
		waitForMessage,
		publish(path: string, diagnostics = [diagnostic], version: number | null = 1): void {
			send({
				method: "textDocument/publishDiagnostics",
				params: { uri: pathToFileURL(path).toString(), diagnostics, version: version ?? undefined },
			});
		},
		async begin(signal?: AbortSignal, firstSettleMs = 1000) {
			const openCount = messages.filter((entry) => entry.method === "textDocument/didOpen").length;
			const pending = withFileMutationQueue(a, () =>
				client.getDiagnostics(a, "source\n", 1000, firstSettleMs, signal),
			);
			await waitForMessage("textDocument/didOpen", openCount);
			// The notification is synchronous inside syncContent. Let its caller
			// finish awaiting it and enter collection before performing another sync.
			await setImmediate();
			return { pending };
		},
	};
}

afterEach(() => {
	for (const client of clients.splice(0)) client.dispose();
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("diagnostics recover after client-wide synchronization", () => {
	it.each(["open", "change"])("accepts A's current publication after a concurrent %s of B", async (operation) => {
		const f = await fixture();
		if (operation === "change") await f.client.openDocument(f.b, "dependency\n");
		const { pending } = await f.begin();
		await withFileMutationQueue(f.b, () => f.client.openDocument(f.b, "changed dependency\n"));
		f.publish(f.a);
		expect(await pending).toMatchObject({
			outcome: "success",
			source: "push",
			freshness: "fresh",
			diagnostics: [diagnostic],
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("collects both disjoint files sharing the client", async () => {
		const f = await fixture();
		const { pending: a } = await f.begin();
		const b = withFileMutationQueue(f.b, () => f.client.getDiagnostics(f.b, "dependency\n", 1000));
		await f.waitForMessage("textDocument/didOpen", 1);
		await setImmediate();
		f.publish(f.a);
		f.publish(f.b, []);
		expect(await a).toMatchObject({ outcome: "success", diagnostics: [diagnostic] });
		expect(await b).toMatchObject({ outcome: "empty", freshness: "fresh", diagnostics: [] });
	});

	it("does not reuse a publication invalidated during its unversioned grace window", async () => {
		const f = await fixture();
		const { pending } = await f.begin();
		f.publish(f.a, [diagnostic], null);
		await vi.advanceTimersByTimeAsync(0);
		await f.client.openDocument(f.b, "dependency\n");
		let completed = false;
		void pending.then(() => {
			completed = true;
		});
		await vi.advanceTimersByTimeAsync(250);
		expect(completed).toBe(false);
		f.publish(f.a, []);
		expect(await pending).toMatchObject({ outcome: "empty", freshness: "fresh", diagnostics: [] });
	});

	it("times out rather than returning a stale dependency publication", async () => {
		const f = await fixture();
		const { pending } = await f.begin();
		f.publish(f.a, [diagnostic], null);
		await vi.advanceTimersByTimeAsync(0);
		await f.client.openDocument(f.b, "dependency\n");
		await vi.advanceTimersByTimeAsync(1000);
		expect(await pending).toMatchObject({ outcome: "timeout", freshness: "stale", diagnostics: [] });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps unversioned publications unverified and gives recovery its grace window", async () => {
		const f = await fixture();
		const { pending } = await f.begin();
		await f.client.openDocument(f.b, "dependency\n");
		f.publish(f.a, [diagnostic], null);
		let completed = false;
		void pending.then(() => {
			completed = true;
		});
		await vi.advanceTimersByTimeAsync(249);
		expect(completed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await pending).toMatchObject({ outcome: "success", freshness: "unverified", diagnostics: [diagnostic] });
	});

	it("rejects wrong document versions after recovery", async () => {
		const f = await fixture();
		const { pending } = await f.begin();
		await f.client.openDocument(f.b, "dependency\n");
		f.publish(f.a, [diagnostic], 0);
		f.publish(f.a, [diagnostic], 2);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await pending).toMatchObject({ outcome: "timeout", diagnostics: [] });
	});

	it.each([false, true])("never recovers using replacement content (pull=%s)", async (pull) => {
		const f = await fixture(pull);
		const { pending } = await f.begin();
		await f.client.openDocument(f.a, "replacement\n");
		if (pull) {
			const request = await f.waitForMessage("textDocument/diagnostic");
			f.send({ id: request.id, result: { kind: "full", items: [diagnostic] } });
		}
		f.publish(f.a, [diagnostic], 2);
		expect(await pending).toMatchObject({ outcome: "timeout", diagnostics: [] });
	});

	it.each(["cancel", "exit"])("honors %s while recovering", async (termination) => {
		const f = await fixture();
		const controller = new AbortController();
		const { pending } = await f.begin(controller.signal);
		f.publish(f.a, [diagnostic], null);
		await vi.advanceTimersByTimeAsync(0);
		await f.client.openDocument(f.b, "dependency\n");
		await vi.advanceTimersByTimeAsync(250);
		if (termination === "cancel") controller.abort();
		else f.client.dispose();
		expect(await pending).toMatchObject({
			outcome: termination === "cancel" ? "cancelled" : "unavailable",
			diagnostics: [],
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([1000, 1500])("does not reset the %sms deadline under repeated epoch changes", async (budget) => {
		const f = await fixture();
		const { pending } = await f.begin(undefined, budget);
		let completed = false;
		void pending.then(() => {
			completed = true;
		});
		for (let elapsed = 0; elapsed < budget; elapsed += 100) {
			await f.client.openDocument(f.b, `dependency ${elapsed}\n`);
			f.publish(f.a, [diagnostic], null);
			await vi.advanceTimersByTimeAsync(100);
			if (elapsed + 100 < budget) expect(completed).toBe(false);
		}
		expect(completed).toBe(true);
		expect(await pending).toMatchObject({ outcome: "success", freshness: "unverified" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reissues superseded pulls against the latest epoch", async () => {
		const f = await fixture(true);
		const { pending } = await f.begin();
		for (let index = 0; index < 3; index++) {
			const request = await f.waitForMessage("textDocument/diagnostic", index);
			await f.client.openDocument(f.b, `dependency ${index}\n`);
			f.send({ id: request.id, result: { kind: "full", items: [] } });
		}
		const current = await f.waitForMessage("textDocument/diagnostic", 3);
		f.send({ id: current.id, result: { kind: "full", items: [diagnostic] } });
		expect(await pending).toMatchObject({
			outcome: "success",
			source: "pull",
			freshness: "fresh",
			diagnostics: [diagnostic],
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("caps pull retries at the original two-request budget", async () => {
		const f = await fixture(true, 100);
		const { pending } = await f.begin();
		for (let index = 0; index < 4; index++) {
			const request = await f.waitForMessage("textDocument/diagnostic", index);
			await vi.advanceTimersByTimeAsync(40);
			await f.client.openDocument(f.b, `dependency ${index}\n`);
			f.send({ id: request.id, result: { kind: "full", items: [] } });
		}
		await f.waitForMessage("textDocument/diagnostic", 4);
		await vi.advanceTimersByTimeAsync(40);
		expect(await pending).toMatchObject({ outcome: "timeout", reason: "request-deadline", diagnostics: [] });
		expect(vi.getTimerCount()).toBe(0);
	});
});
