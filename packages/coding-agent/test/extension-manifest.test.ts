/**
 * Extension manifests (RFC §8.1): validation, package manifests read as JSON
 * with contained entries, single-file manifests only from trusted sources,
 * id precedence, and identity in what extensions contribute.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESERVED_EXTENSION_IDS } from "@hansjm10/volt-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } from "../src/core/extensions/loader.ts";
import {
	declaresPackageExtension,
	defineManifest,
	ExtensionManifestError,
	readModuleManifest,
	readPackageManifest,
	readVoltFieldManifest,
	validateManifest,
} from "../src/core/extensions/manifest.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { listDynamicIntents } from "../src/core/protocol/intents/dynamic.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { isAllowedUiIntent } from "../src/core/ui/normalize.ts";
import { testExtension } from "./utilities.ts";

const EVALUATED_KEY = `__voltManifestEvaluated_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const globalState = globalThis as typeof globalThis & Record<string, string[] | undefined>;

/** Module source that records `label` when evaluated and again when its factory runs. */
function recordingModule(label: string, manifest?: object): string {
	return `(globalThis[${JSON.stringify(EVALUATED_KEY)}] ??= []).push(${JSON.stringify(`${label}:module`)});
${manifest ? `export const manifest = ${JSON.stringify(manifest)};` : ""}
export default function () {
	globalThis[${JSON.stringify(EVALUATED_KEY)}].push(${JSON.stringify(`${label}:factory`)});
}
`;
}

