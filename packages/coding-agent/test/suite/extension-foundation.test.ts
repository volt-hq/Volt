import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import type {
	ExtensionWorkLocationsResult,
	ExtensionWorkReadResult,
	ExtensionWorkSnapshot,
	ExtensionWorkSymbolsResult,
	ExtensionWorkTaskContext,
	ExtensionWorkTaskHandle,
} from "../../src/core/extensions/work-types.ts";
import { loadSkillsFromDir, type Skill } from "../../src/core/skills.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function setup(options: HarnessOptions) {
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		...options,
	});
	harnesses.push(harness);
	harness.session.setSessionName("remaining foundation test");
	return harness;
}
function consumer(run: (task: ExtensionWorkTaskContext) => Promise<void>, extra?: ExtensionFactory) {
	let handle!: ExtensionWorkTaskHandle;
	let api!: ExtensionAPI;
	let snapshot!: ExtensionWorkSnapshot;
	const factory: ExtensionFactory = async (volt) => {
		api = volt;
		volt.on("request_boundary", (event, ctx) => {
			snapshot = ctx.work!.snapshot;
			if (!event.first) return;
			const admission = ctx.work!.tasks.start({ key: "prepare", label: "Prepare" }, run);
			if (admission.status === "started") handle = admission.task;
		});
		volt.registerTool({
			name: "checkpoint",
			label: "Checkpoint",
			description: "Synchronize test",
			parameters: Type.Object({}),
			execute: async () => {
				await handle.wait();
				// Test source authority, not whether real I/O fits the 25 ms collection budget.
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
				return { content: [] };
			},
		});
		await extra?.(volt);
	};
	return { factory, handle: () => handle, api: () => api, snapshot: () => snapshot };
}
async function prompt(harness: Harness, extension: ReturnType<typeof consumer>) {
	let projection: Context | undefined;
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("checkpoint", {})], { stopReason: "toolUse" }),
		(context) => {
			projection = { ...context, messages: structuredClone(context.messages) };
			return fauxAssistantMessage("done");
		},
	]);
	await harness.session.prompt("inspect the request");
	expect(extension.handle().status().state).toBe("completed");
	expect(projection).toBeDefined();
	return projection!;
}
async function skill() {
	const root = await mkdtemp(join(tmpdir(), "volt-managed-skill-"));
	directories.push(root);
	const directory = join(root, "skill");
	await mkdir(directory);
	const path = join(directory, "SKILL.md");
	await writeFile(path, "---\nname: sample\ndescription: Sample guidance\n---\nprepared skill body\n");
	const loaded = loadSkillsFromDir({ dir: directory, source: "user" });
	expect(loaded.skills).toHaveLength(1);
	return { path, directory, loaded };
}

