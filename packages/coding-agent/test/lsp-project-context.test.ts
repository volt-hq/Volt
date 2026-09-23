import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLspConfig } from "../src/core/lsp/config.ts";
import { LspManager } from "../src/core/lsp/manager.ts";
import { lspOperationMetadata } from "../src/core/lsp/outcome.ts";
import { swiftProjectContext } from "../src/core/lsp/project-context.ts";
import * as childProcess from "../src/utils/child-process.ts";

const roots: string[] = [];
const managers: LspManager[] = [];
function directory(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-lsp-context-")));
	roots.push(root);
	return root;
}
function manager(root: string, enabled = true): LspManager {
	const value = new LspManager({
		cwd: root,
		config: resolveLspConfig({
			enabled,
			idleShutdownMs: 0,
			servers: { swift: { command: [process.execPath, join(__dirname, "fixtures/fake-lsp-server.mjs"), "--pull"] } },
		}),
	});
	managers.push(value);
	return value;
}
afterEach(() => {
	for (const value of managers.splice(0)) value.dispose();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Swift filesystem project-context evidence", () => {
	it("classifies markers with BSP precedence and distinguishes failed inspection", () => {
		const root = directory();
		expect(swiftProjectContext(root)).toBe("not-detected");
		writeFileSync(join(root, "Package.swift"), "// package");
		expect(swiftProjectContext(root)).toBe("swiftpm-detected");
		writeFileSync(join(root, "buildServer.json"), "{} ");
		expect(swiftProjectContext(root)).toBe("build-server-detected");
		expect(swiftProjectContext(join(root, "missing"))).toBe("unknown");
		expect(swiftProjectContext(join(root, "Package.swift"))).toBe("unknown");
	});
	it.each([true, false])("routes unused nested and external status without starts (enabled=%s)", async (enabled) => {
		const root = directory();
		const external = directory();
		const nested = join(root, "nested");
		mkdirSync(nested);
		writeFileSync(join(root, "Package.swift"), "// package");
		writeFileSync(join(nested, "buildServer.json"), "{}");
		const spawn = vi.spyOn(childProcess, "spawnProcess");
		const value = manager(root, enabled);
		expect(value.getStatus().find((entry) => entry.name === "swift")).toMatchObject({
			projectContext: "swiftpm-detected",
			state: enabled ? "unused" : "disabled",
		});
		const nestedStatus = await value.status(join(nested, "a.swift"));
		expect(nestedStatus).toMatchObject({ root: nested, projectContext: "build-server-detected" });
		expect(nestedStatus.text).toContain("filesystem evidence does not verify");
		const externalStatus = await value.status(join(external, "a.swift"));
		expect(externalStatus).toMatchObject({ root: external, projectContext: "not-detected" });
		expect(externalStatus.text).not.toContain("Package.swift detected");
		expect(externalStatus.text).toContain("Ready means transport initialized");
		expect(spawn).not.toHaveBeenCalled();
	});
	it("does not borrow coverage from a running root for an unused external root", async () => {
		const root = directory();
		writeFileSync(join(root, "Package.swift"), "// package");
		const path = join(root, "a.swift");
		writeFileSync(path, "value\n");
		const value = manager(root);
		await value.hover(path, "value");
		const external = directory();
		const status = await value.status(join(external, "a.swift"));
		expect(status).toMatchObject({ projectContext: "not-detected", root: external });
		expect(status.text).toContain("unused");
		expect(value.getStatus().filter((entry) => entry.attempts > 0)).toHaveLength(1);
	});
	it("refreshes context transitions, labels best-effort diagnostics and retains explicit caveats", async () => {
		const root = directory();
		const path = join(root, "a.swift");
		writeFileSync(path, "ERROR value\n");
		const value = manager(root);
		const first = await value.getDiagnostics(path, "ERROR value\n");
		expect(first).toMatchObject({ projectContext: "not-detected", freshness: "fresh", diagnosticCount: 1 });
		expect(first.text).toContain("configure a build server manually");
		expect(first.text).toContain("Best-effort diagnostics");
		expect((await value.getDiagnostics(path, "ERROR value\n")).text).toBe("");
		const explicit = await value.fileDiagnostics(path);
		expect(explicit.text).toContain("found ERROR");
		expect(explicit.text).toContain("configure a build server manually");
		writeFileSync(join(root, "Package.swift"), "// package");
		const detected = await value.getDiagnostics(path, "ERROR value\n");
		expect(detected.projectContext).toBe("swiftpm-detected");
		expect(detected.text).toContain("found ERROR");
		expect(detected.text).not.toContain("configure a build server manually");
		writeFileSync(join(root, "buildServer.json"), "{}");
		expect((await value.getDiagnostics(path, "ERROR value\n")).projectContext).toBe("build-server-detected");
		rmSync(join(root, "buildServer.json"));
		rmSync(join(root, "Package.swift"));
		expect((await value.getDiagnostics(path, "ERROR value\n")).text).toContain("configure a build server manually");
		const metadata = lspOperationMetadata(first, "write", "diagnostics", performance.now());
		expect(metadata.projectContext).toBe("not-detected");
		expect(JSON.stringify(metadata)).not.toContain("found ERROR");
		expect(JSON.stringify(metadata)).not.toContain("build server manually");
		expect(value.getStatus().find((entry) => entry.name === "swift")).toMatchObject({
			state: "ready",
			projectContext: "not-detected",
		});
		const alias = join(root, "alias.swift");
		symlinkSync(path, alias);
		expect((await value.getDiagnostics(alias, "ERROR value\n")).text).toBe("");
	});
	it("emits a context warning on a clean first check, not on disabled automatic checks", async () => {
		const root = directory();
		const path = join(root, "a.swift");
		writeFileSync(path, "value\n");
		const value = manager(root);
		expect(await value.getDiagnostics(path, "value\n")).toMatchObject({
			outcome: "empty",
			text: expect.stringContaining("No Swift project context detected"),
		});
		expect((await value.getDiagnostics(path, "value\n")).text).toBe("");
		const disabled = new LspManager({ cwd: root, config: resolveLspConfig({ autoDiagnostics: false }) });
		managers.push(disabled);
		expect(await disabled.getDiagnostics(path, "value\n")).toMatchObject({
			outcome: "skipped",
			text: "",
			projectContext: "not-detected",
		});
	});
});
