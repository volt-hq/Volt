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

const verdict = (line: number, file = "src/value.ts") =>
	fauxAssistantMessage(
		fauxToolCall("report_verdict", {
			verdict: "confirmed",
			reason: "The added guard returns amount when divisor is zero.",
			findings: [
				{
					title: "Zero divisor returns the numerator",
					file,
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
		// One verifier session at a time, so the faux provider's queue is in order.
		globalSettings: { extensions: { "swarm-review": { settings: { verifierConcurrency: 1 } } } },
	});
	cleanups.push(() => harness.cleanup());
	const conversation = await harness.openStartup();
	initializeRepository(conversation.cwd);
	harness.faux.setResponses(responses);
	const client = await createLoopbackClient(harness.host, conversation, { anchor: false });
	cleanups.push(() => client.stop());
	return { harness, client, cwd: conversation.cwd, conversation };
}

/** Options that keep the run to one worker on the faux model; the settings keep verifiers to one at a time. */
const SEQUENTIAL = {
	workers: 1,
	waveSize: 1,
	workerModel: "faux/faux-1",
	verifierModel: "faux/faux-1",
	workerThinking: "off",
	verifierThinking: "off",
	fresh: true,
};

describe("the swarm review as an engine", () => {
	test("is registered as an engine of the extension, with its options", async () => {
		const { conversation } = await setup([]);
		const engine = conversation.session.reviewEngines.get(ENGINE);
		expect(engine).toMatchObject({
			label: "Swarm",
			remoteSafe: true,
			targets: ["uncommitted", "branch", "branch_uncommitted", "commit", "pr"],
		});
		// Named as the settings they override.
		expect(Object.keys(engine?.parameters?.properties ?? {})).toEqual([
			"workers",
			"waveSize",
			"workerModel",
			"workerThinking",
			"verifierModel",
			"verifierThinking",
			"fresh",
		]);
		// Its models and counts have settings of the extension's, tuning is settings only, and /swarm-review is gone.
		expect(Object.keys(swarmManifest.settings.properties)).toEqual(
			expect.arrayContaining([
				"workerModel",
				"workerThinking",
				"verifierModel",
				"verifierThinking",
				"workers",
				"waveSize",
				"concurrency",
				"verifierConcurrency",
				"stragglerGrace",
			]),
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
		expect(run).toMatchObject({ engine: ENGINE, engineLabel: "Swarm", workflowAction: "review.uncommitted" });
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
		// The only file read is the policy the engine gives every pass. The worker's report and each verdict had their
		// anchor in src/value.ts checked against the head, and checking that a file exists is not inspecting it.
		expect(run.result?.coverage.filesInspected).toEqual(["AGENTS.md"]);

		// The report with everything the host has no field for is the work's output. The record is written
		// before the work's executor returns, so wait for the work to settle.
		await conversation.session.work.settled(workId);
		const work = conversation.session.work.get(workId);
		expect(work).toMatchObject({ kind: "review", outcome: "completed" });
		const output = conversation.session.work.output(workId)?.text ?? "";
		expect(output).toContain("**Swarm review**");
		expect(output).toContain("Zero divisor returns the numerator");
	}, 60_000);

	test("repairs invalid worker references and retains an encoded filename through host submission", async () => {
		const path = "src/value%25.ts";
		const encodedFinding = { ...finding, file: path };
		let repair = "";
		const { client, conversation } = await setup([
			fauxAssistantMessage(
				fauxToolCall("report_findings", { findings: [{ ...finding, file: "src/value%zz.ts" }] }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				repair = JSON.stringify(context.messages.at(-1));
				return fauxAssistantMessage(fauxToolCall("report_findings", { findings: [encodedFinding] }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(
				fauxToolCall("report_clusters", { clusters: [{ title: "Zero divisor", claims: ["C1"] }] }),
				{ stopReason: "toolUse" },
			),
			verdict(2, path),
			verdict(2, path),
		]);
		const original = "export function divide(amount: number, divisor: number) {\n\treturn amount / divisor;\n}\n";
		writeFileSync(join(conversation.cwd, "src/value.ts"), original);
		writeFileSync(join(conversation.cwd, "src/value%.ts"), original);
		git(conversation.cwd, "add", "--", "src/value%.ts");
		git(conversation.cwd, "commit", "-m", "percent path base");
		writeFileSync(
			join(conversation.cwd, "src/value%.ts"),
			"export function divide(amount: number, divisor: number) {\n\tif (divisor === 0) return amount;\n\treturn amount / divisor;\n}\n",
		);
		const started = await client.intent("review", {
			target: "uncommitted",
			engine: ENGINE,
			engineParams: SEQUENTIAL,
		});
		const workId = (started as { result: { workId: string } }).result.workId;
		await vi.waitFor(
			() => expect(getReviewRun(conversation.session.sessionManager, workId)?.status).toBe("completed"),
			{ timeout: 30_000 },
		);
		await conversation.session.work.settled(workId);
		expect(repair).toContain("Report rejected");
		const run = getReviewRun(conversation.session.sessionManager, workId)!;
		expect(run.result?.findings).toMatchObject([{ changeLocation: { path } }]);
		expect(run.target.files).toMatchObject([{ path }]);
		expect(run.result?.completionStatus).toBe("complete");
	}, 60_000);

	test.each([
		{
			name: "reports one both rate optional, by default",
			priorities: [3, 3],
			includeOptional: undefined,
			reported: 3,
		},
		{ name: "reports a P2/P3 split at P2", priorities: [3, 2], includeOptional: undefined, reported: 2 },
		{
			name: "leaves optional ones in the report when told to",
			priorities: [3, 3],
			includeOptional: false,
			reported: undefined,
		},
	])(
		"lets verifiers confirm a defect they rate optional: $name",
		async ({ priorities, includeOptional, reported }) => {
			const confirmedAt = (priority: number) =>
				fauxAssistantMessage(
					fauxToolCall("report_verdict", {
						verdict: "confirmed",
						reason: "The added guard returns amount when divisor is zero.",
						findings: [
							{
								title: "Zero divisor returns the numerator",
								file: "src/value.ts",
								line: 2,
								priority,
								explanation: "The guard returns amount instead of signalling an invalid division.",
							},
						],
					}),
					{ stopReason: "toolUse" },
				);
			// Each verifier answers once: a P3 the host's checks sent back would leave the queue short.
			const { client, conversation, harness } = await setup([
				fauxAssistantMessage(fauxToolCall("report_findings", { findings: [finding] }), { stopReason: "toolUse" }),
				fauxAssistantMessage(
					fauxToolCall("report_clusters", {
						clusters: [{ title: "Zero divisor guard returns the wrong value", claims: ["C1"] }],
					}),
					{ stopReason: "toolUse" },
				),
				confirmedAt(priorities[0]),
				confirmedAt(priorities[1]),
			]);
			const started = await client.intent("review", {
				target: "uncommitted",
				engine: ENGINE,
				engineParams: SEQUENTIAL,
				...(includeOptional === undefined ? {} : { includeOptional }),
			});
			const workId = (started as { result: { workId: string } }).result.workId;
			await vi.waitFor(
				() => expect(getReviewRun(conversation.session.sessionManager, workId)?.status).toBe("completed"),
				{ timeout: 30_000 },
			);
			expect(harness.faux.state.callCount).toBe(4);
			const run = getReviewRun(conversation.session.sessionManager, workId)!;
			await conversation.session.work.settled(workId);
			const output = conversation.session.work.output(workId)?.text ?? "";
			if (reported === undefined) {
				expect(run.result?.findings).toHaveLength(0);
				expect(output).toContain("### Optional improvements (P3; this review leaves them out)");
			} else {
				expect(run.result?.findings).toHaveLength(1);
				expect(run.result?.findings[0]).toMatchObject({ priority: reported });
				expect(output).not.toContain("### Optional improvements");
			}
		},
		60_000,
	);

	test("fails with the reason when its model cannot be found, before any session starts", async () => {
		const { client, conversation, harness } = await setup([]);
		const started = await client.intent("review", {
			target: "uncommitted",
			engine: ENGINE,
			engineParams: { ...SEQUENTIAL, workerModel: "nothing/at-all" },
		});
		const workId = (started as { result: { workId: string } }).result.workId;
		await vi.waitFor(() => expect(getReviewRun(conversation.session.sessionManager, workId)?.status).toBe("failed"));
		expect(getReviewRun(conversation.session.sessionManager, workId)?.errorMessage).toContain(
			'Worker model "nothing/at-all" is unknown or not authenticated.',
		);
		expect(harness.faux.state.callCount).toBe(0);
	});

	test.each([
		{ effort: "standard" as const, workerSessions: 1 },
		{ effort: "high" as const, workerSessions: 2 },
	])(
		"at $effort effort, a wave that finds nothing new runs $workerSessions worker session(s)",
		async ({ effort, workerSessions }) => {
			const nothing = () =>
				fauxAssistantMessage(fauxToolCall("report_findings", { findings: [] }), { stopReason: "toolUse" });
			const { client, conversation, harness } = await setup([nothing(), nothing()]);
			const started = await client.intent("review", {
				target: "uncommitted",
				engine: ENGINE,
				effort,
				engineParams: { ...SEQUENTIAL, workers: 2 },
			});
			const workId = (started as { result: { workId: string } }).result.workId;
			await vi.waitFor(
				() => expect(getReviewRun(conversation.session.sessionManager, workId)?.status).toBe("completed"),
				{ timeout: 30_000 },
			);
			expect(harness.faux.state.callCount).toBe(workerSessions);
		},
		60_000,
	);

	test("lets verifiers run commands when a client at the host grants bash, in a checkout each reuses once reset", async () => {
		const toolResults: string[] = [];
		const afterCommand =
			(line: number): FauxResponseFactory =>
			(context) => {
				toolResults.push(JSON.stringify(context.messages.at(-1)));
				return verdict(line);
			};
		const { client, conversation } = await setup([
			fauxAssistantMessage(fauxToolCall("report_findings", { findings: [finding] }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("report_clusters", {
					clusters: [{ title: "Zero divisor guard returns the wrong value", claims: ["C1"] }],
				}),
				{ stopReason: "toolUse" },
			),
			// The first verifier checks with a command, leaving a file behind, before it reports.
			fauxAssistantMessage(fauxToolCall("bash", { command: "pwd;   printf x > left-by-first" }), {
				stopReason: "toolUse",
			}),
			afterCommand(2),
			// The second works in the same checkout, reset: the file is gone, or the command fails.
			fauxAssistantMessage(fauxToolCall("bash", { command: "pwd; test ! -e left-by-first" }), {
				stopReason: "toolUse",
			}),
			afterCommand(2),
		]);

		// A paired remote device is refused the grant, as for any review.
		const remote = {
			target: { session: conversation.session, conversation, host: {}, client: {} } as never,
			services: { runReview: vi.fn() },
			profile: { name: "remote" as const, grant: createIrohRemoteRpcGrant(REMOTE_CAPABILITIES) },
		};
		await expect(
			intentRegistry.invoke(remote, "review", { target: "uncommitted", engine: ENGINE, tools: ["bash"] }),
		).rejects.toMatchObject({ code: "not_allowed" });
		expect(remote.services.runReview).not.toHaveBeenCalled();

		const started = await client.intent("review", {
			target: "uncommitted",
			engine: ENGINE,
			engineParams: SEQUENTIAL,
			tools: ["bash"],
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
		expect(run.result?.coverage.commandsRun).toEqual([
			"pwd; printf x > left-by-first",
			"pwd; test ! -e left-by-first",
		]);
		expect(run.result?.coverage.failedVerificationAttempts).toEqual([]);
		// One checkout, set up once, served both verifiers.
		const checkouts = toolResults.map((result) => /volt-review-checkout-[\w]+/.exec(result)?.[0]);
		expect(checkouts).toHaveLength(2);
		expect(checkouts[0]).toBeDefined();
		expect(checkouts[1]).toBe(checkouts[0]);
		expect(run.result?.coverage.residualRisk).not.toContain(
			"Static review only. This review did not run tests or runtime checks.",
		);
		expect(run.result?.findings).toHaveLength(1);
	}, 60_000);
});
