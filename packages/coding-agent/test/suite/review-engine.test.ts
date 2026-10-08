import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOTE_REVIEW_FAILURE_MESSAGE } from "../../src/core/review.ts";
import {
	type ReviewEngineContext,
	type ReviewEngineDeclaration,
	ReviewEngineDeclarationError,
	ReviewEngineRegistry,
	type ReviewEngineResult,
	ReviewEngineSubmissionError,
	validateReviewEngine,
} from "../../src/core/review-engine.ts";
import { startEngineReview } from "../../src/core/review-engine-run.ts";
import type { ReviewCandidateReport, ReviewVerificationReport } from "../../src/core/review-report.ts";
import * as reviewSnapshots from "../../src/core/review-snapshot.ts";
import { listReviewRuns } from "../../src/core/review-state.ts";
import { createHarness, type Harness } from "./harness.ts";

const SWARM = "ext:swarm-review/swarm";

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** A repository whose working tree changes `src/value.ts` (line 2) and adds an unsupported binary file. */
function initializeRepository(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	git(cwd, "init", "--initial-branch=main");
	git(cwd, "config", "user.email", "review@example.com");
	git(cwd, "config", "user.name", "Review Test");
	writeFileSync(
		join(cwd, "src", "value.ts"),
		"export function divide(amount: number, divisor: number) {\n\treturn amount / divisor;\n}\n",
	);
	git(cwd, "add", ".");
	git(cwd, "commit", "-m", "initial");
	writeFileSync(
		join(cwd, "src", "value.ts"),
		"export function divide(amount: number, divisor: number) {\n\tif (divisor === 0) return amount;\n\treturn amount / divisor;\n}\n",
	);
}

function candidates(overrides: Partial<ReviewCandidateReport["candidates"][number]> = {}): ReviewCandidateReport {
	return {
		summary: "One introduced defect was found.",
		limitations: [],
		candidates: [
			{
				candidateId: "candidate-1",
				title: "Zero returns the numerator",
				body: "The added zero guard returns a plausible but incorrect value.",
				trigger: "Call divide with a zero divisor.",
				impact: "Callers receive the numerator as the result.",
				category: "correctness",
				rootCauseKey: "zero-divisor-returns-input",
				priority: 2,
				confidence: 0.95,
				changeLocation: { path: "src/value.ts", side: "head", startLine: 2, endLine: 2 },
				evidenceLocations: [],
				...overrides,
			},
		],
	};
}

function verification(assessment: "complete" | "incomplete" = "complete"): ReviewVerificationReport {
	return {
		summary: "Two verifiers confirmed the candidate.",
		assessment,
		...(assessment === "incomplete" ? { challenge: "A changed hunk remains uninspected." } : {}),
		decisions: [
			{
				candidateId: "candidate-1",
				outcome: "accept",
				method: "Two independent verifiers compared the exact base and head blobs.",
				rationale: "The added branch returns amount when divisor is zero.",
				confidence: 0.98,
			},
		],
		priorFindingDecisions: [],
		limitations: [],
	};
}

function engine(
	run: (ctx: ReviewEngineContext) => Promise<void>,
	overrides: Partial<ReviewEngineDeclaration> = {},
): ReviewEngineDeclaration {
	return {
		id: SWARM,
		label: "Swarm",
		description: "Many reviewers, clustered, each cluster verified twice.",
		targets: ["uncommitted", "branch", "commit"],
		remoteSafe: false,
		run,
		...overrides,
	};
}

/** Review the whole change the way a careful engine does: the inventory, every hunk's diff, then the result. */
async function reviewCarefully(
	ctx: ReviewEngineContext,
	result: Partial<ReviewEngineResult> = {},
): Promise<ReturnType<ReviewEngineContext["submit"]>> {
	const files = ctx.changedFiles();
	const pass = ctx.pass();
	const delivery = pass.diff(
		files.flatMap((file) => file.hunks.map((hunk) => hunk.id)),
		64 * 1024,
	);
	expect(delivery.omitted).toEqual([]);
	return await ctx.submit({ candidates: candidates(), verification: verification(), ...result });
}

