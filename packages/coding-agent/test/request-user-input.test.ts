import { type ToolCall, validateToolArguments } from "@hansjm10/volt-ai";
import { PRESENTATION_MAX_SERIALIZED_BYTES } from "@hansjm10/volt-protocol";
import type { TUI } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	authorizeToolOperation,
	getTrustedToolOperationResolver,
	operationProvidesResearchEvidence,
	RESEARCH_OPERATION_GRANT_PROFILE,
} from "../src/core/operation-authorization.ts";
import { initTheme, theme } from "../src/core/theme/runtime.ts";
import { presentRequestUserInput } from "../src/core/tools/query-presenters.ts";
import {
	createRequestUserInputTool,
	createRequestUserInputToolDefinition,
	type RequestUserInputToolInput,
} from "../src/core/tools/request-user-input.ts";
import { HOST_UI_POLICY, presentToolCall } from "../src/core/ui/presentation.ts";
import type { UserInputRequest, UserInputResponse } from "../src/core/user-input.ts";
import { type MountUserInputDialog, promptUserInput } from "../src/modes/interactive/components/user-input-dialog.ts";

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

/** A tool context: an RPC host (the interactive TUI's included) has UI; a print run has none. */
function context(mode: ExtensionContext["mode"] = "rpc"): ExtensionContext {
	return { mode, hasUI: mode === "rpc", abort: vi.fn() } as unknown as ExtensionContext;
}

/** The tool, asking through `ask` as the TUI client would. */
function tool(ask: (request: UserInputRequest, signal?: AbortSignal) => Promise<UserInputResponse> | undefined) {
	return createRequestUserInputToolDefinition({ ask });
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
		const definition = tool(custom);
		await expect(
			definition.execute(
				"q1",
				{ questions: [request.questions[0], request.questions[0]] },
				undefined,
				undefined,
				context(),
			),
		).rejects.toThrow("ids must be unique");
		await expect(
			definition.execute(
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
				context(),
			),
		).rejects.toThrow("labels must be unique");
		await expect(
			definition.execute(
				"q1",
				{ questions: [{ ...request.questions[0], question: "  " }] },
				undefined,
				undefined,
				context(),
			),
		).rejects.toThrow("must not be blank");
		expect(custom).not.toHaveBeenCalled();
	});

	it.each(["print", "json"] as const)("returns unavailable without waiting in %s", async (mode) => {
		const ask = vi.fn();
		const result = await tool(ask).execute("q1", request, undefined, undefined, context(mode));
		expect(result.details).toMatchObject({ status: "unavailable", answers: {} });
		expect(ask).not.toHaveBeenCalled();
	});

	it("returns unavailable when no client can ask", async () => {
		const result = await tool(() => undefined).execute("q1", request, undefined, undefined, context());
		expect(result.details).toMatchObject({ status: "unavailable", answers: {} });
		const unwired = await createRequestUserInputToolDefinition().execute(
			"q1",
			request,
			undefined,
			undefined,
			context(),
		);
		expect(unwired.details).toMatchObject({ status: "unavailable", answers: {} });
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
			const ctx = context();
			const result = await tool(async () => response).execute("q1", request, undefined, undefined, ctx);
			expect(result.content).toEqual([{ type: "text", text: JSON.stringify(response) }]);
			expect(result.details).toEqual({ questions: request.questions, ...response });
			expect(result.disposition).toBe(status === "cancelled" ? "stop" : undefined);
			expect(ctx.abort).toHaveBeenCalledTimes(status === "cancelled" ? 1 : 0);
		},
	);

	it("closes a pending dialog on abort and removes its listener", async () => {
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		let closeResult: unknown;
		const mount: MountUserInputDialog = (create) =>
			new Promise((resolve) => {
				create(tui, theme, new KeybindingsManager(), (result) => {
					closeResult = result;
					resolve(result);
				});
			});
		const pending = tool((asked, signal) => promptUserInput(mount, asked, signal)).execute(
			"q1",
			request,
			controller.signal,
			undefined,
			context(),
		);
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(closeResult).toEqual({ status: "cancelled", answers: {} });
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("closes a dialog mounted late if cancellation won before it showed", async () => {
		const controller = new AbortController();
		let show: (() => void) | undefined;
		let response: unknown;
		const mount: MountUserInputDialog = (create) =>
			new Promise((resolve) => {
				show = () => {
					create(tui, theme, new KeybindingsManager(), (result) => {
						response = result;
						resolve(result);
					});
				};
			});
		const pending = promptUserInput(
			mount,
			{ questions: request.questions.map((question) => ({ ...question })) },
			controller.signal,
		);
		controller.abort();
		show?.();
		await expect(pending).resolves.toEqual({ status: "cancelled", answers: {} });
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
		const result = await tool(async () => ({ status: "skipped", answers: {} })).execute(
			"q1",
			input,
			undefined,
			undefined,
			context(),
		);
		expect(result.details.questions[0]).toMatchObject({
			header: "Scope",
			question: "Which clients should this cover?",
		});
	});

	it("does not open a UI for an already aborted call", async () => {
		const ask = vi.fn();
		await expect(tool(ask).execute("q1", request, AbortSignal.abort(), undefined, context())).rejects.toThrow();
		expect(ask).not.toHaveBeenCalled();
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

	it("presents answers semantically in the transcript, with full questions on expansion", async () => {
		const response: UserInputResponse = {
			status: "answered",
			answers: { scope: { answers: ["CLI first (Recommended)"] } },
		};
		const result = await tool(async () => response).execute("q1", request, undefined, undefined, context());
		const presentation = presentToolCall(
			{ present: presentRequestUserInput, policy: HOST_UI_POLICY },
			"request_user_input",
			{
				args: request,
				argsComplete: true,
				state: "done",
				result: { content: result.content, details: result.details, isError: false, partial: false },
				cwd: process.cwd(),
			},
			PRESENTATION_MAX_SERIALIZED_BYTES,
		);
		const collapsed = JSON.stringify(presentation.summary);
		expect(presentation.summary).toEqual([
			{
				type: "keyValue",
				key: "answers",
				items: [
					{
						key: "answer:0",
						label: [{ text: "Scope", token: "accent" }],
						value: "CLI first (Recommended)",
					},
				],
			},
		]);
		// The answers, not the JSON result the model saw.
		expect(collapsed).not.toContain("answered");
		expect(JSON.stringify(presentation.body)).toContain("Which clients should this cover?");
	});
});
