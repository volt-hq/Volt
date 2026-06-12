// Regression for https://github.com/hansjm10/Volt/issues/1
//
// When two coordinated edits land in quick succession on files with a
// cross-file dependency, the server can publish diagnostics computed against
// the pre-edit content. If such a publish carries no version field (it is
// optional in LSP), it used to pass the stale-version guard, satisfy the
// settle wait, and get reported as the edit's diagnostics — describing an
// intermediate state that no longer exists.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLspConfig } from "../../../src/core/lsp/config.ts";
import { LspManager } from "../../../src/core/lsp/manager.ts";

const FAKE_SERVER = join(__dirname, "..", "..", "fixtures", "fake-lsp-server.mjs");

/** Remove a temp dir, retrying while a just-killed server process releases it (Windows). */
async function removeTempDir(dir: string): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	rmSync(dir, { recursive: true, force: true });
}

describe("stale cross-file LSP diagnostics (issue #1)", () => {
	let tempDir: string;
	let manager: LspManager | undefined;

	function setup(options: { serverArgs: string[]; settleMs?: number; firstSettleMs?: number }): LspManager {
		tempDir = mkdtempSync(join(tmpdir(), "volt-lsp-stale-test-"));
		manager = new LspManager({
			cwd: tempDir,
			config: resolveLspConfig({
				enabled: true,
				settleMs: options.settleMs ?? 3000,
				firstSettleMs: options.firstSettleMs,
				idleShutdownMs: 0,
				servers: {
					// Disable built-in defaults so the test never spawns real servers.
					typescript: { enabled: false },
					python: { enabled: false },
					go: { enabled: false },
					rust: { enabled: false },
					fake: {
						command: [process.execPath, FAKE_SERVER, ...options.serverArgs],
						fileExtensions: [".foo"],
						rootMarkers: [],
					},
				},
			}),
		});
		return manager;
	}

	afterEach(async () => {
		manager?.dispose();
		manager = undefined;
		if (tempDir) {
			await removeTempDir(tempDir);
		}
	});

	it("re-waits past an unversioned publish that races a content change", async () => {
		// The server immediately publishes a bogus unversioned result for the
		// old content after every didChange; the genuine (versioned) publish
		// follows after the publish delay. The bogus one must not be reported.
		const manager = setup({ serverArgs: ["--stale-unversioned"] });
		const filePath = join(tempDir, "test.foo");
		writeFileSync(filePath, "clean\n");
		expect(await manager.getDiagnostics(filePath, "clean\n")).toBeUndefined();

		const result = await manager.getDiagnostics(filePath, "still clean\n");
		expect(result).toBeUndefined();
	});

	it("drops unversioned publishes whose positions point past the synced content", async () => {
		// The bogus unversioned publish points at line 10000 of a two-line
		// document — it can only describe an older snapshot. The genuine
		// republish arrives after the settle window, so only the arrival-time
		// staleness check can prevent the bogus result from being reported.
		const manager = setup({
			serverArgs: ["--stale-oob", "--delay", "800"],
			settleMs: 300,
			firstSettleMs: 5000,
		});
		const filePath = join(tempDir, "test.foo");
		writeFileSync(filePath, "clean\n");
		expect(await manager.getDiagnostics(filePath, "clean\n")).toBeUndefined();

		const result = await manager.getDiagnostics(filePath, "still clean\n");
		expect(result).toBeUndefined();
	});

	it("does not report stale cross-file publishes as newly failing files", async () => {
		// Editing B makes the server publish a bogus unversioned out-of-bounds
		// result for A (computed against an older snapshot); A's genuine
		// republish never arrives within the settle window. The cross-file
		// "newly failing" sweep must not surface the stale snapshot.
		const manager = setup({ serverArgs: ["--stale-cross", "--delay", "200"] });
		const fileA = join(tempDir, "a.foo");
		const fileB = join(tempDir, "b.foo");
		writeFileSync(fileA, "alpha\n");
		writeFileSync(fileB, "beta\n");
		expect(await manager.getDiagnostics(fileA, "alpha\n")).toBeUndefined();
		expect(await manager.getDiagnostics(fileB, "beta\n")).toBeUndefined();

		writeFileSync(fileB, "beta two\n");
		const result = await manager.getDiagnostics(fileB, "beta two\n");
		expect(result).toBeUndefined();
	});

	it("retries a failed pull so stale published diagnostics are never the fallback", async () => {
		// The server rejects the first textDocument/diagnostic request (like a
		// ContentModified cancellation) and answers the retry. Pull results are
		// request-ordered after the didChange, so the retry must be preferred
		// over falling back to the published map.
		const manager = setup({
			serverArgs: ["--pull-flaky"],
			settleMs: 500,
			firstSettleMs: 500,
		});
		const filePath = join(tempDir, "test.foo");
		const content = "ERROR at start\n";
		writeFileSync(filePath, content);
		const result = await manager.getDiagnostics(filePath, content);
		expect(result).toContain("found ERROR on line 1");
	});
});
