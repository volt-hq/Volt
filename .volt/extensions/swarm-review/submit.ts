import type {
	ReviewCandidate,
	ReviewEngineResult,
	ReviewVerificationDecision,
	ReviewVerificationReport,
} from "@hansjm10/volt-coding-agent";
import type { ReportedFinding } from "./report.ts";
import type { Candidate, Cluster, SwarmState, Verdict, VerifiedFinding } from "./types.ts";

/** Most candidates one host report holds. */
const MAX_CANDIDATES = 50;
/** Most commands, and most failed commands, one result reports. */
const MAX_COMMANDS = 100;
/** The host's anchor limit: a finding is anchored on at most this many lines. */
const MAX_ANCHOR_LINES = 10;
/** How sure the verifiers' agreement makes a finding, which the host weighs against the claim's own confidence. */
const AGREEMENT_CONFIDENCE = { both: 0.9, one: 0.75, single: 0.6 } as const;

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Lowercase letters, digits, and single hyphens: what the host takes as a category or a root-cause key. */
export function slug(text: string, max = 80): string {
	const slugged = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/g, "");
	return slugged === "" ? "finding" : slugged;
}

function bestClaim(cluster: Cluster, finding?: { file: string }): Candidate | undefined {
	const claims = cluster.candidates;
	const here = finding === undefined ? claims : claims.filter((claim) => claim.file === finding.file);
	return [...(here.length > 0 ? here : claims)].sort((a, b) => b.confidence - a.confidence)[0];
}

/**
 * The host's candidate for a finding a verifier confirmed in `cluster`: the verifier's anchor and explanation, and
 * the trigger, impact, and confidence of the cluster's best claim, which the verified finding does not carry.
 * `position` numbers the cluster's findings, so its candidate ids and root-cause keys stay distinct.
 */
export function candidateFor(cluster: Cluster, finding: VerifiedFinding, position: number): ReviewCandidate {
	const claim = bestClaim(cluster, finding);
	const startLine = finding.line;
	const endLine = Math.max(startLine, Math.min(finding.endLine ?? startLine, startLine + MAX_ANCHOR_LINES - 1));
	return {
		candidateId: `${cluster.id}.${position}`,
		title: clip(finding.title, 200),
		body: clip(finding.fix ? `${finding.explanation}\n\nFix: ${finding.fix}` : finding.explanation, 4_000),
		trigger: clip(claim?.trigger || "See the explanation.", 1_000),
		impact: clip(claim?.impact || "See the explanation.", 1_000),
		category: "swarm",
		rootCauseKey: `${slug(cluster.title, 90)}-${slug(cluster.id, 20)}-${position}`,
		priority: Math.min(3, Math.max(0, Math.round(finding.priority))) as ReviewCandidate["priority"],
		confidence: Math.min(1, Math.max(0, claim?.confidence ?? 0.5)),
		changeLocation: { path: finding.file, side: "head", startLine, endLine },
		evidenceLocations: [],
	};
}

function verdictsOf(cluster: Cluster): Verdict[] {
	return cluster.verdicts.filter((verdict): verdict is Verdict => verdict !== undefined);
}

function methodText(finding: ReportedFinding, completedWorkers: number): string {
	const [first, second] = finding.priorities;
	const agreement =
		finding.agreement === "single"
			? "Confirmed by 1 verifier (the other failed)."
			: finding.agreement === "one"
				? "Reported by 1 of 2 verifiers; both confirmed a defect in this cluster."
				: second !== undefined && first !== second
					? `Both verifiers confirmed it (P${first} / P${second}).`
					: "Both verifiers confirmed it.";
	return clip(`${agreement} Found by ${finding.workers} of ${completedWorkers} workers.`, 1_000);
}

/** What the run could not settle, which makes the engine's own assessment incomplete: empty when nothing is open. */
function openConcerns(state: SwarmState, shardCount: number, unreviewedFiles: readonly string[]): string[] {
	const count = (outcome: Cluster["outcome"]): number =>
		state.clusters.filter((cluster) => cluster.outcome === outcome).length;
	const concerns: string[] = [];
	if (count("disputed") > 0) concerns.push(`${count("disputed")} cluster(s) where the verifiers disagreed`);
	if (count("uncertain") > 0) concerns.push(`${count("uncertain")} cluster(s) the verifiers could not settle`);
	if (count("unverified") > 0) concerns.push(`${count("unverified")} cluster(s) no verifier finished`);
	const failedWave = state.waves.find((summary) => summary.failed);
	if (failedWave) concerns.push(`every worker in wave ${failedWave.wave} failed`);
	if (unreviewedFiles.length > 0) {
		concerns.push(`${unreviewedFiles.length} file(s) in a part of the diff (of ${shardCount}) had no successful worker`);
	}
	return concerns;
}

/**
 * The result the engine submits to the host: the confirmed findings as candidates, a decision to accept each with
 * the verifiers' agreement as its method, and an assessment that is complete unless a cluster was left unsettled or
 * part of the diff had no successful worker. What the verifiers rejected, disputed, or could not settle stays in
 * the report text, which the host has no field for.
 */
export function buildSubmission(
	state: SwarmState,
	findings: readonly ReportedFinding[],
	context: {
		summary: string;
		shardCount: number;
		unreviewedFiles: readonly string[];
		completedWorkers: number;
		limitations: readonly string[];
	},
): ReviewEngineResult {
	const kept = findings.slice(0, MAX_CANDIDATES);
	const positions = new Map<string, number>();
	const candidates: ReviewCandidate[] = [];
	const decisions: ReviewVerificationDecision[] = [];
	for (const finding of kept) {
		const cluster = state.clusters.find((entry) => entry.id === finding.cluster);
		if (!cluster) continue;
		const position = (positions.get(cluster.id) ?? 0) + 1;
		positions.set(cluster.id, position);
		const candidate = candidateFor(cluster, finding, position);
		candidates.push(candidate);
		const reasons = [...new Set(verdictsOf(cluster).map((verdict) => verdict.reason))].join(" / ");
		decisions.push({
			candidateId: candidate.candidateId,
			outcome: "accept",
			method: methodText(finding, context.completedWorkers),
			rationale: clip(reasons || finding.explanation, 2_000),
			confidence: AGREEMENT_CONFIDENCE[finding.agreement],
		});
	}
	const concerns = openConcerns(state, context.shardCount, context.unreviewedFiles);
	const omitted = findings.length - kept.length;
	const limitations = [
		...context.limitations,
		...(omitted > 0 ? [`${omitted} further confirmed finding(s) are in the report text only: a host report holds ${MAX_CANDIDATES}.`] : []),
	]
		.slice(0, 30)
		.map((limitation) => clip(limitation, 500));
	const verification: ReviewVerificationReport = {
		summary: clip(context.summary, 2_000),
		assessment: concerns.length === 0 ? "complete" : "incomplete",
		...(concerns.length === 0 ? {} : { challenge: clip(`Left open: ${concerns.join("; ")}.`, 2_000) }),
		decisions,
		priorFindingDecisions: [],
		limitations,
	};
	return {
		candidates: {
			summary: clip(context.summary, 2_000),
			candidates,
			limitations,
		},
		verification,
		commandsRun: state.commands.slice(0, MAX_COMMANDS),
		failedVerificationAttempts: state.failedCommands.slice(0, MAX_COMMANDS),
	};
}
