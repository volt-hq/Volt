/**
 * Tests for ExtensionRunner - conflict detection, error handling, tool wrapping.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime, discoverAndLoadExtensions, loadExtensions } from "../src/core/extensions/loader.ts";
import {
	ExtensionMessageRoleMismatchError,
	ExtensionRunner,
	emitProjectTrustEvent,
} from "../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionUIContext,
	ProviderConfig,
} from "../src/core/extensions/types.ts";
import { KeybindingsManager, type KeyId } from "../src/core/keybindings.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("ExtensionRunner", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	const defaultKeybindings = new KeybindingsManager().getEffectiveConfig();

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "volt-runner-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = ModelRegistry.create(authStorage);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const providerModelConfig: ProviderConfig = {
		baseUrl: "https://provider.test/v1",
		apiKey: "provider-test-key",
		api: "openai-completions",
		promptCache: {
			modes: ["explicit"],
			retention: { short: { ttlSeconds: 300 } },
		},
		models: [
			{
				id: "instant-model",
				name: "Instant Model",
				reasoning: false,
				input: ["text"],
				promptCache: {
					modes: ["implicit"],
					retention: { short: {} },
				},
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	};

	const extensionActions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: async () => {},
		setSessionName: async () => {},
		getSessionName: () => undefined,
		setLabel: async () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};

	const extensionContextActions: ExtensionContextActions = {
		getModel: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};

	describe("project_trust", () => {
		it("continues past undecided handlers and returns the first yes/no decision", async () => {
			const undecidedPath = path.join(extensionsDir, "undecided.ts");
			const decidedPath = path.join(extensionsDir, "decided.ts");
			fs.writeFileSync(
				undecidedPath,
				`export const manifest = { id: "undecided", displayName: "undecided" };
export default function(volt) {
	volt.on("project_trust", () => ({ trusted: "undecided", remember: true }));
}`,
			);
			fs.writeFileSync(
				decidedPath,
				`export const manifest = { id: "decided", displayName: "decided" };
export default function(volt) {
	volt.on("project_trust", () => ({ trusted: "no", remember: true }));
}`,
			);

			const extensionsResult = await loadExtensions([undecidedPath, decidedPath], tempDir);
			const result = await emitProjectTrustEvent(
				extensionsResult,
				{ type: "project_trust", cwd: tempDir },
				{
					cwd: tempDir,
					mode: "tui",
					hasUI: false,
					ui: {
						select: async () => undefined,
						confirm: async () => false,
						input: async () => undefined,
						notify: () => {},
					},
				},
			);

			expect(result.result).toEqual({ trusted: "no", remember: true });
			expect(result.errors).toEqual([]);
		});
	});

	describe("shortcut conflicts", () => {
		it("warns when extension shortcut conflicts with built-in", async () => {
			const extCode = `
				export const manifest = { id: "conflict", displayName: "conflict" };
				export default function(volt) {
					volt.registerShortcut("ctrl+c", {
						description: "Conflicts with built-in",
						intent: "noop",
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+c")).toBe(false);

			warnSpy.mockRestore();
		});

		it.each([
			{
				name: "default binding",
				shortcut: "alt+p" as KeyId,
				keybindings: defaultKeybindings,
			},
			{
				name: "remapped binding",
				shortcut: "ctrl+shift+x" as KeyId,
				keybindings: {
					...defaultKeybindings,
					"app.plan.togglePane": "ctrl+shift+x" as KeyId,
				},
			},
		])("blocks extension conflicts with the plan-pane action using the $name", async ({ shortcut, keybindings }) => {
			const extensionPath = path.join(extensionsDir, "plan-pane-conflict.ts");
			fs.writeFileSync(
				extensionPath,
				`export const manifest = { id: "plan-pane-conflict", displayName: "plan-pane-conflict" };
export default function(volt) {
	volt.registerShortcut("${shortcut}", {
		description: "Conflicts with global plan-pane toggle",
		intent: "noop",
	});
}`,
			);
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(keybindings);
			const message = `Extension shortcut '${shortcut}' from extension plan-pane-conflict conflicts with built-in shortcut. Skipping.`;

			expect(shortcuts.has(shortcut)).toBe(false);
			expect(runner.getShortcutDiagnostics()).toEqual([
				{
					type: "warning",
					message,
					path: extensionPath,
				},
			]);
			expect(warnSpy).toHaveBeenCalledWith(message);

			warnSpy.mockRestore();
		});

		it("allows a shortcut when the reserved set no longer contains the default key", async () => {
			const extCode = `
				export const manifest = { id: "rebinding", displayName: "rebinding" };
				export default function(volt) {
					volt.registerShortcut("ctrl+p", {
						description: "Uses freed default",
						intent: "noop",
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "rebinding.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.model.cycleForward": "ctrl+n" as KeyId };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(shortcuts.has("ctrl+p")).toBe(true);
			expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));

			warnSpy.mockRestore();
		});

		it("warns but allows when extension uses non-reserved built-in shortcut", async () => {
			const pasteImageKey = Array.isArray(defaultKeybindings["app.clipboard.pasteImage"])
				? (defaultKeybindings["app.clipboard.pasteImage"][0] ?? "")
				: defaultKeybindings["app.clipboard.pasteImage"];
			const extCode = `
				export const manifest = { id: "non-reserved", displayName: "non-reserved" };
				export default function(volt) {
					volt.registerShortcut("${pasteImageKey}", {
						description: "Overrides non-reserved",
						intent: "noop",
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "non-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("built-in shortcut for app.clipboard.pasteImage"),
			);
			expect(shortcuts.has(pasteImageKey as KeyId)).toBe(true);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts for reserved actions even when rebound", async () => {
			const extCode = `
				export const manifest = { id: "rebound-reserved", displayName: "rebound-reserved" };
				export default function(volt) {
					volt.registerShortcut("ctrl+x", {
						description: "Conflicts with rebound reserved",
						intent: "noop",
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "rebound-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.interrupt": "ctrl+x" as KeyId };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+x")).toBe(false);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts when reserved key is also bound to non-reserved actions", async () => {
			const extCode = `
				export const manifest = { id: "shared-reserved", displayName: "shared-reserved" };
				export default function(volt) {
					volt.registerShortcut("ctrl+p", {
						description: "Conflicts with shared reserved default",
						intent: "noop",
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "shared-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+p")).toBe(false);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts when reserved action has multiple keys", async () => {
			const extCode = `
				export const manifest = { id: "multi-reserved", displayName: "multi-reserved" };
				export default function(volt) {
					volt.registerShortcut("ctrl+y", {
						description: "Conflicts with multi-key reserved",
						intent: "noop",
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "multi-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.clear": ["ctrl+x", "ctrl+y"] as KeyId[] };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+y")).toBe(false);

			warnSpy.mockRestore();
		});

		it("warns but allows when non-reserved action has multiple keys", async () => {
			const extCode = `
				export const manifest = { id: "multi-non-reserved", displayName: "multi-non-reserved" };
				export default function(volt) {
					volt.registerShortcut("ctrl+y", {
						description: "Overrides multi-key non-reserved",
						intent: "noop",
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "multi-non-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.clipboard.pasteImage": ["ctrl+x", "ctrl+y"] as KeyId[] };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("built-in shortcut for app.clipboard.pasteImage"),
			);
			expect(shortcuts.has("ctrl+y")).toBe(true);

			warnSpy.mockRestore();
		});

		it("warns when two extensions register same shortcut", async () => {
			// Use a non-reserved shortcut
			const extCode1 = `
				export const manifest = { id: "ext1", displayName: "ext1" };
				export default function(volt) {
					volt.registerShortcut("ctrl+shift+x", {
						description: "First extension",
						intent: "noop",
					});
				}
			`;
			const extCode2 = `
				export const manifest = { id: "ext2-2", displayName: "ext2-2" };
				export default function(volt) {
					volt.registerShortcut("ctrl+shift+x", {
						description: "Second extension",
						intent: "noop",
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "ext1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "ext2.ts"), extCode2);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("shortcut conflict"));
			// Last one wins
			expect(shortcuts.has("ctrl+shift+x")).toBe(true);

			warnSpy.mockRestore();
		});
	});

	describe("tool collection", () => {
		it("collects tools from multiple extensions", async () => {
			const toolCode = (name: string) => `
				import { Type } from "typebox";
				export const manifest = { id: "${name.replace("_", "-")}", displayName: "${name}" };
				export default function(volt) {
					volt.registerTool({
						name: "${name}",
						label: "${name}",
						description: "Test tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-a.ts"), toolCode("tool_a"));
			fs.writeFileSync(path.join(extensionsDir, "tool-b.ts"), toolCode("tool_b"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const tools = runner.getAllRegisteredTools();

			expect(tools.length).toBe(2);
			expect(tools.map((t) => t.definition.name).sort()).toEqual(["tool_a", "tool_b"]);
		});

		it("keeps first tool when two extensions register the same name", async () => {
			const first = `
				import { Type } from "typebox";
				export const manifest = { id: "a-first", displayName: "a-first" };
				export default function(volt) {
					volt.registerTool({
						name: "shared",
						label: "shared",
						description: "first",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			const second = `
				import { Type } from "typebox";
				export const manifest = { id: "b-second-2", displayName: "b-second-2" };
				export default function(volt) {
					volt.registerTool({
						name: "shared",
						label: "shared",
						description: "second",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-first.ts"), first);
			fs.writeFileSync(path.join(extensionsDir, "b-second.ts"), second);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const tools = runner.getAllRegisteredTools();

			expect(tools).toHaveLength(1);
			expect(tools[0]?.definition.description).toBe("first");
		});
	});

	describe("command collection", () => {
		it("collects commands from multiple extensions", async () => {
			const cmdCode = (name: string) => `
				export const manifest = { id: "${name}", displayName: "${name}" };
				export default function(volt) {
					volt.registerCommand("${name}", {
						description: "Test command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd-a.ts"), cmdCode("cmd-a"));
			fs.writeFileSync(path.join(extensionsDir, "cmd-b.ts"), cmdCode("cmd-b"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const commands = runner.getRegisteredCommands();

			expect(commands.length).toBe(2);
			expect(commands.map((c) => c.name).sort()).toEqual(["cmd-a", "cmd-b"]);
			expect(commands.map((c) => c.invocationName).sort()).toEqual(["cmd-a", "cmd-b"]);
		});

		it("gets command by invocation name", async () => {
			const cmdCode = `
				export const manifest = { id: "cmd", displayName: "cmd" };
				export default function(volt) {
					volt.registerCommand("my-cmd", {
						description: "My command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd.ts"), cmdCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const cmd = runner.getCommand("my-cmd");
			expect(cmd).toBeDefined();
			expect(cmd?.name).toBe("my-cmd");
			expect(cmd?.invocationName).toBe("my-cmd");
			expect(cmd?.description).toBe("My command");

			const missing = runner.getCommand("not-exists");
			expect(missing).toBeUndefined();
		});

		it("gives a later extension's command with a taken name an alias under its id", async () => {
			const cmdCode = (id: string, description: string) => `
				export const manifest = { id: "${id}", displayName: "${id}" };
				export default function(volt) {
					volt.registerCommand("shared-cmd", {
						description: "${description}",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd-a.ts"), cmdCode("cmd-a", "First command"));
			fs.writeFileSync(path.join(extensionsDir, "cmd-b.ts"), cmdCode("cmd-b", "Second command"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const commands = runner.getRegisteredCommands();
			const diagnostics = runner.getCommandDiagnostics();

			expect(commands).toHaveLength(2);
			expect(commands.map((command) => command.name)).toEqual(["shared-cmd", "shared-cmd"]);
			expect(commands.map((command) => command.invocationName)).toEqual(["shared-cmd", "cmd-b:shared-cmd"]);
			expect(commands.map((command) => command.extensionId)).toEqual(["cmd-a", "cmd-b"]);
			expect(commands.map((command) => command.description)).toEqual(["First command", "Second command"]);
			expect(diagnostics).toEqual([
				{
					type: "warning",
					message:
						"Extension command '/shared-cmd' from extension cmd-b conflicts with extension cmd-a. Available as '/cmd-b:shared-cmd'.",
					path: path.join(extensionsDir, "cmd-b.ts"),
				},
			]);
			expect(runner.getCommand("shared-cmd")?.description).toBe("First command");
			expect(runner.getCommand("cmd-b:shared-cmd")?.description).toBe("Second command");
		});

		it("refuses a command name that would take another extension's alias", async () => {
			const cmdCode = (id: string, name: string) => `
				export const manifest = { id: "${id}", displayName: "${id}" };
				export default function(volt) {
					volt.registerCommand("${name}", { handler: async () => {} });
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a.ts"), cmdCode("squatter", "go"));
			fs.writeFileSync(path.join(extensionsDir, "b.ts"), cmdCode("squatter-2", "victim:go"));
			fs.writeFileSync(path.join(extensionsDir, "c.ts"), cmdCode("victim", "go"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			expect(result.errors).toEqual([
				{
					path: path.join(extensionsDir, "b.ts"),
					error: expect.stringContaining('Invalid extension command name "victim:go"'),
				},
			]);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const commands = runner.getRegisteredCommands();

			expect(commands.map((command) => [command.extensionId, command.invocationName])).toEqual([
				["squatter", "go"],
				["victim", "victim:go"],
			]);
			expect(runner.getCommand("victim:go")?.extensionId).toBe("victim");
		});
	});

	describe("context creation", () => {
		it("exposes the current abort signal on ExtensionContext", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const controller = new AbortController();

			runner.bindCore(extensionActions, {
				...extensionContextActions,
				getSignal: () => controller.signal,
			});

			const ctx = runner.createContext();
			expect(ctx.signal).toBe(controller.signal);
			expect(ctx.signal?.aborted).toBe(false);

			controller.abort();
			expect(ctx.signal?.aborted).toBe(true);
		});

		it("exposes print mode and hasUI false by default", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, extensionContextActions);

			const ctx = runner.createContext();
			expect(ctx.mode).toBe("print");
			expect(ctx.hasUI).toBe(false);
		});

		it("exposes project trust state on ExtensionContext", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, {
				...extensionContextActions,
				isProjectTrusted: () => false,
			});

			const ctx = runner.createContext();
			expect(ctx.isProjectTrusted()).toBe(false);
		});

		it("exposes rpc mode with hasUI true when an RPC UI context is provided", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, extensionContextActions);
			runner.setUIContext({} as ExtensionUIContext, "rpc");

			const ctx = runner.createContext();
			expect(ctx.mode).toBe("rpc");
			expect(ctx.hasUI).toBe(true);
		});

		it("exposes tui mode with hasUI true when a TUI UI context is provided", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, extensionContextActions);
			runner.setUIContext({} as ExtensionUIContext, "tui");

			const ctx = runner.createContext();
			expect(ctx.mode).toBe("tui");
			expect(ctx.hasUI).toBe(true);
		});
	});

	describe("error handling", () => {
		it("calls error listeners when handler throws", async () => {
			const extCode = `
				export const manifest = { id: "throws", displayName: "throws" };
				export default function(volt) {
					volt.on("context", async () => {
						throw new Error("Handler error!");
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "throws.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const errors: Array<{ extensionId: string; event: string; error: string }> = [];
			runner.onError((err) => {
				errors.push(err);
			});

			// Emit context event which will trigger the throwing handler
			await runner.emitContext([]);

			expect(errors.length).toBe(1);
			expect(errors[0].error).toContain("Handler error!");
			expect(errors[0].event).toBe("context");
		});

		it("rejects a message_end replacement that crosses message roles", async () => {
			const extensionPath = path.join(extensionsDir, "role-change.ts");
			fs.writeFileSync(
				extensionPath,
				`export const manifest = { id: "role-change", displayName: "role-change" };
export default function(volt) {
	volt.on("message_end", () => ({
		message: { role: "assistant", content: [], timestamp: Date.now() },
	}));
}`,
			);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: Array<{ extensionId: string; event: string; error: string }> = [];
			runner.onError((error) => errors.push(error));
			const original = {
				role: "user" as const,
				content: [{ type: "text" as const, text: "original" }],
				timestamp: Date.now(),
			};

			await expect(runner.emitMessageEnd({ type: "message_end", message: original })).rejects.toMatchObject({
				code: "extension_message_role_mismatch",
				extensionId: "role-change",
				expectedRole: "user",
				receivedRole: "assistant",
			});
			runner.onError(() => {
				throw new Error("diagnostic observer failed");
			});
			await expect(runner.emitMessageEnd({ type: "message_end", message: original })).rejects.toBeInstanceOf(
				ExtensionMessageRoleMismatchError,
			);
			expect(errors).toHaveLength(2);
			expect(errors[0]).toMatchObject({ extensionId: "role-change", event: "message_end" });
		});
	});

	describe("message renderers", () => {
		it("gets message renderer by type", async () => {
			const extCode = `
				export const manifest = { id: "renderer", displayName: "renderer" };
				export default function(volt) {
					volt.registerMessageRenderer("my-type", (message, options, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "renderer.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const renderer = runner.getMessageRenderer("my-type");
			expect(renderer).toBeDefined();

			const missing = runner.getMessageRenderer("not-exists");
			expect(missing).toBeUndefined();
		});
	});

	describe("flags", () => {
		it("collects flags from extensions", async () => {
			const extCode = `
				export const manifest = { id: "with-flag", displayName: "with-flag" };
				export default function(volt) {
					volt.registerFlag("my-flag", {
						description: "My flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "with-flag.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const flags = runner.getFlags();

			expect(flags.has("my-flag")).toBe(true);
		});

		it("keeps first flag when two extensions register the same name", async () => {
			const first = `
				export const manifest = { id: "a-first", displayName: "a-first" };
				export default function(volt) {
					volt.registerFlag("shared-flag", {
						description: "first",
						type: "boolean",
						default: true,
					});
				}
			`;
			const second = `
				export const manifest = { id: "b-second", displayName: "b-second" };
				export default function(volt) {
					volt.registerFlag("shared-flag", {
						description: "second",
						type: "boolean",
						default: false,
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-first.ts"), first);
			fs.writeFileSync(path.join(extensionsDir, "b-second.ts"), second);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const flags = runner.getFlags();

			expect(flags.get("shared-flag")?.description).toBe("first");
			expect(result.runtime.flagValues.get("shared-flag")).toBe(true);
		});

		it("can set flag values", async () => {
			const extCode = `
				export const manifest = { id: "flag", displayName: "flag" };
				export default function(volt) {
					volt.registerFlag("test-flag", {
						description: "Test flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "flag.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			// Setting a flag value should not throw
			runner.setFlagValue("--test-flag", true);

			// The flag values are stored in the shared runtime
			expect(result.runtime.flagValues.get("--test-flag")).toBe(true);
		});
	});

	describe("before_agent_start", () => {
		it("keeps ctx.getSystemPrompt() in sync with chained system prompt updates", async () => {
			const extCode1 = `
				export const manifest = { id: "before-agent-start-1", displayName: "before-agent-start-1" };
				export default function(volt) {
					volt.on("before_agent_start", async (_event, ctx) => {
						return {
							systemPrompt: ctx.getSystemPrompt() + "\\nfirst",
						};
					});
				}
			`;
			const extCode2 = `
				export const manifest = { id: "before-agent-start-2", displayName: "before-agent-start-2" };
				export default function(volt) {
					volt.on("before_agent_start", async (_event, ctx) => {
						return {
							systemPrompt: ctx.getSystemPrompt() + "\\nsecond",
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "before-agent-start-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "before-agent-start-2.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(2);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(error.error));
			runner.bindCore(extensionActions, extensionContextActions);

			const chained = await runner.emitBeforeAgentStart("hello", undefined, "base", {
				cwd: tempDir,
			});

			expect(errors).toEqual([]);

			expect(chained).toEqual({
				messages: undefined,
				systemPrompt: "base\nfirst\nsecond",
			});
		});
	});

	describe("tool_result chaining", () => {
		it("chains content modifications across handlers", async () => {
			const extCode1 = `
				export const manifest = { id: "tool-result-1", displayName: "tool-result-1" };
				export default function(volt) {
					volt.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext1" }],
						};
					});
				}
			`;
			const extCode2 = `
				export const manifest = { id: "tool-result-2", displayName: "tool-result-2" };
				export default function(volt) {
					volt.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext2" }],
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-2.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-1",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toBeDefined();
			const chainedContent = chained?.content;
			expect(chainedContent).toBeDefined();
			expect(chainedContent![0]).toEqual({ type: "text", text: "base" });
			expect(chainedContent).toHaveLength(3);
			const appendedText = chainedContent!
				.slice(1)
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text);
			expect(appendedText.sort()).toEqual(["ext1", "ext2"]);
		});

		it("preserves previous modifications when later handlers return partial patches", async () => {
			const extCode1 = `
				export const manifest = { id: "tool-result-partial-1", displayName: "tool-result-partial-1" };
				export default function(volt) {
					volt.on("tool_result", async () => {
						return {
							content: [{ type: "text", text: "first" }],
							details: { source: "ext1" },
						};
					});
				}
			`;
			const extCode2 = `
				export const manifest = { id: "tool-result-partial-2", displayName: "tool-result-partial-2" };
				export default function(volt) {
					volt.on("tool_result", async () => {
						return {
							isError: true,
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-2.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-2",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toEqual({
				content: [{ type: "text", text: "first" }],
				details: { source: "ext1" },
				isError: true,
			});
		});
	});

	describe("provider registration", () => {
		it("bindCore ignores invalid queued registrations and reports extension error", () => {
			const runtime = createExtensionRuntime();
			runtime.registerProvider(
				"broken-provider",
				{
					streamSimple: (() => {
						throw new Error("should not run");
					}) as any,
				},
				"broken-extension",
			);

			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(`${error.extensionId}: ${error.error}`));

			expect(() => runner.bindCore(extensionActions, extensionContextActions)).not.toThrow();
			expect(errors).toEqual([
				'broken-extension: Provider broken-provider: "api" is required when registering streamSimple.',
			]);
			expect(() => modelRegistry.refresh()).not.toThrow();
		});

		it("pre-bind unregister removes all queued registrations for a provider", () => {
			const runtime = createExtensionRuntime();

			runtime.registerProvider("queued-provider", providerModelConfig);
			runtime.registerProvider("queued-provider", {
				...providerModelConfig,
				models: [
					{
						id: "instant-model-2",
						name: "Instant Model 2",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});
			expect(runtime.pendingProviderRegistrations).toHaveLength(2);

			runtime.unregisterProvider("queued-provider");
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);
		});

		it("post-bind register and unregister take effect immediately", () => {
			const runtime = createExtensionRuntime();
			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);

			runner.bindCore(extensionActions, extensionContextActions);
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);

			runtime.registerProvider("instant-provider", providerModelConfig);
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);
			expect(modelRegistry.find("instant-provider", "instant-model")?.promptCache).toEqual({
				modes: ["implicit"],
				retention: { short: {} },
			});

			runtime.registerProvider("anthropic", { promptCache: null });
			expect(modelRegistry.find("anthropic", "claude-sonnet-4-5")?.promptCache).toBeUndefined();

			runtime.unregisterProvider("instant-provider");
			expect(modelRegistry.find("instant-provider", "instant-model")).toBeUndefined();
		});
	});

	describe("command context", () => {
		it("passes fork options through to the bound handler", async () => {
			const runtime = createExtensionRuntime();
			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);
			const fork = vi.fn(async () => ({ cancelled: false as const, sessionId: "forked", seeded: false }));

			runner.bindCommandContext({
				waitForIdle: async () => {},
				newSession: async () => ({ cancelled: true }),
				fork,
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: true }),
				reload: async () => {},
			});

			const commandContext = runner.createCommandContext();
			await commandContext.fork("entry-1");
			expect(fork).toHaveBeenCalledWith("entry-1", undefined);

			await commandContext.fork("entry-2", { position: "at" });
			expect(fork).toHaveBeenLastCalledWith("entry-2", { position: "at" });
		});
	});

	describe("hasHandlers", () => {
		it("returns true when handlers exist for event type", async () => {
			const extCode = `
				export const manifest = { id: "handler", displayName: "handler" };
				export default function(volt) {
					volt.on("tool_call", async () => undefined);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "handler.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			expect(runner.hasHandlers("tool_call")).toBe(true);
			expect(runner.hasHandlers("agent_end")).toBe(false);
		});
	});
});
