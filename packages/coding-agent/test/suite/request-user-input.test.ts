import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { Component, TUI } from "@hansjm10/volt-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { initTheme, theme } from "../../src/core/theme/runtime.ts";
import type { UserInputResponse } from "../../src/core/user-input.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const request = {
	questions: [
		{
			id: "scope",
			header: "Scope",
			question: "Which clients should this cover?",
			options: [
				{ label: "CLI first (Recommended)", description: "Keep the first change focused." },
				{ label: "All clients", description: "Include phone and RPC." },
			],
		},
	],
};
const answered: UserInputResponse = {
	status: "answered",
	answers: { scope: { answers: ["CLI first (Recommended)"] } },
};
const tui = { requestRender: () => {}, terminal: { rows: 36, columns: 120 } } as unknown as TUI;

describe("native structured questions", () => {
	const harnesses: Harness[] = [];
	beforeAll(() => initTheme("dark"));
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()!.cleanupAsync();
	});

	async function setup(options: HarnessOptions = {}): Promise<Harness> {
		const harness = await createHarness({
			settings: { lsp: { enabled: false }, compaction: { enabled: false } },
			resourceLoader: createTestResourceLoader(),
			...options,
		});
		harnesses.push(harness);
		harness.session.setSessionName("Structured question tests");
		return harness;
	}

	async function bind(
		harness: Harness,
		custom: ExtensionUIContext["custom"] = async <T>() => answered as T,
	): Promise<void> {
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: { ...harness.session.extensionRunner.getUIContext(), custom },
		});
	}

	it("advertises questions only with a bound local TUI, preserving policy across mode changes and reload", async () => {
		const h = await setup();
		expect(h.session.getActiveToolNames()).not.toContain("request_user_input");
		await bind(h);
		expect(h.session.getActiveToolNames()).toContain("request_user_input");
		expect(h.session.systemPrompt).toContain("Explore before asking");
		await h.session.setAgentMode("plan");
		expect(h.session.getActiveToolNames()).toContain("request_user_input");
		expect(h.session.getActiveToolNames()).not.toContain("write");
		await h.session.reload();
		expect(h.session.getActiveToolNames()).toContain("request_user_input");
		await h.session.bindExtensions({ mode: "rpc" });
		expect(h.session.getActiveToolNames()).not.toContain("request_user_input");
		await h.session.setAgentMode("build");
		await bind(h);
		expect(h.session.getActiveToolNames()).toContain("request_user_input");
	});

	it.each([{ allowedToolNames: ["read"] }, { excludedToolNames: ["request_user_input"] }, { allowedToolNames: [] }])(
		"respects explicit tool grants %j",
		async (options) => {
			const h = await setup(options);
			await bind(h);
			expect(h.session.getActiveToolNames()).not.toContain("request_user_input");
			await h.session.setAgentMode("plan");
			expect(h.session.getActiveToolNames()).not.toContain("request_user_input");
		},
	);

	it("does not expose questions in child runtimes even if a TUI is bound", async () => {
		const h = await setup({
			subagentToolManager: {
				isSubagentRuntime: () => true,
				listAvailableDefinitions: () => [],
				getDefinition: () => {
					throw new Error("No children");
				},
				startByName: async () => {
					throw new Error("No children");
				},
			},
		});
		await bind(h);
		expect(h.session.getActiveToolNames()).not.toContain("request_user_input");
		await h.session.setAgentMode("plan");
		expect(h.session.getActiveToolNames()).not.toContain("request_user_input");
	});

	it("waits for a real component selection, persists the answer, and continues with it", async () => {
		const h = await setup();
		const ready = Promise.withResolvers<Component>();
		await bind(
			h,
			<T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) =>
				new Promise<T>((resolve, reject) => {
					Promise.resolve(factory(tui, theme, new KeybindingsManager(), (result) => resolve(result as T))).then(
						ready.resolve,
						reject,
					);
				}),
		);
		let nextContext = "";
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("request_user_input", request), { stopReason: "toolUse" }),
			(context) => {
				nextContext = JSON.stringify(context.messages);
				return fauxAssistantMessage("Proceeding with CLI first.");
			},
		]);
		const running = h.session.prompt("Implement the question tool");
		const dialog = await ready.promise;
		expect(h.session.isStreaming).toBe(true);
		expect(h.eventsOfType("tool_execution_end")).toHaveLength(0);
		dialog.handleInput?.("\r");
		await running;
		expect(nextContext).toContain("CLI first (Recommended)");
		const result = h.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "request_user_input",
		);
		expect(result).toMatchObject({ isError: false, details: { ...answered, questions: request.questions } });
		expect(h.session.getLastAssistantText()).toBe("Proceeding with CLI first.");
	});

	it("stops on cancellation without executing later tools or asking again", async () => {
		let markerCalls = 0;
		const h = await setup({
			resourceLoader: undefined,
			extensionFactories: [
				(volt) =>
					volt.registerTool({
						name: "marker",
						label: "marker",
						description: "Record an observable action",
						parameters: Type.Object({}),
						execute: async () => {
							markerCalls++;
							return { content: [{ type: "text", text: "marked" }], details: {} };
						},
					}),
			],
		});
		await bind(h, async <T>() => ({ status: "cancelled", answers: {} }) as T);
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("request_user_input", request), fauxToolCall("marker", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Must not be requested"),
		]);
		await h.session.prompt("Choose a scope");
		expect(markerCalls).toBe(0);
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.session.isStreaming).toBe(false);
	});

	it("cannot approve a ready plan through a question answer", async () => {
		const h = await setup();
		await bind(h);
		await h.session.setAgentMode("plan");
		const draft = h.session.updatePlan({ steps: [{ text: "Implement the requested change" }] });
		const ready = h.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Question authority",
			summary: "Answers are preferences, not execution approval.",
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("request_user_input", request), { stopReason: "toolUse" }),
			fauxAssistantMessage("Preference recorded; the plan still needs approval."),
		]);
		await h.session.prompt("Clarify the client scope");
		expect(h.session.agentMode).toBe("plan");
		expect(h.session.planningState.plan?.id).toBe(ready.id);
		expect(h.session.planningState.plan?.execution).toBeUndefined();
		expect(h.session.getActiveToolNames()).not.toContain("write");
	});

	it("continues after explicit skip without turning the highlighted option into an answer", async () => {
		const h = await setup();
		await bind(h, async <T>() => ({ status: "skipped", answers: {} }) as T);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("request_user_input", request), { stopReason: "toolUse" }),
			fauxAssistantMessage("I will use the current CLI scope as an assumption."),
		]);
		await h.session.prompt("Choose a scope");
		expect(h.eventsOfType("tool_execution_end")[0]?.result).toMatchObject({
			details: { status: "skipped", answers: {} },
		});
		expect(h.session.getLastAssistantText()).toContain("assumption");
	});

	it.each(["abort", "dispose"] as const)("dismisses pending questions and settles on session %s", async (action) => {
		const h = await setup();
		const ready = Promise.withResolvers<void>();
		let closed = false;
		await bind(
			h,
			<T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) =>
				new Promise<T>((resolve, reject) => {
					Promise.resolve(
						factory(tui, theme, new KeybindingsManager(), (result) => {
							closed = true;
							resolve(result as T);
						}),
					).then(() => ready.resolve(), reject);
				}),
		);
		h.setResponses([fauxAssistantMessage(fauxToolCall("request_user_input", request), { stopReason: "toolUse" })]);
		const running = h.session.prompt("Choose a scope");
		await ready.promise;
		if (action === "abort") await h.session.abort();
		else {
			h.session.dispose();
			await h.session.waitForClosed();
		}
		await running;
		expect(closed).toBe(true);
	});
});
