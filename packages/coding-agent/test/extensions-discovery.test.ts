import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions, validateExtensionCommandName } from "../src/core/extensions/loader.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("extensions discovery", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "volt-ext-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const extensionCode = (id: string) => `
		export const manifest = { id: "${id}", displayName: "${id}" };
		export default function(volt) {
			volt.registerCommand("test", { handler: async () => {} });
		}
	`;

	const writePackage = (dir: string, volt: unknown, extra: Record<string, unknown> = {}) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: path.basename(dir), ...extra, volt }));
	};

	it("rejects a remote-safe command name that would resolve to a different slash command", async () => {
		fs.writeFileSync(
			path.join(extensionsDir, "collision.ts"),
			`export const manifest = { id: "collision", displayName: "collision" };
export default function(volt) {
				volt.registerCommand("deploy", { handler: async () => {} });
				volt.registerCommand("deploy now", { remoteSafe: true, handler: async () => {} });
			}`,
		);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		expect(result.extensions).toEqual([]);
		expect(result.errors).toEqual([
			expect.objectContaining({ error: expect.stringContaining('Invalid extension command name "deploy now"') }),
		]);
	});

	it.each([
		"/deploy",
		"deploy/now",
		"deploy now",
		"deploy\tnow",
		"",
		"deploy.now",
		"-deploy",
		"a".repeat(65),
		"other:deploy",
		"skill:debugger",
	])("rejects invalid slash-command registration name %j", (name) => {
		expect(() => validateExtensionCommandName(name)).toThrow("Invalid extension command name");
	});

	it.each(["deploy", "Deploy_2", "review-fix", "a".repeat(64)])("accepts command name %j", (name) => {
		expect(() => validateExtensionCommandName(name)).not.toThrow();
	});

	it.each(["plan", "build"])("reserves native /%s commands", async (name) => {
		fs.writeFileSync(
			path.join(extensionsDir, `${name}.ts`),
			`export const manifest = { id: "${name}-ext", displayName: "ext" };
export default function(volt) {
				volt.registerCommand("${name}", { handler: async () => {} });
			}`,
		);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		expect(result.extensions).toEqual([]);
		expect(result.errors).toEqual([
			expect.objectContaining({ error: expect.stringContaining("reserved by native Plan mode") }),
		]);
	});

	const extensionCodeWithTool = (toolName: string) => `
		import { Type } from "typebox";
		export const manifest = { id: "${toolName.replaceAll("_", "-")}", displayName: "${toolName}" };
		export default function(volt) {
			volt.registerTool({
				name: "${toolName}",
				label: "${toolName}",
				description: "Test tool",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
			});
		}
	`;

	it.each(["update_plan", "submit_plan", "update_plan_progress", "request_replan"])(
		"reserves native %s tools",
		async (name) => {
			fs.writeFileSync(path.join(extensionsDir, `${name}.ts`), extensionCodeWithTool(name));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			expect(result.extensions).toEqual([]);
			expect(result.errors).toEqual([
				expect.objectContaining({ error: expect.stringContaining("reserved by native Plan mode") }),
			]);
		},
	);

	it("discovers direct .ts files in extensions/", async () => {
		fs.writeFileSync(path.join(extensionsDir, "foo.ts"), extensionCode("foo"));
		fs.writeFileSync(path.join(extensionsDir, "bar.ts"), extensionCode("bar"));

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(2);
		expect(result.extensions.map((e) => path.basename(e.path)).sort()).toEqual(["bar.ts", "foo.ts"]);
		expect(result.extensions.map((e) => [e.id, e.version, e.sourceInfo.scope]).sort()).toEqual([
			["bar", "local", "user"],
			["foo", "local", "user"],
		]);
	});

	it("discovers direct .js files in extensions/", async () => {
		fs.writeFileSync(path.join(extensionsDir, "foo.js"), extensionCode("foo"));

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(path.basename(result.extensions[0].path)).toBe("foo.js");
	});

	it("discovers subdirectory with index.ts", async () => {
		const subdir = path.join(extensionsDir, "my-extension");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.ts"), extensionCode("my-extension"));

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("my-extension");
		expect(result.extensions[0].path).toContain("index.ts");
	});

	it("discovers subdirectory with index.js", async () => {
		const subdir = path.join(extensionsDir, "my-extension");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.js"), extensionCode("my-extension"));

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("index.js");
	});

	it("prefers index.ts over index.js", async () => {
		const subdir = path.join(extensionsDir, "my-extension");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.ts"), extensionCode("my-extension"));
		fs.writeFileSync(path.join(subdir, "index.js"), extensionCode("my-extension"));

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("index.ts");
	});

	it("loads a package from its package.json manifest without a module manifest", async () => {
		const subdir = path.join(extensionsDir, "my-package");
		fs.mkdirSync(path.join(subdir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(subdir, "src", "main.ts"),
			`export default function(volt) { volt.registerCommand("test", { handler: async () => {} }); }`,
		);
		writePackage(subdir, { id: "my-package", displayName: "My Package", entry: "src/main.ts" }, { version: "1.2.3" });

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		const [extension] = result.extensions;
		expect(extension.path).toBe(subdir);
		expect(extension.id).toBe("my-package");
		expect(extension.version).toBe("1.2.3");
		expect(extension.manifest).toEqual({ id: "my-package", displayName: "My Package", entry: "src/main.ts" });
		expect(extension.commands.has("test")).toBe(true);
	});

	it("keeps a package entry with a leading tilde package-relative", async () => {
		const subdir = path.join(extensionsDir, "tilde-package");
		fs.mkdirSync(path.join(subdir, "~"), { recursive: true });
		fs.writeFileSync(path.join(subdir, "~", "entry.ts"), extensionCode("ignored"));
		writePackage(subdir, { id: "tilde-package", displayName: "Tilde", entry: "~/entry.ts" });

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions.map((extension) => extension.id)).toEqual(["tilde-package"]);
	});

	it("rejects the old volt.extensions list with a clear manifest error", async () => {
		const subdir = path.join(extensionsDir, "old-package");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "ext1.ts"), extensionCode("ext-1"));
		writePackage(subdir, { extensions: ["./ext1.ts"] });

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.extensions).toHaveLength(0);
		expect(result.errors).toEqual([
			{
				path: subdir,
				error: expect.stringMatching(/^Invalid extension manifest: "volt.extensions" is replaced by the manifest/),
			},
		]);
	});

	it("package.json with volt field takes precedence over index.ts", async () => {
		const subdir = path.join(extensionsDir, "my-package");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.ts"), extensionCodeWithTool("from-index"));
		fs.writeFileSync(path.join(subdir, "custom.ts"), extensionCodeWithTool("from-custom"));
		writePackage(subdir, { id: "my-package", displayName: "My Package", entry: "custom.ts" });

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].id).toBe("my-package");
		// Verify the right tool was registered
		expect(result.extensions[0].tools.has("from-custom")).toBe(true);
		expect(result.extensions[0].tools.has("from-index")).toBe(false);
	});

	it("ignores package.json without volt field, falls back to index.ts", async () => {
		const subdir = path.join(extensionsDir, "my-package");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "index.ts"), extensionCode("my-package"));
		fs.writeFileSync(
			path.join(subdir, "package.json"),
			JSON.stringify({
				name: "my-package",
				version: "1.0.0",
			}),
		);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("index.ts");
	});

	it("ignores subdirectory without index or package.json", async () => {
		const subdir = path.join(extensionsDir, "not-an-extension");
		fs.mkdirSync(subdir);
		fs.writeFileSync(path.join(subdir, "helper.ts"), extensionCode("helper"));
		fs.writeFileSync(path.join(subdir, "utils.ts"), extensionCode("utils"));

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(0);
	});

	it("does not recurse beyond one level", async () => {
		const subdir = path.join(extensionsDir, "container");
		const nested = path.join(subdir, "nested");
		fs.mkdirSync(subdir);
		fs.mkdirSync(nested);
		fs.writeFileSync(path.join(nested, "index.ts"), extensionCode("nested"));
		// No index.ts or package.json in container/

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(0);
	});

	it("handles mixed direct files and subdirectories", async () => {
		// Direct file
		fs.writeFileSync(path.join(extensionsDir, "direct.ts"), extensionCode("direct"));

		// Subdirectory with index
		const subdir1 = path.join(extensionsDir, "with-index");
		fs.mkdirSync(subdir1);
		fs.writeFileSync(path.join(subdir1, "index.ts"), extensionCode("with-index"));

		// Subdirectory with package.json
		const subdir2 = path.join(extensionsDir, "with-manifest");
		fs.mkdirSync(subdir2);
		fs.writeFileSync(path.join(subdir2, "entry.ts"), extensionCode("unused"));
		writePackage(subdir2, { id: "with-manifest", displayName: "With Manifest", entry: "entry.ts" });

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(3);
	});

	it("reports a package whose entry does not exist", async () => {
		const subdir = path.join(extensionsDir, "my-package");
		writePackage(subdir, { id: "my-package", displayName: "My Package", entry: "missing.ts" });

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.extensions).toHaveLength(0);
		expect(result.errors).toEqual([
			{ path: subdir, error: 'Invalid extension manifest: "entry" "missing.ts" does not exist in the package' },
		]);
	});

	it("loads extensions and registers commands", async () => {
		fs.writeFileSync(path.join(extensionsDir, "with-command.ts"), extensionCode("with-command"));

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("test")).toBe(true);
	});

	it("loads extensions and registers tools", async () => {
		fs.writeFileSync(path.join(extensionsDir, "with-tool.ts"), extensionCodeWithTool("my-tool"));

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].tools.has("my-tool")).toBe(true);
	});

	it("reports errors for invalid extension code", async () => {
		fs.writeFileSync(path.join(extensionsDir, "invalid.ts"), "this is not valid typescript export");

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toContain("invalid.ts");
		expect(result.extensions).toHaveLength(0);
	});

	it("handles explicitly configured paths", async () => {
		const customPath = path.join(tempDir, "custom-location", "my-ext.ts");
		fs.mkdirSync(path.dirname(customPath), { recursive: true });
		fs.writeFileSync(customPath, extensionCode("my-ext"));

		const result = await discoverAndLoadExtensions([customPath], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("my-ext.ts");
		expect(result.extensions[0].sourceInfo.scope).toBe("temporary");
	});

	it("resolves dependencies from extension's own node_modules", async () => {
		// Load extension that has its own package.json and node_modules with 'ms' package
		const extPath = path.resolve(__dirname, "../examples/extensions/with-deps");

		const result = await discoverAndLoadExtensions([extPath], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("with-deps");
		expect(result.extensions[0].id).toBe("with-deps");
		expect(result.extensions[0].version).toBe("0.2.3");
		// The extension registers a 'parse_duration' tool
		expect(result.extensions[0].tools.has("parse_duration")).toBe(true);
	});

	it("registers message renderers", async () => {
		const extCode = `
			export const manifest = { id: "with-renderer", displayName: "with-renderer" };
			export default function(volt) {
				volt.registerMessageRenderer("my-custom-type", (message, options, theme) => {
					return null; // Use default rendering
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "with-renderer.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].messageRenderers.has("my-custom-type")).toBe(true);
	});

	it("reports error when extension throws during initialization", async () => {
		const extCode = `
			export const manifest = { id: "throws", displayName: "throws" };
			export default function(volt) {
				throw new Error("Initialization failed!");
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "throws.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].error).toContain("Initialization failed!");
		expect(result.extensions).toHaveLength(0);
	});

	it("reports error when extension has no default export", async () => {
		const extCode = `
			export const manifest = { id: "no-default", displayName: "no-default" };
			export function notDefault(volt) {
				volt.registerCommand("test", { handler: async () => {} });
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "no-default.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].error).toContain("does not export a valid factory function");
		expect(result.extensions).toHaveLength(0);
	});

	it("allows multiple extensions to register different tools", async () => {
		fs.writeFileSync(path.join(extensionsDir, "tool-a.ts"), extensionCodeWithTool("tool-a"));
		fs.writeFileSync(path.join(extensionsDir, "tool-b.ts"), extensionCodeWithTool("tool-b"));

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(2);

		const allTools = new Set<string>();
		for (const ext of result.extensions) {
			for (const name of ext.tools.keys()) {
				allTools.add(name);
			}
		}
		expect(allTools.has("tool-a")).toBe(true);
		expect(allTools.has("tool-b")).toBe(true);
	});

	it("loads extension with event handlers", async () => {
		const extCode = `
			export const manifest = { id: "with-handlers", displayName: "with-handlers" };
			export default function(volt) {
				volt.on("agent_start", async () => {});
				volt.on("tool_call", async (event) => undefined);
				volt.on("agent_end", async () => {});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "with-handlers.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].handlers.has("agent_start")).toBe(true);
		expect(result.extensions[0].handlers.has("tool_call")).toBe(true);
		expect(result.extensions[0].handlers.has("agent_end")).toBe(true);
	});

	it("loads extension with shortcuts", async () => {
		const extCode = `
			export const manifest = { id: "with-shortcut", displayName: "with-shortcut" };
			export default function(volt) {
				volt.registerShortcut("ctrl+t", {
					description: "Test shortcut",
					intent: "noop",
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "with-shortcut.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].shortcuts.has("ctrl+t")).toBe(true);
	});

	it("loads extension with flags", async () => {
		const extCode = `
			export const manifest = { id: "with-flag", displayName: "with-flag" };
			export default function(volt) {
				volt.registerFlag("my-flag", {
					description: "My custom flag",
					handler: async (value) => {},
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "with-flag.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].flags.has("my-flag")).toBe(true);
	});

	it("loadExtensions only loads explicit paths without discovery", async () => {
		// Create discoverable extensions (would be found by discoverAndLoadExtensions)
		fs.writeFileSync(path.join(extensionsDir, "discovered.ts"), extensionCodeWithTool("discovered"));

		// Create explicit extension outside discovery path
		const explicitPath = path.join(tempDir, "explicit.ts");
		fs.writeFileSync(explicitPath, extensionCodeWithTool("explicit"));

		// Use loadExtensions directly to skip discovery
		const { loadExtensions } = await import("../src/core/extensions/loader.ts");
		const result = await loadExtensions([explicitPath], tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].tools.has("explicit")).toBe(true);
		expect(result.extensions[0].tools.has("discovered")).toBe(false);
	});

	it("loadExtensions with no paths loads nothing", async () => {
		// Create discoverable extensions (would be found by discoverAndLoadExtensions)
		fs.writeFileSync(path.join(extensionsDir, "discovered.ts"), extensionCode("discovered"));

		// Use loadExtensions directly with empty paths
		const { loadExtensions } = await import("../src/core/extensions/loader.ts");
		const result = await loadExtensions([], tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(0);
	});
});
