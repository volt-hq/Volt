// Regression for https://github.com/volt-hq/Volt/issues/1082
//
// The swarm review split a large diff into shards among its workers and told each to focus on its own, so a change
// got fewer independent reviews than it had workers. From the second wave on, workers were also told what earlier
// waves reported and asked not to report it again. Every worker must now review the whole change, paging what of
// the diff its prompt leaves out, with the same prompt in every wave; only workers that read every hunk count as
// full reviews.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import swarmReview, { manifest as swarmManifest } from "../../../../../.volt/extensions/swarm-review/index.ts";
import { createLoopbackClient } from "../../../src/client/protocol-client.ts";
import { getReviewRun } from "../../../src/core/review-state.ts";
import { createHostHarness } from "../host-harness.ts";

const ENGINE = "ext:swarm-review/swarm";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** A working tree that changes line 1 of src/small.ts and, with `big`, adds a diff to src/big.ts no prompt carries. */
function initializeRepository(cwd: string, big: boolean): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	git(cwd, "init", "--initial-branch=main");
	git(cwd, "config", "user.email", "review@example.com");
	git(cwd, "config", "user.name", "Review Test");
	git(cwd, "config", "commit.gpgsign", "false");
	writeFileSync(join(cwd, ".gitignore"), "sessions/\n");
	writeFileSync(join(cwd, "src", "small.ts"), "export const limit = 1;\n");
	writeFileSync(join(cwd, "src", "big.ts"), "export const rows = [\n];\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-m", "initial");
	writeFileSync(join(cwd, "src", "small.ts"), "export const limit = 0;\n");
	if (big) {
		// About 216 KB of patch: more than the 200 KB of diff a worker's prompt carries.
		const rows = Array.from({ length: 3_000 }, (_, index) => `\t"row ${index} ${"x".repeat(60)}",\n`).join("");
		writeFileSync(join(cwd, "src", "big.ts"), `export const rows = [\n${rows}];\n`);
	}
}

async function setup(big: boolean) {
	const harness = await createHostHarness({
		whenUnattached: "keep",
		extensions: [{ manifest: swarmManifest, factory: swarmReview }],
		// One session at a time, so the faux provider's queue is in order.
		globalSettings: { extensions: { "swarm-review": { settings: { concurrency: 1, verifierConcurrency: 1 } } } },
	});
	cleanups.push(() => harness.cleanup());
	const conversation = await harness.openStartup();
	initializeRepository(conversation.cwd, big);
	const client = await createLoopbackClient(harness.host, conversation, { anchor: false });
	cleanups.push(() => client.stop());
	const review = async (workers: number, waveSize: number, status: "completed" | "incomplete" = "completed") => {
		const started = await client.intent("review", {
			target: "uncommitted",
			engine: ENGINE,
			engineParams: {
				workers,
				waveSize,
				workerModel: "faux/faux-1",
				verifierModel: "faux/faux-1",
				workerThinking: "off",
				verifierThinking: "off",
				fresh: true,
			},
		});
		const workId = (started as { result: { workId: string } }).result.workId;
		await vi.waitFor(() => expect(getReviewRun(conversation.session.sessionManager, workId)?.status).toBe(status), {
			timeout: 30_000,
		});
		await conversation.session.work.settled(workId);
		return {
			run: getReviewRun(conversation.session.sessionManager, workId)!,
			output: conversation.session.work.output(workId)?.text ?? "",
		};
	};
	return { harness, review };
}

