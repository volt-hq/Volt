import { isReleaseTarget } from "./release-target.mjs";

export const RELEASE_USAGE =
	"Usage:\n" +
	"  node scripts/release.mjs prepare <major|minor|patch|x.y.z>\n" +
	"  node scripts/release.mjs prepare-pr <patch|minor>\n" +
	"  VOLT_APPROVED_CANDIDATE_RUN_ID=<run-id> node scripts/release.mjs finalize <exact-40-character-candidate-commit>\n" +
	"  VOLT_APPROVED_CANDIDATE_RUN_ID=<run-id> VOLT_APPROVED_CANDIDATE_ARTIFACT_DIGEST=<sha256:digest> node scripts/release.mjs authorize <exact-40-character-candidate-commit>";

const EXACT_COMMIT_RE = /^[0-9a-f]{40}$/;

export function parseReleaseInvocation(args) {
	const [phase, value, ...extra] = args;
	if (phase === "prepare" && isReleaseTarget(value) && extra.length === 0) {
		return { phase, target: value };
	}
	if (phase === "prepare-pr" && (value === "patch" || value === "minor") && extra.length === 0) {
		return { phase, target: value };
	}
	if (["authorize", "finalize"].includes(phase) && EXACT_COMMIT_RE.test(value || "") && extra.length === 0) {
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

export function assertCandidateArtifactDigest(digest) {
	if (!/^sha256:[0-9a-f]{64}$/.test(digest || "")) {
		throw new Error(
			"VOLT_APPROVED_CANDIDATE_ARTIFACT_DIGEST must be sha256: followed by exactly 64 lowercase hexadecimal characters",
		);
	}
	return digest;
}

export function candidateTagAttestation(candidateCommit, candidateRunId, candidateArtifactDigest) {
	assertCandidateMatchesHead(candidateCommit, candidateCommit);
	assertCandidateRunId(candidateRunId);
	const lines = [
		`Standalone-Candidate-Commit: ${candidateCommit}`,
		`Standalone-Candidate-Run: ${candidateRunId}`,
	];
	if (candidateArtifactDigest !== undefined) {
		lines.push(`Standalone-Candidate-Artifact-Digest: ${assertCandidateArtifactDigest(candidateArtifactDigest)}`);
	}
	return lines.join("\n");
}

export function createReleaseAuthorization({
	tag,
	version,
	candidateCommit,
	candidateRunId,
	candidateArtifactDigest,
}) {
	const attestation = candidateTagAttestation(candidateCommit, candidateRunId, candidateArtifactDigest);
	const tagMessage = `Release ${tag}\n\n${attestation}`;
	return {
		tag,
		version,
		"candidate-commit": candidateCommit,
		"candidate-run-id": candidateRunId,
		"candidate-artifact-digest": candidateArtifactDigest,
		"tag-message-base64": Buffer.from(tagMessage, "utf8").toString("base64"),
	};
}

export function formatGitHubOutputs(outputs) {
	const lines = [];
	for (const [name, rawValue] of Object.entries(outputs)) {
		if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
			throw new Error(`Invalid GitHub output name: ${name}`);
		}
		const value = String(rawValue);
		if (value.includes("\n") || value.includes("\r")) {
			const delimiter = `VOLT_${name.replaceAll("-", "_").toUpperCase()}_EOF`;
			if (value.split(/\r?\n/).includes(delimiter)) {
				throw new Error(`GitHub output ${name} contains its reserved delimiter`);
			}
			lines.push(`${name}<<${delimiter}`, value, delimiter);
		} else {
			lines.push(`${name}=${value}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

export function assertReleaseTagMatchesCandidate({ tag, candidateCommit, tagType, taggedCommit, tagMessage }) {
	assertCandidateMatchesHead(candidateCommit, candidateCommit);
	if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag || "")) {
		throw new Error(`release tag is not canonical: ${String(tag)}`);
	}
	if (tagType !== "tag") {
		throw new Error(`${tag} must be an existing annotated release tag`);
	}
	if (taggedCommit !== candidateCommit) {
		throw new Error(`${tag} points to ${String(taggedCommit)}, not exact candidate ${candidateCommit}`);
	}
	const lines = typeof tagMessage === "string" ? tagMessage.split(/\r?\n/) : [];
	const commitLines = lines.filter((line) => line.startsWith("Standalone-Candidate-Commit: "));
	const runLines = lines.filter((line) => line.startsWith("Standalone-Candidate-Run: "));
	const digestLines = lines.filter((line) => line.startsWith("Standalone-Candidate-Artifact-Digest: "));
	if (
		lines[0] !== `Release ${tag}` ||
		commitLines.length !== 1 ||
		commitLines[0] !== `Standalone-Candidate-Commit: ${candidateCommit}` ||
		runLines.length !== 1
	) {
		throw new Error(`${tag} does not contain the exact candidate release attestation`);
	}
	const candidateRunId = assertCandidateRunId(runLines[0].slice("Standalone-Candidate-Run: ".length));
	if (digestLines.length > 1) {
		throw new Error(`${tag} contains more than one candidate artifact digest`);
	}
	const candidateArtifactDigest = digestLines.length === 1
		? assertCandidateArtifactDigest(digestLines[0].slice("Standalone-Candidate-Artifact-Digest: ".length))
		: undefined;
	return { candidateArtifactDigest, candidateRunId };
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

export function assertCandidateWorkflowArtifact(response, { candidateCommit, runId, artifactDigest }) {
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
	if (artifactDigest !== undefined) {
		assertCandidateArtifactDigest(artifactDigest);
		if (artifact.digest !== artifactDigest) {
			throw new Error(
				`approved candidate artifact digest is ${String(artifact.digest)}, not explicitly approved digest ${artifactDigest}`,
			);
		}
	}
	return artifact;
}
