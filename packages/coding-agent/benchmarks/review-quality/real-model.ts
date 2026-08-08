import { performance } from "node:perf_hooks";
import {
	completeSimple,
	getModels,
	getProviders,
	type Api,
	type AssistantMessage,
	type Model,
} from "@hansjm10/volt-ai";
import {
	REAL_MODEL_ENV_FLAG,
	REAL_MODEL_ID_ENV,
	REAL_MODEL_PROVIDER_ENV,
	type ReviewQualityEnvironment,
} from "./environment.ts";
import { parseReviewQualityCaseReport } from "./report.ts";
import type {
	ReviewQualityCase,
	ReviewQualityCaseReport,
	ReviewQualityCorpus,
	ReviewQualityReport,
	ReviewQualityTokenUse,
} from "./types.ts";

function requireEnvironmentValue(environment: ReviewQualityEnvironment, name: string): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required when ${REAL_MODEL_ENV_FLAG}=1`);
	return value;
}

function resolveModel(providerId: string, modelId: string): Model<Api> {
	const provider = getProviders().find((candidate) => candidate === providerId);
	if (!provider) throw new Error(`Unknown review-quality provider: ${providerId}`);
	const model = getModels(provider).find((candidate) => candidate.id === modelId);
	if (!model) throw new Error(`Unknown review-quality model: ${providerId}/${modelId}`);
	return model as Model<Api>;
}

function buildPrompt(corpusCase: ReviewQualityCase): string {
	const hunkCatalog = corpusCase.changedFiles
		.flatMap((file) =>
			file.hunks.map(
				(hunk) =>
					`- ${hunk.id}: ${hunk.path}:${hunk.startLine}-${hunk.endLine} (changed ranges ${hunk.changedLineRanges
						.map((range) => `${range.startLine}-${range.endLine}`)
						.join(", ")})`,
			),
		)
		.join("\n");
	return [
		"Review this repository diff for concrete correctness issues.",
		"Return JSON only. Do not wrap it in Markdown.",
		"Each finding must use a short semantic kebab-case issueKey and anchor to changed lines in the after-file.",
		"Report no finding when the diff is correct.",
		"Mark every file and hunk you examined in coverage, even when there are no findings.",
		"Required shape:",
		'{"findings":[{"issueKey":"semantic-key","path":"src/file.ts","startLine":1,"endLine":1,"summary":"optional explanation"}],"coverage":{"reviewedFiles":["src/file.ts"],"reviewedHunks":["src/file.ts#1"]}}',
		"Hunks:",
		hunkCatalog,
		"Diff:",
		corpusCase.diff,
	].join("\n\n");
}

function assistantText(response: AssistantMessage): string {
	return response.content
		.filter((content): content is Extract<AssistantMessage["content"][number], { type: "text" }> => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

function parseJsonResponse(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
		if (fenced?.[1]) return JSON.parse(fenced[1]) as unknown;
		throw new Error("Real-model review did not return valid JSON");
	}
}

function addUsage(target: ReviewQualityTokenUse, response: AssistantMessage): void {
	target.input += response.usage.input;
	target.output += response.usage.output;
	target.cacheRead += response.usage.cacheRead;
	target.cacheWrite += response.usage.cacheWrite;
	target.total += response.usage.totalTokens;
}

export async function runRealModelReviewQuality(
	corpus: ReviewQualityCorpus,
	environment: ReviewQualityEnvironment = process.env,
): Promise<ReviewQualityReport> {
	if (environment[REAL_MODEL_ENV_FLAG] !== "1") {
		throw new Error(`Real-model review-quality evaluation requires ${REAL_MODEL_ENV_FLAG}=1`);
	}
	const provider = requireEnvironmentValue(environment, REAL_MODEL_PROVIDER_ENV);
	const modelId = requireEnvironmentValue(environment, REAL_MODEL_ID_ENV);
	const model = resolveModel(provider, modelId);
	const tokenUse: ReviewQualityTokenUse = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const caseReports: ReviewQualityCaseReport[] = [];
	let reportedCostUsd = 0;
	const startedAt = performance.now();
	for (const corpusCase of corpus.cases) {
		const response = await completeSimple(
			model,
			{
				systemPrompt: "You are a precise code reviewer. Follow the requested JSON schema exactly.",
				messages: [{ role: "user", content: buildPrompt(corpusCase), timestamp: Date.now() }],
			},
			{ maxTokens: 4_096 },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage ?? `Real-model review stopped with ${response.stopReason}`);
		}
		addUsage(tokenUse, response);
		reportedCostUsd += response.usage.cost.total;
		caseReports.push(
			parseReviewQualityCaseReport(parseJsonResponse(assistantText(response)), `model response for ${corpusCase.id}`, corpusCase.id),
		);
	}
	return {
		schemaVersion: 1,
		run: {
			mode: "real-model",
			provider,
			model: modelId,
			latencyMs: performance.now() - startedAt,
			tokenUse,
			reportedCostUsd,
		},
		cases: caseReports,
	};
}
