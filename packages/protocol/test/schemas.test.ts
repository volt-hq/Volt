import { ApiSchema } from "@hansjm10/volt-ai/schemas";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, test } from "vitest";
import {
	CONTROL_RESPONSE_SCHEMAS,
	ControlClientStatusSchema,
	ControlRevokedClientStatusSchema,
	ControlWorktreeStatusSchema,
} from "../src/daemon-control.ts";
import { type RpcGitContext, RpcGitContextSchema } from "../src/git-context.ts";
import { INTENT_SCHEMAS, IntentPresentationSchema } from "../src/intents.ts";
import { RpcPlanningStateSchema } from "../src/planning.ts";
import { RpcEpochMillisecondsSchema } from "../src/primitives.ts";
import {
	RpcReviewAcknowledgmentResponseSchema,
	RpcReviewRunDescriptorSchema,
	RpcReviewWorkflowResultResponseSchema,
} from "../src/projections.ts";
import {
	RpcActiveAgentRunSchema,
	RpcActiveCompactionSchema,
	RpcActiveRetrySchema,
	RpcPromptCacheStatusSchema,
} from "../src/session.ts";
import { RpcSubscriptionUsageReportSchema } from "../src/subscription-usage.ts";
import { RPC_WIRE_MAX_SAFE_INTEGER } from "../src/wire-limits.ts";
import { IrohRemoteWorktreeSummarySchema } from "../src/workspace.ts";

function check(schema: TSchema, value: unknown): boolean {
	return Compile(schema).Check(value);
}

