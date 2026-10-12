import { type Context, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolInfo } from "../../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const READ_GUIDELINE = "Use read to examine files instead of cat or sed.";

interface ObjectSchema {
	properties: Record<string, object>;
	required: string[];
}

function readInfo(tools: ToolInfo[]): ToolInfo {
	const read = tools.find((tool) => tool.name === "read");
	if (!read) throw new Error("read is not registered");
	return read;
}

function mutate(read: ToolInfo): void {
	const parameters = read.parameters as unknown as ObjectSchema;
	Object.assign(parameters.properties.path, { description: "Spoofed path" });
	parameters.properties.injected = Type.String();
	parameters.required.push("injected");
	if (read.promptGuidelines) read.promptGuidelines[0] = "Spoofed guideline";
	read.promptGuidelines?.push("Injected guideline");
}

function json(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

describe("regression #794: getAllTools() parameters and promptGuidelines isolation", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			harness.session.dispose();
			await harness.session.waitForClosed();
			harness.cleanup();
		}
	});

	it("keeps the built-in read schema and guidelines when an extension changes what getAllTools() returns", async () => {
		let before: ToolInfo | undefined;
		const extension = (volt: ExtensionAPI): void => {
			volt.registerCommand("mutate-read", {
				description: "Change the read tool's schema and guidelines",
				handler: async () => {
					const read = readInfo(volt.getAllTools());
					before = structuredClone(read);
					mutate(read);
					// A new tool refreshes the registry and system prompt; it reuses a fresh copy of the read schema.
					volt.registerTool({
						name: "read_copy",
						label: "Read copy",
						description: "Read with the read schema",
						parameters: readInfo(volt.getAllTools()).parameters,
						execute: async () => ({ content: [{ type: "text", text: "copy" }], details: undefined }),
					});
				},
			});
		};
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader({ extensionsResult: await createTestExtensionsResult([extension]) }),
		});
		harnesses.push(harness);
		let request: Context | undefined;
		harness.setResponses([
			(context) => {
				request = context;
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/mutate-read");
		await harness.session.prompt("hello");

		expect(before?.promptGuidelines).toEqual([READ_GUIDELINE]);
		const parameters = json(before?.parameters);
		expect(parameters).toMatchObject({ required: ["path"] });
		// The model is offered, and arguments are validated against, the original schema; a copy serializes the same.
		const offered = (name: string): unknown => json(request?.tools?.find((tool) => tool.name === name)?.parameters);
		expect(offered("read")).toEqual(parameters);
		expect(offered("read_copy")).toEqual(parameters);
		expect(request?.systemPrompt).toContain(READ_GUIDELINE);
		expect(request?.systemPrompt).not.toMatch(/spoofed|injected/i);
		expect(json(readInfo(harness.session.getAllTools()))).toEqual(json(before));

		// Built-in schemas are module constants shared by every session in the process.
		const other = await createHarness();
		harnesses.push(other);
		expect(json(readInfo(other.session.getAllTools()))).toEqual(json(before));
	});
});
