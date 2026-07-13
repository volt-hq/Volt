import { isReleaseTarget } from "./release-target.mjs";

export const RELEASE_USAGE =
	"Usage:\n  node scripts/release.mjs prepare <major|minor|patch|x.y.z>\n  VOLT_APPROVED_CANDIDATE_RUN_ID=<run-id> node scripts/release.mjs finalize <exact-40-character-candidate-commit>";

const EXACT_COMMIT_RE = /^[0-9a-f]{40}$/;

export function parseReleaseInvocation(args) {
	const [phase, value, ...extra] = args;
	if (phase === "prepare" && isReleaseTarget(value) && extra.length === 0) {
		return { phase, target: value };
	}
	if (phase === "finalize" && EXACT_COMMIT_RE.test(value || "") && extra.length === 0) {
		return { phase, candidateCommit: value };
	}
	throw new Error(RELEASE_USAGE);
}

export function assertCandidateMatchesHead(candidateCommit, headCommit) {
	if (!EXACT_COMMIT_RE.test(candidateCommit || "")) {
		throw new Error("candidate sign-off must be an exact lowercase 40-character commit SHA");
	}
	if (!EXACT_COMMIT_RE.test(headCommit || "")) {
		throw new Error(`current HEAD is not an exact lowercase commit SHA: ${String(headCommit)}`);
	}
	if (candidateCommit !== headCommit) {
		throw new Error(`approved candidate ${candidateCommit} does not match current HEAD ${headCommit}`);
	}
	return candidateCommit;
}

export function assertCandidateRunId(runId) {
	if (!/^[1-9]\d*$/.test(runId || "")) {
		throw new Error("VOLT_APPROVED_CANDIDATE_RUN_ID must be the positive decimal ID of the approved candidate workflow run");
	}
	return runId;
}

export function assertCandidateWorkflowRun(run, { candidateCommit, runId }) {
	if (!run || typeof run !== "object" || Array.isArray(run)) {
		throw new Error("GitHub returned invalid candidate workflow run metadata");
	}
	if (String(run.id) !== runId) {
		throw new Error(`GitHub returned workflow run ${String(run.id)}; expected approved run ${runId}`);
	}
	if (run.repository?.full_name !== "hansjm10/Volt") {
		throw new Error(`approved workflow run belongs to ${String(run.repository?.full_name)}, not hansjm10/Volt`);
	}
	if (run.path !== ".github/workflows/build-standalone-candidate.yml") {
		throw new Error(`approved run used unexpected workflow ${String(run.path)}`);
	}
	if (run.event !== "workflow_dispatch") {
		throw new Error(`approved candidate run event is ${String(run.event)}, not workflow_dispatch`);
	}
	if (run.head_branch !== "main" || run.head_sha !== candidateCommit) {
		throw new Error(
			`approved candidate run is bound to ${String(run.head_branch)}@${String(run.head_sha)}, not main@${candidateCommit}`,
		);
	}
	if (run.status !== "completed" || run.conclusion !== "success") {
		throw new Error(
			`approved candidate workflow run is not successful and complete: ${String(run.status)}/${String(run.conclusion)}`,
		);
	}
	return run;
}

export function assertCandidateWorkflowArtifact(response, { candidateCommit, runId }) {
	if (!response || typeof response !== "object" || !Array.isArray(response.artifacts)) {
		throw new Error("GitHub returned invalid candidate artifact metadata");
	}
	const expectedName = `standalone-candidate-${candidateCommit}`;
	const matches = response.artifacts.filter((artifact) => artifact?.name === expectedName);
	if (response.total_count !== 1 || matches.length !== 1) {
		throw new Error(`approved workflow run ${runId} must contain exactly one ${expectedName} artifact`);
	}
	const artifact = matches[0];
	if (artifact.expired !== false) {
		throw new Error(`approved candidate artifact ${expectedName} is expired`);
	}
	if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0) {
		throw new Error(`approved candidate artifact ${expectedName} has an invalid artifact ID`);
	}
	if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0) {
		throw new Error(`approved candidate artifact ${expectedName} is empty or has an invalid size`);
	}
	if (!artifact.workflow_run || String(artifact.workflow_run.id) !== runId) {
		throw new Error(
			`approved candidate artifact belongs to workflow run ${String(artifact.workflow_run?.id)}, not ${runId}`,
		);
	}
	return artifact;
}
