/**
 * The swarm review as an engine: the real extension, run by the host through the `review` intent, with the faux
 * provider as every model. One worker finds a defect, the clustering pass groups it, and two verifiers confirm it;
 * the first verifier anchors it on a line the change did not touch, so the host's validation sends it back.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { REMOTE_CAPABILITIES } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import swarmReview, { manifest as swarmManifest } from "../../../../.volt/extensions/swarm-review/index.ts";
import { createLoopbackClient, type LoopbackClient } from "../../src/client/protocol-client.ts";
import { intentRegistry } from "../../src/core/protocol/intents/index.ts";
import { createIrohRemoteRpcGrant } from "../../src/core/remote/iroh/access-grant.ts";
import { getReviewRun } from "../../src/core/review-state.ts";
import { createHostHarness, type HostHarness } from "./host-harness.ts";

const ENGINE = "ext:swarm-review/swarm";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** A repository whose working tree changes line 2 of src/value.ts. */
function initializeRepository(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	git(cwd, "init", "--initial-branch=main");
	git(cwd, "config", "user.email", "review@example.com");
	git(cwd, "config", "user.name", "Review Test");
	git(cwd, "config", "commit.gpgsign", "false");
	writeFileSync(join(cwd, ".gitignore"), "sessions/\n");
	writeFileSync(join(cwd, "AGENTS.md"), "BASE POLICY\n");
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

const finding = {
	title: "Zero returns the numerator",
	file: "src/value.ts",
	line: 2,
	endLine: 2,
	priority: 2,
	confidence: 0.9,
	trigger: "Call divide with a zero divisor.",
	impact: "Callers receive the numerator as the result.",
	evidence: "The added guard returns amount.",
};

const verdict = (line: number) =>
	fauxAssistantMessage(
		fauxToolCall("report_verdict", {
			verdict: "confirmed",
			reason: "The added guard returns amount when divisor is zero.",
			findings: [
				{
					title: "Zero divisor returns the numerator",
					file: "src/value.ts",
					line,
					priority: 2,
					explanation: "The guard returns amount instead of signalling an invalid division.",
					fix: "Throw a RangeError.",
				},
			],
		}),
		{ stopReason: "toolUse" },
	);

interface Fixture {
	harness: HostHarness;
	client: LoopbackClient;
	cwd: string;
	conversation: Awaited<ReturnType<HostHarness["openStartup"]>>;
}

async function setup(
	responses: Array<ReturnType<typeof fauxAssistantMessage> | FauxResponseFactory>,
): Promise<Fixture> {
	const harness = await createHostHarness({
		whenUnattached: "keep",
		extensions: [{ manifest: swarmManifest, factory: swarmReview }],
	});
	cleanups.push(() => harness.cleanup());
	const conversation = await harness.openStartup();
	initializeRepository(conversation.cwd);
	harness.faux.setResponses(responses);
	const client = await createLoopbackClient(harness.host, conversation, { anchor: false });
	cleanups.push(() => client.stop());
	return { harness, client, cwd: conversation.cwd, conversation };
}

/** Options that keep the run to one worker and one session at a time, so the faux provider's queue is in order. */
const SEQUENTIAL = {
	workers: 1,
	waveSize: 1,
	concurrency: 1,
	verifierConcurrency: 1,
	model: "faux/faux-1",
	verifier: "faux/faux-1",
	thinking: "off",
	verifierThinking: "off",
	fresh: true,
};

describe("the swarm review as an engine", () => {
	test("is registered as an engine of the extension, with its options and its local-only one", async () => {
		const { conversation } = await setup([]);
		const engine = conversation.session.reviewEngines.get(ENGINE);
		expect(engine).toMatchObject({
			label: "Swarm",
			remoteSafe: true,
			localOnly: ["exec"],
			targets: ["uncommitted", "branch", "branch_uncommitted", "commit", "pr"],
		});
		expect(Object.keys(engine?.parameters?.properties ?? {})).toEqual([
			"workers",
			"waveSize",
			"concurrency",
			"model",
			"thinking",
			"verifier",
			"verifierThinking",
			"verifierConcurrency",
			"stragglerGrace",
			"fresh",
			"exec",
		]);
		// Its models and counts have settings of the extension's, and /swarm-review is gone.
		expect(Object.keys(swarmManifest.settings.properties)).toEqual(
			expect.arrayContaining(["workerModel", "verifierModel", "workers", "waveSize"]),
		);
		expect(conversation.session.extensionRunner.getRegisteredCommands().map((command) => command.name)).not.toContain(
			"swarm-review",
		);
	});

	test("runs a swarm through the host and hands the host findings it has validated", async () => {
		// What the worker's model is sent: the host delivers it the diff text.
		let workerRequest = "";
		const worker: FauxResponseFactory = (context) => {
			workerRequest = JSON.stringify(context.messages);
			return fauxAssistantMessage(fauxToolCall("report_findings", { findings: [finding] }), {
				stopReason: "toolUse",
			});
		};
		const { client, conversation } = await setup([
			// The worker's claim, then the clustering of it.
			worker,
			fauxAssistantMessage(
				fauxToolCall("report_clusters", {
					clusters: [{ title: "Zero divisor guard returns the wrong value", claims: ["C1"] }],
				}),
				{ stopReason: "toolUse" },
			),
			// The first verifier anchors on line 1, which the change did not touch: the host's validation says so.
			verdict(1),
			verdict(2),
			// The second verifier gets it right.
			verdict(2),
		]);

		const started = await client.intent("review", {
			target: "uncommitted",
			engine: ENGINE,
			engineParams: SEQUENTIAL,
		});
		const workId = (started as { result: { workId: string } }).result.workId;
		await vi.waitFor(
			() => expect(getReviewRun(conversation.session.sessionManager, workId)?.status).toBe("completed"),
			{
				timeout: 30_000,
			},
		);

		const run = getReviewRun(conversation.session.sessionManager, workId)!;
		expect(run).toMatchObject({ engine: ENGINE, workflowAction: "review.uncommitted" });
		expect(run.result).toMatchObject({ completionStatus: "complete", overallCorrectness: "incorrect" });
		expect(run.result?.findings).toHaveLength(1);
		const [result] = run.result!.findings;
		expect(result).toMatchObject({
			title: "Zero divisor returns the numerator",
			priority: 2,
			status: "open",
			category: "swarm",
			changeLocation: { path: "src/value.ts", side: "head", startLine: 2, endLine: 2 },
			trigger: "Call divide with a zero divisor.",
			impact: "Callers receive the numerator as the result.",
			verification: { outcome: "accepted", method: expect.stringContaining("Both verifiers confirmed it") },
		});
		expect(result?.body).toContain("Fix: Throw a RangeError.");
		expect(workerRequest).toContain("if (divisor === 0) return amount;");
		expect(workerRequest).toContain("src/value.ts | +1 -0");
		// The host observed the diff delivered and the changed-file inventory given: no unchecked area.
		expect(run.result?.coverage).toMatchObject({ changedFileInventoryComplete: true, uncheckedAreas: [] });
		expect(run.result?.coverage.hunksInspected).toHaveLength(1);

		// The report with everything the host has no field for is the work's output. The record is written
		// before the work's executor returns, so wait for the work to settle.
		await conversation.session.work.settled(workId);
		const work = conversation.session.work.get(workId);
		expect(work).toMatchObject({ kind: "review", outcome: "completed" });
		const output = conversation.session.work.output(workId)?.text ?? "";
		expect(output).toContain("**Swarm review**");
		expect(output).toContain("Zero divisor returns the numerator");
	}, 60_000);

	test("fails with the reason when its model cannot be found, before any session starts", async () => {
		const { client, conversation, harness } = await setup([]);
		const started = await client.intent("review", {
			target: "uncommitted",
			engine: ENGINE,
			engineParams: { ...SEQUENTIAL, model: "nothing/at-all" },
		});
		const workId = (started as { result: { workId: string } }).result.workId;
		await vi.waitFor(() => expect(getReviewRun(conversation.session.sessionManager, workId)?.status).toBe("failed"));
		expect(getReviewRun(conversation.session.sessionManager, workId)?.errorMessage).toContain(
			'Worker model "nothing/at-all" is unknown or not authenticated.',
		);
		expect(harness.faux.state.callCount).toBe(0);
	});

	test("lets verifiers run commands only for a client at the host, and reports what they ran", async () => {
		const { client, conversation } = await setup([
			fauxAssistantMessage(fauxToolCall("report_findings", { findings: [finding] }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("report_clusters", {
					clusters: [{ title: "Zero divisor guard returns the wrong value", claims: ["C1"] }],
				}),
				{ stopReason: "toolUse" },
			),
			// The first verifier checks with a command before it reports.
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo   checked   the guard" }), {
				stopReason: "toolUse",
			}),
			verdict(2),
			verdict(2),
		]);

		// A paired remote device is refused the option; the engine is not told of it.
		const remote = {
			target: { session: conversation.session, conversation, host: {}, client: {} } as never,
			services: { runReview: vi.fn() },
			profile: { name: "remote" as const, grant: createIrohRemoteRpcGrant(REMOTE_CAPABILITIES) },
		};
		await expect(
			intentRegistry.invoke(remote, "review", {
				target: "uncommitted",
				engine: ENGINE,
				engineParams: { exec: true },
			}),
		).rejects.toMatchObject({ code: "not_allowed", message: "exec can only be set by a client at the host" });
		expect(remote.services.runReview).not.toHaveBeenCalled();

		const started = await client.intent("review", {
			target: "uncommitted",
			engine: ENGINE,
			engineParams: { ...SEQUENTIAL, exec: true },
		});
		const workId = (started as { result: { workId: string } }).result.workId;
		await vi.waitFor(
			() => expect(getReviewRun(conversation.session.sessionManager, workId)?.status).toBe("completed"),
			{
				timeout: 30_000,
			},
		);
		const run = getReviewRun(conversation.session.sessionManager, workId)!;
		// A review that ran a command is not a static one.
		expect(run.result?.coverage.commandsRun).toEqual(["echo checked the guard"]);
		expect(run.result?.coverage.residualRisk).not.toContain(
			"Static review only. This review did not run tests or runtime checks.",
		);
		expect(run.result?.findings).toHaveLength(1);
	}, 60_000);
});
