import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Skill } from "../../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import type { BuildSystemPromptOptions, ExtensionFactory, ResourceLoader } from "../../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const skill: Skill = {
	name: "review",
	description: "Review code changes",
	filePath: "/skills/review/SKILL.md",
	baseDir: "/skills/review",
	sourceInfo: createSyntheticSourceInfo("/skills/review/SKILL.md", {
		source: "local",
		scope: "project",
		origin: "top-level",
		baseDir: "/skills/review",
	}),
	disableModelInvocation: false,
};
const contextFile = { path: "/project/AGENTS.md", content: "Original project rules." };

/** A loader that, like the real one, hands out the same skills and context file arrays on every call. */
async function loaderWith(factories: ExtensionFactory[]): Promise<ResourceLoader> {
	const skills = [structuredClone(skill)];
	const agentsFiles = [structuredClone(contextFile)];
	return {
		...createTestResourceLoader({ extensionsResult: await createTestExtensionsResult(factories) }),
		getSkills: () => ({ skills, diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles }),
	};
}

function mutate(options: BuildSystemPromptOptions): void {
	const [firstSkill] = options.skills ?? [];
	if (firstSkill) firstSkill.name = "mutated-skill";
	options.skills?.push({ ...skill, name: "injected-skill" });
	const [firstFile] = options.contextFiles ?? [];
	if (firstFile) firstFile.content = "Mutated project rules.";
	options.contextFiles?.push({ path: "/project/INJECTED.md", content: "Injected rules." });
}

function expectLoadedResourcesUnchanged(harness: Harness, resourceLoader: ResourceLoader): void {
	expect(resourceLoader.getSkills().skills).toEqual([skill]);
	expect(resourceLoader.getAgentsFiles().agentsFiles).toEqual([contextFile]);
	harness.session.applySettings();
	expect(harness.session.systemPrompt).toContain("Original project rules.");
	expect(harness.session.systemPrompt).toContain("<name>review</name>");
	expect(harness.session.systemPrompt).not.toMatch(/mutated|injected/i);
}

describe("regression #782: system prompt options isolation", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		harness?.session.dispose();
		if (harness) await harness.session.waitForClosed();
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps loaded skills and context files when a before_agent_start handler mutates its options", async () => {
		const seenByLaterHandler: BuildSystemPromptOptions[] = [];
		const resourceLoader = await loaderWith([
			(volt) => {
				volt.on("before_agent_start", (event) => mutate(event.systemPromptOptions));
			},
			(volt) => {
				volt.on("before_agent_start", (event) => {
					seenByLaterHandler.push(structuredClone(event.systemPromptOptions));
				});
			},
		]);
		harness = await createHarness({ resourceLoader });
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("hello");

		expect(seenByLaterHandler).toHaveLength(1);
		expect(seenByLaterHandler[0]?.skills).toEqual([skill]);
		expect(seenByLaterHandler[0]?.contextFiles).toEqual([contextFile]);
		expectLoadedResourcesUnchanged(harness, resourceLoader);
	});

	it("keeps loaded skills and context files when a command mutates getSystemPromptOptions()", async () => {
		const resourceLoader = await loaderWith([
			(volt) => {
				volt.registerCommand("mutate-options", {
					description: "Mutate system prompt options",
					handler: async (_args, ctx) => mutate(ctx.getSystemPromptOptions()),
				});
			},
		]);
		harness = await createHarness({ resourceLoader });

		await harness.session.prompt("/mutate-options");

		expectLoadedResourcesUnchanged(harness, resourceLoader);
	});
});
