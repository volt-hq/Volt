/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Asks with `ctx.ui.form()`: one choice field per question (plus a free-text
 * field when the question allows its own answer). Every client renders the
 * form, so the tool works in the TUI, over RPC, and on a paired phone.
 * `present()` shows the questions and the answers as UI data.
 */

import { defineManifest, type ExtensionAPI, type ExtensionFormValues } from "@hansjm10/volt-coding-agent";
import type { UiNodeFormField } from "@hansjm10/volt-protocol";
import { Type } from "typebox";

// Types
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

/** The option value of "Type something." */
const OTHER = "other";

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

/**
 * The form fields for the questions. Field ids and option values are
 * positions, so any question id or option value the model chose works.
 */
function formFields(questions: Question[]): UiNodeFormField[] {
	return questions.flatMap((question, index): UiNodeFormField[] => [
		{
			kind: "enum",
			id: `q${index}`,
			label: question.label,
			description: question.prompt,
			required: true,
			options: [
				...question.options.map((option, optionIndex) => ({
					value: String(optionIndex),
					label: `${optionIndex + 1}. ${option.label}`,
					...(option.description ? { description: option.description } : {}),
				})),
				...(question.allowOther ? [{ value: OTHER, label: "Type something." }] : []),
			],
		},
		...(question.allowOther
			? [
					{
						kind: "string" as const,
						id: `q${index}-other`,
						label: `${question.label}: your answer`,
						description: "Used when you choose Type something.",
					},
				]
			: []),
	]);
}

/** The answers the submitted form holds. */
function answersOf(questions: Question[], values: ExtensionFormValues): Answer[] {
	return questions.flatMap((question, index): Answer[] => {
		const choice = values[`q${index}`];
		if (choice === OTHER) {
			const written = String(values[`q${index}-other`] ?? "").trim() || "(no response)";
			return [{ id: question.id, value: written, label: written, wasCustom: true }];
		}
		const optionIndex = Number(choice);
		const option = question.options[optionIndex];
		return option
			? [{ id: question.id, value: option.value, label: option.label, wasCustom: false, index: optionIndex + 1 }]
			: [];
	});
}

export const manifest = defineManifest({
	id: "questionnaire",
	displayName: "Questionnaire",
	description: "Unified tool for asking single or multiple questions.",
});

export default function questionnaire(volt: ExtensionAPI) {
	volt.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. Each question offers a list of options, and optionally a free-text answer.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));

			const values = await ctx.ui.form(
				{
					title: questions.length === 1 ? questions[0].prompt : `${questions.length} questions`,
					fields: formFields(questions),
				},
				{ signal },
			);

			if (values === undefined) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: { questions, answers: [], cancelled: true },
				};
			}

			const answers = answersOf(questions, values);
			const answerLines = answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: { questions, answers, cancelled: false },
			};
		},

		present({ args, state, result }) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const labels = questions.map((q) => q.label || q.id).join(", ");
			const title = [
				{ text: "questionnaire ", bold: true },
				{ text: `${questions.length} question${questions.length !== 1 ? "s" : ""}`, token: "muted" as const },
				...(labels ? [{ text: ` (${labels})`, token: "muted" as const }] : []),
			];
			if (state !== "done") return { title, activity: "Waiting for answers" };
			const details = result?.details as QuestionnaireResult | undefined;
			if (!details || details.cancelled) {
				return { title, summary: [{ type: "text", key: "cancelled", text: "Cancelled", token: "warning" }] };
			}
			return {
				title,
				summary: [
					{
						type: "keyValue",
						key: "answers",
						items: details.answers.map((answer) => ({
							key: answer.id,
							label: [
								{ text: "✓ ", token: "success" },
								{ text: answer.id, token: "accent" },
							],
							value: answer.wasCustom
								? [{ text: "(wrote) ", token: "muted" }, { text: answer.label }]
								: answer.index
									? `${answer.index}. ${answer.label}`
									: answer.label,
						})),
					},
				],
			};
		},
	});
}
