#!/usr/bin/env node
/**
 * Flags changes that can break a Volt iOS build recorded in
 * .github/ios-app-baseline.json (every build Volt still supports). See "iOS
 * app compatibility" in AGENTS.md.
 *
 * A protocol contract change is app-facing when a supported build cannot
 * handle it (scripts/protocol-contract-compat.mjs, against the contract the
 * build pinned) and the pull request's base did not already have it: an
 * earlier decision covered what is on the base. A pull request that changes
 * the baseline is checked against all of it.
 *
 *   node scripts/ios-app-compat.mjs --base <git-ref>
 *     Print the app-facing changes from <git-ref> to HEAD. Pull requests pass
 *     the first parent of GitHub's merge commit.
 *
 *   node scripts/ios-app-compat.mjs --base <git-ref> --gate
 *     Also apply the pull request gate for the event in $GITHUB_EVENT_PATH and
 *     exit nonzero while the pull request is held. Labels and the recorded
 *     compatibility decision go through the gh CLI ($GH_TOKEN).
 *
 * Writes `app-facing=true|false` to $GITHUB_OUTPUT when it is set.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { contractIncompatibilities, formatIncompatibility, TOLERANCES } from "./protocol-contract-compat.mjs";

export const BASELINE_PATH = ".github/ios-app-baseline.json";
export const PROTOCOL_CONTRACT_PATH = "packages/protocol/contract/protocol-schema.json";
export const CODING_AGENT_PACKAGE_PATH = "packages/coding-agent/package.json";
export const IROH_BINDING = "@hansjm10/volt-iroh";
export const BREAKS_LABEL = "breaks-ios-app";
export const CHECKED_LABEL = "ios-compat-checked";
/** Author of the comment recording each compatibility decision (the workflow's GITHUB_TOKEN). */
export const DECISION_AUTHOR = "github-actions[bot]";

/** Inputs outside the protocol contract that the app reads or calls. */
export const APP_FACING_PATHS = [
	{
		pattern: /^packages\/coding-agent\/src\/core\/remote\/iroh\/(?:protocol|ticket|push|completion-notifications)\.ts$/,
		surface: "pairing ticket, remote features, or push payloads",
	},
	{
		pattern: /^packages\/coding-agent\/src\/core\/remote\/iroh\/(?:handshake|handshake-reader|authorization|metadata|connection)\.ts$/,
		surface: "remote handshake, authorization outcomes, host metadata, or stream serving",
	},
	{
		pattern: /^packages\/coding-agent\/src\/daemon\/(?:relay-deployments|iroh-endpoint-ticket)\.ts$/,
		surface: "managed relay and credential service origins, or the endpoint ticket in pairing tickets",
	},
	{
		pattern: /^packages\/coding-agent\/examples\/remote\/firebase-push-relay\/functions\/(?!.*\.test\.js$)[^/]+\.js$/,
		surface: "push relay function",
	},
	{
		pattern: /^services\/relay-credential-broker\/(?!.*(?:_test\.go|\.md)$)/,
		surface: "relay credential broker or relay",
	},
];

const HOLD_MESSAGE = `Labeled ${BREAKS_LABEL}. Hold until a Volt iOS build that supports this change is released, then update ${BASELINE_PATH} and remove the label.`;
const NEEDS_DECISION_MESSAGE = `This pull request changes what a supported Volt iOS build depends on (listed above). If every listed build keeps working, label it ${CHECKED_LABEL}; otherwise leave ${BREAKS_LABEL} until a supporting build is released.`;
const STALE_DECISION_MESSAGE = `The app-facing changes differ from those recorded when ${CHECKED_LABEL} was added, so that decision no longer applies. Review the current changes; if every listed build keeps working, remove ${BREAKS_LABEL} and add ${CHECKED_LABEL} again.`;
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const DECISION_MARKER_RE = /<!-- ios-app-compat-decision fingerprint=([0-9a-f]{64}) -->/;

/**
 * @typedef {{ build: string, version: string, status: string, appCommit: string, protocolContract: { voltCommit: string, sha256: string }, voltIroh: string, tolerance: "strict" | "additive" }} BaselineBuild
 * @returns {{ builds: BaselineBuild[] }}
 */
