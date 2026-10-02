import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLspConfig } from "../src/core/lsp/config.ts";
import { LspManager } from "../src/core/lsp/manager.ts";
import { spawnProcessSync } from "../src/utils/child-process.ts";
import { createRealLspProject } from "./fixtures/real-lsp-project.ts";

const typescriptExecutable = process.env.VOLT_LSP_REAL_TS_EXECUTABLE;
const swiftExecutable = process.env.VOLT_LSP_REAL_SWIFT_EXECUTABLE;
const swiftProject = process.env.VOLT_LSP_REAL_SWIFT_PROJECT;

describe("opt-in real language servers", () => {
	it.skipIf(!typescriptExecutable)(
		"TypeScript 7.0.2: cross-file navigation, diagnostic repair, rename and code actions",
		async () => {
			const executable = realpathSync(typescriptExecutable!);
			const version = spawnProcessSync(executable, ["--version"], { encoding: "utf8", timeout: 3000 });
			expect(version.stdout?.trim()).toBe("Version 7.0.2");
			const root = createRealLspProject("typescript");
			const value = new LspManager({
				cwd: root,
				config: resolveLspConfig({
					idleShutdownMs: 0,
					settleMs: 5000,
					firstSettleMs: 15000,
					servers: { typescript: { command: [executable, "--lsp", "--stdio"] } },
				}),
			});
			try {
				const a = join(root, "a.ts"),
					b = join(root, "b.ts");
				const definition = await value.definition(b, "greet", 2);
				expect(definition.outcome).toBe("success");
				expect(definition.text).toContain("a.ts:");
				const references = await value.references(a, "greet");
				expect(references.outcome).toBe("success");
				expect(references.text).toContain("b.ts:");
				const clean = readFileSync(b, "utf8");
				writeFileSync(b, `${clean}export const broken: number = "bad";\n`);
				const broken = await value.fileDiagnostics(b);
				expect(broken).toMatchObject({ outcome: "success", freshness: "fresh" });
				expect(broken.diagnosticCount).toBeGreaterThan(0);
				writeFileSync(b, clean);
				expect(await value.fileDiagnostics(b)).toMatchObject({ outcome: "empty", freshness: "fresh" });
				const renamed = await value.rename(a, "greet", "welcome");
				expect(renamed.outcome).toBe("success");
				expect(readFileSync(a, "utf8")).toContain("function welcome(");
				expect(readFileSync(b, "utf8")).toContain('welcome("world")');
				const fix = await value.codeFix(b, { kind: "source.organizeImports" });
				expect(["success", "empty", "needs-selection", "unsupported"]).toContain(fix.outcome);
				console.log(
					JSON.stringify({
						server: "typescript",
						definition: definition.outcome,
						references: references.outcome,
						diagnostics: broken.freshness,
						rename: renamed.outcome,
						codeActions: fix.outcome,
					}),
				);
			} finally {
				value.dispose();
				rmSync(root, { recursive: true, force: true });
			}
		},
		60000,
	);

	it.skipIf(process.platform !== "darwin" || !swiftExecutable || !swiftProject)(
		"SourceKit: prebuilt disposable SwiftPM cross-file navigation, diagnostics and rename",
		async () => {
			const root = realpathSync(swiftProject!);
			// Refuse arbitrary projects: the caller must prepare a disposable fixture.
			expect(readFileSync(join(root, ".volt-lsp-test"), "utf8")).toBe("swift");
			const executable = realpathSync(swiftExecutable!);
			const value = new LspManager({
				cwd: root,
				config: resolveLspConfig({
					idleShutdownMs: 0,
					traceFile: join(root, "lsp.log"),
					settleMs: 5000,
					firstSettleMs: 20000,
					servers: { swift: { command: [executable] } },
				}),
			});
			const a = join(root, "Sources/LspFixture/A.swift"),
				b = join(root, "Sources/LspFixture/B.swift");
			const originalA = readFileSync(a, "utf8"),
				originalB = readFileSync(b, "utf8");
			try {
				// SourceKit initializes before its asynchronous SwiftPM manifest/index load.
				// Wait for real diagnostic evidence rather than sleeping or polling queries.
				expect((await value.fileDiagnostics(b)).outcome).toBe("empty");
				const definition = await value.definition(b, "greet");
				expect(definition.outcome).toBe("success");
				expect(definition.text).toContain("A.swift:");
				const references = await value.references(a, "greet");
				expect(references.outcome).toBe("success");
				expect(references.text).toContain("B.swift:");
				writeFileSync(b, `${originalB}public let broken: Int = "bad"\n`);
				const broken = await value.fileDiagnostics(b);
				expect(broken.outcome).toBe("success");
				expect(broken.diagnosticCount).toBeGreaterThan(0);
				expect(["fresh", "unverified"]).toContain(broken.freshness);
				writeFileSync(b, originalB);
				const clean = await value.fileDiagnostics(b);
				expect(clean.outcome).toBe("empty");
				expect(["fresh", "unverified"]).toContain(clean.freshness);
				const renamed = await value.rename(a, "greet", "welcome");
				if (renamed.outcome !== "unsupported") {
					expect(renamed.outcome).toBe("success");
					expect(readFileSync(a, "utf8")).toContain("func welcome(");
					expect(readFileSync(b, "utf8")).toContain("welcome(name:");
				}
				const fix = await value.codeFix(b, { kind: "source.organizeImports" });
				expect(["success", "empty", "needs-selection", "unsupported"]).toContain(fix.outcome);
				console.log(
					JSON.stringify({
						server: "sourcekit",
						definition: definition.outcome,
						references: references.outcome,
						diagnostics: broken.freshness,
						rename: renamed.outcome,
						codeActions: fix.outcome,
					}),
				);
			} finally {
				value.dispose();
				writeFileSync(a, originalA);
				writeFileSync(b, originalB);
			}
		},
		90000,
	);
});
