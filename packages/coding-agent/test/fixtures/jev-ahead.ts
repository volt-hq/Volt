import type { JevAnswer, JevQuestion } from "../../examples/extensions/jev-ahead-of-model/client.ts";

export interface AheadRequest {
	model: string;
	state: {
		request: string;
		recent?: Array<{ role: string; text: string }>;
		tools?: Array<{ name: string; text: string; isError: boolean }>;
		candidates?: Array<{ id: string; path: string }>;
		skills?: Array<{ id: string; label: string; text: string }>;
		evidence?: Array<{ id: string; label: string; text: string }>;
	};
	questions: Record<string, JevQuestion>;
}

/** Scripted oracle for integration contracts; not a simulation of Jev's quality. */
export function aheadAnswers(request: AheadRequest): Record<string, JevAnswer> {
	const answers: Record<string, JevAnswer> = {};
	for (const [id, question] of Object.entries(request.questions)) {
		if (question.type === "boolean") {
			answers[id] = { type: "boolean", probability: id.startsWith("excluded_") ? 0 : 1 };
		} else if (question.type === "score") {
			const candidate =
				request.state.candidates?.find((item) => `value_${item.id}` === id)?.path ??
				request.state.evidence?.find((item) => `value_${item.id}` === id)?.label ??
				"";
			const score = candidate.includes("irrelevant") || candidate.startsWith("skills/") ? 0 : 3;
			answers[id] = {
				type: "score",
				score,
				probabilities: Object.fromEntries(
					question.criteria.map((_label, index) => [String(index), index === score ? 1 : 0]),
				),
			};
		} else {
			const keys = Object.keys(question.criteria);
			let choice = "none";
			if (id === "phase") choice = "investigate";
			if (id === "search")
				choice =
					Object.entries(question.criteria).find(([, text]) => text.toLowerCase() === "resume")?.[0] ?? "none";
			if (id === "skill") choice = keys.find((key) => key.startsWith("skill_")) ?? "none";
			if (id === "followup") choice = keys.find((key) => question.criteria[key].startsWith("definition")) ?? "none";
			const probabilities = Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0]));
			if (id === "skill" && request.questions.phase && keys.includes("skill_1")) {
				probabilities.skill_0 = 0.7;
				probabilities.skill_1 = 0.3;
			}
			answers[id] = { type: "choice", choice, probabilities };
		}
	}
	return answers;
}

export function aheadResponse(init: RequestInit | undefined): Response {
	const request = JSON.parse(String(init?.body)) as AheadRequest;
	return Response.json({
		answers: aheadAnswers(request),
		usage: { inputTokens: 100, outputTokens: 20 },
		providerMetadata: { gateway: { cost: "0.0000042" } },
	});
}
