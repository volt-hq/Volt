/**
 * Extension settings (RFC §8.2): the manifest's settings schema (TypeBox
 * output read as written, deeper checks), stored values under
 * `extensions.<id>.settings` (scopes, trust, profiles, prototype keys, the
 * 16 KB bound), the settings form, and the runtime that serves
 * `volt.settings` and reports changes.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_SETTINGS_MAX_SERIALIZED_BYTES, type ExtensionSettings } from "@hansjm10/volt-protocol";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { defineManifest, ExtensionManifestError, validateManifest } from "../src/core/extensions/manifest.ts";
import {
	checkSettingsValues,
	ExtensionSettingsError,
	type ExtensionSettingsOf,
	ExtensionSettingsRuntime,
	effectiveSettings,
	extensionSettingsView,
	namesCredential,
	readStoredSettings,
	settingsFormFields,
	storeExtensionSettings,
} from "../src/core/extensions/settings.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

const SETTINGS = {
	type: "object",
	properties: {
		organization: { type: "string", title: "Organization", minLength: 1, maxLength: 64, pattern: "[a-z][a-z0-9-]*" },
		mode: { type: "string", enum: ["fast", "careful"], default: "fast" },
		verbose: { type: "boolean", default: false },
		maxLoops: { type: "integer", minimum: 1, maximum: 10, default: 3 },
	},
	required: ["organization"],
} satisfies ExtensionSettings;

function manifestWith(settings: unknown): unknown {
	return { id: "demo", displayName: "Demo", settings };
}

function manifestError(settings: unknown): string {
	try {
		validateManifest(manifestWith(settings), { package: false });
	} catch (error) {
		expect(error).toBeInstanceOf(ExtensionManifestError);
		return (error as Error).message;
	}
	throw new Error("Expected the manifest to be refused");
}

describe("extension settings schema", () => {
	it("accepts TypeBox objects and reads string literal unions and untyped enums as string enums", () => {
		const manifest = validateManifest(
			manifestWith(
				Type.Object({
					organization: Type.String({ minLength: 1 }),
					mode: Type.Union([Type.Literal("fast"), Type.Literal("careful")], { default: "fast" }),
					region: Type.Enum(["eu", "us"]),
					only: Type.Literal("one"),
					retries: Type.Optional(Type.Integer({ minimum: 0 })),
				}),
			),
			{ package: false },
		);
		expect(manifest.settings).toEqual({
			type: "object",
			required: ["organization", "mode", "region", "only"],
			properties: {
				organization: { type: "string", minLength: 1 },
				mode: { type: "string", enum: ["fast", "careful"], default: "fast" },
				region: { type: "string", enum: ["eu", "us"] },
				only: { type: "string", enum: ["one"] },
				retries: { type: "integer", minimum: 0 },
			},
		});
	});

	it("refuses unions of anything but string literals, nested objects, and numbers", () => {
		expect(
			manifestError({
				type: "object",
				properties: { level: { anyOf: [{ const: "a" }, { const: 1 }] } },
			}),
		).toContain("settings");
		expect(manifestError({ type: "object", properties: { nested: { type: "object", properties: {} } } })).toContain(
			"settings",
		);
		expect(manifestError({ type: "object", properties: { ratio: { type: "number" } } })).toContain("settings");
	});

	it("checks defaults, bounds, patterns, required names, and credential names", () => {
		expect(
			manifestError({ type: "object", properties: { mode: { type: "string", enum: ["a"], default: "b" } } }),
		).toBe('settings.properties.mode.default must be one of "a"');
		expect(
			manifestError({ type: "object", properties: { count: { type: "integer", minimum: 5, maximum: 1 } } }),
		).toBe("settings.properties.count.minimum is greater than its maximum");
		expect(manifestError({ type: "object", properties: { count: { type: "integer", default: 2 ** 60 } } })).toBe(
			"settings.properties.count.default is not a safe integer",
		);
		expect(
			manifestError({ type: "object", properties: { count: { type: "integer", minimum: 1, default: 0 } } }),
		).toBe("settings.properties.count.default must be at least 1");
		expect(
			manifestError({ type: "object", properties: { name: { type: "string", minLength: 4, maxLength: 2 } } }),
		).toBe("settings.properties.name.minLength is greater than its maxLength");
		expect(
			manifestError({ type: "object", properties: { name: { type: "string", pattern: "x", default: "y" } } }),
		).toBe("settings.properties.name.default must match its pattern");
		expect(manifestError({ type: "object", properties: { name: { type: "string", pattern: "(a+)+" } } })).toContain(
			"settings.properties.name.pattern is not a pattern every client can test cheaply",
		);
		expect(manifestError({ type: "object", properties: { name: { type: "string", pattern: "(" } } })).toContain(
			"cheaply",
		);
		expect(
			manifestError({ type: "object", properties: { name: { type: "string", pattern: "a+", maxLength: 1000 } } }),
		).toContain("maxLength exceeds 256");
		expect(manifestError({ type: "object", properties: { name: { type: "string" } }, required: ["other"] })).toBe(
			'settings.required names "other", which is not declared',
		);
		expect(manifestError({ type: "object", properties: { apiKey: { type: "string" } } })).toContain(
			"settings.properties.apiKey names a credential",
		);
		expect(
			manifestError({ type: "object", properties: { line: { type: "string", default: "two\nlines" } } }),
		).toContain("must be one line");
		expect(
			manifestError({ type: "object", properties: { color: { type: "string", enum: ["a\u001b[31mred"] } } }),
		).toBe(
			"settings.properties.color.enum options must be one line of at most 256 characters without control characters",
		);
	});

	it("bounds the declared settings and their defaults", () => {
		const many = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`s${index}`, { type: "boolean" }]));
		expect(manifestError({ type: "object", properties: many })).toBe("settings declares more than 64 settings");
		const large = Object.fromEntries(
			Array.from({ length: 5 }, (_, index) => [`s${index}`, { type: "string", default: "x".repeat(4000) }]),
		);
		expect(manifestError({ type: "object", properties: large })).toContain(
			`exceed ${EXTENSION_SETTINGS_MAX_SERIALIZED_BYTES} bytes`,
		);
	});

	it("rejects prototype names", () => {
		expect(manifestError({ type: "object", properties: { constructor: { type: "string" } } })).toContain("settings");
		expect(manifestError(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'))).toContain(
			"settings",
		);
	});

	it("reads credential-like names by word", () => {
		for (const name of [
			"apiKey",
			"api_key",
			"apiKey2",
			"githubToken",
			"token1",
			"accesstoken",
			"clientSecret",
			"password",
			"pwd",
			"PRIVATE_KEY",
			"accessKey",
			"bearer",
			"sessionCookie",
		]) {
			expect(namesCredential(name), name).toBe(true);
		}
		for (const name of ["tokenizer", "maxTokens", "keyboard", "organization", "secretary", "keyPath", "authMode"]) {
			expect(namesCredential(name), name).toBe(false);
		}
	});

	it("renders the settings as form fields, each value its default", () => {
		expect(settingsFormFields(SETTINGS)).toEqual([
			{
				id: "organization",
				label: "Organization",
				kind: "string",
				required: true,
				minLength: 1,
				maxLength: 64,
				pattern: "[a-z][a-z0-9-]*",
			},
			{ id: "mode", label: "mode", kind: "enum", options: [{ value: "fast" }, { value: "careful" }], value: "fast" },
			{ id: "verbose", label: "verbose", kind: "boolean", value: false },
			{ id: "maxLoops", label: "maxLoops", kind: "integer", value: 3, min: 1, max: 10 },
		]);
	});
});

describe("extension setting values", () => {
	it("drops undeclared and invalid stored values with a reason", () => {
		const stored = readStoredSettings(SETTINGS, {
			organization: "acme",
			mode: "reckless",
			maxLoops: 11,
			verbose: null,
			unknown: true,
		});
		expect(stored.values).toEqual({ organization: "acme" });
		expect(stored.dropped).toEqual([
			{ name: "mode", reason: 'must be one of "fast", "careful"' },
			{ name: "maxLoops", reason: "must be at most 10" },
			{ name: "unknown", reason: "is not a declared setting" },
		]);
		expect(readStoredSettings(SETTINGS, ["acme"]).dropped).toEqual([
			{ name: "*", reason: "settings must be an object" },
		]);
		expect(readStoredSettings(SETTINGS, { organization: "a".repeat(20_000) }).dropped[0]?.reason).toContain(
			"stored settings exceed",
		);
	});

	it("refuses values to store, naming each problem", () => {
		expect(() => checkSettingsValues(SETTINGS, { organization: "Acme", maxLoops: 1.5, other: 1 })).toThrow(
			new ExtensionSettingsError(
				'Invalid settings: "organization" must match its pattern; "maxLoops" must be an integer; "other" is not a declared setting',
			),
		);
		expect(checkSettingsValues(SETTINGS, { organization: "acme", verbose: true })).toEqual({
			organization: "acme",
			verbose: true,
		});
	});

	it("layers defaults, then global, then project values, frozen", () => {
		const effective = effectiveSettings(SETTINGS, { mode: "careful", maxLoops: 5 }, { maxLoops: 7 });
		expect(effective).toEqual({ mode: "careful", verbose: false, maxLoops: 7 });
		expect(Object.isFrozen(effective)).toBe(true);
	});
});

describe("extension settings storage", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "volt-extension-settings-"));
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function readJson(path: string): Record<string, unknown> {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	}

	it("stores each scope's values under extensions.<id>.settings, keeping enabled and other extensions", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		await storeExtensionSettings(manager, "demo", SETTINGS, "global", { organization: "acme", verbose: true });
		await storeExtensionSettings(manager, "other", SETTINGS, "global", { mode: "careful" });
		await storeExtensionSettings(manager, "demo", SETTINGS, "project", { maxLoops: 9 });
		expect(readJson(join(agentDir, "settings.json")).extensions).toEqual({
			demo: { settings: { organization: "acme", verbose: true } },
			other: { settings: { mode: "careful" } },
		});
		expect(readJson(join(projectDir, ".volt", "settings.json")).extensions).toEqual({
			demo: { settings: { maxLoops: 9 } },
		});

		const globalPath = join(agentDir, "settings.json");
		writeFileSync(
			globalPath,
			JSON.stringify({ extensions: { demo: { enabled: false, settings: { mode: "fast" } } } }),
		);
		await manager.reload();
		await storeExtensionSettings(manager, "demo", SETTINGS, "global", { mode: "careful" });
		expect(readJson(globalPath).extensions).toEqual({ demo: { enabled: false, settings: { mode: "careful" } } });

		await storeExtensionSettings(manager, "demo", SETTINGS, "global", {});
		expect(readJson(globalPath).extensions).toEqual({ demo: { enabled: false } });

		expect(extensionSettingsView(manager, "demo", SETTINGS)).toEqual({
			form: settingsFormFields(SETTINGS),
			values: { global: {}, project: { maxLoops: 9 } },
			projectTrusted: true,
		});
	});

	it("stores whether an extension runs per scope, keeping its settings; a trusted project's choice wins", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getExtensionEnabled("demo")).toBe(true);
		await storeExtensionSettings(manager, "demo", SETTINGS, "global", { verbose: true });
		manager.setExtensionEnabled("demo", "global", false);
		await manager.flush();
		expect(manager.getExtensionEnabled("demo")).toBe(false);
		expect(manager.getStoredExtensionEnabled("demo", "global")).toBe(false);
		expect(manager.getStoredExtensionEnabled("demo", "project")).toBeUndefined();
		expect(readJson(join(agentDir, "settings.json")).extensions).toEqual({
			demo: { settings: { verbose: true }, enabled: false },
		});
		// Storing settings keeps the choice.
		await storeExtensionSettings(manager, "demo", SETTINGS, "global", { verbose: false });
		expect(manager.getExtensionEnabled("demo")).toBe(false);

		manager.setExtensionEnabled("demo", "project", true);
		await manager.flush();
		expect(manager.getExtensionEnabled("demo")).toBe(true);
		expect(new ExtensionSettingsRuntime(manager).enabled("demo")).toBe(true);

		const untrusted = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
		expect(untrusted.getExtensionEnabled("demo")).toBe(false);
		expect(untrusted.getStoredExtensionEnabled("demo", "project")).toBeUndefined();
		expect(() => untrusted.setExtensionEnabled("demo", "project", false)).toThrow(
			"Project is not trusted; refusing to write project settings",
		);
		expect(new ExtensionSettingsRuntime().enabled("demo")).toBe(true);
	});

	it("neither reads nor writes project values for an untrusted project", async () => {
		const trusted = SettingsManager.create(projectDir, agentDir);
		await storeExtensionSettings(trusted, "demo", SETTINGS, "project", { maxLoops: 9 });

		const untrusted = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
		expect(untrusted.getExtensionSettings("demo", "project")).toBeUndefined();
		expect(extensionSettingsView(untrusted, "demo", SETTINGS)).toEqual({
			form: settingsFormFields(SETTINGS),
			values: { global: {} },
			projectTrusted: false,
		});
		await expect(storeExtensionSettings(untrusted, "demo", SETTINGS, "project", { maxLoops: 2 })).rejects.toThrow(
			"Project settings are stored only for a trusted project",
		);
		expect(() => untrusted.setExtensionSettings("demo", "project", { maxLoops: 2 })).toThrow(
			"Project is not trusted; refusing to write project settings",
		);
	});

	it("refuses a write while the scope's settings file failed to load", async () => {
		const globalPath = join(agentDir, "settings.json");
		const manager = SettingsManager.create(projectDir, agentDir);
		await storeExtensionSettings(manager, "demo", SETTINGS, "global", { verbose: true });
		writeFileSync(globalPath, "{ not json");
		await manager.reload();
		expect(() => manager.setExtensionSettings("demo", "global", { verbose: false })).toThrow(
			"Host global settings could not be loaded; repair them and reload",
		);
	});

	it("clears base values a profile leaves out", async () => {
		const globalPath = join(agentDir, "settings.json");
		writeFileSync(
			globalPath,
			JSON.stringify({ extensions: { demo: { settings: { organization: "base", verbose: true } } } }),
		);
		const manager = SettingsManager.create(projectDir, agentDir, { profile: "work" });
		expect(manager.getExtensionSettings("demo", "global")).toEqual({ organization: "base", verbose: true });
		await storeExtensionSettings(manager, "demo", SETTINGS, "global", { organization: "work" });
		expect(readStoredSettings(SETTINGS, manager.getExtensionSettings("demo", "global")).values).toEqual({
			organization: "work",
		});
		expect(readJson(globalPath)).toEqual({
			extensions: { demo: { settings: { organization: "base", verbose: true } } },
			profiles: { work: { extensions: { demo: { settings: { organization: "work", verbose: null } } } } },
		});
	});

	it("keeps a __proto__ key in a settings file or profile a plain property", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			'{"extensions":{"demo":{"settings":{"organization":"acme"}}},"profiles":{"work":{"extensions":{"__proto__":{"victim":{"settings":{"organization":"evil"}}}}}}}',
		);
		const manager = SettingsManager.create(projectDir, agentDir, { profile: "work" });
		expect(manager.getExtensionSettings("demo", "global")).toEqual({ organization: "acme" });
		expect(manager.getExtensionSettings("victim", "global")).toBeUndefined();
		expect(manager.getExtensionSettings("__proto__", "global")).toBeUndefined();
		// Merged in as a property named "__proto__", never as the merged object's prototype.
		expect(Object.keys(manager.getGlobalEffectiveSettings().extensions ?? {})).toEqual(["demo", "__proto__"]);
		expect(({} as Record<string, unknown>).victim).toBeUndefined();
	});

	it("reports an extensions path list as a setting to rename", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ extensions: ["./ext.ts"] }));
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.drainErrors().map((error) => error.error.message)).toEqual([
			'"extensions" holds a list of paths and is ignored; rename it to "extensionPaths"',
		]);
		expect(() => manager.setExtensionSettings("demo", "global", { verbose: true })).toThrow(
			'"extensions" holds a list of paths; rename it to "extensionPaths"',
		);
	});

	it("reports an extensions path list in a profile as a setting to rename", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ profiles: { work: { extensions: ["./ext.ts"] } } }));
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.drainErrors().map((error) => error.error.message)).toEqual([
			'"profiles.work.extensions" holds a list of paths and is ignored; rename it to "profiles.work.extensionPaths"',
		]);
	});

	it("notifies observers once a change is durable, not for unrelated settings", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		let notified = 0;
		manager.subscribeExtensionSettings(() => notified++);
		const revision = manager.getExtensionSettingsRevision();
		manager.setTheme("light");
		await manager.flush();
		expect(notified).toBe(0);
		expect(manager.getExtensionSettingsRevision()).toBe(revision);
		manager.setExtensionSettings("demo", "global", { verbose: true });
		expect(manager.getExtensionSettingsRevision()).toBe(revision + 1);
		expect(notified).toBe(0);
		await manager.flush();
		expect(notified).toBe(1);
	});
});

describe("extension settings runtime", () => {
	it("serves defaults without settings, then stored values, and reports each change once", async () => {
		const owner = { id: "demo", manifest: { settings: SETTINGS } };
		const settings = new ExtensionSettingsRuntime();
		expect(settings.values(owner)).toEqual({ mode: "fast", verbose: false, maxLoops: 3 });
		await expect(settings.update(owner, { verbose: true }, "global")).rejects.toThrow(
			"Settings cannot be stored in this runtime",
		);

		const manager = SettingsManager.inMemory({ extensions: { demo: { settings: { mode: "careful", bogus: 1 } } } });
		settings.bind(manager);
		expect(settings.changes([owner])).toEqual([
			{
				id: "demo",
				settings: { mode: "careful", verbose: false, maxLoops: 3 },
				previous: { mode: "fast", verbose: false, maxLoops: 3 },
				scope: "global",
			},
		]);
		expect(settings.drainDropped()).toEqual([{ id: "demo", message: '"bogus" is not a declared setting' }]);

		await settings.update(owner, { verbose: true, mode: undefined }, "project");
		expect(manager.getExtensionSettings("demo", "project")).toEqual({ verbose: true });
		expect(settings.values(owner)).toEqual({ mode: "careful", verbose: true, maxLoops: 3 });
		const [change] = settings.changes([owner]);
		expect(change?.scope).toBe("project");
		expect(change?.previous).toEqual({ mode: "careful", verbose: false, maxLoops: 3 });
		expect(settings.changes([owner])).toEqual([]);

		await expect(settings.update(owner, { maxLoops: 0 }, "global")).rejects.toThrow('"maxLoops" must be at least 1');
	});

	it("serves volt.settings and volt.updateSettings to the extension", async () => {
		const manager = SettingsManager.inMemory({ extensions: { demo: { settings: { organization: "acme" } } } });
		const runtime = createExtensionRuntime(new ExtensionSettingsRuntime(manager));
		const manifest = defineManifest({
			id: "demo",
			displayName: "Demo",
			settings: {
				type: "object",
				properties: {
					organization: { type: "string" },
					mode: { type: "string", enum: ["fast", "careful"], default: "fast" },
					maxLoops: { type: "integer", minimum: 1, default: 3 },
				},
			},
		});
		let api: ExtensionAPI<ExtensionSettingsOf<typeof manifest>> | undefined;
		await loadExtensionFromFactory(
			{
				manifest,
				factory: (volt: ExtensionAPI<ExtensionSettingsOf<typeof manifest>>) => {
					api = volt;
				},
			},
			process.cwd(),
			createEventBus(),
			runtime,
		);
		const volt = api!;
		const mode: "fast" | "careful" = volt.settings.mode;
		const organization: string | undefined = volt.settings.organization;
		expect({ mode, organization }).toEqual({ mode: "fast", organization: "acme" });
		expect(Object.isFrozen(volt.settings)).toBe(true);
		await volt.updateSettings({ maxLoops: 4 });
		expect(volt.settings.maxLoops).toBe(4);
		await expect(volt.updateSettings({ mode: "other" as "fast" })).rejects.toThrow(
			'"mode" must be one of "fast", "careful"',
		);
	});
});
