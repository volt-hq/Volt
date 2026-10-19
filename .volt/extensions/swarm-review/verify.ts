import { rm } from "node:fs/promises";
import { type DeepReadonly, StringEnum } from "@hansjm10/volt-ai";
import { type AgentSessionEvent, defineTool, type ReviewEnginePass } from "@hansjm10/volt-coding-agent";
import { Type } from "typebox";
import {
	changeSection,
	VERIFIER_EXEC_ADDENDUM,
	VERIFIER_REPAIR,
	VERIFIER_SYSTEM_PROMPT,
	VERIFIER_WRAP_UP,
} from "./prompts.ts";
import { git } from "./git.ts";
import { runPass } from "./session.ts";
import { candidateFor } from "./submit.ts";
import { normalizeFile } from "./tools.ts";
import type { Cluster, ClusterOutcome, PassState, SwarmSetup, SwarmState, Verdict, VerifiedFinding } from "./types.ts";
import { emptyUsage, errorText, lineRange, runPool } from "./util.ts";

export const VERIFIERS_PER_CLUSTER = 2;
const VERIFIER_TURNS = { wrapUp: 40, max: 60 };
/** Verifiers get the whole diff when it is at most this size; otherwise only their cluster's files. */
const FULL_DIFF_FOR_VERIFIERS = 60_000;
const CLUSTER_DIFF_BUDGET = 200_000;

const VERDICT_SCHEMA = Type.Object({
	verdict: StringEnum(["confirmed", "rejected", "uncertain"] as const),
	reason: Type.String({
		description:
			"For confirmed: the verified facts. For rejected: the specific reason. For uncertain: the check that would settle it.",
	}),
	findings: Type.Array(
		Type.Object({
			title: Type.String({ description: "One-line summary of the verified defect" }),
			file: Type.String({ description: "Repository-relative path of an existing file in the checkout" }),
			line: Type.Integer({ minimum: 1 }),
			endLine: Type.Optional(Type.Integer({ minimum: 1 })),
			priority: Type.Integer({
				minimum: 0,
				maximum: 3,
				description: "0 blocker, 1 urgent, 2 wrong, stale, or missing behavior, 3 correct behavior that could be better",
			}),
			explanation: Type.String({ description: "The code facts you verified, the trigger, and the impact" }),
			fix: Type.Optional(Type.String({ description: "Concise suggested fix" })),
		}),
		{ description: "One entry per distinct confirmed defect. Empty unless the verdict is confirmed." },
	),
});

function createVerdictTool(setup: SwarmSetup, cluster: Cluster, checkout: string, onReport: (verdict: Verdict) => void) {
	return defineTool({
		name: "report_verdict",
		label: "Report verdict",
		description: "Submit your verdict for the cluster: confirmed (with findings), rejected, or uncertain.",
		parameters: VERDICT_SCHEMA,
		async execute(_toolCallId, params) {
			const errors: string[] = [];
			const findings: VerifiedFinding[] = [];
			if (params.verdict === "confirmed" && params.findings.length === 0) {
				errors.push("A confirmed verdict needs at least one finding.");
			}
			if (params.verdict !== "confirmed" && params.findings.length > 0) {
				errors.push(`A ${params.verdict} verdict must not include findings.`);
			}
			for (const finding of params.findings) {
				const file = normalizeFile(checkout, finding.file);
				if (file) findings.push({ ...finding, file });
				else {
					errors.push(
						`Finding "${finding.title}" is anchored to ${finding.file}, which is not an existing file in the checkout.`,
					);
				}
			}
			// The host accepts a finding only anchored on a changed line of at most 10 lines: it says so now, while
			// the verifier can still move the anchor.
			if (errors.length === 0 && findings.length > 0) {
				const validation = await setup.engine.validate({
					summary: "Anchors of a verdict",
					// Only the anchor is checked: a review without optional findings would refuse P3, and a verifier must be
					// able to confirm a real issue it rates optional rather than reject it.
					candidates: findings.map((finding, index) =>
						candidateFor(cluster, { ...finding, priority: Math.min(finding.priority, 2) }, index + 1),
					),
					limitations: [],
				});
				for (const error of validation.errors) {
					const index = Number(/^candidates\[(\d+)\]/.exec(error)?.[1]);
					const finding = findings[index];
					errors.push(finding ? error.replace(/^candidates\[\d+\]/, `Finding "${finding.title}"`) : error);
				}
			}
			if (errors.length > 0) {
				return {
					content: [{ type: "text", text: `Verdict rejected. Fix and resubmit:\n- ${errors.join("\n- ")}` }],
					details: { accepted: false },
					isError: true,
				};
			}
			onReport({ verdict: params.verdict, reason: params.reason, findings });
			return {
				content: [{ type: "text", text: "Verdict recorded." }],
				details: { accepted: true },
				disposition: "stop",
			};
		},
	});
}