describe("review engines", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	});

	/** Count the snapshots the host resolves and disposes. */
	function watchSnapshots(): { resolved: () => number; disposed: () => number } {
		let resolved = 0;
		let disposed = 0;
		const resolve = reviewSnapshots.resolveReviewSnapshot;
		vi.spyOn(reviewSnapshots, "resolveReviewSnapshot").mockImplementation(async (...args) => {
			const snapshot = await resolve(...args);
			if ("error" in snapshot) return snapshot;
			resolved++;
			const dispose = snapshot.dispose.bind(snapshot);
			snapshot.dispose = async () => {
				disposed++;
				await dispose();
			};
			return snapshot;
		});
		return { resolved: () => resolved, disposed: () => disposed };
	}

	async function fixture() {
		const harness = await createHarness();
		harnesses.push(harness);
		initializeRepository(harness.tempDir);
		const start = async (
			declaration: ReviewEngineDeclaration,
			options: {
				remote?: boolean;
				trusted?: boolean;
				target?: Parameters<typeof startEngineReview>[0]["target"];
			} = {},
		) => {
			const { workId } = await startEngineReview({
				engine: declaration,
				target: options.target ?? { kind: "uncommitted" },
				remote: options.remote ?? false,
				cwd: harness.tempDir,
				work: harness.session.work,
				settingsManager: { isProjectTrusted: () => options.trusted ?? true },
				sessionManager: harness.session.sessionManager!,
				sessionWriter: harness.session.sessionWriter,
			});
			await harness.session.work.settled(workId);
			return {
				workId,
				work: harness.session.work.get(workId),
				runs: listReviewRuns(harness.session.sessionManager!),
			};
		};
		return { harness, start };
	}

	describe("declarations", () => {
		const valid = (): ReviewEngineDeclaration => engine(async () => {});

		it("keeps a valid declaration and refuses what an author must fix", () => {
			expect(validateReviewEngine(valid())).toMatchObject({
				id: SWARM,
				remoteSafe: false,
				targets: ["uncommitted", "branch", "commit"],
			});
			expect(validateReviewEngine({ ...valid(), cost: "Slower.", remoteSafe: true })).toMatchObject({
				cost: "Slower.",
				remoteSafe: true,
			});
			for (const broken of [
				{ id: "swarm" },
				{ id: "standard" },
				{ id: "ext:/swarm" },
				{ label: "" },
				{ label: "x".repeat(501) },
				{ description: undefined },
				{ cost: 3 },
				{ targets: [] },
				{ targets: ["uncommitted", "everything"] },
				{ targets: "uncommitted" },
				{ remoteSafe: "yes" },
				{ run: undefined },
			]) {
				expect(() => validateReviewEngine({ ...valid(), ...broken }), JSON.stringify(broken)).toThrow(
					ReviewEngineDeclarationError,
				);
			}
			expect(() => validateReviewEngine(undefined)).toThrow(ReviewEngineDeclarationError);
		});

		it("registers an engine once and removes only its own registration", () => {
			const registry = new ReviewEngineRegistry();
			const remove = registry.register(valid());
			expect(registry.get(SWARM)?.label).toBe("Swarm");
			expect(registry.list().map((entry) => entry.id)).toEqual([SWARM]);
			expect(() => registry.register(valid())).toThrow("already registered");
			remove();
			expect(registry.get(SWARM)).toBeUndefined();
			const replacement = registry.register(valid());
			remove();
			expect(registry.get(SWARM)).toBeDefined();
			replacement();
			expect(registry.list()).toEqual([]);
		});
	});

	it("runs an engine as review work and records its result as the host would", async () => {
		const { harness, start } = await fixture();
		let ended: ReviewEngineContext | undefined;
		let submission: Awaited<ReturnType<ReviewEngineContext["submit"]>> | undefined;
		const { workId, work, runs } = await start(
			engine(async (ctx) => {
				ended = ctx;
				ctx.progress({ text: "Wave 1" });
				ctx.checkpoint({ text: "Verifying" });
				ctx.output("Swarm report\n");
				expect(ctx.target).toMatchObject({
					kind: "uncommitted",
					description: expect.stringContaining("uncommitted"),
					controls: { scope: [], effort: "standard", includeOptional: false },
				});
				submission = await reviewCarefully(ctx, { commandsRun: ["npm test"] });
			}),
		);

		expect(workId).toMatch(/^review:/);
		expect(work).toMatchObject({
			kind: "review",
			outcome: "completed",
			result: {
				summary: "Review complete: 1 finding.",
				data: { findingsCount: 1, completionStatus: "complete" },
				output: { text: "Swarm report\n" },
			},
		});
		expect(submission).toEqual({ completionStatus: "complete", findings: 1, rejected: [], errors: [] });
		expect(runs.runs).toHaveLength(1);
		const [record] = runs.runs;
		expect(record).toMatchObject({
			runId: workId,
			engine: SWARM,
			workflowAction: "review.uncommitted",
			status: "completed",
			options: { scope: [], effort: "standard" },
			result: { completionStatus: "complete", overallCorrectness: "incorrect" },
		});
		const [finding] = record!.result!.findings;
		// The host names the finding and anchors it; the engine's candidate id is not the finding's.
		expect(finding).toMatchObject({
			status: "open",
			title: "Zero returns the numerator",
			changeLocation: { path: "src/value.ts", side: "head", startLine: 2, endLine: 2 },
			verification: { outcome: "accepted", method: expect.stringContaining("Two independent verifiers") },
		});
		expect(finding!.id).not.toBe("candidate-1");
		expect(finding!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		// Coverage is what the host observed: the diff it delivered and the inventory it gave.
		expect(record!.result!.coverage).toMatchObject({
			changedFileInventoryComplete: true,
			hunksInspected: [expect.any(String)],
			uncheckedAreas: [],
			commandsRun: ["npm test"],
		});
		expect(record!.result!.coverage.residualRisk).not.toContain(
			"Static review only. This review did not run tests or runtime checks.",
		);
		// Nothing of the host's remains reachable once the run ended.
		expect(() => ended!.pass()).toThrow("The review has ended");
		await expect(ended!.checkout()).rejects.toThrow("The review has ended");
		expect(harness.session.work.list().filter((item) => item.kind === "review")).toHaveLength(1);
	});

	it("says a static review was static, and what it never delivered is unchecked", async () => {
		const { start } = await fixture();
		const { runs, work } = await start(
			engine(async (ctx) => {
				// No inventory call and no diff delivered: the host observed neither.
				await ctx.submit({ candidates: candidates(), verification: verification() });
			}),
		);
		expect(work).toMatchObject({ outcome: "completed", result: { data: { completionStatus: "incomplete" } } });
		const [record] = runs.runs;
		expect(record).toMatchObject({ status: "incomplete", engine: SWARM });
		expect(record!.result!.coverage.uncheckedAreas).toEqual([
			"Changed-file inventory was not paged to completion.",
			expect.stringContaining("Changed hunk was not fully inspected"),
		]);
		expect(record!.result!.coverage.residualRisk[0]).toBe(
			"Static review only. This review did not run tests or runtime checks.",
		);
		expect(record!.result!.overallCorrectness).toBeUndefined();
	});

	it("credits a hunk to the run once any pass was given all of it", async () => {
		const { start } = await fixture();
		const { runs } = await start(
			engine(async (ctx) => {
				const hunkIds = ctx.changedFiles().flatMap((file) => file.hunks.map((hunk) => hunk.id));
				const first = ctx.pass();
				const second = ctx.pass();
				// A budget too small for the hunk delivers nothing and credits nothing.
				expect(first.diff(hunkIds, 10)).toMatchObject({ delivered: [], omitted: hunkIds });
				expect(first.coverage().hunksInspected).toEqual([]);
				expect(second.diff(hunkIds, 64 * 1024).delivered).toEqual(hunkIds);
				expect(first.coverage().hunksInspected).toEqual([]);
				expect(second.coverage().hunksInspected).toEqual(hunkIds);
				expect(() => first.diff(["no-such-hunk"], 1024)).toThrow("not in this review snapshot");
				await ctx.submit({ candidates: candidates(), verification: verification() });
			}),
		);
		expect(runs.runs[0]).toMatchObject({ status: "completed" });
	});

	it("gives a pass the host's snapshot tools, whose reads count", async () => {
		const { start } = await fixture();
		const { runs } = await start(
			engine(async (ctx) => {
				const pass = ctx.pass();
				const tools = pass.tools();
				expect(tools.map((tool) => tool.name)).toEqual(
					expect.arrayContaining(["review_changed_files", "review_diff", "review_file"]),
				);
				expect(tools.map((tool) => tool.name)).not.toContain("review_context");
				const changedFiles = tools.find((tool) => tool.name === "review_changed_files")!;
				const diff = tools.find((tool) => tool.name === "review_diff")!;
				await changedFiles.execute("call-1", {}, undefined, undefined, undefined as never);
				await diff.execute("call-2", { path: "src/value.ts" }, undefined, undefined, undefined as never);
				expect(pass.coverage()).toMatchObject({
					changedFileInventoryComplete: true,
					diffFilesFullyRead: ["src/value.ts"],
					hunksInspected: [expect.any(String)],
				});
				await ctx.submit({ candidates: candidates(), verification: verification() });
			}),
		);
		expect(runs.runs[0]).toMatchObject({ status: "completed", result: { coverage: { uncheckedAreas: [] } } });
	});

	describe("submitting", () => {
		it("drops candidates the host rejects with their decisions, and keeps the rest", async () => {
			const { start } = await fixture();
			let submission: Awaited<ReturnType<ReviewEngineContext["submit"]>> | undefined;
			let validation: Awaited<ReturnType<ReviewEngineContext["validate"]>> | undefined;
			const report = candidates();
			const stray = {
				...report.candidates[0]!,
				candidateId: "candidate-2",
				rootCauseKey: "unchanged-line",
				changeLocation: { path: "src/value.ts", side: "head" as const, startLine: 1, endLine: 1 },
			};
			const both = { ...report, candidates: [...report.candidates, stray] };
			const decisions = [
				...verification().decisions,
				{ ...verification().decisions[0]!, candidateId: "candidate-2" },
			];
			const { runs } = await start(
				engine(async (ctx) => {
					validation = await ctx.validate(both);
					submission = await reviewCarefully(ctx, {
						candidates: both,
						verification: { ...verification(), decisions },
					});
				}),
			);
			expect(validation).toEqual({
				accepted: ["candidate-1"],
				errors: [expect.stringContaining("does not overlap a changed head line")],
			});
			expect(submission).toMatchObject({ findings: 1, rejected: ["candidate-2"], completionStatus: "complete" });
			expect(runs.runs[0]!.result!.findings).toHaveLength(1);
		});

		it("refuses a result that cannot stand and lets the engine submit again", async () => {
			const { start } = await fixture();
			const failures: unknown[] = [];
			const { runs } = await start(
				engine(async (ctx) => {
					const files = ctx.changedFiles();
					ctx.pass().diff(
						files.flatMap((file) => file.hunks.map((hunk) => hunk.id)),
						64 * 1024,
					);
					const attempts: ReviewEngineResult[] = [
						// A candidate with no decision.
						{ candidates: candidates(), verification: { ...verification(), decisions: [] } },
						// An incomplete assessment that names no challenge.
						{ candidates: candidates(), verification: { ...verification(), assessment: "incomplete" } },
						// A report that is not the host's shape.
						{ candidates: { summary: "x" } as never, verification: verification() },
					];
					for (const attempt of attempts) {
						try {
							await ctx.submit(attempt);
						} catch (error) {
							failures.push(error);
						}
					}
					await ctx.submit({ candidates: candidates(), verification: verification() });
					await expect(ctx.submit({ candidates: candidates(), verification: verification() })).rejects.toThrow(
						"already submitted",
					);
				}),
			);
			expect(failures).toHaveLength(3);
			for (const failure of failures) expect(failure).toBeInstanceOf(ReviewEngineSubmissionError);
			expect((failures[0] as ReviewEngineSubmissionError).errors).toEqual([
				"Missing verification decision for candidate-1",
			]);
			expect((failures[1] as ReviewEngineSubmissionError).errors).toEqual([
				"Incomplete verification requires a challenge",
			]);
			expect((failures[2] as ReviewEngineSubmissionError).errors[0]).toContain("candidates:");
			expect(runs.runs[0]).toMatchObject({ status: "completed" });
		});

		it("keeps a candidate the checks complained about out of the result, even when they let it through", async () => {
			const { start } = await fixture();
			let validation: Awaited<ReturnType<ReviewEngineContext["validate"]>> | undefined;
			let submission: Awaited<ReturnType<ReviewEngineContext["submit"]>> | undefined;
			const { runs } = await start(
				engine(async (ctx) => {
					// P3 without includeOptional is an error, though the anchor itself is fine.
					const optional = candidates({ priority: 3 });
					validation = await ctx.validate(optional);
					submission = await reviewCarefully(ctx, { candidates: optional });
				}),
			);
			expect(validation).toEqual({ accepted: [], errors: ["candidates[0] uses P3 without includeOptional"] });
			expect(submission).toMatchObject({ findings: 0, rejected: ["candidate-1"], completionStatus: "complete" });
			expect(runs.runs[0]).toMatchObject({
				status: "completed",
				result: { findings: [], overallCorrectness: "correct" },
			});
		});
	});

	describe("how a run ends", () => {
		it("records a failure when the engine throws, and when it submits nothing", async () => {
			const { start } = await fixture();
			const thrown = await start(
				engine(async () => {
					throw new Error("the worker pool crashed");
				}),
			);
			expect(thrown.work).toMatchObject({ outcome: "failed", error: "the worker pool crashed" });
			expect(thrown.runs.runs[0]).toMatchObject({
				status: "failed",
				engine: SWARM,
				errorMessage: "the worker pool crashed",
			});
			expect(thrown.runs.runs[0]!.result).toBeUndefined();

			const silent = await start(engine(async () => {}));
			expect(silent.work).toMatchObject({
				outcome: "failed",
				error: "The Swarm engine finished without a review result.",
			});
			expect(silent.runs.runs.map((run) => run.status)).toEqual(["failed", "failed"]);
		});

		it("does not keep a result the engine submitted before it threw", async () => {
			const { start } = await fixture();
			const { work, runs } = await start(
				engine(async (ctx) => {
					await reviewCarefully(ctx);
					throw new Error("crashed after submitting");
				}),
			);
			expect(work).toMatchObject({ outcome: "failed" });
			expect(runs.runs[0]).toMatchObject({ status: "failed" });
			expect(runs.runs[0]!.result).toBeUndefined();
		});

		it("describes a remote client's failure without the engine's message", async () => {
			const { start } = await fixture();
			const { work, runs } = await start(
				engine(
					async () => {
						throw new Error("secret path /home/user/.ssh/id_rsa");
					},
					{ remoteSafe: true },
				),
				{ remote: true },
			);
			expect(work).toMatchObject({ outcome: "failed", error: REMOTE_REVIEW_FAILURE_MESSAGE });
			expect(JSON.stringify(runs.runs[0])).not.toContain("secret path");
		});

		it("cancels with the work and records the cancellation", async () => {
			const { harness, start: _start } = await fixture();
			const started = Promise.withResolvers<AbortSignal>();
			const { workId } = await startEngineReview({
				engine: engine(async (ctx) => {
					started.resolve(ctx.signal);
					await new Promise<void>((resolve) =>
						ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
					// A cancelled engine may still try to submit; the run is cancelled all the same.
					await reviewCarefully(ctx).catch(() => undefined);
				}),
				target: { kind: "uncommitted" },
				remote: false,
				cwd: harness.tempDir,
				work: harness.session.work,
				settingsManager: { isProjectTrusted: () => true },
				sessionManager: harness.session.sessionManager!,
				sessionWriter: harness.session.sessionWriter,
			});
			const signal = await started.promise;
			expect(signal.aborted).toBe(false);
			expect(harness.session.work.get(workId)).toMatchObject({ state: "running" });
			await harness.session.work.cancel(workId);
			await harness.session.work.settled(workId);
			expect(signal.aborted).toBe(true);
			expect(harness.session.work.get(workId)).toMatchObject({ outcome: "cancelled" });
			expect(listReviewRuns(harness.session.sessionManager!).runs[0]).toMatchObject({
				runId: workId,
				status: "cancelled",
				engine: SWARM,
			});
		});
	});

	describe("admission", () => {
		it("refuses a target the engine does not review before any work exists", async () => {
			const { harness, start } = await fixture();
			await expect(start(engine(async () => {}, { targets: ["commit"] }))).rejects.toThrow(
				"The Swarm engine does not review a uncommitted target",
			);
			expect(harness.session.work.list().filter((item) => item.kind === "review")).toEqual([]);
		});

		it("lets a remote client start only an engine that allows it, in a trusted project", async () => {
			const { harness, start } = await fixture();
			await expect(
				start(
					engine(async () => {}),
					{ remote: true },
				),
			).rejects.toThrow("The Swarm engine is not available to remote clients");
			await expect(
				start(
					engine(async () => {}, { remoteSafe: true }),
					{ remote: true, trusted: false },
				),
			).rejects.toThrow("Project trust is required before running a remote review.");
			expect(harness.session.work.list().filter((item) => item.kind === "review")).toEqual([]);
			const { work } = await start(
				engine(async (ctx) => void (await reviewCarefully(ctx)), { remoteSafe: true }),
				{ remote: true },
			);
			expect(work).toMatchObject({ outcome: "completed" });
		});

		it("shares the review limit of three with the built-in pipeline", async () => {
			const { harness, start } = await fixture();
			const snapshots = watchSnapshots();
			const release = Promise.withResolvers<void>();
			const running = async () => {
				const entered = Promise.withResolvers<void>();
				const { workId } = await startEngineReview({
					engine: engine(async () => {
						entered.resolve();
						await release.promise;
					}),
					target: { kind: "uncommitted" },
					remote: false,
					cwd: harness.tempDir,
					work: harness.session.work,
					settingsManager: { isProjectTrusted: () => true },
					sessionManager: harness.session.sessionManager!,
					sessionWriter: harness.session.sessionWriter,
				});
				await entered.promise;
				return workId;
			};
			const ids = [await running(), await running(), await running()];
			await expect(start(engine(async () => {}))).rejects.toThrow();
			// The refused review's snapshot was released at once; the others' wait for their runs.
			expect(snapshots.resolved()).toBe(4);
			expect(snapshots.disposed()).toBe(1);
			release.resolve();
			for (const id of ids) await harness.session.work.settled(id);
			expect(snapshots.disposed()).toBe(4);
		});
	});

	it("disposes the snapshot once, however the run ends", async () => {
		const { harness, start } = await fixture();
		const snapshots = watchSnapshots();
		await start(engine(async (ctx) => void (await reviewCarefully(ctx))));
		expect(snapshots.disposed()).toBe(1);
		await start(
			engine(async () => {
				throw new Error("crashed");
			}),
		);
		expect(snapshots.disposed()).toBe(2);
		await start(engine(async () => {}));
		expect(snapshots.disposed()).toBe(3);

		const entered = Promise.withResolvers<void>();
		const { workId } = await startEngineReview({
			engine: engine(async (ctx) => {
				entered.resolve();
				await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
			}),
			target: { kind: "uncommitted" },
			remote: false,
			cwd: harness.tempDir,
			work: harness.session.work,
			settingsManager: { isProjectTrusted: () => true },
			sessionManager: harness.session.sessionManager!,
			sessionWriter: harness.session.sessionWriter,
		});
		await entered.promise;
		expect(snapshots.disposed()).toBe(3);
		await harness.session.work.cancel(workId);
		await harness.session.work.settled(workId);
		expect(snapshots.resolved()).toBe(4);
		expect(snapshots.disposed()).toBe(4);
	});
});