export function parseBaseline(text) {
	const baseline = JSON.parse(text);
	const builds = baseline?.builds;
	const validBuild = (build) =>
		typeof build?.build === "string" &&
		/^[1-9][0-9]*$/.test(build.build) &&
		typeof build.version === "string" &&
		typeof build.status === "string" &&
		COMMIT_RE.test(build.appCommit ?? "") &&
		COMMIT_RE.test(build.protocolContract?.voltCommit ?? "") &&
		SHA256_RE.test(build.protocolContract?.sha256 ?? "") &&
		typeof build.voltIroh === "string" &&
		build.voltIroh.length > 0 &&
		TOLERANCES.includes(build.tolerance);
	const valid =
		Array.isArray(builds) &&
		builds.length > 0 &&
		builds.every(validBuild) &&
		new Set(builds.map((build) => build.build)).size === builds.length;
	if (!valid) {
		throw new Error(
			`${BASELINE_PATH} must list builds, each once, recording build, version, status, appCommit, protocolContract, voltIroh, and tolerance (${TOLERANCES.join(" or ")}).`,
		);
	}
	return baseline;
}

/** @param {BaselineBuild} build */
export function describeBuild(build) {
	return `Volt iOS ${build.version} (${build.build}), ${build.status}`;
}

export function describeBaseline(baseline) {
	return baseline.builds.map(describeBuild).join("; ");
}

function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

function contentState(content) {
	return content === undefined ? "absent" : sha256(content);
}

function irohBinding(packageJson) {
	if (packageJson === undefined) return undefined;
	return JSON.parse(packageJson).dependencies?.[IROH_BINDING];
}

/**
 * @typedef {{ path: string, description: string, state: string, details?: string[] }} AppFacingChange
 *   `state` identifies the reviewed content: a SHA-256 of the file at HEAD,
 *   "absent", or the Iroh binding version. `details` lists what a protocol
 *   contract change breaks.
 */

/**
 * The contract a baseline build pinned, verified against its recorded hash.
 * @param {BaselineBuild} build
 * @param {(commit: string, path: string) => string | undefined} readCommit
 */
function pinnedContract(build, readCommit) {
	const { voltCommit, sha256: recorded } = build.protocolContract;
	const text = readCommit(voltCommit, PROTOCOL_CONTRACT_PATH);
	if (text === undefined) {
		throw new Error(`Cannot read the protocol contract build ${build.build} pins at ${voltCommit}; fetch full history.`);
	}
	if (sha256(text) !== recorded) {
		throw new Error(`The protocol contract at ${voltCommit} does not match the SHA-256 recorded for build ${build.build}.`);
	}
	return JSON.parse(text);
}

/** The protocol contract changes a supported build cannot handle that the base did not already have. */
function contractChange({ baseline, readBase, readHead, readCommit, baselineChanged }) {
	const headText = readHead(PROTOCOL_CONTRACT_PATH);
	if (headText === undefined) {
		return { path: PROTOCOL_CONTRACT_PATH, description: "protocol contract deleted", state: "absent" };
	}
	const head = JSON.parse(headText);
	const baseText = baselineChanged ? undefined : readBase(PROTOCOL_CONTRACT_PATH);
	const base = baseText === undefined ? undefined : JSON.parse(baseText);
	const details = [];
	for (const build of baseline.builds) {
		const pinned = pinnedContract(build, readCommit);
		const lines = (current) =>
			contractIncompatibilities({ baseline: pinned, current, tolerance: build.tolerance }).map(formatIncompatibility);
		const known = new Set(base === undefined ? [] : lines(base));
		for (const line of lines(head)) if (!known.has(line)) details.push(`build ${build.build}: ${line}`);
	}
	if (details.length === 0) return undefined;
	return {
		path: PROTOCOL_CONTRACT_PATH,
		description: `${details.length} protocol contract change(s) a supported build cannot handle`,
		state: contentState(headText),
		details,
	};
}

/**
 * @param {object} input
 * @param {readonly string[]} input.paths repository-relative paths changed by the diff
 * @param {ReturnType<typeof parseBaseline>} input.baseline
 * @param {(path: string) => string | undefined} input.readBase file contents at the base, or undefined if absent
 * @param {(path: string) => string | undefined} input.readHead file contents at HEAD, or undefined if absent
 * @param {(commit: string, path: string) => string | undefined} input.readCommit file contents at a commit
 * @returns {AppFacingChange[]} empty when nothing app-facing changed
 */