function patchBytes(target: SwarmSetup["target"], hunkIds: readonly string[]): number {
	return hunkIds.reduce((sum, id) => sum + (target.hunkBytes.get(id) ?? 0), 0);
}

/** The whole diff when small (more context); otherwise only the hunks of the cluster's files. Delivered through `pass`. */
function verifierDiff(setup: SwarmSetup, pass: ReviewEnginePass, cluster: Cluster): { diff: string; notes: string[] } {
	const { target } = setup;
	const all = target.shards.flatMap((shard) => shard.hunkIds);
	if (target.complete && patchBytes(target, all) <= FULL_DIFF_FOR_VERIFIERS) {
		return { diff: pass.diff(all, FULL_DIFF_FOR_VERIFIERS * 2).text, notes: [] };
	}
	const files = [...new Set(cluster.candidates.map((candidate) => candidate.file))];
	const ids: string[] = [];
	for (const file of files) {
		const fileIds = target.fileHunks.get(file) ?? [];
		if (patchBytes(target, [...ids, ...fileIds]) <= CLUSTER_DIFF_BUDGET) ids.push(...fileIds);
	}
	return {
		diff: pass.diff(ids, CLUSTER_DIFF_BUDGET + 64 * 1024).text,
		notes: [
			"Only the diff of the files these claims cite is shown; the changed-files list above covers the whole change. Read other files, use read_base for previous versions, and page any other diff with review_diff, as needed.",
		],
	};
}

function verifierPrompt(setup: SwarmSetup, pass: ReviewEnginePass, cluster: Cluster): string {
	const { diff, notes } = verifierDiff(setup, pass, cluster);
	const lines = [
		changeSection(setup.target, diff, notes),
		"",
		`# Cluster ${cluster.id}: ${cluster.title}`,
		`Independent reviewers made the ${cluster.candidates.length} claim(s) below. They are unverified and may be wrong, overstated, or duplicates.`,
	];
	for (const candidate of cluster.candidates) {
		lines.push(
			"",
			`- [${candidate.file}:${lineRange(candidate.line, candidate.endLine)}] ${candidate.title}`,
			`  Trigger: ${candidate.trigger}`,
			`  Impact: ${candidate.impact}`,
			`  Evidence: ${candidate.evidence}`,
		);
	}
	lines.push(
		"",
		"# Task",
		...(setup.options.focus ? [`User focus: ${setup.options.focus}`] : []),
		"Verify the cluster independently, then call report_verdict exactly once.",
	);
	return lines.join("\n");
}

function combine(cluster: Cluster): ClusterOutcome {
	const verdicts = cluster.verdicts.filter((verdict): verdict is Verdict => verdict !== undefined);
	if (verdicts.length === 0) return "unverified";
	if (verdicts.length < VERIFIERS_PER_CLUSTER) return "single";
	const kinds = new Set(verdicts.map((verdict) => verdict.verdict));
	if (kinds.size > 1) return "disputed";
	return verdicts[0].verdict;
}

/** Notes the commands a verifier runs with bash and which of them fail. */
function recordCommand(state: SwarmState, pending: Map<string, string>, event: DeepReadonly<AgentSessionEvent>): void {
	if (event.type === "tool_execution_start" && event.toolName === "bash") {
		const command = (event.args as { command?: unknown } | undefined)?.command;
		if (typeof command === "string") pending.set(event.toolCallId, command.replace(/\s+/g, " ").trim().slice(0, 500));
	} else if (event.type === "tool_execution_end") {
		const command = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (command === undefined) return;
		(event.isError ? state.failedCommands : state.commands).push(command);
	}
}

/** A checkout verifiers run commands in, and the commit it was made at. */
interface VerifierCheckout {
	readonly path: string;
	readonly head: string;
}

/**
 * The checkouts verifiers that run commands work in, one verifier at a time each. The host runs the review's setup
 * in each new checkout (such as installing dependencies), so a checkout is reused: once a verifier is done it is reset
 * to the reviewed head, its untracked files removed, and it goes to the next verifier. A review then sets up at most as
 * many checkouts as verifiers run at once, not one per verifier. Ignored files (installed dependencies, build output)
 * carry over between verifiers.
 */
