import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall, type JsonObject } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionOperationOrigin } from "../../src/core/extensions/index.ts";
import type { RunCodeDetails } from "../../src/core/tools/run-code.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const CODE_MODE = { settings: { codeMode: { enabled: true } } } satisfies HarnessOptions;

function toolResponse(name: string, input: JsonObject) {
	return fauxAssistantMessage(fauxToolCall(name, input), { stopReason: "toolUse" });
}

function runCode(code: string) {
	return toolResponse("run_code", { code });
}

/** The binding lines of the `run_code` description the model was offered in `context`. */
function offeredBindings(context: Context): string[] {
	const description = context.tools?.find((tool) => tool.name === "run_code")?.description ?? "";
	return description.split("\n").filter((line) => line.startsWith("- "));
}

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

function toolResults(harness: Harness, toolName?: string): ToolResultMessage[] {
	return harness.session.messages.filter(
		(message): message is ToolResultMessage =>
			message.role === "toolResult" && (toolName === undefined || message.toolName === toolName),
	);
}

const READ_LINE = "- tools.read(args): Promise<string | ImageRef>";

describe("run_code in a session", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0).reverse()) await harness.cleanupAsync();
	});

	async function setup(options: HarnessOptions = {}): Promise<Harness> {
		const harness = await createHarness(options);
		harnesses.push(harness);
		return harness;
	}

	it("is active by default, in Build and Plan mode, only when codeMode.enabled is set", async () => {
		const off = await setup();
		expect(off.session.getAllTools().map((tool) => tool.name)).toContain("run_code");
		expect(off.session.getActiveToolNames()).not.toContain("run_code");
		await off.session.setAgentMode("plan");
		expect(off.session.getActiveToolNames()).not.toContain("run_code");

		const on = await setup(CODE_MODE);
		expect(on.session.getActiveToolNames()).toContain("run_code");
		await on.session.setAgentMode("plan");
		expect(on.session.getActiveToolNames()).toContain("run_code");

		const excluded = await setup({ ...CODE_MODE, excludedToolNames: ["run_code"] });
		expect(excluded.session.getAllTools().map((tool) => tool.name)).not.toContain("run_code");
		expect(excluded.session.getActiveToolNames()).not.toContain("run_code");

		const listed = await setup({ allowedToolNames: ["read", "run_code"] });
		expect(listed.session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "run_code"]));
		expect(listed.session.getActiveToolNames()).not.toContain("bash");
	});

	it("runs a script whose nested reads pass the session's hooks and returns only its result", async () => {
		const hooked: Array<{ toolName: string; toolCallId: string; origin: ExtensionOperationOrigin | undefined }> = [];
		const harness = await setup({
			...CODE_MODE,
			extensionFactories: [
				(volt) => {
					volt.on("tool_call", (event) => {
						hooked.push({ toolName: event.toolName, toolCallId: event.toolCallId, origin: event.origin });
						return undefined;
					});
				},
			],
		});
		writeFileSync(join(harness.tempDir, "a.txt"), "alpha");
		writeFileSync(join(harness.tempDir, "b.txt"), "beta");
		harness.setResponses([
			runCode(
				"const a: string = await tools.read({ path: 'a.txt' });\nconst b = await tools.read({ path: 'b.txt' });\nreturn a + '+' + b;",
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("combine the files");

		const [result] = toolResults(harness, "run_code");
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toMatch(/^Script completed in \S+ \(2 tool calls\)\nReturn value: alpha\+beta$/);
		const details = result.details as RunCodeDetails;
		expect(details).toMatchObject({ status: "completed", language: "typescript", complete: true });
		expect(details.calls).toMatchObject([
			{ seq: 1, tool: "read", path: "a.txt", status: "completed", readOnly: true },
			{ seq: 2, tool: "read", path: "b.txt", status: "completed", readOnly: true },
		]);

		// Nested calls are neither tool executions nor transcript entries of their own.
		expect(harness.eventsOfType("tool_execution_start").map((event) => event.toolName)).toEqual(["run_code"]);
		expect(toolResults(harness).map((message) => message.toolName)).toEqual(["run_code"]);

		const parent = result.toolCallId;
		expect(hooked).toEqual([
			{ toolName: "run_code", toolCallId: parent, origin: { kind: "agent" } },
			{
				toolName: "read",
				toolCallId: `${parent}:cm:1`,
				origin: { kind: "code_mode", parentToolCallId: parent, seq: 1 },
			},
			{
				toolName: "read",
				toolCallId: `${parent}:cm:2`,
				origin: { kind: "code_mode", parentToolCallId: parent, seq: 2 },
			},
		]);
	});

	it("reports a script that fails after a write, which stays applied", async () => {
		const harness = await setup(CODE_MODE);
		harness.setResponses([
			runCode("await tools.write({ path: 'out.txt', content: 'written' });\nthrow new Error('after the write');"),
			fauxAssistantMessage("noted"),
		]);
		await harness.session.prompt("write then fail");

		const [result] = toolResults(harness, "run_code");
		expect(result.isError).toBe(true);
		const text = getMessageText(result);
		expect(text).toMatch(/^Script failed after \S+ \(1 tool call\): uncaught Error\n/);
		expect(text).toContain("Error: after the write");
		expect(text).toContain("Nested tool calls: 1 (1 completed). Completed calls were not undone.");
		expect(text).toContain('May have changed state:\n- write path="out.txt" content="written": completed');
		expect((result.details as RunCodeDetails).calls).toMatchObject([
			{ tool: "write", path: "out.txt", status: "completed", readOnly: false },
		]);
		expect(readFileSync(join(harness.tempDir, "out.txt"), "utf8")).toBe("written");
	});

	it("binds only read-only tools in Plan mode, where only nested reads count as research", async () => {
		const harness = await setup(CODE_MODE);
		const { session } = harness;
		writeFileSync(join(harness.tempDir, "notes.txt"), "evidence");
		await session.setAgentMode("plan");
		const draft = await session.updatePlan({
			title: "Plan from evidence",
			summary: "Plan the change from the notes.",
			steps: [{ text: "Make the change" }],
		});
		const submit = () =>
			toolResponse("submit_plan", {
				planId: draft.id,
				expectedRevision: draft.revision,
				title: draft.title!,
				summary: draft.summary!,
			});
		harness.setResponses([
			(context) => {
				const bindings = offeredBindings(context);
				expect(bindings[0]).toBe(READ_LINE);
				expect(bindings.join("\n")).not.toMatch(/tools\.(bash|edit|write)\(/);
				return runCode("await tools.bash({ command: 'echo hi' });");
			},
			submit(),
			runCode("return (await tools.read({ path: 'notes.txt' })).length;"),
			submit(),
			fauxAssistantMessage("submitted"),
		]);
		await session.prompt("plan it");

		const [withoutBash, withRead] = toolResults(harness, "run_code");
		expect(withoutBash.isError).toBe(true);
		expect(getMessageText(withoutBash)).toContain("TypeError");
		expect((withoutBash.details as RunCodeDetails).calls).toEqual([]);
		expect(withRead.isError).toBe(false);
		expect(getMessageText(withRead)).toContain("Return value: 8");

		const [blocked, accepted] = toolResults(harness, "submit_plan");
		expect(blocked.isError).toBe(true);
		expect(getMessageText(blocked)).toContain("requires at least one successful read");
		expect(accepted.isError).toBe(false);
		expect(session.planningState.plan?.phase).toBe("ready");
	});

	it("stays inactive in Plan mode while it would bind nothing, so submit_plan reports research is impossible", async () => {
		const harness = await setup({ ...CODE_MODE, allowedToolNames: ["run_code", "edit", "bash"] });
		const { session } = harness;
		expect(session.getActiveToolNames()).toContain("run_code");
		await session.setAgentMode("plan");
		expect(session.getActiveToolNames()).not.toContain("run_code");

		const draft = await session.updatePlan({
			title: "Plan without reads",
			summary: "Plan the change without any read tool.",
			steps: [{ text: "Make the change" }],
		});
		harness.setResponses([
			toolResponse("submit_plan", {
				planId: draft.id,
				expectedRevision: draft.revision,
				title: draft.title!,
				summary: draft.summary!,
			}),
			fauxAssistantMessage("cannot submit"),
		]);
		await session.prompt("plan it");

		const [blocked] = toolResults(harness, "submit_plan");
		expect(blocked.isError).toBe(true);
		expect(getMessageText(blocked)).toContain("exposes no research-capable tools");
	});

	it("describes the bindings of the tools active when the tool set is staged", async () => {
		const harness = await setup(CODE_MODE);
		const offered: string[][] = [];
		harness.setResponses([
			(context) => {
				offered.push(offeredBindings(context));
				return fauxAssistantMessage("first");
			},
			(context) => {
				offered.push(offeredBindings(context));
				return fauxAssistantMessage("second");
			},
		]);
		harness.session.setActiveToolsByName(["read", "run_code"]);
		await harness.session.prompt("first");
		harness.session.setActiveToolsByName(["read", "bash", "run_code"]);
		await harness.session.prompt("second");

		expect(offered[0]).toEqual([READ_LINE]);
		expect(offered[1]).toHaveLength(2);
		expect(offered[1][0]).toMatch(/^- tools\.bash\(args\): Promise<\{ output: string; exitCode/);
		expect(offered[1][1]).toBe(READ_LINE);
		// The registered tool keeps its own description; only the staged copy lists bindings.
		const registered = harness.session.getAllTools().find((tool) => tool.name === "run_code");
		expect(registered?.description).not.toContain("tools.read(args)");
	});
});