describe("remaining extension foundation through AgentSession", () => {
	it.each([0, 100])(
		"honors host first-request allowance %i without persisting the suffix",
		async (firstRequestWaitMs) => {
			let projection: Context | undefined;
			const harness = await setup({
				extensionWorkLimits: { firstRequestWaitMs },
				extensionFactories: [
					(volt) => {
						volt.on("request_boundary", (_event, ctx) => {
							ctx.work!.context.requestWait(100);
							ctx.work!.tasks.start({ key: "prepare", label: "Prepare" }, async (task) => {
								task.context.put({ key: "hint", text: "first-request preparation" });
							});
						});
					},
				],
			});
			harness.setResponses([
				(context) => {
					projection = { ...context, messages: structuredClone(context.messages) };
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("request");
			expect(JSON.stringify(projection?.messages).includes("first-request preparation")).toBe(
				firstRequestWaitMs > 0,
			);
			expect(JSON.stringify(harness.session.messages)).not.toContain("first-request preparation");
			expect(harness.faux.state.callCount).toBe(1);
		},
	);

	it("reads a loaded global skill through its handle even when general read is inactive", async () => {
		const fixture = await skill();
		let result: ExtensionWorkReadResult | undefined;
		const extension = consumer(async (task) => {
			result = await task.repository.readSkill({ resourceId: task.snapshot.skills[0].resourceId });
			if (result.status === "ok")
				task.context.put({
					key: "skill",
					text: result.text,
					dependency: "sources",
					evidenceIds: [result.evidence.id],
				});
		});
		const harness = await setup({ extensionFactories: [extension.factory], initialActiveToolNames: [] });
		harness.session.resourceLoader.getSkills = () => fixture.loaded;
		const context = await prompt(harness, extension);
		expect(result).toMatchObject({
			status: "ok",
			evidence: { path: await realpath(fixture.path), resourceId: extension.snapshot().skills[0].resourceId },
		});
		expect(extension.snapshot().skills[0]).toMatchObject({ name: "sample", scope: "user", origin: "top-level" });
		expect(extension.snapshot().skills[0]).not.toHaveProperty("filePath");
		expect(context.messages.map(getMessageText).join("\n")).toContain("prepared skill body");
		expect(extension.api().getWorkStatus().contributions).toEqual([{ key: "skill", status: "admitted" }]);
		expect(JSON.stringify(harness.session.messages)).not.toContain("prepared skill body");
	});

	it.each(["patch", "replace", "retarget"] as const)(
		"prevents %s from redirecting an issued skill grant",
		async (kind) => {
			const fixture = await skill();
			const secretDirectory = join(fixture.directory, "..", "adjacent");
			await mkdir(secretDirectory);
			const secret = join(secretDirectory, "SKILL.md");
			await writeFile(secret, "adjacent private bytes");
			let result: ExtensionWorkReadResult | undefined;
			const reducerText: string[] = [];
			const extension = consumer(
				async (task) => {
					result = await task.repository.readSkill({ resourceId: task.snapshot.skills[0].resourceId });
				},
				(volt) => {
					volt.on("tool_call", async (event) => {
						if (event.toolName !== "read") return;
						if (kind === "patch") event.input.path = secret;
						else if (kind === "replace") {
							await rename(fixture.path, `${fixture.path}.old`);
							await writeFile(fixture.path, "adjacent private bytes");
						} else {
							// Retarget the parent so Windows can use an unprivileged directory junction.
							await rename(fixture.directory, `${fixture.directory}.old`);
							await symlink(
								secretDirectory,
								fixture.directory,
								process.platform === "win32" ? "junction" : "dir",
							);
						}
					});
					volt.on("tool_result", (event) => {
						if (event.toolName === "read") reducerText.push(JSON.stringify(event.content));
					});
				},
			);
			const harness = await setup({ extensionFactories: [extension.factory] });
			harness.session.resourceLoader.getSkills = () => fixture.loaded;
			await prompt(harness, extension);
			if (kind === "retarget") expect(await realpath(fixture.path)).toBe(await realpath(secret));
			expect(result?.status).toMatch(/denied|invalidated/);
			expect(result).not.toHaveProperty("text");
			expect(reducerText.join("\n")).not.toContain("adjacent private bytes");
		},
	);

	it.each(["redact", "remove", "edit"] as const)("withholds skill context after %s", async (kind) => {
		const fixture = await skill();
		let result: ExtensionWorkReadResult | undefined;
		let loaded = fixture.loaded;
		const extension = consumer(
			async (task) => {
				result = await task.repository.readSkill({ resourceId: task.snapshot.skills[0].resourceId });
				if (result.status === "ok")
					task.context.put({
						key: "skill",
						text: "prepared skill body",
						dependency: "sources",
						evidenceIds: [result.evidence.id],
					});
				if (kind === "remove") loaded = { skills: [], diagnostics: [] };
				if (kind === "edit") await writeFile(fixture.path, "changed skill bytes");
			},
			(volt) => {
				if (kind === "redact")
					volt.on("tool_result", (event) =>
						event.toolName === "read" ? { content: [{ type: "text", text: "redacted" }] } : undefined,
					);
			},
		);
		const harness = await setup({ extensionFactories: [extension.factory] });
		harness.session.resourceLoader.getSkills = () => loaded;
		const context = await prompt(harness, extension);
		expect(JSON.stringify(context.messages)).not.toContain("prepared skill body");
		expect(result?.status).toBe(kind === "redact" ? "unavailable" : "ok");
	});

	it("does not issue handles for user-only or metadata-only skill overrides", async () => {
		const fixture = await skill();
		const native = fixture.loaded.skills[0];
		native.disableModelInvocation = true;
		const forged: Skill = { ...native, name: "forged", disableModelInvocation: false };
		const extension = consumer(async (task) => {
			expect(task.snapshot.skills).toEqual([]);
			expect(await task.repository.readSkill({ resourceId: fixture.path })).toMatchObject({ status: "denied" });
		});
		const harness = await setup({ extensionFactories: [extension.factory] });
		harness.session.resourceLoader.getSkills = () => ({ skills: [native, forged], diagnostics: [] });
		await prompt(harness, extension);
	});

	it.each(["normal", "redact", "patch"] as const)(
		"routes managed semantic reads through native LSP and policies: %s",
		async (kind) => {
			const results: Array<ExtensionWorkSymbolsResult | ExtensionWorkLocationsResult> = [];
			const extension = consumer(
				async (task) => {
					results.push(await task.repository.symbols({ path: "source.managed" }));
					results.push(await task.repository.definition({ path: "source.managed", symbol: "target" }));
					results.push(await task.repository.references({ path: "source.managed", symbol: "target" }));
				},
				(volt) => {
					if (kind === "redact")
						volt.on("tool_result", (event) => (event.toolName === "lsp" ? { content: [] } : undefined));
					if (kind === "patch")
						volt.on("tool_call", (event) => {
							if (event.toolName === "lsp") {
								event.input.action = "rename";
								event.input.newName = "mutated";
							}
						});
				},
			);
			const harness = await setup({
				extensionFactories: [extension.factory],
				initialActiveToolNames: ["lsp"],
				settings: {
					compaction: { enabled: false },
					retry: { enabled: false },
					lsp: {
						servers: {
							managed: {
								command: [
									process.execPath,
									fileURLToPath(new URL("../fixtures/fake-lsp-server.mjs", import.meta.url)),
								],
								fileExtensions: [".managed"],
								rootMarkers: [],
							},
						},
					},
				},
			});
			const source = join(harness.tempDir, "source.managed");
			await writeFile(source, "const target = 1;\n  target;\n");
			await prompt(harness, extension);
			expect(results.map((result) => result.status)).toEqual(
				Array(3).fill(kind === "normal" ? "ok" : kind === "redact" ? "unavailable" : "denied"),
			);
			if (kind === "normal") {
				expect(results[0]).toMatchObject({
					symbols: [
						{ name: "FakeClass", path: await realpath(source), startLine: 1 },
						{ name: "fakeMethod", startLine: 2 },
					],
					coverage: "unknown",
				});
				expect(results[1]).toMatchObject({
					locations: [{ path: await realpath(source), startLine: 1, startColumn: 1 }],
					coverage: "unknown",
				});
				expect(results[2]).toMatchObject({ locations: [{ startLine: 1 }, { startLine: 2 }] });
			}
			expect(await readFile(source, "utf8")).toBe("const target = 1;\n  target;\n");
			expect(harness.eventsOfType("tool_execution_start").map((event) => event.toolName)).toEqual(["checkpoint"]);
		},
	);
});
