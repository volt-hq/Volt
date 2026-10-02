import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLspConfig } from "../src/core/lsp/config.ts";
import { LspManager } from "../src/core/lsp/manager.ts";
import * as childProcess from "../src/utils/child-process.ts";

const roots: string[] = [];
const managers: LspManager[] = [];
const fake = join(__dirname, "fixtures/fake-lsp-server.mjs");
afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("automatic diagnostic controls", () => {
	it("defaults on and preserves independent per-server overrides", () => {
		expect(resolveLspConfig(undefined).autoDiagnostics).toBe(true);
		const config = resolveLspConfig({
			enabled: false,
			autoDiagnostics: false,
			servers: { typescript: { autoDiagnostics: true }, swift: { autoDiagnostics: false, enabled: false } },
		});
		config.enabled = true; // --lsp changes only the master switch.
		expect(config.autoDiagnostics).toBe(false);
		expect(config.servers.find((server) => server.name === "typescript")?.autoDiagnostics).toBe(true);
		expect(config.servers.some((server) => server.name === "swift")).toBe(false);
		expect(config.disabledServers?.find((server) => server.name === "swift")?.autoDiagnostics).toBe(false);
	});

	it.each([
		{ global: false, server: undefined, skipped: true },
		{ global: true, server: false, skipped: true },
		{ global: false, server: true, skipped: false },
		{ global: true, server: undefined, skipped: false },
	])("routes global=$global server=$server without disabling explicit tools", async ({ global, server, skipped }) => {
		const root = mkdtempSync(join(tmpdir(), "volt-lsp-auto-"));
		roots.push(root);
		const path = join(root, "test.foo");
		writeFileSync(path, "ERROR value\n");
		const spawn = vi.spyOn(childProcess, "spawnProcess");
		const manager = new LspManager({
			cwd: root,
			config: resolveLspConfig({
				autoDiagnostics: global,
				idleShutdownMs: 0,
				servers: {
					fixture: {
						command: [process.execPath, fake, "--pull"],
						fileExtensions: [".foo"],
						autoDiagnostics: server,
					},
				},
			}),
		});
		managers.push(manager);
		const result = await manager.getDiagnostics(path, "ERROR value\n");
		if (skipped) {
			expect(result).toMatchObject({
				outcome: "skipped",
				reason: "auto-diagnostics-disabled",
				text: "",
				freshness: "unknown",
				source: "none",
			});
			expect(spawn).not.toHaveBeenCalled();
			expect(manager.getStatus().every((entry) => entry.attempts === 0)).toBe(true);
		} else {
			expect(result).toMatchObject({ outcome: "success", diagnosticCount: 1 });
		}
		expect(await manager.fileDiagnostics(path)).toMatchObject({ outcome: "success", diagnosticCount: 1 });
		writeFileSync(path, "value updated\n");
		await manager.getDiagnostics(path, "value updated\n");
		expect(await manager.hover(path, "updated")).toMatchObject({ outcome: "success", text: "fake hover text" });
		expect(await manager.fileDiagnostics(path)).toMatchObject({ outcome: "empty", diagnosticCount: 0 });
		expect(await manager.rename(path, "updated", "renamed")).toMatchObject({ outcome: "success" });
		expect(readFileSync(path, "utf8")).toBe("value renamed\n");
	});

	it("does not offer installation or synchronize with checks disabled", async () => {
		const root = mkdtempSync(join(tmpdir(), "volt-lsp-auto-"));
		roots.push(root);
		const requestAction = vi.fn();
		const spawn = vi.spyOn(childProcess, "spawnProcess");
		const manager = new LspManager({
			cwd: root,
			config: resolveLspConfig({ autoDiagnostics: false }),
			hostInteraction: { requestAction },
		});
		managers.push(manager);
		expect(await manager.getDiagnostics(join(root, "missing.ts"), "ERROR")).toMatchObject({
			reason: "auto-diagnostics-disabled",
			text: "",
		});
		expect(spawn).not.toHaveBeenCalled();
		expect(requestAction).not.toHaveBeenCalled();
		expect((await manager.status()).outcome).toBe("success");
	});
});