function verifierCheckouts(setup: SwarmSetup) {
	const idle: VerifierCheckout[] = [];
	const created: string[] = [];
	return {
		async take(): Promise<VerifierCheckout> {
			const reused = idle.pop();
			if (reused) return reused;
			const path = await setup.target.createCheckout();
			created.push(path);
			const head = await git(path, ["rev-parse", "HEAD"], setup.signal);
			if (head.code !== 0) throw new Error(`Could not read the checkout's head: ${head.stderr.trim()}`);
			return { path, head: head.stdout.trim() };
		},
		/** Give `checkout` back for the next verifier, or leave it out when it cannot be reset. */
		async give(checkout: VerifierCheckout): Promise<void> {
			try {
				const reset = await git(checkout.path, ["reset", "--hard", "--quiet", checkout.head], setup.signal);
				const clean =
					reset.code === 0 ? await git(checkout.path, ["clean", "-d", "--force", "--quiet"], setup.signal) : reset;
				if (clean.code === 0) idle.push(checkout);
			} catch {
				// Cancelled: nothing runs in it again.
			}
		},
		async removeAll(): Promise<void> {
			await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
		},
	};
}

/** Verifies every pending cluster with independent verifier sessions, then combines their verdicts. */
export async function verifyClusters(setup: SwarmSetup, state: SwarmState): Promise<void> {
	const { options, signal, target } = setup;
	const pending = state.clusters.filter((cluster) => cluster.outcome === "pending");
	for (const cluster of pending) {
		cluster.verifiers = Array.from(
			{ length: VERIFIERS_PER_CLUSTER },
			(): PassState => ({ status: "queued", toolCalls: 0, turns: 0, usage: emptyUsage() }),
		);
		cluster.verdicts = Array.from({ length: VERIFIERS_PER_CLUSTER }, () => undefined);
	}
	// Both verifiers of a cluster are queued together, so each cluster's verdicts arrive close together.
	const jobs = pending.flatMap((cluster) =>
		Array.from({ length: VERIFIERS_PER_CLUSTER }, (_, slot) => ({ cluster, slot })),
	);
	const systemPrompt = options.exec
		? `${VERIFIER_SYSTEM_PROMPT}\n\n${VERIFIER_EXEC_ADDENDUM}`
		: VERIFIER_SYSTEM_PROMPT;
	const checkouts = verifierCheckouts(setup);
	try {
		await runPool(jobs.length, options.verifierConcurrency, (index) => verify(index));
	} finally {
		await checkouts.removeAll();
	}
	if (signal.aborted) return;
	for (const cluster of pending) cluster.outcome = combine(cluster);

	async function verify(index: number): Promise<void> {
		const { cluster, slot } = jobs[index];
		const pass = cluster.verifiers[slot];
		if (signal.aborted) {
			pass.status = "cancelled";
			return;
		}
		pass.status = "running";
		setup.onProgress();
		let verdict: Verdict | undefined;
		// One host pass per verifier: the diff it is given counts for it alone.
		const hostPass = setup.engine.pass();
		const pending = new Map<string, string>();
		// With bash, commands can change files, so a verifier works in a checkout no other verifier uses meanwhile.
		let privateCheckout: VerifierCheckout | undefined;
		try {
			if (options.exec) privateCheckout = await checkouts.take();
			const checkout = privateCheckout?.path ?? target.checkout;
			await runPass(setup, {
				label: `Swarm review verifier ${cluster.id}.${slot + 1}`,
				model: setup.verifierModel,
				thinking: options.verifierThinking,
				systemPrompt,
				checkout,
				reportTool: createVerdictTool(setup, cluster, checkout, (value) => {
					verdict = value;
				}),
				hasReport: () => verdict !== undefined,
				prompt: verifierPrompt(setup, hostPass, cluster),
				hostTools: hostPass.tools().filter((tool) => tool.name === "review_diff"),
				onEvent: (event) => recordCommand(state, pending, event),
				wrapUpMessage: VERIFIER_WRAP_UP,
				repairMessage: VERIFIER_REPAIR,
				turns: VERIFIER_TURNS,
				state: pass,
				...(options.exec ? { extraTools: ["bash"] } : {}),
			});
			cluster.verdicts[slot] = verdict;
			pass.status = "done";
		} catch (error) {
			pass.status = signal.aborted ? "cancelled" : "failed";
			if (!signal.aborted) pass.error = errorText(error);
		} finally {
			if (privateCheckout) await checkouts.give(privateCheckout);
			setup.onProgress();
		}
	}
}
