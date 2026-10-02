import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Disposable, dependency-free fixtures. Building is an explicit external step. */
export function createRealLspProject(language: "typescript" | "swift"): string {
	const root = mkdtempSync(join(tmpdir(), `volt-lsp-real-${language}-`));
	writeFileSync(join(root, ".volt-lsp-test"), language);
	if (language === "typescript") {
		writeFileSync(join(root, "package.json"), '{"type":"module"}');
		writeFileSync(
			join(root, "tsconfig.json"),
			'{"compilerOptions":{"strict":true,"module":"nodenext","target":"es2022"},"include":["*.ts"]}',
		);
		writeFileSync(join(root, "a.ts"), "export function greet(name: string): string { return name; }\n");
		writeFileSync(join(root, "b.ts"), 'import { greet } from "./a.js";\nexport const result = greet("world");\n');
	} else {
		writeFileSync(
			join(root, "Package.swift"),
			'// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "LspFixture", products: [.library(name: "LspFixture", targets: ["LspFixture"])], targets: [.target(name: "LspFixture")])\n',
		);
		mkdirSync(join(root, "Sources/LspFixture"), { recursive: true });
		writeFileSync(join(root, "Sources/LspFixture/A.swift"), "public func greet(name: String) -> String { name }\n");
		writeFileSync(join(root, "Sources/LspFixture/B.swift"), 'public let result = greet(name: "world")\n');
	}
	return root;
}