export function appFacingChanges({ paths, baseline, readBase, readHead, readCommit }) {
	const changes = [];
	const changed = new Set(paths);
	if (changed.has(PROTOCOL_CONTRACT_PATH) || changed.has(BASELINE_PATH)) {
		const change = contractChange({
			baseline,
			readBase,
			readHead,
			readCommit,
			baselineChanged: changed.has(BASELINE_PATH),
		});
		if (change) changes.push(change);
	}
	for (const path of paths) {
		const rule = APP_FACING_PATHS.find(({ pattern }) => pattern.test(path));
		if (rule) changes.push({ path, description: rule.surface, state: contentState(readHead(path)) });
	}
	if (changed.has(CODING_AGENT_PACKAGE_PATH)) {
		const before = irohBinding(readBase(CODING_AGENT_PACKAGE_PATH));
		const after = irohBinding(readHead(CODING_AGENT_PACKAGE_PATH));
		if (after !== before && baseline.builds.some((build) => build.voltIroh !== after)) {
			const versions = [...new Set(baseline.builds.map((build) => build.voltIroh))].join(", ");
			changes.push({
				path: CODING_AGENT_PACKAGE_PATH,
				description: `${IROH_BINDING} ${after ?? "removed"} (baseline ${versions})`,
				state: `${IROH_BINDING}@${after ?? "absent"}`,
			});
		}
	}
	return changes;
}

export function formatChange(change) {
	return `${change.path}: ${change.description}`;
}

/** Most details a decision comment lists per change. */
const COMMENT_DETAILS_MAX = 20;

/**
 * Identifies exactly what a compatibility decision reviewed: the app-facing
 * content and the baseline it was checked against. Any change to either
 * produces a different fingerprint.
 * @param {string} baselineText
 * @param {readonly AppFacingChange[]} changes
 */
export function decisionFingerprint(baselineText, changes) {
	const entries = changes.map(({ path, state }) => `${path}\n${state}`).sort();
	return sha256(JSON.stringify({ baseline: sha256(baselineText), changes: entries }));
}

export function decisionComment({ fingerprint, headSha, baseline, changes }) {
	const covered =
		changes.length === 0
			? ["It covers no app-facing changes; any later one needs a new decision."]
			: [
					`It covers these app-facing changes, checked against ${describeBaseline(baseline)}:`,
					"",
					...changes.flatMap((change) => {
						const details = change.details ?? [];
						const more = details.length - COMMENT_DETAILS_MAX;
						return [
							`- \`${change.path}\`: ${change.description}`,
							...details.slice(0, COMMENT_DETAILS_MAX).map((detail) => `  - ${detail}`),
							...(more > 0 ? [`  - and ${more} more`] : []),
						];
					}),
				];
	return [
		`<!-- ios-app-compat-decision fingerprint=${fingerprint} -->`,
		`iOS app compatibility: \`${CHECKED_LABEL}\` was added at ${headSha}.`,
		"",
		...covered,
		"",
		`A later change to these surfaces, or a new baseline, clears \`${CHECKED_LABEL}\`. Written by the iOS app compatibility workflow; do not edit.`,
	].join("\n");
}

export function parseDecision(body) {
	return DECISION_MARKER_RE.exec(body ?? "")?.[1];
}

/**
 * Pure gate decision. A pull request with app-facing changes passes only
 * while ios-compat-checked is present and was added for exactly these
 * changes: by this labeled event, or as recorded by an earlier one.
 *
 * @param {object} input
 * @param {boolean} input.appFacing
 * @param {string} input.fingerprint fingerprint of the current app-facing changes
 * @param {readonly string[]} input.labels labels on the pull request for this event
 * @param {string} input.action pull_request event action
 * @param {string | undefined} input.labelName label of a labeled/unlabeled event
 * @param {string | undefined} input.recordedFingerprint fingerprint of the last recorded decision
 * @returns {{ record: boolean, addLabels: string[], removeLabels: string[], ok: boolean, message: string }}
 */
