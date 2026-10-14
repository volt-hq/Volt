import { type CodeHostProvider, getCodeHostProvider, type ReviewCodeHostInlineComment } from "./code-host/index.ts";
import { REVIEW_PRE_EXISTING_LINE } from "./review-presentation.ts";
import type { ReviewFinding } from "./review-report.ts";
import { type ReviewRunRecord, reviewRunEngine, reviewRunEngineLabel, STANDARD_REVIEW_ENGINE } from "./review-state.ts";

function findingText(finding: ReviewFinding): string {
	return [
		`**[P${finding.priority}] ${finding.title}**`,
		"",
		finding.body,
		"",
		`Trigger: ${finding.trigger}`,
		`Impact: ${finding.impact}`,
		...(finding.introduced === false ? [REVIEW_PRE_EXISTING_LINE] : []),
		`Verification: ${finding.verification.method} — ${finding.verification.rationale}`,
		`Volt finding: ${finding.id}`,
	].join("\n");
}

function inlineComment(finding: ReviewFinding, run: ReviewRunRecord): ReviewCodeHostInlineComment | undefined {
	const location = finding.changeLocation;
	const file = run.target.files.find((candidate) => candidate.path === location.path);
	if (!file || location.endLine < location.startLine || location.endLine - location.startLine + 1 > 10) {
		return undefined;
	}
	if (location.side === "head" && !file.headOid) return undefined;
	if (location.side === "base" && !file.baseOid) return undefined;
	return {
		path: location.path,
		startLine: location.startLine,
		endLine: location.endLine,
		side: location.side,
		body: findingText(finding),
	};
}

export interface ReviewPublishOptions {
	/** Text added after the review's body, such as a marker a tool reads back. */
	trailer?: string;
	/** The command that runs the code host's CLI in place of its default: the account it is signed in as posts. */
	command?: readonly string[];
}

export interface ReviewPublishResult {
	reviewId?: number;
	url?: string;
	inlineFindingIds: string[];
	summaryOnlyFindingIds: string[];
}

export async function publishReviewRun(
	cwd: string,
	run: ReviewRunRecord,
	provider?: CodeHostProvider,
	options: ReviewPublishOptions = {},
): Promise<ReviewPublishResult> {
	const command = options.command === undefined ? {} : { command: options.command };
	const pullRequest = run.target.identity.pullRequest;
	if (run.status !== "completed" || run.result?.completionStatus !== "complete") {
		throw new Error("Only complete review results can be published.");
	}
	if (run.target.identity.kind !== "pr" || !pullRequest) {
		throw new Error("Only pull request reviews can be published.");
	}
	const codeHostProvider = provider ?? getCodeHostProvider(pullRequest.providerId);
	if (codeHostProvider.id !== pullRequest.providerId) {
		throw new Error("The selected code-host provider does not match the reviewed pull request.");
	}
	await codeHostProvider.verifyPullRequestHead(cwd, pullRequest, command);
	const comments: ReviewCodeHostInlineComment[] = [];
	const inlineFindingIds: string[] = [];
	const summaryOnlyFindingIds: string[] = [];
	for (const finding of run.result.findings.filter(
		(candidate) => candidate.status !== "fixed" && candidate.status !== "dismissed",
	)) {
		const comment = inlineComment(finding, run);
		if (comment) {
			comments.push(comment);
			inlineFindingIds.push(finding.id);
		} else summaryOnlyFindingIds.push(finding.id);
	}
	const summaryOnly = run.result.findings
		.filter((finding) => summaryOnlyFindingIds.includes(finding.id))
		.map((finding) => findingText(finding));
	const body = [
		`Volt review (${run.runId})`,
		...(reviewRunEngine(run) === STANDARD_REVIEW_ENGINE
			? []
			: [
					"",
					`Reviewed with the ${reviewRunEngineLabel(run)} review engine; its coverage and verification are reported by the engine.`,
				]),
		"",
		run.result.summary,
		"",
		`Verdict: ${run.result.overallCorrectness ?? "unavailable"} — ${run.result.overallExplanation}`,
		...(summaryOnly.length > 0 ? ["", "Findings without a safe inline anchor:", "", ...summaryOnly] : []),
		...(options.trailer === undefined ? [] : ["", options.trailer]),
	].join("\n");
	const published = await codeHostProvider.publishPullRequestReview({
		cwd,
		pullRequest,
		body,
		comments,
		...command,
	});
	return {
		...published,
		inlineFindingIds,
		summaryOnlyFindingIds,
	};
}
