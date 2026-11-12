/**
 * The swarm review engine's pure parts: how it packs the host's hunks into shards, maps verified findings onto the
 * host's report shapes, resolves its options, writes its report, and reads base files through the host. The engine
 * as a whole runs in test/suite/swarm-review-engine.test.ts.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReviewEngineChangedFile, ReviewEngineContext, ToolDefinition } from "@hansjm10/volt-coding-agent";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { createBaseReader } from "../../../.volt/extensions/swarm-review/base.ts";
import { resolveOptions } from "../../../.volt/extensions/swarm-review/index.ts";
import { loadDismissals, recordDismissals } from "../../../.volt/extensions/swarm-review/memory.ts";
import { changeSection } from "../../../.volt/extensions/swarm-review/prompts.ts";
import { buildReport, type ReportedFinding, reportSummary } from "../../../.volt/extensions/swarm-review/report.ts";
import { buildSubmission, candidateFor, slug } from "../../../.volt/extensions/swarm-review/submit.ts";
import { MAX_SHARD_BYTES, packShards } from "../../../.volt/extensions/swarm-review/target.ts";
import {
	type CheckoutPathProbe,
	canonicalHeadPath,
	createRepositoryTools,
	insideRoot,
	resolveCheckoutPath,
} from "../../../.volt/extensions/swarm-review/tools.ts";
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
import { directoryCheckout } from "./utilities/swarm-checkout.ts";

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

describe("packing the host's hunks into shards", () => {
	it("keeps a small change in one shard, with each file's hunks and sizes", () => {
		const { shards, fileHunks, hunkBytes } = packShards([file("a.ts", [100, 200]), file("b.ts", [50])]);
		expect(shards).toEqual([
			{ index: 0, files: ["a.ts", "b.ts"], hunkIds: ["a.ts#0", "a.ts#1", "b.ts#0"], partialFiles: [] },
		]);
		expect(fileHunks).toEqual(
			new Map([
				["a.ts", ["a.ts#0", "a.ts#1"]],
				["b.ts", ["b.ts#0"]],
			]),
		);
		expect(hunkBytes.get("a.ts#1")).toBe(200);
	});

	it("starts a new shard when the next hunk would not fit, and splits a file's hunks across shards", () => {
		const half = MAX_SHARD_BYTES / 2 - 600;
		const { shards } = packShards([file("a.ts", [half, half]), file("b.ts", [half, half])]);
		expect(shards.map((shard) => shard.hunkIds)).toEqual([
			["a.ts#0", "a.ts#1"],
			["b.ts#0", "b.ts#1"],
		]);
		const split = packShards([file("a.ts", [half, half, half])]);
		expect(split.shards.map((shard) => shard.hunkIds)).toEqual([["a.ts#0", "a.ts#1"], ["a.ts#2"]]);
		expect(split.shards.map((shard) => shard.files)).toEqual([["a.ts"], ["a.ts"]]);
	});

	it("gives a hunk too large for any shard a shard of its own and marks its file partial", () => {
		const { shards } = packShards([file("a.ts", [10]), file("big.ts", [MAX_SHARD_BYTES + 1]), file("c.ts", [10])]);
		expect(shards.map((shard) => ({ files: shard.files, partial: shard.partialFiles }))).toEqual([
			{ files: ["a.ts"], partial: [] },
			{ files: ["big.ts"], partial: ["big.ts"] },
			{ files: ["c.ts"], partial: [] },
		]);
	});

	it("holds nothing for no files", () => {
		expect(packShards([]).shards).toEqual([]);
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
	shardCount: 1,
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

	it("is incomplete, naming what was left open, when verifiers disagreed or part of the diff had no worker", () => {
		const open = (outcome: Cluster["outcome"]) => cluster({ id: outcome, outcome });
		const result = buildSubmission(
			state([open("disputed"), open("uncertain"), open("unverified")], {
				waves: [{ wave: 2, workers: 3, candidates: 0, newClusters: 0, clusteringFallback: false, failed: true }],
			}),
			[],
			{ ...context, shardCount: 3, unreviewedFiles: ["a.ts", "b.ts"] },
		);
		expect(result.verification.assessment).toBe("incomplete");
		expect(result.verification.challenge).toBe(
			"Left open: 1 cluster(s) where the verifiers disagreed; 1 cluster(s) the verifiers could not settle; 1 cluster(s) no verifier finished; every worker in wave 2 failed; 2 file(s) in a part of the diff (of 3) had no successful worker.",
		);
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
	const worker = (index: number, cost: number): WorkerState => ({
		...pass(cost),
		index,
		wave: 1,
		shard: 0,
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
			shards: [{ index: 0, files: ["src/value.ts"], hunkIds: [], partialFiles: [] }],
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
	function target(directory: string, unrepresented: readonly string[] = []): ReviewTarget {
		return {
			repoRoot: directory,
			checkout: directoryCheckout(directory, unrepresented),
			description: "paths",
			stat: "",
			scope: [],
			shards: [],
			fileHunks: new Map(),
			hunkBytes: new Map(),
			complete: true,
			submodules: false,
			commonDir: join(directory, ".git"),
			readBase: async () => undefined,
		};
	}
	const NO_BREAK_SPACE = "\u00a0";

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

	describe("what a checkout tool opens for its path argument", () => {
		/**
		 * A checkout under a directory with a no-break space in its name, holding a file named with a percent sign, one
		 * named like an escape, a pair where the reference of one spells the name of the other, and a scoped directory.
		 */
		function fixture(unrepresented: readonly string[] = []) {
			const root = mkdtempSync(join(tmpdir(), "volt-swarm-resolver-"));
			directories.push(root);
			const directory = join(root, `check${NO_BREAK_SPACE}out`);
			mkdirSync(join(directory, "@scope"), { recursive: true });
			for (const name of ["100%.ts", "a%25.ts", "both%.ts", "both%25.ts", "plain.ts", "Notes.md", "@scope/x.ts"]) {
				writeFileSync(join(directory, name), `${name}\n`);
			}
			const checkout = directoryCheckout(directory, unrepresented);
			const asked: string[] = [];
			const probe: CheckoutPathProbe = {
				confine: (path) => {
					asked.push(`confine ${path}`);
					if (!insideRoot(directory, path)) throw new Error(`Access outside the repository: ${path}`);
				},
				exists: (path) => {
					asked.push(`exists ${path}`);
					return existsSync(path);
				},
			};
			return { directory, asked, resolve: (argument: string) => resolveCheckoutPath(argument, checkout, probe) };
		}

		it.each([
			// The name ls prints is taken back, and the result says what its reference is.
			{ argument: "100%.ts", opens: "./100%.ts", reference: "100%25.ts" },
			// A reference copied from the diff opens the file it names, when no file has those characters for a name.
			{ argument: "100%25.ts", opens: "./100%.ts", reference: undefined },
			// A name that reads as a reference to a file that is not there is the name.
			{ argument: "a%25.ts", opens: "./a%25.ts", reference: "a%2525.ts" },
			// Only the name is checked for the spaces the tool rewrites, never the checkout's own directory.
			{ argument: "plain.ts", opens: "./plain.ts", reference: undefined },
			{ argument: "./plain.ts", opens: "./plain.ts", reference: undefined },
			// The tool strips a leading "@" from what it is given; "./" keeps the name whole.
			{ argument: "@scope/x.ts", opens: `./${join("@scope", "x.ts")}`, reference: undefined },
			{ argument: ".", opens: ".", reference: undefined },
		])("opens $opens for $argument", ({ argument, opens, reference }) => {
			expect(fixture().resolve(argument)).toEqual({
				path: opens,
				...(reference === undefined ? {} : { reference }),
			});
		});

		it("refuses a string that names one file and, as a reference, another", () => {
			const { directory, resolve } = fixture();
			const resolved = resolve("both%25.ts");
			expect(resolved).toEqual({ refusal: expect.stringContaining("names two files in this checkout") });
			// Each is still reached by its absolute path, which the refusal gives.
			expect(resolved).toEqual({ refusal: expect.stringContaining(JSON.stringify(join(directory, "both%25.ts"))) });
			expect(resolved).toEqual({ refusal: expect.stringContaining(JSON.stringify(join(directory, "both%.ts"))) });
		});

		it("refuses a reference the checkout does not serve, though a file answers to that name", () => {
			// On a system that ignores case, "notes.md" opens the file checked out for "Notes.md": another file's content.
			const resolved = fixture(["notes.md"]).resolve("notes.md");
			expect(resolved).toEqual({ refusal: expect.stringContaining("does not hold notes.md") });
			expect(resolved).toEqual({ refusal: expect.stringContaining("review_file") });
			// A name that is not UTF-8 has no file in any checkout a path string can open.
			expect(fixture().resolve("raw-%FF.ts")).toEqual({
				refusal: expect.stringContaining("does not hold raw-%FF.ts"),
			});
		});

		it("refuses a path nothing is at, which the tool might open under another spelling", () => {
			const { resolve } = fixture();
			expect(resolve("missing.ts")).toEqual({ refusal: 'Nothing is at "missing.ts" in this checkout.' });
			expect(resolve("100%2525.ts")).toEqual({ refusal: expect.stringContaining("Nothing is at") });
			// A native form is checked where it leads. This one has no Unicode space: the fixture's directory does.
			const plain = mkdtempSync(join(tmpdir(), "volt-swarm-resolver-plain-"));
			directories.push(plain);
			const probe: CheckoutPathProbe = { confine: () => {}, exists: existsSync };
			expect(resolveCheckoutPath(join(plain, "missing.ts"), directoryCheckout(plain), probe)).toEqual({
				refusal: expect.stringContaining("Nothing is at"),
			});
		});

		it("refuses a name with a space the tool would rewrite, and a native path with one", () => {
			const { directory, resolve } = fixture();
			expect(resolve(`nb${NO_BREAK_SPACE}sp.ts`)).toEqual({ refusal: expect.stringContaining("Unicode space") });
			// The tool would open the checkout's directory under another name: it is reached by relative names instead.
			expect(resolve(join(directory, "plain.ts"))).toEqual({
				refusal: expect.stringContaining("relative to the checkout"),
			});
		});

		it("confines where a native path leads, in every form the tool expands", () => {
			const { resolve } = fixture();
			expect(() => resolve("../outside")).toThrow(/outside the repository/);
			expect(() => resolve("~/notes.txt")).toThrow(/outside the repository/);
			expect(() => resolve("~")).toThrow(/outside the repository/);
			expect(() => resolve(pathToFileURL(join(homedir(), "notes.txt")).href)).toThrow(/outside the repository/);
			// On Windows the tool expands "~\" as well; elsewhere a backslash is an ordinary character of a name.
			if (process.platform === "win32") expect(() => resolve("~\\notes.txt")).toThrow(/outside the repository/);
			else expect(resolve("~\\notes.txt")).toEqual({ path: "./~\\notes.txt", reference: "~%5Cnotes.txt" });
		});

		it("confines each path before it asks whether the path exists", () => {
			const { asked, resolve } = fixture();
			resolve("100%25.ts");
			const probes = asked.filter((entry) => entry.startsWith("exists "));
			expect(probes).toHaveLength(2);
			for (const probe of probes) {
				expect(asked.indexOf(probe.replace("exists ", "confine "))).toBeGreaterThanOrEqual(0);
				expect(asked.indexOf(probe.replace("exists ", "confine "))).toBeLessThan(asked.indexOf(probe));
			}
		});
	});

	it("reads through the tools by the name they print and by reference, and never a substitute for a head path", async () => {
		const checkout = mkdtempSync(join(tmpdir(), "volt-swarm-byte-checkout-"));
		directories.push(checkout);
		writeFileSync(join(checkout, "100%.ts"), "actual percent\n");
		const tools: ToolDefinition[] = createRepositoryTools(target(checkout), directoryCheckout(checkout));
		const read = tools.find((tool) => tool.name === "read");
		const ls = tools.find((tool) => tool.name === "ls");
		if (!read || !ls) throw new Error("Expected the read and ls tools");
		const run = (tool: ToolDefinition, path?: string) =>
			tool.execute("call", path === undefined ? {} : { path }, undefined, undefined, {} as never);
		const reference = (path: string) => ({
			type: "text",
			text: `Canonical reference for the requested checkout path: ${path}`,
		});

		// ls prints the checkout's own filename, and read takes it back as printed.
		expect((await run(ls)).content).toEqual([{ type: "text", text: expect.stringContaining("100%.ts") }]);
		expect((await run(read, "100%.ts")).content).toEqual([
			{ type: "text", text: expect.stringContaining("actual percent") },
			reference("100%25.ts"),
		]);
		// The reference a reviewer copies from the diff opens the same file.
		expect((await run(read, "100%25.ts")).content).toEqual([
			{ type: "text", text: expect.stringContaining("actual percent") },
		]);
		expect((await run(read, join(checkout, "100%.ts"))).content).toContainEqual(reference("100%25.ts"));

		// Once a file has the escape spelling for its own name, that string names two files and is refused.
		writeFileSync(join(checkout, "100%25.ts"), "literal escape spelling\n");
		await expect(run(read, "100%25.ts")).rejects.toThrow(/names two files/);
		const literal = await run(read, join(checkout, "100%25.ts"));
		expect(literal.content).toEqual([
			{ type: "text", text: expect.stringContaining("literal escape spelling") },
			reference("100%2525.ts"),
		]);

		// "invalid-%FF" is the reference of a head path whose name is not UTF-8. A checkout file with those characters
		// for a name is another file, so it is not read in its place.
		writeFileSync(join(checkout, "invalid-%FF"), "not the raw-byte filename\n");
		await expect(run(read, "invalid-%FF")).rejects.toThrow(/does not hold invalid-%FF/);

		// The read tool looks for a file it does not find under other spellings, a curly apostrophe among them. That
		// file has another reference, so it is not read as the one asked for, by name or by absolute path.
		writeFileSync(join(checkout, "it\u2019s.ts"), "curly apostrophe\n");
		await expect(run(read, "it's.ts")).rejects.toThrow(/Nothing is at "it's\.ts"/);
		await expect(run(read, join(checkout, "it's.ts"))).rejects.toThrow(/Nothing is at/);
		expect((await run(read, "it\u2019s.ts")).content).toEqual([
			{ type: "text", text: expect.stringContaining("curly apostrophe") },
		]);
		await expect(run(read, "../outside")).rejects.toThrow(/outside the repository/);
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
		// A dismissal anchored where the checkout serves nothing is not remembered, and none there is recalled.
		const unserved = target(checkout, ["100%25.ts"]);
		expect(loadDismissals(unserved)).toEqual([]);
	});

	it("tells reviewers which head paths the checkout tools cannot open, listing the first twenty", () => {
		const unrepresented = Array.from({ length: 23 }, (_, index) => `odd-${String(index).padStart(2, "0")}-%FF.ts`);
		const prompt = changeSection(target("checkout", unrepresented), "diff text", []);
		expect(prompt).toContain("cannot open 23 path(s) of the reviewed head");
		expect(prompt).toContain("odd-19-%FF.ts, and 3 more");
		expect(prompt).not.toContain("odd-20-%FF.ts");
		expect(prompt).toContain("review_file");
		expect(changeSection(target("checkout"), "diff text", [])).not.toContain("cannot open");
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