function text(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

/** The prompt a session started with. */
function firstPrompt(context: Context): string {
	const first = context.messages.find((message) => message.role === "user");
	return first ? text(first.content) : "";
}

const finding = {
	title: "Zero limit admits nothing",
	file: "src/small.ts",
	line: 1,
	priority: 2,
	confidence: 0.9,
	trigger: "Any caller checks a count against limit.",
	impact: "Every request is refused.",
	evidence: "The change sets limit to 0.",
};

describe("swarm workers review the whole change independently (issue #1082)", () => {
	/**
	 * Every worker session: it records its prompt, pages src/big.ts for as many pages as its entry in `pages` allows
	 * (all of them when undefined), then reports nothing.
	 */
	function pagingWorkers(pages: Array<number | undefined>) {
		const prompts: string[] = [];
		const respond: FauxResponseFactory = (context) => {
			if (context.messages.length === 1) prompts.push(firstPrompt(context));
			const limit = pages[prompts.length - 1];
			const read = context.messages.filter((message) => message.role === "toolResult").length;
			const last = context.messages.at(-1);
			const cursor = last?.role === "toolResult" ? /Next cursor: (\S+)/.exec(text(last.content))?.[1] : undefined;
			if (limit === undefined || read < limit) {
				if (read === 0) {
					return fauxAssistantMessage(fauxToolCall("review_diff", { path: "src/big.ts", maxBytes: 65_536 }), {
						stopReason: "toolUse",
					});
				}
				if (cursor) {
					return fauxAssistantMessage(fauxToolCall("review_diff", { cursor, maxBytes: 65_536 }), {
						stopReason: "toolUse",
					});
				}
			}
			return fauxAssistantMessage(fauxToolCall("report_findings", { findings: [] }), { stopReason: "toolUse" });
		};
		return { prompts, responses: Array.from({ length: 30 }, () => respond) };
	}

	test("gives every worker the same prompt for the whole change and counts each that paged the rest as a full review", async () => {
		const { harness, review } = await setup(true);
		const workers = pagingWorkers([undefined, undefined]);
		harness.faux.setResponses(workers.responses);

		const { run, output } = await review(2, 2);

		expect(workers.prompts).toHaveLength(2);
		expect(workers.prompts[1]).toBe(workers.prompts[0]);
		const [prompt] = workers.prompts;
		// The small file's diff is in the prompt; the big one is named for paging, not handed to another reviewer.
		expect(prompt).toContain("export const limit = 0;");
		expect(prompt).not.toContain('"row 0 ');
		expect(prompt).toMatch(/leaves out 1 file\(s\): src\/big\.ts\. You review the whole change/);
		expect(prompt).not.toMatch(/other reviewers|split among/i);
		expect(run.result?.coverage.hunksInspected).toHaveLength(2);
		expect(run.result?.completionStatus).toBe("complete");
		expect(output).toContain("2 of 2 workers reviewed the whole change");
	}, 60_000);

	test("leaves the run incomplete when no worker read the whole change", async () => {
		const { harness, review } = await setup(true);
		const workers = pagingWorkers([1]);
		harness.faux.setResponses(workers.responses);

		const { run, output } = await review(1, 1, "incomplete");

		expect(run.result?.completionStatus).toBe("incomplete");
		expect(output).toContain("0 of 1 workers reviewed the whole change");
		expect(output).toContain("**Not reviewed:** no finished worker read the whole diff of 1 file(s) (src/big.ts).");
	}, 60_000);

	test("gives a later wave the same prompt as the first, with nothing an earlier worker reported", async () => {
		const { harness, review } = await setup(false);
		const prompts: string[] = [];
		const worker: FauxResponseFactory = (context) => {
			prompts.push(firstPrompt(context));
			return fauxAssistantMessage(fauxToolCall("report_findings", { findings: [finding] }), {
				stopReason: "toolUse",
			});
		};
		const verdict = fauxAssistantMessage(
			fauxToolCall("report_verdict", {
				verdict: "confirmed",
				reason: "The change sets limit to 0.",
				findings: [
					{ title: finding.title, file: "src/small.ts", line: 1, priority: 2, explanation: "limit is 0." },
				],
			}),
			{ stopReason: "toolUse" },
		);
		harness.faux.setResponses([
			worker,
			fauxAssistantMessage(
				fauxToolCall("report_clusters", { clusters: [{ title: finding.title, claims: ["C1"] }] }),
				{
					stopReason: "toolUse",
				},
			),
			// The second wave runs because the first found a new issue; its worker finds the same one on its own.
			worker,
			fauxAssistantMessage(
				fauxToolCall("report_clusters", { clusters: [{ id: "K1", title: finding.title, claims: ["C2"] }] }),
				{ stopReason: "toolUse" },
			),
			verdict,
			verdict,
		]);

		const { run, output } = await review(2, 1);

		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toBe(prompts[0]);
		expect(prompts[1]).not.toContain(finding.title);
		expect(prompts[1]).not.toMatch(/already reported/i);
		expect(run.result?.findings).toHaveLength(1);
		expect(output).toContain("found by 2/2 workers");
	}, 60_000);
});
