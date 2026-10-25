import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@hansjm10/volt-ai";
import type { HostRequest, HostResponse } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAudit } from "../../../../.volt/extensions/goal/auditor.ts";
import { type AuditRunner, manifest, registerGoal } from "../../../../.volt/extensions/goal/index.ts";
import {
	type Audit,
	createGoal,
	emptyState,
	type GoalState,
	type Proposal,
	restoreState,
	STATE_ENTRY,
} from "../../../../.volt/extensions/goal/state.ts";
import { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionError } from "../../src/core/extensions/types.ts";
import { ClientScope } from "../../src/core/host/client-scope.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import * as nativeTools from "../../src/core/tools/index.ts";
import { createLiveRecorder } from "../utilities/live-recorder.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const proposal: Proposal = {
	objective: "Fix the parser",
	requirements: ["Valid input parses and invalid input is rejected"],
	tasks: [
		{ title: "Implement", requirement: "Cover valid input" },
		{ title: "Verify", requirement: "Cover invalid input" },
	],
};
const approved: Audit = {
	verdict: "approved",
	report: "Checked the implementation and focused tests.\n<approved/>",
	model: "faux/faux-1",
};
const call = (name: string, args: JsonObject) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const stateOf = (harness: Harness) => restoreState(harness.sessionManager.getBranch());
const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	vi.restoreAllMocks();
});

async function setup(audit: AuditRunner = async () => approved, options: HarnessOptions = {}) {
	const harness = await createHarness({
		...options,
		settings: { retry: { enabled: false }, compaction: { enabled: false }, ...options.settings },
		extensionFactories: [
			{ id: manifest.id, permissions: manifest.permissions, factory: (volt) => registerGoal(volt, audit) },
			...(options.extensionFactories ?? []),
		],
	});
	harnesses.push(harness);
	harness.settingsManager.setProjectTrusted(true);
	await harness.session.setSessionName("Goal test");
	const live = createLiveRecorder(["confirm", "form", "dialog"]);
	const detach = harness.session.liveState.attach("test", live);
	const errors: ExtensionError[] = [];
	await harness.session.attachExtensionClient({
		id: "test",
		mode: "rpc",
		onError: (error) => {
			errors.push(error);
		},
		commandContextActions: {
			waitForIdle: () => harness.session.waitForIdle(),
			newSession: async () => ({ cancelled: true }),
			fork: async () => ({ cancelled: true }),
			switchSession: async () => ({ cancelled: true }),
			navigateTree: async () => ({ cancelled: true }),
			reload: async () => {},
		},
	}).ready;
	return {
		harness,
		live,
		errors,
		detach,
		async answer(kind: HostRequest["kind"], response: HostResponse) {
			await vi.waitFor(() => expect(live.pending()[0]?.request.kind).toBe(kind));
			const request = live.pending()[0];
			expect(harness.session.liveState.answer(request.requestId, response, "test")).toBe("accepted");
			return request.request;
		},
	};
}

async function seeded(status: "active" | "auditing" | "paused" | "blocked" = "paused") {
	const manager = SessionManager.inMemory();
	const state: GoalState = { ...emptyState(), goal: { ...createGoal(proposal, "regular"), status } };
	await manager.logWriter.appendCustomEntry(STATE_ENTRY, state);
	return manager;
}