export function decideGate({ appFacing, fingerprint, labels, action, labelName, recordedFingerprint }) {
	const has = new Set(labels);
	const decidedNow = action === "labeled" && labelName === CHECKED_LABEL;
	const outcome = (ok, message, extra = {}) => ({
		record: decidedNow,
		addLabels: [],
		removeLabels: [],
		ok,
		message,
		...extra,
	});
	if (!appFacing) {
		return has.has(BREAKS_LABEL) ? outcome(false, HOLD_MESSAGE) : outcome(true, "no app-facing changes.");
	}
	const approved = has.has(CHECKED_LABEL) && (decidedNow || recordedFingerprint === fingerprint);
	const removeLabels = has.has(CHECKED_LABEL) && !approved ? [CHECKED_LABEL] : [];
	if (has.has(BREAKS_LABEL)) return outcome(false, HOLD_MESSAGE, { removeLabels });
	if (approved) return outcome(true, `${CHECKED_LABEL} covers the current app-facing changes.`);
	if (removeLabels.length > 0) {
		return outcome(false, STALE_DECISION_MESSAGE, { removeLabels, addLabels: [BREAKS_LABEL] });
	}
	// Not on the gate's own label events, so removing breaks-ios-app before
	// adding ios-compat-checked does not put it back. Any other event labels: a
	// pull request opened with labels may only get a run for its labeled event.
	const gateLabelEvent =
		(action === "labeled" || action === "unlabeled") && (labelName === BREAKS_LABEL || labelName === CHECKED_LABEL);
	return outcome(false, NEEDS_DECISION_MESSAGE, { addLabels: gateLabelEvent ? [] : [BREAKS_LABEL] });
}

/**
 * The fingerprint of the decision that applies now. When ios-compat-checked
 * was added after the last recorded decision, its run may still be recording
 * it (for example when the label is added and breaks-ios-app removed at
 * once), so wait for that record instead of discarding the new decision.
 */
async function currentDecisionFingerprint({ github, fingerprint, sleep, now, waitMs, pollMs }) {
	const deadline = now() + waitMs;
	for (;;) {
		const record = github.decisionRecord();
		if (record?.fingerprint === fingerprint) return record.fingerprint;
		const labeledAt = github.latestDecisionLabelAt();
		const pending =
			labeledAt !== undefined && (record === undefined || Date.parse(record.updatedAt) < Date.parse(labeledAt));
		if (!pending || now() >= deadline) return record?.fingerprint;
		await sleep(pollMs);
	}
}

/**
 * @param {object} input
 * @param {{ action: string, label?: { name: string }, pull_request: { head: { sha: string }, labels: { name: string }[] } }} input.event
 * @param {string} input.baselineText
 * @param {ReturnType<typeof parseBaseline>} input.baseline
 * @param {readonly AppFacingChange[]} input.changes
 * @param {{ decisionRecord(): { fingerprint: string, updatedAt: string } | undefined, latestDecisionLabelAt(): string | undefined, recordDecision(body: string): void, addLabel(name: string): void, removeLabel(name: string): void }} input.github
 * @returns {Promise<boolean>} whether the pull request may merge
 */
export async function runGate({
	event,
	baselineText,
	baseline,
	changes,
	github,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now = () => Date.now(),
	waitMs = 90_000,
	pollMs = 5_000,
	log = console.log,
}) {
	const labels = event.pull_request.labels.map((label) => label.name);
	const appFacing = changes.length > 0;
	const fingerprint = decisionFingerprint(baselineText, changes);
	const decidedNow = event.action === "labeled" && event.label?.name === CHECKED_LABEL;
	const recordedFingerprint =
		appFacing && labels.includes(CHECKED_LABEL) && !decidedNow
			? await currentDecisionFingerprint({ github, fingerprint, sleep, now, waitMs, pollMs })
			: undefined;
	const decision = decideGate({
		appFacing,
		fingerprint,
		labels,
		action: event.action,
		labelName: event.label?.name,
		recordedFingerprint,
	});
	let { ok, message } = decision;
	if (decision.record) {
		try {
			github.recordDecision(
				decisionComment({ fingerprint, headSha: event.pull_request.head.sha, baseline, changes }),
			);
		} catch (error) {
			ok = false;
			message = `Could not record the ${CHECKED_LABEL} decision (${error instanceof Error ? error.message : error}). Remove and add the label again.`;
		}
	}
	// Labels only signal state: approval always comes from the recorded
	// fingerprint, so a failed label update cannot let a change through.
	for (const [names, update, verb] of [
		[decision.removeLabels, github.removeLabel, "remove"],
		[decision.addLabels, github.addLabel, "add"],
	]) {
		for (const name of names) {
			try {
				update(name);
			} catch {
				log(`::warning::Could not ${verb} the ${name} label.`);
			}
		}
	}
	log(ok ? `ios-app-compat: ${message}` : `::error::${message}`);
	return ok;
}

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function readAt(ref, path) {
	try {
		return git(["show", `${ref}:${path}`]);
	} catch {
		return undefined;
	}
}

