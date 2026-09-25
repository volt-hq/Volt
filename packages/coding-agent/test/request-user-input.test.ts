import { type ToolCall, validateToolArguments } from "@hansjm10/volt-ai";
import type { TUI } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	authorizeToolOperation,
	getTrustedToolOperationResolver,
	operationProvidesResearchEvidence,
	RESEARCH_OPERATION_GRANT_PROFILE,
} from "../src/core/operation-authorization.ts";
import { initTheme, theme } from "../src/core/theme/runtime.ts";
import {
	createRequestUserInputTool,
	createRequestUserInputToolDefinition,
	type RequestUserInputToolInput,
} from "../src/core/tools/request-user-input.ts";
import type { UserInputResponse } from "../src/core/user-input.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const request: RequestUserInputToolInput = {
	questions: [
		{
			id: "scope",
			header: "Scope",
			question: "Which clients should this cover?",
			options: [
				{ label: "CLI first (Recommended)", description: "Keep the initial change focused on the terminal." },
				{ label: "All clients", description: "Include the phone and RPC integrations." },
			],
		},
	],
};

function context(custom: ExtensionUIContext["custom"], mode: ExtensionContext["mode"] = "tui"): ExtensionContext {
	return { mode, hasUI: mode === "tui", ui: { custom }, abort: vi.fn() } as unknown as ExtensionContext;
}

const tui = { requestRender: () => {}, terminal: { rows: 36, columns: 120 } } as unknown as TUI;

function validate(input: unknown): void {
	const call = { type: "toolCall", id: "q1", name: "request_user_input", arguments: input } as ToolCall;
	validateToolArguments(createRequestUserInputTool(), call);
}

