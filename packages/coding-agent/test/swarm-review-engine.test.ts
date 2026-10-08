/**
 * The swarm review engine's pure parts: how it packs the host's hunks into shards, maps verified findings onto the
 * host's report shapes, resolves its options, and reads base files through the host. The engine as a whole runs in
 * test/suite/swarm-review-engine.test.ts.
 */

import type { ReviewEngineChangedFile, ReviewEngineContext } from "@hansjm10/volt-coding-agent";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createBaseReader } from "../../../.volt/extensions/swarm-review/base.ts";
import { resolveOptions } from "../../../.volt/extensions/swarm-review/index.ts";
import type { ReportedFinding } from "../../../.volt/extensions/swarm-review/report.ts";
import { buildSubmission, candidateFor, slug } from "../../../.volt/extensions/swarm-review/submit.ts";
import { MAX_SHARD_BYTES, packShards } from "../../../.volt/extensions/swarm-review/target.ts";
import type { Candidate, Cluster, SwarmState } from "../../../.volt/extensions/swarm-review/types.ts";
import { ReviewCandidateReportSchema, ReviewVerificationReportSchema } from "../src/core/review-report.ts";

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
		controls: { focus?: string; scope?: string[] } = {},
	) =>
		({
			params,
			target: { controls: { scope: [], effort: "standard", includeOptional: false, ...controls } },
		}) as unknown as Pick<ReviewEngineContext, "params" | "target">;

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
			resolveOptions(
				engine({
					workers: 3,
					waveSize: 20,
					concurrency: 2,
					thinking: "high",
					exec: true,
					fresh: true,
					stragglerGrace: 40,
				}),
				{ workers: 12 },
			),
		).toMatchObject({
			workers: 3,
			waveSize: 3,
			concurrency: 2,
			thinking: "high",
			exec: true,
			fresh: true,
			stragglerGrace: 40,
		});
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
		expect(resolveOptions(engine({ model: "faux/faux-1", verifier: "" }), {})).toMatchObject({
			model: "faux/faux-1",
		});
		expect(resolveOptions(engine({ verifier: "" }), {})).not.toHaveProperty("verifier");
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