function githubClient(repo, number) {
	const gh = (args) =>
		execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
	const jsonLines = (text) =>
		text
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	const decisionRecord = () => {
		const comments = jsonLines(
			gh([
				"api",
				"--paginate",
				`repos/${repo}/issues/${number}/comments`,
				"--jq",
				`.[] | select(.user.login == "${DECISION_AUTHOR}") | {id, body, updated_at}`,
			]),
		);
		const latest = comments.filter((comment) => parseDecision(comment.body) !== undefined).at(-1);
		return latest && { id: latest.id, fingerprint: parseDecision(latest.body), updatedAt: latest.updated_at };
	};
	return {
		decisionRecord,
		latestDecisionLabelAt() {
			return jsonLines(
				gh([
					"api",
					"--paginate",
					`repos/${repo}/issues/${number}/events`,
					"--jq",
					`.[] | select(.event == "labeled" and .label.name == "${CHECKED_LABEL}") | .created_at | tojson`,
				]),
			)
				.sort()
				.at(-1);
		},
		recordDecision(body) {
			const existing = decisionRecord();
			if (existing) {
				gh(["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
			} else {
				gh(["api", "--method", "POST", `repos/${repo}/issues/${number}/comments`, "-f", `body=${body}`]);
			}
		},
		addLabel(name) {
			gh(["api", "--method", "POST", `repos/${repo}/issues/${number}/labels`, "-f", `labels[]=${name}`]);
		},
		removeLabel(name) {
			gh(["api", "--method", "DELETE", `repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`]);
		},
	};
}

async function main(argv) {
	const gate = argv.includes("--gate");
	const args = argv.filter((arg) => arg !== "--gate");
	if (args.length !== 2 || args[0] !== "--base" || !args[1]) {
		throw new Error("Usage: node scripts/ios-app-compat.mjs --base <git-ref> [--gate]");
	}
	const base = args[1];
	const baselineText = readFileSync(BASELINE_PATH, "utf8");
	const baseline = parseBaseline(baselineText);
	// Without rename detection a moved file lists both its old and new path.
	const paths = git(["diff", "--name-only", "--no-renames", base, "HEAD"])
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const changes = appFacingChanges({
		paths,
		baseline,
		readBase: (path) => readAt(base, path),
		readHead: (path) => readAt("HEAD", path),
		readCommit: readAt,
	});
	console.log(`ios-app-compat: baseline ${describeBaseline(baseline)}.`);
	if (changes.length === 0) {
		console.log("ios-app-compat: no app-facing changes.");
	} else {
		console.log(`ios-app-compat: ${changes.length} app-facing change(s):`);
		for (const change of changes) {
			console.log(`- ${formatChange(change)}`);
			for (const detail of change.details ?? []) console.log(`  - ${detail}`);
		}
	}
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `app-facing=${changes.length > 0}\n`);
	}
	if (!gate) return;
	const { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: repo } = process.env;
	if (!eventPath || !repo) throw new Error("--gate requires GITHUB_EVENT_PATH and GITHUB_REPOSITORY.");
	const event = JSON.parse(readFileSync(eventPath, "utf8"));
	if (!event.pull_request) throw new Error("--gate requires a pull_request event.");
	const ok = await runGate({
		event,
		baselineText,
		baseline,
		changes,
		github: githubClient(repo, event.pull_request.number),
	});
	if (!ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
