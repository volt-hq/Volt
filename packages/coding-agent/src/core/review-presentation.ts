import { stripVTControlCharacters } from "node:util";
import type { ParsedReview, ReviewFinding, ReviewLocation } from "./review-report.ts";
import type { ReviewRunRecord } from "./review-state.ts";

export const STATIC_REVIEW_LIMITATION = "Static review only. This review did not run tests or runtime checks.";

/** Render data as inert, single-line Markdown rather than headings, links, or terminal controls. */
function reviewText(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/[\\`*_[\]<>#|!:.@~]/g, "\\$&");
}

function locationText(location: ReviewLocation): string {
	return `${reviewText(location.path)}:${location.startLine}-${location.endLine}, ${location.side}`;
}

function isActive(finding: ReviewFinding): boolean {
	return finding.status === "open" || finding.status === "accepted";
}

function findingCounts(findings: readonly ReviewFinding[]): string {
	const active = findings.filter(isActive);
	const blocking = active.filter((finding) => finding.priority <= 2).length;
	const optional = active.length - blocking;
	const uncertain = findings.filter((finding) => finding.status === "uncertain").length;
	const historical = findings.length - active.length - uncertain;
	return [
		`${blocking} active P0-P2 finding${blocking === 1 ? "" : "s"}`,
		...(optional ? [`${optional} optional suggestion${optional === 1 ? "" : "s"}`] : []),
		...(uncertain ? [`${uncertain} uncertain`] : []),
		...(historical ? [`${historical} fixed/dismissed`] : []),
	].join("; ");
}

function reviewHeading(record: ReviewRunRecord): string {
	const identity = record.target.identity;
	const target =
		identity.kind === "pr" && identity.pullRequest
			? `PR #${identity.pullRequest.number}`
			: identity.kind === "uncommitted"
				? "Uncommitted changes"
				: identity.kind === "commit"
					? "Commit"
					: reviewText(record.target.description);
	const revision =
		identity.kind === "uncommitted" ? `tree ${identity.headTree.slice(0, 12)}` : identity.headCommit?.slice(0, 12);
	return `Review${record.result?.completionStatus === "incomplete" ? " incomplete" : ""} · ${target}${revision ? ` · ${revision}` : ""}`;
}

function compactReview(
	record: ReviewRunRecord,
	parsed: ParsedReview,
	selected: readonly ReviewFinding[],
	selection: boolean,
): string {
	const findings = parsed.findings;
	const active = findings.filter(isActive);
	const blocking = active.filter((finding) => finding.priority <= 2).length;
	const optional = active.length - blocking;
	const historical = findings.filter((finding) => finding.status === "fixed" || finding.status === "dismissed").length;
	const uncertain = findings.some((finding) => finding.status === "uncertain");
	const incomplete = parsed.completionStatus === "incomplete";
	const lines = [reviewHeading(record)];
	if (incomplete) lines.push("No overall conclusion.");
	if (selection) {
		lines.push(`Selected findings: ${selected.length} of ${findings.length} retained entries.`);
		lines.push(`Full run at session opening: ${findingCounts(findings)}.`);
		const outside = findings.filter(
			(finding) => isActive(finding) && finding.priority <= 2 && !selected.includes(finding),
		).length;
		if (outside)
			lines.push(`${outside} active P0-P2 finding${outside === 1 ? " is" : "s are"} outside this selection.`);
	} else if (incomplete || uncertain || blocking || historical) {
		lines.push(`Finding status at session opening: ${findingCounts(findings)}.`);
	} else {
		lines.push(
			`No verified P0-P2 findings in the selected change.${optional ? ` ${optional} optional suggestion${optional === 1 ? "" : "s"}.` : ""}`,
		);
	}
	if (record.options.scope.length) lines.push("Limited to the selected paths; see details.");
	if (record.parentRunId && !record.incrementalFallbackReason)
		lines.push("Includes evidence retained from a prior review.");
	if (incomplete) {
		const coverage = parsed.coverage;
		if (!coverage.changedFileInventoryComplete) lines.push("The changed-file inventory is incomplete.");
		if (coverage.context?.captureStatus === "incomplete") lines.push("Code-host context capture is incomplete.");
		if (coverage.context && !coverage.context.discoveryInspectionComplete)
			lines.push("Discovery did not inspect all captured code-host context.");
		if (coverage.context && !coverage.context.verificationInspectionComplete)
			lines.push("Verification did not inspect all captured code-host context.");
		if (uncertain) lines.push("At least one retained finding is uncertain.");
		lines.push("Independent verification or in-scope coverage is incomplete; see details.");
	}
	for (const [index, finding] of selected.entries()) {
		if (finding.status === "fixed" || finding.status === "dismissed") continue;
		lines.push(
			"",
			`### ${index + 1}. [P${finding.priority}] ${reviewText(finding.title)} (${finding.status})`,
			`ID: ${reviewText(finding.id)}  \nLocation: ${locationText(finding.changeLocation)}`,
			`Trigger: ${reviewText(finding.trigger)}  \nImpact: ${reviewText(finding.impact)}`,
		);
	}
	lines.push(
		"",
		parsed.coverage.residualRisk.includes(STATIC_REVIEW_LIMITATION)
			? STATIC_REVIEW_LIMITATION
			: "Runtime validation is not established by this report.",
	);
	if (parsed.coverage.failedVerificationAttempts.length) lines.push("Some review tool attempts failed; see details.");
	if (parsed.coverage.modelReportedLimitations.length) lines.push("Model-reported limits are recorded in details.");
	// Hard line breaks keep independent status and limitation sentences readable in Markdown.
	return lines.join("  \n");
}

function fullReview(
	record: ReviewRunRecord,
	parsed: ParsedReview,
	selected: readonly ReviewFinding[],
	selection: boolean,
): string {
	const { identity } = record.target;
	const lines = [
		`Review of ${reviewText(record.target.description)}`,
		`Run: ${reviewText(record.runId)}`,
		`Snapshot trees: ${identity.baseTree}..${identity.headTree}`,
		...(identity.headCommit ? [`Captured head commit: ${identity.headCommit}`] : []),
		`Path scope: ${record.options.scope.length ? record.options.scope.map(reviewText).join(", ") : "all changed paths"}`,
		...(record.options.focus ? [`Focus: ${reviewText(record.options.focus)}`] : []),
		...(record.parentRunId ? [`Prior run: ${reviewText(record.parentRunId)}`] : []),
		...(record.incrementalFallbackReason
			? [`Full-review fallback: ${reviewText(record.incrementalFallbackReason)}`]
			: []),
		...(selection
			? [
					`Selected findings: ${selected.length} of ${parsed.findings.length} retained entries. Unselected entries remain in the durable run.`,
				]
			: []),
		`Finding status when this session opened: ${findingCounts(parsed.findings)}.`,
		"These statuses are historical transcript data; use the canonical run for later outcomes.",
		"",
		`Original review conclusion (${new Date(record.endedAt).toISOString()}):`,
		`Status: ${parsed.completionStatus}`,
		`Summary: ${parsed.summary}`,
		`Overall: ${parsed.overallCorrectness ? `${parsed.overallCorrectness} — ` : ""}${parsed.overallExplanation}`,
		"",
		"Coverage (retained evidence; lists can be bounded):",
		`- Changed-file inventory complete: ${parsed.coverage.changedFileInventoryComplete ? "yes" : "no"}`,
		`- File paths observed: ${parsed.coverage.filesInspected.map(reviewText).join(", ") || "none"}`,
		`- Hunks inspected: ${parsed.coverage.hunksInspected.join(", ") || "none"}`,
		`- Commands recorded: ${parsed.coverage.commandsRun.join("; ") || "none"}`,
		`- Failed review tool attempts: ${parsed.coverage.failedVerificationAttempts.join("; ") || "none"}`,
	];
	if (parsed.coverage.context) {
		const context = parsed.coverage.context;
		lines.push(
			`- Code-host context: capture ${context.captureStatus}; ${context.linkedIssueCount} linked issue${context.linkedIssueCount === 1 ? "" : "s"}, ${context.discussionEntryCount} discussion entr${context.discussionEntryCount === 1 ? "y" : "ies"}; discovery ${context.discoveryInspectionComplete ? "complete" : "incomplete"}; verification ${context.verificationInspectionComplete ? "complete" : "incomplete"}`,
		);
		if (context.limitationCodes.length)
			lines.push(`- Context capture limits: ${context.limitationCodes.map(reviewText).join(", ")}`);
	}
	if (parsed.coverage.exclusions.length)
		lines.push(
			`- Exclusions: ${parsed.coverage.exclusions.map((entry) => `${reviewText(entry.path)} (${reviewText(entry.reason)})`).join("; ")}`,
		);
	if (parsed.coverage.uncheckedAreas.length) lines.push(`- Unchecked: ${parsed.coverage.uncheckedAreas.join("; ")}`);
	if (parsed.coverage.residualRisk.length) lines.push(`- Residual risk: ${parsed.coverage.residualRisk.join("; ")}`);
	if (parsed.coverage.modelReportedLimitations.length)
		lines.push(`- Model-reported limitations: ${parsed.coverage.modelReportedLimitations.join("; ")}`);
	lines.push("", "Retained findings:", "");
	if (!selected.length)
		lines.push(selection ? "No findings were selected for this session." : "No findings were retained.");
	for (const [index, finding] of selected.entries()) {
		lines.push(
			`### ${index + 1}. ${reviewText(finding.title)} [${reviewText(finding.id)}] [P${finding.priority}, confidence ${Math.round(finding.confidence * 100)}%] (${locationText(finding.changeLocation)})`,
			`Status: ${finding.status}`,
			"",
			finding.body,
			`Trigger: ${finding.trigger}`,
			`Impact: ${finding.impact}`,
			`Verification: ${finding.verification.method} — ${finding.verification.rationale}`,
			...finding.evidenceLocations.map((location) => `Evidence: ${locationText(location)}`),
			"",
		);
	}
	lines.push(
		"",
		`The original target was identified by \`${record.target.diffCommand}\`; use the retained snapshot/finding ids rather than assuming a moving ref still matches.`,
		"When asked to fix findings, select them by durable id or displayed number, inspect the current code first, and apply minimal correct fixes.",
	);
	return lines.join("\n");
}

/** Initial promotion can retain the full public result before durable storage bounds its evidence. */
export function createReviewSeedMessage(
	record: ReviewRunRecord,
	findingIds?: readonly string[],
	initialResult?: ParsedReview,
) {
	const parsed = initialResult ?? record.result;
	if (!parsed) throw new Error("Review has no validated result to open.");
	const ids = findingIds === undefined ? undefined : new Set(findingIds);
	const known = new Set(parsed.findings.map((finding) => finding.id));
	if (ids && [...ids].some((id) => !known.has(id))) throw new Error("Unknown finding ids in review selection.");
	const selected = parsed.findings.filter((finding) => !ids || ids.has(finding.id));
	return {
		customType: "review",
		content: fullReview(record, parsed, selected, ids !== undefined),
		display: true,
		details: {
			target: record.target.description,
			completionStatus: parsed.completionStatus,
			findings: structuredClone(selected),
			summary: compactReview(record, parsed, selected, ids !== undefined),
		},
	};
}