describe("goal extension lifecycle", () => {
	it("guides a draft, waits for affirmative approval, serializes progress, continues, then audits completion", async () => {
		const audit = vi.fn<AuditRunner>(async () => approved);
		const { harness, answer, errors } = await setup(audit);
		harness.setResponses([
			call("goal_propose", proposal),
			fauxAssistantMessage(
				[
					fauxToolCall("goal_task", { id: "1", status: "complete", evidence: "valid-input fixture passed" }),
					fauxToolCall("goal_task", { id: "2", status: "complete", evidence: "invalid-input fixture passed" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Implementation and verification done; audit next."),
			(context) => {
				expect(
					context.messages.some((message) => getMessageText(message).includes("valid-input fixture passed")),
				).toBe(true);
				return call("goal_complete", { evidence: "Both focused fixtures passed." });
			},
			(context) => {
				expect(context.tools ?? []).toEqual([]);
				return fauxAssistantMessage("Auditor approved completion.");
			},
		]);
		const drafting = harness.session.prompt("/goal");
		await answer("form", { values: { objective: proposal.objective, requirements: proposal.requirements[0] } });
		await drafting;
		await vi.waitFor(() => expect(stateOf(harness).draft).not.toBeNull());
		expect(stateOf(harness).goal).toBeNull();
		await answer("confirm", { confirmed: true });
		await harness.session.waitForIdle();
		expect(errors).toEqual([]);
		expect(stateOf(harness).goal).toMatchObject({ status: "complete", audit: approved });
		expect(stateOf(harness).goal?.tasks.map((task) => task.status)).toEqual(["complete", "complete"]);
		const snapshots = harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === STATE_ENTRY ? [entry.data as GoalState] : [],
			);
		expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(snapshots.at(-2)?.goal?.status).toBe("auditing");
		expect(audit).toHaveBeenCalledOnce();
		expect(audit.mock.calls[0][0].tools.sort()).toEqual(["bash", "read"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
	});

	it.each([false, undefined])("never approves when confirmation is %s", async (approval) => {
		const audit = vi.fn<AuditRunner>(async () => approved);
		const { harness, answer, detach } = await setup(audit);
		harness.setResponses([call("goal_propose", proposal), fauxAssistantMessage("Not approved.")]);
		await harness.session.prompt("/goal Fix parser");
		if (approval === false) await answer("confirm", { confirmed: false });
		else {
			// No client is attached when the proposal asks. UI defaults are not consent.
			detach();
		}
		await harness.session.waitForIdle();
		expect(stateOf(harness)).toMatchObject({ goal: null, draft: null });
		expect(audit).not.toHaveBeenCalled();
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
	});

	it("pauses a pending confirmation without accepting its later answer", async () => {
		const { harness, live } = await setup();
		harness.setResponses([call("goal_propose", proposal), fauxAssistantMessage("Must not execute.")]);
		await harness.session.prompt("/goal Fix parser");
		await vi.waitFor(() => expect(live.pending()[0]?.request.kind).toBe("confirm"));
		const requestId = live.pending()[0].requestId;
		await harness.session.prompt("/goal-pause");
		await harness.session.waitForIdle();
		expect(harness.session.liveState.answer(requestId, { confirmed: true }, "test")).toBe("unknown");
		expect(stateOf(harness)).toMatchObject({ goal: null, draft: null });
	});

	it.each(["active", "auditing"] as const)(
		"restores an interrupted %s goal as paused without starting inference",
		async (status) => {
			const { harness } = await setup(undefined, { sessionManager: await seeded(status) });
			expect(stateOf(harness).goal?.status).toBe("paused");
			expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		},
	);

	it("resumes a confirmed goal, blocks on user input, and keeps separate instances independent", async () => {
		const { harness } = await setup(undefined, { sessionManager: await seeded() });
		const other = await setup();
		harness.setResponses([call("goal_block", { reason: "Need authorization for an environment repair." })]);
		await harness.session.prompt("/goal-resume");
		await harness.session.waitForIdle();
		expect(stateOf(harness).goal).toMatchObject({
			status: "blocked",
			note: expect.stringContaining("authorization"),
		});
		expect(stateOf(other.harness)).toEqual(emptyState());
		expect(other.harness.eventsOfType("agent_start")).toHaveLength(0);
	});

	it.each(["paused", "blocked"] as const)(
		"records an explicit blocker on a %s goal without resuming it or preventing unrelated work",
		async (status) => {
			const { harness, errors } = await setup(undefined, { sessionManager: await seeded(status) });
			for (const reason of ["Need authorization.", "Need the user to approve the specific repair first."]) {
				harness.setResponses([call("goal_block", { reason })]);
				await harness.session.prompt("Record the blocker only; do not resume the goal.");
				await harness.session.waitForIdle();
				expect(stateOf(harness).goal).toMatchObject({ status: "blocked", note: reason });
			}
			const blocked = stateOf(harness);
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("jobs", { action: "list" }),
						fauxToolCall("goal_task", { id: "1", status: "active", evidence: "Must not save." }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Listed jobs without resuming the goal."),
			]);
			await harness.session.prompt("Separate maintenance request: list existing jobs, but do not resume the goal.");
			await harness.session.waitForIdle();
			expect(
				harness.session.messages.findLast(
					(message) => message.role === "toolResult" && message.toolName === "jobs",
				),
			).toMatchObject({ isError: false });
			const rejected = harness.session.messages.findLast(
				(message) => message.role === "toolResult" && message.toolName === "goal_task",
			);
			expect(rejected).toMatchObject({ isError: true });
			expect(getMessageText(rejected)).toContain("Resume the goal before updating tasks.");
			expect(stateOf(harness)).toEqual(blocked);
			expect(errors).toEqual([]);
		},
	);

	it.each([0, 1])(
		"keeps a failed foreground goal blocked when a native job wakes with exit code %i",
		async (exitCode) => {
			const finish = Promise.withResolvers<void>();
			let jobSignal: AbortSignal | undefined;
			const operations: BashOperations = {
				exec: async (_command, _cwd, options) => {
					jobSignal = options.signal;
					options.onData(Buffer.from("Already-authorized job result.\n"));
					await finish.promise;
					return { exitCode };
				},
			};
			// Keep native background wrapping, grants, result delivery, and wake admission intact.
			const definitions = nativeTools.createAllToolDefinitions;
			vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
				definitions(cwd, { ...options, bash: { ...options?.bash, operations } }),
			);
			const manager = await seeded();
			await manager.logWriter.appendCustomMessageEntry(
				"volt-goal.context",
				"stale-goal-fixture: execute now",
				false,
			);
			await manager.logWriter.appendCustomMessageEntry("other.context", "Other extension context stays.", false);
			let preparations = 0;
			const { harness, errors } = await setup(undefined, {
				sessionManager: manager,
				extensionFactories: [
					{
						id: "count-preparations",
						factory: (volt) => {
							volt.on("before_agent_start", () => {
								preparations++;
							});
						},
					},
				],
			});
			const requests: string[][] = [];
			harness.setResponses([
				(context) => {
					requests.push(context.messages.map(getMessageText));
					return call("bash", { command: "controlled authorized work", background: true });
				},
				(context) => {
					requests.push(context.messages.map(getMessageText));
					return fauxAssistantMessage("", {
						stopReason: "error",
						error: { kind: "unknown", retryable: false, message: "Sensitive synthetic failure detail." },
					});
				},
			]);
			try {
				await harness.session.prompt("/goal-resume");
				await harness.session.waitForIdle();
				const blocked = stateOf(harness);
				expect(blocked.goal?.status).toBe("blocked");
				expect(harness.session.work.busy()).toBe(true);
				expect(jobSignal?.aborted).toBe(false);
				const job = harness.session.jobs.list()[0];
				expect(job.status).toBe("running");
				const prepared = preparations;
				harness.setResponses([
					(context) => {
						requests.push(context.messages.map(getMessageText));
						return call("jobs", { action: "read", id: job.id });
					},
					(context) => {
						requests.push(context.messages.map(getMessageText));
						return call("goal_task", { id: "1", status: "complete", evidence: "Not authorized by a job wake." });
					},
					(context) => {
						requests.push(context.messages.map(getMessageText));
						return fauxAssistantMessage("Collected result; goal remains blocked.");
					},
				]);
				finish.resolve();
				await harness.session.work.waitForIdle();
				await harness.session.waitForIdle();
				expect(harness.getPendingResponseCount()).toBe(0);
				expect(requests).toHaveLength(5);
				for (const [index, messages] of requests.entries()) {
					const guidance = messages.filter((text) => text.includes("Goal state (data):"));
					expect(guidance).toHaveLength(1);
					expect(guidance[0]).toContain(index < 2 ? "Status: active" : "Status: blocked");
					if (index >= 2) {
						expect(guidance[0]).toContain("This goal is not running.");
						expect(guidance[0]).toContain("already-authorized job results");
						expect(guidance[0]).not.toContain("Work only on the user-confirmed goal");
					}
					expect(messages.join("\n")).not.toContain("stale-goal-fixture");
					expect(messages.join("\n")).toContain("Other extension context stays.");
				}
				expect(preparations).toBe(prepared); // A native work wake bypasses prompt preflight.
				expect(harness.session.jobs.get(job.id).status).toBe(exitCode === 0 ? "completed" : "failed");
				const collected = harness.session.messages.findLast(
					(message) => message.role === "toolResult" && message.toolName === "jobs",
				);
				expect(getMessageText(collected)).toContain("Already-authorized job result.");
				const rejected = harness.session.messages.findLast(
					(message) => message.role === "toolResult" && message.toolName === "goal_task",
				);
				expect(rejected).toMatchObject({ isError: true });
				expect(getMessageText(rejected)).toContain("Resume the goal before updating tasks.");
				expect(stateOf(harness)).toEqual(blocked);
				expect(harness.faux.state.callCount).toBe(5);
				expect(errors).toEqual([]);
			} finally {
				finish.resolve();
			}
		},
	);

	it("requires another affirmative confirmation when tweaking and retains the old goal after rejection", async () => {
		const { harness, answer } = await setup(undefined, { sessionManager: await seeded() });
		const original = stateOf(harness).goal;
		harness.setResponses([
			call("goal_propose", { ...proposal, objective: "Replace the parser" }),
			fauxAssistantMessage("Revision rejected."),
		]);
		await harness.session.prompt("/goal-tweak Replace the parser");
		await answer("confirm", { confirmed: false });
		await harness.session.waitForIdle();
		expect(stateOf(harness).goal).toEqual(original);
		expect(stateOf(harness).draft).toBeNull();
	});

	it("continues after a rejected audit and completes only after the next audit approves", async () => {
		const audit = vi
			.fn<AuditRunner>()
			.mockResolvedValueOnce({
				verdict: "rejected",
				report: "Missing invalid-input test.\n<disapproved/>",
				model: "faux/faux-1",
			})
			.mockResolvedValueOnce(approved);
		const { harness, answer } = await setup(audit);
		harness.setResponses([
			call("goal_propose", { ...proposal, tasks: [] }),
			call("goal_complete", { evidence: "First attempt." }),
			fauxAssistantMessage("Need to verify the missing case."),
			call("goal_complete", { evidence: "Verified the missing case." }),
			fauxAssistantMessage("Complete."),
		]);
		await harness.session.prompt("/goal Fix parser");
		await answer("confirm", { confirmed: true });
		await harness.session.waitForIdle();
		expect(audit).toHaveBeenCalledTimes(2);
		expect(stateOf(harness).goal).toMatchObject({ status: "complete", audit: approved });
	});

	it("blocks on audit errors rather than self-approving or retrying autonomously", async () => {
		const { harness, answer } = await setup(async () => {
			throw new Error("Audit provider unavailable");
		});
		harness.setResponses([
			call("goal_propose", { ...proposal, tasks: [] }),
			call("goal_complete", { evidence: "Done." }),
			fauxAssistantMessage("Audit failed."),
		]);
		await harness.session.prompt("/goal Fix parser");
		await answer("confirm", { confirmed: true });
		await harness.session.waitForIdle();
		expect(stateOf(harness).goal).toMatchObject({
			status: "blocked",
			audit: { verdict: "error", report: "Audit provider unavailable" },
		});
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
	});

	it("uses a fresh SDK auditor with only the allowed tools and inherited project instructions", async () => {
		const { harness, answer, errors } = await setup((options) =>
			runAudit({
				...options,
				contextFiles: [{ path: "AGENTS.md", content: "Audit fixture: never run deployment commands." }],
			}),
		);
		let auditRequests = 0;
		harness.setResponses([
			call("goal_propose", { ...proposal, tasks: [] }),
			call("goal_complete", { evidence: "Focused fixture passed." }),
			(context) => {
				auditRequests++;
				expect(context.systemPrompt).toContain("independent completion auditor");
				expect(context.systemPrompt).toContain("Audit fixture: never run deployment commands.");
				expect(context.tools?.map((tool) => tool.name).sort()).toEqual(["bash", "read"]);
				expect(context.messages).toHaveLength(1);
				expect(getMessageText(context.messages[0])).toContain("Focused fixture passed.");
				return fauxAssistantMessage("Inspected the fixture.\n<approved/>");
			},
			fauxAssistantMessage("Audit approved."),
		]);
		await harness.session.prompt("/goal Fix parser");
		await answer("confirm", { confirmed: true });
		await harness.session.waitForIdle();
		expect(errors).toEqual([]);
		expect(auditRequests).toBe(1);
		expect(stateOf(harness).goal?.status).toBe("complete");
	});

	it("does not start auditor inference when cancelled during SDK session preparation", async () => {
		const cancelled = new AbortController();
		const { harness, answer } = await setup((options) => runAudit({ ...options, signal: cancelled.signal }));
		const setName = AgentSession.prototype.setSessionName;
		const naming = vi.spyOn(AgentSession.prototype, "setSessionName").mockImplementation(async function (
			this: AgentSession,
			name,
		) {
			await setName.call(this, name);
			if (name === "Goal completion audit") cancelled.abort();
		});
		let auditRequests = 0;
		harness.setResponses([
			call("goal_propose", { ...proposal, tasks: [] }),
			call("goal_complete", { evidence: "Done." }),
			(context) => {
				if (context.systemPrompt?.includes("independent completion auditor")) auditRequests++;
				return fauxAssistantMessage("Audit interrupted.");
			},
		]);
		try {
			await harness.session.prompt("/goal Fix parser");
			await answer("confirm", { confirmed: true });
			await harness.session.waitForIdle();
			expect(auditRequests).toBe(0);
			expect(stateOf(harness).goal).toMatchObject({ status: "blocked", audit: { verdict: "error" } });
		} finally {
			naming.mockRestore();
		}
	});

	it("does not impose a finite continuation run cap", async () => {
		const { harness, answer } = await setup();
		harness.setResponses([
			call("goal_propose", proposal),
			...Array.from({ length: 125 }, (_, index) => fauxAssistantMessage(`Progress ${index}`)),
			call("goal_block", { reason: "Need user input now." }),
		]);
		await harness.session.prompt("/goal Fix parser");
		await answer("confirm", { confirmed: true });
		await harness.session.waitForIdle();
		expect(stateOf(harness).goal?.status).toBe("blocked");
		expect(harness.eventsOfType("agent_start")).toHaveLength(126);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each([false, true])(
		"recovers isolated provider timeouts but still blocks exhausted consecutive retries (exhaust=%s)",
		async (exhaust) => {
			const { harness, errors } = await setup(undefined, {
				sessionManager: await seeded(),
				settings: {
					retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
					compaction: { enabled: false },
				},
			});
			const timeout = fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "timeout", retryable: true, message: "response headers timed out" },
			});
			harness.setResponses([
				...Array.from({ length: 3 }, () => [timeout, call("goal_status", {})]).flat(),
				...(exhaust
					? [timeout, timeout, fauxAssistantMessage("Must not continue after exhaustion.")]
					: [fauxAssistantMessage("Recovered progress."), call("goal_block", { reason: "Need user input." })]),
			]);
			await harness.session.prompt("/goal-resume");
			await harness.session.waitForIdle();

			expect(harness.faux.state.callCount).toBe(8);
			expect(harness.getPendingResponseCount()).toBe(exhaust ? 1 : 0);
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual(
				exhaust ? [1, 1, 1, 1] : [1, 1, 1],
			);
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual(
				exhaust ? [true, true, true, false] : [true, true, true],
			);
			expect(stateOf(harness).goal).toMatchObject({
				status: "blocked",
				note: exhaust ? expect.stringContaining("Agent failed; explicit resume required.") : "Need user input.",
			});
			expect(harness.eventsOfType("agent_settled")).toHaveLength(exhaust ? 1 : 2);
			expect(errors).toEqual([]);
		},
	);

	it.each([0, 1])(
		"recovers a provider failure with a queued native job result (exit code %i) without blocking the goal",
		async (exitCode) => {
			const finish = Promise.withResolvers<void>();
			const operations: BashOperations = {
				exec: async () => {
					await finish.promise;
					return { exitCode };
				},
			};
			const definitions = nativeTools.createAllToolDefinitions;
			vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
				definitions(cwd, { ...options, bash: { ...options?.bash, operations } }),
			);
			const { harness, errors } = await setup(undefined, {
				sessionManager: await seeded(),
				settings: {
					retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
					compaction: { enabled: false },
				},
			});
			harness.setResponses([
				call("bash", { command: "controlled authorized work", background: true }),
				async () => {
					finish.resolve();
					await harness.session.work.waitForIdle();
					expect(harness.control.conversation.queue.steer).toHaveLength(1);
					return fauxAssistantMessage("", {
						stopReason: "error",
						error: { kind: "network", retryable: true, message: "WebSocket closed 1012" },
					});
				},
				(context) => {
					expect(stateOf(harness).goal?.status).toBe("active");
					expect(context.messages.map(getMessageText).join("\n")).toContain("controlled authorized work");
					return call("goal_task", { id: "1", status: "complete", evidence: "Recovered verification passed." });
				},
				fauxAssistantMessage("Recovered progress; continue the goal."),
				(context) => {
					expect(stateOf(harness).goal?.status).toBe("active");
					expect(
						context.messages.some((message) => getMessageText(message).startsWith("Continue the confirmed goal")),
					).toBe(true);
					return call("goal_block", { reason: "Need explicit approval for the next task." });
				},
			]);
			try {
				await harness.session.prompt("/goal-resume");
				await harness.session.waitForIdle();
			} finally {
				finish.resolve();
			}

			expect(harness.faux.state.callCount).toBe(5);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
			expect(harness.session.jobs.list()).toMatchObject([{ status: exitCode === 0 ? "completed" : "failed" }]);
			expect(stateOf(harness).goal).toMatchObject({
				status: "blocked",
				note: "Need explicit approval for the next task.",
				tasks: [{ status: "complete", evidence: "Recovered verification passed." }, { status: "pending" }],
			});
			expect(
				harness.sessionManager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "custom" &&
						entry.customType === STATE_ENTRY &&
						(entry.data as GoalState).goal?.status === "blocked"
							? [(entry.data as GoalState).goal?.note]
							: [],
					),
			).toEqual(["Need explicit approval for the next task."]);
			expect(errors).toEqual([]);
		},
	);

	it("pauses on abort and blocks on a terminal provider failure", async () => {
		const { harness } = await setup(undefined, { sessionManager: await seeded() });
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "auth", retryable: false, message: "No auth" },
			}),
		]);
		await harness.session.prompt("/goal-resume");
		await harness.session.waitForIdle();
		expect(stateOf(harness).goal?.status).toBe("blocked");
		const failure = harness.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(stateOf(harness).goal?.note).toContain(harness.sessionManager.getSessionId());
		expect(stateOf(harness).goal?.note).toContain(failure?.id);
		expect(stateOf(harness).goal?.note).toContain("Failure cause is not supplied by agent_settled");
		expect(stateOf(harness).goal?.note).not.toContain("No auth");
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "aborted",
				error: { kind: "aborted", retryable: false, message: "Cancelled" },
			}),
		]);
		await harness.session.prompt("/goal-resume");
		await harness.session.waitForIdle();
		expect(stateOf(harness).goal?.status).toBe("paused");
	});

	it.each(["settlement", "preflight"] as const)(
		"pauses after late abort during %s and resumes only explicitly",
		async (at) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let held = false;
			const { harness, errors } = await setup(undefined, {
				sessionManager: await seeded(),
				extensionFactories: [
					{
						id: "settlement-gate",
						factory: (volt) => {
							const hold = async () => {
								if (held) return;
								held = true;
								entered.resolve();
								await release.promise;
							};
							if (at === "settlement") volt.on("agent_settled", hold);
							else
								volt.on("before_agent_start", async (event) => {
									if (event.prompt.startsWith("Continue the confirmed goal")) await hold();
								});
						},
					},
				],
			});
			harness.setResponses([fauxAssistantMessage("Progress"), call("goal_block", { reason: "Need user input." })]);
			await harness.session.prompt("/goal-resume");
			await entered.promise;
			await harness.session.abort();
			release.resolve();
			await harness.session.waitForIdle();
			expect(stateOf(harness).goal?.status).toBe("paused");
			expect(harness.faux.state.callCount).toBe(1);
			await harness.session.prompt("/goal-resume");
			await harness.session.waitForIdle();
			expect(stateOf(harness).goal?.status).toBe("blocked");
			expect(harness.faux.state.callCount).toBe(2);
			expect(errors).toEqual([]);
		},
	);

	it("fails closed when a progress append rolls back", async () => {
		const { harness, answer } = await setup(undefined, { log: "memory" });
		let followUpContext = "";
		harness.setResponses([
			call("goal_propose", proposal),
			() => {
				harness.log!.failNext("rolled_back", (batch) => batch.entries.some((entry) => entry.type === "custom"));
				return call("goal_task", { id: "1", status: "complete", evidence: "Verified fixture." });
			},
			(context) => {
				followUpContext = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("Cannot save progress.");
			},
		]);
		await harness.session.prompt("/goal Fix parser");
		await answer("confirm", { confirmed: true });
		await harness.session.waitForIdle();
		expect(stateOf(harness).revision).toBe(2);
		expect(followUpContext).toContain("Goal persistence failed; automatic goal execution is stopped.");
		expect(followUpContext).not.toContain("Work only on the user-confirmed goal");
		expect(stateOf(harness).goal?.tasks[0].status).toBe("pending");
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.session.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
	});

	it("restores the selected branch rather than the newest goal snapshot elsewhere", async () => {
		const manager = SessionManager.inMemory();
		const earlier: GoalState = { ...emptyState(), goal: createGoal(proposal, "regular") };
		const entryId = await manager.logWriter.appendCustomEntry(STATE_ENTRY, earlier);
		await manager.logWriter.appendCustomEntry(STATE_ENTRY, {
			...earlier,
			revision: 1,
			goal: { ...earlier.goal!, status: "complete", audit: approved },
		});
		const { harness } = await setup(undefined, { sessionManager: manager });
		expect(stateOf(harness).goal?.status).toBe("complete");
		await harness.session.navigateTree(entryId);
		expect(stateOf(harness).goal?.status).toBe("paused");
		expect(stateOf(harness).goal?.audit).toBeNull();
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
	});

	it("drains an audit on disable and cannot publish its stale approval", async () => {
		const started = Promise.withResolvers<void>();
		let cancelled = false;
		const { harness, answer, errors } = await setup(async ({ signal }) => {
			started.resolve();
			await new Promise<void>((resolve) =>
				signal.addEventListener(
					"abort",
					() => {
						cancelled = true;
						resolve();
					},
					{ once: true },
				),
			);
			return approved;
		});
		harness.setResponses([
			call("goal_propose", { ...proposal, tasks: [] }),
			call("goal_complete", { evidence: "Done." }),
			fauxAssistantMessage("Extension stopped."),
		]);
		await harness.session.prompt("/goal Fix parser");
		await answer("confirm", { confirmed: true });
		await started.promise;
		harness.settingsManager.setExtensionEnabled("goal", "global", false);
		await harness.session.extensionRegistry.reconcile();
		await harness.session.waitForIdle();
		await harness.session.extensionRegistry.settled();
		expect(cancelled).toBe(true);
		expect(errors).toEqual([]);
		expect(stateOf(harness).goal?.status).toBe("paused");
		expect(stateOf(harness).goal?.audit?.verdict).not.toBe("approved");
		expect(harness.session.liveState.entries().filter(([key]) => key.includes("/goal/"))).toEqual([]);
	});

	it("cancels an audit and discards an approval returned after cancellation", async () => {
		const started = Promise.withResolvers<AbortSignal>();
		const finish = Promise.withResolvers<Audit>();
		const { harness, answer } = await setup(async ({ signal }) => {
			started.resolve(signal);
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return await finish.promise;
		});
		harness.setResponses([
			call("goal_propose", { ...proposal, tasks: [] }),
			call("goal_complete", { evidence: "Done." }),
		]);
		await harness.session.prompt("/goal Fix parser");
		await answer("confirm", { confirmed: true });
		const signal = await started.promise;
		const pausing = harness.session.prompt("/goal-pause");
		await vi.waitFor(() => expect(signal.aborted).toBe(true));
		finish.resolve(approved);
		await pausing;
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(2); // The live foreground run was stopped.
		expect(stateOf(harness).goal?.status).toBe("paused");
		expect(stateOf(harness).goal?.audit?.verdict).not.toBe("approved");
	});

	it.each(["/goal-pause", "/goal Draft later"])(
		"%s leaves unrelated background jobs running when no foreground run is active",
		async (command) => {
			const finish = Promise.withResolvers<void>();
			let jobSignal: AbortSignal | undefined;
			const operations: BashOperations = {
				exec: async (_command, _cwd, options) => {
					jobSignal = options.signal;
					await finish.promise;
					return { exitCode: 0 };
				},
			};
			const definitions = nativeTools.createAllToolDefinitions;
			vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
				definitions(cwd, { ...options, bash: { ...options?.bash, operations } }),
			);
			const { harness, errors } = await setup();
			harness.setResponses([
				call("bash", { command: "controlled unrelated work", background: true }),
				fauxAssistantMessage("Started unrelated work."),
				...(command === "/goal-pause" ? [] : [fauxAssistantMessage("Drafting waits for the user.")]),
			]);
			try {
				await harness.session.prompt("Start unrelated background work.");
				await harness.session.waitForIdle();
				const job = harness.session.jobs.list()[0];
				expect(job.status).toBe("running");
				await harness.session.prompt(command);
				await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
				await harness.session.waitForIdle();
				expect(harness.session.jobs.get(job.id).status).toBe("running");
				expect(jobSignal?.aborted).toBe(false);
				harness.setResponses([fauxAssistantMessage("Collected the unrelated result.")]);
				finish.resolve();
				await harness.session.work.waitForIdle();
				await harness.session.waitForIdle();
				expect(harness.session.jobs.get(job.id).status).toBe("completed");
				expect(errors).toEqual([]);
			} finally {
				finish.resolve();
			}
		},
	);

	it.each(["error", "rejected"] as const)(
		"stores at most 16,000 characters of an audit %s report",
		async (verdict) => {
			const report = "x".repeat(20_000);
			const { harness, answer } = await setup(async () => {
				if (verdict === "error") throw new Error(report);
				return { verdict, report, model: "faux/faux-1" };
			});
			harness.setResponses([
				call("goal_propose", { ...proposal, tasks: [] }),
				call("goal_complete", { evidence: "Done." }),
				verdict === "error"
					? fauxAssistantMessage("Audit failed.")
					: call("goal_block", { reason: "Need user review." }),
			]);
			await harness.session.prompt("/goal Fix parser");
			await answer("confirm", { confirmed: true });
			await harness.session.waitForIdle();
			expect(stateOf(harness).goal).toMatchObject({ status: "blocked", audit: { verdict } });
			expect(stateOf(harness).goal?.audit?.report).toBe(report.slice(0, 16_000));
		},
	);

	it.each(["none", "complete"] as const)(
		"rejects goal_block without an unfinished goal (%s) and continues the unrelated run",
		async (existing) => {
			const sessionManager = SessionManager.inMemory();
			if (existing === "complete") {
				const state: GoalState = {
					...emptyState(),
					goal: { ...createGoal(proposal, "regular"), status: "complete", audit: approved },
				};
				await sessionManager.logWriter.appendCustomEntry(STATE_ENTRY, state);
			}
			const { harness, errors } = await setup(undefined, { sessionManager });
			const before = stateOf(harness);
			harness.setResponses([
				call("goal_block", { reason: "Need user input." }),
				fauxAssistantMessage("Answered the unrelated request."),
			]);
			await harness.session.prompt("Unrelated request.");
			await harness.session.waitForIdle();
			const rejected = harness.session.messages.findLast(
				(message) => message.role === "toolResult" && message.toolName === "goal_block",
			);
			expect(rejected).toMatchObject({ isError: true });
			expect(getMessageText(rejected)).toContain("No unfinished goal to block.");
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(stateOf(harness)).toEqual(before);
			expect(errors).toEqual([]);
		},
	);

	it.each(["steer", "followUp"] as const)(
		"pauses when %s input arrives during a goal run and resumes explicitly",
		async (kind) => {
			const { harness, errors } = await setup(undefined, { sessionManager: await seeded() });
			harness.setResponses([
				async () => {
					await harness.session[kind]("Also check the error path.");
					return fauxAssistantMessage("Progress.");
				},
				fauxAssistantMessage("Handled the queued input."),
				fauxAssistantMessage("Must not continue automatically."),
			]);
			await harness.session.prompt("/goal-resume");
			await harness.session.waitForIdle();
			expect(harness.faux.state.callCount).toBe(2);
			expect(stateOf(harness).goal).toMatchObject({ status: "paused", note: expect.stringContaining("input") });
			harness.setResponses([call("goal_block", { reason: "Need user input." })]);
			await harness.session.prompt("/goal-resume");
			await harness.session.waitForIdle();
			expect(stateOf(harness).goal).toMatchObject({ status: "blocked", note: "Need user input." });
			expect(errors).toEqual([]);
		},
	);

	it.each(["steer", "followUp"] as const)(
		"keeps a draft when %s input arrives during its drafting run",
		async (kind) => {
			const { harness, answer, errors } = await setup();
			harness.setResponses([
				async () => {
					await harness.session[kind]("Also cover the error path.");
					return fauxAssistantMessage("Which parser should the goal cover?");
				},
				fauxAssistantMessage("Noted the queued input."),
			]);
			const drafting = harness.session.prompt("/goal");
			await answer("form", { values: { objective: proposal.objective, requirements: proposal.requirements[0] } });
			await drafting;
			await harness.session.waitForIdle();
			expect(harness.faux.state.callCount).toBe(2);
			expect(stateOf(harness).draft).not.toBeNull();
			expect(errors).toEqual([]);
		},
	);

	it("pauses when another extension's command runs during a goal run", async () => {
		let ran = 0;
		const { harness, errors } = await setup(undefined, {
			sessionManager: await seeded(),
			extensionFactories: [
				{
					id: "noop-command",
					factory: (volt) => {
						volt.registerCommand("noop", {
							handler: async () => {
								ran++;
							},
						});
					},
				},
			],
		});
		harness.setResponses([
			async () => {
				await harness.session.prompt("/noop");
				return fauxAssistantMessage("Progress.");
			},
			fauxAssistantMessage("Must not continue automatically."),
		]);
		await harness.session.prompt("/goal-resume");
		await harness.session.waitForIdle();
		expect(ran).toBe(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(stateOf(harness).goal?.status).toBe("paused");
		expect(errors).toEqual([]);
	});

	it("pauses when Plan mode refuses the continuation", async () => {
		const { harness, errors } = await setup(undefined, { sessionManager: await seeded() });
		harness.setResponses([
			async () => {
				await harness.session.setAgentMode("plan");
				return fauxAssistantMessage("Progress.");
			},
			fauxAssistantMessage("Must not continue automatically."),
		]);
		await harness.session.prompt("/goal-resume");
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(1);
		expect(stateOf(harness).goal).toMatchObject({ status: "paused", note: expect.stringContaining("refused") });
		expect(errors).toEqual([]);
	});

	it.each(["model", "auth"] as const)("blocks a resume whose prompt cannot start (no %s)", async (missing) => {
		const { harness, errors } = await setup(undefined, {
			sessionManager: await seeded(),
			...(missing === "model" ? { selectModel: false } : { withConfiguredAuth: false }),
		});
		await harness.session.prompt("/goal-resume");
		await harness.session.waitForIdle();
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(stateOf(harness).goal).toMatchObject({
			status: "blocked",
			note: expect.stringContaining("could not start"),
		});
		expect(errors.map((error) => error.event)).toEqual(["send_user_message"]);
	});

	it.each([
		["/goal Fix parser", false],
		["/goal-tweak Replace the parser", true],
	] as const)("pauses and clears a draft whose prompt cannot start (%s)", async (command, existing) => {
		const { harness, errors } = await setup(undefined, {
			...(existing ? { sessionManager: await seeded() } : {}),
			withConfiguredAuth: false,
		});
		await harness.session.prompt(command);
		await harness.session.waitForIdle();
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(stateOf(harness).draft).toBeNull();
		if (existing) {
			expect(stateOf(harness).goal).toMatchObject({
				status: "paused",
				note: expect.stringContaining("could not start"),
			});
		} else expect(stateOf(harness).goal).toBeNull();
		expect(errors.map((error) => error.event)).toEqual(["send_user_message"]);
	});

	it("ignores a remote-invoked /goal-resume", async () => {
		const { harness, errors } = await setup(undefined, { sessionManager: await seeded() });
		const before = stateOf(harness);
		harness.setResponses([fauxAssistantMessage("Must not run.")]);
		await ClientScope.run("paired-device", () => harness.session.prompt("/goal-resume"));
		await harness.session.waitForIdle();
		expect(stateOf(harness)).toEqual(before);
		expect(harness.faux.state.callCount).toBe(0);
		expect(errors).toEqual([]);
	});

	it("resumes from an SDK settlement listener after unrelated input", async () => {
		const { harness, errors } = await setup(undefined, { sessionManager: await seeded() });
		harness.setResponses([fauxAssistantMessage("Answered."), call("goal_block", { reason: "Need user input." })]);
		let resuming: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled" && !resuming) resuming = harness.session.prompt("/goal-resume");
		});
		await harness.session.prompt("Unrelated request.");
		await resuming;
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(2);
		expect(stateOf(harness).goal).toMatchObject({ status: "blocked", note: "Need user input." });
		expect(errors).toEqual([]);
	});

	it("continues a goal run whose background job result arrives mid-run", async () => {
		const finish = Promise.withResolvers<void>();
		const operations: BashOperations = {
			exec: async () => {
				await finish.promise;
				return { exitCode: 0 };
			},
		};
		const definitions = nativeTools.createAllToolDefinitions;
		vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
			definitions(cwd, { ...options, bash: { ...options?.bash, operations } }),
		);
		const { harness, errors } = await setup(undefined, { sessionManager: await seeded() });
		harness.setResponses([
			call("bash", { command: "controlled authorized work", background: true }),
			async () => {
				finish.resolve();
				await harness.session.work.waitForIdle();
				expect(harness.control.conversation.queue.steer).toHaveLength(1);
				return fauxAssistantMessage("Waiting for the job.");
			},
			fauxAssistantMessage("Collected the job result."),
			(context) => {
				expect(
					context.messages.some((message) => getMessageText(message).startsWith("Continue the confirmed goal")),
				).toBe(true);
				return call("goal_block", { reason: "Need user input." });
			},
		]);
		try {
			await harness.session.prompt("/goal-resume");
			await harness.session.waitForIdle();
		} finally {
			finish.resolve();
		}
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
		expect(stateOf(harness).goal).toMatchObject({ status: "blocked", note: "Need user input." });
		expect(errors).toEqual([]);
	});
});
