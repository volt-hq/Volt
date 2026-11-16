/**
 * The swarm review engine's pure parts: how it lays out the host's hunks for each worker, what its workers reviewed,
 * how it maps verified findings onto the host's report shapes, resolves its options, writes its report, and reads
 * base files through the host. The engine as a whole runs in test/suite/swarm-review-engine.test.ts.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewEngineChangedFile, ReviewEngineContext, ToolDefinition } from "@hansjm10/volt-coding-agent";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { createBaseReader } from "../../../.volt/extensions/swarm-review/base.ts";
import { loadContextFiles } from "../../../.volt/extensions/swarm-review/context-files.ts";
import { resolveOptions } from "../../../.volt/extensions/swarm-review/index.ts";
import { loadDismissals, recordDismissals } from "../../../.volt/extensions/swarm-review/memory.ts";
import {
	buildReport,
	discoveryCoverage,
	type ReportedFinding,
	reportSummary,
} from "../../../.volt/extensions/swarm-review/report.ts";
import { buildSubmission, candidateFor, slug } from "../../../.volt/extensions/swarm-review/submit.ts";
import {
	DIFF_PAGE_BYTES,
	layoutDiff,
	MAX_INLINE_BYTES,
	pageCount,
} from "../../../.volt/extensions/swarm-review/target.ts";
import { canonicalHeadPath, createRepositoryTools } from "../../../.volt/extensions/swarm-review/tools.ts";
import type {
	Candidate,
	Cluster,
	PassState,
	ReviewTarget,
	SwarmSetup,
	SwarmState,
	WorkerState,
} from "../../../.volt/extensions/swarm-review/types.ts";
import { ReviewCandidateReportSchema, ReviewVerificationReportSchema } from "../src/core/review-report.ts";
import { type ReviewSnapshot, resolveReviewSnapshot } from "../src/core/review-snapshot.ts";
import { createByteReviewRepository, BYTE_REVIEW_PATHS as P } from "./utilities/byte-review-repository.ts";

function file(
	path: string,
	hunkBytes: number[],
	overrides: Partial<ReviewEngineChangedFile> = {},
): ReviewEngineChangedFile {
	return {
		path,
		status: "modified",
		reviewable: true,
		inScope: true,
		hunks: hunkBytes.map((patchBytes, index) => ({
			id: `${path}#${index}`,
			header: "@@",
			oldStart: 1,
			oldCount: 1,
			newStart: 1,
			newCount: 1,
			patchBytes,
		})),
		...overrides,
	};
}

describe("laying out the change for every worker", () => {
	it("carries a small change in the prompt whole, with each file's hunks and sizes", () => {
		const { hunkIds, inlineHunkIds, pagedFiles, fileHunks, hunkBytes } = layoutDiff([
			file("a.ts", [100, 200]),
			file("b.ts", [50]),
		]);
		expect(hunkIds).toEqual(["a.ts#0", "a.ts#1", "b.ts#0"]);
		expect(inlineHunkIds).toEqual(hunkIds);
		expect(pagedFiles).toEqual([]);
		expect(fileHunks).toEqual(
			new Map([
				["a.ts", ["a.ts#0", "a.ts#1"]],
				["b.ts", ["b.ts#0"]],
			]),
		);
		expect(hunkBytes.get("a.ts#1")).toBe(200);
	});

	it("pages a file that no longer fits whole, and keeps carrying later files that do", () => {
		const half = MAX_INLINE_BYTES / 2 - 600;
		const layout = layoutDiff([file("a.ts", [half]), file("b.ts", [half, half]), file("c.ts", [half - 1_000])]);
		// Every worker reviews every hunk; only how they reach it differs.
		expect(layout.hunkIds).toEqual(["a.ts#0", "b.ts#0", "b.ts#1", "c.ts#0"]);
		expect(layout.inlineHunkIds).toEqual(["a.ts#0", "c.ts#0"]);
		expect(layout.pagedFiles).toEqual(["b.ts"]);
	});

	it("pages a file with a hunk larger than the prompt's budget", () => {
		const layout = layoutDiff([file("a.ts", [10]), file("big.ts", [MAX_INLINE_BYTES + 1]), file("c.ts", [10])]);
		expect(layout.inlineHunkIds).toEqual(["a.ts#0", "c.ts#0"]);
		expect(layout.pagedFiles).toEqual(["big.ts"]);
	});

	it("counts the review_diff pages it takes to read files whole, each file on its own", () => {
		const layout = layoutDiff([file("big.ts", [DIFF_PAGE_BYTES * 2]), file("small.ts", [10])]);
		expect(pageCount(layout, ["big.ts"])).toBe(3);
		expect(pageCount(layout, ["small.ts"])).toBe(1);
		expect(pageCount(layout, ["big.ts", "small.ts"])).toBe(4);
		expect(pageCount(layout, [])).toBe(0);
	});

	it("holds nothing for no files", () => {
		expect(layoutDiff([])).toMatchObject({ hunkIds: [], inlineHunkIds: [], pagedFiles: [] });
	});
});

describe("what the workers reviewed", () => {
	const layout = layoutDiff([file("a.ts", [1, 1]), file("b.ts", [1])]);
	const worker = (status: WorkerState["status"], missedHunks: string[]): WorkerState => ({
		index: 0,
		wave: 1,
		missedHunks,
		status,
		toolCalls: 0,
		turns: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		candidates: [],
		dropped: 0,
	});

	it("counts a finished worker that read every hunk as a full review", () => {
		expect(discoveryCoverage(layout, [worker("done", []), worker("done", ["b.ts#0"])])).toEqual({
			completed: 2,
			fullReviews: 1,
			unreviewedFiles: [],
		});
	});

	it("counts no full review when workers read the change only between them", () => {
		expect(discoveryCoverage(layout, [worker("done", ["a.ts#1"]), worker("done", ["b.ts#0"])])).toEqual({
			completed: 2,
			fullReviews: 0,
			unreviewedFiles: [],
		});
	});

	it("names the files with a hunk no finished worker read, ignoring workers that did not finish", () => {
		const workers = [worker("done", ["b.ts#0"]), worker("done", ["a.ts#0", "b.ts#0"]), worker("failed", [])];
		expect(discoveryCoverage(layout, workers)).toEqual({ completed: 2, fullReviews: 0, unreviewedFiles: ["b.ts"] });
		expect(discoveryCoverage(layout, [worker("failed", [])]).unreviewedFiles).toEqual(["a.ts", "b.ts"]);
	});
});

function claim(overrides: Partial<Candidate> = {}): Candidate {
	return {
		id: "C1",
		worker: 0,
		wave: 1,
		title: "Zero returns the numerator",
		file: "src/value.ts",
		line: 2,
		priority: 2,
		confidence: 0.8,
		trigger: "Call divide with a zero divisor.",
		impact: "Callers get the numerator.",
		evidence: "The added guard returns amount.",
		...overrides,
	};
}

function cluster(overrides: Partial<Cluster> = {}): Cluster {
	return {
		id: "K1",
		title: "Zero divisor guard returns the wrong value!",
		candidates: [
			claim(),
			claim({ id: "C2", worker: 1, confidence: 0.95, trigger: "Divide by zero.", impact: "Wrong result." }),
		],
		wave: 1,
		verifiers: [],
		verdicts: [
			{ verdict: "confirmed", reason: "The guard returns amount.", findings: [] },
			{ verdict: "confirmed", reason: "Reproduced by reading the branch.", findings: [] },
		],
		outcome: "confirmed",
		...overrides,
	};
}

function state(clusters: Cluster[], overrides: Partial<SwarmState> = {}): SwarmState {
	return {
		workers: [],
		clusters,
		waves: [],
		phase: "done",
		currentWave: 1,
		clusterPasses: [],
		nextCandidate: 0,
		commands: [],
		failedCommands: [],
		cancelling: false,
		saturated: false,
		...overrides,
	};
}

function reported(overrides: Partial<ReportedFinding> = {}): ReportedFinding {
	return {
		title: "Zero returns the numerator",
		file: "src/value.ts",
		line: 2,
		priority: 2,
		explanation: "The added guard returns amount.",
		cluster: "K1",
		workers: 2,
		agreement: "both",
		priorities: [2, 2],
		...overrides,
	};
}

describe("a verified finding as the host's candidate", () => {
	it("takes the verifier's anchor and explanation and the best claim's trigger, impact, and confidence", () => {
		const candidate = candidateFor(
			cluster(),
			{ title: "T", file: "src/value.ts", line: 2, priority: 1, explanation: "Why.", fix: "Throw." },
			1,
		);
		expect(candidate).toEqual({
			candidateId: "K1.1",
			title: "T",
			body: "Why.\n\nFix: Throw.",
			trigger: "Divide by zero.",
			impact: "Wrong result.",
			category: "swarm",
			rootCauseKey: "zero-divisor-guard-returns-the-wrong-value-k1-1",
			priority: 1,
			confidence: 0.95,
			changeLocation: { path: "src/value.ts", side: "head", startLine: 2, endLine: 2 },
			evidenceLocations: [],
		});
	});

	it("prefers a claim about the finding's own file, and has defaults when the cluster has none", () => {
		const two = cluster({
			candidates: [
				claim({ file: "a.ts", confidence: 0.99, trigger: "Elsewhere." }),
				claim({ id: "C2", file: "b.ts", trigger: "Here." }),
			],
		});
		expect(candidateFor(two, { title: "T", file: "b.ts", line: 1, priority: 2, explanation: "E" }, 1).trigger).toBe(
			"Here.",
		);
		const empty = candidateFor(
			cluster({ candidates: [] }),
			{ title: "T", file: "b.ts", line: 1, priority: 2, explanation: "E" },
			1,
		);
		expect(empty).toMatchObject({ trigger: "See the explanation.", impact: "See the explanation.", confidence: 0.5 });
	});

	it("limits an anchor to ten lines, an overlong text to the host's limits, and keeps keys distinct per finding", () => {
		const finding = {
			title: "x".repeat(300),
			file: "a.ts",
			line: 5,
			endLine: 90,
			priority: 2,
			explanation: "e".repeat(5_000),
		};
		const first = candidateFor(cluster(), finding, 1);
		const second = candidateFor(cluster(), finding, 2);
		expect(first.changeLocation).toMatchObject({ startLine: 5, endLine: 14 });
		expect(first.title).toHaveLength(200);
		expect(first.body).toHaveLength(4_000);
		expect(first.rootCauseKey).not.toBe(second.rootCauseKey);
		expect(first.candidateId).not.toBe(second.candidateId);
		expect(candidateFor(cluster(), { ...finding, endLine: 2 }, 1).changeLocation.endLine).toBe(5);
		expect(candidateFor(cluster(), { ...finding, priority: 9 }, 1).priority).toBe(3);
	});

	it("makes a kebab-case slug of anything", () => {
		expect(slug("Null deref in `parse()` -- when empty!")).toBe("null-deref-in-parse-when-empty");
		expect(slug("")).toBe("finding");
		expect(slug("***")).toBe("finding");
		expect(slug("a".repeat(200), 20)).toHaveLength(20);
		expect(slug("ab-".repeat(40), 6)).toBe("ab-ab");
	});
});

const context = {
	summary: "1 confirmed finding(s).",
	fullReviews: 2,
	unreviewedFiles: [],
	completedWorkers: 2,
	limitations: [],
};

describe("the result the engine submits", () => {
	it("is in the host's own report shapes, with a decision to accept each finding", () => {
		const result = buildSubmission(state([cluster()]), [reported()], context);
		expect(Check(ReviewCandidateReportSchema, result.candidates)).toBe(true);
		expect(Check(ReviewVerificationReportSchema, result.verification)).toBe(true);
		expect(result.candidates.candidates).toHaveLength(1);
		expect(result.verification.decisions).toEqual([
			{
				candidateId: "K1.1",
				outcome: "accept",
				method: "Both verifiers confirmed it. Found by 2 of 2 workers.",
				rationale: "The guard returns amount. / Reproduced by reading the branch.",
				confidence: 0.9,
			},
		]);
		expect(result.verification).toMatchObject({ assessment: "complete", priorFindingDecisions: [] });
		expect(result.verification).not.toHaveProperty("challenge");
	});

	it("says how the verifiers agreed", () => {
		const methods = (finding: Partial<ReportedFinding>) =>
			buildSubmission(state([cluster()]), [reported(finding)], context).verification.decisions[0];
		expect(methods({ agreement: "single", priorities: [2] })).toMatchObject({
			method: "Confirmed by 1 verifier (the other failed). Found by 2 of 2 workers.",
			confidence: 0.6,
		});
		expect(methods({ agreement: "one", priorities: [2] })).toMatchObject({
			method: "Reported by 1 of 2 verifiers; both confirmed a defect in this cluster. Found by 2 of 2 workers.",
			confidence: 0.75,
		});
		expect(methods({ priorities: [1, 2] })?.method).toContain("(P1 / P2)");
	});

	it("is complete with no findings when nothing was found and nothing is open", () => {
		const result = buildSubmission(state([]), [], { ...context, summary: "0 confirmed finding(s)." });
		expect(result.candidates.candidates).toEqual([]);
		expect(result.verification).toMatchObject({ assessment: "complete", decisions: [] });
	});

	it("is incomplete, naming what was left open, when verifiers disagreed or no worker reviewed the whole change", () => {
		const open = (outcome: Cluster["outcome"]) => cluster({ id: outcome, outcome });
		const result = buildSubmission(
			state([open("disputed"), open("uncertain"), open("unverified")], {
				waves: [{ wave: 2, workers: 3, candidates: 0, newClusters: 0, clusteringFallback: false, failed: true }],
			}),
			[],
			{ ...context, fullReviews: 0, unreviewedFiles: ["a.ts", "b.ts"] },
		);
		expect(result.verification.assessment).toBe("incomplete");
		expect(result.verification.challenge).toBe(
			"Left open: 1 cluster(s) where the verifiers disagreed; 1 cluster(s) the verifiers could not settle; 1 cluster(s) no verifier finished; every worker in wave 2 failed; no successful worker reviewed the whole change; 2 file(s) had diff no successful worker read.",
		);
		// Workers that read the change only between them are no independent review of all of it.
		const between = buildSubmission(state([]), [], { ...context, fullReviews: 0 });
		expect(between.verification).toMatchObject({
			assessment: "incomplete",
			challenge: "Left open: no successful worker reviewed the whole change.",
		});
		expect(Check(ReviewVerificationReportSchema, result.verification)).toBe(true);
		// A cluster the verifiers rejected or the memory suppressed settles nothing open.
		const settled = buildSubmission(state([open("rejected"), open("suppressed"), open("single")]), [], context);
		expect(settled.verification.assessment).toBe("complete");
	});

	it("keeps the host's limit of fifty candidates, and says the rest are in the report text", () => {
		const clusters = Array.from({ length: 60 }, (_, index) =>
			cluster({ id: `K${index + 1}`, title: `Defect ${index + 1}` }),
		);
		const findings = clusters.map((entry) => reported({ cluster: entry.id, title: `Finding ${entry.id}` }));
		const result = buildSubmission(state(clusters), findings, context);
		expect(result.candidates.candidates).toHaveLength(50);
		expect(result.verification.decisions).toHaveLength(50);
		expect(result.candidates.limitations).toEqual([
			"10 further confirmed finding(s) are in the report text only: a host report holds 50.",
		]);
		expect(Check(ReviewCandidateReportSchema, result.candidates)).toBe(true);
		expect(Check(ReviewVerificationReportSchema, result.verification)).toBe(true);
	});

	it("numbers a cluster's findings and reports the commands verifiers ran, bounded", () => {
		const result = buildSubmission(
			state([cluster()], {
				commands: Array.from({ length: 150 }, (_, index) => `npm test ${index}`),
				failedCommands: ["npm run broken"],
			}),
			[reported({ title: "One" }), reported({ title: "Two", line: 3 })],
			context,
		);
		expect(result.candidates.candidates.map((candidate) => candidate.candidateId)).toEqual(["K1.1", "K1.2"]);
		expect(new Set(result.candidates.candidates.map((candidate) => candidate.rootCauseKey)).size).toBe(2);
		expect(result.commandsRun).toHaveLength(100);
		expect(result.failedVerificationAttempts).toEqual(["npm run broken"]);
	});

	it("passes the engine's limitations on, each within the host's limit", () => {
		const result = buildSubmission(state([]), [], { ...context, limitations: ["x".repeat(900), "Second."] });
		expect(result.verification.limitations[0]).toHaveLength(500);
		expect(result.verification.limitations[1]).toBe("Second.");
	});
});

describe("the options of a run", () => {
	const engine = (
		params: Record<string, string | boolean | number>,
		controls: { focus?: string; scope?: string[]; effort?: string } = {},
		tools: string[] = [],
	) =>
		({
			params,
			target: { controls: { scope: [], effort: "standard", includeOptional: false, ...controls } },
			tools,
		}) as unknown as Pick<ReviewEngineContext, "params" | "target" | "tools">;

	it("takes the extension's setting for what the run does not set, and a hard default for what neither sets", () => {
		expect(resolveOptions(engine({}), {})).toMatchObject({
			workers: 30,
			waveSize: 10,
			concurrency: 10,
			thinking: "max",
			verifierThinking: "high",
			verifierConcurrency: 6,
			exec: false,
			fresh: false,
			scope: [],
		});
		expect(resolveOptions(engine({}), {})).not.toHaveProperty("stragglerGrace");
		expect(
			resolveOptions(engine({}), { workers: 12, waveSize: 4, workerThinking: "low", verifierConcurrency: 3 }),
		).toMatchObject({
			workers: 12,
			waveSize: 4,
			concurrency: 4,
			thinking: "low",
			verifierConcurrency: 3,
		});
	});

	it("lets a parameter win over a setting, and keeps the wave within the workers", () => {
		expect(
			resolveOptions(engine({ workers: 3, waveSize: 20, workerThinking: "high", fresh: true }), { workers: 12 }),
		).toMatchObject({
			workers: 3,
			waveSize: 3,
			thinking: "high",
			fresh: true,
		});
	});

	it("takes concurrency and straggler grace from settings only", () => {
		expect(resolveOptions(engine({}), { concurrency: 2, verifierConcurrency: 1, stragglerGrace: 40 })).toMatchObject({
			concurrency: 2,
			verifierConcurrency: 1,
			stragglerGrace: 40,
		});
		expect(resolveOptions(engine({ concurrency: 2, verifierConcurrency: 1, stragglerGrace: 40 }), {})).toMatchObject({
			concurrency: 10,
			verifierConcurrency: 6,
		});
		expect(resolveOptions(engine({ stragglerGrace: 40 }), {})).not.toHaveProperty("stragglerGrace");
	});

	it("runs one wave at low effort unless the run sets the workers, and every wave at high effort", () => {
		expect(resolveOptions(engine({}), {})).toMatchObject({ workers: 30, waveSize: 10, stopWhenSaturated: true });
		expect(resolveOptions(engine({}, { effort: "low" }), {})).toMatchObject({
			workers: 10,
			waveSize: 10,
			stopWhenSaturated: true,
		});
		// Low effort never raises a smaller budget, and an explicit worker count still wins.
		expect(resolveOptions(engine({}, { effort: "low" }), { workers: 6 })).toMatchObject({ workers: 6, waveSize: 6 });
		expect(resolveOptions(engine({ workers: 20 }, { effort: "low" }), {})).toMatchObject({
			workers: 20,
			waveSize: 10,
		});
		expect(resolveOptions(engine({}, { effort: "high" }), {})).toMatchObject({
			workers: 30,
			stopWhenSaturated: false,
		});
	});

	it("lets verifiers run commands only when the review grants bash", () => {
		expect(resolveOptions(engine({}), {})).toMatchObject({ exec: false });
		expect(resolveOptions(engine({}, {}, ["bash"]), {})).toMatchObject({ exec: true });
		// Not a parameter of its own any more: the grant is the review's.
		expect(resolveOptions(engine({ exec: true }), {})).toMatchObject({ exec: false });
	});

	it("passes the review's focus and scope on, and ignores a setting of the wrong type", () => {
		expect(
			resolveOptions(engine({}, { focus: "auth", scope: ["src/**"] }), {
				workers: "many",
				workerThinking: "extreme",
			}),
		).toMatchObject({
			focus: "auth",
			scope: ["src/**"],
			workers: 30,
			thinking: "max",
		});
		expect(resolveOptions(engine({ workerModel: "faux/faux-1", verifierModel: "" }), {})).toMatchObject({
			model: "faux/faux-1",
		});
		expect(resolveOptions(engine({ verifierModel: "" }), {})).not.toHaveProperty("verifier");
	});
});

describe("the report", () => {
	const usage = (cost: number) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost });
	const pass = (cost: number): PassState => ({ status: "done", toolCalls: 0, turns: 1, usage: usage(cost) });
	const worker = (index: number, cost: number, missedHunks: string[] = []): WorkerState => ({
		...pass(cost),
		index,
		wave: 1,
		missedHunks,
		candidates: [],
		dropped: 0,
	});
	const confirmed = cluster({
		verifiers: [pass(1), pass(1.5)],
		verdicts: [
			{ verdict: "confirmed", reason: "Guard returns amount.", findings: [reported()] },
			{ verdict: "confirmed", reason: "Read the branch.", findings: [reported()] },
		],
	});
	const rejected = cluster({
		id: "K2",
		title: "Overflow",
		outcome: "rejected",
		verdicts: [
			{ verdict: "rejected", reason: "Bounded input.", findings: [] },
			{ verdict: "rejected", reason: "Bounded input.", findings: [] },
		],
	});
	const suppressed = cluster({
		id: "K3",
		title: "Old issue",
		outcome: "suppressed",
		verdicts: [],
		suppressedBy: { title: "Old issue", reason: "Intended." },
	});
	const setup = {
		options: { workers: 2, waveSize: 2, thinking: "max", verifierThinking: "high", exec: false },
		target: {
			description: "uncommitted changes",
			scope: [],
			...layoutDiff([file("src/value.ts", [100])]),
			submodules: false,
		},
		workerModel: { provider: "faux", id: "worker" },
		verifierModel: { provider: "faux", id: "verifier" },
		engine: { target: { controls: { includeOptional: true } } },
	} as unknown as SwarmSetup;

	it("counts only the outcomes some cluster had, leads the cost with its total, and says how to undo the memory", () => {
		const run = state([confirmed, rejected, suppressed], {
			workers: [worker(0, 0.5), worker(1, 0.5)],
			clusterPasses: [pass(0.25)],
			waves: [{ wave: 1, workers: 2, candidates: 2, newClusters: 2, clusteringFallback: false }],
		});
		const { markdown, findings } = buildReport(setup, run, 65_000, 2);
		expect(findings).toHaveLength(1);
		expect(markdown).toContain(": **1 confirmed finding(s)**, 1 rejected, 1 suppressed");
		expect(markdown).not.toContain("disputed");
		expect(markdown).not.toContain("uncertain");
		expect(markdown).toContain("Estimated cost: $3.75 (workers $1.00 · clustering $0.25 · verifiers $2.50) · 1m 5s");
		expect(markdown).toContain("Rerun with `--fresh` to verify them again.");
		expect(markdown).toContain("Remembered 2 rejected issue(s) for future reviews; `--fresh` ignores them.");
	});

	it("says how many workers reviewed the whole change, and names what none of them read", () => {
		const paged = {
			...setup,
			target: { ...setup.target, ...layoutDiff([file("big.ts", [MAX_INLINE_BYTES + 1])]) },
		} as SwarmSetup;
		const whole = buildReport(paged, state([], { workers: [worker(0, 0), worker(1, 0, ["big.ts#0"])] }), 1_000, 0);
		expect(whole.markdown).toContain(
			"1 of 2 workers reviewed the whole change; the diffs of 1 file(s) did not fit the prompt and were paged.",
		);
		expect(whole.markdown).not.toContain("Not reviewed");
		const none = buildReport(paged, state([], { workers: [worker(0, 0, ["big.ts#0"])] }), 1_000, 0);
		expect(none.markdown).toContain(
			"**Not reviewed:** no finished worker read the whole diff of 1 file(s) (big.ts).",
		);
		// A change every worker's prompt carries whole needs no word on it.
		const inline = buildReport(setup, state([], { workers: [worker(0, 0)] }), 1_000, 0);
		expect(inline.markdown).not.toContain("reviewed the whole change");
	});

	it("summarizes without the outcomes no cluster had", () => {
		expect(reportSummary(state([]), [])).toBe("0 confirmed finding(s).");
		expect(reportSummary(state([confirmed, rejected]), [reported()])).toBe(
			"1 confirmed finding(s), 1 rejected.\n1. [P2] Zero returns the numerator (src/value.ts:2)",
		);
	});
});

describe("swarm canonical path boundaries", () => {
	const directories: string[] = [];
	const snapshots: ReviewSnapshot[] = [];
	afterEach(async () => {
		for (const snapshot of snapshots.splice(0)) await snapshot.dispose();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});
	function target(checkout: string): ReviewTarget {
		return {
			repoRoot: checkout,
			checkout,
			description: "paths",
			stat: "",
			scope: [],
			...layoutDiff([]),
			submodules: false,
			commonDir: join(checkout, ".git"),
			readBase: async () => undefined,
		};
	}

	it("validates a reported path against the head through the host, and names the reference of a checkout filename", async () => {
		const repository = mkdtempSync(join(tmpdir(), "volt-swarm-byte-host-"));
		directories.push(repository);
		const sha = createByteReviewRepository(repository);
		const snapshot = await resolveReviewSnapshot({ kind: "commit", sha }, repository, {
			maxCommitRefBytes: 1024,
			maxPullRequestNumber: 2147483647,
		});
		if ("error" in snapshot) throw new Error(snapshot.error);
		snapshots.push(snapshot);
		// The host's answer, as its engine context gives it: whether the snapshot has a text file there.
		const engine: Pick<ReviewEngineContext, "hasTextFile"> = {
			hasTextFile: async (path, side) => {
				const file = await snapshot.readFile(side, path);
				return file?.available === true && !file.binary;
			},
		};
		// None of these has a file of its name in any checkout on this system; the head has them all.
		for (const path of [P.fe, P.ff, P.replacement, P.literal])
			await expect(canonicalHeadPath(engine, path)).resolves.toBe(path);
		await expect(canonicalHeadPath(engine, "collision-%ff.txt")).rejects.toThrow(/uppercase/);
		await expect(canonicalHeadPath(engine, P.deleted)).rejects.toThrow(/does not exist/);
		await expect(canonicalHeadPath(engine, `./${P.shared}`)).rejects.toThrow(
			`Report the canonical snapshot path reference ${P.shared}.`,
		);
		// A reviewer that read the file with a checkout tool may report the name it saw there.
		await expect(canonicalHeadPath(engine, "back\\slash.txt")).rejects.toThrow(`Report ${P.backslash}.`);
	});

	it("opens the checkout's own filenames, never a name decoded from a reference", async () => {
		const checkout = mkdtempSync(join(tmpdir(), "volt-swarm-byte-checkout-"));
		directories.push(checkout);
		writeFileSync(join(checkout, "100%.ts"), "actual percent\n");
		writeFileSync(join(checkout, "100%25.ts"), "literal escape spelling\n");
		const tools: ToolDefinition[] = createRepositoryTools(target(checkout), checkout);
		const read = tools.find((tool) => tool.name === "read");
		if (!read) throw new Error("Expected read tool");
		const percent = await read.execute("read", { path: "100%.ts" }, undefined, undefined, {} as never);
		expect(percent.content).toEqual([{ type: "text", text: expect.stringContaining("actual percent") }]);
		// A string spelled like the reference of 100%.ts is the name of another file here.
		const literal = await read.execute("read", { path: "100%25.ts" }, undefined, undefined, {} as never);
		expect(literal.content).toEqual([{ type: "text", text: expect.stringContaining("literal escape spelling") }]);
		await expect(read.execute("read", { path: "../outside" }, undefined, undefined, {} as never)).rejects.toThrow(
			/outside the repository/,
		);
	});

	it("looks up the scoped policy of a working directory by its review path", async () => {
		const repository = realpathSync(mkdtempSync(join(tmpdir(), "volt-swarm-context-")));
		directories.push(repository);
		mkdirSync(join(repository, "100%"));
		// The base's policy files under the directory named 100%, by their review paths.
		const base: Record<string, string> = {
			"100%25/AGENTS.md": "SCOPED AGENT POLICY\n",
			"100%25/REVIEW.md": "SCOPED REVIEW POLICY\n",
		};
		const asked: string[] = [];
		const files = await loadContextFiles(
			repository,
			async (path) => {
				asked.push(path);
				return base[path];
			},
			join(repository, "100%"),
			new AbortController().signal,
		);
		expect(files.filter((file) => file.path.startsWith("base:"))).toEqual([
			{ path: "base:100%25/AGENTS.md", content: "SCOPED AGENT POLICY\n" },
			{ path: "base:100%25/REVIEW.md", content: "SCOPED REVIEW POLICY\n" },
		]);
		expect(asked.some((path) => path.startsWith("100%/"))).toBe(false);
	});

	it("keeps canonical dismissal identity while reading the actual percent filename", async () => {
		const checkout = mkdtempSync(join(tmpdir(), "volt-swarm-byte-memory-"));
		directories.push(checkout);
		writeFileSync(join(checkout, "100%.ts"), "anchored source\ncontext\n");
		const review = target(checkout);
		await expect(
			recordDismissals(review, [
				cluster({
					outcome: "rejected",
					candidates: [claim({ file: "100%25.ts", line: 1 })],
					verdicts: [{ verdict: "rejected", reason: "Intended", findings: [] }],
				}),
			]),
		).resolves.toBe(1);
		expect(loadDismissals(review)).toMatchObject([{ file: "100%25.ts", reason: "Intended" }]);
	});
});

describe("reading a base file through the host", () => {
	/** A host whose review_file tool pages `files` the way the real one does: numbered lines, a cursor after the page. */
	function host(files: Record<string, string>, pageLines = 2) {
		const calls: unknown[] = [];
		const tool = {
			name: "review_file",
			async execute(_id: string, params: { path: string; revision: string; limit: number; cursor?: string }) {
				calls.push(params);
				const content = files[params.path];
				if (content === undefined) throw new Error(`File does not exist in the base snapshot: ${params.path}`);
				const lines = content.split("\n");
				const start = params.cursor === undefined ? 0 : Number(params.cursor);
				const end = Math.min(lines.length, start + pageLines);
				const text = lines
					.slice(start, end)
					.map((line, index) => `${start + index + 1}: ${line}`)
					.join("\n");
				return { content: [{ type: "text", text: end < lines.length ? `${text}\n\nNext cursor: ${end}` : text }] };
			},
		};
		return { calls, engine: { pass: () => ({ tools: () => [tool] }) } as unknown as ReviewEngineContext };
	}

	it("undoes the line numbers and the paging", async () => {
		const { engine, calls } = host({ "AGENTS.md": "# Rules\n\n1: not a number prefix\nlast" });
		const readBase = createBaseReader(engine);
		await expect(readBase("AGENTS.md", new AbortController().signal)).resolves.toBe(
			"# Rules\n\n1: not a number prefix\nlast",
		);
		expect(calls).toEqual([
			{ path: "AGENTS.md", revision: "base", limit: 2_000 },
			{ path: "AGENTS.md", revision: "base", limit: 2_000, cursor: "2" },
		]);
	});

	it("is undefined for a file the base does not have, and throws when cancelled", async () => {
		const { engine } = host({});
		const readBase = createBaseReader(engine);
		await expect(readBase("nope.md", new AbortController().signal)).resolves.toBeUndefined();
		const controller = new AbortController();
		controller.abort();
		await expect(readBase("nope.md", controller.signal)).rejects.toThrow("does not exist");
	});

	it("needs the host's tool", () => {
		const engine = { pass: () => ({ tools: () => [] }) } as unknown as ReviewEngineContext;
		expect(() => createBaseReader(engine)).toThrow("review_file tool is not available");
	});
});
