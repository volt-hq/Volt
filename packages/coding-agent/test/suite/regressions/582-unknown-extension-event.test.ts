import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	loadExtensionFromFactory,
} from "../../../src/core/extensions/loader.ts";
import { EXTENSION_EVENT_NAMES, type ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createTestResourceLoader, testExtension } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

/** Subscribes the way `.volt/extensions/prompt-url-widget.ts` did: `session_switch` is not an event. */
const SWITCH_LISTENER = `export const manifest = { id: "prompt-url-widget", displayName: "Prompt URL Widget" };
export default function (volt) {
	volt.on("session_start", () => {});
	volt.on("session_switch", () => {});
}
`;

const PROMPT_PROBE = `export const manifest = { id: "prompt-probe", displayName: "Prompt Probe" };
export default function (volt) {
	volt.on("before_agent_start", (event) => {
		volt.events.emit("probe", event.prompt);
	});
}
`;

/** `on()` as an untyped JavaScript extension sees it. */
function untypedOn(volt: ExtensionAPI): (event: string, handler: () => void) => unknown {
	return volt.on as (event: string, handler: () => void) => unknown;
}

describe("regression #582: on() rejects unknown event names at load", () => {
	const tempDirs: string[] = [];
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function project(extensions: Record<string, string>): { cwd: string; agentDir: string; paths: string[] } {
		const cwd = mkdtempSync(join(tmpdir(), "volt-582-"));
		tempDirs.push(cwd);
		const agentDir = join(cwd, "agent");
		const extensionDir = join(cwd, ".volt", "extensions");
		mkdirSync(agentDir);
		mkdirSync(extensionDir, { recursive: true });
		const paths = Object.entries(extensions).map(([name, source]) => {
			const path = join(extensionDir, name);
			writeFileSync(path, source);
			return path;
		});
		return { cwd, agentDir, paths };
	}

	it("fails a project extension's load with an error naming the extension's manifest id and the event", async () => {
		const { cwd, agentDir, paths } = project({ "prompt-url-widget.ts": SWITCH_LISTENER });

		const result = await discoverAndLoadExtensions([], cwd, agentDir);

		expect(result.extensions).toEqual([]);
		expect(result.errors).toEqual([
			{
				path: paths[0],
				error: "Failed to load extension: Extension 'prompt-url-widget' subscribes to unknown event 'session_switch'",
			},
		]);
	});

	it("reports an SDK extension factory that subscribes to an unknown event as a load error", async () => {
		const { cwd, agentDir } = project({});
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [
				testExtension("switch-listener", (volt) => {
					untypedOn(volt)("session_switch", () => {});
				}),
			],
		});

		await loader.reload();

		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getExtensions().errors).toEqual([
			{
				path: "<inline:1>",
				error: "Failed to load extension: Extension 'switch-listener' subscribes to unknown event 'session_switch'",
			},
		]);
	});

	it("subscribes to every event the API defines", async () => {
		const { cwd } = project({});
		const extension = await loadExtensionFromFactory(
			testExtension("every-event", (volt) => {
				for (const event of EXTENSION_EVENT_NAMES) untypedOn(volt)(event, () => {});
			}),
			cwd,
			createEventBus(),
			createExtensionRuntime(),
		);

		expect(EXTENSION_EVENT_NAMES).toContain("session_start");
		expect(EXTENSION_EVENT_NAMES).not.toContain("session_switch");
		for (const event of EXTENSION_EVENT_NAMES) expect(extension.handlers.has(event)).toBe(true);
	});

	it("runs the extensions that loaded and leaves out the one that subscribed to an unknown event", async () => {
		const { cwd, agentDir, paths } = project({
			"prompt-probe.ts": PROMPT_PROBE,
			"prompt-url-widget.ts": SWITCH_LISTENER,
		});
		const eventBus = createEventBus();
		const prompts: unknown[] = [];
		eventBus.on("probe", (prompt) => {
			prompts.push(prompt);
		});
		const extensionsResult = await discoverAndLoadExtensions([], cwd, agentDir, eventBus);
		expect(extensionsResult.extensions.map((extension) => extension.path)).toEqual([paths[0]]);
		expect(extensionsResult.errors.map((error) => error.path)).toEqual([paths[1]]);

		const harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("hello");

		expect(prompts).toEqual(["hello"]);
	});
});
