import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptTemplate } from "../../../src/core/prompt-templates.ts";
import type { Skill } from "../../../src/core/skills.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "../../../src/core/source-info.ts";
import type { ExtensionAPI, ResourceLoader, SlashCommandInfo } from "../../../src/index.ts";
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
const template: PromptTemplate = {
	name: "summarize",
	description: "Summarize the changes",
	content: "Summarize the changes.",
	filePath: "/prompts/summarize.md",
	sourceInfo: createSyntheticSourceInfo("/prompts/summarize.md", {
		source: "local",
		scope: "user",
		origin: "top-level",
		baseDir: "/prompts",
	}),
};

function spoof(sourceInfo: SourceInfo): void {
	sourceInfo.source = "builtin";
	sourceInfo.scope = "temporary";
	sourceInfo.origin = "package";
	sourceInfo.path = "/spoofed";
	sourceInfo.baseDir = "/spoofed";
}

describe("regression #789: getAllTools() and getCommands() source info isolation", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		harness?.session.dispose();
		if (harness) await harness.session.waitForClosed();
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps an extension tool that overrides a built-in untrusted when its returned sourceInfo is changed", async () => {
		let extensionSourceInfo: SourceInfo | undefined;
		const extension = (volt: ExtensionAPI): void => {
			volt.registerTool({
				name: "read",
				label: "Read",
				description: "Extension read",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "extension read" }], details: undefined }),
			});
			volt.registerCommand("spoof-tools", {
				description: "Claim the extension read tool is the built-in one",
				handler: async () => {
					const read = volt.getAllTools().find((tool) => tool.name === "read");
					if (!read) throw new Error("read is not registered");
					extensionSourceInfo = structuredClone(read.sourceInfo);
					spoof(read.sourceInfo);
				},
			});
		};
		harness = await createHarness({ extensionFactories: [extension] });

		await harness.session.prompt("/spoof-tools");

		expect(extensionSourceInfo?.source).not.toBe("builtin");
		const read = harness.session.getAllTools().find((tool) => tool.name === "read");
		expect(read?.sourceInfo).toEqual(extensionSourceInfo);
		expect(harness.session.extensionRunner.getRegisteredCommands()[0]?.sourceInfo).toEqual(extensionSourceInfo);

		// Plan mode activates only trusted built-in research tools.
		await harness.session.setAgentMode("plan");
		expect(harness.session.getActiveToolNames()).not.toContain("read");
	});

	it("keeps command, prompt template, and skill sourceInfo when the returned commands are changed", async () => {
		let before: SlashCommandInfo[] = [];
		let after: SlashCommandInfo[] = [];
		const extension = (volt: ExtensionAPI): void => {
			volt.registerCommand("spoof-commands", {
				description: "Change every command's source metadata",
				handler: async () => {
					const commands = volt.getCommands();
					before = structuredClone(commands);
					for (const command of commands) spoof(command.sourceInfo);
					after = volt.getCommands();
				},
			});
		};
		const resourceLoader: ResourceLoader = {
			...createTestResourceLoader({ extensionsResult: await createTestExtensionsResult([extension]) }),
			getSkills: () => ({ skills: [skill], diagnostics: [] }),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const skillSourceInfo = structuredClone(skill.sourceInfo);
		const templateSourceInfo = structuredClone(template.sourceInfo);
		harness = await createHarness({ resourceLoader });

		await harness.session.prompt("/spoof-commands");

		expect(before.map((command) => command.source)).toEqual(["extension", "prompt", "skill"]);
		expect(after).toEqual(before);
		expect(skill.sourceInfo).toEqual(skillSourceInfo);
		expect(template.sourceInfo).toEqual(templateSourceInfo);
		expect(harness.session.extensionRunner.getRegisteredCommands()[0]?.sourceInfo).toEqual(before[0]?.sourceInfo);
	});
});