describe("extension manifests", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "volt-manifest-"));
	});

	afterEach(() => {
		delete globalState[EVALUATED_KEY];
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writePackage(name: string, volt: unknown, files: Record<string, string> = {}): string {
		const root = join(tempDir, name);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "2.0.1", volt }));
		for (const [file, content] of Object.entries(files)) {
			mkdirSync(join(root, file, ".."), { recursive: true });
			writeFileSync(join(root, file), content);
		}
		return root;
	}

	describe("validateManifest", () => {
		it("returns a frozen copy of a valid manifest", () => {
			const source = {
				id: "deploy-tools",
				displayName: "Deploy Tools",
				description: "Ships builds.",
				permissions: ["exec", "network"],
				settings: { type: "object", properties: { region: { type: "string", enum: ["eu", "us"] } } },
			};
			const manifest = validateManifest(source, { package: false });
			expect(manifest).toEqual(source);
			expect(manifest).not.toBe(source);
			expect(Object.isFrozen(manifest)).toBe(true);
			source.id = "changed";
			expect(manifest.id).toBe("deploy-tools");
			expect(defineManifest(manifest)).toBe(manifest);
		});

		it.each([
			[{ displayName: "No id" }, '"id" is required'],
			[{ id: "Upper", displayName: "x" }, '"id" must be a lowercase extension id that is not reserved'],
			[{ id: "a".repeat(65), displayName: "x" }, '"id" must be a lowercase extension id'],
			[{ id: "-lead", displayName: "x" }, '"id" must be a lowercase extension id'],
			[{ id: "a.b", displayName: "x" }, '"id" must be a lowercase extension id'],
			[{ id: "ok", displayName: "two\nlines" }, '"displayName" must be one non-empty line'],
			[{ id: "ok", displayName: "x", extra: true }, '"extra" is not a recognized field'],
			[{ id: "ok", displayName: "x", permissions: ["exec", "exec"] }, '"permissions"'],
			[{ id: "ok", displayName: "x", permissions: ["root"] }, '"permissions[0]"'],
		])("rejects %j", (manifest, message) => {
			expect(() => validateManifest(manifest, { package: false })).toThrow(message);
		});

		it.each(RESERVED_EXTENSION_IDS)("rejects the reserved id %s", (id) => {
			expect(() => validateManifest({ id, displayName: "Spoof" }, { package: false })).toThrow(
				'"id" must be a lowercase extension id that is not reserved',
			);
		});

		it("rejects data that is not plain JSON, reading it once", () => {
			let reads = 0;
			const getter = {
				get id() {
					reads++;
					return "ok";
				},
				displayName: "x",
			};
			expect(() => validateManifest(getter, { package: false })).toThrow(/accessor properties are not permitted/);
			expect(reads).toBe(0);
			expect(() =>
				validateManifest({ id: "ok", displayName: "x", description: undefined }, { package: false }),
			).toThrow(/undefined is not permitted/);
			expect(() => validateManifest("ok", { package: false })).toThrow("The manifest must be an object");
		});

		it("requires entry for a package and refuses it for a single file", () => {
			expect(() => validateManifest({ id: "ok", displayName: "x" }, { package: true })).toThrow(
				'"entry" is required',
			);
			expect(() => validateManifest({ id: "ok", displayName: "x", entry: "index.ts" }, { package: false })).toThrow(
				"a single-file extension has none",
			);
		});

		it.each(["../escape.ts", "src/../../escape.ts", "/etc/passwd", "C:/x.ts", "src\\\\x.ts"])(
			"refuses the entry %j outright",
			(entry) => {
				expect(() => validateManifest({ id: "ok", displayName: "x", entry }, { package: true })).toThrow(
					'"entry" must be a relative path inside the package',
				);
			},
		);
	});

	describe("readModuleManifest", () => {
		it("reads the exported manifest and reports a missing one", () => {
			expect(readModuleManifest({ manifest: { id: "ok", displayName: "Ok" } })).toEqual({
				id: "ok",
				displayName: "Ok",
			});
			expect(() => readModuleManifest({ default: () => {} })).toThrow("The module exports no manifest");
		});
	});

	describe("readPackageManifest", () => {
		it("reads the manifest, version, and entry, leaving resources out", () => {
			const root = writePackage(
				"pkg",
				{
					id: "pkg",
					displayName: "Pkg",
					entry: "src/index.ts",
					skills: ["skills"],
				},
				{ "src/index.ts": "throw new Error('never evaluated');" },
			);
			expect(declaresPackageExtension(root)).toBe(true);
			expect(readPackageManifest(root)).toEqual({
				manifest: { id: "pkg", displayName: "Pkg", entry: "src/index.ts" },
				version: "2.0.1",
				entryPath: join(root, "src", "index.ts"),
			});
		});

		it("declares no extension for a field with only resources", () => {
			const root = writePackage("skills-only", { skills: ["skills"], prompts: [], themes: [] });
			expect(declaresPackageExtension(root)).toBe(false);
			expect(readPackageManifest(root)).toBeUndefined();
		});

		it("reads image and video as manifest fields, which refuse them: previews belong in the store catalog", () => {
			const root = writePackage("previews", { skills: ["skills"], video: "https://example.com/demo.mp4" });
			expect(declaresPackageExtension(root)).toBe(true);
			expect(() => readPackageManifest(root)).toThrow(ExtensionManifestError);
		});

		it("checks a volt field as data without looking for the entry", () => {
			expect(readVoltFieldManifest({ skills: ["skills"] })).toBeUndefined();
			expect(readVoltFieldManifest({ id: "pkg", displayName: "Pkg", entry: "missing.ts", skills: [] })).toEqual({
				id: "pkg",
				displayName: "Pkg",
				entry: "missing.ts",
			});
			expect(() => readVoltFieldManifest({ id: "pkg", displayName: "Pkg" })).toThrow('"entry" is required');
			expect(() => readVoltFieldManifest("index.ts")).toThrow('The "volt" field of package.json must be an object');
		});

		it("explains the replaced extensions list", () => {
			const root = writePackage("old", { extensions: ["./index.ts"] }, { "index.ts": "" });
			expect(() => readPackageManifest(root)).toThrow('"volt.extensions" is replaced by the manifest');
		});

		it("treats a __proto__ key as an unrecognized field", () => {
			const root = join(tempDir, "proto");
			mkdirSync(root);
			writeFileSync(
				join(root, "package.json"),
				'{"name":"proto","volt":{"__proto__":{"polluted":true},"id":"proto","displayName":"P","entry":"index.ts"}}',
			);
			writeFileSync(join(root, "index.ts"), "");
			expect(() => readPackageManifest(root)).toThrow('"__proto__" is not a recognized field');
			expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		});

		it("refuses a field that is not an object", () => {
			const root = writePackage("array", ["index.ts"]);
			expect(declaresPackageExtension(root)).toBe(true);
			expect(() => readPackageManifest(root)).toThrow('The "volt" field of package.json must be an object');
		});

		it("refuses an entry that is missing, a directory, or a symbolic link out of the package", () => {
			const outside = join(tempDir, "outside.ts");
			writeFileSync(outside, "export default function () {}");
			const missing = writePackage("missing", { id: "missing", displayName: "M", entry: "nope.ts" });
			expect(() => readPackageManifest(missing)).toThrow('"entry" "nope.ts" does not exist in the package');
			const directory = writePackage(
				"directory",
				{ id: "directory", displayName: "D", entry: "src" },
				{ "src/a.ts": "" },
			);
			expect(() => readPackageManifest(directory)).toThrow('"entry" "src" is not a file');
			const linked = writePackage("linked", { id: "linked", displayName: "L", entry: "index.ts" });
			symlinkSync(outside, join(linked, "index.ts"));
			expect(() => readPackageManifest(linked)).toThrow('"entry" "index.ts" resolves outside the package');
		});
	});

	describe("loading", () => {
		it("loads a package entry only after the package owns its id", async () => {
			const winner = writePackage(
				"winner",
				{ id: "same", displayName: "Winner", entry: "index.ts" },
				{ "index.ts": recordingModule("winner") },
			);
			const loser = writePackage(
				"loser",
				{ id: "same", displayName: "Loser", entry: "index.ts" },
				{ "index.ts": recordingModule("loser") },
			);

			const result = await loadExtensions([winner, loser], tempDir);

			expect(result.extensions.map((extension) => [extension.id, extension.version, extension.path])).toEqual([
				["same", "2.0.1", winner],
			]);
			expect(result.errors).toEqual([
				{ path: loser, error: `Extension id "same" is already used by ${winner}; ${loser} is not loaded` },
			]);
			// The losing package's code never ran.
			expect(globalState[EVALUATED_KEY]).toEqual(["winner:module", "winner:factory"]);
		});

		it("never evaluates a module installed from npm or git to find its manifest", async () => {
			const modulePath = join(tempDir, "installed.ts");
			writeFileSync(modulePath, recordingModule("installed", { id: "installed", displayName: "Installed" }));
			const root = writePackage(
				"installed-pkg",
				{ id: "installed-pkg", displayName: "Installed Package", entry: "index.ts" },
				{ "index.ts": recordingModule("installed-pkg") },
			);

			const result = await loadExtensions(
				[
					{ path: modulePath, scope: "user", installed: true },
					{ path: root, scope: "user", installed: true },
				],
				tempDir,
			);

			expect(result.extensions.map((extension) => extension.id)).toEqual(["installed-pkg"]);
			expect(result.errors).toEqual([
				{
					path: modulePath,
					error: expect.stringContaining("An extension installed from npm or git must be a package"),
				},
			]);
			expect(globalState[EVALUATED_KEY]).toEqual(["installed-pkg:module", "installed-pkg:factory"]);
		});

		it("reports a single file without a manifest, or with an invalid one, without running its factory", async () => {
			const noManifest = join(tempDir, "no-manifest.ts");
			const reserved = join(tempDir, "reserved.ts");
			writeFileSync(noManifest, recordingModule("no-manifest"));
			writeFileSync(reserved, recordingModule("reserved", { id: "volt", displayName: "Volt" }));

			const result = await loadExtensions([noManifest, reserved], tempDir);

			expect(result.extensions).toEqual([]);
			expect(result.errors).toEqual([
				{
					path: noManifest,
					error: expect.stringMatching(/^Invalid extension manifest: The module exports no manifest/),
				},
				{
					path: reserved,
					error: 'Invalid extension manifest: "id" must be a lowercase extension id that is not reserved',
				},
			]);
			expect(globalState[EVALUATED_KEY]).toEqual(["no-manifest:module", "reserved:module"]);
		});

		it("keeps a user or temporary extension over a project one, otherwise the earlier one", async () => {
			const write = (name: string, id: string) => {
				const path = join(tempDir, `${name}.ts`);
				writeFileSync(path, recordingModule(name, { id, displayName: name }));
				return path;
			};
			const project = write("project", "a");
			const user = write("user", "a");
			const temporary = write("temporary", "a");
			const projectB = write("project-b", "b");
			const projectB2 = write("project-b2", "b");

			const result = await loadExtensions(
				[
					{ path: project, scope: "project" },
					{ path: projectB, scope: "project" },
					{ path: projectB2, scope: "project" },
					{ path: user, scope: "user" },
					{ path: temporary, scope: "temporary" },
				],
				tempDir,
			);

			expect(result.extensions.map((extension) => [extension.id, extension.path])).toEqual([
				["b", projectB],
				["a", user],
			]);
			expect(result.errors.map((error) => error.path)).toEqual([projectB2, project, temporary]);
			expect(result.extensions.map((extension) => extension.sourceInfo.scope)).toEqual(["project", "user"]);
		});

		it("keeps the ids of extensions already loaded into the runtime", async () => {
			const runtime = createExtensionRuntime();
			const loaded = await loadExtensionFromFactory(
				testExtension("taken", () => {}),
				tempDir,
				createEventBus(),
				runtime,
			);
			const path = join(tempDir, "late.ts");
			writeFileSync(path, recordingModule("late", { id: "taken", displayName: "Late" }));

			const result = await loadExtensions([{ path, scope: "user" }], tempDir, undefined, runtime, [loaded]);

			expect(result.extensions).toEqual([]);
			expect(result.errors).toEqual([
				{ path, error: `Extension id "taken" is already used by <inline>; ${path} is not loaded` },
			]);
		});

		it("refuses a runner over an extension whose id is not a manifest id", async () => {
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				testExtension("fine", () => {}),
				tempDir,
				createEventBus(),
				runtime,
			);
			expect(
				() =>
					new ExtensionRunner(
						[{ ...extension, id: "<runtime>" }],
						runtime,
						tempDir,
						SessionManager.inMemory(),
						ModelRegistry.inMemory(AuthStorage.inMemory()),
					),
			).toThrow('Invalid extension id "<runtime>"');
		});

		it("refuses a runner over two extensions with one id", async () => {
			const runtime = createExtensionRuntime();
			const bus = createEventBus();
			const one = await loadExtensionFromFactory(
				testExtension("twin", () => {}),
				tempDir,
				bus,
				runtime,
				"<a>",
			);
			const two = await loadExtensionFromFactory(
				testExtension("twin", () => {}),
				tempDir,
				bus,
				runtime,
				"<b>",
			);
			expect(
				() =>
					new ExtensionRunner(
						[one, two],
						runtime,
						tempDir,
						SessionManager.inMemory(),
						ModelRegistry.inMemory(AuthStorage.inMemory()),
					),
			).toThrow('Two extensions have the id "twin"');
		});
	});

	describe("identity", () => {
		it("attributes contributions, errors, and command intents to the manifest id", async () => {
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				testExtension("deploy", (volt) => {
					volt.registerCommand("ship", { handler: async () => {} });
					volt.registerFlag("dry-run", { type: "boolean" });
					volt.registerShortcut("ctrl+shift+d", {
						intent: volt.registerIntent("ship-now", { label: "Ship", handler: () => {} }),
					});
					volt.registerProvider("deploy-ai", { baseUrl: "https://example.com" });
					volt.on("context", () => {
						throw new Error("boom");
					});
				}),
				tempDir,
				createEventBus(),
				runtime,
				"/somewhere/deploy.ts",
			);
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				tempDir,
				SessionManager.inMemory(),
				ModelRegistry.inMemory(AuthStorage.inMemory()),
			);
			const errors: unknown[] = [];
			runner.onError((error) => errors.push(error));
			await runner.emitContext([]);

			expect(runner.getRegisteredCommands().map((command) => command.extensionId)).toEqual(["deploy"]);
			expect(runner.getFlags().get("dry-run")?.extensionId).toBe("deploy");
			expect([...extension.shortcuts.values()].map((shortcut) => [shortcut.extensionId, shortcut.intent])).toEqual([
				["deploy", "extension.intent.deploy.ship-now"],
			]);
			expect(runner.getRegisteredIntents().map((intent) => intent.intent)).toEqual([
				"extension.intent.deploy.ship-now",
			]);
			expect(runtime.pendingProviderRegistrations.map((registration) => registration.extensionId)).toEqual([
				"deploy",
			]);
			expect(errors).toEqual([expect.objectContaining({ extensionId: "deploy", event: "context", error: "boom" })]);

			const [intent] = listDynamicIntents({
				extensionRunner: runner,
				promptTemplates: [],
				resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
			});
			expect(intent?.name).toBe("extension.command.deploy.ship");
			const ownsNoWork = () => false;
			expect(
				isAllowedUiIntent(
					{ type: intent!.name },
					{ owner: "extension", extensionId: "deploy", ownsWork: ownsNoWork },
				),
			).toBe(true);
			expect(
				isAllowedUiIntent(
					{ type: intent!.name },
					{ owner: "extension", extensionId: "deploy-2", ownsWork: ownsNoWork },
				),
			).toBe(false);
		});

		it("rejects a command name an intent cannot carry", async () => {
			await expect(
				loadExtensionFromFactory(
					testExtension("bad", (volt) => volt.registerCommand("bad.name", { handler: async () => {} })),
					tempDir,
					createEventBus(),
					createExtensionRuntime(),
				),
			).rejects.toThrow('Invalid extension command name "bad.name"');
		});
	});
});