describe("shared schemas", () => {
	test("open string enums accept novel values", () => {
		for (const schema of [ApiSchema, IntentPresentationSchema.properties.kind]) {
			expect(check(schema, "some-novel-value.v9")).toBe(true);
			expect(check(schema, 7)).toBe(false);
		}
	});

	test("subscription usage reports are strict and normalized", () => {
		const report = {
			status: "providers",
			providers: [
				{
					providerId: "openai-codex",
					result: {
						status: "success",
						snapshot: {
							providerId: "openai-codex",
							fetchedAt: 1_800_000_000_000,
							plan: "plus",
							limits: [
								{
									id: "weekly",
									label: "Weekly",
									usedPercent: 25.5,
									resetsAt: 1_800_086_400_000,
									windowDurationMs: 604_800_000,
									limitReached: false,
								},
							],
						},
					},
				},
			],
		};
		expect(check(RpcSubscriptionUsageReportSchema, report)).toBe(true);
		expect(check(RpcSubscriptionUsageReportSchema, { status: "no_subscription" })).toBe(true);
		expect(check(RpcSubscriptionUsageReportSchema, { status: "unsupported" })).toBe(true);
		expect(check(RpcSubscriptionUsageReportSchema, { ...report, rawPayload: {} })).toBe(false);
		expect(
			check(RpcSubscriptionUsageReportSchema, {
				...report,
				providers: [
					{
						...report.providers[0],
						result: {
							...report.providers[0].result,
							snapshot: { ...report.providers[0].result.snapshot, accountEmail: "private@example.com" },
						},
					},
				],
			}),
		).toBe(false);
		expect(
			check(RpcSubscriptionUsageReportSchema, {
				status: "providers",
				providers: [
					{
						providerId: "anthropic",
						result: { status: "error", error: { code: "rate_limited", message: "Try again later." } },
					},
				],
			}),
		).toBe(true);
	});

	test("Git context keeps path-free bounded fields", () => {
		const gitContext: RpcGitContext = {
			repository: "workspace",
			head: { kind: "branch", name: "main", oid: "0123456789abcdef0123456789abcdef01234567" },
			upstream: { ref: "origin/main", ahead: 2, behind: 1 },
			base: { ref: "main", ahead: 3, behind: 0 },
			status: {
				staged: { added: 1, modified: 2, deleted: 3, renamed: 4 },
				unstaged: { added: 4, modified: 3, deleted: 2, renamed: 1 },
				untracked: 5,
				conflicted: 1,
				total: 12,
				clean: false,
			},
			operation: { kind: "rebase", step: 2, total: 4 },
			revision: 7,
			observedAt: "2026-07-29T00:00:00.000Z",
			stale: false,
		};
		expect(check(RpcGitContextSchema, gitContext)).toBe(true);
		expect(check(RpcGitContextSchema, { ...gitContext, repository: "r".repeat(257) })).toBe(false);
		expect(check(RpcGitContextSchema, { ...gitContext, head: { kind: "detached", oid: "not-an-object-id" } })).toBe(
			false,
		);
	});

	test("planning state is a complete phase-consistent snapshot", () => {
		const planning = {
			mode: "build",
			plan: {
				id: "plan-1",
				revision: 3,
				phase: "active",
				title: "Ship Plan mode",
				summary: "Implement and verify the native workflow.",
				steps: [
					{
						id: "step-1",
						text: "Implement",
						status: "in_progress",
						substeps: [
							{ id: "substep-1", text: "Persist", status: "completed" },
							{ id: "substep-2", text: "Render", status: "in_progress" },
						],
					},
				],
				execution: {
					id: "execution-1",
					approvedRevision: 2,
					strategy: "retain_context",
					sourceSessionId: "session-1",
					targetSessionId: "session-1",
				},
			},
		};
		const validator = Compile(RpcPlanningStateSchema);
		expect(validator.Errors(planning)).toEqual([]);
		expect(validator.Check({ ...planning, plan: { ...planning.plan, execution: undefined } })).toBe(false);
		expect(validator.Check({ ...planning, plan: { ...planning.plan, phase: "ready" } })).toBe(false);
		expect(
			validator.Check({
				...planning,
				plan: {
					...planning.plan,
					steps: [{ ...planning.plan.steps[0], note: "Groups cannot carry execution notes" }],
				},
			}),
		).toBe(false);
		expect(validator.Check({ ...planning, unexpected: true })).toBe(false);
	});

	test("host-authoritative timestamps are safe non-negative epoch milliseconds", () => {
		const startedAt = 1_800_000_000_000;
		const run = {
			runId: "run-1",
			workflowAction: "review",
			engine: "standard",
			engineLabel: "Standard",
			status: "completed",
			startedAt,
			endedAt: startedAt + 60_000,
			usageUpdatedAt: startedAt + 60_000,
			acknowledgedAt: startedAt + 120_000,
			target: {
				description: "Uncommitted changes",
				diffCommand: "git diff HEAD",
				identity: { kind: "uncommitted", baseTree: "base-tree", headTree: "head-tree" },
				files: {
					totalCount: 0,
					projectedCount: 0,
					omittedCount: 0,
					additions: 0,
					deletions: 0,
					isComplete: true,
					items: [],
				},
			},
			options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
		};
		const runTimestamps = ["startedAt", "endedAt", "usageUpdatedAt", "acknowledgedAt"];
		const cases: Array<[TSchema, Record<string, unknown>, string[]]> = [
			[RpcReviewRunDescriptorSchema, run, runTimestamps],
			[RpcReviewWorkflowResultResponseSchema, run, runTimestamps],
			[RpcReviewAcknowledgmentResponseSchema, { runId: "run-1", acknowledgedAt: startedAt }, ["acknowledgedAt"]],
			[RpcActiveAgentRunSchema, { startedAt }, ["startedAt"]],
			[RpcActiveCompactionSchema, { reason: "manual", startedAt }, ["startedAt"]],
			[RpcActiveRetrySchema, { attempt: 1, maxAttempts: 3, retryAt: startedAt + 2_000 }, ["retryAt"]],
			[
				RpcPromptCacheStatusSchema,
				{
					kind: "retained",
					lastRequestAt: startedAt,
					expiresAt: startedAt + 300_000,
					keepAliveUntil: startedAt + 600_000,
				},
				["lastRequestAt", "expiresAt", "keepAliveUntil"],
			],
			[
				IrohRemoteWorktreeSummarySchema,
				{ id: "wt-1", branch: "volt/wt-1", createdAt: startedAt, sessionIds: [] },
				["createdAt"],
			],
			[
				INTENT_SCHEMAS.review_record_finding_outcome.output,
				{ runId: "run-1", findingId: "finding-1", status: "accepted", createdAt: startedAt },
				["createdAt"],
			],
			[
				ControlWorktreeStatusSchema,
				{
					id: "wt-1",
					workspaceName: "volt",
					path: "/tmp/wt-1",
					branch: "volt/wt-1",
					createdAt: startedAt,
					sessionIds: [],
				},
				["createdAt"],
			],
			[
				ControlClientStatusSchema,
				{ clientNodeId: "node-1", pairedAtMs: startedAt, lastSeenAtMs: startedAt + 60_000 },
				["pairedAtMs", "lastSeenAtMs"],
			],
			[
				ControlRevokedClientStatusSchema,
				{
					clientNodeId: "node-2",
					pairedAtMs: startedAt,
					lastSeenAtMs: startedAt + 60_000,
					revokedAtMs: startedAt + 120_000,
					rePairApprovedAtMs: startedAt + 180_000,
				},
				["pairedAtMs", "lastSeenAtMs", "revokedAtMs", "rePairApprovedAtMs"],
			],
			[
				CONTROL_RESPONSE_SCHEMAS.status_result,
				{
					type: "status_result",
					id: "1",
					version: "1.0.0",
					protocolVersion: 8,
					pid: 42,
					startedAtMs: startedAt,
					environment: { source: "inherited" },
					phoneConnections: 0,
					workspaces: [],
					clients: [],
					remoteTransport: { state: "ready" },
					keepAwake: { enabled: false, state: "disabled" },
					workers: [],
				},
				["startedAtMs"],
			],
		];
		for (const value of [0, startedAt, RPC_WIRE_MAX_SAFE_INTEGER]) {
			expect(check(RpcEpochMillisecondsSchema, value), `${value}`).toBe(true);
		}
		for (const value of [-1, 1.5, RPC_WIRE_MAX_SAFE_INTEGER + 1, Number.MAX_VALUE, "1800000000000"]) {
			expect(check(RpcEpochMillisecondsSchema, value), `${value}`).toBe(false);
		}
		for (const [schema, record, fields] of cases) {
			const validator = Compile(schema);
			expect(validator.Errors(record)).toEqual([]);
			for (const field of fields) {
				for (const value of [0, RPC_WIRE_MAX_SAFE_INTEGER]) {
					expect(validator.Check({ ...record, [field]: value }), `${field}=${value}`).toBe(true);
				}
				for (const value of [-1, startedAt + 0.5, RPC_WIRE_MAX_SAFE_INTEGER + 1]) {
					expect(validator.Check({ ...record, [field]: value }), `${field}=${value}`).toBe(false);
				}
			}
		}
	});
});
