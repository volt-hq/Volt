import { loadReviewQualityCorpus } from "./corpus.ts";
import { REAL_MODEL_ENV_FLAG, type ReviewQualityEnvironment } from "./environment.ts";
import { loadReviewQualityReport } from "./report.ts";
import { scoreReviewQuality } from "./scorer.ts";
import type { ReviewQualityCorpus, ReviewQualityEvaluation, ReviewQualityReport } from "./types.ts";

export type RealModelReviewQualityRunner = (
	corpus: ReviewQualityCorpus,
	environment: ReviewQualityEnvironment,
) => Promise<ReviewQualityReport>;

export interface EvaluateReviewQualityOptions {
	environment?: ReviewQualityEnvironment;
	corpusManifestPath?: string;
	sampleReportPath?: string;
	runRealModel?: RealModelReviewQualityRunner;
}

export async function evaluateReviewQuality(
	options: EvaluateReviewQualityOptions = {},
): Promise<ReviewQualityEvaluation> {
	const environment = options.environment ?? process.env;
	const corpus = loadReviewQualityCorpus(options.corpusManifestPath);
	let report: ReviewQualityReport;
	if (environment[REAL_MODEL_ENV_FLAG] === "1") {
		if (!options.runRealModel) {
			throw new Error(`A real-model runner is required when ${REAL_MODEL_ENV_FLAG}=1`);
		}
		report = await options.runRealModel(corpus, environment);
	} else {
		report = loadReviewQualityReport(options.sampleReportPath);
	}
	return scoreReviewQuality(corpus, report);
}