describe("request_user_input", () => {
	beforeAll(() => initTheme("dark"));

	it("bounds the number and shape of questions and options", () => {
		expect(() => validate(request)).not.toThrow();
		for (const questions of [
			[],
			Array(4).fill(request.questions[0]),
			[{ ...request.questions[0], options: [] }],
			[{ ...request.questions[0], options: Array(4).fill(request.questions[0].options[0]) }],
		]) {
			expect(() => validate({ questions })).toThrow();
		}
		expect(() => validate({ questions: [{ ...request.questions[0], id: "__proto__" }] })).toThrow();
		expect(() => validate({ ...request, permission: true })).toThrow();
	});

	it("rejects duplicate keys, duplicate choices, and blank content before showing UI", async () => {
		const custom = vi.fn();
		const tool = createRequestUserInputToolDefinition();
		await expect(
			tool.execute(
				"q1",
				{ questions: [request.questions[0], request.questions[0]] },
				undefined,
				undefined,
				context(custom),
			),
		).rejects.toThrow("ids must be unique");
		await expect(
			tool.execute(
				"q1",
				{
					questions: [
						{
							...request.questions[0],
							options: [request.questions[0].options[0], request.questions[0].options[0]],
						},
					],
				},
				undefined,
				undefined,
				context(custom),
			),
		).rejects.toThrow("labels must be unique");
		await expect(
			tool.execute(
				"q1",
				{ questions: [{ ...request.questions[0], question: "  " }] },
				undefined,
				undefined,
				context(custom),
			),
		).rejects.toThrow("must not be blank");
		expect(custom).not.toHaveBeenCalled();
	});

	it.each(["print", "json", "rpc"] as const)("returns unavailable without waiting in %s", async (mode) => {
		const custom = vi.fn();
		const result = await createRequestUserInputToolDefinition().execute(
			"q1",
			request,
			undefined,
			undefined,
			context(custom, mode),
		);
		expect(result.details).toMatchObject({ status: "unavailable", answers: {} });
		expect(custom).not.toHaveBeenCalled();
	});

	it.each(["answered", "skipped", "cancelled"] as const)(
		"returns explicit %s outcomes without inferred answers",
		async (status) => {
			const response: UserInputResponse = {
				status,
				answers:
					status === "answered"
						? { scope: { answers: ["CLI first (Recommended)", "Keep the phone out of scope"] } }
						: {},
			};
			const custom: ExtensionUIContext["custom"] = async <T>() => response as T;
			const result = await createRequestUserInputToolDefinition().execute(
				"q1",
				request,
				undefined,
				undefined,
				context(custom),
			);
			expect(result.content).toEqual([{ type: "text", text: JSON.stringify(response) }]);
			expect(result.details).toEqual({ questions: request.questions, ...response });
			expect(result.disposition).toBe(status === "cancelled" ? "stop" : undefined);
		},
	);

	it("closes a pending UI on abort and removes its listener", async () => {
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		let closeResult: unknown;
		const custom: ExtensionUIContext["custom"] = <T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) =>
			new Promise<T>((resolve) => {
				void factory(tui, theme, new KeybindingsManager(), (result) => {
					closeResult = result;
					resolve(result as T);
				});
			});
		const pending = createRequestUserInputToolDefinition().execute(
			"q1",
			request,
			controller.signal,
			undefined,
			context(custom),
		);
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(closeResult).toEqual({ status: "cancelled", answers: {} });
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("closes a deferred UI factory if cancellation won before it mounted", async () => {
		const controller = new AbortController();
		let show: (() => void) | undefined;
		let response: unknown;
		const custom: ExtensionUIContext["custom"] = <T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) =>
			new Promise<T>((resolve) => {
				show = () => {
					void factory(tui, theme, new KeybindingsManager(), (result) => {
						response = result;
						resolve(result as T);
					});
				};
			});
		const pending = createRequestUserInputToolDefinition().execute(
			"q1",
			request,
			controller.signal,
			undefined,
			context(custom),
		);
		controller.abort();
		show?.();
		await expect(pending).rejects.toThrow();
		expect(response).toEqual({ status: "cancelled", answers: {} });
	});

	it("renders model-provided question labels as plain text, not terminal controls", async () => {
		const input = {
			questions: [
				{
					...request.questions[0],
					header: "\u001b[31mScope\u001b[0m\u0007",
					question: "\u001b[2JWhich clients should this cover?",
				},
			],
		};
		const result = await createRequestUserInputToolDefinition().execute(
			"q1",
			input,
			undefined,
			undefined,
			context(async <T>() => ({ status: "skipped", answers: {} }) as T),
		);
		expect(result.details.questions[0]).toMatchObject({
			header: "Scope",
			question: "Which clients should this cover?",
		});
	});

	it("does not open a UI for an already aborted call", async () => {
		const custom = vi.fn();
		await expect(
			createRequestUserInputToolDefinition().execute("q1", request, AbortSignal.abort(), undefined, context(custom)),
		).rejects.toThrow();
		expect(custom).not.toHaveBeenCalled();
	});

	it("can collect preferences in Plan mode but cannot satisfy the research gate", () => {
		const decision = authorizeToolOperation(
			getTrustedToolOperationResolver("request_user_input"),
			request,
			RESEARCH_OPERATION_GRANT_PROFILE,
		);
		expect(decision.allowed).toBe(true);
		expect(operationProvidesResearchEvidence(decision.resolution)).toBe(false);
	});

	it("renders answers semantically in the transcript, with full questions on expansion", async () => {
		const definition = createRequestUserInputToolDefinition();
		const response: UserInputResponse = {
			status: "answered",
			answers: { scope: { answers: ["CLI first (Recommended)"] } },
		};
		const result = await definition.execute(
			"q1",
			request,
			undefined,
			undefined,
			context(async <T>() => response as T),
		);
		const component = new ToolExecutionComponent(
			"request_user_input",
			"q1",
			request,
			{},
			definition,
			tui,
			process.cwd(),
		);
		component.updateResult({ ...result, isError: false }, false);
		const collapsed = stripAnsi(component.render(80).lines.join("\n"));
		expect(collapsed).toContain("Scope: CLI first (Recommended)");
		expect(collapsed).not.toContain('"answers"');
		component.setExpanded(true);
		expect(stripAnsi(component.render(80).lines.join("\n"))).toContain("Which clients should this cover?");
	});
});
