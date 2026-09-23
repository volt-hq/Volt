import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspDiagnostic } from "../src/core/lsp/client.ts";
import { LspManager } from "../src/core/lsp/manager.ts";
import * as childProcess from "../src/utils/child-process.ts";

const diagnostic: LspDiagnostic = {
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
	severity: 1,
	message: "Existing error in A",
};
const roots: string[] = [];
const managers: LspManager[] = [];

interface Message {
	id?: number;
	method: string;
	params?: {
		textDocument?: { uri: string; version: number };
		context?: { diagnostics: LspDiagnostic[] };
	};
}

function fixture(maxSeverity = 1, pull = false) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-lsp-baseline-")));
	roots.push(root);
	const a = join(root, "a.foo");
	const b = join(root, "b.foo");
	writeFileSync(a, "value A\n");
	writeFileSync(b, "value B\n");
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const events = new EventEmitter();
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
	vi.spyOn(childProcess, "spawnProcess").mockReturnValue(child as unknown as ChildProcess);
	const versions = new Map<string, number>();
	const messages: Message[] = [];
	let afterChange = (): void => {};
	let publishOwn = true;
	function send(message: object): void {
		const body = JSON.stringify({ jsonrpc: "2.0", ...message });
		stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}
	function publish(path: string, diagnostics: LspDiagnostic[], versioned = true): void {
		const uri = pathToFileURL(path).toString();
		send({
			method: "textDocument/publishDiagnostics",
			params: { uri, diagnostics, ...(versioned ? { version: versions.get(uri) } : {}) },
		});
	}
	// Publications are explicitly controlled, not automatic on every open.
	// This models servers that do not republish A merely because B was opened.
	stdin.on("data", (chunk: Buffer) => {
		const message = JSON.parse(chunk.toString().split("\r\n\r\n")[1]) as Message;
		messages.push(message);
		const document = message.params?.textDocument;
		if (message.method === "initialize") {
			send({
				id: message.id,
				result: {
					capabilities: {
						hoverProvider: true,
						codeActionProvider: true,
						...(pull ? { diagnosticProvider: {} } : {}),
					},
				},
			});
		} else if (message.method === "textDocument/hover") {
			send({ id: message.id, result: { contents: "Ready" } });
		} else if (message.method === "textDocument/didOpen" && document) {
			versions.set(document.uri, document.version);
		} else if (message.method === "textDocument/didChange" && document) {
			versions.set(document.uri, document.version);
			if (publishOwn) publish(b, []);
			afterChange();
		} else if (message.method === "textDocument/diagnostic") {
			send({ id: message.id, result: { kind: "full", items: [diagnostic] } });
		} else if (message.method === "textDocument/codeAction") {
			send({ id: message.id, result: [] });
		}
	});
	const manager = new LspManager({
		cwd: root,
		config: {
			enabled: true,
			autoDiagnostics: true,
			settleMs: 0,
			firstSettleMs: 0,
			idleShutdownMs: 0,
			maxSeverity,
			maxDiagnostics: 20,
			servers: [{ name: "fixture", command: [process.execPath], fileExtensions: [".foo"], rootMarkers: [] }],
		},
	});
	managers.push(manager);
	return {
		manager,
		a,
		b,
		messages,
		publish,
		async open(path: string): Promise<void> {
			expect(await manager.hover(path, "value")).toMatchObject({ outcome: "success", text: "Ready" });
		},
		async editB(onChange: () => void, content = "value B changed\n", publishEdited = true) {
			afterChange = onChange;
			publishOwn = publishEdited;
			writeFileSync(b, content);
			return manager.getDiagnostics(b, content);
		},
	};
}

afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cross-file diagnostics require a known clean baseline", () => {
	for (const versioned of [true, false]) {
		describe(versioned ? "versioned publications" : "unversioned publications", () => {
			it.each(["errors", "clean", "never-published"])(
				"does not report an unknown %s baseline as newly failing",
				async (baseline) => {
					const f = fixture();
					await f.open(f.a);
					if (baseline !== "never-published") f.publish(f.a, baseline === "errors" ? [diagnostic] : [], versioned);
					await f.open(f.b); // Invalidates A's publication before the next collection.
					const result = await f.editB(() => f.publish(f.a, [diagnostic], versioned));
					expect(result).toMatchObject({ outcome: "empty", text: "" });
				},
			);

			it.each([
				{ label: "clean", before: [], maxSeverity: 1, newlyFailing: true },
				{ label: "errors", before: [diagnostic], maxSeverity: 1, newlyFailing: false },
				{
					label: "filtered warnings",
					before: [{ ...diagnostic, severity: 2 }],
					maxSeverity: 1,
					newlyFailing: true,
				},
				{
					label: "reportable warnings",
					before: [{ ...diagnostic, severity: 2 }],
					maxSeverity: 2,
					newlyFailing: false,
				},
				{
					label: "missing severity",
					before: [{ ...diagnostic, severity: undefined }],
					maxSeverity: 1,
					newlyFailing: false,
				},
			])("classifies a current $label baseline correctly", async ({ before, maxSeverity, newlyFailing }) => {
				const f = fixture(maxSeverity);
				await f.open(f.a);
				await f.open(f.b);
				f.publish(f.a, before, versioned);
				const result = await f.editB(() => f.publish(f.a, [diagnostic], versioned));
				if (newlyFailing) {
					expect(result.text).toContain("a.foo(1,1): error: Existing error in A");
					expect(result.text).toContain(versioned ? "Diagnostics (fresh)" : "freshness: unverified");
				} else {
					expect(result.text).toBe("");
				}
			});
		});
	}

	it.each([true, false])(
		"preserves new cross-file errors after repeated timeouts (versioned=%s)",
		async (versioned) => {
			const f = fixture();
			await f.open(f.a);
			await f.open(f.b);
			const first = await f.editB(() => f.publish(f.a, [], versioned), "value B first\n", false);
			expect(first).toMatchObject({ outcome: "timeout", reason: "no-current-publication" });
			expect(first.text).toContain("Diagnostics not verified");

			const repeated = await f.editB(() => f.publish(f.a, [], versioned), "value B second\n", false);
			expect(repeated).toMatchObject({ outcome: "timeout", reason: "no-current-publication", text: "" });

			const newlyFailing = await f.editB(() => f.publish(f.a, [diagnostic], versioned), "value B third\n", false);
			expect(newlyFailing).toMatchObject({
				outcome: "timeout",
				reason: "no-current-publication",
				diagnosticCount: 0,
				text: expect.stringContaining("a.foo(1,1): error: Existing error in A"),
			});

			const stillFailing = await f.editB(() => f.publish(f.a, [diagnostic], versioned), "value B fourth\n", false);
			expect(stillFailing.text).toBe("");
			// Recovery resets warning suppression, without relabeling earlier timeouts as success.
			const recovered = await f.editB(() => f.publish(f.a, [], versioned), "value B recovered\n");
			expect(recovered.outcome).toBe("empty");
			expect(recovered.text).toEqual(versioned ? expect.stringContaining("no longer reported") : "");
			const nextTimeout = await f.editB(() => f.publish(f.a, [], versioned), "value B timeout\n", false);
			expect(nextTimeout.outcome).toBe("timeout");
			expect(nextTimeout.text).toContain("Diagnostics not verified");
		},
	);

	it("requires a new clean publication before a previously unknown file can become newly failing", async () => {
		const f = fixture();
		await f.open(f.a);
		f.publish(f.a, [diagnostic]);
		await f.open(f.b);
		expect((await f.editB(() => f.publish(f.a, [diagnostic]))).text).toBe("");
		// The republished errors are now current, but still not a clean baseline.
		expect((await f.editB(() => f.publish(f.a, [diagnostic]), "value B again\n")).text).toBe("");
		f.publish(f.a, []);
		expect((await f.editB(() => f.publish(f.a, [diagnostic]), "value B final\n")).text).toContain("Newly failing");
	});

	it.each(["missing", "clean", "filtered"])("does not report a %s post-edit publication as failing", async (after) => {
		const f = fixture();
		await f.open(f.a);
		await f.open(f.b);
		f.publish(f.a, []);
		const result = await f.editB(() => {
			if (after !== "missing") f.publish(f.a, after === "clean" ? [] : [{ ...diagnostic, severity: 2 }]);
		});
		expect(result).toMatchObject({ outcome: "empty", text: "" });
	});

	it("excludes the edited file from the cross-file report", async () => {
		const f = fixture();
		await f.open(f.b);
		f.publish(f.b, []);
		const result = await f.editB(() => f.publish(f.b, [{ ...diagnostic, message: "New error in B" }]));
		expect(result).toMatchObject({
			outcome: "success",
			text: "Diagnostics (fresh):\nb.foo(1,1): error: New error in B",
		});
	});

	it("reports only known clean files when the baseline mixes current and stale evidence", async () => {
		const f = fixture();
		await f.open(f.a);
		f.publish(f.a, [diagnostic]);
		await f.open(f.b);
		const c = join(f.a, "..", "c.foo");
		writeFileSync(c, "value C\n");
		await f.open(c);
		f.publish(c, []);
		const result = await f.editB(() => {
			f.publish(f.a, [diagnostic]);
			f.publish(c, [{ ...diagnostic, message: "New error in C" }]);
		});
		expect(result.text).toBe(
			"Newly failing in other open files:\nDiagnostics (fresh):\nc.foo(1,1): error: New error in C",
		);
	});

	it.each([false, true])("code actions tolerate unknown diagnostics and collect context (pull=%s)", async (pull) => {
		const f = fixture(1, pull);
		await f.open(f.a);
		f.publish(f.a, [diagnostic]);
		await f.open(f.b);
		const result = await f.manager.codeFix(f.a, {});
		expect(result).toMatchObject({ outcome: "empty", text: "No code actions available at this position." });
		expect(
			f.messages.find((message) => message.method === "textDocument/codeAction")?.params?.context?.diagnostics,
		).toEqual(pull ? [diagnostic] : []);
	});
});
