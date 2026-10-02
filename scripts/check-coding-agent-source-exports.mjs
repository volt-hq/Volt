import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const rootDir = process.cwd();
const codingAgentRoot = join(rootDir, "packages", "coding-agent");
const packageJson = JSON.parse(readFileSync(join(codingAgentRoot, "package.json"), "utf8"));
const packageName = packageJson.name;
const packageSourceEntry = join(codingAgentRoot, "src", "index.ts");
const remoteIrohIndex = join(codingAgentRoot, "src", "core", "remote", "iroh", "index.ts");
const failures = [];

function relativePath(path) {
	return relative(rootDir, path);
}

function readSourceFile(path) {
	const sourceText = readFileSync(path, "utf8");
	const scriptKind = path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
	return ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
}

function hasExportModifier(node) {
	return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function collectBindingNames(name, names) {
	if (ts.isIdentifier(name)) {
		names.add(name.text);
		return;
	}
	if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
		for (const element of name.elements) {
			if (ts.isBindingElement(element)) collectBindingNames(element.name, names);
		}
	}
}

function resolveRelativeModule(fromFile, specifier) {
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;

	const basePath = resolve(dirname(fromFile), specifier);
	const candidates = [
		basePath,
		`${basePath}.ts`,
		`${basePath}.mts`,
		`${basePath}.js`,
		`${basePath}.mjs`,
		join(basePath, "index.ts"),
		join(basePath, "index.mts"),
		join(basePath, "index.js"),
		join(basePath, "index.mjs"),
	];
	return candidates.find((candidate) => existsSync(candidate));
}

function collectNamedExports(path, options = {}, seen = new Set()) {
	const cacheKey = `${path}:${options.runtimeOnly === true ? "runtime" : "all"}`;
	if (seen.has(cacheKey)) return new Set();
	seen.add(cacheKey);

	const sourceFile = readSourceFile(path);
	const names = new Set();
	for (const statement of sourceFile.statements) {
		if (ts.isExportDeclaration(statement)) {
			if (options.runtimeOnly === true && statement.isTypeOnly) continue;
			if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
				for (const specifier of statement.exportClause.elements) {
					if (options.runtimeOnly === true && specifier.isTypeOnly) continue;
					names.add(specifier.name.text);
				}
				continue;
			}

			if (!statement.exportClause && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
				const resolvedModule = resolveRelativeModule(path, statement.moduleSpecifier.text);
				if (resolvedModule) {
					for (const name of collectNamedExports(resolvedModule, options, seen)) names.add(name);
				}
			}
			continue;
		}

		if (!hasExportModifier(statement)) continue;
		if (
			options.runtimeOnly === true &&
			(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
		) {
			continue;
		}
		if (
			ts.isFunctionDeclaration(statement) ||
			ts.isClassDeclaration(statement) ||
			ts.isInterfaceDeclaration(statement) ||
			ts.isTypeAliasDeclaration(statement) ||
			ts.isEnumDeclaration(statement)
		) {
			if (statement.name) names.add(statement.name.text);
			continue;
		}
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				collectBindingNames(declaration.name, names);
			}
		}
	}
	return names;
}

function collectFiles(directory, predicate, files = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			collectFiles(path, predicate, files);
			continue;
		}
		if (entry.isFile() && predicate(path)) files.push(path);
	}
	return files;
}

function checkRemoteIrohRootExports() {
	const remoteExports = collectNamedExports(remoteIrohIndex);
	const packageExports = collectNamedExports(packageSourceEntry);
	const missing = [...remoteExports].filter((name) => !packageExports.has(name)).sort();
	if (missing.length === 0) return;

	failures.push(
		`${relativePath(packageSourceEntry)} does not re-export ${relativePath(remoteIrohIndex)} names:\n${missing.map((name) => `  - ${name}`).join("\n")}`,
	);
}

function checkMjsPackageImports() {
	const packageRuntimeExports = collectNamedExports(packageSourceEntry, { runtimeOnly: true });
	const mjsFiles = collectFiles(join(codingAgentRoot, "src"), (path) => path.endsWith(".mjs"));
	for (const file of mjsFiles) {
		const sourceFile = readSourceFile(file);
		for (const statement of sourceFile.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
			if (statement.moduleSpecifier.text !== packageName) continue;

			const namedBindings = statement.importClause?.namedBindings;
			if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
			for (const specifier of namedBindings.elements) {
				const importedName = (specifier.propertyName ?? specifier.name).text;
				if (packageRuntimeExports.has(importedName)) continue;

				const position = sourceFile.getLineAndCharacterOfPosition(specifier.name.getStart(sourceFile));
				failures.push(
					`${relativePath(file)}:${position.line + 1}:${position.character + 1} imports ${importedName} from ${packageName}, but it is not a runtime export of ${relativePath(packageSourceEntry)}`,
				);
			}
		}
	}
}

checkRemoteIrohRootExports();
checkMjsPackageImports();

if (failures.length > 0) {
	console.error("Coding-agent source export checks failed:");
	for (const failure of failures) console.error(failure);
	process.exit(1);
}
