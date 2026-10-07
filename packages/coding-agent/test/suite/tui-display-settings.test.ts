/**
 * The TUI reads its own display settings, themes, and startup notices
 * through its protocol client (architecture rewrite Phase 6, slice 10): its
 * settings where the conversation it shows runs (`conversation_info`'s cwd
 * and project trust, the `settings` profile), following a move into another
 * project and a profile switch; the themes the `resources` query lists; and
 * the model scope under the startup header. Its host closes the language
 * server traces of its conversations as the process exits.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueryResult } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionReference } from "../../src/core/session-manager.ts";
import type { SettingsManager } from "../../src/core/settings-manager.ts";
import { getCurrentThemeName } from "../../src/core/theme/runtime.ts";
import type { TuiSettingsScope } from "../../src/modes/interactive/interactive-mode.ts";
import { createTuiHarness, type TuiHarness, type TuiHarnessOptions, waitForScreen } from "./tui-harness.ts";

type ModeAccess = {
	settingsManager: SettingsManager;
	settingsScope: TuiSettingsScope;
	showModelScope(catalog: QueryResult<"models"> | undefined): void;
};

const SETTINGS = { theme: "dark", quietStartup: true, lsp: { enabled: false }, compaction: { enabled: false } };

const harnesses: TuiHarness[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function start(options: TuiHarnessOptions = {}) {
	const { globalSettings, ...harnessOptions } = options;
	const harness = await createTuiHarness({ globalSettings: { ...SETTINGS, ...globalSettings }, ...harnessOptions });
	harnesses.push(harness);
	const tui = await harness.startMode({ columns: 110, rows: 40 });
	return { harness, tui, access: tui.mode as unknown as ModeAccess };
}

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "volt-tui-display-"));
	directories.push(directory);
	return directory;
}

/** Store a session of `cwd` in the TUI's session directory, with one user message. */
async function storeSession(harness: TuiHarness, cwd: string): Promise<SessionReference> {
	const manager = await SessionManager.create(cwd, harness.sessionDir);
	await manager.logWriter.appendMessage({ role: "user", content: "a question there", timestamp: Date.now() });
	const ref = manager.getSessionRef();
	if (!ref) throw new Error("The session is not stored");
	await manager.closePersistence();
	return ref;
}

describe("the TUI's display settings through its client", () => {
	it("reads them where the conversation runs, and follows a move into another project", async () => {
		const { harness, tui, access } = await start();
		expect(access.settingsScope).toEqual({ cwd: harness.startup.cwd, projectTrusted: true });
		expect(access.settingsManager.getEditorPaddingX()).toBe(0);

		const other = temporaryDirectory();
		mkdirSync(join(other, ".volt"));
		writeFileSync(join(other, ".volt", "settings.json"), JSON.stringify({ editorPaddingX: 2 }));
		const ref = await storeSession(harness, other);
		expect(await tui.resume(ref)).toMatchObject({ cancelled: false });

		await vi.waitFor(() => expect(access.settingsScope.cwd).toBe(other));
		expect(access.settingsScope.projectTrusted).toBe(true);
		expect(access.settingsManager.getEditorPaddingX()).toBe(2);
		const info = await tui.store.client.query("conversation_info");
		expect(info).toMatchObject({ cwd: other, projectTrusted: true });
	});

	it("keeps to its own trust decision when its host runs elsewhere, not the host's (Phase 6 D4)", async () => {
		const harness = await createTuiHarness({ globalSettings: SETTINGS });
		harnesses.push(harness);
		vi.stubEnv("VOLT_CODING_AGENT_DIR", harness.tempDir);
		const tui = await harness.startMode({
			columns: 110,
			rows: 40,
			projectTrust: { cwd: harness.startup.cwd, trusted: true },
		});
		const access = tui.mode as unknown as ModeAccess;
		const other = temporaryDirectory();
		mkdirSync(join(other, ".volt"));
		writeFileSync(join(other, ".volt", "settings.json"), JSON.stringify({ editorPaddingX: 2 }));
		const ref = await storeSession(harness, other);
		expect(await tui.resume(ref)).toMatchObject({ cancelled: false });

		await vi.waitFor(() => expect(access.settingsScope.cwd).toBe(other));
		// The host trusts the project; nothing the TUI decided or saved does.
		expect(await tui.store.client.query("conversation_info")).toMatchObject({ cwd: other, projectTrusted: true });
		expect(access.settingsScope.projectTrusted).toBe(false);
		expect(access.settingsManager.getEditorPaddingX()).toBe(0);
	});

	it("follows the settings profile a switch moves the conversation to", async () => {
		const { tui, access } = await start();
		expect(access.settingsScope.profile).toBeUndefined();

		await tui.store.client.intent("set_profile", { name: "work", create: true });

		await vi.waitFor(() => expect(access.settingsScope.profile).toBe("work"));
		expect((await tui.store.client.query("settings")).profile).toBe("work");
	});

	it("registers the themes the conversation lists, and applies the one its settings name", async () => {
		const themes = temporaryDirectory();
		const themePath = join(themes, "listed.json");
		const dark = JSON.parse(readFileSync(new URL("../../src/core/theme/dark.json", import.meta.url), "utf8"));
		writeFileSync(themePath, JSON.stringify({ ...dark, name: "listed-theme" }));
		const { tui } = await start({ themePaths: [themePath], globalSettings: { theme: "listed-theme" } });

		const resources = await tui.store.client.query("resources");
		expect(resources.themes).toContainEqual(expect.objectContaining({ name: "listed-theme", path: themePath }));
		await vi.waitFor(() => expect(getCurrentThemeName()).toBe("listed-theme"));
	});

	it("shows the models the cycle keys step through under the startup header", async () => {
		const { tui, access } = await start({
			models: [
				{ id: "faux-1", reasoning: false },
				{ id: "faux-2", reasoning: false },
			],
			globalSettings: { quietStartup: false },
		});
		const { models } = await tui.store.client.query("models");
		const provider = models[0]?.provider ?? "";
		await tui.store.client.intent("set_model_scope", {
			models: [
				{ provider, modelId: "faux-2", thinkingLevel: "off" },
				{ provider, modelId: "faux-1" },
			],
		});

		access.showModelScope(await tui.store.client.query("models"));
		await waitForScreen(tui, "Model scope: faux-2:off, faux-1");
	});
});

describe("the TUI's host", () => {
	it("closes the language server traces of its conversations as the process exits, until it is disposed", async () => {
		const before = new Set(process.listeners("exit"));
		const { harness } = await start();
		const close = vi.spyOn(harness.connector.conversation.session, "closeLspTraceSync");
		const added = process.listeners("exit").filter((listener) => !before.has(listener));
		expect(added).toHaveLength(1);
		for (const listener of added) (listener as () => void)();
		expect(close).toHaveBeenCalledOnce();

		await harness.connector.dispose();
		for (const listener of added) expect(process.listeners("exit")).not.toContain(listener);
	});
});
