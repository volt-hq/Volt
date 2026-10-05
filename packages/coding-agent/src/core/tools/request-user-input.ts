import type { AgentTool } from "@hansjm10/volt-agent-core";
import { type Static, Type } from "typebox";
import { stripAnsi } from "../../utils/ansi.ts";
import type { AgentToolResult, ToolDefinition } from "../extensions/types.ts";
import type { UserInputPrompt, UserInputRequest, UserInputResponse } from "../user-input.ts";
import { presentRequestUserInput } from "./query-presenters.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const requestUserInputSchema = Type.Object(
	{
		questions: Type.Array(
			Type.Object(
				{
					id: Type.String({
						pattern: "^[a-z][a-z0-9_]*$",
						maxLength: 64,
						description: "Unique snake_case answer key.",
					}),
					header: Type.String({
						minLength: 1,
						maxLength: 24,
						description: "Short label, such as Scope or Storage.",
					}),
					question: Type.String({
						minLength: 1,
						maxLength: 500,
						description: "One concise question about a material decision.",
					}),
					options: Type.Array(
						Type.Object(
							{
								label: Type.String({
									minLength: 1,
									maxLength: 100,
									description:
										'Short choice label. Put the recommendation first and suffix it with "(Recommended)".',
								}),
								description: Type.String({
									minLength: 1,
									maxLength: 300,
									description: "One short sentence explaining the impact or tradeoff.",
								}),
							},
							{ additionalProperties: false },
						),
						{
							minItems: 2,
							maxItems: 3,
							description:
								'Meaningful, mutually exclusive choices. Do not add "Other" or skip options; the UI provides them.',
						},
					),
				},
				{ additionalProperties: false },
			),
			{
				minItems: 1,
				maxItems: 3,
				description: "Prefer one question. Batch only closely related decisions; at most three.",
			},
		),
	},
	{ additionalProperties: false },
);

export type RequestUserInputToolInput = Static<typeof requestUserInputSchema>;
export interface RequestUserInputToolDetails extends UserInputResponse {
	questions: UserInputRequest["questions"];
}

function questionText(value: string): string {
	return stripAnsi(value)
		.replace(/\p{Cc}/gu, " ")
		.trim();
}

function resultFor(
	request: UserInputRequest,
	response: UserInputResponse,
): AgentToolResult<RequestUserInputToolDetails> {
	return {
		content: [{ type: "text", text: JSON.stringify(response) }],
		details: { questions: request.questions, ...response },
		// Dismissing the whole dialog stops the turn instead of immediately asking again.
		...(response.status === "cancelled" ? { disposition: "stop" as const } : {}),
	};
}

export interface RequestUserInputToolOptions {
	/** Ask the questions in the client that shows them; undefined when no client can. */
	ask?: (request: UserInputRequest, signal?: AbortSignal) => ReturnType<UserInputPrompt> | undefined;
}

export function createRequestUserInputToolDefinition(
	options?: RequestUserInputToolOptions,
): ToolDefinition<typeof requestUserInputSchema, RequestUserInputToolDetails> {
	return {
		name: "request_user_input",
		label: "ask user",
		description:
			"Ask the user one to three short, structured preference questions and wait for their response. Available in the root local TUI only. The user can select a choice, write an answer, add notes, or skip. Not for permission requests, secrets, or facts you can discover with tools.",
		promptSnippet: "Ask a material preference question with selectable choices or a free-form answer",
		promptGuidelines: [
			"Explore before asking: never ask the user for facts you can discover from the repository or available tools.",
			"In Build mode, strongly prefer reasonable assumptions and execution for low-risk, reversible choices. Use request_user_input only when a preference would materially improve the outcome, not for routine implementation decisions or asking whether to proceed with authorized work.",
			"In Plan mode, use request_user_input for unresolved high-impact intent, constraints, or meaningful tradeoffs after exploration. Recommend a default; do not turn planning into a questionnaire about every detail.",
			"Prefer one concise question with 2–3 meaningful choices, the recommendation first. The UI supplies free-form input and skipping; do not print a multiple-choice questionnaire in chat when this tool is available.",
			"A skipped or unavailable answer is not consent. Do not repeat an optional question; proceed within existing authorization using a stated reasonable assumption. If explicit input is required before safe progress, ask one concise plain-text question and stop instead. Never use request_user_input to obtain permission, approve a plan, escalate privileges, or collect secrets.",
		],
		parameters: requestUserInputSchema,
		present: presentRequestUserInput,
		// Prevent two dialogs (or a mutating sibling tool) from racing for input.
		executionMode: "sequential",
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const request: UserInputRequest = {
				questions: input.questions.map((question) => ({
					id: question.id,
					header: questionText(question.header),
					question: questionText(question.question),
					options: question.options.map((option) => ({
						label: questionText(option.label),
						description: questionText(option.description),
					})),
				})),
			};
			if (new Set(request.questions.map((question) => question.id)).size !== request.questions.length) {
				throw new Error("Question ids must be unique within a request.");
			}
			for (const question of request.questions) {
				if (
					!question.header ||
					!question.question ||
					question.options.some((option) => !option.label || !option.description)
				) {
					throw new Error("Questions, headers, option labels, and descriptions must not be blank.");
				}
				if (new Set(question.options.map((option) => option.label)).size !== question.options.length) {
					throw new Error("Option labels must be unique within each question.");
				}
			}
			const asked = ctx?.mode === "tui" && ctx.hasUI ? options?.ask?.(request, signal) : undefined;
			if (asked === undefined) return resultFor(request, { status: "unavailable", answers: {} });
			const response = await asked;
			signal?.throwIfAborted();
			// A turn disposition applies after the entire tool batch. Abort as well
			// so Escape cannot allow a later sibling tool to execute.
			if (response.status === "cancelled") ctx?.abort();
			return resultFor(request, response);
		},
	};
}

export function createRequestUserInputTool(
	options?: RequestUserInputToolOptions,
): AgentTool<typeof requestUserInputSchema, RequestUserInputToolDetails> {
	return wrapToolDefinition(createRequestUserInputToolDefinition(options));
}
